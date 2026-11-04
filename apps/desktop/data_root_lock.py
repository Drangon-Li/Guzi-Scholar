"""Single-writer process lock for a data or library directory."""

from __future__ import annotations

import errno
import os
from pathlib import Path
from typing import Any, Optional

try:
    import fcntl
except ImportError:  # Windows has no fcntl; msvcrt provides the equivalent.
    fcntl = None
try:
    import msvcrt
except ImportError:  # pragma: no cover - present only on Windows
    msvcrt = None


class DataRootLock:
    """Hold one writer process per state or library directory."""

    def __init__(self, data_root: Path) -> None:
        self.path = Path(data_root) / ".my-scholar.lock"
        self.handle: Optional[Any] = None

    # Windows locks a byte range rather than the whole file, so the guard byte
    # sits past any owner text the lock file holds.
    WINDOWS_LOCK_OFFSET = 4096

    def _lock_handle(self, handle: Any) -> None:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        if msvcrt is not None:
            handle.seek(self.WINDOWS_LOCK_OFFSET)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return
        raise RuntimeError("当前平台不支持 My Scholar 数据目录锁。")

    def _unlock_handle(self, handle: Any) -> None:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        elif msvcrt is not None:
            handle.seek(self.WINDOWS_LOCK_OFFSET)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

    def acquire(self) -> None:
        if fcntl is None and msvcrt is None:
            raise RuntimeError("当前平台不支持 My Scholar 数据目录锁。")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+", encoding="utf-8")
        try:
            self._lock_handle(handle)
        except OSError as exc:
            handle.seek(0)
            owner = handle.read().strip()
            handle.close()
            # Windows reports a busy range as EACCES/EDEADLOCK depending on the
            # runtime; both mean another instance owns the library.
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                detail = f"（进程 {owner}）" if owner else ""
                raise RuntimeError(f"这个文献库已由另一个 My Scholar 实例打开{detail}。") from exc
            raise
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
        os.fsync(handle.fileno())
        self.handle = handle

    def release(self) -> None:
        if not self.handle:
            return
        try:
            self._unlock_handle(self.handle)
        finally:
            self.handle.close()
            self.handle = None
