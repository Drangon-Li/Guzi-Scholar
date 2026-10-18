from __future__ import annotations

from contextlib import ExitStack
import http.client
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


class QuietHandler(server.ScholarHandler):
    def log_message(self, *_args):
        pass


class HTTPKeepaliveTest(unittest.TestCase):
    def setUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix="guzi-http-keepalive-")))
        self.job_id = "a" * 16
        self.job_dir = self.root / "jobs" / self.job_id
        self.job_dir.mkdir(parents=True)
        (self.job_dir / "document.json").write_text(json.dumps({"pages": [{"elements": [{
            "block_id": "block-2-1", "type": "paragraph", "page": 2,
            "text": "We propose a new method and demonstrate improved performance in controlled experiments.",
        }]}]}))
        self.annotation = {"id": "local-note", "quote": "A local note.", "kind": "highlight", "note": "Isolated test data"}
        (self.job_dir / "annotations.json").write_text(json.dumps([self.annotation]))
        settings = self.root / "settings.json"
        settings.write_text("{}")
        job_id, job_dir = self.job_id, self.job_dir

        class IsolatedStore:
            def get(self, requested):
                return {"job_id": job_id, "job_dir": str(job_dir), "status": "completed"} if requested == job_id else None

            def path(self, requested, relative=""):
                return job_dir / relative if requested == job_id else None

            def list(self):
                return [self.get(job_id)]

        self.resources.enter_context(patch.dict(os.environ, {
            "MY_SCHOLAR_SETTINGS_FILE": str(settings),
            "MY_SCHOLAR_DEVELOPER_TOKENS_FILE": str(self.root / "no-developer-tokens.json"),
        }, clear=True))
        self.resources.enter_context(patch.object(server, "STORE", IsolatedStore()))
        self.resources.enter_context(patch.object(server, "LIBRARY_ROOT", self.root))
        self.resources.enter_context(patch.object(server, "JOBS_ROOT", self.root / "jobs"))
        self.resources.enter_context(patch.object(server, "SETTINGS_PATH", settings))
        self.resources.enter_context(patch.object(server, "ACCOUNT_FILE", self.root / "no-account.json"))
        self.resources.enter_context(patch.object(server.runtime, "AI_REQUIRES_MEMBER", False))
        self.resources.enter_context(patch.object(server.runtime, "API_ACCESS_TOKEN", ""))
        self.resources.enter_context(patch.object(server.runtime, "READONLY_MODE", False))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)

    def connection(self):
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=3)
        self.addCleanup(connection.close)
        return connection

    def request_json(self, connection, method, path, body=None):
        connection.request(method, path, body=body, headers={"Content-Type": "application/json"} if body is not None else {})
        sock = connection.sock
        response = connection.getresponse()
        payload = json.loads(response.read())
        return response, payload, sock

    def assert_followup_reads(self, connection):
        health, payload, _ = self.request_json(connection, "GET", "/api/health")
        self.assertEqual(health.status, 200)
        self.assertTrue(payload["ok"])
        annotations, payload, _ = self.request_json(connection, "GET", f"/api/jobs/{self.job_id}/annotations")
        self.assertEqual(annotations.status, 200)
        self.assertTrue(any(item.get("id") == self.annotation["id"] for item in payload["annotations"]))

    def test_disabled_ai_highlights_close_unread_body_before_health_and_annotations(self):
        connection = self.connection()
        result, payload, _ = self.request_json(connection, "POST", f"/api/jobs/{self.job_id}/auto-highlights", "{}")
        self.assertEqual(result.status, 200)
        self.assertEqual(payload["result"]["status"], "local-fallback")
        self.assertEqual(result.getheader("Connection"), "close")
        self.assertTrue(result.will_close)
        self.assertIsNone(connection.sock)
        self.assert_followup_reads(connection)

    def test_missing_job_early_return_closes_body_before_followup_reads(self):
        connection = self.connection()
        result, _, _ = self.request_json(connection, "POST", f"/api/jobs/{'b' * 16}/chat", "{}")
        self.assertEqual(result.status, 404)
        self.assertEqual(result.getheader("Connection"), "close")
        self.assert_followup_reads(connection)

    def test_translation_probe_close_prevents_its_empty_json_polluting_next_get(self):
        connection = self.connection()
        result, payload, _ = self.request_json(connection, "POST", "/api/translation/test", "{}")
        self.assertEqual(result.status, 200)
        self.assertFalse(payload["result"]["ok"])
        self.assertEqual(result.getheader("Connection"), "close")
        self.assert_followup_reads(connection)

    def test_consecutive_gets_keep_the_same_connection(self):
        connection = self.connection()
        first, _, first_socket = self.request_json(connection, "GET", "/api/health")
        second, _, second_socket = self.request_json(connection, "GET", f"/api/jobs/{self.job_id}/annotations")
        self.assertEqual((first.status, second.status), (200, 200))
        self.assertNotEqual(first.getheader("Connection"), "close")
        self.assertFalse(first.will_close)
        self.assertIs(first_socket, second_socket)


if __name__ == "__main__":
    unittest.main()
