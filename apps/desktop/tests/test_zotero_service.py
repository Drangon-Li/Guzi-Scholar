from __future__ import annotations

import copy
import hashlib
import json
import sys
import tempfile
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
from job_store import JobStore
from library_store import LibraryStore
from zotero_import import ZoteroError
from zotero_service import ZoteroImports, merge_import_warnings, validate_import_request


def request():
    return {"library": "user:0", "items": [{"item_key": "ITEM1", "attachment_key": "PDF1"}], "folder_id": ""}


class BatchTest(unittest.TestCase):
    def test_current_anchor_warnings_replace_history_without_losing_other_import_warnings(self):
        stale = [f'批注 KEY{index} 未定位：旧原因' for index in range(10)]
        historical = ['笔记 NOTE 超过阅读器笔记上限，完整 HTML 已保留。',
                      '批注 KEY1 有新的 Zotero 内容；已保留当前批注，新版本原文保存在导入记录。']
        current = [f'批注 KEY{index} 未定位：当前原因' for index in range(3)]
        recovered_edited = '批注 KEY7 已定位，其备用笔记含用户改动或额外内容，已保留。'
        old_edited = '批注 KEY8 的备用笔记含用户改动或额外内容，未覆盖；未定位原因见导入提示。'
        merged = merge_import_warnings([*stale, *historical, old_edited, recovered_edited], [*current, recovered_edited])
        self.assertEqual(merged, [*historical, *current, recovered_edited])
        self.assertEqual(merge_import_warnings(merged, current), [*historical, *current])
        self.assertEqual(merge_import_warnings(merged, [*current, recovered_edited]), merged)

    def test_validation_rejects_paths_unknown_fields_and_oversized_batches(self):
        for invalid in ({**request(), "url": "http://example.com"}, {**request(), "library": "../../"},
                        {**request(), "items": []}, {**request(), "items": request()["items"] * 101},
                        {**request(), "items": [{"item_key": "../secret", "attachment_key": "PDF1"}]},
                        {**request(), "folder_id": []}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_import_request(invalid)
        self.assertEqual(len(validate_import_request({**request(), "items": request()["items"] * 2})["items"]), 1)

    def test_partial_failure_keeps_other_results_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            manager = ZoteroImports(Path(temporary))
            done = threading.Event()
            selection = request()
            selection["items"].append({"item_key": "ITEM2", "attachment_key": "PDF2"})

            def importer(_library, item, _folder):
                if item["item_key"] == "ITEM1":
                    raise ZoteroError("附件尚未下载到本机")
                return {**item, "status": "imported", "job_id": "a" * 16, "pending": True}

            initial = manager.submit(selection, importer, on_finish=done.set)
            self.assertTrue(done.wait(5))
            manager.thread.join(5)
            batch = ZoteroImports(Path(temporary)).get(initial["id"])
            self.assertEqual(batch["status"], "completed")
            self.assertEqual(batch["completed"], 2)
            self.assertEqual([item["status"] for item in batch["results"]], ["failed", "imported"])

    def test_concurrent_batch_is_rejected_and_interrupted_batch_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            manager = ZoteroImports(Path(temporary))
            entered, release, done = threading.Event(), threading.Event(), threading.Event()

            def importer(*_args):
                entered.set()
                release.wait(5)
                return {"status": "imported"}

            initial = manager.submit(request(), importer, on_finish=done.set)
            self.assertTrue(entered.wait(5))
            try:
                with self.assertRaisesRegex(ValueError, "正在进行"):
                    manager.submit(request(), importer, on_finish=lambda: None)
                # Read the durable snapshot as a fresh process would.
                recovered = ZoteroImports(Path(temporary)).get(initial["id"])
                self.assertEqual(recovered["status"], "failed")
                self.assertIn("中断", recovered["error"])
            finally:
                release.set()
                self.assertTrue(done.wait(5))
                manager.thread.join(5)
            with self.assertRaises(KeyError):
                manager.get("../../settings")


class ServerImportTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.store = JobStore(self.root / "jobs")
        self.library = LibraryStore(self.root)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(server, "STORE", self.store))
        self.stack.enter_context(patch.object(server, "LIBRARY", self.library))
        self.queue = self.stack.enter_context(patch.object(server, "CONVERSION_QUEUE"))
        self.client = self.stack.enter_context(patch.object(server, "ZoteroClient")).return_value
        self.package = {
            "source_id": "zotero:user:42:ITEM1:PDF1", "library_id": "user:42", "item_key": "ITEM1", "attachment_key": "PDF1", "title": "Imported title",
            "metadata": {"title": "Imported title", "authors": ["Ada"], "year": "2025"},
            "tags": ["研究"], "collections": [], "notes": [{"key": "NOTE1", "version": 1, "html": "<p>Imported note</p>"}],
            "annotations": [{"key": "MARK1", "version": 1, "type": "underline", "text": "Unavailable quote", "comment": "Comment", "color": "#ff0000", "page_label": "2", "position": {"pageIndex": 1}}],
        }
        self.client.fetch_document.side_effect = lambda *_: copy.deepcopy(self.package)

        def download(_library, _attachment, destination):
            data = b"%PDF-1.7\nSynthetic PDF for queue tests\n"
            destination.write_bytes(data)
            return {"filename": "paper.pdf", "byte_size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

        self.client.download_pdf.side_effect = download

    def import_one(self):
        return server._import_zotero_document("user:0", request()["items"][0], "")

    def test_stages_before_queue_and_merges_after_conversion_without_duplicate_content(self):
        result = self.import_one()
        self.assertEqual(result["status"], "imported")
        self.assertTrue(result["pending"])
        record = self.store.get(result["job_id"])
        directory = Path(record["job_dir"])
        self.assertTrue((directory / "zotero-import.json").is_file())
        self.assertFalse((directory / "notes.md").exists())
        self.assertEqual(self.library.get_metadata(record["job_id"])["fields"]["title"], "Imported title")
        self.queue.put.assert_called_once()
        self.store.update(record["job_id"], status="completed")
        (directory / "document.json").write_text(json.dumps({"pages": []}))
        merged = server._apply_zotero_pending(record["job_id"])
        self.assertFalse(merged["pending"])
        self.assertEqual(merged["notes_count"], 1)
        self.assertEqual(merged["unanchored_count"], 1)
        before = (directory / "notes.md").read_text()
        self.assertIn("Imported note", before)
        self.assertIn("Unavailable quote", before)
        repeated = self.import_one()
        self.assertEqual(repeated["status"], "existing")
        self.assertFalse(repeated["pending"])
        self.assertEqual((directory / "notes.md").read_text(), before)
        self.assertEqual(self.client.download_pdf.call_count, 2)
        self.assertEqual(len(self.store.list()), 1)

    def test_changed_pdf_for_same_source_is_reported_without_merging_new_annotations(self):
        first = self.import_one()
        job_id = first["job_id"]
        directory = Path(self.store.get(job_id)["job_dir"])
        original_sidecar = (directory / "zotero-import.json").read_text()
        self.package["annotations"][0]["text"] = "Only present in changed PDF"

        def changed_pdf(_library, _attachment, destination):
            data = b"%PDF-1.7\nChanged source\n"
            destination.write_bytes(data)
            return {"filename": "paper.pdf", "byte_size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

        self.client.download_pdf.side_effect = changed_pdf
        result = self.import_one()
        self.assertEqual(result["status"], "skipped")
        self.assertIn("PDF 已变化", result["error"])
        self.assertEqual((directory / "zotero-import.json").read_text(), original_sidecar)
        self.assertEqual(len(self.store.list()), 1)
        self.assertEqual(list(self.store.incoming_root.iterdir()), [])

    def test_reimport_requeues_failed_conversion_using_the_same_job(self):
        first = self.import_one()
        self.store.update(first["job_id"], status="failed", error="SSH 隧道连接超时。")
        directory = Path(self.store.get(first["job_id"])["job_dir"])
        (directory / "error.json").write_text(json.dumps({"error": "SSH 隧道连接超时。"}))
        with patch.object(server, "_zotero_imports") as manager:
            manager.return_value.get.return_value = {"id": "b" * 32, "status": "completed", "results": [first]}
            failed = server._zotero_batch_status("b" * 32)["results"][0]
        self.assertIn("从 Zotero 导入", failed["error"])
        self.assertNotIn("文献库中重试", failed["error"])
        self.queue.reset_mock()
        repeated = self.import_one()
        self.assertEqual(repeated["job_id"], first["job_id"])
        self.assertEqual(repeated["status"], "existing")
        record = self.store.get(first["job_id"])
        self.assertEqual(record["status"], "queued")
        self.assertEqual(record["error"], "")
        self.assertFalse((directory / "error.json").exists())
        self.assertEqual(len(self.store.list()), 1)
        self.queue.put.assert_called_once_with((first["job_id"], "paper.pdf"))
        self.assertTrue(repeated["pending"])
        self.assertNotIn("error", repeated)

    def test_same_pdf_from_another_source_preserves_both_sources_and_notes(self):
        first = self.import_one()
        self.package["source_id"] = "zotero:group:7:ITEM2:PDF2"
        self.package["library_id"] = "group:7"
        self.package["notes"][0]["html"] = "<p>Second source</p>"
        second = self.import_one()
        self.assertEqual(second["job_id"], first["job_id"])
        self.assertEqual(second["status"], "existing")
        self.store.update(first["job_id"], status="completed")
        directory = Path(self.store.get(first["job_id"])["job_dir"])
        (directory / "document.json").write_text(json.dumps({"pages": []}))
        server._apply_zotero_pending(first["job_id"])
        notes = (directory / "notes.md").read_text()
        self.assertIn("Imported note", notes)
        self.assertIn("Second source", notes)
        self.assertEqual(len(self.library.state["items"][first["job_id"]]["zotero_sources"]), 2)

    def test_reimport_repairs_applied_anchor_status_without_losing_import_counts(self):
        first = self.import_one()
        job_id = first['job_id']
        directory = Path(self.store.get(job_id)['job_dir'])
        self.store.update(job_id, status='completed')
        (directory / 'document.json').write_text(json.dumps({'pages': []}))
        initial = server._apply_zotero_pending(job_id)
        self.assertEqual(initial['unanchored_count'], 1)
        self.assertTrue(any('未定位：' in warning for warning in initial['warnings']))
        saved = json.loads((directory / 'zotero-status.json').read_text())
        saved['warnings'].append('笔记图片未下载，原始资源引用已保留。')
        (directory / 'zotero-status.json').write_text(json.dumps(saved))
        self.assertIn('zotero-unanchored:', (directory / 'notes.md').read_text())
        (directory / 'document.json').write_text(json.dumps({'pages': [{'page': 2, 'width': 600, 'height': 800, 'elements': [
            {'block_id': 'resolved', 'text': 'Unavailable quote', 'bbox': [10, 20, 580, 90]},
        ]}]}))
        (directory / 'document.html').write_text('<p data-block-id="resolved" data-page="2" data-bbox="[10,20,580,90]">Unavailable quote</p>')
        repeated = self.import_one()
        self.assertEqual(repeated['job_id'], job_id)
        self.assertEqual(repeated['annotations_count'], 1)
        self.assertEqual(repeated['notes_count'], 1)
        self.assertEqual(repeated['unanchored_count'], 0)
        self.assertEqual(repeated['resolved_annotations_count'], 1)
        self.assertEqual(repeated['removed_fallback_notes_count'], 1)
        self.assertEqual(repeated['warnings'], ['笔记图片未下载，原始资源引用已保留。'])
        self.assertNotIn('zotero-unanchored:', (directory / 'notes.md').read_text())
        annotation = json.loads((directory / 'annotations.json').read_text())[0]
        self.assertEqual(annotation['block_id'], 'resolved')
        self.assertFalse(annotation['import_unanchored'])
        source = next(iter(json.loads((directory / 'zotero-import.json').read_text())['sources'].values()))
        self.assertEqual(source['summary']['unanchored_count'], 0)
        self.assertEqual(self.import_one()['warnings'], repeated['warnings'])

    def test_failed_merge_does_not_fail_pdf_and_can_recover_after_restart(self):
        result = self.import_one()
        job_id = result["job_id"]
        self.store.update(job_id, status="completed")
        directory = Path(self.store.get(job_id)["job_dir"])
        (directory / "document.json").write_text(json.dumps({"pages": []}))
        with patch.object(server, "apply_zotero_import", side_effect=OSError("disk temporarily unavailable")):
            pending = server._apply_zotero_pending(job_id)
        self.assertTrue(pending["pending"])
        self.assertIn("暂未合并", pending["error"])
        self.assertEqual(self.store.get(job_id)["status"], "completed")
        (directory / "manifest.json").write_text(json.dumps({"source": {"filename": "paper.pdf"}}))
        with patch.object(server, "STORE", JobStore(self.root / "jobs")), patch.object(server, "LIBRARY", LibraryStore(self.root)):
            recovered = server._apply_zotero_pending(job_id)
        self.assertFalse(recovered["pending"])
        self.assertNotIn("error", recovered)
        stale = {"id": "b" * 32, "status": "completed", "results": [{**result, **pending}]}
        with patch.object(server, "_zotero_imports") as manager:
            manager.return_value.get.return_value = stale
            polled = server._zotero_batch_status(stale["id"])
        self.assertFalse(polled["results"][0]["pending"])
        self.assertNotIn("error", polled["results"][0])

    def test_partial_repair_replaces_ten_stale_reasons_with_three_current_reasons_on_every_reimport(self):
        original = self.package['annotations'][0]
        self.package['annotations'] = [{**original, 'key': f'MARK{index}', 'text': f'Unique quote {index}.'} for index in range(10)]
        first = self.import_one()
        job_id = first['job_id']
        directory = Path(self.store.get(job_id)['job_dir'])
        self.store.update(job_id, status='completed')
        (directory / 'document.json').write_text(json.dumps({'pages': []}))
        initial = server._apply_zotero_pending(job_id)
        self.assertEqual(len(initial['warnings']), 10)
        (directory / 'document.json').write_text(json.dumps({'pages': [{'page': 2, 'width': 600, 'height': 800, 'elements': [
            {'block_id': f'resolved-{index}', 'text': f'Unique quote {index}.', 'bbox': [10, 20, 580, 90]} for index in range(7)
        ]}]}))
        for _ in range(2):
            repeated = self.import_one()
            self.assertEqual(repeated['unanchored_count'], 3)
            self.assertEqual(repeated['notes_count'], 1)
            self.assertEqual(repeated['annotations_count'], 10)
            self.assertEqual(len(repeated['warnings']), 3)
            self.assertTrue(all(f'批注 MARK{index} 未定位：' in warning for index, warning in zip(range(7, 10), repeated['warnings'], strict=True)))
            saved = json.loads((directory / 'zotero-status.json').read_text())
            self.assertEqual(saved['warnings'], repeated['warnings'])
        stale = {'id': 'b' * 32, 'status': 'completed', 'results': [{**first, **initial}]}
        with patch.object(server, '_zotero_imports') as manager:
            manager.return_value.get.return_value = stale
            polled = server._zotero_batch_status(stale['id'])
        self.assertEqual(polled['results'][0]['warnings'], repeated['warnings'])

    def test_status_readonly_validation_and_async_migration_lifetime(self):
        handler = object.__new__(server.ScholarHandler)
        sent, errors = [], []
        handler._send_json = lambda body, *_: sent.append(body)
        handler._send_error_json = lambda error, *_: errors.append(error)
        with patch.object(server.runtime, "READONLY_MODE", True):
            handler._get_zotero("/api/integrations/zotero/status", {})
        self.client.status.assert_not_called()
        self.assertTrue(errors)
        self.client.status.side_effect = ZoteroError("请打开 Zotero 并启用本机 API")
        handler._get_zotero("/api/integrations/zotero/status", {})
        self.assertFalse(sent[-1]["available"])
        manager = ZoteroImports(self.root / "batches")
        handler._read_json_body = lambda **_: request()
        entered, release = threading.Event(), threading.Event()

        def importer(*_):
            entered.set()
            release.wait(5)
            return {"status": "imported"}

        with patch.object(server, "ZOTERO_IMPORTS", manager), patch.object(server, "_import_zotero_document", side_effect=importer):
            before = server.MIGRATION_ACTIVE_MUTATIONS
            handler._start_zotero_import()
            self.assertTrue(entered.wait(5))
            try:
                self.assertEqual(server.MIGRATION_ACTIVE_MUTATIONS, before + 1)
            finally:
                release.set()
                manager.thread.join(5)
            self.assertEqual(server.MIGRATION_ACTIVE_MUTATIONS, before)


if __name__ == "__main__":
    unittest.main()
