import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

from services.parser_service.currency import normalize_currency_dollars
from services.parser_service.native_pdf import NativePage, NativePDF


ROOT = Path(__file__).resolve().parents[1]
DEMO_DIR = os.environ.get('GUZI_TEST_DEMO_DIR')
SOURCE = Path(DEMO_DIR).expanduser() / '2.pdf' if DEMO_DIR else None
RESULT = ROOT / 'apps/desktop/build/pdf-benchmark-20261017/results/math-v8/api/demo2/document.json'


def native_page(text):
    chars = [{'text': c, 'x0': i * 5, 'x1': i * 5 + 5,
              'top': 42, 'bottom': 52, 'size': 10, 'fontname': 'Regular',
              'matrix': [1, 0, 0, 1, i * 5, 50], 'upright': True}
             for i, c in enumerate(text)]
    return NativePage(SimpleNamespace(width=2000, height=100, chars=chars, lines=[], rects=[]), {})


class CurrencyV9Tests(unittest.TestCase):
    def normalize(self, content, native):
        return normalize_currency_dollars(content, native_page(native), [0, 0, 1, 1])

    def test_native_touching_dollar_allows_float_roundoff(self):
        page = native_page('Pay $50 per hour')
        dollar = next(c for c in page.chars if c['canonical'] == '$')
        dollar['x1'] += 5e-14
        fixed, edits = normalize_currency_dollars('Pay $50 per hour', page, [0, 0, 1, 1])
        self.assertEqual(fixed, r'Pay \$50 per hour')
        self.assertEqual(edits[0]['source_glyph_ids'], [4])

    def test_moved_ocr_space_returns_to_word_boundary(self):
        fixed, edits = self.normalize('Always$ 50 or more', 'Always $50 or more')
        self.assertEqual(fixed, r'Always \$50 or more')
        self.assertEqual(edits[0]['before'], '$ ')

    def test_fake_wrapper_and_currency_pm_become_selectable_text(self):
        fixed, edits = self.normalize(r'Cost $4.48$ \pm $ 1.02 per article', 'Cost $4.48 ± $1.02 per article')
        self.assertEqual(fixed, r'Cost \$4.48 ± \$1.02 per article')
        self.assertIn('math_wrapper_after_native_currency', [e['reason'] for e in edits])
        self.assertIn('native_currency_plus_minus', [e['reason'] for e in edits])
        self.assertEqual(self.normalize(fixed, 'Cost $4.48 ± $1.02 per article'), (fixed, []))

    def test_real_numeric_math_and_following_math_are_preserved(self):
        for content, native in [(r'Value $10.5\pm0.2$ now', 'Value 10.5±0.2 now'),
                                ('$3$', '3'), ('$x=50$ and $y$', 'x=50 and y')]:
            with self.subTest(content=content):
                self.assertEqual(self.normalize(content, native), (content, []))
        self.assertEqual(self.normalize('Pay $3 then $x$ now', 'Pay $3 then x now')[0], r'Pay \$3 then $x$ now')
        self.assertEqual(self.normalize('Pay $3$x$ now', 'Pay $3x now')[0], r'Pay \$3$x$ now')

    def test_pm_without_native_plus_minus_is_not_guessed(self):
        fixed, edits = self.normalize(r'Cost $4.48 \pm $1.02.', 'Cost $4.48 and $1.02.')
        self.assertIn(r'\pm', fixed)
        self.assertNotIn('native_currency_plus_minus', [e['reason'] for e in edits])

    def test_currency_and_real_pm_math_coexist(self):
        fixed, _ = self.normalize(r'Pay $50 and report $10.5\pm0.2$ now', 'Pay $50 and report 10.5±0.2 now')
        self.assertEqual(fixed, r'Pay \$50 and report $10.5\pm0.2$ now')

    def test_unrelated_or_rotated_dollars_do_not_prove_currency(self):
        self.assertEqual(self.normalize('Value $50$', '$tax 50'), ('Value $50$', []))
        page = native_page('$50')
        page.chars[0]['rotated'] = True
        self.assertEqual(normalize_currency_dollars('$50$', page, [0, 0, 1, 1]), ('$50$', []))

    @unittest.skipUnless(SOURCE is not None and SOURCE.is_file() and RESULT.is_file(), 'GUZI_TEST_DEMO_DIR/2.pdf or local export fixture unavailable')
    def test_original_pdf_payment_blocks_and_cost(self):
        data = json.loads(RESULT.read_text())
        cases = {
            'b-fd4d31bd24781bc32c57f48d': [(r'cost of \$4.48 ± \$1.02 per article', 2)],
            'b-b9c538bc6ee2c2e3fb10f43d': [(r'at \$50 per hour', 2), (r'always \$50 or more', 2)],
            'b-b42313e63d90aac0ccf06fe6': [(r'between \$50 to \$100 per hour', 3)],
            'b-cbee1ef31cd7af18b1cada56': [(r'offered \$10 per statement', 2), (r'offered a \$10 per question', 2)],
            'b-a3b46d57b476d9208b7d31c6': [(r'paid \$20 per claim', 3), (r'a \$200', 3)],
        }
        with NativePDF(SOURCE) as pdf:
            for source_page in data['pages']:
                for block in source_page['blocks']:
                    if block.get('block_id') not in cases:
                        continue
                    original = block['original_candidate_content']
                    fixed, edits = normalize_currency_dollars(original, pdf.page(source_page['source_page'] - 1), block['source_bbox_normalized'])
                    with self.subTest(block=block['block_id']):
                        for expected, count in cases.pop(block['block_id']):
                            self.assertIn(expected, fixed)
                            self.assertEqual(sum(e['reason'] == 'literal_currency_dollar_in_native_pdf' for e in edits), count)
                        for edit in edits:
                            self.assertEqual(original[edit['start']:edit['end']], edit['before'])
                            self.assertTrue(edit['source_glyph_ids'])
        self.assertFalse(cases)


if __name__ == '__main__':
    unittest.main()
