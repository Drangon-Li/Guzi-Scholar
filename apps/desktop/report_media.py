"""Collect source visuals that a report can link to in a specific render."""

from __future__ import annotations

from base64 import b64encode
from collections import Counter, defaultdict
from html import unescape
from pathlib import Path
import re
from struct import unpack

from ai_context import MAX_SOURCE_IMAGE_BYTES
from pymupdf_runtime import load_fitz


_KINDS = {"image": "figure", "figure": "figure", "table": "table", "equation_interline": "equation", "formula": "equation", "equation": "equation"}
_ASSET_PATH = re.compile(r"assets/images/([a-z0-9_@-][a-z0-9._@-]*\.(?:png|jpe?g|webp|gif))", re.I)
_NUMBER = r"[A-Z]?\d+(?:\.\d+)*[a-z]?"
_CAPTION_NUMBER = re.compile(rf"^\s*(?P<label>fig(?:ure)?\.?|tab(?:le)?\.?|[图圖表])\s*(?P<number>{_NUMBER})(?!\w|\.\d)", re.I | re.ASCII)
_GROUP_NUMBER = re.compile(rf"(?:fig|table)-(?P<number>{_NUMBER})(?:-part-\d+)?", re.I)
_CAPTION_TYPES = {"caption", "figcaption", "figure_caption", "figure_title", "image_caption", "table_caption", "table_title"}
_OVERVIEW_PATTERNS = (
    re.compile(r"\b(?:overview of|overview diagram|overall (?:architecture|framework|workflow|pipeline)|system architecture|schematic(?: diagram)? of)\b|整体(?:架构|流程|框架)|总体(?:架构|流程|框架)|架构图|流程图|方法概览|系统概览", re.I),
    re.compile(r"\b(?:overview|architecture|workflows?|schematic|flow\s?chart)\b|概览|總覽|架构|架構|工作流程|示意图|示意圖", re.I),
    re.compile(r"\b(?:framework|pipeline|method diagram|system design)\b|框架|技术路线", re.I),
)
_MAX_SOURCE_BYTES = 12 * 1024 * 1024
_MAX_SOURCE_PIXELS = 16_000_000
_MAX_VISION_SIDE = 2000
_PNG_IHDR = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"


def _block_id(element: dict) -> str:
    value = element.get("block_id") or element.get("id")
    return value if isinstance(value, str) else ""


def _attribute(fragment: str, name: str) -> str:
    start_tag = fragment.lstrip().partition(">")[0]
    match = re.search(rf'''\s{re.escape(name)}\s*=\s*(["'])(.*?)\1''', start_tag)
    return unescape(match[2]) if match else ""


def _plain(value) -> str:
    return " ".join(unescape(re.sub(r"<[^>]+>", "", value)).split()) if isinstance(value, str) else ""


def _caption_number(caption: str) -> tuple[str, str] | None:
    match = _CAPTION_NUMBER.match(caption)
    if not match:
        return None
    kind = "table" if match["label"].lower().startswith(("tab", "表")) else "figure"
    return kind, match["number"].lower()


def _raster_asset(asset_dir: Path, value) -> str | None:
    match = _ASSET_PATH.fullmatch(value) if isinstance(value, str) else None
    if not match:
        return None
    path = asset_dir / match[1]
    try:
        if path.resolve() != path or not path.is_file():
            return None
        with path.open("rb") as handle:
            header = handle.read(12)
    except (OSError, RuntimeError):
        return None
    suffix = path.suffix.lower()
    if (
        suffix == ".png" and header.startswith(b"\x89PNG\r\n\x1a\n")
        or suffix in {".jpg", ".jpeg"} and header.startswith(b"\xff\xd8\xff")
        or suffix == ".gif" and header.startswith((b"GIF87a", b"GIF89a"))
        or suffix == ".webp" and header.startswith(b"RIFF") and header[8:12] == b"WEBP"
    ):
        return "assets/images/" + match[1]
    return None


def _source_asset(asset_dir: Path, element: dict, audit: dict) -> str | None:
    if element.get("visual_source") == "source-unavailable":
        return None
    for candidate in (element.get("visual_asset"), element.get("image_path"), element.get("source_asset"), audit.get("source_asset")):
        asset = _raster_asset(asset_dir, candidate)
        if asset:
            return asset
    # The layout pipeline copies an equation's original sidecar into this directory.
    source = element.get("image_source")
    if isinstance(source, str) and re.fullmatch(r"(?:images/)?[A-Za-z0-9._@-]+", source):
        return _raster_asset(asset_dir, "assets/images/" + source.rsplit("/", 1)[-1])
    return None


def _tex(value) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if (value.startswith("$$") and value.endswith("$$")) or (value.startswith(r"\[") and value.endswith(r"\]")):
        value = value[2:-2].strip()
    return value


def _equations(element: dict, asset: str | None, audit: dict):
    if (
        element.get("render_mode") in ("source-crop", "source-block-crop")
        or audit.get("source_crop_required") or audit.get("status") == "unresolved"
    ):
        if asset:
            yield 1, {"asset": asset}
        return
    equations = element.get("equations")
    if isinstance(equations, list):
        entries = [(ordinal, _tex(entry.get("tex"))) for ordinal, entry in enumerate(equations, 1) if isinstance(entry, dict)]
        if any(tex for _, tex in entries):
            for ordinal, tex in entries:
                if tex:
                    yield ordinal, {"tex": tex, **({"asset": asset} if asset and len(equations) == 1 else {})}
            return
    if audit.get("status") == "confirmed" and (audit.get("render_status") == "mathml" or element.get("render_mode") == "mathml"):
        tex = _tex(element.get("content"))
        if tex:
            yield 1, {"tex": tex, **({"asset": asset} if asset else {})}
            return
    if asset:
        yield 1, {"asset": asset}


def collect_report_media(root: Path, pages: list, generation: str) -> dict[str, dict]:
    asset_dir = root.resolve() / "assets" / "images"
    records = []
    for page in pages:
        if not isinstance(page, dict) or type(page.get("page")) is not int or page["page"] < 1 or not isinstance(page.get("elements"), list):
            continue
        references = page.get("section_kind") == "references"
        records.extend(
            (page["page"], element) for element in page["elements"]
            if isinstance(element, dict) and _block_id(element) and element.get("reference_section", references) is not True
        )
    counts = Counter(_block_id(element) for _, element in records)
    components = set()
    captions_by_block = {}
    captions_by_anchor = defaultdict(list)
    captions_by_number = defaultdict(list)
    for page, element in records:
        block_id = _block_id(element)
        for key in ("figure_group", "table_group"):
            group = element.get(key)
            if isinstance(group, dict) and isinstance(group.get("component_block_ids"), list):
                components.update(child for child in group["component_block_ids"] if isinstance(child, str) and child != block_id)
        if counts[block_id] != 1:
            continue
        caption = _plain(element.get("text") or element.get("caption") or element.get("content"))
        if not caption:
            continue
        captions_by_block[block_id] = caption
        fragment = element.get("html") if isinstance(element.get("html"), str) else ""
        html_id = _attribute(fragment, "id")
        caption_type = (element.get(field) for field in ("type", "kind", "label", "native_label"))
        if html_id.startswith("caption-") or _attribute(fragment, "data-reader-toc-excluded") == "caption" or any(label in _CAPTION_TYPES for label in caption_type if isinstance(label, str)):
            for anchor in {key for key in (html_id, element.get("anchor"), element.get("anchor_group")) if isinstance(key, str) and key}:
                captions_by_anchor[anchor].append((page, caption))
            if number := _caption_number(caption):
                captions_by_number[(page, *number)].append(caption)

    media = {}
    for page, element in records:
        block_id = _block_id(element)
        label = element.get("type") or element.get("kind")
        kind = _KINDS.get(label) if isinstance(label, str) else None
        if not kind or counts[block_id] != 1 or block_id in components:
            continue
        if (
            element.get("render_mode") in ("figure-component", "table-component", "suppressed-margin")
            or element.get("parent_figure_block_id") or element.get("parent_table_block_id")
            or any(element.get(field) in ("logo", "icon", "decoration") for field in ("role", "label", "native_label"))
        ):
            continue
        audit = element.get("math_audit") if isinstance(element.get("math_audit"), dict) else {}
        asset = _source_asset(asset_dir, element, audit)
        common = {"block_id": block_id, "page": page, "render_generation": generation, "kind": kind, "caption": _plain(element.get("caption"))}
        if kind == "equation":
            for ordinal, values in _equations(element, asset, audit):
                media_id = f"equation:{block_id}:{ordinal}"
                media[media_id] = {"id": media_id, **common, **values}
            continue
        if not asset:
            continue
        fragment = element.get("html") if isinstance(element.get("html"), str) else ""
        group = element.get(f"{kind}_group")
        group = group if isinstance(group, dict) else {}
        caption_id = group.get("caption_block_id") or element.get("caption_block_id")
        caption = common["caption"]
        if not caption and isinstance(caption_id, str):
            caption = captions_by_block.get(caption_id, "")
        anchor = element.get("anchor_group") or group.get("anchor") or element.get("anchor")
        caption_anchor = _attribute(fragment, "data-caption-id") or element.get("caption_anchor")
        if not caption:
            for key in (caption_anchor, f"caption-{anchor}" if isinstance(anchor, str) else None, anchor):
                if not isinstance(key, str) or not key:
                    continue
                candidates = captions_by_anchor.get(key, [])
                local = [value for caption_page, value in candidates if caption_page == page]
                if len(local) == 1:
                    caption = local[0]
                elif not local and len(candidates) == 1:
                    caption = candidates[0][1]
                if caption:
                    break
        if not caption:
            embedded = re.search(r"<figcaption\b[^>]*>(.*?)</figcaption\s*>", fragment, re.I | re.S)
            caption = _plain(embedded[1]) if embedded else ""
        if not caption:
            match = _GROUP_NUMBER.fullmatch(anchor) if isinstance(anchor, str) else None
            if match:
                local = captions_by_number.get((page, kind, match["number"].lower()), [])
                if len(local) == 1:
                    caption = local[0]
        media_id = f"{kind}:{block_id}"
        media[media_id] = {"id": media_id, **common, "caption": caption, "asset": asset}
    return media


def overview_figure(media: dict[str, dict], *, numbered_fallback: bool = True) -> str | None:
    ranked = []
    fallback = None
    for order, (media_id, item) in enumerate(media.items()):
        if item["kind"] != "figure":
            continue
        caption = item["caption"]
        if fallback is None and _caption_number(caption):
            fallback = media_id
        for rank, pattern in enumerate(_OVERVIEW_PATTERNS):
            if match := pattern.search(caption[:200]):
                ranked.append((rank, match.start(), order, media_id))
                break
    return min(ranked)[-1] if ranked else fallback if numbered_fallback else None


def report_image_data_url(root: Path, item: dict) -> str | None:
    root = root.resolve()
    asset_dir = root / "assets" / "images"
    asset = _raster_asset(asset_dir, item.get("asset"))
    if not asset:
        return None
    path = root / asset
    try:
        with path.open("rb") as handle:
            data = handle.read(_MAX_SOURCE_BYTES + 1)
        if not 16 <= len(data) <= _MAX_SOURCE_BYTES:
            return None
        extension = path.suffix.lower().removeprefix(".")
        if extension == "jpg":
            extension = "jpeg"
        try:
            fitz = load_fitz()
        except ImportError:
            if extension != "png" or not 45 <= len(data) <= MAX_SOURCE_IMAGE_BYTES or not data.startswith(_PNG_IHDR):
                return None
            width, height = unpack(">II", data[16:24])
            if 0 < min(width, height) and max(width, height) <= 4096 and width * height <= _MAX_SOURCE_PIXELS:
                return "data:image/png;base64," + b64encode(data).decode("ascii")
            return None
        with fitz.open(stream=data, filetype=extension) as document:
            images = document[0].get_image_info() if len(document) == 1 else []
            if len(images) != 1 or not 0 < images[0]["width"] * images[0]["height"] <= _MAX_SOURCE_PIXELS:
                return None
        pixmap = fitz.Pixmap(data)
        side = max(pixmap.width, pixmap.height)
        if side > _MAX_VISION_SIDE or len(data) > MAX_SOURCE_IMAGE_BYTES or extension not in ("png", "jpeg"):
            scale = min(1, _MAX_VISION_SIDE / side)
            if pixmap.colorspace and pixmap.colorspace.n > 3:
                pixmap = fitz.Pixmap(fitz.csRGB, pixmap)
            pixmap = fitz.Pixmap(pixmap, max(1, round(pixmap.width * scale)), max(1, round(pixmap.height * scale)))
            data, extension = pixmap.tobytes("png"), "png"
        if len(data) <= MAX_SOURCE_IMAGE_BYTES:
            return f"data:image/{extension};base64," + b64encode(data).decode("ascii")
    except (ImportError, OSError, RuntimeError, TypeError, ValueError):
        return None
    return None
