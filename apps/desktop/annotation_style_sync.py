"""Apply semantic-action changes with durable, library-bound rollback copies."""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable


STYLE_FIELDS = ("label", "kind", "color")


class AnnotationStyleSyncError(RuntimeError):
    pass


class AnnotationStyleRecoveryRequiredError(AnnotationStyleSyncError):
    pass


def changed_action_fields(previous: dict, current: dict) -> dict[str, dict]:
    before = {item["id"]: item for item in previous.get("custom", [])}
    changes = {}
    for action in current.get("custom", []):
        old = before.get(action["id"], {})
        fields = {field: action[field] for field in STYLE_FIELDS if old.get(field) != action[field]}
        if fields:
            changes[action["id"]] = fields
    return changes


def _encoded(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def _sync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            os.chmod(temporary_path, 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        _sync_directory(path.parent)
    finally:
        temporary_path.unlink(missing_ok=True)


def _transaction_root(settings_path: Path) -> Path:
    return settings_path.parent / "annotation-style-transactions"


def _validate_target(path: Path, settings_path: Path, library_root: Path) -> None:
    if path == settings_path:
        return
    try:
        relative = path.relative_to(library_root / "jobs")
    except ValueError as exc:
        raise AnnotationStyleSyncError("批注同步目标不属于当前文献库。") from exc
    if len(relative.parts) < 2 or relative.parts[1:] not in {
        ("annotations.json",), ("content", "annotations", "annotations.json"),
    }:
        raise AnnotationStyleSyncError("批注同步目标路径无效。")


def _restore(transaction: Path, journal: dict, settings_path: Path, library_root: Path) -> None:
    journal["state"] = "rolling_back"
    _atomic_write(transaction / "journal.json", _encoded(journal))
    for item in reversed(journal["files"]):
        target = Path(item["target"]).resolve()
        _validate_target(target, settings_path, library_root)
        backup = transaction / item["backup"]
        if backup.parent != transaction:
            raise AnnotationStyleSyncError("批注同步备份路径无效。")
        if item["existed"]:
            _atomic_write(target, backup.read_bytes())
        elif target.exists():
            target.unlink(missing_ok=True)
            _sync_directory(target.parent)
    journal["state"] = "rolled_back"
    _atomic_write(transaction / "journal.json", _encoded(journal))


def recover_pending_transactions(settings_path: Path, library_root: Path) -> list[str]:
    settings_path = settings_path.resolve()
    library_root = library_root.resolve()
    recovered = []
    for journal_path in sorted(_transaction_root(settings_path).glob("*/journal.json")):
        try:
            journal = json.loads(journal_path.read_bytes())
            if journal.get("library_root") != str(library_root) or journal.get("settings_path") != str(settings_path):
                continue
            if journal.get("state") not in {"pending", "rolling_back"}:
                continue
            _restore(journal_path.parent, journal, settings_path, library_root)
            recovered.append(str(journal_path.parent))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise AnnotationStyleSyncError(f"批注同步恢复失败，备份保留于：{journal_path.parent}") from exc
    return recovered


def commit_style_sync(
    settings_path: Path,
    library_root: Path,
    jobs: Iterable[tuple[str, Path]],
    settings: dict,
    changes: dict[str, dict],
    is_ai_annotation: Callable[[dict], bool],
) -> dict:
    settings_path = settings_path.resolve()
    library_root = library_root.resolve()
    replacements = []
    changed_jobs = []
    annotation_count = 0
    for job_id, job_dir in jobs:
        path = (job_dir / "annotations.json").resolve()
        _validate_target(path, settings_path, library_root)
        if not path.is_file():
            continue
        try:
            annotations = json.loads(path.read_bytes())
        except (ValueError, UnicodeError) as exc:
            raise AnnotationStyleSyncError(f"批注文件格式无效：{path}") from exc
        if not isinstance(annotations, list):
            raise AnnotationStyleSyncError(f"批注文件格式无效：{path}")
        changed = 0
        for item in annotations:
            if not isinstance(item, dict) or is_ai_annotation(item):
                continue
            fields = changes.get(item.get("action_id"))
            if fields and any(item.get(field) != value for field, value in fields.items()):
                item.update(fields)
                changed += 1
        if not changed:
            continue
        content_path = (job_dir / "content" / "annotations" / "annotations.json").resolve()
        _validate_target(content_path, settings_path, library_root)
        data = _encoded(annotations)
        replacements.extend(((path, data), (content_path, data)))
        changed_jobs.append(job_id)
        annotation_count += changed
    replacements.append((settings_path, _encoded(settings)))
    root = _transaction_root(settings_path)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    transaction = root / uuid.uuid4().hex
    transaction.mkdir(mode=0o700)
    journal = {"version": 1, "state": "pending", "library_root": str(library_root),
               "settings_path": str(settings_path), "files": []}
    for index, (target, _data) in enumerate(replacements):
        existed = target.exists()
        backup = f"{index:04d}.before"
        if existed:
            _atomic_write(transaction / backup, target.read_bytes())
        journal["files"].append({"target": str(target), "backup": backup, "existed": existed})
    _atomic_write(transaction / "journal.json", _encoded(journal))
    _sync_directory(root)
    try:
        for target, data in replacements:
            _atomic_write(target, data)
        journal["state"] = "committed"
        _atomic_write(transaction / "journal.json", _encoded(journal))
    except Exception as exc:
        journal["state"] = "pending"
        try:
            _restore(transaction, journal, settings_path, library_root)
        except Exception as recovery_error:
            raise AnnotationStyleRecoveryRequiredError(f"批注同步失败，待恢复备份保留于：{transaction}") from recovery_error
        raise AnnotationStyleSyncError(f"批注同步失败，已恢复原文件；备份保留于：{transaction}") from exc
    return {"updates": changes, "job_ids": changed_jobs, "annotations": annotation_count,
            "backup_path": str(transaction)}
