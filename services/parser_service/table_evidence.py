"""Bounded OCR table candidates, without certifying their source accuracy."""
from __future__ import annotations

import html
from html.parser import HTMLParser
import re

from bs4 import BeautifulSoup, NavigableString


class _TableMarkup(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []

    def handle_starttag(self, tag, attrs):
        from .exporter import SafeHTML
        if tag not in SafeHTML.allowed or tag in {'sup', 'sub'} and tag in self.stack:
            raise ValueError('unsupported_or_nested_table_markup')
        if tag == 'table' and self.stack:
            raise ValueError('nested_table')
        if not self.stack and tag != 'table':
            raise ValueError('markup_outside_table')
        if tag != 'br':
            if len(self.stack) >= 64:
                raise ValueError('table_markup_depth_exceeded')
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag != 'br':
            raise ValueError('self_closing_table_markup')
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == 'br':
            return
        if not self.stack or self.stack.pop() != tag:
            raise ValueError('unbalanced_table_markup')

    def handle_data(self, value):
        if value.strip() and not self.stack:
            raise ValueError('text_outside_table')


def _markup(content):
    content = str(content or '').strip()
    if re.search(r'<\s*/?\s*(?:script|style|iframe)\b', content, re.I):
        raise ValueError('unsafe_table_markup')
    if '<' in content and re.search(r'<\s*table\b', content, re.I):
        return content
    lines = content.splitlines()
    if len(lines) < 2 or any(not line.strip().startswith('|') or not line.strip().endswith('|') for line in lines):
        raise ValueError('table_html_unavailable')
    rows = [[value.strip().replace(r'\|', '|') for value in re.split(r'(?<!\\)\|', line.strip())[1:-1]] for line in lines]
    if not rows[1] or not all(re.fullmatch(r':?-{3,}:?', value) for value in rows[1]):
        raise ValueError('markdown_table_header_unavailable')
    rows.pop(1)
    return '<table>' + ''.join('<tr>' + ''.join('<td>' + html.escape(value) + '</td>' for value in row) + '</tr>' for row in rows) + '</table>'


def _cell_text(cell):
    def text(node):
        if isinstance(node, NavigableString):
            return str(node)
        value = ''.join(text(child) for child in node.children)
        if node.name in {'sup', 'sub'}:
            return '<' + node.name + '>' + value + '</' + node.name + '>'
        return '\n' if node.name == 'br' else value + '\n' if node.name in {'p', 'li'} else value
    return re.sub(r'\s+', ' ', text(cell)).strip()


def _candidate(content):
    from .exporter import safe_html
    markup = _markup(content)
    parser = _TableMarkup()
    parser.feed(markup)
    parser.close()
    if parser.stack:
        raise ValueError('unclosed_table_markup')
    soup = BeautifulSoup(markup, 'html.parser')
    tables = soup.find_all('table')
    if len(tables) != 1:
        raise ValueError('table_count_invalid')
    table = tables[0]
    for tag in table.find_all(True):
        if tag.name in {'thead', 'tbody', 'tfoot', 'caption'} and tag.parent != table:
            raise ValueError('table_group_parent_invalid')
        if tag.name not in {'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption'} and not tag.find_parent(['td', 'th', 'caption']):
            raise ValueError('table_markup_outside_cells')
    rows = table.find_all('tr')
    if not 1 <= len(rows) <= 512:
        raise ValueError('table_row_count_invalid')
    if any(row.parent != table and row.parent.name not in {'thead', 'tbody', 'tfoot'} for row in rows):
        raise ValueError('table_row_parent_invalid')
    all_cells = table.find_all(['td', 'th'])
    if not all_cells or len(all_cells) > 16384 or any(cell.parent not in rows for cell in all_cells):
        raise ValueError('table_cell_parent_invalid')
    if any(text.strip() and text.parent.name not in {'caption', 'td', 'th', 'strong', 'em', 'b', 'i', 'u', 'sup', 'sub', 'p', 'ul', 'ol', 'li', 'span'} for text in table.find_all(string=True)):
        raise ValueError('table_text_outside_cells')
    occupied, cells, widths = set(), [], []
    for r, row in enumerate(rows):
        col = 0
        for cell in row.find_all(['td', 'th'], recursive=False):
            while (r, col) in occupied:
                col += 1
            spans = []
            for name in ['rowspan', 'colspan']:
                raw = str(cell.get(name, '1'))
                if not re.fullmatch(r'[1-9]\d{0,2}', raw):
                    raise ValueError('table_span_invalid')
                spans.append(int(raw))
            rs, cs = spans
            if r + rs > len(rows) or col + cs > 256:
                raise ValueError('table_span_out_of_bounds')
            for rr in range(r, r + rs):
                for cc in range(col, col + cs):
                    if (rr, cc) in occupied:
                        raise ValueError('overlapping_table_cells')
                    occupied.add((rr, cc))
            cells.append({'row': r, 'column': col, 'rowspan': rs, 'colspan': cs, 'text': _cell_text(cell)})
            col += cs
        width = max((c + 1 for rr, c in occupied if rr == r), default=0)
        widths.append(width)
        if any((r, c) not in occupied for c in range(width)):
            raise ValueError('table_grid_holes')
    if not widths[0] or len(set(widths)) != 1:
        raise ValueError('table_grid_width_inconsistent')
    safe, plain = safe_html(str(table))
    return {'html': safe, 'text': plain, 'rows': len(rows), 'columns': widths[0], 'cells': cells}


def assess_table_evidence(content, other_content=None, *, native_available, structure_issues=(), page_image=None, table_bbox=None):
    """Keep a valid primary OCR candidate and report independent cell disagreement."""
    result = {'schema': 'table-evidence-v1', 'status': 'unresolved', 'evidence_basis': 'native-available' if native_available else 'ocr-only', 'native_available': bool(native_available), 'native_confirmed': False, 'allow_ocr_candidate': False, 'source_comparison_required': True, 'structured_candidate_available': False, 'candidate_html': None, 'ocr_agreement': 'unavailable', 'review_reasons': list(structure_issues), 'sources': {}, 'differences': []}
    candidates = {}
    for source, value in [('primary', content), ('secondary', other_content)]:
        if value is None:
            continue
        try:
            candidates[source] = _candidate(value)
            result['sources'][source] = candidates[source]
        except ValueError as exc:
            result['sources'][source] = {'valid': False, 'reason': str(exc), 'content': str(value)}
            result['review_reasons'].append(source + ':' + str(exc))
    primary, secondary = candidates.get('primary'), candidates.get('secondary')
    if primary:
        result.update(structured_candidate_available=True, candidate_html=primary['html'])
    if primary and secondary:
        shape = lambda value: [(cell['row'], cell['column'], cell['rowspan'], cell['colspan']) for cell in value['cells']]
        same_shape = primary['rows'] == secondary['rows'] and primary['columns'] == secondary['columns'] and shape(primary) == shape(secondary)
        result['ocr_agreement'] = 'exact' if same_shape and primary['cells'] == secondary['cells'] else 'different'
        if same_shape:
            result['differences'] = [{'row': a['row'], 'column': a['column'], 'primary': a['text'], 'secondary': b['text']} for a, b in zip(primary['cells'], secondary['cells']) if a['text'] != b['text']]
        else:
            result['review_reasons'].append('ocr_table_structure_disagreement')
        if result['ocr_agreement'] == 'different':
            result['review_reasons'].append('ocr_table_cell_disagreement')
    if not native_available:
        result['review_reasons'].append('ocr_only_table_requires_source_review')
        result['allow_ocr_candidate'] = bool(primary) and not structure_issues
        from .scan_unit_evidence import assess_scan_units, unit_disagreements
        result['needs_unit_image'] = bool(unit_disagreements(primary, secondary)) and page_image is None and all(cell['rowspan'] == cell['colspan'] == 1 for candidate in (primary, secondary) for cell in candidate['cells'])
        result['unit_image_audit'] = assess_scan_units(page_image, table_bbox, primary, secondary)
        selected = [audit for audit in result['unit_image_audit'] if audit['status'] == 'selected' and audit['before'] != audit['after']]
        if selected and result['allow_ocr_candidate']:
            soup = BeautifulSoup(result['candidate_html'], 'html.parser')
            cells = soup.find_all(['td', 'th'])
            positions = {(cell['row'], cell['column']): index for index, cell in enumerate(primary['cells'])}
            for audit in selected:
                cells[positions[audit['row'], audit['column']]].string = audit['after']
            candidate = _candidate(str(soup))
            result['candidate_html'] = candidate['html']
            result['review_reasons'].append('ocr_table_unit_selected_by_local_pixels')
    return result


def ocr_table_candidate(block):
    """Recheck a persisted scan-table candidate before overriding source-primary."""
    evidence = block.get('table_evidence') or {}
    if not evidence.get('allow_ocr_candidate') or evidence.get('native_available') is not False or evidence.get('evidence_basis') != 'ocr-only':
        return None
    native = block.get('native_evidence') or {}
    if native.get('native_available') is True or native.get('status') == 'confirmed':
        return None
    try:
        return _candidate(evidence.get('candidate_html'))['html']
    except ValueError:
        return None
