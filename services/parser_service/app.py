"""Loopback-only HTTP API for Guzi's persistent parsing queue."""
from __future__ import annotations

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import signal
import threading
from urllib.parse import unquote, urlsplit

from .runtime import Runtime, seed_raw_cache

MAX_UPLOAD = 100 * 1024 * 1024


def load_config(path):
    path = Path(path).resolve()
    config = json.loads(path.read_text())
    if config.get("host", "127.0.0.1") != "127.0.0.1":
        raise ValueError("Service must bind to 127.0.0.1")
    base = Path(config["base"]).resolve()
    token_path = Path(config["token_file"]).resolve()
    if not token_path.is_relative_to(base):
        raise ValueError("Token file must be inside base")
    if token_path.stat().st_mode & 0o077:
        raise ValueError("Token file must have private permissions (0600)")
    token = token_path.read_text().strip()
    if len(token) < 32 or not token.isascii() or any(c.isspace() for c in token):
        raise ValueError("Bearer token must contain at least 32 non-whitespace ASCII characters")
    return config, token


def make_server(runtime, token, port=18770):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "GuziParser/2"

        def log_message(self, format, *args):
            # Do not log HTTP headers, bearer tokens or filenames.
            return

        def setup(self):
            super().setup()
            self.connection.settimeout(60)

        def respond(self, code, data):
            payload = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def authorized(self):
            value = self.headers.get("Authorization", "")
            if not hmac.compare_digest(value.encode(), ("Bearer " + token).encode()):
                self.close_connection = True
                self.respond(401, {"error": "Unauthorized"})
                return False
            return True

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/health":
                self.respond(200, runtime.health())
                return
            if not self.authorized():
                return
            if path == "/v1/health":
                self.respond(200, runtime.health())
                return
            match = re.fullmatch(r"/v1/jobs/([a-f0-9]{32})(/result)?", path)
            if not match:
                self.respond(404, {"error": "Not found"})
                return
            try:
                state = runtime.get(match[1])
            except KeyError:
                self.respond(404, {"error": "Job not found"})
                return
            if not match[2]:
                self.respond(200, state)
                return
            if state["status"] != "completed":
                self.respond(409, {"error": "Job has no completed result", "status": state["status"]})
                return
            target = runtime.path(match[1]) / "result.zip"
            if not target.is_file():
                self.respond(500, {"error": "Completed result is missing"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(target.stat().st_size))
            self.send_header("Content-Disposition", f'attachment; filename="{match[1]}.zip"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with target.open("rb") as stream:
                while data := stream.read(1024*1024):
                    self.wfile.write(data)

        def do_POST(self):
            if not self.authorized():
                return
            path = urlsplit(self.path).path
            match = re.fullmatch(r"/v1/jobs/([a-f0-9]{32})/cancel", path)
            if match:
                self.close_connection = True
                try:
                    self.respond(200, runtime.cancel(match[1]))
                except KeyError:
                    self.respond(404, {"error": "Job not found"})
                return
            if path != "/v1/jobs":
                self.close_connection = True
                self.respond(404, {"error": "Not found"})
                return
            self.close_connection = True
            if self.headers.get("Transfer-Encoding"):
                self.respond(400, {"error": "Chunked upload is unsupported; send Content-Length"})
                return
            if self.headers.get_content_type() != "application/pdf":
                self.respond(415, {"error": "Content-Type must be application/pdf"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            limit = min(MAX_UPLOAD, int(runtime.config.get("max_upload_bytes", MAX_UPLOAD)))
            if length <= 0 or length > limit:
                self.respond(413, {"error": "PDF upload must be 1 byte to 100 MiB"})
                return
            filename = unquote(self.headers.get("X-Filename", "document.pdf"))
            filename = Path(filename.replace("\\", "/")).name[:240]
            filename = "".join(c for c in filename if c >= " " and c != "\x7f") or "document.pdf"
            client_id = self.headers.get("X-Client-Job-Id")
            if client_id and (not client_id.isascii() or not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", client_id)):
                self.respond(400, {"error": "X-Client-Job-Id must be a short ASCII identifier"})
                return
            try:
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("Incomplete PDF upload")
                state = runtime.submit(data, filename, client_id)
            except ValueError as error:
                self.respond(400, {"error": str(error)})
                return
            except RuntimeError as error:
                self.respond(503, {"error": str(error)})
                return
            except Exception:
                self.respond(400, {"error": "PDF could not be opened"})
                return
            self.respond(202, state)

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--write-model-protocol", type=Path)
    parser.add_argument("--seed-pdf", type=Path)
    parser.add_argument("--seed-run-dir", type=Path)
    parser.add_argument("--seed-protocol", type=Path)
    args = parser.parse_args()
    config, token = load_config(args.config)
    if args.seed_pdf:
        if not args.seed_run_dir or not args.seed_protocol:
            parser.error("Seeding requires --seed-run-dir and --seed-protocol")
        result = seed_raw_cache(config, args.seed_pdf, args.seed_run_dir, args.seed_protocol)
        print(json.dumps({"seeded": len(result), "source_sha256": result[0]["source_sha256"]}))
        return
    runtime = Runtime(config, start_worker=not bool(args.write_model_protocol))
    if args.write_model_protocol:
        from .runtime import atomic_json
        target = args.write_model_protocol.resolve()
        if not target.is_relative_to(runtime.base):
            raise ValueError("Protocol output must be inside base")
        atomic_json(target, runtime.protocol)
        runtime.close()
        return
    server = make_server(runtime, token, int(config.get("port", 18770)))
    def shutdown(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    try:
        server.serve_forever(poll_interval=.2)
    finally:
        server.server_close()
        runtime.close()


if __name__ == "__main__":
    main()
