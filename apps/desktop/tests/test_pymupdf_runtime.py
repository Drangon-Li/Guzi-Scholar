"""Regression cover for the PyMuPDF diagnostic-callback crash.

A damaged PDF makes MuPDF log through PyMuPDF's SWIG director, which calls
Python's print() while the calling thread holds the GIL. server.py imports
fitz lazily inside functions, so with several metadata workers the first
import races across threads and the process either wedges on the shared stderr
buffer lock or dies on SIGBUS.

Measured against the unmodified server with 24 unreadable PDFs and four
metadata workers: every request timed out and the run exited on SIGBUS.
Reduced to a standalone harness (eight threads, each importing fitz inside the
thread and opening a malformed file 25 times), a bare import crashed 3 of 12
runs while the guarded path survived 12 of 12.

That 25% rate is why there is no concurrency test here: with the fix removed
it would still pass three runs out of four. The guard that actually holds is
the static one below -- a bare `import fitz` anywhere re-arms the callback for
the whole process, and that is detectable with certainty.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pymupdf_runtime import load_fitz, verify_pdf_glyph_extraction  # noqa: E402

BARE_IMPORT = re.compile(r"^\s*import fitz\b", re.M)


class PyMuPDFRuntimeTest(unittest.TestCase):
    def test_pdf_glyph_smoke_round_trips_real_in_memory_pdf(self) -> None:
        try:
            load_fitz()
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        self.assertTrue(verify_pdf_glyph_extraction())

    def test_pdf_glyph_smoke_requires_pymupdf(self) -> None:
        with patch("pymupdf_runtime.load_fitz", side_effect=ModuleNotFoundError("fitz unavailable")):
            with self.assertRaisesRegex(ModuleNotFoundError, "fitz unavailable"):
                verify_pdf_glyph_extraction()

    def test_pdf_glyph_smoke_rejects_missing_or_incorrect_glyphs(self) -> None:
        for text in ("", "Wrong result"):
            with self.subTest(text=text):
                document = MagicMock()
                document.__enter__.return_value = document
                document.__len__.return_value = 1
                document.__getitem__.return_value.get_text.return_value = {
                    "blocks": [{"type": 0, "lines": [{"spans": [{"chars": [
                        {"c": char, "bbox": [1, 2, 3, 4]} for char in text
                    ]}]}]}],
                }
                runtime = MagicMock()
                runtime.open.return_value = document
                with patch("pymupdf_runtime.load_fitz", return_value=runtime):
                    with self.assertRaisesRegex(RuntimeError, "expected glyphs"):
                        verify_pdf_glyph_extraction()

    def test_pdf_glyph_smoke_rejects_invalid_bboxes(self) -> None:
        for bbox in ([1, 2, 1, 4], [1, 2, 3, float("nan")], [1, 2, 3]):
            with self.subTest(bbox=bbox):
                document = MagicMock()
                document.__enter__.return_value = document
                document.__len__.return_value = 1
                document.__getitem__.return_value.get_text.return_value = {
                    "blocks": [{"type": 0, "lines": [{"spans": [{"chars": [
                        {"c": char, "bbox": bbox} for char in "Guzi rawdict"
                    ]}]}]}],
                }
                runtime = MagicMock()
                runtime.open.return_value = document
                with patch("pymupdf_runtime.load_fitz", return_value=runtime):
                    with self.assertRaisesRegex(RuntimeError, "invalid glyph bbox"):
                        verify_pdf_glyph_extraction()

    def test_loading_disables_the_python_diagnostic_callback(self) -> None:
        # PyMuPDF is an optional dependency and is absent on the CI runner.
        # The static guard below is the one that has to hold everywhere.
        try:
            fitz = load_fitz()
        except ImportError:
            self.skipTest("PyMuPDF is not installed")
        # A no-argument call reads the current setting back.
        self.assertFalse(bool(fitz.TOOLS.mupdf_display_errors()))
        self.assertFalse(bool(fitz.TOOLS.mupdf_display_warnings()))

    def test_no_module_imports_pymupdf_directly(self) -> None:
        offenders = []
        for path in sorted(ROOT.glob("*.py")):
            if path.name == "pymupdf_runtime.py":
                continue
            if BARE_IMPORT.search(path.read_text(encoding="utf-8")):
                offenders.append(path.name)
        self.assertEqual(
            offenders,
            [],
            "use pymupdf_runtime.load_fitz(); a bare import restores the printing callback",
        )

    def test_the_bare_import_guard_can_actually_fail(self) -> None:
        # The check above is only worth having if its pattern really matches.
        self.assertRegex("    import fitz  # type: ignore", BARE_IMPORT)
        self.assertRegex("import fitz", BARE_IMPORT)
        self.assertNotRegex("        fitz = load_fitz()", BARE_IMPORT)


if __name__ == "__main__":
    unittest.main()
