from __future__ import annotations

import html
import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
from job_store import JobStore
from library_store import LibraryStore
from zotero_merge import stage_import


class ZoteroConversionHooksTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='my-scholar-zotero-conversion-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = JobStore(self.root / 'jobs')
        self.library = LibraryStore(self.root)
        self.record = self.store.create('fixture.pdf', 0)
        self.job_id = self.record['job_id']
        self.directory = Path(self.record['job_dir'])
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(server, 'STORE', self.store))
        self.stack.enter_context(patch.object(server, 'LIBRARY', self.library))
        self.stack.enter_context(patch.object(server.runtime, 'READONLY_MODE', False))
        self.stack.enter_context(patch.object(server, '_metadata_settings', return_value={'auto_retrieve': False, 'online_lookup': False}))
        self.enqueue_metadata = self.stack.enter_context(patch.object(server, '_enqueue_metadata'))
        self.stack.enter_context(patch('pymupdf_runtime.load_fitz', side_effect=ImportError('No PDF reader needed for fixture')))
        self.quote = 'A uniquely anchored imported annotation.'
        self.text = 'Intro 😀 ' + self.quote + ' End.'
        self.package = {
            'source_id': 'zotero:user:42:ITEM:PDF', 'library_id': 'user:42',
            'item_key': 'ITEM', 'attachment_key': 'PDF', 'title': 'Fixture paper',
            'metadata': {'title': 'Fixture paper', 'authors': ['Ada'], 'year': '2025'},
            'tags': [], 'collections': [],
            'notes': [{'key': 'NOTE', 'version': 1, 'html': '<p>Imported after publication.</p>'}],
            'annotations': [{'key': 'MARK', 'version': 1, 'type': 'underline', 'text': self.quote,
                             'comment': 'Imported comment', 'color': '#ff0000', 'page_label': '1',
                             'position': {'pageIndex': 0, 'rects': [[20, 725, 400, 760]]}}],
        }

    def fake_parser(self, source_pdf, output, **kwargs):
        output = Path(output)
        output.mkdir(parents=True, exist_ok=True)
        progress = kwargs.get('progress')
        if progress:
            progress('Fixture parser', 0.5)
        element = {'block_id': 'fixture-block', 'type': 'paragraph', 'text': self.text,
                   'bbox': [10, 20, 580, 90], 'source': 'opendataloader'}
        document = {'pages': [{'page': 1, 'width': 600, 'height': 800, 'elements': [element]}]}
        (output / 'document.json').write_text(json.dumps(document), encoding='utf-8')
        (output / 'document-ir.json').write_text(json.dumps({'backend': 'opendataloader', 'pages': [{'page': 1, 'width': 600, 'height': 800}]}), encoding='utf-8')
        (output / 'document.html').write_text('<html><body><p data-block-id="fixture-block" data-page="1" data-bbox="[10,20,580,90]">' + html.escape(self.text) + '</p></body></html>', encoding='utf-8')
        return {'job_id': self.job_id, 'source': {'filename': 'fixture.pdf', 'bytes': 0},
                'artifacts': {'html': str(output / 'document.html')}, 'validation': {'status': 'PASS'}}

    def assert_import_applied(self):
        self.assertEqual(self.store.get(self.job_id)['status'], 'completed')
        self.assertIn('Imported after publication.', (self.directory / 'notes.md').read_text(encoding='utf-8'))
        annotations = json.loads((self.directory / 'annotations.json').read_text(encoding='utf-8'))
        self.assertEqual(len(annotations), 1)
        annotation = annotations[0]
        self.assertEqual(annotation['kind'], 'underline')
        self.assertEqual(annotation['quote'], self.quote)
        self.assertEqual(annotation['note'], 'Imported comment')
        self.assertEqual(annotation['block_id'], 'fixture-block')
        self.assertEqual(annotation['start'], len('Intro 😀 '.encode('utf-16-le')) // 2)
        self.assertFalse(annotation['import_unanchored'])
        self.assertEqual(annotations, json.loads((self.directory / 'content/annotations/annotations.json').read_text(encoding='utf-8')))
        self.assertEqual((self.directory / 'notes.md').read_text(encoding='utf-8'), (self.directory / 'content/notes/notes.md').read_text(encoding='utf-8'))
        sidecar = json.loads((self.directory / 'zotero-import.json').read_text(encoding='utf-8'))
        self.assertEqual(sidecar['sources'][self.package['source_id']]['status'], 'applied')
        status = json.loads((self.directory / 'zotero-status.json').read_text(encoding='utf-8'))
        self.assertFalse(status['pending'])
        self.assertEqual(status['annotations_count'], 1)
        self.assertEqual(status['notes_count'], 1)
        self.assertNotIn('error', status)

    def test_conversion_publication_hook_applies_staged_notes_and_annotations(self):
        stage_import(self.directory, self.package)
        self.assertFalse((self.directory / 'notes.md').exists())
        with patch.object(server, '_parsing_provider_registry', return_value={}), patch.object(server, 'process_pdf', side_effect=self.fake_parser) as parser:
            server._run_conversion_job(self.job_id, 'fixture.pdf')
        parser.assert_called_once()
        self.assertTrue((self.directory / 'manifest.json').is_file())
        self.assert_import_applied()
        self.enqueue_metadata.assert_not_called()
        before = (self.directory / 'notes.md').read_text(encoding='utf-8')
        with patch.object(server, 'process_pdf') as parser:
            server._run_conversion_job(self.job_id, 'fixture.pdf')
        parser.assert_not_called()
        self.assertEqual((self.directory / 'notes.md').read_text(encoding='utf-8'), before)
        self.assertEqual(len(json.loads((self.directory / 'annotations.json').read_text(encoding='utf-8'))), 1)

    def test_worker_startup_recovers_completed_pending_sidecar_without_starting_threads(self):
        manifest = self.fake_parser(self.directory / 'upload.pdf', self.directory)
        (self.directory / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        self.store.update(self.job_id, status='completed')
        self.library.sync_jobs([self.store.get(self.job_id)])
        stage_import(self.directory, self.package)
        # Reload only the temporary stores, as a fresh process would. Reader
        # migration is unrelated to this startup import recovery assertion.
        with patch('job_store._artifact_migrator', None):
            self.store = JobStore(self.root / 'jobs')
        self.library = LibraryStore(self.root)
        with patch.object(server, 'STORE', self.store), patch.object(server, 'LIBRARY', self.library), patch.object(server.threading, 'Thread') as thread:
            server._start_background_workers()
            self.assert_import_applied()
            notes = (self.directory / 'notes.md').read_text(encoding='utf-8')
            server._start_background_workers()
            self.assertEqual((self.directory / 'notes.md').read_text(encoding='utf-8'), notes)
            self.assertEqual(len(json.loads((self.directory / 'annotations.json').read_text(encoding='utf-8'))), 1)
        targets = {call.kwargs['target'] for call in thread.call_args_list}
        self.assertEqual(targets, {server._conversion_worker, server._metadata_worker, server._reflow_worker})
        self.assertEqual(thread.return_value.start.call_count, len(thread.call_args_list))
        self.enqueue_metadata.assert_not_called()


if __name__ == '__main__':
    unittest.main()
