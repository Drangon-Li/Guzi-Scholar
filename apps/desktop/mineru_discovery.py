"""Discover a locally available MinerU executable without downloading it."""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Mapping, Optional, Sequence

from toolchain_paths import tool_path_candidates


PRUNED_DIRECTORY_NAMES = frozenset({
    ".git",
    ".cache",
    ".Trash",
    "Library",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "site-packages",
})


@dataclass(frozen=True)
class MineruCandidate:
    executable: Path
    runtime_root: Optional[Path]
    source: str
    interpreter: Optional[Path]
    version: str
    health: str = "--help"

    def to_dict(self) -> dict[str, object]:
        return {
            "executable": str(self.executable),
            "runtime_root": str(self.runtime_root) if self.runtime_root else None,
            "source": self.source,
            "interpreter": str(self.interpreter) if self.interpreter else None,
            "version": self.version,
            "health": self.health,
        }


@dataclass(frozen=True)
class MineruScanResult:
    candidates: tuple[MineruCandidate, ...]
    diagnostics: tuple[dict[str, str], ...]
    scanned_directories: int = 0
    truncated: bool = False
    timed_out: bool = False

    @property
    def state(self) -> str:
        if not self.candidates:
            return "not_found"
        return "found" if len(self.candidates) == 1 else "multiple"

    def to_dict(self) -> dict[str, object]:
        return {
            "state": self.state,
            "candidate_count": len(self.candidates),
            "candidates": [candidate.to_dict() for candidate in self.candidates],
            "diagnostics": [dict(item) for item in self.diagnostics],
            "scanned_directories": self.scanned_directories,
            "truncated": self.truncated,
            "timed_out": self.timed_out,
        }


# Status endpoints can be polled repeatedly while the settings view is open.
# Keep automatic discovery cheap without weakening explicit user scans.
AUTOMATIC_DISCOVERY_CACHE_TTL_SECONDS = 15.0
_DISCOVERY_CACHE_LOCK = threading.RLock()
_DISCOVERY_CACHE: dict[tuple[object, ...], tuple[float, Optional[MineruCandidate], Optional[str]]] = {}


def clear_discovery_cache() -> None:
    """Invalidate process-local automatic discovery results."""
    with _DISCOVERY_CACHE_LOCK:
        _DISCOVERY_CACHE.clear()


def _automatic_cache_key(project_root: Optional[Path], values: Mapping[str, str], allow_development: bool) -> tuple[object, ...]:
    root = Path(project_root or values.get("MY_SCHOLAR_PROJECT_ROOT") or Path(__file__).resolve().parent).expanduser().resolve()
    environment = tuple(
        (name, str(values.get(name) or ""))
        for name in ("MY_SCHOLAR_MINERU", "MY_SCHOLAR_PACKAGED", "MY_SCHOLAR_TOOLCHAIN_ROOT", "PATH")
    )
    return (_path_key(root), bool(allow_development), environment)


def _resolve_interpreter(executable: Path) -> Optional[Path]:
    try:
        with executable.open("r", encoding="utf-8", errors="replace") as stream:
            first_line = stream.readline(4096).strip()
    except (OSError, UnicodeError):
        return None
    if not first_line.startswith("#!"):
        return None
    tokens = first_line[2:].strip().split()
    if not tokens:
        return None
    command = tokens[0]
    if command == "/usr/bin/env" and len(tokens) > 1:
        resolved = shutil.which(tokens[1])
        return Path(resolved) if resolved else None
    if command.startswith("/"):
        return Path(command).expanduser().resolve()
    resolved = shutil.which(command)
    return Path(resolved) if resolved else None


def _health_failure(executable: Path, *, timeout: float = 20) -> Optional[str]:
    try:
        # Probing for reachability; the stat result itself is not needed.
        executable.stat()
    except OSError as exc:
        return str(exc)
    if not executable.is_file() or not os.access(executable, os.X_OK):
        return "文件不存在或不可执行"
    interpreter = _resolve_interpreter(executable)
    if interpreter is not None and not interpreter.is_file():
        return f"启动解释器不存在：{interpreter}"
    try:
        result = subprocess.run(
            [str(executable), "--help"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"健康检查失败：{exc}"
    if result.returncode != 0:
        lines = (result.stdout or "").strip().splitlines()
        return f"健康检查退出码 {result.returncode}" + (f"：{lines[-1]}" if lines else "")
    return None


def _version(executable: Path, *, timeout: float = 10) -> str:
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return (result.stdout or "").strip().splitlines()[0][:120] if result.returncode == 0 else ""


def _candidate(
    executable: Path,
    source: str,
    *,
    deadline: Optional[float] = None,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[Optional[MineruCandidate], Optional[str]]:
    try:
        original = executable.expanduser()
        if original.is_symlink():
            return None, "不接受符号链接版面引擎"
        resolved = original.resolve()
    except OSError as exc:
        return None, str(exc)
    if deadline is not None and clock() >= deadline:
        return None, "扫描超时"
    health_timeout = 20.0 if deadline is None else max(0.05, deadline - clock())
    failure = _health_failure(resolved, timeout=health_timeout)
    if failure:
        return None, failure
    if deadline is not None and clock() >= deadline:
        return None, "扫描超时"
    interpreter = _resolve_interpreter(resolved)
    runtime_root = interpreter.parent.parent if interpreter and interpreter.parent.name == "bin" else None
    version_timeout = 10.0 if deadline is None else max(0.05, deadline - clock())
    return MineruCandidate(
        executable=resolved,
        runtime_root=runtime_root,
        source=source,
        interpreter=interpreter,
        version=_version(resolved, timeout=version_timeout),
    ), None


def _path_key(path: Path) -> str:
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(path))))


def _known_environment_candidates(
    home: Path,
    system_roots: Sequence[Path],
    *,
    child_limit: int,
) -> list[tuple[Path, str]]:
    candidates = [(Path(root) / "bin" / "mineru", "system-environment") for root in system_roots]
    candidates.append((home / ".local" / "bin" / "mineru", "user-environment"))
    environment_roots = [
        home / ".conda" / "envs",
        home / "miniconda3" / "envs",
        home / "anaconda3" / "envs",
        home / "miniforge3" / "envs",
        home / "mambaforge" / "envs",
        home / ".pyenv" / "versions",
    ]
    remaining = max(0, child_limit)
    for root in environment_roots:
        if remaining <= 0 or root.is_symlink() or not root.is_dir():
            continue
        try:
            children = sorted(root.iterdir(), key=lambda item: item.name)
        except OSError:
            continue
        for child in children:
            if remaining <= 0:
                break
            if child.is_symlink() or not child.is_dir():
                continue
            candidates.append((child / "bin" / "mineru", "known-environment"))
            remaining -= 1
    return candidates


def _bounded_user_candidates(
    roots: Iterable[Path],
    *,
    max_depth: int,
    max_directories: int,
    max_candidates: int,
    deadline: float,
    clock: Callable[[], float],
) -> tuple[list[tuple[Path, str]], int, bool, bool]:
    candidates: list[tuple[Path, str]] = []
    stack: list[tuple[Path, int]] = []
    seen: set[str] = set()
    for root in reversed(list(roots)):
        stack.append((Path(root).expanduser(), 0))
    scanned_directories = 0
    truncated = False
    timed_out = False

    while stack:
        if clock() >= deadline:
            timed_out = True
            truncated = True
            break
        if scanned_directories >= max_directories:
            truncated = True
            break
        directory, depth = stack.pop()
        key = _path_key(directory)
        if key in seen:
            continue
        seen.add(key)
        try:
            if directory.is_symlink() or not directory.is_dir():
                continue
        except OSError:
            continue
        scanned_directories += 1
        environment_executable = directory / "bin" / "mineru"
        try:
            if environment_executable.exists() or environment_executable.is_symlink():
                candidates.append((environment_executable, "user-search"))
                if len(candidates) >= max_candidates:
                    truncated = bool(stack)
                    break
                continue
        except OSError:
            pass
        if directory.name == "bin":
            executable = directory / "mineru"
            try:
                if executable.exists() or executable.is_symlink():
                    candidates.append((executable, "user-search"))
            except OSError:
                pass
            if len(candidates) >= max_candidates:
                truncated = bool(stack)
                break
            continue
        try:
            if (directory / "pyvenv.cfg").is_file() or directory.parent.name == "envs":
                continue
        except OSError:
            continue
        if depth >= max_depth:
            continue
        try:
            children = sorted(directory.iterdir(), key=lambda item: item.name, reverse=True)
        except OSError:
            continue
        for child in children:
            try:
                if child.name in PRUNED_DIRECTORY_NAMES or child.is_symlink() or not child.is_dir():
                    continue
            except OSError:
                continue
            stack.append((child, depth + 1))
    return candidates, scanned_directories, truncated, timed_out


def _default_scan_roots(home: Path) -> tuple[Path, ...]:
    focused = (
        home / "Desktop" / "Workspace",
        home / "Desktop" / "Developer",
        home / "Desktop" / "Code",
        home / "Documents" / "Workspace",
        home / "Documents" / "Developer",
        home / "Documents" / "Code",
        home / "Workspace",
        home / "Developer",
        home / "Code",
    )
    return (*focused, home / "Desktop", home / "Documents")


def scan_mineru(
    *,
    project_root: Optional[Path] = None,
    env: Optional[Mapping[str, str]] = None,
    explicit_scan: bool = False,
    allow_development: Optional[bool] = None,
    home: Optional[Path] = None,
    scan_roots: Optional[Sequence[Path]] = None,
    system_roots: Optional[Sequence[Path]] = None,
    max_depth: int = 7,
    max_directories: int = 4_000,
    max_candidates: int = 16,
    timeout_seconds: float = 5.0,
    validation_timeout_seconds: float = 20.0,
    clock: Callable[[], float] = time.monotonic,
) -> MineruScanResult:
    """Discover healthy MinerU candidates using an explicit bounded policy."""
    if max_depth < 0 or max_directories <= 0 or max_candidates <= 0:
        raise ValueError("扫描上限必须为正数。")
    values = os.environ if env is None else env
    if allow_development is None:
        allow_development = str(values.get("MY_SCHOLAR_PACKAGED") or "").strip().lower() not in {"1", "true", "yes"}
    resolved_home = Path(home or Path.home()).expanduser()
    enumeration_deadline = clock() + max(0.0, float(timeout_seconds))
    raw_candidates: list[tuple[Path, str]] = []
    configured = str(values.get("MY_SCHOLAR_MINERU") or "").strip()
    if configured:
        raw_candidates.append((Path(configured), "configured"))

    root = Path(project_root or values.get("MY_SCHOLAR_PROJECT_ROOT") or Path(__file__).resolve().parent).expanduser().resolve()
    path_value = str(values.get("PATH") or "").strip()
    if allow_development and not configured:
        raw_candidates.extend(
            (candidate, "development-toolchain")
            for candidate in tool_path_candidates(root, "pdf-tools", "envs", "mineru", "bin", "mineru")
        )
        path_candidate = shutil.which("mineru", path=path_value) if path_value else None
        if path_candidate:
            raw_candidates.append((Path(path_candidate), "path"))

    scanned_directories = 0
    truncated = False
    timed_out = False
    if explicit_scan:
        path_candidate = shutil.which("mineru", path=path_value) if path_value else None
        if path_candidate:
            raw_candidates.append((Path(path_candidate), "path"))
        roots = tuple(system_roots) if system_roots is not None else (Path("/opt/homebrew"), Path("/usr/local"))
        raw_candidates.extend(
            _known_environment_candidates(resolved_home, roots, child_limit=max_candidates * 4)
        )
        bounded_roots = tuple(scan_roots) if scan_roots is not None else _default_scan_roots(resolved_home)
        bounded, scanned_directories, truncated, timed_out = _bounded_user_candidates(
            bounded_roots,
            max_depth=max_depth,
            max_directories=max_directories,
            max_candidates=max_candidates,
            deadline=enumeration_deadline,
            clock=clock,
        )
        raw_candidates.extend(bounded)

    validation_deadline = clock() + max(0.0, float(validation_timeout_seconds))
    candidates: list[MineruCandidate] = []
    diagnostics: list[dict[str, str]] = []
    seen_paths: set[str] = set()
    considered = 0
    for path, source in raw_candidates:
        if clock() >= validation_deadline:
            timed_out = True
            truncated = True
            break
        key = _path_key(path)
        if key in seen_paths:
            continue
        seen_paths.add(key)
        if explicit_scan:
            try:
                if not path.exists() and not path.is_symlink():
                    continue
            except OSError:
                continue
        if considered >= max_candidates:
            truncated = True
            break
        considered += 1
        candidate, failure = _candidate(path, source, deadline=validation_deadline, clock=clock)
        if candidate:
            candidates.append(candidate)
        elif failure:
            diagnostics.append({
                "kind": "candidate_failure",
                "path": str(path),
                "source": source,
                "reason": failure,
            })
        if failure == "扫描超时":
            timed_out = True
            truncated = True
            break

    return MineruScanResult(
        candidates=tuple(candidates),
        diagnostics=tuple(diagnostics),
        scanned_directories=scanned_directories,
        truncated=truncated,
        timed_out=timed_out,
    )


def discover_mineru_candidates(
    *,
    project_root: Optional[Path] = None,
    env: Optional[Mapping[str, str]] = None,
    explicit_scan: bool = False,
    allow_development: Optional[bool] = None,
    home: Optional[Path] = None,
    scan_roots: Optional[Sequence[Path]] = None,
    system_roots: Optional[Sequence[Path]] = None,
    max_depth: int = 7,
    max_directories: int = 4_000,
    max_candidates: int = 16,
    timeout_seconds: float = 5.0,
    validation_timeout_seconds: float = 20.0,
) -> tuple[list[MineruCandidate], list[dict[str, str]]]:
    result = scan_mineru(
        project_root=project_root,
        env=env,
        explicit_scan=explicit_scan,
        allow_development=allow_development,
        home=home,
        scan_roots=scan_roots,
        system_roots=system_roots,
        max_depth=max_depth,
        max_directories=max_directories,
        max_candidates=max_candidates,
        timeout_seconds=timeout_seconds,
        validation_timeout_seconds=validation_timeout_seconds,
    )
    return list(result.candidates), [dict(item) for item in result.diagnostics]


def discover_mineru(
    *,
    project_root: Optional[Path] = None,
    explicit_path: Optional[Path | str] = None,
    env: Optional[Mapping[str, str]] = None,
    allow_development: Optional[bool] = None,
    cache_ttl_seconds: float = AUTOMATIC_DISCOVERY_CACHE_TTL_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[Optional[MineruCandidate], Optional[str]]:
    """Find one healthy candidate in a deterministic, bounded order."""
    values = os.environ if env is None else env
    if explicit_path is not None:
        return _candidate(Path(explicit_path), "user-selected")
    configured = str(values.get("MY_SCHOLAR_MINERU") or "").strip()
    if configured:
        return _candidate(Path(configured), "configured")
    if allow_development is None:
        allow_development = str(values.get("MY_SCHOLAR_PACKAGED") or "").strip() not in {"1", "true", "yes"}
    if not allow_development:
        return None, "未选择外部版面引擎"
    ttl = max(0.0, float(cache_ttl_seconds))
    cache_key = _automatic_cache_key(project_root, values, allow_development)
    now = clock()
    if ttl > 0:
        with _DISCOVERY_CACHE_LOCK:
            cached = _DISCOVERY_CACHE.get(cache_key)
            if cached and now - cached[0] < ttl:
                cached_candidate = cached[1]
                if cached_candidate is None or (
                    cached_candidate.executable.is_file() and os.access(cached_candidate.executable, os.X_OK)
                ):
                    return cached_candidate, cached[2]
                _DISCOVERY_CACHE.pop(cache_key, None)
    result = scan_mineru(
        project_root=project_root,
        env=values,
        explicit_scan=False,
        allow_development=True,
        timeout_seconds=60.0,
    )
    if result.candidates:
        candidate, failure = result.candidates[0], None
    else:
        failures = [f"{item['path']}: {item['reason']}" for item in result.diagnostics]
        candidate, failure = None, "; ".join(failures) if failures else "未发现外部版面引擎"
    if ttl > 0:
        with _DISCOVERY_CACHE_LOCK:
            _DISCOVERY_CACHE[cache_key] = (clock(), candidate, failure)
    return candidate, failure


__all__ = [
    "MineruCandidate",
    "MineruScanResult",
    "AUTOMATIC_DISCOVERY_CACHE_TTL_SECONDS",
    "clear_discovery_cache",
    "discover_mineru",
    "discover_mineru_candidates",
    "scan_mineru",
]
