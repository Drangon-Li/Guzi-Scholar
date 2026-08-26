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

    def _documents(self, rich: bool = False) -> list[str]:
        """Documents for the plain papers, or for the single reader fixture."""
        return [
            (self.root / "jobs" / job_id / "document.html").read_text(encoding="utf-8")
            for paper, job_id in zip(PAPERS, self.job_ids, strict=True)
            if bool(paper.get("rich")) is rich
        ]

    def _reader_document(self) -> str:
        documents = self._documents(rich=True)
        self.assertEqual(len(documents), 1)
        return documents[0]

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

    def test_inline_mathml_carries_a_tex_annotation(self) -> None:
        # The reader only tokenizes a formula that has one, so without it
        # translation_smoke's round-trip silently degrades to plain text.
        for document in self._documents() + [self._reader_document()]:
            self.assertIn('<annotation encoding="application/x-tex">', document)

    def test_the_reader_document_matches_the_census_web_smoke_asserts(self) -> None:
        document = self._reader_document()
        counts = {
            "pages": document.count('class="pdf-page"'),
            "figures": document.count('class="pdf-figure"'),
            "tables": document.count('class="pdf-table'),
            "table images": len(re.findall(r'class="table-source-primary[^"]*"><img', document)),
            "semantic tables": document.count("<table"),
            "equations": document.count('class="equation-entry"'),
            "references": len(re.findall(r'id="ref-\d+"', document)),
        }
        self.assertEqual(counts, {
            "pages": 12,
            "figures": 3,
            "tables": 7,
            "table images": 7,
            "semantic tables": 0,
            "equations": 2,
            "references": 100,
        })

    def test_the_reader_document_carries_the_sentences_feature_smoke_quotes(self) -> None:
        # feature_smoke feeds these to the auto-highlight mock, which can only
        # anchor a highlight if the sentence appears verbatim in the body.
        document = self._reader_document()
        for block_id, quote in (
            ("block-1-4-paragraph", "In this paper, we present OneLLM, an MLLM that aligns eight modalities to language using a unified framework."),
            ("block-2-3-paragraph", "OneLLM consists of lightweight modality tokenizers, a universal encoder, a universal projection module (UPM), and an LLM."),
            ("block-2-8-paragraph", "OneLLM is the first MLLM that integrates eight distinct modalities within a single model."),
            ("block-2-9-paragraph", "OneLLM finetuned on this dataset achieves superior performance on multimodal tasks"),
        ):
            self.assertIn(f'data-block-id="{block_id}"', document)
            self.assertIn(quote, document)
            paragraph = re.search(rf'<p id="{block_id}"[^>]*>(.*?)</p>', document, re.S)
            self.assertIsNotNone(paragraph, block_id)
            # The quote must not open the paragraph: the reader wraps it in a
            # <mark>, and feature_smoke walks the first text node expecting a
            # direct child of the paragraph.
            self.assertFalse(paragraph.group(1).startswith(quote), block_id)

    def test_the_introduction_stays_on_page_one(self) -> None:
        # feature_smoke checks that a Chat citation naming the wrong page
        # ([p2/block-1-6-paragraph]) fails to resolve.
        document = self._reader_document()
        anchor = re.search(r'<p id="block-1-6-paragraph"[^>]*data-page="(\d+)"[^>]*>(.*?)</p>', document, re.S)
        self.assertIsNotNone(anchor)
        self.assertEqual(anchor.group(1), "1")
        self.assertTrue(anchor.group(2).startswith("Large Language Models (LLMs)"))

    def test_the_figure_cross_reference_avoids_the_first_figure(self) -> None:
        # feature_smoke rewrites the referenced figure's image to a 1x1 stub,
        # and separately opens the first figure's image in the lightbox.
        document = self._reader_document()
        targets = re.findall(r'<a class="cross-reference" href="#(fig-\d+)"', document)
        self.assertTrue(targets)
        self.assertNotIn("fig-1", targets)

    def test_metadata_retrieval_is_disabled(self) -> None:
        # A CI run must never reach out to Crossref or arXiv.
        settings = json.loads((self.root / "settings.json").read_text(encoding="utf-8"))
        self.assertFalse(settings["metadata"]["auto_retrieve"])
        self.assertFalse(settings["metadata"]["online_lookup"])

    def test_source_pdfs_are_structurally_valid(self) -> None:
        # The fixture should look like a real document to the metadata worker,
        # which opens it with PyMuPDF.
        try:
            import fitz  # type: ignore
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        for job_id in self.job_ids:
            with fitz.open(self.root / "jobs" / job_id / "source.pdf") as document:
                self.assertEqual(document.page_count, 1, job_id)


if __name__ == "__main__":
    unittest.main()
