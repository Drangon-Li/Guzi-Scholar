#!/usr/bin/env python3
"""Authenticated AI relay for the Guzi Scholar invite beta."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from config import AI_SERVICES, AI_TRANSLATION_MODES, DEFAULT_TRANSLATION_MODE, resolve_ai_profile
from user_service import AccountError, AccountStore


MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_MESSAGES = 24
# Must match the desktop translation adapter's hard generation ceiling.
# Conversational callers still send their own lower explicit budget.
MAX_OUTPUT_TOKENS = 4096
MAX_TRANSLATION_OUTPUT_TOKENS = 8192
MAX_TRANSLATION_TEXT_CHARS = 200_000
MAX_CHAT_TEXT_CHARS = 400_000
MAX_CHAT_IMAGE_DATA_CHARS = 7 * 1024 * 1024
MAX_STOP_ITEMS = 4
MAX_STOP_CHARS = 256
MAX_REQUESTS_PER_MINUTE = 12
MAX_CONCURRENT_REQUESTS = 3
MAX_GLOBAL_CONCURRENT_REQUESTS = 8
UPSTREAM_TIMEOUT_SECONDS = 120
def _daily_limit(service: str) -> int:
    defaults = {"translation": 500, "chat": 100}
    raw = os.environ.get(f"MY_SCHOLAR_AI_{service.upper()}_DAILY_LIMIT", str(defaults[service]))
    try:
        return max(1, min(10_000, int(raw)))
    except (TypeError, ValueError):
        return defaults[service]


def _daily_unit_limit(service: str) -> int:
    defaults = {"translation": 2_000_000, "chat": 10_000_000}
    raw = os.environ.get(f"MY_SCHOLAR_AI_{service.upper()}_DAILY_INPUT_UNITS", str(defaults[service]))
    try:
        return max(1, min(100_000_000, int(raw)))
    except (TypeError, ValueError):
        return defaults[service]


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlsplit(url)
    return parsed.scheme.lower(), str(parsed.hostname or "").lower(), parsed.port


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Mapping[str, str],
        newurl: str,
    ) -> urllib.request.Request:
        if _origin(req.full_url) != _origin(newurl):
            raise urllib.error.HTTPError(req.full_url, HTTPStatus.BAD_GATEWAY, "cross-origin redirect refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _sanitize_translation_options(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise AccountError("translation_options 格式无效。")
    result: dict[str, Any] = {}
    for key in ("source_lang", "target_lang"):
        if key in value:
            text = str(value[key]).strip()
            if not text or len(text) > 64:
                raise AccountError("翻译语言参数无效。")
            result[key] = text
    terms = value.get("terms")
    if terms is not None:
        if not isinstance(terms, list) or len(terms) > 256:
            raise AccountError("翻译术语数量过多。")
        clean_terms = []
        for item in terms:
            if not isinstance(item, dict):
                raise AccountError("翻译术语格式无效。")
            source = str(item.get("source", ""))
            target = str(item.get("target", ""))
            if not source or not target or len(source) > 256 or len(target) > 256:
                raise AccountError("翻译术语格式无效。")
            clean_terms.append({"source": source, "target": target})
        result["terms"] = clean_terms
    return result


def _translation_mode(profile: Mapping[str, Any] | None) -> str:
    candidate = str((profile or {}).get("mode", DEFAULT_TRANSLATION_MODE) or "").strip().lower()
    return candidate if candidate in AI_TRANSLATION_MODES else DEFAULT_TRANSLATION_MODE


def _output_token_limit(service: str, translation_mode: str = DEFAULT_TRANSLATION_MODE) -> int:
    return MAX_TRANSLATION_OUTPUT_TOKENS if service == "translation" else MAX_OUTPUT_TOKENS


def _sanitize_messages(service: str, messages: Any, *, translation_mode: str = DEFAULT_TRANSLATION_MODE) -> list[dict[str, Any]]:
    if not isinstance(messages, list) or not messages or len(messages) > MAX_MESSAGES:
        raise AccountError(f"messages 必须是 1-{MAX_MESSAGES} 项的数组。")
    if service == "translation":
        if translation_mode == "chat":
            if len(messages) != 2 or [str(item.get("role", "")) for item in messages if isinstance(item, dict)] != ["system", "user"]:
                raise AccountError("通用翻译请求必须包含一条 system 消息和一条 user 消息。")
        elif len(messages) != 1:
            raise AccountError("专用翻译请求只能包含一条 user 消息。")
    clean: list[dict[str, Any]] = []
    text_chars = 0
    image_count = 0
    for message in messages:
        if not isinstance(message, dict):
            raise AccountError("messages 中的每一项都必须是对象。")
        role = str(message.get("role", ""))
        allowed_roles = {"system", "user"} if service == "translation" and translation_mode == "chat" else ({"user"} if service == "translation" else {"system", "user", "assistant"})
        if role not in allowed_roles:
            raise AccountError("消息角色无效。")
        content = message.get("content")
        if isinstance(content, str):
            text_chars += len(content)
            clean_content: Any = content
        elif service == "chat" and isinstance(content, list) and 1 <= len(content) <= 4:
            clean_parts = []
            for part in content:
                if not isinstance(part, dict):
                    raise AccountError("多模态消息格式无效。")
                if part.get("type") == "text":
                    text = str(part.get("text", ""))
                    text_chars += len(text)
                    clean_parts.append({"type": "text", "text": text})
                elif part.get("type") == "image_url" and isinstance(part.get("image_url"), dict):
                    url = str(part["image_url"].get("url", ""))
                    if (
                        image_count >= 1
                        or len(url) > MAX_CHAT_IMAGE_DATA_CHARS
                        or not re.fullmatch(r"data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+", url)
                    ):
                        raise AccountError("图片消息无效或过大。")
                    image_count += 1
                    clean_parts.append({"type": "image_url", "image_url": {"url": url}})
                else:
                    raise AccountError("多模态消息格式无效。")
            clean_content = clean_parts
        else:
            raise AccountError("消息内容格式无效。")
        clean.append({"role": role, "content": clean_content})
    limit = MAX_TRANSLATION_TEXT_CHARS if service == "translation" else MAX_CHAT_TEXT_CHARS
    if text_chars < 1 or text_chars > limit:
        raise AccountError("消息文本为空或过长。", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    return clean


def _sanitize_number(value: Any, field: str, minimum: float, maximum: float) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise AccountError(f"{field} 参数无效。")
    number = float(value)
    if number < minimum or number > maximum:
        raise AccountError(f"{field} 参数超出允许范围。")
    return int(value) if isinstance(value, int) else number


def _sanitize_stop(value: Any) -> str | list[str]:
    values = [value] if isinstance(value, str) else value
    if not isinstance(values, list) or not values or len(values) > MAX_STOP_ITEMS:
        raise AccountError("stop 参数无效。")
    clean: list[str] = []
    for item in values:
        if not isinstance(item, str) or not item or len(item) > MAX_STOP_CHARS:
            raise AccountError("stop 参数无效。")
        clean.append(item)
    return clean[0] if isinstance(value, str) else clean


def _sanitize_response_format(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"type"} or value.get("type") != "json_object":
        raise AccountError("response_format 仅支持 json_object。")
    return {"type": "json_object"}


def _sanitize_effort(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", value):
        raise AccountError("推理强度参数无效。")
    return value


def _sanitize_thinking_controls(body: Mapping[str, Any], output_limit: int, thinking_limit: int) -> dict[str, Any]:
    clean: dict[str, Any] = {}

    def budget(value: Any, field: str, *, combined: bool = False) -> int:
        maximum = output_limit - 1 if combined else thinking_limit
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise AccountError(f"{field} 必须是正整数，且不能超过网关输出预算。")
        return value

    if "reasoning_effort" in body:
        clean["reasoning_effort"] = _sanitize_effort(body["reasoning_effort"])
    if "enable_thinking" in body:
        if not isinstance(body["enable_thinking"], bool):
            raise AccountError("enable_thinking 必须是布尔值。")
        clean["enable_thinking"] = body["enable_thinking"]
    if "thinking_budget" in body:
        clean["thinking_budget"] = budget(body["thinking_budget"], "thinking_budget")
    if "chat_template_kwargs" in body:
        value = body["chat_template_kwargs"]
        if not isinstance(value, dict) or set(value) != {"enable_thinking"} or not isinstance(value["enable_thinking"], bool):
            raise AccountError("chat_template_kwargs 仅支持布尔值 enable_thinking。")
        clean["chat_template_kwargs"] = dict(value)
    if "thinking" in body:
        value = body["thinking"]
        if (not isinstance(value, dict) or not set(value) <= {"type", "budget_tokens"}
                or value.get("type") not in {"enabled", "disabled", "adaptive", "between_tools"}):
            raise AccountError("thinking 参数格式无效。")
        thinking = {"type": value["type"]}
        if "budget_tokens" in value:
            if value["type"] != "enabled":
                raise AccountError("仅手动启用思考时可以设置 budget_tokens。")
            thinking["budget_tokens"] = budget(value["budget_tokens"], "thinking.budget_tokens", combined=True)
        clean["thinking"] = thinking
    if "reasoning" in body:
        value = body["reasoning"]
        if not isinstance(value, dict) or not value or not set(value) <= {"effort", "max_tokens", "enabled", "exclude"}:
            raise AccountError("reasoning 参数格式无效。")
        reasoning: dict[str, Any] = {}
        if "effort" in value:
            reasoning["effort"] = _sanitize_effort(value["effort"])
        if "max_tokens" in value:
            if "effort" in value:
                raise AccountError("reasoning 不能同时设置 effort 和 max_tokens。")
            reasoning["max_tokens"] = budget(value["max_tokens"], "reasoning.max_tokens", combined=True)
        for field in ("enabled", "exclude"):
            if field in value:
                if not isinstance(value[field], bool):
                    raise AccountError(f"reasoning.{field} 必须是布尔值。")
                reasoning[field] = value[field]
        clean["reasoning"] = reasoning
    if "output_config" in body:
        value = body["output_config"]
        if not isinstance(value, dict) or set(value) != {"effort"}:
            raise AccountError("output_config 仅支持 effort。")
        clean["output_config"] = {"effort": _sanitize_effort(value["effort"])}
    disabled = (clean.get("reasoning_effort") == "none" or clean.get("enable_thinking") is False
                or clean.get("chat_template_kwargs", {}).get("enable_thinking") is False
                or clean.get("thinking", {}).get("type") == "disabled"
                or clean.get("reasoning", {}).get("effort") == "none"
                or clean.get("reasoning", {}).get("enabled") is False)
    has_budget = ("thinking_budget" in clean or "budget_tokens" in clean.get("thinking", {})
                  or "max_tokens" in clean.get("reasoning", {}))
    if disabled and has_budget:
        raise AccountError("关闭思考时不能同时设置思考预算。")
    return clean


def _sanitize_request_body(service: str, body: Any, *, translation_mode: str = DEFAULT_TRANSLATION_MODE) -> tuple[dict[str, Any], int]:
    if not isinstance(body, dict):
        raise AccountError("AI 请求必须是 JSON 对象。")
    clean: dict[str, Any] = {"messages": _sanitize_messages(service, body.get("messages"), translation_mode=translation_mode)}
    numeric_fields = {
        "temperature": (0.0, 2.0),
        "top_p": (0.0, 1.0),
        "frequency_penalty": (-2.0, 2.0),
        "presence_penalty": (-2.0, 2.0),
    }
    for field, (minimum, maximum) in numeric_fields.items():
        if field in body:
            clean[field] = _sanitize_number(body[field], field, minimum, maximum)
    if "seed" in body:
        seed = body["seed"]
        if isinstance(seed, bool) or not isinstance(seed, int) or not -(2**31) <= seed < 2**31:
            raise AccountError("seed 参数无效。")
        clean["seed"] = seed
    if "stream" in body:
        if not isinstance(body["stream"], bool):
            raise AccountError("stream 参数无效。")
        clean["stream"] = body["stream"]
    for token_field in ("max_tokens", "max_completion_tokens"):
        if token_field in body:
            value = body[token_field]
            if isinstance(value, bool):
                raise AccountError(f"{token_field} 参数无效。")
            try:
                clean[token_field] = max(1, min(_output_token_limit(service, translation_mode), int(value)))
            except (TypeError, ValueError) as exc:
                raise AccountError(f"{token_field} 参数无效。") from exc
    if "max_tokens" in clean and "max_completion_tokens" in clean:
        raise AccountError("max_tokens 和 max_completion_tokens 不能同时设置。")
    output_limit = clean.get("max_completion_tokens", clean.get("max_tokens", _output_token_limit(service, translation_mode)))
    clean.update(_sanitize_thinking_controls(body, output_limit, _output_token_limit(service, translation_mode)))
    if "response_format" in body:
        clean["response_format"] = _sanitize_response_format(body["response_format"])
    if "stop" in body:
        clean["stop"] = _sanitize_stop(body["stop"])
    if service == "translation" and translation_mode == "chat" and "translation_options" in body:
        raise AccountError("通用翻译请求不支持 translation_options。")
    if service == "translation" and translation_mode == "qwen-mt" and "translation_options" in body:
        clean["translation_options"] = _sanitize_translation_options(body["translation_options"])
    encoded = json.dumps(clean, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return clean, max(1, len(encoded))


class RequestLimiter:
    def __init__(
        self,
        requests_per_minute: int = MAX_REQUESTS_PER_MINUTE,
        concurrent_requests: int = MAX_CONCURRENT_REQUESTS,
        global_concurrent_requests: int = MAX_GLOBAL_CONCURRENT_REQUESTS,
    ) -> None:
        self.requests_per_minute = requests_per_minute
        self.concurrent_requests = concurrent_requests
        self.global_concurrent_requests = global_concurrent_requests
        self._lock = threading.Lock()
        self._recent: dict[int, deque[float]] = defaultdict(deque)
        self._active: dict[int, int] = defaultdict(int)
        self._global_active = 0

    def acquire(self, user_id: int) -> tuple[bool, int]:
        now = time.monotonic()
        with self._lock:
            recent = self._recent[user_id]
            while recent and recent[0] <= now - 60:
                recent.popleft()
            if self._active[user_id] >= self.concurrent_requests or self._global_active >= self.global_concurrent_requests:
                return False, 1
            if len(recent) >= self.requests_per_minute:
                return False, max(1, int(60 - (now - recent[0])))
            recent.append(now)
            self._active[user_id] += 1
            self._global_active += 1
            return True, 0

    def release(self, user_id: int) -> None:
        with self._lock:
            self._active[user_id] = max(0, self._active[user_id] - 1)
            self._global_active = max(0, self._global_active - 1)


def _endpoint(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    parsed = urlsplit(normalized)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return ""
    if normalized.endswith("/chat/completions"):
        return normalized
    if normalized.endswith("/v1"):
        return normalized + "/chat/completions"
    return normalized + "/v1/chat/completions"


def load_profiles() -> dict[str, dict[str, str]]:
    return {service: resolve_ai_profile(service) for service in AI_SERVICES}


def _configured(profile: Mapping[str, str]) -> bool:
    return bool(_endpoint(profile.get("base_url", "")) and profile.get("api_key") and profile.get("model"))


def _open_provider(
    service: str,
    profile: Mapping[str, str],
    outbound: Mapping[str, Any],
    open_request: Callable[..., Any],
    *,
    timeout: int,
) -> Any:
    endpoint = _endpoint(str(profile.get("base_url", "")))

    def open_body(body: Mapping[str, Any]) -> Any:
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(dict(body), ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": "Bearer " + str(profile["api_key"]),
                "Content-Type": "application/json",
                "Accept": "text/event-stream" if bool(body.get("stream")) else "application/json",
            },
            method="POST",
        )
        return open_request(request, timeout=timeout)

    try:
        return open_body(outbound)
    except urllib.error.HTTPError as exc:
        retryable = exc.code in {400, 422} and "response_format" in outbound
        exc.close()
        if not retryable:
            raise
        retry_body = dict(outbound)
        retry_body.pop("response_format", None)
        return open_body(retry_body)


def probe_profiles(
    profiles: Mapping[str, Mapping[str, str]] | None = None,
    *,
    opener: Callable[..., Any] | None = None,
    timeout: int = 20,
) -> dict[str, Any]:
    resolved = profiles or load_profiles()
    open_request = opener or urllib.request.build_opener(_SameOriginRedirectHandler()).open
    results: dict[str, dict[str, Any]] = {}
    for service in AI_SERVICES:
        profile = resolved.get(service, {})
        started = time.monotonic()
        if not _configured(profile):
            results[service] = {"ok": False, "error": "not_configured"}
            continue
        messages = (
            [
                {"role": "system", "content": "You are a translation engine. Return only the translation."},
                {"role": "user", "content": "<source_text>\nConnection test.\n</source_text>"},
            ]
            if service == "translation" and _translation_mode(profile) == "chat"
            else [{"role": "user", "content": "Connection test. Reply only OK."}]
        )
        outbound: dict[str, Any] = {
            "model": str(profile["model"]),
            "messages": messages,
            "stream": False,
            "max_tokens": 512,
        }
        if service == "translation" and _translation_mode(profile) == "qwen-mt":
            outbound["translation_options"] = {"source_lang": "auto", "target_lang": "Chinese"}
        try:
            with _open_provider(service, profile, outbound, open_request, timeout=timeout) as response:
                status = int(getattr(response, "status", HTTPStatus.OK))
                payload = response.read(64 * 1024)
            if not 200 <= status < 300 or not payload:
                raise RuntimeError("provider response was empty")
            envelope = json.loads(payload.decode("utf-8", errors="replace"))
            choices = envelope.get("choices") if isinstance(envelope, dict) else None
            if not isinstance(choices, list) or not choices:
                raise RuntimeError("provider response shape was invalid")
            results[service] = {
                "ok": True,
                "model": str(profile["model"]),
                "elapsed_ms": max(0, int((time.monotonic() - started) * 1000)),
            }
        except (OSError, TimeoutError, ValueError, KeyError, json.JSONDecodeError):
            results[service] = {"ok": False, "error": "provider_probe_failed"}
    return {"ok": all(result.get("ok") is True for result in results.values()), "services": results}


def build_handler(
    store: AccountStore,
    profiles: Mapping[str, Mapping[str, str]],
    *,
    opener: Callable[..., Any] | None = None,
    limiter: RequestLimiter | None = None,
) -> type[BaseHTTPRequestHandler]:
    request_limiter = limiter or RequestLimiter()
    open_request = opener or urllib.request.build_opener(_SameOriginRedirectHandler()).open

    class AIGatewayHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "GuziScholarAI/1.0"
        sys_version = ""

        def _send_json(
            self,
            body: Mapping[str, Any],
            status: int = HTTPStatus.OK,
            headers: Mapping[str, str] | None = None,
        ) -> None:
            payload = json.dumps(dict(body), ensure_ascii=False).encode("utf-8")
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(payload)

        def _bearer_token(self) -> str:
            authorization = str(self.headers.get("Authorization", ""))
            if not authorization.startswith("Bearer "):
                return ""
            token = authorization[7:].strip()
            return token if 1 <= len(token) <= 4096 else ""

        def _read_body(self, service: str) -> tuple[dict[str, Any], int]:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise AccountError("请求正文长度无效。") from exc
            if length < 1 or length > MAX_BODY_BYTES:
                raise AccountError("AI 请求正文为空或过大。", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise AccountError("AI 请求必须是有效 JSON。") from exc
            return _sanitize_request_body(service, body, translation_mode=_translation_mode(profiles.get(service)))

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            if self.path != "/health":
                self._send_json({"error": "未找到接口。"}, HTTPStatus.NOT_FOUND)
                return
            services = {
                name: {
                    "configured": _configured(profiles.get(name, {})),
                    "model": str(profiles.get(name, {}).get("model", "")) or None,
                }
                for name in AI_SERVICES
            }
            ready = all(service["configured"] for service in services.values())
            self._send_json(
                {"ok": ready, "service": "guzi-scholar-ai", "services": services},
                HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE,
            )

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
            routes = {
                "/translation/v1/chat/completions": "translation",
                "/chat/v1/chat/completions": "chat",
            }
            service = routes.get(self.path)
            if service is None:
                self._send_json({"error": "未找到接口。"}, HTTPStatus.NOT_FOUND)
                return
            try:
                token = self._bearer_token()
                if not token:
                    raise AccountError("请先登录内测账号。", HTTPStatus.UNAUTHORIZED)
                user = store.authenticate(token)
                if not bool(user["member"]):
                    raise AccountError("当前账号没有有效的免费内测资格。", HTTPStatus.FORBIDDEN)
                if not AccountStore.has_beta_access(user):
                    raise AccountError("请在最新版谷子学术中重新登录并同意当前协议。", HTTPStatus.FORBIDDEN)
                profile = profiles.get(service, {})
                if not _configured(profile):
                    raise AccountError("AI 服务暂时不可用。", HTTPStatus.SERVICE_UNAVAILABLE)
                user_id = int(user["id"])
                accepted, retry_after = request_limiter.acquire(user_id)
                if not accepted:
                    self._send_json(
                        {"error": "请求较多，请稍后再试。"},
                        HTTPStatus.TOO_MANY_REQUESTS,
                        {"Retry-After": str(retry_after)},
                    )
                    return
                reserved = False
                charge_committed = False
                input_units = 0
                try:
                    body, input_units = self._read_body(service)
                    store.reserve_ai_request(
                        user_id,
                        service,
                        _daily_limit(service),
                        input_units,
                        _daily_unit_limit(service),
                    )
                    reserved = True
                    upstream_body = dict(body)
                    upstream_body["model"] = str(profile["model"])
                    upstream_body["stream"] = body.get("stream") is True
                    if "max_tokens" not in upstream_body and "max_completion_tokens" not in upstream_body:
                        upstream_body["max_tokens"] = _output_token_limit(service, _translation_mode(profile))
                    response = _open_provider(
                        service,
                        profile,
                        upstream_body,
                        open_request,
                        timeout=UPSTREAM_TIMEOUT_SECONDS,
                    )
                    with response:
                        charge_committed = True
                        content_type = str(response.headers.get("Content-Type", "application/json"))
                        self.send_response(int(getattr(response, "status", HTTPStatus.OK)))
                        self.send_header("Content-Type", content_type)
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("Connection", "close")
                        self.end_headers()
                        read_chunk = getattr(response, "read1", response.read)
                        while True:
                            chunk = read_chunk(64 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            self.wfile.flush()
                        self.close_connection = True
                finally:
                    if reserved and not charge_committed:
                        store.refund_ai_request(user_id, service, input_units)
                    request_limiter.release(user_id)
            except AccountError as exc:
                self._send_json({"error": str(exc)}, exc.status)
            except urllib.error.HTTPError as exc:
                if exc.code == HTTPStatus.TOO_MANY_REQUESTS:
                    self._send_json({"error": "AI 服务繁忙，请稍后再试。"}, HTTPStatus.TOO_MANY_REQUESTS)
                else:
                    self._send_json({"error": "AI 服务暂时不可用。"}, HTTPStatus.BAD_GATEWAY)
            except (urllib.error.URLError, TimeoutError):
                self._send_json({"error": "AI 服务连接超时，请稍后再试。"}, HTTPStatus.BAD_GATEWAY)
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            except Exception:
                self._send_json({"error": "AI 服务暂时不可用。"}, HTTPStatus.BAD_GATEWAY)

        def log_message(self, format: str, *args: Any) -> None:
            super().log_message(format, *args)

    return AIGatewayHandler


def serve(database: str, host: str, port: int) -> None:
    store = AccountStore(database)
    server = ThreadingHTTPServer((host, port), build_handler(store, load_profiles()))
    server.daemon_threads = True
    try:
        server.serve_forever()
    finally:
        server.server_close()
        store.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Guzi Scholar authenticated AI gateway")
    commands = parser.add_subparsers(dest="command", required=True)
    serve_parser = commands.add_parser("serve", help="run the authenticated gateway")
    serve_parser.add_argument("--db", required=True)
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8480)
    probe_parser = commands.add_parser("probe", help="verify both configured providers")
    probe_parser.add_argument("--timeout", type=int, default=20)
    options = parser.parse_args()
    if options.command == "serve":
        serve(options.db, options.host, options.port)
        return
    result = probe_profiles(timeout=max(1, min(120, options.timeout)))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    if not result["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
