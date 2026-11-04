#!/usr/bin/env python3
"""Compose the local My Scholar service and its HTTP API.

The module owns the process-level job queues, serves the static web client,
coordinates conversion and metadata workers, and persists per-document reader
state. Conversion, library metadata, bibliography lookup, and AI calls remain
behind their dedicated modules; :func:`main` is the stable CLI entrypoint.

Stateless helpers live beside it: multipart parsing (multipart_form), settings
normalization (settings_schema), legacy artifact upgrades (artifact_migrations),
conversion publishing (conversion_artifacts), AI highlight checks
(ai_highlights), the account client (account_client), the data-root lock
(data_root_lock) and per-document locks (keyed_locks). Everything that reads or
replaces this module's process state stays here.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from functools import wraps
from concurrent.futures import Future
import hashlib
import hmac
import json
import math
import mimetypes
import os
import platform
import queue
import re
import signal
import shutil
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlsplit

import runtime
from annotation_style_sync import AnnotationStyleRecoveryRequiredError, AnnotationStyleSyncError, changed_action_fields, commit_style_sync, recover_pending_transactions
from ai import TranslationQualityError, auto_highlights, chat as ai_chat, chat_stream as ai_chat_stream, chat_context_info, reference_quick_read, review_tables, services as ai_services, status as ai_status, test_connections as ai_test_connections, translate_text, translate_text_stream, translation_profile_id, validate_translation_segments
from ai_capabilities import discover_models, normalize_ai_options
from bibliography import is_fragmented_metadata_text, retrieve_bibliographic_metadata, retrieve_reference_evidence
from config import DEFAULT_TRANSLATION_MODE, resolve_ai_profile
from ai import test_connection as ai_test_connection, translation_target_language
from ai import _safe_connection_error
from content_store import MAX_NOTE_ASSET_BYTES, _active_conversion_root, _atomic_temp_path, _atomic_write_text, _ensure_content_layout, _normalize_media_layout_items, _note_image_type, _read_media_layout, _store_note_asset, _sync_content_file, _translation_key, _translation_records, _translation_records_need_persist, _write_media_layout, _write_translation_records
# Re-exported for the tests, which reach these through the server module.
from content_store import MAX_MEDIA_LAYOUT_ITEMS, _write_content_manifest, _write_english_snapshot  # noqa: F401
from artifact_migrations import _deduplicate_figure_ids  # noqa: F401
# Self-contained helpers split out of this module; none of them reads the
# process state defined below, so tests that patch server.* still see it all.
from account_client import AccountServiceUnavailable, _account_request, _account_service_configuration
from ai_highlights import _highlight_signature, _is_ai_annotation, _local_highlight_candidates
from artifact_migrations import _clean_legacy_translation_cache, _migrate_reader_html
from conversion_artifacts import _preserve_layout_error_log, _provider_failure, _publish_conversion_attempt, _rebase_manifest_paths, _reflow_failure_error, _validate_reflow_render
from data_root_lock import DataRootLock
from keyed_locks import KeyedLock, KeyedLocks
from multipart_form import _multipart_parts, _parse_multipart_form, _spool_request_body, _spooled_body
from settings_schema import AI_PROFILE_NAMES, _annotation_actions, _annotation_colors, _appearance_settings, _chat_options, _normalize_ai_profile, _normalize_ai_settings, _normalize_ai_status_record, _parsing_settings, _public_ai_settings, _setting_bool, _setting_color
from job_store import JOB_ID_RE, RENDER_GENERATION_RE, JobStore, ReflowCancelledError, ReflowConflictError, _read_json_file, set_artifact_migrator
from library_store import LibraryStore, LibraryValidationError
from vocabulary_store import VocabularyStore, VocabularyValidationError, source_snapshot
from mcp_access import MCPAccess
from scholar_service import CapabilityError, ScholarService, notes_snapshot, save_document_notes
from vocabulary_ai import explain as explain_vocabulary
from layout_pipeline import MathRenderer, mineru_worker_advice
from parsing_providers import ProviderError, ParsingRequest, create_default_registry
from pipeline import PipelineError, process_pdf
from runtime import LOOPBACK_HOSTS, METADATA_PENDING, METADATA_STATE_LOCK
from time_utils import utc_now
from zotero_import import ZoteroClient, ZoteroError
from zotero_merge import apply_import as apply_zotero_import, stage_import as stage_zotero_import
from zotero_service import ZoteroImports, merge_import_warnings, validate_import_request, write_json as write_zotero_json


PROJECT_ROOT = Path(os.environ.get("MY_SCHOLAR_PROJECT_ROOT", str(Path(__file__).resolve().parent))).expanduser().resolve()
WEB_ROOT = PROJECT_ROOT / "web"
DATA_ROOT = Path(os.environ.get("MY_SCHOLAR_DATA_DIR", str(PROJECT_ROOT / "data"))).expanduser().resolve()
LIBRARY_ROOT = Path(os.environ.get("MY_SCHOLAR_LIBRARY_DIR", str(DATA_ROOT))).expanduser().resolve()
COMPONENTS_ROOT = Path(os.environ.get("MY_SCHOLAR_COMPONENTS_DIR", str(DATA_ROOT / "components"))).expanduser().resolve()
JOBS_ROOT = LIBRARY_ROOT / "jobs"
MAX_UPLOAD_BYTES = int(os.environ.get("MY_SCHOLAR_MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
FILE_STREAM_CHUNK_BYTES = 256 * 1024
NOTE_ASSET_PATH_RE = re.compile(r"^content/notes/assets/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$")
SETTINGS_PATH = DATA_ROOT / "settings.json"
AI_STATUS_HISTORY_PATH = DATA_ROOT / "ai-status-history.json"
AI_STATUS_HISTORY_LIMIT = 100
TRANSLATION_LOCK = threading.RLock()
TRANSLATION_FLIGHTS: Dict[tuple, Future] = {}
MATH_RENDERER = MathRenderer()
MATH_RENDERER_LOCK = threading.Lock()
ANNOTATION_LOCK = threading.RLock()
MEDIA_LAYOUT_LOCK = threading.RLock()
SETTINGS_LOCK = threading.RLock()
ANNOTATION_STYLE_RECOVERY_REQUIRED = False
AI_STATUS_HISTORY_LOCK = threading.RLock()
PARALLEL_IMPORT = _parallel_import_env = str(os.environ.get("MY_SCHOLAR_PARALLEL_IMPORT", "1")).strip().lower() not in {"", "0", "false", "no", "off"}
CONVERSION_WORKERS = max(1, min(2, int(os.environ.get("MY_SCHOLAR_CONVERSION_WORKERS", "2" if PARALLEL_IMPORT else "1"))))
METADATA_WORKERS = max(1, min(4, int(os.environ.get("MY_SCHOLAR_METADATA_WORKERS", "3" if PARALLEL_IMPORT else "1"))))
CONVERSION_QUEUE: "queue.Queue[tuple[str, str]]" = queue.Queue()
REFLOW_QUEUE: "queue.Queue[tuple[str, str, int]]" = queue.Queue()
METADATA_QUEUE: "queue.Queue[tuple[str, bool, str, int]]" = queue.Queue()
REFLOW_CANCEL_LOCK = threading.RLock()
REFLOW_CANCEL_EVENTS: Dict[tuple[str, int], threading.Event] = {}
PARSING_PROVIDER_LOCK = threading.RLock()
PARSING_PROVIDERS: Any = None
PARSING_INSTALL_THREAD: Optional[threading.Thread] = None
PARSING_INSTALL_CANCEL_EVENT: Optional[threading.Event] = None
# Generation per job with queued or running metadata work; pruned by the worker
# once a job has none left (see _metadata_worker).
METADATA_GENERATIONS: Dict[str, int] = {}
# Per-document locks, dropped again once no thread holds or waits for them.
METADATA_JOB_LOCKS = KeyedLocks()
JOB_MUTATION_LOCKS = KeyedLocks()
ACCOUNT_FILE = DATA_ROOT / "account.json"
ACCOUNT_LOCK = threading.RLock()
LANDING_FILE = Path(os.environ.get("MY_SCHOLAR_LANDING_FILE", "")).expanduser() if os.environ.get("MY_SCHOLAR_LANDING_FILE") else None
_USAGE_CACHE: Dict[str, Any] = {"at": None, "bytes": 0}
MIGRATION_REQUEST_CONDITION = threading.Condition(threading.RLock())
MIGRATION_QUIESCING = False
MIGRATION_ACTIVE_REQUESTS = 0
MIGRATION_ACTIVE_MUTATIONS = 0
CAPABILITY_INIT_LOCK = threading.RLock()


def _job_mutation_lock(job_id: str) -> KeyedLock:
    return JOB_MUTATION_LOCKS.lock(str(job_id or "").strip())


def _assert_annotation_style_writable() -> None:
    if ANNOTATION_STYLE_RECOVERY_REQUIRED:
        raise PipelineError("语义标记同步尚待恢复，已暂停写入和文献库迁移。请重启服务以恢复备份。")


@contextmanager
def _job_mutation(job_id: str):
    """Serialize destructive and document-owned artifact writes per job."""
    lock = _job_mutation_lock(job_id)
    with lock:
        _assert_annotation_style_writable()
        yield


@contextmanager
def _job_mutations(job_ids: Any):
    """Hold a stable set of per-document mutation locks in id order."""
    canonical_ids = sorted({str(job_id or "").strip() for job_id in job_ids if str(job_id or "").strip()})
    locks = [_job_mutation_lock(job_id) for job_id in canonical_ids]
    for lock in locks:
        lock.acquire()
    try:
        yield
    finally:
        for lock in reversed(locks):
            lock.release()


def _locked_job_method(method: Any) -> Any:
    @wraps(method)
    def wrapped(self: Any, job_id: str, *args: Any, **kwargs: Any) -> Any:
        with _job_mutation(job_id):
            return method(self, job_id, *args, **kwargs)
    return wrapped


def _runtime_lock_roots(data_root: Path = DATA_ROOT, library_root: Path = LIBRARY_ROOT) -> List[Path]:
    roots = {Path(data_root).expanduser().resolve(), Path(library_root).expanduser().resolve()}
    return sorted(roots, key=lambda root: os.fsencode(str(root)))


# Account state, settings and compatibility migrations. Per-document content
# artifacts moved to content_store.py.


def _read_account_state() -> Dict[str, Any]:
    with ACCOUNT_LOCK:
        data = _read_json_file(ACCOUNT_FILE, {})
    return data if isinstance(data, dict) else {}


def _write_account_state(state: Optional[Dict[str, Any]]) -> None:
    with ACCOUNT_LOCK:
        if not state:
            ACCOUNT_FILE.unlink(missing_ok=True)
            return
        ACCOUNT_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = _atomic_temp_path(ACCOUNT_FILE)
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, ACCOUNT_FILE)
            os.chmod(ACCOUNT_FILE, 0o600)
            try:
                directory_fd = os.open(ACCOUNT_FILE.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            except OSError:
                pass
        finally:
            temporary.unlink(missing_ok=True)


def _local_usage_bytes(force: bool = False) -> int:
    """Library footprint (papers + processed artifacts), cached briefly."""
    now = time.monotonic()
    if not force and _USAGE_CACHE["at"] is not None and now - _USAGE_CACHE["at"] < 60:
        return int(_USAGE_CACHE["bytes"])
    total = 0
    if JOBS_ROOT.is_dir():
        for root, _dirs, files in os.walk(JOBS_ROOT):
            for name in files:
                try:
                    total += (Path(root) / name).stat().st_size
                except OSError:
                    continue
    _USAGE_CACHE.update({"at": now, "bytes": total})
    return total


def _account_summary() -> Dict[str, Any]:
    state = _read_account_state()
    profile = state.get("profile") if isinstance(state.get("profile"), dict) else None
    return {
        "logged_in": bool(state.get("token")),
        "username": (profile or {}).get("username"),
        "member": bool((profile or {}).get("beta_access")),
    }


def _apply_member_gate(services: Dict[str, Any]) -> Dict[str, Any]:
    """AI features are a membership entitlement when gating is enabled."""
    if not runtime.AI_REQUIRES_MEMBER:
        return services
    summary = _account_summary()
    if summary["member"]:
        return services
    note = "AI 功能需要有效的免费内测资格。" if summary["logged_in"] else "AI 功能需要先登录内测账号。"
    gated = {}
    for name, service in services.items():
        gated[name] = {**service, "enabled": False, "note": note} if isinstance(service, dict) else service
    return gated


def _chat_image_context(job_dir: Path, value: Any) -> Optional[Dict[str, str]]:
    if value is None or value == "":
        return None
    if not isinstance(value, dict):
        raise PipelineError("selected_image 必须是对象。")
    relative = str(value.get("path") or "").strip().lstrip("/")
    if not relative.startswith("assets/images/"):
        raise PipelineError("图片必须来自当前文献。")
    conversion_root = _active_conversion_root(job_dir)
    root = (conversion_root / "assets" / "images").resolve()
    target = (conversion_root / relative).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise PipelineError("图片路径无效。") from exc
    if not target.is_file():
        raise PipelineError("图片资源不存在。")
    # Reject oversized crops before reading them into memory.
    if target.stat().st_size > MAX_CHAT_IMAGE_BYTES:
        raise PipelineError("图片为空或超过 5 MB。")
    data = target.read_bytes()
    if not data or len(data) > MAX_CHAT_IMAGE_BYTES:
        raise PipelineError("图片为空或超过 5 MB。")
    _, mime_type = _note_image_type(data)
    if mime_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise PipelineError("图片 Chat 仅支持 PNG、JPEG 或 WebP。")
    return {
        "data_url": f"data:{mime_type};base64,{base64.b64encode(data).decode('ascii')}",
        "caption": str(value.get("caption") or "").strip()[:2000],
        "block_id": str(value.get("block_id") or "").strip()[:160],
        "page": str(value.get("page") or "").strip()[:32],
    }


def _stored_settings() -> Dict[str, Any]:
    data = _read_json_file(SETTINGS_PATH, {})
    return data if isinstance(data, dict) else {}


def _ai_status_history() -> List[Dict[str, Any]]:
    payload = _read_json_file(AI_STATUS_HISTORY_PATH, {})
    records = payload.get("history") if isinstance(payload, dict) else []
    history = [_normalize_ai_status_record(record) for record in records] if isinstance(records, list) else []
    return [record for record in history if record is not None][:AI_STATUS_HISTORY_LIMIT]


def _record_ai_status(results: Dict[str, Any]) -> Dict[str, Any]:
    record = _normalize_ai_status_record({"checkedAt": utc_now(), "results": results})
    if record is None:
        raise PipelineError("AI 服务检测结果无效。")
    if runtime.READONLY_MODE:
        return record
    with AI_STATUS_HISTORY_LOCK:
        history = [record, *_ai_status_history()][:AI_STATUS_HISTORY_LIMIT]
        AI_STATUS_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = _atomic_temp_path(AI_STATUS_HISTORY_PATH)
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump({"version": 1, "history": history}, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, AI_STATUS_HISTORY_PATH)
            try:
                AI_STATUS_HISTORY_PATH.chmod(0o600)
            except OSError:
                pass
        finally:
            temporary.unlink(missing_ok=True)
    return record


def _annotation_action_snapshot(value: Dict[str, Any]) -> Dict[str, str]:
    action_id = str(value.get("action_id") or "").strip()
    label = str(value.get("label") or "").strip()
    if not action_id and not label:
        return {}
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", action_id) or not 0 < len(label) <= 40:
        raise PipelineError("自定义标记的 ID 或名称无效。")
    current = next((item for item in _annotation_actions(_stored_settings().get("annotation_actions"))["custom"]
                    if item["id"] == action_id), None)
    if current:
        return {"action_id": action_id, **{field: current[field] for field in ("label", "kind", "color")}}
    return {"action_id": action_id, "label": label}


def _annotation_payload(annotations: list, **fields: Any) -> Dict[str, Any]:
    return {"annotations": annotations, "annotation_style_revision": int(_stored_settings().get("annotation_style_revision", 0)), **fields}


def _persist_settings(data: Dict[str, Any]) -> None:
    _assert_annotation_style_writable()
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = _atomic_temp_path(SETTINGS_PATH)
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, SETTINGS_PATH)
        try:
            SETTINGS_PATH.chmod(0o600)
        except OSError:
            pass
    finally:
        temporary.unlink(missing_ok=True)


def _copy_ai_profile(source: str, target: str) -> Dict[str, Any]:
    source_name = str(source or "").strip().lower()
    target_name = str(target or "").strip().lower()
    if source_name not in AI_PROFILE_NAMES or target_name not in AI_PROFILE_NAMES or source_name == target_name:
        raise PipelineError("AI 服务复用目标无效。")
    with SETTINGS_LOCK:
        _assert_annotation_style_writable()
        current = _stored_settings()
        profiles = _normalize_ai_settings(current.get("ai"), current.get("ai"))
        source_profile = profiles[source_name]
        if source_name == "translation" and source_profile.get("provider") != "openai-compatible":
            raise PipelineError("专用机器翻译配置不能与文章助手复用；请分别配置。")
        if not source_profile["base_url"] or not source_profile["model"]:
            raise PipelineError("源 AI 服务至少需要填写 Base URL 和模型。")
        # Copy only the credentials shared by both service contracts. A
        # translation protocol is meaningful only for the translation target;
        # preserve that target's existing mode when copying a generic Chat
        # profile instead of silently switching it to qwen-mt.
        copied: Dict[str, Any] = {
            "base_url": source_profile["base_url"],
            "model": source_profile["model"],
            "api_key": source_profile["api_key"],
            **normalize_ai_options(source_profile),
        }
        if target_name == "translation":
            copied["provider"] = "openai-compatible"
            copied["mode"] = (
                source_profile.get("mode")
                if source_name == "translation"
                else profiles[target_name].get("mode", DEFAULT_TRANSLATION_MODE)
            )
        profiles[target_name] = _normalize_ai_profile(copied, profiles[target_name], service=target_name)
        current["ai"] = profiles
        _persist_settings(current)
    return _public_settings()


def _apply_settings(data: Dict[str, Any]) -> None:
    # Kept as a compatibility seam for callers that used to apply persisted
    # settings into ``os.environ``. Resolution is now lazy and side-effect
    # free, so deployment environment variables can never be overwritten by a
    # project-local file or the desktop settings form.
    return None


_apply_settings(_stored_settings())


def _public_settings() -> Dict[str, Any]:
    data = _stored_settings()
    primary_modifier = "Cmd" if sys.platform == "darwin" else "Ctrl"
    alt_modifier = "Option" if sys.platform == "darwin" else "Alt"
    shortcut_defaults = {
        "open_library": f"{primary_modifier}+1",
        "open_settings": f"{primary_modifier}+,",
        "highlight": f"{primary_modifier}+Shift+H",
        "underline": f"{primary_modifier}+Shift+U",
        "highlight_note": f"{primary_modifier}+Shift+J",
        "underline_note": f"{primary_modifier}+Shift+K",
        "full_translation": f"{primary_modifier}+Shift+Enter",
        "reflow": f"{primary_modifier}+{alt_modifier}+Enter",
    }
    stored_shortcuts = data.get("shortcuts") if isinstance(data.get("shortcuts"), dict) else {}
    shortcuts = {**shortcut_defaults, **{key: str(value).strip()[:40] for key, value in stored_shortcuts.items() if key in shortcut_defaults and str(value).strip()}}
    if sys.platform == "win32":
        # Early Windows builds persisted Mac defaults; migrate only those exact
        # per-action defaults so custom Command bindings keep their Meta meaning.
        legacy_defaults = {key: value.replace("Ctrl+", "Cmd+", 1).replace("+Alt+", "+Option+") for key, value in shortcut_defaults.items()}
        for key, legacy in legacy_defaults.items():
            if shortcuts[key] == legacy:
                shortcuts[key] = shortcut_defaults[key]
    return {
        "ai_services": ai_services(),
        "ai": _public_ai_settings(data.get("ai")),
        "ai_status_history": _ai_status_history(),
        "shortcuts": shortcuts,
        "highlight_color": _setting_color(data.get("highlight_color")),
        "annotation_colors": _annotation_colors(
            data.get("annotation_colors"), _setting_color(data.get("highlight_color"))
        ),
        "annotation_actions": _annotation_actions(data.get("annotation_actions")),
        "appearance": _appearance_settings(data.get("appearance")),
        "metadata": {
            "auto_retrieve": _setting_bool(data.get("metadata", {}).get("auto_retrieve", True), True) if isinstance(data.get("metadata"), dict) else True,
            "online_lookup": _setting_bool(data.get("metadata", {}).get("online_lookup", True), True) if isinstance(data.get("metadata"), dict) else True,
            "contact_email": str(data.get("metadata", {}).get("contact_email", "")) if isinstance(data.get("metadata"), dict) else "",
        },
        "parsing": _parsing_settings(data.get("parsing")),
    }


def _write_settings(data: Dict[str, Any]) -> Dict[str, Any]:
    global ANNOTATION_STYLE_RECOVERY_REQUIRED
    if runtime.READONLY_MODE:
        raise PipelineError("只读演示模式，暂不支持修改。")
    forbidden = {"base_url", "model", "api_key", "server_preset", "translation", "chat"}
    blocked = sorted(forbidden.intersection(data))
    if blocked:
        raise PipelineError(f"AI 服务配置只能在项目私有配置文件中修改：{', '.join(blocked)}")
    jobs = STORE.list() if "annotation_actions" in data and STORE is not None else []
    style_sync = None
    with _job_mutations(record["job_id"] for record in jobs), ANNOTATION_LOCK, SETTINGS_LOCK:
        _assert_annotation_style_writable()
        previous = _stored_settings()
        current = dict(previous)
        for key in ("shortcuts", "metadata", "highlight_color", "annotation_colors", "annotation_actions", "appearance", "ai", "parsing"):
            if key in data:
                if key == "metadata" and isinstance(data[key], dict):
                    current[key] = {
                        "auto_retrieve": _setting_bool(data[key].get("auto_retrieve"), True),
                        "online_lookup": _setting_bool(data[key].get("online_lookup"), True),
                        "contact_email": str(data[key].get("contact_email") or "").strip()[:254],
                    }
                elif key == "parsing":
                    current["parsing"] = _parsing_settings(data[key], strict=True)
                elif key == "annotation_colors":
                    current["annotation_colors"] = _annotation_colors(
                        data[key], _setting_color(current.get("highlight_color"))
                    )
                elif key == "annotation_actions":
                    current[key] = _annotation_actions(data[key], strict=True)
                elif key == "shortcuts" and isinstance(data[key], dict):
                    defaults = _public_settings().get("shortcuts", {})
                    current["shortcuts"] = {
                        name: str(data[key].get(name, defaults.get(name, ""))).strip()[:40]
                        for name in defaults
                    }
                elif key == "highlight_color":
                    current["highlight_color"] = _setting_color(data.get(key))
                elif key == "ai":
                    current["ai"] = _normalize_ai_settings(data.get(key), current.get("ai"))
                elif key == "appearance":
                    current["appearance"] = _appearance_settings(
                        data.get(key),
                        base=_appearance_settings(current.get("appearance")),
                    )
                else:
                    current[key] = data[key]
        changes = changed_action_fields(_annotation_actions(previous.get("annotation_actions")),
                                        _annotation_actions(current.get("annotation_actions")))
        if changes:
            current["annotation_style_revision"] = int(previous.get("annotation_style_revision", 0)) + 1
            try:
                style_sync = commit_style_sync(SETTINGS_PATH, LIBRARY_ROOT,
                                               [(record["job_id"], Path(record["job_dir"])) for record in jobs],
                                               current, changes, _is_ai_annotation)
                style_sync["revision"] = current["annotation_style_revision"]
            except AnnotationStyleRecoveryRequiredError as exc:
                ANNOTATION_STYLE_RECOVERY_REQUIRED = True
                raise PipelineError(str(exc)) from exc
            except AnnotationStyleSyncError as exc:
                raise PipelineError(str(exc)) from exc
        else:
            _persist_settings(current)
        public = _public_settings()
        if style_sync:
            public["annotation_style_sync"] = style_sync
    return public


def _job_context(job_dir: Path, limit: int = 14000) -> str:
    data = _read_json_file(_active_conversion_root(job_dir) / "document.json", {})
    chunks: List[str] = []
    chars = 0
    if isinstance(data, dict) and isinstance(data.get("pages"), list):
        for page in data["pages"]:
            for item in page.get("elements", []) if isinstance(page, dict) else []:
                if not isinstance(item, dict):
                    continue
                text = str(item.get("text", "")).strip()
                if text:
                    chunk = f"[p{page.get('page')}/{item.get('block_id')}] {text}"
                    chunks.append(chunk)
                    chars += len(chunk) + 2
                if chars >= limit:
                    return "\n\n".join(chunks)[:limit]
    return "\n\n".join(chunks)[:limit]


def _sync_ai_annotations(job_dir: Path, result: Dict[str, Any]) -> None:
    _assert_annotation_style_writable()
    suggestions = result.get("highlights") if isinstance(result, dict) else None
    if not isinstance(suggestions, list):
        return
    current: Dict[tuple[str, str], Dict[str, Any]] = {}
    for suggestion in suggestions:
        if not isinstance(suggestion, dict) or not suggestion.get("block_id") or not suggestion.get("quote"):
            continue
        identity = (str(suggestion.get("block_id")).strip(), str(suggestion.get("quote")).strip())
        current[identity] = suggestion
    path = job_dir / "annotations.json"
    annotations = _read_json_file(path, [])
    if not isinstance(annotations, list):
        return
    cleaned: List[Dict[str, Any]] = []
    ai_positions: Dict[tuple[str, str], int] = {}
    changed = False
    allowed_categories = {"research_goal", "method", "conclusion", "innovation"}
    for raw in annotations:
        if not isinstance(raw, dict):
            changed = True
            continue
        item = dict(raw)
        identity = (str(item.get("block_id") or "").strip(), str(item.get("quote") or "").strip())
        has_range = item.get("start") is not None or item.get("end") is not None
        explicit_source = str(item.get("source") or "").strip().lower()
        legacy_ai = item.get("kind") == "highlight" and not has_range and explicit_source != "manual" and identity in current
        is_ai = explicit_source == "ai" or legacy_ai
        if not is_ai:
            if has_range and explicit_source != "manual":
                item["source"] = "manual"
                changed = True
            cleaned.append(item)
            continue
        suggestion = current.get(identity)
        if not suggestion:
            if item.get("suggestion_state") == "ignored":
                existing_index = ai_positions.get(identity)
                if existing_index is None:
                    ai_positions[identity] = len(cleaned)
                    cleaned.append(item)
                else:
                    if cleaned[existing_index].get("suggestion_state") != "ignored":
                        cleaned[existing_index] = item
                    changed = True
                continue
            changed = True
            continue
        category = str(suggestion.get("category") or "method")
        if category not in allowed_categories:
            category = "method"
        key = _highlight_signature(identity[0], identity[1], category)
        if item.get("suggestion_state") not in {None, "suggested", "ignored"}:
            item["suggestion_state"] = "suggested"
            changed = True
        reason = str(suggestion.get("reason") or "")
        if item.get("source") != "ai" or item.get("category") != category or item.get("suggestion_key") != key or item.get("note") != reason:
            item["source"] = "ai"
            item["category"] = category
            item["suggestion_key"] = key
            item["note"] = reason
            changed = True
        existing_index = ai_positions.get(identity)
        if existing_index is not None:
            if item.get("suggestion_state") == "ignored" and cleaned[existing_index].get("suggestion_state") != "ignored":
                cleaned[existing_index] = item
            changed = True
            continue
        ai_positions[identity] = len(cleaned)
        cleaned.append(item)
    if changed:
        _atomic_write_text(path, json.dumps(cleaned, ensure_ascii=False, indent=2))


def _migrate_job_artifacts(job_dir: Path, manifest: Dict[str, Any]) -> Dict[str, Any]:
    _assert_annotation_style_writable()
    if runtime.READONLY_MODE:
        # A showcase deployment serves a synced snapshot; migrating it would
        # delete and rewrite artifacts the operator pushed deliberately.
        return manifest
    migrated = dict(manifest)
    manifest_changed = False
    obsolete_paths = [job_dir / "document.md", job_dir / "raw-document.html", job_dir / "raw-document.json"]
    if (job_dir / "native").is_dir():
        obsolete_paths.extend((job_dir / "native").glob("*.md"))
    for obsolete in obsolete_paths:
        try:
            obsolete.unlink(missing_ok=True)
        except OSError:
            pass
    outputs = migrated.get("outputs")
    if isinstance(outputs, list):
        filtered_outputs = [item for item in outputs if str(item) not in {"document.md", "raw-document.html", "raw-document.json"}]
        if filtered_outputs != outputs:
            migrated["outputs"] = filtered_outputs
            manifest_changed = True
    notes = migrated.get("notes")
    if isinstance(notes, list):
        filtered_notes = [item for item in notes if "Markdown" not in str(item)]
        normalized_notes = []
        for item in filtered_notes:
            value = str(item)
            if "原始公式裁剪" in value or "整页保真入口" in value:
                value = "公式在阅读界面以 MathML/可见 TeX fallback 渲染；内部审计资源不注入阅读界面。"
            normalized_notes.append(value)
        filtered_notes = normalized_notes
        if filtered_notes != notes:
            migrated["notes"] = filtered_notes
            manifest_changed = True
    if manifest_changed:
        (job_dir / "manifest.json").write_text(json.dumps(migrated, ensure_ascii=False, indent=2), encoding="utf-8")
    # Remote fusion packages already carry their current structured renderer.
    # Legacy migration replaces semantic tables with images and loses MathML.
    engine = manifest.get("engine") if isinstance(manifest.get("engine"), dict) else {}
    if engine.get("name") not in {"guzi-fusion-auto-v2", "guzi-fusion-auto-v3"}:
        _migrate_reader_html(job_dir)
    _clean_legacy_translation_cache(job_dir)
    highlight_result = _read_json_file(job_dir / "ai-highlights.json", {})
    if isinstance(highlight_result, dict) and isinstance(highlight_result.get("highlights"), list):
        _sync_ai_annotations(job_dir, highlight_result)
    try:
        _ensure_content_layout(job_dir)
        _sync_content_file(job_dir, "annotations/annotations.json", _read_json_file(job_dir / "annotations.json", []))
        _sync_content_file(job_dir, "notes/notes.md", (job_dir / "notes.md").read_text(encoding="utf-8") if (job_dir / "notes.md").is_file() else "")
        _write_translation_records(job_dir, _translation_records(job_dir))
    except OSError:
        # These indexes are convenience artifacts; a permissions issue must
        # never make an otherwise readable document unavailable.
        pass
    return migrated


# JobStore loads jobs before this module finishes importing its own stores, so
# the migration is handed over as a hook instead of an import.
set_artifact_migrator(_migrate_job_artifacts)


# Process-level stores and background conversion/metadata workers. They are
# initialized only after the library-root process lock is held.
STORE: Any = None
LIBRARY: Any = None
VOCABULARY: Any = None
SCHOLAR_SERVICE: Any = None
MCP_ACCESS: Any = None
PLUGIN_STORE: Any = None
ZOTERO_IMPORTS: Optional[ZoteroImports] = None
ZOTERO_IMPORTS_LOCK = threading.RLock()


def _zotero_imports() -> ZoteroImports:
    global ZOTERO_IMPORTS
    with ZOTERO_IMPORTS_LOCK:
        if ZOTERO_IMPORTS is None:
            ZOTERO_IMPORTS = ZoteroImports(DATA_ROOT / "integrations" / "zotero" / "batches")
        return ZOTERO_IMPORTS


def _apply_zotero_pending(job_id: str) -> Dict[str, Any]:
    with _job_mutation(job_id), ANNOTATION_LOCK:
        _assert_annotation_style_writable()
        record = STORE.get(job_id)
        if not record:
            return {}
        job_dir = Path(record["job_dir"])
        if not (job_dir / "zotero-import.json").is_file():
            return {}
        if record.get("status") != "completed":
            return {"pending": True}
        try:
            merged = apply_zotero_import(job_dir, LIBRARY, job_id)
            pending = merged.pop("status", "pending") != "applied"
            previous = _read_json_file(job_dir / "zotero-status.json", {})
            if not merged.get("source_count") and isinstance(previous, dict) and not previous.get("pending"):
                current_unanchored = merged.get("current_unanchored_count", previous.get("unanchored_count", 0))
                warnings = merge_import_warnings(previous.get("warnings", []), merged.get("warnings", []))
                merged = {**previous, "unanchored_count": current_unanchored, "warnings": warnings,
                          "resolved_annotations_count": merged.get("resolved_annotations_count", 0),
                          "removed_fallback_notes_count": merged.get("removed_fallback_notes_count", 0)}
            result = {**merged, "pending": pending}
        except Exception as exc:
            # PDF publication has already succeeded. Retain the sidecar so a
            # failed annotation merge can be retried after restart/reimport.
            result = {"pending": True, "error": f"Zotero 笔记与批注暂未合并，可重新导入重试：{exc}"}
            print(f"[zotero] {job_id}: {result['error']}", flush=True)
        try:
            write_zotero_json(job_dir / "zotero-status.json", result)
        except OSError as exc:
            result.update(pending=True, error=f"Zotero 导入状态暂未保存，可重新导入重试：{exc}")
            print(f"[zotero] {job_id}: {result['error']}", flush=True)
        return result


def _import_zotero_document(library: str, item: Dict[str, str], folder_id: str) -> Dict[str, Any]:
    client = ZoteroClient()
    package = client.fetch_document(library, item["item_key"], item["attachment_key"])
    existing_id = LIBRARY.find_zotero_source(package["source_id"])
    record = STORE.get(existing_id) if existing_id else None
    deduplicated = bool(record)
    incoming_dir = None
    try:
        incoming_dir = STORE.new_incoming_directory()
        pdf = client.download_pdf(library, item["attachment_key"], incoming_dir / "upload.pdf.part")
        if record is not None and record.get("source_sha256") != pdf["sha256"]:
            return {**item, "title": package["title"], "status": "skipped", "job_id": str(record["job_id"]),
                    "pending": False, "error": "同一 Zotero 来源的 PDF 已变化。已保留本地文献，本次未导入新版笔记或批注，以免对应到错误正文。"}
        # This sidecar moves atomically with a newly committed job; it must
        # exist before startup or a conversion worker can discover the PDF.
        # Existing jobs also use the upload transaction to repair a missing
        # source or requeue an earlier failed conversion.
        stage_zotero_import(incoming_dir, package)
        record, reused = STORE.commit_staged_upload(
            incoming_dir, pdf["filename"], pdf["byte_size"], pdf["sha256"], folder_id,
        )
        deduplicated = deduplicated or reused
        incoming_dir = None
    finally:
        if incoming_dir is not None:
            shutil.rmtree(incoming_dir, ignore_errors=True)
    job_id = str(record["job_id"])
    with _job_mutation(job_id), ANNOTATION_LOCK:
        record = STORE.get(job_id)
        _assert_annotation_style_writable()
        if record is None:
            raise ValueError("文献已被删除，请重新导入。")
        job_dir = Path(record["job_dir"])
        stage_zotero_import(job_dir, package)
        warnings = []
        try:
            LIBRARY.sync_jobs([record])
            LIBRARY.restore_item(job_id)
            LIBRARY.import_zotero_metadata(job_id, package)
            if folder_id:
                LIBRARY.add_to_folder(job_id, folder_id)
            warnings.extend(_apply_requested_folders(record))
            result = _apply_zotero_pending(job_id)
        except (OSError, LibraryValidationError) as exc:
            result = {"pending": True, "error": f"PDF 已接收，Zotero 附属信息暂未合并，可重新导入重试：{exc}"}
        if record.get("status") == "queued":
            CONVERSION_QUEUE.put((job_id, str(record.get("source_filename") or "document.pdf")))
        if record.get("status") == "failed":
            result.update(pending=False, error="PDF 解析失败；请在“从 Zotero 导入”中重新选择该文献并导入以重试，会复用当前文献。")
        return {**item, "title": package["title"], "status": "existing" if deduplicated else "imported",
                "job_id": job_id, **result, "warnings": [*warnings, *result.get("warnings", [])]}


def _zotero_batch_status(batch_id: str) -> Dict[str, Any]:
    batch = _zotero_imports().get(batch_id)
    for result in batch["results"]:
        job_id = result.get("job_id")
        if not job_id or result.get("status") == "skipped":
            continue
        record = STORE.get(job_id)
        if not record:
            result.update(pending=False, error="导入的文献已被删除。")
        elif record.get("status") == "failed":
            result.update(pending=False, error="PDF 解析失败；请在“从 Zotero 导入”中重新选择该文献并导入以重试，会复用当前文献。")
        elif record.get("status") == "completed":
            saved = _read_json_file(Path(record["job_dir"]) / "zotero-status.json", {})
            if isinstance(saved, dict):
                if saved.get("pending") is False and not saved.get("error"):
                    result.pop("error", None)
                result.update(saved)
    return batch


def _initialize_runtime_stores() -> None:
    global STORE, LIBRARY, VOCABULARY, ANNOTATION_STYLE_RECOVERY_REQUIRED
    if not runtime.READONLY_MODE:
        recover_pending_transactions(SETTINGS_PATH, LIBRARY_ROOT)
        ANNOTATION_STYLE_RECOVERY_REQUIRED = False
    if VOCABULARY is None:
        VOCABULARY = VocabularyStore(LIBRARY_ROOT)
    if STORE is not None and LIBRARY is not None:
        return
    STORE = JobStore(JOBS_ROOT)
    LIBRARY = LibraryStore(LIBRARY_ROOT)
    STORE.recover_permanent_delete_journals(LIBRARY)
    records = STORE.list()
    LIBRARY.sync_jobs(records)
    for record in records:
        _apply_requested_folders(record)


def _scholar_service() -> ScholarService:
    with CAPABILITY_INIT_LOCK:
        global SCHOLAR_SERVICE
        if SCHOLAR_SERVICE is None or SCHOLAR_SERVICE.store is not STORE or SCHOLAR_SERVICE.library is not LIBRARY or SCHOLAR_SERVICE.search_index.path != LIBRARY_ROOT / "cache" / "search.sqlite3":
            if SCHOLAR_SERVICE is not None:
                SCHOLAR_SERVICE.search_index.close()
            SCHOLAR_SERVICE = ScholarService(sys.modules[__name__])
        return SCHOLAR_SERVICE


def _mcp_access() -> MCPAccess:
    with CAPABILITY_INIT_LOCK:
        global MCP_ACCESS
        if MCP_ACCESS is None or MCP_ACCESS.root != DATA_ROOT / "mcp":
            MCP_ACCESS = MCPAccess(DATA_ROOT)
        return MCP_ACCESS


def _plugin_store() -> Any:
    with CAPABILITY_INIT_LOCK:
        global PLUGIN_STORE
        if PLUGIN_STORE is None:
            from plugin_store import PluginStore
            PLUGIN_STORE = PluginStore(DATA_ROOT, LIBRARY_ROOT, PROJECT_ROOT / "web" / "plugins", template_root=PROJECT_ROOT / "plugin_templates" / "starter")
        return PLUGIN_STORE


def _capability_tools(scopes: Any = None) -> List[Dict[str, Any]]:
    tools = [*_scholar_service().tools(), *_plugin_store().tools()]
    return [tool for tool in tools if scopes is None or set(tool.get("requiresScopes", [tool.get("scope")])).issubset(scopes)]


def _call_capability(name: str, arguments: Any, scopes: Any = None) -> Any:
    service = _scholar_service()
    if name in service.descriptors:
        return service.call(name, arguments, scopes)
    tools = {tool["name"]: tool for tool in _plugin_store().tools()}
    if name not in tools:
        raise CapabilityError("未知能力。", 404, "unknown_tool")
    if scopes is not None and tools[name].get("scope", "plugins.manage") not in scopes:
        raise CapabilityError("未授予插件管理权限。", 403, "scope_denied")
    if runtime.READONLY_MODE:
        raise CapabilityError("只读演示模式，暂不支持插件管理。", 403, "readonly")
    if not isinstance(arguments, dict):
        raise CapabilityError("arguments 必须是对象。")
    _assert_annotation_style_writable()
    return _plugin_store().call(name, arguments, allowed_permissions=scopes)


def _migration_request_enter(*, mutation: bool = False) -> bool:
    global MIGRATION_ACTIVE_REQUESTS, MIGRATION_ACTIVE_MUTATIONS
    with MIGRATION_REQUEST_CONDITION:
        if mutation and ANNOTATION_STYLE_RECOVERY_REQUIRED:
            return False
        if MIGRATION_QUIESCING:
            return False
        MIGRATION_ACTIVE_REQUESTS += 1
        if mutation:
            MIGRATION_ACTIVE_MUTATIONS += 1
        return True


def _migration_request_leave(*, mutation: bool = False) -> None:
    global MIGRATION_ACTIVE_REQUESTS, MIGRATION_ACTIVE_MUTATIONS
    with MIGRATION_REQUEST_CONDITION:
        MIGRATION_ACTIVE_REQUESTS = max(0, MIGRATION_ACTIVE_REQUESTS - 1)
        if mutation:
            MIGRATION_ACTIVE_MUTATIONS = max(0, MIGRATION_ACTIVE_MUTATIONS - 1)
        MIGRATION_REQUEST_CONDITION.notify_all()


def _resume_library_requests() -> None:
    global MIGRATION_QUIESCING
    with MIGRATION_REQUEST_CONDITION:
        MIGRATION_QUIESCING = False
        MIGRATION_REQUEST_CONDITION.notify_all()


def _library_migration_status() -> Dict[str, Any]:
    """Report whether the Electron shell can stop and copy the library safely."""
    records = STORE.list() if STORE is not None else []
    busy_jobs = [
        str(record.get("job_id") or "")
        for record in records
        if record.get("status") in {"queued", "running"}
        or (isinstance(record.get("reflow"), dict) and record["reflow"].get("status") in {"queued", "running", "cancelling"})
    ]
    with METADATA_STATE_LOCK:
        metadata_pending = len(METADATA_PENDING)
    with PARSING_PROVIDER_LOCK:
        component_install_pending = PARSING_INSTALL_THREAD is not None and PARSING_INSTALL_THREAD.is_alive()
    conversion_pending = int(getattr(CONVERSION_QUEUE, "unfinished_tasks", 0)) + int(getattr(REFLOW_QUEUE, "unfinished_tasks", 0))
    metadata_queued = int(getattr(METADATA_QUEUE, "unfinished_tasks", 0))
    incoming = 0
    incoming_root = JOBS_ROOT / ".incoming"
    if incoming_root.is_dir():
        try:
            incoming = sum(1 for entry in incoming_root.iterdir() if entry.exists())
        except OSError:
            incoming = 1
    with MIGRATION_REQUEST_CONDITION:
        active_requests = MIGRATION_ACTIVE_REQUESTS
        active_mutations = MIGRATION_ACTIVE_MUTATIONS
        quiescing = MIGRATION_QUIESCING
    ready = not ANNOTATION_STYLE_RECOVERY_REQUIRED and not busy_jobs and not conversion_pending and not metadata_queued and not metadata_pending and not incoming and not active_mutations and not component_install_pending
    return {
        "ready": ready,
        "busy_jobs": busy_jobs,
        "conversion_pending": conversion_pending,
        "metadata_pending": max(metadata_pending, metadata_queued),
        "component_install_pending": component_install_pending,
        **({"reason": "版面引擎安装或导入正在进行中，请等待完成后再重试。"} if component_install_pending else {}),
        "incoming_uploads": incoming,
        "active_requests": active_requests,
        "active_mutations": active_mutations,
        "quiescing": quiescing,
    }


def _quiesce_library_requests(timeout: float = 30.0) -> Dict[str, Any]:
    global MIGRATION_QUIESCING
    deadline = time.monotonic() + max(0.1, float(timeout))
    with MIGRATION_REQUEST_CONDITION:
        if ANNOTATION_STYLE_RECOVERY_REQUIRED:
            return {"ready": False, "reason": "语义标记同步尚待恢复，请重启服务后再迁移文献库。"}
        if MIGRATION_QUIESCING:
            return {"ready": False, "reason": "文献库已经在准备迁移。"}
        MIGRATION_QUIESCING = True
        while MIGRATION_ACTIVE_REQUESTS:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                MIGRATION_QUIESCING = False
                MIGRATION_REQUEST_CONDITION.notify_all()
                return {"ready": False, "reason": "仍有文献请求正在处理，请稍后重试。"}
            MIGRATION_REQUEST_CONDITION.wait(timeout=remaining)
    try:
        status = _library_migration_status()
        if not status.get("ready"):
            _resume_library_requests()
            return {**status, "quiescing": False}
        jobs = STORE.list() if STORE is not None else []
        library = LIBRARY.snapshot([_public_job(item) for item in jobs]) if LIBRARY is not None else {"items": {}}
        return {
            **status,
            "ready": True,
            "baseline": {
                "jobs": len(jobs),
                "items": len(library.get("items") or {}),
            },
        }
    except Exception:
        _resume_library_requests()
        raise


def _apply_requested_folders(record: Dict[str, Any]) -> List[str]:
    """Replay the durable folder intent after upload or process recovery."""
    job_id = str(record.get("job_id") or "")
    if not job_id:
        return []
    # Folder replay can run during startup while a stale queue entry is still
    # draining. Re-read the live job under the same lock as permanent delete so
    # a deleted document is never recreated or written back from an old record.
    with _job_mutation(job_id):
        current = STORE.get(job_id) if STORE is not None else None
        if not current:
            return []
        requested = list(dict.fromkeys(str(value).strip() for value in current.get("requested_folder_ids") or [] if str(value).strip()))
        if not requested:
            return []
        remaining: List[str] = []
        warnings: List[str] = []
        for folder_id in requested:
            try:
                LIBRARY.add_to_folder(job_id, folder_id)
            except LibraryValidationError as exc:
                # A deleted folder is not recoverable; the document itself remains
                # valid and is imported into the library root.
                warnings.append(str(exc))
            except OSError as exc:
                remaining.append(folder_id)
                warnings.append(f"文件夹关联稍后重试：{exc}")
        if remaining != requested and STORE.get(job_id):
            STORE.update(job_id, requested_folder_ids=remaining)
        return warnings


def _metadata_settings() -> Dict[str, Any]:
    data = _stored_settings().get("metadata", {})
    return data if isinstance(data, dict) else {}


def _metadata_needs_local_abstract_backfill(metadata: Any) -> bool:
    if not isinstance(metadata, dict) or "abstract" in set(metadata.get("locked_fields") or []):
        return False
    fields = metadata.get("fields") if isinstance(metadata.get("fields"), dict) else {}
    sources = metadata.get("sources") if isinstance(metadata.get("sources"), dict) else {}
    abstract_source = sources.get("abstract") if isinstance(sources.get("abstract"), dict) else {}
    return (
        str(abstract_source.get("provider") or "") == "local-document"
        and is_fragmented_metadata_text(fields.get("abstract"))
    )


def _metadata_job_lock(job_id: str) -> KeyedLock:
    return METADATA_JOB_LOCKS.lock(job_id)


def _enqueue_metadata(job_id: str, online: bool, phase: str, *, force: bool = False) -> bool:
    phase = "quick" if phase == "quick" else "refine"
    with METADATA_STATE_LOCK:
        generation = METADATA_GENERATIONS.get(job_id, 0)
        if force:
            generation += 1
            METADATA_GENERATIONS[job_id] = generation
        else:
            METADATA_GENERATIONS.setdefault(job_id, generation)
        key = (job_id, phase, generation)
        if key in METADATA_PENDING:
            return False
        METADATA_PENDING.add(key)
    METADATA_QUEUE.put((job_id, bool(online), phase, generation))
    return True


def _run_metadata_job(job_id: str, online: bool, phase: str, generation: int) -> None:
    record = STORE.get(job_id)
    if not record:
        return
    if phase == "refine" and record.get("status") != "completed":
        return
    with _metadata_job_lock(job_id):
        with METADATA_STATE_LOCK:
            if generation != METADATA_GENERATIONS.get(job_id, 0):
                return
        try:
            # Claim the document-owned state transition under the same lock as
            # delete and user edits, but leave network/parse work unlocked so a
            # cancellation or shutdown is not held behind a slow provider.
            with _job_mutation(job_id):
                current = STORE.get(job_id)
                if not current or (phase == "refine" and current.get("status") != "completed"):
                    return
                record = current
                LIBRARY.mark_metadata_retrieving(job_id)
                STORE.update(job_id, metadata_status="retrieving", metadata_phase=phase)
            started = time.perf_counter()
            job_dir = Path(record["job_dir"])
            source = job_dir / "source.pdf"
            if not source.is_file():
                source = job_dir / "upload.pdf"
            document_json = _active_conversion_root(job_dir) / "document.json" if phase == "refine" else None
            result = retrieve_bibliographic_metadata(
                source,
                document_json,
                str(record.get("source_filename") or ""),
                online=online,
                contact_email=str(_metadata_settings().get("contact_email") or ""),
            )
            with METADATA_STATE_LOCK:
                if generation != METADATA_GENERATIONS.get(job_id, 0):
                    return
            with _job_mutation(job_id):
                if not STORE.get(job_id):
                    return
                merged = LIBRARY.merge_metadata_result(job_id, result)
                STORE.update(
                    job_id,
                    metadata_status=str(merged.get("status") or result.get("status") or "local"),
                    metadata_phase=phase,
                    metadata_seconds=round(time.perf_counter() - started, 3),
                    metadata_venue=str(merged.get("fields", {}).get("venue") or ""),
                )
        except Exception as exc:  # metadata must never make a readable job fail
            try:
                with METADATA_STATE_LOCK:
                    if generation != METADATA_GENERATIONS.get(job_id, 0):
                        return
                with _job_mutation(job_id):
                    if not STORE.get(job_id):
                        return
                    LIBRARY.merge_metadata_result(job_id, {"status": "failed", "error": str(exc)[:500], "fields": {}, "sources": {}, "candidates": []})
                    STORE.update(job_id, metadata_status="failed", metadata_phase=phase)
            except Exception:
                pass


def _metadata_worker() -> None:
    while True:
        job_id, online, phase, generation = METADATA_QUEUE.get()
        try:
            try:
                _run_metadata_job(job_id, online, phase, generation)
            except Exception as exc:
                print(f"[metadata] 任务 {job_id} 异常：{exc}", flush=True)
        finally:
            with METADATA_STATE_LOCK:
                METADATA_PENDING.discard((job_id, phase, generation))
                # Nothing queued or running still carries a generation for this
                # job, so its counter can restart from zero next time.
                if not any(pending[0] == job_id for pending in METADATA_PENDING):
                    METADATA_GENERATIONS.pop(job_id, None)
            METADATA_QUEUE.task_done()


def _run_conversion_job(job_id: str, source_name: str) -> None:
    record = STORE.claim(job_id)
    if not record:
        return
    job_dir = Path(record["job_dir"])
    attempt = max(1, int(record.get("attempt") or 1))
    attempt_dir = job_dir / "work" / f"attempt-{attempt}"
    started = time.perf_counter()
    last_stage_at = started
    last_stage = "启动转换"
    stage_timings: List[Dict[str, Any]] = []

    def progress(stage: str, fraction: float) -> None:
        nonlocal last_stage_at, last_stage
        now = time.perf_counter()
        if stage != last_stage:
            stage_timings.append({"stage": last_stage, "seconds": round(now - last_stage_at, 3)})
            last_stage = stage
            last_stage_at = now
        STORE.update(job_id, status="running", stage=stage, progress=fraction)

    try:
        attempt_dir.mkdir(parents=True, exist_ok=False)
        remote_provider = _parsing_provider_registry().get("remote-guzi")
        if getattr(remote_provider, "configured", lambda: False)() is True:
            result = remote_provider.run(ParsingRequest(job_id=job_id, source_pdf=job_dir / "upload.pdf", output_dir=attempt_dir, source_name=source_name), progress=progress)
            manifest = result.manifest
        else:
            manifest = process_pdf(
                job_dir / "upload.pdf", attempt_dir, job_id=job_id,
                source_name=source_name, progress=progress, backend_override="odl",
            )
        source = manifest.setdefault("source", {})
        if record.get("source_sha256"):
            source["sha256"] = record["source_sha256"]
        manifest = _rebase_manifest_paths(manifest, attempt_dir, job_dir)
        manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2)
        (attempt_dir / "manifest.json").write_text(manifest_text, encoding="utf-8")
        _ensure_content_layout(attempt_dir)
        _sync_content_file(attempt_dir, "annotations/annotations.json", [])
        _sync_content_file(attempt_dir, "notes/notes.md", "")
        _write_translation_records(attempt_dir, [])
        # Artifact publication and the completed-state/index handoff must be
        # atomic with respect to permanent deletion. The expensive conversion
        # itself remains outside this lock.
        with _job_mutation(job_id):
            if not STORE.get(job_id):
                return
            _publish_conversion_attempt(job_dir, attempt_dir)
            finished = time.perf_counter()
            stage_timings.append({"stage": last_stage, "seconds": round(finished - last_stage_at, 3)})
            metrics = {"conversion_seconds": round(finished - started, 3), "stages": stage_timings}
            STORE.update(job_id, status="completed", stage="已完成", progress=1.0, manifest=manifest, metrics=metrics)
            completed = STORE.get(job_id)
            if completed:
                LIBRARY.sync_jobs([completed])
                _apply_zotero_pending(job_id)
                settings = _metadata_settings()
                if _setting_bool(settings.get("auto_retrieve", True), True):
                    _enqueue_metadata(job_id, _setting_bool(settings.get("online_lookup", True), True), "refine")
    except Exception as exc:  # conversion errors must be visible in the UI
        error = str(exc)
        try:
            with _job_mutation(job_id):
                if not STORE.get(job_id):
                    return
                (job_dir / "error.json").write_text(json.dumps({"error": error, "at": utc_now()}, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass
        try:
            with _job_mutation(job_id):
                if not STORE.get(job_id):
                    return
                STORE.update(
                    job_id,
                    status="failed",
                    stage="转换失败",
                    progress=1.0,
                    error=error,
                    metrics={"conversion_seconds": round(time.perf_counter() - started, 3), "stages": stage_timings},
                )
        except Exception as persist_error:
            print(f"[conversion] 无法保存任务 {job_id} 的失败状态：{persist_error}", flush=True)


def _conversion_worker() -> None:
    while True:
        job_id, source_name = CONVERSION_QUEUE.get()
        try:
            try:
                _run_conversion_job(job_id, source_name)
            except Exception as exc:
                print(f"[conversion] 任务 {job_id} 异常：{exc}", flush=True)
        finally:
            CONVERSION_QUEUE.task_done()


def _reflow_cancel_event(job_id: str, generation: int) -> threading.Event:
    key = (str(job_id), int(generation))
    with REFLOW_CANCEL_LOCK:
        return REFLOW_CANCEL_EVENTS.setdefault(key, threading.Event())


def _forget_reflow_cancel_event(job_id: str, generation: int) -> None:
    with REFLOW_CANCEL_LOCK:
        REFLOW_CANCEL_EVENTS.pop((str(job_id), int(generation)), None)


def _remote_parser_config_path() -> Path:
    explicit = os.environ.get("MY_SCHOLAR_REMOTE_PARSER_CONFIG")
    if explicit:
        return Path(explicit).expanduser().resolve()
    persistent = DATA_ROOT / "remote-parser.config.json"
    legacy = PROJECT_ROOT / "config.local.json"
    return persistent if persistent.is_file() or not legacy.is_file() else legacy


def _parsing_provider_registry() -> Any:
    global PARSING_PROVIDERS
    with PARSING_PROVIDER_LOCK:
        if PARSING_PROVIDERS is None:
            PARSING_PROVIDERS = create_default_registry(COMPONENTS_ROOT, remote_config_path=_remote_parser_config_path())
        return PARSING_PROVIDERS


def _active_parsing_provider() -> Any:
    registry = _parsing_provider_registry()
    remote = registry.get("remote-guzi")
    return remote if getattr(remote, "configured", lambda: False)() is True else registry.get("local-mineru")


def _ensure_provider_configuration_idle(action: str) -> None:
    active_reflow = any(
        isinstance(record.get("reflow"), dict)
        and record["reflow"].get("status") in {"queued", "running", "cancelling"}
        for record in (STORE.list() if STORE is not None else [])
    )
    if active_reflow:
        raise ProviderError(f"AI 重排正在使用版面引擎，暂不能{action}。", code="busy")
    if PARSING_INSTALL_THREAD is not None and PARSING_INSTALL_THREAD.is_alive():
        raise ProviderError(f"版面引擎安装或导入正在进行中，暂不能{action}。", code="busy")


def _run_provider_install(provider_id: str, cancel_event: threading.Event) -> None:
    global PARSING_INSTALL_CANCEL_EVENT, PARSING_INSTALL_THREAD
    try:
        _parsing_provider_registry().get(provider_id).install(cancel_event=cancel_event)
    except ProviderError as exc:
        print(f"[components] {provider_id} 安装失败：{exc}", flush=True)
    except Exception as exc:
        print(f"[components] {provider_id} 安装异常：{type(exc).__name__}: {exc}", flush=True)
    finally:
        with PARSING_PROVIDER_LOCK:
            PARSING_INSTALL_THREAD = None
            PARSING_INSTALL_CANCEL_EVENT = None


def _run_provider_import(provider_id: str, source: Path) -> None:
    global PARSING_INSTALL_THREAD
    try:
        _parsing_provider_registry().get(provider_id).import_existing(source)
    except ProviderError as exc:
        print(f"[components] {provider_id} 导入失败：{exc}", flush=True)
    except Exception as exc:
        print(f"[components] {provider_id} 导入异常：{type(exc).__name__}: {exc}", flush=True)
    finally:
        with PARSING_PROVIDER_LOCK:
            PARSING_INSTALL_THREAD = None


def _run_reflow_job(job_id: str, source_name: str, generation: int) -> None:
    cancel_event = _reflow_cancel_event(job_id, generation)
    # Claim under the document mutation lock so a queued worker cannot race a
    # permanent delete or a user-initiated reflow cancellation.
    with _job_mutation(job_id):
        record = STORE.claim_reflow(job_id, generation)
    if not record:
        _forget_reflow_cancel_event(job_id, generation)
        return
    job_dir = Path(str(record["job_dir"]))
    source_path = job_dir / "source.pdf"
    renders_root = job_dir / "renders"
    final_dir = renders_root / str(generation)
    attempt_dir = renders_root / f".{generation}-{uuid.uuid4().hex}.tmp"
    started = time.perf_counter()

    def progress(stage: str, fraction: float) -> None:
        if cancel_event.is_set():
            raise ReflowCancelledError("用户已取消重新排版。")
        STORE.update_reflow(
            job_id,
            generation,
            expected_statuses={"running"},
            status="running",
            stage=stage,
            progress=max(0.02, min(0.98, float(fraction))),
        )

    try:
        if cancel_event.is_set():
            raise ReflowCancelledError("用户已取消重新排版。")
        if not source_path.is_file():
            raise PipelineError("原始 source.pdf 不存在，无法安全重新排版。")
        digest = JobStore._hash_file(source_path)
        expected = str(record.get("source_sha256") or "").strip().lower()
        if not digest or not expected or not hmac.compare_digest(digest, expected):
            raise PipelineError("原始 PDF 校验失败，已取消重新排版。")
        renders_root.mkdir(parents=True, exist_ok=True)
        attempt_dir.mkdir(parents=False, exist_ok=False)
        provider_result = _active_parsing_provider().run(
            ParsingRequest(
                job_id=job_id,
                source_pdf=source_path,
                output_dir=attempt_dir,
                source_name=source_name,
                generation=generation,
                **_parsing_settings(_stored_settings().get("parsing")),
            ),
            progress=progress,
            cancel_event=cancel_event,
        )
        manifest = provider_result.manifest
        if cancel_event.is_set():
            raise ReflowCancelledError("用户已取消重新排版。")
        source = manifest.setdefault("source", {})
        source["sha256"] = digest
        manifest = _rebase_manifest_paths(manifest, attempt_dir, final_dir)
        (attempt_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        _validate_reflow_render(attempt_dir)
        if cancel_event.is_set():
            raise ReflowCancelledError("用户已取消重新排版。")
        if final_dir.exists():
            raise PipelineError("重新排版 generation 已存在，未覆盖任何文件。")
        # Publishing and switching the active generation are one short,
        # document-owned critical section. The provider work above remains
        # cancellable and does not hold this lock.
        with _job_mutation(job_id):
            current = STORE.get(job_id)
            current_reflow = current.get("reflow") if isinstance(current, dict) else None
            if not current or not isinstance(current_reflow, dict) or int(current_reflow.get("generation") or 0) != int(generation):
                raise PipelineError("重新排版任务状态已变化，新版本未启用。")
            if cancel_event.is_set() or current_reflow.get("status") == "cancelling":
                raise ReflowCancelledError("用户已取消重新排版。")
            os.replace(attempt_dir, final_dir)
            if cancel_event.is_set():
                shutil.rmtree(final_dir, ignore_errors=True)
                raise ReflowCancelledError("用户已取消重新排版。")
            published_manifest = _validate_reflow_render(final_dir)
            metrics = {
                **provider_result.metrics,
                "generation": generation,
                "conversion_seconds": round(time.perf_counter() - started, 3),
                "validation": str(published_manifest.get("validation", {}).get("status") or ""),
            }
            if not STORE.complete_reflow(job_id, generation, published_manifest, metrics):
                shutil.rmtree(final_dir, ignore_errors=True)
                raise PipelineError("重新排版任务状态已变化，新版本未启用。")
        try:
            _enqueue_metadata(job_id, False, "refine", force=True)
        except Exception as metadata_error:
            print(f"[metadata] 无法安排任务 {job_id} 的本地摘要刷新：{metadata_error}", flush=True)
    except Exception as exc:
        # A cancellation is not a diagnostic; only real failures leave a log.
        preserved = (
            None
            if cancel_event.is_set() or isinstance(exc, ReflowCancelledError)
            else _preserve_layout_error_log(attempt_dir, renders_root, generation)
        )
        shutil.rmtree(attempt_dir, ignore_errors=True)
        try:
            with _job_mutation(job_id):
                current = STORE.get(job_id) or {}
                if not current:
                    return
                if int(current.get("active_render") or 0) != int(generation):
                    shutil.rmtree(final_dir, ignore_errors=True)
                reflow = current.get("reflow") if isinstance(current.get("reflow"), dict) else {}
                cancelled = cancel_event.is_set() or isinstance(exc, ReflowCancelledError) or reflow.get("status") == "cancelling"
                STORE.update_reflow(
                    job_id,
                    generation,
                    expected_statuses={"running", "cancelling"},
                    status="cancelled" if cancelled else "failed",
                    stage="重新排版已取消" if cancelled else "重新排版失败",
                    error="用户已取消重新排版，当前阅读版本未受影响。" if cancelled else _reflow_failure_error(exc, preserved),
                )
        except Exception as persist_error:
            print(f"[reflow] 无法保存任务 {job_id} 的失败状态：{persist_error}", flush=True)
    finally:
        _forget_reflow_cancel_event(job_id, generation)


def _reflow_worker() -> None:
    while True:
        job_id, source_name, generation = REFLOW_QUEUE.get()
        try:
            try:
                _run_reflow_job(job_id, source_name, generation)
            except Exception as exc:
                print(f"[reflow] 任务 {job_id} 异常：{exc}", flush=True)
        finally:
            REFLOW_QUEUE.task_done()


def _start_background_workers() -> None:
    if runtime.READONLY_MODE:
        # A showcase deployment serves existing artifacts only; conversion
        # and metadata workers would try to write into the data root.
        return
    for index in range(CONVERSION_WORKERS):
        threading.Thread(target=_conversion_worker, name=f"my-scholar-conversion-{index + 1}", daemon=True).start()
    threading.Thread(target=_reflow_worker, name="my-scholar-reflow", daemon=True).start()
    for index in range(METADATA_WORKERS):
        threading.Thread(target=_metadata_worker, name=f"my-scholar-metadata-{index + 1}", daemon=True).start()
    settings = _metadata_settings()
    metadata_enabled = _setting_bool(settings.get("auto_retrieve", True), True)
    metadata_online = _setting_bool(settings.get("online_lookup", True), True)
    for record in STORE.list():
        if record.get("status") == "completed":
            _apply_zotero_pending(str(record["job_id"]))
        if record.get("status") == "queued" and Path(record.get("job_dir", "")).joinpath("upload.pdf").is_file():
            CONVERSION_QUEUE.put((str(record["job_id"]), str(record.get("source_filename") or "document.pdf")))
        try:
            metadata = LIBRARY.get_metadata(str(record["job_id"]))
        except LibraryValidationError:
            metadata = {}
        metadata_status = str(metadata.get("status") or "not-run")
        metadata_venue = str(metadata.get("fields", {}).get("venue") or "")
        if metadata_status in {"local", "needs-review", "complete", "failed"}:
            if record.get("metadata_status") != metadata_status or record.get("metadata_venue") != metadata_venue:
                STORE.update(
                    str(record["job_id"]),
                    metadata_status=metadata_status,
                    metadata_phase=str(record.get("metadata_phase") or ("refine" if record.get("status") == "completed" else "quick")),
                    metadata_venue=metadata_venue,
                )
        if record.get("status") == "completed" and _metadata_needs_local_abstract_backfill(metadata):
            _enqueue_metadata(str(record["job_id"]), False, "refine", force=True)
            continue
        retry_local_online = metadata_online and metadata_status == "local" and not metadata_venue
        if not metadata_enabled or (metadata_status not in {"not-run", "retrieving", "failed"} and not retry_local_online):
            continue
        phase = "refine" if record.get("status") == "completed" else "quick"
        _enqueue_metadata(str(record["job_id"]), metadata_online, phase)


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


# Static web delivery, JSON API routing and job artifact access.
_LOCAL_PATH_RE = re.compile(r'(?:/Users|/home|/root|[A-Za-z]:\\Users)[/\\][^"\s,\]}]*')


def _redact_local_paths(payload: Any) -> Any:
    """Replace absolute filesystem paths in an API payload with a placeholder."""
    if isinstance(payload, str):
        return _LOCAL_PATH_RE.sub("[local]", payload)
    if isinstance(payload, dict):
        return {key: _redact_local_paths(value) for key, value in payload.items()}
    if isinstance(payload, list):
        return [_redact_local_paths(item) for item in payload]
    return payload


# Diagnostics and conversion logs describe the operator's machine; a showcase
# serves only what the reader itself renders.
READONLY_BLOCKED_ARTIFACTS = frozenset({
    "manifest.json",
    "validation.json",
    "ai-review.json",
    "converter.log",
    "layout-error.log",
    "layout-content-list.json",
    "document.json",
})


class ScholarHandler(BaseHTTPRequestHandler):
    server_version = "GuziScholar/0.1"
    # GET/HEAD connections stay reusable for document assets. Mutation handlers
    # can respond before reading their body, so those responses close the socket
    # to keep leftover JSON from becoming the next request's HTTP method.
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Keep the terminal useful while retaining the standard access-log shape.
        # Successful static-asset GETs flood the log during reading; skip them.
        message = format % args
        if message.startswith('"GET /api/jobs/') and ' 200 ' in message and ('/assets/' in message or '/renders/' in message or '/pages/' in message):
            return
        print("[http] " + message, flush=True)

    def _send_body_headers(self, content_type: str, length: int, status: int, disposition: Optional[str], immutable: bool) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        if getattr(self, "command", "GET") not in {"GET", "HEAD"}:
            self.send_header("Connection", "close")
            self.close_connection = True
        # Render generations are content-addressed (sha256 asset names and
        # a monotonically increasing generation), so they can be cached
        # forever; everything else stays uncacheable to avoid stale data.
        self.send_header("Cache-Control", "immutable, max-age=31536000" if immutable else "no-store")
        if disposition:
            self.send_header("Content-Disposition", disposition)
        self.end_headers()

    def _send_bytes(self, body: bytes, content_type: str, status: int = HTTPStatus.OK, *, disposition: Optional[str] = None, immutable: bool = False) -> bool:
        try:
            self._send_body_headers(content_type, len(body), status, disposition, immutable)
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # A renderer can close a request while an image/translation is in
            # flight (for example when switching document tabs). This is a
            # normal client lifecycle event, not a server failure.
            return False

    def _send_file_stream(self, handle: Any, content_type: str, *, disposition: Optional[str] = None, immutable: bool = False) -> bool:
        """Stream an open file in fixed chunks so a large PDF never sits in memory
        whole; concurrent reader requests previously each held a full copy."""
        try:
            remaining = os.fstat(handle.fileno()).st_size
            self._send_body_headers(content_type, remaining, HTTPStatus.OK, disposition, immutable)
            # Send exactly the advertised length: a log that grows while it is
            # served must not overrun Content-Length on a keep-alive socket.
            while remaining > 0:
                chunk = handle.read(min(FILE_STREAM_CHUNK_BYTES, remaining))
                if not chunk:
                    # The file shrank underneath us; the response is short, so
                    # the connection cannot be reused for another request.
                    self.close_connection = True
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return False

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> bool:
        if runtime.READONLY_MODE:
            payload = _redact_local_paths(payload)
        return self._send_bytes(_json_bytes(payload), "application/json; charset=utf-8", status)

    def _send_error_json(
        self,
        message: str,
        status: int = HTTPStatus.BAD_REQUEST,
        *,
        code: str = "",
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        payload: Dict[str, Any] = {"error": message}
        if code:
            payload["code"] = code
        if details:
            payload["details"] = details
        self._send_json(payload, status)

    def _require_ai_entitlement(self) -> bool:
        if not runtime.AI_REQUIRES_MEMBER:
            return True
        account = _account_summary()
        if not account["logged_in"]:
            self._send_error_json("AI 功能需要先登录内测账号。", HTTPStatus.UNAUTHORIZED)
            return False
        if not account["member"]:
            self._send_error_json("AI 功能需要有效的免费内测资格。", HTTPStatus.FORBIDDEN)
            return False
        return True

    def _serve_file(self, path: Path, *, download: bool = False, immutable: bool = False) -> None:
        if not path.is_file():
            self._send_error_json("资源不存在。", HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() == ".html":
            content_type = "text/html; charset=utf-8"
        elif path.suffix.lower() in {".md", ".json"}:
            content_type = "text/plain; charset=utf-8" if path.suffix.lower() == ".md" else "application/json; charset=utf-8"
        elif path.suffix.lower() == ".pdf":
            content_type = "application/pdf"
        elif path.suffix.lower() == ".webmanifest":
            content_type = "application/manifest+json; charset=utf-8"
        elif path.suffix.lower() == ".js":
            content_type = "text/javascript; charset=utf-8"
        disposition = f'attachment; filename="{path.name}"' if download else None
        try:
            handle = path.open("rb")
        except FileNotFoundError:
            self._send_error_json("资源不存在。", HTTPStatus.NOT_FOUND)
            return
        with handle:
            self._send_file_stream(handle, content_type, disposition=disposition, immutable=immutable)

    def _serve_web_asset(self, relative: str) -> None:
        try:
            path = (WEB_ROOT / relative).resolve()
            path.relative_to(WEB_ROOT.resolve())
        except ValueError:
            self._send_error_json("资源不存在。", HTTPStatus.NOT_FOUND)
            return
        self._serve_file(path)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path in {"/api/capabilities", "/api/mcp/status", "/api/plugins", "/api/plugins/runtime-status"}:
            try:
                if path == "/api/capabilities":
                    self._send_json({"tools": _capability_tools(getattr(self, "_capability_scopes", None))})
                elif path == "/api/mcp/status":
                    self._send_json(_mcp_access().status())
                elif path == "/api/plugins/runtime-status":
                    self._send_json(_plugin_store().get_plugin_runtime_status(parse_qs(parsed.query).get("pluginId", [""])[0]))
                else:
                    self._send_json(_plugin_store().call("list_plugins", {}))
            except (ValueError, OSError, CapabilityError) as exc:
                self._send_error_json(str(exc), getattr(exc, "status", 400))
            return
        plugin_match = re.fullmatch(r"/plugins/([a-zA-Z0-9._-]+)/(.+)", path)
        if plugin_match:
            try:
                body, content_type = _plugin_store().asset(*plugin_match.groups())
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (ValueError, OSError) as exc:
                self._send_error_json(str(exc), HTTPStatus.FORBIDDEN if isinstance(exc, PermissionError) else HTTPStatus.NOT_FOUND)
            return
        if path == "/api/vocabulary":
            self._vocabulary_request("list")
            return
        if path.startswith("/api/integrations/zotero/"):
            self._get_zotero(path, parse_qs(parsed.query))
            return
        if runtime.READONLY_MODE and path == "/" and LANDING_FILE and LANDING_FILE.is_file():
            self._send_bytes(LANDING_FILE.read_bytes(), "text/html; charset=utf-8")
            return
        # A worker's scope defaults to its own directory, so the installable
        # shell must be served from the root to control /library.
        if path in {"/sw.js", "/manifest.webmanifest"}:
            self._serve_web_asset(path.lstrip("/"))
            return
        if path == "/" or path == "/index.html" or path == "/library":
            shell_name = os.environ.get("MY_SCHOLAR_SHELL", "reference").strip().lower()
            index = WEB_ROOT / "classic" / "index.html" if shell_name in {"classic", "legacy"} else WEB_ROOT / "index.html"
            self._serve_file(index)
            return
        if path == "/plugin-sdk.js":
            self._serve_file(WEB_ROOT / "plugin-sdk.js")
            return
        if path == "/favicon.ico":
            self._send_bytes(b"", "image/x-icon", HTTPStatus.NO_CONTENT)
            return
        if path == "/api/health":
            ai = ai_status()
            services = _apply_member_gate(ai_services())
            if isinstance(ai, dict):
                ai = {**ai, "services": services}
            else:
                ai = {"services": services}
            self._send_json({
                "ok": True,
                "service": "my-scholar",
                "version": "0.5.0",
                "readonly": runtime.READONLY_MODE,
                "shell": os.environ.get("MY_SCHOLAR_SHELL", "reference"),
                "ai": ai,
                "account": _account_summary(),
                "workers": {
                    "parallel_import": PARALLEL_IMPORT,
                    "conversion": CONVERSION_WORKERS,
                    "metadata": METADATA_WORKERS,
                },
                "storage": {
                    "library_id": hashlib.sha256(os.fsencode(str(LIBRARY_ROOT))).hexdigest(),
                    "migration": _library_migration_status(),
                },
            })
            return
        if path == "/api/account/status":
            self._account_status()
            return
        if path == "/api/settings":
            self._send_json(_public_settings())
            return
        if path == "/api/parsing/providers":
            registry = _parsing_provider_registry()
            remote = registry.get("remote-guzi")
            if getattr(remote, "configured", lambda: False)() is True:
                self._send_json({"providers": [remote.status()], "active_provider_id": "remote-guzi"})
            else:
                self._send_json({"providers": registry.list_capabilities(), "active_provider_id": "local-mineru"})
            return
        if path == "/api/jobs":
            jobs = STORE.list()
            LIBRARY.sync_jobs(jobs)
            self._send_json({"jobs": [_public_job(item) for item in jobs]})
            return
        if path == "/api/library":
            self._send_json({"library": LIBRARY.snapshot([_public_job(item) for item in STORE.list()])})
            return
        if path == "/api/library/display":
            self._send_json({"display": LIBRARY.display()})
            return
        match = re.fullmatch(r"/api/library/items/([a-f0-9]{12,40})/metadata", path)
        if match:
            try:
                self._send_json({"metadata": LIBRARY.get_metadata(match.group(1))})
            except LibraryValidationError as exc:
                self._send_error_json(str(exc), HTTPStatus.NOT_FOUND)
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})", path)
        if match:
            record = STORE.get(match.group(1))
            if not record:
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            else:
                self._send_json(_public_job(record))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/media-layout", path)
        if match:
            job_dir = STORE.path(match.group(1))
            if not job_dir:
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            else:
                self._send_json({"media_layout": _read_media_layout(job_dir)})
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/(annotations|notes)", path)
        if match:
            job_dir = STORE.path(match.group(1))
            if not job_dir:
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                return
            if match.group(2) == "annotations":
                with ANNOTATION_LOCK:
                    if not ANNOTATION_STYLE_RECOVERY_REQUIRED:
                        _ensure_content_layout(job_dir)
                    payload = _annotation_payload(_read_json_file(job_dir / "annotations.json", []))
                self._send_json(payload)
            else:
                _ensure_content_layout(job_dir)
                with _job_mutation_lock(match.group(1)):
                    self._send_json(notes_snapshot(job_dir))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/translations", path)
        if match:
            job_dir = STORE.path(match.group(1))
            if not job_dir:
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                return
            profile_id = translation_profile_id()
            with TRANSLATION_LOCK:
                records = _translation_records(job_dir)
                if not runtime.READONLY_MODE and _translation_records_need_persist(job_dir):
                    _write_translation_records(job_dir, records)
            if runtime.READONLY_MODE or parse_qs(parsed.query).get("scope", [""])[0] == "all":
                # The showcase has no translation credentials of its own; the
                # archived translations ARE the exhibit, so skip the profile
                # scoping that keeps live clients on their current gateway.
                current = records
            else:
                current = [item for item in records if profile_id and str(item.get("profile_id") or "") == profile_id]
            self._send_json({"translations": current, "profile_id": profile_id})
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/auto-highlights", path)
        if match:
            job_dir = STORE.path(match.group(1))
            if not job_dir:
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            else:
                result = _read_json_file(job_dir / "ai-highlights.json", {"status": "not-run", "highlights": []})
                self._send_json({"result": result})
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/ai-review", path)
        if match:
            job_dir = STORE.path(match.group(1))
            if not job_dir:
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            else:
                result = _read_json_file(job_dir / "ai-review.json", {"status": "not-run", "reason": "尚未请求 AI 表格复核。"})
                self._send_json({"result": result})
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/(.+)", path)
        if match:
            self._serve_job_artifact(match.group(1), match.group(2), parsed.query)
            return
        if path.startswith("/web/"):
            relative = path[len("/web/") :]
            self._serve_web_asset(relative)
            return
        self._send_error_json("未找到资源。", HTTPStatus.NOT_FOUND)

    def _serve_job_artifact(self, job_id: str, relative: str, query: str) -> None:
        # Only known artifact names are exposed; path() additionally blocks traversal.
        allowed = {
            "document.html",
            "document.json",
            "layout-content-list.json",
            "manifest.json",
            "validation.json",
            "ai-review.json",
            "translations.json",
            "converter.log",
            "layout-error.log",
            "source.pdf",
        }
        render_match = re.fullmatch(
            r"renders/([1-9][0-9]{0,8})/(document\.html|document\.json|document-ir\.json|manifest\.json|validation\.json|layout-content-list\.json|backend-selection\.json|converter\.log|layout-error\.log|(?:(?:assets/images|pages)/[A-Za-z0-9._@-]+|assets/pages/[A-Za-z0-9._@-]+\.jpg))",
            relative,
        )
        download = "download=1" in query
        blocked_relative = render_match.group(2) if render_match else relative
        if runtime.READONLY_MODE and blocked_relative in READONLY_BLOCKED_ARTIFACTS:
            self._send_error_json("只读演示模式不提供该文件。", HTTPStatus.FORBIDDEN)
            return
        if render_match:
            path = STORE.path(job_id, relative)
        elif relative in allowed:
            path = STORE.path(job_id, relative)
        elif relative.startswith("assets/images/") or relative.startswith("pages/") or re.fullmatch(r"assets/pages/[A-Za-z0-9._@-]+\.jpg", relative):
            path = STORE.path(job_id, relative)
        elif NOTE_ASSET_PATH_RE.fullmatch(relative):
            path = STORE.path(job_id, relative)
        elif relative in {
            "content/manifest.json",
            "content/english/blocks.json",
            "content/chinese/blocks.json",
            "content/notes/notes.md",
            "content/annotations/annotations.json",
        }:
            path = STORE.path(job_id, relative)
        else:
            path = None
        if path is None:
            self._send_error_json("资源不存在。", HTTPStatus.NOT_FOUND)
            return
        # Render generations never change once published, so the reader can
        # cache them aggressively; live job artifacts stay uncacheable.
        self._serve_file(path, download=download, immutable=bool(render_match))

    def _migration_control_authorized(self) -> bool:
        provided = str(self.headers.get("X-My-Scholar-Migration-Token") or "")
        return bool(runtime.MIGRATION_CONTROL_TOKEN) and hmac.compare_digest(provided, runtime.MIGRATION_CONTROL_TOKEN)

    def _prepare_library_migration(self) -> None:
        if not self._migration_control_authorized():
            self._send_error_json("无权控制文献库迁移。", HTTPStatus.FORBIDDEN)
            return
        status = _quiesce_library_requests()
        delivered = False
        try:
            delivered = self._send_json({"migration": status})
        finally:
            if status.get("ready") and not delivered:
                _resume_library_requests()

    def _cancel_library_migration(self) -> None:
        if not self._migration_control_authorized():
            self._send_error_json("无权控制文献库迁移。", HTTPStatus.FORBIDDEN)
            return
        _resume_library_requests()
        self._send_json({"ok": True, "migration": _library_migration_status()})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path in {"/api/capabilities/call", "/api/plugins/call", "/api/plugins/runtime-event", "/api/plugins/admission", "/api/mcp/configure", "/api/mcp/rotate"} or re.fullmatch(r"/api/plugins/([a-zA-Z0-9._-]+)/invoke", path):
            self._capability_request(path)
            return
        if path == "/api/vocabulary":
            self._vocabulary_request("add")
            return
        match = re.fullmatch(r"/api/vocabulary/([a-f0-9]{32})/review", path)
        if match:
            self._vocabulary_request("review", match.group(1))
            return
        match = re.fullmatch(r"/api/vocabulary/([a-f0-9]{32})/explain", path)
        if match:
            if not self._require_ai_entitlement():
                return
            self._explain_vocabulary(match.group(1))
            return
        if path == "/api/integrations/zotero/imports":
            self._start_zotero_import()
            return
        if path == "/api/migration/prepare":
            self._prepare_library_migration()
            return
        if path == "/api/migration/cancel":
            self._cancel_library_migration()
            return
        if path in {"/api/parsing/providers/remote-guzi/connect", "/api/parsing/providers/remote-guzi/disconnect"}:
            try:
                with PARSING_PROVIDER_LOCK:
                    _ensure_provider_configuration_idle("更改远端连接")
                    if any(record.get("status") in {"queued", "running"} for record in (STORE.list() if STORE is not None else [])):
                        raise ProviderError("文献正在解析，暂不能更改远端连接。", code="busy")
                    provider = _parsing_provider_registry().get("remote-guzi")
                    if path.endswith("/connect"):
                        provider.connection.connect()
                    else:
                        provider.connection.close()
                    self._send_json({"provider": provider.status()})
            except ProviderError as exc:
                self._send_provider_error(exc)
            return
        if path == "/api/parsing/providers/local-mineru/install":
            self._start_provider_install("local-mineru")
            return
        if path == "/api/parsing/providers/local-mineru/discover":
            self._discover_provider_external("local-mineru")
            return
        if path == "/api/parsing/providers/local-mineru/select":
            self._select_provider_external("local-mineru")
            return
        if path == "/api/parsing/providers/local-mineru/import":
            self._start_provider_import("local-mineru")
            return
        if path == "/api/parsing/providers/local-mineru/install/cancel":
            self._cancel_provider_install("local-mineru")
            return
        ai_execution = path in {"/api/ai/test", "/api/ai/models", "/api/translation/test"} or re.fullmatch(
            r"/api/jobs/[a-f0-9]{12,40}/(?:translate|chat|auto-highlights|ai-review|reference-summary|reflow)",
            path,
        )
        if ai_execution and not self._require_ai_entitlement():
            return
        if path == "/api/jobs":
            self._create_job()
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/reflow", path)
        if match:
            self._start_reflow(match.group(1))
            return
        if path == "/api/library/folders":
            self._create_library_folder()
            return
        if path == "/api/library/properties":
            self._create_library_property()
            return
        if path == "/api/library/views":
            self._create_library_view()
            return
        if path == "/api/library/display":
            self._update_library_display()
            return
        if path == "/api/library/items/permanent":
            self._permanently_delete_library_items()
            return
        if path == "/api/settings":
            self._update_settings()
            return
        if path == "/api/settings/ai/reuse":
            self._reuse_ai_profile()
            return
        if path == "/api/ai/test":
            self._test_ai_connection()
            return
        if path == "/api/translation/test":
            self._test_translation_connection()
            return
        if path == "/api/ai/models":
            self._list_ai_models()
            return
        if path == "/api/mathml":
            self._render_mathml()
            return
        match = re.fullmatch(
            r"/api/account/(register|login|logout|refresh|update|reset|email-code|reset-email|bind-email)",
            path,
        )
        if match:
            self._account_action(match.group(1))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/ai-review", path)
        if match:
            self._run_ai_review(match.group(1))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/note-assets", path)
        if match:
            self._add_note_asset(match.group(1))
            return
        match = re.fullmatch(r"/api/library/items/([a-f0-9]{12,40})/metadata/retrieve", path)
        if match:
            self._retrieve_library_metadata(match.group(1))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/(annotations|translate|chat|auto-highlights|reference-summary)", path)
        if match:
            action = match.group(2)
            if action == "annotations":
                self._add_annotation(match.group(1))
            elif action == "translate":
                self._translate(match.group(1))
            elif action == "chat":
                self._chat(match.group(1))
            elif action == "reference-summary":
                self._reference_summary(match.group(1))
            else:
                self._auto_highlights(match.group(1))
            return
        match = re.fullmatch(r"/api/library/items/([a-f0-9]{12,40})/(trash|restore)", path)
        if match:
            self._library_item_action(match.group(1), match.group(2))
            return
        self._send_error_json("未找到接口。", HTTPStatus.NOT_FOUND)

    def _capability_request(self, path: str) -> None:
        try:
            payload = self._read_json_body(max_bytes=32 * 1024 * 1024)
            if path == "/api/mcp/configure":
                self._send_json(_mcp_access().configure(payload.get("enabled"), payload.get("scopes", [])))
            elif path == "/api/mcp/rotate":
                self._send_json(_mcp_access().rotate())
            elif path in {"/api/plugins/runtime-event", "/api/plugins/admission"}:
                if getattr(self, "_capability_scopes", None) is not None:
                    raise PermissionError("插件验收只能由桌面宿主执行。")
                if path == "/api/plugins/admission":
                    expected = os.environ.get("MY_SCHOLAR_PLUGIN_ADMISSION_TOKEN", "")
                    supplied = str(self.headers.get("X-My-Scholar-Plugin-Admission") or "")
                    if not expected or not hmac.compare_digest(supplied, expected):
                        raise PermissionError("只有桌面宿主运行检查器可以签发插件验收。")
                method = _plugin_store().report_plugin_runtime_event if path.endswith("runtime-event") else _plugin_store().complete_plugin_admission
                self._send_json(method(**payload))
            elif path.endswith("/invoke"):
                plugin_id = path.split("/")[3]
                result = _plugin_store().invoke(plugin_id, payload.get("name"), payload.get("arguments", {}), lambda name, args: _scholar_service().call(name, args, _plugin_store().granted_permissions(plugin_id, preview_session=payload.get("previewSession"), plugin_session=payload.get("pluginSession"))), preview_session=payload.get("previewSession"), plugin_session=payload.get("pluginSession"))
                self._send_json({"result": result})
            else:
                name = payload.get("name")
                if not isinstance(name, str):
                    raise CapabilityError("name 必须是能力名称。")
                if path == "/api/plugins/call" and name not in {tool["name"] for tool in _plugin_store().tools()}:
                    raise CapabilityError("未知插件管理能力。", 404)
                self._send_json({"result": _call_capability(name, payload.get("arguments", {}), getattr(self, "_capability_scopes", None))})
        except (CapabilityError, PipelineError, ValueError, KeyError, TypeError, OSError) as exc:
            self._send_error_json(str(exc), getattr(exc, "status", HTTPStatus.FORBIDDEN if isinstance(exc, PermissionError) else HTTPStatus.BAD_REQUEST), code=getattr(exc, "code", "capability_error"))

    def _test_ai_connection(self) -> None:
        try:
            results = ai_test_connections()
            self._send_json({"results": results, "record": _record_ai_status(results)})
        except Exception as exc:
            self._send_error_json(f"AI 服务连接测试失败：{exc}", HTTPStatus.BAD_GATEWAY)

    def _test_translation_connection(self) -> None:
        started = time.monotonic()
        try:
            result = ai_test_connection("translation")
        except (RuntimeError, ValueError, OSError) as exc:
            safe = ai_status("translation")
            result = {"ok": False, "service": "translation", "provider": safe.get("provider"),
                      "model": safe.get("model"), "profile_id": safe.get("profile_id"),
                      "elapsed_ms": round((time.monotonic() - started) * 1000), "error": _safe_connection_error(exc)}
        self._send_json({"result": result})

    def _reuse_ai_profile(self) -> None:
        try:
            payload = self._read_json_body(max_bytes=16 * 1024)
            settings = _copy_ai_profile(payload.get("source"), payload.get("target"))
            self._send_json({"settings": settings})
        except (PipelineError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _list_ai_models(self) -> None:
        try:
            payload = self._read_json_body(max_bytes=64 * 1024)
            service = str(payload.get("service") or "").strip().lower()
            if service not in AI_PROFILE_NAMES:
                raise PipelineError("未知 AI 服务。")
            current = _stored_settings().get("ai", {})
            current_profile = current.get(service) if isinstance(current, dict) else None
            profile = _normalize_ai_profile(payload.get("profile"), current_profile, service=service)
            if service == "translation" and profile.get("provider") != "openai-compatible":
                raise PipelineError("专用机器翻译不使用模型列表。")
            if not profile["base_url"]:
                raise PipelineError("请先填写 Base URL。")
            models = discover_models(profile)
            self._send_json({"service": service, "models": [item["id"] for item in models],
                             "model_capabilities": {item["id"]: item["capabilities"] for item in models}})
        except (PipelineError, RuntimeError, OSError, ValueError) as exc:
            self._send_error_json(str(exc), HTTPStatus.BAD_GATEWAY)

    def _vocabulary_request(self, action: str, entry_id: str = "") -> None:
        if action != "list" and runtime.READONLY_MODE:
            self._send_error_json("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)
            return
        vocabulary = VOCABULARY if VOCABULARY is not None else VocabularyStore(LIBRARY_ROOT)
        try:
            if action == "list":
                self._send_json({"entries": vocabulary.list()})
            elif action == "delete":
                vocabulary.delete(entry_id)
                self._send_json({"ok": True})
            else:
                payload = self._read_json_body(max_bytes=256 * 1024)
                if action == "add":
                    source = payload.get("source")
                    if not isinstance(source, dict) or not isinstance(source.get("job_id"), str):
                        raise VocabularyValidationError("请提供生词所在文献。")
                    job_id = source["job_id"]
                    if not JOB_ID_RE.fullmatch(job_id):
                        raise VocabularyValidationError("文献标识无效。")
                    with _job_mutation(job_id):
                        record = STORE.get(job_id) if STORE is not None else None
                        if record is None:
                            self._send_error_json("生词来源文献不存在。", HTTPStatus.NOT_FOUND)
                            return
                        metadata = LIBRARY.get_metadata(job_id) if LIBRARY is not None else {}
                        title = str(metadata.get("fields", {}).get("title") or "")
                        snapshot = source_snapshot(source, record, payload.get("term"), title)
                        entry, created = vocabulary.add(payload, snapshot)
                    self._send_json({"entry": entry, "created": created})
                elif action == "update":
                    self._send_json({"entry": vocabulary.update(entry_id, payload)})
                elif action == "review":
                    self._send_json({"entry": vocabulary.review(entry_id, payload)})
        except KeyError:
            self._send_error_json("生词不存在。", HTTPStatus.NOT_FOUND)
        except (VocabularyValidationError, LibraryValidationError, PipelineError) as exc:
            self._send_error_json(str(exc))
        except OSError as exc:
            self._send_error_json(f"生词本读写失败：{exc}", HTTPStatus.INTERNAL_SERVER_ERROR)

    def _explain_vocabulary(self, entry_id: str) -> None:
        if runtime.READONLY_MODE:
            self._send_error_json("只读演示模式，暂不支持生成释义。", HTTPStatus.FORBIDDEN)
            return
        vocabulary = VOCABULARY if VOCABULARY is not None else VocabularyStore(LIBRARY_ROOT)
        try:
            if self._read_json_body(max_bytes=1024) != {}:
                raise VocabularyValidationError("生成释义使用已保存的词条，无需其他参数。")
            entry = vocabulary.get(entry_id)
            self._send_json(explain_vocabulary(entry))
        except KeyError:
            self._send_error_json("生词不存在。", HTTPStatus.NOT_FOUND)
        except VocabularyValidationError as exc:
            self._send_error_json(str(exc))
        except (RuntimeError, ValueError, OSError) as exc:
            self._send_error_json(_safe_connection_error(exc), HTTPStatus.BAD_GATEWAY)

    def _library_payload(self) -> Dict[str, Any]:
        return {"library": LIBRARY.snapshot([_public_job(item) for item in STORE.list()])}

    def _create_library_folder(self) -> None:
        try:
            payload = self._read_json_body(max_bytes=128 * 1024)
            folder = LIBRARY.create_folder(str(payload.get("name", "")), payload.get("parent_id"))
            self._send_json({"folder": folder, **self._library_payload()}, HTTPStatus.CREATED)
        except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _update_library_folder(self, folder_id: str) -> None:
        try:
            folder = LIBRARY.update_folder(folder_id, self._read_json_body(max_bytes=128 * 1024))
            self._send_json({"folder": folder, **self._library_payload()})
        except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _delete_library_folder(self, folder_id: str) -> None:
        try:
            LIBRARY.delete_folder(folder_id)
            self._send_json(self._library_payload())
        except (LibraryValidationError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _create_library_property(self) -> None:
        try:
            prop = LIBRARY.create_property(self._read_json_body(max_bytes=256 * 1024))
            self._send_json({"property": prop, **self._library_payload()}, HTTPStatus.CREATED)
        except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _update_library_property(self, property_id: str) -> None:
        try:
            prop = LIBRARY.update_property(property_id, self._read_json_body(max_bytes=256 * 1024))
            self._send_json({"property": prop, **self._library_payload()})
        except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _delete_library_property(self, property_id: str) -> None:
        try:
            LIBRARY.delete_property(property_id)
            self._send_json(self._library_payload())
        except (LibraryValidationError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _update_library_item(self, job_id: str) -> None:
        with _job_mutation(job_id):
            if not STORE.get(job_id):
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                return
            try:
                item = LIBRARY.update_item(job_id, self._read_json_body(max_bytes=512 * 1024))
                self._send_json({"item": item, **self._library_payload()})
            except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
                self._send_error_json(str(exc))

    def _update_library_metadata(self, job_id: str) -> None:
        with _job_mutation(job_id):
            if not STORE.get(job_id):
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                return
            try:
                metadata = LIBRARY.update_metadata(job_id, self._read_json_body(max_bytes=512 * 1024))
                self._send_json({"metadata": metadata, **self._library_payload()})
            except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
                self._send_error_json(str(exc))

    def _retrieve_library_metadata(self, job_id: str) -> None:
        with _job_mutation(job_id):
            record = STORE.get(job_id)
            if not record:
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                return
            if record.get("status") != "completed":
                self._send_error_json("任务尚未完成，暂不能检索元数据。", HTTPStatus.CONFLICT)
                return
            try:
                payload = self._read_json_body(max_bytes=64 * 1024) if int(self.headers.get("Content-Length", "0") or "0") else {}
                # JSON clients may send a literal boolean, while older integrations
                # occasionally serialize it as a string.  Normalize both forms so
                # an explicit "false" never accidentally enables network lookup.
                default_online = _setting_bool(_metadata_settings().get("online_lookup", True), True)
                online = _setting_bool(payload["online"], default_online) if "online" in payload else default_online
                metadata = LIBRARY.mark_metadata_retrieving(job_id)
                queued = _enqueue_metadata(job_id, online, "refine", force=True)
                self._send_json({"metadata": metadata, "queued": queued}, HTTPStatus.ACCEPTED)
            except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
                self._send_error_json(str(exc))

    def _library_item_action(self, job_id: str, action: str) -> None:
        with _job_mutation(job_id):
            if not STORE.get(job_id):
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                return
            try:
                item = LIBRARY.trash_item(job_id) if action == "trash" else LIBRARY.restore_item(job_id)
                self._send_json({"item": item, **self._library_payload()})
            except (LibraryValidationError, OSError, ValueError) as exc:
                self._send_error_json(str(exc))

    def _permanent_delete_library_item_transaction(self, job_id: str) -> str:
        """Run one permanent-delete transaction and return its canonical id."""
        with _job_mutation(job_id):
            token: Optional[Dict[str, Any]] = None
            removed: Optional[Dict[str, Any]] = None
            indexed = False
            try:
                token = STORE.stage_permanent_delete(job_id)
                canonical_id = str(token["job_id"])
                removed = LIBRARY.permanently_delete_item(canonical_id)
                STORE._mark_permanent_delete_indexed(token)
                indexed = True
                STORE.finalize_permanent_delete(token)
                return canonical_id
            except Exception as exc:
                if indexed:
                    # The metadata tombstone and journal are durable. Keep the
                    # staged directory as a retryable tombstone if cleanup
                    # failed; restoring it as a normal job could be partial.
                    raise PipelineError(f"文献已从索引移除，但文件清理尚未完成：{exc}") from exc
                recovery_errors: List[str] = []
                if removed is not None and token is not None:
                    try:
                        LIBRARY.restore_deleted_item(str(token["job_id"]), removed)
                    except Exception as restore_error:
                        recovery_errors.append(f"索引恢复失败：{restore_error}")
                if token is not None:
                    try:
                        STORE.rollback_permanent_delete(token)
                    except Exception as rollback_error:
                        recovery_errors.append(f"任务目录恢复失败：{rollback_error}")
                message = str(exc) or "永久删除失败。"
                if recovery_errors:
                    message = f"{message}；{'；'.join(recovery_errors)}"
                raise type(exc)(message) from exc

    def _permanently_delete_library_item(self, job_id: str) -> None:
        """Delete a trashed document's artifacts and library index with recovery."""
        if runtime.READONLY_MODE:
            self._send_error_json("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)
            return
        if not STORE.get(job_id):
            self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            return
        try:
            canonical_id = self._permanent_delete_library_item_transaction(job_id)
            try:
                response = {"deleted": canonical_id, **self._library_payload()}
            except Exception:
                response = {"deleted": canonical_id}
            self._send_json(response)
        except Exception as exc:
            status = HTTPStatus.CONFLICT if isinstance(exc, (PipelineError, LibraryValidationError)) else HTTPStatus.INTERNAL_SERVER_ERROR
            self._send_error_json(str(exc) or "永久删除失败。", status)

    @staticmethod
    def _batch_delete_failure(job_id: str, message: str) -> Dict[str, str]:
        return {"job_id": str(job_id), "error": str(message) or "永久删除失败。"}

    def _permanently_delete_library_items(self) -> None:
        """Validate and permanently delete several trashed documents atomically per item."""
        if runtime.READONLY_MODE:
            self._send_error_json("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)
            return
        try:
            payload = self._read_json_body(max_bytes=256 * 1024)
            raw_ids = payload.get("job_ids", payload.get("ids"))
            if not isinstance(raw_ids, list) or not raw_ids:
                raise PipelineError("请提供非空的 job_ids 列表。")
            if len(raw_ids) > 500:
                raise PipelineError("一次最多彻底清除 500 篇文献。")
        except (PipelineError, ValueError) as exc:
            self._send_error_json(str(exc))
            return

        requested: List[str] = []
        failures: List[Dict[str, str]] = []
        seen: set[str] = set()
        for raw_id in raw_ids:
            job_id = str(raw_id or "").strip()
            if not JOB_ID_RE.fullmatch(job_id):
                failures.append(self._batch_delete_failure(job_id, "文献 ID 无效。"))
                continue
            canonical_id = STORE.resolve_id(job_id)
            if canonical_id in seen:
                continue
            seen.add(canonical_id)
            requested.append(canonical_id)

        deleted: List[str] = []
        with _job_mutations(requested):
            # Do not start any transaction until every item has passed the
            # recycle-bin and busy-state checks.
            valid: List[str] = []
            for job_id in requested:
                canonical_id, store_error = STORE.permanent_delete_preflight(job_id)
                if store_error or not canonical_id:
                    failures.append(self._batch_delete_failure(job_id, store_error or "任务不存在。"))
                    continue
                with LIBRARY.lock:
                    item = LIBRARY.state.get("items", {}).get(canonical_id)
                if not isinstance(item, dict):
                    failures.append(self._batch_delete_failure(job_id, "文献不存在。"))
                    continue
                if not item.get("deleted_at"):
                    failures.append(self._batch_delete_failure(job_id, "只能彻底清除回收站中的文献。"))
                    continue
                valid.append(canonical_id)

            if failures:
                response = {"deleted": [], "failed": failures}
                self._send_json(response, HTTPStatus.CONFLICT)
                return

            for job_id in valid:
                try:
                    deleted.append(self._permanent_delete_library_item_transaction(job_id))
                except Exception as exc:
                    failures.append(self._batch_delete_failure(job_id, str(exc)))
            response = {"deleted": deleted, "failed": failures}
            try:
                response.update(self._library_payload())
            except Exception:
                pass
            self._send_json(response, HTTPStatus.MULTI_STATUS if failures else HTTPStatus.OK)

    def _create_library_view(self) -> None:
        try:
            view = LIBRARY.create_view(self._read_json_body(max_bytes=256 * 1024))
            self._send_json({"view": view, **self._library_payload()}, HTTPStatus.CREATED)
        except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _update_library_display(self) -> None:
        try:
            display = LIBRARY.update_display(self._read_json_body(max_bytes=256 * 1024))
            self._send_json({"display": display, **self._library_payload()})
        except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _update_library_view(self, view_id: str) -> None:
        try:
            view = LIBRARY.update_view(view_id, self._read_json_body(max_bytes=256 * 1024))
            self._send_json({"view": view, **self._library_payload()})
        except (LibraryValidationError, PipelineError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _delete_library_view(self, view_id: str) -> None:
        try:
            LIBRARY.delete_view(view_id)
            self._send_json(self._library_payload())
        except (LibraryValidationError, OSError, ValueError) as exc:
            self._send_error_json(str(exc))

    def do_PUT(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        if path == "/api/settings":
            self._update_settings()
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/notes", path)
        if match:
            self._update_notes(match.group(1))
            return
        self._send_error_json("未找到接口。", HTTPStatus.NOT_FOUND)

    def do_PATCH(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        match = re.fullmatch(r"/api/vocabulary/([a-f0-9]{32})", path)
        if match:
            self._vocabulary_request("update", match.group(1))
            return
        match = re.fullmatch(r"/api/library/folders/([^/]+)", path)
        if match:
            self._update_library_folder(match.group(1))
            return
        match = re.fullmatch(r"/api/library/properties/([^/]+)", path)
        if match:
            self._update_library_property(match.group(1))
            return
        match = re.fullmatch(r"/api/library/items/([a-f0-9]{12,40})", path)
        if match:
            self._update_library_item(match.group(1))
            return
        match = re.fullmatch(r"/api/library/items/([a-f0-9]{12,40})/metadata", path)
        if match:
            self._update_library_metadata(match.group(1))
            return
        match = re.fullmatch(r"/api/library/views/([^/]+)", path)
        if match:
            self._update_library_view(match.group(1))
            return
        if path == "/api/library/display":
            self._update_library_display()
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/annotations/([a-f0-9-]+)", path)
        if match:
            self._update_annotation(match.group(1), match.group(2))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/media-layout", path)
        if match:
            self._update_media_layout(match.group(1))
            return
        self._send_error_json("未找到接口。", HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlsplit(self.path)
        path = unquote(parsed.path)
        match = re.fullmatch(r"/api/vocabulary/([a-f0-9]{32})", path)
        if match:
            self._vocabulary_request("delete", match.group(1))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/reflow", path)
        if match:
            self._cancel_reflow(match.group(1))
            return
        if path == "/api/parsing/providers/local-mineru/component":
            self._remove_provider_component("local-mineru")
            return
        match = re.fullmatch(r"/api/library/items/([a-f0-9]{12,40})/permanent", path)
        if match:
            self._permanently_delete_library_item(match.group(1))
            return
        match = re.fullmatch(r"/api/library/folders/([^/]+)", path)
        if match:
            self._delete_library_folder(match.group(1))
            return
        match = re.fullmatch(r"/api/library/properties/([^/]+)", path)
        if match:
            self._delete_library_property(match.group(1))
            return
        match = re.fullmatch(r"/api/library/views/([^/]+)", path)
        if match:
            self._delete_library_view(match.group(1))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/annotations", path)
        if match:
            self._delete_manual_annotations(match.group(1))
            return
        match = re.fullmatch(r"/api/jobs/([a-f0-9]{12,40})/annotations/([a-f0-9-]+)", path)
        if match:
            self._delete_annotation(match.group(1), match.group(2))
            return
        self._send_error_json("未找到接口。", HTTPStatus.NOT_FOUND)

    def _get_zotero(self, path: str, query: Dict[str, List[str]]) -> None:
        if runtime.READONLY_MODE:
            self._send_error_json("只读演示模式不读取本机 Zotero 文库。", HTTPStatus.FORBIDDEN)
            return
        try:
            if path == "/api/integrations/zotero/status":
                try:
                    self._send_json(ZoteroClient().status())
                except ZoteroError as exc:
                    self._send_json({"available": False, "libraries": [], "error": str(exc)})
                return
            match = re.fullmatch(r"/api/integrations/zotero/imports/([a-f0-9]{32})", path)
            if match:
                self._send_json({"import": _zotero_batch_status(match.group(1))})
                return
            library = query.get("library", ["user:0"])[0]
            if path == "/api/integrations/zotero/collections":
                self._send_json({"collections": ZoteroClient().collections(library)})
                return
            if path == "/api/integrations/zotero/items":
                self._send_json(ZoteroClient().items(library, query.get("collection", [""])[0], query.get("q", [""])[0], int(query.get("start", ["0"])[0])))
                return
            self._send_error_json("未找到 Zotero 接口。", HTTPStatus.NOT_FOUND)
        except KeyError:
            self._send_error_json("导入批次不存在。", HTTPStatus.NOT_FOUND)
        except (ZoteroError, ValueError) as exc:
            self._send_error_json(str(exc), HTTPStatus.BAD_REQUEST)

    def _start_zotero_import(self) -> None:
        if runtime.READONLY_MODE:
            self._send_error_json("只读演示模式，暂不支持导入。", HTTPStatus.FORBIDDEN)
            return
        entered = False
        try:
            request = validate_import_request(self._read_json_body(max_bytes=64 * 1024))
            if request["folder_id"]:
                LIBRARY.validate_user_folder(request["folder_id"])
            # The worker outlives this HTTP request. Keep library migration
            # blocked until every selected attachment has been committed.
            entered = _migration_request_enter(mutation=True)
            if not entered:
                raise PipelineError("文献库正在切换，请稍后导入。")
            batch = _zotero_imports().submit(request, _import_zotero_document, on_finish=lambda: _migration_request_leave(mutation=True))
            entered = False
            self._send_json({"import": batch}, HTTPStatus.ACCEPTED)
        except (PipelineError, LibraryValidationError, ValueError, OSError) as exc:
            self._send_error_json(str(exc))
        finally:
            if entered:
                _migration_request_leave(mutation=True)

    def _read_json_body(self, max_bytes: int = 2 * 1024 * 1024) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > max_bytes:
            raise PipelineError("请求体为空或超过大小限制。")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PipelineError("请求体必须是 JSON。") from exc
        if not isinstance(payload, dict):
            raise PipelineError("JSON 请求体必须是对象。")
        return payload

    def _update_media_layout(self, job_id: str) -> None:
        if runtime.READONLY_MODE:
            self._send_error_json("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)
            return
        try:
            payload = self._read_json_body(max_bytes=256 * 1024)
            if set(payload) != {"items"}:
                raise PipelineError("媒体布局请求只能包含 items。")
            patch_items = _normalize_media_layout_items(payload.get("items"))
            with _job_mutation(job_id):
                job_dir = STORE.path(job_id)
                if not job_dir:
                    self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                    return
                with MEDIA_LAYOUT_LOCK:
                    merged = _read_media_layout(job_dir)["items"]
                    merged.update(patch_items)
                    layout = _write_media_layout(job_dir, merged)
            self._send_json({"media_layout": layout})
        except (OSError, PipelineError, ValueError) as exc:
            self._send_error_json(str(exc))

    def _update_settings(self) -> None:
        try:
            payload = self._read_json_body()
            self._send_json({"settings": _write_settings(payload)})
        except (PipelineError, OSError) as exc:
            self._send_error_json(str(exc))

    def _completed_job_dir(self, job_id: str) -> Optional[Path]:
        record = STORE.get(job_id)
        if not record:
            self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            return None
        if record.get("status") != "completed":
            self._send_error_json("任务尚未完成。", HTTPStatus.CONFLICT)
            return None
        return Path(record["job_dir"])

    @_locked_job_method
    def _add_note_asset(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            content_length = 0
        if content_length <= 0:
            self._send_error_json("上传内容为空。")
            return
        if content_length > MAX_NOTE_ASSET_BYTES + 512 * 1024:
            self._send_error_json("笔记图片超过 5 MB。", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._send_error_json("请使用 multipart/form-data 上传字段 file。")
            return
        try:
            form = _parse_multipart_form(self.rfile, content_type, content_length)
            item = next((entry for entry in form.get("file", []) if entry.filename), None)
            if item is None:
                raise PipelineError("没有找到名为 file 的图片字段。")
            data = item.file.read(MAX_NOTE_ASSET_BYTES + 1)
            asset = _store_note_asset(job_dir, data)
            asset["url"] = f"/api/jobs/{job_id}/content/notes/{asset['ref']}"
            self._send_json({"asset": asset}, HTTPStatus.CREATED)
        except (KeyError, OSError, PipelineError, TypeError, ValueError) as exc:
            self._send_error_json(str(exc))

    @_locked_job_method
    def _add_annotation(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        try:
            payload = self._read_json_body()
            quote = str(payload.get("quote", "")).strip()
            if not quote:
                raise PipelineError("划线内容不能为空。")
            with ANNOTATION_LOCK:
                _assert_annotation_style_writable()
                annotations = _read_json_file(job_dir / "annotations.json", [])
                if not isinstance(annotations, list):
                    annotations = []
                kind = str(payload.get("kind", "highlight"))
                block_id = payload.get("block_id")
                source = "ai" if str(payload.get("source", "")).strip().lower() == "ai" else "manual"
                action_snapshot = _annotation_action_snapshot(payload) if source == "manual" else {}
                kind = action_snapshot.get("kind", kind)
                surface = payload.get("surface") if payload.get("surface") in {"paper", "translation"} else None
                source_block_id = str(payload["source_block_id"]) if payload.get("source_block_id") else None
                start = payload.get("start")
                end = payload.get("end")
                has_precise_anchor = (
                    not isinstance(start, bool)
                    and not isinstance(end, bool)
                    and isinstance(start, (int, float))
                    and isinstance(end, (int, float))
                    and math.isfinite(start)
                    and math.isfinite(end)
                    and end > start
                )
                for existing in annotations:
                    if not isinstance(existing, dict):
                        continue
                    existing_source = "ai" if str(existing.get("source", "")).strip().lower() == "ai" else "manual"
                    same_annotation = (
                        existing.get("kind") == kind
                        and existing.get("block_id") == block_id
                        and existing.get("quote") == quote[:10000]
                        and existing_source == source
                        and (existing.get("action_id") or "") == action_snapshot.get("action_id", "")
                    )
                    if same_annotation and source == "manual" and has_precise_anchor:
                        same_annotation = (
                            existing.get("surface") == surface
                            and existing.get("source_block_id") == source_block_id
                            and existing.get("page") == payload.get("page")
                            and existing.get("start") == start
                            and existing.get("end") == end
                        )
                    if same_annotation:
                        self._send_json(_annotation_payload(annotations, annotation=existing))
                        return
                render_generation = str(payload.get("render_generation") or "")
                if render_generation != "base" and not RENDER_GENERATION_RE.fullmatch(render_generation):
                    render_generation = str(((STORE.get(job_id) if STORE is not None else {}) or {}).get("active_render") or "base")
                item = {
                    "id": uuid.uuid4().hex,
                    "kind": kind,
                    "color": _setting_color(payload.get("color")),
                    "category": str(payload.get("category", "method")),
                    "quote": quote[:10000],
                    "note": str(payload.get("note", ""))[:10000],
                    "page": payload.get("page"),
                    "block_id": payload.get("block_id"),
                    "start": start,
                    "end": end,
                    "source": source,
                    "quote_prefix": str(payload.get("quote_prefix") or "")[-48:],
                    "quote_suffix": str(payload.get("quote_suffix") or "")[:48],
                    "render_generation": render_generation,
                    "created_at": utc_now(),
                    **action_snapshot,
                }
                if surface:
                    item["surface"] = surface
                if source_block_id:
                    item["source_block_id"] = source_block_id
                if source == "ai":
                    item["suggestion_key"] = _highlight_signature(item["block_id"], item["quote"], item["category"])
                    item["suggestion_state"] = "suggested"
                annotations.append(item)
                _atomic_write_text(job_dir / "annotations.json", json.dumps(annotations, ensure_ascii=False, indent=2))
                _sync_content_file(job_dir, "annotations/annotations.json", annotations)
                self._send_json(_annotation_payload(annotations, annotation=item), HTTPStatus.CREATED)
        except (PipelineError, OSError) as exc:
            self._send_error_json(str(exc))

    @_locked_job_method
    def _delete_annotation(self, job_id: str, annotation_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        with ANNOTATION_LOCK:
            _assert_annotation_style_writable()
            annotations = _read_json_file(job_dir / "annotations.json", [])
            annotations = [item for item in annotations if isinstance(item, dict) and item.get("id") != annotation_id]
            _atomic_write_text(job_dir / "annotations.json", json.dumps(annotations, ensure_ascii=False, indent=2))
            _sync_content_file(job_dir, "annotations/annotations.json", annotations)
            payload = _annotation_payload(annotations)
        self._send_json(payload)

    @_locked_job_method
    def _delete_manual_annotations(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        with ANNOTATION_LOCK:
            _assert_annotation_style_writable()
            annotations = _read_json_file(job_dir / "annotations.json", [])
            if not isinstance(annotations, list):
                annotations = []
            kept = [item for item in annotations if isinstance(item, dict) and _is_ai_annotation(item)]
            deleted = sum(1 for item in annotations if isinstance(item, dict) and not _is_ai_annotation(item))
            _atomic_write_text(job_dir / "annotations.json", json.dumps(kept, ensure_ascii=False, indent=2))
            _sync_content_file(job_dir, "annotations/annotations.json", kept)
            payload = _annotation_payload(kept, deleted=deleted)
        self._send_json(payload)

    @_locked_job_method
    def _update_annotation(self, job_id: str, annotation_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        try:
            payload = self._read_json_body(max_bytes=256 * 1024)
            with ANNOTATION_LOCK:
                _assert_annotation_style_writable()
                annotations = _read_json_file(job_dir / "annotations.json", [])
                if not isinstance(annotations, list):
                    annotations = []
                updated = next(
                    (item for item in annotations if isinstance(item, dict) and item.get("id") == annotation_id),
                    None,
                )
                if updated is None:
                    self._send_error_json("笔记标记不存在。", HTTPStatus.NOT_FOUND)
                    return

                action_snapshot = _annotation_action_snapshot({**updated, **payload}) if (
                    "action_id" in payload or "label" in payload
                ) else None
                if action_snapshot:
                    payload = {**payload, **action_snapshot}
                next_kind = None
                if "kind" in payload:
                    next_kind = str(payload.get("kind") or "").strip().lower()
                    if next_kind not in {"highlight", "underline"}:
                        raise PipelineError("标注类型只能是 highlight 或 underline。")
                    if _is_ai_annotation(updated):
                        raise PipelineError("只有人工标注可以切换高亮或划线。")
                    if next_kind != updated.get("kind"):
                        anchor_fields = ("surface", "source_block_id", "page", "block_id", "start", "end", "quote")
                        anchor = tuple(updated.get(field) for field in anchor_fields)
                        has_conflict = any(
                            isinstance(item, dict)
                            and item.get("id") != annotation_id
                            and not _is_ai_annotation(item)
                            and item.get("kind") == next_kind
                            and (item.get("action_id") or "") == (updated.get("action_id") or "")
                            and tuple(item.get(field) for field in anchor_fields) == anchor
                            for item in annotations
                        )
                        if has_conflict:
                            self._send_error_json("同一选区已存在目标类型的标注。", HTTPStatus.CONFLICT)
                            return

                suggestion_state = None
                if "suggestion_state" in payload:
                    if not _is_ai_annotation(updated):
                        raise PipelineError("只有 AI 阅读建议可以修改建议状态。")
                    suggestion_state = str(payload.get("suggestion_state") or "").strip().lower()
                    if suggestion_state not in {"suggested", "ignored"}:
                        raise PipelineError("建议状态只能是 suggested 或 ignored。")

                if "note" in payload:
                    updated["note"] = str(payload.get("note") or "")[:10000]
                if "color" in payload:
                    updated["color"] = _setting_color(payload.get("color"))
                if next_kind is not None:
                    updated["kind"] = next_kind
                if suggestion_state is not None:
                    updated["suggestion_state"] = suggestion_state
                if action_snapshot is not None:
                    updated.pop("action_id", None)
                    updated.pop("label", None)
                    updated.update(action_snapshot)
                _atomic_write_text(job_dir / "annotations.json", json.dumps(annotations, ensure_ascii=False, indent=2))
                _sync_content_file(job_dir, "annotations/annotations.json", annotations)
                result = _annotation_payload(annotations, annotation=updated)
            self._send_json(result)
        except (PipelineError, OSError) as exc:
            self._send_error_json(str(exc))

    @_locked_job_method
    def _update_notes(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        try:
            payload = self._read_json_body(max_bytes=5 * 1024 * 1024)
            result = save_document_notes(job_dir, payload.get("markdown", ""), payload.get("expected_revision"))
            self._send_json({**result, "saved_at": utc_now()})
        except (CapabilityError, PipelineError, OSError) as exc:
            self._send_error_json(str(exc), getattr(exc, "status", HTTPStatus.BAD_REQUEST))

    def _translate(self, job_id: str) -> None:
        flight = None
        flight_key = None
        leader = False
        try:
            with _job_mutation(job_id):
                job_dir = self._completed_job_dir(job_id)
                if not job_dir:
                    return
                document = _read_json_file(_active_conversion_root(job_dir) / "document.json", {})
                semantic_validation = document.get("semantic_validation", {}) if isinstance(document, dict) else {}
                if (isinstance(document, dict) and document.get("translation_enabled") is False) or (isinstance(semantic_validation, dict) and semantic_validation.get("status") == "FAIL"):
                    raise PipelineError("当前文档未通过语义结构校验，不能对视觉整页结果执行段落翻译。")
                payload = self._read_json_body()
                text = str(payload.get("text", "")).strip()
                block_id = str(payload.get("block_id", "") or "").strip()
                profile = resolve_ai_profile("translation")
                target_language = str(payload.get("target_language") or translation_target_language(profile)).strip()
                source_hash = str(payload.get("source_hash", "") or "").strip()
                formulas = payload.get("formulas", [])
                if not isinstance(formulas, list):
                    formulas = []
                formulas = [
                    {"token": str(item.get("token", "")), "tex": str(item.get("tex", ""))[:4000]}
                    for item in formulas
                    if isinstance(item, dict) and re.fullmatch(r"__MY_SCHOLAR_MATH_\d+__", str(item.get("token", "")))
                ]
                segments = payload.get("segments")
                alignment_version = str(payload.get("alignment_version") or "")
                if "segments" in payload or alignment_version:
                    segments = validate_translation_segments(text, segments, alignment_version, formulas)
                if not text:
                    raise ValueError("没有可翻译的文本。")
                profile_id = translation_profile_id(profile)
                cache_key = _translation_key(text, block_id, target_language, source_hash, profile_id, alignment_version, segments)
                refresh = bool(payload.get("refresh"))
                with TRANSLATION_LOCK:
                    cached = None if refresh else next((item for item in _translation_records(job_dir) if item.get("cache_key") == cache_key), None)
                    if not cached:
                        # Refresh shares only with another refresh, so an
                        # explicit retranslation cannot inherit a stale miss.
                        flight_key = (str(job_dir.resolve()), cache_key, refresh)
                        flight = TRANSLATION_FLIGHTS.get(flight_key)
                        if flight is None:
                            leader = True
                            flight = Future()
                            TRANSLATION_FLIGHTS[flight_key] = flight

            def result_for_request(on_delta=None):
                nonlocal job_dir
                if cached:
                    return {**cached, "cached": True}
                if not leader:
                    return {**flight.result(), "cached": False}
                try:
                    options = {"target_language": target_language, "context": _job_context(job_dir, 5000), "formulas": formulas, "profile": profile}
                    if segments is not None:
                        options.update(segments=segments, alignment_version=alignment_version)
                        result = translate_text(text, **options)
                        if on_delta:
                            on_delta({"delta": result["text"]})
                    elif on_delta:
                        parts = []
                        try:
                            for delta in translate_text_stream(text, **options):
                                parts.append(delta)
                                on_delta({"delta": delta})
                            translated = "".join(parts).strip()
                            if not translated:
                                raise RuntimeError("模型返回为空。")
                            result = {"text": translated}
                        except Exception as exc:
                            if parts and not isinstance(exc, TranslationQualityError):
                                raise
                            result = translate_text(text, **options)
                    else:
                        result = translate_text(text, **options)
                    provider = profile.get("provider", "openai-compatible")
                    model = (profile.get("model") or None) if provider == "openai-compatible" else None
                    record = {
                        **result, "cache_key": cache_key, "profile_id": profile_id,
                        "provider": provider, "model": model,
                        "provider_snapshot": {"provider": provider, "model": model, "mode": profile.get("mode") if provider == "openai-compatible" else None},
                        "block_id": block_id, "target_language": target_language,
                        "source_hash": source_hash or hashlib.sha256(text.encode("utf-8")).hexdigest(),
                        "source_text": text, "formulas": formulas, "updated_at": utc_now(),
                    }
                    if segments is not None:
                        record.update(source_segments=segments, alignment_version=alignment_version)
                    with _job_mutation(job_id):
                        if STORE is not None:
                            current_dir = STORE.path(job_id)
                            if not current_dir:
                                raise PipelineError("任务不存在。")
                            job_dir = current_dir
                        with TRANSLATION_LOCK:
                            records = _translation_records(job_dir)
                            existing = next((item for item in records if item.get("cache_key") == cache_key), None)
                            # A refresh can finish while an earlier ordinary
                            # miss is still running. Keep its successful result.
                            if existing is not None and not refresh:
                                record = existing
                            else:
                                records = [item for item in records if item.get("cache_key") != cache_key]
                                records.append(record)
                                _write_translation_records(job_dir, records)
                    flight.set_result(record)
                    return {**record, "cached": False}
                except BaseException as exc:
                    flight.set_exception(exc)
                    raise
                finally:
                    with TRANSLATION_LOCK:
                        if TRANSLATION_FLIGHTS.get(flight_key) is flight:
                            del TRANSLATION_FLIGHTS[flight_key]

            if payload.get("stream"):
                self._translate_stream_response(result_for_request)
            else:
                self._send_json({"result": result_for_request()})
        except Exception as exc:
            self._send_error_json(f"翻译失败：{exc}", HTTPStatus.BAD_GATEWAY)
        finally:
            # A disconnected SSE client may fail before its producer starts.
            if leader and flight is not None and not flight.done():
                flight.set_exception(RuntimeError("翻译请求已关闭。"))
                with TRANSLATION_LOCK:
                    if TRANSLATION_FLIGHTS.get(flight_key) is flight:
                        del TRANSLATION_FLIGHTS[flight_key]

    def _account_status(self) -> None:
        if runtime.READONLY_MODE:
            # A showcase has no session of its own; publishing the account
            # service endpoint or the library footprint helps nobody but a
            # scanner.
            self._send_json({"logged_in": False, "profile": None, "readonly": True})
            return
        state = _read_account_state()
        service = _account_service_configuration()
        self._send_json({
            "server": service.get("server"),
            "service": service,
            "logged_in": bool(state.get("token")),
            "profile": state.get("profile") if isinstance(state.get("profile"), dict) else None,
            "local_used_bytes": _local_usage_bytes(),
            "ai_requires_member": runtime.AI_REQUIRES_MEMBER,
        })

    def _account_action(self, action: str) -> None:
        try:
            payload = self._read_json_body()
            state = _read_account_state()
            token = str(state.get("token", ""))
            if action == "email-code":
                purpose = str(payload.get("purpose", "")).strip().lower()
                if purpose == "bind" and not token:
                    raise PipelineError("尚未登录。")
                body = {
                    "email": str(payload.get("email", "")).strip(),
                    "purpose": purpose,
                }
                if purpose == "register":
                    body["invite_code"] = str(payload.get("invite_code", "")).strip()
                result = _account_request(
                    "/api/auth/email-code/request",
                    method="POST",
                    token=token if purpose == "bind" else "",
                    payload=body,
                )
                self._send_json(result)
                return
            if action == "reset-email":
                result = _account_request(
                    "/api/auth/password-reset/email",
                    method="POST",
                    payload={
                        "challenge_id": str(payload.get("challenge_id", "")).strip(),
                        "email_code": str(payload.get("email_code", "")).strip(),
                        "new_password": str(payload.get("new_password", "")),
                    },
                )
                _write_account_state(None)
                response = {"ok": True, "logged_in": False}
                if result.get("recovery_code"):
                    response["recovery_code"] = result["recovery_code"]
                self._send_json(response)
                return
            if action == "reset":
                result = _account_request(
                    "/api/auth/reset-password",
                    method="POST",
                    payload={
                        "username": str(payload.get("username", "")).strip(),
                        "recovery_code": str(payload.get("recovery_code", "")).strip(),
                        "new_password": str(payload.get("new_password", "")),
                    },
                )
                _write_account_state(None)
                self._send_json({"ok": True, "logged_in": False, "recovery_code": result.get("recovery_code")})
                return
            if action in {"register", "login"}:
                username = str(payload.get("username", "")).strip()
                password = str(payload.get("password", ""))
                body: Dict[str, Any] = {"username": username, "password": password}
                body["terms_version"] = str(payload.get("terms_version", "")).strip()
                body["privacy_version"] = str(payload.get("privacy_version", "")).strip()
                if action == "register":
                    body["invite_code"] = str(payload.get("invite_code", "")).strip()
                    body["email"] = str(payload.get("email", "")).strip()
                    body["email_challenge_id"] = str(payload.get("email_challenge_id", "")).strip()
                    body["email_code"] = str(payload.get("email_code", "")).strip()
                result = _account_request(f"/api/auth/{action}", method="POST", payload=body)
                if not result.get("token"):
                    raise PipelineError("账号服务返回异常。")
                fresh = {"server": runtime.ACCOUNT_SERVICE_URL, "username": username, "token": result["token"], "profile": result.get("profile") or {}}
                _write_account_state(fresh)
                response = {"ok": True, "logged_in": True, "profile": fresh["profile"], "local_used_bytes": _local_usage_bytes()}
                if action == "register" and result.get("recovery_code"):
                    response["recovery_code"] = result["recovery_code"]
                self._send_json(response)
                return
            if action == "logout":
                if token:
                    try:
                        _account_request("/api/auth/logout", method="POST", token=token)
                    except PipelineError:
                        pass  # dropping the local session must always succeed
                _write_account_state(None)
                self._send_json({"ok": True})
                return
            if not token:
                raise PipelineError("尚未登录。")
            if action == "bind-email":
                updated = _account_request(
                    "/api/auth/email-bind",
                    method="POST",
                    token=token,
                    payload={
                        "challenge_id": str(payload.get("challenge_id", "")).strip(),
                        "email_code": str(payload.get("email_code", "")).strip(),
                    },
                )
                profile = updated.get("profile")
                if not isinstance(profile, dict):
                    raise PipelineError("账号服务返回异常。")
                _write_account_state({**state, "profile": profile})
                self._send_json({"ok": True, "logged_in": True, "profile": profile, "local_used_bytes": _local_usage_bytes()})
                return
            if action == "update":
                body = {key: payload[key] for key in ("nickname", "avatar") if key in payload}
                updated = _account_request("/api/auth/profile-update", method="POST", token=token, payload=body)
                profile = updated.get("profile") or {}
                _write_account_state({**state, "profile": profile})
                self._send_json({"ok": True, "logged_in": True, "profile": profile, "local_used_bytes": _local_usage_bytes()})
                return
            refreshed = _account_request("/api/auth/profile", token=token)
            profile = refreshed.get("profile") or {}
            _write_account_state({**state, "profile": profile})
            self._send_json({"ok": True, "logged_in": True, "profile": profile, "local_used_bytes": _local_usage_bytes()})
        except AccountServiceUnavailable as exc:
            self._send_error_json(str(exc), HTTPStatus.SERVICE_UNAVAILABLE)
        except PipelineError as exc:
            message = str(exc)
            if "登录已过期" in message:
                _write_account_state(None)
            self._send_error_json(message)
        except Exception as exc:
            self._send_error_json(f"账号操作失败：{exc}", HTTPStatus.BAD_GATEWAY)

    def _render_mathml(self) -> None:
        try:
            payload = self._read_json_body()
            items = payload.get("formulas", [])
            if not isinstance(items, list) or len(items) > 64:
                raise PipelineError("formulas 必须是不超过 64 项的数组。")
            results: List[str] = []
            for item in items:
                tex = str(item.get("tex", "") if isinstance(item, dict) else "")[:4000].strip()
                display = bool(item.get("display")) if isinstance(item, dict) else False
                if not tex:
                    results.append("")
                    continue
                with MATH_RENDERER_LOCK:
                    rendered = MATH_RENDERER.render(tex, display)
                results.append(rendered if "<math" in rendered else "")
            self._send_json({"results": results})
        except Exception as exc:
            self._send_error_json(f"公式转换失败：{exc}")

    def _send_sse_event(self, payload: Any) -> bool:
        try:
            self.wfile.write(b"data: " + _json_bytes(payload) + b"\n\n")
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return False

    def _translate_stream_response(self, result_for_request) -> None:
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        try:
            result = result_for_request(self._send_sse_event)
            self._send_sse_event({"result": result})
        except Exception as exc:
            self._send_sse_event({"error": f"翻译失败：{exc}"})

    def _chat(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        try:
            payload = self._read_json_body(max_bytes=4 * 1024 * 1024)
            messages = payload.get("messages", [])
            if not isinstance(messages, list):
                raise PipelineError("messages 必须是数组。")
            selected = str(payload.get("selected_text", "")).strip()
            options = _chat_options(payload.get("options"))
            context = _job_context(job_dir, 4_000_001)
            source_truncated = len(context) > 4_000_000
            context = context[:4_000_000]
            image = _chat_image_context(job_dir, payload.get("selected_image"))
            context_info = chat_context_info(context=context, messages=messages, selected_text=selected,
                                             selected_image=image, options=options)
            if source_truncated:
                context_info = {**context_info, "truncated": True, "source_truncated": True}
            if payload.get("stream"):
                self._chat_stream_response(messages, context=context, image=image, selected_text=selected,
                                           options=options, context_info=context_info)
                return
            result = ai_chat(messages, context=context, image=image, selected_text=selected, options=options)
            self._send_json({"result": result, "context": context_info})
        except (PipelineError, ValueError) as exc:
            self._send_error_json(str(exc), HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._send_error_json(f"AI 对话失败：{exc}", HTTPStatus.BAD_GATEWAY)

    def _reference_summary(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        try:
            payload = self._read_json_body(max_bytes=32 * 1024)
            reference_text = re.sub(r"\s+", " ", str(payload.get("reference_text") or "")).strip()
            context = str(payload.get("context") or "").strip()
            reference_number = str(payload.get("reference_number") or "").strip()
            if not 8 <= len(reference_text) <= 6000:
                raise PipelineError("参考文献条目长度无效。")
            if len(context) > 8000:
                raise PipelineError("引用上下文超过 8000 字符。")
            if reference_number and not re.fullmatch(r"\d{1,5}", reference_number):
                raise PipelineError("参考文献编号无效。")
            metadata_settings = _public_settings().get("metadata", {})
            if not isinstance(metadata_settings, dict) or not metadata_settings.get("online_lookup", True):
                raise PipelineError("在线元数据检索已关闭，无法执行 AI 速读。")
            evidence = retrieve_reference_evidence(
                reference_text,
                contact_email=str(metadata_settings.get("contact_email") or ""),
            )
            result = reference_quick_read(reference_text, context=context, evidence=evidence)
            result.update({
                "evidence_level": evidence.get("evidence_level", "citation-only"),
                "sources": evidence.get("sources", []),
            })
            self._send_json({"result": result})
        except PipelineError as exc:
            self._send_error_json(str(exc))
        except ValueError as exc:
            self._send_error_json(str(exc))
        except Exception as exc:
            self._send_error_json(f"参考文献 AI 速读失败：{exc}", HTTPStatus.BAD_GATEWAY)

    def _chat_stream_response(self, messages: List[dict], *, context: str, image: Optional[dict],
                              selected_text: str = "", options: Optional[dict] = None,
                              context_info: Optional[dict] = None) -> None:
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            # SSE has no Content-Length; under HTTP/1.1 keep-alive the end of
            # the stream must be signalled by closing the connection.
            self.send_header("Connection", "close")
            self.close_connection = True
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        parts: List[str] = []
        try:
            if context_info is not None and not self._send_sse_event({"context": context_info}):
                return
            try:
                for delta in ai_chat_stream(messages, context=context, image=image,
                                            selected_text=selected_text, options=options):
                    parts.append(delta)
                    if not self._send_sse_event({"delta": delta}):
                        return
                text = "".join(parts).strip()
                if not text:
                    raise RuntimeError("模型返回为空。")
                result: Dict[str, Any] = {"text": text, "model": ai_status("chat").get("model")}
            except Exception as exc:
                if parts:
                    self._send_sse_event({"error": f"AI 对话失败：{exc}"})
                    return
                # A gateway that cannot stream fails before the first delta;
                # retry once with the plain request so chat still works there.
                result = ai_chat(messages, context=context, image=image,
                                 selected_text=selected_text, options=options)
            self._send_sse_event({"result": result, **({"context": context_info} if context_info is not None else {})})
        except Exception as exc:
            self._send_sse_event({"error": f"AI 对话失败：{exc}"})

    @_locked_job_method
    def _auto_highlights(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        data = _read_json_file(_active_conversion_root(job_dir) / "document.json", {})
        blocks: List[dict] = []
        if isinstance(data, dict):
            for page in data.get("pages", []) if isinstance(data.get("pages"), list) else []:
                for item in page.get("elements", []) if isinstance(page, dict) else []:
                    if isinstance(item, dict) and item.get("type") == "paragraph" and item.get("text"):
                        blocks.append(item)
        try:
            result = auto_highlights(blocks)
            # A gateway can return valid JSON with no suggestions. Treat that
            # as an unavailable/insufficient result so the deterministic local
            # fallback still gives the reader an actionable first pass.
            if not isinstance(result, dict) or not isinstance(result.get("highlights"), list) or not result["highlights"]:
                raise ValueError("模型没有返回可用的阅读重点。")
        except Exception as exc:
            # A local deterministic fallback keeps the interaction useful when
            # the optional gateway is unavailable, and clearly labels itself.
            fallback = _local_highlight_candidates(blocks)
            result = {"status": "local-fallback", "model": None, "highlights": fallback, "error": str(exc)}
        try:
            (Path(job_dir) / "ai-highlights.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            with ANNOTATION_LOCK:
                _sync_ai_annotations(Path(job_dir), result)
        except OSError:
            pass
        self._send_json({"result": result})

    def _create_job(self) -> None:
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        if content_length <= 0:
            self._send_error_json("上传内容为空。")
            return
        if content_length > MAX_UPLOAD_BYTES + 1024 * 1024:
            self._send_error_json(f"文件过大，当前上限为 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB。", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._send_error_json("请使用 multipart/form-data 上传字段 file。")
            return
        incoming_dir: Optional[Path] = None
        try:
            # The request is spooled to disk and the PDF copied out of it in
            # bounded reads, so an upload never sits in process memory: the
            # peak is one 1 MB chunk instead of the whole body.
            incoming_dir = STORE.new_incoming_directory()
            body_path = incoming_dir / "request.body"
            if _spool_request_body(self.rfile, content_length, body_path) < content_length:
                # The client went away mid-upload; never import a cut-off PDF.
                self.close_connection = True
                raise PipelineError("上传未完成：连接在传输途中断开。")
            with _spooled_body(body_path) as body:
                form = _multipart_parts(body, content_type)
                item = next((part for part in form.get("file", []) if part.filename), None)
                if item is None:
                    raise PipelineError("没有找到名为 file 的 PDF 文件字段。")
                filename = os.path.basename(str(item.filename))
                if not filename.lower().endswith(".pdf"):
                    raise PipelineError("当前版本只接受 .pdf 文件。")
                folder_values = form.get("folder_id", [])
                folder_id = folder_values[0].read(body).decode("utf-8", "replace").strip() if folder_values else ""
                if folder_id:
                    LIBRARY.validate_user_folder(folder_id)
                staged_path = incoming_dir / "upload.pdf.part"
                digest = hashlib.sha256()
                size = 0
                with staged_path.open("wb") as handle:
                    for chunk in item.iter_chunks(body):
                        size += len(chunk)
                        if size > MAX_UPLOAD_BYTES:
                            raise PipelineError(f"文件过大，当前上限为 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB。")
                        digest.update(chunk)
                        handle.write(chunk)
                    if size <= 0:
                        raise PipelineError("上传的 PDF 文件为空。")
                    handle.flush()
                    os.fsync(handle.fileno())
            # Closed above; Windows cannot delete a file that is still open.
            body_path.unlink()
            record, deduplicated = STORE.commit_staged_upload(
                incoming_dir,
                filename,
                size,
                digest.hexdigest(),
                folder_id,
            )
            incoming_dir = None
        # KeyError/TypeError/ValueError (incl. LibraryValidationError) cover
        # form and folder validation, which used to run before staging.
        except (KeyError, OSError, PipelineError, TypeError, ValueError) as exc:
            if incoming_dir is not None:
                shutil.rmtree(incoming_dir, ignore_errors=True)
            self._send_error_json(str(exc))
            return

        warnings: List[str] = []
        library_ready = False
        try:
            LIBRARY.sync_jobs([record])
            LIBRARY.restore_item(str(record["job_id"]))
            warnings.extend(_apply_requested_folders(record))
            library_ready = True
        except Exception as exc:
            warnings.append(f"文献已接收，文献库索引将在后台恢复：{exc}")
            print(f"[library] 导入 {record['job_id']} 后索引写入失败：{exc}", flush=True)
        record = STORE.get(str(record["job_id"])) or record
        settings = _metadata_settings()
        if record.get("status") == "queued":
            CONVERSION_QUEUE.put((str(record["job_id"]), str(record.get("source_filename") or filename)))
        if library_ready and record.get("status") != "completed" and _setting_bool(settings.get("auto_retrieve", True), True):
            _enqueue_metadata(
                str(record["job_id"]),
                _setting_bool(settings.get("online_lookup", True), True),
                "quick",
            )
        status = HTTPStatus.OK if deduplicated and record.get("status") == "completed" else HTTPStatus.ACCEPTED
        self._send_json({"job": _public_job(record), "deduplicated": deduplicated, "warning": "；".join(warnings)}, status)

    def _send_provider_error(self, error: ProviderError) -> None:
        self._send_error_json(
            str(error),
            int(error.http_status),
            code=error.code,
            details=error.details,
        )

    def _start_provider_install(self, provider_id: str) -> None:
        global PARSING_INSTALL_CANCEL_EVENT, PARSING_INSTALL_THREAD
        try:
            with PARSING_PROVIDER_LOCK:
                provider = _parsing_provider_registry().get(provider_id)
                capability = provider.capability()
                if capability.get("ready") and not capability.get("update_available"):
                    self._send_json({"provider": capability})
                    return
                if any(
                    isinstance(record.get("reflow"), dict)
                    and record["reflow"].get("status") in {"queued", "running", "cancelling"}
                    for record in (STORE.list() if STORE is not None else [])
                ):
                    raise ProviderError("AI 重排正在使用版面引擎，暂不能安装或更新。", code="busy")
                if not capability.get("can_install"):
                    raise _provider_failure(capability)
                if PARSING_INSTALL_THREAD is not None and PARSING_INSTALL_THREAD.is_alive():
                    raise ProviderError("版面引擎安装正在进行中。", code="busy")
                cancel_event = threading.Event()
                thread = threading.Thread(
                    target=_run_provider_install,
                    args=(provider_id, cancel_event),
                    name="my-scholar-component-install",
                    daemon=True,
                )
                PARSING_INSTALL_CANCEL_EVENT = cancel_event
                PARSING_INSTALL_THREAD = thread
                thread.start()
            self._send_json({
                "provider": {
                    **capability,
                    "state": "installing",
                    "reason_code": "installing",
                    "stage": "正在启动安装",
                    "progress": 0.0,
                }
            }, HTTPStatus.ACCEPTED)
        except ProviderError as exc:
            self._send_provider_error(exc)

    def _discover_provider_external(self, provider_id: str) -> None:
        try:
            with PARSING_PROVIDER_LOCK:
                _ensure_provider_configuration_idle("扫描本机")
                result = _parsing_provider_registry().get(provider_id).discover_external()
            self._send_json(result)
        except ProviderError as exc:
            self._send_provider_error(exc)

    def _select_provider_external(self, provider_id: str) -> None:
        try:
            payload = self._read_json_body(max_bytes=16 * 1024)
            source_text = str(payload.get("path") or "").strip()
            if not source_text:
                raise ProviderError("请选择已有版面引擎目录。", code="invalid_external_component")
            with PARSING_PROVIDER_LOCK:
                _ensure_provider_configuration_idle("选择已有版面引擎")
                provider = _parsing_provider_registry().get(provider_id)
                capability = provider.capability()
                if not capability.get("can_import"):
                    raise _provider_failure(capability)
                result = provider.select_external(Path(source_text).expanduser())
            self._send_json({"provider": result})
        except (ProviderError, PipelineError) as exc:
            if isinstance(exc, ProviderError):
                self._send_provider_error(exc)
            else:
                self._send_error_json(str(exc), HTTPStatus.BAD_REQUEST, code="invalid_external_component")

    def _start_provider_import(self, provider_id: str) -> None:
        global PARSING_INSTALL_THREAD
        try:
            payload = self._read_json_body(max_bytes=16 * 1024)
            source_text = str(payload.get("path") or "").strip()
            if not source_text:
                raise ProviderError("请选择已有版面引擎目录。", code="invalid_local_component")
            source = Path(source_text).expanduser()
            with PARSING_PROVIDER_LOCK:
                provider = _parsing_provider_registry().get(provider_id)
                capability = provider.capability()
                if capability.get("ready") and not capability.get("update_available"):
                    self._send_json({"provider": capability})
                    return
                if any(
                    isinstance(record.get("reflow"), dict)
                    and record["reflow"].get("status") in {"queued", "running", "cancelling"}
                    for record in (STORE.list() if STORE is not None else [])
                ):
                    raise ProviderError("AI 重排正在使用版面引擎，暂不能导入。", code="busy")
                if not capability.get("can_import"):
                    raise _provider_failure(capability)
                if PARSING_INSTALL_THREAD is not None and PARSING_INSTALL_THREAD.is_alive():
                    raise ProviderError("版面引擎安装或导入正在进行中。", code="busy")
                thread = threading.Thread(
                    target=_run_provider_import,
                    args=(provider_id, source),
                    name="my-scholar-component-import",
                    daemon=True,
                )
                PARSING_INSTALL_THREAD = thread
                thread.start()
            self._send_json({
                "provider": {
                    **capability,
                    "state": "importing",
                    "reason_code": "importing",
                    "stage": "正在导入已有版面引擎",
                    "progress": 0.0,
                }
            }, HTTPStatus.ACCEPTED)
        except (ProviderError, PipelineError) as exc:
            if isinstance(exc, ProviderError):
                self._send_provider_error(exc)
            else:
                self._send_error_json(str(exc), HTTPStatus.BAD_REQUEST, code="invalid_local_component")

    def _cancel_provider_install(self, provider_id: str) -> None:
        try:
            provider = _parsing_provider_registry().get(provider_id)
            with PARSING_PROVIDER_LOCK:
                install_running = PARSING_INSTALL_THREAD is not None and PARSING_INSTALL_THREAD.is_alive()
                if install_running and PARSING_INSTALL_CANCEL_EVENT is not None:
                    PARSING_INSTALL_CANCEL_EVENT.set()
            if not provider.cancel_install() and not install_running:
                raise ProviderError("当前没有正在进行的版面引擎安装。", code="install_conflict")
            self._send_json({"provider": provider.status()}, HTTPStatus.ACCEPTED)
        except ProviderError as exc:
            self._send_provider_error(exc)

    def _remove_provider_component(self, provider_id: str) -> None:
        try:
            with PARSING_PROVIDER_LOCK:
                active = [
                    record
                    for record in STORE.list()
                    if isinstance(record.get("reflow"), dict)
                    and record["reflow"].get("status") in {"queued", "running", "cancelling"}
                ]
                if active:
                    self._send_error_json(
                        "AI 重排正在使用版面引擎，暂不能删除。",
                        HTTPStatus.CONFLICT,
                        code="provider_busy",
                    )
                    return
                provider = _parsing_provider_registry().get(provider_id)
                result = provider.remove()
            self._send_json({"provider": result})
        except ProviderError as exc:
            self._send_provider_error(exc)

    @_locked_job_method
    def _start_reflow(self, job_id: str) -> None:
        if runtime.READONLY_MODE:
            self._send_error_json("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)
            return
        current_record = STORE.get(job_id)
        if current_record is None:
            self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            return
        if current_record.get("status") != "completed":
            self._send_error_json("只有已完成转换的文献可以重新排版。", HTTPStatus.CONFLICT)
            return
        try:
            with PARSING_PROVIDER_LOCK:
                if PARSING_INSTALL_THREAD is not None and PARSING_INSTALL_THREAD.is_alive():
                    raise ProviderError("版面引擎正在安装或更新，请完成后再开始 AI 重排。", code="busy")
                capability = _active_parsing_provider().capability()
                if not capability.get("ready"):
                    raise _provider_failure(capability)
                record = STORE.begin_reflow(job_id)
        except ProviderError as exc:
            self._send_provider_error(exc)
            return
        except KeyError:
            self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            return
        except ReflowConflictError as exc:
            self._send_error_json(str(exc), HTTPStatus.CONFLICT)
            return
        reflow = record.get("reflow") if isinstance(record.get("reflow"), dict) else {}
        generation = int(reflow.get("generation") or 0)
        REFLOW_QUEUE.put((str(record["job_id"]), str(record.get("source_filename") or "document.pdf"), generation))
        current = STORE.get(str(record["job_id"])) or record
        self._send_json(_public_job(current), HTTPStatus.ACCEPTED)

    @_locked_job_method
    def _cancel_reflow(self, job_id: str) -> None:
        if runtime.READONLY_MODE:
            self._send_error_json("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)
            return
        try:
            record = STORE.request_reflow_cancel(job_id)
        except KeyError:
            self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            return
        except ReflowConflictError as exc:
            self._send_error_json(str(exc), HTTPStatus.CONFLICT, code="reflow_not_active")
            return
        reflow = record.get("reflow") if isinstance(record.get("reflow"), dict) else {}
        generation = int(reflow.get("generation") or 0)
        if generation:
            _reflow_cancel_event(str(record["job_id"]), generation).set()
        current = STORE.get(str(record["job_id"])) or record
        self._send_json(_public_job(current), HTTPStatus.ACCEPTED)

    @_locked_job_method
    def _run_ai_review(self, job_id: str) -> None:
        record = STORE.get(job_id)
        if not record:
            self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
            return
        if record.get("status") != "completed":
            self._send_error_json("任务尚未完成，暂不能进行 AI 表格复核。", HTTPStatus.CONFLICT)
            return
        try:
            result = review_tables(Path(record["job_dir"]))
            current = STORE.get(job_id)
            if not current:
                self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                return
            manifest_path = Path(current["job_dir"]) / "manifest.json"
            if manifest_path.is_file():
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest["ai"] = {"status": result.get("status"), "model": result.get("model"), "reviewed_at": result.get("reviewed_at")}
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                STORE.update(job_id, manifest=manifest)
            self._send_json({"result": result})
        except Exception as exc:
            self._send_error_json(f"AI 复核失败：{exc}", HTTPStatus.BAD_GATEWAY)


# Public response shaping and command-line startup.
def _public_job(record: Dict[str, Any]) -> Dict[str, Any]:
    output = {key: value for key, value in record.items() if key not in {"job_dir", "source_sha256"}}
    active_render = record.get("active_render")
    render_name = str(active_render or "")
    render_prefix = f"renders/{render_name}/" if RENDER_GENERATION_RE.fullmatch(render_name) else ""
    if record.get("status") == "completed":
        job_id = record["job_id"]
        output["links"] = {
            "html": f"/api/jobs/{job_id}/{render_prefix}document.html",
            "json": f"/api/jobs/{job_id}/{render_prefix}document.json?download=1",
            "validation": f"/api/jobs/{job_id}/{render_prefix}validation.json",
            "source": f"/api/jobs/{job_id}/source.pdf",
            "translations": f"/api/jobs/{job_id}/translations",
            "content": f"/api/jobs/{job_id}/content/manifest.json",
            "metadata": f"/api/library/items/{job_id}/metadata",
        }
    reflow = record.get("reflow")
    if isinstance(reflow, dict):
        public_reflow = dict(reflow)
        public_reflow["document_url"] = output.get("links", {}).get("html") if reflow.get("status") == "completed" else None
        output["reflow"] = public_reflow
    return output


def _loopback_host_matches(authority: str, expected_port: int) -> bool:
    value = str(authority or "").strip()
    if not value or "," in value:
        return False
    try:
        parsed = urlsplit("//" + value)
        port = parsed.port
    except ValueError:
        return False
    return (
        str(parsed.hostname or "").lower() in LOOPBACK_HOSTS
        and not parsed.username
        and not parsed.password
        and not parsed.path
        and port == expected_port
    )


def _loopback_origin_matches(origin: str, expected_port: int) -> bool:
    value = str(origin or "").strip()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "http"
        and str(parsed.hostname or "").lower() in LOOPBACK_HOSTS
        and not parsed.username
        and not parsed.password
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
        and port == expected_port
    )


def _request_security_failure(handler: Any) -> Optional[tuple[str, int]]:
    headers = getattr(handler, "headers", None)
    server = getattr(handler, "server", None)
    # Direct method-level unit tests construct handlers without a socket. Real
    # BaseHTTPRequestHandler requests always provide both attributes.
    if headers is None or server is None:
        return None
    bearer = str(headers.get("Authorization") or "")
    bridge_token = str(headers.get("X-My-Scholar-MCP-Token") or "")
    if bearer.lower().startswith("bearer "):
        bridge_token = bearer[7:].strip()
    bridge_request = bool(bridge_token)
    if bridge_request:
        access = _mcp_access()
        if not access.authenticate(bridge_token):
            return "MCP 访问凭据无效或已停用。", HTTPStatus.UNAUTHORIZED
        path = unquote(urlsplit(handler.path).path)
        if (getattr(handler, "command", "GET"), path) not in {("GET", "/api/capabilities"), ("POST", "/api/capabilities/call")}:
            return "MCP 凭据只能访问能力入口。", HTTPStatus.FORBIDDEN
        handler._capability_scopes = access.status()["scopes"]
    elif runtime.API_ACCESS_TOKEN:
        provided = str(headers.get("X-My-Scholar-Api-Token") or "")
        if not hmac.compare_digest(provided, runtime.API_ACCESS_TOKEN):
            return "本地服务访问凭据无效。", HTTPStatus.UNAUTHORIZED
    try:
        bound_host = str(server.server_address[0]).lower()
        expected_port = int(server.server_address[1])
    except (AttributeError, IndexError, TypeError, ValueError):
        return "本地服务无法确认请求来源。", HTTPStatus.FORBIDDEN
    if bound_host not in LOOPBACK_HOSTS:
        return ("MCP 仅允许localhost连接。", HTTPStatus.FORBIDDEN) if bridge_request else None
    if not _loopback_host_matches(str(headers.get("Host") or ""), expected_port):
        return "请求主机无效。", HTTPStatus.FORBIDDEN
    origin = str(headers.get("Origin") or "").strip()
    static_path = unquote(urlsplit(getattr(handler, "path", "")).path)
    plugin_static = static_path == "/plugin-sdk.js" or re.fullmatch(r"/plugins/[a-zA-Z0-9._-]+/.+", static_path) is not None
    if origin and not (origin == "null" and plugin_static) and not _loopback_origin_matches(origin, expected_port):
        return "请求来源无效。", HTTPStatus.FORBIDDEN
    return None


def _install_request_security_guard(handler: type) -> None:
    for name in ("do_GET", "do_POST", "do_PUT", "do_PATCH", "do_DELETE"):
        original = getattr(handler, name, None)
        if original is None:
            continue

        def guarded(self: Any, _original: Any = original) -> None:
            failure = _request_security_failure(self)
            if failure:
                self._send_error_json(*failure)
                return
            _original(self)

        setattr(handler, name, guarded)


def _install_migration_request_guard(handler: type) -> None:
    control_paths = {"/api/migration/prepare", "/api/migration/cancel"}
    for name in ("do_GET", "do_POST", "do_PUT", "do_PATCH", "do_DELETE"):
        original = getattr(handler, name, None)
        if original is None:
            continue
        mutation = name != "do_GET"

        def guarded(self: Any, _original: Any = original, _mutation: bool = mutation) -> None:
            path = unquote(urlsplit(self.path).path)
            if path in control_paths:
                _original(self)
                return
            if not _migration_request_enter(mutation=_mutation):
                message = "语义标记同步尚待恢复，已暂停写入。请重启服务以恢复备份。" if ANNOTATION_STYLE_RECOVERY_REQUIRED else "文献库正在安全切换，请稍候。"
                self._send_error_json(message, HTTPStatus.SERVICE_UNAVAILABLE)
                return
            try:
                _original(self)
            finally:
                _migration_request_leave(mutation=_mutation)

        setattr(handler, name, guarded)


def _install_readonly_guard(handler: type) -> None:
    """Reject every mutating verb when the deployment is read-only.

    Guarding the dispatch table rather than each handler means a future
    do_<VERB> cannot ship without the check.
    """
    def refuse(self: Any) -> None:
        self._send_error_json("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)

    for name in dir(handler):
        if name.startswith("do_") and name not in {"do_GET", "do_HEAD"}:
            setattr(handler, name, refuse)


_install_migration_request_guard(ScholarHandler)

if runtime.READONLY_MODE:
    _install_readonly_guard(ScholarHandler)

_install_request_security_guard(ScholarHandler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the My Scholar local PDF reader MVP")
    parser.add_argument("--host", default=os.environ.get("MY_SCHOLAR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MY_SCHOLAR_PORT", "8765")))
    parser.add_argument("--pdf-evidence-input", help=argparse.SUPPRESS)
    parser.add_argument("--pdf-evidence-output", help=argparse.SUPPRESS)
    parser.add_argument("--pdf-evidence-drawing-pages", default="", help=argparse.SUPPRESS)
    parser.add_argument("--dependency-smoke", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.dependency_smoke:
        import sqlite3
        import ssl
        import urllib.request
        from pymupdf_runtime import verify_pdf_glyph_extraction

        connection = sqlite3.connect(":memory:")
        try:
            connection.execute("CREATE VIRTUAL TABLE fts_probe USING fts5(text, tokenize='unicode61')")
            connection.execute("INSERT INTO fts_probe VALUES('search 测 试')")
            if connection.execute("SELECT count(*) FROM fts_probe WHERE fts_probe MATCH ?", ('"测 试"',)).fetchone()[0] != 1:
                raise RuntimeError("SQLite FTS5 tokenizer probe failed")
        finally:
            connection.close()
        ssl.create_default_context()
        urllib.request.Request("https://example.invalid/")
        pdf_glyph_extraction = verify_pdf_glyph_extraction()
        print(json.dumps({
            "ok": True,
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "arch": platform.machine(),
            "hashlib_scrypt": hasattr(hashlib, "scrypt"),
            "pdf_glyph_extraction": pdf_glyph_extraction,
            "providers": _parsing_provider_registry().list_capabilities(),
        }, ensure_ascii=False))
        return
    if args.pdf_evidence_input or args.pdf_evidence_output:
        if not (args.pdf_evidence_input and args.pdf_evidence_output):
            parser.error("PDF evidence worker requires both input and output paths")
        drawing_pages = []
        if args.pdf_evidence_drawing_pages:
            try:
                drawing_pages = sorted({
                    page
                    for raw in args.pdf_evidence_drawing_pages.split(",")
                    if 0 < (page := int(raw)) <= 512
                })
            except ValueError:
                parser.error("PDF evidence drawing pages must be positive integers")
        from document_ir import write_pdf_evidence
        try:
            write_pdf_evidence(
                Path(args.pdf_evidence_input),
                Path(args.pdf_evidence_output),
                drawing_pages=drawing_pages,
            )
        except Exception as exc:
            raise SystemExit(f"PDF evidence worker failed: {exc}") from exc
        return
    root_locks = [DataRootLock(root) for root in _runtime_lock_roots()]
    try:
        for root_lock in root_locks:
            root_lock.acquire()
        _initialize_runtime_stores()
        _start_background_workers()
        httpd = ThreadingHTTPServer((args.host, args.port), ScholarHandler)
        shutdown_started = threading.Event()

        def request_shutdown(_signum: int, _frame: Any) -> None:
            if shutdown_started.is_set():
                return
            shutdown_started.set()
            threading.Thread(target=httpd.shutdown, name="my-scholar-shutdown", daemon=True).start()

        previous_handlers = {}
        for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[shutdown_signal] = signal.getsignal(shutdown_signal)
            signal.signal(shutdown_signal, request_shutdown)
        actual_port = int(httpd.server_address[1])
        if args.host in LOOPBACK_HOSTS:
            authority = f"[{args.host}]" if ":" in args.host else args.host
            _mcp_access().bind(f"http://{authority}:{actual_port}")
        else:
            _mcp_access().close()
        print(f"My Scholar running at http://{args.host}:{actual_port}", flush=True)
        print(f"State directory: {DATA_ROOT}", flush=True)
        print(f"Library directory: {LIBRARY_ROOT}", flush=True)
        print(f"Workers: conversion={CONVERSION_WORKERS}, metadata={METADATA_WORKERS}", flush=True)
        advice = mineru_worker_advice()
        if advice:
            print(advice, flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping My Scholar", flush=True)
        finally:
            _mcp_access().close()
            if SCHOLAR_SERVICE is not None:
                SCHOLAR_SERVICE.search_index.close()
            httpd.server_close()
            if PARSING_PROVIDERS is not None:
                PARSING_PROVIDERS.get("remote-guzi").connection.close()
            for shutdown_signal, handler in previous_handlers.items():
                signal.signal(shutdown_signal, handler)
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        for root_lock in reversed(root_locks):
            root_lock.release()


if __name__ == "__main__":
    main()
