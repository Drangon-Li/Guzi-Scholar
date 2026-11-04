"""Streaming PDF uploads, the disk-backed multipart scanner and per-key locks."""

from __future__ import annotations

from contextlib import ExitStack
import hashlib
import http.client
from http.server import ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import queue
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server  # noqa: E402
import multipart_form  # noqa: E402
from job_store import JobStore  # noqa: E402
from keyed_locks import KeyedLocks  # noqa: E402
from library_store import LibraryStore  # noqa: E402
from multipart_form import _SpooledBody, _multipart_parts, _parse_multipart_form, _spool_request_body, _spooled_body  # noqa: E402
from pipeline import PipelineError  # noqa: E402

BOUNDARY = "----GuziStreamingBoundary"


def multipart(*parts: bytes, boundary: str = BOUNDARY, close: bool = True) -> bytes:
    delimiter = b"--" + boundary.encode()
    body = b"".join(delimiter + b"\r\n" + part + b"\r\n" for part in parts)
    return body + (delimiter + b"--\r\n" if close else b"")


def file_part(data: bytes, filename: str = "paper.pdf", name: str = "file") -> bytes:
    header = f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: application/pdf\r\n\r\n'
    return header.encode("utf-8") + data


def field_part(name: str, value: str) -> bytes:
    return f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}'.encode("utf-8")


class KeyedLocksTest(unittest.TestCase):
    def test_entries_are_dropped_after_release_and_reentry_is_allowed(self) -> None:
        table = KeyedLocks()
        lock = table.lock("job")
        with lock:
            with table.lock("job"):
                self.assertIn("job", table)
            self.assertEqual(len(table), 1)
        self.assertEqual(len(table), 0)

    def test_waiters_keep_one_lock_per_key(self) -> None:
        table = KeyedLocks()
        inside = 0
        overlap = []
        guard = threading.Lock()

        def critical() -> None:
            nonlocal inside
            for _ in range(200):
                with table.lock("same"):
                    with guard:
                        inside += 1
                        overlap.append(inside)
                    time.sleep(0)
                    with guard:
                        inside -= 1

        workers = [threading.Thread(target=critical) for _ in range(8)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=20)
        self.assertEqual(max(overlap), 1)
        self.assertEqual(len(table), 0)

    def test_distinct_keys_do_not_block_each_other(self) -> None:
        table = KeyedLocks()
        acquired = threading.Event()

        def other_key() -> None:
            with table.lock("b"):
                acquired.set()

        with table.lock("a"):
            thread = threading.Thread(target=other_key)
            thread.start()
            self.assertTrue(acquired.wait(2))
            thread.join(2)
        self.assertEqual(len(table), 0)

    def test_failed_try_acquire_and_foreign_release_leave_no_entry(self) -> None:
        table = KeyedLocks()
        held = threading.Event()
        done = threading.Event()

        def holder() -> None:
            with table.lock("k"):
                held.set()
                done.wait(2)

        thread = threading.Thread(target=holder)
        thread.start()
        self.assertTrue(held.wait(2))
        self.assertFalse(table.lock("k").acquire(blocking=False))
        self.assertFalse(table.lock("k").acquire(timeout=0.01))
        with self.assertRaises(RuntimeError):
            table.lock("k").release()
        done.set()
        thread.join(2)
        self.assertEqual(len(table), 0)
        with self.assertRaises(RuntimeError):
            table.lock("never").release()


class ServerLockTableTest(unittest.TestCase):
    def test_job_and_metadata_locks_are_released_after_use(self) -> None:
        with server._job_mutation("job-a"), server._job_mutations(["job-b", "job-c"]), server._metadata_job_lock("job-a"):
            self.assertIn("job-a", server.JOB_MUTATION_LOCKS)
            self.assertIn("job-a", server.METADATA_JOB_LOCKS)
        self.assertNotIn("job-a", server.JOB_MUTATION_LOCKS)
        self.assertNotIn("job-c", server.JOB_MUTATION_LOCKS)
        self.assertNotIn("job-a", server.METADATA_JOB_LOCKS)

    def test_metadata_generation_is_forgotten_once_no_work_remains(self) -> None:
        class StopWorker(BaseException):
            pass

        metadata_queue: "queue.Queue" = queue.Queue()
        ran: list = []
        generations_seen: list = []

        def run(job_id: str, online: bool, phase: str, generation: int) -> None:
            if job_id == "stop-worker":
                raise StopWorker
            ran.append(generation)
            generations_seen.append(server.METADATA_GENERATIONS.get(job_id))

        with patch.object(server, "METADATA_QUEUE", metadata_queue), patch.object(server, "_run_metadata_job", side_effect=run):
            self.assertTrue(server._enqueue_metadata("gen-job", False, "quick", force=True))
            self.assertTrue(server._enqueue_metadata("gen-job", False, "refine", force=True))
            self.assertEqual(server.METADATA_GENERATIONS["gen-job"], 2)
            metadata_queue.put(("stop-worker", False, "quick", 0))
            # Run the worker loop inline; the sentinel ends it after both jobs.
            with self.assertRaises(StopWorker):
                server._metadata_worker()
        self.assertEqual(ran, [1, 2])
        # The counter survives while work is pending and is pruned afterwards.
        self.assertEqual(generations_seen, [2, 2])
        self.assertNotIn("gen-job", server.METADATA_GENERATIONS)
        self.assertFalse(any(item[0] == "gen-job" for item in server.METADATA_PENDING))


class DiskMultipartTest(unittest.TestCase):
    def scan(self, body: bytes, content_type: str = f"multipart/form-data; boundary={BOUNDARY}") -> dict:
        with tempfile.TemporaryDirectory(prefix="guzi-multipart-") as temp:
            path = Path(temp) / "request.body"
            self.assertEqual(_spool_request_body(io.BytesIO(body), len(body), path, chunk_size=5), len(body))
            with _spooled_body(path) as spooled:
                parts = _multipart_parts(spooled, content_type)
                return {
                    name: [(part.filename, part.read(spooled), b"".join(part.iter_chunks(spooled, 3))) for part in items]
                    for name, items in parts.items()
                }

    def memory(self, body: bytes, content_type: str = f"multipart/form-data; boundary={BOUNDARY}") -> dict:
        form = _parse_multipart_form(io.BytesIO(body), content_type, len(body))
        return {name: [(item.filename, item.data, item.data) for item in items] for name, items in form.items()}

    def test_spooled_scan_matches_in_memory_parse(self) -> None:
        pdf = b"%PDF-1.7\r\n" + bytes(range(256)) * 40 + b"\r\n--" + BOUNDARY.encode() + b"X\r\n"
        bodies = [
            multipart(field_part("folder_id", "文件夹-1"), file_part(pdf, "全文 综述.pdf")),
            multipart(file_part(pdf), close=False),
            multipart(file_part(b"")),
            multipart(b'Content-Disposition: form-data; name="file"; filename="cr.pdf"\r\rbody').replace(b"\r\n", b"\r"),
            multipart(b'Content-Disposition: form-data; name="note"\r\nnot a header line\r\nmore'),
        ]
        for body in bodies:
            with self.subTest(body=body[:60]):
                self.assertEqual(self.scan(body), self.memory(body))

    def test_spooled_find_and_slices_match_bytes_across_chunk_edges(self) -> None:
        import random

        rng = random.Random(5)
        data = bytes(rng.choice(b"ab-\r\n") for _ in range(4000))
        with tempfile.TemporaryDirectory(prefix="guzi-multipart-") as temp, patch.object(multipart_form, "SPOOL_CHUNK_BYTES", 7):
            path = Path(temp) / "body"
            path.write_bytes(data)
            with _spooled_body(path) as spooled:
                self.assertIsInstance(spooled, _SpooledBody)
                for _ in range(400):
                    needle = bytes(rng.choice(b"ab-\r\n") for _ in range(rng.randint(1, 6)))
                    start, end = rng.randint(-50, 4100), rng.choice([None, rng.randint(-50, 4100)])
                    self.assertEqual(spooled.find(needle, start, end), data.find(needle, start, end), (needle, start, end))
                    a, b = rng.randint(-60, 4100), rng.randint(-60, 4100)
                    self.assertEqual(spooled[a:b], data[a:b])

    def test_crlf_split_across_line_windows_is_one_break(self) -> None:
        # Shift the header lines so each CRLF lands on every offset of a 4-byte window.
        with patch.object(multipart_form, "_LINE_WINDOW_BYTES", 4):
            for pad in range(8):
                body = multipart(b'Content-Disposition: form-data; name="note"\r\nX-Long: ' + b"v" * pad + b"\r\n\r\npayload")
                self.assertEqual(self.scan(body)["note"][0][1], b"payload", pad)
                self.assertEqual(self.memory(body)["note"][0][1], b"payload", pad)

    def test_header_block_ends_at_first_non_header_line(self) -> None:
        body = multipart(b'Content-Disposition: form-data; name="note"\r\nplain text\r\n\r\ntail')
        self.assertEqual(self.scan(body)["note"][0][1], b"plain text\r\n\r\ntail")

    def test_empty_and_truncated_bodies(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-multipart-") as temp:
            path = Path(temp) / "request.body"
            self.assertEqual(_spool_request_body(io.BytesIO(b"abc"), 10, path), 3)
            self.assertEqual(path.read_bytes(), b"abc")
            path.write_bytes(b"")
            with _spooled_body(path) as spooled:
                self.assertEqual((len(spooled), spooled[0:10]), (0, b""))
                with self.assertRaises(PipelineError):
                    _multipart_parts(spooled, f"multipart/form-data; boundary={BOUNDARY}")


class QuietHandler(server.ScholarHandler):
    def log_message(self, *_args: object) -> None:
        pass


class StreamingUploadTest(unittest.TestCase):
    def setUp(self) -> None:
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix="guzi-upload-")))
        settings = self.root / "settings.json"
        settings.write_text(json.dumps({"metadata": {"auto_retrieve": False}}), encoding="utf-8")
        self.store = JobStore(self.root / "jobs")
        self.library = LibraryStore(self.root)
        self.conversions: "queue.Queue" = queue.Queue()
        self.resources.enter_context(patch.dict(os.environ, {"MY_SCHOLAR_SETTINGS_FILE": str(settings)}, clear=False))
        for name, value in (
            ("STORE", self.store),
            ("LIBRARY", self.library),
            ("CONVERSION_QUEUE", self.conversions),
            ("SETTINGS_PATH", settings),
            ("ACCOUNT_FILE", self.root / "no-account.json"),
            ("_enqueue_metadata", MagicMock(return_value=True)),
        ):
            self.resources.enter_context(patch.object(server, name, value))
        self.resources.enter_context(patch.object(server.runtime, "API_ACCESS_TOKEN", ""))
        self.resources.enter_context(patch.object(server.runtime, "READONLY_MODE", False))
        self.resources.enter_context(patch.object(server.runtime, "AI_REQUIRES_MEMBER", False))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def stop() -> None:
            self.httpd.shutdown()
            self.httpd.server_close()
            thread.join(timeout=3)

        self.addCleanup(stop)

    def post(self, body: bytes, connection: http.client.HTTPConnection | None = None, content_type: str = f"multipart/form-data; boundary={BOUNDARY}"):
        connection = connection or http.client.HTTPConnection(*self.httpd.server_address, timeout=30)
        self.addCleanup(connection.close)
        connection.request("POST", "/api/jobs", body=body, headers={"Content-Type": content_type, "Content-Length": str(len(body))})
        response = connection.getresponse()
        return response, json.loads(response.read() or b"{}"), connection

    def incoming_entries(self) -> list:
        return sorted(path.name for path in self.store.incoming_root.iterdir())

    def test_upload_is_byte_exact_and_leaves_no_spool_behind(self) -> None:
        pdf = b"%PDF-1.7\r\n" + os.urandom(3 * 1024 * 1024 + 17) + b"\r\n--" + BOUNDARY.encode() + b"Y\r\n%%EOF"
        filename = "全文 Transformer 综述.pdf"
        with patch.object(server, "_parse_multipart_form", side_effect=AssertionError("job uploads must not buffer in memory")):
            response, payload, connection = self.post(multipart(field_part("folder_id", ""), file_part(pdf, filename)))
        self.assertEqual(response.status, 202, payload)
        job = self.store.get(payload["job"]["job_id"])
        stored = Path(job["job_dir"]) / "upload.pdf"
        self.assertEqual(hashlib.sha256(stored.read_bytes()).hexdigest(), hashlib.sha256(pdf).hexdigest())
        self.assertEqual(job["source_filename"], filename)
        self.assertEqual(self.incoming_entries(), [])
        self.assertFalse(list(Path(job["job_dir"]).glob("request.body")))
        self.assertEqual(self.conversions.qsize(), 1)

        # The same connection stays usable, and a re-upload is deduplicated.
        connection.request("GET", "/api/health")
        health = connection.getresponse()
        self.assertEqual(health.status, 200)
        health.read()
        again, payload, _ = self.post(multipart(file_part(pdf, filename)), connection)
        self.assertIn(again.status, {200, 202})
        self.assertTrue(payload["deduplicated"])
        self.assertEqual(self.incoming_entries(), [])

    def test_rejected_uploads_clean_up_their_spool(self) -> None:
        cases = [
            (multipart(file_part(b"text", "notes.txt")), "只接受 .pdf"),
            (multipart(field_part("folder_id", "x")), "没有找到名为 file"),
            (multipart(field_part("folder_id", "missing-folder"), file_part(b"%PDF-1.4")), ""),
            (multipart(file_part(b"")), "为空"),
            (b"no delimiter here", "multipart/form-data"),
        ]
        for body, message in cases:
            with self.subTest(message=message):
                response, payload, _ = self.post(body)
                self.assertEqual(response.status, 400, payload)
                self.assertIn(message, payload.get("error", ""))
                self.assertEqual(self.incoming_entries(), [])
        self.assertEqual(self.store.list(), [])

    def test_connection_dropped_mid_upload_imports_nothing(self) -> None:
        import socket

        body = multipart(file_part(b"%PDF-1.7\n" + os.urandom(256 * 1024), "cut.pdf"))
        with socket.create_connection(self.httpd.server_address, timeout=5) as sock:
            head = (
                f"POST /api/jobs HTTP/1.1\r\nHost: 127.0.0.1:{self.httpd.server_address[1]}\r\n"
                f"Content-Type: multipart/form-data; boundary={BOUNDARY}\r\nContent-Length: {len(body)}\r\n\r\n"
            )
            sock.sendall(head.encode() + body[: len(body) // 2])
            sock.shutdown(socket.SHUT_WR)
            reply = b""
            while chunk := sock.recv(65536):
                reply += chunk
        self.assertIn(b" 400 ", reply.split(b"\r\n", 1)[0])
        self.assertIn("上传未完成".encode(), reply)
        self.assertEqual(self.store.list(), [])
        self.assertEqual(self.incoming_entries(), [])

    def test_large_upload_does_not_hold_the_body_in_memory(self) -> None:
        size = 32 * 1024 * 1024
        pdf = b"%PDF-1.7\n" + b"\x00" * size
        body_path = self.root / "outgoing.bin"
        body_path.write_bytes(multipart(file_part(pdf, "big.pdf")))
        expected = hashlib.sha256(pdf).hexdigest()
        del pdf
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=60)
        self.addCleanup(connection.close)
        tracemalloc.start()
        try:
            with body_path.open("rb") as outgoing:
                connection.request("POST", "/api/jobs", body=outgoing, headers={
                    "Content-Type": f"multipart/form-data; boundary={BOUNDARY}",
                    "Content-Length": str(body_path.stat().st_size),
                })
                response = connection.getresponse()
                payload = json.loads(response.read())
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(response.status, 202, payload)
        stored = Path(self.store.get(payload["job"]["job_id"])["job_dir"]) / "upload.pdf"
        digest = hashlib.sha256()
        with stored.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        self.assertEqual(digest.hexdigest(), expected)
        # The previous in-memory parser peaked above twice the upload size.
        self.assertLess(peak, 8 * 1024 * 1024, f"peak traced allocation {peak / 1048576:.1f} MiB")


if __name__ == "__main__":
    unittest.main()
