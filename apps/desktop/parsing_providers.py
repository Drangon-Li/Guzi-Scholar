"""Provider boundary for advanced document layout parsing."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional

from component_manager import (
    ComponentError,
    ComponentManager,
    ComponentManifest,
    PRODUCTION_COMPONENT_CATALOG,
)
from mineru_discovery import MineruCandidate, clear_discovery_cache, discover_mineru, discover_mineru_candidates
from pipeline import process_pdf


ProgressCallback = Callable[[str, float], None]


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str,
        details: Optional[Mapping[str, Any]] = None,
        http_status: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})
        self.http_status = int(http_status or _http_status_for(code))
        self.status = self.http_status

    def to_dict(self) -> Dict[str, Any]:
        return {"error": str(self), "code": self.code, "details": dict(self.details)}


def _http_status_for(code: str) -> int:
    if code in {"busy", "cancelled", "provider_disabled", "install_conflict"}:
        return 409
    if code in {
        "artifact_unavailable", "not_installed", "not_configured", "unsupported_platform",
        "incompatible_os", "insufficient_memory", "insufficient_disk", "component_unhealthy",
    }:
        return 428
    if code in {"download_failed"}:
        return 502
    return 422


@dataclass(frozen=True)
class ParsingRequest:
    job_id: str
    source_pdf: Path
    output_dir: Path
    source_name: str
    generation: Optional[int] = None
    backend: Optional[str] = None

    @classmethod
    def from_value(cls, value: Any) -> "ParsingRequest":
        if isinstance(value, cls):
            return value
        if not isinstance(value, Mapping):
            raise ProviderError("解析请求格式无效。", code="invalid_request")
        try:
            request = cls(
                job_id=str(value["job_id"]),
                source_pdf=Path(value["source_pdf"]),
                output_dir=Path(value["output_dir"]),
                source_name=str(value.get("source_name") or Path(value["source_pdf"]).name),
                generation=int(value["generation"]) if value.get("generation") is not None else None,
                backend=str(value["backend"]) if value.get("backend") is not None else None,
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError("解析请求缺少有效字段。", code="invalid_request") from exc
        if not request.job_id or not request.source_name:
            raise ProviderError("解析请求缺少任务标识或文件名。", code="invalid_request")
        return request


@dataclass(frozen=True)
class ParsingResult:
    manifest: Dict[str, Any]
    metrics: Dict[str, Any]


class LocalMineruProvider:
    provider_id = "local-mineru"
    kind = "local"

    def __init__(
        self,
        manager: ComponentManager,
        *,
        health_check: Optional[Callable[[Path], Optional[str]]] = None,
        project_root: Optional[Path] = None,
    ) -> None:
        self.manager = manager
        self.health_check = health_check
        self.project_root = Path(project_root or Path(__file__).resolve().parent).expanduser().resolve()

    def _manifest(self) -> Optional[ComponentManifest]:
        return self.manager.manifest_for("mineru")

    def _base_status(self) -> Dict[str, Any]:
        metadata = self.manager.component_metadata("mineru")
        return {
            "id": self.provider_id,
            "kind": self.kind,
            "type": self.kind,
            "ready": False,
            "version": str(metadata.get("version") or ""),
            "model_version": str(metadata.get("model_version") or ""),
            "requirements": dict(metadata.get("requirements") or {}),
            "install_help_url": str(metadata.get("install_help_url") or ""),
        }

    def _external_status(self, candidate: MineruCandidate) -> Dict[str, Any]:
        return {
            **self._base_status(),
            "state": "ready",
            "reason_code": "ready",
            "ready": True,
            "installed": True,
            "version": candidate.version,
            "source": candidate.source,
            "external": True,
            "executable": str(candidate.executable),
            "can_install": False,
            "can_import": True,
            "discovery": {"state": "found", "source": candidate.source, **candidate.to_dict()},
        }

    def _external_candidate(self) -> tuple[Optional[MineruCandidate], Optional[Any]]:
        if hasattr(self.manager, "external_candidate_status"):
            persisted, status = self.manager.external_candidate_status("mineru")
            if persisted or status:
                return persisted, status
        else:
            persisted = self.manager.external_candidate("mineru")
            if persisted:
                return persisted, None
        return discover_mineru(project_root=self.project_root)

    def status(self) -> Dict[str, Any]:
        manifest = self._manifest()
        base = self._base_status()
        if manifest is None:
            external, external_failure = self._external_candidate()
            if external:
                return self._external_status(external)
            operation = self.manager.operation_status("mineru") if hasattr(self.manager, "operation_status") else None
            if operation:
                return {
                    **base,
                    **operation,
                    "reason_code": str(operation.get("state") or "importing"),
                    "can_install": False,
                    "can_import": True,
                    "discovery": self.manager.discovery_status("mineru"),
                }
            outcome = self.manager.last_outcome("mineru") if hasattr(self.manager, "last_outcome") else None
            if outcome:
                return {
                    **base,
                    **outcome,
                    "reason_code": str(outcome.get("reason_code") or outcome.get("state") or "failed"),
                    "can_install": False,
                    "can_import": True,
                    "discovery": self.manager.discovery_status("mineru"),
                    "message": str(outcome.get("error") or "本地版面引擎导入失败。"),
                }
            if isinstance(external_failure, Mapping):
                return {
                    **base,
                    **dict(external_failure),
                    "ready": False,
                    "external": True,
                    "can_install": False,
                    "can_import": True,
                    "discovery": {"state": "invalid", **dict(external_failure)},
                }
            return {
                **base,
                "state": "artifact_unavailable",
                "reason_code": "artifact_unavailable",
                "can_install": False,
                "can_import": True,
                "discovery": self.manager.discovery_status("mineru"),
                "message": f"未发现可复用的本地版面引擎；当前版本也没有可下载 artifact。{str(external_failure or '')}",
            }
        status = self.manager.status(manifest)
        result = {
            **base,
            **status,
            "can_install": not manifest.local_only and status.get("state") in {"not_installed", "update_available", "failed", "cancelled"},
            "can_import": True,
            "source": "local-import" if manifest.local_only else "managed-download",
        }
        if status.get("state") == "ready":
            executable = self.manager.executable_path(manifest)
            if manifest.local_only:
                signature_failure = self.manager.signature_verifier(executable, manifest)
                if signature_failure:
                    return {
                        **result,
                        "state": "signature_verification_failed",
                        "reason_code": "signature_verification_failed",
                        "message": str(signature_failure),
                        "ready": False,
                    }
            failure = self.health_check(executable) if self.health_check else self.manager.executable_health_check(executable, manifest)
            if failure:
                return {
                    **result,
                    "state": "component_unhealthy",
                    "reason_code": "component_unhealthy",
                    "message": str(failure),
                    "ready": False,
                }
            result["ready"] = True
        return result

    def capability(self) -> Dict[str, Any]:
        return self.status()

    def install(
        self,
        progress: Optional[ProgressCallback] = None,
        cancel_event: Any = None,
    ) -> Dict[str, Any]:
        manifest = self._manifest()
        if manifest is None:
            raise ProviderError(
                "本地版面引擎 artifact 尚未提供。",
                code="artifact_unavailable",
                details={"provider_id": self.provider_id},
            )
        try:
            self.manager.install(manifest, progress=progress, cancel_event=cancel_event)
        except ComponentError as exc:
            raise _provider_error(exc) from exc
        return self.status()

    def cancel_install(self) -> bool:
        return self.manager.cancel_install()

    def discover_external(self) -> Dict[str, Any]:
        # A manual scan is an explicit request to refresh the automatic result.
        clear_discovery_cache()
        candidates, failures = discover_mineru_candidates(
            project_root=self.project_root,
            explicit_scan=True,
        )
        persisted, persisted_status = self.manager.external_candidate_status("mineru")
        if persisted and all(candidate.executable != persisted.executable for candidate in candidates):
            candidates.insert(0, persisted)
        elif persisted_status and persisted_status.get("state") != "ready":
            failures.append(dict(persisted_status))
        selected: Optional[MineruCandidate] = None
        if len(candidates) == 1:
            selected = candidates[0]
            provider = self.select_external(selected.executable)
        else:
            provider = self.status()
        return {
            "provider": provider,
            "candidates": [candidate.to_dict() for candidate in candidates],
            "candidate_count": len(candidates),
            "failures": [dict(failure) for failure in failures],
            "auto_selected": selected is not None,
            "selected": selected.to_dict() if selected else None,
        }

    def select_external(self, source: Path) -> Dict[str, Any]:
        source = Path(source).expanduser()
        executable = source if source.is_file() else next(
            (candidate for candidate in (source / "bin" / "mineru", source / "mineru") if candidate.is_file()),
            source,
        )
        try:
            candidate = self.manager.configure_external("mineru", executable)
        except ComponentError as exc:
            raise _provider_error(exc) from exc
        return self._external_status(candidate)

    def import_existing(self, source: Path, progress: Optional[ProgressCallback] = None) -> Dict[str, Any]:
        source = Path(source).expanduser()
        if source.is_file() or not (source / "component.json").is_file():
            return self.select_external(source)
        try:
            return self.manager.import_existing("mineru", source, progress=progress)
        except ComponentError as exc:
            raise _provider_error(exc) from exc

    def remove(self) -> Dict[str, Any]:
        manifest = self._manifest()
        if manifest is None:
            try:
                removed = self.manager.clear_external("mineru")
            except ComponentError as exc:
                raise _provider_error(exc) from exc
            return {**self.status(), "removed": removed, "external_removed": removed}
        try:
            result = self.manager.remove(manifest)
        except ComponentError as exc:
            raise _provider_error(exc) from exc
        return {**self.status(), **result}

    def run(
        self,
        request: Any,
        progress: Optional[ProgressCallback] = None,
        cancel_event: Any = None,
    ) -> ParsingResult:
        parsed = ParsingRequest.from_value(request)
        capability = self.status()
        if not capability.get("ready"):
            code = str(capability.get("reason_code") or capability.get("state") or "not_installed")
            raise ProviderError(
                str(capability.get("message") or "本地版面引擎不可用。"),
                code=code,
                details={"provider": capability},
            )
        manifest = self._manifest()
        external = None if manifest else self._external_candidate()[0]
        if manifest is None and external is None:
            raise ProviderError("本地版面引擎 artifact 尚未提供。", code="artifact_unavailable")
        if cancel_event is not None and cancel_event.is_set():
            raise ProviderError("AI 重排已取消。", code="cancelled")
        started = time.perf_counter()
        try:
            result = process_pdf(
                parsed.source_pdf,
                parsed.output_dir,
                job_id=parsed.job_id,
                source_name=parsed.source_name,
                progress=progress,
                backend_override="layout",
                layout_executable=self.manager.executable_path(manifest) if manifest else external.executable,
                layout_runtime_root=self.manager.target_dir(manifest) if manifest else None,
                layout_backend=parsed.backend,
                cancel_event=cancel_event,
            )
        except Exception as exc:
            if cancel_event is not None and cancel_event.is_set():
                raise ProviderError("AI 重排已取消。", code="cancelled") from exc
            raise
        return ParsingResult(
            manifest=dict(result),
            metrics={
                "provider_id": self.provider_id,
                "component_version": manifest.version if manifest else external.version or "external",
                "model_version": manifest.model_version if manifest else None,
                "seconds": round(time.perf_counter() - started, 3),
            },
        )


class RemoteGuziProvider:
    provider_id = "remote-guzi"
    kind = "remote"

    def status(self) -> Dict[str, Any]:
        return {
            "id": self.provider_id,
            "kind": self.kind,
            "type": self.kind,
            "state": "disabled",
            "reason_code": "not_configured",
            "ready": False,
            "configured": False,
            "can_install": False,
            "message": "谷子在线解析服务尚未提供。",
        }

    def capability(self) -> Dict[str, Any]:
        return self.status()

    def install(self, progress: Optional[ProgressCallback] = None, cancel_event: Any = None) -> Dict[str, Any]:
        raise ProviderError("远程解析服务不支持本地安装。", code="provider_disabled")

    def cancel_install(self) -> bool:
        return False

    def remove(self) -> Dict[str, Any]:
        raise ProviderError("远程解析服务未配置。", code="not_configured")

    def run(
        self,
        request: Any,
        progress: Optional[ProgressCallback] = None,
        cancel_event: Any = None,
    ) -> ParsingResult:
        raise ProviderError("谷子在线解析服务尚未提供。", code="not_configured")


class ParsingProviderRegistry:
    def __init__(self, providers: list[Any]) -> None:
        self._providers = {provider.provider_id: provider for provider in providers}

    def get(self, provider_id: str) -> Any:
        provider = self._providers.get(str(provider_id or ""))
        if provider is None:
            raise ProviderError("解析服务不存在。", code="provider_not_found", http_status=404)
        return provider

    def list_capabilities(self) -> list[Dict[str, Any]]:
        return [provider.status() for provider in self._providers.values()]


def _provider_error(error: ComponentError) -> ProviderError:
    return ProviderError(str(error), code=error.code, details=error.details)


def create_default_registry(
    components_root: Path,
    *,
    catalog: Optional[Mapping[str, Any]] = None,
    downloader: Any = None,
    system_probe: Any = None,
    health_check: Optional[Callable[[Path], Optional[str]]] = None,
    signature_verifier: Any = None,
) -> ParsingProviderRegistry:
    component_health_check = (lambda path, _manifest: health_check(path)) if health_check else None
    manager = ComponentManager(
        components_root,
        catalog=catalog if catalog is not None else PRODUCTION_COMPONENT_CATALOG,
        downloader=downloader,
        system_probe=system_probe,
        signature_verifier=signature_verifier,
        executable_health_check=component_health_check,
    )
    return ParsingProviderRegistry([
        LocalMineruProvider(
            manager,
            health_check=health_check,
            project_root=Path(os.environ.get("MY_SCHOLAR_PROJECT_ROOT") or Path(__file__).resolve().parent),
        ),
        RemoteGuziProvider(),
    ])


__all__ = [
    "LocalMineruProvider",
    "ParsingProviderRegistry",
    "ParsingRequest",
    "ParsingResult",
    "ProviderError",
    "RemoteGuziProvider",
    "create_default_registry",
]
