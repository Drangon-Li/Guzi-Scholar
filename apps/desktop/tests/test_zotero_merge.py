import copy
import html
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from library_store import LibraryStore
import zotero_merge as merge


class ZoteroMergeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='guzi-zotero-merge-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.job_id = 'a' * 16
        self.job = self.root / 'jobs' / self.job_id
        self.job.mkdir(parents=True)
        self.library = LibraryStore(self.root)
        self.library.sync_jobs([{'job_id': self.job_id, 'status': 'completed'}])
        (self.job / 'job.json').write_text(json.dumps({'status': 'completed'}))
        self.text = 'Intro 😀 We propose a reliable method. More context.'
        self.document([(1, 'block-1', self.text, [10, 20, 580, 90])])

    def document(self, blocks):
        pages = {}
        snippets = []
        for page, identity, text, bbox in blocks:
            attrs = f'data-block-id="{identity}" data-page="{page}" data-bbox="{html.escape(json.dumps(bbox), quote=True)}"'
            snippets.append(f'<p {attrs}>{html.escape(text)}</p>')
            pages.setdefault(page, []).append({'block_id': identity, 'type': 'paragraph', 'bbox': bbox, 'text': text, 'source': 'opendataloader'})
        (self.job / 'document.html').write_text('<html><body>' + ''.join(snippets) + '</body></html>')
        (self.job / 'document.json').write_text(json.dumps({'pages': [{'page': page, 'width': 600, 'height': 800, 'elements': elements} for page, elements in pages.items()]}))
        (self.job / 'document-ir.json').write_text(json.dumps({'backend': 'opendataloader', 'pages': [{'page': page, 'width': 600, 'height': 800} for page in pages]}))

    def package(self, **changes):
        return {'source_id': 'zotero:user:123:ITEM:PDF', 'library_id': 'user:123', 'item_key': 'ITEM', 'attachment_key': 'PDF',
                'title': 'Zotero paper', 'metadata': {'title': 'Zotero paper', 'authors': ['Ada'], 'year': '2025', 'doi': '10.1000/test', 'abstract': 'Abstract'},
                'tags': ['机器学习'], 'collections': [{'key': 'CHILD', 'name': '待读', 'parent_key': 'PARENT'}],
                'collection_ancestors': [{'key': 'PARENT', 'name': '科研', 'parent_key': None}],
                'notes': [{'key': 'NOTE', 'version': 1, 'html': '<h2>Reading</h2><p>A <strong>useful</strong> note.</p>'}],
                'annotations': [{'key': 'MARK', 'version': 1, 'type': 'highlight', 'text': 'We propose a reliable method.', 'comment': 'Question', 'color': '#ffd400', 'page_label': '1', 'position': {'pageIndex': 0, 'rects': [[15, 725, 300, 760]]}}],
                'source_url': 'zotero://select/library/items/ITEM', **changes}

    def apply(self, package=None):
        merge.stage_import(self.job, package or self.package())
        return merge.apply_import(self.job, self.library, self.job_id)

    def annotations(self):
        return json.loads((self.job / 'annotations.json').read_text())

    def sidecar(self):
        return json.loads((self.job / 'zotero-import.json').read_text())

    def test_highlight_has_native_anchor_and_utf16_offsets_and_content_mirrors(self):
        result = self.apply()
        item = self.annotations()[0]
        start = self.text.index('We propose')
        self.assertEqual(item['block_id'], 'block-1')
        self.assertEqual(item['start'], len(self.text[:start].encode('utf-16-le')) // 2)
        self.assertNotEqual(item['start'], start)
        self.assertEqual(item['end'] - item['start'], len(item['quote']))
        self.assertEqual(item['source'], 'manual')
        self.assertEqual(item['import_provider'], 'zotero')
        self.assertFalse(item['import_unanchored'])
        self.assertEqual(result['unanchored_count'], 0)
        self.assertEqual(result['notes_count'], 1)
        self.assertEqual(self.annotations(), json.loads((self.job / 'content/annotations/annotations.json').read_text()))
        self.assertEqual((self.job / 'notes.md').read_text(), (self.job / 'content/notes/notes.md').read_text())

    def test_page_and_coordinates_disambiguate_repeated_quotes(self):
        self.document([(1, 'first', self.text, [10, 20, 580, 90]), (1, 'second', self.text, [10, 300, 580, 350]), (2, 'other-page', self.text, [10, 20, 580, 90])])
        self.apply()
        self.assertEqual(self.annotations()[0]['block_id'], 'first')

    def test_fusion_normalized_boxes_use_the_pdf_coordinate_scale(self):
        self.document([(1, 'first', self.text, [10 / 600, 20 / 800, 580 / 600, 90 / 800]),
                       (1, 'other', self.text, [10 / 600, 300 / 800, 580 / 600, 350 / 800])])
        path = self.job / 'document.json'
        document = json.loads(path.read_text())
        for element in document['pages'][0]['elements']:
            element['coordinate_space'] = 'normalized'
        path.write_text(json.dumps(document))
        ir = self.job / 'document-ir.json'
        data = json.loads(ir.read_text())
        data['backend'] = 'guzi-fusion-auto-v3'
        ir.write_text(json.dumps(data))
        result = self.apply()
        self.assertEqual(self.annotations()[0]['block_id'], 'first')
        self.assertFalse(self.annotations()[0]['import_unanchored'])
        self.assertEqual(result['unanchored_count'], 0)

    def test_annotation_tags_preserve_comment_and_source_without_duplicate_append(self):
        package = self.package()
        original = package['annotations'][0]
        original['tags'] = ['待读', '重点', '待读']
        self.apply(package)
        item = self.annotations()[0]
        self.assertEqual(item['note'], 'Question\n\nZotero 标签：待读、重点')
        self.assertEqual(item['import_tags'], ['待读', '重点'])
        self.assertEqual(self.sidecar()['sources'][package['source_id']]['package']['annotations'][0], original)
        repeated = self.apply(package)
        self.assertEqual(repeated['annotations_count'], 0)
        self.assertEqual(self.annotations()[0]['note'].count('Zotero 标签：'), 1)
        self.document([(1, 'other', 'A different paragraph', [10, 20, 580, 90])])
        another = copy.deepcopy(package)
        another['annotations'][0]['key'] = 'UNANCHORED'
        self.apply(another)
        self.assertIn('Zotero 标签：待读、重点', (self.job / 'notes.md').read_text())

    def test_underline_and_normalized_whitespace_keep_rendered_quote(self):
        self.document([(1, 'first', 'Intro 😀 We  propose\na reliable method. More.', [10, 20, 580, 90])])
        package = self.package()
        package['annotations'][0]['type'] = 'underline'
        self.apply(package)
        item = self.annotations()[0]
        self.assertEqual(item['kind'], 'underline')
        self.assertEqual(item['quote'], 'We  propose\na reliable method.')
        self.assertIsNotNone(item['start'])

    def verified_anchor(self, rendered, native, query, selected, *, hyphens=(), page=1):
        glyphs = [{'text': char, 'bbox': [10 + index * 5, 30, 15 + index * 5, 40],
                   'line_hyphen': index in hyphens} for index, char in enumerate(native)]
        block = {'block_id': 'verified', 'page': str(page), 'text': rendered,
                 'bbox': [0, 0, 600, 800], 'fragments': []}
        geometry = {'width': 600, 'height': 800, 'pdf_width': 600, 'pdf_height': 800, '_pdf_glyphs': glyphs}
        start, end = selected
        annotation = {'text': query, 'position': {'pageIndex': page - 1,
                      'rects': [[10 + start * 5, 760, 10 + end * 5, 770]]}}
        return merge._anchor(annotation, [block], {str(page): geometry})

    def test_pdf_evidence_recovers_math_spacing_and_footnote_without_changing_dom_offsets(self):
        cases = [('gt:=maxs∈C⟨−∇f(xt),st−xt⟩, (4)', 'gt := max s∈C ⟨−∇f(xt), st − xt⟩,',
                  'max  s∈C ⟨−∇f (xt), st − xt⟩,'),
                 ('😀 unknown information 1.', '😀 unknown information1.', 'unknown information1.')]
        for rendered, native, query in cases:
            start = native.index('max') if 'max' in native else native.index('unknown')
            result = self.verified_anchor(rendered, native, query, (start, len(native)))
            self.assertIsNotNone(result)
            decoded = rendered.encode('utf-16-le')[result['start'] * 2:result['end'] * 2].decode('utf-16-le')
            self.assertEqual(decoded, result['quote'])
            self.assertIn('information 1' if 'information' in native else 'maxs∈C', result['quote'])
        no_proof = {'block_id': 'bare', 'page': '1', 'text': '−∇f(xt)', 'bbox': [0, 0, 600, 800]}
        self.assertIsNone(merge._anchor({'text': '−∇f (xt)', 'position': {'pageIndex': 0}}, [no_proof], {}))

    def test_pdf_evidence_resolves_second_short_word_only_at_the_selected_position(self):
        rendered = 'the top-k FW gap subsumes the original FW gap'
        second = rendered.rindex('gap')
        result = self.verified_anchor(rendered, rendered, 'gap', (second, second + 3))
        self.assertEqual(result['start'], second)
        self.assertEqual(result['quote'], 'gap')
        self.assertIsNone(self.verified_anchor(rendered, rendered, 'gap', (0, 3)))

    def test_pdf_proven_line_hyphen_is_optional_but_other_hyphens_and_math_operators_are_not(self):
        text = 'Frank-Wolfe'
        result = self.verified_anchor(text, text, 'FrankWolfe', (0, len(text)), hyphens=(5,))
        self.assertEqual(result['quote'], text)
        self.assertIsNone(self.verified_anchor(text, text, 'FrankWolfe', (0, len(text))))
        self.assertIsNone(self.verified_anchor('a−b', 'a−b', 'a-b', (0, 3)))
        self.assertIsNone(self.verified_anchor('ℓ(θ)', 'ℓ(θ)', 'l(θ)', (0, 4)))
        self.assertIsNone(self.verified_anchor('A ≠ B', 'A ≠ B', 'A = B', (0, 5)))

    def test_pdf_ligature_and_soft_hyphen_mapping_has_complete_character_boundaries(self):
        rendered = '😀 ﬃ soft\u00adhyphen'
        native = '😀 ffi softhyphen'
        result = self.verified_anchor(rendered, native, 'ffi softhyphen', (2, len(native)))
        self.assertEqual(result['quote'], 'ﬃ soft\u00adhyphen')
        self.assertEqual(result['start'], 3)
        self.assertIsNone(self.verified_anchor('ﬃ', 'ffi', 'fi', (1, 3)))

    def test_pdf_page_cache_reads_once_for_multiple_annotations(self):
        chars = [{'c': char, 'bbox': [index * 5, 30, index * 5 + 5, 40]} for index, char in enumerate('a-b')]
        from unittest.mock import MagicMock
        document = MagicMock()
        document.__enter__.return_value = document
        document.__getitem__.return_value.get_text.return_value = {'blocks': [{'lines': [{'spans': [{'chars': chars}]}]}]}
        runtime = MagicMock()
        runtime.open.return_value = document
        geometry = {'_pdf_path': 'source.pdf'}
        with patch('pymupdf_runtime.load_fitz', return_value=runtime):
            first = merge._pdf_glyphs(geometry, 1)
            second = merge._pdf_glyphs(geometry, 1)
        self.assertIs(first, second)
        runtime.open.assert_called_once_with('source.pdf')

    def test_line_break_hyphen_requires_alphabetic_words_in_consecutive_lines_of_one_pdf_block(self):
        from unittest.mock import MagicMock
        def line(text):
            return {'spans': [{'chars': [{'c': char, 'bbox': [index * 5, 30, index * 5 + 5, 40]}
                                        for index, char in enumerate(text)]}]}
        cases = [([{'lines': [line('Frank-'), line('Wolfe algorithm')]}], True),
                 ([{'lines': [line('a-'), line('b')]}], False),
                 ([{'lines': [line('term-')]}], False),
                 ([{'lines': [line('term-')]}, {'lines': [line('next word')]}], False),
                 ([{'lines': [line('term-'), line('∇f(x)')]}], False)]
        for blocks, expected in cases:
            document = MagicMock()
            document.__enter__.return_value = document
            document.__getitem__.return_value.get_text.return_value = {'blocks': blocks}
            runtime = MagicMock()
            runtime.open.return_value = document
            with patch('pymupdf_runtime.load_fitz', return_value=runtime):
                glyphs = merge._pdf_glyphs({'_pdf_path': 'source.pdf'}, 1)
            self.assertEqual(any(glyph['line_hyphen'] for glyph in glyphs), expected)

    def test_invalid_rectangles_do_not_turn_unanchored_import_into_an_exception(self):
        for rects in (None, {}, 'invalid'):
            annotation = {'text': 'max s', 'position': {'pageIndex': 0, 'rects': rects}}
            block = {'block_id': 'math', 'page': '1', 'text': 'maxs', 'bbox': [0, 0, 600, 800]}
            geometry = {'width': 600, 'height': 800, 'pdf_width': 600, 'pdf_height': 800}
            self.assertIsNone(merge._anchor(annotation, [block], {'1': geometry}))
            item = {'quote': annotation['text'], 'import_position': annotation['position']}
            self.assertIn('没有', merge._unanchored_reason(item, [block], {'1': geometry}))

    def test_image_formula_has_no_fake_text_anchor_and_an_explicit_persistent_reason(self):
        self.document([(1, 'formula', '', [10, 20, 580, 90])])
        self.apply()
        item = self.annotations()[0]
        self.assertTrue(item['import_unanchored'])
        self.assertIsNone(item['block_id'])
        self.assertIn('公式或图片原图', (self.job / 'notes.md').read_text())
        self.assertIn('公式或图片原图', item['import_unanchored_reason'])

    def test_new_and_legacy_unanchored_reasons_are_persistent_and_idempotent(self):
        package = self.package(annotations=[{'key': 'NOTE', 'version': 1, 'type': 'note', 'text': '',
                                            'comment': 'Keep note', 'position': {'pageIndex': 0}, 'page_label': '1'}])
        self.apply(package)
        notes = self.job / 'notes.md'
        self.assertIn('未定位原因：', notes.read_text())
        self.assertIn('没有选文', notes.read_text())
        old = notes.read_text().split('\n\n未定位原因：')[0]
        notes.write_text(old)
        data = self.sidecar()
        next(iter(data['sources'].values())).pop('unanchored_note_fingerprints')
        (self.job / 'zotero-import.json').write_text(json.dumps(data))
        items = self.annotations()
        items[0].pop('import_unanchored_reason')
        (self.job / 'annotations.json').write_text(json.dumps(items))
        result = self.apply(package)
        self.assertEqual(result['updated_fallback_notes_count'], 1)
        once = notes.read_text()
        self.assertIn('未定位原因：', once)
        self.assertEqual(self.apply(package)['updated_fallback_notes_count'], 0)
        self.assertEqual(notes.read_text(), once)

    def test_reason_upgrade_preserves_user_edited_legacy_fallback(self):
        self.document([(1, 'first', 'Other text', [10, 20, 580, 90])])
        self.apply()
        notes = self.job / 'notes.md'
        edited = notes.read_text().split('\n\n未定位原因：')[0] + '\nMy extra interpretation.'
        notes.write_text(edited)
        result = self.apply()
        self.assertEqual(result['updated_fallback_notes_count'], 0)
        self.assertEqual(notes.read_text(), edited)
        self.assertTrue(any('未定位' in warning for warning in result['warnings']))

    def test_repaired_dom_quote_keeps_legacy_snapshot_for_fallback_cleanup_after_interrupted_write(self):
        self.document([(1, 'first', 'Other text', [10, 20, 580, 90])])
        self.apply()
        sidecar = self.sidecar()
        next(iter(sidecar['sources'].values())).pop('unanchored_note_fingerprints')
        (self.job / 'zotero-import.json').write_text(json.dumps(sidecar))
        self.document([(1, 'first', 'We propose a reliable method .', [10, 20, 580, 90])])
        anchor = {'block_id': 'first', 'page': 1, 'quote': 'We propose a reliable method .', 'start': 0, 'end': 30,
                  'quote_prefix': '', 'quote_suffix': ''}
        original_write = merge._atomic_write
        def fail_notes(path, value):
            if path.name == 'notes.md':
                raise OSError('simulated interruption')
            return original_write(path, value)
        with patch.object(merge, '_anchor', return_value=anchor), patch.object(merge, '_atomic_write', side_effect=fail_notes), self.assertRaises(OSError):
            self.apply()
        self.assertEqual(self.annotations()[0]['import_fallback_quote'], self.package()['annotations'][0]['text'])
        result = self.apply()
        self.assertEqual(result['removed_fallback_notes_count'], 1)
        self.assertNotIn('zotero-unanchored:', (self.job / 'notes.md').read_text())

    def test_ambiguous_quote_is_preserved_as_unanchored_and_in_notes(self):
        self.document([(1, 'first', self.text, [10, 20, 580, 90]), (1, 'second', self.text, [10, 20, 580, 90])])
        result = self.apply()
        item = self.annotations()[0]
        self.assertIsNone(item['block_id'])
        self.assertIsNone(item['start'])
        self.assertEqual(item['quote'], self.package()['annotations'][0]['text'])
        self.assertEqual(item['import_position'], self.package()['annotations'][0]['position'])
        self.assertEqual(result['unanchored_count'], 1)
        self.assertIn('Zotero 未定位批注', (self.job / 'notes.md').read_text())
        self.assertIn('Question', (self.job / 'notes.md').read_text())

    def test_applied_legacy_source_reanchors_and_removes_only_unchanged_fallback(self):
        self.document([(1, 'first', self.text, [10, 20, 580, 90]), (1, 'second', self.text, [10, 20, 580, 90])])
        self.apply()
        sidecar = self.sidecar()
        entry = next(iter(sidecar['sources'].values()))
        entry.pop('unanchored_note_fingerprints', None)
        (self.job / 'zotero-import.json').write_text(json.dumps(sidecar))
        item = self.annotations()[0]
        item.update(note='User edited comment', color='#123456')
        ai = {'id': 'ai', 'kind': 'highlight', 'source': 'ai', 'quote': 'AI text', 'note': 'Keep AI'}
        (self.job / 'annotations.json').write_text(json.dumps([item, ai]))
        notes = self.job / 'notes.md'
        notes.write_text('User introduction\n\n' + notes.read_text())
        child_note = notes.read_text().split('<!-- zotero-unanchored:')[0]
        self.document([(1, 'first', self.text, [10, 20, 580, 90])])
        result = self.apply()
        self.assertEqual(result['resolved_annotations_count'], 1)
        self.assertEqual(result['removed_fallback_notes_count'], 1)
        self.assertEqual(result['current_unanchored_count'], 0)
        self.assertEqual(notes.read_text(), child_note)
        current = self.annotations()
        self.assertEqual(current[0]['note'], 'User edited comment')
        self.assertEqual(current[0]['color'], '#123456')
        self.assertEqual(current[0]['quote'], item['quote'])
        self.assertEqual(current[0]['block_id'], 'first')
        self.assertFalse(current[0]['import_unanchored'])
        self.assertEqual(current[1], ai)
        self.assertEqual(current, json.loads((self.job / 'content/annotations/annotations.json').read_text()))
        before_notes, before_annotations = notes.read_text(), current
        repeated = self.apply()
        self.assertEqual(repeated['resolved_annotations_count'], 0)
        self.assertEqual(repeated['removed_fallback_notes_count'], 0)
        self.assertEqual(notes.read_text(), before_notes)
        self.assertEqual(self.annotations(), before_annotations)

    def test_reanchoring_preserves_edited_fallback_and_user_text_after_it(self):
        self.document([(1, 'first', self.text, [10, 20, 580, 90]), (1, 'second', self.text, [10, 20, 580, 90])])
        self.apply()
        notes = self.job / 'notes.md'
        original = notes.read_text().replace('备注：\n\nQuestion', '备注：\n\nUser edited fallback') + '\n## My own section\nKeep this text.\n'
        notes.write_text(original)
        self.document([(1, 'first', self.text, [10, 20, 580, 90])])
        result = self.apply()
        self.assertEqual(result['resolved_annotations_count'], 1)
        self.assertEqual(result['removed_fallback_notes_count'], 0)
        self.assertEqual(notes.read_text(), original)
        self.assertTrue(any('用户改动' in warning for warning in result['warnings']))

    def test_user_append_after_unchanged_fallback_is_not_mistaken_for_a_removable_block(self):
        self.document([(1, 'first', self.text, [10, 20, 580, 90]), (1, 'second', self.text, [10, 20, 580, 90])])
        self.apply()
        notes = self.job / 'notes.md'
        original = notes.read_text() + '\nMy additional interpretation.\n'
        notes.write_text(original)
        self.document([(1, 'first', self.text, [10, 20, 580, 90])])
        self.apply()
        self.assertEqual(notes.read_text(), original)

    def test_reanchoring_after_upstream_change_uses_the_imported_snapshot(self):
        self.document([(1, 'first', self.text, [10, 20, 580, 90]), (1, 'second', self.text, [10, 20, 580, 90])])
        self.apply()
        sidecar = self.sidecar()
        next(iter(sidecar['sources'].values())).pop('unanchored_note_fingerprints', None)
        (self.job / 'zotero-import.json').write_text(json.dumps(sidecar))
        changed = self.package()
        changed['annotations'][0].update(comment='Upstream new comment', version=2)
        self.document([(1, 'first', self.text, [10, 20, 580, 90])])
        result = self.apply(changed)
        self.assertEqual(result['removed_fallback_notes_count'], 1)
        self.assertEqual(self.annotations()[0]['note'], 'Question')
        self.assertNotIn('zotero-unanchored:', (self.job / 'notes.md').read_text())

    def test_reanchor_cleanup_retries_after_annotation_commit_but_before_notes_write(self):
        self.document([(1, 'first', self.text, [10, 20, 580, 90]), (1, 'second', self.text, [10, 20, 580, 90])])
        self.apply()
        self.document([(1, 'first', self.text, [10, 20, 580, 90])])
        original_write = merge._atomic_write
        def fail_notes(path, value):
            if path.name == 'notes.md':
                raise OSError('simulated notes write failure')
            return original_write(path, value)
        with patch.object(merge, '_atomic_write', side_effect=fail_notes), self.assertRaises(OSError):
            self.apply()
        self.assertFalse(self.annotations()[0]['import_unanchored'])
        self.assertIn('zotero-unanchored:', (self.job / 'notes.md').read_text())
        result = self.apply()
        self.assertEqual(result['resolved_annotations_count'], 0)
        self.assertEqual(result['removed_fallback_notes_count'], 1)
        self.assertNotIn('zotero-unanchored:', (self.job / 'notes.md').read_text())

    def test_legacy_fallback_user_edit_is_not_erased_by_a_matching_new_upstream_comment(self):
        self.document([(1, 'first', self.text, [10, 20, 580, 90]), (1, 'second', self.text, [10, 20, 580, 90])])
        self.apply()
        sidecar = self.sidecar()
        next(iter(sidecar['sources'].values())).pop('unanchored_note_fingerprints', None)
        (self.job / 'zotero-import.json').write_text(json.dumps(sidecar))
        notes = self.job / 'notes.md'
        edited = notes.read_text().replace('备注：\n\nQuestion', '备注：\n\nUpstream new comment')
        notes.write_text(edited)
        changed = self.package()
        changed['annotations'][0].update(comment='Upstream new comment', version=2)
        self.document([(1, 'first', self.text, [10, 20, 580, 90])])
        result = self.apply(changed)
        self.assertEqual(result['removed_fallback_notes_count'], 0)
        self.assertEqual(notes.read_text(), edited)

    def test_cross_page_and_non_text_marks_are_preserved_without_fake_anchors(self):
        package = self.package()
        package['annotations'][0]['position']['nextPageRects'] = [[10, 20, 100, 50]]
        package['annotations'].append({'key': 'IMAGE', 'version': 1, 'type': 'image', 'text': '', 'comment': 'Inspect the image', 'page_label': '2', 'position': {'pageIndex': 1, 'rects': [[1, 1, 4, 4]]}})
        result = self.apply(package)
        self.assertEqual(result['unanchored_count'], 2)
        for item in self.annotations():
            self.assertTrue(item['import_anchor_disabled'])
            self.assertIsNone(item['block_id'])
        self.assertIn('Inspect the image', (self.job / 'notes.md').read_text())
        self.assertEqual(self.sidecar()['sources'][package['source_id']]['package'], package)

    def test_repeated_import_preserves_user_edits_and_deletions(self):
        package = self.package()
        self.apply(package)
        item = self.annotations()[0]
        item['note'] = 'User edited annotation'
        (self.job / 'annotations.json').write_text(json.dumps([item]))
        (self.job / 'notes.md').write_text('User replaced all notes')
        repeated = merge.stage_import(self.job, package)
        self.assertTrue(repeated['duplicate'])
        result = merge.apply_import(self.job, self.library, self.job_id)
        self.assertEqual(result['annotations_count'], 0)
        self.assertEqual((self.job / 'notes.md').read_text(), 'User replaced all notes')
        self.assertEqual(self.annotations()[0]['note'], 'User edited annotation')
        (self.job / 'annotations.json').write_text('[]')
        changed = copy.deepcopy(package)
        changed['notes'][0]['version'] = 2
        changed['notes'][0]['html'] = '<p>Changed upstream note</p>'
        changed['annotations'][0]['version'] = 2
        changed['annotations'][0]['comment'] = 'Changed upstream comment'
        self.apply(changed)
        self.assertEqual(self.annotations(), [])
        self.assertEqual((self.job / 'notes.md').read_text(), 'User replaced all notes')
        source = self.sidecar()['sources'][package['source_id']]
        self.assertEqual(source['history'][0]['package'], package)
        self.assertEqual(source['package'], changed)

    def test_new_note_keys_append_without_replacing_existing_imported_notes(self):
        package = self.package()
        self.apply(package)
        original = (self.job / 'notes.md').read_text()
        package['notes'].append({'key': 'SECOND', 'version': 1, 'html': '<p>Second note</p>'})
        result = self.apply(package)
        self.assertEqual(result['notes_count'], 1)
        self.assertTrue((self.job / 'notes.md').read_text().startswith(original))
        self.assertEqual((self.job / 'notes.md').read_text().count('Second note'), 1)

    def test_multiple_sources_keep_separate_annotation_ids_and_folder_membership(self):
        first = self.package()
        second = self.package(source_id='zotero:group:456:OTHER:PDF', library_id='group:456', item_key='OTHER')
        self.apply(first)
        self.apply(second)
        ids = [item['id'] for item in self.annotations()]
        self.assertEqual(len(ids), len(set(ids)))
        item = self.library.state['items'][self.job_id]
        self.assertEqual(len(item['folder_ids']), 2)
        folders = [folder for folder in self.library.state['folders'] if folder['id'] in item['folder_ids']]
        self.assertEqual([folder['name'] for folder in folders], ['待读', '待读'])
        self.assertNotEqual(folders[0]['parent_id'], folders[1]['parent_id'])
        self.assertEqual(self.library.find_zotero_source(second['source_id']), self.job_id)

    def test_metadata_keeps_user_fields_and_locks_imported_fields_against_refinement(self):
        self.library.update_metadata(self.job_id, {'fields': {'title': 'My title', 'authors': ['My author']}})
        self.library.update_item(self.job_id, {'values': {'research_topic': ['Local topic'], 'reading_status': '阅读中'}})
        self.apply()
        self.library.merge_metadata_result(self.job_id, {'fields': {'title': 'Parser title', 'year': 2024}, 'status': 'complete'})
        current = self.library.get_metadata(self.job_id)
        self.assertEqual(current['fields']['title'], 'My title')
        self.assertEqual(current['fields']['authors'], ['My author'])
        self.assertEqual(current['fields']['year'], 2025)
        self.assertEqual(current['sources']['year']['provider'], 'zotero')
        self.assertIn('doi', current['locked_fields'])
        item = self.library.state['items'][self.job_id]
        self.assertEqual(item['values']['research_topic'], ['Local topic'])
        self.assertEqual(item['values']['reading_status'], '阅读中')
        prop = next(prop for prop in self.library.state['properties'] if prop.get('import_field') == 'tags')
        self.assertEqual(prop['label'], 'Zotero 标签')
        self.assertEqual(item['values'][prop['id']], ['机器学习'])

    def test_renamed_tag_property_and_user_removed_tags_are_not_restored_on_repeat(self):
        package = self.package()
        self.apply(package)
        prop = next(prop for prop in self.library.state['properties'] if prop.get('import_field') == 'tags')
        self.library.update_property(prop['id'], {'label': 'My tags'})
        self.library.update_item(self.job_id, {'values': {prop['id']: []}, 'folder_ids': []})
        package['tags'].append('New tag')
        self.apply(package)
        item = self.library.state['items'][self.job_id]
        self.assertEqual(item['values'][prop['id']], ['New tag'])
        self.assertEqual(item['folder_ids'], [])
        reloaded = LibraryStore(self.root)
        self.assertEqual(reloaded.find_zotero_source(package['source_id']), self.job_id)
        self.assertEqual(next(prop for prop in reloaded.state['properties'] if prop.get('import_field') == 'tags')['label'], 'My tags')

    def test_stage_survives_restart_and_waits_until_conversion_completed(self):
        (self.job / 'job.json').write_text(json.dumps({'status': 'queued'}))
        package = self.package()
        merge.stage_import(self.job, package)
        self.library.import_zotero_metadata(self.job_id, package)
        restarted = LibraryStore(self.root)
        self.assertEqual(merge.apply_import(self.job, restarted, self.job_id)['status'], 'pending')
        self.assertFalse((self.job / 'annotations.json').exists())
        (self.job / 'job.json').write_text(json.dumps({'status': 'completed'}))
        result = merge.apply_import(self.job, restarted, self.job_id)
        self.assertEqual(result['annotations_count'], 1)
        self.assertEqual(result['notes_count'], 1)

    def test_crash_before_final_sidecar_commit_does_not_duplicate_content_on_resume(self):
        merge.stage_import(self.job, self.package())
        original_write = merge._atomic_write
        def interrupted(path, value):
            if path.name == 'zotero-import.json':
                raise OSError('simulated interrupted final commit')
            return original_write(path, value)
        with patch('zotero_merge._atomic_write', side_effect=interrupted):
            with self.assertRaises(OSError):
                merge.apply_import(self.job, self.library, self.job_id)
        notes = (self.job / 'notes.md').read_text()
        merge.apply_import(self.job, LibraryStore(self.root), self.job_id)
        self.assertEqual(len(self.annotations()), 1)
        self.assertEqual((self.job / 'notes.md').read_text(), notes)

    def test_raw_oversized_notes_and_annotations_remain_in_sidecar_with_warnings(self):
        package = self.package()
        package['notes'][0]['html'] = '<p>' + 'x' * 3000 + '</p>'
        package['annotations'][0]['comment'] = 'y' * 15000
        with patch.object(merge, 'MAX_NOTES_CHARS', 1500):
            result = self.apply(package)
        self.assertGreater(result['truncated_count'], 0)
        self.assertTrue(result['warnings'])
        self.assertLessEqual(len((self.job / 'notes.md').read_text()), 1500)
        self.assertLessEqual(len(self.annotations()[0]['note']), 10000)
        self.assertIn('完整原文', self.annotations()[0]['note'])
        self.assertEqual(self.sidecar()['sources'][package['source_id']]['package'], package)

    def test_full_user_notes_are_never_shortened_to_fit_import(self):
        existing = 'User text' * 100
        (self.job / 'notes.md').write_text(existing)
        with patch.object(merge, 'MAX_NOTES_CHARS', len(existing)):
            result = self.apply()
        self.assertEqual((self.job / 'notes.md').read_text(), existing)
        self.assertEqual(result['notes_count'], 0)
        self.assertGreater(result['truncated_count'], 0)

    def test_html_conversion_has_safe_links_basic_formatting_and_explicit_asset_fallbacks(self):
        text, warnings = merge.html_to_markdown('<h1>Title</h1><p><strong>Bold</strong> and <em>italic</em><br>line</p><ul><li>One</li><li>Two</li></ul><a href="https://example.test/a?q=(ok)">Safe</a><a href="zotero://note/ABC">Zotero note</a><a href="javascript:alert(1)">Bad</a><a href="http://[invalid">Malformed</a><script>alert("unsafe")</script><style>body{display:none}</style><img src="https://remote.test/a.png" alt="Chart"><table><tr><td>A</td><td>B</td></tr></table>&lt;script&gt;literal&lt;/script&gt;')
        self.assertIn('# Title', text)
        self.assertIn('**Bold**', text)
        self.assertIn('*italic*', text)
        self.assertIn('- One', text)
        self.assertIn('[Safe](https://example.test/a?q=%28ok%29)', text)
        self.assertIn('Zotero note（链接未导入', text)
        self.assertIn('图片未导入：Chart', text)
        self.assertIn('表格仅保留文本', text)
        self.assertIn(' | A | B', text)
        self.assertNotIn('javascript:', text)
        self.assertNotIn('unsafe', text)
        self.assertNotIn('display:none', text)
        self.assertNotIn('<script>', text)
        self.assertTrue(warnings)

    def test_corrupt_existing_sidecar_is_never_overwritten(self):
        (self.job / 'zotero-import.json').write_text('{broken')
        with self.assertRaisesRegex(ValueError, '停止 Zotero 合并'):
            merge.stage_import(self.job, self.package())
        self.assertEqual((self.job / 'zotero-import.json').read_text(), '{broken')


if __name__ == '__main__':
    unittest.main()
