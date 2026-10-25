"""PDF glyph and vector evidence shared by fusion rules (CPU only)."""
import collections
from contextlib import closing
import io
import re
import statistics
import unicodedata
from difflib import SequenceMatcher

import pdfplumber
from pypdf import PdfReader


VERSION = 'native-pdf-v3'


def glyph_unicode(name):
    from fontTools.agl import toUnicode
    name = name.split('.')[0]
    value = toUnicode(name)
    if not value:
        value = toUnicode(re.sub(r'(?:bigg?|Bigg?|text|display)$', '', name))
    return value


def canonical(value):
    value = unicodedata.normalize('NFKC', value).replace('\u00ad', '')
    return ''.join(c for c in value if not c.isspace() and c not in '\u00ad').replace('’', "'").replace('−', '-').replace('–', '-').replace('—', '-')


def unicode_script(value):
    names = [unicodedata.name(c, '') for c in value]
    if names and all('SUPERSCRIPT' in name for name in names):
        return 'sup'
    if names and all('SUBSCRIPT' in name for name in names):
        return 'sub'
    return None


def resource_fonts(resources, resolve):
    seen = set()

    def visit(reference):
        resource = resolve(reference)
        identity = id(resource)
        if identity in seen:
            return
        seen.add(identity)
        fonts = resolve(resource.get('/Font', resource.get('Font', {})))
        yield from fonts.items()
        objects = resolve(resource.get('/XObject', resource.get('XObject', {})))
        for obj in objects.values():
            obj = resolve(obj)
            child = obj.get('/Resources', obj.get('Resources'))
            if child is not None:
                yield from visit(child)

    yield from visit(resources)


def font_metadata(font):
    font = font.get_object() if hasattr(font, 'get_object') else font
    child = font.get('/DescendantFonts')
    descriptor = (child[0].get_object() if child else font).get('/FontDescriptor', {})
    descriptor = descriptor.get_object() if hasattr(descriptor, 'get_object') else descriptor
    name = str(font.get('/BaseFont', descriptor.get('/FontName', ''))).lstrip('/')
    weight = descriptor.get('/FontWeight')
    italic_angle = float(descriptor.get('/ItalicAngle', 0))
    origin = 'font_descriptor'
    encoding = {}
    if descriptor.get('/FontFile'):
        header = descriptor['/FontFile'].get_data()[:32768].decode('latin1')
        header = header.split('currentfile eexec')[0]
        encoding = {int(code): {'glyph_name': glyph, 'unicode': glyph_unicode(glyph)} for code, glyph in re.findall(r'dup\s+(\d+)\s+/([^\s]+)\s+put', header)}
        match = re.search(r'/Weight\s*\(([^)]*)\)', header)
        if match:
            weight = match[1]
            origin = 'embedded_type1_weight'
        angle = re.search(r'/ItalicAngle\s+(-?[\d.]+)', header)
        if angle:
            italic_angle = float(angle[1])
    elif descriptor.get('/FontFile2'):
        try:
            from fontTools.ttLib import TTFont
        except ImportError:
            TTFont = None
        if TTFont:
            with TTFont(io.BytesIO(descriptor['/FontFile2'].get_data()), lazy=True) as embedded:
                if 'OS/2' in embedded:
                    weight = embedded['OS/2'].usWeightClass
                    origin = 'embedded_opentype_weight'
                if 'post' in embedded:
                    italic_angle = embedded['post'].italicAngle
    explicit = font.get('/Encoding')
    explicit = explicit.get_object() if hasattr(explicit, 'get_object') else explicit
    if isinstance(explicit, dict):
        code = None
        for value in explicit.get('/Differences', []):
            if isinstance(value, int):
                code = value
            elif code is not None:
                glyph = str(value).lstrip('/')
                encoding[code] = {'glyph_name': glyph, 'unicode': glyph_unicode(glyph), 'source': 'pdf_encoding_differences'}
                code += 1
    if isinstance(weight, (int, float)):
        bold = weight >= 600
    elif weight is not None:
        bold = bool(re.search(r'bold|black|demi|heavy', str(weight), re.I))
    else:
        bold = bool(re.search(r'bold|black|semibold|demi|heavy|cmbx|cmbsy|lmbx|[-+]SFBX', name, re.I))
        origin = 'font_name'
    italic = bool(italic_angle or re.search(r'italic|oblique|cmbxti|cmti|cmsl|lmri|lmro', name, re.I))
    return {'font': name, 'bold': bold, 'italic': italic, 'weight': weight, 'italic_angle': italic_angle, 'classification_source': origin, 'encoding': encoding}


def math_style(text, font):
    names = [unicodedata.name(c, '') for c in text if c != 'ℓ']
    if any('SCRIPT' in n and ('MATHEMATICAL' in n or 'CAPITAL' in n or 'SMALL' in n) for n in names):
        return 'mathcal', 'unicode_math_alphabet'
    if any('DOUBLE-STRUCK' in n for n in names):
        return 'mathbb', 'unicode_math_alphabet'
    # These standard TeX symbol encodings put calligraphic capitals in A-Z slots.
    # Their ToUnicode CMaps commonly erase that distinction by mapping to ASCII.
    base = re.sub(r'^[A-Z]{6}\+', '', font).lower()
    if text.isascii() and text.isupper() and re.match(r'(?:cm(?:b)?sy|txsys|pxsy|lmsy|ntxsy)', base):
        return 'mathcal', 'standard_tex_symbol_encoding'
    if text.isascii() and text.isupper() and re.match(r'msbm', base):
        return 'mathbb', 'standard_tex_symbol_encoding'
    return None, None


class NativePDF:
    def __init__(self, path):
        self.pdf = pdfplumber.open(path)
        reader = PdfReader(path)
        self.fonts = {}
        self.fonts_by_id = {}
        seen_fonts = set()
        for page in reader.pages:
            for _, font in resource_fonts(page.get('/Resources', {}), lambda value: value.get_object() if hasattr(value, 'get_object') else value):
                key = (font.idnum, font.generation) if hasattr(font, 'idnum') else id(font)
                if key in seen_fonts:
                    continue
                seen_fonts.add(key)
                info = font_metadata(font)
                self.fonts[info['font']] = info
                if hasattr(font, 'idnum'):
                    self.fonts_by_id[font.idnum] = info

    def page(self, index):
        return NativePage(self.pdf.pages[index], self.fonts, self.fonts_by_id)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.pdf.close()


class NativePage:
    def __init__(self, page, fonts=None, fonts_by_id=None):
        self.page = page
        self.width, self.height = page.width, page.height
        self.fonts = fonts or {}
        self.fonts_by_id = fonts_by_id or {}
        self.chars = []
        decoded = self._decoded_glyphs()
        for i, original in enumerate(page.chars):
            char = dict(original)
            char['glyph_id'] = i
            decoding = decoded.get((tuple(round(v, 6) for v in char.get('matrix', ())), char['text']), {})
            char['font_evidence'] = decoding.get('font_evidence', self.fonts.get(char.get('fontname'), {}) if fonts_by_id is None else {})
            cid = re.fullmatch(r'\(cid:(\d+)\)', char['text'])
            encoded = char['font_evidence'].get('encoding', {}).get(int(cid[1]), {}) if cid else {}
            char['resolved_text'] = encoded.get('unicode', '') if cid else char['text']
            char['unicode_source'] = 'embedded_glyph_name' if cid and encoded.get('unicode') else 'to_unicode'
            correction = {k: v for k, v in decoding.items() if k != 'font_evidence'}
            if correction.get('unicode'):
                char['resolved_text'] = correction['unicode']
                char['unicode_source'] = correction.get('source', 'embedded_glyph_name')
                char['glyph_decoding'] = correction
            char['canonical'] = '' if '\ufffd' in char['text'] else canonical(char['resolved_text'])
            unicode_names = [unicodedata.name(c, '') for c in char['resolved_text']]
            char['unicode_bold'] = any('MATHEMATICAL' in name and 'BOLD' in name for name in unicode_names)
            char['unicode_italic'] = any('MATHEMATICAL' in name and 'ITALIC' in name for name in unicode_names)
            char['unicode_script'] = unicode_script(char['resolved_text'])
            char['baseline'] = self.height - char['matrix'][5] if char.get('matrix') else char['bottom']
            matrix = char.get('matrix', [1, 0, 0, 1, 0, 0])
            char['rotated'] = abs(matrix[1]) > .001 or abs(matrix[2]) > .001 or not char.get('upright', True)
            char['math_style'], char['math_style_source'] = math_style(char['resolved_text'], char.get('fontname', ''))
            self.chars.append(char)
        self._compose_overprints()
        self.underlines = self._underlines()

    def _compose_overprints(self):
        for ring, base in zip(self.chars, self.chars[1:]):
            size = base.get('size', 10)
            if ring['resolved_text'] not in {'˚', '\u030a'} or base['resolved_text'] != 'A' or ring['rotated'] or base['rotated']:
                continue
            if ring.get('fontname') != base.get('fontname') or abs(ring.get('size', 10) - size) > size * .02 or max(abs(ring['x0'] - base['x0']), abs(ring['x1'] - base['x1'])) > size * .05 or not size * .05 < base['baseline'] - ring['baseline'] < size * .35:
                continue
            box = [min(ring['x0'], base['x0']), min(ring['top'], base['top']), max(ring['x1'], base['x1']), max(ring['bottom'], base['bottom'])]
            base.update(resolved_text='Å', canonical=canonical('Å'), unicode_source='native_overprint_composition', glyph_composition={'kind': 'ring-over-capital-A', 'source_glyph_ids': [ring['glyph_id'], base['glyph_id']], 'source_text': [ring['resolved_text'], 'A'], 'source_bbox': box})
            base.update(zip(['x0', 'top', 'x1', 'bottom'], box))
            ring.update(resolved_text='', canonical='', composition_target_glyph_id=base['glyph_id'])

    def _decoded_glyphs(self):
        if not self.fonts_by_id or not hasattr(self.page, 'pdf'):
            return {}
        from pdfminer.pdfdevice import PDFTextDevice
        from pdfminer.pdffont import PDFUnicodeNotDefined
        from pdfminer.pdfinterp import PDFPageInterpreter
        from pdfminer.pdftypes import resolve1

        manager = self.page.pdf.rsrcmgr
        resources = resolve1(self.page.page_obj.resources)
        font_infos = {}
        for _, reference in resource_fonts(resources, resolve1):
            spec = resolve1(reference)
            if hasattr(reference, 'objid') and reference.objid in self.fonts_by_id:
                font_infos[manager.get_font(reference.objid, spec)] = self.fonts_by_id[reference.objid]
        captured = collections.defaultdict(list)
        class DecodeDevice(PDFTextDevice):
            def render_char(device, matrix, font, fontsize, scaling, rise, cid, ncs, graphicstate):
                try:
                    text = font.to_unichr(cid)
                except PDFUnicodeNotDefined:
                    text = '(cid:' + str(cid) + ')'
                info = font_infos.get(font)
                evidence = {'font_evidence': info, **info.get('encoding', {}).get(cid, {})} if info else None
                captured[(tuple(round(v, 6) for v in matrix), text)].append(evidence)
                return fontsize * scaling * font.char_width(cid)
        PDFPageInterpreter(manager, DecodeDevice(manager)).process_page(self.page.page_obj)
        return {key: values[0] for key, values in captured.items() if len(values) == 1 and values[0]}

    def region(self, region, margin=.003):
        x0, y0, x1, y1 = region
        return [c for c in self.chars if x0 - margin <= (c['x0'] + c['x1']) / 2 / self.width <= x1 + margin and y0 - margin <= (c['top'] + c['bottom']) / 2 / self.height <= y1 + margin]

    def _underlines(self):
        underlines = {}
        for line_id, line in enumerate(list(getattr(self.page, 'lines', [])) + list(getattr(self.page, 'rects', []))):
            height, width = line['bottom'] - line['top'], line['x1'] - line['x0']
            if height > 1 or width <= 0 or (height and width < height * 4) or line.get('linewidth', 0) > 1.5:
                continue
            candidates = [c for c in self.chars if not c['rotated'] and c['canonical'] and c['x0'] >= line['x0'] - 1 and c['x1'] <= line['x1'] + 1 and .01 * c.get('size', 10) <= line['top'] - c['baseline'] <= .3 * c.get('size', 10)]
            if not candidates:
                continue
            size = max(c.get('size', 10) for c in candidates)
            width = max(c['x1'] for c in candidates) - min(c['x0'] for c in candidates)
            if line.get('linewidth', 0) > max(1, .12 * size) or not .8 * width <= line['x1'] - line['x0'] <= width + .3 * size:
                continue
            # A fraction rule has a denominator immediately beneath the same x span.
            candidate_ids = {c['glyph_id'] for c in candidates}
            below = any(c['canonical'] and c['glyph_id'] not in candidate_ids and c['x1'] > line['x0'] and c['x0'] < line['x1'] and .05 * size < c['baseline'] - line['top'] < .8 * size for c in self.chars)
            if below:
                continue
            for char in candidates:
                underlines[char['glyph_id']] = {'line_id': line_id, 'bbox': [line['x0'] / self.width, line['top'] / self.height, line['x1'] / self.width, line['bottom'] / self.height], 'linewidth': line.get('linewidth', 0)}
        return underlines

    def evidence(self, chars):
        valid = [c for c in chars if c['canonical'] and not c['rotated']]
        return {'glyphs': len(chars), 'usable_glyphs': len(valid), 'unknown_glyphs': sum(not c['canonical'] and bool(c['text'].strip()) and 'composition_target_glyph_id' not in c for c in chars), 'rotated_glyphs': sum(c['rotated'] for c in chars), 'native_available': bool(valid)}

    def tight_glyph_boxes(self):
        if hasattr(self, '_tight_boxes'):
            return self._tight_boxes
        self._tight_boxes = {}
        if not hasattr(self.page, 'pdf') or self.page.rotation:
            return self._tight_boxes
        source = getattr(self.page.pdf.stream, 'name', None)
        if not isinstance(source, str):
            return self._tight_boxes
        import pypdfium2 as pdfium

        with pdfium.PdfDocument(source) as document:
            with closing(document[self.page.page_number - 1]) as page:
                if abs(page.get_width() - self.width) > .1 or abs(page.get_height() - self.height) > .1:
                    return self._tight_boxes
                with closing(page.get_textpage()) as textpage:
                    values, indices = [], []
                    for index in range(textpage.count_chars()):
                        for value in canonical(textpage.get_text_range(index, 1)):
                            values.append(value)
                            indices.append(index)
                    native, glyphs = [], []
                    for char in self.chars:
                        for value in canonical(char['text']):
                            native.append(value)
                            glyphs.append(char['glyph_id'])
                    mapped = collections.defaultdict(list)
                    for match in SequenceMatcher(None, ''.join(native), ''.join(values), autojunk=False).get_matching_blocks():
                        for offset in range(match.size):
                            mapped[glyphs[match.a + offset]].append(indices[match.b + offset])
                    for char in self.chars:
                        matched = mapped.get(char['glyph_id'], [])
                        if not matched or len(matched) != len(canonical(char['text'])):
                            continue
                        boxes = []
                        for index in set(matched):
                            left, bottom, right, top = textpage.get_charbox(index, loose=False)
                            boxes.append([left, self.height - top, right, self.height - bottom])
                        box = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
                        size = char.get('size', 10)
                        if box[0] >= char['x0'] - size * .25 and box[2] <= char['x1'] + size * .25 and box[1] >= char['top'] - size * .5 and box[3] <= char['bottom'] + size * .5:
                            self._tight_boxes[char['glyph_id']] = box
                    for char in self.chars:
                        parts = (char.get('glyph_composition') or {}).get('source_glyph_ids', [])
                        if parts and all(i in self._tight_boxes for i in parts):
                            boxes = [self._tight_boxes[i] for i in parts]
                            self._tight_boxes[char['glyph_id']] = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
        return self._tight_boxes

    def encoded_script_glyphs(self):
        if hasattr(self, '_encoded_scripts'):
            return self._encoded_scripts
        from pdfminer.pdfdevice import PDFTextDevice
        from pdfminer.pdffont import PDFUnicodeNotDefined
        from pdfminer.pdfinterp import PDFPageInterpreter
        from pdfminer.pdftypes import resolve1
        from pdfminer.psparser import literal_name

        manager = self.page.pdf.rsrcmgr
        fonts = {}
        resources = resolve1(self.page.page_obj.resources)
        for resource, reference in resource_fonts(resources, resolve1):
            spec = resolve1(reference)
            if not hasattr(reference, 'objid') or literal_name(spec.get('Subtype')) not in {'Type1', 'TrueType'}:
                continue
            encoding = resolve1(spec.get('Encoding', {}))
            if not isinstance(encoding, dict):
                continue
            code, scripts = None, {}
            for value in resolve1(encoding.get('Differences', [])):
                if isinstance(value, int):
                    code = value
                    continue
                name = literal_name(value)
                kind = 'sup' if re.fullmatch(r'[A-Za-z]+\.?superior', name) else 'sub' if re.fullmatch(r'[A-Za-z]+\.?inferior', name) else None
                if kind and code is not None:
                    scripts[code] = {'font_resource': resource, 'font_object_id': reference.objid, 'charcode': code, 'glyph_name': name, 'script_kind': kind, 'base_text': canonical(glyph_unicode(name)), 'source': 'pdf-encoding-differences'}
                if code is not None:
                    code += 1
            if scripts:
                fonts[manager.get_font(reference.objid, spec)] = scripts

        def key(matrix, text):
            return tuple(round(value, 6) for value in matrix), text
        captured = collections.defaultdict(list)
        class ScriptDevice(PDFTextDevice):
            def render_char(device, matrix, font, fontsize, scaling, rise, cid, ncs, graphicstate):
                try:
                    text = font.to_unichr(cid)
                except PDFUnicodeNotDefined:
                    text = ''
                evidence = fonts.get(font, {}).get(cid)
                if evidence and (not evidence['base_text'] or evidence['base_text'] != canonical(text) or rise):
                    evidence = None
                captured[key(matrix, text)].append(evidence)
                return fontsize * scaling * font.char_width(cid)
        if fonts:
            PDFPageInterpreter(manager, ScriptDevice(manager)).process_page(self.page.page_obj)
        counts = collections.Counter(key(char['matrix'], char['text']) for char in self.chars)
        result = {}
        for char in self.chars:
            explicit_script = char.get('unicode_script') or unicode_script(char['resolved_text'])
            if explicit_script and char['canonical'] and not char['rotated']:
                result[char['glyph_id']] = {'script_kind': explicit_script, 'base_text': char['canonical'], 'unicode': char['resolved_text'], 'source': 'unicode-script'}
                continue
            identity = key(char['matrix'], char['text'])
            matches = captured.get(identity, [])
            if not char['rotated'] and counts[identity] == 1 and len(matches) == 1 and matches[0]:
                result[char['glyph_id']] = dict(matches[0])
        self._encoded_scripts = result
        return result

    def inline_geometry(self, glyph_ids, region):
        ids = set(glyph_ids)
        selected = [c for c in self.chars if c['glyph_id'] in ids]
        context = [c for c in self.region(region) if c['canonical'] and not c['rotated']]
        if not selected or any(c['rotated'] for c in selected) or not context:
            return {'status': 'unresolved', 'reason': 'inline_geometry_unavailable'}
        x0, top = min(c['x0'] for c in selected), min(c['top'] for c in selected)
        x1, bottom = max(c['x1'] for c in selected), max(c['bottom'] for c in selected)
        size = statistics.median(c.get('size', 10) for c in context)
        selected_size = max(c.get('size', 10) for c in selected)
        if size < selected_size <= size * 1.35:
            size = selected_size
        nearby = [c for c in context if c['glyph_id'] not in ids and .85 * size <= c.get('size', 10) <= 1.2 * size and x0 - size * 6 <= c['x1'] and c['x0'] <= x1 + size * 6 and top - size <= c['baseline'] <= bottom + size]
        if not nearby:
            return {'status': 'unresolved', 'reason': 'inline_body_baseline_unavailable'}
        target = statistics.median(c['baseline'] for c in selected)
        nearest = min(nearby, key=lambda c: abs(c['baseline'] - target) + .15 * max(0, x0 - c['x1'], c['x0'] - x1))
        body = [c for c in nearby if abs(c['baseline'] - nearest['baseline']) <= size * .15]
        baseline = statistics.median(c['baseline'] for c in body)
        size = statistics.median(c.get('size', 10) for c in body)
        isolated_base = [c for c in selected if c.get('size', 10) >= size * .85 and re.fullmatch(r'[A-Za-z()[\]]', c['canonical'])]
        own_baseline = statistics.median(c['baseline'] for c in isolated_base) if isolated_base else baseline
        isolated = len(isolated_base) >= 2 and any(c['canonical'].isalpha() for c in isolated_base) and max(c['baseline'] for c in isolated_base) - min(c['baseline'] for c in isolated_base) <= size * .1 and not any(abs(c['baseline'] - own_baseline) <= size * .15 for c in nearby) and abs(own_baseline - baseline) > size * .6
        if isolated:
            baseline = own_baseline
            body = []
        primary = [c for c in selected if c.get('size', 10) >= size * .85]
        multiple_lines = bool(primary) and max(c['baseline'] for c in primary) - min(c['baseline'] for c in primary) > size * .6
        foreign = []
        for char in self.chars:
            if char['glyph_id'] in ids or char.get('composition_target_glyph_id') in ids or not char['text'].strip():
                continue
            width = max(0, min(x1, char['x1']) - max(x0, char['x0']))
            height = max(0, min(bottom, char['bottom']) - max(top, char['top']))
            if width > size * .08 and height > size * .08 and width * height > .04 * max(1, (char['x1'] - char['x0']) * (char['bottom'] - char['top'])):
                foreign.append(char['glyph_id'])
        font_box_foreign = list(foreign)
        crop_foreign = []
        if foreign:
            tight = self.tight_glyph_boxes()
            if all(glyph_id in tight for glyph_id in ids | set(foreign)):
                x0 = min(tight[i][0] for i in ids)
                top = min(tight[i][1] for i in ids)
                x1 = max(tight[i][2] for i in ids)
                bottom = max(tight[i][3] for i in ids)
                crop_foreign = [i for i in foreign if min(x1, tight[i][2]) - max(x0, tight[i][0]) > size * .08 and min(bottom, tight[i][3]) - max(top, tight[i][1]) > size * .08]
                foreign = [i for i in crop_foreign if any(min(tight[j][2], tight[i][2]) - max(tight[j][0], tight[i][0]) > size * .08 and min(tight[j][3], tight[i][3]) - max(tight[j][1], tight[i][1]) > size * .08 for j in ids)]
        ink_width = sum(c['x1'] - c['x0'] for c in selected)
        reliable = not multiple_lines and not foreign and x1 - x0 <= max(ink_width * 3, size * 3) and bottom - top <= size * 2.5
        script = None
        if all(c.get('size', 10) < size * .9 and c['baseline'] < baseline - size * .1 for c in selected):
            script = 'sup'
        elif all(c.get('size', 10) < size * .9 and c['baseline'] > baseline + size * .05 for c in selected):
            script = 'sub'
        if script is None:
            preceding = [c for c in nearby if c['x1'] <= x0 + size * .1]
            base = max(preceding, key=lambda c: c['x1'], default=None)
            relation = self.script_relation(base, selected) if base else None
            if relation:
                script = relation['script_kind']
        return {'status': 'confirmed' if reliable else 'unresolved', 'reason': None if reliable else 'inline_multiline_geometry' if multiple_lines else 'inline_foreign_glyph_overlap' if foreign else 'inline_native_geometry_ambiguous', 'source_bbox_normalized': [x0 / self.width, top / self.height, x1 / self.width, bottom / self.height], 'source_glyph_ids': sorted(ids), 'body_baseline_normalized': baseline / self.height, 'body_font_size_points': size, 'height_em': (bottom - top) / size, 'baseline_offset_em': (bottom - baseline) / size, 'script_kind': script, 'foreign_glyph_ids': foreign, 'body_neighbor_glyph_ids': [c['glyph_id'] for c in body], **({'baseline_source': 'selected-base-glyphs-on-isolated-line'} if isolated else {}), **({'ink_geometry_source': 'pdfium-tight-glyph-boxes', 'font_box_foreign_glyph_ids': font_box_foreign, 'crop_foreign_glyph_ids': crop_foreign} if font_box_foreign and font_box_foreign != foreign else {})}

    def script_relation(self, base, selected):
        if not base or not selected or base['rotated'] or any(c['rotated'] for c in selected):
            return None
        size = base.get('size', 10)
        if not base['canonical'].isalnum() or not all(.5 * size <= c.get('size', 10) <= .85 * size and re.fullmatch(r'[A-Za-z0-9]+', c['canonical']) for c in selected):
            return None
        ordered = sorted(selected, key=lambda c: c['x0'])
        if not -.1 * size <= ordered[0]['x0'] - base['x1'] <= .3 * size or any(right['x0'] - left['x1'] > size * .25 for left, right in zip(ordered, ordered[1:])):
            return None
        # Some PDFs encode text rise in the font box while keeping the matrix baseline unchanged.
        sub = all(c['bottom'] > base['bottom'] + size * .1 and c['top'] > base['top'] + size * .25 and c['top'] < base['bottom'] for c in ordered)
        sup = all(c['top'] < base['top'] - size * .1 and c['bottom'] < base['bottom'] - size * .25 and c['bottom'] > base['top'] for c in ordered)
        if not sub and not sup:
            return None
        return {'script_kind': 'sub' if sub else 'sup', 'source': 'native_font_bbox_and_size', 'base_glyph_id': base['glyph_id'], 'source_glyph_ids': [c['glyph_id'] for c in ordered]}

    def align(self, text, region, math_aliases=False):
        def normalized(value):
            value = unicodedata.normalize('NFD', canonical(value))
            return value.translate(str.maketrans({'*': '∗', '·': '⋅', '°': '∘', '◦': '∘'})) if math_aliases else value
        target, target_map = [], []
        for i, char in enumerate(text):
            for value in normalized(char):
                target.append(value)
                target_map.append(i)
        chars = self.region(region)
        native, native_map = [], []
        for char in chars:
            if char['rotated']:
                continue
            for value in normalized(char['resolved_text']):
                native.append(value)
                native_map.append(char)
        matcher = SequenceMatcher(None, ''.join(target), ''.join(native), autojunk=False)
        matches = matcher.get_matching_blocks()
        mapped = collections.defaultdict(list)
        for match in matches:
            for j in range(match.size):
                mapped[target_map[match.a + j]].append(native_map[match.b + j])
        covered = sum(match.size for match in matches)
        unmatched = [i for kind, _, _, b0, b1 in matcher.get_opcodes() if kind != 'equal' for i in range(b0, b1)]
        availability = self.evidence(chars)
        complete = bool(native) and not unmatched and not availability['unknown_glyphs'] and not availability['rotated_glyphs']
        return dict(mapped), {**availability, 'alignment_coverage': covered / max(1, len(target)), 'source_coverage': covered / max(1, len(native)), 'source_characters': len(native), 'unmatched_source_text': ''.join(native[i] for i in unmatched), 'unmatched_source_glyph_ids': sorted({native_map[i]['glyph_id'] for i in unmatched}), 'source_content_complete': complete, 'matched_characters': covered, 'target_characters': len(target)}

    def styles(self, char):
        styles = set()
        for style in ['bold', 'italic']:
            if char['font_evidence'].get(style) or char.get('unicode_' + style):
                styles.add(style)
        if char['glyph_id'] in self.underlines:
            styles.add('underline')
        return styles

    def style_spans(self, text, region, excluded=()):
        mapped, evidence = self.align(text, region)
        evidence['status'] = 'confirmed' if evidence['alignment_coverage'] >= .75 and evidence['source_content_complete'] else 'unresolved' if evidence['native_available'] else 'unsupported'
        excluded = {i for start, end in excluded for i in range(start, end)}
        char_styles = {}
        if evidence['alignment_coverage'] >= .75:
            for i, chars in mapped.items():
                if i not in excluded and not text[i].isspace():
                    shared = set.intersection(*(self.styles(c) for c in chars))
                    if shared:
                        char_styles[i] = shared
        # Spaces inherit a style only when both adjacent visible characters agree.
        for i, char in enumerate(text):
            if char.isspace() and i not in excluded:
                before = next((char_styles.get(j, set()) for j in range(i - 1, -1, -1) if not text[j].isspace()), set())
                after = next((char_styles.get(j, set()) for j in range(i + 1, len(text)) if not text[j].isspace()), set())
                if before & after:
                    char_styles[i] = before & after
        spans, start = [], 0
        while start < len(text):
            styles = char_styles.get(start)
            if not styles:
                start += 1
                continue
            end = start + 1
            while end < len(text) and char_styles.get(end) == styles:
                end += 1
            glyphs = {c['glyph_id']: c for i in range(start, end) for c in mapped.get(i, [])}
            if any(c.isalnum() for c in text[start:end]) and glyphs:
                values = list(glyphs.values())
                spans.append({'start': start, 'end': end, 'text': text[start:end], 'styles': sorted(styles), 'status': 'confirmed', 'source': 'pdf_native', 'source_glyph_ids': sorted(glyphs), 'source_bbox': [min(c['x0'] for c in values) / self.width, min(c['top'] for c in values) / self.height, max(c['x1'] for c in values) / self.width, max(c['bottom'] for c in values) / self.height], 'fonts': sorted({c.get('fontname', '') for c in values}), 'underline_evidence': [self.underlines[i] for i in glyphs if i in self.underlines]})
            start = end
        return spans, evidence
