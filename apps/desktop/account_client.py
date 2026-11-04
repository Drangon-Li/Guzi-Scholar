"""Client side of the optional hosted account service.

Resolves the configured endpoint under the transport policy (HTTPS, or plain
HTTP to loopback only when explicitly allowed), refuses cross-origin redirects
and maps transport failures to :class:`AccountServiceUnavailable`.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

import runtime
from pipeline import PipelineError
from runtime import LOOPBACK_HOSTS


class AccountServiceUnavailable(PipelineError):
    """The account endpoint is unavailable or violates transport policy."""


def _account_service_configuration(url: Optional[str] = None) -> Dict[str, Any]:
    candidate = str(runtime.ACCOUNT_SERVICE_URL if url is None else url).strip().rstrip("/")
    if not candidate:
        return {"available": False, "secure": False, "error": "尚未配置账号服务。"}
    try:
        parsed = urlsplit(candidate)
        _ = parsed.port
    except ValueError:
        return {"available": False, "secure": False, "error": "账号服务地址格式无效。"}
    hostname = str(parsed.hostname or "").lower()
    if not hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return {"available": False, "secure": False, "error": "账号服务地址格式无效。"}
    if parsed.scheme == "https":
        return {"available": True, "secure": True, "server": candidate}
    if parsed.scheme == "http" and hostname in LOOPBACK_HOSTS:
        if runtime.ALLOW_INSECURE_LOOPBACK_ACCOUNT:
            return {
                "available": True,
                "secure": False,
                "development_only": True,
                "server": candidate,
            }
        return {
            "available": False,
            "secure": False,
            "error": "本地 HTTP 账号服务仅供开发；请显式设置 MY_SCHOLAR_ALLOW_INSECURE_LOOPBACK_ACCOUNT=1。",
        }
    if parsed.scheme == "http":
        return {"available": False, "secure": False, "error": "账号服务必须使用 HTTPS，已拒绝通过明文 HTTP 发送凭据。"}
    return {"available": False, "secure": False, "error": "账号服务必须使用 HTTPS。"}


class _AccountRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> Optional[urllib.request.Request]:
        current = urlsplit(req.full_url)
        redirected = urlsplit(newurl)
        try:
            current_port = current.port or (443 if current.scheme == "https" else 80)
            redirected_port = redirected.port or (443 if redirected.scheme == "https" else 80)
        except ValueError as exc:
            raise urllib.error.URLError("账号服务返回了无效的重定向地址。") from exc
        same_origin = (
            current.scheme,
            current.hostname,
            current_port,
        ) == (
            redirected.scheme,
            redirected.hostname,
            redirected_port,
        )
        if not same_origin or not _account_service_configuration(newurl).get("available"):
            raise urllib.error.URLError("账号服务尝试跳转到不安全或不同来源的地址。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _account_request(path: str, *, method: str = "GET", token: str = "", payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    configuration = _account_service_configuration()
    if not configuration.get("available"):
        raise AccountServiceUnavailable(str(configuration.get("error") or "账号服务当前不可用。"))
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(
        runtime.ACCOUNT_SERVICE_URL + path,
        data=json.dumps(payload or {}, ensure_ascii=False).encode("utf-8") if method == "POST" else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.build_opener(_AccountRedirectHandler()).open(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8", errors="replace")).get("error", "")
        except Exception:
            detail = ""
        raise PipelineError(detail or f"账号服务错误（HTTP {exc.code}）。") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AccountServiceUnavailable("无法安全连接账号服务器，请检查网络或 HTTPS 服务配置。") from exc
    return data if isinstance(data, dict) else {}
