"""Restore selectable algorithm lines only when PDF glyphs prove their structure."""
import html
import re
import statistics
from contextlib import closing


_SCRIPT_CAPITALS = dict(zip(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵',
))
_LIGATURES = str.maketrans({'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl'})


def _text(char):
    value = char['resolved_text'].translate(_LIGATURES)
    if char.get('math_style') == 'mathcal' and value in _SCRIPT_CAPITALS:
        return _SCRIPT_CAPITALS[value]
    base_font = re.sub(r'^[A-Z]{6}\+', '', char.get('fontname', '')).lower()
    if re.match(r'(?:dsrom|msbm)', base_font) and len(value) == 1 and value.isascii() and value.isdigit():
        return chr(0x1D7D8 + int(value))
    return value


def _intersects(left, right):
    return min(left[2], right[2]) - max(left[0], right[0]) > .001 and min(left[3], right[3]) - max(left[1], right[1]) > .001


def _algorithm_ink_boxes(page, chars):
    boxes = dict(page.tight_glyph_boxes())
    missing = [c for c in chars if c['text'].strip() and c['glyph_id'] not in boxes]
    if not missing:
        return boxes, {}
    source = getattr(getattr(getattr(page.page, 'pdf', None), 'stream', None), 'name', None)
    if not isinstance(source, str) or getattr(page.page, 'rotation', 0):
        return boxes, {}
    import pypdfium2 as pdfium

    extra = {}
    with pdfium.PdfDocument(source) as document:
        with closing(document[page.page.page_number - 1]) as pdfpage:
            if abs(pdfpage.get_width() - page.width) > .1 or abs(pdfpage.get_height() - page.height) > .1:
                return boxes, extra
            with closing(pdfpage.get_textpage()) as textpage:
                candidates = []
                known_boxes = {tuple(round(v, 5) for v in box) for box in boxes.values()}
                for index in range(textpage.count_chars()):
                    left, bottom, right, top = textpage.get_charbox(index, loose=False)
                    if right > left and top > bottom:
                        box = [left, page.height - top, right, page.height - bottom]
                        if tuple(round(v, 5) for v in box) not in known_boxes:
                            candidates.append((index, box, textpage.get_text_range(index, 1)))
                used = set()
                for char in missing:
                    if not re.search(r'(?:CMEX|LMEX)', char.get('fontname', ''), re.I):
                        continue
                    size = char['size']
                    # TeX extensible glyphs descend from their origin. Their
                    # PDFium Unicode can be empty despite a valid ink box.
                    matches = [(index, box, text) for index, box, text in candidates
                               if index not in used and box[0] >= char['x0'] - size * .05
                               and box[2] <= char['x1'] + size * .05
                               and char['baseline'] - size * .1 <= box[1] <= char['baseline'] + size * .2
                               and box[3] <= char['baseline'] + size * 1.3]
                    if len(matches) == 1:
                        index, box, text = matches[0]
                        boxes[char['glyph_id']] = box
                        extra[char['glyph_id']] = {'pdfium_text_index': index, 'pdfium_unicode': text,
                                                   'mapping_method': 'tex-extensible-origin-and-advance'}
                        used.add(index)
    return boxes, extra


def _proven_crop(chars, context, page, body_size):
    boxes, extra = _algorithm_ink_boxes(page, context)
    ids = {c['glyph_id'] for c in chars}
    if not all(c['glyph_id'] in boxes for c in chars if c['text'].strip()):
        return None
    selected = [boxes[c['glyph_id']] for c in chars if c['text'].strip()]
    ink = [min(b[0] for b in selected), min(b[1] for b in selected), max(b[2] for b in selected), max(b[3] for b in selected)]
    foreign = []
    for char in context:
        if char['glyph_id'] in ids or not char['text'].strip():
            continue
        box = boxes.get(char['glyph_id'])
        if box is None:
            box = [char['x0'], char['top'], char['x1'], char['bottom']]
            if _intersects(ink, box):
                return None
        foreign.append((char['glyph_id'], box))
    if any(_intersects(ink, box) for _, box in foreign):
        return None
    padding = body_size * .02
    padded = [ink[0] - padding, ink[1] - padding, ink[2] + padding, ink[3] + padding]
    crop = ink if any(_intersects(padded, box) for _, box in foreign) else padded
    return {'bbox': [crop[0] / page.width, crop[1] / page.height, crop[2] / page.width, crop[3] / page.height],
            'ink_evidence': {'source': 'pdfium-tight-glyph-boxes', 'foreign_ink_glyph_ids': [],
                             'source_glyph_boxes': [{'glyph_id': c['glyph_id'], 'bbox_points': boxes[c['glyph_id']], **extra.get(c['glyph_id'], {})}
                                                    for c in chars if c['text'].strip()]}}


def _runs(chars, baseline, body_size):
    runs = []
    previous = None
    for char in sorted(chars, key=lambda c: (c['x0'], c['glyph_id'])):
        delta = char['baseline'] - baseline
        script = None
        if char['size'] < body_size * .85:
            if delta > body_size * .08:
                script = 'sub'
            elif delta < -body_size * .12:
                script = 'sup'
        value = _text(char)
        if previous is not None and char['x0'] - previous['x1'] > body_size * .16:
            runs.append({'text': ' ', 'script': script if runs and runs[-1]['script'] == script else None,
                         'bold': False, 'italic': False, 'source_glyph_ids': []})
        font = char.get('font_evidence', {})
        runs.append({'text': value, 'script': script,
                     'bold': bool(font.get('bold') or char.get('unicode_bold')),
                     'italic': bool(font.get('italic') or char.get('unicode_italic')),
                     'source_glyph_ids': [char['glyph_id']]})
        previous = char
    merged = []
    for run in runs:
        if merged and all(merged[-1][key] == run[key] for key in ('script', 'bold', 'italic')):
            merged[-1]['text'] += run['text']
            merged[-1]['source_glyph_ids'].extend(run['source_glyph_ids'])
        else:
            merged.append(dict(run))
    return merged


def _render_runs(runs):
    result = []
    for run in runs:
        value = html.escape(run['text'], quote=False)
        if run['italic']:
            value = '<em>' + value + '</em>'
        if run['bold']:
            value = '<strong>' + value + '</strong>'
        if run['script']:
            value = '<' + run['script'] + '>' + value + '</' + run['script'] + '>'
        result.append(value)
    return ''.join(result)


def _complex_reason(chars, baseline, body_size):
    if any(re.search(r'(?:CMEX|LMEX)', c.get('fontname', ''), re.I) for c in chars):
        return 'native_extensible_math_glyphs'
    if any(c['size'] >= body_size * .85 and abs(c['baseline'] - baseline) > body_size * .35 for c in chars):
        return 'native_math_spans_multiple_baselines'
    # Overprinted operators such as a membership sign plus a cancellation slash
    # need a local visual unless a logical glyph mapping proves their meaning.
    main = [c for c in chars if abs(c['baseline'] - baseline) < body_size * .2]
    for i, left in enumerate(main):
        for right in main[i + 1:]:
            width = min(left['x1'], right['x1']) - max(left['x0'], right['x0'])
            if width > .45 * min(left['x1'] - left['x0'], right['x1'] - right['x0']) and '/' in {left['resolved_text'], right['resolved_text']}:
                return 'native_overprinted_operator'
    return None


def restore_algorithm_text(page, bbox, *, native_label):
    """Return a proven algorithm layout, or None when native structure is unclear.

    ``local_crops`` describes only complex mathematical parts. Exporters replace
    matching ``data-algorithm-crop-id`` spans with a high-resolution source visual.
    Raw glyph strings for those parts are evidence, not verified copyable math.
    """
    if native_label != 'algorithm':
        return None
    chars = page.region(bbox, margin=0)
    if not chars or any(c.get('rotated') or (c['text'].strip() and not c.get('canonical')) for c in chars):
        return None
    chars = sorted(chars, key=lambda c: c['glyph_id'])
    body_size = statistics.median(c['size'] for c in chars if c['text'].strip())
    if body_size <= 0:
        return None
    main = sorted((c for c in chars if c['size'] >= body_size * .85 and c['text'].strip()),
                  key=lambda c: (c['baseline'], c['x0']))
    groups = []
    for char in main:
        if groups and abs(char['baseline'] - statistics.median(c['baseline'] for c in groups[-1])) <= body_size * .1:
            groups[-1].append(char)
        else:
            groups.append([char])
    anchors = []
    for group in groups:
        group = sorted(group, key=lambda c: c['x0'])
        compact = ''.join(c['resolved_text'] for c in group).replace(' ', '')
        number = re.match(r'^(\d{1,3}):', compact)
        title = re.match(r'^Algorithm(\d+)(?:\D|$)', compact)
        role = 'title' if title else 'require' if compact.startswith('Require:') else 'ensure' if compact.startswith('Ensure:') else 'code' if number else None
        if role:
            anchors.append({'role': role, 'number': int(number[1]) if number else None,
                            'algorithm_number': int(title[1]) if title else None,
                            'baseline': statistics.median(c['baseline'] for c in group),
                            'first_id': min(c['glyph_id'] for c in group), 'main_glyph_ids': {c['glyph_id'] for c in group}})
    numbers = [a['number'] for a in anchors if a['role'] == 'code']
    if not anchors or anchors[0]['role'] != 'title' or sum(a['role'] == 'title' for a in anchors) != 1 or len(numbers) < 3 or numbers != list(range(1, len(numbers) + 1)):
        return None
    roles = [a['role'] for a in anchors]
    if roles[1:3] != ['require', 'ensure'] or any(role == 'require' and (i + 1 == len(roles) or roles[i + 1] != 'ensure') for i, role in enumerate(roles)) or any(role == 'ensure' and (i == 0 or roles[i - 1] != 'require') for i, role in enumerate(roles)):
        return None
    if anchors[0]['first_id'] != chars[0]['glyph_id'] or [a['first_id'] for a in anchors] != sorted(a['first_id'] for a in anchors):
        return None
    for i, anchor in enumerate(anchors):
        end = anchors[i + 1]['first_id'] if i + 1 < len(anchors) else chars[-1]['glyph_id'] + 1
        anchor['chars'] = [c for c in chars if anchor['first_id'] <= c['glyph_id'] < end]
        if not anchor['main_glyph_ids'].issubset({c['glyph_id'] for c in anchor['chars']}) or any(abs(c['baseline'] - anchor['baseline']) > body_size * 1.05 for c in anchor['chars']):
            return None
    # The source stream and the visual anchors must agree. In particular a
    # shuffled text stream must not silently move a formula to the next line.
    covered = [c['glyph_id'] for a in anchors for c in a['chars']]
    if sorted(covered) != sorted(c['glyph_id'] for c in chars):
        return None
    content_origins = []
    for anchor in anchors:
        if anchor['role'] == 'code':
            ordered = sorted(anchor['chars'], key=lambda c: (c['x0'], c['glyph_id']))
            prefix = len(str(anchor['number'])) + 1
            if ''.join(c['resolved_text'] for c in ordered[:prefix]) != str(anchor['number']) + ':':
                return None
            anchor['label_chars'], anchor['body_chars'] = ordered[:prefix], ordered[prefix:]
            if not anchor['body_chars']:
                return None
            content_origins.append(min(c['x0'] for c in anchor['body_chars']))
    origin = min(content_origins)
    lines, crops = [], []
    cropped_ids = set()
    for index, anchor in enumerate(anchors):
        source = anchor['chars']
        runs = _runs(source, anchor['baseline'], body_size)
        raw_native_text = ''.join(run['text'] for run in runs)
        text = raw_native_text
        content = anchor.get('body_chars', source)
        marker = next((c['x0'] for c in content if c['resolved_text'] == '▷'), None)
        math_chars = [c for c in content if marker is None or c['x0'] < marker]
        reason = _complex_reason(math_chars, anchor['baseline'], body_size) if anchor['role'] == 'code' else None
        body_html = _render_runs(_runs(content, anchor['baseline'], body_size))
        if reason:
            geometry = _proven_crop(math_chars, chars, page, body_size)
            if geometry is None:
                return None
            crop_id = 'algorithm-line-' + str(anchor['number']) + '-math'
            math_runs = _runs(math_chars, anchor['baseline'], body_size)
            raw_math_text = ''.join(run['text'] for run in math_runs)
            crops.append({'id': crop_id, **geometry,
                          'source_glyph_ids': [c['glyph_id'] for c in math_chars],
                          'selectable_text': None, 'source_text_status': 'unresolved',
                          'raw_native_text': raw_math_text, 'reason': reason})
            cropped_ids.update(c['glyph_id'] for c in math_chars)
            after = [c for c in content if c not in math_chars]
            body_html = '<span class="algorithm-local-math" data-algorithm-crop-id="' + crop_id + '" role="img" aria-label="公式原图，原生文字结构待核"></span>'
            runs = _runs(anchor.get('label_chars', []), anchor['baseline'], body_size)
            text = ''.join(run['text'] for run in runs) + ' [公式原图]'
            if after:
                after_runs = _runs(after, anchor['baseline'], body_size)
                runs.extend(after_runs)
                text += ' ' + ''.join(run['text'] for run in after_runs)
                body_html += ' ' + _render_runs(after_runs)
        indent = max(0, (min(c['x0'] for c in content) - origin) / body_size) if anchor['role'] == 'code' else 0
        if anchor['role'] == 'code':
            line_html = '<div class="algorithm-line" data-line-number="' + str(anchor['number']) + '"><span class="algorithm-line-number" style="display:inline-block;width:2em;text-align:right;padding-right:.6em">' + str(anchor['number']) + ':</span><span class="algorithm-line-body" style="padding-left:' + format(indent, '.4f') + 'em">' + body_html + '</span></div>'
        else:
            line_html = '<div class="algorithm-' + anchor['role'] + '">' + body_html + '</div>'
        lines.append({'role': anchor['role'], 'number': anchor['number'], 'baseline': anchor['baseline'],
                      'indent_em': round(indent, 4), 'source_glyph_ids': [c['glyph_id'] for c in source],
                      'text': text, 'raw_native_text': raw_native_text, 'runs': runs, 'html': line_html})
    return {'version': 'algorithm-native-v1', 'algorithm_number': anchors[0]['algorithm_number'],
            'body_font_size_points': body_size,
            'html': '<div class="pdf-algorithm-native">\n' + '\n'.join(line['html'] for line in lines) + '\n</div>',
            'text': '\n'.join(line['text'] for line in lines), 'lines': lines, 'local_crops': crops,
            'evidence': {'status': 'confirmed', 'source_bbox_normalized': list(bbox), 'source_glyph_ids': covered,
                         'source_glyph_count': len(chars), 'covered_glyph_count': len(covered),
                         'glyph_coverage': 1.0, 'text_glyph_coverage': (len(covered) - len(cropped_ids)) / len(covered),
                         'local_visual_glyph_count': len(cropped_ids), 'unknown_glyphs': 0, 'rotated_glyphs': 0,
                         'line_numbers': numbers, 'require_count': roles.count('require'), 'ensure_count': roles.count('ensure')}}
