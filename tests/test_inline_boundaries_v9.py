import unittest

from services.parser_service.fusion import anchored_native_formula, reconcile_inline_boundaries, restore_inline_math
from services.parser_service.math_evidence import TexAtoms, math_spans
from services.parser_service.tests.test_native_pdf import glyph, page


def text_page(text):
    result = page([glyph(c, i * 5) for i, c in enumerate(text)])
    result.width = max(100, len(text) * 5 + 20)
    return result


def atoms(text):
    return ''.join(a['text'] for a in TexAtoms(text).atoms)


class InlineBoundariesV9Test(unittest.TestCase):
    def test_boundary_repair_preserves_source_extra_closing_parenthesis(self):
        p = text_page('(x=1)).')
        fixed, changes = reconcile_inline_boundaries(r'\left(x=1\right)', p, p.chars, [0, 0, 1, 1])
        self.assertEqual(atoms(fixed), '(x=1)).')
        self.assertEqual(changes[0]['reason'], 'native_inline_boundary_punctuation')

    def test_shared_parenthesis_stays_open_across_prose_and(self):
        p = text_page('Before (x=1 and y=2). After')
        fixed, audits = restore_inline_math('Before $(x=1)$ and $y=2.$ After', p, [0, 0, 1, 1])
        spans = math_spans(fixed)
        self.assertEqual([atoms(latex) for _, _, latex in spans], ['(x=1', 'y=2).'])
        self.assertEqual(len(audits), 2)
        self.assertTrue(all(a['status'] == 'confirmed' for a in audits))
        self.assertIn('$ and $', fixed)

    def test_source_unbalanced_parentheses_are_not_balanced_by_latex(self):
        p = text_page('Before ((τ=0.8) after')
        candidate = r'Before $\left(\left(\tau=0.8\right)\right)$ after'
        fixed, audits = restore_inline_math(candidate, p, [0, 0, 1, 1])
        self.assertEqual(atoms(math_spans(fixed)[0][2]), '((τ=0.8)')
        self.assertEqual(audits[0]['status'], 'confirmed')
        self.assertEqual(fixed.count(')'), 1)

    def test_typographic_quotes_remain_prose_on_both_sides(self):
        for quote in ['"', '“']:
            closing = '”' if quote == '“' else quote
            p = text_page(f'Before {quote}x=1{closing}, after')
            candidate = f'Before {quote}$x=1${closing}, after'
            fixed, audits = restore_inline_math(candidate, p, [0, 0, 1, 1])
            self.assertEqual(fixed, candidate)
            self.assertEqual(audits[0]['status'], 'confirmed')
            selected = {c['glyph_id'] for c in p.chars if c['resolved_text'] in {quote, closing}}
            self.assertTrue(selected.isdisjoint(audits[0]['source_glyph_ids']))

    def test_boundary_repair_cannot_change_inner_operator(self):
        p = text_page('(x-1)')
        candidate = '(x+1)'
        self.assertEqual(reconcile_inline_boundaries(candidate, p, p.chars, [0, 0, 1, 1]), (candidate, []))

    def test_boundary_repair_cannot_change_a_number(self):
        p = text_page('(x=2)')
        self.assertEqual(reconcile_inline_boundaries('x=1', p, p.chars, [0, 0, 1, 1]), ('x=1', []))

    def test_boundary_repair_does_not_wrap_a_prose_word_fragment(self):
        p = text_page('(method)')
        self.assertEqual(reconcile_inline_boundaries('method', p, p.chars, [0, 0, 1, 1]), ('method', []))

    def test_boundary_repair_does_not_remove_inner_parentheses(self):
        p = text_page('fx=1')
        candidate = 'f(x)=1'
        self.assertEqual(reconcile_inline_boundaries(candidate, p, p.chars, [0, 0, 1, 1]), (candidate, []))

    def test_fullpage_lookup_rejects_short_anchor_collisions(self):
        visible = 'correctTAILxRIGHTexpected'
        start = len('correctTAIL')
        p = text_page('wrongxxTAILxRIGHTelse')
        found = anchored_native_formula(visible, start, start + 1, TexAtoms('x'), p, [0, 0, 1, 1])
        self.assertEqual(found, [])

    def test_fullpage_lookup_uses_the_full_available_anchor(self):
        source = 'leftsame x rightONE leftsame x rightTWO'
        visible = 'leftsame x rightTWO'
        p = text_page(source)
        start = visible.index('x')
        found = anchored_native_formula(visible, start, start + 1, TexAtoms('x'), p, [0, 0, 1, 1])
        self.assertEqual([c['glyph_id'] for c in found], [source.rindex('x')])

    def test_fullpage_lookup_rejects_two_identical_formula_contexts(self):
        source = 'leftsame x rightsame leftsame x rightsame'
        visible = 'leftsame x rightsame'
        p = text_page(source)
        start = visible.index('x')
        self.assertEqual(anchored_native_formula(visible, start, start + 1, TexAtoms('x'), p, [0, 0, 1, 1]), [])

    def test_fullpage_fallback_cannot_resolve_an_ambiguous_local_match(self):
        source = 'leftsame x rightsame leftsame x rightsame'
        chars = []
        for i, char in enumerate(source):
            if i == source.index('x'):
                chars.append(glyph('9', 0, baseline=10))
            chars.append(glyph(char, i * 5))
        p = page(chars)
        p.width = 250
        visible = 'leftsame x rightsame'
        start = visible.index('x')
        found = anchored_native_formula(visible, start, start + 1, TexAtoms('x'), p, [0, .3, 1, .6])
        self.assertEqual(found, [])

    def test_fullpage_lookup_requires_both_prose_anchors(self):
        p = text_page('leftside x rightside')
        for visible, start in [('x rightside', 0), ('leftside x', 9)]:
            self.assertEqual(anchored_native_formula(visible, start, start + 1, TexAtoms('x'), p, [0, 0, 1, 1]), [])

    def test_line_wrap_dehyphenation_must_not_delete_formula_operators(self):
        for minus in ['−', '-']:
            with self.subTest(minus=minus):
                source = 'leftsame n' + minus + 'm rightsame'
                split = source.index(minus)
                chars = [glyph(c, i * 5, baseline=50 if i <= split else 65) for i, c in enumerate(source)]
                p = page(chars)
                p.width = 150
                visible = 'leftsame nm rightsame'
                start = visible.index('nm')
                self.assertEqual(anchored_native_formula(visible, start, start + 2, TexAtoms('nm'), p, [0, 0, 1, 1]), [])
                _, audits = restore_inline_math('leftsame $nm$ rightsame', p, [0, 0, 1, 1])
                self.assertNotEqual(audits[0]['status'], 'confirmed')

    def test_wrapped_prose_hyphen_can_still_support_both_anchors(self):
        source = 're-turn x rightside'
        chars = [glyph(c, i * 5, baseline=30 if i <= source.index('-') else 45) for i, c in enumerate(source)]
        p = page(chars)
        p.width = 150
        visible = 'return x rightside'
        start = visible.index('x')
        found = anchored_native_formula(visible, start, start + 1, TexAtoms('x'), p, [0, 0, 1, 1])
        self.assertEqual([c['glyph_id'] for c in found], [source.index('x')])

    def test_semantic_confirmation_does_not_require_a_single_crop_rectangle(self):
        text = 'prefixβ2=0.98suffix'
        chars = [glyph(c, i * 5, baseline=30) for i, c in enumerate(text[:7])]
        chars.append(glyph('2', 35, baseline=32, size=7))
        chars.extend(glyph(c, i * 5, baseline=45) for i, c in enumerate(text[8:]))
        p = page(chars)
        p.width = 150
        _, audits = restore_inline_math(r'prefix$\beta_2=0.98$suffix', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['status'], 'confirmed')
        self.assertEqual(audits[0]['render_mode'], 'mathml')
        self.assertEqual(audits[0]['native_geometry']['reason'], 'inline_multiline_geometry')
        self.assertFalse(audits[0]['source_crop_required'])

    def test_unconfirmed_semantics_and_unsafe_geometry_do_not_request_crop(self):
        text = 'prefix x suffix'
        chars = [glyph(c, i * 5) for i, c in enumerate(text)]
        chars.append(glyph('B', (text.index(' x ') + 1) * 5 + 1, baseline=46))
        p = page(chars)
        p.width = 150
        _, audits = restore_inline_math(r'prefix $\hat{x}$ suffix', p, [0, 0, 1, 1])
        self.assertNotEqual(audits[0]['status'], 'confirmed')
        self.assertEqual(audits[0]['render_mode'], 'candidate-unresolved')
        self.assertFalse(audits[0]['source_crop_required'])
        self.assertIsNone(audits[0]['fallback_bbox'])


if __name__ == '__main__':
    unittest.main()
