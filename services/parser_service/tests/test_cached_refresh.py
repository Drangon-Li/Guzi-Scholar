import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.parser_service.exporter import reexport_document, refresh_cached_layout, save_json


class CachedRefreshTest(unittest.TestCase):
    def package(self, root, page_count=2):
        root.mkdir()
        (root / 'assets/images').mkdir(parents=True)
        (root / 'assets/images/verified.png').write_bytes(b'verified visual')
        (root / 'source.pdf').write_bytes(b'fixture source, no parser should open this')
        pages, ir_pages, fragments = [], [], []
        for page in range(1, page_count + 1):
            identity = f'v3-{page}'
            fragment = f'<p data-block-id="{identity}" data-page="{page}">Native corrected prose {page}: <math><mi>ν</mi></math></p>'
            record = {'block_id': identity, 'label': 'text', 'type': 'paragraph', 'source_bbox_normalized': [.1, .1, .9, .2], 'source_content': 'unfixed OCR $v$', 'content': 'Native corrected prose $ν$', 'text': f'Native corrected prose {page}: ν', 'html': fragment, 'markdown': 'Native corrected prose $ν$', 'native_text_corrections': [{'original': 'ocr', 'corrected': 'Native corrected prose'}], 'fusion_provenance': [{'operation': 'restore_prose_by_native_glyphs'}], 'math_audit': {'schema': 'math-evidence-v3', 'status': 'confirmed', 'inline': [{'source_glyph_ids': [1, 2], 'selectable_text': 'ν', 'render_mode': 'literal-text'}]}}
            pages.append({'page': page, 'blocks': [record], 'elements': [copy.deepcopy(record)]})
            ir_pages.append({'page': page, 'elements': [{**copy.deepcopy(record), 'id': identity, 'source': 'guzi-fusion-auto-v3', 'render': {'html': fragment, 'markdown': record['markdown']}}]})
            fragments.append(f'<section class="pdf-page" id="page-{page}" data-page="{page}">{fragment}</section>')
        document = {'backend': 'guzi-fusion-auto-v3', 'pages': pages, 'summary': {'pages': page_count, 'display_formulas': 1, 'tables': 1, 'images': 1}, 'math_audit': [{'schema': 'math-evidence-v3'}]}
        validation = {'status': 'REVIEW', 'warnings': ['retain previous source warning'], 'page_coverage': page_count}
        manifest = {'job_id': 'stable-job', 'source': {'filename': 'paper.pdf', 'sha256': hashlib.sha256((root / 'source.pdf').read_bytes()).hexdigest()}, 'engine': {'name': 'guzi-fusion-auto-v3'}, 'counts': copy.deepcopy(document['summary']), 'assets': {'images': ['assets/images/verified.png']}, 'validation': validation}
        save_json(root / 'document.json', document)
        save_json(root / 'document-ir.json', {'backend': 'guzi-fusion-auto-v3', 'pages': ir_pages, 'quality': validation})
        save_json(root / 'manifest.json', manifest)
        save_json(root / 'validation.json', validation)
        save_json(root / 'provenance.json', {'original_run': {'id': 'v3-run', 'math': 'math-evidence-v3'}})
        (root / 'document.html').write_text('<html><head></head><body>' + '\n'.join(fragments) + '</body></html>')
        (root / 'document.md').write_text('Native corrected prose $ν$\n')
        return document, manifest, validation

    def test_preserves_v3_native_math_and_complete_assets_without_reparsing(self):
        for refresh in (reexport_document, refresh_cached_layout):
            with self.subTest(refresh=refresh.__name__), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                document, manifest, validation = self.package(root / 'source')
                source_bytes = (root / 'source/document.json').read_bytes()
                with patch('services.parser_service.exporter.export_document', side_effect=AssertionError('reparsing is forbidden')), patch('services.parser_service.exporter._cached_figure_patches', return_value=({}, [])):
                    result = refresh(root / 'source', root / 'stage')
                actual = json.loads((root / 'stage/document.json').read_text())
                actual_ir = json.loads((root / 'stage/document-ir.json').read_text())
                self.assertEqual(actual['pages'], document['pages'])
                self.assertEqual(actual['math_audit'], document['math_audit'])
                self.assertEqual(actual['backend'], 'guzi-fusion-auto-v3')
                self.assertEqual(actual_ir['backend'], 'guzi-fusion-auto-v3')
                self.assertEqual(actual_ir['quality'], validation)
                self.assertEqual(result['status'], 'REVIEW')
                self.assertEqual(result['warnings'], validation['warnings'])
                refreshed_manifest = json.loads((root / 'stage/manifest.json').read_text())
                self.assertEqual(refreshed_manifest['job_id'], manifest['job_id'])
                self.assertEqual(refreshed_manifest['source'], manifest['source'])
                self.assertEqual(refreshed_manifest['engine'], manifest['engine'])
                self.assertEqual((root / 'stage/assets/images/verified.png').read_bytes(), b'verified visual')
                self.assertEqual((root / 'stage/document.md').read_bytes(), (root / 'source/document.md').read_bytes())
                self.assertEqual((root / 'source/document.json').read_bytes(), source_bytes)
                provenance = json.loads((root / 'stage/provenance.json').read_text())
                self.assertEqual(provenance['original_run']['id'], 'v3-run')
                self.assertFalse(provenance['local_refreshes'][-1]['inference_performed'])

    def test_late_pages_cannot_fall_back_to_incomplete_sidecars(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            document, _, _ = self.package(root / 'source', page_count=64)
            save_json(root / 'source/stale-layout.json', {'pages': [{'page': page, 'elements': []} for page in range(1, 37)]})
            with patch('services.parser_service.exporter.export_document', side_effect=AssertionError('backend switch is forbidden')), patch('services.parser_service.exporter._cached_figure_patches', return_value=({}, [])):
                refresh_cached_layout(root / 'source', root / 'stage')
            refreshed = json.loads((root / 'stage/document.json').read_text())
            self.assertEqual(len(refreshed['pages']), 64)
            self.assertEqual(refreshed['pages'], document['pages'])
            html = (root / 'stage/document.html').read_text()
            for page in range(37, 65):
                self.assertIn(f'Native corrected prose {page}:', html)
                self.assertTrue(refreshed['pages'][page-1]['elements'][0]['text'])

    def test_saved_footnote_attributes_override_the_generic_text_label(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'source'
            source.mkdir()
            body = '<p data-block-id="body">We incorporated comprehensive textual annotations from the database and official website <sup>1</sup>, and measured structural similarity using TM-score <sup>3</sup> and InterProScan <sup>4</sup>.</p>'
            elements = [{'type': 'paragraph', 'label': 'text', 'block_id': 'body', 'text': 'Verified body', 'html': body}]
            for number in (1, 3, 4):
                elements.append({'type': 'paragraph', 'label': 'text', 'block_id': f'fn-{number}', 'text': 'Website details without a leading digit', 'html': f'<p class="footnote" data-block-id="fn-{number}" data-footnote-number="{number}">Website details and further discussion using protein experiments <sup>4</sup>.</p>'})
            elements.append({'type': 'title', 'block_id': 'refs', 'text': 'References', 'html': '<h2 data-block-id="refs">References</h2>'})
            for number in (1, 3, 4):
                text = f'[{number}] Author. A paper (2020).'
                elements.append({'type': 'paragraph', 'block_id': f'ref-{number}', 'text': text, 'html': f'<p data-block-id="ref-{number}">{text}</p>'})
            save_json(source / 'document.json', {'pages': [{'page': 1, 'elements': elements}], 'citation_audit': {}})
            (source / 'document.html').write_text('<html><head></head><body>' + ''.join(r['html'] for r in elements) + '</body></html>')
            refresh_cached_layout(source, root / 'stage')
            result = json.loads((root / 'stage/document.json').read_text())
            self.assertEqual(result['pages'][0]['elements'][0]['html'], body)
            for record in result['pages'][0]['elements'][1:4]:
                self.assertNotIn('class="citation"', record['html'])

    def test_job_container_cannot_copy_stale_outputs_or_user_data(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            job = root / 'job'
            document, _, _ = self.package(job)
            document['backend'] = 'guzi-fusion-auto-v2'
            save_json(job / 'document.json', document)
            save_json(job / 'job.json', {'active_render': 10})
            (job / 'annotations.json').write_text('private user annotations')
            (job / 'translations.json').write_text('private user translations')
            (job / 'renders').mkdir()
            self.package(job / 'renders/10')
            for refresh in (reexport_document, refresh_cached_layout):
                with self.subTest(refresh=refresh.__name__), patch('services.parser_service.exporter.shutil.copytree') as copytree:
                    with self.assertRaisesRegex(ValueError, 'job container.*renders/10'):
                        refresh(job, root / 'rejected')
                    copytree.assert_not_called()
                self.assertFalse((root / 'rejected').exists())
            with patch('services.parser_service.exporter._cached_figure_patches', return_value=({}, [])):
                reexport_document(job / 'renders/10', root / 'accepted')
            actual = json.loads((root / 'accepted/document.json').read_text())
            self.assertEqual(actual['backend'], 'guzi-fusion-auto-v3')
            self.assertFalse((root / 'accepted/annotations.json').exists())
            self.assertFalse((root / 'accepted/translations.json').exists())

    def test_mismatched_saved_fragments_fail_before_creating_a_package(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root / 'source')
            (root / 'source/document.html').write_text('<html>unrelated cached document</html>')
            with self.assertRaisesRegex(ValueError, 'no longer matches'):
                reexport_document(root / 'source', root / 'stage')
            self.assertFalse((root / 'stage').exists())

    def test_replaced_cached_pdf_fails_before_reading_native_evidence_or_copying(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root / 'source')
            (root / 'source/source.pdf').write_bytes(b'a different source document')
            for refresh in (reexport_document, refresh_cached_layout):
                with self.subTest(refresh=refresh.__name__), patch('services.parser_service.exporter._cached_native_reference_duplicates', side_effect=AssertionError('native evidence must not use a replaced source')) as native, patch('services.parser_service.exporter.shutil.copytree') as copytree:
                    with self.assertRaisesRegex(ValueError, 'source PDF identity mismatch'):
                        refresh(root / 'source', root / 'stage')
                    native.assert_not_called()
                    copytree.assert_not_called()
                self.assertFalse((root / 'stage').exists())

    def test_missing_explicit_pdf_fails_before_creating_a_package(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root / 'source')
            with patch('services.parser_service.exporter.shutil.copytree') as copytree:
                with self.assertRaises(FileNotFoundError):
                    reexport_document(root / 'source', root / 'stage', source_pdf=root / 'missing.pdf')
                copytree.assert_not_called()
            self.assertFalse((root / 'stage').exists())
