import unittest

from services.parser_service.fusion import restore_inline_math
from services.parser_service.tests.test_native_pdf import glyph, page


class InlineMathSyntaxTests(unittest.TestCase):
    def test_invalid_braces_cannot_use_selectable_script_shortcut(self):
        chars = [glyph(c, 3 + index * 5) for index, c in enumerate('Text 1 more.')]
        chars[5].update(size=7, baseline=44, top=37, bottom=44)
        source = page(chars)
        for candidate in [r'Text $^{1}}$ more.', r'Text $^{1$ more.']:
            with self.subTest(candidate=candidate):
                result, audits = restore_inline_math(candidate, source, [0, 0, 1, 1])
                self.assertEqual(result, candidate)
                self.assertEqual(audits[0]['status'], 'unresolved')
                self.assertEqual(audits[0]['reason'], 'formula_candidate_syntax_invalid')
                self.assertTrue(audits[0]['syntax_errors'])


if __name__ == '__main__':
    unittest.main()
