"""Per-key re-entrant locks that are forgotten once nobody uses them.

A plain ``dict.setdefault(key, RLock())`` table keeps one lock for every key it
has ever seen, so a long session that imports and deletes many documents grows
it without bound. Dropping an entry naively is unsafe: a thread that already
fetched the old lock and a thread that creates a fresh one would no longer
exclude each other.

Here every holder *and* every waiter is counted under a private guard, and an
entry is removed only when that count returns to zero. While anyone holds or
waits for a key, all callers resolve the key to the same lock.
"""

from __future__ import annotations

import threading
from typing import Dict, Hashable


class _Entry:
    __slots__ = ("lock", "users")

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.users = 0


class KeyedLocks:
    """A table of re-entrant locks addressed by key."""

    def __init__(self) -> None:
        # The guard is only ever held for dictionary bookkeeping, never while
        # waiting for a key's lock, so it cannot take part in a deadlock.
        self._guard = threading.Lock()
        self._entries: Dict[Hashable, _Entry] = {}

    def lock(self, key: Hashable) -> "KeyedLock":
        """Return a lock-like handle for ``key``; nothing is reserved until it is acquired."""
        return KeyedLock(self, key)

    def __len__(self) -> int:
        with self._guard:
            return len(self._entries)

    def __contains__(self, key: Hashable) -> bool:
        with self._guard:
            return key in self._entries

    def _check_out(self, key: Hashable) -> _Entry:
        with self._guard:
            entry = self._entries.get(key)
            if entry is None:
                entry = self._entries[key] = _Entry()
            entry.users += 1
            return entry

    def _check_in(self, key: Hashable, entry: _Entry) -> None:
        with self._guard:
            entry.users -= 1
            if entry.users <= 0 and self._entries.get(key) is entry:
                del self._entries[key]

    def _held_entry(self, key: Hashable) -> _Entry:
        # The caller holds the key, so its entry is counted and still present.
        with self._guard:
            entry = self._entries.get(key)
        if entry is None:
            raise RuntimeError("cannot release un-acquired lock")
        return entry


class KeyedLock:
    """Handle for one key, usable like ``threading.RLock``.

    ``acquire``/``release`` and the context-manager protocol follow RLock
    semantics, including re-entrant acquisition by the owning thread.
    """

    __slots__ = ("_table", "_key")

    def __init__(self, table: KeyedLocks, key: Hashable) -> None:
        self._table = table
        self._key = key

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        entry = self._table._check_out(self._key)
        try:
            acquired = entry.lock.acquire(blocking, timeout)
        except BaseException:
            self._table._check_in(self._key, entry)
            raise
        if not acquired:
            self._table._check_in(self._key, entry)
        return acquired

    def release(self) -> None:
        entry = self._table._held_entry(self._key)
        # RLock.release raises for a thread that does not own the lock; the
        # count is only returned after a successful release.
        entry.lock.release()
        self._table._check_in(self._key, entry)

    def __enter__(self) -> bool:
        return self.acquire()

    def __exit__(self, *_exc: object) -> None:
        self.release()


__all__ = ["KeyedLock", "KeyedLocks"]
