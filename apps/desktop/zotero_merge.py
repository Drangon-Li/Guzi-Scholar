"""Durable, additive import of Zotero reading data into one local document."""
from __future__ import annotations

import copy
import difflib
import hashlib
import html
import json
import math
import os
import re
import threading
import uuid
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote as urlquote, urlsplit

from content_store import _active_conversion_root, _sync_content_file
from annotation_style_sync import _sync_directory
from pipeline import utc_now

IMPORT_LOCK = threading.RLock()
MAX_NOTES_CHARS = 2_000_000
MAX_ANNOTATION_CHARS = 10_000


def _identity(source: str, kind: str, key: str) -> str:
    return hashlib.sha256(f'{source}\n{kind}\n{key}'.encode()).hexdigest()[:32]


def _atomic_write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as handle:
            handle.write(json.dumps(value, ensure_ascii=False, indent=2) if not isinstance(value, str) else value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path, default):
    if not path.is_file():
        return copy.deepcopy(default)
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ValueError(f'无法读取 {path.name}；为保留现有内容，已停止 Zotero 合并。') from exc


def _sidecar(job_dir: Path) -> dict:
    value = _read_json(job_dir / 'zotero-import.json', {'version': 1, 'sources': {}})
    if not isinstance(value, dict) or not isinstance(value.get('sources'), dict):
        raise ValueError('Zotero 导入记录格式无效，已停止合并。')
    return value


def stage_import(job_dir: Path, package: dict) -> dict:
    source = str(package.get('source_id') or '').strip() if isinstance(package, dict) else ''
    if not source or not package.get('library_id'):
        raise ValueError('Zotero 导入缺少来源或文库标识。')
    digest = hashlib.sha256(json.dumps(package, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    with IMPORT_LOCK:
        data = _sidecar(job_dir)
        previous = data['sources'].get(source)
        if previous and previous.get('fingerprint') == digest:
            return {'source_id': source, 'status': previous.get('status', 'pending'), 'duplicate': True}
        entry = copy.deepcopy(previous or {})
        if previous:
            entry.setdefault('history', []).append({'fingerprint': previous.get('fingerprint'), 'package': previous['package'], 'staged_at': previous.get('staged_at')})
        entry.update(package=copy.deepcopy(package), fingerprint=digest, status='pending', staged_at=utc_now())
        data['sources'][source] = entry
        _atomic_write(job_dir / 'zotero-import.json', data)
        return {'source_id': source, 'status': 'pending', 'duplicate': False}


def _markdown_text(value: str) -> str:
    value = html.escape(str(value), quote=False)
    return re.sub(r'([\\`*\[\]_])', r'\\\1', value)


class _NoteMarkdown(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []
        self.suppressed = []
        self.links = []
        self.warnings = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.suppressed:
            if tag in {'script', 'style', 'iframe', 'object'}:
                self.suppressed.append(tag)
            return
        if tag in {'script', 'style', 'iframe', 'object'}:
            self.suppressed.append(tag)
            return
        if tag in {'p', 'div', 'section'}:
            self.parts.append('\n\n')
        elif re.fullmatch(r'h[1-6]', tag):
            self.parts.append('\n\n' + '#' * int(tag[1]) + ' ')
        elif tag in {'strong', 'b'}:
            self.parts.append('**')
        elif tag in {'em', 'i'}:
            self.parts.append('*')
        elif tag in {'ul', 'ol'}:
            self.stack.append(tag)
            self.parts.append('\n')
        elif tag == 'li':
            self.parts.append('\n' + '  ' * max(0, len(self.stack) - 1) + ('1. ' if self.stack and self.stack[-1] == 'ol' else '- '))
        elif tag in {'br', 'hr'}:
            self.parts.append('\n')
        elif tag == 'blockquote':
            self.parts.append('\n\n> ')
        elif tag == 'a':
            href = str(attrs.get('href') or '')
            try:
                parsed = urlsplit(href)
                safe = parsed.scheme.lower() in {'http', 'https'} and bool(parsed.hostname) and not any(ord(char) < 32 for char in href)
            except ValueError:
                safe = False
            self.links.append(urlquote(href, safe='/:?#=&%+-._~') if safe else '')
            if safe:
                self.parts.append('[')
            elif href:
                self.warnings.append('Zotero 专用或不安全链接已保留为文本，原始链接保存在导入记录。')
        elif tag == 'img':
            self.parts.append('[图片未导入' + ('：' + _markdown_text(attrs['alt']) if attrs.get('alt') else '') + '；原始资源保存在 Zotero 导入记录]')
            self.warnings.append('笔记图片未下载，原始资源引用已保留。')
        elif tag == 'table':
            self.parts.append('\n\n[表格仅保留文本；原始结构保存在 Zotero 导入记录]\n')
            self.warnings.append('笔记表格已保留文本，原始结构保存在导入记录。')
        elif tag == 'tr':
            self.parts.append('\n')
        elif tag in {'td', 'th'}:
            self.parts.append(' | ')
        elif tag == 'pre':
            self.parts.append('\n\n')

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self.suppressed:
            if tag == self.suppressed[-1]:
                self.suppressed.pop()
            return
        if tag in {'p', 'div', 'section', 'blockquote', 'pre'} or re.fullmatch(r'h[1-6]', tag):
            self.parts.append('\n\n')
        elif tag in {'strong', 'b'}:
            self.parts.append('**')
        elif tag in {'em', 'i'}:
            self.parts.append('*')
        elif tag in {'ul', 'ol'}:
            if self.stack:
                self.stack.pop()
            self.parts.append('\n')
        elif tag == 'a' and self.links:
            href = self.links.pop()
            if href:
                self.parts.append('](' + href + ')')
            else:
                self.parts.append('（链接未导入；原始链接保存在 Zotero 导入记录）')

    def handle_data(self, data):
        if not self.suppressed:
            self.parts.append(_markdown_text(data))


def html_to_markdown(value: str) -> tuple[str, list[str]]:
    parser = _NoteMarkdown()
    parser.feed(str(value or ''))
    parser.close()
    text = re.sub(r'\n[ \t]+\n', '\n\n', ''.join(parser.parts))
    return re.sub(r'\n{3,}', '\n\n', text).strip(), list(dict.fromkeys(parser.warnings))


class _DocumentBlocks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        parent_page = next((item['page'] for item in reversed(self.stack) if item.get('page')), None)
        block = None
        if attrs.get('data-block-id'):
            try:
                bbox = json.loads(attrs.get('data-bbox', 'null'))
            except ValueError:
                bbox = None
            block = {'block_id': attrs['data-block-id'], 'page': attrs.get('data-page') or parent_page, 'bbox': bbox, 'parts': []}
            self.blocks.append(block)
        ignored = tag in {'script', 'style'} or bool({'annotation-note-trigger', 'paragraph-translate-trigger'} & set(attrs.get('class', '').split()))
        frame = {'tag': tag, 'page': attrs.get('data-page') or parent_page, 'block': block, 'ignored': ignored}
        if tag not in {'img', 'br', 'hr', 'meta', 'link', 'input', 'wbr'}:
            self.stack.append(frame)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]['tag'] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if any(frame['ignored'] for frame in self.stack):
            return
        for frame in self.stack:
            if frame['block'] is not None:
                frame['block']['parts'].append(data)


def _positive(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    except (TypeError, ValueError):
        return None


def _document_data(job_dir: Path) -> tuple[list[dict], dict, str]:
    root = _active_conversion_root(job_dir)
    document = _read_json(root / 'document.json', {})
    ir = _read_json(root / 'document-ir.json', {})
    parser = _DocumentBlocks()
    if (root / 'document.html').is_file():
        parser.feed((root / 'document.html').read_text(encoding='utf-8'))
        parser.close()
    lookup = {}
    dimensions = {}
    for page in ir.get('pages', []) if isinstance(ir, dict) else []:
        if isinstance(page, dict):
            dimensions[str(page.get('page'))] = {'width': page.get('width'), 'height': page.get('height'), 'normalized': str(ir.get('backend', '')).startswith('mineru')}
    for page in document.get('pages', []) if isinstance(document, dict) else []:
        if not isinstance(page, dict):
            continue
        page_number = str(page.get('page'))
        if _positive(page.get('width')) and _positive(page.get('height')):
            dimensions.setdefault(page_number, {'width': page['width'], 'height': page['height'], 'normalized': False})
        for element in page.get('elements', []):
            if isinstance(element, dict) and element.get('block_id'):
                lookup[str(element['block_id'])] = {**element, 'page': page_number}
    blocks = parser.blocks
    for block in blocks:
        block['text'] = ''.join(block.pop('parts'))
        original = lookup.get(block['block_id'], {})
        block['bbox'] = block.get('bbox') or original.get('bbox')
        block['page'] = str(block.get('page') or original.get('page') or '')
        block['source'] = original.get('source', '')
        block['coordinate_space'] = original.get('coordinate_space', '')
        block['fragments'] = original.get('fragments', [])
    if not blocks:
        for element in lookup.values():
            snippet = _DocumentBlocks()
            snippet.feed(str(element.get('html') or ''))
            text = ''.join(snippet.blocks[0]['parts']) if snippet.blocks else str(element.get('text') or '')
            blocks.append({**element, 'text': text})
    pdf = next((path for path in (job_dir / 'source.pdf', job_dir / 'upload.pdf', root / 'source.pdf') if path.is_file()), None)
    if pdf:
        try:
            from pymupdf_runtime import load_fitz
            with load_fitz().open(pdf) as handle:
                for index, page in enumerate(handle):
                    current = dimensions.setdefault(str(index + 1), {})
                    if not page.rotation and page.cropbox == page.mediabox and page.mediabox.x0 == 0 and page.mediabox.y0 == 0:
                        current.update(pdf_width=page.rect.width, pdf_height=page.rect.height)
                    else:
                        current['pdf_geometry_unsupported'] = True
        except (ImportError, OSError, RuntimeError, ValueError):
            pass
    for geometry in dimensions.values():
        if pdf:
            geometry['_pdf_path'] = str(pdf)
        if not geometry.get('pdf_geometry_unsupported') and not geometry.get('normalized') and _positive(geometry.get('width')) and _positive(geometry.get('height')):
            geometry.setdefault('pdf_width', geometry['width'])
            geometry.setdefault('pdf_height', geometry['height'])
    return blocks, dimensions, root.name if root != job_dir else 'base'


def _box(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        left, top, right, bottom = [float(number) for number in value]
    except (TypeError, ValueError):
        return None
    return [left, top, right, bottom] if all(math.isfinite(number) for number in (left, top, right, bottom)) and right > left and bottom > top else None


def _position_page(position: dict, label: str):
    index = position.get('pageIndex')
    if isinstance(index, int) and not isinstance(index, bool) and index >= 0:
        return index + 1
    return int(label) if re.fullmatch(r'[1-9]\d*', str(label)) else None


def _normalize_whitespace(text: str) -> tuple[str, list[int]]:
    chars, offsets = [], []
    for index, char in enumerate(text):
        char = ' ' if char.isspace() else char
        if char == ' ' and chars and chars[-1] == ' ':
            continue
        chars.append(char)
        offsets.append(index)
    return ''.join(chars), offsets


_LIGATURES = {**dict(zip('ﬀﬁﬂﬃﬄﬅﬆ', ('ff', 'fi', 'fl', 'ffi', 'ffl', 'st', 'st'), strict=True)), '…': '...'}


def _equivalent_text(text: str) -> tuple[str, list[int]]:
    chars, offsets = [], []
    for index, char in enumerate(text):
        if char.isspace() or char == '\u00ad':
            continue
        expanded = _LIGATURES.get(char, char)
        chars.extend(expanded)
        offsets.extend([index] * len(expanded))
    return ''.join(chars), offsets


def _pdf_glyphs(geometry: dict, page: int) -> list:
    if '_pdf_glyphs' not in geometry:
        glyphs = []
        try:
            from pymupdf_runtime import load_fitz
            if geometry.get('_pdf_path') and not geometry.get('pdf_geometry_unsupported'):
                with load_fitz().open(geometry['_pdf_path']) as document:
                    for block in document[page - 1].get_text('rawdict')['blocks']:
                        lines = block.get('lines', [])
                        for line_index, line in enumerate(lines):
                            chars = [char for span in line.get('spans', []) for char in span.get('chars', [])]
                            visible = [index for index, char in enumerate(chars) if not char['c'].isspace()]
                            line_text = ''.join(char['c'] for char in chars).rstrip()
                            following = ''.join(char['c'] for span in lines[line_index + 1].get('spans', []) for char in span.get('chars', [])).lstrip() if line_index + 1 < len(lines) else ''
                            word_break = bool(re.search(r'[^\W\d_]{2,}-$', line_text) and re.match(r'[^\W\d_]{2,}', following))
                            for index, char in enumerate(chars):
                                glyphs.append({'text': char['c'], 'bbox': char['bbox'],
                                               'line_hyphen': bool(word_break and visible and index == visible[-1] and char['c'] == '-')})
        except (ImportError, OSError, RuntimeError, ValueError, IndexError):
            pass
        geometry['_pdf_glyphs'] = glyphs
    return geometry['_pdf_glyphs']


def _inside(box, rect, tolerance=0.5):
    x, y = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return rect[0] - tolerance <= x <= rect[2] + tolerance and rect[1] - tolerance <= y <= rect[3] + tolerance


def _pdf_verified_ranges(block: dict, quote: str, position: dict, geometry: dict, page: int) -> list:
    width, height = _positive(geometry.get('pdf_width')), _positive(geometry.get('pdf_height'))
    bbox = _box(block.get('bbox'))
    rects = [_box(rect) for rect in position.get('rects', [])] if isinstance(position.get('rects'), list) else []
    rects = [[rect[0], height - rect[3], rect[2], height - rect[1]] for rect in rects if rect] if height else []
    if not width or not height or not bbox or not rects:
        return []
    if block.get('coordinate_space') == 'normalized':
        bbox = [bbox[0] * width, bbox[1] * height, bbox[2] * width, bbox[3] * height]
    elif geometry.get('normalized'):
        bbox = [bbox[0] * width / 1000, bbox[1] * height / 1000, bbox[2] * width / 1000, bbox[3] * height / 1000]
    elif geometry.get('width') and geometry.get('height'):
        bbox = [bbox[0] * width / geometry['width'], bbox[1] * height / geometry['height'],
                bbox[2] * width / geometry['width'], bbox[3] * height / geometry['height']]
    glyphs = [glyph for glyph in _pdf_glyphs(geometry, page) if _inside(glyph['bbox'], bbox, 2)]
    native, native_glyphs = [], []
    for index, glyph in enumerate(glyphs):
        value, _ = _equivalent_text(glyph['text'])
        native.extend(value)
        native_glyphs.extend([index] * len(value))
    native = ''.join(native)
    rendered, offsets = _equivalent_text(block['text'])
    if not native or not rendered:
        return []
    selected = [index for index, glyph_index in enumerate(native_glyphs)
                if any(_inside(glyphs[glyph_index]['bbox'], rect) for rect in rects)]
    if not selected or selected != list(range(selected[0], selected[-1] + 1)):
        return []
    first, last = selected[0], selected[-1] + 1
    # A visible hyphen may disappear only with native evidence that it ends a PDF line.
    selected_text = ''.join(char for index, char in enumerate(native[first:last], first)
                            if not glyphs[native_glyphs[index]]['line_hyphen'])
    query, _ = _equivalent_text(quote)
    native_query = native[first:last]
    if query not in {native_query, selected_text}:
        return []
    mapping = {}
    for operation, a, b, c, d in difflib.SequenceMatcher(None, native, rendered, autojunk=False).get_opcodes():
        if operation == 'equal':
            mapping.update((index, c + index - a) for index in range(a, b))
        elif operation == 'delete' and all(glyphs[native_glyphs[index]]['line_hyphen'] for index in range(a, b)):
            continue
        elif operation == 'insert' and (a == 0 or a == len(native)) and re.fullmatch(r'\(\d+\)', rendered[c:d]):
            continue
        else:
            return []
    mapped = [mapping[index] for index in range(first, last) if index in mapping]
    if not mapped or mapped != list(range(mapped[0], mapped[-1] + 1)):
        return []
    start, end = mapped[0], mapped[-1] + 1
    # Never return half of a rendered ligature expansion.
    if (start and offsets[start - 1] == offsets[start]) or (end < len(offsets) and offsets[end] == offsets[end - 1]):
        return []
    return [(block, offsets[start], offsets[end - 1] + 1)]


def _anchor(annotation: dict, blocks: list[dict], dimensions: dict) -> dict | None:
    position = annotation.get('position') if isinstance(annotation.get('position'), dict) else {}
    page = _position_page(position, annotation.get('page_label', ''))
    quote = str(annotation.get('text') or '').strip()
    if page is None or not quote:
        return None
    candidates = [block for block in blocks if str(block.get('page')) == str(page)
                  and len({str(fragment.get('page')) for fragment in block.get('fragments', []) if isinstance(fragment, dict) and fragment.get('page') is not None}) <= 1]
    rects = [_box(rect) for rect in position.get('rects', [])] if isinstance(position.get('rects'), list) else []
    rects = [rect for rect in rects if rect]
    geometry = dimensions.get(str(page), {})
    if rects and geometry.get('pdf_geometry_unsupported'):
        return None
    pdf_width, pdf_height = _positive(geometry.get('pdf_width')), _positive(geometry.get('pdf_height'))
    if rects and pdf_width and pdf_height:
        canvas_width = 1000 if geometry.get('normalized') else _positive(geometry.get('width')) or pdf_width
        canvas_height = 1000 if geometry.get('normalized') else _positive(geometry.get('height')) or pdf_height
        filtered = []
        for block in candidates:
            bbox = _box(block.get('bbox'))
            if not bbox:
                continue
            normalized = block.get('coordinate_space') == 'normalized'
            width, height = (1, 1) if normalized else (canvas_width, canvas_height)
            boxes = [[rect[0] / pdf_width * width, (pdf_height - rect[3]) / pdf_height * height,
                      rect[2] / pdf_width * width, (pdf_height - rect[1]) / pdf_height * height] for rect in rects]
            tolerance_x, tolerance_y = (2 / pdf_width, 2 / pdf_height) if normalized else (2, 2)
            if any(min(bbox[2], rect[2]) > max(bbox[0], rect[0]) - tolerance_x
                   and min(bbox[3], rect[3]) > max(bbox[1], rect[1]) - tolerance_y for rect in boxes):
                filtered.append(block)
        candidates = filtered
    matches = []
    for block in candidates:
        text = block.get('text', '')
        exact = list(re.finditer(re.escape(quote), text))
        if exact:
            matches.extend((block, match.start(), match.end()) for match in exact)
        else:
            normalized, offsets = _normalize_whitespace(text)
            query = re.sub(r'\s+', ' ', quote)
            for match in re.finditer(re.escape(query), normalized):
                matches.append((block, offsets[match.start()], offsets[match.end() - 1] + 1))
    if len(matches) != 1:
        matches = [match for block in candidates for match in _pdf_verified_ranges(block, quote, position, geometry, page)]
        if len(matches) != 1:
            return None
    block, start, end = matches[0]
    text = block['text']
    return {'block_id': block['block_id'], 'page': page, 'quote': text[start:end],
            'start': len(text[:start].encode('utf-16-le')) // 2, 'end': len(text[:end].encode('utf-16-le')) // 2,
            'quote_prefix': text[max(0, start - 48):start], 'quote_suffix': text[end:end + 48]}


def _clipped(value: str) -> tuple[str, bool]:
    if len(value) <= MAX_ANNOTATION_CHARS:
        return value, False
    notice = '\n[内容已截断；完整原文保存在 Zotero 导入记录]'
    return value[:MAX_ANNOTATION_CHARS - len(notice)] + notice, True


def _external_key(value: dict) -> str:
    return str(value.get('key') or hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest())


def _unanchored_content(source: str, original: dict, reason: str = '') -> str:
    position = original.get('position') if isinstance(original.get('position'), dict) else {}
    tags = list(dict.fromkeys(tag for tag in original.get('tags', []) if isinstance(tag, str) and tag))
    tag_note = '\n\nZotero 标签：' + '、'.join(tags) if tags else ''
    return ('## Zotero 未定位批注 · ' + _markdown_text(_external_key(original)) + '\n\n来源：' + _markdown_text(source)
            + '\n\n类型：' + _markdown_text(str(original.get('type') or ''))
            + '；页码：' + _markdown_text(str(original.get('page_label') or _position_page(position, original.get('page_label', '')) or '未知'))
            + '\n\n选文：\n\n' + _markdown_text(str(original.get('text') or '（无选文）'))
            + '\n\n备注：\n\n' + _markdown_text(str(original.get('comment') or '（无备注）') + tag_note)
            + ('\n\n未定位原因：' + _markdown_text(reason) if reason else ''))


def _fallback_fingerprint(identity: str, content: str) -> str:
    return hashlib.sha256(('<!-- zotero-unanchored:' + identity + ' -->\n' + content.strip()).encode()).hexdigest()


def _remove_unchanged_fallback(markdown: str, identity: str, fingerprints: set[str], content: str | None = None) -> tuple[str, bool, bool]:
    marker = '<!-- zotero-unanchored:' + identity + ' -->'
    boundaries = list(re.finditer(r'^<!-- zotero-(?:note|unanchored):[a-f0-9]{32} -->$', markdown, re.MULTILINE))
    matches = [(index, match) for index, match in enumerate(boundaries) if match.group() == marker]
    if len(matches) != 1:
        return markdown, False, bool(matches)
    index, match = matches[0]
    end = boundaries[index + 1].start() if index + 1 < len(boundaries) else len(markdown)
    block = markdown[match.start():end].rstrip('\n')
    if hashlib.sha256(block.encode()).hexdigest() not in fingerprints:
        return markdown, False, True
    replacement = marker + '\n' + content.strip() + '\n\n' if content is not None else ''
    return markdown[:match.start()] + replacement + markdown[end:], True, False


def _unanchored_reason(item: dict, blocks: list, dimensions: dict) -> str:
    if not str(item.get('quote') or '').strip():
        return '此 Zotero 批注没有选文；页码、备注和标签已保留，无法创建文字高亮。'
    if item.get('import_anchor_disabled'):
        return '此批注为跨页选区、非文字类型、旋转选区或超长选文，未创建文字高亮；原始内容已保留。'
    page = _position_page(item.get('import_position') or {}, item.get('import_page_label', ''))
    geometry = dimensions.get(str(page), {})
    height, width = geometry.get('pdf_height'), geometry.get('pdf_width')
    raw_rects = (item.get('import_position') or {}).get('rects')
    rects = [_box(rect) for rect in raw_rects] if isinstance(raw_rects, list) else []
    if height and width:
        overlapping = []
        for block in blocks:
            bbox = _box(block.get('bbox'))
            if str(block.get('page')) != str(page) or not bbox:
                continue
            if block.get('coordinate_space') == 'normalized':
                bbox = [bbox[0] * width, bbox[1] * height, bbox[2] * width, bbox[3] * height]
            elif geometry.get('normalized'):
                bbox = [bbox[0] * width / 1000, bbox[1] * height / 1000, bbox[2] * width / 1000, bbox[3] * height / 1000]
            if any(rect and min(bbox[2], rect[2]) > max(bbox[0], rect[0])
                   and min(bbox[3], height - rect[1]) > max(bbox[1], height - rect[3]) for rect in rects):
                overlapping.append(block)
        if overlapping and not any(str(block.get('text') or '').strip() for block in overlapping):
            return '选框对应内容以公式或图片原图呈现，没有可定位的正文文字；选文和备注已保留。'
    return '页码和选框范围内没有可由原 PDF 字形验证的唯一正文位置；为避免错误高亮，已保留选文和备注。'


def _repair_imported_anchors(data: dict, annotations: list, markdown: str, blocks: list, dimensions: dict, generation: str) -> tuple[str, dict]:
    result = {'resolved_annotations_count': 0, 'removed_fallback_notes_count': 0, 'updated_fallback_notes_count': 0, 'warnings': []}
    for source, entry in data['sources'].items():
        variants = [entry['package'], *[version['package'] for version in entry.get('history', [])]]
        for item in annotations:
            if not isinstance(item, dict) or item.get('import_provider') != 'zotero' or item.get('import_source_id') != source:
                continue
            identity, key = item.get('id'), item.get('import_key')
            if not key or identity != _identity(source, 'annotation', key):
                continue
            fallback_quote = item.get('import_fallback_quote', item.get('quote'))
            if item.get('import_unanchored') and not item.get('import_anchor_disabled'):
                original = {'text': item.get('quote'), 'position': item.get('import_position'), 'page_label': item.get('import_page_label')}
                anchor = _anchor(original, blocks, dimensions)
                if anchor:
                    item.update(anchor, import_unanchored=False, render_generation=generation, import_fallback_quote=fallback_quote)
                    result['resolved_annotations_count'] += 1
            fingerprints = set()
            snapshots = []
            for package in variants:
                for original in package.get('annotations', []):
                    if (_external_key(original) == key and original.get('version') == item.get('import_version')
                            and original.get('type') == item.get('import_type')
                            and original.get('position') == item.get('import_position')
                            and re.sub(r'\s+', ' ', str(original.get('text') or '').strip()) == re.sub(r'\s+', ' ', str(fallback_quote or '').strip())):
                        snapshots.append(original)
            saved = entry.get('unanchored_note_fingerprints', {}).get(identity)
            if saved:
                fingerprints.add(saved)
            else:
                for original in snapshots:
                    fingerprints.add(_fallback_fingerprint(identity, _unanchored_content(source, original, item.get('import_unanchored_reason', ''))))
                if len(fingerprints) != 1:
                    fingerprints.clear()
            if item.get('import_unanchored'):
                reason = _unanchored_reason(item, blocks, dimensions)
                result['warnings'].append(f'批注 {key} 未定位：{reason}')
                unique = {json.dumps(original, ensure_ascii=False, sort_keys=True): original for original in snapshots}
                if len(unique) == 1:
                    content = _unanchored_content(source, next(iter(unique.values())), reason)
                    replacement_fingerprint = _fallback_fingerprint(identity, content)
                    if saved != replacement_fingerprint:
                        markdown, updated, edited = _remove_unchanged_fallback(markdown, identity, fingerprints, content)
                        if updated:
                            entry.setdefault('unanchored_note_fingerprints', {})[identity] = replacement_fingerprint
                            item['import_unanchored_reason'] = reason
                            result['updated_fallback_notes_count'] += 1
                        elif edited:
                            result['warnings'].append(f'批注 {key} 的备用笔记含用户改动或额外内容，未覆盖；未定位原因见导入提示。')
                continue
            start, end = item.get('start'), item.get('end')
            if (not item.get('block_id') or item.get('render_generation') != generation
                    or isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, (int, float))
                    or not isinstance(end, (int, float)) or not math.isfinite(start) or not math.isfinite(end) or end <= start):
                continue
            markdown, removed, edited = _remove_unchanged_fallback(markdown, identity, fingerprints)
            if removed:
                result['removed_fallback_notes_count'] += 1
                entry.get('unanchored_note_fingerprints', {}).pop(identity, None)
            elif edited:
                result['warnings'].append(f'批注 {key} 已定位，其备用笔记含用户改动或额外内容，已保留。')
    return markdown, result


def _append_note(current: str, marker: str, content: str) -> tuple[str, bool, bool]:
    if marker in current:
        return current, False, False
    addition = '\n\n' + marker + '\n' + content.strip() + '\n'
    available = MAX_NOTES_CHARS - len(current)
    if len(addition) <= available:
        return current + addition, True, False
    notice = '\n\n[导入笔记已截断；完整原文保存在 Zotero 导入记录]\n'
    if available > len(marker) + len(notice) + 8:
        return current + addition[:available - len(notice)] + notice, True, True
    return current, False, True


def apply_import(job_dir: Path, library, job_id: str) -> dict:
    with IMPORT_LOCK:
        data = _sidecar(job_dir)
        job = _read_json(job_dir / 'job.json', {})
        summary = {'notes_count': 0, 'annotations_count': 0, 'unanchored_count': 0, 'source_count': 0,
                   'truncated_count': 0, 'tags_added': 0, 'folders_added': 0, 'warnings': [],
                   'resolved_annotations_count': 0, 'removed_fallback_notes_count': 0}
        if job.get('status') not in {None, 'completed'}:
            return {**summary, 'status': 'pending'}
        pending = [(source, entry) for source, entry in data['sources'].items() if entry.get('status') != 'applied']
        annotations = _read_json(job_dir / 'annotations.json', [])
        if not isinstance(annotations, list):
            raise ValueError('现有批注格式无效，已停止 Zotero 合并。')
        note_path = job_dir / 'notes.md'
        markdown = note_path.read_text(encoding='utf-8') if note_path.is_file() else ''
        blocks, dimensions, generation = _document_data(job_dir)
        markdown, repaired = _repair_imported_anchors(data, annotations, markdown, blocks, dimensions, generation)
        summary.update(repaired)
        if not pending and not any(summary[name] for name in ('resolved_annotations_count', 'removed_fallback_notes_count', 'updated_fallback_notes_count')):
            return {**summary, 'status': 'applied', 'current_unanchored_count': sum(bool(item.get('import_unanchored')) for item in annotations if isinstance(item, dict) and item.get('import_provider') == 'zotero')}
        ids = {str(item.get('id')) for item in annotations if isinstance(item, dict)}
        for source, entry in pending:
            package = entry['package']
            result = library.import_zotero_metadata(job_id, package)
            summary['tags_added'] += result['tags_added']
            summary['folders_added'] += result['folders_added']
            summary['warnings'].extend(result['warnings'])
            previous_package = entry.get('history', [])[-1].get('package', {}) if entry.get('history') else {}
            previous_notes = {_external_key(value): value for value in previous_package.get('notes', [])}
            previous_annotations = {_external_key(value): value for value in previous_package.get('annotations', [])}
            note_keys = set(entry.get('imported_note_keys', []))
            annotation_keys = set(entry.get('imported_annotation_keys', []))
            for note in package.get('notes', []):
                key = _external_key(note)
                if key in note_keys:
                    if key in previous_notes and previous_notes[key].get('html') != note.get('html'):
                        summary['warnings'].append(f'笔记 {key} 有新的 Zotero 内容；已保留当前笔记，新版本原文保存在导入记录。')
                    continue
                marker = '<!-- zotero-note:' + _identity(source, 'note', key) + ' -->'
                converted, warnings = html_to_markdown(note.get('html', ''))
                markdown, added, clipped = _append_note(markdown, marker, '## Zotero 笔记 · ' + _markdown_text(key) + '\n\n' + converted)
                summary['notes_count'] += int(added)
                summary['warnings'].extend(warnings)
                summary['truncated_count'] += int(clipped)
                if clipped:
                    summary['warnings'].append(f'笔记 {key} 超过阅读器笔记上限，完整 HTML 已保留在 zotero-import.json。')
                note_keys.add(key)
            for original in package.get('annotations', []):
                key = _external_key(original)
                if key in annotation_keys:
                    previous = previous_annotations.get(key)
                    if previous and (any(previous.get(field) != original.get(field) for field in ('text', 'comment', 'position', 'type', 'color')) or previous.get('tags', []) != original.get('tags', [])):
                        summary['warnings'].append(f'批注 {key} 有新的 Zotero 内容；已保留当前批注，新版本原文保存在导入记录。')
                    continue
                identity = _identity(source, 'annotation', key)
                if identity in ids:
                    annotation_keys.add(key)
                    continue
                position = original.get('position') if isinstance(original.get('position'), dict) else {}
                kind = str(original.get('type') or '')
                quote, quote_clipped = _clipped(str(original.get('text') or '').strip())
                tags = list(dict.fromkeys(tag for tag in original.get('tags', []) if isinstance(tag, str) and tag))
                tag_note = '\n\nZotero 标签：' + '、'.join(tags) if tags else ''
                comment, comment_clipped = _clipped(str(original.get('comment') or '') + tag_note)
                cross_page = bool(position.get('nextPageRects') or position.get('nextPagePaths') or (isinstance(position.get('pages'), list) and len(position['pages']) > 1) or (isinstance(position.get('pageIndices'), list) and len(position['pageIndices']) > 1))
                disabled = cross_page or kind not in {'highlight', 'underline'} or quote_clipped or bool(position.get('rotation'))
                anchor = None if disabled else _anchor(original, blocks, dimensions)
                color = str(original.get('color') or '')
                item = {'id': identity, 'kind': kind if kind in {'highlight', 'underline'} else 'highlight',
                        'color': color if re.fullmatch(r'#[0-9a-fA-F]{6}', color) else '#ffd400',
                        'quote': quote, 'note': comment, 'page': _position_page(position, original.get('page_label', '')),
                        'block_id': None, 'start': None, 'end': None, 'surface': 'paper', 'source': 'manual',
                        'quote_prefix': '', 'quote_suffix': '', 'render_generation': generation, 'created_at': utc_now(),
                        'import_provider': 'zotero', 'import_source_id': source, 'import_key': key,
                        'import_version': original.get('version'), 'import_type': kind, 'import_page_label': original.get('page_label'),
                        'import_tags': tags,
                        'import_position': copy.deepcopy(position), 'import_unanchored': anchor is None,
                        'import_anchor_disabled': disabled, 'import_truncated': quote_clipped or comment_clipped}
                if anchor:
                    item.update(anchor)
                else:
                    summary['unanchored_count'] += 1
                    marker = '<!-- zotero-unanchored:' + identity + ' -->'
                    reason = _unanchored_reason(item, blocks, dimensions)
                    item['import_unanchored_reason'] = reason
                    details = _unanchored_content(source, original, reason)
                    summary['warnings'].append(f'批注 {key} 未定位：{reason}')
                    markdown, added, clipped = _append_note(markdown, marker, details)
                    if added and not clipped:
                        entry.setdefault('unanchored_note_fingerprints', {})[identity] = _fallback_fingerprint(identity, details)
                    summary['truncated_count'] += int(clipped)
                    if clipped:
                        summary['warnings'].append(f'未定位批注 {key} 的笔记预览超过上限，完整批注已保留在导入记录。')
                summary['truncated_count'] += int(quote_clipped or comment_clipped)
                if quote_clipped or comment_clipped:
                    summary['warnings'].append(f'批注 {key} 的选文或备注超过 10000 字符，完整原文已保留在导入记录。')
                annotations.append(item)
                ids.add(identity)
                annotation_keys.add(key)
                summary['annotations_count'] += 1
            entry.update(imported_note_keys=sorted(note_keys), imported_annotation_keys=sorted(annotation_keys),
                         status='applied', applied_at=utc_now(), render_generation=generation)
            summary['source_count'] += 1
        summary['warnings'] = list(dict.fromkeys(summary['warnings']))
        summary['current_unanchored_count'] = sum(bool(item.get('import_unanchored')) for item in annotations if isinstance(item, dict) and item.get('import_provider') == 'zotero')
        _atomic_write(job_dir / 'annotations.json', annotations)
        _sync_content_file(job_dir, 'annotations/annotations.json', annotations)
        _atomic_write(note_path, markdown)
        _sync_content_file(job_dir, 'notes/notes.md', markdown)
        for _, entry in pending:
            entry['summary'] = copy.deepcopy(summary)
        if summary['resolved_annotations_count'] or summary['removed_fallback_notes_count']:
            for source, entry in data['sources'].items():
                if isinstance(entry.get('summary'), dict):
                    entry['summary']['unanchored_count'] = sum(bool(item.get('import_unanchored')) for item in annotations
                                                              if isinstance(item, dict) and item.get('import_source_id') == source)
        _atomic_write(job_dir / 'zotero-import.json', data)
        return {**summary, 'status': 'applied'}
