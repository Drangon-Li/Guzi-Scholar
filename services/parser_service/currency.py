"""Restore literal monetary text using native PDF glyph evidence."""
import re


AMOUNT = re.compile(r'\$\s*\d+(?:[.,]\d+)*(?:[-–]\d+(?:[.,]\d+)*)?')


def normalize_currency_dollars(content, page, region):
    mapped, _ = page.align(content, region)
    native = [c for c in page.region(region) if c['canonical'] and not c['rotated']]
    positions = {c['glyph_id']: i for i, c in enumerate(native)}
    currencies, corrections = [], []
    for match in re.finditer(r'(?<!\\)\$(?=\s*\d)', content):
        index = match.start()
        digit = index + 1
        while content[digit].isspace():
            digit += 1
        pairs = []
        for dollar in mapped.get(index, []):
            if dollar['canonical'] != '$' or dollar['glyph_id'] not in positions:
                continue
            for number in mapped.get(digit, []):
                size = dollar.get('size', 10)
                # PDF matrix arithmetic can put touching glyphs a few ulps apart.
                gap = number['x0'] - dollar['x1']
                if positions.get(number['glyph_id']) == positions[dollar['glyph_id']] + 1 and -size * .03 <= gap < size * 1.5 and abs(number['baseline'] - dollar['baseline']) < size * .2:
                    pairs.append((dollar, number))
        if not pairs:
            continue
        dollar, number = pairs[0]
        size = dollar.get('size', 10)
        amount = AMOUNT.match(content, index)
        ids = sorted({d['glyph_id'] for d, _ in pairs})
        after = r'\$'
        end = index + 1
        if abs(number['x0'] - dollar['x1']) <= size * .1:
            end = digit
        previous = native[positions[dollar['glyph_id']] - 1] if positions[dollar['glyph_id']] else None
        if index and content[index - 1].isalnum() and previous is not None:
            if dollar['x0'] - previous['x1'] > size * .12 or abs(previous['baseline'] - dollar['baseline']) > size * .2:
                after = ' ' + after
        corrections.append({'start': index, 'end': end, 'before': content[index:end], 'after': after, 'reason': 'literal_currency_dollar_in_native_pdf', 'source_glyph_ids': ids})
        currencies.append({'index': index, 'amount_end': amount.end(), 'dollar': dollar, 'source_glyph_ids': ids})

    starts = {c['index'] for c in currencies}
    for currency in currencies:
        end = currency['amount_end']
        if end < len(content) and content[end] == '$' and end not in starts and not any(c['canonical'] == '$' for c in mapped.get(end, [])):
            if end + 1 == len(content) or content[end + 1].isspace() or content[end + 1] in ',.;:!?)]}':
                corrections.append({'start': end, 'end': end + 1, 'before': '$', 'after': '', 'reason': 'math_wrapper_after_native_currency', 'source_glyph_ids': currency['source_glyph_ids']})

    for left, right in zip(currencies, currencies[1:]):
        start, end = left['amount_end'], right['index']
        gap = content[start:end]
        if not re.fullmatch(r'\$?\s*\\pm\s*', gap):
            continue
        last_digit = mapped.get(start - 1, [])
        if not last_digit:
            continue
        lower = max(c['glyph_id'] for c in last_digit)
        upper = right['dollar']['glyph_id']
        between = [c for c in native if lower < c['glyph_id'] < upper]
        if len(between) != 1 or between[0]['canonical'] != '±':
            continue
        macro = re.search(r'\\pm', gap)
        offset = start + macro.start()
        corrections.append({'start': offset, 'end': offset + 3, 'before': r'\pm', 'after': '±', 'reason': 'native_currency_plus_minus', 'source_glyph_ids': [between[0]['glyph_id']]})

    corrections.sort(key=lambda c: c['start'])
    for change in reversed(corrections):
        content = content[:change['start']] + change['after'] + content[change['end']:]
    return content, corrections
