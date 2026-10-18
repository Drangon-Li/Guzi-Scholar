from __future__ import annotations

import hashlib
import io
import json
import stat
import sys
import tempfile
import threading
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from parsing_providers import ParsingResult, ProviderError, RemoteGuziProvider
import server as server_module
from remote_parser_client import RemoteParserClient, RemoteParserError
from remote_parser_connection import RemoteParserConnection

PDF = b"%PDF-1.4\nremote-parser-fixture"


def artifact(*, digest=None, validation="PASS", extras=None):
    data = {
        "manifest.json": json.dumps({"job_id": "remote-id", "source": {"sha256": digest or hashlib.sha256(PDF).hexdigest()}, "validation": {"status": validation}}).encode(),
        "validation.json": json.dumps({"status": validation}).encode(),
        "document.html": b'<h1 data-block-id="heading" data-page="1">Title</h1><p data-block-id="new-1" data-page="1">A retained quote.</p>',
        "document.json": b"{}", "document-ir.json": b"{}", "source.pdf": PDF,
        **(extras or {}),
    }
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in data.items():
            archive.writestr(name, value)
    return stream.getvalue()


class RemoteParserClientTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "input.pdf"
        self.source.write_bytes(PDF)
        self.client = RemoteParserClient("http://127.0.0.1:18770", "private-token", poll_interval=0)

    def tearDown(self):
        self.temporary.cleanup()

    def extract(self, payload):
        archive = self.root / "result.zip"
        archive.write_bytes(payload)
        return self.client.extract_verified(archive, self.root / "result", self.source, "local-id", "论文.pdf")

    def test_complete_artifact_preserves_reader_markup_and_rewrites_identity(self):
        manifest = self.extract(artifact(extras={"assets/images/figure.png": b"image"}))
        self.assertEqual(manifest["job_id"], "local-id")
        self.assertEqual(manifest["source"]["filename"], "论文.pdf")
        self.assertIn('data-block-id="heading"', (self.root / "result/document.html").read_text())
        self.assertEqual((self.root / "result/assets/images/figure.png").read_bytes(), b"image")

    def test_rejects_zip_slip(self):
        with self.assertRaises(RemoteParserError):
            self.extract(artifact(extras={"../escape": b"bad"}))
        self.assertFalse((self.root / "escape").exists())

    def test_rejects_symlinks(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as bundle:
            entry = zipfile.ZipInfo("source.pdf")
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(entry, "/etc/passwd")
        with self.assertRaises(RemoteParserError):
            self.extract(stream.getvalue())

    def test_rejects_wrong_source_and_failed_validation(self):
        for kwargs in ({"digest": "0" * 64}, {"validation": "FAIL"}):
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "result.zip"
                archive.write_bytes(artifact(**kwargs))
                with self.assertRaises(RemoteParserError):
                    self.client.extract_verified(archive, Path(directory) / "output", self.source, "local", "x.pdf")

    def test_rejects_zip_bomb_by_declared_size(self):
        self.client.MAX_EXPANDED_BYTES = 10
        with self.assertRaises(RemoteParserError):
            self.extract(artifact())

    def test_rejects_cross_origin_results_and_credentials(self):
        for path in ("https://attacker.invalid/result", "//attacker.invalid/result", "http://user:secret@127.0.0.1:18770/result"):
            with self.subTest(path=path), self.assertRaises(RemoteParserError):
                self.client._url(path)

    def test_rejects_cleartext_remote_transport(self):
        with self.assertRaises(RemoteParserError):
            RemoteParserClient("http://example.com:18770", "token")

    def test_cancel_is_forwarded_after_submission(self):
        event = threading.Event()
        calls = []
        def fake_json(path, **kwargs):
            calls.append(path)
            if path == "/v1/jobs":
                event.set()
                return {"id": "remote-id"}
            return {}
        with patch.object(self.client, "_json", side_effect=fake_json), self.assertRaises(RemoteParserError) as caught:
            self.client.run(self.source, self.root / "output", source_name="x.pdf", job_id="local", cancel_event=event)
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertEqual(calls, ["/v1/jobs", "/v1/jobs/remote-id/cancel"])

    def test_http_contract_and_authenticated_health(self):
        payload = artifact()
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                requests.append((self.path, self.headers.get("Authorization")))
                if self.headers.get("Authorization") != "Bearer private-token":
                    self.send_error(401)
                    return
                if self.path == "/v1/health":
                    body = json.dumps({"status": "ok", "ready": True, "engine": "fusion", "version": "test"}).encode()
                elif self.path.endswith("/result"):
                    body = payload
                else:
                    body = b'{"id":"remote-id","status":"completed","result_url":"/v1/jobs/remote-id/result"}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                requests.append((self.path, self.headers.get("Authorization")))
                if self.path == "/v1/jobs":
                    self.server.upload = body
                result = b'{"id":"remote-id","status":"queued"}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(result)))
                self.end_headers()
                self.wfile.write(result)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            client = RemoteParserClient(base, "private-token", poll_interval=0)
            self.assertTrue(client.health()["ready"])
            with self.assertRaises(RemoteParserError) as caught:
                RemoteParserClient(base, "wrong-token").health()
            self.assertEqual(caught.exception.code, "remote_unauthorized")
            result = client.run(self.source, self.root / "output", source_name="论文.pdf", job_id="local")
            self.assertEqual(result["job_id"], "local")
            self.assertEqual(server.upload, PDF)
            self.assertTrue(all(token in {"Bearer private-token", "Bearer wrong-token"} for _, token in requests))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_remote_provider_never_starts_local_pipeline_on_failure(self):
        connection = MagicMock()
        connection.client.side_effect = RemoteParserError("connection unavailable")
        provider = RemoteGuziProvider(connection)
        with patch("parsing_providers.process_pdf") as local, self.assertRaises(ProviderError):
            provider.run({"job_id": "local", "source_pdf": self.source, "output_dir": self.root / "output"})
        local.assert_not_called()

    def test_private_configuration_status_hides_token_and_ssh_paths(self):
        config = self.root / "config.local.json"
        config.write_text(json.dumps({"remote_parser": {"enabled": True, "base_url": "http://127.0.0.1:18770", "token": "private-token", "ssh": {"enabled": False, "identity_file": "/secret/key"}}}))
        connection = RemoteParserConnection(config)
        with patch.object(RemoteParserClient, "health", return_value={"ready": True, "engine": "fusion", "version": "test"}):
            status = connection.status()
        self.assertTrue(status["ready"])
        self.assertNotIn("private-token", json.dumps(status))
        self.assertNotIn("/secret/key", json.dumps(status))
        connection.close()
        self.assertEqual(connection.status()["reason_code"], "remote_disconnected")

    def test_initial_import_remote_failure_does_not_start_local_ocr(self):
        store = server_module.JobStore(self.root / "jobs")
        record = store.create("paper.pdf", len(PDF))
        job_dir = Path(record["job_dir"])
        (job_dir / "upload.pdf").write_bytes(PDF)
        remote = MagicMock()
        remote.configured.return_value = True
        remote.run.side_effect = ProviderError("Remote unavailable", code="remote_unavailable")
        registry = MagicMock()
        registry.get.return_value = remote
        with patch.object(server_module, "STORE", store), patch.object(server_module, "_parsing_provider_registry", return_value=registry), patch.object(server_module, "process_pdf") as local:
            server_module._run_conversion_job(record["job_id"], "paper.pdf")
        self.assertEqual(store.get(record["job_id"])["status"], "failed")
        local.assert_not_called()

    def test_remote_reflow_keeps_annotations_and_switches_only_after_verification(self):
        store = server_module.JobStore(self.root / "jobs")
        record = store.create("paper.pdf", len(PDF))
        job_dir = Path(record["job_dir"])
        (job_dir / "source.pdf").write_bytes(PDF)
        (job_dir / "document.html").write_text("old reader")
        annotations = b'[{"id":"saved","block_id":"old-block","quote":"retained quote","page":1}]'
        (job_dir / "annotations.json").write_bytes(annotations)
        store.update(record["job_id"], status="completed", source_sha256=hashlib.sha256(PDF).hexdigest(), manifest={"job_id": record["job_id"]})
        remote = MagicMock()
        remote.configured.return_value = True
        def run(request, **_kwargs):
            archive = self.root / "remote.zip"
            archive.write_bytes(artifact())
            verified = self.root / "verified-reflow"
            manifest = self.client.extract_verified(archive, verified, request.source_pdf, request.job_id, request.source_name)
            for entry in verified.iterdir():
                entry.rename(request.output_dir / entry.name)
            return ParsingResult(manifest, {"provider_id": "remote-guzi"})
        remote.run.side_effect = run
        registry = MagicMock()
        registry.get.return_value = remote
        generation = store.begin_reflow(record["job_id"])["reflow"]["generation"]
        with patch.object(server_module, "STORE", store), patch.object(server_module, "_parsing_provider_registry", return_value=registry), patch.object(server_module, "_enqueue_metadata"), patch.object(server_module, "process_pdf") as local:
            server_module._run_reflow_job(record["job_id"], "paper.pdf", generation)
        current = store.get(record["job_id"])
        self.assertEqual(current["active_render"], generation)
        self.assertEqual((job_dir / "annotations.json").read_bytes(), annotations)
        self.assertEqual((job_dir / "document.html").read_text(), "old reader")
        local.assert_not_called()
        next_generation = store.begin_reflow(record["job_id"])["reflow"]["generation"]
        remote.run.side_effect = ProviderError("Remote failed", code="remote_failed")
        with patch.object(server_module, "STORE", store), patch.object(server_module, "_parsing_provider_registry", return_value=registry):
            server_module._run_reflow_job(record["job_id"], "paper.pdf", next_generation)
        self.assertEqual(store.get(record["job_id"])["active_render"], generation)
        self.assertEqual((job_dir / "annotations.json").read_bytes(), annotations)

    def test_ssh_tunnel_uses_strict_known_hosts_and_only_stops_owned_process(self):
        config = self.root / "config.local.json"
        identity, hosts = self.root / "key", self.root / "known_hosts"
        identity.write_text("fixture")
        hosts.write_text("fixture")
        config.write_text(json.dumps({"remote_parser": {"base_url": "http://127.0.0.1:18770", "token": "private-token", "ssh": {"enabled": True, "host": "example.test", "user": "test", "identity_file": str(identity), "known_hosts_file": str(hosts)}}}))
        connection = RemoteParserConnection(config)
        process = MagicMock()
        process.poll.return_value = None
        socket_mock = MagicMock()
        socket_mock.__enter__.return_value.connect_ex.side_effect = [1, 0]
        with patch("remote_parser_connection.socket.socket", return_value=socket_mock), patch("remote_parser_connection.subprocess.Popen", return_value=process) as launch:
            connection.client()
        command = launch.call_args.args[0]
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertIn("ExitOnForwardFailure=yes", command)
        self.assertIn("UserKnownHostsFile=" + str(hosts.resolve()), command)
        self.assertIn("127.0.0.1:18770:127.0.0.1:18770", command)
        connection.close()
        process.terminate.assert_called_once()
        process.wait.assert_called_once()

    def test_remote_structured_html_is_not_rewritten_by_legacy_migration(self):
        job_dir = self.root / "migration"
        job_dir.mkdir()
        markup = '<main class="reader-content"><figure class="pdf-table"><div class="table-scroll"><table><tr><td><math><mi>x</mi></math></td></tr></table></div><details class="source-crop"><img src="assets/images/table.png"></details></figure></main>'
        (job_dir / "document.html").write_text(markup)
        for engine in ("guzi-fusion-auto-v2", "guzi-fusion-auto-v3"):
            with self.subTest(engine=engine), patch.object(server_module, "_migrate_reader_html") as legacy:
                server_module._migrate_job_artifacts(job_dir, {"engine": {"name": engine}})
                legacy.assert_not_called()
            self.assertEqual((job_dir / "document.html").read_text(), markup)

    def test_thumbnail_routes_allow_only_flat_jpg_paths(self):
        store = server_module.JobStore(self.root / "jobs")
        record = store.create("paper.pdf", len(PDF))
        job_dir = Path(record["job_dir"])
        targets = ["assets/pages/page-001.jpg", "renders/1/assets/pages/page-001.jpg"]
        for relative in targets:
            path = job_dir / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"jpg")
        handler = object.__new__(server_module.ScholarHandler)
        served, errors = [], []
        handler._serve_file = lambda path, **_kwargs: served.append(path)
        handler._send_error_json = lambda *args: errors.append(args)
        invalid = ["assets/pages/page.svg", "assets/pages/page.jpeg", "assets/pages/nested/page.jpg", "assets/pages/../source.pdf", "renders/1/assets/pages/page.svg", "renders/1/assets/pages/nested/page.jpg"]
        with patch.object(server_module, "STORE", store):
            for relative in targets + invalid:
                handler._serve_job_artifact(record["job_id"], relative, "")
        self.assertEqual(served, [(job_dir / relative).resolve() for relative in targets])
        self.assertEqual(len(errors), len(invalid))

    def test_invalid_configuration_still_selects_remote_instead_of_local(self):
        config = self.root / "config.local.json"
        config.write_text("not JSON")
        provider = RemoteGuziProvider(RemoteParserConnection(config))
        self.assertTrue(provider.configured())
        self.assertEqual(provider.status()["reason_code"], "invalid_configuration")
        self.assertTrue(provider.status()["configured"])

    def test_invalid_ssh_configuration_returns_unavailable_status(self):
        config = self.root / "config.local.json"
        for tunnel in ("invalid", [], None, True):
            with self.subTest(ssh=tunnel):
                config.write_text(json.dumps({"remote_parser": {"enabled": True, "token": "private-token", "ssh": tunnel}}))
                connection = RemoteParserConnection(config)
                with patch.object(RemoteParserClient, "health") as health:
                    status = connection.status()
                self.assertEqual(status["reason_code"], "invalid_configuration")
                self.assertEqual(status["state"], "unavailable")
                self.assertTrue(status["configured"])
                self.assertFalse(status["ready"])
                health.assert_not_called()
                connection.close()

    def test_invalid_url_port_returns_unavailable_status(self):
        config = self.root / "config.local.json"
        for port in ("invalid", "65536", "-1"):
            for tunnel_enabled in (False, True):
                with self.subTest(port=port, ssh_enabled=tunnel_enabled):
                    config.write_text(json.dumps({"remote_parser": {"enabled": True, "base_url": f"http://127.0.0.1:{port}", "token": "private-token", "ssh": {"enabled": tunnel_enabled}}}))
                    connection = RemoteParserConnection(config)
                    with patch.object(RemoteParserClient, "health") as health:
                        status = connection.status()
                    self.assertEqual(status["reason_code"], "invalid_configuration")
                    self.assertEqual(status["state"], "unavailable")
                    self.assertTrue(status["configured"])
                    self.assertFalse(status["ready"])
                    health.assert_not_called()
                    connection.close()


if __name__ == "__main__":
    unittest.main()
