"""Backend-neutral document structure and reading-order normalization."""

from __future__ import annotations

import copy
import colorsys
import hashlib
import json
import math
import os
import re
import time
import unicodedata
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Tuple
from pymupdf_runtime import load_fitz


IR_VERSION = 5
CAPTION_RE = re.compile(r"^\s*(?P<kind>fig(?:ure)?|table)\s*\.?\s*(?P<number>\d+)\s*[:.\-]?\s*", re.IGNORECASE)
TERMINAL_RE = re.compile(r'''[.!?。！？;；:]\s*[\]\)\}"'’”]*$''')
LOWERCASE_START_RE = re.compile(r"^[\s\[\(\"'‘“]*(?:[a-z]|and\b|or\b|but\b|which\b|that\b|where\b|while\b)")
FURNITURE_TYPES = {"page_header", "page_footnote", "page_number", "header", "footer", "number", "abandon"}
# Computer Modern spells its bold cuts CMB10 / CMBX10 rather than "bold", and
# sets no bold flag, so a LaTeX heading otherwise reads as regular weight.
BOLD_FONT_NAME_RE = re.compile(r"(?:bold|semi[- ]?bold|demi|black|heavy|\bcmbx?\d)", re.IGNORECASE)
TRANSLATABLE_TYPES = {"title", "paragraph", "list", "image", "table"}
SECTION_TITLE_RE = re.compile(r"^\s*(?:\d+(?:\.\d+)*|[A-Z])\s+\S+")
CONFERENCE_FOOTER_RE = re.compile(
    r"(?:^[A-Z][A-Z0-9-]{2,12}\s*[’']\d{2},.*\b20\d{2}\b|(?:copyright|isbn|doi)\b)",
    re.IGNORECASE,
)
PUBLISHER_BOILERPLATE_RE = re.compile(
    r"(?:permission to make digital or hard copies|acm reference format|"
    r"association for computing machinery|copyright|isbn|doi)",
    re.IGNORECASE,
)
PUBLICATION_METADATA_RE = re.compile(
    r"(?:^\s*(?:received|manuscript received)\b|\bdate of publication\b|"
    r"\bdate of current version\b|\bcorresponding author\b|"
    r"\bassociate editor coordinating the review\b)",
    re.IGNORECASE,
)
INLINE_ABSTRACT_RE = re.compile(
    r"^\s*(?:abstract|摘\s*要)\s*(?:[:：.\u2014-])\s*\S",
    re.IGNORECASE,
)
INLINE_KEYWORDS_RE = re.compile(
    r"^\s*(?:index\s+terms?|key\s*words?|keywords?|关\s*键\s*词)\s*(?:[:：.\u2014-])\s*\S",
    re.IGNORECASE,
)
SCRIPT_TAG_RE = re.compile(r"</?(?:sub|sup)>", re.IGNORECASE)
SCRIPT_RUN_RE = re.compile(r"<(sub|sup)>.*?</\1>", re.IGNORECASE | re.DOTALL)
PDF_EMPHASIS_MAX_PAGES = 512
PDF_EMPHASIS_MAX_SPANS = 200_000
PDF_EMPHASIS_MAX_TEXT_CHARS = 4_000_000
PDF_EMPHASIS_MAX_OPERATIONS = 1_000_000
PDF_EMPHASIS_MAX_SECONDS = 15.0
PDF_EMPHASIS_MAX_DRAWINGS = 50_000
PDF_EMPHASIS_MAX_DRAWING_ITEMS = 200_000
PDF_CAPTION_MAX_MARKERS = 512
PDF_EVIDENCE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
PDF_EVIDENCE_WORKER_CPU_SECONDS = 20
PDF_EVIDENCE_WORKER_ADDRESS_BYTES = 2 * 1024 * 1024 * 1024
CAPTION_CUE_RE = re.compile(r"^\s*(?P<cue>indicates|denotes|represents)\b", re.IGNORECASE)
CAPTION_CUE_SEARCH_RE = re.compile(r"\b(?P<cue>indicates|denotes|represents)\b", re.IGNORECASE)
BODY_MARKER_CUE_RE = re.compile(
    r"(?:^\s*|(?<=[.!?;:])\s+|\band\s+)(?P<cue>indicates|denotes|represents)\b",
    re.IGNORECASE,
)
BODY_MARKER_SLOT_RE = re.compile(r"\(\s*\)")
INLINE_MARKER_TONES = frozenset({"gray", "blue", "orange", "green", "red", "purple", "pink"})
PDF_TEXT_TONES = INLINE_MARKER_TONES - {"gray"}
PDF_TEXT_COLOR_EXCLUDED_RE = re.compile(
    r"(?:https?://|www\.|doi(?:\.org|:)|\S+@\S+)",
    re.IGNORECASE,
)
PDF_TEXT_COLOR_REFERENCE_RE = re.compile(
    r"^\s*(?:\[?\d+(?:\s*[,\-–]\s*\d+)*\]?|"
    r"(?:fig(?:ure)?|table|tab|eq(?:uation)?|section|sec)\.?\s*\d+[a-z]?|"
    r"[a-z]{1,8}\s*\d+[a-z]?)\s*$",
    re.IGNORECASE,
)
INLINE_CITATION_TAIL_RE = re.compile(
    r"(?P<formula>.*?)\s*\\left\s*\[(?P<citation>.*?)\\right\s*\]\s*$",
    re.DOTALL,
)


@dataclass
class _EmphasisBudget:
    deadline: float
    operations: int = 0
    pages: int = 0
    spans: int = 0
    text_chars: int = 0
    drawings: int = 0
    drawing_items: int = 0
    exceeded: bool = False
    reason: str = ""

    def fail(self, reason: str) -> bool:
        self.exceeded = True
        self.reason = reason
        return False

    def checkpoint(self, operations: int = 0) -> bool:
        if self.exceeded:
            return False
        if self.operations + operations > PDF_EMPHASIS_MAX_OPERATIONS:
            return self.fail("operation-budget")
        self.operations += operations
        if time.monotonic() > self.deadline:
            return self.fail("time-budget")
        return True


def _new_emphasis_budget() -> _EmphasisBudget:
    return _EmphasisBudget(deadline=time.monotonic() + PDF_EMPHASIS_MAX_SECONDS)


def _flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return re.sub(r"\s+", " ", value).strip()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return " ".join(filter(None, (_flatten_text(item) for item in value))).strip()
    if isinstance(value, dict):
        if value.get("type") == "inline_marker":
            return {"circle": "—●", "square": "—■"}.get(str(value.get("shape") or ""), "")
        for key in (
            "content", "text", "title_content", "paragraph_content", "list_content",
            "list_items", "item_content", "image_caption", "table_caption",
            "chart_caption", "chart_footnote",
            "page_header_content", "page_footnote_content", "page_number_content",
            "list items", "rows", "cells", "kids",
        ):
            if key in value:
                text = _flatten_text(value[key])
                if text:
                    return text
    return ""


def _bbox(value: Any) -> List[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return []
    try:
        left, top, right, bottom = (float(item) for item in value)
    except (TypeError, ValueError):
        return []
    if right <= left or bottom <= top:
        return []
    return [left, top, right, bottom]


def _odl_bbox(value: Any, page_height: float) -> List[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return []
    try:
        left, bottom, right, top = (float(item) for item in value)
    except (TypeError, ValueError):
        return []
    if right <= left or top <= bottom:
        return []
    return [left, max(0.0, page_height - top), right, max(0.0, page_height - bottom)]


def _width(box: Sequence[float]) -> float:
    return max(0.0, float(box[2]) - float(box[0])) if len(box) == 4 else 0.0


def _height(box: Sequence[float]) -> float:
    return max(0.0, float(box[3]) - float(box[1])) if len(box) == 4 else 0.0


def _center_x(box: Sequence[float]) -> float:
    return (float(box[0]) + float(box[2])) / 2.0


def _center_y(box: Sequence[float]) -> float:
    return (float(box[1]) + float(box[3])) / 2.0


def _union(boxes: Iterable[Sequence[float]]) -> List[float]:
    valid = [list(box) for box in boxes if len(box) == 4]
    if not valid:
        return []
    return [
        min(box[0] for box in valid), min(box[1] for box in valid),
        max(box[2] for box in valid), max(box[3] for box in valid),
    ]


def _horizontal_overlap(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != 4 or len(right) != 4:
        return 0.0
    overlap = max(0.0, min(left[2], right[2]) - max(left[0], right[0]))
    return overlap / max(1.0, min(_width(left), _width(right)))


def _safe_source_id(value: Any, fallback: int) -> str:
    raw = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value if value is not None else fallback)).strip("-.")
    return raw[:48] or str(fallback)


def _expand_odl_items(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    expanded: List[Dict[str, Any]] = []
    for raw in items:
        if str(raw.get("type") or "").lower() != "list":
            expanded.append(raw)
            continue
        entries = raw.get("list items") if isinstance(raw.get("list items"), list) else []
        has_nested = any(isinstance(entry, dict) and entry.get("kids") for entry in entries)
        single_heading = len(entries) == 1 and SECTION_TITLE_RE.match(_flatten_text(entries[0] if entries else {}))
        if not has_nested and not single_heading:
            expanded.append(raw)
            continue
        parent_id = _safe_source_id(raw.get("id"), len(expanded))
        for entry_index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue
            text = _flatten_text(entry.get("content"))
            if text:
                derived = dict(entry)
                derived["id"] = f"{parent_id}-item-{entry_index}"
                derived["page number"] = entry.get("page number") or raw.get("page number")
                derived["type"] = "heading" if SECTION_TITLE_RE.match(text) and len(text) <= 160 else "paragraph"
                derived["content"] = text
                expanded.append(derived)
            nested = entry.get("kids") if isinstance(entry.get("kids"), list) else []
            expanded.extend(_expand_odl_items(item for item in nested if isinstance(item, dict)))
    return expanded


def _stable_block_id(page: int, source_id: str, kind: str) -> str:
    return f"block-{page}-{source_id}-{kind}"


def _render_item(kind: str, text: str, box: List[float], raw: Mapping[str, Any]) -> Dict[str, Any]:
    if kind == "title":
        try:
            level = min(6, max(1, int(raw.get("heading level") or raw.get("level") or 2)))
        except (TypeError, ValueError):
            level = 2
        return {"type": "title", "bbox": box, "content": {"title_content": text, "level": level}}
    if kind == "paragraph":
        return {"type": "paragraph", "bbox": box, "content": {"paragraph_content": text}}
    if kind == "list":
        entries = raw.get("list items") if isinstance(raw.get("list items"), list) else []
        if not entries and text:
            entries = [{"content": text}]
        list_items = [
            {"item_type": "text", "item_content": str(entry.get("content") or "").strip()}
            for entry in entries if isinstance(entry, dict) and str(entry.get("content") or "").strip()
        ]
        return {"type": "list", "bbox": box, "content": {"list_type": "content_list", "list_items": list_items}}
    if kind == "image":
        source = str(raw.get("source") or "").strip()
        content: Dict[str, Any] = {"image_caption": text}
        if source:
            content["image_source"] = {"path": source}
        return {"type": "image", "bbox": box, "content": content}
    if kind == "table":
        source = str(raw.get("source") or "").strip()
        content = {"table_caption": text, "table_type": "odl-table"}
        if source:
            content["image_source"] = {"path": source}
        return {"type": "table", "bbox": box, "content": content}
    return {"type": kind, "bbox": box, "content": text}


def _canonical_element(
    *, page: int, source_id: str, source_index: int, kind: str, box: List[float],
    text: str, source: str, render: Dict[str, Any], confidence: float = 1.0,
    role: str = "body", flags: Iterable[str] = (),
) -> Dict[str, Any]:
    block_id = _stable_block_id(page, source_id, str(render.get("type") or kind))
    return {
        "id": block_id,
        "page": page,
        "type": kind,
        "bbox": box,
        "text": text,
        "source": source,
        "source_id": source_id,
        "source_index": source_index,
        "reading_order": source_index,
        "confidence": round(max(0.0, min(1.0, float(confidence))), 4),
        "role": role,
        "flags": sorted(set(flags)),
        "fragments": [{"page": page, "bbox": box, "text": text}],
        "render": render,
    }


def _edge_key(text: str) -> str:
    return re.sub(r"\d+", "#", re.sub(r"\W+", " ", text.lower())).strip()


def _edge_occurrences(raw_pages: Mapping[int, List[Dict[str, Any]]], page_sizes: Sequence[Tuple[float, float]]) -> Counter:
    keys: Counter = Counter()
    seen: set[Tuple[int, str]] = set()
    for page, items in raw_pages.items():
        height = page_sizes[page - 1][1]
        for item in items:
            box = _odl_bbox(item.get("bounding box"), height)
            text = _flatten_text(item)
            if not box or not text or len(text) > 120:
                continue
            edge = box[1] <= height * 0.075 or box[3] >= height * 0.94
            key = _edge_key(text)
            if edge and key and (page, key) not in seen:
                keys[key] += 1
                seen.add((page, key))
    return keys


def _is_furniture(element: Dict[str, Any], page_height: float, repeats: Counter) -> bool:
    box = element["bbox"]
    text = element["text"]
    if element["type"] in FURNITURE_TYPES:
        return True
    if not box or not text or len(text) > 120 or _height(box) > page_height * 0.07:
        return False
    key = _edge_key(text)
    at_edge = box[1] <= page_height * 0.055 or box[3] >= page_height * 0.965
    repeated_or_numbered = at_edge and (repeats.get(key, 0) >= 2 or bool(re.fullmatch(r"\W*\d+\W*", text)))
    conference_footer = box[1] >= page_height * 0.85 and bool(CONFERENCE_FOOTER_RE.search(text))
    return repeated_or_numbered or conference_footer


def _recoverable_mineru_footnote(text: str, box: Sequence[float], page_height: float) -> bool:
    if not text or PUBLISHER_BOILERPLATE_RE.search(text) or PUBLICATION_METADATA_RE.search(text):
        return False
    numbered_body = bool(re.match(r"^\s*\(\d+\)\s+", text))
    body_position = bool(box) and len(text) >= 160 and box[3] <= page_height * 0.82
    return numbered_body or body_position


def _caption_figures(elements: List[Dict[str, Any]], page_width: float, page_height: float) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    suppressed: List[Dict[str, Any]] = []
    suppressed_ids: set[str] = set()
    figures: List[Dict[str, Any]] = []
    captions = [item for item in elements if item["role"] == "body" and CAPTION_RE.match(item["text"])]
    for caption in captions:
        match = CAPTION_RE.match(caption["text"])
        if not match or not match.group("kind").lower().startswith("fig"):
            continue
        cap_box = caption["bbox"]
        candidates = []
        for item in elements:
            if item is caption or item["id"] in suppressed_ids or item["role"] != "body" or not item["bbox"]:
                continue
            box = item["bbox"]
            gap = cap_box[1] - box[3]
            if gap < -page_height * 0.015 or gap > page_height * 0.34:
                continue
            if _horizontal_overlap(box, cap_box) < 0.2:
                continue
            if item["type"] == "image" or len(item["text"]) <= 120 or _height(box) <= page_height * 0.09:
                candidates.append(item)
        explicit_images = [item for item in candidates if item["type"] == "image"]
        short_text = [item for item in candidates if item["text"] and len(item["text"]) <= 80]
        if not explicit_images and len(short_text) < 4:
            continue
        figure_box = _union(item["bbox"] for item in candidates)
        if not figure_box or _width(figure_box) < page_width * 0.18 or _height(figure_box) < page_height * 0.06:
            continue
        render = _render_item("image", caption["text"], figure_box, {})
        source_id = caption["source_id"]
        figure = _canonical_element(
            page=caption["page"], source_id=source_id, source_index=caption["source_index"],
            kind="image", box=figure_box, text=caption["text"], source="odl-derived-figure",
            render=render, confidence=0.9 if explicit_images else 0.82,
            flags={"caption-associated", "visual-crop", "chart-text-suppressed"},
        )
        figures.append(figure)
        for item in [caption, *candidates]:
            if item["id"] in suppressed_ids:
                continue
            suppressed_ids.add(item["id"])
            suppressed.append({
                "id": item["id"], "page": item["page"], "type": item["type"],
                "bbox": item["bbox"], "text": item["text"], "reason": "figure-region",
            })
    kept = [item for item in elements if item["id"] not in suppressed_ids]
    kept.extend(figures)
    return kept, suppressed


def _figure_number(text: str) -> Optional[str]:
    match = re.search(r"\bfig(?:ure)?\s*\.?\s*(\d+)\b", str(text or ""), flags=re.IGNORECASE)
    return match.group(1) if match else None


def _visual_gap(left: Sequence[float], right: Sequence[float]) -> Tuple[float, float]:
    if len(left) != 4 or len(right) != 4:
        return float("inf"), float("inf")
    horizontal = max(0.0, max(left[0], right[0]) - min(left[2], right[2]))
    vertical = max(0.0, max(left[1], right[1]) - min(left[3], right[3]))
    return horizontal, vertical


def _compose_mineru_figure(
    candidates: List[Dict[str, Any]], union: Sequence[float], *, text: Optional[str] = None,
) -> Dict[str, Any]:
    """Build one composite image element covering every fragment's crop."""
    captioned = sorted(candidates, key=lambda item: (len(str(item.get("text") or "")), -int(item.get("source_index") or 0)), reverse=True)[0]
    source_id = f"{captioned.get('source_id') or captioned.get('source_index')}-composite"
    render = copy.deepcopy(captioned.get("render") or {})
    render["bbox"] = union
    content = render.get("content") if isinstance(render.get("content"), dict) else {}
    render["content"] = content
    merged = _canonical_element(
        page=int(captioned.get("page") or 1),
        source_id=source_id,
        source_index=min(int(item.get("source_index") or 0) for item in candidates),
        kind="image",
        box=union,
        text=str(captioned.get("text") or "").strip() if text is None else text,
        source="mineru-composite",
        render=render,
        confidence=min(float(item.get("confidence") or 0.0) for item in candidates),
        flags=set().union(*(item.get("flags") or [] for item in candidates)) | {"composite-visual", "source-crop"},
    )
    merged["fragments"] = [fragment for item in candidates for fragment in item.get("fragments", [])]
    merged["visual_fragments"] = [
        {"id": item.get("id"), "bbox": item.get("bbox"), "text": item.get("text", "")}
        for item in candidates
    ]
    return merged


# A plate broken into panel crops covers much of the page. Two figures that
# merely sit on the same page do not, so the area floor is what keeps this from
# gluing unrelated figures together.
UNNUMBERED_PLATE_MIN_FRAGMENTS = 3
UNNUMBERED_PLATE_MIN_AREA_RATIO = 0.25


def _unnumbered_figure_clusters(
    elements: List[Dict[str, Any]], consumed: set[str], page_width: float, page_height: float,
) -> List[List[Dict[str, Any]]]:
    """Group leftover panel crops that together tile one large page region."""
    remaining = [
        element for element in elements
        if element.get("type") == "image" and element.get("source") == "mineru"
        and str(element.get("id") or "") not in consumed
        and _bbox(element.get("bbox"))
        and not _figure_number(str(element.get("text") or ""))
    ]
    if len(remaining) < UNNUMBERED_PLATE_MIN_FRAGMENTS:
        return []
    max_gap = max(page_width, page_height) * 0.16
    page_area = float(page_width) * float(page_height)
    clusters: List[List[Dict[str, Any]]] = []
    unassigned = list(remaining)
    while unassigned:
        cluster = [unassigned.pop(0)]
        changed = True
        while changed:
            changed = False
            for candidate in list(unassigned):
                if any(max(_visual_gap(candidate.get("bbox") or [], other.get("bbox") or [])) <= max_gap for other in cluster):
                    cluster.append(candidate)
                    unassigned.remove(candidate)
                    changed = True
        if len(cluster) < UNNUMBERED_PLATE_MIN_FRAGMENTS:
            continue
        union = _union(item.get("bbox") for item in cluster)
        if not union or not page_area:
            continue
        if (_width(union) * _height(union)) / page_area < UNNUMBERED_PLATE_MIN_AREA_RATIO:
            continue
        clusters.append(cluster)
    return clusters


def _merge_mineru_figure_fragments(
    elements: List[Dict[str, Any]], page_width: float, page_height: float,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Keep a multi-panel figure as one PDF crop instead of panel crops.

    MinerU may expose a single author-composed figure as several ``chart``
    elements (for example a main plot, color bar, and two small panels).  A
    repeated Figure number is the only reliable semantic link available at
    this stage, so we additionally require all fragments to form one compact
    visual region before coalescing them.
    """
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    visual_candidates = [
        element for element in elements
        if element.get("type") == "image" and element.get("source") == "mineru"
    ]
    for element in elements:
        if element.get("type") != "image" or element.get("source") != "mineru":
            continue
        number = _figure_number(str(element.get("text") or ""))
        if number:
            groups[number].append(element)

    suppressed: List[Dict[str, Any]] = []
    consumed: set[str] = set()
    for number, candidates in groups.items():
        candidates = [item for item in candidates if str(item.get("id") or "") not in consumed]
        max_gap = max(page_width, page_height) * 0.16
        expanded = list(candidates)
        expanded_ids = {str(item.get("id") or "") for item in expanded}
        changed = True
        while changed:
            changed = False
            for candidate in visual_candidates:
                candidate_id = str(candidate.get("id") or "")
                if candidate_id in expanded_ids or candidate_id in consumed or _figure_number(str(candidate.get("text") or "")):
                    continue
                candidate_text = str(candidate.get("text") or "").strip()
                if candidate_text and len(candidate_text) > 80:
                    continue
                if any(max(_visual_gap(candidate.get("bbox") or [], other.get("bbox") or [])) <= max_gap for other in expanded):
                    expanded.append(candidate)
                    expanded_ids.add(candidate_id)
                    changed = True
        candidates = expanded
        if len(candidates) < 2:
            continue
        boxes = [item.get("bbox") for item in candidates if _bbox(item.get("bbox"))]
        if len(boxes) < 2:
            continue
        union = _union(boxes)
        if not union:
            continue
        # Reject unrelated same-number nodes that are separated by a full
        # column or page-sized gap.  Panels and legends normally touch or sit
        # within a small gutter of another fragment.
        connected: set[str] = {str(candidates[0].get("id") or "")}
        changed = True
        while changed:
            changed = False
            for candidate in candidates:
                candidate_id = str(candidate.get("id") or "")
                if candidate_id in connected:
                    continue
                if any(max(_visual_gap(candidate.get("bbox") or [], other.get("bbox") or [])) <= max_gap for other in candidates if str(other.get("id") or "") in connected):
                    connected.add(candidate_id)
                    changed = True
        if len(connected) < 2 or len(connected) != len(candidates):
            continue

        elements.append(_compose_mineru_figure(candidates, union))
        consumed.update(str(item.get("id") or "") for item in candidates)
        for item in candidates:
            suppressed.append({
                "id": item.get("id"), "page": item.get("page"), "type": item.get("type"),
                "bbox": item.get("bbox"), "text": item.get("text", ""),
                "reason": "composite-figure-fragment", "figure": number,
            })

    # A plate whose caption sits on another page ("Fig. 5: (previous page) …")
    # leaves no figure number on any fragment, so the grouping above never gets
    # a seed and the page reaches the reader as a scatter of panel crops.
    for cluster in _unnumbered_figure_clusters(elements, consumed, page_width, page_height):
        union = _union(item.get("bbox") for item in cluster)
        if not union:
            continue
        elements.append(_compose_mineru_figure(cluster, union, text=""))
        consumed.update(str(item.get("id") or "") for item in cluster)
        for item in cluster:
            suppressed.append({
                "id": item.get("id"), "page": item.get("page"), "type": item.get("type"),
                "bbox": item.get("bbox"), "text": item.get("text", ""),
                "reason": "composite-figure-fragment", "figure": "",
            })

    if not consumed:
        return elements, suppressed
    kept = [
        item for item in elements
        if str(item.get("id") or "") not in consumed and item.get("source") != "mineru-composite"
    ]
    kept.extend(item for item in elements if item.get("source") == "mineru-composite")
    return kept, suppressed


def _is_barrier(element: Dict[str, Any], page_width: float) -> bool:
    box = element["bbox"]
    if not box:
        return False
    width = _width(box)
    spans_center = box[0] < page_width * 0.32 and box[2] > page_width * 0.68
    return width >= page_width * 0.72 or (spans_center and width >= page_width * 0.5)


def _detect_columns(elements: List[Dict[str, Any]], page_width: float) -> bool:
    candidates = [item for item in elements if item["bbox"] and not _is_barrier(item, page_width)]
    mid = page_width / 2.0
    left = [item for item in candidates if _center_x(item["bbox"]) < mid and item["bbox"][2] <= page_width * 0.61]
    right = [item for item in candidates if _center_x(item["bbox"]) >= mid and item["bbox"][0] >= page_width * 0.39]
    left_chars = sum(len(item["text"]) for item in left if item["type"] in TRANSLATABLE_TYPES)
    right_chars = sum(len(item["text"]) for item in right if item["type"] in TRANSLATABLE_TYPES)
    return len(left) >= 2 and len(right) >= 2 and left_chars >= 80 and right_chars >= 80


def _order_segment(elements: List[Dict[str, Any]], page_width: float) -> List[Dict[str, Any]]:
    if not elements:
        return []
    if not _detect_columns(elements, page_width):
        for item in elements:
            item["column"] = 0
        return sorted(elements, key=lambda item: (_center_y(item["bbox"]), item["bbox"][0], item["source_index"]))
    mid = page_width / 2.0
    left, right, floating = [], [], []
    for item in elements:
        box = item["bbox"]
        if box[2] <= page_width * 0.61 or _center_x(box) < mid * 0.92:
            item["column"] = 1
            left.append(item)
        elif box[0] >= page_width * 0.39 or _center_x(box) > mid * 1.08:
            item["column"] = 2
            right.append(item)
        else:
            item["column"] = 0
            floating.append(item)
    key = lambda item: (_center_y(item["bbox"]), item["bbox"][0], item["source_index"])
    return sorted(left, key=key) + sorted(floating, key=key) + sorted(right, key=key)


def _order_page(elements: List[Dict[str, Any]], page_width: float) -> List[Dict[str, Any]]:
    barriers = sorted((item for item in elements if _is_barrier(item, page_width)), key=lambda item: (_center_y(item["bbox"]), item["bbox"][0]))
    remaining = [item for item in elements if item not in barriers]
    ordered: List[Dict[str, Any]] = []
    consumed: set[str] = set()
    for barrier in barriers:
        before = [item for item in remaining if item["id"] not in consumed and _center_y(item["bbox"]) < _center_y(barrier["bbox"])]
        ordered.extend(_order_segment(before, page_width))
        consumed.update(item["id"] for item in before)
        barrier["column"] = 0
        ordered.append(barrier)
    tail = [item for item in remaining if item["id"] not in consumed]
    ordered.extend(_order_segment(tail, page_width))
    for index, item in enumerate(ordered, 1):
        item["reading_order"] = index
    return ordered


def _order_first_page(elements: List[Dict[str, Any]], page_width: float) -> List[Dict[str, Any]]:
    abstract = next(
        (
            item for item in elements
            if (
                item["type"] in {"title", "paragraph"}
                and re.fullmatch(r"(?:abstract|摘\s*要)\s*(?:[:：.\u2014-])?", item["text"].strip(), flags=re.IGNORECASE)
            ) or (item["type"] == "paragraph" and INLINE_ABSTRACT_RE.match(item["text"]))
        ),
        None,
    )
    if abstract is None:
        return _order_page(elements, page_width)
    standalone = bool(re.fullmatch(
        r"(?:abstract|摘\s*要)\s*(?:[:：.\u2014-])?",
        abstract["text"].strip(),
        flags=re.IGNORECASE,
    ))
    abstract_body: Optional[Dict[str, Any]] = None
    if standalone:
        if abstract["type"] == "paragraph":
            abstract["type"] = "title"
            abstract["render"] = {
                "type": "title",
                "bbox": list(abstract["bbox"]),
                "content": {"title_content": abstract["text"], "level": 2},
            }
            abstract["flags"] = sorted(set(abstract.get("flags", [])) | {"standalone-abstract-promoted"})
        abstract["section_role"] = "abstract-heading"
        candidates: List[Tuple[float, float, int, Dict[str, Any]]] = []
        for item in elements:
            if item is abstract or item.get("type") != "paragraph" or not item.get("bbox"):
                continue
            vertical_gap = float(item["bbox"][1]) - float(abstract["bbox"][3])
            overlap = _horizontal_overlap(item["bbox"], abstract["bbox"])
            if -2.0 <= vertical_gap <= 48.0 and overlap >= 0.75:
                candidates.append((max(0.0, vertical_gap), -overlap, int(item.get("source_index", 0)), item))
        if candidates:
            abstract_body = min(candidates, key=lambda value: value[:3])[3]
            abstract_body["section_role"] = "abstract-body"
    else:
        abstract["section_role"] = "abstract-body"
    for item in elements:
        if item["type"] == "paragraph" and INLINE_KEYWORDS_RE.match(item["text"]):
            item["section_role"] = "keywords"
    metadata = [
        item for item in elements
        if item is not abstract
        and item["type"] in {"paragraph", "list"}
        and item["bbox"][3] <= abstract["bbox"][1] + 2.0
    ]
    for item in metadata:
        item["role"] = "metadata"
        item["column"] = 0
    body = [item for item in elements if item not in metadata]
    ordered = _order_page(body, page_width)
    metadata.sort(key=lambda item: (_center_y(item["bbox"]), item["bbox"][0], item["source_index"]))
    # A title that wraps arrives as several elements, and only counting the
    # first one dropped the author block between the title's two lines.
    # Everything sitting wholly above the metadata belongs ahead of it.
    if metadata:
        metadata_top = min(float(item["bbox"][1]) for item in metadata)
        insert_at = 0
        for index, item in enumerate(ordered):
            box = item.get("bbox")
            if not box or float(box[3]) > metadata_top + 2.0:
                break
            insert_at = index + 1
    else:
        insert_at = 1 if ordered and _is_barrier(ordered[0], page_width) else 0
    ordered[insert_at:insert_at] = metadata
    if abstract_body is not None and abstract in ordered and abstract_body in ordered:
        ordered.remove(abstract_body)
        ordered.insert(ordered.index(abstract) + 1, abstract_body)
    for index, item in enumerate(ordered, 1):
        item["reading_order"] = index
    return ordered


def _continues(previous: Dict[str, Any], current: Dict[str, Any]) -> bool:
    if previous.get("type") != "paragraph" or current.get("type") != "paragraph":
        return False
    if previous.get("section_role") or current.get("section_role"):
        return False
    left = str(previous.get("text") or "").strip()
    right = str(current.get("text") or "").strip()
    if not left or not right or TERMINAL_RE.search(left):
        return False
    return bool(LOWERCASE_START_RE.search(right))


def _paragraph_render_pieces(render: Mapping[str, Any], fallback: str) -> List[Any]:
    content = render.get("content") if isinstance(render.get("content"), Mapping) else {}
    value = content.get("paragraph_content")
    if isinstance(value, list) and value:
        return copy.deepcopy(value)
    if isinstance(value, str) and value:
        return [{"type": "text", "content": value}]
    return [{"type": "text", "content": fallback}] if fallback else []


def _merge_elements(previous: Dict[str, Any], current: Dict[str, Any], flag: str) -> None:
    left = previous["text"].rstrip()
    right = current["text"].lstrip()
    separator = "" if left.endswith("-") else " "
    merged = f"{left}{separator}{right}"
    previous_render = previous.get("render") if isinstance(previous.get("render"), dict) else {}
    current_render = current.get("render") if isinstance(current.get("render"), dict) else {}
    merged_pieces: List[Any] = []
    if previous_render.get("type") == "paragraph":
        merged_pieces.extend(_paragraph_render_pieces(previous_render, left))
        if separator:
            merged_pieces.append({"type": "text", "content": separator})
        merged_pieces.extend(_paragraph_render_pieces(current_render, right))
    previous["text"] = merged
    previous["flags"] = sorted(set(previous.get("flags", [])) | {flag})
    previous["fragments"].extend(current.get("fragments", []))
    previous["confidence"] = round(min(float(previous["confidence"]), float(current["confidence"]), 0.92), 4)
    if previous_render.get("type") == "paragraph":
        content = previous_render.get("content")
        if not isinstance(content, dict):
            content = {}
            previous_render["content"] = content
        content["paragraph_content"] = merged_pieces


def _trim_chart_caption_prefix(value: Any) -> Tuple[Any, bool]:
    if not isinstance(value, list) or len(value) < 2:
        return copy.deepcopy(value), False
    marker_index: Optional[int] = None
    for index, piece in enumerate(value):
        if not isinstance(piece, Mapping) or piece.get("type") != "text":
            continue
        if CAPTION_RE.match(str(piece.get("content") or "")):
            marker_index = index
            break
    if marker_index is None or marker_index == 0:
        return copy.deepcopy(value), False
    prefix = value[:marker_index]
    if any(not isinstance(piece, Mapping) or piece.get("type") != "text" for piece in prefix):
        return copy.deepcopy(value), False
    prefix_text = _flatten_text(prefix)
    if len(prefix_text) < 24 or TERMINAL_RE.search(prefix_text):
        return copy.deepcopy(value), False
    return copy.deepcopy(value[marker_index:]), True


def _normalized_text_with_offsets(value: str) -> Tuple[str, List[int]]:
    normalized: List[str] = []
    offsets: List[int] = []
    previous_space = False
    for index, char in enumerate(value):
        folded = unicodedata.normalize("NFKC", char).casefold()
        for output in folded:
            if output.isspace():
                if previous_space or not normalized:
                    continue
                normalized.append(" ")
                offsets.append(index)
                previous_space = True
            else:
                normalized.append(output)
                offsets.append(index)
                previous_space = False
    while normalized and normalized[-1] == " ":
        normalized.pop()
        offsets.pop()
    return "".join(normalized), offsets


def _compact_text_with_offsets(value: str) -> Tuple[str, List[int]]:
    """Fold PDF text, including line-break hyphens, for evidence matching."""
    layout_breaks = frozenset({"\u00ad", "-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014"})
    compact: List[str] = []
    offsets: List[int] = []
    for index, char in enumerate(value):
        folded = unicodedata.normalize("NFKC", char).casefold()
        for output in folded:
            if output.isspace() or output in layout_breaks:
                continue
            compact.append(output)
            offsets.append(index)
    return "".join(compact), offsets


def _find_prepared_text_range(
    normalized: str, offsets: Sequence[int], target: str, start: int = 0
) -> Optional[Tuple[int, int]]:
    if not normalized or not target:
        return None
    normalized_start = bisect_left(offsets, start)
    found = normalized.find(target, normalized_start)
    if found < 0:
        return None
    return offsets[found], offsets[found + len(target) - 1] + 1


def _find_emphasis_text_range(
    compact: str,
    offsets: Sequence[int],
    target: str,
    start: int = 0,
) -> Optional[Tuple[int, int]]:
    """Match a PDF run in reading order, failing closed on ambiguous short runs."""
    if not compact or not target or not offsets:
        return None
    target = str(target)
    if len(target) < 2:
        return None
    search_from = bisect_left(offsets, start)
    occurrences: List[Tuple[int, int]] = []
    cursor = compact.find(target, search_from)
    while cursor >= 0:
        end_cursor = cursor + len(target)
        if end_cursor > len(offsets):
            break
        original_start = offsets[cursor]
        original_end = offsets[end_cursor - 1] + 1
        if len(target) <= 3:
            previous = compact[cursor - 1] if cursor else ""
            following = compact[end_cursor] if end_cursor < len(compact) else ""
            if (previous and previous.isalnum()) or (following and following.isalnum()):
                cursor = compact.find(target, cursor + 1)
                continue
        occurrences.append((original_start, original_end))
        cursor = compact.find(target, cursor + 1)
    if occurrences:
        return occurrences[0]
    # A long run can be recovered when the extractor and layout reader use
    # different reading orders, but never do this for a two- or three-letter
    # token: those are too likely to occur inside an unrelated word.
    if len(target) < 8:
        return None
    cursor = compact.find(target)
    if cursor < 0:
        return None
    if compact.find(target, cursor + 1) >= 0:
        return None
    end_cursor = cursor + len(target)
    if end_cursor > len(offsets):
        return None
    return offsets[cursor], offsets[end_cursor - 1] + 1


def _drawing_bbox(value: Any) -> List[float]:
    try:
        if all(hasattr(value, key) for key in ("x0", "y0", "x1", "y1")):
            box = [float(value.x0), float(value.y0), float(value.x1), float(value.y1)]
        elif isinstance(value, (list, tuple)) and len(value) == 4:
            box = [float(item) for item in value]
        else:
            return []
    except (TypeError, ValueError):
        return []
    if box[2] < box[0] or box[3] < box[1] or (box[2] == box[0] and box[3] == box[1]):
        return []
    return box


def _rgb(value: Any) -> Optional[List[float]]:
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return None
    try:
        channels = [float(value[index]) for index in range(3)]
    except (TypeError, ValueError):
        return None
    if any(not math.isfinite(channel) or channel < 0.0 or channel > 1.0 for channel in channels):
        return None
    return channels


def _marker_tone(value: Any) -> Optional[str]:
    color = _rgb(value)
    if color is None:
        return None
    low, high = min(color), max(color)
    if high - low <= 0.08:
        level = sum(color) / 3.0
        return "gray" if 0.15 <= level <= 0.85 else None
    hue, saturation, brightness = colorsys.rgb_to_hsv(*color)
    if saturation < 0.22 or brightness < 0.18 or low > 0.92:
        return None
    degrees = hue * 360.0
    if degrees < 15.0 or degrees >= 345.0:
        return "red"
    if degrees < 60.0:
        return "orange"
    if degrees < 170.0:
        return "green"
    if degrees < 255.0:
        return "blue"
    if degrees < 310.0:
        return "purple"
    return "pink"


def _pdf_text_tone(span: Mapping[str, Any]) -> Optional[str]:
    text = str(span.get("text") or "").strip()
    if (
        not text
        or len(text) > 512
        or sum(character.isalpha() for character in text) < 2
        or PDF_TEXT_COLOR_EXCLUDED_RE.search(text)
        or PDF_TEXT_COLOR_REFERENCE_RE.fullmatch(text)
    ):
        return None
    value = span.get("color")
    if isinstance(value, bool):
        return None
    try:
        packed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if packed < 0 or packed > 0xFFFFFF:
        return None
    rgb = [((packed >> shift) & 0xFF) / 255.0 for shift in (16, 8, 0)]
    tone = _marker_tone(rgb)
    return tone if tone in PDF_TEXT_TONES else None


def _marker_drawing_pages(pages: Sequence[Sequence[Mapping[str, Any]]]) -> List[int]:
    selected: List[int] = []
    for page_index, items in enumerate(pages, 1):
        include = False
        for item in items:
            if not isinstance(item, Mapping):
                continue
            if item.get("type") == "chart":
                include = True
                break
            if item.get("type") == "paragraph" and (
                BODY_MARKER_CUE_RE.search(_flatten_text(item.get("content")))
                or BODY_MARKER_SLOT_RE.search(_flatten_text(item.get("content")))
            ):
                include = True
                break
        if include:
            selected.append(page_index)
    return selected


def _extract_pdf_text_pages(
    pdf_path: Optional[Path], *, budget: Optional[_EmphasisBudget] = None,
    drawing_pages: Optional[Sequence[int]] = None,
) -> List[Dict[str, Any]]:
    if pdf_path is None:
        return []
    active_budget = budget or _new_emphasis_budget()
    if not active_budget.checkpoint():
        return []
    try:
        fitz = load_fitz()

        pages: List[Dict[str, Any]] = []
        span_count = 0
        text_chars = 0
        drawing_count = 0
        drawing_item_count = 0
        selected_drawing_pages = set(drawing_pages) if drawing_pages is not None else None
        with fitz.open(pdf_path) as document:
            try:
                if len(document) > PDF_EMPHASIS_MAX_PAGES:
                    active_budget.fail("page-budget")
                    return []
            except TypeError:
                pass
            text_flags = getattr(fitz, "TEXTFLAGS_TEXT", None)
            for page_index, page in enumerate(document, 1):
                if page_index > PDF_EMPHASIS_MAX_PAGES:
                    active_budget.fail("page-budget")
                    return []
                if not active_budget.checkpoint():
                    return []
                spans: List[Dict[str, Any]] = []
                try:
                    page_dict = (
                        page.get_text("rawdict", flags=text_flags)
                        if text_flags is not None
                        else page.get_text("rawdict")
                    )
                except (AttributeError, TypeError, RuntimeError, ValueError):
                    page_dict = (
                        page.get_text("dict", flags=text_flags)
                        if text_flags is not None
                        else page.get_text("dict")
                    )
                for block in page_dict.get("blocks", []):
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            raw_chars = span.get("chars") if isinstance(span, Mapping) else None
                            char_records: List[Dict[str, Any]] = []
                            if isinstance(raw_chars, list):
                                for raw_char in raw_chars:
                                    if not isinstance(raw_char, Mapping):
                                        continue
                                    char_text = str(raw_char.get("text") or raw_char.get("c") or "")
                                    char_box = _bbox(raw_char.get("bbox"))
                                    if char_text and char_box:
                                        char_records.append({"text": char_text, "bbox": char_box})
                            text = str(span.get("text") or "")
                            if not text and char_records:
                                text = "".join(item["text"] for item in char_records)
                            font = str(span.get("font") or "")
                            span_count += 1
                            text_chars += len(text) + len(font)
                            if span_count > PDF_EMPHASIS_MAX_SPANS:
                                active_budget.fail("span-budget")
                                return []
                            if text_chars > PDF_EMPHASIS_MAX_TEXT_CHARS:
                                active_budget.fail("text-budget")
                                return []
                            if not active_budget.checkpoint():
                                return []
                            box = _bbox(span.get("bbox"))
                            if not text.strip() or not box:
                                continue
                            try:
                                flags = int(span.get("flags") or 0)
                                size = float(span.get("size") or 0.0)
                            except (TypeError, ValueError):
                                flags, size = 0, 0.0
                            bold = bool(flags & 16) or bool(BOLD_FONT_NAME_RE.search(font))
                            evidence_span = {
                                "text": text,
                                "bbox": box,
                                "size": size,
                                "font": font,
                                "flags": flags,
                                "color": int(span.get("color") or 0),
                                "bold": bold,
                            }
                            if char_records:
                                evidence_span["chars"] = char_records
                            spans.append(evidence_span)
                drawings: List[Dict[str, Any]] = []
                get_drawings = getattr(page, "get_drawings", None)
                raw_drawings = (
                    get_drawings()
                    if callable(get_drawings)
                    and (selected_drawing_pages is None or page_index in selected_drawing_pages)
                    else []
                )
                for drawing in raw_drawings if isinstance(raw_drawings, list) else []:
                    drawing_count += 1
                    active_budget.drawings = drawing_count
                    if drawing_count > PDF_EMPHASIS_MAX_DRAWINGS:
                        active_budget.fail("drawing-budget")
                        return []
                    if not isinstance(drawing, Mapping):
                        if not active_budget.checkpoint(1):
                            return []
                        continue
                    items = drawing.get("items") if isinstance(drawing.get("items"), list) else []
                    drawing_item_count += len(items)
                    active_budget.drawing_items = drawing_item_count
                    if drawing_item_count > PDF_EMPHASIS_MAX_DRAWING_ITEMS:
                        active_budget.fail("drawing-item-budget")
                        return []
                    if not active_budget.checkpoint(len(items) + 1):
                        return []
                    box = _drawing_bbox(drawing.get("rect"))
                    if not box:
                        continue
                    commands = [
                        str(item[0])
                        for item in items
                        if isinstance(item, (list, tuple)) and item and isinstance(item[0], str)
                    ]
                    drawings.append({
                        "type": str(drawing.get("type") or ""),
                        "bbox": box,
                        "color": _rgb(drawing.get("color")),
                        "fill": _rgb(drawing.get("fill")),
                        "commands": commands,
                    })
                pages.append({
                    "width": float(page.rect.width),
                    "height": float(page.rect.height),
                    "spans": spans,
                    "drawings": drawings,
                })
        return pages
    except Exception:
        return []


def _apply_pdf_evidence_worker_limits() -> None:
    try:
        import resource
    except ImportError:  # pragma: no cover - unavailable on Windows
        return
    limits = (
        (getattr(resource, "RLIMIT_CPU", None), PDF_EVIDENCE_WORKER_CPU_SECONDS),
        (getattr(resource, "RLIMIT_AS", None), PDF_EVIDENCE_WORKER_ADDRESS_BYTES),
        (getattr(resource, "RLIMIT_FSIZE", None), PDF_EVIDENCE_MAX_OUTPUT_BYTES),
    )
    for kind, requested in limits:
        if kind is None:
            continue
        try:
            _, hard = resource.getrlimit(kind)
            target = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
            resource.setrlimit(kind, (target, hard))
        except (OSError, ValueError):
            continue


def write_pdf_evidence(
    pdf_path: Path,
    output_path: Path,
    *,
    drawing_pages: Optional[Sequence[int]] = None,
) -> None:
    _apply_pdf_evidence_worker_limits()
    pages = _extract_pdf_text_pages(
        Path(pdf_path),
        budget=_new_emphasis_budget(),
        drawing_pages=drawing_pages,
    )
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(output_path.name + ".tmp")
    written = 0
    try:
        with temporary.open("wb") as handle:
            for chunk in json.JSONEncoder(ensure_ascii=False, separators=(",", ":")).iterencode(pages):
                encoded = chunk.encode("utf-8")
                written += len(encoded)
                if written > PDF_EVIDENCE_MAX_OUTPUT_BYTES:
                    raise ValueError("PDF evidence output exceeds its safety limit")
                handle.write(encoded)
        os.replace(temporary, output_path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _pdf_bbox(box: Sequence[float], ir_page: Mapping[str, Any], pdf_page: Mapping[str, Any]) -> List[float]:
    normalized_box = _bbox(box)
    if not normalized_box:
        return []
    try:
        pdf_width = float(pdf_page.get("width") or 0.0)
        pdf_height = float(pdf_page.get("height") or 0.0)
        ir_width = float(ir_page.get("width") or 0.0)
        ir_height = float(ir_page.get("height") or 0.0)
    except (TypeError, ValueError):
        return []
    if any(
        not math.isfinite(value) or value <= 0.0
        for value in (pdf_width, pdf_height, ir_width, ir_height)
    ):
        return []
    normalized_canvas = ir_width > pdf_width * 1.2 or ir_height > pdf_height * 1.2
    scale_x = pdf_width / 1000.0 if normalized_canvas and pdf_width else 1.0
    scale_y = pdf_height / 1000.0 if normalized_canvas and pdf_height else 1.0
    return [
        normalized_box[0] * scale_x,
        normalized_box[1] * scale_y,
        normalized_box[2] * scale_x,
        normalized_box[3] * scale_y,
    ]


def _pdf_span_char_records(span: Mapping[str, Any]) -> List[Dict[str, Any]]:
    raw_chars = span.get("chars")
    if not isinstance(raw_chars, list):
        return []
    records: List[Dict[str, Any]] = []
    for raw_char in raw_chars:
        if not isinstance(raw_char, Mapping):
            continue
        text = str(raw_char.get("text") or raw_char.get("c") or "")
        box = _bbox(raw_char.get("bbox"))
        if not text or not box:
            continue
        record = dict(span)
        record.pop("chars", None)
        record["text"] = text
        record["bbox"] = box
        if raw_char.get("color") is not None:
            record["color"] = raw_char.get("color")
        if raw_char.get("bold") is not None:
            record["bold"] = raw_char.get("bold")
        record["_pdf_char"] = True
        records.append(record)
    return records


def _pdf_entries_can_merge(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    if not left.get("_pdf_char") or not right.get("_pdf_char"):
        return False
    left_span = left.get("span") if isinstance(left.get("span"), Mapping) else {}
    right_span = right.get("span") if isinstance(right.get("span"), Mapping) else {}
    if (
        left_span.get("color") != right_span.get("color")
        or bool(left_span.get("bold")) != bool(right_span.get("bold"))
        or str(left_span.get("font") or "") != str(right_span.get("font") or "")
    ):
        return False
    left_box = _bbox(left_span.get("bbox"))
    right_box = _bbox(right_span.get("bbox"))
    if not left_box or not right_box:
        return False
    try:
        left_size = float(left_span.get("size") or 0.0)
        right_size = float(right_span.get("size") or 0.0)
    except (TypeError, ValueError, OverflowError):
        return False
    if not math.isfinite(left_size) or not math.isfinite(right_size) or left_size <= 0.0 or right_size <= 0.0:
        return False
    line_tolerance = max(2.0, min(left_size, right_size) * 0.35)
    gap = right_box[0] - left_box[2]
    return (
        abs(_center_y(left_box) - _center_y(right_box)) <= line_tolerance
        and gap >= -max(2.5, min(left_size, right_size) * 0.35)
        and gap <= max(8.0, max(left_size, right_size) * 2.5)
        and len(str(left_span.get("text") or "")) + len(str(right_span.get("text") or "")) <= 480
    )


def _merge_pdf_entries(left: Dict[str, Any], right: Mapping[str, Any]) -> None:
    left_span = left["span"]
    right_span = right["span"] if isinstance(right.get("span"), Mapping) else {}
    left_span["text"] = f'{left_span.get("text") or ""}{right_span.get("text") or ""}'
    left_span["bbox"] = _union([left_span.get("bbox") or [], right_span.get("bbox") or []])
    normalized, _ = _normalized_text_with_offsets(str(left_span.get("text") or ""))
    compact, _ = _compact_text_with_offsets(str(left_span.get("text") or ""))
    left["normalized"] = normalized
    left["compact"] = compact


def _prepare_pdf_span_indexes(
    pages: Sequence[Mapping[str, Any]],
    pdf_pages: Sequence[Mapping[str, Any]],
    budget: _EmphasisBudget,
) -> Optional[List[Dict[str, Any]]]:
    if len(pages) > PDF_EMPHASIS_MAX_PAGES or len(pdf_pages) > PDF_EMPHASIS_MAX_PAGES:
        budget.fail("page-budget")
        return None
    if len(pdf_pages) < len(pages) or not budget.checkpoint():
        return None
    budget.pages = len(pdf_pages)
    span_count = 0
    text_chars = 0
    indexes: List[Dict[str, Any]] = []
    sequence = 0
    for pdf_page in pdf_pages:
        if not isinstance(pdf_page, Mapping):
            budget.fail("invalid-page")
            return None
        entries: List[Dict[str, Any]] = []
        raw_spans = pdf_page.get("spans", [])
        if not isinstance(raw_spans, list):
            raw_spans = []
        for _ordinal, span in enumerate(raw_spans):
            if not isinstance(span, Mapping):
                if not budget.checkpoint(1):
                    return None
                continue
            text = str(span.get("text") or "")
            font = str(span.get("font") or "")
            text_chars += len(text) + len(font)
            budget.text_chars = text_chars
            if text_chars > PDF_EMPHASIS_MAX_TEXT_CHARS:
                budget.fail("text-budget")
                return None
            if not budget.checkpoint(1):
                return None
            char_records = _pdf_span_char_records(span)
            records = char_records or [dict(span)]
            for record in records:
                box = _bbox(record.get("bbox"))
                record_text = str(record.get("text") or "")
                if not box or not record_text:
                    continue
                span_count += 1
                budget.spans = span_count
                if span_count > PDF_EMPHASIS_MAX_SPANS:
                    budget.fail("span-budget")
                    return None
                normalized, _ = _normalized_text_with_offsets(record_text)
                compact, _ = _compact_text_with_offsets(record_text)
                if not budget.checkpoint():
                    return None
                safe_span = dict(record)
                safe_span["bbox"] = box
                sequence += 1
                entries.append({
                    "center_y": _center_y(box),
                    "center_x": _center_x(box),
                    "ordinal": sequence,
                    "normalized": normalized,
                    "compact": compact,
                    "_pdf_char": bool(record.get("_pdf_char")),
                    "span": safe_span,
                })
        entries.sort(key=lambda entry: (entry["center_y"], entry["center_x"], entry["ordinal"]))
        merged_entries: List[Dict[str, Any]] = []
        for entry in entries:
            if merged_entries and _pdf_entries_can_merge(merged_entries[-1], entry):
                _merge_pdf_entries(merged_entries[-1], entry)
            else:
                merged_entries.append(entry)
        indexes.append({"ys": [entry["center_y"] for entry in merged_entries], "entries": merged_entries})
    return indexes


def _spans_near_visual(
    element: Mapping[str, Any],
    ir_page: Mapping[str, Any],
    pdf_page: Mapping[str, Any],
    span_index: Mapping[str, Any],
    budget: _EmphasisBudget,
) -> List[Mapping[str, Any]]:
    box = _pdf_bbox(element.get("bbox") or [], ir_page, pdf_page)
    if not box:
        return []
    top = box[1] - 36.0
    bottom = box[3] + 90.0
    ys = span_index.get("ys", [])
    entries = span_index.get("entries", [])
    selected: List[Mapping[str, Any]] = []
    for entry in entries[bisect_left(ys, top):bisect_right(ys, bottom)]:
        if not budget.checkpoint(1):
            return []
        selected.append(entry)
    return selected


def _caption_text_slice(piece: Mapping[str, Any], start: int, end: int) -> Optional[Dict[str, Any]]:
    content = str(piece.get("content") or "")
    if start >= end:
        return None
    sliced = copy.deepcopy(dict(piece))
    sliced["content"] = content[start:end]
    ranges = piece.get("emphasis") if isinstance(piece.get("emphasis"), list) else []
    adjusted: List[Dict[str, Any]] = []
    for item in ranges:
        if not isinstance(item, Mapping):
            continue
        try:
            item_start = max(start, int(item.get("start", -1)))
            item_end = min(end, int(item.get("end", -1)))
        except (TypeError, ValueError):
            continue
        if item_start >= item_end:
            continue
        copied = copy.deepcopy(dict(item))
        copied["start"] = item_start - start
        copied["end"] = item_end - start
        adjusted.append(copied)
    if adjusted:
        sliced["emphasis"] = adjusted
    else:
        sliced.pop("emphasis", None)
    return sliced


def _insert_caption_markers(
    segments: Sequence[Any],
    markers: Sequence[Mapping[str, Any]],
    cue_pattern: re.Pattern[str] = CAPTION_CUE_SEARCH_RE,
) -> List[Any]:
    by_cue = {int(marker["cue_index"]): marker for marker in markers}
    cue_index = 0
    output: List[Any] = []
    for piece in segments:
        if not isinstance(piece, Mapping) or piece.get("type") != "text":
            output.append(copy.deepcopy(piece))
            continue
        content = str(piece.get("content") or "")
        cursor = 0
        for match in cue_pattern.finditer(content):
            marker = by_cue.get(cue_index)
            if marker is not None:
                cue_start = match.start("cue")
                prefix = _caption_text_slice(piece, cursor, cue_start)
                if prefix is not None:
                    output.append(prefix)
                output.append({
                    "type": "inline_marker",
                    "shape": str(marker["shape"]),
                    "style": "line-marker",
                    "tone": str(marker["tone"]),
                    "source": "pdf-drawing",
                    "source_rgb": list(marker["source_rgb"]),
                    "source_bbox": list(marker["source_bbox"]),
                })
                cursor = cue_start
            cue_index += 1
        suffix = _caption_text_slice(piece, cursor, len(content))
        if suffix is not None:
            output.append(suffix)
    return output


def _insert_parenthesized_markers(
    segments: Sequence[Any],
    markers: Sequence[Mapping[str, Any]],
) -> List[Any]:
    by_slot = {int(marker["cue_index"]): marker for marker in markers}
    slot_index = 0
    output: List[Any] = []
    for piece in segments:
        if not isinstance(piece, Mapping) or piece.get("type") != "text":
            output.append(copy.deepcopy(piece))
            continue
        content = str(piece.get("content") or "")
        cursor = 0
        for match in BODY_MARKER_SLOT_RE.finditer(content):
            marker = by_slot.get(slot_index)
            if marker is not None:
                prefix = _caption_text_slice(piece, cursor, match.start() + 1)
                if prefix is not None:
                    output.append(prefix)
                output.append({
                    "type": "inline_marker",
                    "shape": str(marker["shape"]),
                    "style": "line-marker",
                    "tone": str(marker["tone"]),
                    "source": "pdf-drawing",
                    "source_rgb": list(marker["source_rgb"]),
                    "source_bbox": list(marker["source_bbox"]),
                })
                cursor = match.end() - 1
            slot_index += 1
        suffix = _caption_text_slice(piece, cursor, len(content))
        if suffix is not None:
            output.append(suffix)
    return output


def _parenthesized_pdf_slots(
    entries: Sequence[Mapping[str, Any]],
    owner_box: Sequence[float],
    budget: _EmphasisBudget,
) -> List[Dict[str, Any]]:
    spans: List[Mapping[str, Any]] = []
    for entry in entries:
        if not budget.checkpoint(1):
            return []
        span = entry.get("span") if isinstance(entry.get("span"), Mapping) else {}
        box = span.get("bbox") or []
        if len(box) != 4:
            continue
        if (
            float(box[2]) < float(owner_box[0]) - 3.0
            or float(box[0]) > float(owner_box[2]) + 3.0
            or _center_y(box) < float(owner_box[1]) - 3.0
            or _center_y(box) > float(owner_box[3]) + 3.0
        ):
            continue
        spans.append(span)
    spans.sort(key=lambda span: (_center_y(span.get("bbox") or []), float((span.get("bbox") or [0.0])[0])))
    openings = [span for span in spans if str(span.get("text") or "").rstrip().endswith("(")]
    closings = [span for span in spans if str(span.get("text") or "").lstrip().startswith(")")]
    if not openings or not closings:
        return []
    used_closings: set[int] = set()
    slots: List[Dict[str, Any]] = []
    for opening in openings:
        if not budget.checkpoint(1):
            return []
        opening_box = opening.get("bbox") or []
        try:
            font_size = max(6.0, float(opening.get("size") or 0.0))
        except (TypeError, ValueError):
            font_size = 6.0
        matches: List[Tuple[float, int, Mapping[str, Any]]] = []
        for closing_index, closing in enumerate(closings):
            if closing_index in used_closings or not budget.checkpoint(1):
                continue
            closing_box = closing.get("bbox") or []
            gap = float(closing_box[0]) - float(opening_box[2])
            if (
                float(owner_box[0]) - 3.0 <= float(opening_box[2]) <= float(owner_box[2]) + 3.0
                and float(owner_box[0]) - 3.0 <= float(closing_box[0]) <= float(owner_box[2]) + 3.0
                and 4.0 <= gap <= min(24.0, font_size * 2.8)
                and abs(_center_y(opening_box) - _center_y(closing_box)) <= 1.5
            ):
                matches.append((gap, closing_index, closing))
        if len(matches) != 1:
            continue
        gap, closing_index, closing = matches[0]
        closing_box = closing.get("bbox") or []
        intervening_text = False
        for span in spans:
            if span is opening or span is closing:
                continue
            if not budget.checkpoint(1):
                return []
            box = span.get("bbox") or []
            if (
                abs(_center_y(box) - _center_y(opening_box)) <= 1.5
                and float(box[0]) < float(closing_box[0]) - 0.25
                and float(box[2]) > float(opening_box[2]) + 0.25
            ):
                intervening_text = True
                break
        if intervening_text:
            continue
        used_closings.add(closing_index)
        slots.append({
            "opening": opening,
            "closing": closing,
            "bbox": [float(opening_box[2]), min(float(opening_box[1]), float(closing_box[1])), float(closing_box[0]), max(float(opening_box[3]), float(closing_box[3]))],
            "font_size": font_size,
            "gap": gap,
        })
    slots.sort(key=lambda slot: (_center_y(slot["bbox"]), slot["bbox"][0]))
    return slots


def _drawing_marker_for_slot(
    slot: Mapping[str, Any],
    drawings: Sequence[Mapping[str, Any]],
    owner_box: Sequence[float],
    budget: _EmphasisBudget,
) -> Optional[Dict[str, Any]]:
    slot_box = slot.get("bbox") or []
    if len(slot_box) != 4:
        return None
    try:
        font_size = max(6.0, float(slot.get("font_size") or 0.0))
    except (TypeError, ValueError):
        font_size = 6.0
    line_candidates: List[Tuple[Mapping[str, Any], List[float], str, List[float]]] = []
    for drawing in drawings:
        if not budget.checkpoint(1):
            return None
        box = _drawing_bbox(drawing.get("bbox"))
        commands = drawing.get("commands") if isinstance(drawing.get("commands"), list) else []
        color = _rgb(drawing.get("color"))
        tone = _marker_tone(color)
        if (
            not box
            or commands != ["l"]
            or color is None
            or tone not in INLINE_MARKER_TONES
            or _width(box) < 4.0
            or _width(box) > min(20.0, font_size * 2.2)
            or _height(box) > max(1.5, font_size * 0.18)
            or box[0] < slot_box[0] - 0.75
            or box[2] > slot_box[2] + 0.75
            or box[0] < owner_box[0] - 3.0
            or box[2] > owner_box[2] + 3.0
            or abs(_center_y(box) - _center_y(slot_box)) > max(1.5, font_size * 0.25)
        ):
            continue
        line_candidates.append((drawing, color, tone, box))
    complete: List[Dict[str, Any]] = []
    for _line, line_color, tone, line_box in line_candidates:
        for drawing in drawings:
            if not budget.checkpoint(1):
                return None
            shape_box = _drawing_bbox(drawing.get("bbox"))
            commands = drawing.get("commands") if isinstance(drawing.get("commands"), list) else []
            fill = _rgb(drawing.get("fill"))
            if not shape_box or fill is None or _marker_tone(fill) != tone:
                continue
            shape_width = _width(shape_box)
            shape_height = _height(shape_box)
            if (
                shape_width < 2.5
                or shape_height < 2.5
                or shape_width > min(10.0, font_size)
                or shape_height > min(10.0, font_size)
                or not 0.72 <= shape_width / max(shape_height, 0.01) <= 1.28
                or abs(_center_y(shape_box) - _center_y(line_box)) > 1.5
                or not line_box[0] - 1.0 <= _center_x(shape_box) <= line_box[2] + 1.0
                or max(abs(left - right) for left, right in zip(line_color, fill, strict=False)) > 0.12
            ):
                continue
            if len(commands) >= 3 and all(command == "c" for command in commands):
                shape = "circle"
            elif len(commands) >= 4 and all(command == "l" for command in commands):
                shape = "square"
            else:
                continue
            complete.append({
                "shape": shape,
                "tone": tone,
                "source_rgb": [round(channel, 4) for channel in line_color],
                "source_bbox": _union([line_box, shape_box]),
            })
    unique = {
        (item["shape"], item["tone"], tuple(item["source_bbox"])): item
        for item in complete
    }
    return next(iter(unique.values())) if len(unique) == 1 else None


def _drawing_marker_for_cue(
    cue: Mapping[str, Any],
    drawings: Sequence[Mapping[str, Any]],
    owner_box: Sequence[float],
    budget: _EmphasisBudget,
    *,
    placement: str,
) -> Optional[Dict[str, Any]]:
    cue_span = cue.get("span") if isinstance(cue.get("span"), Mapping) else {}
    cue_box = cue_span.get("bbox") or []
    if len(cue_box) != 4:
        return None
    try:
        font_size = max(6.0, float(cue_span.get("size") or 0.0))
    except (TypeError, ValueError):
        font_size = 6.0
    line_candidates: List[Tuple[float, Mapping[str, Any], List[float], str]] = []
    for drawing in drawings:
        if not budget.checkpoint(1):
            return None
        box = _drawing_bbox(drawing.get("bbox"))
        commands = drawing.get("commands") if isinstance(drawing.get("commands"), list) else []
        color = _rgb(drawing.get("color"))
        tone = _marker_tone(color)
        if (
            not box
            or commands != ["l"]
            or color is None
            or tone not in INLINE_MARKER_TONES
            or _width(box) < 4.0
            or _width(box) > min(20.0, font_size * 2.2)
            or _height(box) > max(1.5, font_size * 0.18)
            or box[0] < owner_box[0] - 8.0
            or box[2] > owner_box[2] + 8.0
        ):
            continue
        if placement == "caption":
            if box[1] <= owner_box[3] + 2.0:
                continue
        elif placement == "body":
            if _center_y(box) < owner_box[1] - 6.0 or _center_y(box) > owner_box[3] + 6.0:
                continue
        else:
            continue
        gap = float(cue_box[0]) - float(box[2])
        if -0.75 <= gap <= 2.5 and abs(_center_y(box) - _center_y(cue_box)) <= max(1.5, font_size * 0.25):
            line_candidates.append((abs(gap), drawing, color, tone))
    for _, line, line_color, tone in sorted(line_candidates, key=lambda value: value[0]):
        line_box = _drawing_bbox(line.get("bbox"))
        for drawing in drawings:
            if not budget.checkpoint(1):
                return None
            shape_box = _drawing_bbox(drawing.get("bbox"))
            commands = drawing.get("commands") if isinstance(drawing.get("commands"), list) else []
            fill = _rgb(drawing.get("fill"))
            if not shape_box or fill is None or _marker_tone(fill) != tone:
                continue
            shape_width = _width(shape_box)
            shape_height = _height(shape_box)
            if (
                shape_width < 2.5
                or shape_height < 2.5
                or shape_width > min(10.0, font_size)
                or shape_height > min(10.0, font_size)
                or not 0.72 <= shape_width / max(shape_height, 0.01) <= 1.28
                or abs(_center_y(shape_box) - _center_y(line_box)) > 1.5
                or not line_box[0] - 1.0 <= _center_x(shape_box) <= line_box[2] + 1.0
                or max(abs(left - right) for left, right in zip(line_color, fill, strict=False)) > 0.12
            ):
                continue
            if len(commands) >= 3 and all(command == "c" for command in commands):
                shape = "circle"
            elif len(commands) >= 4 and all(command == "l" for command in commands):
                shape = "square"
            else:
                continue
            return {
                "shape": shape,
                "tone": tone,
                "source_rgb": [round(channel, 4) for channel in line_color],
                "source_bbox": _union([line_box, shape_box]),
            }
    return None


def _recover_caption_inline_markers(
    pages: List[Dict[str, Any]],
    pdf_pages: Sequence[Mapping[str, Any]],
    span_indexes: Sequence[Mapping[str, Any]],
    budget: _EmphasisBudget,
) -> List[Dict[str, Any]]:
    pending: List[Tuple[Dict[str, Any], str, List[Any], List[Dict[str, Any]], str, str]] = []
    total_markers = 0
    for page in pages:
        page_index = int(page.get("page", 0)) - 1
        if page_index < 0 or page_index >= len(pdf_pages) or page_index >= len(span_indexes):
            continue
        pdf_page = pdf_pages[page_index]
        drawings = pdf_page.get("drawings") if isinstance(pdf_page.get("drawings"), list) else []
        if not drawings:
            continue
        for element in page.get("elements", []):
            if not budget.checkpoint(1):
                return []
            render = element.get("render") if isinstance(element.get("render"), dict) else {}
            content = render.get("content") if isinstance(render.get("content"), dict) else {}
            element_type = element.get("type")
            marker: Optional[re.Match[str]] = None
            if element_type == "image":
                key = "image_caption"
                segments = content.get(key)
                owner_text = _flatten_text(segments)
                marker = CAPTION_RE.match(owner_text)
                if marker is None or not marker.group("kind").lower().startswith("fig"):
                    continue
                cue_pattern = CAPTION_CUE_SEARCH_RE
                placement = "caption"
                flag = "caption-inline-marker-recovered"
                reason = "pdf-caption-line-gap"
            elif element_type == "paragraph":
                key = "paragraph_content"
                segments = content.get(key)
                owner_text = _flatten_text(segments)
                if BODY_MARKER_SLOT_RE.search(owner_text):
                    cue_pattern = BODY_MARKER_SLOT_RE
                    placement = "body-slot"
                    flag = "paragraph-inline-marker-recovered"
                    reason = "pdf-body-parenthesized-marker-gap"
                elif BODY_MARKER_CUE_RE.search(owner_text):
                    cue_pattern = BODY_MARKER_CUE_RE
                    placement = "body"
                    flag = "paragraph-inline-marker-recovered"
                    reason = "pdf-paragraph-line-gap"
                else:
                    continue
            else:
                continue
            if isinstance(segments, str):
                segments = [{"type": "text", "content": segments}]
            if not isinstance(segments, list):
                continue
            owner_box = _pdf_bbox(element.get("bbox") or [], page, pdf_page)
            if not owner_box:
                continue
            nearby = _spans_near_visual(element, page, pdf_page, span_indexes[page_index], budget)
            if budget.exceeded:
                return []
            if placement == "body-slot":
                slot_count = len(list(BODY_MARKER_SLOT_RE.finditer(owner_text)))
                segment_slot_count = sum(
                    len(list(BODY_MARKER_SLOT_RE.finditer(str(piece.get("content") or ""))))
                    for piece in segments
                    if isinstance(piece, Mapping) and piece.get("type") == "text"
                )
                if segment_slot_count != slot_count:
                    continue
                pdf_slots = _parenthesized_pdf_slots(nearby, owner_box, budget)
                if budget.exceeded:
                    return []
                if slot_count == 0 or not pdf_slots:
                    continue
                recovered: List[Dict[str, Any]] = []
                for slot in pdf_slots:
                    found = _drawing_marker_for_slot(slot, drawings, owner_box, budget)
                    if budget.exceeded:
                        return []
                    if found is not None:
                        found["cue_index"] = len(recovered)
                        recovered.append(found)
                if len(recovered) != slot_count:
                    continue
                total_markers += len(recovered)
                if total_markers > PDF_CAPTION_MAX_MARKERS:
                    budget.fail("marker-budget")
                    return []
                pending.append((
                    element,
                    key,
                    _insert_parenthesized_markers(segments, recovered),
                    recovered,
                    flag,
                    reason,
                ))
                continue
            anchor_y = owner_box[1]
            if placement == "caption" and marker is not None:
                expected_number = marker.group("number")
                anchors = []
                for entry in nearby:
                    span = entry.get("span") if isinstance(entry.get("span"), Mapping) else {}
                    span_marker = CAPTION_RE.match(str(span.get("text") or ""))
                    span_box = span.get("bbox") or []
                    if (
                        span_marker is not None
                        and span_marker.group("kind").lower().startswith("fig")
                        and span_marker.group("number") == expected_number
                        and len(span_box) == 4
                        and owner_box[3] - 4.0 <= _center_y(span_box) <= owner_box[3] + 90.0
                    ):
                        anchors.append(entry)
                if not anchors:
                    continue
                anchor_y = min(_center_y(entry["span"]["bbox"]) for entry in anchors)
            cues = []
            for entry in nearby:
                span = entry.get("span") if isinstance(entry.get("span"), Mapping) else {}
                span_box = span.get("bbox") or []
                if (
                    CAPTION_CUE_RE.match(str(span.get("text") or ""))
                    and len(span_box) == 4
                    and _center_y(span_box) >= anchor_y
                    and _center_y(span_box) <= owner_box[3] + (100.0 if placement == "caption" else 8.0)
                    and owner_box[0] - 4.0 <= float(span_box[0]) <= owner_box[2] + 8.0
                ):
                    cues.append(entry)
            cues.sort(key=lambda entry: (_center_y(entry["span"]["bbox"]), entry["span"]["bbox"][0]))
            cue_count = len(list(cue_pattern.finditer(owner_text)))
            if cue_count == 0 or len(cues) != cue_count:
                continue
            recovered: List[Dict[str, Any]] = []
            for cue_index, cue in enumerate(cues):
                found = _drawing_marker_for_cue(cue, drawings, owner_box, budget, placement=placement)
                if budget.exceeded:
                    return []
                if found is not None:
                    found["cue_index"] = cue_index
                    recovered.append(found)
            if len(recovered) != cue_count:
                continue
            total_markers += len(recovered)
            if total_markers > PDF_CAPTION_MAX_MARKERS:
                budget.fail("marker-budget")
                return []
            if recovered:
                pending.append((
                    element,
                    key,
                    _insert_caption_markers(segments, recovered, cue_pattern),
                    recovered,
                    flag,
                    reason,
                ))
    if budget.exceeded:
        return []
    audits: List[Dict[str, Any]] = []
    for element, key, segments, recovered, flag, reason in pending:
        content = element["render"]["content"]
        content[key] = segments
        element["text"] = _flatten_text(content)
        element["flags"] = sorted(set(element.get("flags", [])) | {flag})
        element_audits = [
            {
                "page": element.get("page"),
                "block_id": element.get("id"),
                "shape": marker["shape"],
                "tone": marker["tone"],
                "source_rgb": marker["source_rgb"],
                "cue_index": marker["cue_index"],
                "source_bbox": marker["source_bbox"],
                "reason": reason,
            }
            for marker in recovered
        ]
        element["inline_marker_recoveries"] = element_audits
        audits.extend(element_audits)
    return audits


def _span_is_blue_reference(span: Mapping[str, Any]) -> bool:
    try:
        color = int(span.get("color") or 0)
    except (TypeError, ValueError):
        return False
    red = (color >> 16) & 0xFF
    green = (color >> 8) & 0xFF
    blue = color & 0xFF
    return blue >= 80 and blue >= green + 20 and blue >= red + 25


def _source_multi_citations(
    pdf_page: Mapping[str, Any], budget: _EmphasisBudget
) -> List[Dict[str, Any]]:
    spans: List[Mapping[str, Any]] = []
    for span in pdf_page.get("spans", []):
        if not budget.checkpoint(1):
            return []
        if isinstance(span, Mapping) and len(span.get("bbox") or []) == 4:
            spans.append(span)
    spans.sort(key=lambda span: (_center_y(span.get("bbox") or []), (span.get("bbox") or [0])[0]))
    candidates: List[Dict[str, Any]] = []
    for index in range(max(0, len(spans) - 4)):
        if not budget.checkpoint(1):
            return []
        group = spans[index:index + 5]
        texts = [str(span.get("text") or "") for span in group]
        if not (
            texts[0].strip() == "["
            and texts[1].strip().isdigit()
            and texts[2].strip() == ","
            and texts[3].strip().isdigit()
            and texts[4].lstrip().startswith("]")
            and _span_is_blue_reference(group[1])
            and _span_is_blue_reference(group[3])
        ):
            continue
        boxes = [span.get("bbox") or [] for span in group]
        if any(len(box) != 4 for box in boxes):
            continue
        if any(abs(_center_y(box) - _center_y(boxes[0])) > 2.0 for box in boxes[1:]):
            continue
        if any(not -1.0 <= boxes[position + 1][0] - boxes[position][2] <= 2.5 for position in range(4)):
            continue
        candidates.append({
            "numbers": [texts[1].strip(), texts[3].strip()],
            "bbox": _union(boxes),
        })
    return candidates


def _recover_pdf_inline_citations(
    pages: List[Dict[str, Any]],
    pdf_pages: Sequence[Mapping[str, Any]],
    budget: _EmphasisBudget,
) -> List[Dict[str, Any]]:
    pending: List[Tuple[Dict[str, Any], List[Any], List[Dict[str, Any]]]] = []
    for page in pages:
        page_index = int(page.get("page", 0)) - 1
        if page_index < 0 or page_index >= len(pdf_pages):
            continue
        pdf_page = pdf_pages[page_index]
        page_candidates = _source_multi_citations(pdf_page, budget)
        if budget.exceeded:
            return []
        if not page_candidates:
            continue
        for element in page.get("elements", []):
            if not budget.checkpoint(1):
                return []
            if element.get("type") != "paragraph":
                continue
            render = element.get("render") if isinstance(element.get("render"), dict) else {}
            content = render.get("content") if isinstance(render.get("content"), dict) else {}
            pieces = content.get("paragraph_content")
            if not isinstance(pieces, list):
                continue
            element_box = _pdf_bbox(element.get("bbox") or [], page, pdf_page)
            candidates: List[Dict[str, Any]] = []
            for candidate in page_candidates:
                if not budget.checkpoint(1):
                    return []
                candidate_box = candidate.get("bbox") or []
                if (
                    len(element_box) == 4
                    and len(candidate_box) == 4
                    and element_box[0] - 2.0 <= _center_x(candidate_box) <= element_box[2] + 2.0
                    and element_box[1] - 2.0 <= _center_y(candidate_box) <= element_box[3] + 2.0
                ):
                    candidates.append(candidate)
            if not candidates:
                continue
            used: set[int] = set()
            updated: List[Any] = []
            recoveries: List[Dict[str, Any]] = []
            for piece in pieces:
                copied = copy.deepcopy(piece)
                if not isinstance(copied, dict) or copied.get("type") != "equation_inline":
                    updated.append(copied)
                    continue
                tex = str(copied.get("content") or "")
                tail = INLINE_CITATION_TAIL_RE.fullmatch(tex)
                if tail is None:
                    updated.append(copied)
                    continue
                tail_digits = "".join(re.findall(r"\d", tail.group("citation")))
                candidate_index = next(
                    (
                        index for index, candidate in enumerate(candidates)
                        if index not in used and "".join(candidate["numbers"]) == tail_digits
                    ),
                    None,
                )
                if candidate_index is None:
                    updated.append(copied)
                    continue
                candidate = candidates[candidate_index]
                formula = tail.group("formula").rstrip()
                if not formula:
                    updated.append(copied)
                    continue
                used.add(candidate_index)
                copied["content"] = formula
                updated.append(copied)
                citation = f"[{', '.join(candidate['numbers'])}]"
                updated.append({"type": "text", "content": f" {citation} ", "source": "pdf-span-citation"})
                recoveries.append({
                    "page": element.get("page"),
                    "block_id": element.get("id"),
                    "citation": citation,
                    "source_bbox": candidate["bbox"],
                    "reason": "colored-pdf-citation-spans",
                })
            if recoveries:
                pending.append((element, updated, recoveries))
    if budget.exceeded:
        return []
    audits: List[Dict[str, Any]] = []
    for element, pieces, recoveries in pending:
        content = element["render"]["content"]
        content["paragraph_content"] = pieces
        element["text"] = _flatten_text(content)
        element["flags"] = sorted(set(element.get("flags", [])) | {"inline-citation-recovered"})
        element["inline_citation_recoveries"] = recoveries
        audits.extend(recoveries)
    return audits


def _matching_span_sizes(
    spans: Sequence[Mapping[str, Any]], value: str, budget: _EmphasisBudget
) -> List[float]:
    target, _ = _normalized_text_with_offsets(value)
    if not target or not budget.checkpoint():
        return []
    sizes: List[float] = []
    for entry in spans:
        if not budget.checkpoint(1):
            return []
        span = entry.get("span") if isinstance(entry.get("span"), Mapping) else {}
        candidate = str(entry.get("normalized") or "")
        if not candidate:
            continue
        shorter = min(len(target), len(candidate))
        if shorter < min(8, len(target)):
            continue
        if target in candidate or (len(candidate) >= 12 and candidate in target):
            try:
                size = float(span.get("size") or 0.0)
            except (TypeError, ValueError):
                continue
            if size > 0:
                sizes.append(size)
    return sizes


def _recover_caption_continuations(
    pages: List[Dict[str, Any]],
    pdf_pages: Sequence[Mapping[str, Any]],
    span_indexes: Sequence[Mapping[str, Any]],
    budget: _EmphasisBudget,
) -> List[Dict[str, Any]]:
    recoveries: List[Dict[str, Any]] = []
    if len(pdf_pages) < len(pages) or len(span_indexes) < len(pages) or not budget.checkpoint():
        return recoveries
    for previous_page, current_page in zip(pages, pages[1:], strict=False):
        if not budget.checkpoint():
            return recoveries
        previous = next(
            (item for item in reversed(previous_page["elements"]) if item.get("type") == "paragraph" and item.get("text")),
            None,
        )
        if previous is None or TERMINAL_RE.search(str(previous.get("text") or "").strip()):
            continue
        textual_source_indexes = [
            int(item.get("source_index", 0))
            for item in current_page["elements"]
            if item.get("type") in {"title", "paragraph", "list"} and item.get("text")
        ]
        for visual in current_page["elements"]:
            kind = str(visual.get("type") or "")
            if kind not in {"image", "table"}:
                continue
            if textual_source_indexes and int(visual.get("source_index", 0)) > min(textual_source_indexes):
                continue
            render = visual.get("render") if isinstance(visual.get("render"), dict) else {}
            content = render.get("content") if isinstance(render.get("content"), dict) else {}
            caption_key = "image_caption" if kind == "image" else "table_caption"
            segments = content.get(caption_key)
            if not isinstance(segments, list) or len(segments) < 2:
                continue
            tail = segments[-1]
            if not isinstance(tail, dict) or tail.get("type") != "text":
                continue
            continuation = _flatten_text(tail.get("content"))
            caption = _flatten_text(segments[:-1])
            marker = CAPTION_RE.match(caption)
            if (
                not marker
                or not TERMINAL_RE.search(caption)
                or not continuation
                or len(continuation) > 180
                or not LOWERCASE_START_RE.search(continuation)
                or not TERMINAL_RE.search(continuation)
            ):
                continue
            pdf_page_index = current_page["page"] - 1
            nearby_spans = _spans_near_visual(
                visual,
                current_page,
                pdf_pages[pdf_page_index],
                span_indexes[pdf_page_index],
                budget,
            )
            if budget.exceeded:
                return recoveries
            caption_sizes = _matching_span_sizes(nearby_spans, marker.group(0).strip(), budget)
            continuation_sizes = _matching_span_sizes(nearby_spans, continuation, budget)
            if budget.exceeded:
                return recoveries
            if not caption_sizes or not continuation_sizes:
                continue
            caption_size = median(caption_sizes)
            continuation_size = median(continuation_sizes)
            if continuation_size < caption_size * 1.07 or continuation_size - caption_size < 0.6:
                continue
            content[caption_key] = copy.deepcopy(segments[:-1])
            visual["text"] = caption
            visual["flags"] = sorted(set(visual.get("flags", [])) | {"caption-continuation-recovered"})
            visual["fragments"] = [{"page": visual["page"], "bbox": visual.get("bbox", []), "text": caption}]
            recovered = _canonical_element(
                page=current_page["page"],
                source_id=f'{visual.get("source_id", "visual")}-caption-recovery',
                source_index=int(visual.get("source_index", 0)),
                kind="paragraph",
                box=[],
                text=continuation,
                source="mineru-caption-recovery",
                render=_render_item("paragraph", continuation, [], {}),
                confidence=min(float(visual.get("confidence", 0.98)), 0.9),
                flags={"recovered-body"},
            )
            _merge_elements(previous, recovered, "cross-page-caption-recovery")
            audit = {
                "page": current_page["page"],
                "visual_block_id": visual.get("id"),
                "paragraph_block_id": previous.get("id"),
                "text": continuation,
                "caption_font_size": round(caption_size, 3),
                "body_font_size": round(continuation_size, 3),
                "reason": "cross-page-body-in-caption",
            }
            visual["caption_recoveries"] = [audit]
            recoveries.append(audit)
            break
    return recoveries


def _span_inside_box(span: Mapping[str, Any], box: Sequence[float]) -> bool:
    span_box = _bbox(span.get("bbox"))
    target_box = _bbox(box)
    if not span_box or not target_box:
        return False
    center_x = _center_x(span_box)
    center_y = _center_y(span_box)
    return (
        target_box[0] - 2.0 <= center_x <= target_box[2] + 2.0
        and target_box[1] - 2.0 <= center_y <= target_box[3] + 2.0
    )


def _render_text_piece_slots(render: Dict[str, Any]) -> List[Dict[str, Any]]:
    content = render.get("content")
    if not isinstance(content, dict):
        return []
    keys = {
        "title_content", "paragraph_content", "list_content", "list_items",
        "item_content", "image_caption", "table_caption", "content", "text",
    }
    slots: List[Dict[str, Any]] = []

    def visit(value: Any, parent: Optional[Any] = None, slot: Optional[Any] = None) -> None:
        if isinstance(value, dict):
            if value.get("type") == "equation_inline":
                return
            if value.get("type") == "text" and isinstance(value.get("content"), str):
                slots.append({"mode": "existing", "target": value, "content": value["content"]})
                return
            for key in list(value):
                if key in keys:
                    visit(value[key], value, key)
        elif isinstance(value, list):
            for index, item in enumerate(list(value)):
                if isinstance(item, str):
                    slots.append({"mode": "list", "target": value, "slot": index, "content": item})
                else:
                    visit(item, value, index)
        elif isinstance(value, str) and isinstance(parent, dict) and slot in keys:
            slots.append({"mode": "dict", "target": parent, "slot": slot, "content": value})

    visit(content)
    return slots


def _plan_render_emphasis(
    element: Mapping[str, Any],
    ranges: Sequence[Mapping[str, Any]],
    normalized: str,
    offsets: Sequence[int],
    budget: _EmphasisBudget,
) -> Optional[List[Dict[str, Any]]]:
    render = element.get("render") if isinstance(element.get("render"), dict) else {}
    slots = _render_text_piece_slots(render)
    text = str(element.get("text") or "")
    cursor = 0
    range_cursor = 0
    plans: List[Dict[str, Any]] = []
    for slot in slots:
        value = str(slot.get("content") or "")
        stripped = value.strip()
        if not stripped:
            continue
        if stripped == text:
            located = (0, len(text))
        else:
            target, _ = _normalized_text_with_offsets(stripped)
            if not budget.checkpoint(1):
                return None
            located = _find_prepared_text_range(normalized, offsets, target, cursor)
            if located is None:
                if not budget.checkpoint(1):
                    return None
                located = _find_prepared_text_range(normalized, offsets, target)
        if located is None:
            continue
        global_start, global_end = located
        leading = len(value) - len(value.lstrip())
        local_ranges: List[Dict[str, Any]] = []
        while range_cursor < len(ranges) and int(ranges[range_cursor]["end"]) <= global_start:
            range_cursor += 1
        range_index = range_cursor
        while range_index < len(ranges) and int(ranges[range_index]["start"]) < global_end:
            if not budget.checkpoint(1):
                return None
            emphasis = ranges[range_index]
            start = max(global_start, int(emphasis["start"]))
            end = min(global_end, int(emphasis["end"]))
            if start < end:
                local_ranges.append({
                    "start": leading + start - global_start,
                    "end": leading + end - global_start,
                    "style": str(emphasis.get("style") or ""),
                    "source": str(emphasis.get("source") or ""),
                })
                if emphasis.get("style") == "color" and emphasis.get("tone") in PDF_TEXT_TONES:
                    local_ranges[-1]["tone"] = str(emphasis["tone"])
            range_index += 1
        if local_ranges:
            plans.append({"slot": slot, "emphasis": local_ranges})
        cursor = global_end
    return plans


def _commit_render_emphasis(plans: Sequence[Mapping[str, Any]]) -> None:
    for plan in plans:
        slot = plan["slot"]
        piece = {
            "type": "text",
            "content": str(slot.get("content") or ""),
            "emphasis": list(plan["emphasis"]),
        }
        mode = slot.get("mode")
        if mode == "existing":
            slot["target"]["emphasis"] = piece["emphasis"]
        elif mode == "list":
            slot["target"][slot["slot"]] = piece
        elif mode == "dict":
            slot["target"][slot["slot"]] = [piece]


def _apply_pdf_emphasis(
    pages: List[Dict[str, Any]],
    pdf_pages: Sequence[Mapping[str, Any]],
    span_indexes: Sequence[Mapping[str, Any]],
    budget: _EmphasisBudget,
) -> bool:
    if len(pdf_pages) < len(pages) or len(span_indexes) < len(pages) or budget.exceeded:
        return False
    ir_pages = {int(page["page"]): page for page in pages}
    pending: List[Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]]]] = []
    for page in pages:
        for element in page["elements"]:
            if element.get("type") not in TRANSLATABLE_TYPES or not element.get("text"):
                continue
            text = str(element["text"])
            budget.text_chars += len(text)
            if budget.text_chars > PDF_EMPHASIS_MAX_TEXT_CHARS:
                return budget.fail("text-budget")
            if not budget.checkpoint():
                return False
            candidates: List[Tuple[int, int, Mapping[str, Any], str, Optional[str]]] = []
            seen_candidates = set()
            fragments = element.get("fragments") if isinstance(element.get("fragments"), list) else []
            for fragment in fragments or [{"page": element["page"], "bbox": element.get("bbox", [])}]:
                try:
                    fragment_page = int(fragment.get("page") or element["page"])
                except (TypeError, ValueError):
                    continue
                if fragment_page not in ir_pages or fragment_page > len(pdf_pages):
                    continue
                box = _pdf_bbox(fragment.get("bbox") or [], ir_pages[fragment_page], pdf_pages[fragment_page - 1])
                if not box:
                    continue
                span_index = span_indexes[fragment_page - 1]
                ys = span_index.get("ys", [])
                entries = span_index.get("entries", [])
                nearby_box = (
                    [box[0] - 24.0, box[1] - 90.0, box[2] + 24.0, box[3] + 90.0]
                    if element.get("type") in {"image", "table"}
                    else box
                )
                lower = bisect_left(ys, nearby_box[1] - 2.0)
                upper = bisect_right(ys, nearby_box[3] + 2.0)
                for entry in entries[lower:upper]:
                    if not budget.checkpoint(1):
                        return False
                    span = entry.get("span") if isinstance(entry.get("span"), Mapping) else {}
                    key = (fragment_page, int(entry.get("ordinal", 0)))
                    tone = _pdf_text_tone(span)
                    inside = _span_inside_box(span, box)
                    if not inside and tone and element.get("type") in {"image", "table"}:
                        inside = _span_inside_box(span, nearby_box)
                    if key in seen_candidates or not (span.get("bold") or tone) or not inside:
                        continue
                    seen_candidates.add(key)
                    candidates.append((fragment_page, key[1], span, str(entry.get("compact") or ""), tone))
            candidates.sort(key=lambda item: (item[0], item[1]))
            normalized, offsets = _normalized_text_with_offsets(text)
            compact, compact_offsets = _compact_text_with_offsets(text)
            if not budget.checkpoint():
                return False
            ranges: List[Dict[str, Any]] = []
            cursor = 0
            for _, _, span, target, tone in candidates:
                if not budget.checkpoint(1):
                    return False
                matched = _find_emphasis_text_range(compact, compact_offsets, target, cursor)
                if matched is None:
                    continue
                start, end = matched
                if span.get("bold"):
                    ranges.append({
                        "start": start,
                        "end": end,
                        "style": "bold",
                        "text": text[start:end],
                        "source": "pdf-font",
                        "font": str(span.get("font") or ""),
                    })
                if tone in PDF_TEXT_TONES:
                    ranges.append({
                        "start": start,
                        "end": end,
                        "style": "color",
                        "tone": tone,
                        "text": text[start:end],
                        "source": "pdf-text-color",
                    })
                cursor = end
            if not ranges:
                continue
            grouped: Dict[Tuple[str, str, str], List[Dict[str, Any]]] = defaultdict(list)
            for emphasis in ranges:
                key = (
                    str(emphasis.get("style") or ""),
                    str(emphasis.get("tone") or ""),
                    str(emphasis.get("source") or ""),
                )
                grouped[key].append(dict(emphasis))
            merged: List[Dict[str, Any]] = []
            for bucket in grouped.values():
                combined: List[Dict[str, Any]] = []
                for emphasis in sorted(bucket, key=lambda item: (int(item["start"]), int(item["end"]))):
                    if combined and int(emphasis["start"]) <= int(combined[-1]["end"]):
                        combined[-1]["end"] = max(int(combined[-1]["end"]), int(emphasis["end"]))
                        combined[-1]["text"] = text[int(combined[-1]["start"]):int(combined[-1]["end"])]
                    else:
                        combined.append(emphasis)
                merged.extend(combined)
            merged.sort(key=lambda item: (
                int(item["start"]),
                0 if item.get("style") == "bold" else 1,
                int(item["end"]),
            ))
            render_plans = _plan_render_emphasis(element, merged, normalized, offsets, budget)
            if render_plans is None:
                return False
            pending.append((element, merged, render_plans))
    if not budget.checkpoint():
        return False
    for element, ranges, render_plans in pending:
        element["emphasis"] = ranges
        _commit_render_emphasis(render_plans)
    return True


def _merge_continuations(pages: List[Dict[str, Any]]) -> None:
    for page in pages:
        elements = page["elements"]
        left = [item for item in elements if item.get("column") == 1 and item["type"] == "paragraph"]
        right = [item for item in elements if item.get("column") == 2 and item["type"] == "paragraph"]
        if left and right and _continues(left[-1], right[0]):
            _merge_elements(left[-1], right[0], "cross-column")
            elements.remove(right[0])
    for previous_page, current_page in zip(pages, pages[1:], strict=False):
        previous = next((item for item in reversed(previous_page["elements"]) if item["type"] == "paragraph"), None)
        current = next((item for item in current_page["elements"] if item["type"] == "paragraph"), None)
        if previous and current and _continues(previous, current):
            _merge_elements(previous, current, "cross-page")
            current_page["elements"].remove(current)
    for page in pages:
        for index, item in enumerate(page["elements"], 1):
            item["reading_order"] = index


def _quality(pages: List[Dict[str, Any]], suppressed: List[Dict[str, Any]], backend: str) -> Dict[str, Any]:
    elements = [item for page in pages for item in page["elements"]]
    translatable = [
        item for item in elements
        if item["role"] == "body" and item["type"] in TRANSLATABLE_TYPES and len(item["text"].strip()) >= 2
    ]
    paragraphs = [item for item in translatable if item["type"] in {"paragraph", "list"} and len(item["text"]) >= 20]
    body_text = "\n".join(item["text"] for item in translatable)
    visible_text = SCRIPT_TAG_RE.sub("", body_text)
    visible_characters = sum(1 for char in visible_text if not char.isspace())
    replacement_characters = visible_text.count("\ufffd")
    replacement_ratio = replacement_characters / max(1, visible_characters)
    script_runs = len(SCRIPT_RUN_RE.findall(body_text))
    script_run_ratio = script_runs / max(1, visible_characters)
    sub_open_tags = len(re.findall(r"<sub>", body_text, flags=re.IGNORECASE))
    sub_close_tags = len(re.findall(r"</sub>", body_text, flags=re.IGNORECASE))
    sup_open_tags = len(re.findall(r"<sup>", body_text, flags=re.IGNORECASE))
    sup_close_tags = len(re.findall(r"</sup>", body_text, flags=re.IGNORECASE))
    script_open_tags = sub_open_tags + sup_open_tags
    script_close_tags = sub_close_tags + sup_close_tags

    issues: List[str] = []
    hard_failures: List[str] = []
    if not translatable:
        issues.append("no-translatable-blocks")
        hard_failures.append("no-translatable-blocks")
    if len(paragraphs) < max(2, len(pages) // 2):
        issues.append("insufficient-body-paragraphs")
    empty_pages = [page["page"] for page in pages if not any(item["role"] == "body" for item in page["elements"])]
    if empty_pages:
        issues.append("empty-semantic-pages")
    if sub_open_tags != sub_close_tags or sup_open_tags != sup_close_tags:
        issues.append("unbalanced-script-markup")
        hard_failures.append("unbalanced-script-markup")
    if script_runs >= 12 and script_run_ratio >= 0.015:
        issues.append("pathological-script-markup")
        hard_failures.append("pathological-script-markup")
    elif script_runs >= 8 and script_run_ratio >= 0.005:
        issues.append("suspicious-script-markup")
    if replacement_characters:
        issues.append("replacement-characters")
        if replacement_characters >= 8 or replacement_ratio >= 0.0005:
            hard_failures.append("replacement-characters")
    confidence = sum(float(item["confidence"]) for item in elements) / max(1, len(elements))
    if hard_failures:
        status = "FAIL"
    elif issues:
        status = "REVIEW"
    else:
        status = "PASS"
    return {
        "status": status,
        "backend": backend,
        "confidence": round(confidence, 4),
        "translatable_blocks": len(translatable),
        "body_paragraphs": len(paragraphs),
        "empty_pages": empty_pages,
        "suppressed_elements": len(suppressed),
        "issues": issues,
        "hard_failures": hard_failures,
        "text_quality": {
            "visible_characters": visible_characters,
            "replacement_characters": replacement_characters,
            "replacement_ratio": round(replacement_ratio, 6),
            "script_runs": script_runs,
            "script_run_ratio": round(script_run_ratio, 6),
            "script_open_tags": script_open_tags,
            "script_close_tags": script_close_tags,
        },
    }


# A running header or preprint watermark repeats on page after page at the
# same edge. MinerU labels most of them page_header but misses some, and the
# missed ones land in the reading text, so repetition is the backstop.
MINERU_EDGE_REPEAT_MIN_PAGES = 3


LINE_NUMBER_GUTTER_RE = re.compile(r"^\s*\d{1,4}\s+(?=\S)")


def _text_slots(value: Any) -> Iterator[Tuple[Any, Any]]:
    """Yield every mutable text leaf in a render payload, in document order."""
    if isinstance(value, dict):
        for key in (
            "title_content", "paragraph_content", "list_content", "list_items",
            "item_content", "content", "text",
        ):
            if key in value:
                inner = value[key]
                if isinstance(inner, str):
                    yield value, key
                else:
                    yield from _text_slots(inner)
                return
    elif isinstance(value, list):
        for item in value:
            yield from _text_slots(item)


def _strip_gutter_number_from_render(render: Dict[str, Any]) -> None:
    """Drop a leading line number from a render payload's first text.

    The IR's own ``text`` is rebuilt separately; the HTML is assembled from
    this payload, so both have to lose the number.
    """
    for container, key in _text_slots(render.get("content")):
        if str(container[key]).strip():
            container[key] = LINE_NUMBER_GUTTER_RE.sub("", str(container[key]), count=1)
            return


def _line_number_gutter(items: List[Dict[str, Any]], page_width: float, page_height: float) -> Optional[float]:
    """Return the right edge of a LaTeX ``lineno`` gutter, when the page has one.

    The gutter is a tall, very narrow strip; MinerU reports it as
    ``page_aside_text``. Body blocks that start left of its right edge pick up
    the line number as leading text.
    """
    for item in items:
        if not isinstance(item, dict) or str(item.get("type") or "").strip() != "page_aside_text":
            continue
        box = _bbox(item.get("bbox"))
        if not box:
            continue
        if _width(box) <= page_width * 0.05 and _height(box) >= page_height * 0.5:
            return float(box[2])
    return None


def _mineru_edge_repeats(pages: List[List[Dict[str, Any]]]) -> Counter:
    """Count how many pages carry each edge-anchored text, normalised."""
    keys: Counter = Counter()
    seen: set[Tuple[int, str]] = set()
    for page_index, items in enumerate(pages, 1):
        boxes = [_bbox(item.get("bbox")) for item in items if isinstance(item, dict) and _bbox(item.get("bbox"))]
        if not boxes:
            continue
        height = max(box[3] for box in boxes)
        for item in items:
            if not isinstance(item, dict):
                continue
            box = _bbox(item.get("bbox"))
            text = _flatten_text(item.get("content"))
            if not box or not text or not height:
                continue
            if _is_edge_banner(box, height):
                key = _edge_key(text)
                if key and (page_index, key) not in seen:
                    keys[key] += 1
                    seen.add((page_index, key))
    return keys


def _is_edge_banner(box: Sequence[float], page_height: float) -> bool:
    """A short strip pinned to the top or bottom margin.

    The height bound matters as much as the position: a body block running to
    the foot of the page also touches the bottom margin.
    """
    if not page_height or _height(box) > page_height * 0.08:
        return False
    return box[1] <= page_height * 0.075 or box[3] >= page_height * 0.94


def mineru_to_ir(
    pages: List[List[Dict[str, Any]]],
    *,
    backend: str,
    pdf_path: Optional[Path] = None,
    pdf_pages_override: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    emphasis_budget = _new_emphasis_budget()
    drawing_pages = _marker_drawing_pages(pages)
    pdf_pages = (
        _extract_pdf_text_pages(pdf_path, budget=emphasis_budget, drawing_pages=drawing_pages)
        if pdf_pages_override is None
        else list(pdf_pages_override)
    )
    ir_pages: List[Dict[str, Any]] = []
    suppressed: List[Dict[str, Any]] = []
    edge_repeats = _mineru_edge_repeats(pages)
    for page_index, items in enumerate(pages, 1):
        elements: List[Dict[str, Any]] = []
        max_x = max((_bbox(item.get("bbox"))[2] for item in items if isinstance(item, dict) and _bbox(item.get("bbox"))), default=1000.0)
        max_y = max((_bbox(item.get("bbox"))[3] for item in items if isinstance(item, dict) and _bbox(item.get("bbox"))), default=1000.0)
        gutter_right = _line_number_gutter(items, max_x, max_y)
        for source_index, raw in enumerate(items):
            if not isinstance(raw, dict):
                continue
            raw_kind = str(raw.get("type") or "").strip()
            box = _bbox(raw.get("bbox"))
            text = _flatten_text(raw.get("content"))
            if (
                gutter_right is not None
                and box
                and raw_kind in {"title", "text", "paragraph", "list"}
                and box[0] <= gutter_right
            ):
                text = LINE_NUMBER_GUTTER_RE.sub("", text, count=1)
                strip_gutter = True
            else:
                strip_gutter = False
            recovered_body = raw_kind == "page_footnote" and _recoverable_mineru_footnote(text, box, max_y)
            kind = "image" if raw_kind == "chart" else ("paragraph" if recovered_body else raw_kind)
            role = "furniture" if raw_kind in FURNITURE_TYPES and not recovered_body else "body"
            if (
                role == "body"
                and raw_kind != "chart"
                and box
                and _is_edge_banner(box, max_y)
                and edge_repeats.get(_edge_key(text), 0) >= MINERU_EDGE_REPEAT_MIN_PAGES
            ):
                role = "furniture"
            source_id = str(source_index)
            render = copy.deepcopy(raw)
            if strip_gutter:
                _strip_gutter_number_from_render(render)
            element_flags = {"recovered-body"} if recovered_body else set()
            if raw_kind == "chart":
                content = render.get("content") if isinstance(render.get("content"), dict) else {}
                caption, prefix_trimmed = _trim_chart_caption_prefix(content.get("chart_caption", []))
                render["type"] = "image"
                render["content"] = {
                    "image_source": content.get("image_source", {}),
                    "image_caption": caption,
                    "image_footnote": content.get("chart_footnote", []),
                }
                text = _flatten_text(render["content"])
                if prefix_trimmed:
                    element_flags.add("chart-caption-prefix-trimmed")
            elif recovered_body:
                render = {"type": "paragraph", "bbox": box, "content": {"paragraph_content": text}}
            element = _canonical_element(
                page=page_index, source_id=source_id, source_index=source_index, kind=kind,
                box=box, text=text, source="mineru", render=render,
                confidence=float(raw.get("score", 0.98) or 0.98), role=role,
                flags=element_flags,
            )
            element["column"] = 0
            if role == "furniture":
                suppressed.append({"id": element["id"], "page": page_index, "type": kind, "bbox": box, "text": text, "reason": "furniture"})
                continue
            if kind in {"title", "paragraph", "list"} and not text:
                suppressed.append({"id": element["id"], "page": page_index, "type": kind, "bbox": box, "text": "", "reason": "empty-text"})
                continue
            elements.append(element)
        elements, composite_suppressed = _merge_mineru_figure_fragments(elements, max_x, max_y)
        suppressed.extend(composite_suppressed)
        if page_index == 1:
            elements = _order_first_page(elements, max_x)
        else:
            for order, element in enumerate(elements, 1):
                element["reading_order"] = order
        ir_pages.append({"page": page_index, "width": max_x, "height": max_y, "coordinate_origin": "top-left", "elements": elements})
    span_indexes = _prepare_pdf_span_indexes(ir_pages, pdf_pages, emphasis_budget)
    inline_marker_recoveries = _recover_caption_inline_markers(
        ir_pages, pdf_pages, span_indexes, emphasis_budget
    ) if span_indexes is not None and not emphasis_budget.exceeded else []
    inline_citation_recoveries = _recover_pdf_inline_citations(
        ir_pages, pdf_pages, emphasis_budget
    ) if span_indexes is not None and not emphasis_budget.exceeded else []
    recoveries = _recover_caption_continuations(
        ir_pages, pdf_pages, span_indexes, emphasis_budget
    ) if span_indexes is not None and not emphasis_budget.exceeded else []
    _merge_continuations(ir_pages)
    if span_indexes is not None and not emphasis_budget.exceeded:
        _apply_pdf_emphasis(ir_pages, pdf_pages, span_indexes, emphasis_budget)
    quality = _quality(ir_pages, suppressed, backend)
    return {
        "ir_version": IR_VERSION,
        "backend": backend,
        "pages": ir_pages,
        "suppressed": suppressed,
        "recoveries": recoveries,
        "inline_marker_recoveries": inline_marker_recoveries,
        "inline_citation_recoveries": inline_citation_recoveries,
        "quality": quality,
    }


def _merge_pdf_evidence_page_sizes(
    sizes: Sequence[Tuple[float, float]],
    pdf_pages: Sequence[Mapping[str, Any]],
    page_count: int,
) -> List[Tuple[float, float]]:
    """Use bounded PDF evidence dimensions when the normal PDF reader is absent."""
    merged = list(sizes[:page_count])
    while len(merged) < page_count:
        merged.append((612.0, 792.0))
    for index, pdf_page in enumerate(pdf_pages[:page_count]):
        if not isinstance(pdf_page, Mapping):
            continue
        try:
            width = float(pdf_page.get("width") or 0.0)
            height = float(pdf_page.get("height") or 0.0)
        except (TypeError, ValueError):
            continue
        if math.isfinite(width) and math.isfinite(height) and width > 0.0 and height > 0.0:
            merged[index] = (width, height)
    return merged


def odl_to_ir(
    raw_json: Mapping[str, Any],
    page_sizes: Sequence[Tuple[float, float]],
    *,
    pdf_pages_override: Optional[Sequence[Mapping[str, Any]]] = None,
) -> Dict[str, Any]:
    page_count = max(1, int(raw_json.get("number of pages") or len(page_sizes) or 1))
    sizes = list(page_sizes)
    while len(sizes) < page_count:
        sizes.append((612.0, 792.0))
    pdf_pages = list(pdf_pages_override) if pdf_pages_override is not None else []
    if pdf_pages:
        sizes = _merge_pdf_evidence_page_sizes(sizes, pdf_pages, page_count)
    raw_pages: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for item in raw_json.get("kids", []) if isinstance(raw_json.get("kids"), list) else []:
        if not isinstance(item, dict):
            continue
        try:
            page = max(1, min(page_count, int(item.get("page number") or 1)))
        except (TypeError, ValueError):
            page = 1
        raw_pages[page].append(item)
    repeats = _edge_occurrences(raw_pages, sizes)
    ir_pages: List[Dict[str, Any]] = []
    suppressed: List[Dict[str, Any]] = []
    type_map = {"heading": "title", "paragraph": "paragraph", "list": "list", "image": "image", "table": "table", "formula": "equation_interline"}
    for page in range(1, page_count + 1):
        width, height = sizes[page - 1]
        elements: List[Dict[str, Any]] = []
        for source_index, raw in enumerate(_expand_odl_items(raw_pages.get(page, []))):
            raw_type = str(raw.get("type") or "").lower().strip()
            kind = type_map.get(raw_type)
            if not kind:
                continue
            box = _odl_bbox(raw.get("bounding box"), height)
            if not box:
                continue
            text = _flatten_text(raw)
            source_id = _safe_source_id(raw.get("id"), source_index)
            render = _render_item(kind, text, box, raw)
            element = _canonical_element(
                page=page, source_id=source_id, source_index=source_index, kind=kind,
                box=box, text=text, source="opendataloader", render=render,
                confidence=0.84 if kind in {"title", "paragraph", "list"} else 0.72,
            )
            if _is_furniture(element, height, repeats):
                suppressed.append({"id": element["id"], "page": page, "type": kind, "bbox": box, "text": text, "reason": "furniture"})
                continue
            try:
                small_bottom_note = float(raw.get("font size") or 0) <= 7.2 and box[1] >= height * 0.78
            except (TypeError, ValueError):
                small_bottom_note = False
            if small_bottom_note:
                suppressed.append({"id": element["id"], "page": page, "type": kind, "bbox": box, "text": text, "reason": "footnote"})
                continue
            if kind == "table" and (_width(box) * _height(box) < width * height * 0.012 or (not text and _width(box) < width * 0.25)):
                suppressed.append({"id": element["id"], "page": page, "type": kind, "bbox": box, "text": text, "reason": "table-fragment"})
                continue
            elements.append(element)
        elements, figure_suppressed = _caption_figures(elements, width, height)
        suppressed.extend(figure_suppressed)
        ordered = _order_first_page(elements, width) if page == 1 else _order_page(elements, width)
        ir_pages.append({"page": page, "width": width, "height": height, "coordinate_origin": "top-left", "elements": ordered})
    _merge_continuations(ir_pages)
    if pdf_pages:
        emphasis_budget = _new_emphasis_budget()
        span_indexes = _prepare_pdf_span_indexes(ir_pages, pdf_pages, emphasis_budget)
        if span_indexes is not None and not emphasis_budget.exceeded:
            _apply_pdf_emphasis(ir_pages, pdf_pages, span_indexes, emphasis_budget)
    quality = _quality(ir_pages, suppressed, "opendataloader")
    return {"ir_version": IR_VERSION, "backend": "opendataloader", "pages": ir_pages, "suppressed": suppressed, "quality": quality}


def render_pages(ir: Mapping[str, Any]) -> List[List[Dict[str, Any]]]:
    pages: List[List[Dict[str, Any]]] = []
    for page in ir.get("pages", []) if isinstance(ir.get("pages"), list) else []:
        values: List[Dict[str, Any]] = []
        elements = sorted(page.get("elements", []), key=lambda item: int(item.get("reading_order", 0)))
        for element in elements:
            render = copy.deepcopy(element.get("render") or {})
            render["_ir"] = {
                "block_id": element.get("id"),
                "reading_order": element.get("reading_order"),
                "confidence": element.get("confidence"),
                "source": element.get("source"),
                "source_id": element.get("source_id"),
                "role": element.get("role", "body"),
                "column": element.get("column", 0),
                "flags": element.get("flags", []),
                "fragments": element.get("fragments", []),
            }
            if element.get("emphasis"):
                render["_ir"]["emphasis"] = copy.deepcopy(element["emphasis"])
            if element.get("caption_recoveries"):
                render["_ir"]["caption_recoveries"] = copy.deepcopy(element["caption_recoveries"])
            if element.get("inline_marker_recoveries"):
                render["_ir"]["inline_marker_recoveries"] = copy.deepcopy(element["inline_marker_recoveries"])
            if element.get("inline_citation_recoveries"):
                render["_ir"]["inline_citation_recoveries"] = copy.deepcopy(element["inline_citation_recoveries"])
            if element.get("section_role"):
                render["_ir"]["section_role"] = element["section_role"]
            values.append(render)
        pages.append(values)
    return pages


def serializable_ir(ir: Mapping[str, Any]) -> Dict[str, Any]:
    output = copy.deepcopy(dict(ir))
    for page in output.get("pages", []):
        for element in page.get("elements", []):
            element.pop("render", None)
    return output


def pdf_page_sizes(pdf_path: Path, page_count: int) -> List[Tuple[float, float]]:
    try:
        fitz = load_fitz()

        with fitz.open(pdf_path) as document:
            return [(float(page.rect.width), float(page.rect.height)) for page in document]
    except Exception:
        return [(612.0, 792.0) for _ in range(max(1, page_count))]


def source_fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]
