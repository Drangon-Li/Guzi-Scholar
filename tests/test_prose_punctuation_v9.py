import copy
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from services.parser_service.currency import normalize_currency_dollars
from services.parser_service.fusion import fuse, restore_native_prose
from services.parser_service.tests.test_native_pdf import page, glyph


ROOT = Path(__file__).resolve().parents[1]
DEMO_DIR = os.environ.get('GUZI_TEST_DEMO_DIR')
SOURCE = Path(DEMO_DIR).expanduser() / '2.pdf' if DEMO_DIR else None
RAW_GLM = ROOT / 'apps/desktop/build/pdf-benchmark-20261017/results/demo-baselines-v2-20261018/2/glm/output/2/2.json'


class NativeProsePunctuationTests(unittest.TestCase):
    def test_native_ascii_parenthesis_and_space_survive_math_boundary(self):
        text = 'Result (x=1) and baseline.'
        p = page([glyph(c, i*5) for i,c in enumerate(text)])
        p.width = 200
        fixed, edits = restore_native_prose('Result $x=1$）and baseline.', p, [0,0,1,1])
        self.assertEqual(fixed, 'Result $x=1$) and baseline.')
        self.assertTrue(any(e['reason']=='native_prose_punctuation_glyph' for e in edits))

    def test_native_fullwidth_punctuation_is_preserved(self):
        text = 'Result （x=1） and baseline.'
        p = page([glyph(c, i*5) for i,c in enumerate(text)])
        p.width = 200
        candidate='Result （$x=1$） and baseline.'
        self.assertEqual(restore_native_prose(candidate,p,[0,0,1,1])[0],candidate)

    def test_currency_does_not_turn_following_native_punctuation_into_math(self):
        source = 'Pay $3 and result (x=1) and baseline.'
        p = page([glyph(c, i * 5) for i, c in enumerate(source)])
        p.width = 300
        candidate = 'Pay $3 and result $x=1$）and baseline.'
        normalized, dollars = normalize_currency_dollars(candidate, p, [0, 0, 1, 1])
        fixed, edits = restore_native_prose(normalized, p, [0, 0, 1, 1])
        self.assertEqual(fixed, r'Pay \$3 and result $x=1$) and baseline.')
        self.assertEqual(len(dollars), 1)
        self.assertTrue(any(e['before'] == '）' and e['after'] == ') ' for e in edits))

    @unittest.skipUnless(SOURCE is not None and SOURCE.is_file() and RAW_GLM.is_file(), 'GUZI_TEST_DEMO_DIR/2.pdf or local raw GLM fixture unavailable')
    def test_real_raw_glm_fusion_restores_ascii_parenthesis_and_word_gap(self):
        from pypdf import PdfReader, PdfWriter
        raw = json.loads(RAW_GLM.read_text())
        blocks = raw[2]['blocks'] if isinstance(raw[2], dict) else raw[2]
        block = copy.deepcopy(blocks[4])
        self.assertIn('$3-12 per question', block['content'])
        self.assertIn('$）and', block['content'])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            writer = PdfWriter()
            writer.add_page(PdfReader(SOURCE).pages[2])
            writer.write(root / 'source.pdf')
            (root / 'glm.json').write_text(json.dumps([[block]]))
            (root / 'mineru.json').write_text(json.dumps({'pages': [{'page_idx': 0, 'blocks': []}]}))
            fuse(SimpleNamespace(pdf=root / 'source.pdf', glm_json=root / 'glm.json', mineru_json=root / 'mineru.json', glm_assets=root, mineru_assets=root, output=root / 'output'))
            result = json.loads((root / 'output/document.json').read_text())['pages'][0]['blocks'][0]
            self.assertNotIn('）and', result['content'])
            self.assertRegex(result['content'], r'0\.0029\s*\$\) and did not differ')
            self.assertIn(r'\$3-12 per question', result['content'])
            corrections = result['native_text_corrections']
            self.assertTrue(any(e['before'] == '）' and e['after'] == ') ' for e in corrections))
            operations = [entry['operation'] for entry in result['fusion_annotations']]
            self.assertLess(operations.index('preserve_native_currency_dollars'), operations.index('restore_prose_by_native_glyphs'))
            self.assertTrue(all(a['status'] == 'confirmed' for a in result['math_audit']['inline']))
