"""Dedicated machine translation protocols, separate from chat completion."""

from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import re
import urllib.error
import urllib.request
from typing import Any, Mapping


VOLCENGINE_URL = "https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01"
DEEPL_URLS = {"free": "https://api-free.deepl.com/v2/translate", "pro": "https://api.deepl.com/v2/translate"}
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
PROTECTED_SPAN_RE = re.compile(r"(__MY_SCHOLAR_(?:MATH|SPECIAL_TOKEN|MARKER|BOLD_(?:START|END))_\d+__|\r\n?|\n|\t+)")


def language_code(value: str, *, source: bool = False) -> str:
    code = str(value or ("auto" if source else "zh")).strip().lower().replace("_", "-")
    aliases = {
        "中文": "zh", "简体中文": "zh", "中文（简体）": "zh", "chinese": "zh",
        "zh-cn": "zh", "zh-hans": "zh", "繁体中文": "zh-hant", "zh-tw": "zh-hant",
        "english": "en", "英文": "en", "英语": "en", "日语": "ja", "japanese": "ja",
        "德语": "de", "german": "de", "法语": "fr", "french": "fr", "自动检测": "auto",
    }
    code = aliases.get(code, code)
    if code == "auto" and source:
        return code
    if not re.fullmatch(r"[a-z]{2,3}(?:-[a-z0-9]{2,8})?", code):
        raise ValueError("语言请填写有效的语言代码，例如 zh、en 或 ja。")
    return code


def configured(profile: Mapping[str, str]) -> bool:
    provider = profile.get("provider", "openai-compatible")
    if provider == "volcengine":
        return bool(profile.get("access_key_id") and profile.get("secret_access_key"))
    if provider == "deepl":
        return bool(profile.get("api_key"))
    if provider == "openai-compatible":
        return bool(profile.get("base_url") and profile.get("model") and profile.get("api_key"))
    return False


def _volcengine_signature(canonical: str, secret_access_key: str, timestamp: str, region: str, service: str) -> str:
    scope = f"{timestamp[:8]}/{region}/{service}/request"
    signing_text = "\n".join(["HMAC-SHA256", timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = secret_access_key.encode("utf-8")
    for part in (timestamp[:8], region, service, "request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    return hmac.new(key, signing_text.encode(), hashlib.sha256).hexdigest()


def volcengine_headers(body: bytes, access_key_id: str, secret_access_key: str, *, date: str = "") -> dict[str, str]:
    timestamp = date or datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    digest = hashlib.sha256(body).hexdigest()
    signed_headers = "content-type;host;x-content-sha256;x-date"
    canonical_headers = (
        "content-type:application/json\n"
        "host:translate.volcengineapi.com\n"
        f"x-content-sha256:{digest}\n"
        f"x-date:{timestamp}\n"
    )
    canonical = "\n".join(["POST", "/", "Action=TranslateText&Version=2020-06-01", canonical_headers, signed_headers, digest])
    scope = f"{timestamp[:8]}/cn-north-1/translate/request"
    signature = _volcengine_signature(canonical, secret_access_key, timestamp, "cn-north-1", "translate")
    return {
        "Content-Type": "application/json", "Host": "translate.volcengineapi.com",
        "X-Date": timestamp, "X-Content-Sha256": digest,
        "Authorization": f"HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
    }


def _post(url: str, body: bytes, headers: dict[str, str], timeout: int) -> dict[str, Any]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        detail = {401: "凭据无效", 403: "凭据或服务权限不足", 429: "请求过于频繁，请稍后重试", 456: "翻译额度已用尽"}.get(exc.code, "服务请求失败")
        exc.close()
        raise RuntimeError(f"机器翻译{detail}（HTTP {exc.code}）。") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise RuntimeError("无法连接机器翻译服务，请检查网络或稍后重试。") from None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("机器翻译响应超过安全上限。")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RuntimeError("机器翻译服务返回了无效 JSON。") from None
    if not isinstance(value, dict):
        raise RuntimeError("机器翻译服务响应格式无效。")
    return value


def _translate_batch(texts: list[str], profile: Mapping[str, str], source: str, target: str, timeout: int) -> list[str]:
    provider = profile.get("provider")
    if provider == "volcengine":
        payload = {"TargetLanguage": target, "TextList": texts}
        if source != "auto":
            payload["SourceLanguage"] = source
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        result = _post(VOLCENGINE_URL, body, volcengine_headers(body, profile["access_key_id"], profile["secret_access_key"]), timeout)
        metadata = result.get("ResponseMetadata")
        if isinstance(metadata, dict) and metadata.get("Error"):
            # Provider messages can echo request data; expose only known codes.
            error = metadata["Error"]
            code = str(error.get("Code", "")) if isinstance(error, dict) else ""
            detail = {"-400": "请求参数无效", "-415": "不支持该语言方向", "-429": "请求过于频繁", "-500": "服务内部错误"}.get(code, "请求被拒绝，请检查凭据与服务权限")
            raise RuntimeError(f"火山引擎翻译{detail}。")
        items, field = result.get("TranslationList"), "Translation"
    elif provider == "deepl":
        tier = profile.get("deepl_tier", "free")
        if tier not in DEEPL_URLS:
            raise ValueError("DeepL 套餐必须为 free 或 pro。")
        payload = {"text": texts, "target_lang": target.upper(), "preserve_formatting": True}
        if source != "auto":
            payload["source_lang"] = source.split("-")[0].upper()
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        result = _post(DEEPL_URLS[tier], body, {"Content-Type": "application/json", "Authorization": "DeepL-Auth-Key " + profile["api_key"]}, timeout)
        items, field = result.get("translations"), "text"
    else:
        raise ValueError("未知机器翻译提供商。")
    if not isinstance(items, list) or len(items) != len(texts) or any(not isinstance(item, dict) or not isinstance(item.get(field), str) or not item[field].strip() for item in items):
        raise RuntimeError("机器翻译服务未返回完整的译文。")
    return [item[field].strip() for item in items]


def translate(text: str, profile: Mapping[str, str], *, target_language: str = "", timeout: int = 60) -> str:
    if not configured(profile):
        raise RuntimeError("请先完整配置机器翻译服务的凭据。")
    source = language_code(profile.get("source_language", "auto"), source=True)
    target = language_code(target_language or profile.get("target_language", "zh"))
    # Keep formulas and layout locally: machine translators are not required
    # to echo placeholders, even when a provider offers ignored XML tags.
    parts: list[str] = []
    positions: list[int] = []
    texts: list[str] = []
    for segment in PROTECTED_SPAN_RE.split(text):
        if PROTECTED_SPAN_RE.fullmatch(segment) or not any(char.isalpha() for char in segment):
            parts.append(segment)
            continue
        while segment:
            end = min(len(segment), 4000)
            if end < len(segment):
                boundaries = list(re.finditer(r"[.!?。！？]\s", segment[:end]))
                boundary = boundaries[-1].end() if boundaries else segment.rfind(" ", 0, end) + 1
                if boundary > end // 2:
                    end = boundary
            piece, segment = segment[:end], segment[end:]
            if not any(char.isalpha() for char in piece):
                parts.append(piece)
                continue
            leading = piece[:len(piece) - len(piece.lstrip())]
            trailing = piece[len(piece.rstrip()):]
            parts.append(leading)
            positions.append(len(parts))
            texts.append(piece.strip())
            parts.extend(["", trailing])
    # Bound batches to Volcengine's 16 texts / 5000 characters.
    offset = 0
    while offset < len(texts):
        end, count = offset, 0
        while end < len(texts) and end - offset < 16 and count + len(texts[end]) <= 5000:
            count += len(texts[end])
            end += 1
        translated = _translate_batch(texts[offset:end], profile, source, target, timeout)
        for index, value in enumerate(translated, offset):
            parts[positions[index]] = value
        offset = end
    return "".join(parts)
