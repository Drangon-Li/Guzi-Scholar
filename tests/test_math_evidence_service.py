import json
import os
from pathlib import Path
import tempfile
import unittest

from services.parser_service.fusion import equation_number_region, restore_inline_math, restore_native_prose
from services.parser_service.math_evidence import assess_formula, reconcile_equation_number, selectable_script_segments
from services.parser_service.native_pdf import NativePDF, canonical, font_metadata
from services.parser_service.tests.test_native_pdf import glyph, line, page


class MathEvidenceRegressionTest(unittest.TestCase):
    def test_middle_dot_equivalence_is_math_only_and_not_a_bullet(self):
        p = page([glyph('x', 10), glyph('·', 15), glyph('y', 20)])
        self.assertEqual(assess_formula(r'x\cdot y', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        for wrong in [r'x\bullet y', r'x\times y']:
            self.assertNotEqual(assess_formula(wrong, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        self.assertEqual(canonical('·'), '·')

    def test_symbol_subscript_cannot_match_native_superscript(self):
        p = page([glyph('y', 10), glyph('⋆', 15, baseline=46, size=7)])
        good = assess_formula(r'y^{\star}', None, p, [0, 0, 1, 1])[1]
        wrong = assess_formula(r'y_{\star}', None, p, [0, 0, 1, 1])[1]
        self.assertEqual(good['status'], 'confirmed')
        self.assertNotEqual(wrong['status'], 'confirmed')
        self.assertTrue(wrong['candidates'][0]['script_errors'])
        segments = selectable_script_segments(r'y^{\star}', p, [0, 0, 1, 1], [0, 1])
        self.assertEqual([(s['text'], s.get('script_kind')) for s in segments], [('y', None), ('⋆', 'sup')])
        self.assertIsNone(selectable_script_segments(r'y_{\star}', p, [0, 0, 1, 1], [0, 1]))

    def test_fraction_uses_vector_rule_order_and_validates_its_internal_scripts(self):
        p = page([glyph('E', 5), glyph('=', 10), glyph('m', 25, baseline=44, size=7), glyph('v', 30, baseline=44, size=7), glyph('2', 28, baseline=56, size=7), glyph('2', 35, baseline=40, size=5)], [line(24, 41, 48.5)])
        self.assertEqual(assess_formula(r'E=\frac{mv^2}{2}', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        for wrong in [r'E=\frac{mv_2}{2}', r'E=\frac{2}{mv^2}']:
            self.assertNotEqual(assess_formula(wrong, None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_fraction_chunks_follow_geometry_instead_of_pdf_paint_order(self):
        p = page([glyph('d', 62, baseline=56, size=7), glyph('-', 36), glyph('b', 12, baseline=56, size=7), glyph('a', 12, baseline=44, size=7), glyph('c', 62, baseline=44, size=7)], [line(10, 20, 48.5), line(60, 70, 48.5)])
        good = assess_formula(r'\frac{a}{b}-\frac{c}{d}', None, p, [0, 0, 1, 1])[1]
        bad = assess_formula(r'\frac{c}{d}-\frac{a}{b}', None, p, [0, 0, 1, 1])[1]
        self.assertEqual(good['status'], 'confirmed')
        self.assertNotEqual(bad['status'], 'confirmed')

    def test_uniform_native_script_recovers_missing_markup_but_not_wrong_explicit_script(self):
        p = page([glyph('A', 0), glyph('o', 5, baseline=52, size=7), glyph('x', 10, baseline=52, size=7), glyph('B', 15)])
        _, audits = restore_inline_math(r'A $\mathrm{O x}$ B', p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['render_mode'], 'native-script')
        self.assertEqual(audits[0]['script_kind'], 'sub')
        self.assertEqual(audits[0]['selectable_text'], 'ox')
        _, wrong = restore_inline_math(r'A $^{ox}$ B', p, [0, 0, 1, 1])
        self.assertNotEqual(wrong[0]['status'], 'confirmed')

    def test_punctuation_recovery_requires_anchors_and_body_geometry(self):
        text = 'alpha ystar, next'
        p = page([glyph(c, i * 4) for i, c in enumerate(text)])
        fixed, edits = restore_native_prose('alpha ystar next', p, [0, 0, 1, 1])
        self.assertEqual(fixed, text)
        self.assertEqual(edits[0]['reason'], 'native_anchored_prose_punctuation')
        raised = page([glyph(c, i * 4, baseline=30 if c == ',' else 50) for i, c in enumerate(text)])
        self.assertEqual(restore_native_prose('alpha ystar next', raised, [0, 0, 1, 1])[0], 'alpha ystar next')
        self.assertEqual(restore_native_prose('abc', page([glyph(c, i * 4) for i, c in enumerate('a,bc')]), [0, 0, 1, 1])[0], 'abc')

    def test_degree_sign_has_intrinsic_upper_position_but_plain_circle_does_not(self):
        p = page([glyph('4', 0), glyph('2', 5), glyph('°', 10), glyph('C', 15)])
        self.assertEqual(assess_formula(r'42^{\circ}C', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        self.assertNotEqual(assess_formula(r'42_{\circ}C', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')
        p = page([glyph('x', 0), glyph('∘', 5)])
        self.assertNotEqual(assess_formula(r'x^{\circ}', None, p, [0, 0, 1, 1])[1]['status'], 'confirmed')

    def test_two_local_anchors_recover_formula_despite_reordered_header(self):
        body, header = 'bufferat40◦C.Soluble', 'HEADER' * 8
        chars = [glyph(c, i * 5) for i, c in enumerate(body)]
        chars[10] = glyph('◦', 50, baseline=46, size=7)
        chars += [glyph(c, i * 5, baseline=15, size=8) for i, c in enumerate(header)]
        p = page(chars)
        p.width = 500
        content = header + r' bufferat$40^{\circ}\mathrm{C}$.Soluble'
        _, audits = restore_inline_math(content, p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['status'], 'confirmed')
        self.assertEqual(audits[0]['alignment_basis'], 'unique-native-formula-with-two-prose-anchors')
        _, rejected = restore_inline_math(content.replace('bufferat', 'buffeZat'), p, [0, 0, 1, 1])
        self.assertNotEqual(rejected[0]['status'], 'confirmed')

    def test_ring_and_A_compose_only_with_matching_overprint_geometry(self):
        p = page([glyph('˚', 10, baseline=48.2), glyph('A', 10)])
        self.assertEqual(p.chars[1]['resolved_text'], 'Å')
        self.assertEqual(p.chars[1]['glyph_composition']['source_glyph_ids'], [0, 1])
        self.assertEqual(p.evidence(p.chars)['unknown_glyphs'], 0)
        for ring in [glyph('˚', 0, baseline=48.2), glyph('˚', 10, baseline=40), glyph('˚', 10, baseline=48.2, font='Different')]:
            p = page([ring, glyph('A', 10)])
            self.assertEqual(p.chars[1]['resolved_text'], 'A')

    def test_isolated_math_alphabet_does_not_restyle_a_word(self):
        chars = [glyph(c, i * 4, font='ABCDEF+CMSY10' if c == 'I' else 'Regular') for i, c in enumerate('images I,')]
        fixed, edits = restore_native_prose('images I,', page(chars), [0, 0, 1, 1])
        self.assertEqual(fixed, r'images $\mathcal{I}$,')
        self.assertEqual(edits[0]['source_glyph_ids'], [7])
        chars = [glyph(c, i * 4, font='ABCDEF+CMSY10') for i, c in enumerate('TIME')]
        self.assertEqual(restore_native_prose('TIME', page(chars), [0, 0, 1, 1])[0], 'TIME')

    def test_number_search_does_not_union_a_merged_ocr_formula(self):
        p = page([glyph('x', 20, baseline=30), glyph('(', 80, baseline=30), glyph('1', 85, baseline=30), glyph(')', 90, baseline=30), glyph('y', 20, baseline=70), glyph('(', 80, baseline=70), glyph('2', 85, baseline=70), glyph(')', 90, baseline=70)])
        regions = [[.1, .2, .6, .35], [.1, .6, .6, .75]]
        for index, region in enumerate(regions):
            search = equation_number_region(p, region, [.1, .2, .96, .8], [regions[1 - index]])
            _, audit = reconcile_equation_number('x', p, search)
            self.assertEqual(audit['status'], 'confirmed')
            self.assertEqual(audit['source_number'], str(index + 1))
            self.assertLess(search[3] - search[1], .5)
        p = page([glyph('f', 0), glyph('(', 15), glyph('1', 20), glyph(')', 25), glyph('+', 40), glyph('x', 45)])
        self.assertEqual(reconcile_equation_number('f(1)+x', p, [0, 0, 1, 1])[1]['status'], 'absent')

    def test_tight_ink_evidence_resolves_font_box_overlap_but_rejects_real_overlap(self):
        chars = [glyph('A', 0), glyph('x', 10), glyph('B', 12, baseline=44)]
        p = page(chars)
        self.assertEqual(p.inline_geometry([1], [0, 0, 1, 1])['reason'], 'inline_foreign_glyph_overlap')
        p._tight_boxes = {1: [10, 46, 15, 51], 2: [12, 37, 17, 41]}
        geometry = p.inline_geometry([1], [0, 0, 1, 1])
        self.assertEqual(geometry['status'], 'confirmed')
        self.assertEqual(geometry['ink_geometry_source'], 'pdfium-tight-glyph-boxes')
        p._tight_boxes[2] = [12, 47, 17, 50]
        self.assertEqual(p.inline_geometry([1], [0, 0, 1, 1])['reason'], 'inline_foreign_glyph_overlap')

    def test_explicit_encoding_restores_a_bad_to_unicode_mapping(self):
        from pypdf import PdfWriter
        from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject
        info = font_metadata({'/BaseFont': '/Symbol', '/Encoding': {'/Differences': [97, '/rho']}})
        self.assertEqual(info['encoding'][97]['unicode'], 'ρ')
        writer = PdfWriter()
        pdfpage = writer.add_blank_page(width=200, height=200)
        cmap = DecodedStreamObject()
        cmap.set_data(b'/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Bad def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <61> <00C4> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end')
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Symbol'), NameObject('/Encoding'): DictionaryObject({NameObject('/Differences'): ArrayObject([NumberObject(97), NameObject('/rho')])}), NameObject('/ToUnicode'): writer._add_object(cmap)})
        pdfpage[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 20 100 Td <61> Tj ET')
        pdfpage[NameObject('/Contents')] = writer._add_object(stream)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'encoding.pdf'
            writer.write(path)
            with NativePDF(path) as document:
                char = document.page(0).chars[0]
                self.assertEqual(char['text'], 'Ä')
                self.assertEqual(char['resolved_text'], 'ρ')
                self.assertEqual(char['unicode_source'], 'pdf_encoding_differences')

    def test_same_basefont_resources_do_not_share_encoding_metadata(self):
        from pypdf import PdfWriter
        from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject
        writer = PdfWriter()
        pdfpage = writer.add_blank_page(width=400, height=200)
        resources = DictionaryObject()
        for resource, letter in [('/F1', '/A'), ('/F2', '/B')]:
            font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica'), NameObject('/Encoding'): DictionaryObject({NameObject('/BaseEncoding'): NameObject('/WinAnsiEncoding'), NameObject('/Differences'): ArrayObject([NumberObject(65), NameObject(letter)])})})
            resources[NameObject(resource)] = writer._add_object(font)
        pdfpage[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): resources})
        stream = DecodedStreamObject()
        stream.set_data(b'BT /F1 12 Tf 1 0 0 1 30 150 Tm (A=1) Tj /F2 12 Tf 1 0 0 1 200 100 Tm (A) Tj ET')
        pdfpage[NameObject('/Contents')] = writer._add_object(stream)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'resources.pdf'
            writer.write(path)
            with NativePDF(path) as document:
                p = document.page(0)
                self.assertEqual(''.join(c['resolved_text'] for c in p.chars), 'A=1B')
                self.assertEqual(p.chars[0]['font_evidence']['encoding'][65]['unicode'], 'A')
                self.assertEqual(p.chars[-1]['font_evidence']['encoding'][65]['unicode'], 'B')
                fixed, audit = assess_formula('A=1', None, p, [.05, .15, .25, .3])
                self.assertEqual(fixed, 'A=1')
                self.assertEqual(audit['status'], 'confirmed')


class RealMathFixtureRegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1] / 'apps/desktop/build/pdf-benchmark-20261017/results/figure-grouping-v7/api'
        demo_dir = os.environ.get('GUZI_TEST_DEMO_DIR')
        if not demo_dir:
            raise unittest.SkipTest('GUZI_TEST_DEMO_DIR is not configured')
        demo_dir = Path(demo_dir).expanduser()
        if not all((demo_dir / f'{number}.pdf').is_file() and (cls.root / f'demo{number}/document.json').is_file()
                   for number in (1, 3, 4, 5)):
            raise unittest.SkipTest('GUZI_TEST_DEMO_DIR PDFs or local benchmark exports are not present')
        cls.demo1 = NativePDF(demo_dir / '1.pdf')
        cls.demo4 = NativePDF(demo_dir / '4.pdf')
        cls.demo5 = NativePDF(demo_dir / '5.pdf')
        cls.demo3 = NativePDF(demo_dir / '3.pdf')
        cls.document1 = json.loads((cls.root / 'demo1/document.json').read_text())
        cls.document4 = json.loads((cls.root / 'demo4/document.json').read_text())
        cls.document5 = json.loads((cls.root / 'demo5/document.json').read_text())
        cls.document3 = json.loads((cls.root / 'demo3/document.json').read_text())

    @classmethod
    def tearDownClass(cls):
        cls.demo1.__exit__(None, None, None)
        cls.demo4.__exit__(None, None, None)
        cls.demo5.__exit__(None, None, None)
        cls.demo3.__exit__(None, None, None)

    def test_demo1_first_paragraph_restores_native_punctuation_math_alphabet_and_star(self):
        b = self.document1['pages'][2]['blocks'][6]
        p = self.demo1.page(2)
        fixed, edits = restore_native_prose(b['source_content'], p, b['bbox'])
        self.assertEqual([e['source_glyph_ids'] for e in edits], [[1550], [1601], [1644], [1959]])
        self.assertIn(r'$y^{\star}$,', fixed)
        self.assertIn('response <em>y</em>.', fixed)
        self.assertIn('evaluation. For', fixed)
        _, audits = restore_inline_math(fixed, p, b['bbox'])
        self.assertTrue(all(a['status'] == 'confirmed' for a in audits))
        self.assertEqual(audits[1]['render_mode'], 'mathml')
        self.assertEqual(audits[1]['source_glyph_ids'], [1599, 1600])

    def test_demo1_equation1_dot_and_equation14_number(self):
        b = self.document1['pages'][2]['blocks'][7]
        _, audit = assess_formula(b['math_audit']['candidates'][0]['content'], None, self.demo1.page(2), b['bbox'])
        self.assertEqual(audit['status'], 'confirmed')
        _, audit = reconcile_equation_number(r'x\tag{14}', self.demo1.page(19), [.516, .842, .883, .861])
        self.assertEqual(audit['status'], 'confirmed')
        self.assertEqual(audit['source_number'], '14')

    def test_demo4_formula_numbers_have_separate_vertical_ownership(self):
        p = self.demo4.page(3)
        regions = [[.119, .338, .826, .422], [.141, .444, .824, .477]]
        for i, region in enumerate(regions):
            search = equation_number_region(p, region, [.118, .339, .876, .479], [regions[1 - i]])
            _, audit = reconcile_equation_number('x', p, search)
            self.assertEqual(audit['source_number'], str(i + 1))
            self.assertEqual(audit['status'], 'confirmed')

    def test_demo4_rho_uses_actual_glyph_encoding(self):
        p = self.demo4.page(37)
        for glyph_id in [1566, 1802]:
            char = p.chars[glyph_id]
            self.assertEqual(char['text'], 'Ä')
            self.assertEqual(char['resolved_text'], 'ρ')
            self.assertEqual(char['glyph_decoding']['glyph_name'], 'rho')

    def test_demo4_temperature_and_units_use_tight_ink_evidence(self):
        p = self.demo4.page(46)
        b = next(b for b in self.document4['pages'][46]['blocks'] if b['block_id'] == 'b-60b0d4b6dd7580deefce1cb9')
        _, audits = restore_inline_math(b['source_content'], p, b['bbox'])
        temperatures = [a for a in audits if r'\circ' in a['candidate_content'] or r'\mathrm{m L}' in a['candidate_content']]
        self.assertEqual(len(temperatures), 8)
        for audit in temperatures:
            self.assertEqual(audit['status'], 'confirmed')
            self.assertEqual(audit['render_mode'], 'mathml')
            self.assertEqual(audit['native_geometry']['ink_geometry_source'], 'pdfium-tight-glyph-boxes')

    def test_demo4_isolated_dtt_indices_recover_selectable_subscripts(self):
        p = self.demo4.page(14)
        b = next(b for b in self.document4['pages'][14]['blocks'] if b['block_id'] == 'b-1ce67b8c57bfcaa098afd822')
        _, audits = restore_inline_math(b['source_content'], p, b['bbox'])
        indices = [a for a in audits if a.get('candidate_content') in [r'$\mathrm{O x}$', r'$\mathrm{r e d}$']]
        self.assertEqual(len(indices), 2)
        self.assertEqual([a['selectable_text'] for a in indices], ['ox', 'red'])
        self.assertTrue(all(a['status'] == 'confirmed' and a['render_mode'] == 'native-script' and a['script_kind'] == 'sub' for a in indices))

    def test_demo5_inline_fractions_keep_structural_mathml_and_reject_wrong_powers(self):
        p = self.demo5.page(8)
        for bid in ['b-2b1c0cb8308a0f405e08d811', 'b-3ad02e5e7a97460c503966b0']:
            b = next(b for b in self.document5['pages'][8]['blocks'] if b['block_id'] == bid)
            _, audits = restore_inline_math(b['source_content'], p, b['bbox'])
            audit = next(a for a in audits if r'\frac' in a['candidate_content'])
            self.assertEqual(audit['status'], 'confirmed')
            self.assertEqual(audit['render_mode'], 'mathml')
            self.assertEqual(audit['candidates'][0]['score'], 0)
            wrong = audit['candidate_content'].replace('^{2}', '_{2}')
            _, rejected = assess_formula(wrong, None, p, b['bbox'], glyph_ids=audit['source_glyph_ids'], context_region=b['bbox'])
            self.assertNotEqual(rejected['status'], 'confirmed')

    def test_source_author_markers_and_envelope_keep_selectable_scripts(self):
        for pdf, document, bid in [(self.demo3, self.document3, 'b-4c20680b26ef6e5a37cf9209'), (self.demo4, self.document4, 'b-5d0529dbc5e6b4c23827a180'), (self.demo5, self.document5, 'b-ec385ca4733fb68a2b60c964')]:
            b = next(b for b in document['pages'][0]['blocks'] if b['block_id'] == bid)
            _, audits = restore_inline_math(b['source_content'], pdf.page(0), b['bbox'])
            markers = [a for a in audits if '*' in a.get('candidate_content', '') or '✉' in a.get('candidate_content', '')]
            self.assertTrue(markers)
            self.assertTrue(all(a['status'] == 'confirmed' and a['render_mode'] == 'native-script' for a in markers))
            if pdf is self.demo5:
                self.assertEqual([a['selectable_text'] for a in markers], ['1✉', '1✉'])

    def test_demo4_overprinted_angstrom_and_remaining_temperature_fields(self):
        p = self.demo4.page(29)
        b = next(b for b in self.document4['pages'][29]['blocks'] if b['block_id'] == 'b-e03b2cdccb6790fb715578d5')
        fixed, changes = restore_native_prose(b['source_content'], p, b['bbox'])
        self.assertEqual(fixed.count('Å'), 3)
        self.assertEqual([c['source_glyph_ids'] for c in changes if c['reason'] == 'native_ring_overprint_composition'], [[760, 761], [777, 778], [791, 792]])
        for pn, bid in [(31, 'b-0dfa1673765f2f8e36196e28'), (31, 'b-008c3ebfeb2f7fb5c3be6ece'), (45, 'b-b7c2c78e74fb3fa299030355'), (45, 'b-3992accb84fcabcb6979e678')]:
            b = next(b for b in self.document4['pages'][pn - 1]['blocks'] if b['block_id'] == bid)
            _, audits = restore_inline_math(b['source_content'], self.demo4.page(pn - 1), b['bbox'])
            temperatures = [a for a in audits if r'\circ' in a['candidate_content']]
            self.assertTrue(temperatures)
            self.assertTrue(all(a['status'] == 'confirmed' and a['render_mode'] == 'mathml' for a in temperatures))


class Original64FontResourceRegressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1] / 'apps/desktop/build/pdf-benchmark-20261017/results/figure-grouping-v7/api/original64'
        source = os.environ.get('GUZI_TEST_ORIGINAL_PDF')
        if not source or not Path(source).expanduser().is_file() or not (root / 'document.json').is_file():
            raise unittest.SkipTest('GUZI_TEST_ORIGINAL_PDF or local original64 export fixture is not present')
        cls.pdf = NativePDF(Path(source).expanduser())
        cls.document = json.loads((root / 'document.json').read_text())

    @classmethod
    def tearDownClass(cls):
        cls.pdf.__exit__(None, None, None)

    def test_real_variable_and_math_alphabet_fields_retain_native_alignment(self):
        for pn, bid in [(9, 'b-f3304b230bdcceefbd5a3193'), (10, 'b-c05529367d2171ed9c4ddd93')]:
            b = next(b for b in self.document['pages'][pn - 1]['blocks'] if b['block_id'] == bid)
            _, audits = restore_inline_math(b['source_content'], self.pdf.page(pn - 1), b['bbox'])
            self.assertTrue(audits)
            self.assertTrue(all(a['status'] == 'confirmed' for a in audits))
            self.assertTrue(all(c['lexical_errors'] == 0 for a in audits for c in a.get('candidates', [])))

    def test_original_explicit_script_and_footnote_fields_survive_resource_identity(self):
        from services.parser_service.exporter import revalidate_inline_source
        for pn, bid, expected in [(14, 'b-e8f55203798d2ba68fa52fd7', '(R2).'), (35, 'b-e3df936c981923c2281c2f50', '3'), (35, 'b-4e37f43da44b9ffa8bb2bc18', '6')]:
            b = next(b for b in self.document['pages'][pn - 1]['blocks'] if b['block_id'] == bid)
            p = self.pdf.page(pn - 1)
            _, audits = restore_inline_math(b['source_content'], p, b['bbox'])
            self.assertEqual(len(audits), 1)
            revalidate_inline_source(audits[0], p, b['bbox'])
            self.assertEqual(audits[0]['status'], 'confirmed')
            self.assertEqual(audits[0]['selectable_text'], expected)


if __name__ == '__main__':
    unittest.main()
