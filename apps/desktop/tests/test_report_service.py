from __future__ import annotations

from base64 import b64decode
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import report_service as reports
import server
from ai_context import message_tokens
from pymupdf_runtime import load_fitz


QUOTE = "The algorithm sorts observations before estimating the threshold."
FORMULA = r"\tau = \min_i x_i"
PNG = b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=")


def model_report():
    return {
        "title": "阈值估计",
        "sections": [
            {"key": key, "paragraphs": [{
                "text": "先排序观测值，再估计 [[阈值]]。", "kind": "paper",
                "citations": [{"block_id": "methods-1", "quote": QUOTE, "page": 900, "render_generation": "999"}],
            }]}
            for key in reports.SECTIONS
        ],
        "concepts": [{"term": "阈值", "definition": "用于判断某个值是否满足条件的分界。"}],
    }


class ReportEndpointTest(unittest.TestCase):
    def setUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory()))
        store = server.JobStore(self.root / "jobs")
        library = server.LibraryStore(self.root)
        record = store.create("threshold.pdf", 100)
        self.job_id = record["job_id"]
        self.job_dir = Path(record["job_dir"])
        self.path = f"/api/jobs/{self.job_id}/report"
        store.update(self.job_id, status="completed")
        library.sync_jobs([store.get(self.job_id)])
        self.write_document(self.job_dir)
        for target, value in (("STORE", store), ("LIBRARY", library), ("LIBRARY_ROOT", self.root)):
            self.resources.enter_context(patch.object(server, target, value))
        self.resources.enter_context(patch.object(server, "_request_security_failure", return_value=None))
        self.resources.enter_context(patch.object(server.runtime, "AI_REQUIRES_MEMBER", False))
        self.resources.enter_context(patch.object(reports, "_effective_profile", return_value={}))

    def write_document(self, directory, text=QUOTE):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "document.json").write_text(json.dumps({"pages": [{
            "page": 2, "elements": [
                {"id": "methods-1", "kind": "paragraph", "text": text},
                {"block_id": "methods-2", "type": "paragraph", "text": "Repeated phrase. Repeated phrase."},
                {"block_id": "results-table", "type": "table", "caption": "Results", "html": "<tr><td>Accuracy</td><td>0.82</td></tr>"},
            ],
        }]}), encoding="utf-8")

    def write_media(self, directory, image=b"\x89PNG\r\n\x1a\n"):
        path = directory / "document.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        elements = document["pages"][0]["elements"]
        elements[-1]["visual_asset"] = "assets/images/table.png"
        elements.extend([
            {"block_id": "result", "type": "image", "caption": "Figure 1. Thresholds across data sets.",
             "visual_asset": "assets/images/result.png"},
            {"block_id": "overview", "type": "image", "caption": "Figure 2. Overview of the threshold estimation workflow.",
             "visual_asset": "assets/images/overview.png"},
            {"block_id": "formula", "type": "equation_interline", "equations": [{"tex": FORMULA}]},
        ])
        path.write_text(json.dumps(document), encoding="utf-8")
        assets = directory / "assets" / "images"
        assets.mkdir(parents=True)
        for name in ("table.png", "result.png", "overview.png"):
            (assets / name).write_bytes(image)

    def request(self, method, suffix="", payload=None, *, path=None):
        handler = object.__new__(server.ScholarHandler)
        handler.path = path or self.path + suffix
        handler._read_json_body = lambda: payload
        output = []
        handler._send_json = lambda body, status=200: output.append((status, body))
        handler._send_error_json = lambda message, status=400, **details: output.append((status, {"error": message, **details}))
        getattr(handler, f"do_{method}")()
        self.assertEqual(len(output), 1)
        return output[0]

    def draft(self, expected=0, *, raw=None):
        if raw is None:
            raw = model_report()
        with patch.object(reports, "_complete", return_value=json.dumps(raw)):
            status, body = self.request("POST", "/draft", {"expected_revision": expected})
        self.assertEqual(status, 200, body)
        return body["draft"]

    def save(self, report, revision=0, source="ai"):
        return self.request("PUT", payload={"expected_revision": revision, "source": source, "report": report})

    def test_draft_is_unpersisted_and_normalizes_quotes_against_source(self):
        raw = model_report()
        raw["sections"][0]["paragraphs"][0]["citations"] = [{"block_id": "methods-1", "quote": "Invented text"}]
        raw["sections"][1]["paragraphs"][0]["citations"] = [{"block_id": "methods-2", "quote": "Repeated phrase."}]
        raw["sections"][3]["paragraphs"][0]["citations"] = [{"block_id": "results-table", "quote": "Accuracy 0.82"}]
        draft = self.draft(raw=raw)
        self.assertEqual(draft["source"], {"render_generation": "base", "blocks_read": 3, "blocks_total": 3})
        self.assertEqual([section["key"] for section in draft["sections"]], list(reports.SECTIONS))
        for section in draft["sections"][:2]:
            paragraph = section["paragraphs"][0]
            self.assertEqual((paragraph["kind"], paragraph["citations"]), ("gap", []))
            self.assertNotIn("先排序", paragraph["text"])
        self.assertEqual(draft["sections"][2]["paragraphs"][0]["citations"], [
            {"block_id": "methods-1", "quote": QUOTE, "page": 2, "render_generation": "base"},
        ])
        self.assertEqual(draft["sections"][3]["paragraphs"][0]["citations"][0]["quote"], "Accuracy 0.82")
        self.assertEqual(self.request("GET"), (200, {"revision": 0, "report": None, "history": []}))
        self.assertFalse((self.job_dir / reports.REPORT_FILE).exists())

    def test_cli_draft_allows_time_for_a_full_report(self):
        with (
            patch.object(reports, "_effective_profile", return_value={"cli_kind": "codex"}),
            patch.object(reports, "_complete", return_value=json.dumps(model_report())) as complete,
        ):
            status, body = self.request("POST", "/draft", {"expected_revision": 0})
        self.assertEqual(status, 200, body)
        self.assertEqual(complete.call_args.kwargs["timeout_seconds"], 300)
        self.assertEqual(complete.call_args.kwargs["response_format"], {"type": "json_object"})
        self.assertEqual(len(body["draft"]["sections"]), 10)

    def test_draft_uses_trusted_media_and_adds_overview_to_implementation(self):
        self.write_media(self.job_dir)
        raw = model_report()
        sections = {section["key"]: section["paragraphs"][0] for section in raw["sections"]}
        sections["why"]["media_ids"] = ["figure:overview"]
        sections["implementation"]["media_ids"] = ["figure:result"]
        sections["experiments"]["media_ids"] = ["table:results-table", "table:results-table", "fabricated"]
        raw["media"] = [{"id": "figure:overview", "asset": "../../private.png", "page": 99}]

        with patch.object(reports, "_complete", return_value=json.dumps(raw)) as complete:
            status, body = self.request("POST", "/draft", {"expected_revision": 0})
        self.assertEqual(status, 200, body)
        draft = body["draft"]
        sections = {section["key"]: section["paragraphs"][0] for section in draft["sections"]}
        self.assertNotIn("media_ids", sections["why"])
        self.assertEqual(sections["implementation"]["media_ids"], ["figure:result", "figure:overview", "equation:formula:1"])
        self.assertEqual(sections["experiments"]["media_ids"], ["table:results-table"])
        media = {item["id"]: item for item in draft["media"]}
        overview = {key: value for key, value in media["figure:overview"].items() if key != "explanation_proof"}
        self.assertEqual(overview, {
            "id": "figure:overview", "block_id": "overview", "page": 2, "render_generation": "base",
            "kind": "figure", "caption": "Figure 2. Overview of the threshold estimation workflow.",
            "asset": "assets/images/overview.png",
            "explanation": {"basis": "unavailable", "image_supplied": False},
        })
        self.assertEqual(media["equation:formula:1"]["tex"], FORMULA)
        messages = complete.call_args.args[0]
        catalog = {item["id"]: item for item in json.loads(messages[2]["content"])["source_media"]}
        self.assertEqual(catalog["figure:overview"]["caption"], media["figure:overview"]["caption"])
        self.assertEqual(catalog["equation:formula:1"]["tex"], FORMULA)
        self.assertFalse(any("assets/images/" in message["content"] for message in messages))

    def test_media_anchors_are_validated_when_saving_and_preserved_across_revisions(self):
        render = self.job_dir / "renders" / "1"
        self.write_document(render)
        self.write_media(render)
        (render / "manifest.json").write_text("{}", encoding="utf-8")
        server.STORE.update(self.job_id, active_render=1)
        initial = self.draft()
        self.assertTrue(all(item["render_generation"] == "1" for item in initial["media"]))

        supplied = {**initial, "media": [{**item, "asset": "https://untrusted.test/diagram.png"} for item in initial["media"]]}
        status, saved = self.save(supplied)
        self.assertEqual(status, 200, saved)
        for item in initial["media"]:
            item.pop("explanation_proof", None)
        self.assertEqual(saved["report"], initial)

        changed = model_report()["sections"][0]
        changed["paragraphs"][0]["media_ids"] = ["figure:overview"]
        reply = {"reply": "改写了动机。", "draft": {"sections": [changed]}}
        with patch.object(reports, "_complete", return_value=json.dumps(reply)) as complete:
            status, result = self.request("POST", "/chat", {"expected_revision": 1, "mode": "revise", "message": "改写动机"})
        self.assertEqual(status, 200, result)
        draft = result["draft"]
        self.assertEqual(draft["sections"][1:], initial["sections"][1:])
        self.assertEqual([{key: value for key, value in item.items() if key != "explanation_proof"} for item in draft["media"]], initial["media"])
        self.assertNotIn("media_ids", draft["sections"][0]["paragraphs"][0])
        self.assertNotIn("assets/images/", complete.call_args.args[0][2]["content"])
        self.assertEqual(self.request("GET")[1], saved)
        self.assertEqual(self.save(draft, 1)[0], 200)

        newer_render = self.job_dir / "renders" / "2"
        self.write_document(newer_render)
        (newer_render / "manifest.json").write_text("{}", encoding="utf-8")
        server.STORE.update(self.job_id, active_render=2)
        regenerated = self.draft(expected=2)
        self.assertEqual(regenerated["source"]["render_generation"], "2")
        self.assertNotIn("media", regenerated)
        self.assertEqual(self.request("GET")[1]["revision"], 2)
        status, restored = self.request("PUT", payload={"expected_revision": 2, "restore_revision": 1})
        self.assertEqual(status, 200, restored)
        self.assertEqual(restored["report"], initial)
        (render / "assets" / "images" / "overview.png").unlink()
        self.assertEqual(self.save(draft, 3, "manual")[0], 400)

    def test_vision_draft_sends_overview_and_table_and_persists_valid_explanations(self):
        try:
            load_fitz()
        except ImportError:
            self.skipTest("PyMuPDF is needed to validate source visuals")
        self.write_media(self.job_dir, PNG)
        raw = model_report()
        raw["sections"][-1]["paragraphs"][0]["media_ids"] = ["table:results-table", "figure:result"]
        raw["media_explanations"] = [
            {"id": "figure:overview", "visual_readable": True, "text": "箭头指向阈值估计。",
             "citations": [{"block_id": "methods-1", "quote": QUOTE}]},
            {"id": "table:results-table", "visual_readable": True, "text": "可比较的准确率为 0.82。",
             "citations": [{"block_id": "results-table", "quote": "Accuracy 0.82"}]},
            {"id": "figure:result", "visual_readable": True, "text": "无法核对的依据。",
             "citations": [{"block_id": "methods-1", "quote": "Invented."}]},
        ]
        for profile, basis in (({"cli_kind": "codex"}, "visual"), ({"model": "gpt-4.1-mini"}, "visual"),
                               ({"cli_kind": "claude"}, "source_text"), ({"model": "text-only"}, "source_text")):
            raw["media_explanations"][0]["visual_readable"] = basis == "visual"
            raw["media_explanations"][1]["visual_readable"] = basis == "visual"
            with (self.subTest(profile=profile), patch.object(reports, "_effective_profile", return_value=profile),
                  patch.object(reports, "_complete", return_value=json.dumps(raw)) as complete):
                status, body = self.request("POST", "/draft", {"expected_revision": 0})
                self.assertEqual(status, 200, body)
                draft = body["draft"]
                messages = complete.call_args.args[0]
                if basis == "visual":
                    self.assertEqual(complete.call_args.kwargs.get("allow_report_images", False), bool(profile.get("cli_kind")))
                    attachments = messages[-1]["content"]
                    self.assertIn("figure:overview", attachments[0]["text"])
                    self.assertIn("table:results-table", attachments[2]["text"])
                    self.assertEqual(b64decode(attachments[1]["image_url"]["url"].partition(",")[2]), PNG)
                    self.assertLessEqual(message_tokens(messages), reports.request_budget(profile, reports.ANSWER_TOKENS)["input_limit"])
                else:
                    self.assertTrue(all(isinstance(message["content"], str) for message in messages))
                explanations = {item["id"]: item["explanation"] for item in draft["media"] if "explanation" in item}
                self.assertEqual(explanations["figure:overview"]["basis"], basis)
                self.assertEqual(explanations["table:results-table"]["basis"], basis)
                self.assertEqual(explanations["table:results-table"]["citations"][0]["page"], 2)
                self.assertEqual(explanations["figure:result"]["basis"], "unavailable")
        draft["media"][0]["explanation"] = {"basis": "visual", "text": "客户伪造的说明。"}
        status, saved = self.save(draft)
        self.assertEqual(status, 200, saved)
        saved_media = {item["id"]: item for item in saved["report"]["media"]}
        self.assertNotIn("explanation", saved_media[draft["media"][0]["id"]])
        self.assertEqual(saved_media["table:results-table"]["explanation"], explanations["table:results-table"])

    def test_revisions_reject_concurrent_stale_writes_and_restore_prior_copy(self):
        initial = self.draft()
        self.assertEqual(self.save(initial)[0], 200)
        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(lambda title: self.save({**initial, "title": title}, 1, "manual"), ("一", "二")))
        self.assertEqual(sorted(status for status, _ in responses), [200, 409])
        conflict = next(body for status, body in responses if status == 409)
        self.assertEqual(conflict["code"], "report_revision_conflict")
        status, restored = self.request("PUT", payload={"expected_revision": 2, "restore_revision": 1})
        self.assertEqual(status, 200)
        self.assertEqual(restored["report"], initial)
        self.assertEqual([item["source"] for item in restored["history"]], ["ai", "manual", "restore"])
        self.assertEqual(self.request("GET"), (200, restored))

    def test_versioned_anchors_survive_reflow_and_manual_edits_verify_source(self):
        render = self.job_dir / "renders" / "1"
        self.write_document(render)
        (render / "manifest.json").write_text("{}", encoding="utf-8")
        server.STORE.update(self.job_id, active_render=1)
        draft = self.draft()
        self.assertEqual(draft["source"]["render_generation"], "1")
        self.assertEqual(self.save(draft)[0], 200)
        render = self.job_dir / "renders" / "2"
        self.write_document(render, "The updated text changes the wording of the original.")
        (render / "manifest.json").write_text("{}", encoding="utf-8")
        server.STORE.update(self.job_id, active_render=2)
        self.assertEqual(reports.load_evidence(self.job_dir).generation, "2")
        self.assertEqual(self.save(draft, 1, "manual")[0], 200)
        draft["sections"][0]["paragraphs"][0]["citations"][0]["page"] = 3
        self.assertEqual(self.save(draft, 2, "manual")[0], 400)
        self.assertEqual(self.request("GET")[1]["revision"], 2)

    def test_concept_knowledge_writes_bind_to_saved_report_and_preserve_evidence(self):
        initial = self.draft()
        concept = initial["concepts"][0]
        suffix = "/concepts/" + concept["id"]
        self.assertEqual(self.request("PUT", suffix, {"revision": 0, "status": "learning"})[0], 409)
        self.assertEqual(self.save(initial)[0], 200)
        with patch.object(reports, "_complete", return_value=json.dumps({"reply": "从排序后的观测值中确定分界。"})):
            status, result = self.request("POST", "/chat", {
                "expected_revision": 1, "mode": "knowledge", "message": "提炼概念", "concept_id": concept["id"],
            })
        self.assertEqual(status, 200)
        self.assertEqual(self.request("GET", path="/api/report-knowledge"), (200, {"entries": []}))
        status, entry = self.request("PUT", suffix, {"revision": 1, "status": "learning", "saved": True, "text": result["reply"]})
        self.assertEqual(status, 200, entry)
        self.assertEqual(entry["report_revision"], 1)
        self.assertEqual(entry["citation"]["quote"], QUOTE)
        self.assertEqual(self.request("GET", path="/api/report-knowledge"), (200, {"entries": [entry]}))

    def test_question_passes_selected_report_text_separately_from_paper_evidence(self):
        self.assertEqual(self.save(self.draft())[0], 200)
        selection = "报告提到先排序再估计。"
        earlier_selection = "先估计阈值，再作决策。" * 70
        payload = {
            "expected_revision": 1, "mode": "question", "message": "这一步有什么作用？",
            "selected_text": selection,
            "history": [{"role": "user", "content": "解释这个流程", "selected_text": earlier_selection},
                        {"role": "assistant", "content": "可以分成两个步骤。"}],
        }
        with patch.object(reports, "_complete", return_value=json.dumps({"reply": "排序有助于找到分界。"})) as complete:
            self.assertEqual(self.request("POST", "/chat", payload), (200, {"reply": "排序有助于找到分界。"}))
            messages = complete.call_args.args[0]
            self.assertIn(QUOTE, messages[1]["content"])
            self.assertNotIn(selection, messages[1]["content"])
            task = json.loads(messages[2]["content"])
            self.assertEqual(task["message"], payload["message"])
            self.assertEqual(task["selected_text"], selection)
            self.assertEqual(task["history"][0]["selected_text"], earlier_selection[:600])
            self.assertNotIn("selected_text", task["history"][1])

            payload["selected_text"] = "长" * 4001
            self.assertEqual(self.request("POST", "/chat", payload)[0], 400)
            complete.assert_called_once()

    def test_revision_suggestion_keeps_unchanged_sections_without_committing(self):
        initial = self.draft()
        self.assertEqual(self.save(initial)[0], 200)
        changed = model_report()["sections"][0]
        changed["paragraphs"][0]["text"] = "先从 [[阈值]] 的含义讲起。"
        reply = {"reply": "我改写了研究动机。", "draft": {"sections": [changed]}}
        selection = "先排序观测值，再估计阈值。"
        with patch.object(reports, "_complete", return_value=json.dumps(reply)) as complete:
            status, payload = self.request("POST", "/chat", {
                "expected_revision": 1, "mode": "revise", "message": "把动机写得更容易懂", "history": [],
                "selected_text": selection,
            })
            self.assertEqual(json.loads(complete.call_args.args[0][2]["content"])["selected_text"], selection)
        self.assertEqual(status, 200, payload)
        draft = payload["draft"]
        self.assertEqual(draft["sections"][0]["paragraphs"][0]["text"], changed["paragraphs"][0]["text"])
        self.assertEqual(draft["sections"][1:], initial["sections"][1:])
        self.assertEqual(self.request("GET")[1]["report"], initial)

    def test_corrupt_history_is_not_overwritten(self):
        initial = self.draft()
        broken_file = self.job_dir / reports.REPORT_FILE
        broken_file.write_text("{broken", encoding="utf-8")
        self.assertEqual(self.request("GET")[0], 500)
        self.assertEqual(self.save(initial)[0], 500)
        self.assertEqual(broken_file.read_text(encoding="utf-8"), "{broken")

    def test_readonly_demo_does_not_expose_private_report_or_knowledge(self):
        initial = self.draft()
        self.assertEqual(self.save(initial)[0], 200)
        with patch.object(server.runtime, "READONLY_MODE", True):
            self.assertEqual(self.request("GET")[0], 403)
            self.assertEqual(self.request("GET", path="/api/report-knowledge")[0], 403)


class EvidenceBudgetTest(unittest.TestCase):
    def test_partial_budget_reads_across_full_document_and_marks_actual_coverage(self):
        blocks = {str(page): {"block_id": str(page), "page": page, "text": "Important method. " * 8}
                  for page in range(1, 81)}
        evidence = reports.Evidence("base", blocks, 1)
        budget = {"input_limit": 680}
        messages, selected = reports._model_messages("Read the paper.", {"task": "summarize"}, evidence, budget, set())
        self.assertLessEqual(message_tokens(messages), budget["input_limit"])
        self.assertLess(len(selected.blocks), len(blocks))
        self.assertTrue({"1", "40", "80"}.issubset(selected.blocks))
        header, data = messages[1]["content"].split("\n", 1)
        self.assertIn(f"含 {len(selected.blocks)} 个完整文本块", header)
        self.assertEqual(json.loads(data), list(selected.blocks.values()))

    def test_media_catalog_is_independent_of_selected_text_blocks(self):
        blocks = {str(page): {"block_id": str(page), "page": page, "text": "Important method. " * 8}
                  for page in range(1, 81)}
        figure = {"id": "figure:visual", "block_id": "visual", "page": 50, "kind": "figure",
                  "caption": "Figure 1. Architecture overview.", "render_generation": "base",
                  "asset": "assets/images/diagram.png"}
        evidence = reports.Evidence("base", blocks, 0, {figure["id"]: figure})
        budget = {"input_limit": 680}
        messages, selected = reports._model_messages("Read the paper.", {"task": "summarize"}, evidence, budget, set())
        self.assertLessEqual(message_tokens(messages), budget["input_limit"])
        self.assertNotIn("visual", selected.blocks)
        self.assertEqual(selected.media, evidence.media)
        self.assertEqual(json.loads(messages[2]["content"])["source_media"][0]["id"], figure["id"])

    def test_exact_quote_from_an_unsupplied_block_does_not_validate(self):
        quote = "An independently verified sentence."
        canonical = {"methods-1": {"page": 1, "text": QUOTE}, "unread": {"page": 2, "text": quote}}
        evidence = reports.Evidence("base", canonical, 0)
        selected = reports.Evidence("base", {"methods-1": canonical["methods-1"]}, 0)
        raw = model_report()
        raw["sections"][0]["paragraphs"][0]["citations"] = [{"block_id": "unread", "quote": quote}]
        draft = reports._draft(raw, evidence, selected)
        self.assertEqual(draft["sections"][0]["paragraphs"][0]["kind"], "gap")
        self.assertEqual(draft["source"]["blocks_read"], 1)


if __name__ == "__main__":
    unittest.main()
