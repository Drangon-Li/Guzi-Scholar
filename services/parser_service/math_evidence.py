"""Conservative TeX atom alignment against native PDF glyphs."""
import collections
from difflib import SequenceMatcher
import re

from .native_pdf import canonical, unicode_script


VERSION = 'math-evidence-v3'
SYMBOLS = dict(alpha='α', beta='β', gamma='γ', delta='δ', epsilon='ε', varepsilon='ϵ', zeta='ζ', eta='η', theta='θ', vartheta='ϑ', iota='ι', kappa='κ', lambda_='λ', mu='μ', nu='ν', xi='ξ', pi='π', rho='ρ', sigma='σ', tau='τ', phi='ϕ', varphi='φ', chi='χ', psi='ψ', omega='ω', Gamma='Γ', Delta='Δ', Theta='Θ', Lambda='Λ', Xi='Ξ', Pi='Π', Sigma='Σ', Phi='Φ', Psi='Ψ', Omega='Ω', in_='∈', notin='∉', sum='∑', prod='∏', times='×', cdot='⋅', leq='≤', le='≤', geq='≥', ge='≥', neq='≠', ne='≠', approx='≈', sim='∼', to='→', rightarrow='→', leftarrow='←', cup='∪', cap='∩', emptyset='∅', partial='∂', nabla='∇', infty='∞', pm='±', mp='∓', circ='∘', ast='∗', star='⋆', ell='ℓ', ldots='…', cdots='⋯', forall='∀', exists='∃', neg='¬', land='∧', lor='∨', subset='⊂', subseteq='⊆', supset='⊃', supseteq='⊇', lbrace='{', rbrace='}', lvert='|', rvert='|', vert='|', lVert='‖', rVert='‖', langle='⟨', rangle='⟩')
SYMBOLS['lambda'] = SYMBOLS.pop('lambda_')
SYMBOLS['in'] = SYMBOLS.pop('in_')
SYMBOLS['bullet'] = '•'
SYMBOLS.update({'{': '{', '}': '}', '_': '_', '%': '%', '&': '&', '#': '#', '$': '$', 'checkmark': '✓', 'triangle': '△', 'dots': '…', 'mid': '|', 'lceil': '⌈', 'rceil': '⌉', 'dagger': '†', 'ddagger': '‡', 'int': '∫'})
FUNCTIONS = {'arg', 'argmax', 'argmin', 'sin', 'cos', 'tan', 'log', 'ln', 'exp', 'max', 'min', 'lim', 'sup', 'inf', 'det', 'Pr', 'gcd'}
STYLES = {'mathcal', 'mathscr', 'mathbb', 'mathbf', 'boldsymbol', 'mathit', 'mathrm', 'operatorname', 'text', 'textrm', 'textnormal', 'textbf', 'textit', 'bm'}
LAYOUT = {'left', 'right', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr', 'limits', 'nolimits', 'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle', 'quad', 'qquad', 'enspace', 'thinspace', '!', ',', ';', ':', ' ', '\\'}
MATH_SPAN = re.compile(r'(?<!\\)\$\$(.+?)(?<!\\)\$\$|(?<!\\)\$(?!\$)([^\n]+?)(?<!\\)\$(?!\$)', re.S)


def math_canonical(value):
    return canonical(value).replace('*', '∗').replace('·', '⋅')


def math_spans(text):
    return [(m.start(), m.end(), m.group(1) or m.group(2)) for m in MATH_SPAN.finditer(text)]


def math_candidates(text, recover=True):
    result = [(start, end, latex, 'delimited') for start, end, latex in math_spans(text)]
    if not recover:
        return result
    commands = set(SYMBOLS) | FUNCTIONS | STYLES | LAYOUT | {'frac', 'dfrac', 'tfrac', 'sqrt', 'hat', 'bar', 'tilde', 'vec', 'overline', 'underline', 'underset', 'overset', 'begin', 'end'}
    hint = re.compile(r'\\(?:' + '|'.join(re.escape(c) for c in sorted(commands, key=len, reverse=True) if c.isalpha()) + r')(?![A-Za-z])|[A-Za-z0-9]+[_^]\s*\{')
    def bare(start, end):
        while start < end:
            match = hint.search(text, start, end)
            if not match:
                return
            command = re.match(r'\\([A-Za-z]+)', match[0])
            simple = command and command[1] in SYMBOLS and (match.end() >= end or text[match.end()] not in '_^{')
            stop = match.end() if simple else end
            comment = text.find('▷', match.start(), stop)
            if comment >= 0:
                stop = comment
            while stop > match.start() and text[stop - 1].isspace():
                stop -= 1
            result.append((match.start(), stop, text[match.start():stop], 'bare-tex'))
            start = max(stop, match.end())
    for line in re.finditer(r'[^\n]+', text):
        cursor = line.start()
        ranges = [(a, b) for a, b, _, _ in result if a < line.end() and b > line.start()]
        for start, end in sorted(ranges) + [(line.end(), line.end())]:
            if cursor < start:
                fragment = text[cursor:start]
                dollar = re.search(r'(?<!\\)\$', fragment)
                if dollar:
                    opening = cursor + dollar.start()
                    bare(cursor, opening)
                    stop = start
                    while stop > opening and text[stop - 1].isspace():
                        stop -= 1
                    result.append((opening, stop, text[opening:stop].strip('$'), 'unbalanced-inline'))
                else:
                    bare(cursor, start)
            cursor = max(cursor, end)
    return sorted(result, key=lambda item: item[0])


def readable_candidate(text):
    leading = ' ' if text[:1].isspace() else ''
    trailing = ' ' if text[-1:].isspace() else ''
    value = text.strip().strip('$')
    preview_symbols = {**SYMBOLS, 'downarrow': '↓', 'uparrow': '↑', 'vee': '∨', 'wedge': '∧'}
    value = re.sub(r'\\([A-Za-z]+|.)', lambda m: preview_symbols[m[1]] if m[1] in preview_symbols else ' ' if m[1] in LAYOUT else m[0], value)
    scripts = [('_', str.maketrans('0123456789+-=()aehijklmnoprstuvx', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ')), ('^', str.maketrans('0123456789+-=()in', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁱⁿ'))]
    for _ in range(8):
        before = value
        value = re.sub(r'\\(?:' + '|'.join(STYLES) + r')\s*\{([^{}]*)\}', lambda m: m[1], value)
        for marker, alphabet in scripts:
            value = re.sub(re.escape(marker) + r'(?:\{([^{}]*)\}|([^\s{}()]))', lambda m: (m[1] or m[2]).translate(alphabet) if all(ord(c) in alphabet for c in (m[1] or m[2])) else marker + '(' + (m[1] or m[2]) + ')', value)
        value = re.sub(r'\\(?:dfrac|tfrac|frac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}', lambda m: '(' + m[1] + ')/(' + m[2] + ')', value)
        value = re.sub(r'\\sqrt\s*\{([^{}]*)\}', lambda m: '√(' + m[1] + ')', value)
        if before == value:
            break
    value = re.sub(r'\\([A-Za-z]+|.)', lambda m: SYMBOLS.get(m[1], m[1] if m[1] not in LAYOUT else ' '), value)
    return leading + value.strip() + trailing


def reconcile_equation_number(content, page, region):
    chars = [c for c in page.region(region) if c['canonical'] and not c['rotated']]
    text, mapping = [], []
    for char in chars:
        for value in char['canonical']:
            text.append(value)
            mapping.append(char)
    candidates = []
    for match in re.finditer(r'\((\d+[a-z]?)\)', ''.join(text)):
        glyphs = {c['glyph_id']: c for c in mapping[match.start():match.end()]}
        values = list(glyphs.values())
        size = max(c.get('size', 10) for c in values)
        baseline = sum(c['baseline'] for c in values) / len(values)
        if max(abs(c['baseline'] - baseline) for c in values) > size * .2:
            continue
        left = min(c['x0'] for c in values)
        right = max(c['x1'] for c in values)
        if any(c['glyph_id'] not in glyphs and c['x0'] >= right and abs(c['baseline'] - baseline) <= size * .25 for c in chars):
            continue
        preceding = [c for c in chars if c['glyph_id'] not in glyphs and c['x1'] <= left and abs(c['baseline'] - baseline) <= size * .25]
        gap = left - max((c['x1'] for c in preceding), default=left - size * 2)
        if gap < size * .4:
            continue
        candidates.append({'number': match[1], 'source_glyph_ids': sorted(glyphs), 'source_bbox': [left / page.width, min(c['top'] for c in values) / page.height, right / page.width, max(c['bottom'] for c in values) / page.height]})
    existing = re.findall(r'\\tag\s*\*?\s*\{\s*([^}]+)\s*\}', content)
    if len(candidates) != 1:
        return content, {'status': 'unresolved' if existing or candidates else 'absent', 'engine_numbers': existing, 'source_candidates': candidates}
    source = candidates[0]
    body = re.sub(r'\\tag\s*\*?\s*\{[^}]+\}', '', content).strip().removeprefix('$$').removesuffix('$$').strip()
    result = body + ' \\tag{' + source['number'] + '}'
    return result, {'status': 'confirmed', 'engine_numbers': existing, 'source_number': source['number'], 'changed': existing != [source['number']], **source}


class TexAtoms:
    def __init__(self, text):
        self.text, self.pos, self.unknown = text, 0, []
        self.atoms = self.read()

    def whitespace(self):
        while self.pos < len(self.text) and self.text[self.pos].isspace():
            self.pos += 1

    def argument(self, script=(), styles=(), role=None):
        self.whitespace()
        if self.pos < len(self.text) and self.text[self.pos] == '{':
            self.pos += 1
            return self.read(script, styles, role, group=True)
        return self.read(script, styles, role, single=True)

    def read(self, script=(), styles=(), role=None, group=False, single=False):
        result = []
        while self.pos < len(self.text):
            self.whitespace()
            if self.pos >= len(self.text):
                break
            start = self.pos
            char = self.text[self.pos]
            self.pos += 1
            if char == '}':
                break
            if char == '{':
                result.extend(self.read(script, styles, role, group=True))
            elif char in '_^':
                result.extend(self.argument(script + (('sub' if char == '_' else 'sup'),), styles, role))
            elif char == '\\':
                match = re.match(r'[A-Za-z]+|.', self.text[self.pos:])
                if not match:
                    break
                macro = match[0]
                self.pos += len(macro)
                end = self.pos
                if macro in SYMBOLS:
                    result.extend(self.atom(SYMBOLS[macro], start, end, script, styles, role))
                elif macro in FUNCTIONS:
                    result.extend(self.atom(macro, start, end, script, styles, 'operator'))
                elif macro in STYLES:
                    self.whitespace()
                    if self.pos < len(self.text) and self.text[self.pos] == '*':
                        self.pos += 1
                    style = {'mathscr': 'mathcal', 'boldsymbol': 'mathbf', 'bm': 'mathbf', 'textbf': 'mathbf', 'textit': 'mathit'}.get(macro, macro)
                    result.extend(self.argument(script, styles + (style,), 'operator' if macro in {'operatorname', 'mathrm', 'text', 'textrm'} else role))
                elif macro in {'frac', 'dfrac', 'tfrac'}:
                    result.extend(self.argument(script, styles, 'numerator'))
                    result.extend(self.argument(script, styles, 'denominator'))
                elif macro in {'underset', 'overset'}:
                    limit = self.argument(script + (('sub' if macro == 'underset' else 'sup'),), styles, role)
                    result.extend(self.argument(script, styles, role))
                    result.extend(limit)
                elif macro in {'tag', 'label', 'begin', 'end'}:
                    self.argument(script, styles, role)
                elif macro in LAYOUT:
                    pass
                elif macro in {'hat', 'bar', 'tilde', 'vec', 'overline', 'underline', 'sqrt'}:
                    self.unknown.append(macro)
                    result.extend(self.argument(script, styles, role))
                else:
                    self.unknown.append(macro)
            elif char not in '$&~':
                result.extend(self.atom(char, start, self.pos, script, styles, role))
            if single:
                break
        return result

    @staticmethod
    def atom(value, start, end, script, styles, role):
        intrinsic = unicode_script(value)
        return [{'text': c, 'start': start, 'end': end, 'script': list(script or ((intrinsic,) if intrinsic else ())), 'styles': list(styles), 'role': role} for c in math_canonical(value)]


def native_atoms(page, region, glyph_ids=None, context_region=None):
    region_chars = page.region(region) if glyph_ids is None else [c for c in page.chars if c['glyph_id'] in set(glyph_ids)]
    chars = [c for c in region_chars if c['canonical'] and not c['rotated']]
    # Equation numbers are spatially detached and are metadata, not formula atoms.
    if len(chars) > 3:
        ordered = sorted(chars, key=lambda c: c['x0'])
        for i in range(1, len(ordered)):
            tail = ''.join(c['canonical'] for c in ordered[i:])
            if ordered[i]['x0'] - max(c['x1'] for c in ordered[:i]) > 3 * ordered[i].get('size', 10) and re.fullmatch(r'\(\d+[a-z]?\)', tail):
                ids = {c['glyph_id'] for c in ordered[i:]}
                chars = [c for c in chars if c['glyph_id'] not in ids]
                break
    if not chars:
        return [], page.evidence(region_chars)
    main_size = max(c.get('size', 10) for c in chars)
    baselines = collections.Counter(round(c['baseline'], 1) for c in chars if c.get('size', 10) >= main_size * .85)
    baseline = baselines.most_common(1)[0][0] if baselines else chars[0]['baseline']
    line_baselines = []
    if context_region:
        nearby = [c for c in page.region(context_region) if c['canonical'] and not c['rotated'] and c.get('size', 10) > main_size * 1.15 and abs(c['baseline'] - baseline) < c.get('size', 10) * 1.5 and min(abs(c['x1'] - chars[0]['x0']), abs(c['x0'] - chars[-1]['x1'])) < main_size * 4]
        if nearby:
            baselines = collections.Counter(round(c['baseline'], 1) for c in nearby)
            baseline = min(baselines, key=lambda value: (abs(value - baseline), -baselines[value]))
            main_size = max(c.get('size', 10) for c in nearby if abs(c['baseline'] - baseline) < .2 * c.get('size', 10))
        geometry = page.inline_geometry([c['glyph_id'] for c in chars], context_region)
        if geometry.get('status') == 'confirmed':
            baseline = geometry['body_baseline_normalized'] * page.height
            main_size = geometry['body_font_size_points']
        else:
            ids = {c['glyph_id'] for c in chars}
            context = [c for c in page.region(context_region) if c['glyph_id'] not in ids and c['canonical'] and not c['rotated'] and main_size * .85 <= c.get('size', 10) <= main_size * 1.2]
            primary = [c for c in chars if c.get('size', 10) >= main_size * .85 and not c.get('unicode_script')]
            # Only nearby prose can establish another body row. Fraction rows and
            # operator limit baselines must not become new body baselines.
            for char in primary:
                neighbors = [c for c in context if abs(c['baseline'] - char['baseline']) <= main_size * .2 and min(abs(c['x1'] - char['x0']), abs(c['x0'] - char['x1'])) <= main_size * 6]
                if neighbors:
                    row = collections.Counter(round(c['baseline'], 1) for c in neighbors).most_common(1)[0][0]
                    if not any(abs(row - existing) <= main_size * .2 for existing in line_baselines):
                        line_baselines.append(row)
            if len(line_baselines) < 2:
                line_baselines = []
    result = []
    for char in chars:
        row_baseline = min(line_baselines, key=lambda row: abs(row - char['baseline'])) if line_baselines else baseline
        delta = char['baseline'] - row_baseline
        script = 'sub' if delta > .08 * main_size and char.get('size', 10) < .85 * main_size else 'sup' if delta < -.12 * main_size and char.get('size', 10) < .85 * main_size else None
        if char.get('unicode_script'):
            script = char['unicode_script']
        if char['resolved_text'] == '°':
            script = 'sup'
        if char['resolved_text'] == '✉' and delta < -.2 * main_size and char.get('size', 10) <= main_size * 1.05:
            script = 'sup'
        styles = [char['math_style']] if char['math_style'] else []
        if char['font_evidence'].get('bold') or char.get('unicode_bold'):
            styles.append('mathbf')
        for value in math_canonical(char['resolved_text']):
            if script == 'sup' and value in '°◦':
                value = '∘'
            result.append({'text': value, 'script': script, 'styles': styles, 'glyph_id': char['glyph_id'], 'char': char})
    for rule in list(getattr(page.page, 'lines', [])) + list(getattr(page.page, 'rects', [])):
        height, width = rule['bottom'] - rule['top'], rule['x1'] - rule['x0']
        if height > 1 or width <= 0 or (height and width < height * 4) or rule.get('linewidth', 0) > 1.5:
            continue
        aligned = [a for a in result if a['char']['x0'] >= rule['x0'] - 1 and a['char']['x1'] <= rule['x1'] + 1]
        above = [a for a in aligned if 0 < rule['top'] - a['char']['baseline'] < main_size]
        below = [a for a in aligned if .05 * main_size < a['char']['baseline'] - rule['top'] <= main_size * 1.2]
        if above and below:
            side_baselines = []
            for side, role in [(above, 'numerator'), (below, 'denominator')]:
                side_size = max(a['char'].get('size', 10) for a in side)
                side_baseline = collections.Counter(round(a['char']['baseline'], 1) for a in side if a['char'].get('size', 10) >= side_size * .85).most_common(1)[0][0]
                side_baselines.append(side_baseline)
                for a in side:
                    a['fraction_role'] = role
                    a['fraction_group'] = (rule['x0'], rule['top'], rule['x1'], rule['bottom'])
                    delta = a['char']['baseline'] - side_baseline
                    a['script'] = 'sub' if delta > .08 * side_size and a['char'].get('size', 10) < .85 * side_size else 'sup' if delta < -.12 * side_size and a['char'].get('size', 10) < .85 * side_size else None
            for a in above + below:
                a['fraction_row_baseline'] = sum(side_baselines) / 2
    chunks, seen = [], set()
    for atom in result:
        group = atom.get('fraction_group')
        if group is None:
            chunks.append([atom])
        elif group not in seen:
            seen.add(group)
            chunks.append(sorted((a for a in result if a.get('fraction_group') == group), key=lambda a: (a['fraction_role'] == 'denominator', a['char']['x0'])))
    availability = page.evidence(region_chars)
    if line_baselines:
        availability.update(per_line_baselines=True, line_baselines_normalized=sorted(row / page.height for row in line_baselines))
    if seen:
        rows = [chunk[0].get('fraction_row_baseline', chunk[0]['char']['baseline']) for chunk in chunks if chunk[0].get('fraction_group') or not chunk[0]['script']]
        if max(rows) - min(rows) > main_size * .75:
            availability['fraction_order_ambiguous'] = True
        else:
            chunks.sort(key=lambda chunk: min(a['char']['x0'] for a in chunk))
    return [a for chunk in chunks for a in chunk], availability


def ordered_atoms(atoms):
    result, i = [], 0
    while i < len(atoms):
        atom = atoms[i]
        if atom['script'] and result and (result[-1]['text'].isalnum() or result[-1]['text'] in '∑∏∫'):
            end = i + 1
            while end < len(atoms) and atoms[end]['script']:
                end += 1
            result.extend(sorted(atoms[i:end], key=lambda a: 0 if (a['script'][0] if isinstance(a['script'], list) else a['script']) == 'sub' else 1))
            i = end
        else:
            result.append(atom)
            i += 1
    return result


def candidate_score(parsed, native):
    candidate = ordered_atoms(parsed.atoms)
    native = ordered_atoms(native)
    target = ''.join(a['text'] for a in candidate)
    source = ''.join(a['text'] for a in native)
    matches = SequenceMatcher(None, target, source, autojunk=False).get_matching_blocks()
    mapping = {match.a + i: match.b + i for match in matches for i in range(match.size)}
    matched = len(mapping)
    lexical_errors = len(target) + len(source) - 2 * matched
    style_errors, script_errors, structure_errors = [], [], []
    for i, j in mapping.items():
        a, b = candidate[i], native[j]
        wanted = set(a['styles']) & {'mathcal', 'mathbb', 'mathbf'}
        actual = set(b['styles']) & {'mathcal', 'mathbb', 'mathbf'}
        if wanted != actual and a['text'].isalpha():
            style_errors.append({'atom': parsed.atoms.index(a), 'text': a['text'], 'candidate_styles': sorted(wanted), 'source_styles': sorted(actual), 'glyph_id': b['glyph_id']})
        script = a['script'][0] if a['script'] else None
        if script != b['script']:
            script_errors.append({'atom': i, 'text': a['text'], 'candidate_script': script, 'source_script': b['script'], 'glyph_id': b['glyph_id']})
        fraction_role = a['role'] if a['role'] in {'numerator', 'denominator'} else None
        if fraction_role != b.get('fraction_role'):
            structure_errors.append({'text': a['text'], 'candidate_fraction_role': fraction_role, 'source_fraction_role': b.get('fraction_role'), 'glyph_id': b['glyph_id']})
    score = lexical_errors * 3 + len(style_errors) * 2 + len(script_errors) * 2 + len(structure_errors) * 2
    matched_native = set(mapping.values())
    unmatched_native = ''.join(atom['text'] for j, atom in enumerate(native) if j not in matched_native)
    return {'score': score, 'lexical_errors': lexical_errors, 'style_errors': style_errors, 'script_errors': script_errors, 'structure_errors': structure_errors, 'alignment_coverage': matched / max(1, len(target)), 'native_coverage': matched / max(1, len(source)), 'unmatched_native_text': unmatched_native, 'unknown_macros': sorted(set(parsed.unknown)), 'mapping': mapping}


def selectable_script_segments(content, page, region, glyph_ids, context_region=None):
    parsed = TexAtoms(content)
    if parsed.unknown or not 1 <= len(parsed.atoms) <= 32 or not any(atom['script'] for atom in parsed.atoms):
        return None
    if any(len(atom['script']) > 1 or set(atom['styles']) - {'mathrm'} or atom['role'] not in {None, 'operator'} for atom in parsed.atoms):
        return None
    native, available = native_atoms(page, region, glyph_ids, context_region)
    if available['unknown_glyphs'] or available['rotated_glyphs'] or len(native) != len(parsed.atoms) or candidate_score(parsed, native)['score']:
        return None
    segments = []
    for atom, source in zip(parsed.atoms, native):
        script = atom['script'][0] if atom['script'] else None
        if atom['text'] != source['text'] or script != source['script']:
            return None
        if segments and segments[-1].get('script_kind') == script:
            segments[-1]['text'] += source['text']
            segments[-1]['source_glyph_ids'].append(source['glyph_id'])
        else:
            segments.append({'text': source['text'], **({'script_kind': script} if script else {}), 'source_glyph_ids': [source['glyph_id']]})
    return segments


def repair_candidate(content, page, region, glyph_ids=None, context_region=None):
    parsed = TexAtoms(content)
    native, availability = native_atoms(page, region, glyph_ids, context_region)
    evidence = candidate_score(parsed, native)
    substitutions = []
    # Repairs need surrounding matched atoms. A raw bag of matching letters is insufficient.
    mapping = evidence['mapping']
    t = ''.join(a['text'] for a in parsed.atoms)
    s = ''.join(a['text'] for a in native)
    for operation, a0, a1, b0, b1 in SequenceMatcher(None, t, s, autojunk=False).get_opcodes():
        if operation != 'replace' or a1 - a0 != 1 or b1 - b0 != 1 or len(t) < 2:
            continue
        if not (a0 == 0 or a0 - 1 in mapping) or not (a1 == len(t) or a1 in mapping):
            continue
        a, b = parsed.atoms[a0], native[b0]
        # The PDF's explicit Unicode scalar is stronger evidence than two OCR votes.
        letter_repair = a['text'].isalpha() and b['text'].isalpha() and a['text'] != b['text']
        marker_repair = a['text'] in {'×', '∗'} and b['text'] == '✉' and b['char']['resolved_text'] == '✉'
        if (letter_repair or marker_repair) and evidence['alignment_coverage'] >= .5:
            char = b['char']
            substitutions.append({'start': a['start'], 'end': a['end'], 'before': content[a['start']:a['end']], 'after': b['text'], 'glyph_id': b['glyph_id'], 'reason': 'explicit_native_unicode', 'source_unicode': char['text']})
    if evidence['alignment_coverage'] >= .8:
        for issue in evidence['style_errors']:
            atom = parsed.atoms[issue['atom']]
            styles = issue['source_styles']
            fragment = content[atom['start']:atom['end']]
            fragment_atoms = TexAtoms(fragment)
            if styles and not issue['candidate_styles'] and len(fragment_atoms.atoms) == 1 and not fragment_atoms.unknown:
                replacement = fragment
                for style in styles:
                    replacement = '\\' + style + '{' + replacement + '}'
                substitutions.append({'start': atom['start'], 'end': atom['end'], 'before': fragment, 'after': replacement, 'glyph_id': issue['glyph_id'], 'reason': 'native_math_alphabet'})
    exact = evidence['lexical_errors'] == 0 and not parsed.unknown and not availability['unknown_glyphs'] and not availability['rotated_glyphs'] and not availability.get('fraction_order_ambiguous') and not evidence['structure_errors']
    if exact and context_region and glyph_ids is not None:
        geometry = page.inline_geometry(glyph_ids, context_region)
        if geometry.get('status') == 'confirmed':
            ordered = ordered_atoms(parsed.atoms)
            ordered_native = ordered_atoms(native)
            # Missing markup can be restored without changing an explicit subscript
            # into a superscript (or the reverse).
            for atom, source in zip(ordered, ordered_native):
                if not atom['script'] and source['script'] and source['text'] == atom['text']:
                    fragment = content[atom['start']:atom['end']]
                    if len(TexAtoms(fragment).atoms) == 1:
                        marker = '^' if source['script'] == 'sup' else '_'
                        substitutions.append({'start': atom['start'], 'end': atom['end'], 'before': fragment, 'after': '{}' + marker + '{' + fragment + '}', 'glyph_id': source['glyph_id'], 'reason': 'native_script_position'})
            if re.fullmatch(r'[()]*[†‡][()]*', s) and all(a['script'] == ['sup'] for a in parsed.atoms) and all(a['script'] is None for a in native):
                fragments = [content[a['start']:a['end']] for a in parsed.atoms]
                substitutions = [{'start': 0, 'end': len(content), 'before': content, 'after': ''.join(fragments), 'glyph_ids': [a['glyph_id'] for a in native], 'reason': 'native_baseline_marker'}]
    result = content
    accepted, occupied = [], set()
    for change in sorted(substitutions, key=lambda c: c['start'], reverse=True):
        positions = set(range(change['start'], change['end']))
        if positions & occupied:
            continue
        occupied |= positions
        result = result[:change['start']] + change['after'] + result[change['end']:]
        accepted.append(change)
    return result, accepted, availability


def assess_formula(glm_content, mineru_content, page, region, glyph_ids=None, context_region=None):
    candidates = [('glm', glm_content)]
    if mineru_content:
        candidates.append(('mineru', mineru_content))
    repaired, changes, availability = repair_candidate(glm_content, page, region, glyph_ids, context_region)
    if changes:
        candidates.append(('pdf_native_repair', repaired))
    native, _ = native_atoms(page, region, glyph_ids, context_region)
    scored = []
    for engine, content in candidates:
        parsed = TexAtoms(content)
        score = candidate_score(parsed, native)
        scored.append((score['score'], engine, content, score))
    scored.sort(key=lambda item: item[0])
    best = scored[0]
    quality = best[3]
    confirmed = bool(native) and not availability['unknown_glyphs'] and not availability['rotated_glyphs'] and not availability.get('fraction_order_ambiguous') and quality['alignment_coverage'] >= .9 and quality['native_coverage'] >= .85 and quality['lexical_errors'] == 0 and not quality['style_errors'] and not quality['script_errors'] and not quality['structure_errors'] and not quality['unknown_macros']
    reason = None if confirmed else 'formula_native_evidence_incomplete' if not native or quality['alignment_coverage'] < .85 else 'formula_structure_or_glyphs_unresolved'
    # Unresolved differences never replace the base formula with an uncertain candidate.
    chosen = best if confirmed else next(c for c in scored if c[1] == 'glm')
    for _, _, _, evidence in scored:
        evidence.pop('mapping', None)
    audit = {'version': VERSION, 'status': 'confirmed' if confirmed else 'unsupported' if not native else 'unresolved', 'selected_engine': chosen[1], 'reason': reason, 'source_crop_required': not confirmed, 'fallback_bbox': list(region), 'candidate_content': chosen[2], 'native_evidence': availability, 'candidates': [{'engine': engine, 'content': content, **score} for _, engine, content, score in scored], 'changes': changes if chosen[1] == 'pdf_native_repair' else []}
    return chosen[2], audit
