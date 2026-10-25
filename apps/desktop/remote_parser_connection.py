"""Private remote-parser configuration and ownership-scoped SSH forwarding."""
from __future__ import annotations

import atexit
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from remote_parser_client import RemoteParserClient, RemoteParserError
from subprocess_runtime import hidden_subprocess_options, stop_windows_process_tree


class RemoteParserConnection:
    def __init__(self, config_path: Path) -> None:
        self.config_path = Path(config_path)
        self._process = None
        self._signature = None
        self._lock = threading.RLock()
        self._paused = False
        atexit.register(self.close)

    def config(self) -> dict:
        if not self.config_path.is_file():
            return {}
        try:
            value = json.loads(self.config_path.read_text(encoding="utf-8"))
            remote = value.get("remote_parser", {})
            if not isinstance(remote, dict):
                raise ValueError()
            return remote
        except (OSError, ValueError, AttributeError):
            raise RemoteParserError("远端解析私有配置无效。", "invalid_configuration") from None

    def configured(self) -> bool:
        value = self.config()
        return bool(value) and value.get("enabled", True) is not False

    def _stop(self) -> None:
        if self._process is not None:
            if self._process.poll() is None:
                if sys.platform == "win32":
                    stop_windows_process_tree(self._process)
                else:
                    self._process.terminate()
                try:
                    self._process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=3)
            self._process = None
        self._signature = None

    def close(self) -> None:
        with self._lock:
            self._paused = True
            self._stop()

    def connect(self) -> dict:
        with self._lock:
            self._paused = False
        return self.status()

    def client(self) -> RemoteParserClient:
        with self._lock:
            configuration = self.config()
            if not self.configured():
                self._stop()
                raise RemoteParserError("尚未配置远端融合解析服务。", "not_configured")
            if self._paused:
                raise RemoteParserError("远端连接已暂停，请在设置中重新连接。", "remote_disconnected")
            base_url = str(configuration.get("base_url") or "http://127.0.0.1:18770")
            try:
                _ = urlsplit(base_url).port
            except ValueError:
                raise RemoteParserError("远端解析地址端口无效。", "invalid_configuration") from None
            tunnel = configuration.get("ssh", {})
            if not isinstance(tunnel, dict):
                raise RemoteParserError("SSH 配置必须是对象。", "invalid_configuration")
            client = RemoteParserClient(base_url, str(configuration.get("token") or ""))
            signature = json.dumps(configuration, sort_keys=True)
            if self._signature != signature:
                self._stop()
            if tunnel.get("enabled", False):
                self._ensure_tunnel(tunnel, client.base_url)
            self._signature = signature
            return client

    def _ensure_tunnel(self, tunnel: dict, base_url: str) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        parsed = urlsplit(base_url)
        try:
            local_port = int(tunnel.get("local_port", 18770))
            remote_port = int(tunnel.get("remote_port", 18770))
            ssh_port = int(tunnel.get("port", 22))
            if not all(1 <= value <= 65535 for value in (local_port, remote_port, ssh_port)):
                raise ValueError()
        except (TypeError, ValueError):
            raise RemoteParserError("SSH 端口配置无效。", "invalid_configuration") from None
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port != local_port:
            raise RemoteParserError("SSH 隧道解析地址必须与本机 127.0.0.1 转发端口一致。", "invalid_configuration")
        host, user = str(tunnel.get("host") or ""), str(tunnel.get("user") or "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", host) or (user and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", user)):
            raise RemoteParserError("SSH 主机或用户配置无效。", "invalid_configuration")
        identity = Path(str(tunnel.get("identity_file") or "")).expanduser().resolve()
        known_hosts = Path(str(tunnel.get("known_hosts_file") or "")).expanduser().resolve()
        if not identity.is_file() or not known_hosts.is_file():
            raise RemoteParserError("SSH 私钥或已验证的 known_hosts 文件不存在。", "invalid_configuration")
        command = ["ssh", "-F", os.devnull, "-N", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known_hosts}", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-i", str(identity), "-p", str(ssh_port), "-L", f"127.0.0.1:{local_port}:127.0.0.1:{remote_port}", f"{user}@{host}" if user else host]
        try:
            # A pre-existing listener is never adopted as this process's tunnel.
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", local_port)) == 0:
                    raise RemoteParserError("SSH 本机转发端口已被占用。", "tunnel_conflict")
            self._process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **hidden_subprocess_options())
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if self._process.poll() is not None:
                    self._stop()
                    raise RemoteParserError("SSH 隧道启动失败，请核对主机指纹与私钥。", "tunnel_failed")
                with socket.socket() as probe:
                    if probe.connect_ex(("127.0.0.1", local_port)) == 0:
                        return
                time.sleep(0.1)
            self._stop()
            raise RemoteParserError("SSH 隧道连接超时。", "tunnel_failed")
        except OSError:
            self._stop()
            raise RemoteParserError("无法启动 SSH 隧道。", "tunnel_failed") from None

    def status(self) -> dict:
        base = {"configured": False, "ready": False}
        try:
            base["configured"] = self.configured()
            if not base["configured"]:
                with self._lock:
                    self._stop()
                raise RemoteParserError("尚未配置远端融合解析服务。", "not_configured")
            health = self.client().health()
            return {**base, **health, "state": "ready", "reason_code": "ready", "message": "远端融合解析已连接；导入与重新排版将在远端运行。"}
        except RemoteParserError as exc:
            if exc.code == "invalid_configuration":
                base["configured"] = True
            return {**base, "state": "disabled" if exc.code == "not_configured" else "unavailable", "reason_code": exc.code, "message": str(exc)}
