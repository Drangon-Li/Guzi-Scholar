"""Model metadata discovery without treating a catalog as an access grant."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from collections.abc import Mapping
from typing import Any

from ai_model_catalog import CATALOG, CATALOG_DATE, CATALOG_URL


API_FORMATS = ("auto", "openai", "openai-responses", "anthropic", "qwen", "deepseek", "glm", "openrouter", "chat-template")
DEFAULT_AI_OPTIONS = {"api_format": "auto", "reasoning_effort": "auto", "thinking_budget": 0, "context_window": 0}
MAX_MODELS = 500
MAX_MODEL_ID_CHARS = 256
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_CATALOG_BYTES = 16 * 1024 * 1024
CAPABILITY_CACHE_SECONDS = 15 * 60
CATALOG_REFRESH_SECONDS = 24 * 60 * 60
_EFFORT = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")
_lock = threading.Lock()
_capability_cache: OrderedDict[tuple[str, str, str, str], tuple[float, dict]] = OrderedDict()
_catalog = CATALOG
_catalog_date = CATALOG_DATE
_catalog_checked_at = 0.0


def normalize_ai_options(value: Any, strict: bool = False) -> dict[str, Any]:
    if value is None:
        value = {}
    if not isinstance(value, Mapping):
        if strict:
            raise ValueError("AI 选项必须为对象。")
        value = {}
    result = dict(DEFAULT_AI_OPTIONS)
    for field in ("api_format", "reasoning_effort"):
        raw = value.get(field, result[field])
        candidate = raw.strip().lower() if isinstance(raw, str) else ""
        valid = candidate in API_FORMATS if field == "api_format" else bool(_EFFORT.fullmatch(candidate))
        if not valid:
            if strict:
                raise ValueError(f"无效的 AI 选项：{field}。")
        else:
            result[field] = candidate
    for field in ("thinking_budget", "context_window"):
        raw = value.get(field, 0)
        if isinstance(raw, int) and not isinstance(raw, bool) and 0 <= raw <= 2**31 - 1:
            result[field] = raw
        elif strict:
            raise ValueError(f"{field} 必须是 0 到 2147483647 之间的整数。")
    return result


def resolve_api_format(profile: Mapping[str, Any]) -> str:
    configured = normalize_ai_options(profile)["api_format"]
    if configured != "auto":
        return configured
    parsed = urllib.parse.urlsplit(str(profile.get("base_url") or ""))
    host, path = (parsed.hostname or "").lower(), parsed.path.rstrip("/").lower()
    if path.endswith("/responses"):
        return "openai-responses"
    if path.endswith("/messages"):
        return "anthropic"
    if host == "api.anthropic.com":
        return "anthropic"
    if host in {"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"}:
        return "qwen"
    if host == "api.deepseek.com":
        return "deepseek"
    if host in {"open.bigmodel.cn", "api.z.ai"} or path.endswith(("/api/paas/v4", "/api/coding/paas/v4")):
        return "glm"
    if host == "openrouter.ai":
        return "openrouter"
    return "openai"


def _unknown_capabilities() -> dict[str, Any]:
    return {"context_window": None, "max_input_tokens": None, "max_output_tokens": None,
            "reasoning_efforts": None, "thinking_supported": None, "thinking_required": None,
            "thinking_budget_supported": None, "thinking_budget_min": None, "thinking_budget_max": None,
            "temperature_supported": None, "source": "unknown", "matched_model": None}


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _integer(value: Any, *, zero: bool = False) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= (0 if zero else 1):
        return value
    return None


def _supported(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    supported = _mapping(value).get("supported")
    return supported if isinstance(supported, bool) else None


def _efforts(value: Any) -> list[str] | None:
    if isinstance(value, Mapping):
        for key in ("supported_levels", "values", "levels"):
            if key in value:
                return _efforts(value[key])
        levels = [key for key, item in value.items() if _EFFORT.fullmatch(str(key)) and _supported(item) is True]
        return levels if levels else ([] if value.get("supported") is False else None)
    if isinstance(value, list):
        return list(dict.fromkeys(item for item in value if isinstance(item, str) and _EFFORT.fullmatch(item)))
    return None


def _metadata_capabilities(model: Mapping[str, Any]) -> dict[str, Any]:
    result = _unknown_capabilities()
    info, caps = _mapping(model.get("model_info")), _mapping(model.get("capabilities"))
    limits = _mapping(model.get("limit"))
    sources = [model, caps, info]
    aliases = {
        "context_window": ("context_window", "context_length", "max_context_length", "max_sequence_length"),
        "max_input_tokens": ("max_input_tokens", "input_token_limit", "max_input_length"),
        "max_output_tokens": ("max_output_tokens", "max_completion_tokens", "output_token_limit", "max_output_length", "max_tokens"),
    }
    for target, keys in aliases.items():
        result[target] = next((number for source in sources for key in keys if (number := _integer(source.get(key))) is not None), None)
    for target, key in (("context_window", "context"), ("max_input_tokens", "input"), ("max_output_tokens", "output")):
        if result[target] is None:
            result[target] = _integer(limits.get(key))
    top_provider = _mapping(model.get("top_provider"))
    if result["max_output_tokens"] is None:
        result["max_output_tokens"] = _integer(top_provider.get("max_completion_tokens"))

    reasoning = caps.get("reasoning", model.get("reasoning"))
    thinking = caps.get("thinking", model.get("thinking"))
    reasoning_data, thinking_data = _mapping(reasoning), _mapping(thinking)
    result["thinking_supported"] = _supported(reasoning)
    if _supported(thinking) is not None:
        result["thinking_supported"] = _supported(thinking)
    required = model.get("thinking_required", thinking_data.get("required", reasoning_data.get("required")))
    if isinstance(required, bool):
        result["thinking_required"] = required
    if result["thinking_supported"] is False:
        result["thinking_required"] = False
    effort = caps.get("effort", model.get("effort", reasoning_data.get("effort")))
    result["reasoning_efforts"] = _efforts(model.get("reasoning_efforts", effort))
    budget = _mapping(reasoning_data.get("budget", thinking_data.get("budget")))
    budget_supported = model.get("thinking_budget_supported", caps.get("thinking_budget_supported", _supported(budget)))
    if isinstance(budget_supported, bool):
        result["thinking_budget_supported"] = budget_supported
    result["thinking_budget_min"] = _integer(model.get("thinking_budget_min", budget.get("min")), zero=True)
    result["thinking_budget_max"] = _integer(model.get("thinking_budget_max", budget.get("max")), zero=True)
    options = model.get("reasoning_options")
    if isinstance(options, list):
        controls = [_mapping(option).get("type") for option in options]
        if any(control in {"effort", "toggle", "budget_tokens"} for control in controls):
            result["thinking_budget_supported"] = "budget_tokens" in controls
        for option in options:
            option = _mapping(option)
            if option.get("type") == "effort":
                result["reasoning_efforts"] = _efforts(option.get("values"))
            elif option.get("type") == "toggle":
                result["thinking_required"] = False
            elif option.get("type") == "budget_tokens":
                result["thinking_budget_min"] = _integer(option.get("min"), zero=True)
                result["thinking_budget_max"] = _integer(option.get("max"), zero=True)
    if result["reasoning_efforts"] and "none" in result["reasoning_efforts"]:
        result["thinking_required"] = False
    # Anthropic exposes supported thinking types independently of effort levels.
    types = _mapping(thinking_data.get("types"))
    if any(_supported(item) is True for key, item in types.items() if key != "disabled"):
        result["thinking_supported"] = True
    if "disabled" in types and _supported(types["disabled"]) is not None:
        result["thinking_required"] = not _supported(types["disabled"]) if result["thinking_supported"] else None
    if types and _supported(types.get("disabled")) is True:
        result["thinking_required"] = False
    modes = []
    if _supported(types.get("enabled")) is True:
        modes.append("manual")
        result["thinking_budget_supported"] = True
    if _supported(types.get("adaptive")) is True:
        modes.append("adaptive")
    if modes:
        result["thinking_modes"] = modes
    if result["thinking_supported"] is False:
        result["thinking_budget_supported"] = False
    if result["thinking_budget_min"] is not None or result["thinking_budget_max"] is not None:
        result["thinking_budget_supported"] = True
    temperature = caps.get("temperature", model.get("temperature_supported", model.get("temperature")))
    result["temperature_supported"] = _supported(temperature)
    return result


def _provider_id(profile: Mapping[str, Any]) -> str | None:
    host = (urllib.parse.urlsplit(str(profile.get("base_url") or "")).hostname or "").lower()
    return {"api.openai.com": "openai", "api.anthropic.com": "anthropic",
            "api.deepseek.com": "deepseek", "dashscope.aliyuncs.com": "alibaba-cn",
            "dashscope-intl.aliyuncs.com": "alibaba", "dashscope-us.aliyuncs.com": "alibaba",
            "open.bigmodel.cn": "zhipuai", "api.z.ai": "zai", "openrouter.ai": "openrouter"}.get(host)


def _catalog_capabilities(profile: Mapping[str, Any]) -> dict[str, Any]:
    model_id = str(profile.get("model") or "").strip()
    if not model_id:
        return _unknown_capabilities()
    with _lock:
        catalog, date = _catalog, _catalog_date
    provider = _provider_id(profile)
    candidates = []
    if provider in catalog:
        candidates.append((provider, model_id))
    if "/" in model_id:
        namespace, short_id = model_id.split("/", 1)
        namespace = {"qwen": "alibaba", "z-ai": "zai"}.get(namespace, namespace)
        if namespace in catalog:
            candidates.append((namespace, short_id))
    if not candidates:
        # Exact identifiers only; deployment names and family prefixes are not aliases.
        for name in ("openai", "anthropic", "alibaba", "alibaba-cn", "deepseek", "zhipuai", "zai"):
            if model_id in _mapping(_mapping(catalog.get(name)).get("models")):
                candidates.append((name, model_id))
    for name, candidate in candidates:
        record = _mapping(_mapping(catalog.get(name)).get("models")).get(candidate)
        if isinstance(record, Mapping):
            result = _metadata_capabilities(record)
            result.update(source=f"models.dev:{date}", matched_model=f"{name}/{candidate}")
            return result
    return _unknown_capabilities()



def _anthropic_thinking_rules(profile: Mapping[str, Any], capabilities: dict[str, Any]) -> dict[str, Any]:
    # Verified 2026-10-22; exact IDs only, never extrapolate to future models.
    # https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
    # https://platform.claude.com/docs/en/build-with-claude/effort
    if resolve_api_format(profile) != "anthropic":
        return capabilities
    model = str(profile.get("model") or "").removeprefix("anthropic/")
    modern = {"claude-fable-5-1", "claude-fable-5", "claude-mythos-5-1", "claude-mythos-5",
              "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
              "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"}
    manual_and_adaptive = {"claude-opus-4-6", "claude-sonnet-4-6", "claude-mythos-preview"}
    manual = {"claude-opus-4-5", "claude-haiku-4-5", "claude-sonnet-4-5"}
    if model not in modern | manual_and_adaptive | manual:
        return capabilities
    result = dict(capabilities)
    result.update(thinking_supported=True,
                  thinking_modes=["adaptive"] if model in modern else (["adaptive", "manual"] if model in manual_and_adaptive else ["manual"]))
    result["thinking_budget_supported"] = "manual" in result["thinking_modes"]
    if "manual" in result["thinking_modes"]:
        result["thinking_budget_min"] = 1024
    # A custom gateway can choose different thinking constraints; only enforce
    # Anthropic's off-mode restrictions for its own native endpoint.
    if _provider_id(profile) == "anthropic":
        result["thinking_required"] = model in {"claude-fable-5-1", "claude-fable-5", "claude-mythos-5-1", "claude-mythos-5", "claude-mythos-preview", "claude-opus-5-5"}
        if model == "claude-sonnet-5-5":
            result.update(thinking_off_type="between_tools", thinking_off_effort="high")
        elif model in {"claude-opus-5", "claude-haiku-5-5"}:
            result["thinking_off_effort"] = "high"
    if model in modern:
        result["reasoning_efforts"] = ["low", "medium", "high", "xhigh", "max"]
    elif model in manual_and_adaptive:
        result["reasoning_efforts"] = ["low", "medium", "high", "max"]
    elif model == "claude-opus-4-5":
        result["reasoning_efforts"] = ["low", "medium", "high"]
    else:
        result["reasoning_efforts"] = []
    result["thinking_source"] = "https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting"
    return result

def _cache_key(profile: Mapping[str, Any]) -> tuple[str, str, str, str]:
    return (str(profile.get("base_url") or "").strip().rstrip("/"), resolve_api_format(profile),
            hashlib.sha256(str(profile.get("api_key") or "").encode()).hexdigest(), str(profile.get("model") or "").strip())


def get_model_capabilities(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Read known limits locally; a context budget never changes discovered limits."""
    key = _cache_key(profile)
    with _lock:
        cached = _capability_cache.get(key)
        if cached and time.monotonic() - cached[0] < CAPABILITY_CACHE_SECONDS:
            _capability_cache.move_to_end(key)
            return copy.deepcopy(cached[1])
        if cached:
            del _capability_cache[key]
    return _anthropic_thinking_rules(profile, _catalog_capabilities(profile))


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), parsed.port or (443 if parsed.scheme.lower() == "https" else 80)


class _SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        if _origin(request.full_url) != _origin(newurl):
            raise urllib.error.HTTPError(request.full_url, code, "Cross-origin redirect refused", headers, fp)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def _request_json(url: str, headers: Mapping[str, str], timeout: float, max_bytes: int) -> Any:
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    opener = urllib.request.build_opener(_SameOriginRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read(max_bytes + 1)
    except urllib.error.HTTPError as exc:
        exc.close()
        raise
    if len(body) > max_bytes:
        raise RuntimeError("模型列表响应超过安全上限。")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("模型列表响应不是有效 JSON。") from exc


def _models_endpoint(profile: Mapping[str, Any]) -> str:
    base = str(profile.get("base_url") or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("请配置有效的 HTTP(S) AI 服务 Base URL。")
    path, api_format = parsed.path.rstrip("/"), resolve_api_format(profile)
    for suffix in ("/chat/completions", "/responses", "/messages"):
        if path.endswith(suffix):
            path = path[:-len(suffix)]
            break
    if path.endswith("/models"):
        pass
    elif api_format == "qwen" and (not path or path.startswith("/api/v1")):
        path = "/api/v1/models"
    elif api_format == "deepseek" and not path:
        path = "/models"
    elif api_format == "openrouter" and not path:
        path = "/api/v1/models"
    elif api_format == "glm" and not path:
        path = "/api/paas/v4/models"
    elif path.endswith(("/v1", "/v4")) or api_format == "glm":
        path += "/models"
    else:
        path += "/v1/models"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, ""))


def _refresh_catalog(timeout: float) -> None:
    global _catalog, _catalog_date, _catalog_checked_at
    now = time.monotonic()
    with _lock:
        if _catalog_checked_at and now - _catalog_checked_at < CATALOG_REFRESH_SECONDS:
            return
        _catalog_checked_at = now
    try:
        payload = _request_json(CATALOG_URL, {"Accept": "application/json"}, min(timeout, 3), MAX_CATALOG_BYTES)
    except (RuntimeError, urllib.error.URLError, TimeoutError, OSError, ValueError):
        return
    if not isinstance(payload, Mapping):
        return
    # Bound the retained public catalog as well as the HTTP response.
    retained = {}
    count = 0
    for provider_id, provider in list(payload.items())[:500]:
        models = _mapping(_mapping(provider).get("models"))
        selected = {}
        for model_id, record in models.items():
            if isinstance(record, Mapping) and isinstance(model_id, str) and len(model_id) <= MAX_MODEL_ID_CHARS:
                selected[model_id] = {key: record[key] for key in ("id", "limit", "reasoning", "reasoning_options", "temperature", "capabilities") if key in record}
                count += 1
                if count >= 20000:
                    break
        if selected:
            retained[provider_id] = {"models": selected}
        if count >= 20000:
            break
    if retained:
        with _lock:
            _catalog = {**CATALOG, **retained}
            _catalog_date = time.strftime("%Y-%m-%d", time.gmtime())


def _model_id(item: Any) -> str:
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, Mapping):
        for source in (item, _mapping(item.get("model_info"))):
            for field in ("id", "model", "model_id", "name", "model_name"):
                candidate = source.get(field)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip()
    return ""


def discover_models(profile: Mapping[str, Any], timeout_seconds: float | None = None) -> list[dict[str, Any]]:
    """Query this endpoint with this key, then enrich only the returned model IDs."""
    url = _models_endpoint(profile)
    api_format = resolve_api_format(profile)
    headers = {"Accept": "application/json"}
    key = str(profile.get("api_key") or "").strip()
    if key:
        headers["x-api-key" if api_format == "anthropic" else "Authorization"] = key if api_format == "anthropic" else "Bearer " + key
    if api_format == "anthropic":
        headers["anthropic-version"] = "2023-06-01"
    timeout = timeout_seconds if timeout_seconds is not None else float(os.environ.get("MY_SCHOLAR_AI_MODEL_TIMEOUT", "15"))
    records, seen = [], set()
    deadline = time.monotonic() + timeout
    try:
        while len(records) < MAX_MODELS:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            payload = _request_json(url, headers, remaining, MAX_RESPONSE_BYTES)
            if isinstance(payload, Mapping):
                raw = payload.get("data", payload.get("models", _mapping(payload.get("output")).get("models", [])))
                if isinstance(raw, Mapping):
                    raw = raw.get("models", [])
            else:
                raw = payload
            if not isinstance(raw, list):
                raise RuntimeError("模型列表响应格式不受支持。")
            before = len(records)
            for item in raw:
                model_id = _model_id(item)
                if not model_id or len(model_id) > MAX_MODEL_ID_CHARS or model_id in seen:
                    continue
                seen.add(model_id)
                records.append((model_id, _mapping(item)))
                if len(records) >= MAX_MODELS:
                    break
            if api_format != "anthropic" or not isinstance(payload, Mapping) or not payload.get("has_more") or len(records) == before:
                break
            last_id = payload.get("last_id")
            if not isinstance(last_id, str) or not last_id or len(last_id) > MAX_MODEL_ID_CHARS:
                break
            parsed = urllib.parse.urlsplit(url)
            query = dict(urllib.parse.parse_qsl(parsed.query))
            if query.get("after_id") == last_id:
                break
            query["after_id"] = last_id
            url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"模型列表请求失败（HTTP {exc.code}）。") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError("无法连接模型列表服务，请检查 Base URL 和网络。") from exc
    if not records:
        raise RuntimeError("服务未返回可用模型。")
    _refresh_catalog(max(0.1, deadline - time.monotonic()))
    result = []
    for model_id, record in records:
        model_profile = {**profile, "model": model_id}
        capabilities = _anthropic_thinking_rules(model_profile, _catalog_capabilities(model_profile))
        native = _metadata_capabilities(record)
        known = {name: value for name, value in native.items() if name not in {"source", "matched_model"} and value is not None}
        if known:
            catalog_source = capabilities["source"]
            capabilities.update(known)
            capabilities["source"] = "endpoint" + (f"+{catalog_source}" if catalog_source != "unknown" else "")
            capabilities["matched_model"] = model_id
        with _lock:
            cache_key = _cache_key(model_profile)
            _capability_cache[cache_key] = (time.monotonic(), copy.deepcopy(capabilities))
            _capability_cache.move_to_end(cache_key)
            while len(_capability_cache) > 2048:
                _capability_cache.popitem(last=False)
        result.append({"id": model_id, "capabilities": capabilities})
    return result
