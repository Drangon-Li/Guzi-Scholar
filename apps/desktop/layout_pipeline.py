"""Layout-aware PDF ingestion for My Scholar.

This module is intentionally an adapter around public, local extraction outputs.
It does not reuse any Scholaread implementation.  The adapter consumes a MinerU
content-list sidecar (when available), an optional Nougat page sidecar for display
math, and the original PDF as the visual source of truth.  If a layout sidecar is
not available the caller can keep the legacy ODL path as a reversible fallback.
"""

from __future__ import annotations

import html
import json
import math
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timezone
from itertools import islice
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from document_ir import _marker_drawing_pages, mineru_to_ir, render_pages, serializable_ir
from mineru_discovery import discover_mineru
from toolchain_paths import tool_path_candidates


PROJECT_ROOT = Path(__file__).resolve().parent

ALLOWED_INLINE_TAGS = (
    "sup", "/sup", "sub", "/sub", "br", "em", "/em", "strong", "/strong",
    "i", "/i", "u", "/u",
)
REF_RE = re.compile(r"(?<![A-Za-z0-9])\[(\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+)*)\]")
CROSS_REF_RE = re.compile(
    r"\b(Fig(?:ure)?\.?|Table|Tab\.?|Eq(?:uation)?\.?)\s*(\d+)\b",
    flags=re.IGNORECASE,
)
TAG_RE = re.compile(r"\\tag\s*\{([^{}]+)\}")
SPECIAL_TOKEN_RE = re.compile(r"\[(?P<prefix>I|T)(?P<separator>\\?_)?(?P<suffix>CLS|SEP)\]", flags=re.IGNORECASE)
MINERU_WORKERS = max(1, min(2, int(os.environ.get("MY_SCHOLAR_MINERU_WORKERS", "1"))))
MINERU_SEMAPHORE = threading.BoundedSemaphore(MINERU_WORKERS)
# A remote run only uploads and waits, so the local single-slot limit would
# throttle it for no reason; the GPU server does the queueing that matters.
MINERU_REMOTE_WORKERS = max(1, min(8, int(os.environ.get("MY_SCHOLAR_MINERU_REMOTE_WORKERS", "4"))))
MINERU_REMOTE_SEMAPHORE = threading.BoundedSemaphore(MINERU_REMOTE_WORKERS)
MINERU_BACKENDS = ("pipeline", "hybrid-engine", "vlm-http-client", "hybrid-http-client")
DEFAULT_MINERU_BACKEND = "pipeline"
# MinerU's own client/server split: the client sends the PDF to an
# OpenAI-compatible server (`mineru-openai-server`) and needs only CPU and
# network. vlm-http-client does not need a local torch install at all.
REMOTE_MINERU_BACKENDS = ("vlm-http-client", "hybrid-http-client")
DISCOVERY_CACHE_LOCK = threading.RLock()
DISCOVERY_CACHE: Dict[Tuple[str, str], Tuple[float, List[Path]]] = {}
FIRST_PAGE_CACHE: Dict[Tuple[str, int, int], str] = {}
MINERU_HEALTH_CACHE: Dict[Tuple[str, int], Optional[str]] = {}
VISUAL_CROP_BASE_DPI = 300
VISUAL_CROP_TARGET_WIDTH_PX = 1920
VISUAL_CROP_MAX_DPI = 600
VISUAL_CROP_MAX_PIXELS = 12_000_000
LAYOUT_BUDGET_MAX_VISUALS = 128
LAYOUT_BUDGET_MAX_TOTAL_PIXELS = 240_000_000
LAYOUT_BUDGET_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
LAYOUT_BUDGET_MAX_SIDECAR_FILES = 256
LAYOUT_BUDGET_MAX_SIDECAR_BYTES = 128 * 1024 * 1024
LAYOUT_BUDGET_MAX_OPERATIONS = 384
LAYOUT_BUDGET_MAX_WALL_SECONDS = 300.0
LAYOUT_SIDECAR_MAX_JSON_BYTES = 16 * 1024 * 1024
LAYOUT_SIDECAR_MAX_PAGES = 512
LAYOUT_SIDECAR_MAX_ELEMENTS = 100_000
LAYOUT_SIDECAR_MAX_NODES = 1_000_000
LAYOUT_SIDECAR_MAX_STRING_CHARS = 8_000_000
LAYOUT_SIDECAR_MAX_DEPTH = 64
PDF_EVIDENCE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
PDF_EVIDENCE_WORKER_TIMEOUT_SECONDS = 25.0
INLINE_MARKER_TONES = frozenset({"gray", "blue", "orange", "green", "red", "purple", "pink"})
PDF_TEXT_TONES = INLINE_MARKER_TONES - {"gray"}


@dataclass
class LayoutRenderBudget:
    max_visuals: int = LAYOUT_BUDGET_MAX_VISUALS
    max_total_pixels: int = LAYOUT_BUDGET_MAX_TOTAL_PIXELS
    max_output_bytes: int = LAYOUT_BUDGET_MAX_OUTPUT_BYTES
    max_sidecar_files: int = LAYOUT_BUDGET_MAX_SIDECAR_FILES
    max_sidecar_bytes: int = LAYOUT_BUDGET_MAX_SIDECAR_BYTES
    max_operations: int = LAYOUT_BUDGET_MAX_OPERATIONS
    max_wall_seconds: float = LAYOUT_BUDGET_MAX_WALL_SECONDS
    clock: Callable[[], float] = field(default_factory=lambda: time.monotonic, repr=False)
    operations: int = 0
    visuals: int = 0
    visual_outputs: int = 0
    pixels: int = 0
    encoded_png_bytes: int = 0
    output_bytes: int = 0
    sidecar_files: int = 0
    sidecar_bytes: int = 0
    fallback_count: int = 0
    fallback_by_reason: Dict[str, int] = field(default_factory=dict)
    fallback_events: List[Dict[str, Any]] = field(default_factory=list)
    last_reason: Optional[str] = None
    started_at: float = field(init=False)

    def __post_init__(self) -> None:
        self.started_at = float(self.clock())

    def _elapsed(self) -> float:
        return max(0.0, float(self.clock()) - self.started_at)

    def _fallback(
        self,
        reason: str,
        kind: str,
        identifier: str,
        **details: Any,
    ) -> None:
        self.last_reason = reason
        self.fallback_count += 1
        self.fallback_by_reason[reason] = self.fallback_by_reason.get(reason, 0) + 1
        if len(self.fallback_events) < 64:
            event = {
                "reason": reason,
                "kind": kind,
                "identifier": str(identifier)[:160],
            }
            event.update(details)
            self.fallback_events.append(event)

    def record_fallback(self, reason: str, kind: str, identifier: str, **details: Any) -> None:
        self._fallback(reason, kind, identifier, **details)

    def _common_limit(self, kind: str, identifier: str) -> bool:
        if self._elapsed() >= self.max_wall_seconds:
            self._fallback("wall-clock", kind, identifier)
            return False
        if self.operations >= self.max_operations:
            self._fallback("operation-count", kind, identifier)
            return False
        return True

    def reserve_sidecar(self, identifier: str, byte_count: int) -> bool:
        byte_count = max(0, int(byte_count))
        if not self._common_limit("sidecar", identifier):
            return False
        if self.sidecar_files >= self.max_sidecar_files:
            self._fallback("sidecar-count", "sidecar", identifier, attempted_bytes=byte_count)
            return False
        if self.sidecar_bytes + byte_count > self.max_sidecar_bytes:
            self._fallback("sidecar-bytes", "sidecar", identifier, attempted_bytes=byte_count)
            return False
        if self.output_bytes + byte_count > self.max_output_bytes:
            self._fallback("output-bytes", "sidecar", identifier, attempted_bytes=byte_count)
            return False
        self.operations += 1
        self.sidecar_files += 1
        self.sidecar_bytes += byte_count
        self.output_bytes += byte_count
        return True

    def finish_sidecar(self, identifier: str, reserved_bytes: int, actual_bytes: int) -> bool:
        reserved_bytes = max(0, int(reserved_bytes))
        actual_bytes = max(0, int(actual_bytes))
        delta = actual_bytes - reserved_bytes
        if delta:
            self.sidecar_bytes += delta
            self.output_bytes += delta
        if self.sidecar_bytes > self.max_sidecar_bytes:
            self._fallback("sidecar-bytes", "sidecar", identifier, attempted_bytes=actual_bytes)
            return False
        if self.output_bytes > self.max_output_bytes:
            self._fallback("output-bytes", "sidecar", identifier, attempted_bytes=actual_bytes)
            return False
        if self._elapsed() >= self.max_wall_seconds:
            self._fallback("wall-clock", "sidecar", identifier, attempted_bytes=actual_bytes)
            return False
        return True

    def reserve_visual(self, identifier: str, estimated_pixels: int) -> Optional[int]:
        estimated_pixels = max(1, int(estimated_pixels))
        if not self._common_limit("visual", identifier):
            return None
        if self.visuals >= self.max_visuals:
            self._fallback("visual-count", "visual", identifier, attempted_pixels=estimated_pixels)
            return None
        if self.pixels + estimated_pixels > self.max_total_pixels:
            self._fallback("pixel-budget", "visual", identifier, attempted_pixels=estimated_pixels)
            return None
        self.operations += 1
        self.visuals += 1
        self.pixels += estimated_pixels
        return estimated_pixels

    def finish_visual(
        self,
        identifier: str,
        reserved_pixels: int,
        actual_pixels: int,
        png_bytes: int,
    ) -> bool:
        actual_pixels = max(1, int(actual_pixels))
        png_bytes = max(0, int(png_bytes))
        self.pixels += actual_pixels - max(1, int(reserved_pixels))
        self.encoded_png_bytes += png_bytes
        if self.pixels > self.max_total_pixels:
            self._fallback("pixel-budget", "visual", identifier, attempted_pixels=actual_pixels)
            return False
        if self._elapsed() >= self.max_wall_seconds:
            self._fallback("wall-clock", "visual", identifier, attempted_bytes=png_bytes)
            return False
        if self.output_bytes + png_bytes > self.max_output_bytes:
            self._fallback("output-bytes", "visual", identifier, attempted_bytes=png_bytes)
            return False
        self.output_bytes += png_bytes
        self.visual_outputs += 1
        return True

    def reject_visual(
        self,
        identifier: str,
        reserved_pixels: int,
        reason: str,
        *,
        actual_pixels: Optional[int] = None,
        png_bytes: int = 0,
    ) -> None:
        if actual_pixels is not None:
            self.pixels += max(1, int(actual_pixels)) - max(1, int(reserved_pixels))
        self.encoded_png_bytes += max(0, int(png_bytes))
        self._fallback(reason, "visual", identifier)

    def report(self) -> Dict[str, Any]:
        return {
            "quality": "fallback" if self.fallback_count else "adaptive",
            "exhausted": bool(self.fallback_by_reason),
            "limits": {
                "visuals": self.max_visuals,
                "pixels": self.max_total_pixels,
                "output_bytes": self.max_output_bytes,
                "sidecar_files": self.max_sidecar_files,
                "sidecar_bytes": self.max_sidecar_bytes,
                "operations": self.max_operations,
                "wall_seconds": self.max_wall_seconds,
            },
            "usage": {
                "operations": self.operations,
                "visuals": self.visuals,
                "visual_outputs": self.visual_outputs,
                "pixels": self.pixels,
                "encoded_png_bytes": self.encoded_png_bytes,
                "output_bytes": self.output_bytes,
                "sidecar_files": self.sidecar_files,
                "sidecar_bytes": self.sidecar_bytes,
                "elapsed_seconds": round(self._elapsed(), 3),
            },
            "fallbacks": {
                "count": self.fallback_count,
                "by_reason": dict(sorted(self.fallback_by_reason.items())),
                "events": list(self.fallback_events),
            },
        }


def _pdf_tools_path(*parts: str) -> Path:
    candidates = tool_path_candidates(PROJECT_ROOT, "pdf-tools", *parts)
    return next((candidate for candidate in candidates if candidate.is_dir()), candidates[0])


def _pdf_tools_root() -> Path:
    return _pdf_tools_path()


# Inline/display formula normalization and conservative candidate repair.
class LayoutPipelineError(RuntimeError):
    """A recoverable layout conversion failure."""


class LayoutPipelineCancelled(LayoutPipelineError):
    """The caller cancelled layout conversion before publication."""


def _raise_if_cancelled(cancel_event: Any) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise LayoutPipelineCancelled("AI 重排已取消。")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _validate_layout_sidecar(value: Any) -> List[List[Dict[str, Any]]]:
    if not isinstance(value, list) or not value or not all(isinstance(page, list) for page in value):
        raise LayoutPipelineError("版面 JSON 不是按页排列的 content_list_v2")
    if len(value) > LAYOUT_SIDECAR_MAX_PAGES:
        raise LayoutPipelineError("版面 JSON 页数超过安全上限")
    element_count = sum(len(page) for page in value)
    if element_count > LAYOUT_SIDECAR_MAX_ELEMENTS:
        raise LayoutPipelineError("版面 JSON 元素数量超过安全上限")
    node_count = 0
    string_chars = 0
    stack: List[Tuple[Any, int]] = [(value, 0)]
    while stack:
        current, depth = stack.pop()
        node_count += 1
        if node_count > LAYOUT_SIDECAR_MAX_NODES:
            raise LayoutPipelineError("版面 JSON 节点数量超过安全上限")
        if depth > LAYOUT_SIDECAR_MAX_DEPTH:
            raise LayoutPipelineError("版面 JSON 嵌套层级超过安全上限")
        if isinstance(current, str):
            string_chars += len(current)
        elif isinstance(current, Mapping):
            for key, child in current.items():
                string_chars += len(str(key))
                stack.append((child, depth + 1))
        elif isinstance(current, list):
            stack.extend((child, depth + 1) for child in current)
        if string_chars > LAYOUT_SIDECAR_MAX_STRING_CHARS:
            raise LayoutPipelineError("版面 JSON 文本总量超过安全上限")
    return value


def _load_layout_sidecar(path: Path) -> List[List[Dict[str, Any]]]:
    try:
        with Path(path).open("rb") as handle:
            payload = handle.read(LAYOUT_SIDECAR_MAX_JSON_BYTES + 1)
    except OSError as exc:
        raise LayoutPipelineError(f"版面 JSON 无法读取：{exc}") from exc
    if len(payload) > LAYOUT_SIDECAR_MAX_JSON_BYTES:
        raise LayoutPipelineError("版面 JSON 文件超过安全上限")
    try:
        value = json.loads(payload.decode("utf-8", errors="replace"))
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise LayoutPipelineError(f"版面 JSON 无法解析：{exc}") from exc
    return _validate_layout_sidecar(value)


def _pdf_evidence_worker_command(source_pdf: Path, output_json: Path, drawing_pages: Sequence[int]) -> List[str]:
    worker_args = [
        "--pdf-evidence-input", str(source_pdf),
        "--pdf-evidence-output", str(output_json),
        "--pdf-evidence-drawing-pages", ",".join(str(page) for page in drawing_pages),
    ]
    if getattr(sys, "frozen", False):
        return [sys.executable, *worker_args]
    return [sys.executable, str(PROJECT_ROOT / "server.py"), *worker_args]


def _pdf_evidence_java_command(source_pdf: Path, output_json: Path) -> Optional[List[str]]:
    java = str(os.environ.get("MY_SCHOLAR_JAVA") or "").strip()
    if not java:
        java = _which(["java", "/usr/bin/java"]) or ""
    if not java:
        return None
    classpath = str(os.environ.get("MY_SCHOLAR_PDF_RENDERER_CLASSPATH") or "").strip()
    if not classpath:
        renderer = PROJECT_ROOT / "build" / "mac-runtime" / "pdf-renderer"
        jar = PROJECT_ROOT / "build" / "mac-runtime" / "opendataloader-pdf-cli-0.0.0.jar"
        if renderer.is_dir() and jar.is_file():
            classpath = os.pathsep.join((str(renderer), str(jar)))
    if not classpath:
        return None
    return [
        str(Path(java).expanduser().resolve()),
        "--add-opens=java.base/java.nio=ALL-UNNAMED",
        "-Djava.awt.headless=true",
        "-cp",
        classpath,
        "MyScholarPdfRenderer",
        "--evidence",
        str(source_pdf),
        str(output_json),
    ]


def _read_pdf_evidence_output(path: Path) -> List[Dict[str, Any]]:
    try:
        with path.open("rb") as handle:
            payload = handle.read(PDF_EVIDENCE_MAX_OUTPUT_BYTES + 1)
        if len(payload) > PDF_EVIDENCE_MAX_OUTPUT_BYTES:
            return []
        value = json.loads(payload.decode("utf-8"))
        if not isinstance(value, list) or len(value) > LAYOUT_SIDECAR_MAX_PAGES:
            return []
        if not all(isinstance(page, Mapping) for page in value):
            return []
        return [dict(page) for page in value]
    except (OSError, json.JSONDecodeError, UnicodeDecodeError, ValueError, TypeError):
        return []


def _extract_pdf_evidence_java(source_pdf: Path, workspace: Path) -> List[Dict[str, Any]]:
    try:
        with tempfile.TemporaryDirectory(prefix="pdf-evidence-java-", dir=str(workspace)) as temp:
            output_json = Path(temp) / "evidence.json"
            command = _pdf_evidence_java_command(source_pdf, output_json)
            if command is None:
                return []
            result = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=PDF_EVIDENCE_WORKER_TIMEOUT_SECONDS,
            )
            if result.returncode != 0:
                return []
            return _read_pdf_evidence_output(output_json)
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError):
        return []


def _extract_pdf_evidence_isolated(
    source_pdf: Path,
    raw_pages: Sequence[Sequence[Mapping[str, Any]]],
    workspace: Path,
) -> List[Dict[str, Any]]:
    drawing_pages = _marker_drawing_pages(raw_pages)
    try:
        with tempfile.TemporaryDirectory(prefix="pdf-evidence-", dir=str(workspace)) as temp:
            output_json = Path(temp) / "evidence.json"
            result = subprocess.run(
                _pdf_evidence_worker_command(source_pdf, output_json, drawing_pages),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=PDF_EVIDENCE_WORKER_TIMEOUT_SECONDS,
            )
            value = _read_pdf_evidence_output(output_json) if result.returncode == 0 else []
            if value:
                return value
    except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError, UnicodeDecodeError, ValueError):
        pass
    return _extract_pdf_evidence_java(source_pdf, workspace)


def _safe_inline(value: Any) -> str:
    escaped = html.escape("" if value is None else str(value), quote=False)
    for tag in ALLOWED_INLINE_TAGS:
        escaped = escaped.replace(f"&lt;{tag}&gt;", f"<{tag}>")
    def replace_token(match: re.Match[str]) -> str:
        prefix = match.group("prefix").upper()
        suffix = match.group("suffix").upper()
        raw = f"[{prefix}_{suffix}]"
        return f'<span class="math-token" translate="no" data-token="{raw}">[{prefix}<sub>{suffix}</sub>]</span>'
    return SPECIAL_TOKEN_RE.sub(replace_token, escaped)


def _emphasis_for_slice(ranges: Sequence[Mapping[str, Any]], start: int, end: int) -> List[Dict[str, Any]]:
    sliced: List[Dict[str, Any]] = []
    for item in ranges:
        style = str(item.get("style") or "")
        tone = str(item.get("tone") or "")
        if style != "bold" and not (style == "color" and tone in PDF_TEXT_TONES):
            continue
        try:
            item_start = max(start, int(item.get("start", -1)))
            item_end = min(end, int(item.get("end", -1)))
        except (TypeError, ValueError):
            continue
        if item_start >= item_end:
            continue
        candidate = {
            "start": item_start - start,
            "end": item_end - start,
            "style": style,
            "source": str(item.get("source") or ("pdf-font" if style == "bold" else "pdf-text-color")),
        }
        if style == "color":
            candidate["tone"] = tone
        sliced.append(candidate)
    return sliced


def _safe_inline_with_emphasis(value: Any, ranges: Optional[Sequence[Mapping[str, Any]]] = None) -> str:
    raw = "" if value is None else str(value)
    candidates: List[Dict[str, Any]] = []
    for item in ranges or []:
        style = str(item.get("style") or "")
        tone = str(item.get("tone") or "")
        if style != "bold" and not (style == "color" and tone in PDF_TEXT_TONES):
            continue
        try:
            start = int(item.get("start", -1))
            end = int(item.get("end", -1))
        except (TypeError, ValueError):
            continue
        if start < 0 or end <= start or end > len(raw):
            continue
        candidates.append({
            "start": start,
            "end": end,
            "style": style,
            "source": str(item.get("source") or ("pdf-font" if style == "bold" else "pdf-text-color")),
            "tone": tone,
        })
    grouped: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = {}
    for candidate in sorted(candidates, key=lambda item: (item["style"], item["tone"], item["source"], item["start"], item["end"])):
        key = (candidate["style"], candidate["tone"], candidate["source"])
        bucket = grouped.setdefault(key, [])
        if bucket and candidate["start"] <= bucket[-1]["end"]:
            bucket[-1]["end"] = max(bucket[-1]["end"], candidate["end"])
        else:
            bucket.append(dict(candidate))
    validated = [item for bucket in grouped.values() for item in bucket]
    if not validated:
        return _safe_inline(raw)
    output: List[str] = []
    boundaries = sorted({0, len(raw), *(item["start"] for item in validated), *(item["end"] for item in validated)})
    for start, end in zip(boundaries, boundaries[1:]):
        if start >= end:
            continue
        active = [item for item in validated if item["start"] <= start and item["end"] >= end]
        segment = _safe_inline(raw[start:end])
        color = next((item for item in active if item["style"] == "color"), None)
        bold = next((item for item in active if item["style"] == "bold"), None)
        if color is not None:
            tone = color["tone"]
            segment = (
                f'<span class="pdf-text-tone pdf-text-tone-{tone}" data-text-tone="{tone}">'
                f'{segment}</span>'
            )
        if bold is not None:
            segment = (
                f'<strong data-emphasis-source="{html.escape(bold["source"], quote=True)}">'
                f'{segment}</strong>'
            )
        output.append(segment)
    return "".join(output)


def _special_tokens(value: Any) -> List[str]:
    return [
        f"[{match.group('prefix').upper()}_{match.group('suffix').upper()}]"
        for match in SPECIAL_TOKEN_RE.finditer(str(value or ""))
    ]


def _text_from_content(value: Any) -> str:
    """Flatten MinerU's nested content while retaining useful inline markup."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "".join(_text_from_content(item) for item in value)
    if isinstance(value, dict):
        if value.get("type") == "inline_marker":
            return {"circle": "—● ", "square": "—■ "}.get(str(value.get("shape") or ""), "")
        # The order matters: list_items/item_content are common in reference
        # lists, while content/text cover ordinary spans.
        for key in (
            "content", "text", "title_content", "paragraph_content",
            "list_content", "list_items", "item_content", "image_caption",
            "table_caption", "page_header_content", "page_footnote_content",
            "page_number_content",
        ):
            if key in value:
                return _text_from_content(value[key])
    return ""


def _caption(content: Dict[str, Any], key: str) -> str:
    return _text_from_content(content.get(key, "")).strip()


def _inline_marker_html(piece: Mapping[str, Any]) -> str:
    shape = str(piece.get("shape") or "")
    tone = str(piece.get("tone") or "")
    if piece.get("style") != "line-marker" or tone not in INLINE_MARKER_TONES:
        return ""
    label = {"circle": "line with circle marker", "square": "line with square marker"}.get(shape)
    if label is None:
        return ""
    return (
        f'<span class="inline-legend-marker inline-legend-marker-{shape} inline-legend-marker-{tone}" '
        f'role="img" aria-label="{label}">'
        '<span class="inline-legend-line" aria-hidden="true"></span>'
        '<span class="inline-legend-shape" aria-hidden="true"></span></span>'
    )


def _caption_html(content: Dict[str, Any], key: str, renderer: "MathRenderer") -> str:
    """Render caption segments with inline math, mirroring paragraph bodies.

    MinerU captions arrive as mixed text/equation_inline segment lists; the
    plain _caption() flattening keeps working for numbering and alt text.
    """
    value = content.get(key, "")
    if not isinstance(value, list):
        return _safe_inline(_text_from_content(value).strip())
    parts: List[str] = []
    for piece in value:
        if isinstance(piece, dict) and piece.get("type") == "inline_marker":
            parts.append(_inline_marker_html(piece))
        elif isinstance(piece, dict) and piece.get("type") == "equation_inline":
            parts.append(renderer.render(str(piece.get("content", "")), display=False))
        else:
            emphasis = piece.get("emphasis") if isinstance(piece, dict) and isinstance(piece.get("emphasis"), list) else []
            parts.append(_safe_inline_with_emphasis(_text_from_content(piece), emphasis))
    return "".join(parts).strip()


def _clean_tex(value: str) -> str:
    tex = (value or "").strip()
    if tex.startswith("\\[") and tex.endswith("\\]"):
        tex = tex[2:-2].strip()
    if tex.startswith("$$") and tex.endswith("$$"):
        tex = tex[2:-2].strip()
    return tex


def _normalize_tex(value: str) -> str:
    """Make common legacy TeX emitted by PDF extractors acceptable to Pandoc.

    Older layout sidecars often use declarations such as ``\\bf`` inside an
    otherwise valid expression.  Pandoc treats those declarations as a hard
    parse failure, which previously exposed the entire formula as raw text.
    The replacements are intentionally conservative and only touch standalone
    legacy commands; the original source remains in the element audit.
    """
    tex = _clean_tex(value)
    replacements = (
        (r"\\bf(?![A-Za-z])", r"\\mathbf"),
        (r"\\rm(?![A-Za-z])", r"\\mathrm"),
        (r"\\it(?![A-Za-z])", r"\\mathit"),
        (r"\\cal(?![A-Za-z])", r"\\mathcal"),
        (r"\\tt(?![A-Za-z])", r"\\mathtt"),
        (r"\\sf(?![A-Za-z])", r"\\mathsf"),
        (r"\\Bbb(?![A-Za-z])", r"\\mathbb"),
    )
    for pattern, replacement in replacements:
        tex = re.sub(pattern, replacement, tex)
    return tex


INLINE_MARKUP_RE = re.compile(
    r"</?(?:sup|sub|em|strong|i|u|br)\b[^>]*>", flags=re.IGNORECASE
)
ARGMAX_TEXT_RE = re.compile(
    r"(?<![A-Za-z])(?P<base>[A-Za-z])\s*[\*⋆]\s*=\s*"
    r"arg\s*max(?:\s*[A-Za-z0-9])?\s*"
    r"(?P<weight>[A-Za-z])\s*(?P<sub>[A-Za-z0-9])(?=[^A-Za-z0-9]|$)",
    flags=re.IGNORECASE,
)


def _load_formula_candidates(formula_dir: Optional[Path]) -> Dict[int, Dict[str, List[str]]]:
    """Load page-level Nougat display and inline candidates.

    The candidates are deliberately kept separate from MinerU's selected
    formulas.  They are evidence for repairing a residual text span, not a
    second renderer whose output should replace the layout sidecar wholesale.
    """
    candidates: Dict[int, Dict[str, List[str]]] = {}
    if not formula_dir or not formula_dir.is_dir():
        return candidates
    for path in sorted(formula_dir.glob("page-*.mmd")):
        match = re.search(r"page-(\d+)\.mmd$", path.name)
        if not match:
            continue
        text = _read_text(path)
        display = re.findall(r"\\\[(.*?)\\\]", text, flags=re.S)
        if not display:
            display = re.findall(r"(?ms)^\s*\$\$\s*\n(.*?)^\s*\$\$\s*$", text)
        inline = re.findall(r"\\\((.*?)\\\)", text, flags=re.S)
        candidates[int(match.group(1))] = {
            "display": [item.strip() for item in display if item.strip()],
            "inline": [item.strip() for item in inline if item.strip()],
        }
    return candidates


def _tex_signature(value: str) -> str:
    """Return a whitespace-insensitive signature for candidate alignment."""
    tex = _normalize_tex(value)
    tex = re.sub(r"\\operatorname\*?\s*\{\s*arg\\,?\s*max\s*\}", "argmax", tex)
    tex = re.sub(
        r"\\(?:mathbf|mathrm|mathbb|mathcal|mathit|mathtt|mathsf)\s*",
        "",
        tex,
    )
    tex = re.sub(r"\\(?:left|right|,|;|!|quad|qquad)\s*", "", tex)
    return re.sub(r"\s+", "", tex).lower()


def _loose_tex_signature(value: str) -> str:
    """Normalize harmless layout wrappers for MinerU/Nougat alignment."""
    tex = _tex_signature(value)
    tex = re.sub(r"\\begin\{array\}\{[^{}]*\}|\\end\{array\}", "", tex)
    tex = re.sub(r"\\bar", "", tex)
    tex = tex.replace("\\cdot", "")
    # Array cells are often wrapped in one extra pair of braces by MinerU.
    return tex.replace("{", "").replace("}", "")


def _candidate_is_complex(tex: str) -> bool:
    """Only treat structurally mathematical candidates as repair evidence."""
    normalized = _normalize_tex(tex)
    if len(normalized) < 6:
        return False
    has_structure = "=" in normalized or bool(
        re.search(r"\\(?:sum|frac|operator|sqrt|int|prod|begin)\b", normalized)
    )
    has_math_tokens = "^" in normalized or "_" in normalized or "\\" in normalized
    return bool(has_structure and has_math_tokens)


def _plain_text_with_spans(value: str) -> Tuple[str, List[Tuple[int, int]]]:
    """Drop harmless inline HTML tags while retaining raw-string offsets."""
    chars: List[str] = []
    spans: List[Tuple[int, int]] = []
    cursor = 0
    for match in INLINE_MARKUP_RE.finditer(value):
        for index in range(cursor, match.start()):
            char = value[index]
            if char in {"∗", "⋆"}:
                char = "*"
            chars.append(char)
            spans.append((index, index + 1))
        cursor = match.end()
    for index in range(cursor, len(value)):
        char = value[index]
        if char in {"∗", "⋆"}:
            char = "*"
        chars.append(char)
        spans.append((index, index + 1))
    return "".join(chars), spans


def _candidate_relevant_to_text(tex: str, value: str) -> bool:
    plain, _ = _plain_text_with_spans(value)
    lower = plain.lower()
    if re.search(r"arg\\,?\s*max|arg\s*max", tex, flags=re.IGNORECASE):
        return "arg" in lower and "max" in lower
    if "\\frac" in tex or "\\sum" in tex:
        return any(token in lower for token in ("sum", "fraction", "output"))
    return False


def _cleanup_formula_adjacent_ocr(value: str) -> str:
    """Remove the narrow OCR marker left between a formula and its cross-ref.

    MinerU occasionally emits ``Tab. 7 k (d)`` after the inline formula.  The
    single-letter token is only removed in this exact cross-reference shape;
    ordinary prose and valid labels such as ``Tab. 7 (d)`` are untouched.
    """
    return re.sub(
        r"(\b(?:Tab(?:le)?|Fig(?:ure)?|Eq(?:uation)?)\.?\s*\d+)\s+([A-Za-z])\s+(\([a-z]\))",
        r"\1 \3",
        value,
        flags=re.IGNORECASE,
    )


def _find_candidate_match(value: str, tex: str) -> Optional[Tuple[int, int, str]]:
    """Find a high-confidence residual span and return raw offsets.

    At present the important residual class is the arg-max expression emitted
    as ``k<sup>*</sup> = arg max w<sub>k</sub>``.  Other complex candidates are
    left untouched unless a future extractor supplies an explicit span; this
    avoids turning ordinary prose into formula markup.
    """
    if not re.search(r"arg\\,?\s*max|arg\s*max", tex, flags=re.IGNORECASE):
        return None
    plain, spans = _plain_text_with_spans(value)
    match = ARGMAX_TEXT_RE.search(plain)
    if not match or not spans:
        return None
    start = spans[match.start()][0]
    end = spans[match.end() - 1][1]
    # The plain-text match omits markup tags. Include any closing ``sub`` /
    # ``sup`` tag immediately following the matched character so we do not
    # leave an orphaned tag in the surrounding paragraph.
    while end < len(value):
        tag = INLINE_MARKUP_RE.match(value, end)
        if not tag:
            break
        end = tag.end()
    return start, end, value[start:end]


def _repair_text_piece(
    value: str,
    candidates: Sequence[str],
    used: Set[int],
    renderer: "MathRenderer",
    emphasis: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Tuple[str, str, List[dict]]:
    """Repair only high-confidence formula-like fragments in a text piece."""
    raw = "" if value is None else str(value)
    replacements: List[Tuple[int, int, str, str, dict]] = []
    for index, tex in sorted(
        enumerate(candidates),
        key=lambda item: len(_normalize_tex(item[1])),
        reverse=True,
    ):
        if index in used or not _candidate_is_complex(tex):
            continue
        found = _find_candidate_match(raw, tex)
        if not found:
            continue
        start, end, original = found
        if any(start < existing_end and end > existing_start for existing_start, existing_end, *_ in replacements):
            continue
        clean = _clean_tex(tex)
        rendered = renderer.render(tex, display=False)
        audit = {
            "kind": "inline-repaired",
            "tex": tex,
            "source": "nougat-page",
            "confidence": "high",
            "original_text": original,
            "repaired_text": clean,
            "replacement_markdown": f"${clean}$",
            "render_mode": renderer.mode(tex, display=False),
        }
        replacements.append((start, end, rendered, f"${clean}$", audit))
        used.add(index)

    if not replacements:
        return _safe_inline_with_emphasis(raw, emphasis), raw, []

    html_parts: List[str] = []
    markdown_parts: List[str] = []
    audits: List[dict] = []
    cursor = 0
    for start, end, rendered, markdown, audit in sorted(replacements, key=lambda item: item[0]):
        html_parts.append(_safe_inline_with_emphasis(raw[cursor:start], _emphasis_for_slice(emphasis or [], cursor, start)))
        html_parts.append(rendered)
        markdown_parts.append(raw[cursor:start])
        markdown_parts.append(markdown)
        audits.append(audit)
        cursor = end
    html_parts.append(_safe_inline_with_emphasis(raw[cursor:], _emphasis_for_slice(emphasis or [], cursor, len(raw))))
    markdown_parts.append(raw[cursor:])
    return "".join(html_parts), "".join(markdown_parts), audits


class MathRenderer:
    """Render MathML when Pandoc is installed, with a visible TeX fallback."""

    def __init__(self) -> None:
        self.cache: Dict[Tuple[str, bool], str] = {}
        self.modes: Dict[Tuple[str, bool], str] = {}
        configured = os.environ.get("MY_SCHOLAR_PANDOC")
        candidates = [configured or ""]
        if not getattr(sys, "frozen", False):
            candidates.extend([
                shutil.which("pandoc") or "",
                "/opt/anaconda3/bin/pandoc",
                "/opt/homebrew/bin/pandoc",
                "/usr/local/bin/pandoc",
            ])
        self.pandoc = next((path for path in candidates if path and Path(path).is_file()), None)

    @staticmethod
    def _pandoc_tex(tex: str) -> str:
        """Normalize extractor operators that older Pandoc cannot parse."""
        # Pandoc 2.x parses the equivalent ``mathop{mathrm{...}}`` form while
        # rejecting ``operatorname*`` when a following subscript is present.
        tex = re.sub(
            r"\\operatorname\*?\s*\{\s*arg\\,?\s*max\s*\}",
            r"\\mathop{\\mathrm{arg\\,max}}",
            tex,
            flags=re.IGNORECASE,
        )
        # MinerU emits ``\begin{array} { r l }``; Pandoc rejects the column
        # spec once whitespace separates it from the environment or sits
        # between the letters, so join and despace that one argument.
        tex = re.sub(
            r"(\\begin\{array\})\s*\{([^{}]*)\}",
            lambda match: match.group(1) + "{" + re.sub(r"\s+", "", match.group(2)) + "}",
            tex,
        )
        # Pandoc's texmath knows ``\phantom`` but not the h/v variants.
        return re.sub(r"\\[hv]phantom(?![A-Za-z])", r"\\phantom", tex)

    def render(self, tex: str, display: bool) -> str:
        source_tex = _clean_tex(tex)
        tex = _normalize_tex(source_tex)
        if not tex:
            return ""
        key = (tex, display)
        if key in self.cache:
            return self.cache[key]
        tag_match = TAG_RE.search(tex)
        number = tag_match.group(1).strip() if tag_match else None
        tex_for_mathml = TAG_RE.sub("", tex).strip()
        rendered = ""
        if self.pandoc:
            source_tex = self._pandoc_tex(tex_for_mathml)
            source = f"$$\n{source_tex}\n$$" if display else f"${source_tex}$"
            try:
                completed = subprocess.run(
                    [self.pandoc, "--from=markdown+tex_math_dollars+tex_math_single_backslash",
                     "--to=html5", "--mathml"],
                    input=source, text=True, capture_output=True, check=False, timeout=20,
                )
                match = re.search(r"<math\b.*?</math>", completed.stdout or "", flags=re.S)
                if match:
                    rendered = match.group(0)
            except (OSError, subprocess.TimeoutExpired):
                rendered = ""
        if not rendered:
            cls = "math-display" if display else "math-inline"
            fallback_tex = self._pandoc_tex(tex_for_mathml)
            rendered = (
                f'<span class="{cls} math-fallback" data-tex="{html.escape(fallback_tex, quote=True)}">'
                f"<code>{_safe_inline(fallback_tex)}</code></span>"
            )
            self.modes[key] = "fallback"
        else:
            cls = "math-display" if display else "math-inline"
            rendered = (
                f'<span class="{cls} math-rendered" data-tex="{html.escape(source_tex, quote=True)}">'
                f"{rendered}</span>"
            )
            self.modes[key] = "mathml"
        if display:
            result = f'<div class="equation-line">{rendered}'
            if number:
                result += f'<span class="equation-number">({html.escape(number)})</span>'
            result += "</div>"
        else:
            result = rendered
        self.cache[key] = result
        return result

    def mode(self, tex: str, display: bool) -> str:
        """Return the renderer mode after ``render`` has been called."""
        return self.modes.get((_normalize_tex(tex), display), "unknown")


def _load_display_formulas(formula_dir: Optional[Path]) -> Dict[int, List[str]]:
    candidates = _load_formula_candidates(formula_dir)
    return {
        page: [item for item in values.get("display", []) if len(item.strip()) > 4]
        for page, values in candidates.items()
        if any(len(item.strip()) > 4 for item in values.get("display", []))
    }


# Layout sidecar discovery and optional MinerU execution.
def _first_page_text(path: Path) -> str:
    try:
        stat = path.stat()
        cache_key = (str(path.resolve()), int(stat.st_mtime_ns), int(stat.st_size))
    except OSError:
        return ""
    with DISCOVERY_CACHE_LOCK:
        if cache_key in FIRST_PAGE_CACHE:
            return FIRST_PAGE_CACHE[cache_key]
    try:
        import fitz  # type: ignore

        with fitz.open(path) as doc:
            text = doc[0].get_text("text") if doc.page_count else ""
        normalized = re.sub(r"\W+", " ", text.lower())
        with DISCOVERY_CACHE_LOCK:
            FIRST_PAGE_CACHE[cache_key] = normalized
            if len(FIRST_PAGE_CACHE) > 256:
                FIRST_PAGE_CACHE.pop(next(iter(FIRST_PAGE_CACHE)))
        return normalized
    except Exception:
        return ""


def _cached_discovery(root: Path, pattern: str, ttl: float = 60.0) -> List[Path]:
    key = (str(root.resolve()), pattern)
    now = time.monotonic()
    with DISCOVERY_CACHE_LOCK:
        cached = DISCOVERY_CACHE.get(key)
        if cached and cached[0] > now:
            return list(cached[1])
    values = sorted(root.glob(pattern)) if root.is_dir() else []
    with DISCOVERY_CACHE_LOCK:
        DISCOVERY_CACHE[key] = (now + ttl, values)
    return list(values)


def _sidecar_matches_pdf(sidecar: Path, pdf_path: Path, source_text: str = "") -> bool:
    """Avoid accidentally applying a cached result to an unrelated upload."""
    origin_candidates = list(sidecar.parent.glob("*_origin.pdf"))
    if not origin_candidates:
        return False
    source_text = source_text or _first_page_text(pdf_path)
    origin_text = _first_page_text(origin_candidates[0])
    if not source_text or not origin_text:
        return pdf_path.stem.lower() in sidecar.stem.lower()
    source_tokens = set(source_text.split())
    origin_tokens = set(origin_text.split())
    if not source_tokens or not origin_tokens:
        return False
    overlap = len(source_tokens & origin_tokens) / max(1, len(source_tokens | origin_tokens))
    return overlap >= 0.35


def _find_layout_sidecar(pdf_path: Path, source_name: Optional[str] = None) -> Tuple[Optional[Path], str]:
    explicit = os.environ.get("MY_SCHOLAR_LAYOUT_JSON")
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not path.is_file():
            raise LayoutPipelineError(f"MY_SCHOLAR_LAYOUT_JSON 不存在：{path}")
        return path, "configured-sidecar"

    # A local precomputed sidecar is useful for the paper used in the product
    # smoke test, but it is accepted only after a first-page text check.
    root = _pdf_tools_path("results")
    stem = Path(source_name or pdf_path.name).stem
    candidates = sorted(root.glob(f"**/{stem}/auto/*_content_list_v2.json"))
    # Some upload handlers use a temporary ``upload.pdf`` path.  If the
    # original name did not produce a direct match, scan cached content lists
    # and retain only those whose first-page text matches the upload.
    if not candidates:
        candidates = _cached_discovery(root, "**/*_content_list_v2.json")
    source_text = _first_page_text(pdf_path)
    for candidate in candidates:
        if _sidecar_matches_pdf(candidate, pdf_path, source_text):
            return candidate, "cached-mineru-sidecar"

    if os.environ.get("MY_SCHOLAR_DISABLE_MINERU", "").lower() in {"1", "true", "yes"}:
        return None, "disabled"
    candidate, failure = discover_mineru(project_root=PROJECT_ROOT)
    if candidate:
        return candidate.executable, "mineru-executable"
    if failure and os.environ.get("MY_SCHOLAR_MINERU"):
        raise LayoutPipelineError(f"MY_SCHOLAR_MINERU 不可用：{failure}")
    return None, "unavailable"


def _mineru_health_failure(executable: Path) -> Optional[str]:
    try:
        stat = executable.stat()
    except OSError as exc:
        return str(exc)
    key = (str(executable), int(stat.st_mtime_ns))
    with DISCOVERY_CACHE_LOCK:
        if key in MINERU_HEALTH_CACHE:
            return MINERU_HEALTH_CACHE[key]
    failure: Optional[str] = None
    try:
        with executable.open("r", encoding="utf-8", errors="replace") as stream:
            first_line = stream.readline(4096).strip()
        if first_line.startswith("#!"):
            interpreter = first_line[2:].strip().split()[0]
            if interpreter.startswith("/") and not Path(interpreter).is_file():
                failure = f"启动解释器不存在：{interpreter}"
        if failure is None:
            completed = subprocess.run(
                [str(executable), "--help"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace", check=False, timeout=20,
            )
            if completed.returncode != 0:
                detail = (completed.stdout or "").strip().splitlines()
                failure = f"健康检查退出码 {completed.returncode}" + (f"：{detail[-1]}" if detail else "")
    except (OSError, subprocess.TimeoutExpired) as exc:
        failure = f"健康检查失败：{exc}"
    with DISCOVERY_CACHE_LOCK:
        MINERU_HEALTH_CACHE.clear()
        MINERU_HEALTH_CACHE[key] = failure
    return failure


def _find_formula_dir(pdf_path: Path, source_name: Optional[str] = None) -> Optional[Path]:
    explicit = os.environ.get("MY_SCHOLAR_FORMULA_DIR")
    if explicit:
        path = Path(explicit).expanduser().resolve()
        return path if path.is_dir() else None
    root = _pdf_tools_path("results")
    for manifest in _cached_discovery(root, "**/nougat-pages/manifest.json"):
        try:
            data = json.loads(_read_text(manifest))
        except (OSError, json.JSONDecodeError):
            continue
        source = str(data.get("source_pdf", ""))
        if Path(source).name in {pdf_path.name, Path(source_name or "").name}:
            return manifest.parent
    return None


def _stop_mineru_process(process: subprocess.Popen) -> None:
    # stdout is owned by the _MineruOutputMonitor reader thread, so this only
    # terminates the process group and must never call communicate().
    if process.poll() is None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except (OSError, ProcessLookupError):
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except (OSError, ProcessLookupError):
            pass
        process.wait()


MINERU_PROGRESS_RE = re.compile(
    r"^(?P<stage>[A-Za-z][A-Za-z0-9 ()/_-]{0,48}):\s+\d{1,3}%\|.*\|\s*(?P<done>\d+)/(?P<total>\d+)\b"
)

# Window boundaries follow the measured share of a hybrid-engine run, where
# the VLM "Predict" bars consume ~90% of the wall time; unknown bars keep the
# monotonic floor so progress never moves backwards across stages.
_MINERU_STAGE_WINDOWS = (
    ("layout predict", "版面检测", 0.02, 0.08),
    ("table orientation", "表格方向分析", 0.08, 0.10),
    ("mfd predict", "公式检测", 0.10, 0.12),
    ("mfr predict", "公式识别", 0.12, 0.16),
    ("processing pages", "汇总解析结果", 0.96, 1.0),
    ("ocr-det", "文字检测", 0.88, 0.94),
    ("ocr-rec", "文字识别", 0.94, 0.96),
    ("predict", "AI 深度解析", 0.16, 0.88),
)


def _mineru_progress_update(line: str) -> Optional[Tuple[str, int, int]]:
    match = MINERU_PROGRESS_RE.match(line)
    if not match:
        return None
    done = int(match.group("done"))
    total = int(match.group("total"))
    if total <= 0 or done > total:
        return None
    return match.group("stage").strip(), done, total


class _MineruOutputMonitor:
    """Drain MinerU stdout while it runs.

    Keeps the transcript for ``mineru.log`` and turns the tqdm bars (separated
    by carriage returns, tail-buffered per chunk) into progress callbacks; the
    run is otherwise silent for minutes during local VLM inference.
    """

    def __init__(self, stream: Any, progress: Optional[Callable[[str, float], None]]) -> None:
        self._stream = stream
        self._progress = progress
        self._chunks: List[bytes] = []
        self._pending = b""
        self._thread: Optional[threading.Thread] = None
        self._latest: Optional[Tuple[str, int, int]] = None
        self._reported: Optional[Tuple[str, int, int]] = None
        self._reported_at = 0.0
        self._floor = 0.0

    def start(self) -> None:
        if self._stream is None:
            return
        self._thread = threading.Thread(target=self._drain, name="mineru-output", daemon=True)
        self._thread.start()

    def _drain(self) -> None:
        try:
            fd = self._stream.fileno()
        except (OSError, ValueError, AttributeError):
            return
        while True:
            try:
                chunk = os.read(fd, 4096)
            except (OSError, ValueError):
                break
            if not chunk:
                break
            self._chunks.append(chunk)
            self._pending += chunk
            *lines, self._pending = re.split(rb"[\r\n]", self._pending)
            for raw in lines:
                update = _mineru_progress_update(raw.decode("utf-8", "replace").strip())
                if update is not None:
                    self._latest = update

    def emit(self) -> None:
        # Runs on the polling thread so a cancellation raised by the progress
        # callback unwinds through _run_mineru, not the reader thread.
        if self._progress is None:
            return
        latest = self._latest
        if latest is None or latest == self._reported:
            return
        now = time.monotonic()
        if self._reported is not None and latest[0] == self._reported[0] and now - self._reported_at < 0.5:
            return
        stage, done, total = latest
        label, fraction = self._describe(stage, done, total)
        self._reported = latest
        self._reported_at = now
        self._progress(label, fraction)

    def _describe(self, stage: str, done: int, total: int) -> Tuple[str, float]:
        lowered = stage.lower()
        label = stage
        fraction = self._floor
        for prefix, name, start, end in _MINERU_STAGE_WINDOWS:
            if lowered.startswith(prefix):
                label = name
                fraction = start + (end - start) * (done / total)
                break
        self._floor = max(self._floor, min(1.0, fraction))
        return f"{label} {done}/{total}", self._floor

    def close(self) -> None:
        if self._thread is not None:
            self._thread.join(timeout=5)
        try:
            if self._stream is not None:
                self._stream.close()
        except OSError:
            pass

    def transcript(self) -> str:
        return b"".join(self._chunks).decode("utf-8", "replace")


def normalize_mineru_backend(value: Any) -> str:
    """Resolve the MinerU backend, preferring the caller over the environment.

    ``hybrid-engine`` matches MinerU's own default and parses formulas and
    layout far more accurately, but it downloads and runs a VLM, so an
    unrecognized value falls back to the light ``pipeline`` backend.
    """
    for candidate in (value, os.environ.get("MY_SCHOLAR_MINERU_BACKEND")):
        normalized = str(candidate or "").strip().lower()
        if normalized in MINERU_BACKENDS:
            return normalized
    return DEFAULT_MINERU_BACKEND


def is_remote_mineru_backend(value: Any) -> bool:
    return normalize_mineru_backend(value) in REMOTE_MINERU_BACKENDS


def normalize_mineru_server_url(value: Any) -> str:
    """Validate the MinerU server address, preferring the caller over the env.

    Only http and https are accepted: the value becomes a subprocess argument,
    so anything else (file://, a shell fragment) must be rejected here rather
    than handed to the CLI.
    """
    for candidate in (value, os.environ.get("MY_SCHOLAR_MINERU_SERVER_URL")):
        raw = str(candidate or "").strip()
        if not raw:
            continue
        parsed = urllib.parse.urlsplit(raw)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise LayoutPipelineError(f"版面引擎服务器地址无效：{raw}")
        if parsed.query or parsed.fragment:
            raise LayoutPipelineError("版面引擎服务器地址不能包含查询参数或片段。")
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
    return ""


def _run_mineru(
    executable: Path,
    pdf_path: Path,
    output: Path,
    *,
    backend: Optional[str] = None,
    server_url: Optional[str] = None,
    runtime_root: Optional[Path] = None,
    cancel_event: Any = None,
    progress: Optional[Callable[[str, float], None]] = None,
) -> Path:
    executable = Path(executable).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    resolved_backend = normalize_mineru_backend(backend)
    command = [
        str(executable), "-p", str(pdf_path), "-o", str(output),
        "-b", resolved_backend,
        "-m", "auto", "-f", "true", "-t", "true",
    ]
    if resolved_backend in REMOTE_MINERU_BACKENDS:
        resolved_url = normalize_mineru_server_url(server_url)
        if not resolved_url:
            raise LayoutPipelineError("远程版面解析需要先在设置中填写服务器地址。")
        command += ["-u", resolved_url]
    semaphore = MINERU_REMOTE_SEMAPHORE if resolved_backend in REMOTE_MINERU_BACKENDS else MINERU_SEMAPHORE
    acquired = False
    process: Optional[subprocess.Popen] = None
    monitor: Optional[_MineruOutputMonitor] = None
    try:
        waiting_reported = False
        while not acquired:
            _raise_if_cancelled(cancel_event)
            acquired = semaphore.acquire(timeout=0.2)
            if not acquired and not waiting_reported and progress is not None:
                progress("排队等待版面引擎空闲", 0.0)
                waiting_reported = True
        _raise_if_cancelled(cancel_event)
        options: Dict[str, Any] = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.STDOUT,
        }
        if os.name == "posix":
            options["start_new_session"] = True
        elif os.name == "nt":
            options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if runtime_root is not None:
            managed_root = Path(runtime_root).expanduser().resolve()
            try:
                executable.resolve().relative_to(managed_root)
            except ValueError as exc:
                raise LayoutPipelineError("MinerU 可执行文件不在受管组件目录中。") from exc
            cache_root = managed_root / "runtime-cache"
            temp_root = output / ".runtime-tmp"
            cache_root.mkdir(parents=True, exist_ok=True)
            temp_root.mkdir(parents=True, exist_ok=True)
            environment = dict(os.environ)
            for key in ("CONDA_PREFIX", "PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"):
                environment.pop(key, None)
            environment.update({
                "PATH": f"{executable.parent}:/usr/bin:/bin:/usr/sbin:/sbin",
                "PYTHONNOUSERSITE": "1",
                "HF_HUB_OFFLINE": "1",
                "HF_DATASETS_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "HF_HOME": str(cache_root / "huggingface"),
                "MODELSCOPE_CACHE": str(cache_root / "modelscope"),
                "XDG_CACHE_HOME": str(cache_root),
                "TMPDIR": str(temp_root),
                "MY_SCHOLAR_MINERU_COMPONENT_ROOT": str(managed_root),
            })
            options["cwd"] = str(managed_root)
            options["env"] = environment
        process = subprocess.Popen(command, **options)
        monitor = _MineruOutputMonitor(process.stdout, progress)
        monitor.start()
        if progress is not None:
            progress("启动本地版面引擎", 0.0)
        deadline = time.monotonic() + int(os.environ.get("MY_SCHOLAR_MINERU_TIMEOUT", "900"))
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise LayoutPipelineCancelled("AI 重排已取消。")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LayoutPipelineError("MinerU 运行超时。")
            if process.poll() is not None:
                break
            monitor.emit()
            time.sleep(min(0.25, remaining))
    except LayoutPipelineError:
        raise
    except OSError as exc:
        raise LayoutPipelineError(f"MinerU 运行失败：{exc}") from exc
    finally:
        if process is not None:
            _stop_mineru_process(process)
        if monitor is not None:
            monitor.close()
        if acquired:
            semaphore.release()
        if process is not None:
            (output / "mineru.log").write_text(monitor.transcript() if monitor else "", encoding="utf-8")
    if process is None or process.returncode != 0:
        returncode = process.returncode if process is not None else "unknown"
        raise LayoutPipelineError(f"MinerU 退出码 {returncode}，详见 mineru.log")
    matches = sorted(output.rglob("*_content_list_v2.json"))
    if not matches:
        raise LayoutPipelineError("MinerU 未生成 content_list_v2.json")
    return matches[0]


def _copy_sidecar_images(
    sidecar: Path,
    assets: Path,
    *,
    budget: Optional[LayoutRenderBudget] = None,
) -> Dict[str, str]:
    source_dir = sidecar.parent / "images"
    assets.mkdir(parents=True, exist_ok=True)
    mapping: Dict[str, str] = {}
    active_budget = budget or LayoutRenderBudget()
    if not source_dir.is_dir():
        return mapping
    remaining_files = active_budget.max_sidecar_files - active_budget.sidecar_files
    remaining_operations = active_budget.max_operations - active_budget.operations
    remaining_entries = max(0, min(remaining_files, remaining_operations))
    candidates = list(islice(source_dir.iterdir(), remaining_entries + 1))
    if len(candidates) > remaining_entries:
        reason = "operation-count" if remaining_operations <= remaining_files else "sidecar-count"
        active_budget.record_fallback(reason, "sidecar", "remaining-directory-entries")
        candidates = candidates[:remaining_entries]
    for source in sorted(candidates):
        if not source.is_file() or source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            continue
        try:
            source_bytes = source.stat().st_size
        except OSError:
            active_budget.record_fallback("sidecar-stat-error", "sidecar", source.name)
            continue
        if not active_budget.reserve_sidecar(source.name, source_bytes):
            continue
        target = assets / source.name
        if target.exists() and target.stat().st_size != source.stat().st_size:
            target = assets / f"{source.stem}-{len(mapping) + 1}{source.suffix}"
        temporary_handle = tempfile.NamedTemporaryFile(
            prefix=".sidecar-",
            suffix=source.suffix,
            dir=assets,
            delete=False,
        )
        temporary = Path(temporary_handle.name)
        temporary_handle.close()
        try:
            actual_bytes = 0
            grew_during_copy = False
            with source.open("rb") as input_stream, temporary.open("wb") as output_stream:
                while actual_bytes < source_bytes:
                    chunk = input_stream.read(min(1024 * 1024, source_bytes - actual_bytes))
                    if not chunk:
                        break
                    output_stream.write(chunk)
                    actual_bytes += len(chunk)
                grew_during_copy = bool(input_stream.read(1))
            if grew_during_copy:
                active_budget.record_fallback(
                    "sidecar-size-changed",
                    "sidecar",
                    source.name,
                    attempted_bytes=source_bytes + 1,
                )
                continue
            shutil.copystat(source, temporary)
            actual_bytes = temporary.stat().st_size
            if not active_budget.finish_sidecar(source.name, source_bytes, actual_bytes):
                continue
            os.replace(temporary, target)
        except OSError:
            active_budget.record_fallback("sidecar-copy-error", "sidecar", source.name)
            continue
        finally:
            temporary.unlink(missing_ok=True)
        mapping[source.name] = f"assets/images/{target.name}"
    return mapping


def _which(candidates: Sequence[str]) -> Optional[str]:
    for candidate in candidates:
        if candidate and (Path(candidate).is_file() or shutil.which(candidate)):
            return candidate if Path(candidate).is_file() else shutil.which(candidate)
    return None


# PDF page rendering, high-density visual crops and asset normalization.
def _render_pages(pdf_path: Path, target: Path, page_count: int, dpi: int = 144) -> List[str]:
    target.mkdir(parents=True, exist_ok=True)
    for existing in target.glob("page-*.png"):
        existing.unlink(missing_ok=True)
    rendered: List[str] = []
    try:
        import fitz  # type: ignore

        with fitz.open(pdf_path) as doc:
            if len(doc) < page_count:
                raise LayoutPipelineError("PDF 实际页数少于解析结果。")
            scale = dpi / 72.0
            matrix = fitz.Matrix(scale, scale)
            for index in range(page_count):
                out = target / f"page-{index + 1:03d}.png"
                pix = doc[index].get_pixmap(matrix=matrix, alpha=False)
                pix.save(str(out))
                rendered.append(out.name)
        if len(rendered) == page_count and len(set(rendered)) == page_count:
            return rendered
    except Exception:
        for name in rendered:
            (target / name).unlink(missing_ok=True)
        rendered = []
    renderer_classpath = str(os.environ.get("MY_SCHOLAR_PDF_RENDERER_CLASSPATH", "")).strip()
    configured_java = str(os.environ.get("MY_SCHOLAR_JAVA", "")).strip()
    if renderer_classpath and configured_java:
        command = [
            str(Path(configured_java).expanduser().resolve()),
            "--add-opens=java.base/java.nio=ALL-UNNAMED",
            "-Djava.awt.headless=true",
            "-cp",
            renderer_classpath,
            "MyScholarPdfRenderer",
            str(pdf_path),
            str(target),
            str(dpi),
            str(page_count),
        ]
        try:
            subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True, timeout=600)
            rendered = [path.name for path in sorted(target.glob("page-*.png"))]
            if len(rendered) == page_count and len(set(rendered)) == page_count:
                return rendered
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
        for name in rendered:
            (target / name).unlink(missing_ok=True)
        rendered = []
    if getattr(sys, "frozen", False):
        return []
    pdftoppm = _which(["pdftoppm", "/opt/homebrew/bin/pdftoppm"])
    if not pdftoppm:
        return []
    with tempfile.TemporaryDirectory(prefix="my-scholar-pages-") as temp:
        prefix = Path(temp) / "page"
        command = [pdftoppm, "-png", "-r", str(dpi), "-f", "1", "-l", str(page_count), str(pdf_path), str(prefix)]
        try:
            subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True, timeout=600)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            return []
        for source in sorted(Path(temp).glob("page-*.png")):
            match = re.search(r"page-(\d+)\.png$", source.name)
            if not match:
                continue
            out = target / f"page-{int(match.group(1)):03d}.png"
            shutil.copy2(source, out)
            rendered.append(out.name)
    if len(rendered) != page_count or len(set(rendered)) != page_count:
        for name in rendered:
            (target / name).unlink(missing_ok=True)
        return []
    return rendered


def _png_dimensions(path: Path) -> Optional[Tuple[int, int]]:
    """Read PNG dimensions without requiring an image library in the bundle."""
    try:
        with Path(path).open("rb") as stream:
            header = stream.read(24)
        if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        width = int.from_bytes(header[16:20], "big")
        height = int.from_bytes(header[20:24], "big")
        return (width, height) if width > 0 and height > 0 else None
    except (OSError, ValueError):
        return None


def _visual_coordinate_canvas(
    items: Sequence[Dict[str, Any]],
    page_width: float,
    page_height: float,
) -> Tuple[float, float]:
    """Return the sidecar coordinate canvas for a rendered PDF page.

    MinerU content lists use a normalized 1000x1000 canvas. ODL sidecars use
    PDF points, so their canvas is the actual page size rather than the largest
    observed element (which may be a narrow figure). The coordinate source is
    authoritative when present; the size check keeps legacy sidecars working.
    """
    max_x = 0.0
    max_y = 0.0
    mineru_coordinates = False
    for item in items:
        if not isinstance(item, dict):
            continue
        box = item.get("bbox")
        if isinstance(box, (list, tuple)) and len(box) == 4:
            try:
                left, top, right, bottom = (float(value) for value in box)
            except (TypeError, ValueError):
                left = top = right = bottom = 0.0
            if right > left and bottom > top:
                max_x = max(max_x, right)
                max_y = max(max_y, bottom)
        ir_metadata = item.get("_ir") if isinstance(item.get("_ir"), dict) else {}
        if str(ir_metadata.get("source") or "").startswith("mineru"):
            mineru_coordinates = True
    if mineru_coordinates or max_x > page_width * 1.2 or max_y > page_height * 1.2:
        return 1000.0, 1000.0
    return max(1.0, float(page_width)), max(1.0, float(page_height))


def _render_pdf_visual_crops_java(
    pdf_path: Path,
    pages: List[List[Dict[str, Any]]],
    assets: Path,
    *,
    dpi: int,
    target_width_px: int,
    max_dpi: int,
    max_pixels: int,
    metadata: Dict[str, Dict[str, Any]],
    budget: LayoutRenderBudget,
    page_assets: Optional[Sequence[str]] = None,
    page_assets_dir: Optional[Path] = None,
    page_dpi: int = 144,
) -> Dict[str, str]:
    """Render crops through the bundled PDFBox helper when PyMuPDF is absent."""
    java = str(os.environ.get("MY_SCHOLAR_JAVA") or "").strip()
    classpath = str(os.environ.get("MY_SCHOLAR_PDF_RENDERER_CLASSPATH") or "").strip()
    if not java or not classpath or not Path(java).is_file() or not Path(pdf_path).is_file():
        return {}
    try:
        page_dpi = max(36, min(600, int(page_dpi)))
    except (TypeError, ValueError):
        page_dpi = 144
    assets.mkdir(parents=True, exist_ok=True)
    requests: List[Dict[str, Any]] = []
    used_targets: Set[str] = set()
    for page_index, items in enumerate(pages):
        page_size = None
        if page_assets_dir is not None and page_assets and page_index < len(page_assets):
            page_size = _png_dimensions(Path(page_assets_dir) / str(page_assets[page_index]))
        if page_size is None:
            page_size = (
                max(1, round(612.0 * page_dpi / 72.0)),
                max(1, round(792.0 * page_dpi / 72.0)),
            )
        page_width_px, page_height_px = page_size
        page_width_pt = page_width_px * 72.0 / page_dpi
        page_height_pt = page_height_px * 72.0 / page_dpi
        canvas_width, canvas_height = _visual_coordinate_canvas(items, page_width_pt, page_height_pt)
        for element_index, item in enumerate(items):
            if not isinstance(item, dict) or str(item.get("type") or "") not in {"image", "table"}:
                continue
            bbox = item.get("bbox")
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            try:
                left, top, right, bottom = (float(value) for value in bbox)
            except (TypeError, ValueError):
                continue
            left_ratio = max(0.0, min(1.0, left / canvas_width))
            top_ratio = max(0.0, min(1.0, top / canvas_height))
            right_ratio = max(0.0, min(1.0, right / canvas_width))
            bottom_ratio = max(0.0, min(1.0, bottom / canvas_height))
            if right_ratio <= left_ratio or bottom_ratio <= top_ratio:
                continue
            crop_width_pt = max(1.0, (right_ratio - left_ratio) * page_width_pt)
            crop_height_pt = max(1.0, (bottom_ratio - top_ratio) * page_height_pt)
            density_dpi = math.ceil(target_width_px * 72.0 / crop_width_pt)
            selected_dpi = min(max_dpi, max(dpi, density_dpi))
            cap_dpi = math.floor(72.0 * math.sqrt(max_pixels / (crop_width_pt * crop_height_pt)))
            requested_dpi = selected_dpi
            selected_dpi = max(1, min(selected_dpi, cap_dpi))
            pixel_cap_applied = selected_dpi < requested_dpi
            estimated_width = max(1, math.ceil(crop_width_pt * selected_dpi / 72.0) + 2)
            estimated_height = max(1, math.ceil(crop_height_pt * selected_dpi / 72.0) + 2)
            ir_metadata = item.get("_ir") if isinstance(item.get("_ir"), dict) else {}
            block_id = str(ir_metadata.get("block_id") or f"block-{page_index + 1}-{element_index}-{item.get('type')}")
            reservation = budget.reserve_visual(block_id, estimated_width * estimated_height)
            if reservation is None:
                metadata[block_id] = {
                    "asset": None, "actual_dpi": None, "visual_source": "source-fallback",
                    "fallback": True, "fallback_reason": budget.last_reason, "quality": "fallback",
                }
                continue
            safe_id = re.sub(r"[^A-Za-z0-9._-]+", "-", block_id).strip("-.") or f"{page_index + 1}-{element_index}"
            filename = f"pdf-{safe_id}@{selected_dpi}.png"
            if filename in used_targets:
                filename = f"pdf-{safe_id}-{element_index}@{selected_dpi}.png"
            used_targets.add(filename)
            target = assets / filename
            requests.append({
                "page": page_index + 1,
                "left": left_ratio,
                "top": top_ratio,
                "right": right_ratio,
                "bottom": bottom_ratio,
                "dpi": selected_dpi,
                "target": target,
                "block_id": block_id,
                "reservation": reservation,
                "pixel_cap_applied": pixel_cap_applied,
            })
    if not requests:
        return {}

    rendered: Dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="my-scholar-java-crops-") as temp:
        manifest = Path(temp) / "crops.tsv"
        manifest.write_text(
            "".join(
                f"{request['page']}\t{request['left']:.8f}\t{request['top']:.8f}\t"
                f"{request['right']:.8f}\t{request['bottom']:.8f}\t{request['dpi']}\t"
                f"{request['target']}\n"
                for request in requests
            ),
            encoding="utf-8",
        )
        command = [
            java,
            "--add-opens=java.base/java.nio=ALL-UNNAMED",
            "-Djava.awt.headless=true",
            "-cp",
            classpath,
            "MyScholarPdfRenderer",
            "--crop",
            str(pdf_path),
            str(manifest),
        ]
        try:
            subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True, timeout=600)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            for request in requests:
                request["target"].unlink(missing_ok=True)
                budget.reject_visual(request["block_id"], request["reservation"], "java-crop-render-error")
                metadata[request["block_id"]] = {
                    "asset": None, "actual_dpi": request["dpi"], "visual_source": "source-fallback",
                    "fallback": True, "fallback_reason": "java-crop-render-error", "quality": "fallback",
                }
            return {}

    for request in requests:
        target = request["target"]
        dimensions = _png_dimensions(target)
        if dimensions is None:
            budget.reject_visual(request["block_id"], request["reservation"], "java-crop-missing-output")
            metadata[request["block_id"]] = {
                "asset": None, "actual_dpi": request["dpi"], "visual_source": "source-fallback",
                "fallback": True, "fallback_reason": "java-crop-missing-output", "quality": "fallback",
            }
            continue
        pixel_width, pixel_height = dimensions
        png_bytes = target.stat().st_size
        if not budget.finish_visual(request["block_id"], request["reservation"], pixel_width * pixel_height, png_bytes):
            target.unlink(missing_ok=True)
            metadata[request["block_id"]] = {
                "asset": None, "actual_dpi": request["dpi"], "pixel_width": pixel_width,
                "pixel_height": pixel_height, "visual_source": "source-fallback", "fallback": True,
                "fallback_reason": budget.last_reason, "quality": "fallback",
            }
            continue
        asset = f"assets/images/{target.name}"
        rendered[request["block_id"]] = asset
        metadata[request["block_id"]] = {
            "asset": asset, "actual_dpi": request["dpi"], "pixel_width": pixel_width,
            "pixel_height": pixel_height, "visual_source": "pdf-crop", "fallback": False,
            "fallback_reason": None, "quality": "adaptive", "target_width_px": target_width_px,
            "target_width_met": pixel_width >= target_width_px,
            "pixel_cap_applied": request["pixel_cap_applied"], "max_pixels": max_pixels,
            "renderer": "pdfbox",
        }
    return rendered


def _render_pdf_visual_crops(
    pdf_path: Path,
    pages: List[List[Dict[str, Any]]],
    assets: Path,
    dpi: int = VISUAL_CROP_BASE_DPI,
    *,
    target_width_px: int = VISUAL_CROP_TARGET_WIDTH_PX,
    max_dpi: int = VISUAL_CROP_MAX_DPI,
    max_pixels: int = VISUAL_CROP_MAX_PIXELS,
    metadata: Optional[Dict[str, Dict[str, Any]]] = None,
    budget: Optional[LayoutRenderBudget] = None,
    page_assets: Optional[Sequence[str]] = None,
    page_assets_dir: Optional[Path] = None,
    page_dpi: int = 144,
) -> Dict[str, str]:
    """Render figure/table regions from the source PDF at reading resolution.

    MinerU's extracted JPEGs are useful evidence, but many are too small for a
    reflow reader.  The layout sidecar already supplies PDF-coordinate bboxes,
    so rasterising those regions from the original PDF preserves the page's
    vector detail without trying to reconstruct figures from fragments.  This
    controls output density only; it does not add detail missing from a raster
    image embedded in the source PDF.
    """
    try:
        base_dpi = max(1, min(VISUAL_CROP_MAX_DPI, int(dpi)))
    except (TypeError, ValueError):
        base_dpi = VISUAL_CROP_BASE_DPI
    try:
        maximum_dpi = max(1, min(VISUAL_CROP_MAX_DPI, int(max_dpi)))
    except (TypeError, ValueError):
        maximum_dpi = VISUAL_CROP_MAX_DPI
    base_dpi = min(base_dpi, maximum_dpi)
    try:
        target_width = max(1, int(target_width_px))
    except (TypeError, ValueError):
        target_width = VISUAL_CROP_TARGET_WIDTH_PX
    try:
        pixel_limit = max(1, int(max_pixels))
    except (TypeError, ValueError):
        pixel_limit = VISUAL_CROP_MAX_PIXELS
    try:
        import fitz  # type: ignore
    except Exception:
        return _render_pdf_visual_crops_java(
            pdf_path,
            pages,
            assets,
            dpi=base_dpi,
            target_width_px=target_width,
            max_dpi=maximum_dpi,
            max_pixels=pixel_limit,
            metadata=metadata if metadata is not None else {},
            budget=budget or LayoutRenderBudget(),
            page_assets=page_assets,
            page_assets_dir=page_assets_dir,
            page_dpi=page_dpi,
        )

    assets.mkdir(parents=True, exist_ok=True)
    rendered: Dict[str, str] = {}
    crop_metadata = metadata if metadata is not None else {}
    active_budget = budget or LayoutRenderBudget()
    try:
        document = fitz.open(pdf_path)
        for page_index, items in enumerate(pages):
            if page_index >= len(document):
                break
            page = document[page_index]
            canvas_width, canvas_height = _visual_coordinate_canvas(items, page.rect.width, page.rect.height)
            if canvas_width == page.rect.width and canvas_height == page.rect.height:
                scale_x = scale_y = 1.0
            else:
                scale_x = page.rect.width / canvas_width
                scale_y = page.rect.height / canvas_height
            for element_index, item in enumerate(items):
                if not isinstance(item, dict) or str(item.get("type", "")) not in {"image", "table"}:
                    continue
                bbox = item.get("bbox")
                if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                    continue
                try:
                    left, top, right, bottom = (float(value) for value in bbox)
                except (TypeError, ValueError):
                    continue
                # MinerU's v2 content list stores boxes on a normalized
                # 1000x1000 page canvas, while PyMuPDF exposes the source PDF
                # in points (612x792 for the OneLLM paper).  A direct
                # intersection would silently clip the right/bottom of wide
                # figures and tables.  Keep support for sidecars that already
                # use PDF points by detecting that smaller coordinate range.
                clip = fitz.Rect(
                    left * scale_x,
                    top * scale_y,
                    right * scale_x,
                    bottom * scale_y,
                ) & page.rect
                if clip.width <= 1 or clip.height <= 1:
                    continue
                ir_metadata = item.get("_ir") if isinstance(item.get("_ir"), dict) else {}
                block_id = str(ir_metadata.get("block_id") or f"block-{page_index + 1}-{element_index}-{item.get('type')}")
                density_dpi = math.ceil(target_width * 72.0 / clip.width)
                selected_dpi = min(maximum_dpi, max(base_dpi, density_dpi))
                cap_dpi = math.floor(72.0 * math.sqrt(pixel_limit / (clip.width * clip.height)))
                requested_dpi = selected_dpi
                selected_dpi = max(1, min(selected_dpi, cap_dpi))
                pixel_cap_applied = selected_dpi < requested_dpi
                scale = selected_dpi / 72.0
                estimated_width = max(1, math.ceil(clip.width * scale) + 2)
                estimated_height = max(1, math.ceil(clip.height * scale) + 2)
                reservation = active_budget.reserve_visual(
                    block_id,
                    estimated_width * estimated_height,
                )
                if reservation is None:
                    crop_metadata[block_id] = {
                        "asset": None,
                        "actual_dpi": None,
                        "visual_source": "source-fallback",
                        "fallback": True,
                        "fallback_reason": active_budget.last_reason,
                        "quality": "fallback",
                    }
                    continue
                budget_finalized = False
                target: Optional[Path] = None
                try:
                    pixmap = page.get_pixmap(
                        matrix=fitz.Matrix(scale, scale),
                        clip=clip,
                        alpha=False,
                    )
                    actual_pixels = pixmap.width * pixmap.height
                    if actual_pixels > pixel_limit:
                        active_budget.reject_visual(
                            block_id,
                            reservation,
                            "per-visual-pixels",
                            actual_pixels=actual_pixels,
                        )
                        crop_metadata[block_id] = {
                            "asset": None,
                            "actual_dpi": selected_dpi,
                            "pixel_width": pixmap.width,
                            "pixel_height": pixmap.height,
                            "visual_source": "source-fallback",
                            "fallback": True,
                            "fallback_reason": "per-visual-pixels",
                            "quality": "fallback",
                        }
                        continue
                    png = pixmap.tobytes("png")
                    if not active_budget.finish_visual(
                        block_id,
                        reservation,
                        actual_pixels,
                        len(png),
                    ):
                        crop_metadata[block_id] = {
                            "asset": None,
                            "actual_dpi": selected_dpi,
                            "pixel_width": pixmap.width,
                            "pixel_height": pixmap.height,
                            "visual_source": "source-fallback",
                            "fallback": True,
                            "fallback_reason": active_budget.last_reason,
                            "quality": "fallback",
                        }
                        continue
                    budget_finalized = True
                    target = assets / f"pdf-{block_id}@{selected_dpi}.png"
                    target.write_bytes(png)
                except Exception:
                    if target is not None:
                        target.unlink(missing_ok=True)
                    if budget_finalized:
                        active_budget.visual_outputs = max(0, active_budget.visual_outputs - 1)
                        active_budget.record_fallback("crop-write-error", "visual", block_id)
                    else:
                        active_budget.reject_visual(block_id, reservation, "render-error")
                    crop_metadata[block_id] = {
                        "asset": None,
                        "actual_dpi": selected_dpi,
                        "visual_source": "source-fallback",
                        "fallback": True,
                        "fallback_reason": "crop-write-error" if budget_finalized else "render-error",
                        "quality": "fallback",
                    }
                    continue
                asset = f"assets/images/{target.name}"
                rendered[block_id] = asset
                crop_metadata[block_id] = {
                    "asset": asset,
                    "actual_dpi": selected_dpi,
                    "pixel_width": pixmap.width,
                    "pixel_height": pixmap.height,
                    "visual_source": "pdf-crop",
                    "fallback": False,
                    "fallback_reason": None,
                    "quality": "adaptive",
                    "target_width_px": target_width,
                    "target_width_met": pixmap.width >= target_width,
                    "pixel_cap_applied": pixel_cap_applied,
                    "max_pixels": pixel_limit,
                }
        document.close()
    except Exception:
        return {}
    return rendered


def _visual_crop_base_dpi(value: Any = None) -> int:
    raw = os.environ.get("MY_SCHOLAR_VISUAL_DPI", str(VISUAL_CROP_BASE_DPI)) if value is None else value
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return VISUAL_CROP_BASE_DPI
    return max(VISUAL_CROP_BASE_DPI, min(VISUAL_CROP_MAX_DPI, parsed))


def _page_count(pdf_path: Path) -> int:
    try:
        import fitz  # type: ignore

        doc = fitz.open(pdf_path)
        count = len(doc)
        doc.close()
        return max(1, count)
    except Exception:
        return 1


def _asset_path(value: Optional[str], mapping: Dict[str, str]) -> Optional[str]:
    if not value:
        return None
    name = Path(str(value)).name
    return mapping.get(name)


def _normalize_table_html(raw: str) -> str:
    """Make MinerU's table usable in a narrow reader without changing spans."""
    raw = raw.strip()
    if not raw:
        return ""
    if not re.search(r"<table\b", raw, flags=re.I):
        return ""
    # The first row is a header in the public content-list output. Preserve
    # rowspan/colspan while improving semantics for screen readers.
    if not re.search(r"<th\b", raw, flags=re.I):
        first = re.search(r"<tr\b[^>]*>(.*?)</tr\s*>", raw, flags=re.I | re.S)
        if first:
            row = re.sub(r"<td\b", "<th", first.group(1), flags=re.I)
            row = re.sub(r"</td\s*>", "</th>", row, flags=re.I)
            raw = raw[:first.start(1)] + row + raw[first.end(1):]
    return raw


def _table_needs_review(raw: str) -> bool:
    widths: List[int] = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr\s*>", raw, flags=re.I | re.S):
        width = 0
        for cell in re.findall(r"<(?:td|th)\b([^>]*)>", row, flags=re.I):
            match = re.search(r"\bcolspan\s*=\s*[\"']?(\d+)", cell, flags=re.I)
            width += int(match.group(1)) if match else 1
        if width:
            widths.append(width)
    return len(widths) > 1 and len(set(widths)) > 1


def _linkify_text(value: str, refs: Set[int], anchors: Set[str], unresolved: List[str]) -> str:
    """Link citations/cross references in already escaped inline text."""
    parts = re.split(r"(<[^>]+>)", value)
    for index in range(0, len(parts), 2):
        text = parts[index]

        def replace_ref(match: re.Match[str]) -> str:
            raw = match.group(0)
            numbers: List[int] = []
            for token in re.split(r"\s*,\s*", match.group(1)):
                if "-" in token or "–" in token:
                    try:
                        start, end = re.split(r"\s*[-–]\s*", token)[:2]
                        numbers.extend(range(int(start), int(end) + 1))
                    except ValueError:
                        continue
                else:
                    try:
                        numbers.append(int(token.strip()))
                    except ValueError:
                        continue
            links = []
            for number in numbers:
                if number in refs:
                    links.append(f'<a class="citation" href="#ref-{number}" data-ref="{number}">[{number}]</a>')
                else:
                    unresolved.append(f"ref-{number}")
                    links.append(f"[{number}]")
            return ", ".join(links) if links else raw

        text = REF_RE.sub(replace_ref, text)

        def replace_cross(match: re.Match[str]) -> str:
            label = match.group(1)
            number = int(match.group(2))
            prefix = label.lower().replace(".", "")
            if prefix.startswith("fig"):
                anchor = f"fig-{number}"
            elif prefix.startswith("tab"):
                anchor = f"table-{number}"
            else:
                anchor = f"eq-{number}"
            if anchor not in anchors:
                unresolved.append(anchor)
                return match.group(0)
            return f'<a class="cross-reference" href="#{anchor}">{html.escape(label)} {number}</a>'

        parts[index] = CROSS_REF_RE.sub(replace_cross, text)
    return "".join(parts)


def _display_formula_list(
    item: Dict[str, Any],
    sidecar: Dict[int, List[str]],
    page_no: int,
    ordinal: int = 0,
    block_count: int = 1,
) -> List[str]:
    """Pick this block's display formulas from the page-level Nougat sidecar.

    Nougat candidates are page-scoped. A page with one interline block keeps
    the whole list (one MinerU block may hold several stacked equations), but
    with several blocks each takes its reading-order candidate — otherwise
    every block on the page would re-render the full page list — and the last
    block absorbs any leftovers.
    """
    content = item.get("content", {})
    mineru = str(content.get("math_content", "")) if isinstance(content, dict) else ""
    fallback = [mineru] if mineru.strip() else []
    candidates = sidecar.get(page_no) or []
    if not candidates:
        return fallback
    if block_count <= 1:
        return list(candidates)
    selected = candidates[ordinal:ordinal + 1] if ordinal < block_count - 1 else candidates[ordinal:]
    return selected or fallback


def _formula_tag(tex: str, default: int) -> int:
    match = TAG_RE.search(tex)
    if match:
        try:
            return int(re.sub(r"\D", "", match.group(1)))
        except ValueError:
            pass
    return default


@dataclass
class BuildState:
    refs: Set[int] = field(default_factory=set)
    anchors: Set[str] = field(default_factory=set)
    unresolved: List[str] = field(default_factory=list)
    next_equation: int = 1
    last_reference: Optional[int] = None
    reference_mode: bool = False


# Semantic HTML assembly for text, references, figures, tables and formulas.
def _extract_ref_numbers(pages: List[List[Dict[str, Any]]]) -> Set[int]:
    refs: Set[int] = set()
    for page in pages:
        for item in page:
            if item.get("type") != "list":
                continue
            content = item.get("content", {})
            if not isinstance(content, dict):
                continue
            for entry in content.get("list_items", []) or []:
                text = _text_from_content(entry)
                match = re.match(r"\s*\[(\d+)\]", text)
                if match:
                    refs.add(int(match.group(1)))
    return refs


def _find_anchor_numbers(pages: List[List[Dict[str, Any]]]) -> Set[str]:
    anchors: Set[str] = set()
    for page in pages:
        for item in page:
            kind = item.get("type")
            content = item.get("content", {})
            if not isinstance(content, dict):
                continue
            if kind == "image":
                text = _caption(content, "image_caption")
                match = re.search(r"(?:Figure|Fig\.?)[^0-9]*(\d+)", text, flags=re.I)
                if match:
                    anchors.add(f"fig-{int(match.group(1))}")
            elif kind == "table":
                text = _caption(content, "table_caption")
                for match in re.finditer(r"Table[^0-9]*(\d+)", text, flags=re.I):
                    anchors.add(f"table-{int(match.group(1))}")
            elif kind == "equation_interline":
                tex = str(content.get("math_content", ""))
                for number in TAG_RE.findall(tex):
                    digits = re.sub(r"\D", "", number)
                    if digits:
                        anchors.add(f"eq-{int(digits)}")
    return anchors


def _paragraph_html(
    item: Dict[str, Any],
    renderer: MathRenderer,
    state: BuildState,
    candidates: Optional[Sequence[str]] = None,
) -> Tuple[str, List[dict], List[dict], List[str], str]:
    content = item.get("content", {})
    pieces = content.get("paragraph_content", []) if isinstance(content, dict) else []
    candidate_values = list(candidates or [])
    used_candidates: Set[int] = set()
    formulas: List[dict] = []
    repairs: List[dict] = []
    output: List[str] = []
    markdown: List[str] = []
    relevance_text: List[str] = []
    for piece in pieces:
        if not isinstance(piece, dict):
            value = "" if piece is None else str(piece)
            output.append(_safe_inline(value))
            markdown.append(value)
            relevance_text.append(value)
            continue
        if piece.get("type") == "inline_marker":
            marker_html = _inline_marker_html(piece)
            if marker_html:
                output.append(marker_html)
                marker_text = {"circle": "—●", "square": "—■"}.get(str(piece.get("shape") or ""), "")
                markdown.append(marker_text)
                relevance_text.append(marker_text)
            continue
        if piece.get("type") == "equation_inline":
            tex = str(piece.get("content", ""))
            output.append(renderer.render(tex, display=False))
            tex_signature = _tex_signature(tex)
            loose_signature = _loose_tex_signature(tex)
            candidate_index = next(
                (
                    index
                    for index, candidate in enumerate(candidate_values)
                    if (
                        _tex_signature(candidate) == tex_signature
                        or (
                            len(tex_signature) >= 8
                            and len(_tex_signature(candidate)) >= 8
                            and (
                                _tex_signature(candidate) in tex_signature
                                or tex_signature in _tex_signature(candidate)
                            )
                        )
                        or (
                            len(loose_signature) >= 8
                            and len(_loose_tex_signature(candidate)) >= 8
                            and (
                                _loose_tex_signature(candidate) in loose_signature
                                or loose_signature in _loose_tex_signature(candidate)
                            )
                        )
                    )
                ),
                None,
            )
            if candidate_index is not None:
                used_candidates.add(candidate_index)
            formulas.append(
                {
                    "kind": "inline",
                    "tex": tex,
                    "source": "mineru-inline",
                    "candidate_tex": candidate_values[candidate_index] if candidate_index is not None else None,
                    "render_mode": renderer.mode(tex, display=False),
                }
            )
            markdown.append(f"${_clean_tex(tex)}$")
        else:
            value = piece.get("content", "")
            value = value if isinstance(value, str) else _text_from_content(value)
            html_piece, markdown_piece, piece_repairs = _repair_text_piece(
                value,
                candidate_values,
                used_candidates,
                renderer,
                piece.get("emphasis") if isinstance(piece.get("emphasis"), list) else None,
            )
            output.append(html_piece)
            markdown.append(markdown_piece)
            repairs.extend(piece_repairs)
            relevance_text.append(value)
    text = "".join(output).strip()
    markdown_text = "".join(markdown).strip()
    if repairs and any(
        re.search(r"arg\\,?\s*max|arg\s*max", str(item.get("tex", "")), flags=re.IGNORECASE)
        for item in repairs
    ):
        cleaned_text = _cleanup_formula_adjacent_ocr(text)
        cleaned_markdown = _cleanup_formula_adjacent_ocr(markdown_text)
        if cleaned_text != text or cleaned_markdown != markdown_text:
            for repair in repairs:
                repair["ocr_cleanup"] = "adjacent-cross-reference-token"
            text = cleaned_text
            markdown_text = cleaned_markdown
    text = _linkify_text(text, state.refs, state.anchors, state.unresolved)
    relevance = "".join(relevance_text)
    unresolved = [
        candidate
        for index, candidate in enumerate(candidate_values)
        if index not in used_candidates
        and _candidate_is_complex(candidate)
        and _candidate_relevant_to_text(candidate, relevance)
    ]
    return (
        f"<p>{text}</p>" if text else "",
        formulas,
        repairs,
        unresolved,
        markdown_text,
    )


def _title_html(item: Dict[str, Any], state: BuildState) -> Tuple[str, str]:
    content = item.get("content", {})
    level = 2
    if isinstance(content, dict):
        try:
            level = min(6, max(1, int(content.get("level", 2) or 2)))
        except (TypeError, ValueError):
            level = 2
    text = _text_from_content(content).strip()
    lower = text.lower()
    if re.search(r"\b(appendix|supplementary|supplemental material)\b", lower) or re.match(r"\s*appendix\s+[a-z0-9]", lower):
        kind = "appendix"
    elif re.search(r"\breferences?\b|bibliography", lower):
        kind = "references"
    else:
        kind = "body"
    return (f"<h{level}>{_linkify_text(_safe_inline(text), state.refs, state.anchors, state.unresolved)}</h{level}>" if text else ""), kind


def _is_abstract_title(text: str) -> bool:
    return bool(re.fullmatch(r"(?:abstract|摘\s*要)\s*(?:[:：.—-])?", text.strip(), flags=re.IGNORECASE))


def _inline_section_role(text: str) -> str:
    value = text.strip()
    if re.match(r"^(?:abstract|摘\s*要)\s*(?:[:：.\u2014-])\s*\S", value, flags=re.IGNORECASE):
        return "abstract-body"
    if re.match(r"^(?:index\s+terms?|key\s*words?|keywords?|关\s*键\s*词)\s*(?:[:：.\u2014-])\s*\S", value, flags=re.IGNORECASE):
        return "keywords"
    return ""


def _decorate_inline_section_label(block: str, section_role: str) -> str:
    if section_role == "abstract-body":
        label = r"(?:Abstract|摘\s*要)"
        label_class = "paper-section-label paper-abstract-label"
    elif section_role == "keywords":
        label = r"(?:Index\s+Terms?|Key\s*Words?|Keywords?|关\s*键\s*词)"
        label_class = "paper-section-label paper-keywords-label"
    else:
        return block
    pattern = re.compile(rf'(<p\b[^>]*>)(\s*)({label}\s*(?:[:：.\u2014-]+))', flags=re.IGNORECASE)
    return pattern.sub(
        lambda match: f'{match.group(1)}{match.group(2)}<strong class="{label_class}">{match.group(3)}</strong>',
        block,
        count=1,
    )


def _list_html(item: Dict[str, Any], state: BuildState) -> str:
    content = item.get("content", {})
    if not isinstance(content, dict):
        return ""
    list_type = str(content.get("list_type", ""))
    entries = content.get("list_items", []) or []
    is_refs = list_type == "reference_list" or state.reference_mode
    tag = "ol" if is_refs else "ul"
    classes = "references" if is_refs else "content-list"
    lines = [f'<{tag} class="{classes}">']
    for entry in entries:
        text = _text_from_content(entry).strip()
        number_match = re.match(r"\s*\[(\d+)\]\s*(.*)", text, flags=re.S)
        if is_refs and number_match:
            number = int(number_match.group(1))
            state.last_reference = number
            body = _safe_inline(number_match.group(2))
            lines.append(f'<li id="ref-{number}" data-ref="{number}"><span class="ref-number">[{number}]</span> {body}</li>')
        elif is_refs:
            body = _safe_inline(text)
            continuation = " reference-continuation" if state.last_reference else ""
            lines.append(f'<li class="reference-item{continuation}">{body}</li>')
        else:
            lines.append(f"<li>{_linkify_text(_safe_inline(text), state.refs, state.anchors, state.unresolved)}</li>")
    lines.append(f"</{tag}>")
    return "\n".join(lines)


def _image_or_crop(path: Optional[str], mapping: Dict[str, str], alt: str) -> str:
    source = _asset_path(path, mapping)
    if not source:
        return ""
    return f'<a class="asset-link" href="{html.escape(source, quote=True)}" target="_blank"><img src="{html.escape(source, quote=True)}" alt="{html.escape(alt, quote=True)}" loading="lazy"></a>'


def _image_asset(source: Optional[str], alt: str) -> str:
    if not source:
        return ""
    return f'<a class="asset-link" href="{html.escape(source, quote=True)}" target="_blank"><img src="{html.escape(source, quote=True)}" alt="{html.escape(alt, quote=True)}" loading="lazy"></a>'


def _build_document_html(
    source_title: str,
    pages: List[List[Dict[str, Any]]],
    mapping: Dict[str, str],
    page_assets: List[str],
    formulas: Dict[int, List[str]],
    inline_candidates: Optional[Dict[int, List[str]]] = None,
    visual_assets: Optional[Dict[str, str]] = None,
    visual_asset_metadata: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Tuple[str, Dict[str, Any]]:
    renderer = MathRenderer()
    state = BuildState(refs=_extract_ref_numbers(pages), anchors=_find_anchor_numbers(pages))
    html_pages: List[str] = []
    manifest_pages: List[dict] = []
    formula_audit: List[dict] = []
    inline_formula_audit: List[dict] = []
    unresolved_inline_formulas: List[dict] = []
    special_token_audit: List[dict] = []
    table_audit: List[dict] = []
    section_kinds: Dict[int, str] = {}
    figure_count = table_count = equation_count = 0
    rendered_figure_numbers: Set[int] = set()
    rendered_table_numbers: Set[int] = set()
    reference_started = False
    paper_title_seen = False
    abstract_section_open = False
    interline_totals = {
        index + 1: sum(1 for entry in page_items if isinstance(entry, dict) and entry.get("type") == "equation_interline")
        for index, page_items in enumerate(pages)
    }
    interline_ordinals: Dict[int, int] = {}

    for page_index, items in enumerate(pages):
        page_no = page_index + 1
        state.reference_mode = reference_started
        rendered = [f'<section class="pdf-page" id="page-{page_no}" data-page="{page_no}">', f'<div class="page-label">第 {page_no} 页</div>']
        records: List[dict] = []
        for element_index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            kind = str(item.get("type", ""))
            if kind in {"page_header", "page_footnote", "page_number"}:
                continue
            ir_metadata = item.get("_ir") if isinstance(item.get("_ir"), dict) else {}
            block_id = str(ir_metadata.get("block_id") or f"block-{page_no}-{element_index}-{kind}")
            bbox = item.get("bbox") or []
            record: Dict[str, Any] = {"block_id": block_id, "index": element_index, "type": kind, "bbox": bbox}
            for key in (
                "reading_order", "confidence", "source", "source_id", "role", "column",
                "flags", "fragments", "section_role", "emphasis", "caption_recoveries",
            ):
                if key in ir_metadata:
                    record[key] = ir_metadata[key]
            block = ""
            if kind == "title":
                block, section_kind = _title_html(item, state)
                title_text = _text_from_content(item.get("content", {})).strip()
                abstract_section_open = _is_abstract_title(title_text)
                record["text"] = title_text
                if page_no == 1 and block and not paper_title_seen:
                    block = re.sub(
                        r"<h([1-6])(?=[ >])",
                        lambda match: f'<h{match.group(1)} class="paper-title" data-translate-block-id="{block_id}"',
                        block,
                        count=1,
                    )
                    record["translation_role"] = "title"
                    paper_title_seen = True
                if ir_metadata.get("role") == "metadata" and block:
                    block = re.sub(
                        r"<h([1-6])(?=[ >])",
                        lambda match: f'<h{match.group(1)} class="paper-metadata" data-translation-excluded="metadata"',
                        block,
                        count=1,
                    )
                    record["translation_excluded"] = "metadata"
                if abstract_section_open and block:
                    class_match = re.search(r'(<h[1-6]\b[^>]*\bclass=")([^"]*)', block)
                    if class_match:
                        block = block[:class_match.start(2)] + f'{class_match.group(2)} paper-abstract-heading' + block[class_match.end(2):]
                    else:
                        block = re.sub(r"<h([1-6])(?=[ >])", lambda match: f'<h{match.group(1)} class="paper-abstract-heading"', block, count=1)
                    record["section_role"] = "abstract-heading"
                section_kinds[page_no] = section_kind
                if section_kind == "references":
                    state.reference_mode = True
                    reference_started = True
            elif kind == "paragraph":
                # Standalone equation labels left by some extractors are not
                # paragraphs; avoid displaying a duplicate (1)/(2).
                plain = re.sub(r"\s+", "", _text_from_content(item.get("content", {})))
                if re.fullmatch(r"\(?\d+\)?", plain) and equation_count:
                    continue
                block, inline, repairs, unresolved, markdown_text = _paragraph_html(
                    item,
                    renderer,
                    state,
                    (inline_candidates or {}).get(page_no, []),
                )
                record["text"] = _text_from_content(item.get("content", {}))
                paragraph_role = str(ir_metadata.get("section_role") or _inline_section_role(record["text"]))
                tokens = _special_tokens(record["text"])
                if tokens:
                    record["special_tokens"] = tokens
                    special_token_audit.append({"page": page_no, "block_id": block_id, "tokens": tokens, "source": "layout-text", "protected": True})
                try:
                    metadata_paragraph = ir_metadata.get("role") == "metadata" or (
                        not ir_metadata
                        and not abstract_section_open and page_no == 1 and len(bbox) > 1 and float(bbox[1]) < 300
                    )
                except (TypeError, ValueError):
                    metadata_paragraph = False
                if metadata_paragraph and block:
                    block = block.replace("<p>", '<p class="paper-metadata" data-translation-excluded="metadata">', 1)
                    record["translation_excluded"] = "metadata"
                elif paragraph_role == "keywords" and block:
                    block = block.replace("<p>", '<p class="paper-keywords">', 1)
                    block = _decorate_inline_section_label(block, paragraph_role)
                    record["section_role"] = "keywords"
                    abstract_section_open = False
                elif (paragraph_role == "abstract-body" or abstract_section_open) and block:
                    block = block.replace("<p>", '<p class="paper-abstract-body">', 1)
                    record["section_role"] = "abstract-body"
                    if paragraph_role == "abstract-body":
                        block = _decorate_inline_section_label(block, paragraph_role)
                        abstract_section_open = True
                record["rendered_markdown"] = markdown_text or record["text"]
                if inline:
                    record["inline_formulas"] = inline
                    inline_formula_audit.extend(
                        {"page": page_no, "block_id": block_id, **formula}
                        for formula in inline
                    )
                if repairs:
                    record["inline_formula_repairs"] = repairs
                    record["text_before_formula_repair"] = record["text"]
                    record["text_after_formula_repair"] = markdown_text
                    inline_formula_audit.extend(
                        {"page": page_no, "block_id": block_id, **repair}
                        for repair in repairs
                    )
                if unresolved:
                    record["unresolved_inline_formulas"] = unresolved
                    unresolved_inline_formulas.extend(
                        {"page": page_no, "block_id": block_id, "tex": tex}
                        for tex in unresolved
                    )
            elif kind == "image":
                content = item.get("content", {})
                content = content if isinstance(content, dict) else {}
                caption = _caption(content, "image_caption")
                caption_tokens = _special_tokens(caption)
                if caption_tokens:
                    special_token_audit.append({"page": page_no, "block_id": block_id, "tokens": caption_tokens, "source": "image-caption", "protected": True})
                match = re.search(r"(?:Figure|Fig\.?)[^0-9]*(\d+)", caption, flags=re.I)
                if match:
                    figure_number = int(match.group(1))
                    while figure_number in rendered_figure_numbers:
                        figure_number = max(figure_count + 1, figure_number + 1)
                else:
                    figure_number = figure_count + 1
                    while figure_number in rendered_figure_numbers or f"fig-{figure_number}" in state.anchors:
                        figure_number += 1
                figure_count = max(figure_count, figure_number)
                rendered_figure_numbers.add(figure_number)
                anchor = f"fig-{figure_number}"
                state.anchors.add(anchor)
                source = content.get("image_source", {}).get("path") if isinstance(content.get("image_source"), dict) else None
                source_asset = _asset_path(source, mapping)
                pdf_crop = (visual_assets or {}).get(block_id)
                crop_metadata = (visual_asset_metadata or {}).get(block_id, {})
                ir_source = str(ir_metadata.get("source") or "")
                # A composite figure must never fall back to the whole page:
                # that makes the surrounding prose look like part of the
                # figure. The bundled PDFBox crop renderer supplies the
                # bounded source crop when PyMuPDF is unavailable.
                visual_asset = pdf_crop or (None if ir_source == "mineru-composite" else source_asset)
                image = _image_asset(visual_asset, caption or f"Figure {figure_number}")
                block = f'<figure class="pdf-figure" id="{anchor}" data-block-id="{block_id}" data-page="{page_no}" data-bbox="{html.escape(json.dumps(bbox), quote=True)}">{image}<figcaption data-translate-block-id="{block_id}">{_caption_html(content, "image_caption", renderer)}</figcaption></figure>'
                record.update({
                    "image_source": source,
                    "source_asset": source_asset,
                    "visual_asset": visual_asset,
                    "visual_source": "pdf-crop" if pdf_crop else ("source-unavailable" if ir_source == "mineru-composite" else "mineru-crop"),
                    "visual_fallback": not bool(pdf_crop),
                    "visual_fallback_reason": crop_metadata.get("fallback_reason"),
                    "visual_quality": crop_metadata.get("quality", "fallback" if not pdf_crop else "adaptive"),
                    "actual_dpi": crop_metadata.get("actual_dpi"),
                    "pixel_width": crop_metadata.get("pixel_width"),
                    "pixel_height": crop_metadata.get("pixel_height"),
                    "pixel_cap_applied": bool(crop_metadata.get("pixel_cap_applied")),
                    "caption": caption,
                    "anchor": anchor,
                })
            elif kind == "table":
                content = item.get("content", {})
                content = content if isinstance(content, dict) else {}
                caption = _caption(content, "table_caption")
                caption_tokens = _special_tokens(caption)
                if caption_tokens:
                    special_token_audit.append({"page": page_no, "block_id": block_id, "tokens": caption_tokens, "source": "table-caption", "protected": True})
                match = re.search(r"Table[^0-9]*(\d+)", caption, flags=re.I)
                table_number = int(match.group(1)) if match else table_count + 1
                # A sidecar can represent two side-by-side tables as separate
                # elements while only attaching the shared caption to the
                # second one.  Keep the paper number when available, then
                # advance to the next unused anchor instead of emitting a
                # duplicate id that would make cross-reference jumps unstable.
                while table_number in rendered_table_numbers:
                    table_number = max(table_count + 1, table_number + 1)
                table_count = max(table_count, table_number)
                rendered_table_numbers.add(table_number)
                anchor = f"table-{table_number}"
                state.anchors.add(anchor)
                table = _normalize_table_html(str(content.get("html", "")))
                source = content.get("image_source", {}).get("path") if isinstance(content.get("image_source"), dict) else None
                source_asset = _asset_path(source, mapping)
                pdf_crop = (visual_assets or {}).get(block_id)
                crop_metadata = (visual_asset_metadata or {}).get(block_id, {})
                visual_asset = pdf_crop or source_asset
                crop = _image_asset(visual_asset, f"Table {table_number} source crop")
                review_table = str(content.get("table_type", "")) == "complex_table" or _table_needs_review(table)
                if crop:
                    # The PDF crop is the only user-facing table renderer. The
                    # normalized HTML remains in document.json for later search
                    # or AI review, but is not allowed to distort the page.
                    table_view = f'<div class="table-source-primary table-image-only">{crop}</div>'
                    display_policy = "source-crop-only"
                else:
                    # The reading surface is intentionally image-only.  Keep
                    # the structured candidate in document.json for search or
                    # review, but never expose a reconstructed table when the
                    # source crop is unavailable.
                    table_view = '<div class="table-source-missing">表格图像暂不可用</div>'
                    display_policy = "source-crop-missing"
                class_name = "pdf-table table-image-only" if crop else "pdf-table table-image-missing"
                block = (
                    f'<figure class="{class_name}" id="{anchor}" data-block-id="{block_id}" data-page="{page_no}" data-bbox="{html.escape(json.dumps(bbox), quote=True)}">'
                    f'<figcaption data-translate-block-id="{block_id}">{_caption_html(content, "table_caption", renderer)}</figcaption>{table_view}</figure>'
                )
                record.update({
                    "caption": caption,
                    "image_source": source,
                    "anchor": anchor,
                    "table_type": content.get("table_type"),
                    "html": table,
                    "needs_review": review_table,
                    "display_policy": display_policy,
                    "source_asset": source_asset,
                    "visual_asset": visual_asset,
                    "visual_source": "pdf-crop" if pdf_crop else "mineru-crop",
                    "visual_fallback": not bool(pdf_crop),
                    "visual_fallback_reason": crop_metadata.get("fallback_reason"),
                    "visual_quality": crop_metadata.get("quality", "fallback" if not pdf_crop else "adaptive"),
                    "actual_dpi": crop_metadata.get("actual_dpi"),
                    "pixel_width": crop_metadata.get("pixel_width"),
                    "pixel_height": crop_metadata.get("pixel_height"),
                    "pixel_cap_applied": bool(crop_metadata.get("pixel_cap_applied")),
                })
                table_audit.append({"page": page_no, "table": table_number, "block_id": block_id, "table_type": content.get("table_type"), "needs_review": review_table, "display_policy": display_policy, "source_available": bool(visual_asset), "structured_available": bool(table)})
            elif kind == "equation_interline":
                content = item.get("content", {})
                content = content if isinstance(content, dict) else {}
                ordinal = interline_ordinals.get(page_no, 0)
                interline_ordinals[page_no] = ordinal + 1
                tex_list = _display_formula_list(item, formulas, page_no, ordinal, interline_totals.get(page_no, 1))
                equation_blocks: List[str] = []
                equation_records: List[dict] = []
                for tex in tex_list:
                    number = _formula_tag(tex, state.next_equation)
                    state.next_equation = max(state.next_equation, number + 1)
                    anchor = f"eq-{number}"
                    state.anchors.add(anchor)
                    equation_blocks.append(f'<div id="{anchor}" class="equation-entry">{renderer.render(tex, display=True)}</div>')
                    equation_records.append({"number": number, "tex": tex, "anchor": anchor, "render_mode": renderer.mode(tex, display=True)})
                    equation_count += 1
                source = content.get("image_source", {}).get("path") if isinstance(content.get("image_source"), dict) else None
                # Formula crops remain in the task assets/audit for diagnostics,
                # but are deliberately not mixed into the reading surface.  A
                # rendered MathML/fallback formula is the only user-facing form.
                block = f'<div class="pdf-equation" data-block-id="{block_id}" data-page="{page_no}" data-bbox="{html.escape(json.dumps(bbox), quote=True)}">{"".join(equation_blocks)}</div>'
                record.update({"equations": equation_records, "image_source": source})
                formula_audit.append({"page": page_no, "block_id": block_id, "bbox": bbox, "equations": equation_records, "source": source})
            elif kind == "list":
                block = _list_html(item, state)
                content = item.get("content", {}) if isinstance(item.get("content"), dict) else {}
                record["text"] = _text_from_content(content).strip()
                if content.get("list_type") == "reference_list":
                    state.reference_mode = True
                    reference_started = True
            if block:
                block = re.sub(r"(<(?:p|h[1-6])[^>]*>)\s*\(?\d+\)?\s*(</(?:p|h[1-6])>)", "", block)
                if "data-block-id=" not in block:
                    block = re.sub(
                        r"<(p|h[1-6]|ul|ol)(?=[ >])",
                        lambda match: (
                            f'<{match.group(1)} data-block-id="{block_id}" data-page="{page_no}" '
                            f'data-bbox="{html.escape(json.dumps(bbox), quote=True)}"'
                        ),
                        block,
                        count=1,
                    )
                rendered.append(block)
                record["html"] = block
                records.append(record)
        rendered.append("</section>")
        if reference_started and page_no not in section_kinds:
            section_kinds[page_no] = "references"
        page_kind = section_kinds.get(page_no, "references" if reference_started else "body")
        rendered[0] = rendered[0].replace(
            f'data-page="{page_no}"',
            f'data-page="{page_no}" data-section-kind="{html.escape(page_kind, quote=True)}"',
        )
        html_pages.append("\n".join(rendered))
        manifest_pages.append({"page": page_no, "section_kind": section_kinds.get(page_no, "body"), "elements": records})

    css = r"""
:root { color-scheme:light dark; --ink:#191919; --muted:#756b60; --line:#e7ded2; --paper:#fff; --soft:#fbf6ed; --accent:#d97706; --highlight-orange:#f59e0b; --user-highlight:#f59e0b; --reader-font-scale:1; --reader-line-height:1.72; --ui-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",sans-serif; --paper-font:"Times New Roman",Times,"Songti SC",STSong,"Noto Serif CJK SC",serif; }
* { box-sizing:border-box; -webkit-user-select:none; user-select:none; } html { scroll-behavior:smooth; background:var(--paper); } body { margin:0; background:var(--paper); color:var(--ink); font-family:var(--ui-font); }
.reader-topbar { position:sticky; top:0; z-index:5; display:flex; gap:14px; align-items:center; padding:13px 24px; background:rgba(255,255,255,.94); border-bottom:1px solid var(--line); backdrop-filter:blur(12px); } .reader-brand{font-weight:750}.reader-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:14px}
.reader-shell{width:100%;max-width:none;margin:0;padding:0 24px 88px;background:var(--paper)}.reader-layout{display:block}
.reader-content{max-width:1080px;margin:0 auto;background:var(--paper);font-family:var(--paper-font);font-size:calc(17px * var(--reader-font-scale));line-height:var(--reader-line-height);text-rendering:optimizeLegibility}.reader-content,.reader-content *{-webkit-user-select:text;user-select:text}
.reader-embedded .reader-topbar{display:none}.reader-embedded .reader-shell{padding-top:0}
.reader-nav,.source-crop,.page-source{display:none!important}.reader-content button,.reader-content button *,.reader-content input,.reader-content textarea,.reader-content select,.reader-content summary,.reader-content .paragraph-translate-trigger,.reader-content .paragraph-translate-trigger *,.reader-content .annotation-note-trigger,.reader-content .annotation-note-trigger *,.reader-content .annotation-note-popover,.reader-content .annotation-note-popover *{ -webkit-user-select:none; user-select:none; }
.pdf-table figcaption[data-translate-block-id],.pdf-figure figcaption[data-translate-block-id]{position:relative}
.annotation-note-popover{position:absolute}
  .pdf-page{position:relative;margin:0;padding:0 clamp(30px,5vw,74px);background:var(--paper);border:0;border-radius:0;box-shadow:none}.pdf-page + .pdf-page{padding-top:0;border-top:0}.page-label{position:absolute;left:8px;top:12px;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.page-content{max-width:960px;margin:0 auto}h1,h2,h3,h4,h5,h6{font-family:var(--paper-font);color:var(--ink);line-height:1.25}h1{margin:0 0 .7em;font-size:2.12rem}.paper-title{margin-bottom:.18em}.paper-metadata{margin:.38em 0;color:color-mix(in srgb,var(--ink) 42%,var(--paper));font-size:.92em;line-height:1.55}.paper-abstract-heading{font-style:normal;font-weight:700}.paper-abstract-body,.paper-abstract-translation{font-style:italic}.paper-section-label{font-weight:700}.paper-keywords,.paper-keywords-translation{font-style:italic;font-size:.95em}.paper-abstract-body .paragraph-translate-trigger,.paper-abstract-body .annotation-note-trigger,.paper-keywords .paragraph-translate-trigger,.paper-keywords .annotation-note-trigger{font-style:normal}h2{margin:1.3em 0 .55em;font-size:1.62rem}h3{margin:1.15em 0 .45em;font-size:1.28rem}p{margin:.72em 0}:is(p,ul,ol)[data-block-id]{position:relative}math,.math-inline,.pdf-equation{font-family:"Times New Roman",Times,serif}button,input,textarea,select,.reader-topbar,.paragraph-translate-trigger,.annotation-note-popover,.annotation-note-trigger{font-family:var(--ui-font)}a{color:var(--accent)}.pdf-figure,.pdf-table{margin:28px 0;padding:14px;border:1px solid var(--line);border-radius:9px;background:transparent}.pdf-figure img,.source-crop img,.page-source img{max-width:100%;height:auto;display:block;margin:0 auto}.pdf-figure .asset-link{display:block}.pdf-figure img{max-height:none;width:auto}.pdf-table figcaption,.pdf-figure figcaption{margin-top:12px;color:var(--muted);font-family:var(--paper-font);font-size:.96em;line-height:1.58}.inline-legend-marker{position:relative;display:inline-block;width:1.45em;height:.86em;margin:0 .12em;vertical-align:-.12em}.inline-legend-marker-gray{color:#9f9f9f}.inline-legend-line{position:absolute;left:.04em;right:.04em;top:50%;height:1px;background:currentColor}.inline-legend-shape{position:absolute;left:50%;top:50%;width:.48em;height:.48em;background:currentColor;transform:translate(-50%,-50%)}.inline-legend-marker-circle .inline-legend-shape{border-radius:50%}.table-scroll{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}.pdf-table table{width:max-content;min-width:100%;border-collapse:collapse;font-size:.86em}.pdf-table td,.pdf-table th{border:1px solid var(--line);padding:4px 6px;vertical-align:top;white-space:normal}.pdf-table th{background:var(--soft);font-weight:650}.pdf-equation{margin:22px 0;padding:10px 14px;border-left:4px solid var(--highlight-orange);background:var(--soft);overflow-x:auto}.equation-line{display:flex;align-items:center;justify-content:center;gap:16px;margin:9px 0;min-height:34px}.equation-line math[display="inline"],math.math-inline{vertical-align:-.16em;line-height:1.15}.equation-number{color:var(--muted);white-space:nowrap}.source-crop,.page-source{margin-top:10px;color:var(--muted);font-size:.85em}.source-crop summary,.page-source summary{cursor:pointer}.math-fallback code{white-space:pre-wrap}.references{list-style:none;padding-left:0}.references li{padding:.3em 0;line-height:1.62}.ref-number{color:var(--muted)}.citation,.cross-reference{white-space:nowrap}.block-selected{outline:2px solid var(--accent);outline-offset:3px}.reader-reflow .pdf-page{max-width:1080px;margin-left:auto;margin-right:auto}.reader-reflow .page-source{display:none}
  .inline-legend-marker-gray{color:#8c8c8c}.inline-legend-marker-blue{color:#2f80ed}.inline-legend-marker-orange{color:#d97706}.inline-legend-marker-green{color:#2f855a}.inline-legend-marker-red{color:#d14343}.inline-legend-marker-purple{color:#805ad5}.inline-legend-marker-pink{color:#d53f8c}
  .pdf-text-tone{font-weight:inherit}.pdf-text-tone-blue{color:#1769aa}.pdf-text-tone-orange{color:#a85d00}.pdf-text-tone-green{color:#237a4b}.pdf-text-tone-red{color:#b23a3a}.pdf-text-tone-purple{color:#7047a8}.pdf-text-tone-pink{color:#a93a6f}
  .math-token{display:inline-block;white-space:nowrap;font-family:"Times New Roman",Times,serif;font-variant-ligatures:none}.math-token sub{font-size:.72em;line-height:0;vertical-align:-.32em}
  .my-scholar-highlight{padding:.04em .08em;border-radius:.16em;background:rgba(246,166,35,.38);box-shadow:inset 0 -.09em 0 rgba(224,128,0,.42);color:inherit}
  .my-scholar-underline{background:transparent;color:inherit;text-decoration:underline 2px var(--highlight-orange);text-underline-offset:3px}
  .annotation-note-trigger{--annotation-color:var(--highlight-orange);display:inline-flex;width:17px;height:17px;align-items:center;justify-content:center;margin:0 3px;border:1px solid color-mix(in srgb,var(--annotation-color) 72%,var(--line));border-radius:50%;background:color-mix(in srgb,var(--annotation-color) 16%,transparent);color:color-mix(in srgb,var(--annotation-color) 72%,var(--ink));font-size:10px;line-height:1;vertical-align:2px;cursor:pointer}
  .annotation-note-trigger:hover,.annotation-note-trigger:focus{border-color:var(--annotation-color);background:color-mix(in srgb,var(--annotation-color) 26%,transparent);outline:2px solid color-mix(in srgb,var(--annotation-color) 22%,transparent);outline-offset:1px}
  .annotation-note-popover{--annotation-color:var(--highlight-orange);position:fixed;z-index:30;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:color-mix(in srgb,var(--paper) 97%,transparent);box-shadow:0 12px 32px rgba(30,48,65,.2);color:var(--ink);font-size:12px;line-height:1.5;transform-origin:top center;animation:annotation-popover-in 160ms cubic-bezier(.22,1,.36,1) both}
  .annotation-note-popover.is-closing{opacity:0;transform:translateY(-2px) scale(.985);pointer-events:none;animation:none;transition:opacity 150ms ease-in,transform 150ms ease-in}
  @keyframes annotation-popover-in{from{opacity:0;transform:translateY(3px) scale(.985)}to{opacity:1;transform:none}}
  .annotation-note-popover-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:7px;color:color-mix(in srgb,var(--annotation-color) 72%,var(--ink))}
  .annotation-note-popover-head span{color:var(--muted);font-size:10px}
  .annotation-color-palette{display:flex;align-items:center;gap:5px;margin:0 0 9px;padding:2px 1px}
  .annotation-color-swatch{position:relative;width:20px;height:20px;flex:0 0 20px;padding:0;border:2px solid var(--paper);border-radius:50%;background:var(--swatch-color);box-shadow:0 0 0 1px color-mix(in srgb,var(--swatch-color) 70%,var(--line));cursor:pointer;transition:transform .14s ease,box-shadow .14s ease}
  .annotation-color-swatch:hover{transform:scale(1.08)}
  .annotation-color-swatch:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .annotation-color-swatch:disabled{opacity:.55;cursor:wait}
  .annotation-color-swatch[aria-pressed="true"]{box-shadow:0 0 0 2px var(--paper),0 0 0 4px var(--swatch-color)}
  .annotation-color-swatch[aria-pressed="true"]::after{content:'✓';position:absolute;inset:0;display:grid;place-items:center;color:#20252a;font-size:11px;font-weight:800;text-shadow:0 1px rgba(255,255,255,.72)}
  .annotation-note-popover-quote{max-height:100px;overflow:auto;padding:7px 8px;border-left:3px solid var(--annotation-color);background:color-mix(in srgb,var(--annotation-color) 9%,var(--paper));color:var(--ink);font-family:var(--paper-font);font-size:11px}
  .annotation-note-popover.is-editing .annotation-note-popover-quote{display:none}
  .annotation-note-popover-body,.annotation-note-editor{font-family:var(--paper-font)}
  .annotation-note-popover-body{margin-top:8px;white-space:normal}
  .annotation-note-popover-body p,.annotation-note-editor p{margin:.35em 0}
  .annotation-note-popover-body ul,.annotation-note-popover-body ol,.annotation-note-editor ul,.annotation-note-editor ol{margin:.35em 0;padding-left:20px}
  .annotation-note-popover-body blockquote,.annotation-note-editor blockquote{margin:.45em 0;padding-left:8px;border-left:3px solid var(--annotation-color);color:var(--muted)}
  .annotation-note-popover-body h1,.annotation-note-popover-body h2,.annotation-note-popover-body h3,.annotation-note-editor h1,.annotation-note-editor h2,.annotation-note-editor h3{margin:.5em 0 .3em;font-family:inherit;font-size:1.12em;line-height:inherit}
  .annotation-note-popover-body code,.annotation-note-editor code{padding:1px 3px;border-radius:3px;background:color-mix(in srgb,var(--annotation-color) 10%,var(--soft));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
  .annotation-note-popover-body a,.annotation-note-editor a{color:color-mix(in srgb,var(--annotation-color) 70%,var(--ink))}
  .annotation-note-popover-body img,.annotation-note-editor img{display:block;max-width:100%;height:auto;margin:8px 0;border-radius:7px}
  .annotation-note-editor-shell{overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--paper)}
  .annotation-note-formatbar{display:flex;flex-wrap:wrap;gap:3px;padding:5px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--annotation-color) 6%,var(--soft))}
  .annotation-note-formatbar button{min-height:25px;padding:3px 6px;border:0;border-radius:5px;background:transparent;color:var(--ink);font:inherit;font-size:10px;cursor:pointer}
  .annotation-note-formatbar button:hover,.annotation-note-formatbar button:focus-visible{background:color-mix(in srgb,var(--annotation-color) 16%,var(--paper));outline:none}
  .annotation-note-formatbar button:disabled{opacity:.6;cursor:wait}
  .annotation-note-editor{display:block;width:100%;min-height:108px;max-height:260px;overflow:auto;resize:vertical;padding:9px 10px;border:0;border-radius:0;outline:none;background:var(--paper);color:var(--ink);font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;caret-color:var(--annotation-color)}
  .annotation-note-editor[contenteditable="true"],.annotation-note-editor[contenteditable="true"] *{-webkit-user-select:text!important;user-select:text!important}
  .annotation-note-editor-shell:focus-within{border-color:var(--annotation-color);box-shadow:0 0 0 3px color-mix(in srgb,var(--annotation-color) 18%,transparent)}
  .annotation-note-editor.is-empty::before{content:attr(data-placeholder);color:var(--muted);pointer-events:none}
  .annotation-note-editor > :first-child{margin-top:0}
  .annotation-note-editor > :last-child{margin-bottom:0}
  .annotation-note-empty{color:var(--muted)}
  .annotation-note-popover-actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
  .annotation-note-popover-actions button{padding:4px 7px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--ink);font-size:10px;cursor:pointer}
  .annotation-note-popover-actions button:hover{border-color:var(--annotation-color);background:color-mix(in srgb,var(--annotation-color) 12%,var(--paper))}
  .paragraph-translate-trigger{position:absolute;right:-34px;top:50%;transform:translateY(-50%);opacity:0;padding:3px 7px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--muted);font-size:11px;line-height:1.2;cursor:pointer;transition:opacity .15s ease,background .15s ease}
  .paragraph-translate-trigger:hover,.paragraph-translate-trigger:focus,:is(p,ul,ol)[data-block-id]:hover .paragraph-translate-trigger{opacity:1;background:var(--soft);outline:none}
  .my-scholar-translation{display:block;margin:.12em 0 .86em;padding:0 0 0 .92em;border-left:2px solid rgba(246,166,35,.58);background:transparent;color:color-mix(in srgb,var(--ink) 82%,var(--muted));font-family:var(--paper-font);font-size:.94em;line-height:1.68}
  .my-scholar-translation.title-translation{margin:.1em 0 1.2em;padding-left:0;border-left:0;color:var(--ink);font-size:1.34em;line-height:1.48}
  .my-scholar-translation .translation-text{white-space:pre-wrap}
  .translation-text .translation-math{display:inline-block;margin:0 .08em;vertical-align:-.16em}
  .translation-math-fallback{display:inline-block;white-space:nowrap}
  .my-scholar-translation.is-pending{color:var(--muted)}
  .my-scholar-translation.is-error{border-left-color:#d26b6b;color:#b24c4c}
  .my-scholar-translation.is-cached{border-left-color:rgba(246,166,35,.58)}
  .my-scholar-highlight[data-user-color="true"]{background:color-mix(in srgb,var(--user-highlight) 32%,transparent);box-shadow:inset 0 -.09em 0 color-mix(in srgb,var(--user-highlight) 62%,transparent)}.my-scholar-underline[data-user-color="true"]{text-decoration-color:var(--user-highlight)}
.table-source-primary{padding:2px 0 8px}.table-source-primary img{width:auto;max-width:100%;height:auto}.table-image-only .table-source-primary img{display:block;max-height:none;margin:0 auto}.table-source-missing{margin-bottom:8px;padding:7px 9px;border-radius:6px;background:var(--soft);color:var(--muted);font-size:.82em}.table-structure{margin-top:8px}.table-structure summary{cursor:pointer;color:var(--muted);font-size:.86em}
@media(prefers-color-scheme:dark){:root{--ink:#e8e8ea;--muted:#b9ad9d;--line:#493c2b;--paper:#111315;--soft:#241c12;--accent:#f3b34c;--user-highlight:#f3b34c}.reader-topbar{background:rgba(17,19,21,.94)}.my-scholar-highlight{background:rgba(246,166,35,.42);box-shadow:inset 0 -.09em 0 rgba(246,166,35,.55)}.my-scholar-highlight[data-user-color="true"]{background:color-mix(in srgb,var(--user-highlight) 42%,transparent);box-shadow:inset 0 -.09em 0 color-mix(in srgb,var(--user-highlight) 72%,transparent)}.annotation-note-popover{box-shadow:0 16px 40px rgba(0,0,0,.46)}.my-scholar-translation{color:#d3d3d5}.my-scholar-translation.is-error{color:#ff9b9b}.pdf-text-tone-blue{color:#7cc4ff}.pdf-text-tone-orange{color:#f0ad4e}.pdf-text-tone-green{color:#6fd39d}.pdf-text-tone-red{color:#ff8b8b}.pdf-text-tone-purple{color:#c4a5ff}.pdf-text-tone-pink{color:#ff93c1}}
@media(prefers-reduced-motion:reduce){.annotation-note-popover{animation:none;transition:none}}
@media(max-width:760px){.reader-layout{display:block}.pdf-page{padding:0 16px}.paragraph-translate-trigger{right:0;top:-22px;transform:none;opacity:.7}}

/* My Scholar continuous reader overrides: page ids/data-page remain anchors, but
   pagination must not become a visual card or inject a page-sized gap. */
:root{--highlight-goal:#2f9d72;--highlight-method:#e39a22;--highlight-innovation:#8b6edb;--highlight-conclusion:#d15d79}
.reader-content{padding:32px 0 48px}
.pdf-page{padding-top:0;padding-bottom:0;border-top:0;border-bottom:0}
.pdf-page + .pdf-page{padding-top:0;border-top:0}
.pdf-page > :first-child{margin-top:0}
.pdf-page > :last-child{margin-bottom:0}
.pdf-page > .page-label + *{margin-top:0}
.reader-content :is(h1.paper-title[data-block-id],h1[data-translate-block-id],p[data-block-id],figcaption[data-translate-block-id]):has(+ .my-scholar-translation){margin-bottom:0}
.pdf-page > .my-scholar-translation:last-child{margin-bottom:.86em}
.my-scholar-translation{border-left:0;padding-left:0}
.highlight-group{--group-color:var(--highlight-method);--group-border:rgba(227,154,34,.42);--group-tint:rgba(227,154,34,.08);--group-label-bg:rgba(227,154,34,.18);--group-label-ink:#9a6208;border-color:var(--group-border);background:var(--group-tint)}
.highlight-group-research_goal{--group-color:var(--highlight-goal);--group-border:rgba(47,157,114,.42);--group-tint:rgba(47,157,114,.08);--group-label-bg:rgba(47,157,114,.17);--group-label-ink:#237653}
.highlight-group-innovation{--group-color:var(--highlight-innovation);--group-border:rgba(139,110,219,.45);--group-tint:rgba(139,110,219,.08);--group-label-bg:rgba(139,110,219,.17);--group-label-ink:#6950ae}
.highlight-group-conclusion{--group-color:var(--highlight-conclusion);--group-border:rgba(209,93,121,.45);--group-tint:rgba(209,93,121,.08);--group-label-bg:rgba(209,93,121,.16);--group-label-ink:#a44661}
.highlight-group h3{background:var(--group-label-bg);color:var(--group-label-ink)}
.highlight-card{border-color:var(--group-border);border-left-color:var(--group-color)}
.highlight-card:hover{background:color-mix(in srgb,var(--group-tint) 55%,var(--paper))}
.my-scholar-highlight-research_goal{background:rgba(47,157,114,.24);box-shadow:inset 0 -.09em 0 rgba(47,157,114,.45)}
.my-scholar-highlight-method{background:rgba(227,154,34,.28);box-shadow:inset 0 -.09em 0 rgba(227,154,34,.48)}
.my-scholar-highlight-innovation{background:rgba(139,110,219,.24);box-shadow:inset 0 -.09em 0 rgba(139,110,219,.46)}
.my-scholar-highlight-conclusion{background:rgba(209,93,121,.24);box-shadow:inset 0 -.09em 0 rgba(209,93,121,.46)}
.highlight-filter[data-highlight-filter="research_goal"].active{border-color:var(--highlight-goal);background:rgba(47,157,114,.12);color:#237653}
.highlight-filter[data-highlight-filter="method"].active{border-color:var(--highlight-method);background:rgba(227,154,34,.14);color:#9a6208}
.highlight-filter[data-highlight-filter="innovation"].active{border-color:var(--highlight-innovation);background:rgba(139,110,219,.13);color:#6950ae}
.highlight-filter[data-highlight-filter="conclusion"].active{border-color:var(--highlight-conclusion);background:rgba(209,93,121,.13);color:#a44661}
@media(prefers-color-scheme:dark){
  :root{--highlight-goal:#4fc58f;--highlight-method:#e3a44e;--highlight-innovation:#a894ef;--highlight-conclusion:#e77995}
  .highlight-group{border-color:color-mix(in srgb,var(--group-color) 70%,var(--line));background:color-mix(in srgb,var(--group-color) 12%,var(--paper))}
  .highlight-group h3{background:color-mix(in srgb,var(--group-color) 24%,var(--paper));color:color-mix(in srgb,var(--group-color) 66%,#fff)}
  .highlight-card{border-color:color-mix(in srgb,var(--group-color) 66%,var(--line));background:var(--paper)}
  .highlight-card:hover{background:color-mix(in srgb,var(--group-color) 16%,var(--paper))}
  .my-scholar-highlight-research_goal{background:rgba(47,197,143,.34);box-shadow:inset 0 -.09em 0 rgba(47,197,143,.64)}
  .my-scholar-highlight-method{background:rgba(227,164,78,.38);box-shadow:inset 0 -.09em 0 rgba(227,164,78,.68)}
  .my-scholar-highlight-innovation{background:rgba(157,132,236,.36);box-shadow:inset 0 -.09em 0 rgba(157,132,236,.66)}
  .my-scholar-highlight-conclusion{background:rgba(231,119,149,.36);box-shadow:inset 0 -.09em 0 rgba(231,119,149,.66)}
}
@media(max-width:760px){.reader-content{padding-top:22px;padding-bottom:32px}.pdf-page{padding-left:16px;padding-right:16px;padding-top:0;padding-bottom:0}}
"""
    document = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(source_title)}</title><link rel="icon" href="data:,"><style>{css}</style></head><body><header class="reader-topbar"><span class="reader-brand">My Scholar</span><span class="reader-title">{html.escape(source_title)}</span></header><div class="reader-shell"><div class="reader-layout"><main class="reader-content">{"".join(html_pages)}</main></div></div></body></html>'''
    metadata = {
        "pages": manifest_pages,
        "summary": {
            "pages": len(pages), "images": figure_count, "tables": table_count,
            "display_formulas": equation_count,
            "references": len(state.refs),
            "tables_needing_review": sum(1 for item in table_audit if item["needs_review"]),
            "table_display_mode": "source-crop-only",
        },
        "formula_audit": formula_audit,
        "inline_formula_audit": inline_formula_audit,
        "unresolved_inline_formulas": unresolved_inline_formulas,
        "special_token_audit": special_token_audit,
        "table_audit": table_audit,
        "citation_audit": {"known_references": sorted(state.refs), "unresolved": sorted(set(state.unresolved))},
        "section_audit": {"appendix_pages": [p for p, k in section_kinds.items() if k == "appendix"], "reference_pages": [p for p, k in section_kinds.items() if k == "references"]},
    }
    metadata["summary"].update({
        "major_figures": figure_count,
        "semantic_tables": 0,
        "structured_tables": len(table_audit),
        "table_images": sum(1 for item in table_audit if item.get("source_available")),
        "formulas": equation_count,
        "inline_formulas": len(inline_formula_audit),
        "inline_mathml": sum(
            1 for item in inline_formula_audit if item.get("render_mode") == "mathml"
        ),
        "math_fallbacks": sum(
            1 for item in inline_formula_audit if item.get("render_mode") == "fallback"
        ),
        "unresolved_inline_formulas": len(unresolved_inline_formulas),
        "special_tokens": sum(len(item.get("tokens", [])) for item in special_token_audit),
        "elements": sum(len(page["elements"]) for page in manifest_pages),
    })
    return document, metadata


def _validation(document_path: Path, metadata: Dict[str, Any], page_assets: List[str], job_dir: Path) -> Dict[str, Any]:
    raw = _read_text(document_path)
    visible_page_fallback = bool(re.search(r'class=["\'][^"\']*page-source', raw, flags=re.I))
    visible_formula_crops = bool(re.search(r'class=["\'][^"\']*source-crop', raw, flags=re.I))
    visible_semantic_tables = bool(
        re.search(
            r'<figure\b[^>]*class=["\'][^"\']*\bpdf-table\b[^"\']*["\'][^>]*>.*?<table\b',
            raw,
            flags=re.I | re.S,
        )
    )
    image_refs = re.findall(r'<img\b[^>]+src=["\']([^"\']+)', raw, flags=re.I)
    missing = []
    for ref in image_refs:
        if ref.startswith(("http:", "https:", "data:")):
            continue
        if not (job_dir / ref).is_file():
            missing.append(ref)
    summary = metadata.get("summary", {})
    warnings: List[str] = []
    if summary.get("pages") != len(page_assets) and page_assets:
        warnings.append("页面缩略图数量与版面页数不一致")
    if missing:
        warnings.append(f"缺失图片资源 {len(missing)} 个")
    unresolved = metadata.get("citation_audit", {}).get("unresolved", [])
    if unresolved:
        warnings.append(f"有 {len(unresolved)} 个引用/交叉引用未解析")
    ids = set(re.findall(r'\bid=["\']([^"\']+)', raw, flags=re.I))
    cross_targets = re.findall(r'<a\b[^>]*class=["\'][^"\']*cross-reference[^"\']*["\'][^>]*href=["\']#([^"\']+)', raw, flags=re.I)
    missing_cross_targets = sorted(set(cross_targets) - ids)
    if missing_cross_targets:
        warnings.append(f"有 {len(missing_cross_targets)} 个表/图/公式跳转目标缺失")
    if visible_page_fallback or visible_formula_crops:
        warnings.append("阅读界面仍暴露内部兜底/公式裁剪入口")
    if visible_semantic_tables:
        warnings.append("阅读界面仍暴露结构化表格")
    review_count = int(summary.get("tables_needing_review", 0) or 0)
    section_audit = metadata.get("section_audit", {}) if isinstance(metadata.get("section_audit"), dict) else {}
    if review_count and summary.get("table_display_mode") != "source-crop-only":
        warnings.append(f"有 {review_count} 张复杂表使用结构化候选，需人工复核")
    if summary.get("table_display_mode") == "source-crop-only" and int(summary.get("tables", 0) or 0) != int(summary.get("table_images", 0) or 0):
        warnings.append("部分表格缺少图像资源")
    if not summary.get("display_formulas"):
        warnings.append("未检测到显示公式")
    unresolved_inline = int(summary.get("unresolved_inline_formulas", 0) or 0)
    if unresolved_inline:
        warnings.append(f"有 {unresolved_inline} 个高置信行内公式候选未回填")
    render_budget = metadata.get("render_budget", {}) if isinstance(metadata.get("render_budget"), dict) else {}
    budget_fallbacks = render_budget.get("fallbacks", {}) if isinstance(render_budget.get("fallbacks"), dict) else {}
    budget_fallback_count = int(budget_fallbacks.get("count", 0) or 0)
    if budget_fallback_count:
        warnings.append(f"视觉资源预算触发 {budget_fallback_count} 次安全回退")
    return {
        "status": "PASS" if not warnings else "REVIEW",
        "checked_at": utc_now(),
        "backend": "layout-aware",
        "counts": summary,
        "missing_assets": missing,
        "warnings": warnings,
        "checks": {
            "all_image_refs_exist": not missing,
            "citation_links_resolved": not unresolved,
            "cross_reference_links_resolved": not missing_cross_targets,
            "page_source_fallback": bool(page_assets),
            "visible_page_fallback": visible_page_fallback,
            "visible_formula_crops": visible_formula_crops,
            "visible_semantic_tables": visible_semantic_tables,
            "semantic_tables": summary.get("semantic_tables", 0),
            "structured_tables": summary.get("structured_tables", 0),
            "table_images": summary.get("table_images", 0),
            "table_display_mode": summary.get("table_display_mode"),
            "tables_needing_review": review_count,
            "display_formulas": summary.get("display_formulas", 0),
            "inline_formulas": summary.get("inline_formulas", 0),
            "inline_mathml": summary.get("inline_mathml", 0),
            "math_fallbacks": summary.get("math_fallbacks", 0),
            "unresolved_inline_formulas": unresolved_inline,
            "appendix_pages": section_audit.get("appendix_pages", []),
            "reference_pages": section_audit.get("reference_pages", []),
            "render_budget_quality": render_budget.get("quality", "adaptive"),
            "render_budget_fallbacks": budget_fallback_count,
        },
    }


# Public layout pipeline and page-image fallback.
def build_visual_fallback_html(source_title: str, raw_html: str, page_assets: List[str]) -> str:
    """Create an honest visual reader when no layout model is available.

    The full-page raster is primary, so fragmented ODL image/table nodes cannot
    be mistaken for a recovered structure.  Debugging text stays in the raw
    task artifacts and is not inserted into the reading surface.
    """
    body_match = re.search(r"<body\b[^>]*>(.*?)</body\s*>", raw_html, flags=re.I | re.S)
    body = body_match.group(1) if body_match else raw_html
    markers = list(re.finditer(r"(?:&lt;!--|<!--)\s*page\s*:\s*(\d+)\s*(?:--&gt;|-->)", body, flags=re.I))
    fragments: List[Tuple[int, str]] = []
    if markers:
        for index, marker in enumerate(markers):
            end = markers[index + 1].start() if index + 1 < len(markers) else len(body)
            fragments.append((int(marker.group(1)), body[marker.end():end]))
    else:
        fragments = [(index + 1, body) for index in range(max(1, len(page_assets)))]
    sections: List[str] = []
    for index, asset in enumerate(page_assets):
        page_no = index + 1
        sections.append(
            f'<section class="pdf-page" id="page-{page_no}" data-page="{page_no}">'
            f'<img class="page-raster" src="pages/{html.escape(asset, quote=True)}" alt="page {page_no}"></section>'
        )
    css = ".pdf-page{margin:0 auto;padding:0;background:#fff;max-width:1000px}.pdf-page + .pdf-page{padding-top:0;border-top:0}.page-raster{display:block;width:100%;height:auto}.reader-topbar{position:sticky;top:0;padding:12px 20px;background:#fff;border-bottom:1px solid #dbe3e9;z-index:2}body{margin:0;background:#eef2f5;color:#17202a;font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"PingFang SC\",\"Segoe UI\",sans-serif}.reader-shell{padding:20px}"
    return f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(source_title)}</title><link rel="icon" href="data:,"><style>{css}</style></head><body><header class="reader-topbar"><strong>My Scholar</strong><span> {html.escape(source_title)}</span></header><main class="reader-shell">{"".join(sections)}</main></body></html>'


def process_layout_pdf(
    pdf_path: Path,
    job_dir: Path,
    *,
    job_id: str,
    source_name: str,
    progress=None,
    render_budget: Optional[LayoutRenderBudget] = None,
    layout_source: Optional[Tuple[Optional[Path], str]] = None,
    mineru_backend: Optional[str] = None,
    mineru_server_url: Optional[str] = None,
    runtime_root: Optional[Path] = None,
    cancel_event: Any = None,
) -> Optional[dict]:
    """Build a layout-aware job, or return ``None`` when no backend is usable."""
    pdf_path = Path(pdf_path).resolve()
    job_dir = Path(job_dir).resolve()
    _raise_if_cancelled(cancel_event)
    sidecar_or_bin, source_kind = layout_source or _find_layout_sidecar(pdf_path, source_name)
    if sidecar_or_bin is None:
        return None
    if progress:
        progress("准备版面解析", 0.12)
    source_copy = job_dir / "source.pdf"
    job_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pdf_path, source_copy)
    layout_dir = job_dir / "layout"
    if source_kind == "mineru-executable":
        resolved_backend = normalize_mineru_backend(mineru_backend)
        mineru_progress: Optional[Callable[[str, float], None]] = None
        if progress:
            def mineru_progress(stage: str, fraction: float) -> None:
                # MinerU owns the 0.12..0.62 span of the overall conversion.
                progress(stage, 0.12 + 0.5 * max(0.0, min(1.0, fraction)))
        sidecar = _run_mineru(
            sidecar_or_bin,
            source_copy,
            layout_dir,
            backend=resolved_backend,
            server_url=mineru_server_url,
            runtime_root=runtime_root,
            cancel_event=cancel_event,
            progress=mineru_progress,
        )
        placement = "remote" if resolved_backend in REMOTE_MINERU_BACKENDS else "local"
        backend_name = f"MinerU {placement} {resolved_backend}"
    else:
        sidecar = sidecar_or_bin
        backend_name = "MinerU cached layout sidecar"
    _raise_if_cancelled(cancel_event)
    raw_pages = _load_layout_sidecar(sidecar)
    pdf_evidence = _extract_pdf_evidence_isolated(source_copy, raw_pages, job_dir)
    _raise_if_cancelled(cancel_event)
    ir = mineru_to_ir(
        raw_pages,
        backend=backend_name,
        pdf_path=source_copy,
        # Keep the direct PyMuPDF path available in development when the
        # isolated worker or bundled PDFBox fallback is unavailable.
        pdf_pages_override=pdf_evidence or None,
    )
    pages = render_pages(ir)
    assets = job_dir / "assets" / "images"
    active_budget = render_budget or LayoutRenderBudget()
    mapping = _copy_sidecar_images(sidecar, assets, budget=active_budget)
    _raise_if_cancelled(cancel_event)
    render_budget_report = active_budget.report()
    try:
        page_dpi = max(36, min(600, int(os.environ.get("MY_SCHOLAR_PAGE_DPI", "144"))))
    except (TypeError, ValueError):
        page_dpi = 144
    page_assets = _render_pages(source_copy, job_dir / "pages", len(pages), dpi=page_dpi)
    _raise_if_cancelled(cancel_event)
    visual_dpi = _visual_crop_base_dpi()
    visual_asset_metadata: Dict[str, Dict[str, Any]] = {}
    visual_assets = _render_pdf_visual_crops(
        source_copy,
        pages,
        assets,
        dpi=visual_dpi,
        metadata=visual_asset_metadata,
        budget=active_budget,
        page_assets=page_assets,
        page_assets_dir=job_dir / "pages",
        page_dpi=page_dpi,
    )
    _raise_if_cancelled(cancel_event)
    render_budget_report = active_budget.report()
    _raise_if_cancelled(cancel_event)
    formula_dir = _find_formula_dir(pdf_path, source_name)
    formula_candidates = _load_formula_candidates(formula_dir)
    display_formulas = {
        page: [item for item in values.get("display", []) if len(item.strip()) > 4]
        for page, values in formula_candidates.items()
        if any(len(item.strip()) > 4 for item in values.get("display", []))
    }
    inline_candidates = {
        page: values.get("inline", [])
        for page, values in formula_candidates.items()
        if values.get("inline")
    }
    if progress:
        progress("生成语义文档", 0.62)
    document, metadata = _build_document_html(
        source_name,
        pages,
        mapping,
        page_assets,
        display_formulas,
        inline_candidates,
        visual_assets,
        visual_asset_metadata,
    )
    metadata.update({
        "job_id": job_id, "source_filename": source_name,
        "layout_source": str(sidecar), "formula_source": str(formula_dir) if formula_dir else None,
        "backend": backend_name, "generated_at": utc_now(),
        "ir_version": ir["ir_version"], "semantic_validation": ir["quality"],
        "render_budget": render_budget_report,
    })
    visual_records = {
        str(element.get("block_id")): {
            "asset": element.get("visual_asset"),
            "visual_source": element.get("visual_source"),
            "fallback": bool(element.get("visual_fallback")),
            "fallback_reason": element.get("visual_fallback_reason"),
            "quality": element.get("visual_quality"),
            "actual_dpi": element.get("actual_dpi"),
            "pixel_width": element.get("pixel_width"),
            "pixel_height": element.get("pixel_height"),
            "pixel_cap_applied": bool(element.get("pixel_cap_applied")),
        }
        for page in metadata.get("pages", [])
        for element in page.get("elements", [])
        if element.get("type") in {"image", "table"} and element.get("block_id")
    }
    for ir_page in ir.get("pages", []):
        for element in ir_page.get("elements", []):
            block_id = str(element.get("id") or "")
            if block_id in visual_records:
                element["visual"] = dict(visual_records[block_id])
    (job_dir / "document.html").write_text(document, encoding="utf-8")
    (job_dir / "document.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    (job_dir / "document-ir.json").write_text(json.dumps(serializable_ir(ir), ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.copy2(sidecar, job_dir / "layout-content-list.json")
    visual_validation = _validation(job_dir / "document.html", metadata, page_assets, job_dir)
    semantic_validation = ir["quality"]
    validation = dict(visual_validation)
    validation["visual_validation"] = visual_validation
    validation["semantic_validation"] = semantic_validation
    validation["render_budget"] = render_budget_report
    if visual_validation["status"] == "PASS" and semantic_validation["status"] != "PASS":
        validation["status"] = "REVIEW"
    validation["warnings"] = list(visual_validation.get("warnings", [])) + [
        f"语义结构需要复核：{issue}" for issue in semantic_validation.get("issues", [])
    ]
    (job_dir / "validation.json").write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8")
    if progress:
        progress("完成校验", 0.96)
    manifest = {
        "job_id": job_id,
        "source": {"filename": source_name, "bytes": source_copy.stat().st_size},
        "engine": {"name": backend_name, "layout": str(sidecar), "formula": str(formula_dir) if formula_dir else "MinerU embedded formula"},
        "created_at": utc_now(),
        "counts": metadata.get("summary", {}),
        "assets": {
            "images": sorted(set(mapping.values()) | set(visual_assets.values())),
            "page_thumbnails": page_assets,
            "visuals": visual_records,
        },
        "outputs": ["document.html", "document.json", "document-ir.json", "validation.json", "layout-content-list.json"],
        "validation": {"status": validation["status"], "warnings": validation["warnings"]},
        "quality": {
            "render_budget": render_budget_report["quality"],
            "visual_fallbacks": render_budget_report["fallbacks"]["count"],
        },
        "ai": {"status": "not-run", "mode": "optional review; deterministic source retained"},
        "provenance": {
            "clean_room": True,
            "layout_backend": backend_name,
            "formula_backend": "Nougat page candidates + MinerU layout" if formula_dir else "MinerU equation_interline",
            "visual_truth": "original PDF page raster and source crops",
        },
        "notes": [
            "语义 HTML 来自版面 JSON；不会把图示小切片拼成伪图。",
            "表格 HTML 默认只显示原始 PDF 裁剪图；结构化候选保留在 JSON 中供检索和 AI 复核，不覆盖视觉结果。",
            "公式优先使用 LaTeX→MathML；内部审计资产不注入阅读界面。",
        ],
    }
    (job_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest
