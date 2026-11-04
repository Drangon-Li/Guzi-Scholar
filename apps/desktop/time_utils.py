"""Timestamp helpers shared by the stores, pipelines and services.

Kept dependency-free so any module can import it without creating a cycle.
"""

from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> str:
    """Current UTC time as ISO 8601 with second precision, e.g. ``2026-11-04T01:53:00+00:00``."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


__all__ = ["utc_now"]
