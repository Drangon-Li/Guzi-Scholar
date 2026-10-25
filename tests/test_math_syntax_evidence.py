import unittest

from services.parser_service.math_evidence import TexAtoms, assess_formula, selectable_script_segments
from services.parser_service.tests.test_native_pdf import glyph, page


class MathSyntaxEvidenceTest(unittest.TestCase):
    def test_extra_top_level_closing_brace_is_never_confirmed(self):
        p = page([glyph('ŷ', 10)])
        for candidate in [r'\hat{y}}', r'\hat{y}}+x', r'\hat{y}}}']:
            with self.subTest(candidate=candidate):
                fixed, audit = assess_formula(candidate, None, p, [0, 0, 1, 1])
                self.assertEqual(fixed, candidate)
                self.assertNotEqual(audit['status'], 'confirmed')
                self.assertEqual(audit['reason'], 'formula_candidate_syntax_invalid')
                self.assertTrue(audit['candidates'][0]['syntax_errors'])

    def test_suffix_after_bad_closing_brace_is_still_parsed(self):
        parsed = TexAtoms(r'\hat{y}}+x')
        self.assertEqual(''.join(atom['text'] for atom in parsed.atoms), 'y+x')
        self.assertEqual(parsed.pos, len(parsed.text))
        self.assertEqual(parsed.syntax_errors, [{'kind': 'unexpected_closing_brace', 'position': 7}])

    def test_missing_closing_brace_is_never_confirmed(self):
        p = page([glyph('ŷ', 10)])
        for candidate in [r'\hat{y', r'{\hat{y}', r'{{\hat{y}}']:
            with self.subTest(candidate=candidate):
                fixed, audit = assess_formula(candidate, None, p, [0, 0, 1, 1])
                self.assertEqual(fixed, candidate)
                self.assertNotEqual(audit['status'], 'confirmed')
                self.assertTrue(any(error['kind'] == 'unclosed_group' for error in audit['candidates'][0]['syntax_errors']))

    def test_balanced_nested_groups_remain_confirmed(self):
        p = page([glyph('ŷ', 10)])
        for candidate in [r'{{\hat{{y}}}}', r'{\hat{y}}', r'\hat{{{y}}}']:
            with self.subTest(candidate=candidate):
                parsed = TexAtoms(candidate)
                self.assertEqual(parsed.syntax_errors, [])
                self.assertEqual(assess_formula(candidate, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_missing_arguments_and_dangling_escape_are_diagnosed(self):
        p = page([glyph('x', 10)])
        for candidate in ['x^', 'x_', 'x\\', r'\hat', 'x_{}^']:
            with self.subTest(candidate=candidate):
                self.assertTrue(TexAtoms(candidate).syntax_errors)
                self.assertNotEqual(assess_formula(candidate, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_bad_script_cannot_bypass_syntax_checks_via_selectable_segments(self):
        p = page([glyph('1', 10, baseline=45, size=7), glyph('B', 20)])
        self.assertIsNone(selectable_script_segments('^{1}}', p, [0, 0, 1, 1], [0], [0, 0, 1, 1]))

    def test_escaped_literal_braces_are_balanced_literals(self):
        p = page([glyph(c, 10 + i * 5) for i, c in enumerate('{x}')])
        candidate = r'\{x\}'
        self.assertEqual(TexAtoms(candidate).syntax_errors, [])
        self.assertEqual(assess_formula(candidate, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_left_right_require_delimiters_and_pairs(self):
        p = page([glyph('ŷ', 10)])
        for candidate in [r'\hat{y}\left', r'\hat{y}\right', r'\left\hat{y}', r'\left x\hat{y}', r'\right)\hat{y}', r'\left(\hat{y}', r'{\left(\hat{y}}\right)', r'{\left(\hat{y}}{\right)}']:
            with self.subTest(candidate=candidate):
                parsed = TexAtoms(candidate)
                self.assertTrue(parsed.syntax_errors)
                self.assertEqual(parsed.pos, len(candidate))
                self.assertNotEqual(assess_formula(candidate, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_valid_left_right_pairs_allow_different_and_invisible_delimiters(self):
        cases = [
            (r'\left(\hat{y}\right)', '(ŷ)'),
            (r'\left[\hat{y}\right)', '[ŷ)'),
            (r'\left.\hat{y}\right)', 'ŷ)'),
            (r'\left.\hat{y}\right.', 'ŷ'),
            (r'\left\{\hat{y}\right\}', '{ŷ}'),
            (r'\left\langle\hat{y}\right\rvert', '⟨ŷ|'),
            (r'\left(\left[\hat{y}\right)\right]', '([ŷ)]'),
        ]
        for candidate, source in cases:
            with self.subTest(candidate=candidate):
                p = page([glyph(c, 10 + i * 5) for i, c in enumerate(source)])
                self.assertEqual(TexAtoms(candidate).syntax_errors, [])
                self.assertEqual(assess_formula(candidate, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_unknown_unclosed_and_mismatched_environments_are_not_confirmed(self):
        p = page([glyph('ŷ', 10)])
        for candidate in [
            r'\hat{y}\begin{invalid}',
            r'\begin{invalid}\hat{y}\end{invalid}',
            r'\begin{matrix}\hat{y}\end{equation}',
            r'\begin{matrix}\hat{y}', r'\hat{y}\end{matrix}',
            r'{\begin{matrix}\hat{y}}\end{matrix}',
            r'\begin{matrix}\begin{smallmatrix}\hat{y}\end{matrix}\end{smallmatrix}',
            r'\begin matrix\hat{y}',
        ]:
            with self.subTest(candidate=candidate):
                self.assertTrue(TexAtoms(candidate).syntax_errors)
                _, audit = assess_formula(candidate, None, p, [0, 0, 1, 1])
                self.assertNotEqual(audit['status'], 'confirmed')
                self.assertEqual(audit['reason'], 'formula_candidate_syntax_invalid')

    def test_paired_matrix_environments_remain_confirmed_and_renderable(self):
        from services.parser_service.exporter import display_math
        p = page([glyph('ŷ', 10)])
        for candidate in [r'\begin{matrix}\hat{y}\end{matrix}', r'\begin{matrix}\begin{smallmatrix}\hat{y}\end{smallmatrix}\end{matrix}']:
            with self.subTest(candidate=candidate):
                self.assertEqual(TexAtoms(candidate).syntax_errors, [])
                fixed, audit = assess_formula(candidate, None, p, [0, 0, 1, 1])
                self.assertEqual(audit['status'], 'confirmed')
                self.assertTrue(display_math(fixed, audit))

    def test_duplicate_scripts_on_one_base_are_not_confirmed(self):
        for marker, baseline in [('_', 53), ('^', 45)]:
            p = page([glyph('ŷ', 10), glyph('i', 15, baseline=baseline, size=7), glyph('j', 20, baseline=baseline, size=7)])
            for candidate in [rf'\hat{{y}}{marker}i{marker}j', rf'\hat{{y}}{marker}{{i}}{marker}{{j}}', rf'\hat{{y}}{marker}i\limits{marker}j']:
                with self.subTest(candidate=candidate):
                    self.assertTrue(any(error['kind'] == 'duplicate_script' for error in TexAtoms(candidate).syntax_errors))
                    self.assertNotEqual(assess_formula(candidate, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_distinct_scripts_and_scripts_on_distinct_bases_remain_valid(self):
        p = page([glyph('x', 10), glyph('i', 15, baseline=53, size=7), glyph('j', 20, baseline=45, size=7)])
        for candidate in ['x_i^j', 'x_{i}^{j}']:
            with self.subTest(candidate=candidate):
                self.assertEqual(TexAtoms(candidate).syntax_errors, [])
                self.assertEqual(assess_formula(candidate, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        for candidate in ['x_i+y_j', 'x_i{y}_j', 'x_i{}_j', 'x_{i_j}', 'x_{i}^j_k']:
            with self.subTest(candidate=candidate):
                errors = TexAtoms(candidate).syntax_errors
                self.assertEqual(bool(errors), candidate == 'x_{i}^j_k')

    def test_detached_native_script_fragments_keep_independent_runs(self):
        p = page([glyph('A', 0, size=12), glyph('1', 8, baseline=46, size=8), glyph('†', 13, baseline=46, size=8), glyph(',', 20, size=12)])
        fixed, audit = assess_formula(r'^{1}\dagger', None, p, [0, 0, 1, 1], [1, 2], [0, 0, 1, 1])
        self.assertEqual(audit['status'], 'confirmed')
        self.assertEqual(fixed, r'^{1}{}^{\dagger}')
        self.assertEqual(TexAtoms(fixed).syntax_errors, [])
        segments = selectable_script_segments(fixed, p, [0, 0, 1, 1], [1, 2], [0, 0, 1, 1])
        self.assertEqual([(segment['text'], segment['script_kind']) for segment in segments], [('1†', 'sup')])
        invalid = r'^{1}^{\dagger}'
        self.assertTrue(any(error['kind'] == 'duplicate_script' for error in TexAtoms(invalid).syntax_errors))
        self.assertNotEqual(assess_formula(invalid, None, p, [0, 0, 1, 1], [1, 2], [0, 0, 1, 1])[1]['status'], 'confirmed')


if __name__ == '__main__':
    unittest.main()
