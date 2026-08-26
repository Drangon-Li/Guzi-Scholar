"""Conversion job registry backed by the ``jobs/<job-id>`` artifact folders.

Split out of ``server.py``: this module owns the job lifecycle (creation,
deduplication, reflow generations and the two-phase permanent-delete journal)
and deliberately knows nothing about HTTP or the translation/annotation
stores. ``server.py`` re-exports the public names, so existing imports keep
working.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import threading
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from pipeline import PipelineError, utc_now
from runtime import METADATA_PENDING, METADATA_STATE_LOCK, READONLY_MODE

PERMANENT_DELETE_JOURNAL_NAME = ".permanent-delete-journal.json"
JOB_ID_RE = re.compile(r"^[a-f0-9]{12,40}$")
RENDER_GENERATION_RE = re.compile(r"^[1-9][0-9]{0,8}$")


class ReflowConflictError(PipelineError):
    """Raised when a job mutation collides with an in-flight reflow."""


class ReflowCancelledError(PipelineError):
    """Raised when a reflow run is cancelled while it is still working."""


ArtifactMigrator = Callable[[Path, Dict[str, Any]], Dict[str, Any]]

_artifact_migrator: Optional[ArtifactMigrator] = None


def set_artifact_migrator(migrator: Optional[ArtifactMigrator]) -> None:
    """Register the legacy-artifact migration run when a job is loaded.

    The migration rewrites translation caches and annotation indexes, so it
    lives in ``server.py`` next to those stores; JobStore only needs the hook.
    """
    global _artifact_migrator
    _artifact_migrator = migrator


def _read_json_file(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else default
    except (OSError, json.JSONDecodeError):
        return default


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
                if active_render is None and _artifact_migrator is not None:
                    manifest = _artifact_migrator(job_dir, manifest)
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
