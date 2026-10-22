"""Durable progress for explicit, one-way Zotero import batches."""

from __future__ import annotations

import copy
import json
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any, Callable


def merge_import_warnings(previous: list[str], current: list[str]) -> list[str]:
    history = [warning for warning in previous if not re.match(
        r'^批注 \S+ (?:未定位：|已定位，其备用笔记|的备用笔记含用户改动)', warning,
    )]
    return list(dict.fromkeys([*history, *current]))


def validate_import_request(payload: dict[str, Any]) -> dict[str, Any]:
    if set(payload) - {"library", "items", "folder_id"}:
        raise ValueError("Zotero 导入请求包含未知字段。")
    library = payload.get("library")
    if not isinstance(library, str) or not re.fullmatch(r"(?:user:(?:0|[1-9][0-9]{0,15})|group:[1-9][0-9]{0,15})", library):
        raise ValueError("请选择有效的 Zotero 文库。")
    items = payload.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError("每批请选择 1 到 100 篇 Zotero 文献。")
    selected = []
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {"item_key", "attachment_key"}:
            raise ValueError("每篇文献必须指定条目和 PDF 附件。")
        if any(not isinstance(item[key], str) or not re.fullmatch(r"[A-Za-z0-9]{1,64}", item[key]) for key in item):
            raise ValueError("Zotero 条目或附件标识无效。")
        identity = (item["item_key"], item["attachment_key"])
        if identity not in seen:
            selected.append(dict(item))
            seen.add(identity)
    folder = payload.get("folder_id", "")
    if not isinstance(folder, str) or len(folder) > 128:
        raise ValueError("目标文件夹无效。")
    return {"library": library, "items": selected, "folder_id": folder.strip()}


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class ZoteroImports:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.lock = threading.RLock()
        self.active_id: str | None = None
        self.thread: threading.Thread | None = None

    def _read(self, batch_id: str) -> dict[str, Any]:
        if not re.fullmatch(r"[a-f0-9]{32}", batch_id):
            raise KeyError("导入批次不存在。")
        try:
            return json.loads((self.root / f"{batch_id}.json").read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise KeyError("导入批次不存在。") from exc

    def get(self, batch_id: str) -> dict[str, Any]:
        with self.lock:
            batch = self._read(batch_id)
            if batch["status"] == "running" and self.active_id != batch_id:
                batch.update(status="failed", error="上次导入因应用退出而中断；已接收的文献会继续解析，可重新选择剩余条目导入。")
                write_json(self.root / f"{batch_id}.json", batch)
            return batch

    def submit(self, request: dict[str, Any], importer: Callable[[str, dict[str, str], str], dict[str, Any]],
               *, on_finish: Callable[[], None]) -> dict[str, Any]:
        with self.lock:
            if self.active_id is not None:
                raise ValueError("已有 Zotero 导入正在进行，请等待当前批次完成。")
            batch = {"id": uuid.uuid4().hex, "status": "running", "total": len(request["items"]), "completed": 0, "results": []}
            write_json(self.root / f"{batch['id']}.json", batch)
            self.active_id = batch["id"]
            initial = copy.deepcopy(batch)
            self.thread = threading.Thread(target=self._run, args=(batch, request, importer, on_finish), name="my-scholar-zotero-import", daemon=True)
            try:
                self.thread.start()
            except Exception:
                self.active_id = None
                raise
            return initial

    def _run(self, batch: dict[str, Any], request: dict[str, Any], importer: Callable[..., dict[str, Any]], on_finish: Callable[[], None]) -> None:
        try:
            for item in request["items"]:
                try:
                    result = importer(request["library"], item, request["folder_id"])
                except Exception as exc:
                    result = {**item, "status": "failed", "error": str(exc)}
                with self.lock:
                    batch["results"].append(result)
                    batch["completed"] += 1
                    write_json(self.root / f"{batch['id']}.json", batch)
            batch["status"] = "completed"
        except Exception as exc:
            batch.update(status="failed", error=f"导入进度保存失败：{exc}")
        finally:
            try:
                with self.lock:
                    write_json(self.root / f"{batch['id']}.json", batch)
            finally:
                with self.lock:
                    self.active_id = None
                on_finish()
