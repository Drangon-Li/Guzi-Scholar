"""Conservative pixel evidence for an existing C / degree-C OCR disagreement."""
from __future__ import annotations

import math
import re
import statistics
import hashlib


_QUANTITY = re.compile(r'(-?\d+(?:\.\d+)?(?:--?\d+(?:\.\d+)?)?)\s*(C|℃|°C)')


def unit_disagreements(primary, secondary):
    if not primary or not secondary:
        return []
    if primary['rows'] != secondary['rows'] or primary['columns'] != secondary['columns']:
        return []
    if [(c['row'], c['column'], c['rowspan'], c['colspan']) for c in primary['cells']] != [(c['row'], c['column'], c['rowspan'], c['colspan']) for c in secondary['cells']]:
        return []
    disagreements = []
    for first, second in zip(primary['cells'], secondary['cells']):
        a, b = _QUANTITY.fullmatch(first['text']), _QUANTITY.fullmatch(second['text'])
        if a and b and a[1] == b[1] and (a[2] == 'C') != (b[2] == 'C'):
            disagreements.append({'row': first['row'], 'column': first['column'], 'number': a[1], 'primary': first['text'], 'secondary': second['text'], 'primary_unit': a[2], 'secondary_unit': b[2]})
    return disagreements


def _runs(values):
    groups = []
    for value in values:
        if not groups or value > groups[-1][-1] + 1:
            groups.append([])
        groups[-1].append(value)
    return groups


def _grid(image, bbox, rows, columns):
    if image.width * image.height > 8_000_000:
        raise ValueError('page_pixel_budget_exceeded')
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4 or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in bbox) or not (0 <= bbox[0] < bbox[2] <= 1 and 0 <= bbox[1] < bbox[3] <= 1):
        raise ValueError('table_bbox_invalid')
    x0, y0, x1, y1 = [round(v * extent) for v, extent in zip(bbox, (image.width, image.height, image.width, image.height))]
    margin = max(4, round(max(x1 - x0, y1 - y0) * .015))
    box = (max(0, x0 - margin), max(0, y0 - margin), min(image.width, x1 + margin), min(image.height, y1 + margin))
    gray = image.crop(box).convert('L')
    pixels = gray.load()
    width, height = gray.size
    horizontal = _runs([y for y in range(height) if sum(pixels[x, y] < 220 for x in range(width)) >= (x1 - x0) * .85])
    vertical = _runs([x for x in range(width) if sum(pixels[x, y] < 220 for y in range(height)) >= (y1 - y0) * .85])
    if len(horizontal) != rows + 1 or len(vertical) != columns + 1:
        raise ValueError('table_grid_not_unique_or_incomplete')
    xs = [round(statistics.mean(group)) for group in vertical]
    ys = [round(statistics.mean(group)) for group in horizontal]
    if min(b - a for a, b in zip(xs, xs[1:])) < 30 or min(b - a for a, b in zip(ys, ys[1:])) < 26:
        raise ValueError('table_grid_too_small')
    if any(len(group) > 6 for group in horizontal + vertical):
        raise ValueError('table_grid_strokes_ambiguous')
    if abs(xs[0] + box[0] - x0) > margin or abs(xs[-1] + box[0] - x1) > margin or abs(ys[0] + box[1] - y0) > margin or abs(ys[-1] + box[1] - y1) > margin:
        raise ValueError('table_grid_bbox_mismatch')
    for group in horizontal:
        if any(not any(pixels[x, y] < 220 for y in group) for x in range(xs[0], xs[-1] + 1)):
            raise ValueError('table_grid_broken')
    for group in vertical:
        if any(not any(pixels[x, y] < 220 for x in group) for y in range(ys[0], ys[-1] + 1)):
            raise ValueError('table_grid_broken')
    return gray, box, xs, ys


def _components(image, threshold):
    width, height = image.size
    points = {(i % width, i // width) for i, value in enumerate(image.tobytes()) if value < threshold}
    components = []
    while points:
        start = points.pop()
        pending, part = [start], {start}
        for x, y in pending:
            for neighbor in ((x - 1, y - 1), (x, y - 1), (x + 1, y - 1), (x - 1, y), (x + 1, y), (x - 1, y + 1), (x, y + 1), (x + 1, y + 1)):
                if neighbor in points:
                    points.remove(neighbor)
                    pending.append(neighbor)
                    part.add(neighbor)
        xx, yy = zip(*part)
        components.append({'bbox': (min(xx), min(yy), max(xx) + 1, max(yy) + 1), 'pixels': part})
    return sorted(components, key=lambda part: (part['bbox'][0], part['bbox'][1]))


def _holes(component):
    x0, y0, x1, y1 = component['bbox']
    white = {(x, y) for x in range(x0 - 1, x1 + 1) for y in range(y0 - 1, y1 + 1)} - component['pixels']
    pending = [(x0 - 1, y0 - 1)]
    white.remove(pending[0])
    for x, y in pending:
        for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if neighbor in white:
                white.remove(neighbor)
                pending.append(neighbor)
    return white


def _is_c(component, opening_band=(.35, .65)):
    x0, y0, x1, y1 = component['bbox']
    width, height = x1 - x0, y1 - y0
    pixels = component['pixels']
    if not .45 <= width / height <= 1.1 or _holes(component):
        return False
    middle = range(y0 + round(height * opening_band[0]), y0 + round(height * opening_band[1]))
    if any(x >= x0 + width * .7 and y in middle for x, y in pixels):
        return False
    if not all(any(x <= x0 + width * .3 and (x, y) in pixels for x in range(x0, x1)) for y in middle):
        return False
    return all(any(x > x0 + width * .4 and (x, y) in pixels for x in range(x0, x1) for y in band) for band in (range(y0, y0 + max(2, height // 5)), range(y1 - max(2, height // 5), y1)))


def _single_hole(component):
    white = _holes(component)
    if not white:
        return False
    pending = [white.pop()]
    for x, y in pending:
        for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if neighbor in white:
                white.remove(neighbor)
                pending.append(neighbor)
    return not white


def _cell_unit(image, number, quality):
    if image.width * image.height > 1_000_000:
        raise ValueError('cell_pixel_budget_exceeded')
    strong = _components(image, 150)
    quality.update(strong_threshold=150, faint_ink_threshold=255, strong_components=len(strong), cell_sha256=hashlib.sha256(image.tobytes()).hexdigest())
    if not strong:
        raise ValueError('cell_ink_missing')
    expected = len(number)
    if len(strong) not in {expected + 1, expected + 2}:
        raise ValueError('numeric_or_unit_component_count_mismatch')
    weak = _components(image, 255)
    quality['weak_components'] = len(weak)
    if len(weak) != len(strong):
        raise ValueError('faint_or_unexplained_ink')
    # Each connected strong component lies wholly inside one weak component.
    strong_markers = {next(iter(part['pixels'])): part for part in strong}
    # Faint marks must not disappear merely because the dark glyph threshold misses them.
    for component in weak:
        explained = [strong_markers[pixel] for pixel in component['pixels'] if pixel in strong_markers]
        if len(explained) != 1:
            raise ValueError('faint_or_unexplained_ink')
        part = explained[0]
        x0, y0, x1, y1 = component['bbox']
        if not (part['bbox'][0] - 2 <= x0 and part['bbox'][1] - 2 <= y0 and x1 <= part['bbox'][2] + 2 and y1 <= part['bbox'][3] + 2):
            raise ValueError('faint_or_unexplained_ink')
    if any(part['bbox'][0] <= 1 or part['bbox'][1] <= 1 or part['bbox'][2] >= image.width - 1 or part['bbox'][3] >= image.height - 1 for part in strong):
        raise ValueError('glyph_touches_cell_boundary')
    numeric, rest = strong[:expected], strong[expected:]
    digits = [component for char, component in zip(number, numeric) if char.isdigit()]
    heights = [part['bbox'][3] - part['bbox'][1] for part in digits]
    body_height = statistics.median(heights)
    top = statistics.median(part['bbox'][1] for part in digits)
    baseline = statistics.median(part['bbox'][3] for part in digits)
    quality['numeric_height_pixels'] = body_height
    quality['numeric_components'] = [{'character': char, 'bbox': list(part['bbox'])} for char, part in zip(number, numeric)]
    if body_height < 18:
        raise ValueError('numeric_resolution_too_low')
    for char, part in zip(number, numeric):
        x0, y0, x1, y1 = part['bbox']
        width, height = x1 - x0, y1 - y0
        if char.isdigit():
            if not .75 * body_height <= height <= 1.2 * body_height or not .15 * body_height <= width <= body_height or abs(y0 - top) > 2 or abs(y1 - baseline) > 2 or len(part['pixels']) < body_height ** 2 * .07:
                raise ValueError('numeric_glyph_geometry_mismatch')
        elif char == '.':
            if not 2 <= len(part['pixels']) or width > body_height * .3 or height > body_height * .3 or abs(y1 - baseline) > 2:
                raise ValueError('decimal_geometry_mismatch')
        elif char == '-':
            if not .2 * body_height <= width <= .8 * body_height or height > .25 * body_height or not top + .3 * body_height <= (y0 + y1) / 2 <= top + .75 * body_height:
                raise ValueError('range_separator_geometry_mismatch')
    if any(not 0 < b['bbox'][0] - a['bbox'][2] <= body_height * .55 for a, b in zip(numeric, numeric[1:])):
        raise ValueError('numeric_spacing_mismatch')
    unit = rest[-1]
    ux0, uy0, ux1, uy1 = unit['bbox']
    unit_marker = next(iter(unit['pixels']))
    weak_unit = next(part for part in weak if unit_marker in part['pixels'])
    # Antialiasing widens C terminals; its faint outline must still keep an open center.
    if abs(uy0 - top) > 2 or abs(uy1 - baseline) > 2 or not _is_c(unit) or not _is_c(weak_unit, (.4, .6)):
        raise ValueError('terminal_c_geometry_unverified')
    quality['terminal_c_bbox'] = list(unit['bbox'])
    gap = ux0 - numeric[-1]['bbox'][2]
    if not .15 * body_height <= gap <= 1.5 * body_height:
        raise ValueError('unit_spacing_unverified')
    if len(rest) == 1:
        return 'C', quality
    circle = rest[0]
    cx0, cy0, cx1, cy1 = circle['bbox']
    cw, ch = cx1 - cx0, cy1 - cy0
    if not .15 * body_height <= min(cw, ch) <= max(cw, ch) <= .5 * body_height or not .65 <= cw / ch <= 1.5 or not _single_hole(circle) or cy1 > top + .45 * body_height or cy0 < top - .35 * body_height or not 0 <= ux0 - cx1 <= body_height * .3 or cx0 <= numeric[-1]['bbox'][2]:
        raise ValueError('degree_ring_geometry_unverified')
    quality['degree_ring_bbox'] = list(circle['bbox'])
    return 'degree-C', quality


def assess_scan_units(page_image, table_bbox, primary, secondary):
    targets = unit_disagreements(primary, secondary)
    audits = [{**target, 'status': 'unresolved', 'reason': 'unit_image_unavailable', 'before': target['primary'], 'after': target['primary']} for target in targets]
    if targets and any(cell['rowspan'] != 1 or cell['colspan'] != 1 for candidate in (primary, secondary) for cell in candidate['cells']):
        for audit in audits:
            audit['reason'] = 'merged_cells_not_supported'
        return audits
    if not targets or page_image is None:
        return audits
    for audit in audits:
        audit['quality'] = {'page_pixels': list(page_image.size), 'grid_threshold': 220}
    try:
        gray, crop_box, xs, ys = _grid(page_image, table_bbox, primary['rows'], primary['columns'])
    except ValueError as exc:
        for audit in audits:
            audit['reason'] = str(exc)
        return audits
    for audit in audits:
        row, column = audit['row'], audit['column']
        box = (xs[column] + 4, ys[row] + 4, xs[column + 1] - 4, ys[row + 1] - 4)
        absolute = [box[0] + crop_box[0], box[1] + crop_box[1], box[2] + crop_box[0], box[3] + crop_box[1]]
        audit['cell_bbox_pixels'] = absolute
        audit['cell_bbox'] = [value / extent for value, extent in zip(absolute, (page_image.width, page_image.height, page_image.width, page_image.height))]
        try:
            cell_image = gray.crop(box)
            audit['quality']['cell_pixels'] = list(cell_image.size)
            selected, quality = _cell_unit(cell_image, audit['number'], audit['quality'])
            selected_text = audit['primary'] if (audit['primary_unit'] == 'C') == (selected == 'C') else audit['secondary']
            audit.update(status='selected', reason='complete_numeric_components_and_visible_unit_shape', after=selected_text, selected_unit_shape=selected, quality=quality)
        except ValueError as exc:
            audit['reason'] = str(exc)
    return audits
