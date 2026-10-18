import unittest

from services.parser_service.math_evidence import TexAtoms, assess_formula, native_atoms, selectable_script_segments
from services.parser_service.native_pdf import math_style, resource_fonts
from services.parser_service.tests.test_native_pdf import glyph, line, page


class MathNativeV9Test(unittest.TestCase):
    def test_tex_nonbreaking_space_is_not_a_visible_atom(self):
        p = page([glyph(c, i * 6) for i, c in enumerate('(0.22µm)')])
        content, audit = assess_formula(r'(0.22~{\mu}\mathrm{m})', None, p, [0, 0, 1, 1])
        self.assertEqual(audit['status'], 'confirmed')
        self.assertEqual(len(TexAtoms(content).atoms), 8)

    def test_ell_is_a_symbol_and_not_a_calligraphic_alphabet(self):
        self.assertEqual(math_style('ℓ', 'Regular'), (None, None))
        p = page([glyph('ℓ', 10)])
        self.assertEqual(assess_formula(r'\ell', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        self.assertEqual(math_style('𝒜', 'Regular')[0], 'mathcal')

    def test_intrinsic_unicode_scripts_survive_nfkc(self):
        for text, formula, kind in [('²', '^2', 'sup'), ('¹⁸', '^{18}', 'sup'), ('₂', '_2', 'sub')]:
            p = page([glyph(c, i * 6) for i, c in enumerate(text)])
            atoms, _ = native_atoms(p, [0, 0, 1, 1])
            self.assertEqual([a['script'] for a in atoms], [kind] * len(text))
            self.assertEqual(assess_formula(formula, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
            wrong = formula.replace('^', '_') if kind == 'sup' else formula.replace('_', '^')
            self.assertNotEqual(assess_formula(wrong, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_wrapped_formula_uses_each_adjacent_body_line(self):
        p = page([glyph('L', 60, baseline=30), glyph('β', 70, baseline=30), glyph('2', 75, baseline=32, size=7), glyph('=', 0, baseline=45), glyph('0', 5, baseline=45), glyph('.', 10, baseline=45), glyph('9', 15, baseline=45), glyph('8', 20, baseline=45), glyph('R', 30, baseline=45)])
        ids = list(range(1, 8))
        atoms, availability = native_atoms(p, [0, 0, 1, 1], ids, [0, 0, 1, 1])
        self.assertEqual([a['script'] for a in atoms], [None, 'sub', None, None, None, None, None])
        self.assertTrue(availability['per_line_baselines'])
        self.assertEqual(availability['line_baselines_normalized'], [.3, .45])
        self.assertEqual(assess_formula(r'\beta_2=0.98', None, p, [0, 0, 1, 1], ids, [0, 0, 1, 1])[1]['status'], 'confirmed')
        self.assertNotEqual(assess_formula(r'\beta^2=0.98', None, p, [0, 0, 1, 1], ids, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_fraction_order_remains_strict_with_prose_on_two_rows(self):
        p = page([glyph('L', 0, baseline=30), glyph('a', 20, baseline=30), glyph('b', 20, baseline=50), glyph('R', 40, baseline=50)], [line(18, 27, 40)])
        for content in [r'\frac{a}{b}', r'\frac{b}{a}']:
            self.assertNotEqual(assess_formula(content, None, p, [0, 0, 1, 1], [1, 2], [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_operator_limits_do_not_create_fraction_rows(self):
        p = page([glyph('=', 0), glyph('1', 12, baseline=46, size=7), glyph('k', 12, baseline=54, size=7), glyph('∑', 25, baseline=43), glyph('k', 30, baseline=46, size=7), glyph('i', 30, baseline=54, size=7), glyph('=', 35, baseline=54, size=7), glyph('1', 40, baseline=54, size=7), glyph('p', 50), glyph('i', 55, baseline=52, size=7)], [line(11, 18, 47.5)])
        good = assess_formula(r'=\frac{1}{k}\sum_{i=1}^{k}p_i', None, p, [0, 0, 1, 1])[1]
        self.assertEqual(good['status'], 'confirmed')
        self.assertNotEqual(assess_formula(r'=\frac{k}{1}\sum_{i=1}^{k}p_i', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_greek_macro_can_receive_native_bold_style(self):
        p = page([glyph('α', 10, font='Bold')], fonts={'Bold': {'bold': True, 'italic': False}})
        fixed, audit = assess_formula(r'\alpha', None, p, [0, 0, 1, 1])
        self.assertEqual(fixed, r'\mathbf{\alpha}')
        self.assertEqual(audit['status'], 'confirmed')
        self.assertEqual(audit['changes'][0]['reason'], 'native_math_alphabet')

    def test_number_and_dagger_share_a_native_superscript_run(self):
        p = page([glyph('A', 0, size=12), glyph('1', 8, baseline=46, size=8), glyph('†', 13, baseline=46, size=8), glyph(',', 20, size=12)])
        fixed, audit = assess_formula(r'^{1}\dagger', None, p, [0, 0, 1, 1], [1, 2], [0, 0, 1, 1])
        self.assertEqual(audit['status'], 'confirmed')
        segments = selectable_script_segments(fixed, p, [0, 0, 1, 1], [1, 2], [0, 0, 1, 1])
        self.assertEqual([(s['text'], s.get('script_kind')) for s in segments], [('1†', 'sup')])
        wrong = assess_formula(r'_{1}\dagger', None, p, [0, 0, 1, 1], [1, 2], [0, 0, 1, 1])[1]
        self.assertNotEqual(wrong['status'], 'confirmed')

    def test_baseline_dagger_marker_drops_only_false_outer_script(self):
        p = page([glyph('A', 0), glyph('(', 10), glyph('†', 15), glyph(')', 20), glyph('B', 30)])
        fixed, audit = assess_formula(r'^{(\dagger)}', None, p, [0, 0, 1, 1], [1, 2, 3], [0, 0, 1, 1])
        self.assertEqual(fixed, r'(\dagger)')
        self.assertEqual(audit['status'], 'confirmed')
        self.assertEqual(audit['changes'][0]['reason'], 'native_baseline_marker')
        p = page([glyph('A', 0), glyph('x', 10), glyph('B', 20)])
        self.assertNotEqual(assess_formula('^x', None, p, [0, 0, 1, 1], [1], [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_recursive_form_resources_preserve_font_identity(self):
        nested = {'/Font': {'/F2': {'name': 'nested'}}}
        resources = {'/Font': {'/F1': {'name': 'outer'}}, '/XObject': {'/Form': {'/Resources': nested}}}
        nested['/XObject'] = {'/Cycle': {'/Resources': resources}}
        self.assertEqual([(name, font['name']) for name, font in resource_fonts(resources, lambda value: value)], [('/F1', 'outer'), ('/F2', 'nested')])


if __name__ == '__main__':
    unittest.main()
