"""Publishing and validating conversion and reflow outputs on disk.

A conversion attempt is built in its own directory and published into the job
directory with the manifest as the commit marker; reflow renders are validated
before use and failed runs keep their layout log for diagnosis.
"""

from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from job_store import _read_json_file
from parsing_providers import ProviderError
from pipeline import PipelineError


def _publish_conversion_attempt(job_dir: Path, attempt_dir: Path) -> None:
    """Publish a complete conversion, with the manifest as the commit marker."""
    manifest_path = attempt_dir / "manifest.json"
    if not manifest_path.is_file():
        raise PipelineError("转换没有生成完成清单。")
    stale_root = job_dir / "work" / f"stale-{attempt_dir.name}-{uuid.uuid4().hex[:8]}"
    stale_root.mkdir(parents=True, exist_ok=False)
    entries = [entry for entry in attempt_dir.iterdir() if entry.name != "manifest.json"]
    try:
        for entry in entries:
            target = job_dir / entry.name
            if target.exists():
                os.replace(target, stale_root / entry.name)
            os.replace(entry, target)
        target_manifest = job_dir / "manifest.json"
        if target_manifest.exists():
            os.replace(target_manifest, stale_root / "manifest.json")
        os.replace(manifest_path, target_manifest)
        try:
            directory_fd = os.open(job_dir, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    except Exception:
        raise
    else:
        shutil.rmtree(stale_root, ignore_errors=True)
        try:
            attempt_dir.rmdir()
        except OSError:
            pass


def _rebase_manifest_paths(value: Any, attempt_dir: Path, job_dir: Path) -> Any:
    """Point manifest paths at the published directory, not the attempt one.

    Rewriting the serialized JSON would silently no-op on Windows, where
    json.dumps escapes the backslashes in the path being searched for.
    """
    old = str(attempt_dir)
    new = str(job_dir)
    if isinstance(value, str):
        return new + value[len(old):] if value.startswith(old) else value
    if isinstance(value, dict):
        return {key: _rebase_manifest_paths(item, attempt_dir, job_dir) for key, item in value.items()}
    if isinstance(value, list):
        return [_rebase_manifest_paths(item, attempt_dir, job_dir) for item in value]
    return value


def _validate_reflow_render(render_dir: Path) -> Dict[str, Any]:
    required = ("manifest.json", "document.html", "document.json", "document-ir.json", "validation.json", "source.pdf")
    missing = [name for name in required if not (render_dir / name).is_file()]
    if missing:
        raise PipelineError("重新排版产物不完整：" + "、".join(missing))
    validation = _read_json_file(render_dir / "validation.json", {})
    if not isinstance(validation, dict) or validation.get("status") not in {"PASS", "REVIEW"}:
        raise PipelineError("重新排版校验未通过，当前阅读版本未受影响。")
    manifest = _read_json_file(render_dir / "manifest.json", {})
    if not isinstance(manifest, dict):
        raise PipelineError("重新排版没有生成有效清单。")
    return manifest


def _provider_failure(capability: Dict[str, Any]) -> ProviderError:
    code = str(capability.get("reason_code") or capability.get("state") or "not_installed")
    message = str(capability.get("message") or "版面解析服务当前不可用。")
    return ProviderError(message, code=code, details={"provider": capability})


def _reflow_failure_error(exc: BaseException, preserved: Optional[Path]) -> str:
    """The stored message, naming the transcript when one was kept."""
    message = str(exc)
    if preserved is not None:
        message = f"{message}（解析日志：{preserved.name}）"
    return message[:500]


def _preserve_layout_error_log(attempt_dir: Path, renders_root: Path, generation: int) -> Optional[Path]:
    """Copy a failed attempt's MinerU transcript out before the attempt is removed.

    The transcript is written inside the attempt directory, which the failure
    path deletes, so until now the only run that kept a log was the one that
    succeeded -- the one nobody needs to read.
    """
    source = attempt_dir / "layout" / "mineru.log"
    target = renders_root / f"layout-error-{generation}.log"
    try:
        if not source.is_file() or source.stat().st_size == 0:
            return None
        renders_root.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    except OSError as error:
        print(f"[reflow] 无法保留 generation {generation} 的 MinerU 日志：{error}", flush=True)
        return None
    return target
