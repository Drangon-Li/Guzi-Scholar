"""Select and normalize deterministic PDF conversion backends.

``process_pdf`` is the stable conversion entrypoint. In ``auto`` mode it first
tries the layout-aware adapter from :mod:`layout_pipeline`, then falls back to
the local OpenDataLoader CLI adapter defined here. Both paths produce the same
job-level HTML, JSON, manifest, page assets, and validation contract.
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from document_ir import odl_to_ir, pdf_page_sizes, render_pages, serializable_ir
from mineru_discovery import discover_mineru
from toolchain_paths import tool_path_candidates


PROJECT_ROOT = Path(__file__).resolve().parent
LAYOUT_INVOCATION_LOCK = threading.RLock()

PAGE_MARKER_RE = re.compile(
    r"(?:&lt;!--|<!--)\s*page\s*:\s*(\d+)\s*(?:--&gt;|-->)",
    flags=re.IGNORECASE,
)
IMAGE_REF_RE = re.compile(
    r"(?:[^\"'<>/\s]+_images/)?(imageFile[^\"'<>/\s]+\.(?:png|jpe?g|webp|gif))",
    flags=re.IGNORECASE,
)
FORMULA_RE = re.compile(
    r"(?:<math\b|<span[^>]+class=[\"'][^\"']*(?:math|formula|equation)[^\"']*[\"']|\\\(|\\\[|\$\$|\b(?:Eq\.?|Equation)\s*\(?\d+\)?)",
    flags=re.IGNORECASE,
)
HTML_TABLE_RE = re.compile(r"<table\b([^>]*)>", flags=re.IGNORECASE)
IMG_RUN_RE = re.compile(
    r"(?P<run>(?:\s*<img\b[^>]*>\s*){2,})",
    flags=re.IGNORECASE,
)
CONVERSION_OUTPUT_NAMES = {
    "assets", "backend-selection.json", "converter.log", "document-ir.json",
    "document.html", "document.json", "layout", "layout-content-list.json",
    "layout-error.log", "manifest.json", "native", "pages", "source.pdf",
    "validation.json",
}


# Shared paths, subprocess helpers and normalized output utilities.
class PipelineError(RuntimeError):
    """An expected, user-facing conversion failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_stem(filename: str) -> str:
    stem = Path(filename).stem or "document"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-")
    return (stem[:80] or "document")


def _which(candidates: Sequence[str]) -> Optional[str]:
    for candidate in candidates:
        path = shutil.which(candidate)
        if path:
            return path
    return None


def resolve_jar() -> Path:
    configured = os.environ.get("MY_SCHOLAR_ODL_JAR")
    if configured:
        candidates = [Path(configured).expanduser().resolve()]
    else:
        candidates = tool_path_candidates(
            PROJECT_ROOT,
            "opendataloader-pdf",
            "java",
            "opendataloader-pdf-cli",
            "target",
            "opendataloader-pdf-cli-0.0.0.jar",
        )
    jar = next((candidate for candidate in candidates if candidate.is_file()), None)
    if jar is None:
        # The converter toolchain is not bundled with the app: name the path
        # that was tried so a packaged install is diagnosable without logs.
        attempted = "\n".join(f"- {candidate}" for candidate in candidates)
        raise PipelineError(
            "找不到 PDF 转换工具。已尝试：\n"
            f"{attempted}\n"
            "阅读已导入的文献不受影响；导入新 PDF 需要安装转换工具链："
            "构建 opendataloader-pdf 后用 MY_SCHOLAR_ODL_JAR 指向其 JAR，"
            "或安装 MinerU 并设置 MY_SCHOLAR_LAYOUT_JSON。"
        )
    return jar


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def _run(cmd: Sequence[str], *, timeout: int = 900) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            list(cmd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise PipelineError(f"找不到运行依赖：{cmd[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise PipelineError(f"转换超时（>{timeout} 秒）。") from exc
    if result.returncode != 0:
        tail = (result.stdout or "").strip()[-3000:]
        raise PipelineError(f"转换程序退出码 {result.returncode}：\n{tail}")
    return result


def _find_one(directory: Path, suffix: str) -> Path:
    matches = sorted(p for p in directory.rglob(f"*{suffix}") if p.is_file())
    if not matches:
        raise PipelineError(f"OpenDataLoader 没有生成 {suffix} 输出。")
    return matches[0]


def _parse_page_count(pdf_path: Path, raw_json: dict) -> int:
    value = raw_json.get("number of pages")
    try:
        if value is not None:
            return max(1, int(value))
    except (TypeError, ValueError):
        pass
    pdfinfo = _which(["pdfinfo", "/opt/homebrew/bin/pdfinfo"])
    if pdfinfo:
        try:
            result = _run([pdfinfo, str(pdf_path)], timeout=30)
            match = re.search(r"^Pages:\s*(\d+)", result.stdout or "", re.MULTILINE)
            if match:
                return max(1, int(match.group(1)))
        except PipelineError:
            pass
    return 1


def _copy_images(native_dir: Path, assets_dir: Path) -> List[str]:
    assets_dir.mkdir(parents=True, exist_ok=True)
    copied: List[str] = []
    for source in sorted(native_dir.rglob("*")):
        if not source.is_file() or source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            continue
        target = assets_dir / source.name
        # Avoid a same-name collision from an unusual input package.
        if target.exists() and target.stat().st_size != source.stat().st_size:
            target = assets_dir / f"{source.stem}-{len(copied) + 1}{source.suffix}"
        shutil.copy2(source, target)
        copied.append(target.name)
    return copied


def _rewrite_image_refs(content: str) -> str:
    def replace(match: re.Match) -> str:
        return f"assets/images/{match.group(1)}"

    return IMAGE_REF_RE.sub(replace, content)


def _extract_body(raw_html: str) -> str:
    match = re.search(r"<body\b[^>]*>(.*?)</body\s*>", raw_html, flags=re.IGNORECASE | re.DOTALL)
    return match.group(1) if match else raw_html


def _split_pages(body: str) -> List[Tuple[int, str]]:
    """Split ODL's escaped page comments while tolerating missing markers."""
    matches = list(PAGE_MARKER_RE.finditer(body))
    if not matches:
        return [(1, body.strip())]
    pages: List[Tuple[int, str]] = []
    for index, marker in enumerate(matches):
        start = marker.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        fragment = body[start:end].strip()
        page_number = int(marker.group(1))
        pages.append((page_number, fragment))
    # A malformed converter may put content before its first marker. Keep it
    # visible instead of silently dropping it.
    prefix = body[: matches[0].start()].strip()
    if prefix:
        pages.insert(0, (max(1, int(matches[0].group(1)) - 1), prefix))
    return pages


def _annotate_tables(content: str) -> str:
    def replace(match: re.Match) -> str:
        attrs = match.group(1) or ""
        if re.search(r"\bclass\s*=", attrs, flags=re.IGNORECASE):
            if "extracted-table" not in attrs:
                attrs += ' data-my-scholar="extracted-table"'
        else:
            attrs = ' class="extracted-table" data-my-scholar="extracted-table"' + attrs
        return f"<table{attrs}>"

    return HTML_TABLE_RE.sub(replace, content)


def _group_figure_runs(content: str) -> str:
    """Group adjacent image fragments so decomposed figures remain inspectable."""
    def replace(match: re.Match) -> str:
        run = match.group("run").strip()
        return f'<div class="figure-cluster" data-my-scholar="figure-cluster">{run}</div>'

    return IMG_RUN_RE.sub(replace, content)


def _page_sections(body: str) -> Tuple[str, List[int]]:
    sections: List[str] = []
    page_numbers: List[int] = []
    for page_number, fragment in _split_pages(body):
        fragment = _annotate_tables(_group_figure_runs(fragment))
        page_numbers.append(page_number)
        sections.append(
            f'<section class="pdf-page" id="page-{page_number}" data-page="{page_number}">'
            f'<div class="page-label">第 {page_number} 页</div>'
            f'<div class="page-content">{fragment}</div>'
            "</section>"
        )
    return "\n".join(sections), page_numbers


DOCUMENT_CSS = r"""
:root { color-scheme: light dark; --ink: #18232d; --muted: #756b60; --line: #e7ded2; --paper: #fff; --accent: #d97706; --user-highlight: #f59e0b; --soft: #fbf6ed; }
* { box-sizing: border-box; -webkit-user-select: none; user-select: none; }
html { scroll-behavior: smooth; }
body { margin: 0; background: #eef2f5; color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif; line-height: 1.62; }
.reader-topbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 14px; padding: 14px 24px; background: rgba(255,255,255,.94); border-bottom: 1px solid var(--line); backdrop-filter: blur(12px); }
.reader-brand { font-weight: 750; letter-spacing: .01em; }
.reader-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 14px; }
.reader-shell { max-width: 1180px; margin: 0 auto; padding: 28px 20px 80px; }
.reader-layout { display: block; }
/* Page navigation is deliberately omitted from the user-facing ODL fallback.
   The article remains a continuous, anchor-preserving reading surface. */
.reader-nav { display: none !important; }
.reader-content { min-width: 0; -webkit-user-select: text; user-select: text; }
.reader-content button, .reader-content button *, .reader-content input, .reader-content textarea, .reader-content select, .reader-content summary { -webkit-user-select: none; user-select: none; }
.pdf-page { position: relative; margin: 0; padding: 32px clamp(22px, 5vw, 62px) 42px; background: var(--paper); border: 0; border-radius: 0; box-shadow: none; }
.page-label { margin: -12px 0 22px; color: #9aa6af; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.page-content { max-width: 780px; margin: 0 auto; }
h1, h2, h3 { line-height: 1.25; color: #15202a; }
h1 { font-size: clamp(25px, 3vw, 36px); margin-top: 0; }
h2 { margin-top: 1.8em; font-size: 23px; }
h3 { font-size: 18px; }
p { margin: .75em 0; }
img { display: block; max-width: 100%; height: auto; margin: 18px auto; border-radius: 4px; }
.figure-cluster { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: center; gap: 6px; margin: 20px 0; padding: 12px; background: var(--soft); border: 1px solid #e7edf1; border-radius: 10px; }
.figure-cluster img { flex: 1 1 120px; max-width: 220px; max-height: 260px; object-fit: contain; margin: 0; }
figcaption { color: #52616d; font-size: 13px; text-align: center; margin: 6px auto 16px; }
table { width: 100%; margin: 20px 0; border-collapse: collapse; font-size: 13px; overflow: hidden; }
th, td { padding: 7px 8px; border: 1px solid #ccd6dd; vertical-align: top; text-align: left; }
th { background: #f0f4f7; font-weight: 650; }
.extracted-table { outline: 2px solid rgba(217,119,6,.18); outline-offset: 3px; }
ul, ol { padding-left: 1.5em; }
code { padding: .12em .35em; background: #f1f4f6; border-radius: 4px; }
.my-scholar-highlight[data-user-color="true"] { background: color-mix(in srgb,var(--user-highlight) 32%,transparent); box-shadow: inset 0 -.09em 0 color-mix(in srgb,var(--user-highlight) 62%,transparent); }
.my-scholar-underline[data-user-color="true"] { text-decoration-color: var(--user-highlight); }
.reader-content :is(h1.paper-title[data-block-id],h1[data-translate-block-id],p[data-block-id],figcaption[data-translate-block-id]):has(+ .my-scholar-translation) { margin-bottom: 0; }
.pdf-page > .my-scholar-translation:last-child { margin-bottom: .86em; }
.translation-text .translation-math { display: inline-block; margin: 0 .08em; vertical-align: -.16em; }
.translation-math-fallback { display: inline-block; white-space: nowrap; }
@media (prefers-color-scheme: dark) { :root { --ink:#e8e8ea; --muted:#b9ad9d; --line:#493c2b; --paper:#111315; --accent:#f3b34c; --user-highlight:#f3b34c; --soft:#241c12; } body { background:var(--paper); } h1,h2,h3 { color:var(--ink); } th { background:var(--soft); } }
@media (max-width: 760px) { .pdf-page { padding: 26px 18px 34px; } }
"""


# Reader HTML normalization and artifact validation.
def _make_nav(page_numbers: Iterable[int]) -> str:
    links = "".join(f'<a href="#page-{n}">第 {n} 页</a>' for n in page_numbers)
    return f'<nav class="reader-nav"><h2>Pages</h2>{links}</nav>'


def _make_document_html(title: str, raw_html: str) -> Tuple[str, List[int]]:
    body = _rewrite_image_refs(_extract_body(raw_html))
    sections, page_numbers = _page_sections(body)
    escaped_title = html.escape(title)
    document = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escaped_title} · My Scholar</title>
<style>{DOCUMENT_CSS}</style>
</head>
<body>
<header class="reader-topbar"><span class="reader-brand">My Scholar</span><span class="reader-title">{escaped_title}</span></header>
<div class="reader-shell"><div class="reader-layout"><main class="reader-content">{sections}</main></div></div>
</body>
</html>
"""
    return document, page_numbers


class _MarkupStats(HTMLParser):
    """Small HTML parser used for validation, avoiding a third-party parser."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.pages = 0
        self.images: List[str] = []
        self.tables: List[dict] = []
        self._table: Optional[dict] = None
        self._row: Optional[dict] = None
        self._cell_text: List[str] = []
        self._in_cell = False

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        attrs_dict = dict(attrs)
        tag = tag.lower()
        if tag == "section" and "pdf-page" in (attrs_dict.get("class") or "").split():
            self.pages += 1
        elif tag == "img":
            self.images.append(attrs_dict.get("src") or "")
        elif tag == "table":
            self._table = {"rows": [], "attrs": attrs_dict}
        elif tag == "tr" and self._table is not None:
            self._row = {"cells": []}
        elif tag in {"td", "th"} and self._row is not None:
            self._cell_text = []
            self._in_cell = True
            self._row["cells"].append({"tag": tag, "colspan": _positive_int(attrs_dict.get("colspan"), 1), "text": ""})

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"td", "th"} and self._in_cell and self._row is not None and self._row["cells"]:
            self._row["cells"][-1]["text"] = " ".join("".join(self._cell_text).split())
            self._in_cell = False
            self._cell_text = []
        elif tag == "tr" and self._table is not None and self._row is not None:
            self._table["rows"].append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None

    def handle_data(self, data: str) -> None:
        if self._in_cell:
            self._cell_text.append(data)


def _positive_int(value: Optional[str], default: int = 1) -> int:
    try:
        parsed = int(value or "")
        return parsed if parsed > 0 else default
    except (TypeError, ValueError):
        return default


def _is_semantic_table(table: dict) -> bool:
    """Separate table-shaped formula/layout fragments from actual table candidates."""
    rows = table.get("rows", [])
    if len(rows) >= 2:
        return True
    return any(sum(cell.get("colspan", 1) for cell in row.get("cells", [])) >= 2 for row in rows)


def validate_document(document_path: Path, assets_dir: Path, expected_pages: int, expected_tables: int) -> dict:
    parser = _MarkupStats()
    raw = _read_text(document_path)
    parser.feed(raw)
    missing_assets = []
    for src in parser.images:
        if not src or src.startswith(("http://", "https://", "data:")):
            continue
        asset = (document_path.parent / src).resolve()
        try:
            asset.relative_to(document_path.parent.resolve())
        except ValueError:
            missing_assets.append(src)
            continue
        if not asset.is_file():
            missing_assets.append(src)

    semantic_tables = [table for table in parser.tables if _is_semantic_table(table)]
    table_reviews = []
    for index, table in enumerate(semantic_tables, 1):
        rows = table["rows"]
        widths = [sum(cell["colspan"] for cell in row["cells"]) for row in rows]
        nonempty = sum(1 for row in rows for cell in row["cells"] if cell["text"])
        review = []
        if not rows:
            review.append("empty-table")
        if rows and nonempty == 0:
            review.append("no-cell-text")
        if len(set(widths)) > 1:
            review.append("inconsistent-column-count")
        if review:
            table_reviews.append({"table": index, "issues": review, "row_widths": widths})

    warnings: List[str] = []
    if parser.pages != expected_pages:
        warnings.append(f"页面分段数 {parser.pages} 与 PDF 页数 {expected_pages} 不一致")
    if expected_tables and len(semantic_tables) != expected_tables:
        warnings.append(f"HTML 语义表格数 {len(semantic_tables)} 与结构化结果 {expected_tables} 不一致")
    if missing_assets:
        warnings.append(f"有 {len(missing_assets)} 个图片资源缺失")
    if table_reviews:
        warnings.append(f"有 {len(table_reviews)} 个表格需要人工复核")
    return {
        "status": "PASS" if not warnings else "REVIEW",
        "checked_at": utc_now(),
        "html": {
            "pages": parser.pages,
            "tables": len(parser.tables),
            "semantic_tables": len(semantic_tables),
            "images": len(parser.images),
        },
        "expected": {"pages": expected_pages, "tables": expected_tables},
        "missing_assets": missing_assets,
        "table_reviews": table_reviews,
        "warnings": warnings,
    }


def _formula_count(raw_html: str, raw_json: dict) -> int:
    from_json = sum(1 for item in raw_json.get("kids", []) if str(item.get("type", "")).lower() in {"formula", "equation", "math"})
    return max(from_json, len(FORMULA_RE.findall(raw_html)))


def _augment_json(raw_json: dict, *, job_id: str, source_name: str, counts: dict) -> dict:
    output = dict(raw_json)
    output["my_scholar"] = {
        "job_id": job_id,
        "source_filename": source_name,
        "engine": "OpenDataLoader PDF CLI",
        "counts": counts,
        "generated_at": utc_now(),
        "license_note": "OpenDataLoader is used as a separate Apache-2.0 component; no proprietary Scholaread code is bundled.",
    }
    return output


def _render_page_thumbnails(pdf_path: Path, pages_dir: Path, page_count: int) -> List[str]:
    pdftoppm = _which(["pdftoppm", "/opt/homebrew/bin/pdftoppm"])
    if not pdftoppm:
        return []
    pages_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="my-scholar-pages-") as temp:
        prefix = Path(temp) / "page"
        try:
            _run([pdftoppm, "-png", "-r", "72", "-f", "1", "-l", str(page_count), str(pdf_path), str(prefix)], timeout=300)
        except PipelineError:
            return []
        rendered = []
        for source in sorted(Path(temp).glob("page-*.png")):
            match = re.search(r"page-(\d+)\.png$", source.name)
            if not match:
                continue
            page_number = int(match.group(1))
            target = pages_dir / f"page-{page_number:03d}.png"
            shutil.copy2(source, target)
            rendered.append(target.name)
        return rendered


# OpenDataLoader adapter and visual fallback.
def _process_pdf_odl(pdf_path: Path, job_dir: Path, *, job_id: str, source_name: str, progress=None) -> dict:
    """Convert one PDF and return the manifest dictionary.

    ``progress`` is an optional callback receiving ``(stage, fraction)``.
    """
    pdf_path = Path(pdf_path).resolve()
    job_dir = Path(job_dir).resolve()
    if not pdf_path.is_file():
        raise PipelineError("上传的 PDF 不存在。")
    if pdf_path.suffix.lower() != ".pdf":
        raise PipelineError("当前版本只接受 .pdf 文件。")
    job_dir.mkdir(parents=True, exist_ok=True)
    source_copy = job_dir / "source.pdf"
    shutil.copy2(pdf_path, source_copy)
    if progress:
        progress("准备转换", 0.08)

    native_dir = job_dir / "native"
    native_dir.mkdir(exist_ok=True)
    jar = resolve_jar()
    configured_java = str(os.environ.get("MY_SCHOLAR_JAVA", "")).strip()
    java = str(Path(configured_java).expanduser().resolve()) if configured_java else (_which(["java", "/usr/bin/java"]) or "/usr/bin/java")
    command = [
        java,
        "--add-opens=java.base/java.nio=ALL-UNNAMED",
        "-Djava.awt.headless=true",
        "-jar",
        str(jar),
        "-q",
        "-f",
        "json,html",
        "--image-output",
        "external",
        "--html-page-separator",
        "<!-- page: %page-number% -->",
        "-o",
        str(native_dir),
        str(source_copy),
    ]
    result = _run(command, timeout=int(os.environ.get("MY_SCHOLAR_CONVERT_TIMEOUT", "900")))
    (job_dir / "converter.log").write_text(result.stdout or "", encoding="utf-8")
    if progress:
        progress("整理结构与资源", 0.58)

    native_html = _find_one(native_dir, ".html")
    native_json_path = _find_one(native_dir, ".json")
    try:
        raw_json = json.loads(_read_text(native_json_path))
    except json.JSONDecodeError as exc:
        raise PipelineError(f"OpenDataLoader JSON 输出无法解析：{exc}") from exc
    raw_html = _read_text(native_html)
    page_count = _parse_page_count(source_copy, raw_json)
    page_sizes = pdf_page_sizes(source_copy, page_count)
    pdf_evidence = []
    try:
        # The packaged Python runtime intentionally omits PyMuPDF.  The
        # isolated helper keeps that optional dependency out of the main
        # conversion process and can fall back to the bundled PDFBox reader.
        from layout_pipeline import _extract_pdf_evidence_isolated

        if progress:
            progress("读取 PDF 文字样式", 0.62)
        pdf_evidence = _extract_pdf_evidence_isolated(source_copy, [], job_dir)
    except Exception:
        # Evidence is an enhancement only; a malformed or unavailable reader
        # must never turn an otherwise usable ODL conversion into a failure.
        pdf_evidence = []
    if progress:
        progress("整理结构与资源", 0.68)
    ir = odl_to_ir(
        raw_json,
        page_sizes,
        pdf_pages_override=pdf_evidence or None,
    )
    pages = render_pages(ir)
    assets_dir = job_dir / "assets" / "images"
    image_names = _copy_images(native_dir, assets_dir)
    mapping = {name: f"assets/images/{name}" for name in image_names}
    from layout_pipeline import (
        _build_document_html,
        _render_pages,
        _render_pdf_visual_crops,
        _validation,
        build_visual_fallback_html,
    )

    thumbnails = _render_pages(
        source_copy,
        job_dir / "pages",
        page_count,
        dpi=int(os.environ.get("MY_SCHOLAR_PAGE_DPI", "144")),
    )
    if len(thumbnails) != page_count or len(set(thumbnails)) != page_count:
        thumbnails = _render_page_thumbnails(source_copy, job_dir / "pages", page_count)
    render_error = "" if len(thumbnails) == page_count and len(set(thumbnails)) == page_count else (
        f"整页渲染不完整：期望 {page_count} 页，实际 {len(set(thumbnails))} 页"
    )
    visual_assets: Dict[str, str] = {}
    metadata: Dict[str, Any] = {}
    semantic_html = ""
    if not render_error:
        try:
            visual_assets = _render_pdf_visual_crops(
                source_copy,
                pages,
                assets_dir,
                dpi=int(os.environ.get("MY_SCHOLAR_VISUAL_DPI", "300")),
            )
            semantic_html, metadata = _build_document_html(
                source_name, pages, mapping, thumbnails, {}, visual_assets=visual_assets,
            )
        except Exception as exc:
            render_error = f"语义文档渲染失败：{exc}"

    semantic_validation = dict(ir["quality"])
    if render_error:
        semantic_validation["status"] = "FAIL"
        semantic_validation["issues"] = list(semantic_validation.get("issues", [])) + ["semantic-render-failed"]
        semantic_validation["render_error"] = render_error
    fallback_setting = os.environ.get("MY_SCHOLAR_ODL_VISUAL_FALLBACK", "auto").strip().lower()
    force_visual = fallback_setting in {"1", "true", "yes", "force"}
    visual_fallback = force_visual or semantic_validation["status"] == "FAIL"
    document_html = build_visual_fallback_html(source_name, raw_html, thumbnails) if visual_fallback else semantic_html

    counts = dict(metadata.get("summary", {}))
    counts.update({
        "pages": page_count,
        "raw_elements": len(raw_json.get("kids", [])),
        "raw_tables": sum(1 for item in raw_json.get("kids", []) if str(item.get("type", "")).lower() == "table"),
        "raw_images": len(image_names),
        "raw_formulas": _formula_count(raw_html, raw_json),
        "translatable_blocks": semantic_validation.get("translatable_blocks", 0),
        "body_paragraphs": semantic_validation.get("body_paragraphs", 0),
        "confidence": semantic_validation.get("confidence", 0),
        "visual_fallback": visual_fallback,
    })
    metadata.update({
        "job_id": job_id,
        "source_filename": source_name,
        "backend": "OpenDataLoader PDF CLI",
        "generated_at": utc_now(),
        "ir_version": ir["ir_version"],
        "semantic_validation": semantic_validation,
        "translation_enabled": not visual_fallback and semantic_validation["status"] != "FAIL",
        "summary": counts,
    })
    _write_text(job_dir / "document.html", document_html)
    (job_dir / "document.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    (job_dir / "document-ir.json").write_text(json.dumps(serializable_ir(ir), ensure_ascii=False, indent=2), encoding="utf-8")

    if visual_fallback:
        visual_validation = validate_document(job_dir / "document.html", assets_dir, page_count, 0)
    else:
        visual_validation = _validation(job_dir / "document.html", metadata, thumbnails, job_dir)
    validation = dict(visual_validation)
    validation["visual_validation"] = visual_validation
    validation["semantic_validation"] = semantic_validation
    validation["mode"] = "visual-fallback" if visual_fallback else "semantic-reflow"
    validation["status"] = (
        "PASS" if visual_validation["status"] == "PASS" and semantic_validation["status"] == "PASS" and not visual_fallback
        else "REVIEW"
    )
    validation["warnings"] = list(visual_validation.get("warnings", [])) + [
        f"语义结构需要复核：{issue}" for issue in semantic_validation.get("issues", [])
    ]
    if force_visual:
        validation["warnings"].append("已通过 MY_SCHOLAR_ODL_VISUAL_FALLBACK 强制使用整页模式")
    (job_dir / "validation.json").write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8")
    if progress:
        progress("完成校验", 0.96)

    manifest = {
        "job_id": job_id,
        "source": {"filename": source_name, "bytes": source_copy.stat().st_size},
        "engine": {"name": "OpenDataLoader PDF CLI", "jar": str(jar), "mode": "visual-fallback" if visual_fallback else "semantic-reflow"},
        "created_at": utc_now(),
        "counts": counts,
        "page_numbers": list(range(1, page_count + 1)),
        "assets": {"images": sorted(set(mapping.values()) | set(visual_assets.values())), "page_thumbnails": thumbnails},
        "outputs": ["document.html", "document.json", "document-ir.json", "validation.json"],
        "validation": {"status": validation["status"], "warnings": validation["warnings"]},
        "ai": {"status": "not-run", "mode": "optional OpenAI-compatible table review"},
        "notes": [
            "HTML 与翻译块均由统一文档 IR 生成；原始 ODL JSON 仅作为审计输入保留。",
            "语义质量不达标时自动退回整页保真模式。" if visual_fallback else "双栏阅读顺序、跨栏续段与图注区域在统一 IR 中完成归一化。",
        ],
    }
    (job_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


# Public backend selection and downstream table-audit helpers.
def _read_json_object(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(_read_text(path))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _semantic_validation(job_dir: Path) -> Dict[str, Any]:
    document = _read_json_object(Path(job_dir) / "document.json")
    quality = document.get("semantic_validation")
    if isinstance(quality, dict):
        return dict(quality)
    validation = _read_json_object(Path(job_dir) / "validation.json")
    quality = validation.get("semantic_validation")
    if isinstance(quality, dict):
        return dict(quality)
    return {
        "status": "FAIL",
        "issues": ["missing-semantic-validation"],
        "hard_failures": ["missing-semantic-validation"],
    }


def _semantic_rejection_reason(quality: Dict[str, Any]) -> str:
    status = str(quality.get("status") or "").upper()
    hard_failures = [str(value) for value in quality.get("hard_failures", []) if str(value)]
    if status != "FAIL" and not hard_failures:
        return ""
    issues = hard_failures or [str(value) for value in quality.get("issues", []) if str(value)]
    return ", ".join(issues) or "semantic-validation-failed"


def _remove_generated_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _rebase_candidate_paths(value: Any, candidate_dir: Path, job_dir: Path) -> Any:
    old = str(candidate_dir)
    new = str(job_dir)
    if isinstance(value, str):
        return new + value[len(old):] if value.startswith(old) else value
    if isinstance(value, dict):
        return {key: _rebase_candidate_paths(item, candidate_dir, job_dir) for key, item in value.items()}
    if isinstance(value, list):
        return [_rebase_candidate_paths(item, candidate_dir, job_dir) for item in value]
    return value


def _rebase_promoted_json_paths(candidate_dir: Path, job_dir: Path) -> None:
    for filename in ("document.json", "document-ir.json", "manifest.json", "validation.json"):
        path = job_dir / filename
        data = _read_json_object(path)
        if not data:
            continue
        rebased = _rebase_candidate_paths(data, candidate_dir, job_dir)
        path.write_text(json.dumps(rebased, ensure_ascii=False, indent=2), encoding="utf-8")


def _promote_conversion(candidate_dir: Path, job_dir: Path) -> None:
    """Atomically select one backend without touching notes or annotations."""
    candidate_dir = Path(candidate_dir)
    job_dir = Path(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    candidate_names = {child.name for child in candidate_dir.iterdir()}
    managed_names = sorted(CONVERSION_OUTPUT_NAMES | candidate_names)
    backup_dir = Path(tempfile.mkdtemp(prefix=".conversion-backup-", dir=str(job_dir)))
    promoted: List[Path] = []
    try:
        for name in managed_names:
            destination = job_dir / name
            if destination.exists() or destination.is_symlink():
                os.replace(destination, backup_dir / name)
        for child in list(candidate_dir.iterdir()):
            destination = job_dir / child.name
            os.replace(child, destination)
            promoted.append(destination)
        _rebase_promoted_json_paths(candidate_dir, job_dir)
    except Exception:
        for destination in reversed(promoted):
            _remove_generated_path(destination)
        for previous in list(backup_dir.iterdir()):
            os.replace(previous, job_dir / previous.name)
        raise
    finally:
        shutil.rmtree(backup_dir, ignore_errors=True)


def _scaled_progress(progress, start: float, end: float):
    if progress is None:
        return None

    def report(stage: str, fraction: float) -> None:
        bounded = max(0.0, min(1.0, float(fraction)))
        progress(stage, start + (end - start) * bounded)

    return report


def _record_backend_selection(job_dir: Path, manifest: dict, selection: Dict[str, Any]) -> dict:
    job_dir = Path(job_dir)
    manifest = dict(manifest)
    manifest["backend_selection"] = selection
    outputs = list(manifest.get("outputs", []))
    if "backend-selection.json" not in outputs:
        outputs.append("backend-selection.json")
    manifest["outputs"] = outputs
    notes = list(manifest.get("notes", []))
    notes.insert(0, "版面解析候选未通过文本质量门禁，已自动选择 OpenDataLoader。")
    manifest["notes"] = notes
    (job_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (job_dir / "backend-selection.json").write_text(json.dumps(selection, ensure_ascii=False, indent=2), encoding="utf-8")
    for filename in ("document.json", "validation.json"):
        path = job_dir / filename
        data = _read_json_object(path)
        if not data:
            continue
        data["backend_selection"] = selection
        if filename == "validation.json":
            warnings = list(data.get("warnings", []))
            warning = "MinerU 文本质量未通过，已自动切换到 OpenDataLoader。"
            if warning not in warnings:
                warnings.append(warning)
            data["warnings"] = warnings
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def _fresh_layout_backend(layout_module: Any) -> Tuple[Optional[Path], str]:
    """Resolve a runnable MinerU binary without consulting cached sidecars."""
    candidate, failure = discover_mineru(project_root=PROJECT_ROOT)
    if candidate:
        return candidate.executable, "mineru-executable"
    if failure and os.environ.get("MY_SCHOLAR_MINERU"):
        raise layout_module.LayoutPipelineError(f"MY_SCHOLAR_MINERU 不可用：{failure}")
    return None, "unavailable"


def _process_layout_candidate(
    pdf_path: Path,
    candidate_dir: Path,
    *,
    job_id: str,
    source_name: str,
    progress: Any,
    refresh_layout_sidecar: bool,
    layout_executable: Optional[Path],
    layout_runtime_root: Optional[Path],
    cancel_event: Any,
) -> Optional[dict]:
    """Serialize layout execution while keeping backend selection request-scoped."""
    import layout_pipeline

    with LAYOUT_INVOCATION_LOCK:
        layout_source = None
        if layout_executable is not None:
            layout_source = (Path(layout_executable).expanduser().resolve(), "mineru-executable")
        elif refresh_layout_sidecar:
            layout_source = _fresh_layout_backend(layout_pipeline)
        return layout_pipeline.process_layout_pdf(
            pdf_path,
            candidate_dir,
            job_id=job_id,
            source_name=source_name,
            progress=progress,
            layout_source=layout_source,
            runtime_root=layout_runtime_root,
            cancel_event=cancel_event,
        )


def process_pdf(
    pdf_path: Path,
    job_dir: Path,
    *,
    job_id: str,
    source_name: str,
    progress=None,
    backend_override: Optional[str] = None,
    refresh_layout_sidecar: bool = False,
    layout_executable: Optional[Path] = None,
    layout_runtime_root: Optional[Path] = None,
    cancel_event: Any = None,
) -> dict:
    """Convert a PDF with the layout-aware adapter, falling back to ODL.

    ``MY_SCHOLAR_BACKEND=odl`` is an explicit rollback switch.  ``layout``
    makes layout parsing strict and surfaces a model/sidecar error instead of
    silently returning the legacy fragment output; ``auto`` is the user-facing
    default and falls back only after recording the reason in the job folder.
    """
    backend = str(backend_override or os.environ.get("MY_SCHOLAR_BACKEND", "auto")).strip().lower()
    if backend not in {"auto", "layout", "odl"}:
        raise PipelineError("MY_SCHOLAR_BACKEND 只能是 auto、layout 或 odl。")
    job_dir = Path(job_dir).resolve()
    job_dir.parent.mkdir(parents=True, exist_ok=True)
    selection: Dict[str, Any] = {}
    if backend != "odl":
        try:
            from layout_pipeline import LayoutPipelineError

            with tempfile.TemporaryDirectory(prefix=f".{job_id}-layout-", dir=str(job_dir.parent)) as temp:
                candidate_dir = Path(temp)
                manifest = _process_layout_candidate(
                    pdf_path,
                    candidate_dir,
                    job_id=job_id,
                    source_name=source_name,
                    progress=_scaled_progress(progress, 0.0, 0.82) if backend == "auto" else progress,
                    refresh_layout_sidecar=refresh_layout_sidecar,
                    layout_executable=layout_executable,
                    layout_runtime_root=layout_runtime_root,
                    cancel_event=cancel_event,
                )
                if manifest is not None:
                    quality = _semantic_validation(candidate_dir)
                    rejection = _semantic_rejection_reason(quality)
                    if not rejection:
                        _promote_conversion(candidate_dir, job_dir)
                        return _rebase_candidate_paths(manifest, candidate_dir, job_dir)
                    selection = {
                        "selected_backend": "OpenDataLoader PDF CLI",
                        "rejected_backend": str(manifest.get("engine", {}).get("name") or "layout"),
                        "reason": "semantic-quality-gate",
                        "issues": [value for value in quality.get("issues", []) if value],
                        "hard_failures": [value for value in quality.get("hard_failures", []) if value],
                        "text_quality": quality.get("text_quality", {}),
                    }
                    if backend == "layout":
                        raise PipelineError(f"版面解析文本质量未通过：{rejection}")
            if backend == "layout":
                raise PipelineError("未找到可用的版面解析后端或 sidecar。")
            if not selection:
                selection = {
                    "selected_backend": "OpenDataLoader PDF CLI",
                    "rejected_backend": "layout",
                    "reason": "layout-backend-unavailable",
                }
        except LayoutPipelineError as exc:
            if backend == "layout":
                job_dir.mkdir(parents=True, exist_ok=True)
                (job_dir / "layout-error.log").write_text(str(exc), encoding="utf-8")
                raise PipelineError(str(exc)) from exc
            selection = {
                "selected_backend": "OpenDataLoader PDF CLI",
                "rejected_backend": "layout",
                "reason": "layout-error",
                "error": str(exc),
            }
        except Exception as exc:
            # Keep auto mode usable when an optional layout dependency is
            # unavailable, while leaving a concrete diagnostic artifact.
            if backend == "layout":
                job_dir.mkdir(parents=True, exist_ok=True)
                (job_dir / "layout-error.log").write_text(
                    f"{type(exc).__name__}: {exc}", encoding="utf-8"
                )
                raise PipelineError(f"版面解析失败：{exc}") from exc
            selection = {
                "selected_backend": "OpenDataLoader PDF CLI",
                "rejected_backend": "layout",
                "reason": "layout-error",
                "error": f"{type(exc).__name__}: {exc}",
            }
    if backend == "odl":
        return _process_pdf_odl(
            pdf_path,
            job_dir,
            job_id=job_id,
            source_name=source_name,
            progress=progress,
        )
    with tempfile.TemporaryDirectory(prefix=f".{job_id}-odl-", dir=str(job_dir.parent)) as temp:
        candidate_dir = Path(temp)
        manifest = _process_pdf_odl(
            pdf_path,
            candidate_dir,
            job_id=job_id,
            source_name=source_name,
            progress=_scaled_progress(progress, 0.82, 1.0),
        )
        _promote_conversion(candidate_dir, job_dir)
    return _record_backend_selection(job_dir, manifest, selection)


def collect_table_candidates(job_dir: Path) -> List[dict]:
    """Return compact table records for an optional AI review endpoint."""
    path = Path(job_dir) / "document.json"
    if not path.is_file():
        return []
    data = json.loads(_read_text(path))
    candidates = []
    # Layout-aware documents store tables under pages[].elements[] and keep
    # the original crop beside the semantic HTML.  Do not fall back to the
    # legacy top-level ``kids`` table unless this shape is absent.
    if isinstance(data.get("pages"), list):
        for page in data.get("pages", []):
            for item in page.get("elements", []) if isinstance(page, dict) else []:
                if not isinstance(item, dict) or item.get("type") != "table":
                    continue
                candidates.append(
                    {
                        "id": item.get("block_id") or item.get("anchor"),
                        "page": page.get("page") if isinstance(page, dict) else None,
                        "rows": _count_html_rows(str(item.get("html", ""))),
                        "columns": _max_html_row_cells(str(item.get("html", ""))),
                        "bounding_box": item.get("bbox"),
                        "caption": item.get("caption", ""),
                        "content": item.get("html", ""),
                        "source_crop": item.get("image_source"),
                    }
                )
        return candidates
    for item in data.get("kids", []):
        if str(item.get("type", "")).lower() != "table":
            continue
        candidates.append(
            {
                "id": item.get("id"),
                "page": item.get("page number"),
                "rows": item.get("number of rows"),
                "columns": item.get("number of columns"),
                "bounding_box": item.get("bounding box"),
                "content": item.get("content"),
                "structured_rows": item.get("rows"),
            }
        )
    return candidates


def _count_html_rows(content: str) -> int:
    return len(re.findall(r"<tr\b", content, flags=re.IGNORECASE))


def _max_html_row_cells(content: str) -> int:
    widths = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr\s*>", content, flags=re.IGNORECASE | re.DOTALL):
        widths.append(len(re.findall(r"<(?:td|th)\b", row, flags=re.IGNORECASE)))
    return max(widths, default=0)
