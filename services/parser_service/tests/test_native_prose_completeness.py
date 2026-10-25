import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from services.parser_service.fusion import fuse, restore_inline_math, restore_native_prose, visible_math
from services.parser_service.tests.test_native_pdf import glyph, page


class NativeProseCompletenessTest(unittest.TestCase):
    def native(self, text):
        p = page([glyph(c, i * 5) for i, c in enumerate(text)])
        p.width = max(100, len(text) * 5 + 10)
        return p

    def test_source_omission_cannot_confirm_complete_style_evidence(self):
        p = self.native('Let xi be input')
        _, evidence = p.style_spans('Let x be input', [0, 0, 1, 1])
        self.assertEqual(evidence['alignment_coverage'], 1)
        self.assertLess(evidence['source_coverage'], 1)
        self.assertEqual(evidence['unmatched_source_text'], 'i')
        self.assertFalse(evidence['source_content_complete'])
        self.assertEqual(evidence['status'], 'unresolved')

    def test_missing_same_matrix_baseline_script_uses_actual_font_box(self):
        p = self.native('Let xi be input')
        i = p.chars[5]
        i.update(size=8, x0=24.8, x1=26.6, top=48.7, bottom=56.7)
        fixed, edits = restore_native_prose('Let x be input', p, [0, 0, 1, 1])
        self.assertEqual(fixed, 'Let x$_{i}$ be input')
        self.assertEqual(edits[0]['reason'], 'native_anchored_omitted_script')
        self.assertEqual(i['baseline'], p.chars[4]['baseline'])
        _, audits = restore_inline_math(fixed, p, [0, 0, 1, 1])
        self.assertEqual(audits[0]['status'], 'confirmed')
        self.assertEqual(audits[0]['render_mode'], 'native-script')
        self.assertEqual(audits[0]['selectable_text'], 'i')
        self.assertEqual(audits[0]['script_kind'], 'sub')
        self.assertTrue(p.align(visible_math(fixed)[0], [0, 0, 1, 1])[1]['source_content_complete'])

    def test_small_body_glyph_is_not_recovered_as_script(self):
        p = self.native('Let xi be input')
        p.chars[5].update(size=8, x0=24.8, x1=26.6, top=43.6, bottom=51.6)
        candidate = 'Let x be input'
        self.assertEqual(restore_native_prose(candidate, p, [0, 0, 1, 1]), (candidate, []))
        self.assertFalse(p.align(candidate, [0, 0, 1, 1])[1]['source_content_complete'])

    def test_source_punctuation_spaces_and_decimal_are_restored(self):
        source = 'Time is 2.35 seconds. A parser works. Bars score 98.52%, compared.'
        candidate = 'Time is 2.35 seconds.A parser works.Bars score 98. 52% ,compared.'
        fixed, edits = restore_native_prose(candidate, self.native(source), [0, 0, 1, 1])
        self.assertEqual(fixed, source)
        self.assertTrue(all(e['reason'] == 'native_prose_punctuation_spacing' for e in edits))

    def test_math_whitespace_and_reference_boundaries_are_preserved(self):
        p = self.native('Use x. y then [1, 2].')
        candidate = 'Use $x. y$ then [1, 2].'
        self.assertEqual(restore_native_prose(candidate, p, [0, 0, 1, 1])[0], candidate)

    def test_missing_body_letter_stays_unresolved_without_inventing_script(self):
        p = self.native('Read the source.')
        candidate = 'Read th source.'
        self.assertEqual(restore_native_prose(candidate, p, [0, 0, 1, 1]), (candidate, []))
        self.assertEqual(p.align(candidate, [0, 0, 1, 1])[1]['unmatched_source_text'], 'e')

    def test_fusion_flags_unrecoverable_native_body_letter_omission(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            writer = PdfWriter()
            source = writer.add_blank_page(width=200, height=100)
            font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
            source[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
            stream = DecodedStreamObject()
            stream.set_data(b'BT /F1 10 Tf 10 50 Td (Read the source.) Tj ET')
            source[NameObject('/Contents')] = writer._add_object(stream)
            writer.write(root / 'source.pdf')
            (root / 'glm.json').write_text(json.dumps([[{'label': 'text', 'content': 'Read th source.', 'bbox_2d': [0, 0, 1000, 1000]}]]))
            (root / 'mineru.json').write_text(json.dumps({'pages': [{'page_idx': 0, 'blocks': []}]}))
            fuse(SimpleNamespace(pdf=root / 'source.pdf', glm_json=root / 'glm.json', mineru_json=root / 'mineru.json', glm_assets=root, mineru_assets=root, output=root / 'output'))
            block = json.loads((root / 'output/document.json').read_text())['pages'][0]['blocks'][0]
            self.assertEqual(block['content'], 'Read th source.')
            self.assertIn('native_prose_source_content_incomplete', block['review_flags'])
            self.assertEqual(block['native_evidence']['status'], 'unresolved')
            self.assertEqual(block['native_evidence']['unmatched_source_text'], 'e')
            from services.parser_service.exporter import export_document
            export_document(root / 'source.pdf', root / 'output', root / 'export')
            validation = json.loads((root / 'export/validation.json').read_text())
            self.assertEqual(validation['status'], 'REVIEW')
            self.assertTrue(validation['warnings'])


if __name__ == '__main__':
    unittest.main()
