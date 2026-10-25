"""Windows options for background desktop child processes."""

from __future__ import annotations

import os
import subprocess
import sys
from typing import Any


def hidden_subprocess_options() -> dict[str, Any]:
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def stop_windows_process_tree(process: subprocess.Popen) -> None:
    # terminate()/kill() on Windows stop only the parent, leaving model workers.
    taskkill = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "taskkill.exe")
    try:
        result = subprocess.run(
            [taskkill, "/PID", str(process.pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
            **hidden_subprocess_options(),
        )
        if result.returncode == 0:
            return
    except (OSError, subprocess.TimeoutExpired):
        pass
    if process.poll() is None:
        process.kill()
