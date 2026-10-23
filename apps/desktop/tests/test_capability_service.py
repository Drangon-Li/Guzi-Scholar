from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import http.client
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from job_store import JobStore
from library_store import LibraryStore
from mcp_access import MCPAccess
from scholar_service import CapabilityError, ScholarService
from vocabulary_store import VocabularyStore
from plugin_store import ADMISSION_CHECKS


class ServiceFixture(unittest.TestCase):
    def setUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix='guzi-capabilities-')))
        self.store = JobStore(self.root / 'jobs')
        self.library = LibraryStore(self.root)
        self.vocabulary = VocabularyStore(self.root)
        self.record = self.store.create('synthetic.pdf', 20)
        self.job_id = self.record['job_id']
        self.job_dir = Path(self.record['job_dir'])
        self.store.update(self.job_id, status='completed')
        self.record = self.store.get(self.job_id)
        self.library.sync_jobs(self.store.list())
        self.document(self.job_dir, 'Base English attention 中文深度学习', 'base-block')
        (self.job_dir / 'notes.md').write_text('自己的读书笔记 neural insight', encoding='utf-8')
        (self.job_dir / 'annotations.json').write_text(json.dumps([{'id': 'a1', 'quote': 'highlight evidence', 'note': '异常指标', 'page': 2, 'block_id': 'base-block'}]), encoding='utf-8')
        self.library.update_metadata(self.job_id, {'title': 'Synthetic metadata title', 'authors': ['Ada']})
        for name, value in {'STORE': self.store, 'LIBRARY': self.library, 'VOCABULARY': self.vocabulary, 'DATA_ROOT': self.root, 'LIBRARY_ROOT': self.root, 'JOBS_ROOT': self.root / 'jobs', 'SETTINGS_PATH': self.root / 'settings.json', 'ACCOUNT_FILE': self.root / 'account.json', 'MCP_ACCESS': None, 'SCHOLAR_SERVICE': None, 'PLUGIN_STORE': None, 'ANNOTATION_STYLE_RECOVERY_REQUIRED': False, 'MIGRATION_QUIESCING': False}.items():
            self.resources.enter_context(patch.object(server, name, value))
        self.resources.enter_context(patch.object(server.runtime, 'READONLY_MODE', False))
        self.resources.enter_context(patch.object(server.runtime, 'AI_REQUIRES_MEMBER', False))
        self.resources.enter_context(patch.object(server.runtime, 'API_ACCESS_TOKEN', 'ui-secret'))
        self.resources.enter_context(patch.dict(os.environ, {'MY_SCHOLAR_SETTINGS_FILE': str(self.root / 'settings.json'), 'MY_SCHOLAR_PLUGIN_ADMISSION_TOKEN': 'host-only-secret'}, clear=True))
        self.service = ScholarService(server)
        self.addCleanup(self.close_index)

    def close_index(self):
        if self.service.search_index.connection is not None:
            self.service.search_index.connection.close()
        cached = server.SCHOLAR_SERVICE
        if cached is not None and cached.search_index.connection is not None:
            cached.search_index.connection.close()

    @staticmethod
    def document(root, text, block_id):
        root.mkdir(parents=True, exist_ok=True)
        (root / 'document.json').write_text(json.dumps({'pages': [{'page': 2, 'elements': [{'text': text, 'block_id': block_id, 'type': 'paragraph'}]}]}), encoding='utf-8')

    def call(self, tool_name, **arguments):
        return self.service.call(tool_name, arguments)


class CapabilitiesTest(ServiceFixture):
    def test_english_chinese_and_all_sources(self):
        for query, source in [('attention', 'content'), ('深度学习', 'content'), ('读书笔记', 'notes'), ('neural', 'notes'), ('异常指标', 'annotations'), ('metadata', 'metadata')]:
            with self.subTest(query=query):
                result = self.call('search_library', query=query)
                self.assertGreater(result['total'], 0)
                self.assertEqual(result['results'][0]['source'], source)
                self.assertEqual(result['index']['state'], 'ready')
                self.assertEqual(result['results'][0]['reference']['job_id'], self.job_id)
        result = self.call('search_library', query='深学习')
        self.assertEqual(result['total'], 0, 'Chinese phrases must retain word order')
        self.assertEqual(self.call('search_library', query='" OR *')['total'], 0)

    def test_active_render_beats_stale_mirror(self):
        mirror = self.job_dir / 'content' / 'english'
        mirror.mkdir(parents=True)
        (mirror / 'blocks.json').write_text(json.dumps({'blocks': [{'text': 'stale-only'}]}))
        self.assertEqual(self.call('search_library', query='attention')['total'], 1)
        active = self.job_dir / 'renders' / '1'
        self.document(active, 'Current generation discovery 新版本正文', 'active-block')
        (active / 'manifest.json').write_text('{}')
        self.store.update(self.job_id, active_render='1')
        found = self.call('search_library', query='discovery')
        self.assertEqual(found['total'], 1)
        self.assertEqual(found['results'][0]['reference']['render_generation'], '1')
        self.assertEqual(self.call('search_library', query='attention')['total'], 0)
        self.assertEqual(self.call('search_library', query='stale-only')['total'], 0)
        content = self.call('get_document_content', job_id=self.job_id)
        self.assertEqual(content['blocks'][0]['block_id'], 'active-block')

    def test_incremental_notes_annotation_metadata_trash_restore(self):
        initial = self.call('search_library', query='attention')
        self.assertEqual(initial['index']['updated_documents'], 1)
        self.assertEqual(self.call('search_library', query='attention')['index']['updated_documents'], 0)
        notes = self.call('get_notes', job_id=self.job_id)
        self.call('save_notes', job_id=self.job_id, markdown='newly-indexed-note', expected_revision=notes['revision'])
        result = self.call('search_library', query='newly-indexed-note')
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['index']['updated_documents'], 1)
        self.call('update_document_metadata', job_id=self.job_id, fields={'title': 'UpdatedUniqueTitle'})
        result = self.call('search_library', query='UpdatedUniqueTitle')
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['index']['updated_documents'], 1)
        self.library.trash_item(self.job_id)
        self.assertEqual(self.call('search_library', query='attention')['total'], 0)
        with self.assertRaises(CapabilityError):
            self.call('get_document', job_id=self.job_id)
        self.library.restore_item(self.job_id)
        self.assertEqual(self.call('search_library', query='attention')['total'], 1)

    def test_notes_conflict_and_concurrent_writers(self):
        initial = self.call('get_notes', job_id=self.job_id)
        def write(index):
            try:
                return self.call('save_notes', job_id=self.job_id, markdown=f'writer {index}', expected_revision=initial['revision'])
            except CapabilityError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(write, range(6)))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(results.count(409), 5)
        self.assertEqual((self.job_dir / 'content' / 'notes' / 'notes.md').read_text(), (self.job_dir / 'notes.md').read_text())
        with self.assertRaises(CapabilityError):
            self.call('save_notes', job_id=self.job_id, markdown='missing revision')

    def test_search_organization_changes_do_not_reindex_content(self):
        self.call('search_library', query='attention')
        folder = self.library.create_folder('Search filter')
        original_read = Path.read_text
        content_reads = []
        def read(path, *args, **kwargs):
            if path.name == 'document.json':
                content_reads.append(path)
            return original_read(path, *args, **kwargs)
        with patch.object(Path, 'read_text', read):
            self.library.update_item(self.job_id, {'values': {'reading_status': '阅读中', 'importance': 4}, 'progress': {'percent': 25}})
            self.assertEqual(self.call('search_library', query='attention')['index']['updated_documents'], 0)
            self.store.update(self.job_id, stage='后台状态更新')
            self.assertEqual(self.call('search_library', query='attention')['index']['updated_documents'], 0)
            self.call('set_document_folders', job_id=self.job_id, add=[folder['id']])
            result = self.call('search_library', query='attention', folder_id=folder['id'])
            self.assertEqual(result['total'], 1)
            self.assertEqual(result['index']['updated_documents'], 0)
            self.call('set_document_folders', job_id=self.job_id, remove=[folder['id']])
            result = self.call('search_library', query='attention', folder_id=folder['id'])
            self.assertEqual(result['total'], 0)
            self.assertEqual(result['index']['updated_documents'], 0)
            self.assertEqual(content_reads, [])

    def test_search_index_tracks_alias_filename_and_content_updates(self):
        self.call('search_library', query='attention')
        self.library.update_item(self.job_id, {'alias': 'UniqueSearchAlias'})
        result = self.call('search_library', query='UniqueSearchAlias')
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['index']['updated_documents'], 1)
        self.store.update(self.job_id, source_filename='RenamedSearchSource.pdf')
        result = self.call('search_library', query='RenamedSearchSource')
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['index']['updated_documents'], 1)
        self.document(self.job_dir, 'Changed searchable body text', 'changed-block')
        result = self.call('search_library', query='Changed')
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['index']['updated_documents'], 1)
        self.assertEqual(self.call('search_library', query='attention')['total'], 0)

    def test_annotations_reuse_validation_and_index(self):
        result = self.call('create_annotation', job_id=self.job_id, quote='Fresh annotation content', block_id='base-block')
        annotation_id = result['annotation']['id']
        self.call('update_annotation', job_id=self.job_id, annotation_id=annotation_id, note='NewAnnotationNote')
        result = self.call('search_library', query='NewAnnotationNote')
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['index']['updated_documents'], 1)
        self.call('delete_annotation', job_id=self.job_id, annotation_id=annotation_id)
        self.assertEqual(self.call('search_library', query='NewAnnotationNote')['total'], 0)
        with self.assertRaises(CapabilityError):
            self.call('create_annotation', job_id=self.job_id, quote='')

    def test_folder_properties_and_failed_update_has_no_partial_changes(self):
        folder = self.call('create_folder', name='Example')['folder']
        prop = self.library.create_property({'label': 'Priority', 'type': 'text'})
        self.call('set_document_folders', job_id=self.job_id, add=[folder['id']])
        self.call('set_document_properties', job_id=self.job_id, values={prop['id']: 'high'})
        self.assertEqual(self.call('get_document', job_id=self.job_id)['document']['values'][prop['id']], 'high')
        self.assertEqual(self.call('search_library', query='attention', folder_id=folder['id'])['total'], 1)
        before = self.library.snapshot(self.store.list())['items'][self.job_id]
        with self.assertRaises(ValueError):
            self.library.update_item(self.job_id, {'folder_ids': [], 'values': {'missing-property': 1}})
        self.assertEqual(self.library.snapshot(self.store.list())['items'][self.job_id], before)

    def test_scope_readonly_and_private_settings(self):
        with self.assertRaises(CapabilityError) as captured:
            self.service.call('get_notes', {'job_id': self.job_id}, {'library.read'})
        self.assertEqual(captured.exception.status, 403)
        with patch.object(server, '_public_settings', return_value={'appearance': {'theme': 'dark'}, 'ai': {'api_key': 'PRIVATE'}, 'parsing': {'server_url': 'PRIVATE'}, 'shortcuts': {}}):
            self.assertNotIn('PRIVATE', json.dumps(self.call('get_preferences')))
        with self.assertRaises(CapabilityError):
            self.call('update_preferences', api_key='not-allowed')
        with patch.object(server.runtime, 'READONLY_MODE', True):
            with self.assertRaises(CapabilityError) as captured:
                self.call('create_folder', name='Denied')
            self.assertEqual(captured.exception.status, 403)

    def test_vocabulary_operations_use_existing_store(self):
        entry = self.call('vocabulary_save', term='attention', source={'job_id': self.job_id, 'quote': 'We use attention.'})['entry']
        self.call('vocabulary_update', entry_id=entry['id'], meaning='注意力', details={'meanings': 'focus'})
        self.call('vocabulary_review', entry_id=entry['id'], status='learning')
        saved = self.call('vocabulary_list')['entries'][0]
        self.assertEqual(saved['meaning'], '注意力')
        self.assertEqual(saved['review']['review_count'], 1)
        self.call('vocabulary_delete', entry_id=entry['id'])
        self.assertEqual(self.vocabulary.list(), [])

    def test_disk_failures_do_not_leave_library_changes_in_memory(self):
        import copy
        original = copy.deepcopy(self.library.state)
        def fail_save():
            self.library.state['updated_at'] = 'uncommitted timestamp'
            raise OSError('synthetic disk full')
        operations = [lambda: self.library.create_folder('Must not exist'), lambda: self.library.update_metadata(self.job_id, {'title': 'Must not persist'}), lambda: self.library.update_item(self.job_id, {'alias': 'Must not persist'})]
        for operation in operations:
            with patch.object(self.library, '_save_locked', side_effect=fail_save):
                with self.assertRaises(OSError):
                    operation()
            self.assertEqual(self.library.state, original)
        self.library.save()
        disk = json.loads(self.library.path.read_text())
        self.assertEqual(disk['items'], original['items'])
        self.assertEqual(disk['folders'], original['folders'])

    def test_note_primary_atomic_failure_and_derived_mirror_failure(self):
        initial = self.call('get_notes', job_id=self.job_id)
        with patch('scholar_service.os.replace', side_effect=OSError('synthetic disk full')):
            with self.assertRaises(OSError):
                self.call('save_notes', job_id=self.job_id, markdown='not committed', expected_revision=initial['revision'])
        self.assertEqual(self.call('get_notes', job_id=self.job_id), initial)
        self.assertEqual(list(self.job_dir.glob('.notes.md.*.tmp')), [])
        with patch('scholar_service._sync_content_file', side_effect=OSError('synthetic cache failure')):
            saved = self.call('save_notes', job_id=self.job_id, markdown='durably committed', expected_revision=initial['revision'])
        self.assertEqual(saved['mirror_status'], 'pending')
        self.assertNotEqual(saved['revision'], initial['revision'])
        self.assertEqual(self.call('get_notes', job_id=self.job_id)['markdown'], 'durably committed')

    def test_concurrent_first_requests_share_process_services(self):
        with ThreadPoolExecutor(max_workers=10) as pool:
            identities = list(pool.map(lambda _: (id(server._scholar_service()), id(server._mcp_access()), id(server._plugin_store())), range(30)))
        self.assertEqual(len(set(identities)), 1)

    def test_corrupt_search_cache_rebuilds(self):
        path = self.root / 'cache' / 'search.sqlite3'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'corrupt sqlite data')
        self.assertEqual(self.call('search_library', query='attention')['total'], 1)

    def test_pagination_and_sources(self):
        results = self.call('search_library', query='', limit=1, offset=1)
        self.assertEqual(len(results['results']), 1)
        self.assertGreater(results['total'], 1)
        self.assertEqual(self.call('search_library', query='attention', sources=['notes'])['total'], 0)
        for args in ({'limit': -1}, {'offset': -1}, {'sources': ['bad']}, {'query': None}):
            with self.assertRaises(CapabilityError):
                self.call('search_library', **args)


class HTTPAccessTest(ServiceFixture):
    def setUp(self):
        super().setUp()
        class Quiet(server.ScholarHandler):
            def log_message(self, *_args):
                pass
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        server._mcp_access().bind(f'http://127.0.0.1:{self.httpd.server_address[1]}')

    def stop(self):
        server._mcp_access().close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=3)

    def request(self, method, path, body=None, token='ui-secret', bridge=False, extra=None):
        connection = http.client.HTTPConnection(*self.httpd.server_address, timeout=5)
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization' if bridge else 'X-My-Scholar-Api-Token'] = ('Bearer ' if bridge else '') + token
        headers.update(extra or {})
        try:
            connection.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, json.loads(raw) if 'application/json' in response.getheader('Content-Type', '') else raw
        finally:
            connection.close()

    def configure(self, scopes):
        status, result = self.request('POST', '/api/mcp/configure', {'enabled': True, 'scopes': scopes})
        self.assertEqual(status, 200, result)
        return json.loads((self.root / 'mcp' / 'connection.json').read_text())['token']

    def admit_fixture(self, preview):
        session = {'pluginId': preview['pluginId'], 'previewSession': preview['previewId']}
        status, result = self.request('POST', '/api/plugins/runtime-event', {**session, 'level': 'ready', 'message': 'Trusted host fixture'})
        self.assertEqual(status, 200, result)
        body = {**session, 'checks': {key: True for key in ADMISSION_CHECKS}}
        self.assertEqual(self.request('POST', '/api/plugins/admission', body)[0], 403, 'UI credential cannot issue admission')
        status, result = self.request('POST', '/api/plugins/admission', body, extra={'X-My-Scholar-Plugin-Admission': 'host-only-secret'})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['admission']['status'], 'passed')

    def test_default_disabled_connection_permissions_and_restart_rotation(self):
        status, result = self.request('GET', '/api/mcp/status')
        self.assertFalse(result['enabled'])
        token = self.configure(['library.read', 'notes.read'])
        status, result = self.request('GET', '/api/mcp/status')
        self.assertNotIn('token', result)
        self.assertNotIn(token, json.dumps(result))
        self.assertEqual(stat.S_IMODE((self.root / 'mcp').stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.root / 'mcp' / 'connection.json').stat().st_mode), 0o600)
        server._mcp_access().close()
        self.assertFalse((self.root / 'mcp' / 'connection.json').exists())
        replacement = MCPAccess(self.root)
        replacement.bind(f'http://127.0.0.1:{self.httpd.server_address[1]}')
        self.assertTrue(replacement.enabled)
        self.assertFalse(replacement.authenticate(token))
        replacement.close()

    def test_bridge_scopes_token_rotation_and_old_api_denial(self):
        token = self.configure(['library.read'])
        status, result = self.request('GET', '/api/capabilities', token=token, bridge=True)
        self.assertEqual(status, 200)
        names = {tool['name'] for tool in result['tools']}
        self.assertIn('search_library', names)
        self.assertNotIn('save_notes', names)
        self.assertNotIn('install_plugin', names)
        status, result = self.request('POST', '/api/capabilities/call', {'name': 'search_library', 'arguments': {'query': 'neural'}}, token=token, bridge=True)
        self.assertEqual(status, 200)
        self.assertEqual(result['result']['total'], 0)
        status, result = self.request('POST', '/api/capabilities/call', {'name': 'search_library', 'arguments': {'query': 'neural', 'sources': ['notes']}}, token=token, bridge=True)
        self.assertEqual(status, 403)
        status, result = self.request('POST', '/api/capabilities/call', {'name': 'search_library', 'arguments': {'query': 'attention'}}, token=token, bridge=True)
        self.assertEqual(status, 200, result)
        self.assertEqual(result['result']['total'], 1)
        status, result = self.request('POST', '/api/capabilities/call', {'name': 'save_notes', 'arguments': {'job_id': self.job_id, 'markdown': 'x', 'expected_revision': 'x'}}, token=token, bridge=True)
        self.assertEqual(status, 403)
        for path in ('/api/settings', '/api/jobs', '/api/mcp/status', '/api/plugins', '/plugin-sdk.js'):
            self.assertEqual(self.request('GET', path, token=token, bridge=True)[0], 403)
        self.request('POST', '/api/mcp/rotate', {})
        self.assertEqual(self.request('GET', '/api/capabilities', token=token, bridge=True)[0], 401)

    def test_ui_notes_revision_and_http_conflict(self):
        status, result = self.request('GET', f'/api/jobs/{self.job_id}/notes')
        self.assertEqual(status, 200)
        revision = result['revision']
        body = {'markdown': 'first save', 'expected_revision': revision}
        status, saved = self.request('PUT', f'/api/jobs/{self.job_id}/notes', body)
        self.assertEqual(status, 200)
        self.assertNotEqual(saved['revision'], revision)
        status, result = self.request('PUT', f'/api/jobs/{self.job_id}/notes', body)
        self.assertEqual(status, 409)
        self.assertEqual((self.job_dir / 'notes.md').read_text(), 'first save')

    def test_migration_gate_blocks_capability_and_config(self):
        with patch.object(server, 'MIGRATION_QUIESCING', True):
            self.assertEqual(self.request('POST', '/api/capabilities/call', {'name': 'create_folder', 'arguments': {'name': 'blocked'}})[0], 503)
            self.assertEqual(self.request('POST', '/api/mcp/configure', {'enabled': True, 'scopes': []})[0], 503)

    def test_mcp_plugin_authoring_preview_and_invocation_scope(self):
        token = self.configure(['plugins.manage', 'library.read'])
        def author(name, arguments):
            status, value = self.request('POST', '/api/capabilities/call', {'name': name, 'arguments': arguments}, token=token, bridge=True)
            self.assertEqual(status, 200, value)
            return value['result']
        sdk = author('get_plugin_sdk', {})
        self.assertIn('manifestSchema', sdk)
        draft = author('create_plugin_draft', {'id': 'local.capability-test', 'name': 'Capability test'})
        manifest = draft['manifest']
        manifest['permissions'] = ['library.read']
        author('write_plugin_file', {'draftId': draft['draftId'], 'path': 'manifest.json', 'content': json.dumps(manifest)})
        self.assertTrue(author('validate_plugin', {'draftId': draft['draftId']})['valid'])
        preview = author('preview_plugin', {'draftId': draft['draftId'], 'grants': ['library.read']})
        status, asset = self.request('GET', preview['url'], extra={'Origin': 'null'})
        self.assertEqual(status, 200)
        self.assertIn(b'<html', asset.lower())
        invoke_path = f"/api/plugins/{preview['pluginId']}/invoke"
        status, result = self.request('POST', invoke_path, {'name': 'search_library', 'arguments': {'query': 'neural'}, 'previewSession': preview['previewId']})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['result']['total'], 0, 'library.read must not expose private notes')
        self.assertEqual(self.request('POST', invoke_path, {'name': 'get_notes', 'arguments': {'job_id': self.job_id}, 'previewSession': preview['previewId']})[0], 403)
        forged = {'pluginId': preview['pluginId'], 'level': 'ready', 'message': 'Synthetic test ready', 'previewSession': preview['previewId']}
        self.assertNotEqual(self.request('POST', '/api/capabilities/call', {'name': 'report_plugin_runtime_event', 'arguments': forged}, token=token, bridge=True)[0], 200)
        self.assertEqual(self.request('POST', '/api/plugins/runtime-event', forged, token=token, bridge=True)[0], 403)
        self.assertEqual(self.request('POST', '/api/plugins/admission', {'pluginId': preview['pluginId'], 'previewSession': preview['previewId'], 'checks': {key: True for key in ADMISSION_CHECKS}}, token=token, bridge=True)[0], 403)
        self.assertEqual(self.request('GET', '/api/plugins/runtime-status?pluginId=' + preview['pluginId'], token=token, bridge=True)[0], 403)
        self.assertEqual(self.request('POST', '/api/capabilities/call', {'name': 'install_plugin', 'arguments': {'draftId': draft['draftId'], 'grants': ['library.read'], 'enabled': True}}, token=token, bridge=True)[0], 403)
        self.admit_fixture(preview)
        runtime = author('get_plugin_runtime_status', {'pluginId': preview['pluginId']})
        self.assertEqual(runtime['status'], 'ready')
        first_install = author('install_plugin', {'draftId': draft['draftId'], 'grants': ['library.read'], 'enabled': True})
        first_epoch = first_install['plugin']['epoch']
        installed_path = '/api/plugins/local.capability-test/invoke'
        invocation = {'name': 'search_library', 'arguments': {'query': 'attention'}, 'pluginSession': first_epoch}
        self.assertEqual(self.request('POST', installed_path, invocation)[0], 200)
        replacement = author('install_plugin', {'draftId': draft['draftId'], 'grants': ['library.read'], 'enabled': True})
        self.assertNotEqual(replacement['plugin']['epoch'], first_epoch)
        self.assertEqual(self.request('POST', installed_path, invocation)[0], 403, 'reinstall must invalidate old frames')
        invocation['pluginSession'] = replacement['plugin']['epoch']
        self.assertEqual(self.request('POST', installed_path, invocation)[0], 200)
        invocation.pop('pluginSession')
        self.assertEqual(self.request('POST', installed_path, invocation)[0], 403)
        status, installed = self.request('GET', '/api/plugins')
        self.assertEqual(status, 200)
        self.assertTrue(any(plugin['id'] == 'local.capability-test' for plugin in installed['plugins']))

    def test_mcp_cannot_expand_its_scopes_through_plugin_grants(self):
        token = self.configure(['plugins.manage', 'library.read', 'notes.read'])
        def call(name, arguments, bridge=True):
            return self.request('POST', '/api/capabilities/call' if bridge else '/api/plugins/call', {'name': name, 'arguments': arguments}, token=token if bridge else 'ui-secret', bridge=bridge)
        status, created = call('create_plugin_draft', {'id': 'local.scope-limits'})
        self.assertEqual(status, 200)
        draft = created['result']
        manifest = draft['manifest']
        manifest['permissions'] = ['notes.write', 'storage']
        status, _ = call('write_plugin_file', {'draftId': draft['draftId'], 'path': 'manifest.json', 'content': json.dumps(manifest)})
        self.assertEqual(status, 200)
        grant_args = {'draftId': draft['draftId'], 'grants': ['notes.write', 'storage']}
        self.assertEqual(call('preview_plugin', grant_args)[0], 403)
        self.assertEqual(call('install_plugin', {**grant_args, 'enabled': True})[0], 403)
        status, installed = self.request('GET', '/api/plugins')
        self.assertFalse(any(item['id'] == 'local.scope-limits' for item in installed['plugins']))
        # Desktop grants still require independent host admission before activation.
        self.assertEqual(call('install_plugin', {**grant_args, 'enabled': True}, bridge=False)[0], 403)
        status, preview = call('preview_plugin', grant_args, bridge=False)
        self.assertEqual(status, 200)
        self.admit_fixture(preview['result'])
        self.assertEqual(call('install_plugin', {**grant_args, 'enabled': True}, bridge=False)[0], 200)
        self.assertEqual(call('set_plugin_enabled', {'pluginId': 'local.scope-limits', 'enabled': False})[0], 200)
        # Omitting grants must not bypass the ceiling by inheriting saved grants.
        self.assertEqual(call('set_plugin_enabled', {'pluginId': 'local.scope-limits', 'enabled': True})[0], 403)
        self.assertEqual(call('set_plugin_enabled', {'pluginId': 'local.scope-limits', 'enabled': True}, bridge=False)[0], 200)
        manifest['version'] = '0.2.0'
        self.assertEqual(call('write_plugin_file', {'draftId': draft['draftId'], 'path': 'manifest.json', 'content': json.dumps(manifest)})[0], 200)
        self.assertEqual(call('install_plugin', {**grant_args, 'enabled': True}, bridge=False)[0], 403)
        status, preview = call('preview_plugin', grant_args, bridge=False)
        self.assertEqual(status, 200)
        self.admit_fixture(preview['result'])
        self.assertEqual(call('install_plugin', {**grant_args, 'enabled': True}, bridge=False)[0], 200)
        self.assertEqual(call('install_plugin', {'draftId': draft['draftId'], 'enabled': True})[0], 403)
        self.assertEqual(call('rollback_plugin', {'pluginId': 'local.scope-limits'})[0], 403)
        _, current = self.request('GET', '/api/plugins')
        installed = next(item for item in current['plugins'] if item['id'] == 'local.scope-limits')
        self.assertEqual(installed['version'], '0.2.0')
        self.assertTrue(installed['enabled'])
        manifest['permissions'] = ['storage', 'reader.open']
        self.assertEqual(call('write_plugin_file', {'draftId': draft['draftId'], 'path': 'manifest.json', 'content': json.dumps(manifest)})[0], 200)
        self.assertEqual(call('preview_plugin', {'draftId': draft['draftId'], 'grants': ['storage', 'reader.open']})[0], 200)
        self.assertEqual(call('preview_plugin', {'draftId': draft['draftId'], 'grants': ['storage'], 'allowed_permissions': ['notes.write']})[0], 400)

    def test_null_origin_static_only(self):
        self.assertEqual(self.request('GET', '/plugin-sdk.js', extra={'Origin': 'null'})[0], 200)
        self.assertEqual(self.request('GET', '/api/capabilities', extra={'Origin': 'null'})[0], 403)
        self.assertEqual(self.request('GET', '/api/capabilities', token=None)[0], 401)
        self.assertEqual(self.request('GET', '/api/capabilities', extra={'Host': 'attacker.example'})[0], 403)


if __name__ == '__main__':
    unittest.main()
