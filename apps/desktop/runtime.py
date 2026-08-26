"""Process-wide runtime flags and shared mutable state.

This module deliberately imports nothing from the rest of the application so
that any module may depend on it without creating an import cycle.
"""

from __future__ import annotations

import os
import threading

READONLY_MODE = str(os.environ.get("MY_SCHOLAR_READONLY", "")).strip().lower() in {"1", "true", "yes", "on"}

# Guards METADATA_PENDING and the metadata generation bookkeeping in server.py.
METADATA_STATE_LOCK = threading.RLock()
# (job_id, phase, generation) tuples for metadata work that has been queued but
# has not finished yet.
METADATA_PENDING: set[tuple[str, str, int]] = set()

__all__ = ["METADATA_PENDING", "METADATA_STATE_LOCK", "READONLY_MODE"]
