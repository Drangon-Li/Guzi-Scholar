"""Numbered bibliography evidence shared by fusion and local re-export."""
import html
import re
import unicodedata
from difflib import SequenceMatcher


ENTRY_RE = re.compile(r"(?m)^\s*(?:\[(\d+)\]|(\d+)[.)])\s+")
CITATION_RE = re.compile(r"(?<![\w])\[(\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–—]\s*\d+)?)*)\]")
NUMERIC_CITATION_RE = re.compile(r"\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,;]\s*\d+(?:\s*[-–—]\s*\d+)?)*")


def plain_content(content):
    return html.unescape(re.sub(r"<[^>]*>", "", str(content or "")))


def is_bibliography_heading(content):
    text = unicodedata.normalize("NFKC", plain_content(content)).strip()
    text = re.sub(r"^#{1,6}\s+", "", text).strip()
    text = re.sub(r"^\d+(?:\.\d+)*(?:[.)、:]\s*|\s+)", "", text)
    english = r"(?:References?|Bibliography)"
    chinese = r"(?:参考文献|參考文獻)"
    separator = r"(?:\s*[/|:—–-]\s*|\s+)"
    bilingual = rf"(?:{chinese}{separator}{english}|{english}{separator}{chinese}|{chinese}\s*\(\s*{english}\s*\)|{english}\s*\(\s*{chinese}\s*\))"
    continuation = r"(?:continued|cont\.?|cont['’]d\.?|续|續)"
    suffix = rf"(?:\s*\(\s*{continuation}\s*\)|\s*\[\s*{continuation}\s*\]|\s+{continuation}|\s*[-—–:]\s*{continuation})?"
    return bool(re.fullmatch(rf"(?:{english}|{chinese}|{bilingual}){suffix}[\s.:。]*", text, re.I))


def reference_numbers(content):
    return [int(match[1] or match[2]) for match in ENTRY_RE.finditer(plain_content(content))]


def is_bibliography_entry(content):
    text = plain_content(content).strip()
    return bool(ENTRY_RE.match(text) and len(text) >= 30 and re.search(r"\b(?:18|19|20)\d{2}\b|https?://|\bdoi\b", text, re.I))


def aggregate_reference_duplicates(blocks):
    def box(block):
        value = block.get("source_bbox_normalized") or block.get("normalized_bbox")
        return list(value) if value else [float(x) / 1000 for x in block.get("bbox_2d", [0, 0, 0, 0])]

    def area(bounds):
        return max(0, bounds[2]-bounds[0]) * max(0, bounds[3]-bounds[1])

    def norm(content):
        return re.sub(r"\s+", "", unicodedata.normalize("NFKC", plain_content(content))).casefold()

    proposals = []
    for i, aggregate in enumerate(blocks):
        if aggregate.get("label") != "reference":
            continue
        parent = box(aggregate)
        candidates = []
        for j, block in enumerate(blocks):
            child = box(block)
            # Independent OCR boxes drift by a few thousandths at page edges.
            overlap = [max(parent[0]-.004, child[0]), max(parent[1]-.004, child[1]), min(parent[2]+.004, child[2]), min(parent[3]+.004, child[3])]
            if j != i and block.get("label") in {"text", "reference"} and 0 < area(child) < area(parent)*.6 and area(overlap)/area(child) >= .9:
                candidates.append((j, block))
        if len(candidates) < 3:
            continue
        original_numbers = reference_numbers(aggregate.get("content"))
        child_numbers = [number for _, block in candidates for number in reference_numbers(block.get("content"))]
        # Older GLM outputs concatenate bracketed entries onto one line.
        if len(original_numbers) < 3:
            original_numbers = [int(n) for n in re.findall(r"\[(\d+)\]", plain_content(aggregate.get("content")))]
        unnumbered = not original_numbers and not child_numbers
        if not unnumbered and (len(original_numbers) < 3 or original_numbers != child_numbers):
            continue
        original = norm(aggregate.get("content"))
        children = norm("".join(str(block.get("content") or "") for _, block in candidates))
        if not original or not children:
            continue
        if unnumbered and (len(original) < 200 or any(len(plain_content(block.get("content"))) < 30 for _, block in candidates)):
            continue
        matching = sum(match.size for match in SequenceMatcher(None, original, children, autojunk=False).get_matching_blocks())
        coverage = min(matching/len(original), matching/len(children))
        if coverage >= .97:
            proposals.append({"aggregate_index": i, "retained_indices": [j for j, _ in candidates], "content_coverage": coverage, "reason": "same_page_reference_aggregate_duplicates_finer_blocks"})
    return proposals


def native_reference_duplicates(blocks, native_text):
    def normalized(value):
        return re.sub(r"\s+", "", unicodedata.normalize("NFKC", plain_content(value))).casefold()

    def numbered_entries(value):
        text = plain_content(value)
        markers = list(ENTRY_RE.finditer(text))
        return {int(marker[1] or marker[2]): text[marker.start():markers[index+1].start() if index+1 < len(markers) else len(text)] for index, marker in enumerate(markers)}

    proposals = []
    for index, aggregate in enumerate(blocks):
        canonical = numbered_entries(aggregate.get("content"))
        bounds = aggregate.get("source_bbox_normalized") or aggregate.get("normalized_bbox")
        if aggregate.get("label") != "reference" or len(canonical) < 2 or not bounds:
            continue
        region = [max(0, bounds[0]-.004), max(0, bounds[1]-.004), min(1, bounds[2]+.004), min(1, bounds[3]+.004)]
        candidates = []
        for child_index, block in enumerate(blocks):
            child = block.get("source_bbox_normalized") or block.get("normalized_bbox")
            entries = numbered_entries(block.get("content"))
            if block.get("label") != "footnote" or not child or not entries or not entries.keys() <= canonical.keys():
                continue
            area = max(0, child[2]-child[0]) * max(0, child[3]-child[1])
            overlap = max(0, min(region[2], child[2])-max(region[0], child[0])) * max(0, min(region[3], child[3])-max(region[1], child[1]))
            if not area or overlap / area < .9:
                continue
            coverage = min(SequenceMatcher(None, normalized(value), normalized(canonical[number]), autojunk=False).ratio() for number, value in entries.items())
            if coverage >= .85:
                candidates.append((child_index, coverage))
        if not candidates:
            continue
        native = native_text(region)
        # The whole canonical list must occur in the PDF region. Geometry and
        # matching numbers alone cannot establish that a footnote is redundant.
        if not native or normalized(aggregate.get("content")) not in normalized(native):
            continue
        proposals.append({"canonical_index": index, "suppressed_indices": [child for child, _ in candidates], "reference_numbers": list(canonical), "native_bbox": region, "native_text": native, "minimum_entry_similarity": min(coverage for _, coverage in candidates), "reason": "overlapping_reference_footnotes_with_pdf_native_canonical"})
    return proposals


def bibliography_layout(entries, source_pages):
    duplicates = {}
    for pi, page in enumerate(source_pages, 1):
        for proposal in aggregate_reference_duplicates(page["blocks"]):
            duplicates[pi, proposal["aggregate_index"]] = proposal
            for index in proposal["retained_indices"]:
                # An explicit reference aggregate can contain explanatory
                # headings that interrupted the generic section walk.
                entries[pi, index]["references"] = True
    known_numbers = {number for location, entry in entries.items() if location not in duplicates and (entry["references"] or entry["label"] == "reference") and not is_bibliography_heading(entry["plain"]) for number in reference_numbers(entry["plain"])}
    for entry in entries.values():
        # Fine OCR entries can follow explanatory headings inside a bibliography.
        if is_bibliography_entry(entry["plain"]) and set(reference_numbers(entry["plain"])) <= known_numbers:
            entry["references"] = True
    targets = {}
    for location, entry in entries.items():
        if location in duplicates or not (entry["references"] or entry["label"] == "reference") or is_bibliography_heading(entry["plain"]):
            continue
        for number in reference_numbers(entry["plain"]):
            targets.setdefault(number, location)
    return targets, duplicates


def citation_links(markup, targets, *, superscript=False, footnote_numbers=()):
    if is_bibliography_entry(markup):
        return markup

    def linked_numbers(value, excluded=()):
        for token in re.split(r"\s*[,;]\s*", value):
            numbers = [int(n) for n in re.split(r"\s*[-–—]\s*", token)]
            start, end = (numbers[0], numbers[-1])
            # A group containing zero or a missing target may be a mathematical
            # interval. Do not partially turn it into a plausible citation.
            if start <= 0 or end < start or end-start > 1000 or any(n not in targets or n in excluded for n in range(start, end+1)):
                return value
        return re.sub(r"\d+", lambda match: f'<a class="citation" href="#ref-{int(match[0])}" data-ref="{int(match[0])}">{match[0]}</a>', value)

    def replace(match):
        return "[" + linked_numbers(match[1]) + "]"

    result, protected, stack = [], [], []
    previous_text = ""
    for part in re.split(r"(<[^>]*>)", markup):
        if part.startswith("<"):
            tag = re.match(r"<\s*(/?)\s*([A-Za-z][\w-]*)", part)
            if tag:
                name = tag[2].lower()
                if tag[1]:
                    if name in stack:
                        stack = stack[:len(stack)-1-stack[::-1].index(name)]
                    if name in protected:
                        protected = protected[:len(protected)-1-protected[::-1].index(name)]
                elif not part.rstrip().endswith("/>"):
                    stack.append(name)
                    if name in {"math", "a", "code", "pre", "table"}:
                        protected.append(name)
            result.append(part)
        else:
            linked = part if protected else CITATION_RE.sub(replace, part)
            if superscript and not protected and stack and stack[-1] == "sup" and NUMERIC_CITATION_RE.fullmatch(part.strip()):
                prefix = plain_content(previous_text).rstrip()
                word = re.search(r"([A-Za-z][\w-]*)[\s,.)\]]*$", prefix)
                # Affiliations, powers and physical units also use <sup>. Only
                # prose trailing a substantive word is sufficient evidence.
                prose_words = re.findall(r"\b[a-z][a-z-]{2,}\b", prefix)
                starts_with_sup = bool(re.match(r"\s*(?:<[^>]+>\s*)*<sup\b", markup, re.I))
                if len(prefix) >= 60 and len(prose_words) >= 5 and word and len(word[1]) >= 3 and word[1].lower() not in {"cm", "mm", "nm", "km", "mol"} and not starts_with_sup and not re.search(r"[†✉*∗]", plain_content(markup)):
                    linked = part.replace(part.strip(), linked_numbers(part.strip(), footnote_numbers), 1)
            result.append(linked)
            if not stack or stack[-1] != "sup":
                previous_text += part
    return "".join(result)


def bibliography_anchors(markup, numbers):
    marker = re.compile(r"(?m)(^|\n)(\s*(?:<(?:strong|em|b|i)>)*)(\[(\d+)\]|(\d+)[.)])(?=\s|<)")
    def replace(match):
        number = int(match[4] or match[5])
        anchor = f'<span id="ref-{number}" data-ref="{number}"></span>' if number in numbers else ""
        return match[1] + anchor + match[2] + match[3]
    return marker.sub(replace, markup)
