import unittest
from types import SimpleNamespace

from services.parser_service.native_pdf import NativePage, font_metadata, glyph_unicode, math_style


def glyph(text, x, baseline=50, size=10, font='Regular', rotated=False):
    return {'text': text, 'x0': x, 'x1': x + 5, 'top': baseline - size * .8, 'bottom': baseline + size * .2, 'size': size, 'fontname': font, 'matrix': [0, 1, -1, 0, x, 100 - baseline] if rotated else [1, 0, 0, 1, x, 100 - baseline], 'upright': not rotated}


def page(chars, lines=(), fonts=None):
    return NativePage(SimpleNamespace(width=100, height=100, chars=chars, lines=list(lines), rects=[]), fonts)


def line(x0, x1, y):
    return {'x0': x0, 'x1': x1, 'top': y, 'bottom': y, 'linewidth': .5}


class NativeEvidenceTest(unittest.TestCase):
    def test_unknown_cid_is_unusable(self):
        p = page([glyph('(cid:91)', 10)])
        self.assertEqual(p.evidence(p.chars)['usable_glyphs'], 0)

    def test_embedded_encoding_resolves_known_cid_only(self):
        fonts = {'Regular': {'encoding': {0: {'glyph_name': 'parenleftbig', 'unicode': '('}}}}
        p = page([glyph('(cid:0)', 10), glyph('(cid:91)', 20)], fonts=fonts)
        self.assertEqual([c['canonical'] for c in p.chars], ['(', ''])
        self.assertEqual(p.chars[0]['text'], '(cid:0)')

    def test_adobe_extension_glyph_names(self):
        self.assertEqual(glyph_unicode('parenleftbig'), '(')
        self.assertEqual(glyph_unicode('summationtext.1'), '∑')
        self.assertEqual(glyph_unicode('unknownshape'), '')

    def test_rotated_text_is_not_projected(self):
        p = page([glyph('A', 10, font='Bold', rotated=True)], fonts={'Bold': {'bold': True}})
        spans, evidence = p.style_spans('A', [0, 0, 1, 1])
        self.assertEqual(spans, [])
        self.assertEqual(evidence['rotated_glyphs'], 1)

    def test_fraction_line_is_not_an_underline(self):
        p = page([glyph('1', 10, baseline=50, size=8), glyph('k', 10, baseline=57, size=8)], [line(10, 15, 51.5)])
        self.assertFalse(p.underlines)

    def test_table_rule_is_not_an_underline(self):
        p = page([glyph('7', 10), glyph('8', 60)], [line(0, 100, 52)])
        self.assertFalse(p.underlines)

    def test_underline_has_glyph_and_line_evidence(self):
        p = page([glyph('7', 10), glyph('8', 15)], [line(10, 20, 52)])
        spans, _ = p.style_spans('78', [0, 0, 1, 1])
        self.assertEqual(spans[0]['styles'], ['underline'])
        self.assertEqual(len(spans[0]['underline_evidence']), 2)

    def test_regular_s_has_no_calligraphic_font_evidence(self):
        self.assertEqual(math_style('S', 'ABCDEF+CMR10'), (None, None))
        self.assertEqual(math_style('S', 'ABCDEF+CMSY10')[0], 'mathcal')

    def test_explicit_font_weight_and_italic(self):
        info = font_metadata({'/BaseFont': '/OpaqueName', '/FontDescriptor': {'/FontWeight': 700, '/ItalicAngle': -10}})
        self.assertTrue(info['bold'])
        self.assertTrue(info['italic'])

    def test_type1_medium_name_uses_embedded_bold_weight(self):
        stream = SimpleNamespace(get_data=lambda: b'/Weight (Bold) def /ItalicAngle 0 def /Encoding 256 array dup 0 /parenleftbig put currentfile eexec')
        info = font_metadata({'/BaseFont': '/Nimbus-Medi', '/FontDescriptor': {'/FontFile': stream}})
        self.assertTrue(info['bold'])
        self.assertEqual(info['classification_source'], 'embedded_type1_weight')

    def test_unicode_math_bold_retains_style_before_normalization(self):
        p = page([glyph('𝐀', 10)])
        spans, _ = p.style_spans('A', [0, 0, 1, 1])
        self.assertEqual(spans[0]['styles'], ['bold'])

    def test_inline_crop_does_not_union_two_body_lines(self):
        p = page([glyph('L', 70, baseline=30), glyph('β', 80, baseline=30), glyph('2', 85, baseline=32, size=7), glyph('=', 0, baseline=45), glyph('0', 5, baseline=45), glyph('R', 20, baseline=45)])
        evidence = p.inline_geometry([1, 2, 3, 4], [0, 0, 1, 1])
        self.assertEqual(evidence['status'], 'unresolved')
        self.assertEqual(evidence['reason'], 'inline_multiline_geometry')


if __name__ == '__main__':
    unittest.main()
