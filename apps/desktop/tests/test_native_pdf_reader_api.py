from __future__ import annotations

import hashlib
import io
import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from http import HTTPStatus
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
from job_store import JobStore
from library_store import LibraryStore


class NativePDFReaderAPITest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="my-scholar-native-reader-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        self.store = JobStore(root / "jobs")
        incoming = self.store.new_incoming_directory()
        pdf = b"%PDF-1.4\n"
        (incoming / "upload.pdf.part").write_bytes(pdf)
        job, _ = self.store.commit_staged_upload(incoming, "paper.pdf", len(pdf), hashlib.sha256(pdf).hexdigest())
        self.job_id = job["job_id"]
        self.job_dir = Path(job["job_dir"])
        self.path = f"/api/jobs/{self.job_id}"
        patches = ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.object(server, "STORE", self.store))
        patches.enter_context(patch.object(server, "LIBRARY", LibraryStore(root)))
        patches.enter_context(patch.object(server, "SETTINGS_PATH", root / "settings.json"))
        patches.enter_context(patch.object(server.runtime, "READONLY_MODE", False))
        patches.enter_context(patch.object(server.runtime, "AI_REQUIRES_MEMBER", False))
        self.anchor = {
            "kind": "highlight", "surface": "pdf", "source": "manual", "page": 1,
            "quote": "Repeated quote", "pdf_rects": [[0.1, 0.2, 0.4, 0.25]],
        }

    def request(self, method, relative, payload=None, *, headers=None, body=b""):
        handler = object.__new__(server.ScholarHandler)
        handler.path = self.path + relative
        handler.headers = headers or {}
        handler.rfile = io.BytesIO(body)
        replies = []
        handler._read_json_body = lambda **_kwargs: payload
        handler._send_json = lambda value, status=HTTPStatus.OK: replies.append((status, value))
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST: replies.append((status, {"error": message}))
        getattr(handler, f"do_{method}")()
        self.assertEqual(len(replies), 1)
        return replies[0]

    def add_annotation(self, **changes):
        status, result = self.request("POST", "/annotations", {**self.anchor, **changes})
        self.assertEqual(status, HTTPStatus.CREATED, result)
        return result["annotation"]

    def test_annotation_crud_uses_pdf_rectangles_for_identity(self):
        first = self.add_annotation()
        status, duplicate = self.request("POST", "/annotations", self.anchor)
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(duplicate["annotation"]["id"], first["id"])
        other_page = self.add_annotation(page=2)
        other_location = self.add_annotation(pdf_rects=[[0.1, 0.3, 0.4, 0.35]])
        underline = self.add_annotation(kind="underline")
        status, _ = self.request("PATCH", f"/annotations/{underline['id']}", {"kind": "highlight"})
        self.assertEqual(status, HTTPStatus.CONFLICT)
        status, result = self.request("PATCH", f"/annotations/{other_location['id']}", {"kind": "underline", "note": "Study this"})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(result["annotation"]["note"], "Study this")
        self.assertEqual(result["annotation"]["pdf_rects"], other_location["pdf_rects"])
        status, result = self.request("PATCH", f"/annotations/{other_location['id']}", {"kind": "highlight"})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(result["annotation"]["kind"], "highlight")

        _, result = self.request("DELETE", f"/annotations/{first['id']}")
        self.assertEqual([item["id"] for item in result["annotations"]], [other_page["id"], other_location["id"], underline["id"]])
        self.assertEqual(self.request("GET", "/annotations")[1]["annotations"], result["annotations"])
        _, result = self.request("DELETE", "/annotations")
        self.assertEqual(result["deleted"], 3)
        self.assertEqual(result["annotations"], [])

    def test_rejects_invalid_pdf_annotations_and_preserves_parsed_guard(self):
        invalid = (
            {"page": True}, {"page": 1.5}, {"page": 0}, {"source": "ai"}, {"quote": "x" * 10001},
            {"kind": "strike"}, {"pdf_rects": []}, {"pdf_rects": self.anchor["pdf_rects"] * 257},
            {"pdf_rects": [[0, 0, 1.1, 1]]}, {"pdf_rects": [[0.5, 0, 0.1, 1]]},
            {"pdf_rects": [[0, 0, 1, True]]}, {"pdf_rects": [[0, 0, 1, float("nan")]]},
        )
        for changes in invalid:
            with self.subTest(changes=next(iter(changes))):
                status, _ = self.request("POST", "/annotations", {**self.anchor, **changes})
                self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        status, _ = self.request("POST", "/annotations", {**self.anchor, "surface": "paper"})
        self.assertEqual(status, HTTPStatus.CONFLICT)
        self.assertFalse((self.job_dir / "annotations.json").exists())

    def test_notes_annotation_and_image_survive_parse_publication(self):
        annotation = self.add_annotation()
        picture = b"\x89PNG\r\n\x1a\nfixture"
        body = b'--fixture\r\nContent-Disposition: form-data; name="file"; filename="picture.png"\r\n\r\n' + picture + b"\r\n--fixture--\r\n"
        status, result = self.request("POST", "/note-assets", headers={
            "Content-Type": "multipart/form-data; boundary=fixture", "Content-Length": str(len(body)),
        }, body=body)
        self.assertEqual(status, HTTPStatus.CREATED)
        asset = result["asset"]
        status, notes = self.request("GET", "/notes")
        self.assertEqual(status, HTTPStatus.OK)
        markdown = f"Draft from the original PDF\n\n![Figure]({asset['ref']})"
        status, saved = self.request("PUT", "/notes", {"markdown": markdown, "expected_revision": notes["revision"]})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(saved["markdown"], markdown)
        status, _ = self.request("PUT", "/notes", {"markdown": "Stale edit", "expected_revision": notes["revision"]})
        self.assertEqual(status, HTTPStatus.CONFLICT)

        def parser(_source, output_dir, **_kwargs):
            (output_dir / "document.json").write_text('{"pages": []}', encoding="utf-8")
            return {"source": {}}

        self.store.begin_parse(self.job_id)
        with (
            patch.object(server, "_parsing_provider_registry", return_value={}),
            patch.object(server, "process_pdf", side_effect=parser),
            patch.object(server, "_metadata_settings", return_value={"auto_retrieve": False}),
        ):
            server._run_conversion_job(self.job_id, "paper.pdf")
        self.assertEqual(self.store.get(self.job_id)["status"], "completed")
        self.assertEqual(self.request("GET", "/annotations")[1]["annotations"], [annotation])
        self.assertEqual(self.request("GET", "/notes")[1]["revision"], saved["revision"])
        self.assertEqual(json.loads((self.job_dir / "content/annotations/annotations.json").read_text()), [annotation])
        self.assertEqual((self.job_dir / "content/notes/notes.md").read_text(), markdown)
        self.assertEqual((self.job_dir / "content/notes" / asset["ref"]).read_bytes(), picture)

        status, parsed = self.request("POST", "/annotations", {**self.anchor, "surface": "paper"})
        self.assertEqual(status, HTTPStatus.CREATED)
        self.assertNotIn("pdf_rects", parsed["annotation"])
        self.assertEqual(len(parsed["annotations"]), 2)

    def test_pdf_chat_uses_history_without_a_new_selection(self):
        messages = [
            {"role": "user", "content": "What does this mean?", "quote": "Selected text"},
            {"role": "assistant", "content": "An explanation"},
            {"role": "user", "content": "Say more"},
        ]
        with (
            patch.object(server, "_job_context", side_effect=AssertionError("Unexpected parsed context")),
            patch.object(server, "chat_context_info", return_value={}),
            patch.object(server, "ai_chat", return_value={"answer": "Follow-up"}) as chat,
        ):
            status, result = self.request("POST", "/chat", {"source_kind": "pdf", "messages": messages})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(result["result"]["answer"], "Follow-up")
        self.assertEqual(chat.call_args.args, (messages,))
        self.assertIn("未提供论文全文", chat.call_args.kwargs["context"])
        self.assertEqual(chat.call_args.kwargs["selected_text"], "")
        self.assertIsNone(chat.call_args.kwargs["image"])

        with patch.object(server, "chat_context_info", return_value={}), patch.object(server.ScholarHandler, "_chat_stream_response", autospec=True) as stream:
            stream.side_effect = lambda handler, *_args, **_kwargs: handler._send_json({"streamed": True})
            status, result = self.request("POST", "/chat", {
                "source_kind": "pdf", "messages": messages, "selected_text": "new selection", "stream": True,
            })
        self.assertEqual((status, result), (HTTPStatus.OK, {"streamed": True}))
        self.assertEqual(stream.call_args.kwargs["selected_text"], "new selection")

    def test_original_pdf_is_required_for_pdf_actions(self):
        (self.job_dir / "upload.pdf").unlink()
        for route, payload in (("/annotations", self.anchor), ("/chat", {"source_kind": "pdf"})):
            status, _ = self.request("POST", route, payload)
            self.assertEqual(status, HTTPStatus.CONFLICT)
