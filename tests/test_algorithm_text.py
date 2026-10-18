import unittest
import os
from pathlib import Path
from types import SimpleNamespace

from services.parser_service.algorithm_text import restore_algorithm_text
from services.parser_service.native_pdf import NativePage, NativePDF

DEMO_DIR = os.environ.get('GUZI_TEST_DEMO_DIR')
SOURCE = Path(DEMO_DIR).expanduser() / '2.pdf' if DEMO_DIR else None


def char(value, x, baseline, size=10, font='Regular', rotated=False):
    return {'text': value, 'x0': x, 'x1': x + size * .5,
            'top': baseline - size * .8, 'bottom': baseline + size * .2,
            'size': size, 'fontname': font,
            'matrix': [0, 1, -1, 0, x, 200 - baseline] if rotated else [1, 0, 0, 1, x, 200 - baseline],
            'upright': not rotated}


def word(value, x, baseline, size=10, font='Regular'):
    return [char(c, x + i * size * .5, baseline, size, font) for i, c in enumerate(value)]


def algorithm(extra=None, numbers=(1, 2, 3), title='Algorithm 1 Example', require=True):
    lines = [word(title, 10, 20)]
    if require:
        lines.append(word('Require: Set of papers', 10, 35))
    lines.append(word('Ensure: Set of outputs', 10, 50))
    for n, baseline, indent, value in zip(numbers, [65, 80, 95], [40, 55, 40], ['procedure F', 'D <- D', 'return D']):
        content = word(str(n) + ':', 10, baseline) + word(value, indent, baseline)
        if extra and baseline == 80:
            content += extra
        lines.append(content)
    return NativePage(SimpleNamespace(width=400, height=200, chars=[c for line in lines for c in line], lines=[], rects=[]), {})


def restore(page, label='algorithm'):
    return restore_algorithm_text(page, [0, 0, 1, 1], native_label=label)


def add_ink_evidence(page):
    boxes = {c['glyph_id']: [c['x0'], c['top'], c['x1'], c['bottom']] for c in page.chars}
    page.tight_glyph_boxes = lambda: boxes
    return boxes


class AlgorithmTextTest(unittest.TestCase):
    def test_proven_algorithm_restores_lines_and_indent(self):
        result = restore(algorithm())
        self.assertIsNotNone(result)
        self.assertEqual(result['evidence']['line_numbers'], [1, 2, 3])
        self.assertEqual(result['evidence']['glyph_coverage'], 1)
        self.assertEqual(result['body_font_size_points'], 10)
        self.assertIn('</div>\n<div', result['html'])
        code = [line for line in result['lines'] if line['role'] == 'code']
        self.assertEqual([line['indent_em'] for line in code], [0, 1.5, 0])
        self.assertIn('Require: Set of papers', result['text'])
        self.assertEqual(len(result['evidence']['source_glyph_ids']), len(algorithm().chars))

    def test_requires_native_algorithm_label(self):
        self.assertIsNone(restore(algorithm(), 'text'))
        self.assertIsNone(restore(algorithm(), 'figure'))

    def test_rejects_unproven_heading_or_contract(self):
        self.assertIsNone(restore(algorithm(title='Example 1')))
        self.assertIsNone(restore(algorithm(require=False)))

    def test_rejects_missing_duplicate_or_nonstarting_line_numbers(self):
        for numbers in [(1, 3, 4), (1, 2, 2), (2, 3, 4)]:
            with self.subTest(numbers=numbers):
                self.assertIsNone(restore(algorithm(numbers=numbers)))

    def test_unknown_and_rotated_glyphs_reject_whole_reconstruction(self):
        unknown = [char('(cid:991)', 180, 80)]
        self.assertIsNone(restore(algorithm(extra=unknown)))
        rotated = [char('Z', 180, 80, rotated=True)]
        self.assertIsNone(restore(algorithm(extra=rotated)))

    def test_native_math_alphabet_and_sub_sup_remain_selectable(self):
        extra = word('D', 140, 80, font='ABCDEF+CMSY10') + word('prev', 146, 81.5, 7)
        extra += word('B', 170, 80, font='ABCDEF+CMSY10') + word('2', 176, 76.5, 7)
        result = restore(algorithm(extra=extra))
        self.assertIn('𝒟<sub>prev</sub>', result['html'])
        self.assertIn('ℬ<sup>2</sup>', result['html'])
        self.assertFalse(result['local_crops'])

    def test_complex_math_has_local_visual_without_unverified_hidden_copy_text(self):
        page = algorithm(extra=[char('∑', 140, 75, font='ABCDEF+CMEX10')])
        add_ink_evidence(page)
        result = restore(page)
        self.assertEqual(len(result['local_crops']), 1)
        crop = result['local_crops'][0]
        self.assertIsNone(crop['selectable_text'])
        self.assertEqual(crop['source_text_status'], 'unresolved')
        self.assertIn('∑', crop['raw_native_text'])
        self.assertNotIn('∑', result['html'])
        self.assertIn('[公式原图]', result['text'])
        self.assertLess(result['evidence']['text_glyph_coverage'], 1)
        self.assertEqual(result['evidence']['glyph_coverage'], 1)
        self.assertEqual(len(crop['bbox']), 4)

    def test_complex_math_without_proven_ink_is_rejected(self):
        page = algorithm(extra=[char('∑', 140, 75, font='ABCDEF+CMEX10')])
        self.assertIsNone(restore(page))

    def test_local_crop_with_foreign_line_ink_is_rejected(self):
        page = algorithm(extra=[char('∑', 140, 75, font='ABCDEF+CMEX10')])
        boxes = add_ink_evidence(page)
        previous = next(c for c in page.chars if c['baseline'] == 65 and c['x0'] == 40)
        boxes[previous['glyph_id']] = [60, 74, 65, 80]
        self.assertIsNone(restore(page))

    def test_source_text_is_html_escaped(self):
        result = restore(algorithm(extra=word('<script>&', 140, 80)))
        self.assertIn('&lt;script&gt;&amp;', result['html'])
        self.assertNotIn('<script>', result['html'])

    def test_interleaved_stream_is_rejected(self):
        page = algorithm()
        first = next(c for c in page.chars if c['baseline'] == 80)
        first['glyph_id'] = 0
        self.assertIsNone(restore(page))

    @unittest.skipUnless(SOURCE is not None and SOURCE.is_file(), 'GUZI_TEST_DEMO_DIR/2.pdf fixture unavailable')
    def test_real_demo2_algorithm_1(self):
        with NativePDF(SOURCE) as doc:
            page = doc.page(15)
            result = restore_algorithm_text(page, [.112, .36, .887, .695], native_label='algorithm')
            native_boxes = page.tight_glyph_boxes()
        self.assertIsNotNone(result)
        self.assertEqual(result['evidence']['line_numbers'], list(range(1, 16)))
        self.assertEqual(result['evidence']['source_glyph_count'], 1012)
        self.assertEqual(result['evidence']['glyph_coverage'], 1)
        self.assertEqual(result['evidence']['require_count'], 2)
        self.assertEqual(result['evidence']['ensure_count'], 2)
        self.assertIn('candidate papers 𝒟, set of previous papers D', result['text'])
        self.assertIn('<sub>prev</sub>', result['html'])
        self.assertIn('ℬ', result['html'])
        self.assertIn('𝟙<sub>fut</sub>', result['html'])
        crops = {crop['id'] for crop in result['local_crops']}
        self.assertEqual(crops, {'algorithm-line-7-math', 'algorithm-line-11-math'})
        self.assertNotIn('∈/', result['html'])
        self.assertIn('Filter out already present papers', result['text'])
        crop7 = next(c for c in result['local_crops'] if c['id'] == 'algorithm-line-7-math')
        box = [crop7['bbox'][0] * page.width, crop7['bbox'][1] * page.height,
               crop7['bbox'][2] * page.width, crop7['bbox'][3] * page.height]
        selected = crop7['ink_evidence']['source_glyph_boxes']
        self.assertEqual({c['glyph_id'] for c in selected}, set(crop7['source_glyph_ids']))
        self.assertTrue(any(c.get('pdfium_unicode') == '' for c in selected))
        for char in selected:
            ink = char['bbox_points']
            self.assertLessEqual(box[0], ink[0])
            self.assertLessEqual(box[1], ink[1])
            self.assertGreaterEqual(box[2], ink[2])
            self.assertGreaterEqual(box[3], ink[3])
        previous_line = next(line for line in result['lines'] if line['number'] == 6)
        for glyph_id in previous_line['source_glyph_ids']:
            ink = native_boxes[glyph_id]
            overlap = min(box[2], ink[2]) > max(box[0], ink[0]) and min(box[3], ink[3]) > max(box[1], ink[1])
            self.assertFalse(overlap, glyph_id)


if __name__ == '__main__':
    unittest.main()
