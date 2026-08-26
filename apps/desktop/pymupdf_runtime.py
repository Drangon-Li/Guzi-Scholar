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

Import failures are deliberately left to propagate: PyMuPDF is optional, and
every call site already runs inside a ``try`` that treats it as unavailable.
"""

from __future__ import annotations

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


__all__ = ["diagnostics_silenced", "load_fitz"]
