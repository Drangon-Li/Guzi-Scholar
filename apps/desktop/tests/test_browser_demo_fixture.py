from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from content_store import _read_media_layout, _translation_records  # noqa: E402
from job_store import JobStore  # noqa: E402
from library_store import LibraryStore  # noqa: E402
from scholar_service import notes_snapshot  # noqa: E402
from seed_browser_demo import JOB_ID, MEDIA_ASSET, MEDIA_BLOCK_ID, NOTES, PARAGRAPHS, TITLE, seed  # noqa: E402


class BrowserDemoFixtureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="my-scholar-browser-demo-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "data"
        self.job_ids = seed(self.root)
        self.job_dir = self.root / "jobs" / JOB_ID

    def read_json(self, relative: str):
        return json.loads((self.job_dir / relative).read_text(encoding="utf-8"))

    def test_fixed_job_and_library_are_complete_and_synthetic(self) -> None:
        self.assertEqual(self.job_ids, ["8065bbad761a6255"])
        jobs = JobStore(self.root / "jobs").list()
        self.assertEqual([job["job_id"] for job in jobs], [JOB_ID])
        self.assertEqual(jobs[0]["status"], "completed")
        self.assertEqual(jobs[0]["manifest"]["engine"]["mode"], "synthetic")
        library = LibraryStore(self.root).snapshot(jobs)
        self.assertEqual(set(library["items"]), {JOB_ID})
        self.assertEqual(library["items"][JOB_ID]["metadata"]["fields"]["title"], TITLE)
        self.assertTrue((self.job_dir / "source.pdf").read_bytes().startswith(b"%PDF-1.4"))
        settings = json.loads((self.root / "settings.json").read_text(encoding="utf-8"))
        self.assertFalse(settings["metadata"]["auto_retrieve"])
        self.assertFalse(settings["metadata"]["online_lookup"])

    def test_translations_align_with_html_json_and_english_index(self) -> None:
        document = self.read_json("document.json")
        self.assertEqual(document["job_id"], JOB_ID)
        self.assertTrue(document["synthetic"])
        blocks = {block["block_id"]: block for page in document["pages"] for block in page["elements"]}
        english = {block["block_id"]: block for block in self.read_json("content/english/blocks.json")["blocks"]}
        html = (self.job_dir / "document.html").read_text(encoding="utf-8")
        translations = _translation_records(self.job_dir)
        self.assertEqual(len(translations), len(PARAGRAPHS))
        self.assertEqual(translations, self.read_json("content/chinese/blocks.json")["blocks"])
        for record in translations:
            block_id = record["block_id"]
            self.assertEqual(record["source_text"], blocks[block_id]["text"])
            self.assertEqual(record["source_text"], english[block_id]["text"])
            self.assertEqual(record["source_hash"], hashlib.sha256(record["source_text"].encode("utf-8")).hexdigest())
            self.assertIn(f'data-block-id="{block_id}"', html)
            self.assertIn(record["source_text"], html)
            self.assertTrue(record["text"])
            self.assertTrue(record["cache_key"])
            self.assertEqual(record["page"], blocks[block_id]["page"])

    def test_demo_api_seed_artifacts_have_nonempty_original_state(self) -> None:
        annotations = self.read_json("annotations.json")
        self.assertTrue(annotations)
        self.assertEqual(annotations, self.read_json("content/annotations/annotations.json"))
        source_blocks = {block["block_id"]: block for block in self.read_json("content/english/blocks.json")["blocks"]}
        for annotation in annotations:
            source = source_blocks[annotation["block_id"]]["text"]
            self.assertEqual(source[annotation["start"]:annotation["end"]], annotation["quote"])
            self.assertEqual(annotation["source"], "manual")
        self.assertEqual(notes_snapshot(self.job_dir), {"markdown": NOTES, "revision": hashlib.sha256(NOTES.encode("utf-8")).hexdigest()})
        self.assertEqual((self.job_dir / "content/notes/notes.md").read_text(encoding="utf-8"), NOTES)
        self.assertEqual(_read_media_layout(self.job_dir), {"version": 1, "items": {MEDIA_BLOCK_ID: {"width_percent": 70.0}}})
        self.assertTrue((self.job_dir / MEDIA_ASSET).is_file())
        manifest = self.read_json("content/manifest.json")
        for key in ("source_pdf", "html", "english", "chinese", "notes", "annotations"):
            self.assertTrue((self.job_dir / "content" / manifest[key]).is_file(), key)

    def test_nonempty_root_is_rejected_without_changes(self) -> None:
        before = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        with self.assertRaisesRegex(ValueError, "empty data root"):
            seed(self.root)
        after = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)

    def test_existing_empty_root_is_supported(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-empty-browser-demo-") as directory:
            self.assertEqual(seed(Path(directory)), [JOB_ID])


if __name__ == "__main__":
    unittest.main()
