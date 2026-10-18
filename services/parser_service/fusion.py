#!/usr/bin/env python3
"""Fuse original GLM/MinerU outputs; no inference or manually selected blocks."""
import argparse
import copy
import hashlib
import json
import re
import shutil
import time
import unicodedata
import html
from collections import Counter
from pathlib import Path

from bs4 import BeautifulSoup
from PIL import Image

from .bibliography import aggregate_reference_duplicates
from .native_pdf import NativePDF
from .currency import normalize_currency_dollars
from .math_evidence import TexAtoms, assess_formula, math_candidates, math_canonical, math_spans, readable_candidate, reconcile_equation_number, selectable_script_segments, native_atoms, ordered_atoms

SCHEMA = 'guzi-fusion-auto-v3'


def markup(text, styles):
    value = html.escape(text, quote=False)
    for style, tag in [('italic', 'em'), ('bold', 'strong'), ('underline', 'u')]:
        if style in styles:
            value = '<' + tag + '>' + value + '</' + tag + '>'
    return value


def styled_text(text, spans, offset=0):
    result, cursor = [], 0
    for span in spans:
        start, end = max(0, span['start'] - offset), min(len(text), span['end'] - offset)
        if start >= end:
            continue
        result.append(html.escape(text[cursor:start], quote=False))
        result.append(markup(text[start:end], span['styles']))
        cursor = end
    result.append(html.escape(text[cursor:], quote=False))
    return ''.join(result)


def strip_emphasis(content):
    parts, cursor = [], 0
    for start, end, _, _ in math_candidates(content):
        parts.append(content[cursor:start].replace('***', '').replace('**', ''))
        parts.append(content[start:end])
        cursor = end
    parts.append(content[cursor:].replace('***', '').replace('**', ''))
    return ''.join(parts)


def restore_styles(content, page, region, table=False):
    if table:
        soup = BeautifulSoup(content, 'html.parser')
        for tag in soup.find_all(['strong', 'b', 'em', 'i', 'u']):
            tag.unwrap()
        nodes = list(soup.find_all(string=True))
        offsets, parts, cursor = [], [], 0
        for node in nodes:
            text = str(node)
            offsets.append((node, cursor))
            parts.append(text + '\n')
            cursor += len(text) + 1
        text = ''.join(parts)
        spans, evidence = page.style_spans(text, region, [(a, b) for a, b, _ in math_spans(text)])
        if evidence['alignment_coverage'] < .75:
            return content, [], evidence
        for node, offset in offsets:
            rendered = BeautifulSoup(styled_text(str(node), spans, offset), 'html.parser')
            node.replace_with(*list(rendered.contents))
        return str(soup), spans, evidence
    text = strip_emphasis(content)
    exclusions = [(a, b) for a, b, _, _ in math_candidates(text)]
    spans, evidence = page.style_spans(text, region, exclusions)
    if evidence['alignment_coverage'] < .75:
        return content, [], evidence
    # Keep TeX bytes intact; HTML escaping applies only to prose runs.
    rendered = styled_text(text, spans)
    for start, end in reversed(exclusions):
        original = text[start:end]
        rendered = rendered.replace(html.escape(original, quote=False), original, 1)
    return rendered, spans, evidence


def visible_math(content, recover=True):
    result, intervals, cursor, size = [], [], 0, 0
    for start, end, latex, syntax in math_candidates(content, recover):
        prefix = content[cursor:start]
        result.append(prefix)
        size += len(prefix)
        text = ''.join(a['text'] for a in TexAtoms(latex).atoms)
        intervals.append((size, size + len(text), start, end, latex, syntax))
        result.append(text)
        size += len(text)
        cursor = end
    result.append(content[cursor:])
    return ''.join(result), intervals


def restore_native_prose(content, page, region):
    from difflib import SequenceMatcher
    from .native_pdf import canonical

    visible, offsets = [], []
    def prose(start, end):
        for match in re.finditer(r'</?[A-Za-z][^>]*>|&(?:#\d+|#x[\da-fA-F]+|[A-Za-z]+);|.', content[start:end], re.S):
            if match[0].startswith('<') and match[0].endswith('>'):
                continue
            for char in canonical(html.unescape(match[0])):
                visible.append(char)
                offsets.append((start + match.start(), start + match.end(), False))
    cursor = 0
    for start, end, latex, syntax in math_candidates(content):
        prose(cursor, start)
        for atom in TexAtoms(latex).atoms:
            visible.append(atom['text'])
            offsets.append((start, end, True))
        cursor = end
    prose(cursor, len(content))
    chars = [c for c in page.region(region) if c['canonical'] and not c['rotated']]
    native, native_map = [], []
    for char in chars:
        for value in char['canonical']:
            native.append(value)
            native_map.append(char)
    target, source = ''.join(visible), ''.join(native)
    matcher = SequenceMatcher(None, target, source, autojunk=False)
    operations = matcher.get_opcodes()
    if sum(m.size for m in matcher.get_matching_blocks()) / max(1, len(target)) < .85:
        return content, []
    edits = []
    for oi, (kind, a0, a1, b0, b1) in enumerate(operations):
        if kind == 'replace' and a1 - a0 == b1 - b0 == 1 and native_map[b0].get('glyph_composition') and target[a0:a1] == 'A' and source[b0:b1] == 'Å':
            start, end, math = offsets[a0]
            if not math and content[start:end] == 'A' and 0 < oi < len(operations) - 1 and operations[oi - 1][0] == operations[oi + 1][0] == 'equal':
                edits.append({'start': start, 'end': end, 'before': 'A', 'after': 'Å', 'reason': 'native_ring_overprint_composition', 'source_glyph_ids': native_map[b0]['glyph_composition']['source_glyph_ids']})
        if kind == 'equal':
            for i, j in zip(range(a0, a1), range(b0, b1)):
                start, end, math = offsets[i]
                char = native_map[j]
                if not math and end - start == 1 and content[start:end] in '（）［］｛｝，．：；？！' and char['resolved_text'] in '()[]{},.:;?!':
                    after = char['resolved_text']
                    if after in ')]},;:!?' and end < len(content) and content[end].isalnum() and j + 1 < len(native_map):
                        neighbor = native_map[j + 1]
                        gap = neighbor['x0'] - char['x1']
                        if neighbor['canonical'] == canonical(content[end]) and gap > char.get('size', 10) * .12 and abs(neighbor['baseline'] - char['baseline']) < char.get('size', 10) * .2:
                            after += ' '
                    edits.append({'start': start, 'end': end, 'before': content[start:end], 'after': after, 'reason': 'native_prose_punctuation_glyph', 'source_glyph_ids': [char['glyph_id']]})
                style = char.get('math_style')
                if math or style not in {'mathcal', 'mathbb'} or end - start != 1 or not content[start:end].isascii() or not content[start:end].isalpha():
                    continue
                if (start and content[start - 1].isalnum()) or (end < len(content) and content[end].isalnum()):
                    continue
                edits.append({'start': start, 'end': end, 'before': content[start:end], 'after': '$\\' + style + '{' + char['canonical'] + '}$', 'reason': 'native_isolated_math_alphabet', 'source_glyph_ids': [char['glyph_id']]})
        if kind != 'insert' or b1 - b0 != 1 or source[b0:b1] not in ',.;:!?' or not 0 < a0 < len(offsets) or not 0 < oi < len(operations) - 1:
            continue
        before, after = operations[oi - 1], operations[oi + 1]
        if before[0] != 'equal' or after[0] != 'equal' or min(before[2] - before[1], after[2] - after[1]) < 3:
            continue
        left, right = offsets[a0 - 1], offsets[a0]
        if left[:2] == right[:2] or left[1] > right[0]:
            continue
        punctuation = native_map[b0]
        neighbors = native_map[max(0, b0 - 4):b0] + native_map[b1:b1 + 4]
        size = punctuation.get('size', 10)
        if not any(abs(c['baseline'] - punctuation['baseline']) < size * .2 and abs(c.get('size', 10) / size - 1) < .2 and min(abs(c['x1'] - punctuation['x0']), abs(c['x0'] - punctuation['x1'])) < size * 2 for c in neighbors):
            continue
        index = left[1]
        closing = re.match(r'(?:</[A-Za-z]+>)*', content[index:right[0]])
        index += closing.end()
        edits.append({'start': index, 'end': index, 'before': '', 'after': source[b0], 'reason': 'native_anchored_prose_punctuation', 'source_glyph_ids': [punctuation['glyph_id']]})
    for edit in sorted(edits, key=lambda value: value['start'], reverse=True):
        content = content[:edit['start']] + edit['after'] + content[edit['end']:]
    return content, edits


def anchored_native_formula(visible, start, end, parsed, page, region):
    if parsed.unknown or not 1 <= len(parsed.atoms) <= 64:
        return []
    def aligned(value):
        return math_canonical(html.unescape(re.sub(r'<[^>]+>', '', value))).replace('°', '∘').replace('◦', '∘')
    left, right = aligned(visible[:start])[-8:], aligned(visible[end:])[:8]
    if min(len(left), len(right)) < 3:
        return []
    target = ''.join(a['text'] for a in parsed.atoms)
    for search_region in (region, [0, 0, 1, 1]):
        chars = [c for c in page.region(search_region) if not c['rotated'] and c['canonical']]
        source, mapping, skipped = [], [], []
        for i, char in enumerate(chars):
            wrapped_hyphen = char['resolved_text'] == '-' and 0 < i < len(chars) - 1 and chars[i-1]['canonical'].isalpha() and chars[i+1]['canonical'].isalpha() and chars[i+1]['top'] - char['top'] > char.get('size', 10) * .5
            if wrapped_hyphen:
                skipped.append(char['glyph_id'])
                continue
            for value in aligned(char['resolved_text']):
                source.append(value)
                mapping.append(char)
        source = ''.join(source)
        matches = [m.start() for m in re.finditer(re.escape(target), source)]
        verified = [i for i in matches if source[max(0, i - len(left)):i] == left and source[i + len(target):i + len(target) + len(right)] == right and not any(mapping[i]['glyph_id'] < omitted < mapping[i+len(target)-1]['glyph_id'] for omitted in skipped)]
        if len(verified) > 1:
            return []
        if len(verified) == 1:
            index = verified[0]
            return list({char['glyph_id']: char for char in mapping[index:index + len(target)]}.values())
    return []


def reconcile_inline_boundaries(latex, page, included, region):
    from difflib import SequenceMatcher
    if not included:
        return latex, []
    # Only edge punctuation is repaired here; inner operators and arguments are evidence-checked later.
    plain = re.sub(r'\\(?:left|right)\s*', '', latex)
    parsed = TexAtoms(plain)
    native, available = native_atoms(page, region, [c['glyph_id'] for c in included], region)
    if parsed.unknown or available['unknown_glyphs'] or available['rotated_glyphs']:
        return latex, []
    target = ''.join(a['text'] for a in ordered_atoms(parsed.atoms))
    source = ''.join(a['text'] for a in ordered_atoms(native))
    if re.fullmatch(r'[A-Za-z]{3,}', target) and not any(a['script'] or a['styles'] or a['role'] for a in parsed.atoms):
        return latex, []
    edge = '()[].,;:!?'
    if not target.strip(edge) or target.strip(edge) != source.strip(edge) or target == source:
        return latex, []
    if any(kind != 'equal' and (set(target[a:b]) | set(source[c:d])) - set(edge)
           for kind, a, b, c, d in SequenceMatcher(None, target, source, autojunk=False).get_opcodes()):
        return latex, []
    atoms = parsed.atoms
    first = next(i for i, atom in enumerate(atoms) if atom['text'] not in edge)
    last = next(i for i in range(len(atoms)-1, -1, -1) if atoms[i]['text'] not in edge)
    prefix = source[:len(source)-len(source.lstrip(edge))]
    suffix = source[len(source.rstrip(edge)):]
    result = plain
    if last + 1 < len(atoms):
        result = result[:atoms[last+1]['start']] + suffix + result[atoms[-1]['end']:]
    else:
        result += suffix
    if first:
        result = result[:atoms[0]['start']] + prefix + result[atoms[first-1]['end']:]
    else:
        result = prefix + result
    return result, [{'before': latex, 'after': result, 'reason': 'native_inline_boundary_punctuation',
                     'source_glyph_ids': [c['glyph_id'] for c in included]}]


def restore_inline_math(content, page, region, recover=True):
    visible, intervals = visible_math(content, recover)
    if not intervals:
        return content, []
    mapped, evidence = page.align(visible, region, math_aliases=True)
    native_region = page.region(region)
    audits, edits = [], []
    for interval_index, (a, b, start, end, latex, syntax) in enumerate(intervals):
        original_latex = latex
        boundary_changes = []
        parsed = TexAtoms(latex)
        script_end = next((i for i, atom in enumerate(parsed.atoms) if not atom['script']), len(parsed.atoms))
        punctuation = '.,;:!?，。；：！？)]'
        script_atoms = parsed.atoms[:script_end] if script_end and all(not atom['script'] and atom['text'] in punctuation for atom in parsed.atoms[script_end:]) else []
        bare = bool(script_atoms)
        trailing_atoms = parsed.atoms[script_end:] if bare else []
        def unresolved(reason, render_mode='candidate-unresolved'):
            return {'start': start, 'end': end, 'status': 'unresolved', 'render_mode': render_mode, 'semantic_kind': 'prose-boundary' if render_mode == 'literal-text' else 'formula', 'selectable_text': readable_candidate(latex), 'source_crop_required': False, 'fallback_bbox': None, 'reason': reason, 'candidate_content': content[start:end]}
        if syntax != 'delimited':
            audit = unresolved('math_delimiter_unbalanced' if syntax == 'unbalanced-inline' else 'tex_outside_math_delimiters')
            audit.update(source_syntax=syntax, exact_candidate_range=True)
            if not audit['selectable_text']:
                audit['selectable_text'] = '[数学分隔符待核]'
            audits.append(audit)
            continue
        prose = re.sub(r'\\(?:text|textrm|textnormal|mathrm|operatorname)\s*\*?\s*\{[^{}]*\}', '', latex)
        prose = re.sub(r'\\[A-Za-z]+', '', prose)
        words = re.findall(r'[A-Za-z]{3,}', prose)
        if len(words) >= 3 and any(len(word) >= 5 for word in words):
            audits.append(unresolved('math_delimiter_boundary_ambiguous', 'literal-text'))
            continue
        left = next((max(c['glyph_id'] for c in mapped[i]) for i in range(a - 1, -1, -1) if i in mapped), None)
        right = next((min(c['glyph_id'] for c in mapped[i]) for i in range(b, len(visible)) if i in mapped), None)
        included = [c for c in native_region if (left is None or c['glyph_id'] > left) and (right is None or c['glyph_id'] < right)]
        included = [c for c in included if c['text'].strip()]
        bounded = included
        inside = {c['glyph_id']: c for i in range(a, b) for c in mapped.get(i, [])}
        if bare:
            inside = {c['glyph_id']: c for i in range(a, a + len(script_atoms)) for c in mapped.get(i, [])}
        bounded_marker = ''.join(math_canonical(c['resolved_text']) for c in bounded)
        marker_target = ''.join(atom['text'] for atom in script_atoms)
        exact_marker = bare and re.fullmatch(r'[\d,;∗†‡✉–—\-]+', bounded_marker) and (bounded_marker == marker_target or len(bounded_marker) == len(marker_target) and bounded_marker.replace('✉', '×') == marker_target)
        if len(parsed.atoms) == 1 and parsed.atoms[0]['text'] == '•' and len(bounded) == 1 and ord(bounded[0]['resolved_text'][:1] or ' ') >= 0x1F000 and evidence['alignment_coverage'] >= .85:
            audits.append({'start': start, 'end': end, 'status': 'confirmed', 'render_mode': 'literal-text', 'semantic_kind': 'text-symbol', 'selectable_text': bounded[0]['resolved_text'], 'source_crop_required': False, 'fallback_bbox': None, 'candidate_content': content[start:end], 'source_glyph_ids': [bounded[0]['glyph_id']], 'reason': None, 'changes': [{'before': latex, 'after': bounded[0]['resolved_text'], 'reason': 'explicit_native_unicode_symbol'}]})
            continue
        previous_adjacent = interval_index > 0 and not content[intervals[interval_index - 1][3]:start].strip()
        next_adjacent = interval_index + 1 < len(intervals) and not content[end:intervals[interval_index + 1][2]].strip()
        if not inside and (previous_adjacent or next_adjacent):
            audits.append(unresolved('inline_crop_alignment_unavailable'))
            continue
        if exact_marker:
            included = list(bounded)
        elif inside and (bare or previous_adjacent or next_adjacent):
            included = list(inside.values())
        # Anchors on both sides disambiguate repeated inline symbols in one paragraph.
        if not included or len(included) > max(32, (b - a) * 3):
            included = list(inside.values())
        local_formula = anchored_native_formula(visible, a, b, parsed, page, region)
        if local_formula:
            included = local_formula
        symbols = {'copyright': {'©'}, 'textcopyright': {'©'}, 'textregistered': {'®'}, 'texttrademark': {'™'}, 'textcircled': {'©', 'ⓒ'} if re.search(r'\{c\}', latex) else {'®', 'Ⓡ'} if re.search(r'\{R\}', latex) else set()}
        macro = re.fullmatch(r'\s*\\(copyright|textcopyright|textregistered|texttrademark|textcircled)(?:\s*\{[cR]\})?\s*', latex)
        native_text = ''.join(c['resolved_text'] for c in bounded)
        if macro and native_text in symbols[macro[1]]:
            audit = {'start': start, 'end': end, 'status': 'confirmed', 'render_mode': 'literal-text', 'semantic_kind': 'text-symbol', 'selectable_text': native_text, 'source_crop_required': False, 'fallback_bbox': None, 'candidate_content': content[start:end], 'source_glyph_ids': [c['glyph_id'] for c in bounded], 'reason': None}
            audits.append(audit)
            continue
        if included and not bare and evidence['alignment_coverage'] >= .85:
            # A typographic quote already present in prose must not enter the math span.
            preceding = re.sub(r'<[^>]*>', '', content[:start]).rstrip()
            if preceding.endswith(('"', '“', '”')) and included[0]['resolved_text'] in {'"', '“', '”'}:
                included = included[1:]
            latex, boundary_changes = reconcile_inline_boundaries(latex, page, included, region)
            parsed = TexAtoms(latex)
        if not included or evidence['alignment_coverage'] < .75 and not local_formula:
            audits.append(unresolved('inline_crop_alignment_unavailable'))
            continue
        geometry = page.inline_geometry([c['glyph_id'] for c in included], region)
        target = ''.join(atom['text'] for atom in (script_atoms if bare else parsed.atoms))
        source = ''.join(math_canonical(c['resolved_text']) for c in included)
        script_kinds = {atom['script'][0] for atom in script_atoms}
        if bare and len(script_atoms) == 1 and source in {'∗', '†', '‡'} and target == source and geometry.get('status') == 'confirmed' and geometry.get('script_kind') is None and not content[:start].strip() and re.match(r'\s+[A-Za-z]{3,}', content[end:]):
            audits.append({'start': start, 'end': end, 'status': 'confirmed', 'render_mode': 'literal-text', 'semantic_kind': 'text-marker', 'selectable_text': ''.join(c['resolved_text'] for c in included), 'candidate_content': content[start:end], 'source_crop_required': False, 'fallback_bbox': None, 'reason': None, 'native_geometry': geometry, 'source_glyph_ids': [c['glyph_id'] for c in included]})
            continue
        if geometry.get('status') == 'confirmed' and geometry.get('script_kind') in {'sup', 'sub'} and not parsed.unknown and 1 <= len(parsed.atoms) <= 8 and not any(atom['script'] or set(atom['styles']) - {'mathrm'} or atom['role'] not in {None, 'operator'} for atom in parsed.atoms):
            source_text = ''.join(c['canonical'] for c in included)
            if re.fullmatch(r'[A-Za-z0-9,;†‡*]+', source_text) and target.casefold() == source_text.casefold() and all(not c.get('math_style') and not c['font_evidence'].get('bold') for c in included):
                script = geometry['script_kind']
                segments = selectable_script_segments(('^' if script == 'sup' else '_') + '{' + source_text + '}', page, region, [c['glyph_id'] for c in included], region)
                if segments:
                    audits.append({'start': start, 'end': end, 'status': 'confirmed', 'render_mode': 'native-script', 'semantic_kind': 'math-script', 'script_kind': script, 'selectable_text': source_text, 'selectable_segments': segments, 'candidate_content': content[start:end], 'source_crop_required': False, 'fallback_bbox': None, 'reason': None, 'changes': [{'before': latex, 'after': source_text, 'reason': 'native_uniform_script_geometry'}], 'native_geometry': geometry, **{key: geometry[key] for key in ['source_bbox_normalized', 'source_glyph_ids', 'body_baseline_normalized', 'body_font_size_points', 'height_em', 'baseline_offset_em']}})
                    continue
        if bare and not parsed.unknown and all(c['canonical'] and not c['rotated'] for c in included) and target == source and len(script_kinds) == 1 and geometry.get('script_kind') == next(iter(script_kinds)):
            script = geometry['script_kind']
            word = re.search(r'([A-Za-z]{3,})[.,;:!?)]?\s*$', content[:start])
            citation = script == 'sup' and bool(re.fullmatch(r'[\d,;–—\-\[\]()†‡*]+', target)) and word is not None
            audit = {'status': 'confirmed', 'render_mode': 'native-script', 'semantic_kind': 'citation-marker' if citation else 'math-script', 'script_kind': script, 'selectable_text': ''.join(c['resolved_text'] for c in included), 'source_crop_required': False, 'fallback_bbox': None, 'candidate_content': content[start:end], 'native_geometry': geometry, **{key: geometry[key] for key in ['source_bbox_normalized', 'source_glyph_ids', 'body_baseline_normalized', 'body_font_size_points', 'height_em', 'baseline_offset_em']}}
            if trailing_atoms:
                trailing = [c for c in bounded if c['glyph_id'] > max(inside) and c['canonical'] in punctuation and abs(c['baseline'] / page.height - geometry['body_baseline_normalized']) * page.height < geometry['body_font_size_points'] * .2]
                if not trailing:
                    audits.append(unresolved('script_trailing_punctuation_unresolved'))
                    continue
                value = ''.join(c['resolved_text'] for c in trailing)
                audit['selectable_segments'] = [{'text': audit['selectable_text'], 'script_kind': script, 'source_glyph_ids': audit['source_glyph_ids']}, {'text': value, 'source_glyph_ids': [c['glyph_id'] for c in trailing]}]
                audit['selectable_text'] += value
            audit.update(start=start, end=end)
            audits.append(audit)
            continue
        if geometry.get('status') != 'confirmed' and geometry.get('reason') not in {'inline_body_baseline_unavailable', 'inline_multiline_geometry'}:
            audit = unresolved(geometry.get('reason', 'inline_native_geometry_ambiguous'))
            audit['native_geometry'] = geometry
            audits.append(audit)
            continue
        box = geometry.get('source_bbox_normalized') or [min(c['x0'] for c in included) / page.width, min(c['top'] for c in included) / page.height, max(c['x1'] for c in included) / page.width, max(c['bottom'] for c in included) / page.height]
        fixed, audit = assess_formula(latex, None, page, box, glyph_ids=[c['glyph_id'] for c in included], context_region=region)
        audit.update(render_mode='mathml' if audit['status'] == 'confirmed' else 'source-crop', semantic_kind='formula', selectable_text=readable_candidate(fixed), native_geometry=geometry, **{key: geometry[key] for key in ['source_bbox_normalized', 'source_glyph_ids', 'body_baseline_normalized', 'body_font_size_points', 'height_em', 'baseline_offset_em'] if key in geometry})
        if boundary_changes:
            audit['changes'] = boundary_changes + audit.get('changes', [])
        if local_formula:
            audit['alignment_basis'] = 'unique-native-formula-with-two-prose-anchors'
        if audit['status'] == 'confirmed' and (bare or TexAtoms(fixed).atoms and all(atom['script'] for atom in TexAtoms(fixed).atoms)):
            segments = selectable_script_segments(fixed, page, box, [c['glyph_id'] for c in included], region)
            if segments:
                audit.update(render_mode='native-script', semantic_kind='math-script', selectable_segments=segments, selectable_text=''.join(segment['text'] for segment in segments))
        if audit['status'] != 'confirmed' and geometry.get('status') != 'confirmed':
            audit.update(source_crop_required=False, fallback_bbox=None, render_mode='candidate-unresolved', reason=geometry['reason'])
        if bare and audit['status'] != 'confirmed':
            audit.update(source_crop_required=False, fallback_bbox=None, render_mode='candidate-unresolved', semantic_kind='math-script', reason='bare_script_native_evidence_unresolved', script_kind=next(iter(script_kinds)) if len(script_kinds) == 1 else None)
        if audit['source_crop_required']:
            selected = next(c for c in audit['candidates'] if c['engine'] == audit['selected_engine'])
            decorations = {'hat': 'ˆ^̂', 'bar': '¯ˉ̄', 'tilde': '~˜̃', 'vec': '→⃗', 'sqrt': '√'}
            allowed = ''.join(decorations.get(macro, '') for macro in parsed.unknown)
            unmatched = selected['unmatched_native_text']
            exclusive = (selected['native_coverage'] == 1 or bool(unmatched) and all(char in allowed for char in unmatched)) and not geometry.get('crop_foreign_glyph_ids')
            complete = selected['alignment_coverage'] == 1 and exclusive and not (parsed.unknown and (previous_adjacent or next_adjacent))
            audit['crop_completeness'] = {'known_candidate_atoms_covered': selected['alignment_coverage'], 'selected_native_atoms_covered': selected['native_coverage'], 'unmatched_native_text': unmatched, 'exclusive_to_candidate': exclusive, 'complete': complete}
            if not complete:
                audit.update(source_crop_required=False, fallback_bbox=None, render_mode='candidate-unresolved', reason='formula_crop_atom_coverage_incomplete' if exclusive else 'formula_crop_contains_unmatched_native_text')
        audit.update(start=start, end=end)
        audits.append(audit)
        if fixed != original_latex:
            edits.append((start, end, '$' + fixed + '$'))
    for start, end, replacement in reversed(edits):
        content = content[:start] + replacement + content[end:]
    return content, audits


def locate_inline_audits(content, audits):
    cursor = 0
    for audit in audits:
        candidate = audit['candidate_content']
        needle = candidate if audit.get('exact_candidate_range') or candidate.startswith('$') else '$' + candidate + '$'
        index = content.find(needle, cursor)
        if index >= 0:
            audit.update(start=index, end=index + len(needle), candidate_content=needle)
            cursor = index + len(needle)
        else:
            audit.update(start=None, end=None, source_crop_required=False, status='unresolved', reason='inline_output_range_unavailable')


def inline_block_audit(content, audits, region, text_primary=True):
    block_required = not text_primary and any(a.get('status') != 'confirmed' and not a.get('source_crop_required') for a in audits)
    return {'inline': audits, 'status': 'confirmed' if all(a['status'] == 'confirmed' for a in audits) else 'unresolved', 'source_crop_required': False, 'source_block_required': block_required, 'fallback_bbox': list(region) if block_required else None, 'candidate_content': content if block_required else None, 'text_primary': text_primary}


def restore_table_math(content, page, region):
    soup = BeautifulSoup(content, 'html.parser')
    nodes = list(soup.find_all(string=True))
    text = '\n'.join(str(node) for node in nodes)
    _, audits = restore_inline_math(text, page, region, recover=False)
    cursor = 0
    for node in nodes:
        value = str(node)
        edits = []
        for start, end, _ in math_spans(value):
            audit = audits[cursor]
            cursor += 1
            candidate = audit['candidate_content']
            edits.append((start, end, candidate if candidate.startswith('$') else '$' + candidate + '$'))
        if edits:
            for start, end, replacement in reversed(edits):
                value = value[:start] + replacement + value[end:]
            node.replace_with(value)
    return str(soup), audits


def table_script_audit(content, page, region):
    soup = BeautifulSoup(content, 'html.parser')
    table_cells = soup.find_all(['td', 'th'])
    texts = [cell.get_text() for cell in table_cells]
    joined = '\n'.join(texts)
    mapped, evidence = page.align(joined, region)
    issues, offset = [], 0
    for index, (cell, text) in enumerate(zip(table_cells, texts)):
        if not cell.find(['sub', 'sup']) and not math_spans(text):
            glyphs = {c['glyph_id']: c for i in range(offset, offset + len(text)) for c in mapped.get(i, [])}
            previous = None
            for c in glyphs.values():
                if previous and c.get('size', 10) < previous.get('size', 10) * .85 and abs(c['x0'] - previous['x1']) < previous.get('size', 10) * 1.5:
                    delta = c['baseline'] - previous['baseline']
                    if .08 * previous.get('size', 10) < abs(delta) < previous.get('size', 10):
                        issues.append({'cell_index': index, 'text': text, 'script': 'sub' if delta > 0 else 'sup', 'source_glyph_id': c['glyph_id'], 'base_glyph_id': previous['glyph_id']})
                        continue
                previous = c
        offset += len(text) + 1
    return {'status': 'unresolved' if issues or evidence['alignment_coverage'] < .75 else 'confirmed', 'lost_native_scripts': issues, 'alignment_coverage': evidence['alignment_coverage']}


def norm(text):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', text or '')).casefold()


def bbox(block, glm=False):
    value = block.get('bbox_2d' if glm else 'bbox', [0, 0, 0, 0])
    return [float(x) / (1000 if glm else 1) for x in value]


def area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def intersection(a, b):
    return area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def overlap(a, b):
    return intersection(a, b) / max(1e-12, min(area(a), area(b)))


def match(block, candidates, types):
    a = bbox(block, True)
    scored = []
    for i, candidate in enumerate(candidates):
        if candidate['type'] not in types:
            continue
        b = bbox(candidate)
        cover = intersection(a, b) / max(1e-12, area(a))
        iou = intersection(a, b) / max(1e-12, area(a) + area(b) - intersection(a, b))
        if cover >= .70:
            scored.append((iou, i, candidate))
    return max(scored, default=(None, None, None), key=lambda x: x[0] or 0)[1:]


def equation_number_region(page, region, other_region=None, peers=()):
    chars = [c for c in page.region(region) if c['canonical'] and not c['rotated']]
    height = max((c.get('size', 10) for c in chars), default=10) / page.height
    top, bottom = max(0, region[1] - height), min(1, region[3] + height * 1.5)
    for peer in peers:
        if min(region[2], peer[2]) <= max(region[0], peer[0]):
            continue
        if peer[3] <= region[1]:
            top = max(top, (peer[3] + region[1]) / 2)
        elif peer[1] >= region[3]:
            bottom = min(bottom, (region[3] + peer[1]) / 2)
    return [region[0], top, max(region[2], other_region[2]) if other_region else region[2], bottom]


def cells(row):
    return row.find_all(['td', 'th'], recursive=False)


def span(cell, name):
    return max(1, int(cell.get(name, 1)))


def row_key(row):
    return tuple(norm(c.get_text()) for c in cells(row))


def table_grid(rows):
    occupied, layout = {}, []
    for r, row in enumerate(rows):
        placed, col = [], 0
        for cell in cells(row):
            while (r, col) in occupied:
                col += 1
            rs, cs = span(cell, 'rowspan'), span(cell, 'colspan')
            placed.append((cell, col, col + cs, rs))
            for rr in range(r, r + rs):
                for cc in range(col, col + cs):
                    if (rr, cc) in occupied:
                        raise ValueError('overlapping_table_cells')
                    occupied[rr, cc] = cell
            col += cs
        width = max([cc + 1 for rr, cc in occupied if rr == r], default=0)
        layout.append((width, placed))
    return layout


def numeric_tokens(content):
    return re.findall(r'\d+(?:\.\d+)?', BeautifulSoup(content, 'html.parser').get_text(' '))


def normalize_table(content, mineru_content=None):
    soup = BeautifulSoup(content, 'html.parser')
    rows = soup.find_all('tr')
    if not rows:
        return content, [], ['table_html_unavailable']
    changes, flags = [], []
    try:
        grid = table_grid(rows)
        # Repeated multi-cell rows define width; single-cell group labels cannot outvote it.
        widths = [w for w, placed in grid if len(placed) > 1]
        if not widths:
            return content, [], ['table_grid_width_unresolved']
        width = Counter(widths).most_common(1)[0][0]
        for ri, row in enumerate(rows):
            cs = cells(row)
            if len(cs) == 1 and span(cs[0], 'colspan') > width:
                old = span(cs[0], 'colspan')
                cs[0]['colspan'] = str(width)
                changes.append({'operation': 'normalize_table_grid', 'row': ri, 'old_colspan': old, 'colspan': width})
        if mineru_content and '<table' in mineru_content:
            native = BeautifulSoup(mineru_content, 'html.parser')
            mr = native.find_all('tr')
            # Body-row anchors establish independent header depth, even when one engine collapses header rows.
            anchors = [(ri, mi) for ri, row in enumerate(rows) for mi, other in enumerate(mr) if len(cells(row)) >= 3 and row_key(row) == row_key(other) and any(re.search(r'\d', c.get_text()) for c in cells(row)[1:])]
            if anchors:
                gh, mh = min(anchors)
                for ri, row in enumerate(rows[:gh]):
                    cs = cells(row)
                    if len(cs) > 1 and norm(cs[0].get_text()) and all(not norm(c.get_text()) for c in cs[1:]):
                        group = [mi for mi, r in enumerate(mr[:mh]) if len(cells(r)) == 1 and norm(cells(r)[0].get_text()) == norm(cs[0].get_text())]
                        if len(group) == 1:
                            gh, mh = ri, group[0]
                            break
                if 0 < gh <= 6 and 0 < mh <= 6 and mr:
                    gc = cells(rows[0]); mc = cells(mr[0])
                    if gc and mc and not norm(gc[0].get_text()) and norm(mc[0].get_text()) and span(mc[0], 'rowspan') > 1:
                        label = mc[0].get_text()
                        matching = [ri for ri in range(gh) if cells(rows[ri]) and norm(cells(rows[ri])[0].get_text()) == norm(label)]
                        blank = all(cells(rows[ri]) and not norm(cells(rows[ri])[0].get_text()) for ri in range(gh))
                        # Confirm the rest of the header remains in the same table using shared text anchors.
                        gt = ''.join(norm(c.get_text()) for _, placed in table_grid(rows[:gh]) for c, col, _, _ in placed if col > 0)
                        mt = ''.join(norm(c.get_text()) for _, placed in table_grid(mr[:mh]) for c, col, _, _ in placed if col > 0)
                        from difflib import SequenceMatcher
                        similarity = SequenceMatcher(None, gt, mt).ratio()
                        if (blank or matching == [1]) and similarity >= .72:
                            gc[0].string = label
                            gc[0]['rowspan'] = str(gh)
                            for ri in range(1, gh):
                                cells(rows[ri])[0].decompose()
                            changes.append({'operation': 'transfer_header_cell', 'row': 0, 'column': 0, 'rowspan': gh, 'text': label, 'header_anchor_similarity': similarity})
                        else:
                            flags.append('table_header_transfer_not_confident')
            # A repeated label followed by empty cells may be a merged group row in the other source.
            for ri, row in enumerate(rows):
                cs = cells(row)
                if len(cs) > 1 and norm(cs[0].get_text()) and all(not norm(c.get_text()) for c in cs[1:]):
                    matches = [r for r in mr if len(cells(r)) == 1 and norm(cells(r)[0].get_text()) == norm(cs[0].get_text()) and span(cells(r)[0], 'colspan') == width]
                    if len(matches) == 1:
                        cs[0]['colspan'] = str(width)
                        for cell in cs[1:]:
                            cell.decompose()
                        changes.append({'operation': 'normalize_table_grid', 'row': ri, 'colspan': width, 'cross_source_group_label': cs[0].get_text()})
        final = table_grid(rows)
        if any(w != width for w, _ in final):
            return content, [], flags + ['table_grid_width_inconsistent']
    except (ValueError, TypeError) as exc:
        return content, [], ['table_grid_invalid:' + str(exc)]
    result = str(soup) if changes else content
    # Header text can contain digits; require every original numeric token to survive in order.
    before, after = numeric_tokens(content), numeric_tokens(result)
    if before != after:
        return content, [], ['table_numeric_invariant_failed']
    return result, changes, flags


def source_path(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('Missing or outside asset root: ' + str(relative))
    return path


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def image_metadata(path):
    with Image.open(path) as image:
        return {'width': image.width, 'height': image.height, 'pixels': image.width * image.height}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def fuse(args):
    started = time.perf_counter()
    out = args.output.resolve()
    if out.exists() and any(out.iterdir()):
        raise ValueError('Output must be absent or empty: ' + str(out))
    for source in [args.pdf, args.glm_json, args.mineru_json]:
        if source.resolve().is_relative_to(out):
            raise ValueError('Output cannot contain input files')
    (out / 'pages').mkdir(parents=True, exist_ok=True)
    (out / 'images').mkdir()
    glm = json.loads(args.glm_json.read_text())
    mineru = json.loads(args.mineru_json.read_text())
    if isinstance(glm, dict):
        glm = glm['pages']
    mpages = {p.get('page_idx', i): p['blocks'] for i, p in enumerate(mineru['pages'])}
    decisions, flags, pages, assets, suppressed = [], [], [], [], []
    def event(page, gi, operation, mi=None, **extra):
        record = {'page': page, 'glm_block_index': gi, 'operation': operation, **extra}
        if mi is not None:
            record['mineru_block_index'] = mi
        decisions.append(record)
        return record
    with NativePDF(args.pdf) as nativepdf:
        pdf = nativepdf.pdf
        if len(glm) != len(pdf.pages) or set(mpages) != set(range(len(pdf.pages))):
            raise ValueError('PDF/GLM/MinerU page coverage differs')
        for pi, source_blocks in enumerate(glm):
            if isinstance(source_blocks, dict):
                source_blocks = source_blocks['blocks']
            n, mb, pdfpage = pi + 1, mpages[pi], pdf.pages[pi]
            nativepage = nativepdf.page(pi)
            blocks, removed, page_flags = copy.deepcopy(source_blocks), set(), []
            for gi, block in enumerate(blocks):
                block['source_page'] = n
                block['source_bbox_normalized'] = bbox(block, True)
                block['fusion_provenance'] = [{'engine': 'glm', 'file': str(args.glm_json), 'pointer': f'/{pi}/{gi}', 'operation': 'keep_native_content'}]
                block['fusion_annotations'], block['review_flags'] = [], []
            for duplicate in aggregate_reference_duplicates(blocks):
                gi = duplicate['aggregate_index']
                removed.add(gi)
                record = event(n, gi, 'suppress_aggregate_reference', **duplicate)
                suppressed.append({'page': n, 'block': copy.deepcopy(blocks[gi]), 'decision': record})
                for retained in duplicate['retained_indices']:
                    blocks[retained]['fusion_provenance'].append({'engine': 'glm', 'file': str(args.glm_json), 'pointer': f'/{pi}/{gi}', 'operation': 'retain_finer_reference_instead_of_aggregate', 'aggregate_content_coverage': duplicate['content_coverage']})
            def annotate(gi, operation, mi=None, **extra):
                record = event(n, gi, operation, mi, **extra)
                blocks[gi]['fusion_annotations'].append(record)
                if mi is not None:
                    blocks[gi]['fusion_provenance'].append({'engine': 'mineru', 'file': str(args.mineru_json), 'pointer': f'/pages/{pi}/blocks/{mi}', 'operation': operation})
            def flag(gi, reason):
                record = {'page': n, 'glm_block_index': gi, 'reason': reason}
                flags.append(record); page_flags.append(record)
                blocks[gi]['review_flags'].append(reason)
            for gi, block in enumerate(blocks):
                if gi in removed:
                    continue
                label, content = block['label'], block.get('content') or ''
                region = bbox(block, True)
                if label in {'text', 'reference', 'footnote'}:
                    # Literal currency must not pair with later formula delimiters.
                    normalized, dollar_changes = normalize_currency_dollars(content, nativepage, region)
                    recovered, native_changes = restore_native_prose(normalized, nativepage, region)
                    fixed, audits = restore_inline_math(recovered, nativepage, region)
                    if dollar_changes:
                        block['text_corrections'] = dollar_changes
                        block['original_candidate_content'] = content
                        annotate(gi, 'preserve_native_currency_dollars', changes=dollar_changes)
                    if native_changes:
                        block['native_text_corrections'] = native_changes
                        annotate(gi, 'restore_prose_by_native_glyphs', changes=native_changes)
                    if audits:
                        for audit in audits:
                            if audit.get('changes'):
                                annotate(gi, 'repair_inline_math_by_native_glyphs', changes=audit['changes'], source_bbox=audit['fallback_bbox'])
                            if audit['status'] != 'confirmed':
                                flag(gi, audit['reason'])
                    fused, spans, evidence = restore_styles(fixed, nativepage, region)
                    locate_inline_audits(fused, audits)
                    if audits:
                        block['math_audit'] = inline_block_audit(fused, audits, region)
                    block['content'], block['style_spans'], block['native_evidence'] = fused, spans, evidence
                    if spans:
                        annotate(gi, 'restore_emphasis_by_native_glyphs', span_count=len(spans), styles=dict(Counter(s for span in spans for s in span['styles'])))
                elif label == 'formula':
                    mi, other = match(block, mb, {'equation'})
                    fixed, audit = assess_formula(content, other.get('content') if other else None, nativepage, region)
                    peers = [bbox(peer, True) for pj, peer in enumerate(blocks) if pj != gi and peer.get('label') == 'formula']
                    number_region = equation_number_region(nativepage, region, bbox(other) if other else None, peers)
                    fixed, number_audit = reconcile_equation_number(fixed, nativepage, number_region)
                    audit['equation_number'] = number_audit
                    audit['candidate_content'] = fixed
                    if number_audit['status'] == 'unresolved':
                        audit.update(status='unresolved', reason='equation_number_unverified', source_crop_required=True)
                    if audit['source_crop_required']:
                        number_box = number_audit.get('source_bbox') if number_audit['status'] == 'confirmed' else None
                        audit['fallback_bbox'] = [min(region[0], number_box[0]), min(region[1], number_box[1]), max(region[2], number_box[2]), max(region[3], number_box[3])] if number_box else list(region)
                    block['content'] = '$$\n' + fixed.strip().removeprefix('$$').removesuffix('$$').strip() + '\n$$'
                    block['math_audit'] = audit
                    annotate(gi, 'select_equation_by_native_atoms', mi, selected_engine=audit['selected_engine'], status=audit['status'], evidence=audit)
                    if audit['status'] != 'confirmed':
                        flag(gi, audit['reason'])
                elif label == 'table':
                    mi, other = match(block, mb, {'table'})
                    fused, changes, issues = normalize_table(content, other.get('content') if other else None)
                    fused, audits = restore_table_math(fused, nativepage, region)
                    fused, spans, evidence = restore_styles(fused, nativepage, region, table=True)
                    if audits:
                        locate_inline_audits(fused, audits)
                        block['math_audit'] = inline_block_audit(fused, audits, region, text_primary=False)
                        for audit in audits:
                            if audit['status'] != 'confirmed':
                                flag(gi, audit['reason'])
                    block['content'], block['style_spans'], block['native_evidence'] = fused, spans, evidence
                    scripts = table_script_audit(fused, nativepage, region)
                    block['table_script_audit'] = scripts
                    if scripts['status'] != 'confirmed' or issues:
                        block['needs_source_table'] = True
                        block['render_fallback'] = {'mode': 'source-crop', 'bbox': list(region), 'reason': 'table_native_scripts_or_structure_unresolved', 'candidate_content': fused}
                        flag(gi, 'table_native_scripts_or_structure_unresolved')
                    if spans:
                        annotate(gi, 'restore_table_emphasis_by_native_glyphs', mi, span_count=len(spans), styles=dict(Counter(s for span in spans for s in span['styles'])))
                    for change in changes:
                        annotate(gi, change.pop('operation'), mi, **change)
                    for reason in issues:
                        flag(gi, reason)
                    if evidence['alignment_coverage'] < .75:
                        flag(gi, 'table_native_style_alignment_unavailable')
            # Larger existing crops can cover multiple disjoint GLM subfigures.
            # A caption or other GLM content inside the proposed expansion prevents grouping.
            image_indices = [i for i, b in enumerate(blocks) if b['label'] == 'image']
            proposals = []
            for mi, other in enumerate(mb):
                if other['type'] != 'image' or not other.get('image_source'):
                    continue
                region = bbox(other)
                contained = [i for i in image_indices if intersection(bbox(blocks[i], True), region) / max(1e-12, area(bbox(blocks[i], True))) >= .92]
                if len(contained) < 2:
                    continue
                occupied = sum(area(bbox(blocks[i], True)) for i in contained)
                intrusion = any(i not in contained and intersection(bbox(b, True), region) / max(1e-12, area(bbox(b, True))) > .3 for i, b in enumerate(blocks))
                disjoint = all(overlap(bbox(blocks[a], True), bbox(blocks[b], True)) < .15 for a in contained for b in contained if a < b)
                if not intrusion and disjoint and occupied / max(1e-12, area(region)) >= .55:
                    proposals.append((occupied / area(region), mi, contained))
            selected = {}
            for _, mi, contained in sorted(proposals, reverse=True):
                if any(i in selected or i in removed for i in contained):
                    continue
                first, *rest = contained
                selected[first] = mi
                removed.update(rest)
                annotate(first, 'group_existing_crops', mi, grouped_glm_block_indices=contained)
                for gi in rest:
                    annotate(gi, 'deduplicate_contained_glm_image', mi, retained_glm_block_index=first)
            for gi in image_indices:
                if gi in removed:
                    continue
                block, chosen, mi = blocks[gi], 'glm', selected.get(gi)
                gpath = source_path(args.glm_assets, block['image_path'])
                gm = image_metadata(gpath)
                source, region = gpath, bbox(block, True)
                if mi is None:
                    mi, other = match(block, mb, {'image'})
                else:
                    other = mb[mi]
                reason = 'keep_glm_crop'
                if other and other.get('image_source'):
                    mpath = source_path(args.mineru_assets, other['image_source'])
                    mm, mbox = image_metadata(mpath), bbox(other)
                    growth = area(mbox) / max(1e-12, area(region))
                    intrusion = any(i != gi and i not in removed and intersection(bbox(b, True), mbox) / max(1e-12, area(bbox(b, True))) > .3 for i, b in enumerate(blocks))
                    # Containment is required: a crop that trades one edge for another is unresolved.
                    contains = intersection(region, mbox) / max(1e-12, area(region)) >= .92
                    if gi in selected or (contains and not intrusion and 1.01 <= growth <= 1.50 and mm['pixels'] >= gm['pixels'] * .55):
                        chosen, source, region = 'mineru', mpath, mbox
                        reason = 'larger_same_region_existing_crop'
                dest = out / 'images' / f'p{n:03d}-b{gi:03d}-{chosen}{source.suffix.lower()}'
                shutil.copyfile(source, dest)
                block['image_path'] = dest.relative_to(out).as_posix()
                block['source_bbox_normalized'] = region
                crossing = []
                for other_index, text_block in enumerate(blocks):
                    if other_index in removed or text_block.get('label') not in {'text', 'reference', 'footnote'}:
                        continue
                    text_box = bbox(text_block, True)
                    crosses = text_box[1] < region[1] < text_box[3] or text_box[1] < region[3] < text_box[3]
                    if crosses and intersection(text_box, region) / max(area(text_box), 1e-12) >= .15:
                        crossing.append({'glm_block_index': other_index, 'bbox': text_box})
                if crossing:
                    block['visual_audit'] = {'status': 'unresolved', 'reason': 'image_crop_intersects_external_text', 'crossing_text_blocks': crossing}
                    flag(gi, 'image_crop_intersects_external_text')
                source_digest, output_digest = sha(source), sha(dest)
                assert source_digest == output_digest
                asset = {'page': n, 'glm_block_index': gi, 'engine': chosen, 'source': str(source), 'output': block['image_path'], 'sha256': output_digest, 'source_sha256': source_digest, 'identical_bytes': True, **image_metadata(dest)}
                assets.append(asset)
                annotate(gi, 'select_existing_crop', mi if chosen == 'mineru' else None, selected_engine=chosen, reason=reason, asset=asset)
            kept, markdown = [], []
            for gi, block in enumerate(blocks):
                if gi in removed:
                    continue
                block['output_order'] = len(kept)
                kept.append(block)
                markdown.append(f'![Image]({block["image_path"]})' if block['label'] == 'image' else (block.get('content') or ''))
            page = {'schema': SCHEMA, 'physical_page': n, 'source_page': n, 'page_index': pi, 'base_reading_order': 'glm', 'blocks': kept, 'suppressed': [s for s in suppressed if s['page'] == n], 'decisions': [d for d in decisions if d['page'] == n], 'review_flags': page_flags}
            pages.append(page)
            write_json(out / 'pages' / f'page-{n:03d}.json', page)
            # Page Markdown paths are relative to its own directory.
            page_md = '\n\n'.join(markdown) + '\n'
            page['markdown'] = page_md
            (out / 'pages' / f'page-{n:03d}.md').write_text(page_md.replace('](images/', '](../images/'))
            pdfpage.close()
    inputs = {name: {'path': str(path), 'sha256': sha(path)} for name, path in [('pdf', args.pdf), ('glm_json', args.glm_json), ('mineru_json', args.mineru_json)]}
    (out / 'document.md').write_text('\n\n'.join(f'<!-- PDF page {p["physical_page"]} -->\n\n' + p.pop('markdown') for p in pages))
    write_json(out / 'document.json', {'schema': SCHEMA, 'pages': pages, 'suppressed': suppressed})
    write_json(out / 'decisions.json', {'schema': SCHEMA, 'decisions': decisions, 'review_flags': flags, 'assets': assets})
    counts = dict(Counter(d['operation'] for d in decisions))
    math_audits = [audit for p in pages for b in p['blocks'] for audit in (b.get('math_audit', {}).get('inline', []) if 'inline' in b.get('math_audit', {}) else [b['math_audit']] if b.get('math_audit') else [])]
    style_spans = [span for p in pages for b in p['blocks'] for span in b.get('style_spans', [])]
    quality = {'math': dict(Counter(a['status'] for a in math_audits)), 'math_source_crop_required': sum(a['source_crop_required'] for a in math_audits), 'math_source_block_required': sum(bool(b.get('math_audit', {}).get('source_block_required')) for p in pages for b in p['blocks']), 'native_style_spans_confirmed': len(style_spans), 'native_style_counts': dict(Counter(style for span in style_spans for style in span['styles'])), 'native_style_blocks': dict(Counter(b['native_evidence']['status'] for p in pages for b in p['blocks'] if b.get('native_evidence'))), 'suppressed_reference_aggregates': len(suppressed)}
    quality['source_tables_required'] = sum(bool(b.get('needs_source_table')) for p in pages for b in p['blocks'])
    quality['selectable_native_script_spans'] = sum(a.get('render_mode') == 'native-script' for a in math_audits)
    quality['selectable_citation_spans'] = sum(a.get('semantic_kind') == 'citation-marker' for a in math_audits)
    quality['unlocalized_inline_candidates'] = sum(a.get('render_mode') == 'candidate-unresolved' for a in math_audits)
    quality['text_source_block_required'] = sum(bool(b.get('math_audit', {}).get('source_block_required')) for p in pages for b in p['blocks'] if b['label'] in {'text', 'reference', 'footnote'})
    summary = {'schema': SCHEMA, 'algorithm_version': 'fusion-native-selectable-v3', 'automatic': True, 'inference_performed': False, 'page_count': len(pages), 'block_count': sum(len(p['blocks']) for p in pages), 'inputs': inputs, 'input_sha256': {k: v['sha256'] for k, v in inputs.items()}, 'counts': counts, 'quality': quality, 'review_flag_count': len(flags), 'asset_count': len(assets), 'limitations': ['Prose and reference markers remain text-primary; only reliable local formula regions request image crops.', 'Unsupported mathematical syntax, ambiguous glyphs and script relations retain readable candidates and review evidence.', 'Style confirmation requires native glyph alignment and embedded-font or vector-line evidence; image-only text cannot be certified by these rules.', 'Image selection uses existing crop geometry and pixel counts; it cannot certify every visual label or recover omitted source content.', 'GLM reading order and coverage are retained; unmatched MinerU content is not inserted.'], 'timing': {'method': 'time.perf_counter', 'scope': 'input read, PDF character extraction, fusion, asset copies, checksums and all output writes including preliminary summary'}}
    write_json(out / 'summary.json', summary)
    summary['timing']['cpu_fusion_seconds'] = time.perf_counter() - started
    # Final measurement persistence is the sole write outside the measured interval.
    summary['timing']['excludes'] = 'final persistence of measured timing field only'
    write_json(out / 'summary.json', summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['pdf', 'glm-json', 'mineru-json', 'glm-assets', 'mineru-assets', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    summary = fuse(args)
    print(json.dumps({'output': str(args.output), 'page_count': summary['page_count'], 'counts': summary['counts'], 'review_flag_count': summary['review_flag_count'], 'cpu_fusion_seconds': summary['timing']['cpu_fusion_seconds']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
