#!/usr/bin/env python3
"""Compose the local My Scholar service and its HTTP API.

The module owns the process-level job queues, serves the static web client,
coordinates conversion and metadata workers, and persists per-document reader
state. Conversion, library metadata, bibliography lookup, and AI calls remain
behind their dedicated modules; :func:`main` is the stable CLI entrypoint.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from functools import wraps
import email.parser
import errno
import hashlib
import hmac
import html
import io
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
import unicodedata
import urllib.error
import urllib.request
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import unquote, urlsplit

try:
    import fcntl
except ImportError:  # Windows has no fcntl; msvcrt provides the equivalent.
    fcntl = None
try:
    import msvcrt
except ImportError:  # pragma: no cover - present only on Windows
    msvcrt = None

from ai import auto_highlights, chat as ai_chat, chat_stream as ai_chat_stream, is_metadata_block, list_models as ai_list_models, reference_quick_read, review_tables, services as ai_services, status as ai_status, test_connections as ai_test_connections, translate_text, translate_text_stream, translation_profile_id
from bibliography import is_fragmented_metadata_text, retrieve_bibliographic_metadata, retrieve_reference_evidence
from config import AI_TRANSLATION_MODES, DEFAULT_TRANSLATION_MODE
from library_store import LibraryStore, LibraryValidationError
from layout_pipeline import MathRenderer, normalize_mineru_backend
from parsing_providers import ProviderError, ParsingRequest, create_default_registry
from pipeline import PipelineError, process_pdf, utc_now


PROJECT_ROOT = Path(os.environ.get("MY_SCHOLAR_PROJECT_ROOT", str(Path(__file__).resolve().parent))).expanduser().resolve()
WEB_ROOT = PROJECT_ROOT / "web"
DATA_ROOT = Path(os.environ.get("MY_SCHOLAR_DATA_DIR", str(PROJECT_ROOT / "data"))).expanduser().resolve()
LIBRARY_ROOT = Path(os.environ.get("MY_SCHOLAR_LIBRARY_DIR", str(DATA_ROOT))).expanduser().resolve()
COMPONENTS_ROOT = Path(os.environ.get("MY_SCHOLAR_COMPONENTS_DIR", str(DATA_ROOT / "components"))).expanduser().resolve()
JOBS_ROOT = LIBRARY_ROOT / "jobs"
PERMANENT_DELETE_JOURNAL_NAME = ".permanent-delete-journal.json"
MAX_UPLOAD_BYTES = int(os.environ.get("MY_SCHOLAR_MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
MAX_NOTE_ASSET_BYTES = 5 * 1024 * 1024
MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
MAX_MEDIA_LAYOUT_BYTES = 512 * 1024
MAX_MEDIA_LAYOUT_ITEMS = 2048
JOB_ID_RE = re.compile(r"^[a-f0-9]{12,40}$")
RENDER_GENERATION_RE = re.compile(r"^[1-9][0-9]{0,8}$")
NOTE_ASSET_PATH_RE = re.compile(r"^content/notes/assets/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$")
MEDIA_LAYOUT_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
SETTINGS_PATH = DATA_ROOT / "settings.json"
AI_STATUS_HISTORY_PATH = DATA_ROOT / "ai-status-history.json"
AI_STATUS_HISTORY_LIMIT = 100
TRANSLATION_LOCK = threading.RLock()
MATH_RENDERER = MathRenderer()
MATH_RENDERER_LOCK = threading.Lock()
ANNOTATION_LOCK = threading.RLock()
MEDIA_LAYOUT_LOCK = threading.RLock()
SETTINGS_LOCK = threading.RLock()
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
METADATA_STATE_LOCK = threading.RLock()
METADATA_PENDING: set[tuple[str, str, int]] = set()
METADATA_GENERATIONS: Dict[str, int] = {}
METADATA_JOB_LOCKS: Dict[str, threading.RLock] = {}
JOB_MUTATION_LOCKS: Dict[str, threading.RLock] = {}
ACCOUNT_SERVICE_URL = os.environ.get("MY_SCHOLAR_ACCOUNT_URL", "").strip().rstrip("/")
ALLOW_INSECURE_LOOPBACK_ACCOUNT = str(
    os.environ.get("MY_SCHOLAR_ALLOW_INSECURE_LOOPBACK_ACCOUNT", "")
).strip().lower() in {"1", "true", "yes", "on"}
ACCOUNT_FILE = DATA_ROOT / "account.json"
ACCOUNT_LOCK = threading.RLock()
READONLY_MODE = str(os.environ.get("MY_SCHOLAR_READONLY", "")).strip().lower() in {"1", "true", "yes", "on"}
LANDING_FILE = Path(os.environ.get("MY_SCHOLAR_LANDING_FILE", "")).expanduser() if os.environ.get("MY_SCHOLAR_LANDING_FILE") else None
# Open-source builds use the user's own AI credentials and do not require an
# account or a hosted membership entitlement. The legacy gate can still be
# enabled explicitly for private deployments with MY_SCHOLAR_AI_REQUIRE_MEMBER=1.
AI_REQUIRES_MEMBER = str(os.environ.get("MY_SCHOLAR_AI_REQUIRE_MEMBER", "0")).strip().lower() not in {"", "0", "false", "no", "off"}
_USAGE_CACHE: Dict[str, Any] = {"at": None, "bytes": 0}
MIGRATION_CONTROL_TOKEN = os.environ.get("MY_SCHOLAR_MIGRATION_TOKEN", "").strip()
MIGRATION_REQUEST_CONDITION = threading.Condition(threading.RLock())
MIGRATION_QUIESCING = False
MIGRATION_ACTIVE_REQUESTS = 0
MIGRATION_ACTIVE_MUTATIONS = 0
API_ACCESS_TOKEN = os.environ.get("MY_SCHOLAR_API_TOKEN", "").strip()
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


class AccountServiceUnavailable(PipelineError):
    """The account endpoint is unavailable or violates transport policy."""


class ReflowConflictError(PipelineError):
    """The requested document cannot start another reflow generation."""


class ReflowCancelledError(PipelineError):
    """The active reflow was cancelled before its render was published."""


def _job_mutation_lock(job_id: str) -> threading.RLock:
    canonical_id = str(job_id or "").strip()
    with METADATA_STATE_LOCK:
        return JOB_MUTATION_LOCKS.setdefault(canonical_id, threading.RLock())


@contextmanager
def _job_mutation(job_id: str):
    """Serialize destructive and document-owned artifact writes per job."""
    lock = _job_mutation_lock(job_id)
    with lock:
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


class DataRootLock:
    """Hold one writer process per state or library directory."""

    def __init__(self, data_root: Path) -> None:
        self.path = Path(data_root) / ".my-scholar.lock"
        self.handle: Optional[Any] = None

    # Windows locks a byte range rather than the whole file, so the guard byte
    # sits past any owner text the lock file holds.
    WINDOWS_LOCK_OFFSET = 4096

    def _lock_handle(self, handle: Any) -> None:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        if msvcrt is not None:
            handle.seek(self.WINDOWS_LOCK_OFFSET)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return
        raise RuntimeError("当前平台不支持 My Scholar 数据目录锁。")

    def _unlock_handle(self, handle: Any) -> None:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        elif msvcrt is not None:
            handle.seek(self.WINDOWS_LOCK_OFFSET)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

    def acquire(self) -> None:
        if fcntl is None and msvcrt is None:
            raise RuntimeError("当前平台不支持 My Scholar 数据目录锁。")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+", encoding="utf-8")
        try:
            self._lock_handle(handle)
        except OSError as exc:
            handle.seek(0)
            owner = handle.read().strip()
            handle.close()
            # Windows reports a busy range as EACCES/EDEADLOCK depending on the
            # runtime; both mean another instance owns the library.
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                detail = f"（进程 {owner}）" if owner else ""
                raise RuntimeError(f"这个文献库已由另一个 My Scholar 实例打开{detail}。") from exc
            raise
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
        os.fsync(handle.fileno())
        self.handle = handle

    def release(self) -> None:
        if not self.handle:
            return
        try:
            self._unlock_handle(self.handle)
        finally:
            self.handle.close()
            self.handle = None


def _runtime_lock_roots(data_root: Path = DATA_ROOT, library_root: Path = LIBRARY_ROOT) -> List[Path]:
    roots = {Path(data_root).expanduser().resolve(), Path(library_root).expanduser().resolve()}
    return sorted(roots, key=lambda root: os.fsencode(str(root)))


class _MultipartFile:
    """One multipart field, mirroring the slice of the removed
    ``cgi.FieldStorage`` interface this server uses."""

    def __init__(self, filename: str, data: bytes) -> None:
        self.filename = filename
        self.data = data
        self.file = io.BytesIO(data)


def _decode_multipart_text(value: str) -> str:
    """Restore UTF-8 header text from the latin-1 parsing round-trip.

    Browsers send multipart filenames as raw UTF-8 bytes; the removed ``cgi``
    module decoded them as UTF-8 and this keeps that behavior.
    """
    try:
        return value.encode("latin-1").decode("utf-8")
    except UnicodeError:
        return value


def _disposition_param(disposition: str, name: str) -> str:
    """Read one Content-Disposition parameter from an already-decoded header.

    ``Message.get_param`` replaces surrogateescape bytes with U+FFFD before we
    can restore them, so the parameter is taken from the raw header instead.
    """
    quoted = re.search(rf'(?<![\w-]){name}\s*=\s*"((?:[^"\\]|\\.)*)"', disposition, re.IGNORECASE)
    if quoted:
        return re.sub(r"\\(.)", r"\1", quoted.group(1))
    plain = re.search(rf"(?<![\w-]){name}\s*=\s*([^;\r\n]+)", disposition, re.IGNORECASE)
    return plain.group(1).strip() if plain else ""


def _parse_multipart_form(rfile: Any, content_type: str, content_length: int) -> Dict[str, List[_MultipartFile]]:
    """Parse multipart/form-data with the stdlib email parser.

    ``cgi`` was removed in Python 3.13. The body is decoded as latin-1 so
    every byte maps to one code point: headers stay plain ``str`` (compat32
    wraps surrogateescape headers in lossy ``Header`` objects), and
    ``get_payload(decode=True)`` restores binary payloads byte-exactly via
    its raw-unicode-escape fallback.
    """
    body = rfile.read(content_length)
    message = email.parser.Parser().parsestr(
        "Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n" + body.decode("latin-1")
    )
    if not message.is_multipart():
        raise PipelineError("请使用 multipart/form-data 上传字段 file。")
    fields: Dict[str, List[_MultipartFile]] = {}
    for part in message.get_payload():
        disposition = _decode_multipart_text(str(part.get("Content-Disposition", "")))
        field_name = _disposition_param(disposition, "name")
        if not field_name:
            continue
        payload = part.get_payload(decode=True)
        fields.setdefault(field_name, []).append(
            _MultipartFile(_disposition_param(disposition, "filename"), payload if isinstance(payload, bytes) else b"")
        )
    return fields


# Per-document content, settings and compatibility migrations.
def _read_json_file(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else default
    except (OSError, json.JSONDecodeError):
        return default


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


def _read_account_state() -> Dict[str, Any]:
    with ACCOUNT_LOCK:
        data = _read_json_file(ACCOUNT_FILE, {})
    return data if isinstance(data, dict) else {}


def _account_service_configuration(url: Optional[str] = None) -> Dict[str, Any]:
    candidate = str(ACCOUNT_SERVICE_URL if url is None else url).strip().rstrip("/")
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
        if ALLOW_INSECURE_LOOPBACK_ACCOUNT:
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
        ACCOUNT_SERVICE_URL + path,
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
        raise PipelineError(detail or f"账号服务错误（HTTP {exc.code}）。")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AccountServiceUnavailable("无法安全连接账号服务器，请检查网络或 HTTPS 服务配置。") from exc
    return data if isinstance(data, dict) else {}


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
    if not AI_REQUIRES_MEMBER:
        return services
    summary = _account_summary()
    if summary["member"]:
        return services
    note = "AI 功能需要有效的免费内测资格。" if summary["logged_in"] else "AI 功能需要先登录内测账号。"
    gated = {}
    for name, service in services.items():
        gated[name] = {**service, "enabled": False, "note": note} if isinstance(service, dict) else service
    return gated


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
    if READONLY_MODE:
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
    if READONLY_MODE:
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
    if READONLY_MODE:
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
    if READONLY_MODE:
        return
    _content_root(job_dir)
    _write_english_snapshot(job_dir)
    _write_content_manifest(job_dir)


def _sync_content_file(job_dir: Path, relative: str, payload: Any) -> None:
    if READONLY_MODE:
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
    if READONLY_MODE:
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


def _stored_settings() -> Dict[str, Any]:
    data = _read_json_file(SETTINGS_PATH, {})
    return data if isinstance(data, dict) else {}


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


def _ai_status_history() -> List[Dict[str, Any]]:
    payload = _read_json_file(AI_STATUS_HISTORY_PATH, {})
    records = payload.get("history") if isinstance(payload, dict) else []
    history = [_normalize_ai_status_record(record) for record in records] if isinstance(records, list) else []
    return [record for record in history if record is not None][:AI_STATUS_HISTORY_LIMIT]


def _record_ai_status(results: Dict[str, Any]) -> Dict[str, Any]:
    record = _normalize_ai_status_record({"checkedAt": utc_now(), "results": results})
    if record is None:
        raise PipelineError("AI 服务检测结果无效。")
    if READONLY_MODE:
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


def _annotation_colors(value: Any, fallback: str) -> Dict[str, str]:
    """Remember the last colour picked for each annotation kind."""
    stored = value if isinstance(value, dict) else {}
    return {kind: _setting_color(stored.get(kind), fallback) for kind in ANNOTATION_COLOR_KINDS}


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


def _normalize_ai_profile(value: Any, current: Any = None, *, service: str = "chat") -> Dict[str, str]:
    """Validate one user-owned OpenAI-compatible profile.

    API keys are write-only from the UI: an empty key keeps the existing one,
    while ``clear_api_key`` explicitly removes it. This avoids echoing secrets
    through the settings endpoint while still allowing users to rotate them.
    """
    incoming = value if isinstance(value, dict) else {}
    existing = current if isinstance(current, dict) else {}
    result: Dict[str, str] = {
        "base_url": str(incoming.get("base_url", existing.get("base_url", "")) or "").strip().rstrip("/"),
        "model": str(incoming.get("model", existing.get("model", "")) or "").strip(),
        "api_key": str(existing.get("api_key", "") or "").strip(),
    }
    if service == "translation":
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


def _normalize_ai_settings(value: Any, current: Any = None) -> Dict[str, Dict[str, str]]:
    incoming = value if isinstance(value, dict) else {}
    existing = current if isinstance(current, dict) else {}
    return {
        service: _normalize_ai_profile(incoming.get(service), existing.get(service), service=service)
        for service in ("translation", "chat")
    }


def _public_ai_settings(value: Any) -> Dict[str, Dict[str, Any]]:
    profiles = _normalize_ai_settings(value)
    return {
        service: {
            "base_url": profile["base_url"],
            "model": profile["model"],
            "api_key_configured": bool(profile["api_key"]),
            **({"mode": profile["mode"]} if service == "translation" else {}),
        }
        for service, profile in profiles.items()
    }


def _persist_settings(data: Dict[str, Any]) -> None:
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


AI_PROFILE_NAMES = frozenset({"translation", "chat"})


def _copy_ai_profile(source: str, target: str) -> Dict[str, Any]:
    source_name = str(source or "").strip().lower()
    target_name = str(target or "").strip().lower()
    if source_name not in AI_PROFILE_NAMES or target_name not in AI_PROFILE_NAMES or source_name == target_name:
        raise PipelineError("AI 服务复用目标无效。")
    with SETTINGS_LOCK:
        current = _stored_settings()
        profiles = _normalize_ai_settings(current.get("ai"), current.get("ai"))
        source_profile = profiles[source_name]
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
        }
        if target_name == "translation":
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
    shortcut_defaults = {
        "open_library": "Cmd+1",
        "open_settings": "Cmd+,",
        "highlight": "Cmd+Shift+H",
        "underline": "Cmd+Shift+U",
        "highlight_note": "Cmd+Shift+J",
        "underline_note": "Cmd+Shift+K",
    }
    stored_shortcuts = data.get("shortcuts") if isinstance(data.get("shortcuts"), dict) else {}
    shortcuts = {**shortcut_defaults, **{key: str(value).strip()[:40] for key, value in stored_shortcuts.items() if key in shortcut_defaults and str(value).strip()}}
    return {
        "ai_services": ai_services(),
        "ai": _public_ai_settings(data.get("ai")),
        "ai_status_history": _ai_status_history(),
        "shortcuts": shortcuts,
        "highlight_color": _setting_color(data.get("highlight_color")),
        "annotation_colors": _annotation_colors(
            data.get("annotation_colors"), _setting_color(data.get("highlight_color"))
        ),
        "appearance": _appearance_settings(data.get("appearance")),
        "metadata": {
            "auto_retrieve": _setting_bool(data.get("metadata", {}).get("auto_retrieve", True), True) if isinstance(data.get("metadata"), dict) else True,
            "online_lookup": _setting_bool(data.get("metadata", {}).get("online_lookup", True), True) if isinstance(data.get("metadata"), dict) else True,
            "contact_email": str(data.get("metadata", {}).get("contact_email", "")) if isinstance(data.get("metadata"), dict) else "",
        },
        "parsing": {"backend": _parsing_backend(data.get("parsing"))},
    }


def _write_settings(data: Dict[str, Any]) -> Dict[str, Any]:
    if READONLY_MODE:
        raise PipelineError("只读演示模式，暂不支持修改。")
    forbidden = {"base_url", "model", "api_key", "server_preset", "translation", "chat"}
    blocked = sorted(forbidden.intersection(data))
    if blocked:
        raise PipelineError(f"AI 服务配置只能在项目私有配置文件中修改：{', '.join(blocked)}")
    with SETTINGS_LOCK:
        current = _stored_settings()
        for key in ("shortcuts", "metadata", "highlight_color", "annotation_colors", "appearance", "ai", "parsing"):
            if key in data:
                if key == "metadata" and isinstance(data[key], dict):
                    current[key] = {
                        "auto_retrieve": _setting_bool(data[key].get("auto_retrieve"), True),
                        "online_lookup": _setting_bool(data[key].get("online_lookup"), True),
                        "contact_email": str(data[key].get("contact_email") or "").strip()[:254],
                    }
                elif key == "parsing":
                    current["parsing"] = {"backend": _parsing_backend(data[key])}
                elif key == "annotation_colors":
                    current["annotation_colors"] = _annotation_colors(
                        data[key], _setting_color(current.get("highlight_color"))
                    )
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
        _persist_settings(current)
    return _public_settings()


def _job_context(job_dir: Path, limit: int = 14000) -> str:
    data = _read_json_file(_active_conversion_root(job_dir) / "document.json", {})
    chunks: List[str] = []
    if isinstance(data, dict) and isinstance(data.get("pages"), list):
        for page in data["pages"]:
            for item in page.get("elements", []) if isinstance(page, dict) else []:
                if not isinstance(item, dict):
                    continue
                text = str(item.get("text", "")).strip()
                if text:
                    chunks.append(f"[p{page.get('page')}/{item.get('block_id')}] {text}")
                if sum(len(x) for x in chunks) >= limit:
                    return "\n\n".join(chunks)[:limit]
    return "\n\n".join(chunks)[:limit]


def _highlight_signature(block_id: Any, quote: Any, category: Any) -> str:
    material = "\n".join((str(block_id or "").strip(), str(category or "method").strip(), str(quote or "").strip()))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


_LOCAL_HIGHLIGHT_MARKERS = {
    "research_goal": ("we present", "we propose", "this paper", "our goal", "we aim"),
    "method": ("pre-training", "pretraining", "pretrain", "encoder", "transformer", "fine-tun", "optimiz", "task"),
    "innovation": ("unified", "multiway", "novel", "first", "introduce", "stagewise", "general-purpose"),
    "conclusion": ("experimental results", "results demonstrate", "achieves", "outperforms", "state-of-the-art", "improves", "competitive performance"),
}


def _local_highlight_candidates(blocks: List[dict], limit: int = 8) -> List[Dict[str, Any]]:
    """Create conservative, verbatim highlights when the optional model is empty."""
    candidates: List[tuple[Dict[str, Any], Dict[str, int]]] = []
    for block in blocks:
        raw_text = str(block.get("text", "")).strip()
        text = re.sub(r"<[^>]+>", "", raw_text).strip()
        if len(text) < 120 or is_metadata_block(block, text) or any(marker in text for marker in ("MMLab", "Corresponding author")):
            continue
        quote = re.split(r"(?<=[.!?。！？])\s+", text)[0][:300].strip()
        lower = text.lower()
        scores = {category: sum(lower.count(marker) for marker in markers) for category, markers in _LOCAL_HIGHLIGHT_MARKERS.items()}
        candidates.append(({
            "block_id": block.get("block_id"),
            "quote": quote,
            "category": "method",
            "reason": "本地规则候选（未调用模型）",
        }, scores))
    if not candidates:
        return []

    selected: List[Dict[str, Any]] = []
    used_blocks: set[str] = set()
    category_order = ("research_goal", "method", "innovation", "conclusion")
    for category in category_order:
        ranked = sorted(
            candidates,
            key=lambda pair: (pair[1].get(category, 0), max(pair[1].values()), len(str(pair[0].get("quote", "")))),
            reverse=True,
        )
        chosen = next((pair for pair in ranked if str(pair[0].get("block_id")) not in used_blocks and pair[1].get(category, 0) > 0), None)
        if chosen is None:
            chosen = next((pair for pair in ranked if str(pair[0].get("block_id")) not in used_blocks), None)
        if chosen is None:
            continue
        item = dict(chosen[0])
        item["category"] = category
        selected.append(item)
        used_blocks.add(str(item.get("block_id")))

    remaining = sorted(candidates, key=lambda pair: (max(pair[1].values()), len(str(pair[0].get("quote", "")))), reverse=True)
    for candidate, _scores in remaining:
        if len(selected) >= limit:
            break
        block_id = str(candidate.get("block_id"))
        if block_id in used_blocks:
            continue
        selected.append(dict(candidate))
        used_blocks.add(block_id)
    return selected[:limit]


def _metadata_block_ids(job_dir: Path) -> set[str]:
    data = _read_json_file(_active_conversion_root(job_dir) / "document.json", {})
    identifiers: set[str] = set()
    for page in data.get("pages", []) if isinstance(data, dict) and isinstance(data.get("pages"), list) else []:
        for item in page.get("elements", []) if isinstance(page, dict) else []:
            if isinstance(item, dict) and item.get("translation_excluded") == "metadata" and item.get("block_id"):
                identifiers.add(str(item["block_id"]))
    return identifiers


def _clean_legacy_translation_cache(job_dir: Path) -> None:
    metadata_ids = _metadata_block_ids(job_dir)
    if not metadata_ids or not (job_dir / "translations.json").is_file():
        return
    records = _translation_records(job_dir)
    filtered = [item for item in records if str(item.get("block_id", "")) not in metadata_ids]
    if len(filtered) != len(records):
        _write_translation_records(job_dir, filtered)


_LEGACY_READER_STYLE_MARKER = "/* my-scholar:continuous-reader-migration-v6 */"
_LEGACY_READER_STYLE = r"""
/* my-scholar:continuous-reader-migration-v6 */
/* my-scholar:continuous-reader-migration-v5 (compatibility marker) */
/* my-scholar:continuous-reader-migration-v4 (compatibility marker) */
/* Existing jobs may have been rendered by the pre-continuous reader. Keep
   their ids and data-page anchors, but remove presentation-only page cards,
   navigation chrome, and internal audit disclosures from the reading surface. */
html, body { background: var(--paper, #fff) !important; }
:root { --accent: #d97706 !important; --accent-dark: #a65305 !important; --highlight-orange: #f59e0b !important; --user-highlight: #f59e0b !important; --muted: #756b60 !important; --line: #e7ded2 !important; --soft: #fbf6ed !important; }
a, .citation, .cross-reference { color: var(--accent, #d97706) !important; }
.block-selected { outline-color: var(--accent, #d97706) !important; }
.my-scholar-underline:not([data-user-color="true"]) { text-decoration-color: var(--highlight-orange, #f59e0b) !important; }
*, *::before, *::after { -webkit-user-select: none !important; user-select: none !important; }
input, textarea, [contenteditable="true"] { -webkit-user-select: text !important; user-select: text !important; }
.reader-shell { width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 24px 72px !important; background: var(--paper, #fff) !important; }
.reader-layout { display: block !important; }
.reader-nav { display: none !important; }
.reader-content { max-width: 1080px !important; margin: 0 auto !important; padding: 32px 0 48px !important; background: var(--paper, #fff) !important; font-family: var(--paper-font, "Times New Roman", Times, serif) !important; font-size: calc(18px * var(--reader-font-scale, 1)) !important; line-height: var(--reader-line-height, 1.72) !important; -webkit-user-select: text !important; user-select: text !important; }
.reader-content p, .reader-content li, .reader-content figcaption, .reader-content .translation-text { line-height: inherit !important; }
.reader-content, .reader-content * { -webkit-user-select: text !important; user-select: text !important; }
.reader-content button, .reader-content button *, .reader-content input, .reader-content textarea, .reader-content select, .reader-content summary, .reader-content .paragraph-translate-trigger, .reader-content .paragraph-translate-trigger *, .reader-content .annotation-note-trigger, .reader-content .annotation-note-trigger *, .reader-content .annotation-note-popover, .reader-content .annotation-note-popover * { -webkit-user-select: none !important; user-select: none !important; }
.reader-content .annotation-note-popover .annotation-note-editor[contenteditable="true"], .reader-content .annotation-note-popover .annotation-note-editor[contenteditable="true"] * { -webkit-user-select: text !important; user-select: text !important; }
.my-scholar-highlight[data-user-color="true"] { background: color-mix(in srgb, var(--user-highlight, #f59e0b) 32%, transparent) !important; box-shadow: inset 0 -.09em 0 color-mix(in srgb, var(--user-highlight, #f59e0b) 62%, transparent) !important; }
.my-scholar-underline[data-user-color="true"] { text-decoration-color: var(--user-highlight, #f59e0b) !important; }
.pdf-page { margin: 0 !important; padding: 0 clamp(30px, 5vw, 74px) !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; background: var(--paper, #fff) !important; }
.pdf-page + .pdf-page { padding-top: 0 !important; border-top: 0 !important; }
.page-label { position: absolute !important; width: 1px !important; height: 1px !important; margin: -1px !important; padding: 0 !important; overflow: hidden !important; clip: rect(0 0 0 0) !important; white-space: nowrap !important; border: 0 !important; }
.source-crop, .page-source, .table-structure, .table-review-badge { display: none !important; }
.pdf-figure, .pdf-table { background: transparent !important; }
.pdf-table { border: 0 !important; padding: 0 !important; }
.pdf-table .table-source-primary { padding: 0 0 8px !important; }
.pdf-table .table-source-primary img { width: auto !important; max-width: 100% !important; height: auto !important; }
.pdf-table.table-image-missing .table-source-missing { margin: 8px 0 !important; color: var(--muted, #6f7d8d) !important; }
.references { list-style: none !important; padding-left: 0 !important; }
.my-scholar-translation { border-left: 0 !important; padding-left: 0 !important; background: transparent !important; }
.translation-text .translation-math { display: inline-block; margin: 0 .08em; vertical-align: -.16em; }
.translation-math-fallback { display: inline-block; white-space: nowrap; }
@media (max-width: 760px) {
  .reader-shell { padding: 0 16px 48px !important; }
  .reader-content { padding-top: 22px !important; padding-bottom: 32px !important; }
  .pdf-page { padding-left: 16px !important; padding-right: 16px !important; }
}
@media (prefers-color-scheme: dark) {
  :root { --accent: #f3b34c !important; --accent-dark: #ffd07a !important; --highlight-orange: #f3b34c !important; --user-highlight: #f3b34c !important; --muted: #b9ad9d !important; --line: #493c2b !important; --soft: #241c12 !important; }
  a, .citation, .cross-reference { color: var(--accent, #f3b34c) !important; }
}
"""


_TABLE_FIGURE_RE = re.compile(
    r'(?P<open><figure\b[^>]*class=["\'][^"\']*\bpdf-table\b[^"\']*["\'][^>]*>)'
    r'(?P<body>.*?)'
    r'(?P<close></figure\s*>)',
    flags=re.IGNORECASE | re.DOTALL,
)


def _table_image_markup(fragment: str) -> str:
    """Extract an existing crop link without exposing legacy table markup."""
    linked = re.search(
        r'<a\b[^>]*class=["\'][^"\']*\basset-link\b[^"\']*["\'][^>]*>.*?<img\b[^>]*>.*?</a\s*>',
        fragment,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if linked:
        return linked.group(0)
    image = re.search(r'<img\b[^>]*>', fragment, flags=re.IGNORECASE)
    return image.group(0) if image else ""


def _add_class(tag: str, class_name: str) -> str:
    def replace(match: re.Match[str]) -> str:
        classes = match.group(2).split()
        if class_name not in classes:
            classes.append(class_name)
        return f"{match.group(1)}{' '.join(classes)}{match.group(3)}"

    return re.sub(
        r'(class=["\'])([^"\']*)(["\'])',
        replace,
        tag,
        count=1,
        flags=re.IGNORECASE,
    )


def _migrate_legacy_table_figures(document: str) -> str:
    """Promote old hidden table crops and remove semantic tables from HTML."""

    def replace(match: re.Match[str]) -> str:
        opening = match.group("open")
        body = match.group("body")
        primary = re.search(
            r'<(?:div|section)\b[^>]*class=["\'][^"\']*\btable-source-primary\b[^"\']*["\'][^>]*>.*?</(?:div|section)\s*>',
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        source_crop = re.search(
            r'<(?:details|div|section)\b[^>]*class=["\'][^"\']*\bsource-crop\b[^"\']*["\'][^>]*>.*?</(?:details|div|section)\s*>',
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        crop_markup = _table_image_markup(primary.group(0) if primary else "")
        if not crop_markup and source_crop:
            crop_markup = _table_image_markup(source_crop.group(0))

        # Remove the old crop/structured wrappers and any semantic table. The
        # structured candidate remains available in document.json for search
        # and review, but never becomes the reading renderer.
        body = re.sub(
            r'<(?:details|div|section)\b[^>]*class=["\'][^"\']*\b(?:table-source-primary|source-crop|table-structure|table-scroll)\b[^"\']*["\'][^>]*>.*?</(?:details|div|section)\s*>',
            "",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        body = re.sub(r'<table\b.*?</table\s*>', "", body, flags=re.IGNORECASE | re.DOTALL)

        if crop_markup:
            primary_html = f'<div class="table-source-primary table-image-only">{crop_markup}</div>'
            caption_end = re.search(r'</figcaption\s*>', body, flags=re.IGNORECASE)
            if caption_end:
                body = body[:caption_end.end()] + primary_html + body[caption_end.end():]
            else:
                body = primary_html + body
            opening = _add_class(opening, "table-image-only")
            opening = re.sub(r'\btable-semantic-fallback\b', '', opening, flags=re.IGNORECASE)
        else:
            missing = '<div class="table-source-missing">表格图像暂不可用</div>'
            caption_end = re.search(r'</figcaption\s*>', body, flags=re.IGNORECASE)
            if caption_end:
                body = body[:caption_end.end()] + missing + body[caption_end.end():]
            else:
                body = missing + body
            opening = _add_class(opening, "table-image-missing")
        return opening + body + match.group("close")

    return _TABLE_FIGURE_RE.sub(replace, document)


_FIGURE_ID_RE = re.compile(
    r'(?P<open><figure\b[^>]*?\bid=["\'](?P<id>[^"\']+)["\'][^>]*>)(?P<body>.*?)</figure\s*>',
    flags=re.IGNORECASE | re.DOTALL,
)


def _deduplicate_figure_ids(document: str) -> str:
    matches = list(_FIGURE_ID_RE.finditer(document))
    groups: Dict[str, List[int]] = {}
    for index, match in enumerate(matches):
        groups.setdefault(match.group("id"), []).append(index)
    replacements: Dict[int, str] = {}
    used_ids = {match.group("id") for match in matches}
    for anchor, indexes in groups.items():
        if len(indexes) < 2:
            continue
        number = re.search(r"(\d+)$", anchor)
        expected = number.group(1) if number else ""

        def score(index: int) -> tuple[int, int]:
            body = matches[index].group("body")
            caption_match = re.search(r"<figcaption\b[^>]*>(.*?)</figcaption\s*>", body, flags=re.IGNORECASE | re.DOTALL)
            caption = re.sub(r"<[^>]+>", " ", caption_match.group(1) if caption_match else "")
            caption = re.sub(r"\s+", " ", html.unescape(caption)).strip()
            explicit = bool(expected and re.search(rf"\b(?:Figure|Fig\.?|Table)\s*{re.escape(expected)}\b", caption, flags=re.IGNORECASE))
            return (1000 if explicit else 0, len(caption))

        canonical = max(indexes, key=score)
        suffix = 1
        for index in indexes:
            if index == canonical:
                continue
            candidate = f"{anchor}-duplicate-{suffix}"
            while candidate in used_ids:
                suffix += 1
                candidate = f"{anchor}-duplicate-{suffix}"
            replacements[index] = candidate
            used_ids.add(candidate)
            suffix += 1
    if not replacements:
        return document
    cursor = 0
    chunks: List[str] = []
    for index, match in enumerate(matches):
        chunks.append(document[cursor:match.start()])
        block = match.group(0)
        if index in replacements:
            opening = match.group("open")
            opening = re.sub(
                rf'(\bid=["\']){re.escape(match.group("id"))}(["\'])',
                rf'\g<1>{replacements[index]}\g<2>',
                opening,
                count=1,
                flags=re.IGNORECASE,
            )
            block = opening + match.group("body") + "</figure>"
        chunks.append(block)
        cursor = match.end()
    chunks.append(document[cursor:])
    return "".join(chunks)


def _migrate_reader_html(job_dir: Path) -> bool:
    """Bring pre-continuous reader HTML into the current presentation shell."""
    path = job_dir / "document.html"
    if not path.is_file():
        return False
    try:
        document = path.read_text(encoding="utf-8")
    except OSError:
        return False
    had_migration_style = _LEGACY_READER_STYLE_MARKER in document
    original = document
    # Older exports put the page navigator and audit crops directly in the
    # DOM. Remove those presentation-only blocks instead of merely hiding
    # them, so accessibility/search cannot surface an internal fallback.
    document = re.sub(
        r'<nav\b[^>]*class=["\'][^"\']*\breader-nav\b[^"\']*["\'][^>]*>.*?</nav\s*>',
        "",
        document,
        flags=re.IGNORECASE | re.DOTALL,
    )
    document = _migrate_legacy_table_figures(document)
    document = _deduplicate_figure_ids(document)
    for class_name in ("source-crop", "page-source", "table-structure"):
        document = re.sub(
            rf'<(?:details|div|section)\b[^>]*class=["\'][^"\']*\b{class_name}\b[^"\']*["\'][^>]*>.*?</(?:details|div|section)\s*>',
            "",
            document,
            flags=re.IGNORECASE | re.DOTALL,
        )
    if had_migration_style:
        migrated = document
    else:
        closing = re.search(r"</style>", document, flags=re.IGNORECASE)
        if closing:
            migrated = document[:closing.start()] + _LEGACY_READER_STYLE + document[closing.start():]
        else:
            head = re.search(r"</head>", document, flags=re.IGNORECASE)
            style = f"<style>{_LEGACY_READER_STYLE}</style>"
            migrated = document[:head.start()] + style + document[head.start():] if head else style + document
    if migrated == original:
        return False
    try:
        path.write_text(migrated, encoding="utf-8")
    except OSError:
        return False
    return True


def _sync_ai_annotations(job_dir: Path, result: Dict[str, Any]) -> None:
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
        path.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")


def _is_ai_annotation(item: Dict[str, Any]) -> bool:
    source = str(item.get("source") or "").strip().lower()
    if source == "ai":
        return True
    if source == "manual":
        return False
    return item.get("kind") == "highlight" and item.get("start") is None and item.get("end") is None


def _migrate_job_artifacts(job_dir: Path, manifest: Dict[str, Any]) -> Dict[str, Any]:
    if READONLY_MODE:
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


# In-memory conversion job registry backed by data/jobs/<job-id> artifacts.
class JobStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.incoming_root = self.root / ".incoming"
        self.incoming_root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.aliases: Dict[str, str] = {}
        self.sha_index: Dict[str, str] = {}
        self._load_aliases()
        self._discard_abandoned_uploads()
        self._load_existing()

    @property
    def permanent_delete_journal_path(self) -> Path:
        return self.root / PERMANENT_DELETE_JOURNAL_NAME

    def _read_permanent_delete_journal(self) -> List[Dict[str, Any]]:
        journal = _read_json_file(self.permanent_delete_journal_path, [])
        return [item for item in journal if isinstance(item, dict) and str(item.get("job_id") or "").strip()]

    def _write_permanent_delete_journal(self, entries: List[Dict[str, Any]]) -> None:
        if READONLY_MODE:
            return
        target = self.permanent_delete_journal_path
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, target)
        try:
            directory_fd = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass

    def _upsert_permanent_delete_journal(self, entry: Dict[str, Any]) -> None:
        entries = [item for item in self._read_permanent_delete_journal() if str(item.get("job_id")) != str(entry.get("job_id"))]
        entries.append(dict(entry))
        self._write_permanent_delete_journal(entries)

    def _remove_permanent_delete_journal(self, job_id: str) -> None:
        entries = [item for item in self._read_permanent_delete_journal() if str(item.get("job_id")) != str(job_id)]
        if entries:
            self._write_permanent_delete_journal(entries)
        else:
            try:
                self.permanent_delete_journal_path.unlink()
            except FileNotFoundError:
                pass

    def recover_permanent_delete_journals(self, library: Any) -> None:
        """Resolve interrupted delete transactions after both stores are loaded."""
        with self.lock:
            for entry in self._read_permanent_delete_journal():
                job_id = self.resolve_id(str(entry.get("job_id") or ""))
                if not JOB_ID_RE.fullmatch(job_id):
                    self._remove_permanent_delete_journal(str(entry.get("job_id") or ""))
                    continue
                root = self.root.resolve()
                original = (root / job_id).resolve()
                staged = Path(str(entry.get("staged_dir") or "")).resolve()
                if staged.parent != root or not staged.name.startswith(f".deleting-{job_id}-"):
                    self._remove_permanent_delete_journal(job_id)
                    continue
                indexed = str(entry.get("status") or "") == "indexed"
                try:
                    indexed = indexed or bool(library.is_permanently_deleted(job_id))
                except Exception:
                    pass
                if indexed:
                    if staged.exists():
                        try:
                            shutil.rmtree(staged)
                        except OSError:
                            # Keep the indexed journal for a later retry; do
                            # not recreate a potentially partial job directory.
                            continue
                    self.jobs.pop(job_id, None)
                    self._remove_permanent_delete_journal(job_id)
                    continue
                if staged.exists() and not original.exists():
                    os.replace(staged, original)
                    record = dict(entry.get("record") or {})
                    record["job_id"] = job_id
                    record["job_dir"] = str(original)
                    self.jobs[job_id] = record
                self._remove_permanent_delete_journal(job_id)

    def _mark_permanent_delete_indexed(self, token: Dict[str, Any]) -> None:
        with self.lock:
            entry = dict(token)
            entry["status"] = "indexed"
            self._upsert_permanent_delete_journal(entry)

    def permanent_delete_preflight(self, job_id: str) -> tuple[Optional[str], Optional[str]]:
        """Validate a permanent delete without changing either store."""
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            record = self.jobs.get(canonical_id)
            if record is None:
                return None, "任务不存在。"
            status = str(record.get("status") or "")
            if status in {"queued", "running"}:
                return canonical_id, "文献仍在导入或转换中，暂不能彻底清除。"
            if status not in {"completed", "failed"}:
                return canonical_id, "文献当前仍在处理中，暂不能彻底清除。"
            reflow = record.get("reflow")
            if isinstance(reflow, dict) and str(reflow.get("status") or "") in {"queued", "running", "cancelling"}:
                return canonical_id, "文献正在重新排版，请等待任务结束后再彻底清除。"
            if str(record.get("metadata_status") or "") == "retrieving":
                return canonical_id, "文献正在检索元数据，请等待任务结束后再彻底清除。"
            with METADATA_STATE_LOCK:
                if any(str(pending[0]) == canonical_id for pending in METADATA_PENDING):
                    return canonical_id, "文献仍有后台任务运行，暂不能彻底清除。"
            root = self.root.resolve()
            job_dir = Path(str(record.get("job_dir") or "")).resolve()
            if job_dir.parent != root or job_dir.name != canonical_id:
                return canonical_id, "任务目录不在文献库根目录下，已拒绝彻底清除。"
            if not job_dir.is_dir():
                return canonical_id, "任务目录不存在，无法安全彻底清除。"
            return canonical_id, None

    def _discard_abandoned_uploads(self) -> None:
        """Remove unpublished upload fragments left by an interrupted process."""
        if READONLY_MODE:
            return
        for child in self.incoming_root.iterdir():
            try:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            except OSError:
                continue

    @staticmethod
    def _write_job_state_at(directory: Path, record: Dict[str, Any]) -> None:
        public = {
            key: value
            for key, value in record.items()
            if key not in {"job_dir", "manifest"}
        }
        target = directory / "job.json"
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(public, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        try:
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass

    def _persist_locked(self, record: Dict[str, Any]) -> None:
        if READONLY_MODE:
            return
        directory = Path(str(record["job_dir"]))
        if directory.is_dir():
            self._write_job_state_at(directory, record)

    def _load_aliases(self) -> None:
        """Load recoverable ids produced by the historical dedupe migration."""
        manifest_path = self.root / ".duplicates" / "merge-manifest.json"
        manifest = _read_json_file(manifest_path, {})
        if not isinstance(manifest, dict):
            return
        for group in manifest.get("groups", []) if isinstance(manifest.get("groups"), list) else []:
            if not isinstance(group, dict):
                continue
            canonical = str(group.get("canonical") or "").strip()
            if not JOB_ID_RE.fullmatch(canonical):
                continue
            for archived in group.get("archived", []) if isinstance(group.get("archived"), list) else []:
                archived = str(archived or "").strip()
                if JOB_ID_RE.fullmatch(archived) and archived != canonical:
                    self.aliases[archived] = canonical

    def resolve_id(self, job_id: str) -> str:
        """Resolve an archived duplicate id to its live canonical job."""
        current = str(job_id or "").strip()
        seen: set[str] = set()
        while current in self.aliases and current not in seen:
            seen.add(current)
            current = self.aliases[current]
        return current

    def _load_existing(self) -> None:
        """Make completed local jobs visible after a server restart."""
        for job_dir in sorted(self.root.iterdir()):
            if not job_dir.is_dir() or not JOB_ID_RE.fullmatch(job_dir.name):
                continue
            error_path = job_dir / "error.json"
            state_path = job_dir / "job.json"
            state = _read_json_file(state_path, {})
            if not isinstance(state, dict):
                state = {}
            active_render = state.get("active_render")
            try:
                active_render = int(active_render) if active_render is not None else None
            except (TypeError, ValueError):
                active_render = None
            render_name = str(active_render or "")
            render_dir = job_dir / "renders" / render_name if RENDER_GENERATION_RE.fullmatch(render_name) else None
            manifest_path = render_dir / "manifest.json" if render_dir and (render_dir / "manifest.json").is_file() else job_dir / "manifest.json"
            if manifest_path.parent == job_dir:
                active_render = None
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else None
            except (OSError, json.JSONDecodeError):
                manifest = None
            if isinstance(manifest, dict):
                if active_render is None:
                    manifest = _migrate_job_artifacts(job_dir, manifest)
            source = (manifest or {}).get("source", {})
            source_path = job_dir / "source.pdf"
            if not source_path.is_file():
                source_path = job_dir / "upload.pdf"
            stored_status = str(state.get("status") or "")
            if manifest:
                status = "completed"
            elif error_path.is_file() or stored_status == "failed":
                status = "failed"
            else:
                status = "queued"
            record = {
                "job_id": job_dir.name,
                "source_filename": source.get("filename") or state.get("source_filename") or "document.pdf",
                "source_bytes": source.get("bytes") or state.get("source_bytes") or (source_path.stat().st_size if source_path.is_file() else 0),
                "status": status,
                "stage": "已完成" if manifest else ("转换失败" if status == "failed" else "等待开始"),
                "progress": 1.0 if status in {"completed", "failed"} else 0.0,
                "created_at": state.get("created_at") or (manifest or {}).get("created_at", ""),
                "updated_at": state.get("updated_at") or (manifest or {}).get("created_at", ""),
                "attempt": max(0, int(state.get("attempt") or 0)),
                "job_dir": str(job_dir),
            }
            if active_render is not None:
                record["active_render"] = active_render
            reflow = state.get("reflow")
            if isinstance(reflow, dict):
                try:
                    reflow_progress = max(0.0, min(1.0, float(reflow.get("progress") or 0.0)))
                except (TypeError, ValueError, OverflowError):
                    reflow_progress = 0.0
                try:
                    reflow_generation = max(1, int(reflow.get("generation") or 1))
                except (TypeError, ValueError, OverflowError):
                    reflow_generation = 1
                reflow_status = str(reflow.get("status") or "failed")
                if reflow_status not in {"queued", "running", "cancelling", "cancelled", "completed", "failed"}:
                    reflow_status = "failed"
                normalized_reflow = {
                    "status": reflow_status,
                    "stage": str(reflow.get("stage") or ""),
                    "progress": reflow_progress,
                    "generation": reflow_generation,
                    "error": str(reflow.get("error") or "")[:500],
                }
                if normalized_reflow["status"] in {"queued", "running", "cancelling"}:
                    normalized_reflow.update({
                        "status": "cancelled" if normalized_reflow["status"] == "cancelling" else "failed",
                        "stage": "重新排版已取消" if normalized_reflow["status"] == "cancelling" else "重新排版已中断",
                        "error": "应用退出前正在取消重新排版，当前阅读版本未受影响。" if normalized_reflow["status"] == "cancelling" else "应用退出时重新排版尚未完成，当前阅读版本未受影响。",
                    })
                record["reflow"] = normalized_reflow
            for key in ("requested_folder_ids", "metrics", "metadata_status", "metadata_phase", "metadata_seconds", "metadata_venue"):
                if key in state:
                    record[key] = state[key]
            digest = str(source.get("sha256") or state.get("source_sha256") or "").strip().lower()
            if not digest and source_path.is_file():
                digest = self._hash_file(source_path)
            if digest:
                record["source_sha256"] = digest
            if manifest:
                record["manifest"] = manifest
            if error_path.is_file():
                try:
                    record["error"] = json.loads(error_path.read_text(encoding="utf-8")).get("error", "转换失败")
                except (OSError, json.JSONDecodeError):
                    record["error"] = "转换失败"
            self.jobs[job_dir.name] = record
            self._persist_locked(record)
        status_priority = {"completed": 3, "running": 2, "queued": 1, "failed": 0}
        for record in sorted(self.jobs.values(), key=lambda item: status_priority.get(str(item.get("status")), -1), reverse=True):
            digest = str(record.get("source_sha256") or "").strip().lower()
            if digest:
                self.sha_index.setdefault(digest, str(record["job_id"]))

    @staticmethod
    def _hash_file(path: Path) -> str:
        hasher = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    hasher.update(chunk)
        except OSError:
            return ""
        return hasher.hexdigest()

    @staticmethod
    def _source_title_key(source_name: str) -> str:
        """Return a stable local key for duplicate upload detection.

        A trailing Finder-style copy suffix is ignored so the common
        ``Paper.pdf`` / ``Paper (1).pdf`` case shares one local source.
        """
        stem = unicodedata.normalize("NFKC", Path(str(source_name)).stem).strip()
        stem = re.sub(r"\s*[（(]\d+[）)]\s*$", "", stem)
        return re.sub(r"[\W_]+", "", stem.casefold(), flags=re.UNICODE)

    @staticmethod
    def _record_source_sha256(record: Dict[str, Any]) -> str:
        digest = str(record.get("source_sha256") or "").strip().lower()
        if digest:
            return digest
        job_dir = Path(str(record.get("job_dir") or ""))
        source_path = job_dir / "source.pdf"
        if not source_path.is_file():
            source_path = job_dir / "upload.pdf"
        if not source_path.is_file():
            return ""
        digest = JobStore._hash_file(source_path)
        record["source_sha256"] = digest
        return digest

    @staticmethod
    def _can_reuse_exact(record: Dict[str, Any], size: int) -> bool:
        if record.get("status") not in {"queued", "running", "completed"}:
            return False
        job_dir = Path(str(record.get("job_dir") or ""))
        source = job_dir / "source.pdf"
        if not source.is_file():
            source = job_dir / "upload.pdf"
        try:
            return source.is_file() and source.stat().st_size == int(size)
        except OSError:
            return False

    def create_or_get_by_source_title(self, source_name: str, size: int, source_sha256: str = "") -> tuple[Dict[str, Any], bool]:
        """Atomically reuse only a byte-identical PDF.

        Filenames are hints, not document identities: camera-ready and draft
        versions often share a name while containing different material.
        """
        source_sha256 = str(source_sha256 or "").strip().lower()
        with self.lock:
            if source_sha256:
                canonical_id = self.sha_index.get(source_sha256)
                canonical = self.jobs.get(canonical_id or "")
                if canonical and self._can_reuse_exact(canonical, size):
                    return dict(canonical), True
            record = self._create_locked(source_name, size, source_sha256)
        return dict(record), False

    def new_incoming_directory(self) -> Path:
        directory = self.incoming_root / uuid.uuid4().hex
        directory.mkdir(parents=False, exist_ok=False)
        return directory

    def commit_staged_upload(
        self,
        incoming_dir: Path,
        source_name: str,
        size: int,
        source_sha256: str,
        folder_id: str = "",
    ) -> tuple[Dict[str, Any], bool]:
        """Publish one fully written upload directory as an atomic job."""
        incoming_dir = Path(incoming_dir).resolve()
        incoming_dir.relative_to(self.incoming_root.resolve())
        part = incoming_dir / "upload.pdf.part"
        if not part.is_file() or part.stat().st_size != int(size):
            raise PipelineError("上传暂存文件不完整。")
        digest = str(source_sha256 or "").strip().lower()
        with self.lock:
            canonical_id = self.sha_index.get(digest)
            canonical = self.jobs.get(canonical_id or "")
            if canonical and int(canonical.get("source_bytes") or 0) == int(size) and canonical.get("status") in {"failed", "queued"} and not self._can_reuse_exact(canonical, size):
                job_dir = Path(str(canonical["job_dir"]))
                os.replace(part, job_dir / "upload.pdf")
                shutil.rmtree(incoming_dir, ignore_errors=True)
                (job_dir / "error.json").unlink(missing_ok=True)
                canonical.update({
                    "source_filename": source_name,
                    "source_bytes": int(size),
                    "source_sha256": digest,
                    "status": "queued",
                    "stage": "等待重试",
                    "progress": 0.0,
                    "error": "",
                    "updated_at": utc_now(),
                })
                if folder_id:
                    requested = list(canonical.get("requested_folder_ids") or [])
                    if folder_id not in requested:
                        requested.append(folder_id)
                    canonical["requested_folder_ids"] = requested
                self._persist_locked(canonical)
                return dict(canonical), False
            if canonical and int(canonical.get("source_bytes") or 0) == int(size) and canonical.get("status") == "completed" and not self._can_reuse_exact(canonical, size):
                job_dir = Path(str(canonical["job_dir"]))
                os.replace(part, job_dir / "source.pdf")
                shutil.rmtree(incoming_dir, ignore_errors=True)
                if folder_id:
                    requested = list(canonical.get("requested_folder_ids") or [])
                    if folder_id not in requested:
                        requested.append(folder_id)
                    canonical["requested_folder_ids"] = requested
                canonical["updated_at"] = utc_now()
                self._persist_locked(canonical)
                return dict(canonical), True
            if canonical and self._can_reuse_exact(canonical, size):
                if folder_id:
                    requested = list(canonical.get("requested_folder_ids") or [])
                    if folder_id not in requested:
                        requested.append(folder_id)
                        canonical["requested_folder_ids"] = requested
                        canonical["updated_at"] = utc_now()
                        self._persist_locked(canonical)
                shutil.rmtree(incoming_dir, ignore_errors=True)
                return dict(canonical), True
            job_id = uuid.uuid4().hex[:16]
            job_dir = self.root / job_id
            now = utc_now()
            record = {
                "job_id": job_id,
                "source_filename": source_name,
                "source_bytes": int(size),
                "source_sha256": digest,
                "status": "queued",
                "stage": "等待开始",
                "progress": 0.0,
                "attempt": 0,
                "requested_folder_ids": [folder_id] if folder_id else [],
                "created_at": now,
                "updated_at": now,
                "job_dir": str(job_dir),
            }
            os.replace(part, incoming_dir / "upload.pdf")
            self._write_job_state_at(incoming_dir, record)
            os.replace(incoming_dir, job_dir)
            try:
                root_fd = os.open(self.root, os.O_RDONLY)
                try:
                    os.fsync(root_fd)
                finally:
                    os.close(root_fd)
            except OSError:
                pass
            self.jobs[job_id] = record
            if digest:
                self.sha_index[digest] = job_id
            return dict(record), False

    def create(self, source_name: str, size: int) -> Dict[str, Any]:
        """Create a job without de-duplication (kept for internal callers)."""
        with self.lock:
            return dict(self._create_locked(source_name, size))

    def _create_locked(self, source_name: str, size: int, source_sha256: str = "") -> Dict[str, Any]:
        job_id = uuid.uuid4().hex[:16]
        job_dir = self.root / job_id
        job_dir.mkdir(parents=True, exist_ok=False)
        record = {
            "job_id": job_id,
            "source_filename": source_name,
            "source_bytes": size,
            "status": "queued",
            "stage": "等待开始",
            "progress": 0.0,
            "attempt": 0,
            "created_at": utc_now(),
            "updated_at": utc_now(),
            "job_dir": str(job_dir),
        }
        if source_sha256:
            record["source_sha256"] = source_sha256
            self.sha_index[source_sha256] = job_id
        self.jobs[job_id] = record
        self._persist_locked(record)
        return record

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            record = self.jobs.get(self.resolve_id(job_id))
            return dict(record) if record else None

    def update(self, job_id: str, **fields: Any) -> None:
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            if canonical_id in self.jobs:
                previous = dict(self.jobs[canonical_id])
                self.jobs[canonical_id].update(fields)
                self.jobs[canonical_id]["updated_at"] = utc_now()
                try:
                    self._persist_locked(self.jobs[canonical_id])
                except Exception:
                    self.jobs[canonical_id] = previous
                    raise

    def claim(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Atomically claim a queued job so duplicate queue entries are harmless."""
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            record = self.jobs.get(canonical_id)
            if not record or record.get("status") != "queued":
                return None
            previous = dict(record)
            record["status"] = "running"
            record["stage"] = "启动转换"
            record["progress"] = 0.03
            record["attempt"] = max(0, int(record.get("attempt") or 0)) + 1
            record["updated_at"] = utc_now()
            try:
                self._persist_locked(record)
            except Exception:
                self.jobs[canonical_id] = previous
                raise
            return dict(record)

    def begin_reflow(self, job_id: str) -> Dict[str, Any]:
        """Atomically reserve one new render generation for a completed job."""
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            record = self.jobs.get(canonical_id)
            if record is None:
                raise KeyError(job_id)
            if record.get("status") != "completed":
                raise ReflowConflictError("只有已完成转换的文献可以重新排版。")
            current_reflow = record.get("reflow")
            if isinstance(current_reflow, dict) and current_reflow.get("status") in {"queued", "running", "cancelling"}:
                raise ReflowConflictError("这篇文献正在重新排版，请勿重复提交。")
            job_dir = Path(str(record["job_dir"]))
            source_path = job_dir / "source.pdf"
            if not source_path.is_file():
                raise ReflowConflictError("原始 source.pdf 不存在，无法安全重新排版。")
            digest = self._hash_file(source_path)
            expected = str(record.get("source_sha256") or "").strip().lower()
            if not digest or (expected and not hmac.compare_digest(digest, expected)):
                raise ReflowConflictError("原始 PDF 校验失败，已取消重新排版。")
            generation = max(
                int(record.get("active_render") or 0),
                int(current_reflow.get("generation") or 0) if isinstance(current_reflow, dict) else 0,
            ) + 1
            previous = dict(record)
            record["source_sha256"] = digest
            record["reflow"] = {
                "status": "queued",
                "stage": "等待重新排版",
                "progress": 0.0,
                "generation": generation,
                "error": "",
            }
            record["updated_at"] = utc_now()
            try:
                self._persist_locked(record)
            except Exception:
                self.jobs[canonical_id] = previous
                raise
            return dict(record)

    def claim_reflow(self, job_id: str, generation: int) -> Optional[Dict[str, Any]]:
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            record = self.jobs.get(canonical_id)
            reflow = record.get("reflow") if record else None
            if not isinstance(reflow, dict) or reflow.get("status") != "queued" or int(reflow.get("generation") or 0) != int(generation):
                return None
            previous = dict(record)
            record["reflow"] = {**reflow, "status": "running", "stage": "启动重新排版", "progress": 0.02, "error": ""}
            record["updated_at"] = utc_now()
            try:
                self._persist_locked(record)
            except Exception:
                self.jobs[canonical_id] = previous
                raise
            return dict(record)

    def update_reflow(
        self,
        job_id: str,
        generation: int,
        *,
        expected_statuses: Optional[set[str]] = None,
        **fields: Any,
    ) -> bool:
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            record = self.jobs.get(canonical_id)
            reflow = record.get("reflow") if record else None
            if not isinstance(reflow, dict) or int(reflow.get("generation") or 0) != int(generation):
                return False
            if expected_statuses is not None and str(reflow.get("status") or "") not in expected_statuses:
                return False
            previous = dict(record)
            record["reflow"] = {**reflow, **fields}
            record["updated_at"] = utc_now()
            try:
                self._persist_locked(record)
            except Exception:
                self.jobs[canonical_id] = previous
                raise
            return True

    def request_reflow_cancel(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            record = self.jobs.get(canonical_id)
            if record is None:
                raise KeyError(job_id)
            reflow = record.get("reflow")
            if not isinstance(reflow, dict):
                raise ReflowConflictError("这篇文献没有可取消的重新排版任务。")
            status = str(reflow.get("status") or "")
            if status == "queued":
                next_reflow = {
                    **reflow,
                    "status": "cancelled",
                    "stage": "重新排版已取消",
                    "error": "用户已取消重新排版，当前阅读版本未受影响。",
                }
            elif status in {"running", "cancelling"}:
                next_reflow = {
                    **reflow,
                    "status": "cancelling",
                    "stage": "正在取消重新排版",
                    "error": "",
                }
            else:
                raise ReflowConflictError("当前没有正在进行的重新排版任务。")
            previous = dict(record)
            record["reflow"] = next_reflow
            record["updated_at"] = utc_now()
            try:
                self._persist_locked(record)
            except Exception:
                self.jobs[canonical_id] = previous
                raise
            return dict(record)

    def complete_reflow(self, job_id: str, generation: int, manifest: Dict[str, Any], metrics: Dict[str, Any]) -> bool:
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            record = self.jobs.get(canonical_id)
            reflow = record.get("reflow") if record else None
            if not isinstance(reflow, dict) or reflow.get("status") != "running" or int(reflow.get("generation") or 0) != int(generation):
                return False
            previous = dict(record)
            record["active_render"] = int(generation)
            record["manifest"] = manifest
            record["metrics"] = {**dict(record.get("metrics") or {}), "reflow": metrics}
            record["reflow"] = {
                **reflow,
                "status": "completed",
                "stage": "重新排版完成",
                "progress": 1.0,
                "error": "",
            }
            record["updated_at"] = utc_now()
            try:
                self._persist_locked(record)
            except Exception:
                self.jobs[canonical_id] = previous
                raise
            return True

    def list(self) -> list:
        with self.lock:
            records = [dict(item) for item in self.jobs.values()]
        return sorted(records, key=lambda item: item.get("created_at", ""), reverse=True)

    def stage_permanent_delete(self, job_id: str) -> Dict[str, Any]:
        """Move a job directory aside while its library index is updated.

        The directory rename and in-memory removal happen under the JobStore
        lock, so conversion/reflow workers cannot claim or persist the job
        after this point.  The returned token can be passed to
        :meth:`rollback_permanent_delete` if the index transaction fails.
        """
        with self.lock:
            canonical_id = self.resolve_id(job_id)
            record = self.jobs.get(canonical_id)
            if record is None:
                raise PipelineError("任务不存在。")
            status = str(record.get("status") or "")
            if status in {"queued", "running"}:
                raise ReflowConflictError("文献仍在导入或转换中，暂不能彻底清除。")
            if status not in {"completed", "failed"}:
                raise ReflowConflictError("文献当前仍在处理中，暂不能彻底清除。")
            reflow = record.get("reflow")
            if isinstance(reflow, dict) and str(reflow.get("status") or "") in {"queued", "running", "cancelling"}:
                raise ReflowConflictError("文献正在重新排版，请等待任务结束后再彻底清除。")
            if str(record.get("metadata_status") or "") == "retrieving":
                raise ReflowConflictError("文献正在检索元数据，请等待任务结束后再彻底清除。")
            with METADATA_STATE_LOCK:
                if any(str(pending[0]) == canonical_id for pending in METADATA_PENDING):
                    raise ReflowConflictError("文献仍有后台任务运行，暂不能彻底清除。")

            root = self.root.resolve()
            job_dir = Path(str(record.get("job_dir") or "")).resolve()
            if job_dir.parent != root or job_dir.name != canonical_id:
                raise PipelineError("任务目录不在文献库根目录下，已拒绝彻底清除。")
            if not job_dir.is_dir():
                raise PipelineError("任务目录不存在，无法安全彻底清除。")
            staged_dir = root / f".deleting-{canonical_id}-{uuid.uuid4().hex}"
            token = {
                "job_id": canonical_id,
                "record": dict(record),
                "job_dir": str(job_dir),
                "staged_dir": str(staged_dir),
                "status": "prepared",
            }
            self._upsert_permanent_delete_journal(token)
            os.replace(job_dir, staged_dir)
            token["status"] = "staged"
            try:
                self._upsert_permanent_delete_journal(token)
            except Exception:
                # The prepared journal is enough for a restart to recover the
                # staged directory. Restore synchronously when possible so a
                # transient journal-write failure does not leave a live
                # in-memory record pointing at a missing directory.
                restored = False
                try:
                    if staged_dir.exists() and not job_dir.exists():
                        os.replace(staged_dir, job_dir)
                    restored = job_dir.is_dir()
                except OSError:
                    restored = False
                if not restored:
                    self.jobs.pop(canonical_id, None)
                    self.sha_index = {
                        digest: mapped_id
                        for digest, mapped_id in self.sha_index.items()
                        if self.resolve_id(mapped_id) != canonical_id
                    }
                try:
                    self._remove_permanent_delete_journal(canonical_id)
                except OSError:
                    # Keep the prepared journal if its cleanup also failed;
                    # startup recovery will reconcile it with the directory.
                    pass
                raise
            self.jobs.pop(canonical_id, None)
            self.sha_index = {
                digest: mapped_id
                for digest, mapped_id in self.sha_index.items()
                if self.resolve_id(mapped_id) != canonical_id
            }
            return token

    def rollback_permanent_delete(self, token: Dict[str, Any]) -> None:
        """Put a staged job directory and registry record back in place."""
        canonical_id = str(token.get("job_id") or "").strip()
        if not JOB_ID_RE.fullmatch(canonical_id):
            raise PipelineError("永久删除恢复令牌无效。")
        with self.lock:
            if canonical_id in self.jobs:
                raise PipelineError("永久删除恢复与现有任务冲突。")
            root = self.root.resolve()
            original = (root / canonical_id).resolve()
            staged = Path(str(token.get("staged_dir") or "")).resolve()
            if staged.parent != root or not staged.name.startswith(f".deleting-{canonical_id}-"):
                raise PipelineError("永久删除暂存目录无效。")
            if staged.exists():
                if original.exists():
                    raise PipelineError("永久删除恢复目标已存在。")
                os.replace(staged, original)
            record = dict(token.get("record") or {})
            record["job_id"] = canonical_id
            record["job_dir"] = str(original)
            self.jobs[canonical_id] = record
            digest = str(record.get("source_sha256") or "").strip().lower()
            if digest:
                self.sha_index.setdefault(digest, canonical_id)
            self._remove_permanent_delete_journal(canonical_id)

    def finalize_permanent_delete(self, token: Dict[str, Any]) -> None:
        """Delete a staged job directory after both stores are committed."""
        canonical_id = str(token.get("job_id") or "").strip()
        if not JOB_ID_RE.fullmatch(canonical_id):
            raise PipelineError("永久删除令牌无效。")
        # The journal is a shared read-modify-write file.  Finalization can
        # run concurrently for different documents, so protect both the
        # staged-directory cleanup and journal removal with the store lock.
        with self.lock:
            root = self.root.resolve()
            staged = Path(str(token.get("staged_dir") or "")).resolve()
            if staged.parent != root or not staged.name.startswith(f".deleting-{canonical_id}-"):
                raise PipelineError("永久删除暂存目录无效。")
            if staged.exists():
                shutil.rmtree(staged)
            self._remove_permanent_delete_journal(canonical_id)

    def path(self, job_id: str, relative: str = "") -> Optional[Path]:
        canonical_id = self.resolve_id(job_id)
        if not JOB_ID_RE.fullmatch(canonical_id):
            return None
        job_dir = (self.root / canonical_id).resolve()
        if not job_dir.is_dir():
            return None
        target = (job_dir / relative).resolve()
        try:
            target.relative_to(job_dir)
        except ValueError:
            return None
        return target


# Process-level stores and background conversion/metadata workers. They are
# initialized only after the library-root process lock is held.
STORE: Any = None
LIBRARY: Any = None


def _initialize_runtime_stores() -> None:
    global STORE, LIBRARY
    if STORE is not None and LIBRARY is not None:
        return
    STORE = JobStore(JOBS_ROOT)
    LIBRARY = LibraryStore(LIBRARY_ROOT)
    STORE.recover_permanent_delete_journals(LIBRARY)
    LIBRARY.sync_jobs(STORE.list())
    for record in STORE.list():
        _apply_requested_folders(record)


def _migration_request_enter(*, mutation: bool = False) -> bool:
    global MIGRATION_ACTIVE_REQUESTS, MIGRATION_ACTIVE_MUTATIONS
    with MIGRATION_REQUEST_CONDITION:
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
    ready = not busy_jobs and not conversion_pending and not metadata_queued and not metadata_pending and not incoming and not active_mutations
    return {
        "ready": ready,
        "busy_jobs": busy_jobs,
        "conversion_pending": conversion_pending,
        "metadata_pending": max(metadata_pending, metadata_queued),
        "incoming_uploads": incoming,
        "active_requests": active_requests,
        "active_mutations": active_mutations,
        "quiescing": quiescing,
    }


def _quiesce_library_requests(timeout: float = 30.0) -> Dict[str, Any]:
    global MIGRATION_QUIESCING
    deadline = time.monotonic() + max(0.1, float(timeout))
    with MIGRATION_REQUEST_CONDITION:
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


def _metadata_job_lock(job_id: str) -> threading.RLock:
    with METADATA_STATE_LOCK:
        return METADATA_JOB_LOCKS.setdefault(job_id, threading.RLock())


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
            METADATA_QUEUE.task_done()


def _publish_conversion_attempt(job_dir: Path, attempt_dir: Path) -> None:
    """Publish a complete conversion, with the manifest as the commit marker."""
    manifest_path = attempt_dir / "manifest.json"
    if not manifest_path.is_file():
        raise PipelineError("转换没有生成完成清单。")
    stale_root = job_dir / "work" / f"stale-{attempt_dir.name}-{uuid.uuid4().hex[:8]}"
    stale_root.mkdir(parents=True, exist_ok=False)
    entries = [entry for entry in attempt_dir.iterdir() if entry.name != "manifest.json"]
    try:
        for entry in entries:
            target = job_dir / entry.name
            if target.exists():
                os.replace(target, stale_root / entry.name)
            os.replace(entry, target)
        target_manifest = job_dir / "manifest.json"
        if target_manifest.exists():
            os.replace(target_manifest, stale_root / "manifest.json")
        os.replace(manifest_path, target_manifest)
        try:
            directory_fd = os.open(job_dir, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    except Exception:
        raise
    else:
        shutil.rmtree(stale_root, ignore_errors=True)
        try:
            attempt_dir.rmdir()
        except OSError:
            pass


def _rebase_manifest_paths(value: Any, attempt_dir: Path, job_dir: Path) -> Any:
    """Point manifest paths at the published directory, not the attempt one.

    Rewriting the serialized JSON would silently no-op on Windows, where
    json.dumps escapes the backslashes in the path being searched for.
    """
    old = str(attempt_dir)
    new = str(job_dir)
    if isinstance(value, str):
        return new + value[len(old):] if value.startswith(old) else value
    if isinstance(value, dict):
        return {key: _rebase_manifest_paths(item, attempt_dir, job_dir) for key, item in value.items()}
    if isinstance(value, list):
        return [_rebase_manifest_paths(item, attempt_dir, job_dir) for item in value]
    return value


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
        manifest = process_pdf(
            job_dir / "upload.pdf",
            attempt_dir,
            job_id=job_id,
            source_name=source_name,
            progress=progress,
            backend_override="odl",
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


def _validate_reflow_render(render_dir: Path) -> Dict[str, Any]:
    required = ("manifest.json", "document.html", "document.json", "document-ir.json", "validation.json", "source.pdf")
    missing = [name for name in required if not (render_dir / name).is_file()]
    if missing:
        raise PipelineError("重新排版产物不完整：" + "、".join(missing))
    validation = _read_json_file(render_dir / "validation.json", {})
    if not isinstance(validation, dict) or validation.get("status") not in {"PASS", "REVIEW"}:
        raise PipelineError("重新排版校验未通过，当前阅读版本未受影响。")
    manifest = _read_json_file(render_dir / "manifest.json", {})
    if not isinstance(manifest, dict):
        raise PipelineError("重新排版没有生成有效清单。")
    return manifest


def _reflow_cancel_event(job_id: str, generation: int) -> threading.Event:
    key = (str(job_id), int(generation))
    with REFLOW_CANCEL_LOCK:
        return REFLOW_CANCEL_EVENTS.setdefault(key, threading.Event())


def _forget_reflow_cancel_event(job_id: str, generation: int) -> None:
    with REFLOW_CANCEL_LOCK:
        REFLOW_CANCEL_EVENTS.pop((str(job_id), int(generation)), None)


def _parsing_provider_registry() -> Any:
    global PARSING_PROVIDERS
    with PARSING_PROVIDER_LOCK:
        if PARSING_PROVIDERS is None:
            PARSING_PROVIDERS = create_default_registry(COMPONENTS_ROOT)
        return PARSING_PROVIDERS


def _provider_failure(capability: Dict[str, Any]) -> ProviderError:
    code = str(capability.get("reason_code") or capability.get("state") or "not_installed")
    message = str(capability.get("message") or "版面解析服务当前不可用。")
    return ProviderError(message, code=code, details={"provider": capability})


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
        provider_result = _parsing_provider_registry().get("local-mineru").run(
            ParsingRequest(
                job_id=job_id,
                source_pdf=source_path,
                output_dir=attempt_dir,
                source_name=source_name,
                generation=generation,
                backend=_parsing_backend(_stored_settings().get("parsing")),
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
                    error="用户已取消重新排版，当前阅读版本未受影响。" if cancelled else str(exc)[:500],
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
    if READONLY_MODE:
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
    # Every non-SSE response carries an explicit Content-Length, so persistent
    # connections are safe and save a TCP handshake plus a worker thread per
    # asset when the reader loads a document with images.
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        # Keep the terminal useful while retaining the standard access-log shape.
        # Successful static-asset GETs flood the log during reading; skip them.
        message = format % args
        if message.startswith('"GET /api/jobs/') and ' 200 ' in message and ('/assets/' in message or '/renders/' in message or '/pages/' in message):
            return
        print("[http] " + message, flush=True)

    def _send_bytes(self, body: bytes, content_type: str, status: int = HTTPStatus.OK, *, disposition: Optional[str] = None, immutable: bool = False) -> bool:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            # Render generations are content-addressed (sha256 asset names and
            # a monotonically increasing generation), so they can be cached
            # forever; everything else stays uncacheable to avoid stale data.
            self.send_header("Cache-Control", "immutable, max-age=31536000" if immutable else "no-store")
            if disposition:
                self.send_header("Content-Disposition", disposition)
            self.end_headers()
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # A renderer can close a request while an image/translation is in
            # flight (for example when switching document tabs). This is a
            # normal client lifecycle event, not a server failure.
            return False

    def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> bool:
        if READONLY_MODE:
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
        if not AI_REQUIRES_MEMBER:
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
        self._send_bytes(path.read_bytes(), content_type, disposition=disposition, immutable=immutable)

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
        if READONLY_MODE and path == "/" and LANDING_FILE and LANDING_FILE.is_file():
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
                "version": "0.1.8",
                "readonly": READONLY_MODE,
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
            self._send_json({"providers": _parsing_provider_registry().list_capabilities()})
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
                _ensure_content_layout(job_dir)
                self._send_json({"annotations": _read_json_file(job_dir / "annotations.json", [])})
            else:
                notes_path = job_dir / "notes.md"
                _ensure_content_layout(job_dir)
                self._send_json({"markdown": notes_path.read_text(encoding="utf-8") if notes_path.is_file() else ""})
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
                if not READONLY_MODE and _translation_records_need_persist(job_dir):
                    _write_translation_records(job_dir, records)
            if READONLY_MODE:
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
            r"renders/([1-9][0-9]{0,8})/(document\.html|document\.json|document-ir\.json|manifest\.json|validation\.json|layout-content-list\.json|backend-selection\.json|converter\.log|layout-error\.log|(?:assets/images|pages)/[A-Za-z0-9._@-]+)",
            relative,
        )
        download = "download=1" in query
        blocked_relative = render_match.group(2) if render_match else relative
        if READONLY_MODE and blocked_relative in READONLY_BLOCKED_ARTIFACTS:
            self._send_error_json("只读演示模式不提供该文件。", HTTPStatus.FORBIDDEN)
            return
        if render_match:
            path = STORE.path(job_id, relative)
        elif relative in allowed:
            path = STORE.path(job_id, relative)
        elif relative.startswith("assets/images/") or relative.startswith("pages/"):
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
        return bool(MIGRATION_CONTROL_TOKEN) and hmac.compare_digest(provided, MIGRATION_CONTROL_TOKEN)

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
        if path == "/api/migration/prepare":
            self._prepare_library_migration()
            return
        if path == "/api/migration/cancel":
            self._cancel_library_migration()
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
        ai_execution = path in {"/api/ai/test", "/api/ai/models"} or re.fullmatch(
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

    def _test_ai_connection(self) -> None:
        try:
            results = ai_test_connections()
            self._send_json({"results": results, "record": _record_ai_status(results)})
        except Exception as exc:
            self._send_error_json(f"AI 服务连接测试失败：{exc}", HTTPStatus.BAD_GATEWAY)

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
            if not profile["base_url"]:
                raise PipelineError("请先填写 Base URL。")
            models = ai_list_models(profile["base_url"], profile["api_key"])
            self._send_json({"service": service, "models": models})
        except (PipelineError, RuntimeError, OSError, ValueError) as exc:
            self._send_error_json(str(exc), HTTPStatus.BAD_GATEWAY)

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
        if READONLY_MODE:
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
        if READONLY_MODE:
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
        if READONLY_MODE:
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
                annotations = _read_json_file(job_dir / "annotations.json", [])
                if not isinstance(annotations, list):
                    annotations = []
                kind = str(payload.get("kind", "highlight"))
                block_id = payload.get("block_id")
                source = "ai" if str(payload.get("source", "")).strip().lower() == "ai" else "manual"
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
                        self._send_json({"annotation": existing, "annotations": annotations})
                        return
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
                    "created_at": utc_now(),
                }
                if surface:
                    item["surface"] = surface
                if source_block_id:
                    item["source_block_id"] = source_block_id
                if source == "ai":
                    item["suggestion_key"] = _highlight_signature(item["block_id"], item["quote"], item["category"])
                    item["suggestion_state"] = "suggested"
                annotations.append(item)
                (job_dir / "annotations.json").write_text(json.dumps(annotations, ensure_ascii=False, indent=2), encoding="utf-8")
                _sync_content_file(job_dir, "annotations/annotations.json", annotations)
                self._send_json({"annotation": item, "annotations": annotations}, HTTPStatus.CREATED)
        except (PipelineError, OSError) as exc:
            self._send_error_json(str(exc))

    @_locked_job_method
    def _delete_annotation(self, job_id: str, annotation_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        with ANNOTATION_LOCK:
            annotations = _read_json_file(job_dir / "annotations.json", [])
            annotations = [item for item in annotations if isinstance(item, dict) and item.get("id") != annotation_id]
            (job_dir / "annotations.json").write_text(json.dumps(annotations, ensure_ascii=False, indent=2), encoding="utf-8")
            _sync_content_file(job_dir, "annotations/annotations.json", annotations)
        self._send_json({"annotations": annotations})

    @_locked_job_method
    def _delete_manual_annotations(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        with ANNOTATION_LOCK:
            annotations = _read_json_file(job_dir / "annotations.json", [])
            if not isinstance(annotations, list):
                annotations = []
            kept = [item for item in annotations if isinstance(item, dict) and _is_ai_annotation(item)]
            deleted = sum(1 for item in annotations if isinstance(item, dict) and not _is_ai_annotation(item))
            (job_dir / "annotations.json").write_text(json.dumps(kept, ensure_ascii=False, indent=2), encoding="utf-8")
            _sync_content_file(job_dir, "annotations/annotations.json", kept)
        self._send_json({"annotations": kept, "deleted": deleted})

    @_locked_job_method
    def _update_annotation(self, job_id: str, annotation_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        try:
            payload = self._read_json_body(max_bytes=256 * 1024)
            with ANNOTATION_LOCK:
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
                (job_dir / "annotations.json").write_text(json.dumps(annotations, ensure_ascii=False, indent=2), encoding="utf-8")
                _sync_content_file(job_dir, "annotations/annotations.json", annotations)
            self._send_json({"annotation": updated, "annotations": annotations})
        except (PipelineError, OSError) as exc:
            self._send_error_json(str(exc))

    @_locked_job_method
    def _update_notes(self, job_id: str) -> None:
        job_dir = self._completed_job_dir(job_id)
        if not job_dir:
            return
        try:
            payload = self._read_json_body(max_bytes=5 * 1024 * 1024)
            markdown = str(payload.get("markdown", ""))
            if len(markdown) > 2_000_000:
                raise PipelineError("笔记超过 2 MB。")
            (job_dir / "notes.md").write_text(markdown, encoding="utf-8")
            _sync_content_file(job_dir, "notes/notes.md", markdown)
            self._send_json({"markdown": markdown, "saved_at": utc_now()})
        except (PipelineError, OSError) as exc:
            self._send_error_json(str(exc))

    def _translate(self, job_id: str) -> None:
        try:
            # Keep only document validation and cache lookup in the mutation
            # section. The model call itself must be outside it so the three
            # full-translation workers can run concurrently for one document.
            with _job_mutation(job_id):
                job_dir = self._completed_job_dir(job_id)
                if not job_dir:
                    return
                document = _read_json_file(_active_conversion_root(job_dir) / "document.json", {})
                semantic_validation = document.get("semantic_validation", {}) if isinstance(document, dict) else {}
                if (
                    isinstance(document, dict) and document.get("translation_enabled") is False
                ) or (
                    isinstance(semantic_validation, dict) and semantic_validation.get("status") == "FAIL"
                ):
                    raise PipelineError("当前文档未通过语义结构校验，不能对视觉整页结果执行段落翻译。")
                payload = self._read_json_body()
                text = str(payload.get("text", "")).strip()
                block_id = str(payload.get("block_id", "") or "").strip()
                target_language = str(payload.get("target_language", "中文") or "中文").strip()
                source_hash = str(payload.get("source_hash", "") or "").strip()
                formulas = payload.get("formulas", [])
                if not isinstance(formulas, list):
                    formulas = []
                formulas = [
                    {"token": str(item.get("token", "")), "tex": str(item.get("tex", ""))[:4000]}
                    for item in formulas
                    if isinstance(item, dict) and re.fullmatch(r"__MY_SCHOLAR_MATH_\d+__", str(item.get("token", "")))
                ]
                profile_id = translation_profile_id()
                cache_key = _translation_key(text, block_id, target_language, source_hash, profile_id)
                with TRANSLATION_LOCK:
                    cached = next((item for item in _translation_records(job_dir) if item.get("cache_key") == cache_key), None)
            if payload.get("stream"):
                self._translate_stream_response(
                    job_dir,
                    cached,
                    job_id=job_id,
                    text=text,
                    block_id=block_id,
                    target_language=target_language,
                    source_hash=source_hash,
                    formulas=formulas,
                    profile_id=profile_id,
                    cache_key=cache_key,
                )
                return
            if cached:
                self._send_json({"result": {**cached, "cached": True}})
                return
            result = translate_text(
                text,
                target_language=target_language,
                context=_job_context(job_dir, 5000),
                formulas=formulas,
            )
            record = {
                **result,
                "cache_key": cache_key,
                "profile_id": profile_id,
                "block_id": block_id,
                "target_language": target_language,
                "source_hash": source_hash or hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "source_text": text,
                "formulas": formulas,
                "updated_at": utc_now(),
            }
            with _job_mutation(job_id):
                if STORE is not None:
                    current_dir = STORE.path(job_id)
                    if not current_dir:
                        self._send_error_json("任务不存在。", HTTPStatus.NOT_FOUND)
                        return
                    job_dir = current_dir
                with TRANSLATION_LOCK:
                    records = [item for item in _translation_records(job_dir) if item.get("cache_key") != cache_key]
                    records.append(record)
                    _write_translation_records(job_dir, records)
            self._send_json({"result": {**record, "cached": False}})
        except Exception as exc:
            self._send_error_json(f"翻译失败：{exc}", HTTPStatus.BAD_GATEWAY)

    def _account_status(self) -> None:
        if READONLY_MODE:
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
            "ai_requires_member": AI_REQUIRES_MEMBER,
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
                fresh = {"server": ACCOUNT_SERVICE_URL, "username": username, "token": result["token"], "profile": result.get("profile") or {}}
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

    def _translate_stream_response(
        self,
        job_dir: Path,
        cached: Optional[Dict[str, Any]],
        *,
        job_id: str,
        text: str,
        block_id: str,
        target_language: str,
        source_hash: str,
        formulas: List[Dict[str, str]],
        profile_id: str,
        cache_key: str,
    ) -> None:
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
        if cached:
            self._send_sse_event({"result": {**cached, "cached": True}})
            return
        context = _job_context(job_dir, 5000)
        parts: List[str] = []
        try:
            try:
                for delta in translate_text_stream(text, target_language=target_language, context=context, formulas=formulas):
                    parts.append(delta)
                    if not self._send_sse_event({"delta": delta}):
                        return
                translated = "".join(parts).strip()
                if not translated:
                    raise RuntimeError("模型返回为空。")
                result = {
                    "text": translated,
                    "model": ai_status("translation").get("model"),
                    "profile_id": profile_id,
                    "formulas": formulas,
                }
            except Exception as exc:
                if parts:
                    self._send_sse_event({"error": f"翻译失败：{exc}"})
                    return
                # A gateway that rejects `stream: true` fails before the first
                # delta; retry once with the plain request so translation still
                # works there.
                result = translate_text(text, target_language=target_language, context=context, formulas=formulas)
            record = {
                **result,
                "cache_key": cache_key,
                "profile_id": profile_id,
                "block_id": block_id,
                "target_language": target_language,
                "source_hash": source_hash or hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "source_text": text,
                "formulas": formulas,
                "updated_at": utc_now(),
            }
            with _job_mutation(job_id):
                if STORE is not None:
                    current_dir = STORE.path(job_id)
                    if not current_dir:
                        raise PipelineError("任务不存在。")
                    job_dir = current_dir
                with TRANSLATION_LOCK:
                    records = [item for item in _translation_records(job_dir) if item.get("cache_key") != cache_key]
                    records.append(record)
                    _write_translation_records(job_dir, records)
            self._send_sse_event({"result": {**record, "cached": False}})
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
            # Chat gets the whole paper (block-tagged) instead of a preview so
            # the assistant can ground answers anywhere in the document.
            context = _job_context(job_dir, 120000)
            if selected:
                context = (
                    "用户当前在正文中选中了以下段落，请优先结合它作答：\n«选中开始»\n"
                    + selected[:6000]
                    + "\n«选中结束»\n\n论文全文（带页码与块编号）：\n"
                    + context
                )
            image = _chat_image_context(job_dir, payload.get("selected_image"))
            if payload.get("stream"):
                self._chat_stream_response(messages, context=context, image=image)
                return
            result = ai_chat(messages, context=context, image=image)
            self._send_json({"result": result})
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

    def _chat_stream_response(self, messages: List[dict], *, context: str, image: Optional[dict]) -> None:
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
            try:
                for delta in ai_chat_stream(messages, context=context, image=image):
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
                result = ai_chat(messages, context=context, image=image)
            self._send_sse_event({"result": result})
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
        try:
            form = _parse_multipart_form(self.rfile, content_type, content_length)
            item = next((entry for entry in form.get("file", []) if entry.filename), None)
            if item is None:
                raise PipelineError("没有找到名为 file 的 PDF 文件字段。")
            filename = os.path.basename(str(item.filename))
            if not filename.lower().endswith(".pdf"):
                raise PipelineError("当前版本只接受 .pdf 文件。")
            folder_values = form.get("folder_id", [])
            folder_id = folder_values[0].data.decode("utf-8", "replace").strip() if folder_values else ""
        except (ValueError, KeyError, TypeError, PipelineError) as exc:
            self._send_error_json(str(exc))
            return

        if folder_id:
            try:
                LIBRARY.validate_user_folder(folder_id)
            except LibraryValidationError as exc:
                self._send_error_json(str(exc))
                return

        incoming_dir: Optional[Path] = None
        try:
            incoming_dir = STORE.new_incoming_directory()
            staged_path = incoming_dir / "upload.pdf.part"
            digest = hashlib.sha256()
            size = 0
            with staged_path.open("wb") as handle:
                while True:
                    chunk = item.file.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise PipelineError(f"文件过大，当前上限为 {MAX_UPLOAD_BYTES // (1024 * 1024)} MB。")
                    digest.update(chunk)
                    handle.write(chunk)
                if size <= 0:
                    raise PipelineError("上传的 PDF 文件为空。")
                handle.flush()
                os.fsync(handle.fileno())
            record, deduplicated = STORE.commit_staged_upload(
                incoming_dir,
                filename,
                size,
                digest.hexdigest(),
                folder_id,
            )
            incoming_dir = None
        except (OSError, PipelineError, ValueError) as exc:
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
        if READONLY_MODE:
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
                capability = _parsing_provider_registry().get("local-mineru").capability()
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
        if READONLY_MODE:
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
    if API_ACCESS_TOKEN:
        provided = str(headers.get("X-My-Scholar-Api-Token") or "")
        if not hmac.compare_digest(provided, API_ACCESS_TOKEN):
            return "本地服务访问凭据无效。", HTTPStatus.UNAUTHORIZED
    try:
        bound_host = str(server.server_address[0]).lower()
        expected_port = int(server.server_address[1])
    except (AttributeError, IndexError, TypeError, ValueError):
        return "本地服务无法确认请求来源。", HTTPStatus.FORBIDDEN
    if bound_host not in LOOPBACK_HOSTS:
        return None
    if not _loopback_host_matches(str(headers.get("Host") or ""), expected_port):
        return "请求主机无效。", HTTPStatus.FORBIDDEN
    origin = str(headers.get("Origin") or "").strip()
    if origin and not _loopback_origin_matches(origin, expected_port):
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
                self._send_error_json("文献库正在安全切换，请稍候。", HTTPStatus.SERVICE_UNAVAILABLE)
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

if READONLY_MODE:
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

        connection = sqlite3.connect(":memory:")
        try:
            connection.execute("SELECT 1").fetchone()
        finally:
            connection.close()
        ssl.create_default_context()
        urllib.request.Request("https://example.invalid/")
        print(json.dumps({
            "ok": True,
            "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "arch": platform.machine(),
            "hashlib_scrypt": hasattr(hashlib, "scrypt"),
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
        print(f"My Scholar running at http://{args.host}:{actual_port}", flush=True)
        print(f"State directory: {DATA_ROOT}", flush=True)
        print(f"Library directory: {LIBRARY_ROOT}", flush=True)
        print(f"Workers: conversion={CONVERSION_WORKERS}, metadata={METADATA_WORKERS}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping My Scholar", flush=True)
        finally:
            httpd.server_close()
            for shutdown_signal, handler in previous_handlers.items():
                signal.signal(shutdown_signal, handler)
    except RuntimeError as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        for root_lock in reversed(root_locks):
            root_lock.release()


if __name__ == "__main__":
    main()
