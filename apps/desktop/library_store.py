"""Versioned local metadata store for the My Scholar literature library.

The conversion job directories remain the source of truth for PDFs and reader
artifacts.  This module only stores user-owned organization metadata in one
small, atomically-written JSON document.
"""

from __future__ import annotations

import copy
import json
import math
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from bibliography import BIBLIOGRAPHIC_FIELDS, INTEGER_FIELDS, LIST_FIELDS, empty_bibliographic_metadata

SCHEMA_VERSION = 5
SYSTEM_FOLDER_IDS = {"system-all", "system-unfiled", "system-trash"}
READING_STATUSES = ("未开始", "计划中", "阅读中", "已完成")
PROPERTY_TYPES = {"select", "multi-select", "rating", "text"}
DEFAULT_GROUP_BY = "reading_status"
RETIRED_DISPLAY_COLUMN_IDS = {"status"}
COLUMN_WIDTH_MAX = 520
COLUMN_MIN_WIDTHS = {
    "name": 180,
    "title": 160,
    "research_topic": 116,
    "importance": 100,
    "reading_status": 96,
    "venue": 110,
}


# Versioned schema defaults and normalization helpers.
def _default_display() -> Dict[str, Any]:
    # The title is already represented by the filename/name column, so it is
    # intentionally not a default column. Users can still add it back.
    return {
        "group_by": DEFAULT_GROUP_BY,
        "columns": [
            {"id": "name", "label": "名称", "visible": True, "system": True, "order": 0},
            {"id": "research_topic", "label": "研究主题", "visible": True, "system": True, "order": 1},
            {"id": "importance", "label": "重要程度", "visible": True, "system": True, "order": 2},
            {"id": "reading_status", "label": "阅读状态", "visible": True, "system": True, "order": 3},
            {"id": "venue", "label": "接收/来源", "visible": True, "system": True, "order": 4},
            {"id": "title", "label": "标题", "visible": False, "system": True, "order": 5},
        ],
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default_state() -> Dict[str, Any]:
    now = utc_now()
    return {
        "version": SCHEMA_VERSION,
        "folders": [
            {"id": "system-all", "name": "全部文献", "parent_id": None, "system": True, "sort_order": 0, "created_at": now},
            {"id": "system-unfiled", "name": "未分类", "parent_id": None, "system": True, "sort_order": 1, "created_at": now},
            {"id": "system-trash", "name": "回收站", "parent_id": None, "system": True, "sort_order": 2, "created_at": now},
        ],
        "properties": [
            {"id": "reading_status", "label": "阅读状态", "type": "select", "options": list(READING_STATUSES), "system": True, "hidden": False, "order": 0},
            {"id": "importance", "label": "重要程度", "type": "rating", "max": 5, "system": True, "hidden": False, "order": 1},
            {"id": "research_topic", "label": "研究主题", "type": "multi-select", "options": [], "system": True, "hidden": False, "order": 2},
            {"id": "venue", "label": "接收/来源", "type": "text", "options": [], "system": True, "hidden": False, "order": 3},
        ],
        "display": _default_display(),
        "items": {},
        "permanently_deleted": [],
        "views": [
            {"id": "view-all", "name": "全部文献", "filters": [], "sort_by": "updated_at", "sort_direction": "desc", "system": True, "created_at": now},
            {"id": "view-unread", "name": "未开始", "filters": [{"field": "reading_status", "operator": "equals", "value": "未开始"}], "sort_by": "updated_at", "sort_direction": "desc", "system": True, "created_at": now},
            {"id": "view-planned", "name": "计划中", "filters": [{"field": "reading_status", "operator": "equals", "value": "计划中"}], "sort_by": "updated_at", "sort_direction": "desc", "system": True, "created_at": now},
            {"id": "view-reading", "name": "阅读中", "filters": [{"field": "reading_status", "operator": "equals", "value": "阅读中"}], "sort_by": "updated_at", "sort_direction": "desc", "system": True, "created_at": now},
            {"id": "view-done", "name": "已完成", "filters": [{"field": "reading_status", "operator": "equals", "value": "已完成"}], "sort_by": "updated_at", "sort_direction": "desc", "system": True, "created_at": now},
            {"id": "view-important", "name": "高重要度", "filters": [{"field": "importance", "operator": "gte", "value": 4}], "sort_by": "importance", "sort_direction": "desc", "system": True, "created_at": now},
        ],
        "updated_at": now,
    }


def _as_list(value: Any) -> List[Any]:
    return list(value) if isinstance(value, list) else []


def _column_min_width(column_id: str) -> int:
    return int(COLUMN_MIN_WIDTHS.get(column_id, 96))


def _normalize_column_width(value: Any, column_id: str, *, strict: bool = False) -> Optional[int]:
    """Normalize a persisted/user-supplied column width in CSS pixels.

    Missing or explicit ``null`` widths mean that the responsive grid should
    choose the width. Existing malformed files are repaired by dropping the
    value; API payloads receive a validation error instead.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, bool):
        if strict:
            raise LibraryValidationError("列宽必须是数字。")
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        if strict:
            raise LibraryValidationError("列宽必须是数字。") from None
        return None
    minimum = _column_min_width(column_id)
    if not math.isfinite(numeric):
        if strict:
            raise LibraryValidationError("列宽必须是有限数字。")
        return None
    if strict and (numeric < minimum or numeric > COLUMN_WIDTH_MAX):
        raise LibraryValidationError(f"列宽必须在 {minimum} 到 {COLUMN_WIDTH_MAX} 像素之间。")
    return max(minimum, min(COLUMN_WIDTH_MAX, int(round(numeric))))


def _display_column_definitions(state: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    definitions = {str(item["id"]): copy.deepcopy(item) for item in _default_display()["columns"]}
    for item in state.get("properties", []):
        if isinstance(item, dict) and item.get("id"):
            property_id = str(item["id"])
            if property_id in definitions:
                # Built-in columns own their identifiers and labels even if a
                # damaged legacy file contains a colliding property record.
                continue
            definitions[property_id] = {
                "id": property_id,
                "label": str(item.get("label") or property_id),
                "system": bool(item.get("system", False)),
                "visible": not bool(item.get("hidden", False)),
            }
    return definitions


# Thread-safe CRUD and schema migration for library.json.
class LibraryValidationError(ValueError):
    """User-editable library metadata failed validation."""


class LibraryStore:
    def __init__(self, data_root: Path) -> None:
        self.data_root = Path(data_root)
        self.path = self.data_root / "library.json"
        self.lock = threading.RLock()
        self._backup_initialized = False
        self._loaded_from_backup = False
        self._migration_required = False
        self.recovery_warning = ""
        self.state = self._load()
        if self._loaded_from_backup:
            # The backup is the last known-good copy. Rebuild the primary
            # without first replacing that backup with the corrupt file.
            self._backup_initialized = True
        if self._migration_required:
            self._save_locked(backup=not self._loaded_from_backup)

    def _load(self) -> Dict[str, Any]:
        raw: Any = None
        loaded_from_backup = False
        corrupt_paths: List[Path] = []
        for candidate in (self.path, self.path.with_suffix(".json.bak")):
            if not candidate.is_file():
                continue
            try:
                raw = json.loads(candidate.read_text(encoding="utf-8"))
                loaded_from_backup = candidate != self.path
                self._loaded_from_backup = loaded_from_backup
                break
            except json.JSONDecodeError:
                corrupt_paths.append(candidate)
                continue
            except OSError:
                continue
        if corrupt_paths:
            archived = self._archive_corrupt_files(corrupt_paths)
            if archived:
                self.recovery_warning = "文献库索引损坏，已保留损坏副本并从可用数据恢复。"
        if not isinstance(raw, dict):
            # A malformed metadata file must not make the PDFs inaccessible.
            return _default_state()
        try:
            stored_version = int(raw.get("version", 0)) if isinstance(raw, dict) else 0
        except (TypeError, ValueError):
            stored_version = 0
        self._migration_required = loaded_from_backup or stored_version < SCHEMA_VERSION
        normalized = self._normalize(raw)
        if isinstance(raw, dict) and raw.get("display") != normalized.get("display"):
            # Persist shape repairs even when a previous build already used
            # the current version number but omitted a newly added preference.
            self._migration_required = True
        return normalized

    @staticmethod
    def _archive_corrupt_files(paths: Iterable[Path]) -> List[Path]:
        archived: List[Path] = []
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        for path in paths:
            if not path.is_file():
                continue
            target = path.with_name(f"{path.name}.corrupt-{stamp}-{uuid.uuid4().hex[:6]}")
            try:
                os.replace(path, target)
                archived.append(target)
            except OSError:
                continue
        return archived

    @staticmethod
    def _normalize(raw: Any) -> Dict[str, Any]:
        state = _default_state()
        if not isinstance(raw, dict):
            return state
        state["version"] = SCHEMA_VERSION
        for key in ("folders", "properties", "views"):
            if isinstance(raw.get(key), list):
                state[key] = copy.deepcopy(raw[key])
        raw_display = raw.get("display")
        if isinstance(raw_display, dict):
            state["display"] = {
                "group_by": raw_display.get("group_by", DEFAULT_GROUP_BY),
                "columns": [copy.deepcopy(item) for item in raw_display.get("columns", []) if isinstance(item, dict)],
            }
        if isinstance(raw.get("items"), dict):
            state["items"] = copy.deepcopy(raw["items"])
            for item in state["items"].values():
                if isinstance(item, dict):
                    item["metadata"] = LibraryStore._normalize_metadata(item.get("metadata"))
                    item["alias"] = str(item.get("alias") or "").strip()[:200]
        deleted_ids = []
        for value in _as_list(raw.get("permanently_deleted")):
            value = str(value or "").strip().lower()
            if value and value not in deleted_ids and len(value) <= 40:
                deleted_ids.append(value)
        state["permanently_deleted"] = deleted_ids
        for job_id in deleted_ids:
            state["items"].pop(job_id, None)
        state["updated_at"] = str(raw.get("updated_at") or state["updated_at"])
        # Keep the system records present even if an older build omitted one.
        folder_ids = {str(item.get("id")) for item in state["folders"] if isinstance(item, dict)}
        for required in _default_state()["folders"]:
            if required["id"] not in folder_ids:
                state["folders"].append(required)
        property_ids = {str(item.get("id")) for item in state["properties"] if isinstance(item, dict)}
        for required in _default_state()["properties"]:
            if required["id"] not in property_ids:
                state["properties"].append(required)
        # The status vocabulary belongs to the code, not to the persisted
        # record: a library saved before a status existed must still offer it.
        for prop in state["properties"]:
            if isinstance(prop, dict) and prop.get("id") == "reading_status":
                prop["options"] = list(READING_STATUSES)
        default_views = _default_state()["views"]
        view_ids = [str(item.get("id")) for item in state["views"] if isinstance(item, dict)]
        for index, required in enumerate(default_views):
            if required["id"] in view_ids:
                continue
            # Slot a newly introduced system view next to its neighbours so the
            # sidebar keeps the reading order instead of appending it at the end.
            anchor = next((view_ids.index(previous["id"]) for previous in reversed(default_views[:index]) if previous["id"] in view_ids), -1)
            state["views"].insert(anchor + 1, copy.deepcopy(required))
            view_ids.insert(anchor + 1, required["id"])
        definitions = _display_column_definitions(state)
        default_columns = _default_display()["columns"]
        columns = state.setdefault("display", {}).setdefault("columns", [])
        if not isinstance(columns, list):
            columns = []
            state["display"]["columns"] = columns
        existing_columns = {str(item.get("id")) for item in columns if isinstance(item, dict)}
        for required in default_columns:
            if required["id"] not in existing_columns:
                columns.append(copy.deepcopy(required))
        normalized_columns = []
        seen_column_ids = set()
        for column in columns:
            column_id = str(column.get("id") or "").strip()
            if not column_id or column_id in seen_column_ids or column_id not in definitions:
                continue
            seen_column_ids.add(column_id)
            definition = definitions[column_id]
            normalized = copy.deepcopy(column)
            normalized["id"] = column_id
            normalized["label"] = str(column.get("label") or definition.get("label") or column_id)[:80]
            normalized["visible"] = bool(column.get("visible", True))
            normalized["system"] = bool(definition.get("system", False))
            normalized["order"] = len(normalized_columns)
            if "width" in column:
                width = _normalize_column_width(column.get("width"), column_id)
                if width is not None:
                    normalized["width"] = width
                else:
                    normalized.pop("width", None)
            else:
                normalized.pop("width", None)
            normalized_columns.append(normalized)
        state["display"]["columns"] = normalized_columns
        group_by = str(state["display"].get("group_by") or DEFAULT_GROUP_BY).strip()
        state["display"]["group_by"] = group_by if group_by in definitions else DEFAULT_GROUP_BY
        return state

    def _save_locked(self, *, backup: bool = False) -> None:
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.state["version"] = SCHEMA_VERSION
        self.state["updated_at"] = utc_now()
        if (backup or not self._backup_initialized) and self.path.is_file():
            backup_path = self.path.with_suffix(".json.bak")
            try:
                shutil.copy2(self.path, backup_path)
                self._backup_initialized = True
            except OSError:
                pass
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(self.state, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)
        try:
            directory_fd = os.open(self.data_root, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    def save(self, *, backup: bool = False) -> None:
        with self.lock:
            self._save_locked(backup=backup)

    @staticmethod
    def _job_defaults(job: Dict[str, Any]) -> Dict[str, Any]:
        now = str(job.get("updated_at") or job.get("created_at") or utc_now())
        return {
            "folder_ids": [],
            "alias": "",
            "values": {"reading_status": "未开始", "importance": 0, "research_topic": [], "venue": ""},
            "metadata": empty_bibliographic_metadata(),
            "progress": {"percent": 0, "page": 1, "scroll_top": 0, "updated_at": now},
            "deleted_at": None,
            "created_at": str(job.get("created_at") or now),
            "updated_at": now,
            "job_updated_at": str(job.get("updated_at") or now),
        }

    @staticmethod
    def _normalize_metadata(raw: Any) -> Dict[str, Any]:
        metadata = empty_bibliographic_metadata()
        if not isinstance(raw, dict):
            return metadata
        fields = raw.get("fields") if isinstance(raw.get("fields"), dict) else {}
        for field in BIBLIOGRAPHIC_FIELDS:
            if field not in fields:
                continue
            value = fields[field]
            if field in LIST_FIELDS:
                metadata["fields"][field] = [str(item).strip()[:500] for item in _as_list(value) if str(item).strip()][:100]
            elif field in INTEGER_FIELDS:
                try:
                    metadata["fields"][field] = int(value) if value not in (None, "") else None
                except (TypeError, ValueError):
                    metadata["fields"][field] = None
            else:
                metadata["fields"][field] = str(value or "")[:12000 if field == "abstract" else 2000]
        if isinstance(raw.get("sources"), dict):
            metadata["sources"] = copy.deepcopy(raw["sources"])
        metadata["locked_fields"] = [str(field) for field in _as_list(raw.get("locked_fields")) if str(field) in BIBLIOGRAPHIC_FIELDS]
        metadata["candidates"] = copy.deepcopy(_as_list(raw.get("candidates"))[:5])
        status = str(raw.get("status") or "not-run")
        metadata["status"] = status if status in {"not-run", "retrieving", "local", "complete", "needs-review", "failed"} else "not-run"
        metadata["retrieved_at"] = str(raw.get("retrieved_at") or "") or None
        metadata["error"] = str(raw.get("error") or "")[:500]
        return metadata

    def sync_jobs(self, jobs: Iterable[Dict[str, Any]]) -> bool:
        """Idempotently add job ids to the library without touching artifacts."""
        changed = False
        with self.lock:
            for job in jobs:
                job_id = str(job.get("job_id") or "").strip()
                if not job_id:
                    continue
                if job_id in self.state.get("permanently_deleted", []):
                    # A stale worker or GET snapshot must not recreate an item
                    # after its artifacts and metadata were permanently removed.
                    if self.state["items"].pop(job_id, None) is not None:
                        changed = True
                    continue
                item = self.state["items"].get(job_id)
                if not isinstance(item, dict):
                    item = self._job_defaults(job)
                    self.state["items"][job_id] = item
                    changed = True
                elif not isinstance(item.get("metadata"), dict):
                    item["metadata"] = empty_bibliographic_metadata()
                    changed = True
                if item.get("deleted_at") and job.get("status") == "completed":
                    # Preserve an explicit trash choice; a server restart must
                    # not resurrect a document merely because its job exists.
                    continue
                if item.get("job_updated_at") != job.get("updated_at") and job.get("updated_at"):
                    item["job_updated_at"] = str(job["updated_at"])
                    changed = True
            if changed:
                self._save_locked()
        return changed

    def snapshot(self, jobs: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
        # ``jobs`` is often a list, but accepting any iterable is useful for
        # callers that stream the JobStore. Materialize it once so syncing and
        # joining the public job records cannot consume different views.
        jobs = list(jobs)
        self.sync_jobs(jobs)
        with self.lock:
            result = copy.deepcopy(self.state)
        job_map = {str(job.get("job_id")): dict(job) for job in jobs if job.get("job_id")}
        for job_id, item in result["items"].items():
            if job_id in job_map:
                item["job"] = job_map[job_id]
        result["folder_counts"] = self.folder_counts(result, include_trash=False)
        return result

    def display(self) -> Dict[str, Any]:
        with self.lock:
            return copy.deepcopy(self.state.get("display") or _default_display())

    def update_display(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(payload, dict):
            raise LibraryValidationError("显示配置必须是对象。")
        has_columns = "columns" in payload
        has_group_by = "group_by" in payload
        if not has_columns and not has_group_by:
            raise LibraryValidationError("显示配置至少需要列或分类字段。")
        columns = payload.get("columns") if has_columns else None
        if has_columns and not isinstance(columns, list):
            raise LibraryValidationError("列配置必须是数组。")
        with self.lock:
            current_columns = self.state.get("display", {}).get("columns", [])
            known = {str(item.get("id")): item for item in current_columns if isinstance(item, dict) and item.get("id")}
            definitions = _display_column_definitions(self.state)
            allowed_ids = set(definitions)
            normalized = []
            seen = set()
            source_columns = columns if has_columns else current_columns
            for raw in source_columns:
                if not isinstance(raw, dict):
                    continue
                column_id = str(raw.get("id") or "").strip()
                if not column_id or column_id in seen or len(column_id) > 100:
                    continue
                if column_id in RETIRED_DISPLAY_COLUMN_IDS:
                    continue
                if column_id not in allowed_ids:
                    raise LibraryValidationError(f"未知列：{column_id}")
                definition = definitions[column_id]
                previous = known.get(column_id, {})
                label = str(raw.get("label") or previous.get("label") or definition.get("label") or column_id).strip()[:80]
                if not label:
                    raise LibraryValidationError("列名称不能为空。")
                normalized.append({
                    "id": column_id,
                    "label": label,
                    "visible": bool(raw.get("visible", True)),
                    "system": bool(definition.get("system", previous.get("system", False))),
                    "order": len(normalized),
                })
                if "width" in raw:
                    width = _normalize_column_width(raw.get("width"), column_id, strict=True)
                    if width is not None:
                        normalized[-1]["width"] = width
                elif "width" in previous:
                    width = _normalize_column_width(previous.get("width"), column_id)
                    if width is not None:
                        normalized[-1]["width"] = width
                seen.add(column_id)
            if not normalized:
                raise LibraryValidationError("至少保留一列。")

            # Keep the built-in columns addressable even when an older client
            # submits only the user-selected subset. Visibility is still
            # controlled explicitly by sending ``visible: false``.
            for required in _default_display()["columns"]:
                column_id = str(required["id"])
                if column_id in seen:
                    continue
                previous = known.get(column_id, {})
                normalized.append({
                    "id": column_id,
                    "label": str(previous.get("label") or required["label"])[:80],
                    "visible": bool(previous.get("visible", required.get("visible", True))),
                    "system": True,
                    "order": len(normalized),
                })
                if "width" in previous:
                    width = _normalize_column_width(previous.get("width"), column_id)
                    if width is not None:
                        normalized[-1]["width"] = width
                seen.add(column_id)
            group_by = str(self.state.get("display", {}).get("group_by") or DEFAULT_GROUP_BY).strip()
            if group_by not in allowed_ids:
                group_by = DEFAULT_GROUP_BY
            if has_group_by:
                candidate = str(payload.get("group_by") or "").strip()
                if candidate in RETIRED_DISPLAY_COLUMN_IDS:
                    candidate = DEFAULT_GROUP_BY
                elif candidate not in allowed_ids:
                    raise LibraryValidationError(f"未知分类列：{candidate or '（空）'}")
                group_by = candidate
            self.state["display"] = {"group_by": group_by, "columns": normalized}
            self._save_locked()
            return copy.deepcopy(self.state["display"])

    @staticmethod
    def folder_counts(state: Dict[str, Any], *, include_trash: bool = False) -> Dict[str, int]:
        counts = {str(folder.get("id")): 0 for folder in _as_list(state.get("folders")) if isinstance(folder, dict)}
        for item in (state.get("items") or {}).values() if isinstance(state.get("items"), dict) else []:
            if not isinstance(item, dict) or (item.get("deleted_at") and not include_trash):
                continue
            for folder_id in item.get("folder_ids", []) if isinstance(item.get("folder_ids"), list) else []:
                counts[str(folder_id)] = counts.get(str(folder_id), 0) + 1
        counts["system-all"] = sum(1 for item in (state.get("items") or {}).values() if isinstance(item, dict) and (include_trash or not item.get("deleted_at")))
        counts["system-unfiled"] = sum(1 for item in (state.get("items") or {}).values() if isinstance(item, dict) and not item.get("deleted_at") and not item.get("folder_ids"))
        counts["system-trash"] = sum(1 for item in (state.get("items") or {}).values() if isinstance(item, dict) and item.get("deleted_at"))
        return counts

    def _find_folder(self, folder_id: str) -> Dict[str, Any]:
        for folder in self.state["folders"]:
            if isinstance(folder, dict) and str(folder.get("id")) == folder_id:
                return folder
        raise LibraryValidationError("文件夹不存在。")

    def create_folder(self, name: str, parent_id: Optional[str] = None) -> Dict[str, Any]:
        name = str(name or "").strip()
        if not name or len(name) > 120:
            raise LibraryValidationError("文件夹名称不能为空且不能超过 120 个字符。")
        with self.lock:
            if parent_id:
                parent = self._find_folder(parent_id)
                if parent.get("system"):
                    raise LibraryValidationError("自定义文件夹不能嵌套在系统文件夹下。")
            folder = {"id": f"folder-{uuid.uuid4().hex[:12]}", "name": name, "parent_id": parent_id, "system": False, "sort_order": len(self.state["folders"]), "created_at": utc_now()}
            self.state["folders"].append(folder)
            self._save_locked()
            return copy.deepcopy(folder)

    def update_folder(self, folder_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            folder = self._find_folder(folder_id)
            if folder.get("system"):
                raise LibraryValidationError("系统文件夹不能修改。")
            if "name" in payload:
                name = str(payload.get("name") or "").strip()
                if not name or len(name) > 120:
                    raise LibraryValidationError("文件夹名称不能为空且不能超过 120 个字符。")
                folder["name"] = name
            if "parent_id" in payload:
                parent_id = payload.get("parent_id") or None
                if parent_id == folder_id:
                    raise LibraryValidationError("文件夹不能嵌套到自身。")
                if parent_id:
                    parent = self._find_folder(str(parent_id))
                    if parent.get("system"):
                        raise LibraryValidationError("自定义文件夹不能嵌套在系统文件夹下。")
                    ancestor_id = str(parent_id)
                    visited = set()
                    while ancestor_id and ancestor_id not in visited:
                        if ancestor_id == folder_id:
                            raise LibraryValidationError("文件夹不能嵌套到自己的子文件夹中。")
                        visited.add(ancestor_id)
                        ancestor = self._find_folder(ancestor_id)
                        ancestor_id = str(ancestor.get("parent_id") or "")
                folder["parent_id"] = parent_id
            self._save_locked()
            return copy.deepcopy(folder)

    def delete_folder(self, folder_id: str) -> None:
        with self.lock:
            folder = self._find_folder(folder_id)
            if folder.get("system"):
                raise LibraryValidationError("系统文件夹不能删除。")
            parent_id = folder.get("parent_id")
            self.state["folders"] = [item for item in self.state["folders"] if item.get("id") != folder_id]
            for child in self.state["folders"]:
                if isinstance(child, dict) and child.get("parent_id") == folder_id:
                    child["parent_id"] = parent_id
            for item in self.state["items"].values():
                if isinstance(item, dict):
                    item["folder_ids"] = [value for value in item.get("folder_ids", []) if value != folder_id]
            self._save_locked()

    def _find_property(self, property_id: str) -> Dict[str, Any]:
        for prop in self.state["properties"]:
            if isinstance(prop, dict) and str(prop.get("id")) == property_id:
                return prop
        raise LibraryValidationError("属性不存在。")

    def _property_label_taken(self, label: str, *, except_id: str = "") -> bool:
        # A custom property with a system column's name renders as a second
        # column with the same header, which reads as a bug rather than a choice.
        wanted = label.strip().casefold()
        taken = {str(column.get("label") or "").strip().casefold() for column in _default_display()["columns"]}
        taken.update(
            str(prop.get("label") or "").strip().casefold()
            for prop in self.state["properties"]
            if isinstance(prop, dict) and str(prop.get("id")) != except_id
        )
        return wanted in taken

    def create_property(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        label = str(payload.get("label") or "").strip()
        prop_type = str(payload.get("type") or "text")
        if not label or len(label) > 80:
            raise LibraryValidationError("属性名称不能为空且不能超过 80 个字符。")
        if prop_type not in PROPERTY_TYPES:
            raise LibraryValidationError("不支持的属性类型。")
        options = [str(item).strip() for item in _as_list(payload.get("options")) if str(item).strip()][:100]
        with self.lock:
            if self._property_label_taken(label):
                raise LibraryValidationError("已有同名的属性或系统列，请换一个名称。")
            prop = {"id": f"property-{uuid.uuid4().hex[:12]}", "label": label, "type": prop_type, "options": options, "system": False, "hidden": False, "order": len(self.state["properties"]), "created_at": utc_now()}
            if prop_type == "rating":
                try:
                    prop["max"] = max(1, min(10, int(payload.get("max", 5) or 5)))
                except (TypeError, ValueError) as exc:
                    raise LibraryValidationError("评分属性的最大值必须是 1 到 10 的整数。") from exc
            self.state["properties"].append(prop)
            columns = self.state.setdefault("display", {}).setdefault("columns", [])
            columns.append({
                "id": prop["id"],
                "label": label,
                "visible": bool(payload.get("visible", True)),
                "system": False,
                "order": len(columns),
            })
            self._save_locked()
        return copy.deepcopy(prop)

    def update_property(self, property_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            prop = self._find_property(property_id)
            if "label" in payload and not prop.get("system"):
                label = str(payload.get("label") or "").strip()
                if not label or len(label) > 80:
                    raise LibraryValidationError("属性名称不能为空且不能超过 80 个字符。")
                if self._property_label_taken(label, except_id=property_id):
                    raise LibraryValidationError("已有同名的属性或系统列，请换一个名称。")
                prop["label"] = label
            if "hidden" in payload:
                prop["hidden"] = bool(payload.get("hidden"))
            if "options" in payload and prop.get("type") in {"select", "multi-select"}:
                prop["options"] = [str(item).strip() for item in _as_list(payload.get("options")) if str(item).strip()][:100]
            column = next(
                (item for item in self.state.get("display", {}).get("columns", []) if str(item.get("id")) == property_id),
                None,
            )
            if column is not None and "label" in payload and not prop.get("system"):
                column["label"] = prop["label"]
            self._save_locked()
            return copy.deepcopy(prop)

    def delete_property(self, property_id: str) -> None:
        with self.lock:
            prop = self._find_property(property_id)
            if prop.get("system"):
                raise LibraryValidationError("系统属性不能删除，只能隐藏。")
            self.state["properties"] = [item for item in self.state["properties"] if item.get("id") != property_id]
            self.state["display"]["columns"] = [
                column for column in self.state.get("display", {}).get("columns", [])
                if str(column.get("id")) != property_id
            ]
            if self.state.get("display", {}).get("group_by") == property_id:
                self.state["display"]["group_by"] = DEFAULT_GROUP_BY
            for index, column in enumerate(self.state["display"]["columns"]):
                column["order"] = index
            for item in self.state["items"].values():
                if isinstance(item, dict):
                    item.setdefault("values", {}).pop(property_id, None)
            self._save_locked()

    def update_item(self, job_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            if str(job_id or "").strip() in self.state.get("permanently_deleted", []):
                raise LibraryValidationError("文献已被彻底清除。")
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                item = self._job_defaults({"job_id": job_id})
                self.state["items"][job_id] = item
            if "folder_ids" in payload:
                folder_ids = []
                for folder_id in _as_list(payload.get("folder_ids")):
                    folder_id = str(folder_id)
                    if folder_id in SYSTEM_FOLDER_IDS:
                        continue
                    self._find_folder(folder_id)
                    if folder_id not in folder_ids:
                        folder_ids.append(folder_id)
                item["folder_ids"] = folder_ids
            if "values" in payload:
                if not isinstance(payload["values"], dict):
                    raise LibraryValidationError("属性值必须是对象。")
                values = item.setdefault("values", {})
                for property_id, value in payload["values"].items():
                    prop = self._find_property(str(property_id))
                    values[str(property_id)] = self._validate_value(prop, value)
            if "progress" in payload:
                item["progress"] = self._validate_progress(payload["progress"], item.get("progress"))
            if "alias" in payload:
                # A display name the reader chooses for the list; the bibliographic
                # title in the metadata stays what the paper is actually called.
                alias = str(payload.get("alias") or "").strip()
                if len(alias) > 200:
                    raise LibraryValidationError("显示名称不能超过 200 个字符。")
                item["alias"] = alias
            item["updated_at"] = utc_now()
            self._save_locked()
            return copy.deepcopy(item)

    def add_to_folder(self, job_id: str, folder_id: str) -> Dict[str, Any]:
        """Add an existing item to one user folder without removing memberships."""
        folder_id = str(folder_id or "").strip()
        if not folder_id or folder_id in SYSTEM_FOLDER_IDS:
            with self.lock:
                if str(job_id or "").strip() in self.state.get("permanently_deleted", []):
                    raise LibraryValidationError("文献已被彻底清除。")
                item = self.state["items"].get(job_id)
                return copy.deepcopy(item) if isinstance(item, dict) else self._job_defaults({"job_id": job_id})
        with self.lock:
            self._find_folder(folder_id)
            if str(job_id or "").strip() in self.state.get("permanently_deleted", []):
                raise LibraryValidationError("文献已被彻底清除。")
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                item = self._job_defaults({"job_id": job_id})
                self.state["items"][job_id] = item
            folder_ids = list(item.get("folder_ids") or [])
            if folder_id not in folder_ids:
                folder_ids.append(folder_id)
                item["folder_ids"] = folder_ids
                item["updated_at"] = utc_now()
                self._save_locked()
            return copy.deepcopy(item)

    def validate_user_folder(self, folder_id: str) -> None:
        folder_id = str(folder_id or "").strip()
        if not folder_id or folder_id in SYSTEM_FOLDER_IDS:
            return
        with self.lock:
            self._find_folder(folder_id)

    def get_metadata(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                raise LibraryValidationError("文献不存在。")
            metadata = self._normalize_metadata(item.get("metadata"))
            item["metadata"] = metadata
            return copy.deepcopy(metadata)

    @staticmethod
    def _validate_metadata_fields(value: Any) -> Dict[str, Any]:
        if not isinstance(value, dict):
            raise LibraryValidationError("书目元数据字段必须是对象。")
        validated: Dict[str, Any] = {}
        for field, raw in value.items():
            field = str(field)
            if field not in BIBLIOGRAPHIC_FIELDS:
                raise LibraryValidationError(f"不支持的书目字段：{field}")
            if field in LIST_FIELDS:
                entries = []
                for entry in _as_list(raw):
                    entry = str(entry).strip()
                    if entry and entry not in entries:
                        entries.append(entry[:500])
                validated[field] = entries[:100]
            elif field in INTEGER_FIELDS:
                if raw in (None, ""):
                    validated[field] = None
                else:
                    try:
                        year = int(raw)
                    except (TypeError, ValueError) as exc:
                        raise LibraryValidationError("出版年份必须是整数。") from exc
                    if year < 1000 or year > datetime.now().year + 2:
                        raise LibraryValidationError("出版年份超出合理范围。")
                    validated[field] = year
            else:
                validated[field] = str(raw or "").strip()[:12000 if field == "abstract" else 2000]
        return validated

    def update_metadata(self, job_id: str, payload: Dict[str, Any], *, lock_changed: bool = True) -> Dict[str, Any]:
        fields = self._validate_metadata_fields(payload.get("fields", payload))
        with self.lock:
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                raise LibraryValidationError("文献不存在。")
            metadata = self._normalize_metadata(item.get("metadata"))
            metadata["fields"].update(fields)
            locked = set(metadata.get("locked_fields", []))
            if lock_changed:
                locked.update(fields)
            locked.difference_update(str(field) for field in _as_list(payload.get("unlock_fields")))
            metadata["locked_fields"] = sorted(field for field in locked if field in BIBLIOGRAPHIC_FIELDS)
            for field in fields:
                metadata["sources"][field] = {"provider": "user", "confidence": 1.0, "retrieved_at": utc_now()}
            metadata["error"] = ""
            item["metadata"] = metadata
            item["updated_at"] = utc_now()
            self._save_locked()
            return copy.deepcopy(metadata)

    def mark_metadata_retrieving(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                raise LibraryValidationError("文献不存在。")
            metadata = self._normalize_metadata(item.get("metadata"))
            if metadata.get("status") not in {"local", "needs-review", "complete"}:
                metadata["status"] = "retrieving"
            metadata["error"] = ""
            item["metadata"] = metadata
            self._save_locked()
            return copy.deepcopy(metadata)

    def merge_metadata_result(self, job_id: str, result: Dict[str, Any]) -> Dict[str, Any]:
        incoming = self._normalize_metadata(result)
        with self.lock:
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                raise LibraryValidationError("文献不存在。")
            current = self._normalize_metadata(item.get("metadata"))
            locked = set(current.get("locked_fields", []))
            for field in BIBLIOGRAPHIC_FIELDS:
                if field in locked:
                    continue
                value = incoming["fields"].get(field)
                if value in (None, "", []):
                    continue
                current_source = current["sources"].get(field, {})
                incoming_source = incoming["sources"].get(field, {})
                if current["fields"].get(field) not in (None, "", []) and float(current_source.get("confidence", 0)) > float(incoming_source.get("confidence", 0)):
                    continue
                current["fields"][field] = value
                current["sources"][field] = incoming_source
            status_rank = {"not-run": 0, "retrieving": 0, "failed": 1, "local": 2, "needs-review": 3, "complete": 4}
            current_rank = status_rank.get(str(current.get("status") or "not-run"), 0)
            incoming_rank = status_rank.get(str(incoming.get("status") or "not-run"), 0)
            if incoming_rank >= current_rank:
                for key in ("status", "retrieved_at", "error", "candidates"):
                    current[key] = copy.deepcopy(incoming.get(key))
            item["metadata"] = current
            item["updated_at"] = utc_now()
            self._save_locked()
            return copy.deepcopy(current)

    @staticmethod
    def _validate_progress(value: Any, current: Any) -> Dict[str, Any]:
        base = dict(current) if isinstance(current, dict) else {"percent": 0, "page": 1, "scroll_top": 0, "updated_at": utc_now()}
        if not isinstance(value, dict):
            raise LibraryValidationError("阅读进度必须是对象。")
        if "percent" in value:
            base["percent"] = max(0, min(100, round(float(value.get("percent") or 0), 2)))
        if "page" in value:
            base["page"] = max(1, int(value.get("page") or 1))
        if "scroll_top" in value:
            base["scroll_top"] = max(0, round(float(value.get("scroll_top") or 0), 2))
        base["updated_at"] = utc_now()
        return base

    @staticmethod
    def _validate_value(prop: Dict[str, Any], value: Any) -> Any:
        prop_type = prop.get("type")
        if prop.get("id") == "reading_status":
            value = str(value or "未开始")
            if value not in READING_STATUSES:
                raise LibraryValidationError(f"阅读状态必须是{'、'.join(READING_STATUSES[:-1])}或{READING_STATUSES[-1]}。")
        if prop_type == "select":
            value = str(value or "")
            options = _as_list(prop.get("options"))
            if value and options and value not in options:
                raise LibraryValidationError(f"属性“{prop.get('label')}”的选项无效。")
            return value
        if prop_type == "multi-select":
            values = []
            for entry in _as_list(value):
                entry = str(entry).strip()
                if entry and entry not in values:
                    values.append(entry)
            options = _as_list(prop.get("options"))
            if options and any(entry not in options for entry in values):
                raise LibraryValidationError(f"属性“{prop.get('label')}”包含无效选项。")
            return values
        if prop_type == "rating":
            return max(0, min(int(prop.get("max", 5) or 5), int(value or 0)))
        return str(value or "")[:1000]

    def trash_item(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                raise LibraryValidationError("文献不存在。")
            item["deleted_at"] = utc_now()
            item["updated_at"] = item["deleted_at"]
            self._save_locked()
            return copy.deepcopy(item)

    def restore_item(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                raise LibraryValidationError("文献不存在。")
            if not item.get("deleted_at"):
                return copy.deepcopy(item)
            item["deleted_at"] = None
            item["updated_at"] = utc_now()
            self._save_locked()
            return copy.deepcopy(item)

    def permanently_delete_item(self, job_id: str) -> Dict[str, Any]:
        """Remove one trashed item from the metadata index.

        The job directory is owned by :class:`server.JobStore`; this method
        only changes ``library.json`` so the caller can coordinate both stores
        and roll the index back if artifact cleanup fails.
        """
        with self.lock:
            item = self.state["items"].get(job_id)
            if not isinstance(item, dict):
                raise LibraryValidationError("文献不存在。")
            if not item.get("deleted_at"):
                raise LibraryValidationError("只能彻底清除回收站中的文献。")
            removed = copy.deepcopy(item)
            del self.state["items"][job_id]
            tombstones = self.state.setdefault("permanently_deleted", [])
            if job_id not in tombstones:
                tombstones.append(job_id)
            try:
                self._save_locked()
            except Exception:
                self.state["items"][job_id] = item
                if job_id in tombstones:
                    tombstones.remove(job_id)
                raise
            return removed

    def restore_deleted_item(self, job_id: str, item: Dict[str, Any]) -> Dict[str, Any]:
        """Restore an index entry after a failed permanent-delete transaction."""
        if not isinstance(item, dict):
            raise LibraryValidationError("文献索引恢复数据无效。")
        with self.lock:
            if job_id in self.state["items"]:
                raise LibraryValidationError("文献索引恢复冲突。")
            self.state["items"][job_id] = copy.deepcopy(item)
            tombstones = self.state.setdefault("permanently_deleted", [])
            if job_id in tombstones:
                tombstones.remove(job_id)
            try:
                self._save_locked()
            except Exception:
                self.state["items"].pop(job_id, None)
                if job_id not in tombstones:
                    tombstones.append(job_id)
                raise
            return copy.deepcopy(self.state["items"][job_id])

    def is_permanently_deleted(self, job_id: str) -> bool:
        with self.lock:
            return str(job_id or "").strip() in self.state.get("permanently_deleted", [])

    def create_view(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        name = str(payload.get("name") or "").strip()
        if not name or len(name) > 80:
            raise LibraryValidationError("视图名称不能为空且不能超过 80 个字符。")
        view = {"id": f"view-{uuid.uuid4().hex[:12]}", "name": name, "filters": _as_list(payload.get("filters")), "sort_by": str(payload.get("sort_by") or "updated_at"), "sort_direction": "asc" if payload.get("sort_direction") == "asc" else "desc", "system": False, "created_at": utc_now()}
        with self.lock:
            self.state["views"].append(view)
            self._save_locked()
        return copy.deepcopy(view)

    def update_view(self, view_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            view = next((item for item in self.state["views"] if isinstance(item, dict) and item.get("id") == view_id), None)
            if not view:
                raise LibraryValidationError("视图不存在。")
            if view.get("system") and "name" in payload:
                raise LibraryValidationError("系统视图名称不能修改。")
            for key in ("name", "filters", "sort_by", "sort_direction"):
                if key not in payload:
                    continue
                if key == "name":
                    value = str(payload.get(key) or "").strip()
                    if not value:
                        raise LibraryValidationError("视图名称不能为空。")
                    view[key] = value[:80]
                elif key == "sort_direction":
                    view[key] = "asc" if payload.get(key) == "asc" else "desc"
                elif key == "filters":
                    view[key] = _as_list(payload.get(key))
                else:
                    view[key] = str(payload.get(key) or "updated_at")
            self._save_locked()
            return copy.deepcopy(view)

    def delete_view(self, view_id: str) -> None:
        with self.lock:
            view = next((item for item in self.state["views"] if isinstance(item, dict) and item.get("id") == view_id), None)
            if not view:
                raise LibraryValidationError("视图不存在。")
            if view.get("system"):
                raise LibraryValidationError("系统视图不能删除。")
            self.state["views"] = [item for item in self.state["views"] if item.get("id") != view_id]
            self._save_locked()
