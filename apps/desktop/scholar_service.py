"""Shared, permission-labelled capabilities over the desktop service's stores."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

import runtime
from content_store import _atomic_temp_path, _sync_content_file
from job_store import _read_json_file
from search_service import SearchService, content_blocks


class CapabilityError(Exception):
    def __init__(self, message, status=400, code='invalid_request'):
        super().__init__(message)
        self.status, self.code = int(status), code


def notes_snapshot(job_dir):
    path = Path(job_dir) / 'notes.md'
    markdown = path.read_text(encoding='utf-8') if path.is_file() else ''
    return {"markdown": markdown, "revision": hashlib.sha256(markdown.encode('utf-8')).hexdigest()}


def save_document_notes(job_dir, markdown, expected_revision=None, *, require_revision=False):
    if not isinstance(markdown, str) or len(markdown.encode('utf-8')) > 2_000_000:
        raise CapabilityError('笔记必须是字符串且不超过2 MB。')
    current = notes_snapshot(job_dir)
    if require_revision and not isinstance(expected_revision, str):
        raise CapabilityError('保存笔记必须提供读取时的expected_revision。')
    if expected_revision is not None and expected_revision != current['revision']:
        raise CapabilityError('笔记已被其他窗口更新，请重新读取后合并。', 409, 'revision_conflict')
    target = Path(job_dir) / 'notes.md'
    temporary = _atomic_temp_path(target)
    try:
        with temporary.open('w', encoding='utf-8') as handle:
            handle.write(markdown)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    result = notes_snapshot(job_dir)
    try:
        _sync_content_file(Path(job_dir), 'notes/notes.md', markdown)
    except OSError:
        result['mirror_status'] = 'pending'
    return result


STR = {"type": "string"}
OBJ = {"type": "object"}
ARR = {"type": "array", "items": STR}
JOB = {"job_id": {"type": "string", "description": "Document id returned by search_library"}}
PREF_KEYS = frozenset({'shortcuts', 'highlight_color', 'annotation_colors', 'annotation_actions', 'appearance'})


def descriptor(name, description, scope, properties=None, required=()):
    return {"name": name, "description": description, "scope": scope,
            "inputSchema": {"type": "object", "properties": properties or {}, "required": list(required), "additionalProperties": False},
            "annotations": {"readOnlyHint": scope.endswith('.read'), "destructiveHint": False, "openWorldHint": name == 'vocabulary_explain'}}


def capability_descriptors():
    annotation = {**JOB, **{key: STR for key in ('annotation_id', 'quote', 'note', 'kind', 'color', 'block_id', 'surface', 'source_block_id', 'render_generation', 'action_id', 'category', 'quote_prefix', 'quote_suffix', 'suggestion_state')}, 'page': {"type": "integer"}, 'start': {"type": "number"}, 'end': {"type": "number"}}
    vocabulary = {'entry_id': STR, 'term': STR, 'language': STR, 'meaning': STR, 'note': STR, 'tags': ARR, 'source': OBJ, 'status': STR, 'details': OBJ, 'only_if_meaning_empty': {'type': 'boolean'}, 'only_if_details_empty': {'type': 'boolean'}}
    return [
        descriptor('search_library', 'Search metadata, notes, annotations and current full text. Returns paged source references and index state. Chinese phrases and English words are supported.', 'library.read', {'query': STR, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}, 'offset': {'type': 'integer', 'minimum': 0}, 'sources': ARR, 'folder_id': STR}),
        descriptor('get_document', 'Read public document metadata, folders and properties.', 'library.read', JOB, ['job_id']),
        descriptor('get_document_content', 'Read current active render text blocks with stable block/page references.', 'library.read', {**JOB, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}, 'offset': {'type': 'integer', 'minimum': 0}}, ['job_id']),
        descriptor('get_notes', 'Read Markdown notes and their revision for conflict-safe editing.', 'notes.read', JOB, ['job_id']),
        descriptor('save_notes', 'Atomically replace Markdown notes only if expected_revision still matches.', 'notes.write', {**JOB, 'markdown': STR, 'expected_revision': STR}, ['job_id', 'markdown', 'expected_revision']),
        descriptor('list_annotations', 'Read document highlights, underlines and notes.', 'annotations.read', JOB, ['job_id']),
        descriptor('create_annotation', 'Create a highlight or underline using existing reader validation.', 'annotations.write', {key: value for key, value in annotation.items() if key not in {'annotation_id', 'suggestion_state'}}, ['job_id', 'quote']),
        descriptor('update_annotation', 'Update a saved annotation using existing reader validation.', 'annotations.write', annotation, ['job_id', 'annotation_id']),
        descriptor('delete_annotation', 'Delete one saved annotation.', 'annotations.write', {**JOB, 'annotation_id': STR}, ['job_id', 'annotation_id']),
        descriptor('list_folders', 'List document folders.', 'library.read'),
        descriptor('create_folder', 'Create a named folder, optionally beneath another folder.', 'library.write', {'name': STR, 'parent_id': STR}, ['name']),
        descriptor('set_document_folders', 'Add or remove folder memberships atomically.', 'library.write', {**JOB, 'add': ARR, 'remove': ARR}, ['job_id']),
        descriptor('list_properties', 'List library custom property definitions.', 'library.read'),
        descriptor('set_document_properties', 'Set existing custom property values on a document.', 'library.write', {**JOB, 'values': OBJ}, ['job_id', 'values']),
        descriptor('update_document_metadata', 'Update bibliographic fields, preserving existing validation and field locks.', 'library.write', {**JOB, 'fields': OBJ}, ['job_id', 'fields']),
        descriptor('get_preferences', 'Read reader appearance, annotation styles and keyboard shortcuts. Credentials are excluded.', 'preferences.read'),
        descriptor('update_preferences', 'Update reader appearance, annotation styles and keyboard shortcuts.', 'preferences.write', {key: (STR if key == 'highlight_color' else OBJ) for key in PREF_KEYS}),
        descriptor('vocabulary_list', 'List saved vocabulary entries.', 'vocabulary.read'),
        descriptor('vocabulary_save', 'Save a word or phrase with a source document.', 'vocabulary.write', {key: value for key, value in vocabulary.items() if key != 'entry_id'}, ['term', 'source']),
        descriptor('vocabulary_update', 'Update a saved vocabulary entry.', 'vocabulary.write', vocabulary, ['entry_id']),
        descriptor('vocabulary_delete', 'Delete one saved vocabulary entry.', 'vocabulary.write', {'entry_id': STR}, ['entry_id']),
        descriptor('vocabulary_review', 'Update review status for a saved vocabulary entry.', 'vocabulary.write', {'entry_id': STR, 'status': STR}, ['entry_id', 'status']),
        {**descriptor('vocabulary_explain', 'Generate an explanation for a saved vocabulary entry using configured AI; sends saved word/source text to the configured provider. Requires vocabulary.read, vocabulary.write and ai.translate.', 'vocabulary.write', {'entry_id': STR}, ['entry_id']), 'requiresScopes': ['vocabulary.read', 'vocabulary.write', 'ai.translate']},
    ]


def public_document_item(job_id, item):
    return {'job_id': job_id, **{key: item.get(key) for key in ('alias', 'folder_ids', 'values', 'progress', 'created_at', 'updated_at')}}


def public_vocabulary_result(result):
    def entry(value):
        output = {key: value[key] for key in ('id', 'term', 'language', 'meaning', 'note', 'tags', 'details', 'review', 'created_at', 'updated_at') if key in value}
        source_fields = ('job_id', 'title', 'source_filename', 'selected_text', 'quote', 'block_id', 'source_block_id', 'render_generation', 'quote_prefix', 'quote_suffix', 'surface', 'page', 'start', 'end')
        output['sources'] = [{key: source[key] for key in source_fields if key in source} for source in value.get('sources', [])]
        return output
    output = dict(result)
    if 'entry' in output:
        output['entry'] = entry(output['entry'])
    if 'entries' in output:
        output['entries'] = [entry(value) for value in output['entries']]
    return output


class ScholarService:
    def __init__(self, host):
        self.host = host
        self.store = host.STORE
        self.library = host.LIBRARY
        self.search_index = SearchService(host.LIBRARY_ROOT)
        self.descriptors = {tool['name']: tool for tool in capability_descriptors()}

    def tools(self):
        return list(self.descriptors.values())

    def _snapshot(self):
        return self.host.LIBRARY.snapshot(self.host.STORE.list())

    def _document(self, job_id):
        if not isinstance(job_id, str) or not self.host.JOB_ID_RE.fullmatch(job_id):
            raise CapabilityError('文献标识无效。')
        record = self.host.STORE.get(job_id)
        if not record or self.host.LIBRARY.is_permanently_deleted(job_id):
            raise CapabilityError('文献不存在。', 404, 'not_found')
        with self.host.LIBRARY.lock:
            item = self.host.LIBRARY.state.get('items', {}).get(job_id, {})
            if item.get('deleted_at'):
                raise CapabilityError('文献已在回收站中。', 404, 'not_found')
        return record, Path(record['job_dir'])

    def _handler_call(self, method, payload, *args):
        handler = object.__new__(self.host.ScholarHandler)
        output = []
        handler._read_json_body = lambda **kwargs: payload
        handler._send_json = lambda result, *args, **kwargs: output.append(result)
        def error(message, status=400, **kwargs):
            raise CapabilityError(message, status)
        handler._send_error_json = error
        getattr(handler, method)(*args)
        return output[-1] if output else {}

    def call(self, name, arguments, scopes=None):
        tool = self.descriptors.get(name)
        if tool is None:
            raise CapabilityError('未知能力。', 404, 'unknown_tool')
        if not isinstance(arguments, dict):
            raise CapabilityError('arguments 必须是对象。')
        schema = tool['inputSchema']
        if set(arguments) - set(schema['properties']):
            raise CapabilityError('包含不支持的参数：' + ', '.join(sorted(set(arguments) - set(schema['properties']))))
        missing = set(schema['required']) - set(arguments)
        if missing:
            raise CapabilityError('缺少必填参数：' + ', '.join(sorted(missing)))
        for key, value in arguments.items():
            rule = schema['properties'][key]
            expected = rule.get('type')
            valid = {'string': isinstance(value, str), 'object': isinstance(value, dict), 'array': isinstance(value, list), 'integer': isinstance(value, int) and not isinstance(value, bool), 'number': isinstance(value, (int, float)) and not isinstance(value, bool), 'boolean': isinstance(value, bool)}
            if expected and not valid.get(expected, True):
                raise CapabilityError('参数类型无效：' + key)
            if expected == 'array' and rule.get('items', {}).get('type') == 'string' and any(not isinstance(item, str) for item in value):
                raise CapabilityError('列表参数必须只包含字符串：' + key)
        if scopes is not None and tool['scope'] not in scopes:
            raise CapabilityError('未授予能力权限：' + tool['scope'], 403, 'scope_denied')
        if runtime.READONLY_MODE and not tool['scope'].endswith('.read'):
            raise CapabilityError('只读演示模式，暂不支持修改。', 403, 'readonly')
        if not tool['scope'].endswith('.read'):
            self.host._assert_annotation_style_writable()
        try:
            required_scopes = tool.get('requiresScopes', [tool['scope']])
            if scopes is not None and not set(required_scopes).issubset(scopes):
                raise CapabilityError('未授予此能力要求的全部权限。', 403, 'scope_denied')
            return self._call(name, dict(arguments), scopes)
        except CapabilityError:
            raise
        except (ValueError, KeyError, TypeError) as exc:
            raise CapabilityError(str(exc)) from exc

    def _call(self, name, args, scopes=None):
        h = self.host
        job_id = args.get('job_id')
        record, job_dir = self._document(job_id) if job_id is not None else (None, None)
        if name == 'search_library':
            jobs = h.STORE.list()
            if scopes is not None:
                allowed = {'metadata', 'content'}
                if 'notes.read' in scopes:
                    allowed.add('notes')
                if 'annotations.read' in scopes:
                    allowed.add('annotations')
                requested = args.get('sources')
                if requested is not None and (not isinstance(requested, list) or any(source not in allowed for source in requested)):
                    raise CapabilityError('未授予指定检索来源的读取权限。', 403, 'scope_denied')
                args['sources'] = sorted(allowed) if requested is None else requested
            return self.search_index.search(h.LIBRARY.snapshot(jobs), jobs, **args)
        if name == 'get_document':
            item = self._snapshot()['items'][job_id]
            return {'document': public_document_item(job_id, item), 'metadata': {'fields': item.get('metadata', {}).get('fields', {}), 'locked_fields': item.get('metadata', {}).get('locked_fields', [])}, 'status': record.get('status'), 'source_name': record.get('source_filename')}
        if name == 'get_document_content':
            limit, offset = args.get('limit', 100), args.get('offset', 0)
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100 or isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
                raise CapabilityError('分页参数无效。')
            blocks, generation = content_blocks(job_dir)
            return {'job_id': job_id, 'blocks': blocks[offset:offset+limit], 'total': len(blocks), 'offset': offset, 'limit': limit, 'render_generation': generation}
        if name in {'get_notes', 'save_notes'}:
            with h._job_mutation_lock(job_id):
                if name == 'get_notes':
                    return {'job_id': job_id, **notes_snapshot(job_dir)}
                if record.get('status') != 'completed':
                    raise CapabilityError('文献尚未完成转换。', 409)
                return {'job_id': job_id, **save_document_notes(job_dir, args['markdown'], args['expected_revision'], require_revision=True)}
        if name == 'list_annotations':
            with h.ANNOTATION_LOCK:
                return {'job_id': job_id, **h._annotation_payload(_read_json_file(job_dir / 'annotations.json', []))}
        annotation_methods = {'create_annotation': '_add_annotation', 'update_annotation': '_update_annotation', 'delete_annotation': '_delete_annotation'}
        if name in annotation_methods:
            args.pop('job_id')
            annotation_id = args.pop('annotation_id', None)
            return self._handler_call(annotation_methods[name], args, job_id, *([annotation_id] if annotation_id is not None else []))
        if name == 'list_folders':
            return {'folders': self._snapshot()['folders']}
        if name == 'create_folder':
            return {'folder': h.LIBRARY.create_folder(args['name'], args.get('parent_id'))}
        if name == 'set_document_folders':
            add, remove = args.get('add', []), args.get('remove', [])
            if not isinstance(add, list) or not isinstance(remove, list):
                raise CapabilityError('add 和 remove 必须是文件夹ID列表。')
            with h._job_mutation(job_id), h.LIBRARY.lock:
                current = h.LIBRARY.state['items'][job_id].get('folder_ids', [])
                folders = list(dict.fromkeys([folder for folder in current if folder not in remove] + add))
                return {'document': public_document_item(job_id, h.LIBRARY.update_item(job_id, {'folder_ids': folders}))}
        if name == 'list_properties':
            return {'properties': self._snapshot()['properties']}
        if name == 'set_document_properties':
            with h._job_mutation(job_id):
                return {'document': public_document_item(job_id, h.LIBRARY.update_item(job_id, {'values': args['values']}))}
        if name == 'update_document_metadata':
            with h._job_mutation(job_id):
                value = h.LIBRARY.update_metadata(job_id, {'fields': args['fields']})
                return {'metadata': {key: value.get(key) for key in ('fields', 'locked_fields', 'status')}}
        if name in {'get_preferences', 'update_preferences'}:
            if name == 'update_preferences':
                h._write_settings(args)
            public = h._public_settings()
            return {'preferences': {key: public[key] for key in PREF_KEYS if key in public}}
        vocabulary_methods = {'vocabulary_list': 'list', 'vocabulary_save': 'add', 'vocabulary_update': 'update', 'vocabulary_delete': 'delete', 'vocabulary_review': 'review'}
        entry_id = args.pop('entry_id', '')
        if name in vocabulary_methods:
            if name == 'vocabulary_save':
                source = args.get('source', {})
                self._document(source.get('job_id') if isinstance(source, dict) else None)
            return public_vocabulary_result(self._handler_call('_vocabulary_request', args, vocabulary_methods[name], entry_id))
        if name == 'vocabulary_explain':
            if runtime.AI_REQUIRES_MEMBER:
                # Keep the same entitlement decision as the HTTP endpoint.
                probe = object.__new__(h.ScholarHandler)
                probe._send_error_json = lambda message, status=403, **kw: (_ for _ in ()).throw(CapabilityError(message, status))
                probe._require_ai_entitlement()
            return self._handler_call('_explain_vocabulary', {}, entry_id)
        raise CapabilityError('未知能力。', 404)
