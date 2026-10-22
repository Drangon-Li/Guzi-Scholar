"""Library-scoped vocabulary and source snapshots, persisted atomically."""

from __future__ import annotations

import copy
import json
import os
import re
import threading
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class VocabularyValidationError(ValueError):
    pass


class VocabularyStorageError(OSError):
    pass


DETAIL_FIELDS = {
    "part_of_speech": 500, "meanings": 6000, "synonyms": 2000,
    "antonyms": 2000, "examples": 8000, "context_explanation": 6000,
}


def normalize_details(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) - DETAIL_FIELDS.keys():
        raise VocabularyValidationError("详细释义只能包含词性、词义、同反义词、例句和语境解释。")
    return {key: _text(text, key, DETAIL_FIELDS[key]) for key, text in value.items()}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _text(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str) or len(value) > limit:
        raise VocabularyValidationError(f"{name}必须是长度不超过 {limit} 的文本。")
    return value.strip()


def _term_key(term: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", term).casefold().split())


def _tags(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 30:
        raise VocabularyValidationError("标签必须是最多 30 项的列表。")
    return list(dict.fromkeys(tag for item in value if (tag := _text(item, "标签", 80))))


def source_snapshot(payload: Any, record: dict, term: str, title: str = "") -> dict:
    if not isinstance(payload, dict):
        raise VocabularyValidationError("请提供生词所在文献。")
    _text(payload.get("quote", ""), "原句", 20000)
    source = {
        "job_id": record["job_id"],
        "title": title or record.get("title") or record.get("source_filename") or "未命名文献",
        "source_filename": record.get("source_filename", ""),
        "source_sha256": record.get("source_sha256", ""),
        "selected_text": term,
        "quote": payload.get("quote", ""),
    }
    for key in ("block_id", "source_block_id", "render_generation", "quote_prefix", "quote_suffix"):
        if payload.get(key) is not None:
            _text(payload[key], key, 500)
            source[key] = payload[key]
    surface = payload.get("surface", "source")
    if not isinstance(surface, str) or surface not in {"source", "paper", "translation"}:
        raise VocabularyValidationError("生词来源视图无效。")
    source["surface"] = surface
    for key in ("page", "start", "end"):
        value = payload.get(key)
        if value is not None:
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise VocabularyValidationError(f"{key}必须是非负整数。")
            source[key] = value
    if ("start" in source) != ("end" in source) or ("start" in source and source["end"] <= source["start"]):
        raise VocabularyValidationError("生词选区起止位置无效。")
    return source


def _source_key(source: dict) -> tuple:
    return tuple(source.get(key) for key in ("job_id", "quote", "surface", "block_id", "source_block_id", "page", "start", "end", "render_generation"))


class VocabularyStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.path = self.root / "vocabulary.json"
        self.backup_path = self.root / "vocabulary.json.bak"
        self.lock = threading.RLock()

    def _load(self) -> dict:
        failed = False
        for path in (self.path, self.backup_path):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("entries"), list):
                    raise ValueError("无效的生词本格式")
                ids = set()
                for entry in raw["entries"]:
                    if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or entry["id"] in ids:
                        raise ValueError("无效的生词条目")
                    if not isinstance(entry.get("term"), str) or not isinstance(entry.get("language"), str):
                        raise ValueError("无效的生词条目")
                    if not isinstance(entry.get("sources"), list) or not isinstance(entry.get("review"), dict):
                        raise ValueError("无效的生词条目")
                    if any(not isinstance(entry.get(key), str) for key in ("meaning", "note", "created_at", "updated_at")):
                        raise ValueError("无效的生词条目")
                    if not isinstance(entry.get("tags"), list) or any(not isinstance(tag, str) for tag in entry["tags"]):
                        raise ValueError("无效的生词标签")
                    if any(not isinstance(source, dict) or not isinstance(source.get("job_id"), str) for source in entry["sources"]):
                        raise ValueError("无效的生词来源")
                    if "details" in entry:
                        normalize_details(entry["details"])
                    review = entry["review"]
                    count = review.get("review_count")
                    if not isinstance(review.get("status"), str) or review["status"] not in {"new", "learning", "mastered"} or type(count) is not int or count < 0:
                        raise ValueError("无效的生词复习记录")
                    ids.add(entry["id"])
                return raw
            except FileNotFoundError:
                continue
            except (ValueError, UnicodeError):
                failed = True
        if failed:
            raise VocabularyStorageError("生词本文件损坏，请从备份恢复。")
        return {"version": 1, "entries": []}

    def _atomic_write(self, path: Path, content: str) -> None:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _save(self, state: dict, previous: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        # Back up the validated previous snapshot, including when it came from
        # recovery, so a corrupt primary never replaces a working backup.
        self._atomic_write(self.backup_path, json.dumps(previous, ensure_ascii=False, indent=2))
        self._atomic_write(self.path, json.dumps(state, ensure_ascii=False, indent=2))

    def list(self) -> list[dict]:
        with self.lock:
            return copy.deepcopy(self._load()["entries"])

    def get(self, entry_id: str) -> dict:
        with self.lock:
            for entry in self._load()["entries"]:
                if entry["id"] == entry_id:
                    return copy.deepcopy(entry)
        raise KeyError(entry_id)

    def add(self, payload: dict, source: dict) -> tuple[dict, bool]:
        term = _text(payload.get("term"), "生词", 120)
        if not term or "\n" in payload["term"] or "\r" in payload["term"] or any(unicodedata.category(char) == "Cc" for char in term):
            raise VocabularyValidationError("请仅保存单词或短语，不含换行。")
        language = _text(payload.get("language", "auto"), "语言", 35).lower()
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,34}", language):
            raise VocabularyValidationError("语言代码无效。")
        meaning = _text(payload.get("meaning", ""), "释义", 10000)
        tags = _tags(payload.get("tags", []))
        with self.lock:
            previous = self._load()
            state = copy.deepcopy(previous)
            existing = next((item for item in state["entries"] if item["language"] == language and _term_key(item["term"]) == _term_key(term)), None)
            if existing is not None:
                if not any(_source_key(item) == _source_key(source) for item in existing["sources"]):
                    existing["sources"].append(copy.deepcopy(source))
                    existing["updated_at"] = _now()
                    self._save(state, previous)
                return copy.deepcopy(existing), False
            now = _now()
            entry = {"id": uuid.uuid4().hex, "term": term, "language": language, "meaning": meaning, "note": "", "tags": tags,
                     "sources": [copy.deepcopy(source)], "created_at": now, "updated_at": now,
                     "review": {"status": "new", "review_count": 0, "last_reviewed_at": None}}
            state["entries"].insert(0, entry)
            self._save(state, previous)
            return copy.deepcopy(entry), True

    def _mutate(self, entry_id: str, operation: Any) -> dict:
        with self.lock:
            previous = self._load()
            state = copy.deepcopy(previous)
            entry = next((item for item in state["entries"] if item["id"] == entry_id), None)
            if entry is None:
                raise KeyError(entry_id)
            operation(entry, state)
            if state != previous:
                entry["updated_at"] = _now()
                self._save(state, previous)
            return copy.deepcopy(entry)

    def update(self, entry_id: str, payload: dict) -> dict:
        if not payload or set(payload) - {"meaning", "note", "tags", "details", "only_if_meaning_empty", "only_if_details_empty"}:
            raise VocabularyValidationError("生词只能修改释义、详细释义、笔记和标签。")
        for flag in ("only_if_meaning_empty", "only_if_details_empty"):
            if flag in payload and not isinstance(payload[flag], bool):
                raise VocabularyValidationError(f"{flag} 必须是布尔值。")
        changes = {key: _text(payload[key], "释义" if key == "meaning" else "笔记", 10000) for key in ("meaning", "note") if key in payload}
        if "tags" in payload:
            changes["tags"] = _tags(payload["tags"])
        if "details" in payload:
            changes["details"] = normalize_details(payload["details"])
        def operation(entry: dict, state: dict) -> None:
            for key, value in changes.items():
                if key == "meaning" and payload.get("only_if_meaning_empty") and entry.get("meaning", "").strip():
                    continue
                if key == "details":
                    if payload.get("only_if_details_empty") and any(entry.get("details", {}).values()):
                        continue
                    entry["details"] = {**entry.get("details", {}), **value}
                    continue
                entry[key] = value
        return self._mutate(entry_id, operation)

    def review(self, entry_id: str, payload: dict) -> dict:
        if set(payload) != {"status"} or not isinstance(payload.get("status"), str) or payload["status"] not in {"learning", "mastered"}:
            raise VocabularyValidationError("复习状态必须是 learning 或 mastered。")
        def operation(entry: dict, state: dict) -> None:
            entry["review"] = {"status": payload["status"], "review_count": entry["review"]["review_count"] + 1, "last_reviewed_at": _now()}
        return self._mutate(entry_id, operation)

    def delete(self, entry_id: str) -> None:
        self._mutate(entry_id, lambda entry, state: state["entries"].remove(entry))
