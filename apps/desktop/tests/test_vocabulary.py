from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
from library_store import LibraryStore
from vocabulary_store import VocabularyStorageError, VocabularyStore, VocabularyValidationError, source_snapshot


class VocabularyStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="guzi-vocabulary-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "library"
        self.store = VocabularyStore(self.root)
        self.source = {"job_id": "a" * 16, "quote": "A method improves the result.", "surface": "source", "start": 2, "end": 8}

    def add(self, term="method", **kwargs):
        return self.store.add({"term": term, **kwargs}, self.source)

    def test_empty_read_and_constructor_never_create_files(self):
        self.assertEqual(self.store.list(), [])
        self.assertFalse(self.root.exists())

    def test_normalized_duplicate_merges_sources_preserving_user_data(self):
        entry, created = self.add("Ｍｅｔｈｏｄ", language="EN", meaning="方法", tags=["研究"])
        self.assertTrue(created)
        self.store.update(entry["id"], {"note": "my note"})
        self.store.review(entry["id"], {"status": "mastered"})
        second = {**self.source, "job_id": "b" * 16}
        duplicate, created = self.store.add({"term": "METHOD", "language": "en", "meaning": "overwrite", "tags": ["other"]}, second)
        self.assertFalse(created)
        self.assertEqual(duplicate["id"], entry["id"])
        self.assertEqual(duplicate["meaning"], "方法")
        self.assertEqual(duplicate["tags"], ["研究"])
        self.assertEqual(duplicate["note"], "my note")
        self.assertEqual(duplicate["review"]["status"], "mastered")
        self.assertEqual(len(duplicate["sources"]), 2)
        self.assertEqual(self.store.add({"term": "method", "language": "en"}, second)[0]["sources"], duplicate["sources"])
        self.assertTrue(self.add("method", language="fr")[1])
        self.assertEqual(len(VocabularyStore(self.root).list()), 2)
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.store.backup_path.stat().st_mode & 0o777, 0o600)

    def test_repeated_selection_ignores_casing_and_title_changes(self):
        source = {**self.source, "selected_text": "Method", "title": "old"}
        entry, _ = self.store.add({"term": "Method"}, source)
        duplicate, _ = self.store.add({"term": "method"}, {**source, "selected_text": "method", "title": "new"})
        self.assertEqual(len(duplicate["sources"]), 1)
        self.assertEqual(entry["id"], duplicate["id"])

    def test_validation_prevents_paragraph_and_invalid_fields(self):
        for term in ("", "a" * 121, "method\nparagraph", "method\rparagraph", 3):
            with self.subTest(term=term), self.assertRaises(VocabularyValidationError):
                self.add(term)
        with self.assertRaises(VocabularyValidationError):
            self.add(tags="tag")
        with self.assertRaises(VocabularyValidationError):
            self.add(language="../en")
        self.assertFalse(self.root.exists())

    def test_conditional_meaning_update_does_not_overwrite_user_edits(self):
        entry, _ = self.add()
        entry_id = entry["id"]
        self.assertEqual(self.store.update(entry_id, {"meaning": "自动释义", "only_if_meaning_empty": True})["meaning"], "自动释义")
        self.store.update(entry_id, {"meaning": "手动释义", "tags": ["tag", "tag"], "note": "note"})
        entry = self.store.update(entry_id, {"meaning": "迟到的释义", "only_if_meaning_empty": True})
        self.assertEqual(entry["meaning"], "手动释义")
        self.assertEqual(entry["tags"], ["tag"])
        self.assertEqual(entry["note"], "note")
        with self.assertRaises(VocabularyValidationError):
            self.store.update(entry_id, {"review": {"status": "mastered"}})

    def test_review_counts_and_delete_persist_and_missing_id_raises(self):
        entry, _ = self.add()
        entry_id = entry["id"]
        for count, status in enumerate(("learning", "mastered", "learning"), 1):
            entry = self.store.review(entry_id, {"status": status})
            self.assertEqual(entry["review"]["status"], status)
            self.assertEqual(entry["review"]["review_count"], count)
            self.assertTrue(entry["review"]["last_reviewed_at"])
        self.assertEqual(VocabularyStore(self.root).list()[0]["review"]["review_count"], 3)
        with self.assertRaises(VocabularyValidationError):
            self.store.review(entry_id, {"status": "new"})
        self.store.delete(entry_id)
        self.assertEqual(VocabularyStore(self.root).list(), [])
        with self.assertRaises(KeyError):
            self.store.delete(entry_id)

    def test_details_are_optional_merge_and_preserve_manual_edits(self):
        entry, _ = self.add(meaning="用户释义")
        self.assertNotIn("details", self.store.get(entry["id"]))
        result = self.store.update(entry["id"], {"details": {"part_of_speech": "名词", "meanings": "方法"}, "only_if_details_empty": True})
        self.assertEqual(result["meaning"], "用户释义")
        result = self.store.update(entry["id"], {"details": {"meanings": "用户修改"}})
        self.assertEqual(result["details"]["part_of_speech"], "名词")
        result = self.store.update(entry["id"], {"details": {"meanings": "迟到的 AI"}, "only_if_details_empty": True})
        self.assertEqual(result["details"]["meanings"], "用户修改")
        self.assertEqual(VocabularyStore(self.root).get(entry["id"])["details"], result["details"])
        for details in ([], {"unknown": "x"}, {"examples": ["x"]}, {"meanings": "x" * 6001}):
            with self.subTest(details_type=type(details)), self.assertRaises(VocabularyValidationError):
                self.store.update(entry["id"], {"details": details})
        self.store.delete(entry["id"])
        with self.assertRaises(KeyError):
            self.store.update(entry["id"], {"details": {"meanings": "迟到的 AI"}, "only_if_details_empty": True})
        self.assertEqual(VocabularyStore(self.root).list(), [])

    def test_failed_replace_keeps_disk_and_memory_data_and_cleans_temporary_files(self):
        entry, _ = self.add(meaning="original")
        initial = self.store.path.read_bytes()
        original_replace = __import__("os").replace
        def replace(source, destination):
            if destination == self.store.path:
                raise OSError("disk unavailable")
            return original_replace(source, destination)
        with patch("vocabulary_store.os.replace", side_effect=replace), self.assertRaises(OSError):
            self.store.update(entry["id"], {"meaning": "lost"})
        self.assertEqual(self.store.path.read_bytes(), initial)
        self.assertEqual(self.store.list()[0]["meaning"], "original")
        self.assertEqual(list(self.root.glob(".*.tmp")), [])
        self.assertEqual(json.loads(self.store.backup_path.read_text())["entries"][0]["meaning"], "original")

    def test_backup_failure_does_not_modify_primary(self):
        entry, _ = self.add(meaning="original")
        with patch.object(self.store, "_atomic_write", side_effect=OSError("backup failed")), self.assertRaises(OSError):
            self.store.update(entry["id"], {"meaning": "lost"})
        self.assertEqual(self.store.list()[0]["meaning"], "original")

    def test_corrupt_primary_recovers_backup_without_get_writes(self):
        entry, _ = self.add(meaning="original")
        self.store.update(entry["id"], {"meaning": "new"})
        self.store.path.write_text("broken", encoding="utf-8")
        self.assertEqual(self.store.list()[0]["meaning"], "original")
        self.assertEqual(self.store.path.read_text(), "broken")
        self.store.update(entry["id"], {"note": "recovered"})
        self.assertEqual(self.store.list()[0]["note"], "recovered")
        self.assertEqual(json.loads(self.store.backup_path.read_text())["entries"][0]["meaning"], "original")

    def test_malformed_entry_recovers_backup_before_mutation(self):
        entry, _ = self.add(meaning="original")
        self.store.update(entry["id"], {"note": "note"})
        data = json.loads(self.store.path.read_text())
        data["entries"][0]["review"] = {}
        self.store.path.write_text(json.dumps(data))
        self.assertEqual(self.store.list()[0]["meaning"], "original")
        self.assertEqual(self.store.review(entry["id"], {"status": "learning"})["review"]["review_count"], 1)

    def test_unrecoverable_data_is_not_overwritten(self):
        self.root.mkdir()
        self.store.path.write_text("broken")
        with self.assertRaises(VocabularyStorageError):
            self.add()
        self.assertEqual(self.store.path.read_text(), "broken")

    def test_concurrent_duplicate_adds_and_reviews_have_no_lost_updates(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.add(), range(12)))
        self.assertEqual(sum(created for _, created in results), 1)
        entry_id = results[0][0]["id"]
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _: self.store.review(entry_id, {"status": "learning"}), range(12)))
        self.assertEqual(self.store.list()[0]["review"]["review_count"], 12)

    def test_source_snapshot_owns_document_identity_and_preserves_quote(self):
        record = {"job_id": "a" * 16, "source_filename": "paper.pdf", "source_sha256": "trusted"}
        source = source_snapshot({**self.source, "title": "forged", "source_sha256": "forged", "block_id": "b1", "source_block_id": "s1", "page": 1, "render_generation": "base", "quote_prefix": "A ", "quote_suffix": " improves"}, record, "method", "Paper title")
        self.assertEqual(source["source_sha256"], "trusted")
        self.assertEqual(source["title"], "Paper title")
        self.assertEqual(source["quote"], self.source["quote"])
        self.assertEqual(source["selected_text"], "method")
        self.assertEqual(source["source_block_id"], "s1")
        self.assertEqual(source["quote_prefix"], "A ")
        with self.assertRaises(VocabularyValidationError):
            source_snapshot({**self.source, "end": 1}, record, "method")


class VocabularyApiTest(unittest.TestCase):
    def setUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix="guzi-vocabulary-api-")))
        self.store = server.JobStore(self.root / "jobs")
        self.library = LibraryStore(self.root)
        self.record = self.store.create("trusted-paper.pdf", 20)
        self.library.sync_jobs(self.store.list())
        self.library.update_metadata(self.record["job_id"], {"fields": {"title": "Trusted paper title"}})
        self.vocabulary = VocabularyStore(self.root)
        for name, value in (("STORE", self.store), ("LIBRARY", self.library), ("VOCABULARY", self.vocabulary), ("LIBRARY_ROOT", self.root), ("MIGRATION_QUIESCING", False)):
            self.resources.enter_context(patch.object(server, name, value))
        self.resources.enter_context(patch.object(server.runtime, "READONLY_MODE", False))
        self.resources.enter_context(patch.object(server.runtime, "AI_REQUIRES_MEMBER", False))
        self.resources.enter_context(patch.object(server.runtime, "API_ACCESS_TOKEN", "token"))

    def request(self, verb, path="/api/vocabulary", payload=None, token="token", host="127.0.0.1:8135"):
        handler = object.__new__(server.ScholarHandler)
        handler.path = path
        handler.headers = {"Host": host, "X-My-Scholar-Api-Token": token}
        handler.server = SimpleNamespace(server_address=("127.0.0.1", 8135))
        handler._read_json_body = lambda **kwargs: payload
        responses, errors = [], []
        handler._send_json = lambda body, status=200, **kwargs: responses.append((body, int(status)))
        handler._send_error_json = lambda message, status=400, **kwargs: errors.append((message, int(status)))
        getattr(handler, f"do_{verb}")()
        return responses, errors

    def add(self, **source_overrides):
        return self.request("POST", payload={"term": "method", "source": {"job_id": self.record["job_id"], "quote": "A method improves results.", "title": "forged", **source_overrides}})

    def test_api_crud_review_and_backend_source_metadata(self):
        responses, errors = self.add()
        self.assertEqual(errors, [])
        entry = responses[0][0]["entry"]
        self.assertTrue(responses[0][0]["created"])
        self.assertEqual(entry["sources"][0]["title"], "Trusted paper title")
        self.assertEqual(entry["sources"][0]["source_filename"], "trusted-paper.pdf")
        path = f'/api/vocabulary/{entry["id"]}'
        self.assertEqual(self.request("PATCH", path, {"meaning": "方法"})[0][0][0]["entry"]["meaning"], "方法")
        self.assertEqual(self.request("PATCH", path, {"meaning": "override", "only_if_meaning_empty": True})[0][0][0]["entry"]["meaning"], "方法")
        self.assertEqual(self.request("POST", path + "/review", {"status": "learning"})[0][0][0]["entry"]["review"]["review_count"], 1)
        self.assertEqual(len(self.request("GET")[0][0][0]["entries"]), 1)
        self.assertEqual(self.request("DELETE", path)[0][0][0], {"ok": True})
        self.assertEqual(self.request("DELETE", path)[1][0][1], 404)

    def test_missing_or_invalid_document_cannot_be_saved_and_old_sources_survive(self):
        self.assertEqual(self.add(job_id="b" * 16)[1][0][1], 404)
        self.assertEqual(self.add(job_id="../escape")[1][0][1], 400)
        self.assertFalse(self.vocabulary.path.exists())
        self.assertEqual(self.add()[1], [])
        with patch.object(server, "STORE", SimpleNamespace(get=lambda _: None)):
            self.assertEqual(len(self.request("GET")[0][0][0]["entries"]), 1)

    def test_get_without_vocabulary_file_does_not_create_it(self):
        self.assertEqual(self.request("GET")[0][0][0], {"entries": []})
        self.assertFalse(self.vocabulary.path.exists())
        self.assertFalse(self.vocabulary.backup_path.exists())

    def test_explanation_uses_saved_source_and_never_overwrites(self):
        entry = self.add()[0][0][0]["entry"]
        endpoint = f'/api/vocabulary/{entry["id"]}/explain'
        initial = self.vocabulary.path.read_bytes()
        with patch.object(server, "explain_vocabulary", return_value={"details": {"meanings": "方法"}, "model": "test"}) as generate:
            responses, errors = self.request("POST", endpoint, {})
            self.assertEqual(errors, [])
            self.assertEqual(responses[0][0]["details"]["meanings"], "方法")
            self.assertEqual(generate.call_args.args[0]["sources"][0]["title"], "Trusted paper title")
        self.assertEqual(self.vocabulary.path.read_bytes(), initial)
        self.assertEqual(self.request("POST", endpoint, {"term": "forged"})[1][0][1], 400)
        self.assertEqual(self.request("POST", endpoint, {}, token="wrong")[1][0][1], 401)
        with patch.object(server.runtime, "READONLY_MODE", True):
            self.assertEqual(self.request("POST", endpoint, {})[1][0][1], 403)
        with patch.object(server, "MIGRATION_QUIESCING", True):
            self.assertEqual(self.request("POST", endpoint, {})[1][0][1], 503)
        with patch.object(server, "explain_vocabulary", side_effect=RuntimeError("格式不完整")):
            self.assertEqual(self.request("POST", endpoint, {})[1][0][1], 502)
        self.vocabulary.delete(entry["id"])
        self.assertEqual(self.request("POST", endpoint, {})[1][0][1], 404)

    def test_explanation_requires_membership_only_when_enabled(self):
        entry = self.add()[0][0][0]["entry"]
        endpoint = f'/api/vocabulary/{entry["id"]}/explain'
        result = {"details": {"meanings": "方法"}, "model": "test"}
        cases = (
            (False, {"logged_in": False, "member": False}, 200),
            (True, {"logged_in": False, "member": False}, 401),
            (True, {"logged_in": True, "member": False}, 403),
            (True, {"logged_in": True, "member": True}, 200),
        )
        for required, account, status in cases:
            with self.subTest(required=required, account=account), patch.object(server.runtime, "AI_REQUIRES_MEMBER", required), patch.object(server, "_account_summary", return_value=account) as summary, patch.object(server, "explain_vocabulary", return_value=result) as generate:
                responses, errors = self.request("POST", endpoint, {})
                if status == 200:
                    self.assertEqual(errors, [])
                    self.assertEqual(responses, [(result, 200)])
                    generate.assert_called_once()
                else:
                    self.assertEqual(responses, [])
                    self.assertEqual(errors[0][1], status)
                    generate.assert_not_called()
                if required:
                    summary.assert_called_once_with()
                else:
                    summary.assert_not_called()

    def test_api_token_host_readonly_and_migration_guards_cover_new_routes(self):
        self.assertEqual(self.request("GET", token="wrong")[1][0][1], 401)
        self.assertEqual(self.request("POST", payload={}, host="attacker.example:8135")[1][0][1], 403)
        with patch.object(server.runtime, "READONLY_MODE", True):
            self.assertEqual(self.add()[1][0][1], 403)
            self.assertEqual(self.request("PATCH", "/api/vocabulary/" + "a" * 32, {"meaning": "x"})[1][0][1], 403)
            self.assertEqual(self.request("DELETE", "/api/vocabulary/" + "a" * 32)[1][0][1], 403)
            self.assertEqual(self.request("POST", "/api/vocabulary/" + "a" * 32 + "/review", {"status": "learning"})[1][0][1], 403)
            self.assertEqual(self.request("GET")[1], [])
        with patch.object(server, "MIGRATION_QUIESCING", True):
            for verb, path in (("GET", "/api/vocabulary"), ("POST", "/api/vocabulary"), ("PATCH", "/api/vocabulary/" + "a" * 32), ("DELETE", "/api/vocabulary/" + "a" * 32)):
                self.assertEqual(self.request(verb, path, {})[1][0][1], 503)
        self.assertFalse(self.vocabulary.path.exists())

    def test_malformed_source_and_review_status_return_validation_errors(self):
        for surface in ([], {}, 5):
            self.assertEqual(self.add(surface=surface)[1][0][1], 400)
        responses, _ = self.add()
        entry_id = responses[0][0]["entry"]["id"]
        for status in ([], {}, None, 5):
            self.assertEqual(self.request("POST", f"/api/vocabulary/{entry_id}/review", {"status": status})[1][0][1], 400)

    def test_storage_failure_is_reported_and_leaves_existing_entry(self):
        self.add()
        with patch.object(self.vocabulary, "_save", side_effect=OSError("disk full")):
            responses, errors = self.request("PATCH", "/api/vocabulary/" + self.vocabulary.list()[0]["id"], {"meaning": "x"})
        self.assertEqual(responses, [])
        self.assertEqual(errors[0][1], 500)
        self.assertEqual(self.vocabulary.list()[0]["meaning"], "")


if __name__ == "__main__":
    unittest.main()
