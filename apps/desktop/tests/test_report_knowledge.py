from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from report_knowledge import ReportKnowledgeStore


class ReportKnowledgeStoreTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="guzi-report-knowledge-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "library"
        self.store = ReportKnowledgeStore(self.root)

    def upsert(self, store=None, **changes):
        entry = {
            "job_id": "a" * 16,
            "concept_id": "attention",
            "term": "注意力",
            "status": "learning",
            "report_revision": 1,
            "article_title": "Paper A",
            "citation": {"page": 3, "generation": "base"},
            **changes,
        }
        return (store or self.store).upsert(**entry)

    def test_assessment_persists_without_saving_knowledge(self):
        self.assertEqual(self.store.list_entries(), [])
        self.assertFalse(self.root.exists())
        entry = self.upsert(status="familiar")
        self.assertEqual(entry["status"], "familiar")
        self.assertEqual(entry["text"], "")
        self.assertFalse(entry["saved"])
        self.assertEqual(ReportKnowledgeStore(self.root).list_entries(), [entry])

    def test_status_changes_preserve_saved_note_and_its_original_report(self):
        original = self.upsert(text="我的理解\n第二行", saved=True)
        newer_source = {"report_revision": 2, "article_title": "Revised title", "citation": None}
        assessed = self.upsert(status="mastered", **newer_source)
        self.assertEqual(assessed, {**original, "status": "mastered"})

        updated = self.upsert(status="mastered", text="改写", saved=True, **newer_source)
        self.assertEqual(updated, {**assessed, **newer_source, "text": "改写"})
        removed = self.upsert(status="mastered", saved=False, **newer_source)
        self.assertEqual(removed, {**updated, "saved": False})
        self.assertEqual(ReportKnowledgeStore(self.root).list_entries(), [removed])

    def test_homonyms_remain_distinct_across_papers_and_concept_ids(self):
        first = self.upsert(text="第一篇中的注意力", saved=True)
        second = self.upsert(job_id="b" * 16, article_title="Paper B", text="第二篇中的注意力", saved=True)
        third = self.upsert(concept_id="selective-attention", status="mastered")
        self.assertEqual(self.store.list_entries(), [first, second, third])

    def test_concurrent_updates_from_independent_instances_are_retained(self):
        def assess(index):
            return self.upsert(ReportKnowledgeStore(self.root), concept_id=f"concept-{index}")

        with ThreadPoolExecutor(max_workers=8) as executor:
            expected = {entry["concept_id"] for entry in executor.map(assess, range(24))}
        self.assertEqual({entry["concept_id"] for entry in self.store.list_entries()}, expected)

    def test_failed_atomic_replace_keeps_old_entry_and_cleans_up_temporary_file(self):
        original = self.upsert(text="原始文本", saved=True)
        with patch("report_knowledge.os.replace", side_effect=OSError("write failed")), self.assertRaises(OSError):
            self.upsert(status="mastered")
        self.assertEqual(ReportKnowledgeStore(self.root).list_entries(), [original])
        self.assertEqual(list(self.store.path.parent.iterdir()), [self.store.path])

    def test_damaged_state_is_not_overwritten(self):
        self.root.mkdir()
        damaged = '{"version":1,"entries":[{"job_id":"job","concept_id":"term"}]}'
        self.store.path.write_text(damaged, encoding="utf-8")
        with self.assertRaises(ValueError):
            self.upsert()
        self.assertEqual(self.store.path.read_text(encoding="utf-8"), damaged)
