"""Authenticated remote parsing and verified, bounded artifact delivery."""
from __future__ import annotations

import hashlib
import hmac
import http.client
import json
import re
import shutil
import stat
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


class RemoteParserError(RuntimeError):
    def __init__(self, message: str, code: str = "remote_unavailable") -> None:
        super().__init__(message)
        self.code = code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class RemoteParserClient:
    MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
    MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
    MAX_FILES = 20000
    REQUIRED = {"manifest.json", "document.html", "document.json", "document-ir.json", "validation.json", "source.pdf"}

    def __init__(self, base_url: str, token: str, *, timeout: float = 20, poll_interval: float = 0.5, job_timeout: float = 7200) -> None:
        parsed = urllib.parse.urlsplit(str(base_url).rstrip("/"))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise RemoteParserError("远端解析地址无效。", "invalid_configuration")
        if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise RemoteParserError("远端 HTTP 解析必须通过本机 SSH 隧道连接。", "invalid_configuration")
        if not token or "\n" in token or "\r" in token:
            raise RemoteParserError("远端解析凭据未配置。", "not_configured")
        if not token.isascii():
            raise RemoteParserError("远端解析凭据格式无效。", "invalid_configuration")
        self.base_url = urllib.parse.urlunsplit(parsed).rstrip("/")
        self.token = token
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.job_timeout = job_timeout
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _url(self, path: str) -> str:
        url = urllib.parse.urljoin(self.base_url + "/", path)
        base, target = urllib.parse.urlsplit(self.base_url), urllib.parse.urlsplit(url)
        if (base.scheme, base.netloc) != (target.scheme, target.netloc) or target.fragment or target.username or target.password:
            raise RemoteParserError("远端返回了不安全的结果地址。", "invalid_artifact")
        return url

    def _open(self, path: str, *, method: str = "GET", data: Any = None, headers: Any = None):
        request = urllib.request.Request(self._url(path), data=data, method=method, headers={"Authorization": "Bearer " + self.token, **(headers or {})})
        try:
            return self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            code = "remote_unauthorized" if status in {401, 403} else "remote_unavailable"
            raise RemoteParserError(f"远端解析请求失败（HTTP {status}）。", code) from None
        except (OSError, urllib.error.URLError, ValueError):
            raise RemoteParserError("无法连接远端解析服务，请检查连接与 SSH 隧道。") from None

    def _json(self, path: str, **kwargs: Any) -> dict:
        try:
            with self._open(path, **kwargs) as response:
                raw = response.read(1024 * 1024 + 1)
        except (OSError, http.client.HTTPException):
            raise RemoteParserError("远端解析连接中断。") from None
        try:
            if len(raw) > 1024 * 1024:
                raise ValueError()
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeDecodeError):
            raise RemoteParserError("远端解析响应格式无效。", "invalid_response") from None

    def health(self) -> dict:
        value = self._json("/v1/health")
        if value.get("status") != "ok" or value.get("ready") is not True or not isinstance(value.get("engine"), str) or not value.get("engine") or not isinstance(value.get("version"), str) or not value.get("version"):
            raise RemoteParserError("远端解析服务尚未就绪。", "remote_not_ready")
        return {key: value[key] for key in ("status", "ready", "engine", "version") if key in value}

    @staticmethod
    def _cancelled(cancel_event: Any) -> bool:
        return cancel_event is not None and cancel_event.is_set()

    def run(self, source: Path, output: Path, *, source_name: str, job_id: str, progress: Any = None, cancel_event: Any = None) -> dict:
        remote_id = None
        completed = False
        deadline = time.monotonic() + self.job_timeout
        try:
            if self._cancelled(cancel_event):
                raise RemoteParserError("远端解析已取消。", "cancelled")
            if progress:
                progress("上传到远端解析服务", 0.02)
            with source.open("rb") as stream:
                submitted = self._json("/v1/jobs", method="POST", data=stream, headers={"Content-Type": "application/pdf", "Content-Length": str(source.stat().st_size), "X-Filename": urllib.parse.quote(source_name, safe=""), "X-Client-Job-Id": hashlib.sha256(job_id.encode()).hexdigest()[:32]})
            remote_id = str(submitted.get("id") or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", remote_id):
                raise RemoteParserError("远端解析任务标识无效。", "invalid_response")
            while True:
                if self._cancelled(cancel_event):
                    raise RemoteParserError("远端解析已取消。", "cancelled")
                if time.monotonic() > deadline:
                    raise RemoteParserError("远端解析超时，请检查服务状态。", "remote_timeout")
                status = self._json(f"/v1/jobs/{remote_id}")
                state = status.get("status")
                if state == "completed":
                    break
                if state == "failed":
                    raise RemoteParserError("远端解析失败，请查看远端服务日志。", "remote_failed")
                if state == "cancelled":
                    raise RemoteParserError("远端解析已取消。", "cancelled")
                if state not in {"queued", "running"}:
                    raise RemoteParserError("远端解析任务状态无效。", "invalid_response")
                if progress:
                    fraction = float(status.get("progress") or 0)
                    progress("远端排队中" if state == "queued" else "远端融合解析中", max(0.03, min(0.9, fraction * 0.9)))
                if cancel_event is not None:
                    cancel_event.wait(self.poll_interval)
                else:
                    time.sleep(self.poll_interval)
            if progress:
                progress("下载并校验远端结果", 0.92)
            output.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="remote-parser-", dir=output.parent) as temporary:
                archive = Path(temporary) / "result.zip"
                with self._open(str(status.get("result_url") or f"/v1/jobs/{remote_id}/result")) as response, archive.open("wb") as target:
                    length = response.headers.get("Content-Length")
                    if length and int(length) > self.MAX_DOWNLOAD_BYTES:
                        raise RemoteParserError("远端结果超过下载限制。", "invalid_artifact")
                    size = 0
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if time.monotonic() > deadline:
                            raise RemoteParserError("远端解析结果下载超时。", "remote_timeout")
                        if size > self.MAX_DOWNLOAD_BYTES or self._cancelled(cancel_event):
                            raise RemoteParserError("远端解析已取消。" if self._cancelled(cancel_event) else "远端结果超过下载限制。", "cancelled" if self._cancelled(cancel_event) else "invalid_artifact")
                        target.write(chunk)
                extracted = Path(temporary) / "verified"
                manifest = self.extract_verified(archive, extracted, source, job_id, source_name)
                if self._cancelled(cancel_event):
                    raise RemoteParserError("远端解析已取消。", "cancelled")
                for entry in extracted.iterdir():
                    if (output / entry.name).exists():
                        raise RemoteParserError("远端结果输出目录非空。", "invalid_artifact")
                    shutil.move(str(entry), output / entry.name)
            completed = True
            return manifest
        except (zipfile.BadZipFile, OSError, ValueError, UnicodeDecodeError, RuntimeError, http.client.HTTPException) as exc:
            if isinstance(exc, RemoteParserError):
                raise
            raise RemoteParserError("远端解析制品无效或连接中断。", "invalid_artifact") from None
        finally:
            if remote_id and not completed:
                try:
                    self._json(f"/v1/jobs/{remote_id}/cancel", method="POST", data=b"")
                except Exception:
                    pass

    def extract_verified(self, archive: Path, destination: Path, source: Path, job_id: str, source_name: str) -> dict:
        destination.mkdir(parents=True, exist_ok=False)
        with zipfile.ZipFile(archive) as bundle:
            entries = bundle.infolist()
            if len(entries) > self.MAX_FILES or sum(entry.file_size for entry in entries) > self.MAX_EXPANDED_BYTES:
                raise RemoteParserError("远端制品展开大小超过限制。", "invalid_artifact")
            seen = set()
            for entry in entries:
                path = PurePosixPath(entry.filename)
                mode = entry.external_attr >> 16
                if not entry.filename or "\\" in entry.filename or path.is_absolute() or ".." in path.parts or ":" in entry.filename or entry.filename in seen or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}):
                    raise RemoteParserError("远端制品包含不安全路径。", "invalid_artifact")
                seen.add(entry.filename)
                target = destination.joinpath(*path.parts)
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(entry) as origin, target.open("xb") as sink:
                        shutil.copyfileobj(origin, sink, 1024 * 1024)
        if not all((destination / name).is_file() for name in self.REQUIRED):
            raise RemoteParserError("远端解析制品不完整。", "invalid_artifact")
        manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
        validation = json.loads((destination / "validation.json").read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or not isinstance(validation, dict) or validation.get("status") not in {"PASS", "REVIEW"}:
            raise RemoteParserError("远端解析结果校验未通过。", "invalid_artifact")
        def digest(path: Path) -> str:
            with path.open("rb") as stream:
                hasher = hashlib.sha256()
                while chunk := stream.read(1024 * 1024):
                    hasher.update(chunk)
                return hasher.hexdigest()
        source_info = manifest.get("source")
        expected = digest(source)
        if not isinstance(source_info, dict) or not hmac.compare_digest(str(source_info.get("sha256") or ""), expected) or not hmac.compare_digest(digest(destination / "source.pdf"), expected):
            raise RemoteParserError("远端解析结果与原始 PDF 不匹配。", "source_mismatch")
        for name in ("document.json", "document-ir.json"):
            if not isinstance(json.loads((destination / name).read_text(encoding="utf-8")), dict):
                raise RemoteParserError("远端文档结构无效。", "invalid_artifact")
        manifest["job_id"] = job_id
        manifest["source"]["filename"] = source_name
        (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return manifest
