"""Per-document content artifacts stored inside a job folder.

Split out of ``server.py``: translation records, note assets, media layout and
the ``content/`` mirror the reader loads. Everything here is file I/O scoped to
a single job directory and knows nothing about HTTP. ``server.py`` re-exports
these names, so existing call sites and tests are unchanged.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import runtime
from job_store import RENDER_GENERATION_RE, _read_json_file
from pipeline import PipelineError, utc_now


MAX_NOTE_ASSET_BYTES = 5 * 1024 * 1024

MAX_MEDIA_LAYOUT_BYTES = 512 * 1024

MAX_MEDIA_LAYOUT_ITEMS = 2048

MEDIA_LAYOUT_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")

def _translation_key(
    text: str,
    block_id: str,
    target_language: str,
    source_hash: str = "",
    profile_id: str = "",
) -> str:
    digest = source_hash.strip() or hashlib.sha256(text.encode("utf-8")).hexdigest()
    material = "\n".join((profile_id.strip(), target_language.strip() or "中文", block_id.strip(), digest))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()

def _translation_records(job_dir: Path) -> List[Dict[str, Any]]:
    """Read the task-local translation cache in a backwards-compatible form."""
    data = _read_json_file(job_dir / "translations.json", {})
    if isinstance(data, dict) and isinstance(data.get("entries"), dict):
        values = data["entries"].values()
    elif isinstance(data, list):
        values = data
    else:
        values = []
    return [dict(item) for item in values if isinstance(item, dict) and item.get("cache_key")]

def _translation_records_need_persist(job_dir: Path) -> bool:
    """True when a read must rewrite the cache to finish a format migration."""
    data = _read_json_file(job_dir / "translations.json", {})
    if not (isinstance(data, dict) and isinstance(data.get("entries"), dict)):
        # Legacy list payloads (or a missing cache) migrate to keyed entries.
        return True
    return not (job_dir / "content" / "chinese" / "blocks.json").is_file()

def _active_conversion_root(job_dir: Path) -> Path:
    """Resolve immutable conversion artifacts without moving user-owned files."""
    job_dir = Path(job_dir)
    state = _read_json_file(job_dir / "job.json", {})
    generation = str(state.get("active_render") or "") if isinstance(state, dict) else ""
    if RENDER_GENERATION_RE.fullmatch(generation):
        candidate = job_dir / "renders" / generation
        if (candidate / "manifest.json").is_file():
            return candidate
    return job_dir

def _content_root(job_dir: Path) -> Path:
    """Return the user-facing, per-document content directory.

    Root-level artifacts remain the conversion source of truth. This additive
    directory is only a local organization/index layer.
    """
    root = job_dir / "content"
    for name in ("english", "chinese", "notes", "annotations"):
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / "notes" / "assets").mkdir(parents=True, exist_ok=True)
    return root

def _note_image_type(data: bytes) -> tuple[str, str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif", "image/gif"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    raise PipelineError("笔记图片仅支持 PNG、JPEG、WebP 或 GIF。")

def _store_note_asset(job_dir: Path, data: bytes) -> Dict[str, Any]:
    if not data:
        raise PipelineError("笔记图片不能为空。")
    if len(data) > MAX_NOTE_ASSET_BYTES:
        raise PipelineError("笔记图片超过 5 MB。")
    extension, mime_type = _note_image_type(data)
    digest = hashlib.sha256(data).hexdigest()
    relative = f"assets/{digest}.{extension}"
    target = _content_root(job_dir) / "notes" / relative
    if not target.is_file():
        temporary = _atomic_temp_path(target)
        temporary.write_bytes(data)
        temporary.replace(target)
    _write_content_manifest(job_dir)
    return {"ref": relative, "mime_type": mime_type, "size": len(data)}

def _atomic_temp_path(target: Path) -> Path:
    """Give each concurrent writer its own temporary file."""
    return target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")

def _empty_media_layout() -> Dict[str, Any]:
    return {"version": 1, "items": {}}

def _normalize_media_layout_items(value: Any) -> Dict[str, Dict[str, float]]:
    if not isinstance(value, dict):
        raise PipelineError("媒体布局 items 必须是对象。")
    if len(value) > MAX_MEDIA_LAYOUT_ITEMS:
        raise PipelineError(f"媒体布局最多保存 {MAX_MEDIA_LAYOUT_ITEMS} 项。")
    normalized: Dict[str, Dict[str, float]] = {}
    for key, raw in value.items():
        if not isinstance(key, str) or not MEDIA_LAYOUT_KEY_RE.fullmatch(key):
            raise PipelineError("媒体布局 key 无效。")
        if not isinstance(raw, dict) or set(raw) != {"width_percent"}:
            raise PipelineError("媒体布局条目只能包含 width_percent。")
        width = raw.get("width_percent")
        if isinstance(width, bool) or not isinstance(width, (int, float)):
            raise PipelineError("媒体宽度必须是数字。")
        width = float(width)
        if not math.isfinite(width) or width < 24 or width > 100:
            raise PipelineError("媒体宽度必须在 24 到 100 之间。")
        normalized[key] = {"width_percent": width}
    return normalized

def _read_media_layout(job_dir: Path) -> Dict[str, Any]:
    path = job_dir / "media-layout.json"
    try:
        if not path.is_file():
            return _empty_media_layout()
        if path.stat().st_size > MAX_MEDIA_LAYOUT_BYTES:
            return _empty_media_layout()
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or set(raw) != {"version", "items"} or raw.get("version") != 1:
            return _empty_media_layout()
        return {"version": 1, "items": _normalize_media_layout_items(raw.get("items"))}
    except (OSError, json.JSONDecodeError, PipelineError):
        return _empty_media_layout()

def _write_media_layout(job_dir: Path, items: Dict[str, Dict[str, float]]) -> Dict[str, Any]:
    if runtime.READONLY_MODE:
        raise PipelineError("只读演示模式，暂不支持修改。")
    layout = {"version": 1, "items": _normalize_media_layout_items(items)}
    encoded = json.dumps(layout, ensure_ascii=False, indent=2).encode("utf-8")
    if len(encoded) > MAX_MEDIA_LAYOUT_BYTES:
        raise PipelineError("媒体布局文件超过大小限制。")
    target = job_dir / "media-layout.json"
    temporary = _atomic_temp_path(target)
    try:
        with temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        try:
            directory_fd = os.open(job_dir, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    finally:
        temporary.unlink(missing_ok=True)
    return layout

def _write_content_manifest(job_dir: Path, *, updated_at: Optional[str] = None) -> None:
    if runtime.READONLY_MODE:
        return
    root = _content_root(job_dir)
    manifest_path = root / "manifest.json"
    current = _read_json_file(manifest_path, {})
    if not isinstance(current, dict):
        current = {}
    existing = dict(current)
    current.update({
        "version": 1,
        "source_pdf": "../source.pdf" if (job_dir / "source.pdf").is_file() else "../upload.pdf",
        "html": "../document.html",
        "english": "english/blocks.json",
        "chinese": "chinese/blocks.json",
        "notes": "notes/notes.md",
        "note_assets": "notes/assets/",
        "annotations": "annotations/annotations.json",
        "updated_at": updated_at or utc_now(),
    })
    # Reads call this defensively; only touch the disk when something changed.
    if existing and {**current, "updated_at": existing.get("updated_at")} == existing:
        return
    temporary = _atomic_temp_path(manifest_path)
    temporary.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(manifest_path)

def _write_english_snapshot(job_dir: Path) -> None:
    """Materialize a compact English block index from the deterministic HTML."""
    if runtime.READONLY_MODE:
        return
    root = _content_root(job_dir)
    target = root / "english" / "blocks.json"
    if target.is_file():
        return
    document = _read_json_file(_active_conversion_root(job_dir) / "document.json", {})
    blocks: List[Dict[str, Any]] = []
    semantic_validation = document.get("semantic_validation", {}) if isinstance(document, dict) else {}
    semantic_failed = isinstance(semantic_validation, dict) and semantic_validation.get("status") == "FAIL"
    translation_disabled = isinstance(document, dict) and document.get("translation_enabled") is False
    if semantic_failed or translation_disabled:
        temporary = _atomic_temp_path(target)
        temporary.write_text(json.dumps({"version": 1, "blocks": []}, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(target)
        return
    for page in document.get("pages", []) if isinstance(document, dict) else []:
        if not isinstance(page, dict):
            continue
        page_number = page.get("page")
        for element in page.get("elements", []) if isinstance(page.get("elements"), list) else []:
            if not isinstance(element, dict):
                continue
            text = str(element.get("text") or element.get("caption") or "").strip()
            block_id = str(element.get("block_id") or "").strip()
            if text and block_id:
                blocks.append({"block_id": block_id, "page": page_number, "text": text, "type": element.get("type")})
    temporary = _atomic_temp_path(target)
    temporary.write_text(json.dumps({"version": 1, "blocks": blocks}, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)

def _ensure_content_layout(job_dir: Path) -> None:
    if runtime.READONLY_MODE:
        return
    _content_root(job_dir)
    _write_english_snapshot(job_dir)
    _write_content_manifest(job_dir)

def _sync_content_file(job_dir: Path, relative: str, payload: Any) -> None:
    if runtime.READONLY_MODE:
        return
    _ensure_content_layout(job_dir)
    target = job_dir / "content" / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = _atomic_temp_path(target)
    if isinstance(payload, (dict, list)):
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        temporary.write_text(str(payload or ""), encoding="utf-8")
    temporary.replace(target)
    _write_content_manifest(job_dir)

def _write_translation_records(job_dir: Path, records: List[Dict[str, Any]]) -> None:
    if runtime.READONLY_MODE:
        return
    _ensure_content_layout(job_dir)
    path = job_dir / "translations.json"
    entries = {str(item["cache_key"]): item for item in records if item.get("cache_key")}
    temporary = _atomic_temp_path(path)
    temporary.write_text(json.dumps({"version": 1, "entries": entries}, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
    chinese = job_dir / "content" / "chinese" / "blocks.json"
    chinese_tmp = _atomic_temp_path(chinese)
    chinese_tmp.write_text(json.dumps({"version": 1, "blocks": records}, ensure_ascii=False, indent=2), encoding="utf-8")
    chinese_tmp.replace(chinese)
    _write_content_manifest(job_dir)
