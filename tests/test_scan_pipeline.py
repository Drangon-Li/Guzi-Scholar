import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from PIL import Image, ImageDraw
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from services.parser_service.exporter import export_document
from services.parser_service.fusion import fuse


class ScanTablePipelineTests(unittest.TestCase):
    def test_split_secondary_prose_repairs_punctuation_and_retains_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pdf = root / 'scan.pdf'
            document = canvas.Canvas(str(pdf), pagesize=(300, 300))
            document.showPage()
            document.save()
            primary = '样本数量为128 All four checks passed.The report is ready.'
            glm = root / 'glm.json'
            mineru = root / 'mineru.json'
            glm.write_text(json.dumps([[{'label': 'text', 'bbox_2d': [100, 100, 900, 500], 'content': primary}]]))
            mineru.write_text(json.dumps({'pages': [{'page_idx': 0, 'blocks': [
                {'type': 'text', 'bbox': [.1, .1, .9, .25], 'content': '样本数量为 128。'},
                {'type': 'text', 'bbox': [.1, .3, .9, .5], 'content': 'All four checks passed. The report is ready.'},
                {'type': 'text', 'bbox': [.1, .6, .9, .7], 'content': 'Unrelated text.'},
            ]}]}))
            fuse(SimpleNamespace(pdf=pdf, glm_json=glm, mineru_json=mineru, glm_assets=root, mineru_assets=root, output=root / 'fusion'))
            export_document(pdf, root / 'fusion', root / 'output')
            block = json.loads((root / 'output/document.json').read_text())['pages'][0]['blocks'][0]
            self.assertIn('128。', block['text'])
            self.assertIn('passed. The', block['text'])
            self.assertNotIn('Unrelated', block['text'])
            self.assertEqual(block['ocr_prose_evidence']['mineru_block_indices'], [0, 1])
            self.assertFalse(block['ocr_prose_evidence']['native_confirmed'])
            self.assertIn('ocr_only_prose_requires_source_review', block['review_flags'])
            validation = json.loads((root / 'output/validation.json').read_text())
            self.assertEqual(validation['status'], 'REVIEW')
            self.assertTrue(validation['warnings'])

    def test_scan_table_remains_searchable_with_visible_source_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pdf = root / 'scan.pdf'
            image = Image.new('RGB', (500, 300), 'white')
            ImageDraw.Draw(image).text((20, 30), 'Voltage 220.4 V', fill='black')
            image_bytes = io.BytesIO()
            image.save(image_bytes, format='PNG')
            document = canvas.Canvas(str(pdf), pagesize=(300, 300))
            document.drawImage(ImageReader(image_bytes), 30, 150, width=240, height=120)
            document.save()
            table = '<table><tr><td>Voltage</td><td>220.4 V</td></tr></table>'
            glm = root / 'glm.json'
            mineru = root / 'mineru.json'
            glm.write_text(json.dumps([[{'label': 'table', 'bbox_2d': [100, 100, 900, 500], 'content': table}]]))
            mineru.write_text(json.dumps({'pages': [{'page_idx': 0, 'blocks': [{'type': 'table', 'bbox': [.1, .1, .9, .5], 'content': table}]}]}))
            fuse(SimpleNamespace(pdf=pdf, glm_json=glm, mineru_json=mineru, glm_assets=root, mineru_assets=root, output=root / 'fusion'))
            export_document(pdf, root / 'fusion', root / 'output')
            result = json.loads((root / 'output/document.json').read_text())
            block = result['pages'][0]['blocks'][0]
            self.assertEqual(block['table_html_status'], 'ocr-only-unverified')
            self.assertIn('<table>', block['table_html'])
            self.assertIn('220.4 V', block['text'])
            self.assertIn('220.4 V', (root / 'output/document.md').read_text())
            self.assertIn('表格文字待核对', block['html'])
            self.assertIn('<details class="source-crop" open>', block['html'])
            self.assertTrue((root / 'output' / block['visual_asset']).is_file())
            self.assertFalse(block['table_evidence']['native_confirmed'])
            validation = json.loads((root / 'output/validation.json').read_text())
            self.assertEqual(validation['status'], 'REVIEW')
            self.assertTrue(validation['warnings'])


if __name__ == '__main__':
    unittest.main()
