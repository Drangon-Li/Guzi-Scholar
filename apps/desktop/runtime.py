"""Process-wide runtime configuration and shared mutable state.

This module deliberately imports nothing from the rest of the application so
that any module may depend on it without creating an import cycle.

Everything here is read through the module (``runtime.NAME``) rather than
copied out with ``from runtime import NAME``. A from-import binds the value at
import time, so each module would end up with its own copy and patching one of
them would silently miss the others -- which is exactly how the read-only write
guards lost their test coverage once they moved into content_store.
"""

from __future__ import annotations

import os
import threading


def _flag(name: str, *, default: bool = False) -> bool:
    raw = str(os.environ.get(name, "")).strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


# Serve existing artifacts without ever writing to the data root.
READONLY_MODE = _flag("MY_SCHOLAR_READONLY")

# Security-relevant switches. These gate authentication, transport policy and
# the migration control endpoints, so they must have exactly one definition.
API_ACCESS_TOKEN = os.environ.get("MY_SCHOLAR_API_TOKEN", "").strip()
MIGRATION_CONTROL_TOKEN = os.environ.get("MY_SCHOLAR_MIGRATION_TOKEN", "").strip()
ACCOUNT_SERVICE_URL = os.environ.get("MY_SCHOLAR_ACCOUNT_URL", "").strip().rstrip("/")
ALLOW_INSECURE_LOOPBACK_ACCOUNT = _flag("MY_SCHOLAR_ALLOW_INSECURE_LOOPBACK_ACCOUNT")
# Open-source builds use the user's own AI credentials and do not require an
# account or a hosted membership entitlement. The legacy gate can still be
# enabled explicitly for private deployments with MY_SCHOLAR_AI_REQUIRE_MEMBER=1.
# Kept as a negative test rather than _flag(): this switch has always treated
# any value that is not an explicit "off" as enabling the gate.
AI_REQUIRES_MEMBER = str(
    os.environ.get("MY_SCHOLAR_AI_REQUIRE_MEMBER", "0")
).strip().lower() not in {"", "0", "false", "no", "off"}

# Guards METADATA_PENDING and the metadata generation bookkeeping in server.py.
METADATA_STATE_LOCK = threading.RLock()
# (job_id, phase, generation) tuples for metadata work that has been queued but
# has not finished yet.
METADATA_PENDING: set[tuple[str, str, int]] = set()

__all__ = [
    "ACCOUNT_SERVICE_URL",
    "AI_REQUIRES_MEMBER",
    "ALLOW_INSECURE_LOOPBACK_ACCOUNT",
    "API_ACCESS_TOKEN",
    "METADATA_PENDING",
    "METADATA_STATE_LOCK",
    "MIGRATION_CONTROL_TOKEN",
    "READONLY_MODE",
]
