"""Export fusion evidence as a self-contained desktop reader package."""
from __future__ import annotations

import argparse
import copy
import hashlib
import html
import io
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import shutil
import zipfile
import unicodedata
from xml.etree import ElementTree

from .bibliography import bibliography_anchors, bibliography_layout, citation_links, is_bibliography_entry, native_reference_duplicates, reference_numbers


def save_json(path, data):
    path = Path(path)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class SafeHTML(HTMLParser):
    allowed = {"strong", "em", "b", "i", "u", "sup", "sub", "br", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "p", "ul", "ol", "li", "span"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.plain = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "iframe"}:
            self.hidden += 1
        elif tag in self.allowed and not self.hidden:
            safe = "".join(f' {key}="{html.escape(value or "", quote=True)}"' for key, value in attrs if key in {"colspan", "rowspan"} and str(value).isdigit())
            self.parts.append(f"<{tag}{safe}>")
            if tag in {"br", "tr", "p", "li"}:
                self.plain.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style", "iframe"}:
            self.hidden = max(0, self.hidden - 1)
        elif tag in self.allowed and not self.hidden:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(html.escape(data))
            self.plain.append(data)


def safe_html(value):
    parser = SafeHTML()
    parser.feed(value)
    return "".join(parser.parts), "".join(parser.plain).strip()


def text_content(value):
    class DOMText(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.values = []
        def handle_data(self, data):
            self.values.append(data)
    parser = DOMText()
    parser.feed(value)
    return "".join(parser.values)


def inline(value):
    # Protect original allowed HTML before interpreting Markdown delimiters.
    tokens = []
    def protect(match):
        tokens.append(match[0])
        return f"GUZIHTMLTOKEN{len(tokens)-1}END"
    value = re.sub(r"</?[A-Za-z][^>]*>", protect, str(value))
    value = html.escape(html.unescape(value))
    for pattern, tag in [(r"\*\*\*(.+?)\*\*\*", "strongem"), (r"\*\*(.+?)\*\*", "strong"), (r"(?<!\*)\*([^*\n]+)\*(?!\*)", "em")]:
        value = re.sub(pattern, lambda m: f"<strong><em>{m[1]}</em></strong>" if tag == "strongem" else f"<{tag}>{m[1]}</{tag}>", value, flags=re.S)
    for index, token in enumerate(tokens):
        value = value.replace(f"GUZIHTMLTOKEN{index}END", token)
    # Parsing the markup also drops all event handlers, links and executable tags.
    return safe_html(value)


GREEK_VARIANTS = {}
for _point in range(0x1D6A8, 0x1D7CC):
    _character = chr(_point)
    _name = unicodedata.name(_character, '')
    for _variant, _prefix in [('sans-serif-bold-italic', 'SANS-SERIF BOLD ITALIC'), ('bold-sans-serif', 'SANS-SERIF BOLD'), ('bold-italic', 'BOLD ITALIC'), ('bold', 'BOLD'), ('italic', 'ITALIC')]:
        if _name.startswith('MATHEMATICAL ' + _prefix + ' '):
            _base = unicodedata.decomposition(_character).split()[-1]
            GREEK_VARIANTS[(_variant, chr(int(_base, 16)))] = _character
            break


def render_math(tex, display=False):
    tex = re.sub(r"^\s*\$\$?|\$\$?\s*$", "", tex).strip()
    if (tex.startswith(r"\[") and tex.endswith(r"\]")) or (tex.startswith(r"\(") and tex.endswith(r"\)")):
        tex = tex[2:-2].strip()
    tex = re.sub(r"\\arg\s*\\(max|min)(?![A-Za-z])", lambda match: "\\arg" + match[1], tex)
    tex = re.sub(r"\\arg(?![A-Za-z])", lambda _match: r"\operatorname{arg}", tex)
    # The converter's single-letter shortcut erases mathrm's font scope.
    # A TeX-ignored group space keeps its normal font conversion path intact.
    tex = re.sub(r"(?<!\\)\\mathrm\{([A-Za-z])\}", lambda match: r"\mathrm{ " + match[1] + "}", tex)
    try:
        from latex2mathml.converter import convert
        rendered = convert(tex, display="block" if display else "inline")
        root = ElementTree.fromstring(rendered)
        changed = False
        for node in root.iter():
            # Chromium ignores non-normal mathvariant values; encoded Greek
            # variants retain the source font distinction in MathML Core.
            if node.tag.rsplit('}', 1)[-1] == 'mi':
                styled = GREEK_VARIANTS.get((node.get('mathvariant'), node.text))
                if styled:
                    node.text = styled
                    changed = True
            for attribute in ("text", "tail"):
                value = getattr(node, attribute)
                if value:
                    normalized = re.sub(r"\\([_%$#&{}])", lambda match: match[1], value)
                    if normalized != value:
                        setattr(node, attribute, normalized)
                        changed = True
        if root.tag.rsplit("}", 1)[-1] != "math" or "\\" in "".join(root.itertext()):
            return ""
        if changed:
            ElementTree.register_namespace("", "http://www.w3.org/1998/Math/MathML")
            return ElementTree.tostring(root, encoding="unicode")
        return rendered
    except Exception:
        return ""


def inline_math(markup):
    pattern = r"(?<!\\)\$(?!\$)(.+?)(?<!\\)\$(?!\$)|\\\((.+?)\\\)"
    def replace(match):
        tex = html.unescape(match[1] if match[1] is not None else match[2])
        rendered = render_math(tex)
        return rendered or f'<span class="math-inline math-fallback"><code>{html.escape(tex)}</code></span>'
    return re.sub(pattern, replace, markup, flags=re.S)


def display_math(content, audit):
    number = audit.get("equation_number", {})
    tags = list(re.finditer(r"\\tag\s*\*?\s*\{\s*([^{}]+)\s*\}", content))
    if number.get("status") != "confirmed" or len(tags) != 1 or tags[0][1].strip() != str(number.get("source_number")):
        return render_math(content, display=True)
    match = tags[0]
    mathml = render_math(content[:match.start()] + content[match.end():], display=True)
    if not mathml:
        return ""
    label = html.escape(str(number["source_number"]))
    return f'<div class="equation-layout"><div class="equation-body">{mathml}</div> <span class="equation-number">({label})</span></div>'


CAPTION_RE = re.compile(r"^(Figure|Fig\.?|Table|Tab\.?)\s*([A-Z]?\d+)([a-z]?)(?!\w|\.\d)(?:\s*[:.|]|(?=\s+(?:\(|(?-i:[A-Z]))))", re.I)
REFERENCE_RE = re.compile(r"\b(Fig(?:ure)?\.?|Table|Tab\.?|Eq(?:uation)?\.?)\s*([A-Z]?\d+)([a-z]?)(?!\w|\.\d)", re.I)


def contents_layout(source_pages):
    headings, contents = set(), {}
    active_page = None
    pending_heading = None
    number_pattern = r"(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)*|[IVXLCDM]+)"

    def rows(content):
        result, pending = [], []
        for source_line in content.splitlines():
            if not source_line.strip():
                continue
            line = inline(re.sub(r"^\s*(?:#{1,6}\s+|[-*]\s+)", "", source_line))[1].strip()
            pending.append((source_line, line))
            joined = " ".join(value for _raw, value in pending)
            match = re.fullmatch(r"(.+?)(?:\s*\.{2,}\s*|\s+)(\d+|[ivxlcdm]+)", joined, re.I)
            if not match:
                if len(pending) > 2 or not re.match(number_pattern + r"[.)]?\s+\S", pending[0][1]):
                    return None
                continue
            title, page_label = match.groups()
            numbered = re.fullmatch(r"(" + number_pattern + r")[.)]?\s+(.+)", title)
            if numbered:
                number, title = numbered.groups()
            elif re.fullmatch(r"References?|Bibliography|Acknowledg(?:e)?ments?|参考文献|致谢", title, re.I):
                number = ""
            else:
                return None
            result.append({"source_line": "\n".join(raw for raw, _value in pending), "number": number, "title": title.strip(), "level": number.count(".")+1 if number else 1, "page_label": page_label})
            pending = []
        return result if len(result) >= 2 and not pending else None

    for pi, page in enumerate(source_pages, 1):
        if active_page is not None and pi > active_page + 1:
            active_page = None
            pending_heading = None
        for index, block in enumerate(page["blocks"]):
            content = str(block.get("content") or "")
            plain = inline(re.sub(r"^\s*#{1,6}\s+", "", content))[1].strip()
            if re.fullmatch(r"(?:Table\s+of\s+)?Contents?|目录", plain, re.I):
                pending_heading = (pi, index)
                active_page = pi
                continue
            if block.get("label") in {"aside_text", "page_header", "page_footer", "page_number"}:
                continue
            if active_page is not None:
                parsed = rows(content) if block.get("label") in {"text", "title", "heading", "index"} else None
                if parsed:
                    if pending_heading is not None:
                        headings.add(pending_heading)
                        pending_heading = None
                    contents[pi, index] = parsed
                    active_page = pi
                else:
                    active_page = None
                    pending_heading = None
    return headings, contents


def reference_layout(source_pages):
    """Bind numbered objects to source captions before making any links."""
    entries, by_location = [], {}
    contents_headings, contents_blocks = contents_layout(source_pages)
    scope, references = "main", False
    for pi, page in enumerate(source_pages, 1):
        table_boxes = [normalized_bbox(block) for block in page["blocks"] if block.get("label") == "table"]
        for index, block in enumerate(page["blocks"]):
            content = str(block.get("content") or "")
            heading = re.match(r"^#{1,6}\s+(.*)", content, re.S)
            plain = inline(heading[1] if heading else content)[1].strip()
            is_heading = bool(heading) or block.get("label") in {"title", "heading"}
            box = normalized_bbox(block)
            center = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            table_heading = is_heading and any(b[0] <= center[0] <= b[2] and b[1] <= center[1] <= b[3] for b in table_boxes)
            is_contents = (pi, index) in contents_headings or (pi, index) in contents_blocks
            if is_heading and not table_heading and not is_contents:
                appendix = re.match(r"^(?:([A-Z])\.\s*)?Appendix(?:\s+([A-Z])\b|\b)", plain, re.I)
                if appendix:
                    scope = "appendix-" + (appendix[1] or appendix[2] or "root").upper()
                subsection = re.match(r"^([A-Z])\.(\d+)(?:\.|\s)", plain)
                if scope.startswith("appendix-") and subsection:
                    scope = f"appendix-{subsection[1]}.{subsection[2]}"
                references = bool(re.match(r"^(?:References?|Bibliography)\b", plain, re.I))
            caption = CAPTION_RE.match(plain) if not references else None
            caption_kind = "image" if caption and caption[1].lower().startswith("fig") else "table" if caption else None
            entry = {"page": pi, "index": index, "order": len(entries), "label": str(block.get("label") or "text"), "bbox": box, "plain": plain, "scope": scope, "references": references, "caption": (caption_kind, caption[2].upper() + caption[3].lower()) if caption else None, "table_heading": table_heading, "paper_title": pi == 1 and index <= 3 and is_heading and not table_heading and bool(re.match(r"^#\s", content)) and not re.match(r"^(?:\d|abstract\b|introduction\b|contents?\b|references?\b|fig(?:ure)?\b|table\b|keywords?\b)", plain, re.I)}
            entry.update({"toc_heading": (pi, index) in contents_headings, "toc_entries": contents_blocks.get((pi, index))})
            entries.append(entry)
            by_location[pi, index] = entry
    groups = {}
    assignments = {}
    def auxiliary(entry):
        return entry["table_heading"] or entry["label"] in {"aside_text", "page_header", "page_footer", "page_number"} or bool(re.match(r"^(?:\([a-z]\)|[A-Z]\.)(?:\s|$)", entry["plain"]))
    for entry in entries:
        kind = entry["label"]
        if kind not in {"image", "table", "formula"}:
            continue
        caption_entry = entry if entry["caption"] and entry["caption"][0] == kind else None
        if kind in {"image", "table"} and caption_entry is None:
            # Captions may follow several subfigures, or precede tables that
            # continue on subsequent pages. Substantive text ends that evidence.
            for direction in (1, -1):
                cursor = entry["order"] + direction
                last_page = entry["page"]
                while 0 <= cursor < len(entries):
                    other = entries[cursor]
                    if other["scope"] != entry["scope"] or other["references"] or abs(other["page"] - last_page) > 1:
                        break
                    if direction == 1 and other["page"] != entry["page"]:
                        break
                    if kind == "image" and other["page"] != entry["page"]:
                        break
                    if other["caption"]:
                        if other["caption"][0] == kind:
                            caption_entry = other
                        break
                    if other["label"] != kind and not auxiliary(other):
                        break
                    last_page = other["page"]
                    cursor += direction
                if caption_entry is not None:
                    break
        if kind == "formula":
            tag = re.search(r"\\tag\*?\s*\{(\d+)\}", str(source_pages[entry["page"]-1]["blocks"][entry["index"]].get("content") or ""))
            if tag:
                entry["caption"] = (kind, tag[1])
                caption_entry = entry
        if caption_entry is None:
            continue
        number = caption_entry["caption"][1]
        key = (kind, caption_entry["order"])
        if key not in groups:
            prefix = {"image": "fig", "table": "table", "formula": "eq"}[kind]
            suffix = "" if entry["scope"] == "main" else "-" + re.sub(r"[^A-Za-z0-9_-]", "-", entry["scope"])
            anchor = f"{prefix}-{number}{suffix}"
            if any(group["anchor"] == anchor for group in groups.values()):
                anchor += f'-p{entry["page"]}-{entry["index"]}'
            groups[key] = {"anchor": anchor, "kind": kind, "number": number, "scope": entry["scope"], "page": entry["page"], "order": entry["order"], "caption_location": (caption_entry["page"], caption_entry["index"]), "members": []}
        group = groups[key]
        group["members"].append((entry["page"], entry["index"]))
        assignments[entry["page"], entry["index"]] = {"group": group, "anchor": group["anchor"] if len(group["members"]) == 1 else f'{group["anchor"]}-part-{len(group["members"])}'}
    for group in groups.values():
        if group["kind"] != "image":
            continue
        caption = by_location[group["caption_location"]]
        members = set(group["members"])
        boxes = [by_location[location]["bbox"] for location in members]
        bounds = [min(box[0] for box in boxes), min(box[1] for box in boxes), max(box[2] for box in boxes), max(box[3] for box in boxes)]
        cursor = caption["order"] - 1
        while cursor >= 0:
            other = entries[cursor]
            location = (other["page"], other["index"])
            if other["page"] != caption["page"] or other["scope"] != group["scope"] or other["references"] or other["caption"]:
                break
            if other["label"] == "image":
                existing = assignments.get(location)
                if existing and existing["group"] is not group:
                    break
                members.add(location)
                bounds = [min(bounds[0], other["bbox"][0]), min(bounds[1], other["bbox"][1]), max(bounds[2], other["bbox"][2]), max(bounds[3], other["bbox"][3])]
            elif not auxiliary(other):
                box = other["bbox"]
                numbered_heading = re.match(r"^(?:\d+(?:\.\d+)*|[A-Z]\.\d+)\b", other["plain"])
                figure_label = other["label"] in {"text", "title", "heading"} and len(other["plain"]) <= 200 and not numbered_heading and box[3]-box[1] <= .1 and bounds[0]-.04 <= (box[0]+box[2])/2 <= bounds[2]+.04 and bounds[1]-.12 <= (box[1]+box[3])/2 <= caption["bbox"][3]
                if not figure_label:
                    break
            cursor -= 1
        group["members"] = sorted(members, key=lambda location: by_location[location]["order"])
        group["order"] = by_location[group["members"][0]]["order"]
        for part, location in enumerate(group["members"], 1):
            assignments[location] = {"group": group, "anchor": group["anchor"] if part == 1 else f'{group["anchor"]}-part-{part}'}
        following = entries[caption["order"]+1] if caption["order"]+1 < len(entries) else None
        if following and following["page"] == caption["page"]+1 and following["scope"] == group["scope"] and following["caption"] == ("image", group["number"]):
            group["caption_location"] = (following["page"], following["index"])
    return by_location, assignments, list(groups.values())


def cross_references(markup, entry, groups):
    if entry["references"] or entry["caption"] or entry.get("toc_heading") or entry.get("toc_entries"):
        return markup
    def replace(match):
        kind = match[1].lower()
        kind = "image" if kind.startswith("fig") else "table" if kind.startswith("ta") else "formula"
        number = match[2].upper() + match[3].lower()
        candidates = [group for group in groups if group["kind"] == kind and group["number"] == number and group["scope"] == entry["scope"]]
        if not candidates and match[3]:
            candidates = [group for group in groups if group["kind"] == kind and group["number"] == match[2].upper() and group["scope"] == entry["scope"]]
        if not candidates:
            return match[0]
        target = min(candidates, key=lambda group: (abs(group["page"] - entry["page"]), abs(group["order"] - entry["order"]), group["order"]))
        return f'<a class="cross-reference" href="#{target["anchor"]}">{match[0]}</a>'
    parts, protected = [], []
    for part in re.split(r"(<[^>]*>)", markup):
        if part.startswith("<"):
            tag = re.match(r"<\s*(/?)\s*([A-Za-z][\w-]*)", part)
            if tag and tag[2].lower() in {"math", "a", "code", "pre"}:
                if tag[1]:
                    if protected:
                        protected.pop()
                elif not part.rstrip().endswith("/>"):
                    protected.append(tag[2].lower())
            parts.append(part)
        else:
            parts.append(part if protected else REFERENCE_RE.sub(replace, part))
    return "".join(parts)


def normalized_bbox(block):
    value = block.get("source_bbox_normalized") or block.get("normalized_bbox") or block.get("bbox")
    if not value:
        value = [float(x) / 1000 for x in block.get("bbox_2d", [0, 0, 1000, 1000])]
    if len(value) != 4:
        raise ValueError("Invalid block bbox")
    result = [max(0., min(1., float(x))) for x in value]
    if result[0] >= result[2] or result[1] >= result[3]:
        raise ValueError("Empty block bbox")
    return result


def stable_id(sha, page, box, label, ordinal=0):
    location = json.dumps([page, [round(x, 6) for x in box], label, ordinal], separators=(",", ":"))
    return "b-" + hashlib.sha256((sha + location).encode()).hexdigest()[:24]


def composite_figures(entries, assignments, groups, source_frames=None):
    ordered = list(entries.values())
    composites = []
    frame_cache = {}
    for group in groups:
        if group["kind"] != "image":
            continue
        caption = entries[group["caption_location"]]
        members = [entries[location] for location in group["members"]]
        if any(entry["page"] != caption["page"] or entry["bbox"][3] >= caption["bbox"][1] for entry in members):
            continue
        panel_media = list(members)

        def marker(entry):
            match = re.fullmatch(r"\s*(?:\(([A-Za-z])\)|([A-Za-z])[.)]?)\s*", entry["plain"])
            return (match[1] or match[2]).upper() if match else None

        # A text-only panel needs its own panel boundary and caption evidence;
        # proximity alone would also swallow ordinary prose above a figure.
        text_panels = set()
        page_entries = [entry for entry in ordered if entry["page"] == caption["page"] and entry["scope"] == group["scope"]]
        panel_markers = [entry for entry in page_entries if marker(entry)]
        for first, last in zip(panel_markers, panel_markers[1:]):
            if ord(marker(last)) != ord(marker(first)) + 1 or not all(re.search(rf"\b{marker(entry)}[.)]\s", caption["plain"], re.I) for entry in (first, last)):
                continue
            start, end = first["bbox"][1], last["bbox"][1]
            region = [entry for entry in page_entries if first["order"] <= entry["order"] < last["order"]]
            left, right = min(entry["bbox"][0] for entry in members), max(entry["bbox"][2] for entry in members)
            if not .04 < end-start <= .3 or end > min(entry["bbox"][1] for entry in members) + .03 or not 1 < len(region) <= 20:
                continue
            if any(entry["label"] not in {"text", "title", "heading"} or entry["caption"] or entry["references"] or re.match(r"^(?:\d+(?:\.\d+)*|[A-Z]\.\d+)\b", entry["plain"]) or not (left-.04 <= entry["bbox"][0] < entry["bbox"][2] <= right+.04 and start <= entry["bbox"][1] < entry["bbox"][3] <= end and entry["bbox"][3]-entry["bbox"][1] <= .06) for entry in region):
                continue
            labels = [entry for entry in region if entry["plain"].endswith(":") and len(entry["plain"]) <= 40 and entry["bbox"][2]-entry["bbox"][0] <= .25 and entry["bbox"][3]-entry["bbox"][1] <= .02]
            if len(labels) < 2:
                continue
            panel_box = [min(entry["bbox"][0] for entry in region), start, max(entry["bbox"][2] for entry in region), max(entry["bbox"][3] for entry in region)]
            if not source_frames:
                continue
            if caption["page"] not in frame_cache:
                frame_cache[caption["page"]] = source_frames(caption["page"])
            figure_boxes = [panel_box] + [entry["bbox"] for entry in members]
            figure_box = [min(box[0] for box in figure_boxes), min(box[1] for box in figure_boxes), max(box[2] for box in figure_boxes), max(box[3] for box in figure_boxes)]
            if not any(frame[3] < caption["bbox"][1] and max(abs(a-b) for a, b in zip(frame, figure_box)) <= .025 and all(frame[0]-.01 <= box[0] and frame[1]-.01 <= box[1] and frame[2]+.01 >= box[2] and frame[3]+.01 >= box[3] for box in figure_boxes) for frame in frame_cache[caption["page"]]):
                continue
            text_panels.update((entry["page"], entry["index"]) for entry in region)

        def source_contains_label(box):
            if not source_frames:
                return False
            if caption["page"] not in frame_cache:
                frame_cache[caption["page"]] = source_frames(caption["page"])
            def contained(frame, candidate):
                return frame[0]-.01 <= candidate[0] and frame[1]-.01 <= candidate[1] and frame[2]+.01 >= candidate[2] and frame[3]+.01 >= candidate[3]
            return any(frame[3] < caption["bbox"][1] and contained(frame, box) and any(contained(frame, image["bbox"]) for image in panel_media) for frame in frame_cache[caption["page"]])

        def panel_label(entry):
            box = entry["bbox"]
            if entry["label"] not in {"text", "title", "heading"} or entry.get("toc_heading") or entry.get("toc_entries") or re.match(r"^(?:\d+(?:\.\d+)*|[A-Z]\.\d+)\b", entry["plain"]):
                return False
            if len(entry["plain"]) > 200 or box[2]-box[0] > .5 or box[3]-box[1] > .045:
                return False
            if not marker(entry) and not source_contains_label(box):
                return False
            # Labels sit on or immediately beside a concrete panel, rather than
            # merely somewhere inside the overall multi-row bounding rectangle.
            return any(box[0] >= image["bbox"][0]-.04 and box[2] <= image["bbox"][2]+.04 and box[1] <= image["bbox"][3]+.025 and box[3] >= image["bbox"][1]-.03 for image in panel_media) or (
                box[2]-box[0] <= .4 and any(min(abs(box[3]-image["bbox"][1]), abs(box[1]-image["bbox"][3])) <= .031 and min(box[2], image["bbox"][2])-max(box[0], image["bbox"][0]) >= (box[2]-box[0])*.5 for image in panel_media))

        components = []
        last_order = max(caption["order"]-1, max(entry["order"] for entry in members))
        for entry in ordered[caption["order"]+1:]:
            location = (entry["page"], entry["index"])
            assigned = assignments.get(location)
            if entry["page"] != caption["page"] or entry["scope"] != group["scope"] or entry["caption"] or entry["references"] or entry["bbox"][3] >= caption["bbox"][1] or (assigned and assigned["group"] is not group):
                break
            if entry["label"] != "image" and not marker(entry):
                break
            last_order = max(last_order, entry["order"])
        for entry in reversed(ordered[:last_order+1]):
            location = (entry["page"], entry["index"])
            if entry is caption:
                continue
            if entry["page"] != caption["page"] or entry["scope"] != group["scope"] or entry["caption"] or entry["references"]:
                break
            assigned = assignments.get(location)
            if assigned and assigned["group"] is not group:
                break
            if entry["label"] not in {"image", "table"} and location not in text_panels and not panel_label(entry):
                break
            if entry["label"] in {"image", "table"}:
                panel_media.append(entry)
            components.append(location)
        components.reverse()
        images = [location for location in components if entries[location]["label"] == "image"]
        if len(images) < 2 or not set(group["members"]).issubset(images):
            continue
        markers = [marker(entries[location]) for location in components if marker(entries[location])]
        if markers and re.search(r"\bA\.\s", caption["plain"]) and "A" not in markers:
            continue
        boxes = [entries[location]["bbox"] for location in components if entries[location]["label"] != "table"]
        bounds = [min(box[0] for box in boxes), min(box[1] for box in boxes), max(box[2] for box in boxes), max(box[3] for box in boxes)]
        if bounds[3] >= caption["bbox"][1]:
            continue
        def contained(box):
            return bounds[0] <= box[0] and bounds[1] <= box[1] and bounds[2] >= box[2] and bounds[3] >= box[3]
        if any(not contained(entries[location]["bbox"]) for location in components if entries[location]["label"] == "table"):
            continue
        if any(entry["page"] == caption["page"] and (entry["page"], entry["index"]) not in components and entry is not caption and min(entry["bbox"][2], bounds[2]) > max(entry["bbox"][0], bounds[0]) and min(entry["bbox"][3], bounds[3]) > max(entry["bbox"][1], bounds[1]) for entry in ordered):
            continue
        composites.append({"group": group, "components": components, "host": group["members"][0], "bbox": bounds})

    # A source Image/Form can establish a whole figure even when OCR labels
    # interrupted the image-to-caption walk before it found any group members.
    if source_frames:
        for caption in ordered:
            if not caption["caption"] or caption["caption"][0] != "image" or caption["references"]:
                continue
            if any(group["kind"] == "image" and group["number"] == caption["caption"][1] and group["scope"] == caption["scope"] for group in groups):
                continue
            page_number = caption["page"]
            if page_number not in frame_cache:
                frame_cache[page_number] = source_frames(page_number)
            for frame in frame_cache[page_number]:
                if not 0 < caption["bbox"][1] - frame[3] <= .04:
                    continue
                page_entries = [entry for entry in ordered if entry["page"] == page_number]
                region = [entry for entry in page_entries if min(entry["bbox"][2], frame[2]) > max(entry["bbox"][0], frame[0]) and min(entry["bbox"][3], frame[3]) > max(entry["bbox"][1], frame[1])]
                if not region or any(entry["scope"] != caption["scope"] or entry["references"] or entry["caption"] or entry.get("toc_heading") or entry.get("toc_entries") or (entry["page"], entry["index"]) in assignments or not (frame[0]-.01 <= entry["bbox"][0] < entry["bbox"][2] <= frame[2]+.01 and frame[1]-.01 <= entry["bbox"][1] < entry["bbox"][3] <= frame[3]+.01) for entry in region):
                    continue
                media = [entry for entry in region if entry["label"] in {"image", "table"}]
                images = [entry for entry in media if entry["label"] == "image"]
                if len(media) < 2 or not images:
                    continue
                if len(images) == 1:
                    # A table can be a figure panel, but only the source frame
                    # plus explicit panel labels establishes that association.
                    markers = {entry["plain"].strip("(). ") for entry in region if re.fullmatch(r"\(?[A-Z]\)?[.]?", entry["plain"])}
                    if len(markers) < 2 or not all(re.search(rf"\b{re.escape(marker)}[,.):]\s", caption["plain"]) for marker in markers):
                        continue
                image_box = [min(entry["bbox"][0] for entry in media), min(entry["bbox"][1] for entry in media), max(entry["bbox"][2] for entry in media), max(entry["bbox"][3] for entry in media)]
                if max(abs(a-b) for a, b in zip(frame, image_box)) > .04:
                    continue
                def framed_label(entry):
                    box = entry["bbox"]
                    if re.fullmatch(r"\(?[A-Z]\)?[.]?", entry["plain"]):
                        return box[2]-box[0] <= .04 and box[3]-box[1] <= .03
                    if entry["label"] not in {"text", "title", "heading"} or len(entry["plain"]) > 200 or box[2]-box[0] > .5 or box[3]-box[1] > .03 or re.match(r"^(?:\d+(?:\.\d+)*|[A-Z]\.\d+)[.)]?\s", entry["plain"]) or re.search(r"[.!?]\s*$", entry["plain"]):
                        return False
                    return any(min(abs(box[3]-image["bbox"][1]), abs(box[1]-image["bbox"][3])) <= .035 and min(box[2], image["bbox"][2])-max(box[0], image["bbox"][0]) >= (box[2]-box[0])*.3 for image in media)
                if any(entry["label"] not in {"image", "table"} and not framed_label(entry) for entry in region):
                    continue
                following = ordered[caption["order"]+1] if caption["order"]+1 < len(ordered) else None
                full_caption = following if following and following["page"] == page_number+1 and following["scope"] == caption["scope"] and following["caption"] == caption["caption"] else caption
                number = caption["caption"][1]
                suffix = "" if caption["scope"] == "main" else "-" + re.sub(r"[^A-Za-z0-9_-]", "-", caption["scope"])
                group = {"anchor": f"fig-{number}{suffix}", "kind": "image", "number": number, "scope": caption["scope"], "page": page_number, "order": region[0]["order"], "caption_location": (full_caption["page"], full_caption["index"]), "members": [(entry["page"], entry["index"]) for entry in images]}
                groups.append(group)
                for part, location in enumerate(group["members"], 1):
                    assignments[location] = {"group": group, "anchor": group["anchor"] if part == 1 else f'{group["anchor"]}-part-{part}'}
                composites.append({"group": group, "components": [(entry["page"], entry["index"]) for entry in region], "host": group["members"][0], "bbox": list(frame)})
                break
    return composites


def source_object_bounds(obj):
    bounds = obj.get_bounds()
    container = obj.container
    # PDFium reports nested objects in their Form's coordinate system.
    while container:
        bounds = container.get_matrix().on_rect(*bounds)
        container = container.container
    return bounds


def bounded_visual_dpi(width, height, requested):
    scale = min(requested / 72, 6144 / max(width, height), math.sqrt(24_000_000 / (width * height)))
    while max(math.ceil(width * scale), math.ceil(height * scale)) > 6144 or math.ceil(width * scale) * math.ceil(height * scale) > 24_000_000:
        scale *= .9999
    return scale * 72


def source_figure_ink_bounds(pdf, page_number, bounds, outside, evidence=None):
    import pypdfium2 as pdfium

    expanded = list(bounds)
    ink_boxes = []
    if evidence is not None:
        evidence["objects"] = []
    with pdfium.PdfDocument(pdf) as document:
        page = document[page_number-1]
        width, height = page.get_size()
        for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE, pdfium.raw.FPDF_PAGEOBJ_PATH, pdfium.raw.FPDF_PAGEOBJ_TEXT]):
            left, bottom, right, top = source_object_bounds(obj)
            box = [left/width, 1-top/height, right/width, 1-bottom/height]
            if evidence is not None:
                evidence["objects"].append(list(box))
            if not (max(0., bounds[0]-.03) <= box[0] < box[2] <= min(1., bounds[2]+.03) and max(0., bounds[1]-.03) <= box[1] < box[3] <= min(1., bounds[3]+.03)):
                continue
            # One PDF point protects antialiased ink only on a newly exposed edge.
            for edge, padding in enumerate([1/width, 1/height, 1/width, 1/height]):
                if obj.type == pdfium.raw.FPDF_PAGEOBJ_IMAGE:
                    padding = 0.
                if edge < 2 and box[edge] < bounds[edge]-1e-5:
                    box[edge] = max(0., bounds[edge]-.03, box[edge]-padding)
                elif edge >= 2 and box[edge] > bounds[edge]+1e-5:
                    box[edge] = min(1., bounds[edge]+.03, box[edge]+padding)
            if any(bbox_overlaps(box, entry["bbox"]) for entry in outside):
                continue
            ink_boxes.append(box)
            expanded = [min(expanded[0], box[0]) if box[0] < bounds[0]-1e-5 else expanded[0], min(expanded[1], box[1]) if box[1] < bounds[1]-1e-5 else expanded[1], max(expanded[2], box[2]) if box[2] > bounds[2]+1e-5 else expanded[2], max(expanded[3], box[3]) if box[3] > bounds[3]+1e-5 else expanded[3]]
    if evidence is not None:
        evidence["bbox"] = [min(box[0] for box in ink_boxes), min(box[1] for box in ink_boxes), max(box[2] for box in ink_boxes), max(box[3] for box in ink_boxes)] if ink_boxes else None
    if any(bbox_overlaps(expanded, entry["bbox"]) for entry in outside):
        return list(bounds)
    return expanded


def source_figure_frames(pdf, page_number):
    import pypdfium2 as pdfium

    with pdfium.PdfDocument(pdf) as document:
        page = document[page_number-1]
        width, height = page.get_size()
        frames = []
        for obj in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE, pdfium.raw.FPDF_PAGEOBJ_FORM]):
            bounds = source_object_bounds(obj)
            left, bottom, right, top = bounds
            if 0 <= left < right <= width and 0 <= bottom < top <= height:
                frames.append([left/width, 1-top/height, right/width, 1-bottom/height])
        return frames


def embedded_figure(pdf, page_number, page, bounds):
    import pypdfium2 as pdfium

    def matches(box):
        intersection = max(0., min(box[2], bounds[2]) - max(box[0], bounds[0])) * max(0., min(box[3], bounds[3]) - max(box[1], bounds[1]))
        union = (box[2]-box[0]) * (box[3]-box[1]) + (bounds[2]-bounds[0]) * (bounds[3]-bounds[1]) - intersection
        return union and intersection / union >= .95 and max(abs(a-b) for a, b in zip(box, bounds)) <= .01

    # Accessing page.images also materializes every pdfminer path on vector-heavy pages.
    with pdfium.PdfDocument(pdf) as document:
        pdf_page = document[page_number-1]
        if not any(matches([left/page.width, 1-top/page.height, right/page.width, 1-bottom/page.height]) for obj in pdf_page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE]) for left, bottom, right, top in [obj.get_bounds()]):
            return None
    candidates = []
    for image in page.images:
        box = [image["x0"] / page.width, image["top"] / page.height, image["x1"] / page.width, image["bottom"] / page.height]
        if matches(box):
            candidates.append((image, box))
    return candidates[0] if len(candidates) == 1 else None


def bbox_overlaps(left, right):
    return min(left[2], right[2]) > max(left[0], right[0]) and min(left[3], right[3]) > max(left[1], right[1])


def extract_figure_image(pdf, page_number, page, image, box):
    from PIL import Image
    import pypdfium2 as pdfium
    width, height = image.get("srcsize") or (0, 0)
    attrs = image["stream"].attrs
    colorspace = image.get("colorspace") or []
    simple_color = len(colorspace) == 1 and getattr(colorspace[0], "name", "") in {"DeviceRGB", "DeviceGray"}
    if not simple_color or not (0 < width * height <= 24_000_000 and max(width, height) <= 6144) or page.rotation or image.get("bits") != 8 or any(key in attrs for key in ("SMask", "Mask", "Decode")) or image.get("imagemask"):
        return None
    aspect = (box[2]-box[0])*page.width / ((box[3]-box[1])*page.height)
    if abs(width/height/aspect - 1) > .01:
        return None
    if any(other is not image and bbox_overlaps(box, [other["x0"]/page.width, other["top"]/page.height, other["x1"]/page.width, other["bottom"]/page.height]) for other in page.images):
        return None
    if any(box[0] <= (char["x0"] + char["x1"]) / (2*page.width) <= box[2] and box[1] <= (char["top"] + char["bottom"]) / (2*page.height) <= box[3] for char in page.chars):
        return None
    if any(box[0] < (shape["x0"] + shape["x1"]) / (2*page.width) < box[2] and box[1] < (shape["top"] + shape["bottom"]) / (2*page.height) < box[3] for shape in page.lines + page.rects + page.curves):
        return None
    with pdfium.PdfDocument(pdf) as document:
        pdf_page = document[page_number-1]
        matches = []
        for obj in pdf_page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE]):
            left, bottom, right, top = obj.get_bounds()
            candidate = [left/page.width, 1-top/page.height, right/page.width, 1-bottom/page.height]
            matrix = obj.get_matrix()
            if max(abs(a-b) for a, b in zip(candidate, box)) < .0001 and obj.get_px_size() == (width, height) and matrix.a > 0 and matrix.d > 0 and abs(matrix.b) < .001 and abs(matrix.c) < .001:
                matches.append(obj)
        if len(matches) != 1:
            return None
        with io.BytesIO() as buffer:
            matches[0].extract(buffer, fb_format="png")
            buffer.seek(0)
            with Image.open(buffer) as decoded:
                if decoded.size != (width, height) or decoded.mode not in {"RGB", "L"}:
                    return None
                return decoded.convert("RGB")


def revalidate_inline_source(item, page, region):
    from .math_evidence import TexAtoms
    ids = item.get("source_glyph_ids") or []
    if not ids:
        return
    selected = [char for char in page.chars if char["glyph_id"] in set(ids)]
    geometry = page.inline_geometry(ids, region)
    if geometry.get("baseline_source") == "selected-base-glyphs-on-isolated-line" and geometry["status"] == "confirmed":
        item["previous_native_geometry"] = copy.deepcopy(item.get("native_geometry"))
        item["native_geometry"] = geometry
        for key in ("body_baseline_normalized", "baseline_offset_em"):
            item[key] = geometry[key]
    candidate = next((value for value in item.get("candidates", []) if value.get("engine") == item.get("selected_engine")), {})
    if not candidate.get("script_errors") or candidate.get("lexical_errors") or candidate.get("style_errors") or candidate.get("structure_errors") or candidate.get("unknown_macros") or candidate.get("alignment_coverage") != 1 or candidate.get("native_coverage") != 1 or geometry.get("status") != "confirmed":
        return
    parsed = TexAtoms(candidate["content"])
    if parsed.unknown or not 1 <= len(parsed.atoms) <= 16 or not any(atom["script"] for atom in parsed.atoms) or any(set(atom["styles"]) - {"mathrm"} for atom in parsed.atoms):
        return
    source = [(value, char) for char in selected for value in char["canonical"]]
    if len(source) != len(parsed.atoms) or not all(char["canonical"] and not char["rotated"] for char in selected):
        return
    scripts = page.encoded_script_glyphs()
    segments, evidence = [], []
    for atom, (value, char) in zip(parsed.atoms, source):
        script = scripts.get(char["glyph_id"], {}).get("script_kind")
        if atom["text"] != value or atom["script"] != ([script] if script else []) or not re.fullmatch(r"[\w()[\].,;:!?]", value):
            return
        if script:
            evidence.append({"glyph_id": char["glyph_id"], **scripts[char["glyph_id"]]})
        if segments and segments[-1].get("script_kind") == script:
            segments[-1]["text"] += value
            segments[-1]["source_glyph_ids"].append(char["glyph_id"])
        else:
            segments.append({"text": value, **({"script_kind": script} if script else {}), "source_glyph_ids": [char["glyph_id"]]})
    item["source_revalidation"] = {"basis": "exact-native-atoms-and-explicit-script-encoding", "previous_status": item.get("status"), "previous_reason": item.get("reason"), "previous_script_errors": copy.deepcopy(candidate["script_errors"]), "script_glyphs": evidence}
    candidate["score"] = max(0, candidate.get("score", 0) - 2 * len(candidate["script_errors"]))
    candidate["script_errors"] = []
    item.update({"status": "confirmed", "reason": None, "source_crop_required": False, "fallback_bbox": None, "render_mode": "native-script", "semantic_kind": "simple-script-formula", "selectable_segments": segments, "selectable_text": "".join(segment["text"] for segment in segments), "native_geometry": geometry})
    for key in ("source_bbox_normalized", "source_glyph_ids", "body_baseline_normalized", "body_font_size_points", "height_em", "baseline_offset_em"):
        item[key] = geometry[key]
    item.pop("source_asset", None)
    item.pop("selection_text", None)


def export_document(pdf, fusion_dir, output, title=None, job_id=None):
    import pdfplumber
    from PIL import Image
    pdf, fusion_dir, output = Path(pdf), Path(fusion_dir), Path(output)
    output.mkdir(parents=True, exist_ok=False)
    images = output / "assets/images"
    images.mkdir(parents=True)
    thumbnails = output / "assets/pages"
    thumbnails.mkdir()
    source_sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    fusion = json.loads((fusion_dir / "document.json").read_text())
    engine = str(fusion.get("schema") or "guzi-fusion-auto-v2")
    source_pages = fusion["pages"]
    title = title or pdf.name
    shutil.copy2(pdf, output / "source.pdf")
    pages, ir_pages, html_pages, md_pages = [], [], [], []
    page_assets, warnings, math_audits = [], [], []
    native_fonts = None
    counts = {"pages": len(source_pages), "images": 0, "tables": 0, "display_formulas": 0, "references": 0}
    reference_entries, reference_assignments, reference_groups = reference_layout(source_pages)
    bibliography_targets, duplicate_references = bibliography_layout(reference_entries, source_pages)
    counts["references"] = len(bibliography_targets)
    previous_reference_assignments = reference_assignments.copy()
    composites = composite_figures(reference_entries, reference_assignments, reference_groups, lambda page: source_figure_frames(pdf, page))
    caption_ids = {group["caption_location"]: "caption-" + group["anchor"] for group in reference_groups if group["caption_location"] not in group["members"]}
    composite_locations = {location: composite for composite in composites for location in composite["components"]}
    source_ids = {}
    seen = {}
    for location, entry in reference_entries.items():
        key = (entry["page"], tuple(round(x, 6) for x in entry["bbox"]), entry["label"])
        ordinal = seen.get(key, 0)
        seen[key] = ordinal + 1
        source_ids[location] = stable_id(source_sha, entry["page"], entry["bbox"], entry["label"], ordinal)
    def section_key(value):
        return re.sub(r"[\W_]+", "", value.casefold())
    sections = []
    for location, entry in reference_entries.items():
        original = source_pages[location[0]-1]["blocks"][location[1]]
        content = str(original.get("content") or "")
        if (re.match(r"^#{1,6}\s", content) or entry["label"] in {"title", "heading"}) and not any(entry.get(key) for key in ("toc_heading", "toc_entries", "table_heading", "caption", "paper_title")) and "\n" not in content.strip():
            sections.append((location, entry))
    for entry in reference_entries.values():
        for row in entry.get("toc_entries") or []:
            key = section_key((row["number"] + " " + row["title"]).strip())
            matches = [(location, target) for location, target in sections if section_key(target["plain"]) == key and (row["number"] or target["scope"] == entry["scope"])]
            row.update({"target_verified": len(matches) == 1, "target_match_basis": "unique-normalized-section-heading", "target_status": "verified" if len(matches) == 1 else "ambiguous" if matches else "unmatched", "target_candidate_count": len(matches), "target_block_id": None, "target_anchor": None, "target_page": None})
            if len(matches) == 1:
                location, target = matches[0]
                row.update({"target_block_id": source_ids[location], "target_anchor": "section-" + source_ids[location], "target_page": target["page"]})
    with pdfplumber.open(pdf) as document:
        if len(document.pages) != len(source_pages):
            raise ValueError("Fusion/PDF page coverage mismatch")
        for pi, (page, original_page) in enumerate(zip(document.pages, source_pages), 1):
            # Text-sensitive crops share a lazy high-resolution raster below.
            dpi = min(144., 4096 * 72 / max(page.width, page.height), math.sqrt(12_000_000 / (page.width * page.height)) * 72)
            if dpi < 12:
                raise ValueError("PDF page dimensions exceed source rendering budget")
            raster = page.to_image(resolution=dpi, antialias=True).original.convert("RGB")
            thumb = raster.copy()
            thumb.thumbnail((640, 900), Image.Resampling.LANCZOS)
            thumb_path = f"assets/pages/page-{pi:03d}.jpg"
            thumb.save(output / thumb_path, quality=85)
            page_assets.append(thumb_path)
            high_raster = None
            native_page = None
            page_composites = [composite for composite in composites if composite["host"][0] == pi]
            high_dpi = bounded_visual_dpi(page.width, page.height, min(384., max([288.] + [2160 * 72 / ((composite["bbox"][2]-composite["bbox"][0]) * page.width) for composite in page_composites])))
            for composite in page_composites:
                outside = [entry for location, entry in reference_entries.items() if entry["page"] == pi and location not in composite["components"]]
                ink_evidence = {}
                composite["render_bbox"] = source_figure_ink_bounds(pdf, pi, composite["bbox"], outside, ink_evidence)
                composite["source_ink_bbox"] = ink_evidence["bbox"]
                composite["ink_expanded_edges"] = [name for edge, name in enumerate(["left", "top", "right", "bottom"]) if (composite["render_bbox"][edge] < composite["bbox"][edge] if edge < 2 else composite["render_bbox"][edge] > composite["bbox"][edge])]
                composite["native_image"] = None
                native = embedded_figure(pdf, pi, page, composite["render_bbox"])
                if native:
                    candidate_image, candidate_box = native
                    render_box = composite["render_bbox"]
                    envelope = composite["bbox"]
                    contains_ink = all(render_box[edge] >= envelope[edge]-1e-5 or candidate_box[edge] <= render_box[edge]+1e-5 for edge in (0, 1)) and all(render_box[edge] <= envelope[edge]+1e-5 or candidate_box[edge] >= render_box[edge]-1e-5 for edge in (2, 3))
                    strips = [[render_box[0], render_box[1], candidate_box[0], render_box[3]], [render_box[0], render_box[1], render_box[2], candidate_box[1]], [candidate_box[2], render_box[1], render_box[2], render_box[3]], [render_box[0], candidate_box[3], render_box[2], render_box[3]]]
                    discards_ink = any(min(box[2], strip[2])-max(box[0], strip[0]) > 1e-5 and min(box[3], strip[3])-max(box[1], strip[1]) > 1e-5 for strip in strips for box in ink_evidence["objects"])
                    if contains_ink and not discards_ink and not any(bbox_overlaps(candidate_box, entry["bbox"]) for entry in outside):
                        composite["render_bbox"] = candidate_box
                        composite["native_source"] = candidate_image
                        try:
                            composite["native_image"] = extract_figure_image(pdf, pi, page, candidate_image, candidate_box)
                        except (OSError, ValueError, RuntimeError):
                            composite["native_image"] = None
            math_assets = {}
            def crop(box, key, mathematical=False, high_resolution=False):
                nonlocal high_raster
                if len(box) != 4 or not (0 <= box[0] < box[2] <= 1 and 0 <= box[1] < box[3] <= 1):
                    raise ValueError("Unsafe source crop bbox")
                high_resolution = high_resolution or mathematical
                if high_resolution and high_raster is None:
                    high_raster = page.to_image(resolution=high_dpi, antialias=True).original.convert("RGB")
                source = high_raster if high_resolution else raster
                coordinates = (int(box[0]*source.width), int(box[1]*source.height), max(int(box[0]*source.width)+1, math.ceil(box[2]*source.width)), max(int(box[1]*source.height)+1, math.ceil(box[3]*source.height)))
                asset = f"assets/images/{key}.png"
                source.crop(coordinates).save(output / asset)
                if high_resolution:
                    logical_width = max(1, int(box[2]*raster.width) - int(box[0]*raster.width))
                    math_assets[asset] = {"kind": "source-math-crop" if mathematical else "pdf-render", "render_dpi": high_dpi, "intrinsic_pixels": [coordinates[2]-coordinates[0], coordinates[3]-coordinates[1]], "display_width_css_pixels": logical_width, "source_bbox": list(box), "antialias": True}
                return asset

            def visual_crop(box, key, index):
                outside = [entry for location, entry in reference_entries.items() if entry["page"] == pi and location != (pi, index)]
                evidence = {}
                render_box = source_figure_ink_bounds(pdf, pi, box, outside, evidence)
                native = embedded_figure(pdf, pi, page, render_box)
                native_image = None
                if native:
                    candidate, candidate_box = native
                    ink = evidence["bbox"]
                    contains_ink = ink is None or all(candidate_box[edge] <= ink[edge]+1e-5 for edge in (0, 1)) and all(candidate_box[edge] >= ink[edge]-1e-5 for edge in (2, 3))
                    if contains_ink and not any(bbox_overlaps(candidate_box, entry["bbox"]) for entry in outside):
                        try:
                            native_image = extract_figure_image(pdf, pi, page, candidate, candidate_box)
                        except (OSError, ValueError, RuntimeError):
                            native_image = None
                        if native_image is not None:
                            render_box = candidate_box
                if native_image is not None:
                    asset = f"assets/images/{key}.png"
                    with native_image:
                        pixels = list(native_image.size)
                        native_image.save(output / asset)
                    provenance = {"kind": "pdf-embedded-image", "source_image_name": candidate.get("name"), "intrinsic_pixels": pixels, "render_dpi": None, "antialias": None, "source_bbox": list(render_box), "display_width_css_pixels": max(1, int(render_box[2]*raster.width)-int(render_box[0]*raster.width))}
                else:
                    asset = crop(render_box, key, high_resolution=True)
                    provenance = math_assets[asset]
                    pixels = provenance["intrinsic_pixels"]
                provenance.update({"effective_dpi": [pixels[0]*72/((render_box[2]-render_box[0])*page.width), pixels[1]*72/((render_box[3]-render_box[1])*page.height)], "pixel_budget": 24_000_000, "max_edge": 6144})
                return asset, provenance, render_box, evidence["bbox"]
            records, ir_elements, rendered, markdown = [], [], [], []
            for index, original in enumerate(original_page["blocks"]):
                block = copy.deepcopy(original)
                label = str(block.get("label", "text"))
                content = str(block.get("content") or "")
                box = normalized_bbox(block)
                block_id = source_ids[pi, index]
                composite = composite_locations.get((pi, index))
                if composite and (pi, index) != composite["host"]:
                    source_type = {"text": "paragraph", "table": "table", "image": "image"}.get(label, label)
                    record = {**block, "block_id": block_id, "index": index, "type": source_type, "bbox": box, "coordinate_space": "normalized", "text": "", "content": content, "source_content": original.get("content"), "html": "", "markdown": "", "render_mode": "figure-component", "parent_figure_anchor": composite["group"]["anchor"], "parent_figure_block_id": source_ids[composite["host"]], "source_block_bbox": box, "render_bbox": composite["render_bbox"], "component_envelope_bbox": composite["bbox"]}
                    records.append(record)
                    ir_elements.append({**record, "id": block_id, "page": pi, "source": engine, "reading_order": index, "render": {"html": "", "markdown": ""}, "style_spans": block.get("style_spans", [])})
                    rendered.append("")
                    markdown.append("")
                    continue
                audit = copy.deepcopy(block.get("math_audit") or {})
                if isinstance(audit, list):
                    audit = {"inline": audit}
                candidate_content = content
                render_fallback = block.get("render_fallback") or {}
                source_block_required = label in {"table", "formula"} and (bool(audit.get("source_block_required")) or bool(block.get("needs_source_table")) or render_fallback.get("mode") == "source-crop")
                if label not in {"table", "formula", "image"} and audit.get("source_block_required"):
                    audit.update({"source_block_required": False, "status": "unresolved", "render_reason": "selectable-prose-preserved"})
                if render_fallback.get("bbox"):
                    audit["fallback_bbox"] = render_fallback["bbox"]
                if render_fallback.get("reason"):
                    audit["render_reason"] = render_fallback["reason"]
                native_table_unsupported = label == "table" and (block.get("native_evidence") or {}).get("status") == "unsupported"
                if native_table_unsupported:
                    source_block_required = True
                    audit.update({"status": "unresolved", "render_reason": "unsupported-native-table-geometry"})
                if label in {"text", "reference", "footnote"}:
                    for item in audit.get("inline", []):
                        if item.get("render_mode") == "source-crop" or item.get("source_crop_required"):
                            if native_page is None:
                                from .native_pdf import NativePage
                                native_page = NativePage(page)
                            revalidate_inline_source(item, native_page, box)
                    if any(item.get("source_revalidation") for item in audit.get("inline", [])) and all(item.get("status") == "confirmed" for item in audit["inline"]):
                        audit["status"] = "confirmed"
                inline_audits = [] if source_block_required else sorted(audit.get("inline", []), key=lambda item: item.get("start") if isinstance(item.get("start"), int) else -1, reverse=True)
                if source_block_required:
                    audit["inline_rendering_suppressed"] = True
                replacements = {}
                for ai, item in enumerate(inline_audits):
                    mode = item.get("render_mode") or ("source-crop" if item.get("source_crop_required") else "")
                    if mode not in {"native-script", "source-crop", "candidate-unresolved", "literal-text"}:
                        continue
                    if not isinstance(item.get("start"), int) or not isinstance(item.get("end"), int):
                        continue
                    start, end = item["start"], item["end"]
                    if not 0 <= start < end <= len(content):
                        raise ValueError("Inline math fallback range outside content")
                    if item.get("candidate_content") is not None and content[start:end] != item["candidate_content"]:
                        raise ValueError("Inline math candidate no longer matches final content offsets")
                    marker = f"GUZIMATHCROP{ai}END"
                    replacements[marker] = {"bbox": item.get("source_bbox_normalized") or item.get("fallback_bbox"), "key": f"{block_id}-math-{ai}", "audit": item, "mode": mode, "candidate": content[start:end]}
                    content = content[:start] + marker + content[end:]
                if inline_audits:
                    audit["inline"] = list(reversed(inline_audits))
                image_markdown = re.fullmatch(r"!\[([^\]]*)\]\([^\n)]+\)", content.strip()) if label == "image" else None
                if image_markdown:
                    content = image_markdown[1]
                markup, plain = inline(content)
                markup = inline_math(markup) if label != "formula" else markup
                if 'math-fallback' in markup or len(re.findall(r"(?<!\\)\$", markup)) % 2:
                    audit.update({"status": "unresolved", "render_status": "unsupported-inline-math", "render_reason": "unconverted-or-unbalanced-inline-math"})
                    if label == "table":
                        source_block_required = True
                        audit.update({"source_block_required": True, "fallback_bbox": box, "inline_rendering_suppressed": True})
                markdown_content = content
                for marker, replacement in replacements.items() if not source_block_required else []:
                    item = replacement["audit"]
                    mode = replacement["mode"]
                    selected = str(item.get("selectable_text") or replacement["candidate"])
                    segments = item.get("selectable_segments") if mode == "native-script" else None
                    if isinstance(segments, list) and segments:
                        selected = "".join(str(segment.get("text") or "") for segment in segments)
                    if mode == "source-crop" and replacement["bbox"]:
                        asset = crop(replacement["bbox"], replacement["key"], mathematical=True)
                        item["source_asset"] = asset
                        item["asset_provenance"] = math_assets[asset]
                        selected = "[公式原图]"
                        height = max(.1, min(3.6, float(item.get("height_em") or 1.2)))
                        baseline = max(-3.6, min(3.6, float(item.get("baseline_offset_em") or 0)))
                        replacement_html = f'<span class="math-source-visual" data-math-status="unresolved"><span class="math-source-text">{selected}</span><img class="math-source-inline" src="{asset}" alt="公式原图，识别待核" aria-hidden="true" data-height-em="{height:g}" data-baseline-offset-em="{baseline:g}" style="height:{height:g}em;vertical-align:{-baseline:g}em" loading="lazy"></span>'
                        markdown_image = f'<img src="{asset}" alt="原 PDF 数学区域">' if label == "table" else f"![原 PDF 数学区域]({asset})"
                        item.update({"status": "unresolved", "selection_text": selected})
                        audit["status"] = "unresolved"
                    else:
                        replacement_html = html.escape(selected)
                        if mode == "native-script" and item.get("script_kind") in {"sup", "sub"}:
                            tag = item["script_kind"]
                            replacement_html = f'<{tag}>{replacement_html}</{tag}>'
                        if isinstance(segments, list) and segments:
                            parts = []
                            for segment in segments:
                                value = html.escape(str(segment.get("text") or ""))
                                tag = segment.get("script_kind")
                                parts.append(f'<{tag}>{value}</{tag}>' if tag in {"sup", "sub"} else value)
                            replacement_html = "".join(parts)
                        elif mode == "candidate-unresolved" or mode == "source-crop":
                            candidate = replacement["candidate"].strip()
                            delimited = re.fullmatch(r"\$(?!\$)([^$]+)\$|\\\((.*?)\\\)", candidate, re.S)
                            candidate_mathml = render_math(candidate) if mode == "candidate-unresolved" and delimited else ""
                            if candidate_mathml:
                                replacement_html = candidate_mathml
                                item["candidate_rendering"] = "mathml-unverified"
                            replacement_html = f'<span class="math-candidate-unresolved" data-math-status="unresolved" title="公式待核：请对照源 PDF">{replacement_html}</span>'
                            item["status"] = "unresolved"
                            audit["status"] = "unresolved"
                        markdown_image = replacement_html
                    markup = markup.replace(marker, replacement_html)
                    plain = plain.replace(marker, selected)
                    markdown_content = markdown_content.replace(marker, markdown_image)
                markup = re.sub(r"\\([$])", r"\1", markup)
                kind = {"text": "paragraph", "formula": "equation_interline", "title": "title", "heading": "title"}.get(label, label)
                reference_entry = reference_entries[pi, index]
                attrs = f'data-block-id="{block_id}" data-page="{pi}" data-bbox="{html.escape(json.dumps(box), quote=True)}"'
                if (pi, index) in caption_ids:
                    attrs += f' id="{caption_ids[pi, index]}"'
                if reference_entry["toc_heading"] or reference_entry["toc_entries"]:
                    attrs += ' data-reader-toc-excluded="contents"'
                elif reference_entry["table_heading"]:
                    attrs += ' data-reader-toc-excluded="table-content"'
                elif reference_entry["caption"]:
                    attrs += ' data-reader-toc-excluded="caption"'
                footnote = re.match(r"^\s*\[?(\d+)\]?[.)]?\s+", plain) if label == "footnote" else None
                if footnote:
                    attrs += f' id="fn-{footnote[1]}-{re.sub(r"[^A-Za-z0-9_-]", "-", reference_entry["scope"])}-p{pi}-{index}" data-footnote-number="{footnote[1]}"'
                record = {**block, "block_id": block_id, "index": index, "type": kind, "bbox": box, "coordinate_space": "normalized", "text": plain, "content": markdown_content, "math_audit": audit}
                algorithm = None
                if block.get("native_label") == "algorithm" and label == "text":
                    from .algorithm_text import restore_algorithm_text
                    from .native_pdf import NativePDF, NativePage
                    if native_fonts is None:
                        with NativePDF(pdf) as native_document:
                            native_fonts = (native_document.fonts, native_document.fonts_by_id)
                    if native_page is None or not native_page.fonts_by_id:
                        native_page = NativePage(page, *native_fonts)
                    algorithm = restore_algorithm_text(native_page, box, native_label="algorithm")
                if algorithm:
                    algorithm_html = algorithm["html"]
                    for item in algorithm["local_crops"]:
                        asset = crop(item["bbox"], block_id + "-" + item["id"], mathematical=True)
                        item.update({"source_asset": asset, "asset_provenance": math_assets[asset]})
                        line = next(line for line in algorithm["lines"] if set(item["source_glyph_ids"]).issubset(line["source_glyph_ids"]))
                        size = algorithm["body_font_size_points"]
                        height = (item["bbox"][3] - item["bbox"][1]) * page.height / size
                        offset = (item["bbox"][3] * page.height - line["baseline"]) / size
                        visual = f'<span class="math-source-visual" data-math-status="unresolved"><span class="math-source-text">[公式原图]</span><img class="math-source-inline" src="{asset}" alt="公式原图，识别待核" aria-hidden="true" data-height-em="{height:g}" data-baseline-offset-em="{offset:g}" style="height:{height:g}em;vertical-align:{-offset:g}em" loading="lazy"></span>'
                        algorithm_html = re.sub(r'<span[^>]*data-algorithm-crop-id="' + re.escape(item["id"]) + r'"[^>]*></span>', lambda _match: visual, algorithm_html)
                    fragment = f'<div class="pdf-algorithm" {attrs}>{algorithm_html}</div>'
                    markdown_content = algorithm_html
                    record.update({"render_mode": "native-algorithm", "algorithm_audit": {key: value for key, value in algorithm.items() if key != "html"}, "source_candidate_math_audit": audit})
                    audit = {"status": "unresolved" if algorithm["local_crops"] else "confirmed", "render_status": "native-algorithm", "local_crops": algorithm["local_crops"], "native_evidence": algorithm["evidence"]}
                elif reference_entry["toc_entries"]:
                    rows = reference_entry["toc_entries"]
                    items = []
                    for row in rows:
                        tag = "a" if row["target_verified"] else "span"
                        link = f' href="#{row["target_anchor"]}"' if row["target_verified"] else ""
                        cls = "toc-row toc-link" if row["target_verified"] else "toc-row"
                        body = f'<span class="toc-number">{html.escape(row["number"])}</span> <span class="toc-title">{html.escape(row["title"])}</span> <span class="toc-page-label">{html.escape(row["page_label"])}</span>'
                        items.append(f'<li data-toc-level="{row["level"]}" style="--toc-indent:{min(5, row["level"]-1)*1.25:g}em"><{tag} class="{cls}"{link}>{body}</{tag}></li>')
                    fragment = f'<nav class="paper-toc" aria-label="Contents" {attrs}><ol>\n' + "\n".join(items) + '</ol></nav>'
                    markdown_content = "\n".join("  " * (row["level"]-1) + (row["number"] + " " + row["title"]).strip() + " " + row["page_label"] for row in rows)
                    record.update({"type": "table_of_contents", "render_mode": "table-of-contents", "toc_entries": copy.deepcopy(rows), "reader_toc_excluded": "contents"})
                elif label in {"image", "table", "formula"}:
                    assignment = reference_assignments.get((pi, index))
                    prefix = {"image": "fig", "table": "table", "formula": "eq"}[label]
                    anchor = assignment["anchor"] if assignment else f"{prefix}-{block_id}"
                    record["anchor"] = anchor
                    if assignment:
                        group = assignment["group"]
                        record["anchor_group"] = group["anchor"]
                        record["caption_number"] = group["number"]
                        attrs += f' data-media-group="{group["anchor"]}"'
                        caption_id = caption_ids.get(group["caption_location"])
                        if caption_id:
                            attrs += f' data-caption-id="{caption_id}"'
                    if label == "image":
                        counts["images"] += 1
                        if composite:
                            render_box = composite["render_bbox"]
                            native_image = composite["native_image"]
                            asset = f"assets/images/{block_id}-figure.png"
                            if native_image is not None:
                                native_image.save(output / asset)
                                pixels = list(native_image.size)
                                provenance = {"kind": "pdf-embedded-image", "source_image_name": composite["native_source"].get("name"), "intrinsic_pixels": pixels, "render_dpi": None}
                            else:
                                if high_raster is None:
                                    high_raster = page.to_image(resolution=high_dpi, antialias=True).original.convert("RGB")
                                coordinates = (int(render_box[0]*high_raster.width), int(render_box[1]*high_raster.height), math.ceil(render_box[2]*high_raster.width), math.ceil(render_box[3]*high_raster.height))
                                figure = high_raster.crop(coordinates)
                                figure.save(output / asset)
                                pixels = list(figure.size)
                                provenance = {"kind": "pdf-render", "intrinsic_pixels": pixels, "render_dpi": high_dpi}
                            provenance.update({"effective_dpi": [pixels[0] * 72 / ((render_box[2]-render_box[0])*page.width), pixels[1] * 72 / ((render_box[3]-render_box[1])*page.height)], "target_pixels": 2160, "antialias": True if provenance["kind"] == "pdf-render" else None, "pixel_budget": 24_000_000, "max_edge": 6144})
                            aliases = []
                            for location in composite["components"]:
                                entry = reference_entries[location]
                                old_assignment = previous_reference_assignments.get(location)
                                alias = old_assignment["anchor"] if old_assignment else f'{"table" if entry["label"] == "table" else "fig"}-{source_ids[location]}' if entry["label"] in {"image", "table"} else None
                                original_component = source_pages[location[0]-1]["blocks"][location[1]]
                                if not alias and (entry["label"] in {"title", "heading"} or re.match(r"^#{1,6}\s", str(original_component.get("content") or ""))):
                                    alias = f'section-{source_ids[location]}'
                                if alias and alias != anchor:
                                    aliases.append(alias)
                                assignment_alias = reference_assignments.get(location, {}).get("anchor")
                                if assignment_alias and assignment_alias != anchor and assignment_alias not in aliases:
                                    aliases.append(assignment_alias)
                            alias_caption = caption_ids.get(composite["group"]["caption_location"])
                            alias_caption_attr = f' data-caption-id="{alias_caption}"' if alias_caption else ""
                            body = "".join(f'<span id="{alias}" class="figure-member-anchor" data-media-group="{anchor}"{alias_caption_attr}></span>' for alias in aliases) + f'<img src="{asset}" alt="" loading="lazy"><figcaption>{markup}</figcaption>'
                            group_metadata = {"anchor": anchor, "caption_block_id": source_ids[composite["group"]["caption_location"]], "component_block_ids": [source_ids[location] for location in composite["components"]], "component_locations": composite["components"], "component_source_labels": [reference_entries[location]["label"] for location in composite["components"]], "anchor_aliases": aliases}
                            record.update({"render_mode": "composite-figure", "source_block_bbox": box, "render_bbox": render_box, "bbox": render_box, "component_envelope_bbox": composite["bbox"], "source_ink_bbox": composite["source_ink_bbox"], "ink_expanded_edges": composite["ink_expanded_edges"], "figure_group": group_metadata, "asset_provenance": provenance})
                            attrs = attrs.replace(f'data-bbox="{html.escape(json.dumps(box), quote=True)}"', f'data-bbox="{html.escape(json.dumps(render_box), quote=True)}"')
                        else:
                            asset, provenance, render_box, ink_box = visual_crop(box, block_id, index)
                            record.update({"source_block_bbox": box, "render_bbox": render_box, "bbox": render_box, "source_ink_bbox": ink_box, "asset_provenance": provenance})
                            attrs = attrs.replace(f'data-bbox="{html.escape(json.dumps(box), quote=True)}"', f'data-bbox="{html.escape(json.dumps(render_box), quote=True)}"')
                            width = provenance["display_width_css_pixels"]
                            body = f'<img src="{asset}" alt="" style="width:{width}px" loading="lazy"><figcaption>{markup}</figcaption>'
                        markdown_content = f"![{plain}]({asset})"
                    elif label == "table":
                        counts["tables"] += 1
                        asset, provenance, render_box, ink_box = visual_crop(audit.get("fallback_bbox") or box, block_id, index)
                        record.update({"source_block_bbox": box, "render_bbox": render_box, "source_ink_bbox": ink_box, "asset_provenance": provenance})
                        width = provenance["display_width_css_pixels"]
                        if source_block_required:
                            body = f'<div class="table-source-primary"><img src="{asset}" alt="" style="width:{width}px"></div>'
                            record.update({"candidate_content": candidate_content, "render_mode": "source-block-crop", "bbox": render_box})
                            attrs = attrs.replace(f'data-bbox="{html.escape(json.dumps(box), quote=True)}"', f'data-bbox="{html.escape(json.dumps(render_box), quote=True)}"')
                            markdown_content = f"![原 PDF 表格]({asset})"
                            audit.update({"status": "unresolved", "render_status": "source-block-crop", "source_block_required": True, "source_asset": asset})
                        else:
                            body = f'<div class="table-scroll">{markup}</div><details class="source-crop"><summary>原 PDF 表格</summary><img src="{asset}" alt="" style="width:{width}px"></details>'
                        record["table_html"] = None if source_block_required else markup
                        if source_block_required:
                            record["table_html_status"] = "unsupported-source-primary"
                    else:
                        counts["display_formulas"] += 1
                        mathml = "" if source_block_required or audit.get("source_crop_required") else display_math(content, audit)
                        if mathml:
                            body, asset = mathml, None
                            record["render_mode"] = "mathml"
                            audit["render_status"] = "mathml"
                        else:
                            asset = crop(audit.get("fallback_bbox") or box, block_id, mathematical=True)
                            width = math_assets[asset]["display_width_css_pixels"]
                            body = f'<img src="{asset}" alt="原 PDF 公式，识别待核" style="width:{width}px" loading="lazy">'
                            record["asset_provenance"] = math_assets[asset]
                            record["candidate_content"] = content
                            markdown_content = f"![原 PDF 数学区域]({asset})"
                            record.update({"text": "", "content": markdown_content, "render_mode": "source-crop"})
                            audit.update({"status": "unresolved", "render_status": "source-crop", "source_crop_required": True, "source_asset": asset})
                            if not audit.get("reason"):
                                audit["reason"] = "mathml-renderer-unavailable-or-unsupported"
                    record.update({"visual_asset": asset, "image_path": asset, "visual_source": record.get("asset_provenance", {}).get("kind") or ("source-pdf" if label != "image" else "fusion-crop")})
                    css = {"image": "pdf-figure", "table": "pdf-table", "formula": "pdf-equation"}[label]
                    fragment = f'<figure class="{css}" id="{anchor}" {attrs}>{body}</figure>'
                elif kind == "title" or re.match(r"^#{1,6}\s", content):
                    heading = re.match(r"^(#{1,6})\s+(.*)", content, re.S)
                    depth = min(4, len(heading[1])) if heading else min(4, max(1, int(block.get("level") or (1 if pi == 1 and index == 0 else 2))))
                    if heading:
                        markup = re.sub(r"^#{1,6}\s+", "", markup)
                        plain = re.sub(r"^#{1,6}\s+", "", plain)
                        record["text"] = plain
                    title_class = ' class="paper-title"' if reference_entry["paper_title"] else ""
                    heading_id = "" if (pi, index) in caption_ids else f' id="section-{block_id}"'
                    fragment = f'<h{depth}{title_class}{heading_id} {attrs}>{markup}</h{depth}>'
                    record["type"] = "title"
                else:
                    footnote_class = ' class="footnote"' if footnote else ""
                    fragment = f'<p{footnote_class} {attrs}>{markup}</p>'
                if label in {"aside_text", "page_header", "page_footer", "page_number"}:
                    fragment, markdown_content = "", ""
                    record["render_mode"] = "suppressed-margin"
                record["reference_scope"] = reference_entry["scope"]
                if reference_entry["toc_heading"]:
                    record["reader_toc_excluded"] = "contents"
                record["reference_section"] = reference_entry["references"]
                record["html"] = fragment
                record["source_content"] = original.get("content")
                record["text"] = text_content(fragment)
                record["markdown"] = markdown_content
                record["content"] = markdown_content
                record["math_audit"] = audit
                if audit:
                    math_audits.append({"page": pi, "block_id": block_id, **audit})
                records.append(record)
                ir_elements.append({**record, "id": block_id, "page": pi, "source": engine, "reading_order": index, "render": {"html": fragment, "markdown": markdown_content}, "style_spans": block.get("style_spans", [])})
                rendered.append(fragment)
                markdown.append(markdown_content)
                if block.get("review_flags") or audit.get("status") in {"unresolved", "unsupported"}:
                    warnings.append(f"page {pi} block {index}: review evidence")
            pages.append({**original_page, "page": pi, "elements": records, "blocks": records, "thumbnail": thumb_path})
            ir_pages.append({"page": pi, "width": page.width, "height": page.height, "coordinate_origin": "top-left", "coordinate_space": "normalized", "elements": ir_elements})
            html_pages.append(f'<section class="pdf-page" id="page-{pi}" data-page="{pi}">' + "\n".join(rendered) + '</section>')
            md_pages.append(f"<!-- PDF page {pi} -->\n\n" + "\n\n".join(markdown))
            for composite in page_composites:
                native_image = composite.pop("native_image", None)
                if native_image is not None:
                    native_image.close()
                composite.pop("native_source", None)
            if high_raster is not None:
                high_raster.close()
            page.close()
    html_pages = []
    for pi, (page, ir_page) in enumerate(zip(pages, ir_pages), 1):
        for index, (record, ir_element) in enumerate(zip(page["elements"], ir_page["elements"])):
            entry = reference_entries[pi, index]
            fragment = cross_references(record["html"], entry, reference_groups)
            location = (pi, index)
            if location in duplicate_references:
                fragment = f'<span class="reference-aggregate-anchor" data-block-id="{record["block_id"]}" aria-hidden="true"></span>'
                record["render_mode"] = "suppressed-reference-aggregate"
                record["suppression_evidence"] = duplicate_references[location]
                record["markdown"] = ""
                ir_element.update({"render_mode": record["render_mode"], "suppression_evidence": record["suppression_evidence"]})
                ir_element["render"]["markdown"] = ""
            elif entry["references"] or entry["label"] == "reference":
                numbers = {number for number, target in bibliography_targets.items() if target == location}
                fragment = re.sub(r"(<(?:p|div)\b[^>]*>)(.*?)(</(?:p|div)>)", lambda match: match[1] + bibliography_anchors(match[2], numbers) + match[3], fragment, flags=re.S)
                if len(numbers) == 1:
                    number = next(iter(numbers))
                    fragment = re.sub(r"(<(?:p|div)\b)", rf'\1 id="ref-{number}" data-ref="{number}" class="reference-item"', fragment, count=1) if f'id="ref-{number}"' not in fragment else fragment
                record["reference_numbers"] = sorted(numbers)
                ir_element["reference_numbers"] = sorted(numbers)
            else:
                fragment = citation_links(fragment, bibliography_targets)
            record["html"] = fragment
            ir_element["html"] = fragment
            ir_element["render"]["html"] = fragment
        html_pages.append(f'<section class="pdf-page" id="page-{pi}" data-page="{pi}">' + "\n".join(record["html"] for record in page["elements"]) + '</section>')
    css = """body{margin:0;background:var(--paper,#faf9f6);color:var(--ink,#242323);font-family:var(--paper-font,Georgia,'Times New Roman',serif);font-size:calc(18px * var(--reader-font-scale,1));line-height:var(--reader-line-height,1.7)}.reader-content{max-width:960px;margin:auto;padding:40px}.pdf-page{padding:12px 0}h1,h2,h3,h4{line-height:1.3}h1{font-size:2em}.paper-toc{font-size:1em;line-height:1.55}.paper-toc ol{list-style:none;padding:0;margin:.6em 0}.paper-toc li{padding:.2em 0 .2em var(--toc-indent,0)}.toc-row{display:grid;grid-template-columns:minmax(2.8em,max-content) minmax(0,1fr) max-content;column-gap:.6em;color:inherit;text-decoration:none}.toc-link:hover .toc-title{text-decoration:underline}.toc-page-label{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.toc-title{overflow-wrap:anywhere}p{white-space:normal;overflow-wrap:anywhere}.reference-item{margin:.55em 0}.reference-aggregate-anchor{display:none}.pdf-page{padding:0}.pdf-page>:first-child{margin-top:0}.pdf-page>:last-child{margin-bottom:0}figure{margin:24px 0}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--line,#ddd);padding:6px}table p{margin:0}.table-scroll{overflow:auto}.pdf-equation{text-align:center;overflow-x:auto}.equation-layout{display:grid;grid-template-columns:minmax(max-content,1fr) max-content;align-items:center;column-gap:1.5em;padding:.25em 0}.equation-body{min-width:max-content;overflow:visible}.equation-body math{margin:0}.equation-number{white-space:nowrap;font-variant-numeric:tabular-nums}.math-source-visual{display:inline;position:relative}.math-source-text{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.math-source-inline{display:inline;max-height:3.6em;max-width:100%;width:auto}.source-crop{font-size:.8em;color:#666}u{text-underline-offset:.14em}math{font-size:1.08em}strong{font-weight:700}@media(prefers-color-scheme:dark){:root{--paper:#1e2124;--ink:#dcdcde;--line:#55462f;--soft:#32281a}}"""
    document_html = f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' data:; style-src \'unsafe-inline\'"><title>{html.escape(title)}</title><style>{css}</style></head><body><main class="reader-content">' + "\n".join(html_pages) + '</main></body></html>'
    validation = {"status": "REVIEW" if warnings else "PASS", "warnings": warnings, "source_sha256": source_sha, "page_coverage": len(pages), "math_audit": math_audits, "bibliography": {"known_references": sorted(bibliography_targets), "suppressed_aggregates": len(duplicate_references)}}
    metadata = {**fusion, "pages": pages, "summary": counts, "backend": engine, "ir_version": 5, "source_sha256": source_sha, "source_filename": title, "math_audit": math_audits}
    save_json(output / "document.json", metadata)
    save_json(output / "document-ir.json", {"ir_version": 5, "backend": engine, "pages": ir_pages, "suppressed": [], "quality": validation})
    save_json(output / "validation.json", validation)
    (output / "document.html").write_text(document_html, encoding="utf-8")
    (output / "document.md").write_text("\n\n".join(f'<!-- PDF page {page["page"]} -->\n\n' + "\n\n".join(record["markdown"] for record in page["elements"] if record["markdown"]) for page in pages) + "\n", encoding="utf-8")
    save_json(output / "manifest.json", {"job_id": job_id, "source": {"filename": title, "bytes": pdf.stat().st_size, "sha256": source_sha}, "engine": {"name": engine}, "counts": counts, "assets": {"images": sorted(str(p.relative_to(output)) for p in images.iterdir()), "page_thumbnails": page_assets}, "outputs": ["document.html", "document.json", "document-ir.json", "validation.json", "source.pdf", "document.md"], "validation": validation})
    return validation


def _cached_records(page):
    return page.get("blocks", page.get("elements", []))


def _cached_source_pages(document):
    # Source candidates are used only to locate captions and bibliography entries.
    # They must never replace the already corrected text or math renderings.
    return [{**page, "blocks": [{**record, "label": record.get("label") or {"paragraph": "text", "equation_interline": "formula"}.get(record.get("type"), record.get("type", "text")), "content": record.get("source_content", record.get("content", record.get("text", "")))} for record in _cached_records(page)]} for page in document["pages"]]


def _cached_native_reference_duplicates(pdf, source_pages):
    candidates = [(pi, page) for pi, page in enumerate(source_pages, 1) if {"reference", "footnote"} <= {block.get("label") for block in page["blocks"]}]
    if not candidates:
        return []
    import pypdfium2 as pdfium

    proposals = []
    with pdfium.PdfDocument(pdf) as source:
        for pi, page_data in candidates:
            page = source[pi-1]
            text = page.get_textpage()
            width, height = page.get_size()
            try:
                def native_text(bounds):
                    return text.get_text_bounded(left=bounds[0]*width, bottom=(1-bounds[3])*height, right=bounds[2]*width, top=(1-bounds[1])*height)
                proposals.extend({"page": pi, **proposal} for proposal in native_reference_duplicates(page_data["blocks"], native_text))
            finally:
                text.close()
                page.close()
    return proposals


def _cached_figure_patches(pdf, source_pages, records, output):
    """Recompose only figures proved by saved blocks and native PDF frames."""
    import pypdfium2 as pdfium

    entries, assignments, groups = reference_layout(source_pages)
    composites = composite_figures(entries, assignments, groups, lambda page: source_figure_frames(pdf, page))
    patches, assets = {}, []
    if not composites:
        return patches, assets
    with pdfium.PdfDocument(pdf) as source:
        for composite in composites:
            host = records[composite["host"]]
            old_html = host.get("html", "")
            if not old_html or not re.search(r"<img\b", old_html):
                continue
            locations = composite["components"]
            # A math-bearing paragraph remains in its verified rendering.
            # Tables enter a composite only through the native frame evidence.
            if any(records[location].get("math_audit") and entries[location]["label"] not in {"image", "table"} for location in locations):
                continue
            outside = [entry for location, entry in entries.items() if entry["page"] == composite["host"][0] and location not in locations]
            bounds = source_figure_ink_bounds(pdf, composite["host"][0], composite["bbox"], outside)
            old_bounds = host.get("render_bbox")
            old_components = set(host.get("figure_group", {}).get("component_block_ids", []))
            component_ids = [records[location]["block_id"] for location in locations]
            if old_bounds and all(old_bounds[i] <= bounds[i]+1e-5 for i in (0, 1)) and all(old_bounds[i] >= bounds[i]-1e-5 for i in (2, 3)) and set(component_ids).issubset(old_components):
                continue
            page = source[composite["host"][0]-1]
            width, height = page.get_size()
            dpi = bounded_visual_dpi(width, height, max(288., 2160*72/((bounds[2]-bounds[0])*width)))
            bitmap = page.render(scale=dpi/72, crop=(bounds[0]*width, (1-bounds[3])*height, (1-bounds[2])*width, bounds[1]*height))
            asset = f'assets/images/{host["block_id"]}-cached-figure.png'
            (output / asset).parent.mkdir(parents=True, exist_ok=True)
            image = bitmap.to_pil()
            pixels = list(image.size)
            image.save(output / asset)
            image.close()
            bitmap.close()
            page.close()
            fragment = re.sub(r'(<img\b[^>]*\bsrc=")[^"]*(")', lambda match: match[1] + asset + match[2], old_html, count=1)
            fragment = re.sub(r'(<img\b[^>]*?)\sstyle="[^"]*"', r'\1', fragment, count=1)
            aliases = []
            for location in locations:
                if location == composite["host"]:
                    continue
                original = records[location].get("html", "")
                aliases.extend(re.findall(r'(?<![-\w])id="([^"]+)"', original))
                if original:
                    patches[location] = {"html": f'<span class="figure-member-anchor" data-block-id="{records[location]["block_id"]}" aria-hidden="true"></span>', "cached_display": {"mode": "figure-component", "parent_block_id": host["block_id"]}}
            aliases = [alias for alias in dict.fromkeys(aliases) if f'id="{alias}"' not in fragment]
            fragment = re.sub(r'(<figure\b[^>]*>)', lambda match: match[1] + "".join(f'<span id="{html.escape(alias, quote=True)}" class="figure-member-anchor"></span>' for alias in aliases), fragment, count=1)
            patches[composite["host"]] = {"html": fragment, "cached_display": {"mode": "composite-figure", "render_bbox": bounds, "component_block_ids": component_ids, "asset": asset, "asset_provenance": {"kind": "pdf-render", "render_dpi": dpi, "intrinsic_pixels": pixels, "source_bbox": bounds}}}
            assets.append(asset)
    return patches, assets


def reexport_document(exported_dir, output, source_pdf=None):
    """Patch a complete cached reader package without rerunning extraction."""
    exported_dir, output = Path(exported_dir), Path(output)
    job_file = exported_dir / "job.json"
    if job_file.is_file():
        active_render = json.loads(job_file.read_text()).get("active_render")
        if active_render is not None:
            raise ValueError(f"Cached refresh cannot use a job container; use its active render package: {exported_dir / 'renders' / str(active_render)}")
    if output.resolve() == exported_dir.resolve() or output.resolve().is_relative_to(exported_dir.resolve()):
        raise ValueError("Cached refresh output must be outside the input package")
    if output.exists():
        raise FileExistsError(output)
    document = json.loads((exported_dir / "document.json").read_text())
    def cached_json(name, default):
        path = exported_dir / name
        return json.loads(path.read_text()) if path.is_file() else default
    manifest = cached_json("manifest.json", {})
    ir = cached_json("document-ir.json", {"pages": []})
    validation = cached_json("validation.json", {})
    raw = (exported_dir / "document.html").read_text()
    source_pages = _cached_source_pages(document)
    records = {(pi, index): record for pi, page in enumerate(document["pages"], 1) for index, record in enumerate(_cached_records(page))}
    expected_ids = [record.get("block_id", record.get("id")) for record in records.values()]
    for record in records.values():
        if record.get("html") and record["html"] not in raw:
            raise ValueError("Cached HTML no longer matches its saved block records")
    entries, _, _ = reference_layout(source_pages)
    targets, duplicates = bibliography_layout(entries, source_pages)
    pdf = Path(source_pdf) if source_pdf else exported_dir / "source.pdf"
    if (source_pdf or pdf.is_file()) and manifest.get("source", {}).get("sha256") and hashlib.sha256(pdf.read_bytes()).hexdigest() != manifest["source"]["sha256"]:
        raise ValueError("Cached refresh source PDF identity mismatch")
    native_duplicates = _cached_native_reference_duplicates(pdf, source_pages) if pdf.is_file() else []
    native_members = {}
    for proposal in native_duplicates:
        canonical = proposal["page"], proposal["canonical_index"]
        if canonical in duplicates:
            continue
        region_members = {canonical, *((proposal["page"], index) for index in proposal["suppressed_indices"])}
        for number in proposal["reference_numbers"]:
            if targets.get(number) in region_members:
                targets[number] = canonical
        for index in proposal["suppressed_indices"]:
            native_members[proposal["page"], index] = proposal
    reference_headings = [entry["order"] for entry in entries.values() if re.fullmatch(r"References?|Bibliography", entry["plain"], re.I)]
    multiple_bibliographies = len(reference_headings) > 1
    first_bibliography = min(reference_headings, default=float("inf"))
    footnotes = {}
    for location, entry in entries.items():
        fragment = records[location].get("html", "")
        explicit_numbers = re.findall(r'data-footnote-number="(\d+)"', fragment)
        if explicit_numbers:
            footnotes.setdefault(entry["page"], set()).update(map(int, explicit_numbers))
        elif entry["label"] == "footnote" or re.search(r'class="[^"]*\bfootnote\b', fragment):
            match = re.match(r"\s*\[?(\d+)\]?[.)]?\s+", entry["plain"])
            if match:
                footnotes.setdefault(entry["page"], set()).add(int(match[1]))
    patches = {}
    for location, record in records.items():
        original = record.get("html", "")
        if not original:
            continue
        entry = entries[location]
        if location in native_members:
            evidence = native_members[location]
            canonical = records[evidence["page"], evidence["canonical_index"]]
            aliases = [identity for identity in re.findall(r'(?<![-\w])id="([^"]+)"', original) if not re.fullmatch(r"ref-\d+", identity)]
            fragment = f'<span class="reference-member-anchor" data-block-id="{record["block_id"]}" aria-hidden="true">' + "".join(f'<span id="{html.escape(identity, quote=True)}"></span>' for identity in dict.fromkeys(aliases)) + '</span>'
            patches[location] = {"html": fragment, "cached_display": {"mode": "suppressed-reference-member", "parent_block_id": canonical["block_id"], "evidence": evidence}}
            continue
        if location in duplicates:
            patches[location] = {"html": f'<span class="reference-aggregate-anchor" data-block-id="{record["block_id"]}" aria-hidden="true"></span>', "cached_display": {"mode": "suppressed-reference-aggregate", "evidence": duplicates[location]}}
            continue
        numbers = {number for number, target in targets.items() if target == location}
        if entry["references"] or entry["label"] == "reference" or is_bibliography_entry(original):
            missing = {number for number in numbers if not re.search(rf'(?<![-\w])id="ref-{number}"', original)}
            fragment = re.sub(r"(<(?:p|div)\b[^>]*>)(.*?)(</(?:p|div)>)", lambda match: match[1] + bibliography_anchors(match[2], missing) + match[3], original, flags=re.S)
        elif entry["label"] == "footnote" or re.search(r'class="[^"]*\bfootnote\b|data-footnote-number=', original):
            fragment = original
        elif multiple_bibliographies and entry["order"] >= first_bibliography:
            fragment = original
        else:
            fragment = citation_links(original, targets, superscript=entry["label"] != "footnote", footnote_numbers=footnotes.get(entry["page"], ()))
        if fragment != original:
            patches[location] = {"html": fragment}
    shutil.copytree(exported_dir, output)
    if source_pdf:
        shutil.copy2(pdf, output / "source.pdf")
    assets = []
    if str(document.get("backend", "")).startswith("guzi-fusion-") and pdf.is_file():
        figure_patches, assets = _cached_figure_patches(pdf, source_pages, records, output)
        patches.update(figure_patches)
    ir_records = {record.get("block_id", record.get("id")): record for page in ir["pages"] for record in page.get("elements", page.get("blocks", []))}
    for location, changes in patches.items():
        record = records[location]
        original = record["html"]
        if original not in raw:
            raise ValueError("Cached fragment replacement is ambiguous")
        raw = raw.replace(original, changes["html"], 1)
        identity = record.get("block_id", record.get("id"))
        record.update(changes)
        page = document["pages"][location[0]-1]
        for key in ("blocks", "elements"):
            for peer in page.get(key, []):
                if peer.get("block_id", peer.get("id")) == identity:
                    peer.update(changes)
        if identity in ir_records:
            ir_record = ir_records[identity]
            ir_record.update(changes)
            if "render" in ir_record:
                ir_record["render"]["html"] = changes["html"]
    flow_css = '<style id="guzi-cached-flow">.reader-content .pdf-page{padding-top:0;padding-bottom:0;min-height:0;height:auto}.reader-content .pdf-page>:first-child{margin-top:0}.reader-content .pdf-page>:last-child{margin-bottom:0}.reader-content p{white-space:normal;overflow-wrap:anywhere}.reference-aggregate-anchor{display:none}.figure-member-anchor{display:inline}</style>'
    if 'id="guzi-cached-flow"' not in raw:
        raw = raw.replace("</head>", flow_css + "</head>", 1)
    actual_ids = [record.get("block_id", record.get("id")) for page in document["pages"] for record in _cached_records(page)]
    if actual_ids != expected_ids:
        raise ValueError("Cached refresh changed stable block IDs")
    audit = {"mode": "preserve-cached-rendering", "inference_performed": False, "backend_preserved": True, "block_ids_preserved": True, "math_evidence_preserved": True, "changed_blocks": len(patches), "figure_assets": assets, "bibliography": {"known_references": sorted(targets), "suppressed_aggregates": len(duplicates), "native_reference_regions": native_duplicates, "suppressed_reference_members": len(native_members), "later_scopes_deferred": multiple_bibliographies}}
    validation["cached_refresh"] = audit
    document["cached_refresh"] = audit
    document.setdefault("summary", {})["references"] = len(targets)
    manifest.setdefault("counts", {})["references"] = len(targets)
    manifest["validation"] = validation
    manifest.setdefault("assets", {}).setdefault("images", []).extend(asset for asset in assets if asset not in manifest.get("assets", {}).get("images", []))
    if "citation_audit" in document:
        document["citation_audit"]["known_references"] = sorted(targets)
        document["citation_audit"]["unresolved"] = [value for value in document["citation_audit"].get("unresolved", []) if not (re.fullmatch(r"ref-\d+", value) and int(value[4:]) in targets)]
    save_json(output / "document.json", document)
    for name, value in (("document-ir.json", ir), ("manifest.json", manifest), ("validation.json", validation)):
        if (exported_dir / name).is_file():
            save_json(output / name, value)
    (output / "document.html").write_text(raw, encoding="utf-8")
    provenance_file = output / "provenance.json"
    provenance = json.loads(provenance_file.read_text()) if provenance_file.exists() else {}
    provenance.setdefault("local_refreshes", []).append({**audit, "renderer_files": {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in ("exporter.py", "bibliography.py")}})
    save_json(provenance_file, provenance)
    return {**validation, "known_references": sorted(targets)}


def refresh_cached_layout(exported_dir, output):
    """Apply conservative cached repairs; no parser/backend fallback is allowed."""
    return reexport_document(exported_dir, output)


def zip_result(directory, target):
    directory, target = Path(directory), Path(target)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_file() and not path.is_symlink():
                archive.write(path, str(path.relative_to(directory)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--fusion-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--title")
    parser.add_argument("--job-id")
    args = parser.parse_args()
    export_document(args.pdf, args.fusion_dir, args.output, args.title, args.job_id)


if __name__ == "__main__":
    main()
