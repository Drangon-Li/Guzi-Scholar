import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bs4 import BeautifulSoup

from services.parser_service.exporter import display_math, export_document, render_math

DEMO_DIR = os.environ.get('GUZI_TEST_DEMO_DIR')
SOURCE = Path(DEMO_DIR).expanduser() / '2.pdf' if DEMO_DIR else None


class EquationLayoutTests(unittest.TestCase):
    def test_verified_number_is_separate_selectable_text(self):
        markup = display_math(r'$$a_t\in\mathcal{A}_{\mathrm{env}}.\tag{2}$$', {'equation_number': {'status': 'confirmed', 'source_number': '2'}})
        soup = BeautifulSoup(markup, 'html.parser')
        self.assertIsNotNone(soup.select_one('.equation-body math'))
        self.assertEqual(soup.select_one('.equation-number').get_text(), '(2)')
        self.assertNotIn('(2)', soup.find('math').get_text())
        self.assertIn(' (2)', soup.get_text())

    def test_unverified_or_multiple_numbers_are_not_silently_rewritten(self):
        tex = r'$$x=1\tag{8}$$'
        self.assertEqual(display_math(tex, {'equation_number': {'status': 'confirmed', 'source_number': '9'}}), render_math(tex, display=True))
        self.assertEqual(display_math(tex, {}), render_math(tex, display=True))
        multiple = r'$$x=1\tag{8}\tag{9}$$'
        self.assertEqual(display_math(multiple, {'equation_number': {'status': 'confirmed', 'source_number': '9'}}), render_math(multiple, display=True))

    def test_renderer_failure_does_not_emit_a_number_without_a_formula(self):
        with patch('services.parser_service.exporter.render_math', return_value=''):
            self.assertEqual(display_math(r'$$x\tag{2}$$', {'equation_number': {'status': 'confirmed', 'source_number': '2'}}), '')


class SourceMathResolutionTests(unittest.TestCase):
    def test_unverified_candidate_can_render_without_claiming_confirmation(self):
        from reportlab.pdfgen.canvas import Canvas
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canvas = Canvas(str(root / 'source.pdf'), pagesize=(400, 400))
            canvas.drawString(20, 380, 'Native evidence does not uniquely align this candidate.')
            canvas.save()
            content = 'Candidate $x^{N}$ only.'
            fusion = root / 'fusion';fusion.mkdir()
            (fusion / 'document.json').write_text(json.dumps({'pages': [{'blocks': [{'label': 'text', 'content': content, 'source_bbox_normalized': [.05, .03, .95, .1], 'math_audit': {'inline': [{'start': 10, 'end': 17, 'candidate_content': '$x^{N}$', 'selectable_text': 'x^(N)', 'render_mode': 'candidate-unresolved', 'status': 'unresolved', 'reason': 'inline_multiline_geometry'}]}}]}]}))
            export_document(root / 'source.pdf', fusion, root / 'output')
            element = json.loads((root / 'output/document.json').read_text())['pages'][0]['elements'][0]
            soup = BeautifulSoup(element['html'], 'html.parser')
            candidate = soup.select_one('.math-candidate-unresolved')
            self.assertIsNotNone(candidate.select_one('math msup'))
            self.assertEqual(candidate['data-math-status'], 'unresolved')
            self.assertIn('待核', candidate['title'])
            self.assertEqual(element['math_audit']['status'], 'unresolved')
            self.assertEqual(element['math_audit']['inline'][0]['reason'], 'inline_multiline_geometry')
            self.assertEqual(element['math_audit']['inline'][0]['candidate_rendering'], 'mathml-unverified')
            self.assertNotIn('^(N)', element['text'])

    @unittest.skipUnless(SOURCE is not None and SOURCE.is_file(), 'GUZI_TEST_DEMO_DIR/2.pdf fixture unavailable')
    def test_algorithm_export_keeps_source_lines_selectable_and_crops_only_complex_math(self):
        from pypdf import PdfReader, PdfWriter
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.pdf'
            writer = PdfWriter()
            writer.add_page(PdfReader(SOURCE).pages[15])
            writer.write(source)
            fusion = root / 'fusion'
            fusion.mkdir()
            (fusion / 'document.json').write_text(json.dumps({'pages': [{'blocks': [{'label': 'text', 'native_label': 'algorithm', 'content': 'Incomplete OCR $D_{out}', 'source_bbox_normalized': [.112, .36, .887, .695]}]}]}))
            export_document(source, fusion, root / 'output')
            element = json.loads((root / 'output/document.json').read_text())['pages'][0]['elements'][0]
            self.assertEqual(element['render_mode'], 'native-algorithm')
            soup = BeautifulSoup(element['html'], 'html.parser')
            self.assertEqual([int(line['data-line-number']) for line in soup.select('.algorithm-line')], list(range(1, 16)))
            self.assertEqual(len(soup.select('.math-source-inline')), 2)
            for image in soup.select('.math-source-inline'):
                self.assertGreater(float(image['data-height-em']), 0)
                self.assertLessEqual(abs(float(image['data-baseline-offset-em'])), 3.6)
            self.assertIn('candidate papers 𝒟, set of previous papers', element['text'])
            self.assertIn('\n', element['text'])
            self.assertNotIn('Incomplete OCR', element['text'])
            self.assertEqual(element['text'].count('[公式原图]'), 2)
            for item in element['math_audit']['local_crops']:
                self.assertGreaterEqual(item['asset_provenance']['render_dpi'], 288)
                self.assertTrue((root / 'output' / item['source_asset']).is_file())
            self.assertEqual(element['math_audit']['status'], 'unresolved')

    def test_display_and_inline_fallbacks_share_high_resolution_without_expanding_regions(self):
        from PIL import Image
        from reportlab.pdfgen.canvas import Canvas
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.pdf'
            canvas = Canvas(str(source), pagesize=(400, 400))
            canvas.setFont('Helvetica', 9)
            canvas.drawString(40, 340, 'x + y')
            canvas.drawString(40, 280, 'x + y')
            canvas.save()
            formula_box = [.09, .125, .22, .165]
            inline_box = [.09, .275, .22, .315]
            content = 'Before $x$ after'
            fusion = root / 'fusion'
            fusion.mkdir()
            (fusion / 'document.json').write_text(json.dumps({'pages': [{'blocks': [
                {'label': 'formula', 'content': r'$$\unknown{x}$$', 'source_bbox_normalized': formula_box, 'math_audit': {'source_crop_required': True, 'fallback_bbox': formula_box}},
                {'label': 'text', 'content': content, 'source_bbox_normalized': [.05, .25, .9, .35], 'math_audit': {'inline': [{'start': 7, 'end': 10, 'candidate_content': '$x$', 'render_mode': 'source-crop', 'source_crop_required': True, 'fallback_bbox': inline_box, 'height_em': 1.1, 'baseline_offset_em': .2}]}}
            ]}]}))
            export_document(source, fusion, root / 'output')
            first, second = json.loads((root / 'output/document.json').read_text())['pages'][0]['elements']
            inline = second['math_audit']['inline'][0]
            self.assertIn('style="width:104px"', first['html'])
            for item, bbox, asset in [(first, formula_box, first['visual_asset']), (inline, inline_box, inline['source_asset'])]:
                provenance = item['asset_provenance']
                self.assertGreaterEqual(provenance['render_dpi'], 288)
                self.assertEqual(provenance['source_bbox'], bbox)
                with Image.open(root / 'output' / asset) as image:
                    self.assertEqual(list(image.size), provenance['intrinsic_pixels'])
                    self.assertGreaterEqual(image.height, 64)
                    self.assertTrue(any(image.convert('L').histogram()[1:255]))
            self.assertIn('Before ', second['text'])
            self.assertIn(' after', second['text'])
            self.assertIn('height:1.1em;vertical-align:-0.2em', second['html'])


if __name__ == '__main__':
    unittest.main()
