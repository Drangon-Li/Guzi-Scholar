"""Guard the structural contract the UI smoke tests rely on.

The fixture is CI infrastructure: if it drifts, the UI suite fails in ways that
look like product regressions. These tests pin the properties each smoke test
actually depends on.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from seed_library import PAPERS, seed  # noqa: E402

SECTION_RE = re.compile(r'<section class="pdf-page".*?</section>', re.S)
TAG_RE = re.compile(r"<(h1|h2|p) ")


class UIFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._temp = tempfile.TemporaryDirectory(prefix="my-scholar-ui-fixture-")
        cls.root = Path(cls._temp.name)
        cls.job_ids = seed(cls.root)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._temp.cleanup()

    def _documents(self) -> list[str]:
        return [
            (self.root / "jobs" / job_id / "document.html").read_text(encoding="utf-8")
            for job_id in self.job_ids
        ]

    def test_every_paper_is_seeded_and_completed(self) -> None:
        self.assertEqual(len(self.job_ids), len(PAPERS))
        library = json.loads((self.root / "library.json").read_text(encoding="utf-8"))
        titles = {
            item["metadata"]["fields"]["title"]
            for item in library["items"].values()
        }
        self.assertEqual(titles, {paper["title"] for paper in PAPERS})
        for job_id in self.job_ids:
            state = json.loads((self.root / "jobs" / job_id / "job.json").read_text(encoding="utf-8"))
            self.assertEqual(state["status"], "completed", job_id)

    def test_documents_expose_a_cross_page_paragraph_boundary(self) -> None:
        # translation_smoke measures the gap between the last paragraph of one
        # page and the first paragraph of the next.
        for document in self._documents():
            pages = SECTION_RE.findall(document)
            self.assertEqual(len(pages), 2)
            first, second = (TAG_RE.findall(page) for page in pages)
            self.assertEqual(first[-1], "p")
            self.assertEqual(second[0], "p")

    def test_every_block_carries_a_block_id(self) -> None:
        # interaction_regression skips documents without data-block-id. Count
        # the attribute form only; the inlined stylesheet also selects on it.
        for document in self._documents():
            blocks = TAG_RE.findall(document)
            self.assertEqual(len(blocks), document.count('data-block-id="'))
            self.assertGreater(len(blocks), 4)

    def test_a_paragraph_carries_inline_mathml(self) -> None:
        for document in self._documents():
            self.assertIn("<math", document)

    def test_metadata_retrieval_is_disabled(self) -> None:
        # A CI run must never reach out to Crossref or arXiv.
        settings = json.loads((self.root / "settings.json").read_text(encoding="utf-8"))
        self.assertFalse(settings["metadata"]["auto_retrieve"])
        self.assertFalse(settings["metadata"]["online_lookup"])

    def test_source_pdfs_are_structurally_valid(self) -> None:
        # A malformed PDF wedges MuPDF's error callback and hangs the server,
        # so the fixture must produce files that really parse.
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        for job_id in self.job_ids:
            with fitz.open(self.root / "jobs" / job_id / "source.pdf") as document:
                self.assertEqual(document.page_count, 1, job_id)


if __name__ == "__main__":
    unittest.main()
