"""One-time upgrades of reader artifacts written by older releases.

Rewrites legacy reader HTML (continuous-reader styles, table figures, duplicate
figure ids) and drops translation cache entries for metadata blocks. Called
from ``server._migrate_job_artifacts`` when a job is loaded.
"""

from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Dict, List

from content_store import _active_conversion_root, _translation_records, _write_translation_records
from job_store import _read_json_file


def _metadata_block_ids(job_dir: Path) -> set[str]:
    data = _read_json_file(_active_conversion_root(job_dir) / "document.json", {})
    identifiers: set[str] = set()
    for page in data.get("pages", []) if isinstance(data, dict) and isinstance(data.get("pages"), list) else []:
        for item in page.get("elements", []) if isinstance(page, dict) else []:
            if isinstance(item, dict) and item.get("translation_excluded") == "metadata" and item.get("block_id"):
                identifiers.add(str(item["block_id"]))
    return identifiers


def _clean_legacy_translation_cache(job_dir: Path) -> None:
    metadata_ids = _metadata_block_ids(job_dir)
    if not metadata_ids or not (job_dir / "translations.json").is_file():
        return
    records = _translation_records(job_dir)
    filtered = [item for item in records if str(item.get("block_id", "")) not in metadata_ids]
    if len(filtered) != len(records):
        _write_translation_records(job_dir, filtered)


_LEGACY_READER_STYLE_MARKER = "/* my-scholar:continuous-reader-migration-v6 */"


_LEGACY_READER_STYLE = r"""
/* my-scholar:continuous-reader-migration-v6 */
/* my-scholar:continuous-reader-migration-v5 (compatibility marker) */
/* my-scholar:continuous-reader-migration-v4 (compatibility marker) */
/* Existing jobs may have been rendered by the pre-continuous reader. Keep
   their ids and data-page anchors, but remove presentation-only page cards,
   navigation chrome, and internal audit disclosures from the reading surface. */
html, body { background: var(--paper, #fff) !important; }
:root { --accent: #d97706 !important; --accent-dark: #a65305 !important; --highlight-orange: #f59e0b !important; --user-highlight: #f59e0b !important; --muted: #756b60 !important; --line: #e7ded2 !important; --soft: #fbf6ed !important; }
a, .citation, .cross-reference { color: var(--accent, #d97706) !important; }
.block-selected { outline-color: var(--accent, #d97706) !important; }
.my-scholar-underline:not([data-user-color="true"]) { text-decoration-color: var(--highlight-orange, #f59e0b) !important; }
*, *::before, *::after { -webkit-user-select: none !important; user-select: none !important; }
input, textarea, [contenteditable="true"] { -webkit-user-select: text !important; user-select: text !important; }
.reader-shell { width: 100% !important; max-width: none !important; margin: 0 !important; padding: 0 24px 72px !important; background: var(--paper, #fff) !important; }
.reader-layout { display: block !important; }
.reader-nav { display: none !important; }
.reader-content { max-width: 1080px !important; margin: 0 auto !important; padding: 32px 0 48px !important; background: var(--paper, #fff) !important; font-family: var(--paper-font, "Times New Roman", Times, serif) !important; font-size: calc(18px * var(--reader-font-scale, 1)) !important; line-height: var(--reader-line-height, 1.72) !important; -webkit-user-select: text !important; user-select: text !important; }
.reader-content p, .reader-content li, .reader-content figcaption, .reader-content .translation-text { line-height: inherit !important; }
.reader-content, .reader-content * { -webkit-user-select: text !important; user-select: text !important; }
.reader-content button, .reader-content button *, .reader-content input, .reader-content textarea, .reader-content select, .reader-content summary, .reader-content .paragraph-translate-trigger, .reader-content .paragraph-translate-trigger *, .reader-content .annotation-note-trigger, .reader-content .annotation-note-trigger *, .reader-content .annotation-note-popover, .reader-content .annotation-note-popover * { -webkit-user-select: none !important; user-select: none !important; }
.reader-content .annotation-note-popover .annotation-note-editor[contenteditable="true"], .reader-content .annotation-note-popover .annotation-note-editor[contenteditable="true"] * { -webkit-user-select: text !important; user-select: text !important; }
.my-scholar-highlight[data-user-color="true"] { background: color-mix(in srgb, var(--user-highlight, #f59e0b) 32%, transparent) !important; box-shadow: inset 0 -.09em 0 color-mix(in srgb, var(--user-highlight, #f59e0b) 62%, transparent) !important; }
.my-scholar-underline[data-user-color="true"] { text-decoration-color: var(--user-highlight, #f59e0b) !important; }
.pdf-page { margin: 0 !important; padding: 0 clamp(30px, 5vw, 74px) !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; background: var(--paper, #fff) !important; }
.pdf-page + .pdf-page { padding-top: 0 !important; border-top: 0 !important; }
.page-label { position: absolute !important; width: 1px !important; height: 1px !important; margin: -1px !important; padding: 0 !important; overflow: hidden !important; clip: rect(0 0 0 0) !important; white-space: nowrap !important; border: 0 !important; }
.source-crop, .page-source, .table-structure, .table-review-badge { display: none !important; }
.pdf-figure, .pdf-table { background: transparent !important; }
.pdf-table { border: 0 !important; padding: 0 !important; }
.pdf-table .table-source-primary { padding: 0 0 8px !important; }
.pdf-table .table-source-primary img { width: auto !important; max-width: 100% !important; height: auto !important; }
.pdf-table.table-image-missing .table-source-missing { margin: 8px 0 !important; color: var(--muted, #6f7d8d) !important; }
.references { list-style: none !important; padding-left: 0 !important; }
.my-scholar-translation { border-left: 0 !important; padding-left: 0 !important; background: transparent !important; }
.translation-text .translation-math { display: inline-block; margin: 0 .08em; vertical-align: -.16em; }
.translation-math-fallback { display: inline-block; white-space: nowrap; }
@media (max-width: 760px) {
  .reader-shell { padding: 0 16px 48px !important; }
  .reader-content { padding-top: 22px !important; padding-bottom: 32px !important; }
  .pdf-page { padding-left: 16px !important; padding-right: 16px !important; }
}
@media (prefers-color-scheme: dark) {
  :root { --accent: #f3b34c !important; --accent-dark: #ffd07a !important; --highlight-orange: #f3b34c !important; --user-highlight: #f3b34c !important; --ink: #dcdcde !important; --muted: #b9ad9d !important; --line: #55462f !important; --paper: #1e2124 !important; --soft: #32281a !important; }
  a, .citation, .cross-reference { color: var(--accent, #f3b34c) !important; }
}
"""


_TABLE_FIGURE_RE = re.compile(
    r'(?P<open><figure\b[^>]*class=["\'][^"\']*\bpdf-table\b[^"\']*["\'][^>]*>)'
    r'(?P<body>.*?)'
    r'(?P<close></figure\s*>)',
    flags=re.IGNORECASE | re.DOTALL,
)


def _table_image_markup(fragment: str) -> str:
    """Extract an existing crop link without exposing legacy table markup."""
    linked = re.search(
        r'<a\b[^>]*class=["\'][^"\']*\basset-link\b[^"\']*["\'][^>]*>.*?<img\b[^>]*>.*?</a\s*>',
        fragment,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if linked:
        return linked.group(0)
    image = re.search(r'<img\b[^>]*>', fragment, flags=re.IGNORECASE)
    return image.group(0) if image else ""


def _add_class(tag: str, class_name: str) -> str:
    def replace(match: re.Match[str]) -> str:
        classes = match.group(2).split()
        if class_name not in classes:
            classes.append(class_name)
        return f"{match.group(1)}{' '.join(classes)}{match.group(3)}"

    return re.sub(
        r'(class=["\'])([^"\']*)(["\'])',
        replace,
        tag,
        count=1,
        flags=re.IGNORECASE,
    )


def _migrate_legacy_table_figures(document: str) -> str:
    """Promote old hidden table crops and remove semantic tables from HTML."""

    def replace(match: re.Match[str]) -> str:
        opening = match.group("open")
        body = match.group("body")
        primary = re.search(
            r'<(?:div|section)\b[^>]*class=["\'][^"\']*\btable-source-primary\b[^"\']*["\'][^>]*>.*?</(?:div|section)\s*>',
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        source_crop = re.search(
            r'<(?:details|div|section)\b[^>]*class=["\'][^"\']*\bsource-crop\b[^"\']*["\'][^>]*>.*?</(?:details|div|section)\s*>',
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        crop_markup = _table_image_markup(primary.group(0) if primary else "")
        if not crop_markup and source_crop:
            crop_markup = _table_image_markup(source_crop.group(0))

        # Remove the old crop/structured wrappers and any semantic table. The
        # structured candidate remains available in document.json for search
        # and review, but never becomes the reading renderer.
        body = re.sub(
            r'<(?:details|div|section)\b[^>]*class=["\'][^"\']*\b(?:table-source-primary|source-crop|table-structure|table-scroll)\b[^"\']*["\'][^>]*>.*?</(?:details|div|section)\s*>',
            "",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        body = re.sub(r'<table\b.*?</table\s*>', "", body, flags=re.IGNORECASE | re.DOTALL)

        if crop_markup:
            primary_html = f'<div class="table-source-primary table-image-only">{crop_markup}</div>'
            caption_end = re.search(r'</figcaption\s*>', body, flags=re.IGNORECASE)
            if caption_end:
                body = body[:caption_end.end()] + primary_html + body[caption_end.end():]
            else:
                body = primary_html + body
            opening = _add_class(opening, "table-image-only")
            opening = re.sub(r'\btable-semantic-fallback\b', '', opening, flags=re.IGNORECASE)
        else:
            missing = '<div class="table-source-missing">表格图像暂不可用</div>'
            caption_end = re.search(r'</figcaption\s*>', body, flags=re.IGNORECASE)
            if caption_end:
                body = body[:caption_end.end()] + missing + body[caption_end.end():]
            else:
                body = missing + body
            opening = _add_class(opening, "table-image-missing")
        return opening + body + match.group("close")

    return _TABLE_FIGURE_RE.sub(replace, document)


_FIGURE_ID_RE = re.compile(
    r'(?P<open><figure\b[^>]*?\bid=["\'](?P<id>[^"\']+)["\'][^>]*>)(?P<body>.*?)</figure\s*>',
    flags=re.IGNORECASE | re.DOTALL,
)


def _deduplicate_figure_ids(document: str) -> str:
    matches = list(_FIGURE_ID_RE.finditer(document))
    groups: Dict[str, List[int]] = {}
    for index, match in enumerate(matches):
        groups.setdefault(match.group("id"), []).append(index)
    replacements: Dict[int, str] = {}
    used_ids = {match.group("id") for match in matches}
    for anchor, indexes in groups.items():
        if len(indexes) < 2:
            continue
        number = re.search(r"(\d+)$", anchor)
        expected = number.group(1) if number else ""

        def score(index: int, expected: str = expected) -> tuple[int, int]:
            body = matches[index].group("body")
            caption_match = re.search(r"<figcaption\b[^>]*>(.*?)</figcaption\s*>", body, flags=re.IGNORECASE | re.DOTALL)
            caption = re.sub(r"<[^>]+>", " ", caption_match.group(1) if caption_match else "")
            caption = re.sub(r"\s+", " ", html.unescape(caption)).strip()
            explicit = bool(expected and re.search(rf"\b(?:Figure|Fig\.?|Table)\s*{re.escape(expected)}\b", caption, flags=re.IGNORECASE))
            return (1000 if explicit else 0, len(caption))

        canonical = max(indexes, key=score)
        suffix = 1
        for index in indexes:
            if index == canonical:
                continue
            candidate = f"{anchor}-duplicate-{suffix}"
            while candidate in used_ids:
                suffix += 1
                candidate = f"{anchor}-duplicate-{suffix}"
            replacements[index] = candidate
            used_ids.add(candidate)
            suffix += 1
    if not replacements:
        return document
    cursor = 0
    chunks: List[str] = []
    for index, match in enumerate(matches):
        chunks.append(document[cursor:match.start()])
        block = match.group(0)
        if index in replacements:
            opening = match.group("open")
            opening = re.sub(
                rf'(\bid=["\']){re.escape(match.group("id"))}(["\'])',
                rf'\g<1>{replacements[index]}\g<2>',
                opening,
                count=1,
                flags=re.IGNORECASE,
            )
            block = opening + match.group("body") + "</figure>"
        chunks.append(block)
        cursor = match.end()
    chunks.append(document[cursor:])
    return "".join(chunks)


def _migrate_reader_html(job_dir: Path) -> bool:
    """Bring pre-continuous reader HTML into the current presentation shell."""
    path = job_dir / "document.html"
    if not path.is_file():
        return False
    try:
        document = path.read_text(encoding="utf-8")
    except OSError:
        return False
    had_migration_style = _LEGACY_READER_STYLE_MARKER in document
    original = document
    # Older exports put the page navigator and audit crops directly in the
    # DOM. Remove those presentation-only blocks instead of merely hiding
    # them, so accessibility/search cannot surface an internal fallback.
    document = re.sub(
        r'<nav\b[^>]*class=["\'][^"\']*\breader-nav\b[^"\']*["\'][^>]*>.*?</nav\s*>',
        "",
        document,
        flags=re.IGNORECASE | re.DOTALL,
    )
    document = _migrate_legacy_table_figures(document)
    document = _deduplicate_figure_ids(document)
    for class_name in ("source-crop", "page-source", "table-structure"):
        document = re.sub(
            rf'<(?:details|div|section)\b[^>]*class=["\'][^"\']*\b{class_name}\b[^"\']*["\'][^>]*>.*?</(?:details|div|section)\s*>',
            "",
            document,
            flags=re.IGNORECASE | re.DOTALL,
        )
    if had_migration_style:
        migrated = document
    else:
        closing = re.search(r"</style>", document, flags=re.IGNORECASE)
        if closing:
            migrated = document[:closing.start()] + _LEGACY_READER_STYLE + document[closing.start():]
        else:
            head = re.search(r"</head>", document, flags=re.IGNORECASE)
            style = f"<style>{_LEGACY_READER_STYLE}</style>"
            migrated = document[:head.start()] + style + document[head.start():] if head else style + document
    if migrated == original:
        return False
    try:
        path.write_text(migrated, encoding="utf-8")
    except OSError:
        return False
    return True
