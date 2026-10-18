import copy
import json
import math
import os
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageChops, ImageDraw
from reportlab.pdfgen import canvas

from services.parser_service.exporter import bounded_visual_dpi, export_document, stable_id

DEMO_DIR = os.environ.get('GUZI_TEST_DEMO_DIR')
SOURCE = Path(DEMO_DIR).expanduser() / '1.pdf' if DEMO_DIR else None


class VisualResolutionV9Tests(unittest.TestCase):
    def export(self, root, blocks, suffix='output'):
        fusion = root / ('fusion-' + suffix)
        fusion.mkdir()
        Image.new('RGB', (20, 10), 'red').save(fusion / 'old.png')
        (fusion / 'document.json').write_text(json.dumps({'schema': 'test', 'pages': [{'blocks': blocks}]}))
        output = root / suffix
        export_document(root / 'source.pdf', fusion, output)
        document = json.loads((output / 'document.json').read_text())
        return output, document['pages'][0]['blocks']

    def vector_pdf(self, root):
        pdf = canvas.Canvas(str(root / 'source.pdf'), pagesize=(500, 500))
        pdf.setFont('Helvetica', 9)
        pdf.drawString(110, 384, 'Tool Use Rate by Model')
        pdf.rect(100, 210, 300, 165)
        for i in range(5):
            pdf.drawString(110, 350 - i * 25, 'Model %d       0.78     0.90     0.59' % i)
        pdf.drawString(110, 200, 'Image inspect     Visual retrieve     KB search')
        pdf.drawString(50, 415, 'An unrelated body paragraph must stay outside.')
        pdf.drawString(50, 175, 'Figure 6. Caption remains ordinary text.')
        pdf.save()

    def blocks(self, label='image', **extra):
        return [{'label': 'text', 'content': 'An unrelated body paragraph must stay outside.', 'source_bbox_normalized': [.1, .14, .9, .18]},
                {'label': label, 'content': '<table><tr><td>0.78</td></tr></table>' if label == 'table' else '', 'source_bbox_normalized': [.2, .23, .8, .60], 'image_path': 'old.png', **extra},
                {'label': 'text', 'content': 'Figure 6. Caption remains ordinary text.', 'source_bbox_normalized': [.1, .63, .9, .66]}]

    def assert_high_resolution(self, output, record):
        provenance = record['asset_provenance']
        self.assertEqual(provenance['kind'], 'pdf-render')
        self.assertGreaterEqual(provenance['render_dpi'], 288)
        self.assertLessEqual(max(provenance['intrinsic_pixels']), 6144)
        self.assertLessEqual(math.prod(provenance['intrinsic_pixels']), 24_000_000)
        with Image.open(output / record['visual_asset']) as image:
            self.assertEqual(list(image.size), provenance['intrinsic_pixels'])
            self.assertGreater(image.width, provenance['display_width_css_pixels'] * 1.9)
        self.assertIn('style="width:%dpx"' % provenance['display_width_css_pixels'], record['html'])

    def test_single_vector_figure_ignores_low_quality_fusion_crop_and_restores_source_edges(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.vector_pdf(root)
            blocks = self.blocks()
            original = copy.deepcopy(blocks)
            output, records = self.export(root, blocks)
            figure = records[1]
            self.assert_high_resolution(output, figure)
            self.assertLess(figure['render_bbox'][1], .218)
            self.assertGreater(figure['render_bbox'][1], .18)
            self.assertLess(figure['render_bbox'][3], .63)
            self.assertEqual(figure['source_block_bbox'], original[1]['source_bbox_normalized'])
            self.assertEqual(blocks, original)
            self.assertIn('An unrelated body paragraph', records[0]['text'])
            self.assertIn('Caption remains ordinary text', records[2]['text'])
            self.assertEqual(figure['block_id'], stable_id(json.loads((output / 'document.json').read_text())['source_sha256'], 1, original[1]['source_bbox_normalized'], 'image'))

    def test_all_table_source_variants_use_high_resolution_and_proven_boundaries(self):
        variants = [{}, {'math_audit': {'source_block_required': True}}, {'native_evidence': {'status': 'unsupported'}}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.vector_pdf(root)
            for index, extra in enumerate(variants):
                with self.subTest(extra=extra):
                    output, records = self.export(root, self.blocks('table', **extra), 'table-%d' % index)
                    self.assert_high_resolution(output, records[1])
                    self.assertLess(records[1]['render_bbox'][1], .218)
                    self.assertLess(records[1]['render_bbox'][3], .63)
                    if index:
                        self.assertIn('table-source-primary', records[1]['html'])
                    else:
                        self.assertIn('<details', records[1]['html'])

    def test_single_embedded_figure_preserves_original_pixels_without_css_enlargement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = Image.new('RGB', (1200, 600), 'white')
            ImageDraw.Draw(source).line((0, 0, 1199, 599), fill='black', width=3)
            source.save(root / 'embedded.png')
            pdf = canvas.Canvas(str(root / 'source.pdf'), pagesize=(500, 500))
            pdf.drawImage(str(root / 'embedded.png'), 100, 250, width=300, height=150)
            pdf.save()
            output, records = self.export(root, [{'label': 'image', 'content': '', 'image_path': 'old.png', 'source_bbox_normalized': [.2, .2, .8, .5]}])
            record = records[0]
            self.assertEqual(record['asset_provenance']['kind'], 'pdf-embedded-image')
            self.assertEqual(record['asset_provenance']['display_width_css_pixels'], 600)
            with Image.open(output / record['visual_asset']) as image:
                self.assertEqual(image.size, source.size)
                self.assertIsNone(ImageChops.difference(source, image.convert('RGB')).getbbox())

    def test_high_resolution_budget_accounts_for_raster_rounding(self):
        for width, height in [(500, 500), (2000, 2000), (10000, 300), (612.3, 792.7)]:
            with self.subTest(width=width, height=height):
                dpi = bounded_visual_dpi(width, height, 384)
                pixels = [math.ceil(width * dpi / 72), math.ceil(height * dpi / 72)]
                self.assertLessEqual(max(pixels), 6144)
                self.assertLessEqual(math.prod(pixels), 24_000_000)

    @unittest.skipUnless(SOURCE is not None and SOURCE.is_file(), 'GUZI_TEST_DEMO_DIR/1.pdf fixture unavailable')
    def test_original_agrigym_heatmap_recovers_title_without_figure_caption(self):
        from pypdf import PdfReader, PdfWriter
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            writer = PdfWriter()
            writer.add_page(PdfReader(SOURCE).pages[7])
            writer.write(root / 'source.pdf')
            blocks = [{'label': 'table', 'content': '<table><tr><td>0.78</td></tr></table>', 'source_bbox_normalized': [.517, .09, .88, .223], 'math_audit': {'source_block_required': True}},
                      {'label': 'text', 'content': 'Figure 6: Tool-use profile across VLM agents.', 'source_bbox_normalized': [.508, .234, .885, .306]}]
            output, records = self.export(root, blocks)
            heatmap = records[0]
            self.assert_high_resolution(output, heatmap)
            self.assertLess(heatmap['render_bbox'][1], .084)
            self.assertGreater(heatmap['render_bbox'][1], .08)
            self.assertLess(heatmap['render_bbox'][3], .234)
            self.assertGreater(heatmap['asset_provenance']['intrinsic_pixels'][0], 850)
            self.assertGreater(heatmap['asset_provenance']['intrinsic_pixels'][1], 450)


if __name__ == '__main__':
    unittest.main()
