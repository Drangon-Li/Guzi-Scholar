"""Library-scoped concept assessments and saved knowledge from reading reports."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from keyed_locks import KeyedLocks


REPORT_KNOWLEDGE_STATUSES = frozenset({"unassessed", "familiar", "learning", "mastered"})
_STORE_LOCKS = KeyedLocks()


class ReportKnowledgeStore:
    def __init__(self, root: Path):
        self.path = Path(root).resolve() / "report-knowledge.json"

    def _read_entries(self) -> dict[tuple[str, str], dict]:
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("entries"), list):
            raise ValueError("报告知识库文件格式无效。")

        entries = {}
        for entry in state["entries"]:
            if not isinstance(entry, dict):
                raise ValueError("报告知识库条目格式无效。")
            key = (entry.get("job_id"), entry.get("concept_id"))
            if not all(isinstance(value, str) and value for value in key) or key in entries:
                raise ValueError("报告知识库条目标识无效。")
            if (
                any(not isinstance(entry.get(field), str) for field in ("term", "status", "text", "article_title"))
                or entry["status"] not in REPORT_KNOWLEDGE_STATUSES
                or not isinstance(entry.get("saved"), bool)
                or type(entry.get("report_revision")) is not int
                or entry["report_revision"] < 1
                or "citation" not in entry
                or (entry["citation"] is not None and not isinstance(entry["citation"], dict))
            ):
                raise ValueError("报告知识库条目内容无效。")
            entries[key] = entry
        return entries

    def _write_entries(self, entries: dict[tuple[str, str], dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump({"version": 1, "entries": list(entries.values())}, output, ensure_ascii=False, indent=2)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def list_entries(self) -> list[dict]:
        with _STORE_LOCKS.lock(self.path):
            return list(self._read_entries().values())

    def upsert(
        self,
        *,
        job_id: str,
        concept_id: str,
        term: str,
        status: str,
        report_revision: int,
        article_title: str,
        citation: dict | None = None,
        text: str | None = None,
        saved: bool | None = None,
    ) -> dict:
        if not isinstance(status, str) or status not in REPORT_KNOWLEDGE_STATUSES:
            raise ValueError("报告概念熟悉度无效。")
        key = (job_id, concept_id)
        with _STORE_LOCKS.lock(self.path):
            entries = self._read_entries()
            previous = entries.get(key, {})
            entry = {
                "job_id": job_id,
                "concept_id": concept_id,
                "term": term,
                "status": status,
                "text": previous.get("text", "") if text is None else text,
                "saved": previous.get("saved", False) if saved is None else saved,
                "report_revision": report_revision,
                "article_title": article_title,
                "citation": citation,
            }
            if previous.get("saved") and saved is not True:
                # An assessment after regeneration still belongs to the original saved note.
                for field in ("term", "report_revision", "article_title", "citation"):
                    entry[field] = previous[field]
            if entry != previous:
                entries[key] = entry
                self._write_entries(entries)
            return entry
