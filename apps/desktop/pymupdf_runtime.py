"""Load PyMuPDF with its Python-level diagnostic printing switched off.

PyMuPDF installs a SWIG director that forwards every MuPDF diagnostic through
Python's ``print()``. A damaged PDF makes MuPDF log freely, and the callback
runs while the calling thread holds the GIL. When several threads open damaged
PDFs at once they all reach ``_enter_buffered_busy`` on the same buffered
stream and wait there, still holding the GIL -- the whole interpreter stops,
HTTP threads included, and the process no longer answers even SIGTERM.

Observed with four metadata workers over two dozen unreadable files: every
request timed out and the server had to be killed with SIGKILL.

Silencing the log loses nothing. MuPDF still reports failures the way callers
already handle them, by raising (``FileDataError`` and friends); the printed
lines were duplicate noise on a path that has to stay lock-free.

Import failures propagate: parsing callers can treat PyMuPDF as unavailable,
while the packaged dependency smoke requires working PDF glyph extraction.
"""

from __future__ import annotations

import math
import threading
from typing import Any

_CONFIGURE_LOCK = threading.Lock()
_configured = False


def load_fitz() -> Any:
    """Return the ``fitz`` module, disabling its diagnostic printing once."""
    import fitz  # type: ignore

    global _configured
    if _configured:
        return fitz
    with _CONFIGURE_LOCK:
        if not _configured:
            tools = getattr(fitz, "TOOLS", None)
            for name in ("mupdf_display_errors", "mupdf_display_warnings"):
                setter = getattr(tools, name, None)
                if callable(setter):
                    try:
                        setter(False)
                    except Exception:
                        # An older or patched build may not accept the call;
                        # a noisy log is better than refusing to open the file.
                        pass
            _configured = True
    return fitz


def diagnostics_silenced() -> bool:
    """Whether the one-time configuration has run. For tests."""
    return _configured


def verify_pdf_glyph_extraction() -> bool:
    fitz = load_fitz()
    expected = "Guzi rawdict"
    with fitz.open() as document:
        page = document.new_page(width=240, height=100)
        page.insert_text((12, 30), expected, fontsize=12, fontname="helv")
        pdf = document.tobytes()
    with fitz.open(stream=pdf, filetype="pdf") as document:
        if len(document) != 1:
            raise RuntimeError("PDF glyph extraction smoke returned an invalid page count")
        chars = [
            char
            for block in document[0].get_text("rawdict")["blocks"]
            if block.get("type") == 0
            for line in block["lines"]
            for span in line["spans"]
            for char in span["chars"]
        ]
        if len(chars) != len(expected) or "".join(char["c"] for char in chars) != expected:
            raise RuntimeError("PDF glyph extraction smoke did not recover the expected glyphs")
        for char in chars:
            box = char["bbox"]
            if len(box) != 4 or not all(math.isfinite(value) for value in box) or box[2] <= box[0] or box[3] <= box[1]:
                raise RuntimeError("PDF glyph extraction smoke returned an invalid glyph bbox")
    return True


__all__ = ["diagnostics_silenced", "load_fitz", "verify_pdf_glyph_extraction"]
