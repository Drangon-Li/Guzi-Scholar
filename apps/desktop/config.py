"""Local AI profile resolution for the open-source My Scholar client.

The desktop settings file is the normal source of AI configuration. A
developer token file remains available as an optional, git-ignored fallback
for local development and automated deployments. No account session or
vendor gateway is required.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
from typing import Any, Mapping, Optional

from ai_capabilities import normalize_ai_options


PROJECT_ROOT = Path(__file__).resolve().parent
DEVELOPER_TOKENS_PATH = PROJECT_ROOT / "developer.tokens.json"
DEVELOPER_TOKENS_FILE_ENV = "MY_SCHOLAR_DEVELOPER_TOKENS_FILE"
SETTINGS_FILE_ENV = "MY_SCHOLAR_SETTINGS_FILE"

# Compatibility names for integrations that used the old gateway. The default
# is intentionally empty and no account token is read by the open-source app.
AI_GATEWAY_URL_ENV = "MY_SCHOLAR_AI_GATEWAY_URL"
AI_GATEWAY_URL_DEFAULT = ""
ACCOUNT_STATE_FILE_ENV = "MY_SCHOLAR_ACCOUNT_STATE_FILE"
AI_GATEWAY_MODELS = {
    "translation": "qwen-mt-plus",
    "chat": "qwen3.8-max-preview",
}
AI_SERVICES = ("translation", "chat")
AI_TRANSLATION_MODES = ("qwen-mt", "chat")
DEFAULT_TRANSLATION_MODE = "qwen-mt"
TRANSLATION_PROVIDERS = ("openai-compatible", "volcengine", "deepl")
MACHINE_TRANSLATION_FORMAT_VERSION = "local-format-v1"
CLI_PROFILE_FIELDS = ("cli_kind", "cli_path", "cli_model", "cli_args")
CLI_KINDS = ("codex", "claude", "custom")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _read_developer_tokens(path: Path) -> dict[str, Any]:
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return _read_json(path)


def developer_tokens_path(environ: Optional[Mapping[str, Any]] = None) -> Path:
    env = environ if environ is not None else os.environ
    override = str(env.get(DEVELOPER_TOKENS_FILE_ENV, "") or "").strip()
    return Path(override).expanduser() if override else DEVELOPER_TOKENS_PATH


def settings_path(environ: Optional[Mapping[str, Any]] = None) -> Path:
    env = environ if environ is not None else os.environ
    override = str(env.get(SETTINGS_FILE_ENV, "") or "").strip()
    if override:
        return Path(override).expanduser()
    data_root = str(env.get("MY_SCHOLAR_DATA_DIR", "") or "").strip()
    return (Path(data_root).expanduser() if data_root else PROJECT_ROOT / "data") / "settings.json"


def _profile_id(base_url: str, model: str, mode: str = "") -> str:
    if not (base_url and model):
        return ""
    material = f"{base_url.rstrip('/')}\n{model}\n{mode}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def normalize_cli_profile(value: Mapping[str, Any], current: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    existing = current if current is not None else {}
    kind = value.get("cli_kind", existing.get("cli_kind", ""))
    if kind == "":
        return {}
    if kind not in CLI_KINDS:
        raise ValueError("本地 CLI 类型无效。")
    defaults = existing if kind == existing.get("cli_kind") else {}
    path = value.get("cli_path", defaults.get("cli_path", ""))
    if not isinstance(path, str) or len(path) > 4096 or "\x00" in path:
        raise ValueError("本地 CLI 可执行文件路径无效。")
    path = path.strip()
    if path and not (Path(path).is_absolute() or PureWindowsPath(path).is_absolute() or path.startswith(("~/", "~\\"))):
        raise ValueError("本地 CLI 可执行文件必须使用绝对路径或 ~/ 路径。")
    if kind == "custom" and not path:
        raise ValueError("请为自定义 CLI 填写可执行文件路径。")
    model = value.get("cli_model", defaults.get("cli_model", ""))
    if not isinstance(model, str) or len(model) > 256 or "\x00" in model:
        raise ValueError("CLI 模型名称无效。")
    if kind == "custom" and model.strip():
        raise ValueError("CLI 模型只适用于 Codex 和 Claude Code。")
    args = value.get("cli_args", defaults.get("cli_args", []))
    if (not isinstance(args, list) or (kind != "custom" and args)
            or any(not isinstance(arg, str) or "\x00" in arg for arg in args)):
        raise ValueError("只有自定义 CLI 可填写参数，参数必须是字符串列表。")
    return {"cli_kind": kind, "cli_path": path, "cli_model": model.strip(), "cli_args": list(args)}


def cli_context_options(value: Mapping[str, Any], *, strict: bool = False) -> dict[str, Any]:
    return normalize_ai_options({"context_window": value.get("context_window", 0)}, strict=strict)


def _normalize_profile(value: Any, *, service: str = "chat") -> dict[str, Any]:
    if not isinstance(value, Mapping):
        value = {}
    cli = normalize_cli_profile(value)
    if cli:
        result = {
            **cli, "base_url": "", "api_key": "", "model": cli["cli_model"],
            **cli_context_options(value),
        }
        if service == "translation":
            result.update(
                provider="cli", mode="chat",
                source_language=str(value.get("source_language") or "auto").strip(),
                target_language=str(value.get("target_language") or "zh").strip(),
            )
        identity = json.dumps(["cli", result], sort_keys=True)
        result["profile_id"] = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        return result
    base_url = str(value.get("base_url", "") or "").strip().rstrip("/")
    api_key = str(value.get("api_key", "") or "").strip()
    model = str(value.get("model", "") or "").strip()
    mode = ""
    if service == "translation":
        candidate = str(value.get("mode", DEFAULT_TRANSLATION_MODE) or "").strip().lower()
        mode = candidate if candidate in AI_TRANSLATION_MODES else DEFAULT_TRANSLATION_MODE
    result = {
        "base_url": base_url,
        "api_key": api_key,
        "model": model,
        **({"mode": mode} if service == "translation" else {}),
        "profile_id": _profile_id(base_url, model, mode),
        **normalize_ai_options(value),
    }
    if service == "translation":
        provider = str(value.get("provider") or "openai-compatible").strip().lower()
        result.update({
            "provider": provider,
            "source_language": str(value.get("source_language") or "auto").strip(),
            "target_language": str(value.get("target_language") or "zh").strip(),
            "deepl_tier": str(value.get("deepl_tier") or "free").strip().lower(),
            "access_key_id": str(value.get("access_key_id") or "").strip(),
            "secret_access_key": str(value.get("secret_access_key") or "").strip(),
        })
        if provider != "openai-compatible" or result["source_language"] != "auto" or result["target_language"] != "zh":
            # Credentials rotate without invalidating translations; provider,
            # endpoint tier and language direction change the actual result.
            identity = [provider, result["source_language"], result["target_language"]]
            if provider == "openai-compatible":
                identity.extend([base_url, model, mode])
            elif provider == "deepl":
                identity.append(result["deepl_tier"])
            if provider in ("volcengine", "deepl"):
                # Old machine translations could drop styling placeholders.
                identity.append(MACHINE_TRANSLATION_FORMAT_VERSION)
            result["profile_id"] = hashlib.sha256(json.dumps(identity).encode("utf-8")).hexdigest()
    options = normalize_ai_options(value)
    if options != normalize_ai_options({}) and result["profile_id"]:
        identity = [result["profile_id"], options]
        result["profile_id"] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode("utf-8")).hexdigest()
    return result


def _user_profile(name: str, environ: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    raw = _read_json(settings_path(environ))
    profiles = raw.get("ai") if isinstance(raw.get("ai"), Mapping) else {}
    if not isinstance(profiles, Mapping) or name not in profiles:
        return None
    # A present profile, even when incomplete, is an explicit user choice.
    return _normalize_profile(profiles.get(name), service=name)


def _explicit_gateway_profile(name: str, environ: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    base = str(environ.get(AI_GATEWAY_URL_ENV, "") or "").strip().rstrip("/")
    if not base:
        return None
    model_key = f"MY_SCHOLAR_AI_{name.upper()}_MODEL"
    key_key = f"MY_SCHOLAR_AI_{name.upper()}_API_KEY"
    model = str(environ.get(model_key, AI_GATEWAY_MODELS[name]) or "").strip()
    api_key = str(environ.get(key_key, environ.get("MY_SCHOLAR_AI_API_KEY", "")) or "").strip()
    value: dict[str, Any] = {"base_url": f"{base}/{name}/v1", "api_key": api_key, "model": model}
    if name == "translation":
        value["mode"] = environ.get("MY_SCHOLAR_AI_TRANSLATION_MODE", DEFAULT_TRANSLATION_MODE)
    return _normalize_profile(value, service=name)


def resolve_ai_profile(
    service: str,
    *,
    environ: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    """Resolve one AI profile from local user settings or developer config."""
    name = str(service or "").strip().lower()
    if name not in AI_SERVICES:
        raise ValueError(f"未知 AI 服务：{name or '空'}")
    env = environ if environ is not None else os.environ

    user = _user_profile(name, env)
    if user is not None:
        return user

    explicit_gateway = _explicit_gateway_profile(name, env)
    if explicit_gateway is not None:
        return explicit_gateway

    raw = _read_developer_tokens(developer_tokens_path(env))
    profile = raw.get(name) if isinstance(raw.get(name), Mapping) else {}
    return _normalize_profile(profile, service=name)


__all__ = [
    "ACCOUNT_STATE_FILE_ENV",
    "AI_GATEWAY_MODELS",
    "AI_GATEWAY_URL_DEFAULT",
    "AI_GATEWAY_URL_ENV",
    "AI_SERVICES",
    "AI_TRANSLATION_MODES",
    "CLI_PROFILE_FIELDS",
    "DEFAULT_TRANSLATION_MODE",
    "DEVELOPER_TOKENS_FILE_ENV",
    "DEVELOPER_TOKENS_PATH",
    "PROJECT_ROOT",
    "SETTINGS_FILE_ENV",
    "developer_tokens_path",
    "resolve_ai_profile",
    "settings_path",
]
