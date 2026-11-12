"""Normalization of persisted desktop settings.

Pure functions that turn stored or submitted settings values into their
canonical shape: annotation colors and actions, appearance, parsing backend and
AI profiles. Reading and writing ``settings.json`` stays in server.py.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

import runtime
from ai_capabilities import get_model_capabilities, normalize_ai_options
from config import AI_TRANSLATION_MODES, CLI_PROFILE_FIELDS, DEFAULT_TRANSLATION_MODE, TRANSLATION_PROVIDERS, normalize_cli_profile
from layout_pipeline import LayoutPipelineError, normalize_mineru_backend, normalize_mineru_server_url
from pipeline import PipelineError
from runtime import LOOPBACK_HOSTS
from translation_providers import language_code


def _normalize_ai_status_record(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    checked_at = str(value.get("checkedAt") or value.get("checked_at") or "").strip()
    results = value.get("results")
    if not checked_at or not isinstance(results, dict):
        return None
    normalized: Dict[str, Dict[str, Any]] = {}
    for service in ("translation", "chat"):
        result = results.get(service)
        if not isinstance(result, dict):
            result = {}
        ok = result.get("ok") is True or result.get("success") is True or result.get("status") == "ok"
        safe: Dict[str, Any] = {"ok": ok}
        try:
            elapsed = max(0, int(float(result.get("elapsed_ms"))))
        except (TypeError, ValueError, OverflowError):
            elapsed = None
        if elapsed is not None:
            safe["elapsed_ms"] = elapsed
        if not ok:
            safe["error"] = str(result.get("error") or result.get("message") or "连接失败")[:180]
        normalized[service] = safe
    return {"checkedAt": checked_at, "results": normalized}


def _setting_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() not in {"", "0", "false", "no", "off"}


ANNOTATION_COLOR_KINDS = ("highlight", "underline")


def _setting_color(value: Any, default: str = "#f59e0b") -> str:
    candidate = str(value or "").strip()
    return candidate if re.fullmatch(r"#[0-9a-fA-F]{6}", candidate) else default


def _parsing_backend(value: Any) -> str:
    """An unset choice defers to MY_SCHOLAR_MINERU_BACKEND, then to the default."""
    return normalize_mineru_backend(value.get("backend") if isinstance(value, dict) else None)


def _parsing_server_url(value: Any, *, strict: bool) -> str:
    """Validate the layout server address, rejecting anything but http(s).

    Reads are lenient: a stored value that is somehow invalid must not take the
    whole settings endpoint down with it. Writes reject it so it never lands.
    """
    raw = value.get("server_url") if isinstance(value, dict) else None
    try:
        return normalize_mineru_server_url(raw)
    except LayoutPipelineError as exc:
        if strict:
            raise PipelineError(str(exc)) from exc
        return ""


def _parsing_settings(value: Any, *, strict: bool = False) -> Dict[str, str]:
    return {"backend": _parsing_backend(value), "server_url": _parsing_server_url(value, strict=strict)}


def _annotation_colors(value: Any, fallback: str) -> Dict[str, str]:
    """Remember the last colour picked for each annotation kind."""
    stored = value if isinstance(value, dict) else {}
    return {kind: _setting_color(stored.get(kind), fallback) for kind in ANNOTATION_COLOR_KINDS}


BUILTIN_ANNOTATION_ACTIONS = ("highlight", "highlight_note", "underline", "underline_note", "copy", "chat")


def _annotation_actions(value: Any, *, strict: bool = False) -> Dict[str, Any]:
    stored = value if isinstance(value, dict) else {}
    show_shortcut_hints = _setting_bool(stored.get("show_shortcut_hints"), True)
    hidden = stored.get("hidden_builtin", [])
    custom = stored.get("custom", [])
    if not isinstance(hidden, list) or not isinstance(custom, list):
        if strict:
            raise PipelineError("选区工具栏的按钮配置必须是列表。")
        return {"hidden_builtin": [], "custom": [], "show_shortcut_hints": show_shortcut_hints}
    if strict and len(custom) > 32:
        raise PipelineError("最多可配置 32 个自定义标记。")
    actions = []
    seen = set()
    for item in custom[:32]:
        if not isinstance(item, dict):
            if strict:
                raise PipelineError("自定义标记格式无效。")
            continue
        action_id = str(item.get("id") or "").strip()
        label = str(item.get("label") or "").strip()
        kind = str(item.get("kind") or "highlight")
        color = str(item.get("color") or "#f59e0b")
        valid = (re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", action_id)
                 and action_id not in seen and 0 < len(label) <= 40
                 and kind in ANNOTATION_COLOR_KINDS
                 and re.fullmatch(r"#[0-9a-fA-F]{6}", color))
        if not valid:
            if strict:
                raise PipelineError("自定义标记需要唯一 ID、1–40 字名称、有效颜色及高亮或划线类型。")
            continue
        seen.add(action_id)
        actions.append({"id": action_id, "label": label, "kind": kind, "color": color,
                        "enabled": _setting_bool(item.get("enabled"), True)})
    return {"hidden_builtin": [name for name in BUILTIN_ANNOTATION_ACTIONS if name in hidden],
            "custom": actions, "show_shortcut_hints": show_shortcut_hints}


APPEARANCE_DEFAULTS = {
    "app_font": "system",
    "reader_font": "academic",
    "accent": "amber",
}


APPEARANCE_CHOICES = {
    "app_font": frozenset({"system", "pingfang", "songti"}),
    "reader_font": frozenset({"academic", "songti", "georgia", "sans"}),
    "accent": frozenset({"amber", "blue", "emerald", "violet", "rose", "graphite"}),
}


def _appearance_settings(value: Any, *, base: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    result = dict(APPEARANCE_DEFAULTS)
    if isinstance(base, dict):
        for name, choices in APPEARANCE_CHOICES.items():
            candidate = str(base.get(name) or "").strip().lower()
            if candidate in choices:
                result[name] = candidate
    if not isinstance(value, dict):
        return dict(APPEARANCE_DEFAULTS)
    for name, choices in APPEARANCE_CHOICES.items():
        if name not in value:
            continue
        candidate = str(value.get(name) or "").strip().lower()
        result[name] = candidate if candidate in choices else APPEARANCE_DEFAULTS[name]
    return result


AI_PROFILE_LIMITS = {"base_url": 2048, "model": 256, "api_key": 4096}


def _normalize_ai_profile(value: Any, current: Any = None, *, service: str = "chat") -> Dict[str, Any]:
    """Validate one user-owned AI profile.

    API keys are write-only from the UI: an empty key keeps the existing one,
    while ``clear_api_key`` explicitly removes it. This avoids echoing secrets
    through the settings endpoint while still allowing users to rotate them.
    """
    incoming = value if isinstance(value, dict) else {}
    existing = current if isinstance(current, dict) else {}
    result: Dict[str, Any] = {
        "base_url": str(incoming.get("base_url", existing.get("base_url", "")) or "").strip().rstrip("/"),
        "model": str(incoming.get("model", existing.get("model", "")) or "").strip(),
        "api_key": str(existing.get("api_key", "") or "").strip(),
    }
    try:
        result.update(normalize_ai_options({**existing, **incoming}, strict=True))
        result.update(normalize_cli_profile(incoming, existing))
    except ValueError as exc:
        raise PipelineError(str(exc)) from exc
    if service == "translation":
        provider = str(incoming.get("provider", existing.get("provider", "openai-compatible")) or "openai-compatible").strip().lower()
        if provider not in TRANSLATION_PROVIDERS:
            raise PipelineError("翻译提供商无效。知网尚无可核实的官方公开翻译 API。")
        result["provider"] = provider
        if provider != existing.get("provider", "openai-compatible"):
            # OpenAI and DeepL both call their token api_key, but those tokens
            # belong to different services and must not travel across providers.
            result["api_key"] = ""
        try:
            result["source_language"] = language_code(str(incoming.get("source_language", existing.get("source_language", "auto")) or "auto"), source=True)
            result["target_language"] = language_code(str(incoming.get("target_language", existing.get("target_language", "zh")) or "zh"))
        except ValueError as exc:
            raise PipelineError(str(exc)) from exc
        tier = str(incoming.get("deepl_tier", existing.get("deepl_tier", "free")) or "free").strip().lower()
        if tier not in {"free", "pro"}:
            raise PipelineError("DeepL 套餐必须为 free 或 pro。")
        result["deepl_tier"] = tier
        for field in ("access_key_id", "secret_access_key"):
            result[field] = str(incoming.get(field) or existing.get(field) or "").strip()
            if _setting_bool(incoming.get("clear_" + field), False):
                result[field] = ""
            if len(result[field]) > 4096:
                raise PipelineError("翻译凭据配置过长。")
        candidate_mode = str(incoming.get("mode", existing.get("mode", DEFAULT_TRANSLATION_MODE)) or "").strip().lower()
        if candidate_mode not in AI_TRANSLATION_MODES:
            raise PipelineError("翻译协议模式无效。")
        result["mode"] = candidate_mode
    if "api_key" in incoming and str(incoming.get("api_key") or "").strip():
        result["api_key"] = str(incoming.get("api_key")).strip()
    if _setting_bool(incoming.get("clear_api_key"), False):
        result["api_key"] = ""
    if result["base_url"]:
        parsed = urlsplit(result["base_url"])
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise PipelineError("AI Base URL 必须是没有凭据、查询参数或片段的 HTTP(S) 地址。")
        if parsed.scheme == "http" and str(parsed.hostname).lower() not in LOOPBACK_HOSTS:
            raise PipelineError("远程 AI Base URL 必须使用 HTTPS；仅本机服务允许 HTTP。")
    for field, limit in AI_PROFILE_LIMITS.items():
        if len(result[field]) > limit:
            raise PipelineError(f"AI {field} 配置过长。")
    return result


def _normalize_ai_settings(value: Any, current: Any = None) -> Dict[str, Dict[str, Any]]:
    incoming = value if isinstance(value, dict) else {}
    existing = current if isinstance(current, dict) else {}
    return {
        service: _normalize_ai_profile(incoming.get(service), existing.get(service), service=service)
        for service in ("translation", "chat")
    }


def _public_ai_settings(value: Any, *, include_cli: Optional[bool] = None) -> Dict[str, Dict[str, Any]]:
    if include_cli is None:
        include_cli = runtime.desktop_cli_available()
    profiles = _normalize_ai_settings(value)
    return {
        service: {
            "base_url": profile["base_url"],
            "model": profile["model"],
            "api_key_configured": bool(profile["api_key"]),
            **normalize_ai_options(profile),
            "capabilities": get_model_capabilities(profile if include_cli else {**profile, "cli_kind": ""}),
            **({field: profile[field] for field in CLI_PROFILE_FIELDS} if include_cli and profile.get("cli_kind") else {}),
            **({
                "mode": profile["mode"], "provider": profile["provider"],
                "source_language": profile["source_language"], "target_language": profile["target_language"],
                "deepl_tier": profile["deepl_tier"],
                "access_key_id_configured": bool(profile["access_key_id"]),
                "secret_access_key_configured": bool(profile["secret_access_key"]),
            } if service == "translation" else {}),
        }
        for service, profile in profiles.items()
    }


AI_PROFILE_NAMES = frozenset({"translation", "chat"})


def _chat_options(value: Any) -> Dict[str, Any]:
    if value is None:
        return {}
    allowed = {"reasoning_effort", "thinking_budget", "context_window"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise PipelineError("会话设置仅支持推理强度、思考预算和上下文窗口。")
    overrides = {key: item for key, item in value.items() if item is not None}
    try:
        normalized = normalize_ai_options(overrides, strict=True)
    except ValueError as exc:
        raise PipelineError(str(exc)) from exc
    return {key: normalized[key] for key in overrides}
