"""Process-owned, scoped MCP credentials; the desktop API token is never exported."""
from __future__ import annotations

import hmac
import json
import os
import secrets
import threading
from pathlib import Path
from urllib.parse import urlsplit

SCOPES = frozenset({f"{group}.{verb}" for group in ("library", "notes", "annotations", "vocabulary", "preferences") for verb in ("read", "write")} | {"plugins.manage", "ai.translate"})
DEFAULT_SCOPES = sorted(scope for scope in SCOPES if scope.endswith(".read"))


class MCPAccess:
    def __init__(self, data_root: Path):
        self.root = Path(data_root) / "mcp"
        self.config_file = self.root / "config.json"
        self.connection_file = self.root / "connection.json"
        self.lock = threading.RLock()
        self.enabled = False
        self.scopes = list(DEFAULT_SCOPES)
        self.token = ""
        self.url = ""
        try:
            value = json.loads(self.config_file.read_text(encoding="utf-8"))
            self.enabled = value.get("enabled") is True
            self.scopes = self._scopes(value.get("scopes", DEFAULT_SCOPES))
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    @staticmethod
    def _scopes(value):
        if not isinstance(value, list) or any(not isinstance(scope, str) or scope not in SCOPES for scope in value):
            raise ValueError("MCP scopes 包含无效权限。")
        return sorted(set(value))

    def _write(self, path, value):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        temporary = path.with_name('.' + path.name + '.' + secrets.token_hex(6))
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
        finally:
            temporary.unlink(missing_ok=True)

    def bind(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname not in {'localhost', '127.0.0.1', '::1'} or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError("MCP 仅支持 localhost HTTP 服务。")
        with self.lock:
            self.url = url
            self._refresh()

    def _refresh(self):
        self.token = secrets.token_urlsafe(32) if self.enabled and self.url else ""
        if self.token:
            self._write(self.connection_file, {"url": self.url, "token": self.token})
        else:
            self.connection_file.unlink(missing_ok=True)

    def configure(self, enabled, scopes):
        if not isinstance(enabled, bool):
            raise ValueError("enabled 必须是布尔值。")
        validated = self._scopes(scopes)
        with self.lock:
            self._write(self.config_file, {"enabled": enabled, "scopes": validated})
            self.enabled, self.scopes = enabled, validated
            self._refresh()
            return self.status()

    def rotate(self):
        with self.lock:
            self._refresh()
            return self.status()

    def authenticate(self, provided):
        with self.lock:
            return bool(self.enabled and self.token and provided and hmac.compare_digest(str(provided), self.token))

    def status(self):
        with self.lock:
            return {"enabled": self.enabled, "connected": bool(self.token), "scopes": list(self.scopes), "available_scopes": sorted(SCOPES), "connection_file": str(self.connection_file), "url": self.url}

    def close(self):
        with self.lock:
            self.token = ""
            self.connection_file.unlink(missing_ok=True)
