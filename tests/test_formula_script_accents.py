import json
from pathlib import Path
import unittest

from services.parser_service.fusion import bbox, restore_inline_math, restore_native_prose, visible_math
from services.parser_service.math_evidence import TexAtoms, assess_formula, native_atoms
from services.parser_service.native_pdf import NativePDF
from services.parser_service.tests.test_native_pdf import glyph, page


ROOT = Path(__file__).resolve().parents[1]
ACADEMIC = ROOT / 'data/deployment/quality-fix-20261025/raw/a0dd054f701b47158edfe9caf9eb5a06'


def shifted_glyph(text, x, shift, size=11):
    char = glyph(text, x, size=size)
    char['top'] += shift
    char['bottom'] += shift
    return char


class FormulaScriptAccentTest(unittest.TestCase):
    def test_inline_accent_projection_preserves_source_completeness(self):
        content = r'Target $\hat{y}$ value.'
        native_text = 'Target ŷ value.'
        visible, _ = visible_math(content)
        self.assertEqual(visible, native_text)
        for source in ['precomposed', 'combined-glyph', 'separate-glyphs']:
            with self.subTest(source=source):
                chars = [glyph(c, 3 + i * 5) for i, c in enumerate(native_text)]
                if source == 'combined-glyph':
                    chars[7]['text'] = 'y\u0302'
                elif source == 'separate-glyphs':
                    chars[7]['text'] = 'y'
                    chars.insert(8, shifted_glyph('\u0302', 38, -3, size=7))
                p = page(chars)
                mapped, evidence = p.align(visible, [0, 0, 1, 1])
                self.assertTrue(evidence['source_content_complete'])
                self.assertEqual(evidence['alignment_coverage'], 1)
                self.assertEqual(evidence['source_coverage'], 1)
                self.assertEqual({char['glyph_id'] for char in mapped[7]}, {7, 8} if source == 'separate-glyphs' else {7})
                self.assertEqual(restore_native_prose(content, p, [0, 0, 1, 1]), (content, []))
                _, audits = restore_inline_math(content, p, [0, 0, 1, 1])
                self.assertEqual(audits[0]['status'], 'confirmed')
                _, missing = restore_inline_math('Target $y$ value.', p, [0, 0, 1, 1])
                self.assertNotEqual(missing[0]['status'], 'confirmed')
                self.assertFalse(p.align('Target y value.', [0, 0, 1, 1])[1]['source_content_complete'])

    def test_inline_hat_without_source_accent_stays_unresolved(self):
        p = page([glyph(c, 3 + i * 5) for i, c in enumerate('Target y value.')])
        content = r'Target $\hat{y}$ value.'
        _, audits = restore_inline_math(content, p, [0, 0, 1, 1])
        self.assertNotEqual(audits[0]['status'], 'confirmed')
        self.assertLess(p.align(visible_math(content)[0], [0, 0, 1, 1])[1]['alignment_coverage'], 1)

    def test_same_matrix_baseline_scripts_use_font_boxes(self):
        chars = [glyph('Σ', 0, size=13)]
        chars += [shifted_glyph(c, 5 + i * 5, 6.5) for i, c in enumerate('i=1')]
        chars += [shifted_glyph('N', 20, -6.5), glyph('(', 25, size=13), glyph('y', 30, size=13), shifted_glyph('i', 35, 6.5), glyph('-', 40, size=13), glyph('ŷ', 45, size=13), shifted_glyph('i', 50, 6.5), glyph(')', 55, size=13), shifted_glyph('2', 60, -6.5)]
        p = page(chars)
        formula = r'\Sigma_{i=1}^{N}(y_i-\hat{y}_i)^2'
        fixed, audit = assess_formula(formula, None, p, [0, 0, 1, 1])
        self.assertEqual(fixed, formula)
        self.assertEqual(audit['status'], 'confirmed')
        self.assertEqual(len(audit['native_evidence']['script_bbox_evidence']), 7)
        self.assertEqual(audit['native_evidence']['accent_evidence'][0]['source_unicode'], 'ŷ')
        self.assertEqual({c['baseline'] for c in p.chars}, {50})

    def test_precomposed_and_combining_unicode_accents_agree(self):
        for source in ['ŷ', 'y\u0302']:
            for candidate in [r'\hat{y}', 'ŷ', 'y\u0302']:
                with self.subTest(source=source, candidate=candidate):
                    p = page([glyph(source, 10)])
                    fixed, audit = assess_formula(candidate, None, p, [0, 0, 1, 1])
                    self.assertEqual(fixed, candidate)
                    self.assertEqual(audit['status'], 'confirmed')

    def test_separate_combining_mark_needs_attachment_geometry(self):
        mark = shifted_glyph('\u0302', 10, -3, size=7)
        p = page([glyph('y', 10), mark])
        _, audit = assess_formula(r'\hat{y}', None, p, [0, 0, 1, 1])
        self.assertEqual(audit['status'], 'confirmed')
        self.assertEqual(audit['native_evidence']['accent_evidence'][0]['source_glyph_ids'], [0, 1])
        p = page([glyph('y', 10), shifted_glyph('\u0302', 25, -3, size=7)])
        self.assertNotEqual(assess_formula(r'\hat{y}', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_missing_wrong_or_double_accent_is_not_confirmed(self):
        for source, candidate in [('y', r'\hat{y}'), ('ŷ', 'y'), ('ȳ', r'\hat{y}'), ('ŷ', r'\hat{ŷ}'), ('ŷ', r'\hat{\hat{y}}')]:
            with self.subTest(source=source, candidate=candidate):
                p = page([glyph(source, 10)])
                fixed, audit = assess_formula(candidate, None, p, [0, 0, 1, 1])
                self.assertNotEqual(audit['status'], 'confirmed')
                self.assertEqual(fixed, candidate)

    def test_unsupported_and_multi_atom_accent_macros_stay_unresolved(self):
        for source, candidate in [('x', r'\widetilde{x}'), ('ŷ', r'\bar{y}'), ('ŷy', r'\hat{ŷy}')]:
            p = page([glyph(c, 10 + i * 5) for i, c in enumerate(source)])
            _, audit = assess_formula(candidate, None, p, [0, 0, 1, 1])
            self.assertNotEqual(audit['status'], 'confirmed')

    def test_baseline_small_text_is_not_promoted_to_script(self):
        p = page([glyph('x', 10, size=13), glyph('i', 15, size=11)])
        self.assertEqual(native_atoms(p, [0, 0, 1, 1])[0][1]['script'], None)
        self.assertEqual(assess_formula('xi', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        for formula in ['x_i', 'x^i']:
            self.assertNotEqual(assess_formula(formula, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_wrong_or_nested_script_relation_is_not_confirmed(self):
        p = page([glyph('x', 10, size=13), shifted_glyph('i', 15, 6.5)])
        self.assertEqual(assess_formula('x_i', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        self.assertNotEqual(assess_formula('x^i', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        self.assertNotEqual(assess_formula('x_{^{i}}', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    @unittest.skipUnless((ACADEMIC / 'source.pdf').is_file(), 'downloaded academic replay fixture unavailable')
    def test_real_academic_display_and_inline_are_selectable(self):
        blocks = json.loads((ACADEMIC / 'glm/output/source/source.json').read_text())[0]
        with NativePDF(ACADEMIC / 'source.pdf') as native:
            p = native.page(0)
            display = next(b for b in blocks if b['label'] == 'formula')
            fixed, audit = assess_formula(display['content'], None, p, bbox(display, True))
            self.assertEqual(audit['status'], 'confirmed')
            self.assertFalse(audit['source_crop_required'])
            self.assertNotIn(r'\hat {ŷ}', fixed)
            inline = next(b for b in blocks if 'E=' in b.get('content', ''))
            _, audits = restore_inline_math(inline['content'], p, bbox(inline, True))
            self.assertEqual(audits[0]['status'], 'confirmed')
            self.assertEqual(audits[0]['render_mode'], 'mathml')
            self.assertFalse(audits[0]['source_crop_required'])


if __name__ == '__main__':
    unittest.main()
