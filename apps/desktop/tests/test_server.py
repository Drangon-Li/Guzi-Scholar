from __future__ import annotations

import errno
import hashlib
import io
import json
import os
import queue
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional
from unittest.mock import MagicMock, patch
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from pipeline import PipelineError  # noqa: E402
from library_store import LibraryStore  # noqa: E402
import server as server_module  # noqa: E402
from server import AI_STATUS_HISTORY_LIMIT, DataRootLock, MAX_CHAT_IMAGE_BYTES, MAX_NOTE_ASSET_BYTES, JobStore, ReflowConflictError, ScholarHandler, _ai_status_history, _chat_image_context, _copy_ai_profile, _deduplicate_figure_ids, _migrate_job_artifacts, _note_image_type, _public_job, _public_settings, _record_ai_status, _runtime_lock_roots, _store_note_asset, _sync_ai_annotations, _translation_key, _translation_records, _write_content_manifest, _write_settings, _write_translation_records  # noqa: E402


class PDFEvidenceWorkerTest(unittest.TestCase):
    def test_dependency_smoke_checks_provider_imports_before_runtime_locks(self) -> None:
        registry = MagicMock()
        registry.list_capabilities.return_value = [
            {"id": "local-mineru", "state": "artifact_unavailable", "ready": False},
            {"id": "remote-guzi", "state": "disabled", "ready": False},
        ]
        with patch.object(sys, "argv", ["server.py", "--dependency-smoke"]), patch(
            "server._runtime_lock_roots"
        ) as runtime_roots, patch("server.ThreadingHTTPServer") as http_server, patch(
            "server._parsing_provider_registry", return_value=registry
        ), patch("builtins.print") as output:
            server_module.main()
        payload = json.loads(output.call_args.args[0])
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["hashlib_scrypt"])
        self.assertEqual([item["id"] for item in payload["providers"]], ["local-mineru", "remote-guzi"])
        runtime_roots.assert_not_called()
        http_server.assert_not_called()

    def test_worker_mode_returns_before_runtime_locks_and_http_server(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-evidence-cli-") as temp:
            source = Path(temp) / "source.pdf"
            output = Path(temp) / "evidence.json"
            source.write_bytes(b"%PDF-1.4\n")
            argv = [
                "server.py",
                "--pdf-evidence-input", str(source),
                "--pdf-evidence-output", str(output),
                "--pdf-evidence-drawing-pages", "2,1,2",
            ]
            with patch.object(sys, "argv", argv), patch("document_ir.write_pdf_evidence") as writer, patch(
                "server._runtime_lock_roots"
            ) as runtime_roots, patch("server.ThreadingHTTPServer") as http_server:
                server_module.main()
            writer.assert_called_once_with(source, output, drawing_pages=[1, 2])
            runtime_roots.assert_not_called()
            http_server.assert_not_called()


class PermanentDeleteTest(unittest.TestCase):
    @staticmethod
    def _handler() -> tuple[ScholarHandler, list[tuple[dict, HTTPStatus]], list[tuple[str, HTTPStatus]]]:
        handler = object.__new__(ScholarHandler)
        responses: list[tuple[dict, HTTPStatus]] = []
        errors: list[tuple[str, HTTPStatus]] = []
        handler._send_json = lambda payload, status=HTTPStatus.OK, **_kwargs: responses.append((payload, status))
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **_kwargs: errors.append((message, status))
        return handler, responses, errors

    @staticmethod
    def _completed_job(root: Path) -> tuple[JobStore, LibraryStore, dict]:
        store = JobStore(root / "jobs")
        library = LibraryStore(root)
        record = store.create("paper.pdf", 11)
        job_dir = Path(record["job_dir"])
        (job_dir / "source.pdf").write_bytes(b"%PDF-1.4\nfull-data")
        store.update(record["job_id"], status="completed")
        record = store.get(record["job_id"])
        library.sync_jobs([record])
        return store, library, record

    @staticmethod
    def _batch_handler(job_ids: list[str]) -> tuple[ScholarHandler, list[tuple[dict, HTTPStatus]], list[tuple[str, HTTPStatus]]]:
        handler, responses, errors = PermanentDeleteTest._handler()
        raw = json.dumps({"job_ids": job_ids}).encode("utf-8")
        handler.headers = {"Content-Length": str(len(raw))}
        handler.rfile = io.BytesIO(raw)
        return handler, responses, errors

    def test_permanent_delete_removes_job_directory_and_library_index(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-") as temp:
            store, library, record = self._completed_job(Path(temp))
            job_id = record["job_id"]
            job_dir = Path(record["job_dir"])
            library.trash_item(job_id)
            handler, responses, errors = self._handler()
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
                handler._permanently_delete_library_item(job_id)

            self.assertEqual(errors, [])
            self.assertEqual(responses[0][0]["deleted"], job_id)
            self.assertFalse(job_dir.exists())
            self.assertIsNone(store.get(job_id))
            self.assertNotIn(job_id, library.state["items"])
            self.assertEqual(list((Path(temp) / "jobs").glob(f".deleting-{job_id}-*")), [])

    def test_permanent_delete_rejects_non_trash_and_rolls_back_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-boundary-") as temp:
            store, library, record = self._completed_job(Path(temp))
            job_id = record["job_id"]
            job_dir = Path(record["job_dir"])
            handler, responses, errors = self._handler()
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
                handler._permanently_delete_library_item(job_id)

            self.assertEqual(responses, [])
            self.assertEqual(errors[0][1], HTTPStatus.CONFLICT)
            self.assertTrue(job_dir.is_dir())
            self.assertIsNotNone(store.get(job_id))
            self.assertIn(job_id, library.state["items"])

    def test_permanent_delete_rejects_running_and_reflow_jobs_without_staging(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-busy-") as temp:
            store, library, record = self._completed_job(Path(temp))
            job_id = record["job_id"]
            job_dir = Path(record["job_dir"])
            library.trash_item(job_id)
            handler, responses, errors = self._handler()
            store.update(job_id, status="running")
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
                handler._permanently_delete_library_item(job_id)
            self.assertEqual(errors[0][1], HTTPStatus.CONFLICT)
            self.assertTrue(job_dir.is_dir())
            self.assertIsNotNone(store.get(job_id))

            store.update(job_id, status="completed", reflow={}, metadata_status="retrieving")
            errors.clear()
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
                handler._permanently_delete_library_item(job_id)
            self.assertEqual(errors[0][1], HTTPStatus.CONFLICT)
            self.assertTrue(job_dir.is_dir())
            self.assertIsNotNone(store.get(job_id))

            store.update(job_id, status="completed", reflow={"status": "running", "generation": 1})
            errors.clear()
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
                handler._permanently_delete_library_item(job_id)
            self.assertEqual(errors[0][1], HTTPStatus.CONFLICT)
            self.assertTrue(job_dir.is_dir())
            self.assertIsNotNone(store.get(job_id))

    def test_permanent_delete_keeps_indexed_tombstone_when_final_cleanup_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-rollback-") as temp:
            store, library, record = self._completed_job(Path(temp))
            job_id = record["job_id"]
            job_dir = Path(record["job_dir"])
            library.trash_item(job_id)
            handler, responses, errors = self._handler()
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library), patch.object(
                store, "finalize_permanent_delete", side_effect=OSError("disk full")
            ):
                handler._permanently_delete_library_item(job_id)

            self.assertEqual(responses, [])
            self.assertEqual(errors[0][1], HTTPStatus.CONFLICT)
            self.assertFalse(job_dir.exists())
            self.assertIsNone(store.get(job_id))
            self.assertNotIn(job_id, library.state["items"])
            self.assertIn(job_id, library.state["permanently_deleted"])
            self.assertEqual(len(list((Path(temp) / "jobs").glob(f".deleting-{job_id}-*"))), 1)
            self.assertTrue((Path(temp) / "jobs" / ".permanent-delete-journal.json").is_file())

    def test_permanent_delete_finalize_holds_store_lock_for_shared_journal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-finalize-lock-") as temp:
            store = JobStore(Path(temp) / "jobs")
            job_id = "a" * 16
            token = {
                "job_id": job_id,
                "staged_dir": str(Path(temp) / "jobs" / f".deleting-{job_id}-token"),
            }
            lock_state = {"entered": False}

            class TrackingLock:
                def __enter__(self):
                    lock_state["entered"] = True
                    return self

                def __exit__(self, *_args):
                    lock_state["entered"] = False

            store.lock = TrackingLock()  # type: ignore[assignment]
            with patch.object(store, "_remove_permanent_delete_journal", side_effect=lambda _job_id: self.assertTrue(lock_state["entered"])):
                store.finalize_permanent_delete(token)

    def test_delete_route_dispatches_permanent_action(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler.path = f"/api/library/items/{'a' * 16}/permanent"
        dispatched: list[str] = []
        handler._permanently_delete_library_item = lambda job_id: dispatched.append(job_id)
        handler.do_DELETE()
        self.assertEqual(dispatched, ["a" * 16])

    def test_permanent_delete_helper_is_readonly_safe(self) -> None:
        handler, responses, errors = self._handler()
        store = MagicMock()
        library = MagicMock()
        with patch.object(server_module.runtime, "READONLY_MODE", True), patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
            handler._permanently_delete_library_item("a" * 16)
        self.assertEqual(responses, [])
        self.assertEqual(errors, [("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)])
        store.get.assert_not_called()

    def test_batch_permanent_delete_prevalidates_all_items_before_mutating(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-batch-permanent-delete-boundary-") as temp:
            root = Path(temp)
            store, library, first = self._completed_job(root / "one")
            second = store.create("second.pdf", 12)
            second_dir = Path(second["job_dir"])
            (second_dir / "source.pdf").write_bytes(b"%PDF-1.4\nsecond")
            store.update(second["job_id"], status="completed")
            second = store.get(second["job_id"])
            library.sync_jobs([second])
            library.trash_item(first["job_id"])
            handler, responses, errors = self._batch_handler([first["job_id"], second["job_id"]])
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
                handler._permanently_delete_library_items()

            self.assertEqual(errors, [])
            self.assertEqual(responses[0][1], HTTPStatus.CONFLICT)
            self.assertEqual(responses[0][0]["deleted"], [])
            self.assertEqual(responses[0][0]["failed"][0]["job_id"], second["job_id"])
            self.assertTrue(Path(first["job_dir"]).is_dir())
            self.assertTrue(second_dir.is_dir())
            self.assertIn(first["job_id"], library.state["items"])

    def test_batch_permanent_delete_returns_deleted_and_failed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-batch-permanent-delete-") as temp:
            root = Path(temp)
            store, library, first = self._completed_job(root / "one")
            second = store.create("second.pdf", 12)
            second_dir = Path(second["job_dir"])
            (second_dir / "source.pdf").write_bytes(b"%PDF-1.4\nsecond")
            store.update(second["job_id"], status="completed")
            second = store.get(second["job_id"])
            library.sync_jobs([second])
            library.trash_item(first["job_id"])
            library.trash_item(second["job_id"])
            handler, responses, errors = self._batch_handler([first["job_id"], second["job_id"]])
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
                handler._permanently_delete_library_items()

            self.assertEqual(errors, [])
            self.assertEqual(responses[0][1], HTTPStatus.OK)
            self.assertEqual(responses[0][0]["deleted"], [first["job_id"], second["job_id"]])
            self.assertEqual(responses[0][0]["failed"], [])
            self.assertFalse(Path(first["job_dir"]).exists())
            self.assertFalse(second_dir.exists())

    def test_batch_permanent_delete_keeps_indexed_cleanup_failure_as_failed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-batch-permanent-delete-partial-") as temp:
            root = Path(temp)
            store, library, first = self._completed_job(root / "one")
            second = store.create("second.pdf", 12)
            second_dir = Path(second["job_dir"])
            (second_dir / "source.pdf").write_bytes(b"%PDF-1.4\nsecond")
            store.update(second["job_id"], status="completed")
            second = store.get(second["job_id"])
            library.sync_jobs([second])
            library.trash_item(first["job_id"])
            library.trash_item(second["job_id"])
            original_finalize = store.finalize_permanent_delete
            calls = {"count": 0}

            def fail_second(token: dict) -> None:
                calls["count"] += 1
                if calls["count"] == 2:
                    raise OSError("disk full")
                original_finalize(token)

            handler, responses, errors = self._batch_handler([first["job_id"], second["job_id"]])
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library), patch.object(
                store, "finalize_permanent_delete", side_effect=fail_second
            ):
                handler._permanently_delete_library_items()

            self.assertEqual(errors, [])
            self.assertEqual(responses[0][1], HTTPStatus.MULTI_STATUS)
            self.assertEqual(responses[0][0]["deleted"], [first["job_id"]])
            self.assertEqual(responses[0][0]["failed"][0]["job_id"], second["job_id"])
            self.assertFalse(Path(first["job_dir"]).exists())
            self.assertFalse(store.get(second["job_id"]))
            self.assertNotIn(second["job_id"], library.state["items"])
            self.assertTrue(second_dir.parent.joinpath(".permanent-delete-journal.json").is_file())

    def test_permanent_delete_recovery_cleans_prepared_journal_without_touching_original(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-recover-prepared-") as temp:
            root = Path(temp)
            store, library, record = self._completed_job(root)
            job_id = record["job_id"]
            staged = root / "jobs" / f".deleting-{job_id}-prepared"
            store._upsert_permanent_delete_journal({
                "job_id": job_id,
                "record": record,
                "job_dir": record["job_dir"],
                "staged_dir": str(staged),
                "status": "prepared",
            })
            restarted = JobStore(root / "jobs")
            restarted.recover_permanent_delete_journals(LibraryStore(root))
            self.assertTrue(Path(record["job_dir"]).is_dir())
            self.assertIsNotNone(restarted.get(job_id))
            self.assertFalse(store.permanent_delete_journal_path.exists())

    def test_permanent_delete_recovery_restores_unindexed_staged_job(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-recover-staged-") as temp:
            root = Path(temp)
            store, library, record = self._completed_job(root)
            job_id = record["job_id"]
            library.trash_item(job_id)
            token = store.stage_permanent_delete(job_id)
            self.assertFalse(Path(record["job_dir"]).exists())
            restarted = JobStore(root / "jobs")
            restarted.recover_permanent_delete_journals(LibraryStore(root))
            self.assertTrue(Path(record["job_dir"]).is_dir())
            self.assertIsNotNone(restarted.get(job_id))
            self.assertFalse(Path(token["staged_dir"]).exists())
            self.assertFalse(store.permanent_delete_journal_path.exists())

    def test_permanent_delete_recovery_finishes_indexed_staged_job(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-recover-indexed-") as temp:
            root = Path(temp)
            store, library, record = self._completed_job(root)
            job_id = record["job_id"]
            library.trash_item(job_id)
            token = store.stage_permanent_delete(job_id)
            library.permanently_delete_item(job_id)
            store._mark_permanent_delete_indexed(token)
            restarted = JobStore(root / "jobs")
            restarted.recover_permanent_delete_journals(LibraryStore(root))
            self.assertFalse(Path(token["staged_dir"]).exists())
            self.assertIsNone(restarted.get(job_id))
            self.assertFalse(store.permanent_delete_journal_path.exists())

    def test_permanent_delete_recovery_keeps_indexed_journal_when_cleanup_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-recover-retry-") as temp:
            root = Path(temp)
            store, library, record = self._completed_job(root)
            job_id = record["job_id"]
            library.trash_item(job_id)
            token = store.stage_permanent_delete(job_id)
            library.permanently_delete_item(job_id)
            store._mark_permanent_delete_indexed(token)
            restarted = JobStore(root / "jobs")
            with patch.object(server_module.shutil, "rmtree", side_effect=OSError("disk busy")):
                restarted.recover_permanent_delete_journals(LibraryStore(root))
            self.assertTrue(Path(token["staged_dir"]).exists())
            self.assertTrue(restarted.permanent_delete_journal_path.exists())
            self.assertIsNone(restarted.get(job_id))
            restarted.recover_permanent_delete_journals(LibraryStore(root))
            self.assertFalse(Path(token["staged_dir"]).exists())
            self.assertFalse(restarted.permanent_delete_journal_path.exists())

    def test_permanent_delete_stage_journal_failure_restores_live_job(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-permanent-delete-journal-failure-") as temp:
            root = Path(temp)
            store, library, record = self._completed_job(root)
            job_id = record["job_id"]
            job_dir = Path(record["job_dir"])
            library.trash_item(job_id)
            calls = {"count": 0}
            original_upsert = store._upsert_permanent_delete_journal

            def fail_staged(entry: dict) -> None:
                calls["count"] += 1
                if calls["count"] == 2:
                    raise OSError("journal unavailable")
                original_upsert(entry)

            handler, responses, errors = self._handler()
            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library), patch.object(
                store, "_upsert_permanent_delete_journal", side_effect=fail_staged
            ):
                handler._permanently_delete_library_item(job_id)

            self.assertEqual(responses, [])
            self.assertEqual(errors[0][1], HTTPStatus.INTERNAL_SERVER_ERROR)
            self.assertTrue(job_dir.is_dir())
            self.assertIsNotNone(store.get(job_id))
            self.assertIn(job_id, library.state["items"])
            self.assertFalse(store.permanent_delete_journal_path.exists())
            self.assertEqual(list((root / "jobs").glob(f".deleting-{job_id}-*")), [])

    def test_post_route_dispatches_batch_permanent_action(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler.path = "/api/library/items/permanent"
        dispatched: list[bool] = []
        handler._permanently_delete_library_items = lambda: dispatched.append(True)
        handler.do_POST()
        self.assertEqual(dispatched, [True])


class TranslationCacheTest(unittest.TestCase):
    def test_failed_semantic_document_has_no_english_translation_blocks(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-semantic-gate-") as temp:
            job_dir = Path(temp)
            (job_dir / "document.json").write_text(json.dumps({
                "semantic_validation": {"status": "FAIL"},
                "translation_enabled": False,
                "pages": [{"page": 1, "elements": [{"block_id": "block-1", "text": "Unsafe fragment"}]}],
            }), encoding="utf-8")
            server_module._write_english_snapshot(job_dir)
            snapshot = json.loads((job_dir / "content" / "english" / "blocks.json").read_text(encoding="utf-8"))
            self.assertEqual(snapshot["blocks"], [])

    def test_startup_retries_local_metadata_without_a_venue_when_online(self) -> None:
        store = MagicMock()
        store.list.return_value = [{
            "job_id": "a" * 16,
            "status": "completed",
            "source_filename": "paper.pdf",
            "metadata_status": "local",
            "metadata_venue": "",
        }]
        library = MagicMock()
        library.get_metadata.return_value = {
            "status": "local",
            "fields": {"venue": ""},
            "error": "temporary network failure",
        }
        with (
            patch.object(server_module, "STORE", store),
            patch.object(server_module, "LIBRARY", library),
            patch.object(server_module, "_metadata_settings", return_value={"auto_retrieve": True, "online_lookup": True}),
            patch.object(server_module, "_enqueue_metadata") as enqueue,
            patch.object(server_module.threading, "Thread") as worker_thread,
        ):
            server_module._start_background_workers()
        self.assertEqual(worker_thread.return_value.start.call_count, server_module.CONVERSION_WORKERS + server_module.METADATA_WORKERS + 1)
        enqueue.assert_called_once_with("a" * 16, True, "refine")

    def test_startup_backfills_only_unlocked_fragmented_local_abstracts_offline(self) -> None:
        fragmented = (
            "Th e num b er o f users o f weara bl e d ev i ces i n creased over th e p ast d eca d es. "
            "Th ese d ev i ces con ti nuous l y co ll ec t sens iti ve data a b ou t th e users."
        )
        records = [
            {"job_id": "a" * 16, "status": "completed", "metadata_status": "local"},
            {"job_id": "b" * 16, "status": "completed", "metadata_status": "local"},
            {"job_id": "c" * 16, "status": "completed", "metadata_status": "local"},
            {"job_id": "d" * 16, "status": "running", "metadata_status": "local"},
        ]
        metadata = {
            "a" * 16: {"status": "local", "fields": {"abstract": fragmented, "venue": "Venue"}, "sources": {"abstract": {"provider": "local-document"}}, "locked_fields": []},
            "b" * 16: {"status": "local", "fields": {"abstract": fragmented, "venue": "Venue"}, "sources": {"abstract": {"provider": "local-document"}}, "locked_fields": ["abstract"]},
            "c" * 16: {"status": "local", "fields": {"abstract": fragmented, "venue": "Venue"}, "sources": {"abstract": {"provider": "crossref"}}, "locked_fields": []},
            "d" * 16: {"status": "local", "fields": {"abstract": fragmented, "venue": "Venue"}, "sources": {"abstract": {"provider": "local-document"}}, "locked_fields": []},
        }
        store = MagicMock()
        store.list.return_value = records
        library = MagicMock()
        library.get_metadata.side_effect = lambda job_id: metadata[job_id]
        with (
            patch.object(server_module, "STORE", store),
            patch.object(server_module, "LIBRARY", library),
            patch.object(server_module, "_metadata_settings", return_value={"auto_retrieve": False, "online_lookup": True}),
            patch.object(server_module, "_enqueue_metadata") as enqueue,
            patch.object(server_module.threading, "Thread"),
        ):
            server_module._start_background_workers()

        enqueue.assert_called_once_with("a" * 16, False, "refine", force=True)

    def test_legacy_duplicate_figure_anchor_keeps_the_captioned_figure_canonical(self) -> None:
        document = (
            '<figure class="pdf-figure" id="fig-2"><figcaption></figcaption></figure>'
            '<figure class="pdf-figure" id="fig-2"><figcaption>Figure 2. Main model.</figcaption></figure>'
        )
        migrated = _deduplicate_figure_ids(document)
        self.assertEqual(migrated.count('id="fig-2"'), 1)
        self.assertRegex(migrated, r'id="fig-2"[^>]*><figcaption>Figure 2\. Main model\.')
        self.assertIn('id="fig-2-duplicate-1"', migrated)

    def test_archived_duplicate_id_resolves_to_live_canonical_job(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-alias-") as temp:
            root = Path(temp)
            canonical = "b" * 16
            archived = "a" * 16
            job_dir = root / canonical
            job_dir.mkdir()
            (job_dir / "manifest.json").write_text(json.dumps({"job_id": canonical, "created_at": "2026-01-01", "source": {"filename": "Paper.pdf"}}), encoding="utf-8")
            duplicates = root / ".duplicates"
            duplicates.mkdir()
            (duplicates / "merge-manifest.json").write_text(json.dumps({"groups": [{"canonical": canonical, "archived": [archived]}]}), encoding="utf-8")
            store = JobStore(root)
            self.assertEqual(store.get(archived)["job_id"], canonical)
            self.assertEqual(store.path(archived), job_dir.resolve())

    def test_job_store_keeps_same_title_when_content_identity_is_unknown(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-dedupe-") as temp:
            store = JobStore(Path(temp))
            first, duplicate = store.create_or_get_by_source_title("OneLLM CVPR 2024.pdf", 123)
            second, duplicate_copy = store.create_or_get_by_source_title("onellm_cvpr_2024 (1).pdf", 456)
            third, duplicate_other = store.create_or_get_by_source_title("Another Paper.pdf", 789)
            self.assertFalse(duplicate)
            self.assertFalse(duplicate_copy)
            self.assertFalse(duplicate_other)
            self.assertNotEqual(first["job_id"], second["job_id"])
            self.assertNotEqual(first["job_id"], third["job_id"])
            self.assertEqual(len(store.list()), 3)

    def test_job_store_reuses_an_exact_pdf_after_it_is_renamed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-digest-dedupe-") as temp:
            store = JobStore(Path(temp))
            digest = "a" * 64
            first, duplicate = store.create_or_get_by_source_title("conference-version.pdf", 321, digest)
            (Path(first["job_dir"]) / "upload.pdf").write_bytes(b"x" * 321)
            renamed, duplicate_renamed = store.create_or_get_by_source_title("final-camera-ready.pdf", 321, digest)
            different, duplicate_different = store.create_or_get_by_source_title("different-paper.pdf", 321, "b" * 64)
            self.assertFalse(duplicate)
            self.assertTrue(duplicate_renamed)
            self.assertFalse(duplicate_different)
            self.assertEqual(first["job_id"], renamed["job_id"])
            self.assertNotEqual(first["job_id"], different["job_id"])
            self.assertEqual(len(store.list()), 2)

    def test_staged_upload_is_atomic_durable_and_deduplicated(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-staged-upload-") as temp:
            root = Path(temp)
            store = JobStore(root)
            payload = b"%PDF-1.4\nparallel import"
            digest = hashlib.sha256(payload).hexdigest()

            first_stage = store.new_incoming_directory()
            (first_stage / "upload.pdf.part").write_bytes(payload)
            first, duplicate = store.commit_staged_upload(first_stage, "paper.pdf", len(payload), digest)
            self.assertFalse(duplicate)
            self.assertEqual((Path(first["job_dir"]) / "upload.pdf").read_bytes(), payload)
            self.assertTrue((Path(first["job_dir"]) / "job.json").is_file())

            second_stage = store.new_incoming_directory()
            (second_stage / "upload.pdf.part").write_bytes(payload)
            second, duplicate = store.commit_staged_upload(second_stage, "renamed.pdf", len(payload), digest)
            self.assertTrue(duplicate)
            self.assertEqual(second["job_id"], first["job_id"])
            self.assertEqual(len(store.list()), 1)

            reloaded = JobStore(root)
            restored = reloaded.get(first["job_id"])
            self.assertEqual(restored["source_filename"], "paper.pdf")
            self.assertEqual(restored["source_sha256"], digest)

    def test_failed_exact_upload_retries_the_same_index(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-digest-retry-") as temp:
            root = Path(temp)
            store = JobStore(root)
            payload = b"%PDF-1.4\nretry"
            digest = hashlib.sha256(payload).hexdigest()
            first_stage = store.new_incoming_directory()
            (first_stage / "upload.pdf.part").write_bytes(payload)
            failed, duplicate = store.commit_staged_upload(first_stage, "paper.pdf", len(payload), digest)
            self.assertFalse(duplicate)
            store.update(failed["job_id"], status="failed")

            retry_stage = store.new_incoming_directory()
            (retry_stage / "upload.pdf.part").write_bytes(payload)
            retried, duplicate = store.commit_staged_upload(retry_stage, "paper.pdf", len(payload), digest)

            self.assertFalse(duplicate)
            self.assertEqual(retried["job_id"], failed["job_id"])
            self.assertEqual(retried["status"], "queued")
            self.assertEqual((Path(retried["job_dir"]) / "upload.pdf").read_bytes(), payload)

    def test_requested_folder_intent_is_replayed_and_cleared(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-folder-recovery-") as temp:
            data_root = Path(temp)
            store = JobStore(data_root / "jobs")
            library = LibraryStore(data_root)
            folder = library.create_folder("待整理")
            payload = b"%PDF-1.4\nfolder"
            stage = store.new_incoming_directory()
            (stage / "upload.pdf.part").write_bytes(payload)
            record, _ = store.commit_staged_upload(
                stage,
                "folder-paper.pdf",
                len(payload),
                hashlib.sha256(payload).hexdigest(),
                folder["id"],
            )
            library.sync_jobs([record])

            with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
                warnings = server_module._apply_requested_folders(record)

            self.assertEqual(warnings, [])
            self.assertIn(folder["id"], library.state["items"][record["job_id"]]["folder_ids"])
            self.assertEqual(store.get(record["job_id"])["requested_folder_ids"], [])
            self.assertIn(folder["id"], LibraryStore(data_root).state["items"][record["job_id"]]["folder_ids"])

    def test_requested_folder_replay_skips_a_deleted_job(self) -> None:
        job_id = "a" * 16
        store = MagicMock()
        store.get.return_value = None
        library = MagicMock()
        with patch.object(server_module, "STORE", store), patch.object(server_module, "LIBRARY", library):
            warnings = server_module._apply_requested_folders({"job_id": job_id, "requested_folder_ids": ["folder-stale"]})

        self.assertEqual(warnings, [])
        library.add_to_folder.assert_not_called()
        store.update.assert_not_called()

    def test_ai_review_holds_job_mutation_lock_for_the_full_review(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-ai-review-lock-") as temp:
            store = JobStore(Path(temp) / "jobs")
            record = store.create("paper.pdf", 10)
            job_id = record["job_id"]
            job_dir = Path(record["job_dir"])
            (job_dir / "manifest.json").write_text("{}", encoding="utf-8")
            store.update(job_id, status="completed")
            handler, responses, errors = PermanentDeleteTest._handler()
            review_started = threading.Event()
            release_review = threading.Event()

            def slow_review(_job_dir: Path) -> dict:
                review_started.set()
                self.assertTrue(release_review.wait(timeout=2.0))
                return {"status": "completed", "model": "test", "reviewed_at": "now"}

            with patch.object(server_module, "STORE", store), patch.object(server_module, "review_tables", side_effect=slow_review):
                worker = threading.Thread(target=handler._run_ai_review, args=(job_id,))
                worker.start()
                self.assertTrue(review_started.wait(timeout=1.0))
                contender_acquired = threading.Event()

                def contend_for_job() -> None:
                    with server_module._job_mutation(job_id):
                        contender_acquired.set()

                contender = threading.Thread(target=contend_for_job)
                contender.start()
                self.assertFalse(contender_acquired.wait(timeout=0.1))
                release_review.set()
                worker.join(timeout=2.0)
                contender.join(timeout=2.0)

            self.assertFalse(worker.is_alive())
            self.assertFalse(contender.is_alive())
            self.assertTrue(contender_acquired.is_set())
            self.assertEqual(errors, [])
            self.assertEqual(responses[0][0]["result"]["status"], "completed")

    def test_only_one_worker_can_claim_and_running_recovers_as_queued(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-job-claim-") as temp:
            root = Path(temp)
            store = JobStore(root)
            record = store.create("paper.pdf", 10)
            (Path(record["job_dir"]) / "upload.pdf").write_bytes(b"%PDF-1.4")
            with ThreadPoolExecutor(max_workers=12) as executor:
                claims = list(executor.map(lambda _: store.claim(record["job_id"]), range(24)))
            self.assertEqual(sum(claim is not None for claim in claims), 1)
            self.assertEqual(store.get(record["job_id"])["status"], "running")
            self.assertEqual(JobStore(root).get(record["job_id"])["status"], "queued")

    def test_two_conversion_workers_overlap_without_exceeding_pool_limit(self) -> None:
        class QueueExhausted(Exception):
            pass

        class FiniteQueue:
            def __init__(self, items: list[tuple[str, str]]) -> None:
                self.items = list(items)
                self.lock = threading.Lock()
                self.completed = 0

            def get(self) -> tuple[str, str]:
                with self.lock:
                    if not self.items:
                        raise QueueExhausted
                    return self.items.pop(0)

            def task_done(self) -> None:
                with self.lock:
                    self.completed += 1

        class LibraryStub:
            @staticmethod
            def sync_jobs(_jobs: list[dict]) -> None:
                return None

        with tempfile.TemporaryDirectory(prefix="my-scholar-conversion-workers-") as temp:
            root = Path(temp)
            store = JobStore(root)
            records = [store.create(f"paper-{index}.pdf", 10) for index in range(4)]
            for record in records:
                (Path(record["job_dir"]) / "upload.pdf").write_bytes(b"%PDF-1.4")

            work_queue = FiniteQueue([(record["job_id"], record["source_filename"]) for record in records])
            counter_lock = threading.Lock()
            first_pair_ready = threading.Event()
            active = 0
            peak = 0
            started = 0

            def fake_process_pdf(
                _pdf_path: Path,
                _job_dir: Path,
                *,
                job_id: str,
                source_name: str,
                progress=None,
                backend_override: Optional[str] = None,
            ) -> dict:
                nonlocal active, peak, started
                self.assertEqual(backend_override, "odl")
                with counter_lock:
                    active += 1
                    started += 1
                    peak = max(peak, active)
                    if started >= 2:
                        first_pair_ready.set()
                try:
                    if not first_pair_ready.wait(timeout=2):
                        raise AssertionError("两个转换 worker 没有发生重叠")
                    if progress:
                        progress("测试转换", 0.5)
                    time.sleep(0.03)
                    return {
                        "job_id": job_id,
                        "source": {"filename": source_name, "bytes": 10},
                        "counts": {},
                        "outputs": [],
                    }
                finally:
                    with counter_lock:
                        active -= 1

            with (
                patch.object(server_module, "STORE", store),
                patch.object(server_module, "LIBRARY", LibraryStub()),
                patch.object(server_module, "CONVERSION_QUEUE", work_queue),
                patch.object(server_module, "process_pdf", side_effect=fake_process_pdf),
                patch.object(server_module, "_metadata_settings", return_value={"auto_retrieve": False}),
            ):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    futures = [executor.submit(server_module._conversion_worker) for _ in range(2)]
                    for future in futures:
                        with self.assertRaises(QueueExhausted):
                            future.result(timeout=5)

            self.assertEqual(peak, 2)
            self.assertEqual(work_queue.completed, len(records))
            self.assertTrue(all(store.get(record["job_id"])["status"] == "completed" for record in records))

    def test_conversion_worker_continues_after_one_unhandled_task_error(self) -> None:
        class QueueExhausted(Exception):
            pass

        class FiniteQueue:
            def __init__(self) -> None:
                self.items = [("a" * 16, "one.pdf"), ("b" * 16, "two.pdf")]
                self.completed = 0

            def get(self) -> tuple[str, str]:
                if not self.items:
                    raise QueueExhausted
                return self.items.pop(0)

            def task_done(self) -> None:
                self.completed += 1

        work_queue = FiniteQueue()
        with (
            patch.object(server_module, "CONVERSION_QUEUE", work_queue),
            patch.object(server_module, "_run_conversion_job", side_effect=[RuntimeError("disk error"), None]) as runner,
        ):
            with self.assertRaises(QueueExhausted):
                server_module._conversion_worker()
        self.assertEqual(runner.call_count, 2)
        self.assertEqual(work_queue.completed, 2)

    def test_data_root_lock_rejects_a_second_writer(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-data-lock-") as temp:
            first = DataRootLock(Path(temp))
            second = DataRootLock(Path(temp))
            first.acquire()
            try:
                with self.assertRaisesRegex(RuntimeError, "另一个 My Scholar"):
                    second.acquire()
            finally:
                first.release()

    def test_translation_key_is_stable_and_scoped(self) -> None:
        first = _translation_key("A paragraph.", "block-1", "中文", "source-a", "profile-a")
        self.assertEqual(first, _translation_key("different text", "block-1", "中文", "source-a", "profile-a"))
        self.assertNotEqual(first, _translation_key("A paragraph.", "block-2", "中文", "source-a", "profile-a"))
        self.assertNotEqual(first, _translation_key("A paragraph.", "block-1", "English", "source-a", "profile-a"))
        self.assertNotEqual(first, _translation_key("A paragraph.", "block-1", "中文", "source-a", "profile-b"))

    def test_task_local_translation_records_round_trip(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-translations-") as temp:
            job_dir = Path(temp)
            item = {
                "cache_key": "abc123",
                "block_id": "block-1",
                "target_language": "中文",
                "source_hash": "source-a",
                "text": "一段译文",
            }
            _write_translation_records(job_dir, [item])
            self.assertEqual(_translation_records(job_dir), [item])
            self.assertTrue((job_dir / "content" / "english" / "blocks.json").is_file())
            self.assertTrue((job_dir / "content" / "chinese" / "blocks.json").is_file())
            self.assertEqual(json.loads((job_dir / "content" / "chinese" / "blocks.json").read_text(encoding="utf-8"))["blocks"], [item])
            _write_translation_records(job_dir, [dict(item, text="更新后的译文")])
            self.assertEqual(_translation_records(job_dir)[0]["text"], "更新后的译文")

    def test_translation_endpoint_returns_only_current_profile_without_deleting_older_records(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-translation-profile-") as temp:
            job_dir = Path(temp)
            records = [
                {"cache_key": "current", "profile_id": "profile-current", "block_id": "block-1", "text": "当前译文"},
                {"cache_key": "other", "profile_id": "profile-other", "block_id": "block-1", "text": "其他译文"},
                {"cache_key": "legacy", "block_id": "block-1", "text": "旧版译文"},
            ]
            _write_translation_records(job_dir, records)

            class StoreStub:
                @staticmethod
                def path(_job_id: str) -> Path:
                    return job_dir

            handler = object.__new__(ScholarHandler)
            handler.path = f"/api/jobs/{'a' * 16}/translations"
            responses: list[dict] = []
            handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
            handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)
            with patch("server.STORE", StoreStub()), patch("server.translation_profile_id", return_value="profile-current"):
                handler.do_GET()

            self.assertEqual(responses, [{"translations": [records[0]], "profile_id": "profile-current"}])
            responses.clear()
            with patch("server.STORE", StoreStub()), patch("server.translation_profile_id", return_value=""):
                handler.do_GET()
            self.assertEqual(responses, [{"translations": [], "profile_id": ""}])
            self.assertEqual({item["cache_key"] for item in _translation_records(job_dir)}, {"current", "other", "legacy"})

    def test_readonly_mode_returns_all_translation_records_and_blocks_writes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-readonly-") as temp:
            job_dir = Path(temp)
            records = [
                {"cache_key": "current", "profile_id": "profile-current", "block_id": "b1", "text": "当前译文"},
                {"cache_key": "legacy", "block_id": "b1", "text": "旧版译文"},
            ]
            _write_translation_records(job_dir, records)

            class StoreStub:
                @staticmethod
                def path(_job_id: str) -> Path:
                    return job_dir

            handler = object.__new__(ScholarHandler)
            handler.path = f"/api/jobs/{'a' * 16}/translations"
            responses: list[dict] = []
            handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
            handler._send_error_json = lambda message, status=None: responses.append({"error": message, "status": status})
            with (
                patch("server.STORE", StoreStub()),
                patch("server.translation_profile_id", return_value=""),
                patch.object(server_module.runtime, "READONLY_MODE", True),
            ):
                handler.do_GET()
            self.assertEqual({item["cache_key"] for item in responses[0]["translations"]}, {"current", "legacy"})
            # The cache file itself must stay untouched by a read-only GET.
            self.assertEqual({item["cache_key"] for item in _translation_records(job_dir)}, {"current", "legacy"})

    def test_translate_records_profile_and_keeps_other_profile_caches(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-translate-profile-") as temp:
            job_dir = Path(temp)
            old_records = [
                {"cache_key": "other", "profile_id": "profile-other", "block_id": "block-1", "text": "其他译文"},
                {"cache_key": "legacy", "block_id": "block-1", "text": "旧版译文"},
            ]
            _write_translation_records(job_dir, old_records)
            payload = {"text": "Source text.", "block_id": "block-1", "target_language": "中文", "source_hash": "source-a"}
            handler = object.__new__(ScholarHandler)
            handler._completed_job_dir = lambda _job_id: job_dir
            handler._read_json_body = lambda **_kwargs: payload
            responses: list[dict] = []
            handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
            handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)

            with patch("server.translation_profile_id", return_value="profile-current"), patch("server.translate_text", return_value={"text": "当前译文"}) as translate:
                handler._translate("a" * 16)
                handler._translate("a" * 16)

            translate.assert_called_once()
            records = _translation_records(job_dir)
            self.assertEqual(len(records), 3)
            current = next(item for item in records if item.get("profile_id") == "profile-current")
            self.assertEqual(current["cache_key"], _translation_key("Source text.", "block-1", "中文", "source-a", "profile-current"))
            self.assertEqual([response["result"]["cached"] for response in responses], [False, True])
            self.assertEqual({item["cache_key"] for item in records if item.get("profile_id") != "profile-current"}, {"other", "legacy"})

    def test_content_manifest_writes_are_safe_for_concurrent_reader_requests(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-content-race-") as temp:
            job_dir = Path(temp)
            (job_dir / "source.pdf").write_bytes(b"%PDF-1.4")
            with ThreadPoolExecutor(max_workers=8) as executor:
                list(executor.map(lambda _: _write_content_manifest(job_dir), range(32)))
            manifest = json.loads((job_dir / "content" / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["source_pdf"], "../source.pdf")
            self.assertFalse(list((job_dir / "content").glob("*.tmp")))

    def test_public_job_exposes_html_without_markdown_download(self) -> None:
        job = _public_job({"job_id": "a" * 16, "job_dir": "/private/tmp/job", "status": "completed"})
        self.assertIn("html", job["links"])
        self.assertIn("content", job["links"])
        self.assertNotIn("markdown", job["links"])
        self.assertNotIn("job_dir", job)

    def test_public_job_join_keeps_reader_links_for_library_rows(self) -> None:
        job = _public_job({"job_id": "a" * 16, "status": "completed", "source_filename": "paper.pdf"})
        self.assertEqual(job["links"]["html"], "/api/jobs/aaaaaaaaaaaaaaaa/document.html")

    def test_job_migration_backfills_current_ai_source_without_reclassifying_manual_ranges(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-migration-") as temp:
            job_dir = Path(temp)
            (job_dir / "native").mkdir()
            (job_dir / "document.md").write_text("legacy", encoding="utf-8")
            (job_dir / "raw-document.html").write_text("legacy", encoding="utf-8")
            (job_dir / "raw-document.json").write_text("{}", encoding="utf-8")
            (job_dir / "native" / "source.md").write_text("legacy", encoding="utf-8")
            (job_dir / "document.html").write_text(
                "<!doctype html><html><head><style>.pdf-page{border:1px solid red}</style></head>"
                "<body><nav class='reader-nav'>Pages</nav><details class='source-crop'><summary>原始公式</summary>crop</details>"
                "<figure class='pdf-table table-semantic-fallback' id='table-4'><figcaption>Table 4</figcaption>"
                "<div class='table-scroll'><table><tr><td>结构化候选</td></tr></table></div>"
                "<details class='source-crop'><summary>查看裁剪</summary><a class='asset-link' href='assets/images/table.png'><img src='assets/images/table.png'></a></details>"
                "</figure><section class='pdf-page'>正文</section></body></html>",
                encoding="utf-8",
            )
            (job_dir / "document.json").write_text(
                '{"pages":[{"elements":[{"block_id":"author","translation_excluded":"metadata"}]}]}',
                encoding="utf-8",
            )
            _write_translation_records(job_dir, [
                {"cache_key": "author-cache", "block_id": "author", "text": "作者"},
                {"cache_key": "body-cache", "block_id": "body", "text": "正文"},
            ])
            current = {"block_id": "body", "quote": "Current sentence.", "category": "method", "reason": "当前"}
            (job_dir / "ai-highlights.json").write_text(json.dumps({"highlights": [current]}), encoding="utf-8")
            (job_dir / "annotations.json").write_text(json.dumps([
                {"id": "current", "kind": "highlight", "block_id": "body", "quote": "Current sentence.", "note": "当前", "start": None, "end": None},
                {"id": "stale", "kind": "highlight", "block_id": "body", "quote": "Old sentence.", "category": "method", "note": "旧候选", "start": None, "end": None},
                {"id": "manual", "kind": "highlight", "block_id": "body", "quote": "Manual", "category": "method", "note": "手写", "start": 0, "end": 6},
            ], ensure_ascii=False), encoding="utf-8")
            manifest = {"outputs": ["document.html", "document.md", "raw-document.html", "raw-document.json", "document.json"], "notes": ["Markdown 与 JSON 从同一次转换导出。", "保留 HTML。"]}
            migrated = _migrate_job_artifacts(job_dir, manifest)
            self.assertFalse((job_dir / "document.md").exists())
            self.assertFalse((job_dir / "raw-document.html").exists())
            self.assertFalse((job_dir / "raw-document.json").exists())
            self.assertFalse((job_dir / "native" / "source.md").exists())
            self.assertNotIn("document.md", migrated["outputs"])
            self.assertNotIn("raw-document.html", migrated["outputs"])
            self.assertNotIn("raw-document.json", migrated["outputs"])
            migrated_html = (job_dir / "document.html").read_text(encoding="utf-8")
            self.assertIn("continuous-reader-migration-v4", migrated_html)
            self.assertIn(".reader-nav { display: none", migrated_html)
            self.assertNotIn("原始公式", migrated_html)
            self.assertNotIn("<table", migrated_html)
            self.assertIn('class="table-source-primary table-image-only"', migrated_html)
            self.assertIn('src=\'assets/images/table.png\'', migrated_html)
            self.assertEqual([item["block_id"] for item in _translation_records(job_dir)], ["body"])
            annotations = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual([item["id"] for item in annotations], ["current", "stale", "manual"])
            self.assertEqual(annotations[0]["source"], "ai")
            self.assertEqual(annotations[0]["category"], "method")
            self.assertTrue(annotations[0]["suggestion_key"])
            self.assertNotIn("source", annotations[1])
            self.assertEqual(annotations[2]["source"], "manual")


class ReaderPerformanceTest(unittest.TestCase):
    @staticmethod
    def _bytes_handler() -> ScholarHandler:
        handler = object.__new__(ScholarHandler)
        handler.headers_sent: list[tuple[str, str]] = []
        handler.send_response = lambda *_args, **_kwargs: None
        handler.send_header = lambda key, value: handler.headers_sent.append((key, value))
        handler.end_headers = lambda *_args, **_kwargs: None
        handler.wfile = io.BytesIO()
        return handler

    def test_handler_uses_persistent_http_connections(self) -> None:
        self.assertEqual(ScholarHandler.protocol_version, "HTTP/1.1")

    def test_immutable_render_generations_are_cacheable(self) -> None:
        handler = self._bytes_handler()
        handler._send_bytes(b"<html></html>", "text/html; charset=utf-8", immutable=True)
        headers = dict(handler.headers_sent)
        self.assertIn("immutable", headers.get("Cache-Control", ""))
        plain = self._bytes_handler()
        plain._send_bytes(b"{}", "application/json; charset=utf-8")
        self.assertEqual(dict(plain.headers_sent).get("Cache-Control"), "no-store")

    def test_content_manifest_is_not_rewritten_when_unchanged(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-manifest-skip-") as temp:
            job_dir = Path(temp)
            (job_dir / "source.pdf").write_bytes(b"%PDF-1.4\n")
            server_module._write_content_manifest(job_dir)
            manifest_path = job_dir / "content" / "manifest.json"
            first = manifest_path.read_bytes()
            server_module._write_content_manifest(job_dir)
            self.assertEqual(manifest_path.read_bytes(), first)
            (job_dir / "source.pdf").unlink()
            (job_dir / "upload.pdf").write_bytes(b"%PDF-1.4\n")
            server_module._write_content_manifest(job_dir)
            updated = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(updated["source_pdf"], "../upload.pdf")

    def test_translation_records_persist_only_for_migrations(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-translation-skip-") as temp:
            job_dir = Path(temp)
            record = {"cache_key": "k", "block_id": "b", "text": "译文", "profile_id": "p"}
            # A missing cache rewrites once to create the migration artifacts.
            self.assertTrue(server_module._translation_records_need_persist(job_dir))
            server_module._write_translation_records(job_dir, [record])
            self.assertFalse(server_module._translation_records_need_persist(job_dir))
            # Legacy list payloads still migrate to keyed entries.
            (job_dir / "translations.json").write_text(json.dumps([record]), encoding="utf-8")
            self.assertTrue(server_module._translation_records_need_persist(job_dir))


class TranslateStreamTest(unittest.TestCase):
    @staticmethod
    def _stream_handler(job_dir: Path, payload: dict) -> ScholarHandler:
        handler = object.__new__(ScholarHandler)
        handler._completed_job_dir = lambda _job_id: job_dir
        handler._read_json_body = lambda **_kwargs: dict(payload)
        handler.send_response = lambda *_args, **_kwargs: None
        handler.send_header = lambda *_args, **_kwargs: None
        handler.end_headers = lambda *_args, **_kwargs: None
        handler.wfile = io.BytesIO()
        return handler

    @staticmethod
    def _events(handler: ScholarHandler) -> list[dict]:
        raw = handler.wfile.getvalue().decode("utf-8")
        return [json.loads(chunk[len("data: "):]) for chunk in raw.split("\n\n") if chunk.startswith("data: ")]

    def test_translate_stream_emits_deltas_and_caches_result(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-translate-stream-") as temp:
            job_dir = Path(temp)
            payload = {"text": "Source text.", "block_id": "", "target_language": "中文", "source_hash": "sel-1", "stream": True}
            handler = self._stream_handler(job_dir, payload)
            with (
                patch("server.translation_profile_id", return_value="profile-current"),
                patch("server.ai_status", return_value={"model": "test-model"}),
                patch("server.translate_text_stream", return_value=iter(["你", "好"])) as stream,
                patch("server.translate_text") as plain,
            ):
                handler._translate("a" * 16)
            plain.assert_not_called()
            stream.assert_called_once()
            events = self._events(handler)
            self.assertEqual(events[:2], [{"delta": "你"}, {"delta": "好"}])
            self.assertEqual(events[2]["result"]["text"], "你好")
            self.assertFalse(events[2]["result"]["cached"])
            records = _translation_records(job_dir)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["text"], "你好")
            self.assertEqual(records[0]["model"], "test-model")

            cached_handler = self._stream_handler(job_dir, payload)
            with (
                patch("server.translation_profile_id", return_value="profile-current"),
                patch("server.translate_text_stream") as stream_again,
            ):
                cached_handler._translate("a" * 16)
            stream_again.assert_not_called()
            cached_events = self._events(cached_handler)
            self.assertEqual(len(cached_events), 1)
            self.assertTrue(cached_events[0]["result"]["cached"])
            self.assertEqual(cached_events[0]["result"]["text"], "你好")

    def test_translate_stream_falls_back_to_plain_request_before_first_delta(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-translate-stream-") as temp:
            job_dir = Path(temp)
            payload = {"text": "Source text.", "block_id": "", "target_language": "中文", "source_hash": "sel-2", "stream": True}
            handler = self._stream_handler(job_dir, payload)
            with (
                patch("server.translation_profile_id", return_value="profile-current"),
                patch("server.translate_text_stream", side_effect=RuntimeError("HTTP 400")),
                patch("server.translate_text", return_value={"text": "回退译文", "model": "test-model", "profile_id": "profile-current", "formulas": []}) as plain,
            ):
                handler._translate("a" * 16)
            plain.assert_called_once()
            events = self._events(handler)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["result"]["text"], "回退译文")
            self.assertFalse(events[0]["result"]["cached"])
            self.assertEqual(_translation_records(job_dir)[0]["text"], "回退译文")

    def test_translate_stream_midway_failure_reports_error_without_caching(self) -> None:
        def broken_stream(*_args, **_kwargs):
            yield "部分"
            raise RuntimeError("gateway dropped")

        with tempfile.TemporaryDirectory(prefix="my-scholar-translate-stream-") as temp:
            job_dir = Path(temp)
            payload = {"text": "Source text.", "block_id": "", "target_language": "中文", "source_hash": "sel-3", "stream": True}
            handler = self._stream_handler(job_dir, payload)
            with (
                patch("server.translation_profile_id", return_value="profile-current"),
                patch("server.translate_text_stream", side_effect=broken_stream),
                patch("server.translate_text") as plain,
            ):
                handler._translate("a" * 16)
            plain.assert_not_called()
            events = self._events(handler)
            self.assertEqual(events[0], {"delta": "部分"})
            self.assertIn("翻译失败", events[1]["error"])
            self.assertEqual(_translation_records(job_dir), [])


class ChatStreamTest(unittest.TestCase):
    @staticmethod
    def _stream_handler(job_dir: Path, payload: dict) -> ScholarHandler:
        handler = object.__new__(ScholarHandler)
        handler._completed_job_dir = lambda _job_id: job_dir
        handler._read_json_body = lambda **_kwargs: dict(payload)
        handler.send_response = lambda *_args, **_kwargs: None
        handler.send_header = lambda *_args, **_kwargs: None
        handler.end_headers = lambda *_args, **_kwargs: None
        handler.wfile = io.BytesIO()
        return handler

    def test_chat_stream_emits_deltas_then_result(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-chat-stream-") as temp:
            job_dir = Path(temp)
            payload = {"messages": [{"role": "user", "content": "总结一下"}], "stream": True}
            handler = self._stream_handler(job_dir, payload)
            with (
                patch("server.ai_chat_stream", return_value=iter(["答", "案"])) as stream,
                patch("server.ai_status", return_value={"model": "chat-test"}),
                patch("server.ai_chat") as plain,
            ):
                handler._chat("a" * 16)
            plain.assert_not_called()
            stream.assert_called_once()
            events = TranslateStreamTest._events(handler)
            self.assertEqual(events[:2], [{"delta": "答"}, {"delta": "案"}])
            self.assertEqual(events[2], {"result": {"text": "答案", "model": "chat-test"}})

    def test_chat_stream_falls_back_to_plain_request_before_first_delta(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-chat-stream-") as temp:
            job_dir = Path(temp)
            payload = {"messages": [{"role": "user", "content": "总结一下"}], "stream": True}
            handler = self._stream_handler(job_dir, payload)
            with (
                patch("server.ai_chat_stream", side_effect=RuntimeError("HTTP 400")),
                patch("server.ai_chat", return_value={"text": "回退回答", "model": "chat-test"}) as plain,
            ):
                handler._chat("a" * 16)
            plain.assert_called_once()
            events = TranslateStreamTest._events(handler)
            self.assertEqual(events, [{"result": {"text": "回退回答", "model": "chat-test"}}])

    def test_chat_stream_midway_failure_reports_error(self) -> None:
        def broken_stream(*_args, **_kwargs):
            yield "部分回答"
            raise RuntimeError("gateway dropped")

        with tempfile.TemporaryDirectory(prefix="my-scholar-chat-stream-") as temp:
            job_dir = Path(temp)
            payload = {"messages": [{"role": "user", "content": "总结一下"}], "stream": True}
            handler = self._stream_handler(job_dir, payload)
            with (
                patch("server.ai_chat_stream", side_effect=broken_stream),
                patch("server.ai_chat") as plain,
            ):
                handler._chat("a" * 16)
            plain.assert_not_called()
            events = TranslateStreamTest._events(handler)
            self.assertEqual(events[0], {"delta": "部分回答"})
            self.assertIn("AI 对话失败", events[1]["error"])


class MathMLEndpointTest(unittest.TestCase):
    def test_mathml_endpoint_returns_only_real_mathml(self) -> None:
        class RendererStub:
            @staticmethod
            def render(tex: str, display: bool) -> str:
                if tex == "x^2":
                    return f'<math display="{"block" if display else "inline"}">x2</math>'
                return '<span class="math-fallback"><code>junk</code></span>'

        handler = object.__new__(ScholarHandler)
        handler._read_json_body = lambda **_kwargs: {"formulas": [{"tex": "x^2", "display": True}, {"tex": "junk"}, {"tex": ""}]}
        responses: list[dict] = []
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)
        with patch("server.MATH_RENDERER", RendererStub()):
            handler._render_mathml()
        self.assertEqual(responses, [{"results": ['<math display="block">x2</math>', "", ""]}])

    def test_mathml_endpoint_rejects_oversized_batches(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler._read_json_body = lambda **_kwargs: {"formulas": [{"tex": "x"}] * 65}
        errors: list[str] = []
        handler._send_json = lambda body, *_args, **_kwargs: self.fail(str(body))
        handler._send_error_json = lambda message, *_args, **_kwargs: errors.append(message)
        handler._render_mathml()
        self.assertTrue(errors and "64" in errors[0])


class AccountProxyTest(unittest.TestCase):
    def _handler(self, payload: dict) -> ScholarHandler:
        handler = object.__new__(ScholarHandler)
        handler._read_json_body = lambda **_kwargs: dict(payload)
        handler.responses = []
        handler._send_json = lambda body, *_args, **_kwargs: handler.responses.append(body)
        handler._send_error_json = lambda message, *_args, **_kwargs: handler.responses.append({"error": message})
        return handler

    def test_email_account_routes_dispatch_to_the_expected_actions(self) -> None:
        handler = object.__new__(ScholarHandler)
        actions: list[str] = []
        handler._account_action = actions.append
        handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)
        for path, action in (
            ("/api/account/email-code", "email-code"),
            ("/api/account/reset-email", "reset-email"),
            ("/api/account/bind-email", "bind-email"),
        ):
            handler.path = path
            handler.do_POST()
            self.assertEqual(actions[-1], action)

    def test_login_persists_token_without_usage_reporting(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            calls: list[tuple] = []

            def fake_request(path, *, method="GET", token="", payload=None):
                calls.append((path, method, token, payload))
                if path == "/api/auth/login":
                    return {"token": "session-token", "profile": {"username": "owner", "member": True, "beta_access": True}}
                raise AssertionError(path)

            handler = self._handler({
                "username": "owner",
                "password": "password-1",
                "terms_version": "2026-08-06-email",
                "privacy_version": "2026-08-06-email",
            })
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module, "_account_request", side_effect=fake_request),
                patch.object(server_module, "_local_usage_bytes", return_value=4096),
            ):
                handler._account_action("login")
            state = json.loads(account_file.read_text(encoding="utf-8"))
            self.assertEqual(state["token"], "session-token")
            self.assertEqual(state["profile"]["username"], "owner")
            self.assertEqual(calls, [(
                "/api/auth/login",
                "POST",
                "",
                {
                    "username": "owner",
                    "password": "password-1",
                    "terms_version": "2026-08-06-email",
                    "privacy_version": "2026-08-06-email",
                },
            )])
            self.assertEqual(handler.responses[0]["local_used_bytes"], 4096)

    def test_register_forwards_invite_and_consent_versions_and_returns_recovery_code(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            calls: list[tuple] = []

            def fake_request(path, *, method="GET", token="", payload=None):
                calls.append((path, method, token, payload))
                return {
                    "token": "session-token",
                    "profile": {"username": "new-user", "member": True, "beta_access": True},
                    "recovery_code": "RECOVERY-CODE",
                }

            handler = self._handler({
                "username": "new-user",
                "password": "password-1",
                "invite_code": "INVITE-CODE",
                "email": "reader@example.com",
                "email_challenge_id": "challenge-register",
                "email_code": "12345678",
                "terms_version": "2026-08-06-email",
                "privacy_version": "2026-08-06-email",
            })
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module, "_account_request", side_effect=fake_request),
                patch.object(server_module, "_local_usage_bytes", return_value=0),
            ):
                handler._account_action("register")

            self.assertEqual(calls, [(
                "/api/auth/register",
                "POST",
                "",
                {
                    "username": "new-user",
                    "password": "password-1",
                    "invite_code": "INVITE-CODE",
                    "email": "reader@example.com",
                    "email_challenge_id": "challenge-register",
                    "email_code": "12345678",
                    "terms_version": "2026-08-06-email",
                    "privacy_version": "2026-08-06-email",
                },
            )])
            self.assertEqual(handler.responses[0]["recovery_code"], "RECOVERY-CODE")
            self.assertEqual(json.loads(account_file.read_text(encoding="utf-8"))["token"], "session-token")

    def test_registration_email_code_request_forwards_invite_without_session_token(self) -> None:
        calls: list[tuple] = []

        def fake_request(path, *, method="GET", token="", payload=None):
            calls.append((path, method, token, payload))
            return {"ok": True, "challenge_id": "challenge-register", "expires_in": 600}

        handler = self._handler({
            "email": " reader@example.com ",
            "purpose": "REGISTER",
            "invite_code": " INVITE-CODE ",
            "ignored": "not-forwarded",
        })
        with patch.object(server_module, "_account_request", side_effect=fake_request):
            handler._account_action("email-code")

        self.assertEqual(calls, [(
            "/api/auth/email-code/request",
            "POST",
            "",
            {"email": "reader@example.com", "purpose": "register", "invite_code": "INVITE-CODE"},
        )])
        self.assertEqual(handler.responses, [{"ok": True, "challenge_id": "challenge-register", "expires_in": 600}])

    def test_bind_email_code_request_uses_existing_session_token(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(json.dumps({"token": "session-token", "profile": {"username": "owner"}}), encoding="utf-8")
            calls: list[tuple] = []

            def fake_request(path, *, method="GET", token="", payload=None):
                calls.append((path, method, token, payload))
                return {"ok": True, "challenge_id": "challenge-bind"}

            handler = self._handler({"email": "owner@example.com", "purpose": "bind", "invite_code": "ignored"})
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module, "_account_request", side_effect=fake_request),
            ):
                handler._account_action("email-code")

            self.assertEqual(calls, [(
                "/api/auth/email-code/request",
                "POST",
                "session-token",
                {"email": "owner@example.com", "purpose": "bind"},
            )])
            self.assertEqual(json.loads(account_file.read_text(encoding="utf-8"))["token"], "session-token")

    def test_bind_email_code_request_requires_login_before_upstream_call(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            handler = self._handler({"email": "owner@example.com", "purpose": "bind"})
            with (
                patch.object(server_module, "ACCOUNT_FILE", Path(temp) / "account.json"),
                patch.object(server_module, "_account_request") as account_request,
            ):
                handler._account_action("email-code")
            account_request.assert_not_called()
            self.assertEqual(handler.responses, [{"error": "尚未登录。"}])

    def test_password_reset_forwards_recovery_code_and_clears_local_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(json.dumps({"token": "old", "profile": {"member": True}}), encoding="utf-8")
            calls: list[tuple] = []

            def fake_request(path, *, method="GET", token="", payload=None):
                calls.append((path, method, token, payload))
                return {"ok": True, "recovery_code": "NEW-RECOVERY-CODE"}

            handler = self._handler({
                "username": "owner",
                "recovery_code": "OLD-RECOVERY-CODE",
                "new_password": "new-password-1",
            })
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module, "_account_request", side_effect=fake_request),
            ):
                handler._account_action("reset")

            self.assertEqual(calls[0], (
                "/api/auth/reset-password",
                "POST",
                "",
                {
                    "username": "owner",
                    "recovery_code": "OLD-RECOVERY-CODE",
                    "new_password": "new-password-1",
                },
            ))
            self.assertFalse(account_file.exists())
            self.assertEqual(handler.responses, [{"ok": True, "logged_in": False, "recovery_code": "NEW-RECOVERY-CODE"}])

    def test_email_password_reset_forwards_challenge_and_clears_local_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(json.dumps({"token": "old", "profile": {"member": True}}), encoding="utf-8")
            calls: list[tuple] = []

            def fake_request(path, *, method="GET", token="", payload=None):
                calls.append((path, method, token, payload))
                return {"ok": True, "recovery_code": "NEW-RECOVERY-CODE"}

            handler = self._handler({
                "challenge_id": " challenge-reset ",
                "email_code": " 12345678 ",
                "new_password": "new-password-1",
            })
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module, "_account_request", side_effect=fake_request),
            ):
                handler._account_action("reset-email")

            self.assertEqual(calls, [(
                "/api/auth/password-reset/email",
                "POST",
                "",
                {
                    "challenge_id": "challenge-reset",
                    "email_code": "12345678",
                    "new_password": "new-password-1",
                },
            )])
            self.assertFalse(account_file.exists())
            self.assertEqual(handler.responses, [{"ok": True, "logged_in": False, "recovery_code": "NEW-RECOVERY-CODE"}])

    def test_bind_email_forwards_session_and_persists_returned_profile(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(
                json.dumps({"server": "https://accounts.example", "username": "owner", "token": "session-token", "profile": {"username": "owner"}}),
                encoding="utf-8",
            )
            calls: list[tuple] = []
            bound_profile = {"username": "owner", "email": "owner@example.com", "email_verified": True}

            def fake_request(path, *, method="GET", token="", payload=None):
                calls.append((path, method, token, payload))
                return {"profile": bound_profile}

            handler = self._handler({
                "challenge_id": " challenge-bind ",
                "email_code": " 87654321 ",
            })
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module, "_account_request", side_effect=fake_request),
                patch.object(server_module, "_local_usage_bytes", return_value=2048),
            ):
                handler._account_action("bind-email")

            self.assertEqual(calls, [(
                "/api/auth/email-bind",
                "POST",
                "session-token",
                {
                    "challenge_id": "challenge-bind",
                    "email_code": "87654321",
                },
            )])
            state = json.loads(account_file.read_text(encoding="utf-8"))
            self.assertEqual(state["token"], "session-token")
            self.assertEqual(state["profile"], bound_profile)
            self.assertEqual(handler.responses, [{
                "ok": True,
                "logged_in": True,
                "profile": bound_profile,
                "local_used_bytes": 2048,
            }])

    def test_logout_clears_local_session_even_if_upstream_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(json.dumps({"token": "t", "profile": {}}), encoding="utf-8")

            def failing_request(*_args, **_kwargs):
                raise PipelineError("无法连接账号服务器，请稍后重试。")

            handler = self._handler({})
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module, "_account_request", side_effect=failing_request),
            ):
                handler._account_action("logout")
            self.assertFalse(account_file.exists())
            self.assertEqual(handler.responses, [{"ok": True}])

    def test_expired_session_clears_stored_token(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(json.dumps({"token": "stale", "profile": {"member": True}}), encoding="utf-8")

            def expired_request(*_args, **_kwargs):
                raise PipelineError("登录已过期，请重新登录。")

            handler = self._handler({})
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module, "_account_request", side_effect=expired_request),
                patch.object(server_module, "_local_usage_bytes", return_value=0),
            ):
                handler._account_action("refresh")
            self.assertFalse(account_file.exists())
            self.assertIn("登录已过期", handler.responses[0]["error"])

    def test_member_gate_disables_ai_services_for_non_members(self) -> None:
        services = {"translation": {"enabled": True, "model": "m"}, "chat": {"enabled": True, "model": "n"}}
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-") as temp:
            account_file = Path(temp) / "account.json"
            with patch.object(server_module, "ACCOUNT_FILE", account_file), patch.object(server_module, "AI_REQUIRES_MEMBER", True):
                gated = server_module._apply_member_gate(services)
                self.assertFalse(gated["translation"]["enabled"])
                self.assertIn("登录", gated["translation"]["note"])

                account_file.write_text(json.dumps({"token": "t", "profile": {"username": "u", "member": False, "beta_access": False}}), encoding="utf-8")
                gated = server_module._apply_member_gate(services)
                self.assertFalse(gated["chat"]["enabled"])
                self.assertIn("内测资格", gated["chat"]["note"])

                account_file.write_text(json.dumps({"token": "t", "profile": {"username": "u", "member": True, "beta_access": True}}), encoding="utf-8")
                self.assertTrue(server_module._apply_member_gate(services)["translation"]["enabled"])
            with patch.object(server_module, "AI_REQUIRES_MEMBER", False):
                self.assertTrue(server_module._apply_member_gate(services)["chat"]["enabled"])

    def test_account_transport_requires_https_except_explicit_loopback_development(self) -> None:
        self.assertTrue(server_module._account_service_configuration("https://accounts.example.test")["available"])
        self.assertFalse(server_module._account_service_configuration("http://accounts.example.test")["available"])
        with patch.object(server_module, "ALLOW_INSECURE_LOOPBACK_ACCOUNT", False):
            status = server_module._account_service_configuration("http://127.0.0.1:8478")
            self.assertFalse(status["available"])
            self.assertIn("显式设置", status["error"])
        with patch.object(server_module, "ALLOW_INSECURE_LOOPBACK_ACCOUNT", True):
            status = server_module._account_service_configuration("http://localhost:8478")
            self.assertTrue(status["available"])
            self.assertTrue(status["development_only"])

    def test_remote_http_account_request_is_rejected_before_network_io(self) -> None:
        with (
            patch.object(server_module, "ACCOUNT_SERVICE_URL", "http://accounts.example.test"),
            patch.object(server_module.urllib.request, "build_opener") as build_opener,
            self.assertRaisesRegex(server_module.AccountServiceUnavailable, "必须使用 HTTPS"),
        ):
            server_module._account_request("/api/auth/login", method="POST", payload={"password": "secret"})
        build_opener.assert_not_called()

    def test_account_state_write_is_atomic_and_owner_only(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-atomic-") as temp:
            account_file = Path(temp) / "account.json"
            with patch.object(server_module, "ACCOUNT_FILE", account_file):
                server_module._write_account_state({"token": "new", "profile": {"member": True}})
            self.assertEqual(json.loads(account_file.read_text(encoding="utf-8"))["token"], "new")
            self.assertEqual(account_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(account_file.parent.glob(".account.json.*.tmp")), [])

    def test_failed_account_replace_preserves_previous_session(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-account-atomic-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(json.dumps({"token": "old"}), encoding="utf-8")
            with (
                patch.object(server_module, "ACCOUNT_FILE", account_file),
                patch.object(server_module.os, "replace", side_effect=OSError("replace failed")),
                self.assertRaisesRegex(OSError, "replace failed"),
            ):
                server_module._write_account_state({"token": "new"})
            self.assertEqual(json.loads(account_file.read_text(encoding="utf-8"))["token"], "old")
            self.assertEqual(list(account_file.parent.glob(".account.json.*.tmp")), [])


class AIEntitlementTest(unittest.TestCase):
    AI_PATHS = (
        "/api/ai/test",
        "/api/ai/models",
        f"/api/jobs/{'a' * 16}/translate",
        f"/api/jobs/{'a' * 16}/chat",
        f"/api/jobs/{'a' * 16}/auto-highlights",
        f"/api/jobs/{'a' * 16}/ai-review",
        f"/api/jobs/{'a' * 16}/reference-summary",
        f"/api/jobs/{'a' * 16}/reflow",
    )

    @staticmethod
    def _blocked_response(path: str, account_file: Path) -> tuple[str, HTTPStatus]:
        handler = object.__new__(ScholarHandler)
        handler.path = path
        responses: list[tuple[str, HTTPStatus]] = []
        handler._send_error_json = lambda message, status=None: responses.append((message, status))
        with (
            patch.object(server_module, "ACCOUNT_FILE", account_file),
            patch.object(server_module, "AI_REQUIRES_MEMBER", True),
        ):
            handler.do_POST()
        return responses[0]

    def test_every_ai_execution_route_requires_login(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-ai-gate-") as temp:
            account_file = Path(temp) / "account.json"
            for path in self.AI_PATHS:
                with self.subTest(path=path):
                    message, status = self._blocked_response(path, account_file)
                    self.assertIn("登录", message)
                    self.assertEqual(status, HTTPStatus.UNAUTHORIZED)

    def test_logged_in_non_member_receives_forbidden(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-ai-gate-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(json.dumps({"token": "t", "profile": {"member": False, "beta_access": False}}), encoding="utf-8")
            for path in self.AI_PATHS:
                with self.subTest(path=path):
                    message, status = self._blocked_response(path, account_file)
                    self.assertIn("内测资格", message)
                    self.assertEqual(status, HTTPStatus.FORBIDDEN)

    def test_legacy_member_cache_without_current_agreement_is_forbidden(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-ai-gate-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(
                json.dumps({"token": "t", "profile": {"member": True, "beta_access": False}}),
                encoding="utf-8",
            )
            message, status = self._blocked_response(self.AI_PATHS[2], account_file)
            self.assertIn("内测资格", message)
            self.assertEqual(status, HTTPStatus.FORBIDDEN)

    def test_member_and_disabled_gate_allow_ai_execution(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler._send_error_json = lambda *_args, **_kwargs: self.fail("member should not be blocked")
        with tempfile.TemporaryDirectory(prefix="my-scholar-ai-gate-") as temp:
            account_file = Path(temp) / "account.json"
            account_file.write_text(json.dumps({"token": "t", "profile": {"member": True, "beta_access": True}}), encoding="utf-8")
            with patch.object(server_module, "ACCOUNT_FILE", account_file), patch.object(server_module, "AI_REQUIRES_MEMBER", True):
                self.assertTrue(handler._require_ai_entitlement())
        with patch.object(server_module, "AI_REQUIRES_MEMBER", False):
            self.assertTrue(handler._require_ai_entitlement())


class LocalRequestSecurityTest(unittest.TestCase):
    @staticmethod
    def _handler(headers: dict[str, str]) -> ScholarHandler:
        handler = object.__new__(ScholarHandler)
        handler.headers = headers
        handler.server = type("ServerStub", (), {"server_address": ("127.0.0.1", 8765)})()
        return handler

    def test_valid_loopback_host_and_origin_are_accepted(self) -> None:
        handler = self._handler({"Host": "127.0.0.1:8765", "Origin": "http://localhost:8765"})
        with patch.object(server_module, "API_ACCESS_TOKEN", ""):
            self.assertIsNone(server_module._request_security_failure(handler))

    def test_forged_host_and_origin_are_rejected(self) -> None:
        with patch.object(server_module, "API_ACCESS_TOKEN", ""):
            host_failure = server_module._request_security_failure(self._handler({"Host": "evil.example:8765"}))
            origin_failure = server_module._request_security_failure(self._handler({
                "Host": "127.0.0.1:8765",
                "Origin": "https://evil.example",
            }))
        self.assertEqual(host_failure[1], HTTPStatus.FORBIDDEN)
        self.assertEqual(origin_failure[1], HTTPStatus.FORBIDDEN)

    def test_electron_token_is_required_when_configured(self) -> None:
        valid_headers = {"Host": "127.0.0.1:8765", "X-My-Scholar-Api-Token": "secret"}
        with patch.object(server_module, "API_ACCESS_TOKEN", "secret"):
            missing = server_module._request_security_failure(self._handler({"Host": "127.0.0.1:8765"}))
            wrong = server_module._request_security_failure(self._handler({
                "Host": "127.0.0.1:8765",
                "X-My-Scholar-Api-Token": "wrong",
            }))
            self.assertIsNone(server_module._request_security_failure(self._handler(valid_headers)))
        self.assertEqual(missing[1], HTTPStatus.UNAUTHORIZED)
        self.assertEqual(wrong[1], HTTPStatus.UNAUTHORIZED)

    def test_non_loopback_deployment_keeps_existing_host_policy(self) -> None:
        handler = self._handler({"Host": "reader.example.test"})
        handler.server.server_address = ("0.0.0.0", 8765)
        with patch.object(server_module, "API_ACCESS_TOKEN", ""):
            self.assertIsNone(server_module._request_security_failure(handler))


class SettingsBoundaryTest(unittest.TestCase):
    def test_ai_status_history_keeps_more_than_the_visible_page_limit(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-history-limit-") as temp:
            history_path = Path(temp) / "ai-status-history.json"
            with patch.object(server_module, "AI_STATUS_HISTORY_PATH", history_path):
                for index in range(AI_STATUS_HISTORY_LIMIT + 5):
                    _record_ai_status({
                        "translation": {"ok": index % 2 == 0, "elapsed_ms": index},
                        "chat": {"ok": True, "elapsed_ms": index},
                    })
                history = _ai_status_history()
        self.assertEqual(len(history), AI_STATUS_HISTORY_LIMIT)

    def test_public_settings_uses_safe_appearance_defaults(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-appearance-defaults-") as temp:
            settings_path = Path(temp) / "settings.json"
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _public_settings()

            self.assertEqual(public["appearance"], {
                "app_font": "system",
                "reader_font": "academic",
                "accent": "amber",
            })

    def test_remote_parsing_server_url_round_trips_and_is_normalised(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-parsing-url-") as temp:
            settings_path = Path(temp) / "settings.json"
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _write_settings({
                    "parsing": {"backend": "vlm-http-client", "server_url": "  http://gpu-box:30000/  "},
                })
            self.assertEqual(public["parsing"]["backend"], "vlm-http-client")
            self.assertEqual(public["parsing"]["server_url"], "http://gpu-box:30000")

    def test_a_non_http_parsing_server_url_is_refused_on_write(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-parsing-url-reject-") as temp:
            settings_path = Path(temp) / "settings.json"
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                for rejected in ("file:///etc/passwd", "ftp://host", "gpu-box:30000"):
                    with self.assertRaises(PipelineError, msg=rejected):
                        _write_settings({"parsing": {"backend": "vlm-http-client", "server_url": rejected}})
                self.assertFalse(settings_path.is_file())

    def test_an_unreadable_stored_parsing_url_does_not_break_the_settings_read(self) -> None:
        # A bad value already on disk must degrade to "unset" rather than take
        # the whole settings endpoint down.
        with tempfile.TemporaryDirectory(prefix="my-scholar-parsing-url-stored-") as temp:
            settings_path = Path(temp) / "settings.json"
            settings_path.write_text(
                json.dumps({"parsing": {"backend": "vlm-http-client", "server_url": "file:///etc/passwd"}}),
                encoding="utf-8",
            )
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _public_settings()
            self.assertEqual(public["parsing"]["server_url"], "")
            self.assertEqual(public["parsing"]["backend"], "vlm-http-client")

    def test_public_settings_exposes_service_status_without_ai_configuration(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-public-") as temp:
            settings_path = Path(temp) / "settings.json"
            settings_path.write_text(json.dumps({
                "base_url": "http://legacy.invalid/v1",
                "model": "legacy-model",
                "api_key": "legacy-test-key",
                "highlight_color": "#123ABC",
            }), encoding="utf-8")
            services = {
                "translation": {"configured": True, "model": "translation-model"},
                "chat": {"configured": False, "model": None},
            }
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value=services):
                public = _public_settings()

            self.assertEqual(public["ai_services"], services)
            self.assertEqual(public["highlight_color"], "#123ABC")
            self.assertEqual(public["appearance"], {
                "app_font": "system",
                "reader_font": "academic",
                "accent": "amber",
            })
            for forbidden in ("base_url", "model", "api_key", "api_key_configured", "server_preset", "translation", "chat"):
                self.assertNotIn(forbidden, public)
            self.assertEqual(public["ai"], {
                "translation": {"base_url": "", "model": "", "api_key_configured": False, "mode": "qwen-mt"},
                "chat": {"base_url": "", "model": "", "api_key_configured": False},
            })

    def test_settings_writer_rejects_legacy_top_level_ai_configuration_surfaces(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-private-") as temp:
            settings_path = Path(temp) / "settings.json"
            with patch("server.SETTINGS_PATH", settings_path):
                for field in ("base_url", "model", "api_key", "server_preset", "translation", "chat"):
                    with self.subTest(field=field), self.assertRaisesRegex(PipelineError, "项目私有配置文件"):
                        _write_settings({field: "blocked"})
            self.assertFalse(settings_path.exists())

    def test_settings_writer_persists_user_ai_profiles_without_returning_keys(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-ai-") as temp:
            settings_path = Path(temp) / "settings.json"
            payload = {"ai": {
                "translation": {"base_url": "https://translate.example/v1", "model": "translate-model", "api_key": "translate-secret"},
                "chat": {"base_url": "https://chat.example/v1", "model": "chat-model", "api_key": "chat-secret"},
            }}
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _write_settings(payload)
            stored = json.loads(settings_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["ai"]["translation"]["api_key"], "translate-secret")
        self.assertEqual(stored["ai"]["chat"]["api_key"], "chat-secret")
        self.assertTrue(public["ai"]["translation"]["api_key_configured"])
        self.assertTrue(public["ai"]["chat"]["api_key_configured"])
        self.assertNotIn("api_key", public["ai"]["translation"])
        self.assertNotIn("api_key", public["ai"]["chat"])

    def test_settings_writer_requires_https_except_for_loopback_ai_services(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-ai-transport-") as temp:
            settings_path = Path(temp) / "settings.json"
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                with self.assertRaisesRegex(PipelineError, "必须使用 HTTPS"):
                    _write_settings({"ai": {"chat": {
                        "base_url": "http://provider.example/v1", "model": "chat-model", "api_key": "secret",
                    }}})
                public = _write_settings({"ai": {"chat": {
                    "base_url": "http://127.0.0.1:8000/v1", "model": "local-model", "api_key": "local-secret",
                }}})
        self.assertEqual(public["ai"]["chat"]["base_url"], "http://127.0.0.1:8000/v1")
        self.assertTrue(public["ai"]["chat"]["api_key_configured"])

    def test_settings_writer_keeps_existing_key_when_ui_sends_empty_value(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-ai-") as temp:
            settings_path = Path(temp) / "settings.json"
            settings_path.write_text(json.dumps({"ai": {"chat": {
                "base_url": "https://chat.example/v1", "model": "chat-model", "api_key": "old-secret",
            }}}), encoding="utf-8")
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                _write_settings({"ai": {"chat": {"api_key": ""}}})
                stored = json.loads(settings_path.read_text(encoding="utf-8"))
                self.assertEqual(stored["ai"]["chat"]["api_key"], "old-secret")
                _write_settings({"ai": {"chat": {"clear_api_key": True}}})
                cleared = json.loads(settings_path.read_text(encoding="utf-8"))
        self.assertEqual(cleared["ai"]["chat"]["api_key"], "")

    def test_ai_profile_reuse_copies_saved_key_without_publishing_it(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-ai-reuse-") as temp:
            settings_path = Path(temp) / "settings.json"
            settings_path.write_text(json.dumps({"ai": {"translation": {
                "base_url": "https://shared.example/v1", "model": "shared-model", "api_key": "shared-secret",
            }}}), encoding="utf-8")
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _copy_ai_profile("translation", "chat")
            stored = json.loads(settings_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["ai"]["chat"]["api_key"], "shared-secret")
        self.assertEqual(public["ai"]["chat"]["base_url"], "https://shared.example/v1")
        self.assertTrue(public["ai"]["chat"]["api_key_configured"])
        self.assertNotIn("api_key", public["ai"]["chat"])

    def test_ai_profile_reuse_normalizes_translation_mode_in_both_directions(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-ai-reuse-mode-") as temp:
            settings_path = Path(temp) / "settings.json"
            settings_path.write_text(json.dumps({"ai": {
                "translation": {
                    "base_url": "https://translate.example/v1",
                    "model": "translate-model",
                    "api_key": "translate-secret",
                    "mode": "chat",
                },
                "chat": {
                    "base_url": "https://chat.example/v1",
                    "model": "chat-model",
                    "api_key": "chat-secret",
                },
            }}), encoding="utf-8")
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                _copy_ai_profile("translation", "chat")
                after_chat = json.loads(settings_path.read_text(encoding="utf-8"))
                self.assertNotIn("mode", after_chat["ai"]["chat"])
                _copy_ai_profile("chat", "translation")
                after_translation = json.loads(settings_path.read_text(encoding="utf-8"))

        self.assertEqual(after_translation["ai"]["translation"]["mode"], "chat")
        self.assertEqual(after_translation["ai"]["translation"]["base_url"], "https://translate.example/v1")
        self.assertEqual(after_translation["ai"]["translation"]["api_key"], "translate-secret")

    def test_ai_profile_reuse_does_not_copy_translation_mode_into_chat(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-ai-reuse-mode-") as temp:
            settings_path = Path(temp) / "settings.json"
            settings_path.write_text(json.dumps({"ai": {
                "translation": {
                    "base_url": "https://shared.example/v1",
                    "model": "shared-model",
                    "api_key": "shared-secret",
                    "mode": "chat",
                },
                "chat": {"base_url": "", "model": "", "api_key": ""},
            }}), encoding="utf-8")
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                _copy_ai_profile("translation", "chat")
            stored = json.loads(settings_path.read_text(encoding="utf-8"))
        self.assertNotIn("mode", stored["ai"]["chat"])

    def test_ai_profile_reuse_to_translation_preserves_target_protocol_mode(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-ai-reuse-target-mode-") as temp:
            settings_path = Path(temp) / "settings.json"
            settings_path.write_text(json.dumps({"ai": {
                "chat": {
                    "base_url": "https://shared.example/v1",
                    "model": "shared-model",
                    "api_key": "shared-secret",
                },
                "translation": {
                    "base_url": "https://old.example/v1",
                    "model": "old-model",
                    "api_key": "old-secret",
                    "mode": "chat",
                },
            }}), encoding="utf-8")
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                _copy_ai_profile("chat", "translation")
            stored = json.loads(settings_path.read_text(encoding="utf-8"))
        self.assertEqual(stored["ai"]["translation"]["base_url"], "https://shared.example/v1")
        self.assertEqual(stored["ai"]["translation"]["model"], "shared-model")
        self.assertEqual(stored["ai"]["translation"]["api_key"], "shared-secret")
        self.assertEqual(stored["ai"]["translation"]["mode"], "chat")

    def test_model_list_endpoint_uses_current_profile_and_returns_ids_only(self) -> None:
        handler = object.__new__(ScholarHandler)
        responses: list[dict] = []
        handler._read_json_body = lambda max_bytes=None: {
            "service": "chat",
            "profile": {"base_url": "https://models.example/v1", "api_key": "typed-secret"},
        }
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        with patch("server.ai_list_models", return_value=["model-a", "model-b"]) as list_models_mock:
            handler._list_ai_models()
        list_models_mock.assert_called_once_with("https://models.example/v1", "typed-secret")
        self.assertEqual(responses, [{"service": "chat", "models": ["model-a", "model-b"]}])

    def test_settings_writer_still_persists_non_ai_preferences_privately(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-safe-") as temp:
            settings_path = Path(temp) / "settings.json"
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _write_settings({"highlight_color": "#123ABC", "metadata": {"auto_retrieve": False}})
            stored = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(stored["highlight_color"], "#123ABC")
            self.assertFalse(stored["metadata"]["auto_retrieve"])
            self.assertEqual(public["highlight_color"], "#123ABC")
            self.assertEqual(settings_path.stat().st_mode & 0o777, 0o600)

    def test_settings_writer_round_trips_the_parsing_backend_and_rejects_others(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-parsing-") as temp:
            settings_path = Path(temp) / "settings.json"
            environment = {key: value for key, value in os.environ.items() if key != "MY_SCHOLAR_MINERU_BACKEND"}
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}), patch.dict(
                os.environ, environment, clear=True,
            ):
                self.assertEqual(_public_settings()["parsing"]["backend"], "pipeline")
                public = _write_settings({"parsing": {"backend": "hybrid-engine"}})
                self.assertEqual(public["parsing"]["backend"], "hybrid-engine")
                self.assertEqual(
                    json.loads(settings_path.read_text(encoding="utf-8"))["parsing"]["backend"],
                    "hybrid-engine",
                )
                # An unsupported backend must not reach the MinerU command line.
                self.assertEqual(
                    _write_settings({"parsing": {"backend": "vlm-engine"}})["parsing"]["backend"],
                    "pipeline",
                )

    def test_settings_writer_persists_allowlisted_appearance_privately(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-appearance-") as temp:
            settings_path = Path(temp) / "settings.json"
            appearance = {"app_font": "pingfang", "reader_font": "georgia", "accent": "violet"}
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _write_settings({"appearance": appearance})

            stored = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(stored["appearance"], appearance)
            self.assertEqual(public["appearance"], appearance)
            self.assertEqual(settings_path.stat().st_mode & 0o777, 0o600)

    def test_settings_writer_repairs_invalid_appearance_to_defaults(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-appearance-invalid-") as temp:
            settings_path = Path(temp) / "settings.json"
            invalid = {
                "app_font": "url(file:///tmp/font.woff2)",
                "reader_font": '"Comic Sans MS"',
                "accent": "#ff00ff",
                "custom_css": "body { display: none; }",
            }
            expected = {"app_font": "system", "reader_font": "academic", "accent": "amber"}
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _write_settings({"appearance": invalid})

            stored = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(stored["appearance"], expected)
            self.assertEqual(public["appearance"], expected)

    def test_appearance_updates_preserve_legacy_highlight_color(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-settings-legacy-highlight-") as temp:
            settings_path = Path(temp) / "settings.json"
            settings_path.write_text(json.dumps({"highlight_color": "#123ABC"}), encoding="utf-8")
            with patch("server.SETTINGS_PATH", settings_path), patch("server.ai_services", return_value={}):
                public = _write_settings({"appearance": {"accent": "blue"}})

            stored = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(stored["highlight_color"], "#123ABC")
            self.assertEqual(public["highlight_color"], "#123ABC")
            self.assertEqual(stored["appearance"], {
                "app_font": "system",
                "reader_font": "academic",
                "accent": "blue",
            })

    def test_ai_connection_endpoint_keeps_partial_results(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-ai-status-") as temp:
            history_path = Path(temp) / "ai-status-history.json"
            handler = object.__new__(ScholarHandler)
            responses: list[dict] = []
            handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
            handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)
            results = {
                "translation": {"ok": True, "model": "translation-model", "elapsed_ms": 12},
                "chat": {"ok": False, "error": "test failure", "profile_id": "private-profile"},
            }
            with (
                patch("server.ai_test_connections", return_value=results),
                patch.object(server_module, "AI_STATUS_HISTORY_PATH", history_path),
            ):
                handler._test_ai_connection()
                public = _public_settings()

            self.assertEqual(responses[0]["results"], results)
            record = responses[0]["record"]
            self.assertTrue(record["results"]["translation"]["ok"])
            self.assertEqual(record["results"]["translation"]["elapsed_ms"], 12)
            self.assertEqual(record["results"]["chat"]["error"], "test failure")
            self.assertNotIn("model", record["results"]["translation"])
            self.assertNotIn("profile_id", record["results"]["chat"])
            self.assertEqual(public["ai_status_history"], [record])
            self.assertEqual(history_path.stat().st_mode & 0o777, 0o600)

    def test_health_keeps_default_status_and_adds_both_services(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler.path = "/api/health"
        responses: list[dict] = []
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        services = {"translation": {"enabled": True}, "chat": {"enabled": False}}
        with (
            patch("server.ai_status", return_value={"service": "chat", "enabled": False}),
            patch("server.ai_services", return_value=services),
            patch.object(server_module, "AI_REQUIRES_MEMBER", False),
        ):
            handler.do_GET()
        self.assertEqual(responses[0]["ai"]["service"], "chat")
        self.assertEqual(responses[0]["ai"]["services"], services)
        self.assertIn("account", responses[0])
        self.assertIn("library_id", responses[0]["storage"])
        self.assertIn("migration", responses[0]["storage"])
        self.assertNotIn("library_dir", responses[0]["storage"])
        self.assertNotIn("state_dir", responses[0]["storage"])

    def test_health_gates_ai_services_when_not_logged_in(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler.path = "/api/health"
        responses: list[dict] = []
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        services = {"translation": {"enabled": True}, "chat": {"enabled": True}}
        with (
            tempfile.TemporaryDirectory(prefix="my-scholar-health-account-") as temp,
            patch("server.ai_status", return_value={"service": "chat", "enabled": True}),
            patch("server.ai_services", return_value=services),
            patch.object(server_module, "ACCOUNT_FILE", Path(temp) / "account.json"),
            patch.object(server_module, "AI_REQUIRES_MEMBER", True),
        ):
            handler.do_GET()
        self.assertFalse(responses[0]["ai"]["services"]["translation"]["enabled"])
        self.assertFalse(responses[0]["account"]["logged_in"])


class AnnotationBoundaryTest(unittest.TestCase):
    def _handler(self, job_dir: Path, payload: dict) -> tuple[ScholarHandler, list[dict]]:
        handler = object.__new__(ScholarHandler)
        responses: list[dict] = []
        handler._completed_job_dir = lambda _job_id: job_dir
        handler._read_json_body = lambda **_kwargs: payload
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)
        return handler, responses

    @staticmethod
    def _error_handler(job_dir: Path, payload: dict) -> tuple[ScholarHandler, list[tuple[str, HTTPStatus]]]:
        handler = object.__new__(ScholarHandler)
        errors: list[tuple[str, HTTPStatus]] = []
        handler._completed_job_dir = lambda _job_id: job_dir
        handler._read_json_body = lambda **_kwargs: payload
        handler._send_json = lambda body, *_args, **_kwargs: errors.append((f"unexpected response: {body}", HTTPStatus.OK))
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST: errors.append((message, status))
        return handler, errors

    def test_manual_and_ai_annotations_with_the_same_quote_are_independent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-annotation-source-") as temp:
            job_dir = Path(temp)
            manual_payload = {"kind": "highlight", "quote": "Shared quote", "block_id": "body", "start": 0, "end": 12}
            handler, responses = self._handler(job_dir, manual_payload)
            handler._add_annotation("a" * 16)
            self.assertEqual(responses[-1]["annotation"]["source"], "manual")

            ai_payload = {"kind": "highlight", "quote": "Shared quote", "block_id": "body", "source": "ai", "category": "method"}
            handler._read_json_body = lambda **_kwargs: ai_payload
            handler._add_annotation("a" * 16)
            annotations = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual([item["source"] for item in annotations], ["manual", "ai"])

            handler._read_json_body = lambda **_kwargs: manual_payload
            handler._add_annotation("a" * 16)
            annotations = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual(len(annotations), 2)

    def test_identical_manual_quotes_at_different_offsets_are_independent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-annotation-offset-") as temp:
            job_dir = Path(temp)
            first_payload = {
                "kind": "underline",
                "quote": "Repeated quote",
                "block_id": "body",
                "surface": "paper",
                "start": 0,
                "end": 14,
            }
            handler, responses = self._handler(job_dir, first_payload)
            handler._add_annotation("a" * 16)
            first_id = responses[-1]["annotation"]["id"]

            second_payload = {**first_payload, "start": 20, "end": 34}
            handler._read_json_body = lambda **_kwargs: second_payload
            handler._add_annotation("a" * 16)
            second_id = responses[-1]["annotation"]["id"]

            handler._read_json_body = lambda **_kwargs: first_payload
            handler._add_annotation("a" * 16)
            annotations = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual(len(annotations), 2)
            self.assertEqual([item["start"] for item in annotations], [0, 20])
            self.assertNotEqual(first_id, second_id)
            self.assertEqual(responses[-1]["annotation"]["id"], first_id)

    def test_annotation_color_patch_accepts_only_valid_hex_colors(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-annotation-color-") as temp:
            job_dir = Path(temp)
            annotation = {"id": "annotation-1", "kind": "highlight", "quote": "Quote", "source": "manual", "color": "#f59e0b"}
            (job_dir / "annotations.json").write_text(json.dumps([annotation]), encoding="utf-8")
            handler, responses = self._handler(job_dir, {"color": "#123ABC"})
            handler._update_annotation("a" * 16, "annotation-1")
            self.assertEqual(responses[-1]["annotation"]["color"], "#123ABC")

            handler._read_json_body = lambda **_kwargs: {"color": "orange"}
            handler._update_annotation("a" * 16, "annotation-1")
            self.assertEqual(responses[-1]["annotation"]["color"], "#f59e0b")

    def test_annotation_note_patch_keeps_the_selected_color_and_asset_reference(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-annotation-note-") as temp:
            job_dir = Path(temp)
            annotation = {"id": "annotation-1", "kind": "highlight", "quote": "Quote", "source": "manual", "color": "#5fb236"}
            (job_dir / "annotations.json").write_text(json.dumps([annotation]), encoding="utf-8")
            asset_ref = f"assets/{'a' * 64}.png"
            handler, responses = self._handler(job_dir, {"note": f"![图]({asset_ref})"})
            handler._update_annotation("a" * 16, "annotation-1")
            self.assertEqual(responses[-1]["annotation"]["color"], "#5fb236")
            self.assertEqual(responses[-1]["annotation"]["note"], f"![图]({asset_ref})")

    def test_manual_annotation_kind_patch_preserves_anchor_and_metadata(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-annotation-kind-") as temp:
            job_dir = Path(temp)
            annotation = {
                "id": "annotation-1",
                "kind": "underline",
                "color": "#5fb236",
                "note": "Keep this note",
                "quote": "Selected text",
                "page": 3,
                "block_id": "body-3",
                "start": 7,
                "end": 20,
                "source": "manual",
                "surface": "translation",
                "source_block_id": "source-3",
                "created_at": "2026-08-17T01:02:03Z",
            }
            (job_dir / "annotations.json").write_text(json.dumps([annotation]), encoding="utf-8")
            handler, responses = self._handler(job_dir, {"kind": "highlight"})
            handler._update_annotation("a" * 16, annotation["id"])

            converted = responses[-1]["annotation"]
            self.assertEqual(converted["kind"], "highlight")
            for field in ("id", "color", "note", "start", "end", "surface", "source_block_id", "created_at"):
                self.assertEqual(converted[field], annotation[field])
            persisted = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted, [converted])

            handler._read_json_body = lambda **_kwargs: {"kind": "underline"}
            handler._update_annotation("a" * 16, annotation["id"])
            self.assertEqual(responses[-1]["annotation"]["kind"], "underline")

    def test_annotation_kind_patch_rejects_unknown_kind_without_mutation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-annotation-kind-invalid-") as temp:
            job_dir = Path(temp)
            annotation = {"id": "annotation-1", "kind": "highlight", "quote": "Quote", "source": "manual", "color": "#5fb236"}
            (job_dir / "annotations.json").write_text(json.dumps([annotation]), encoding="utf-8")
            handler, errors = self._error_handler(job_dir, {"kind": "strike", "note": "must not be written"})
            handler._update_annotation("a" * 16, annotation["id"])

            self.assertEqual(errors, [("标注类型只能是 highlight 或 underline。", HTTPStatus.BAD_REQUEST)])
            persisted = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted, [annotation])

    def test_annotation_kind_patch_rejects_ai_annotation_without_mutation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-annotation-kind-ai-") as temp:
            job_dir = Path(temp)
            annotation = {"id": "annotation-ai", "kind": "highlight", "quote": "Quote", "source": "ai", "note": "AI reason"}
            (job_dir / "annotations.json").write_text(json.dumps([annotation]), encoding="utf-8")
            handler, errors = self._error_handler(job_dir, {"kind": "underline", "note": "must not be written"})
            handler._update_annotation("a" * 16, annotation["id"])

            self.assertEqual(errors, [("只有人工标注可以切换高亮或划线。", HTTPStatus.BAD_REQUEST)])
            persisted = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted, [annotation])

    def test_annotation_kind_patch_returns_conflict_for_existing_target_anchor(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-annotation-kind-conflict-") as temp:
            job_dir = Path(temp)
            shared_anchor = {
                "quote": "Selected text",
                "page": 3,
                "block_id": "body-3",
                "start": 7,
                "end": 20,
                "source": "manual",
                "surface": "translation",
                "source_block_id": "source-3",
            }
            annotations = [
                {"id": "underline-1", "kind": "underline", "color": "#5fb236", "note": "Underline note", **shared_anchor},
                {"id": "highlight-1", "kind": "highlight", "color": "#f59e0b", "note": "Highlight note", **shared_anchor},
            ]
            (job_dir / "annotations.json").write_text(json.dumps(annotations), encoding="utf-8")
            handler, errors = self._error_handler(
                job_dir,
                {"kind": "highlight", "color": "#123ABC", "note": "must not overwrite either note"},
            )
            handler._update_annotation("a" * 16, "underline-1")

            self.assertEqual(errors, [("同一选区已存在目标类型的标注。", HTTPStatus.CONFLICT)])
            persisted = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted, annotations)

    def test_clear_annotations_deletes_manual_notes_and_keeps_ai_highlights(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-clear-annotations-") as temp:
            job_dir = Path(temp)
            annotations = [
                {"id": "manual", "kind": "highlight", "source": "manual", "start": 0, "end": 5},
                {"id": "manual-underline", "kind": "underline", "start": 2, "end": 8},
                {"id": "ai", "kind": "highlight", "source": "ai", "start": None, "end": None},
                {"id": "legacy-ai", "kind": "highlight", "start": None, "end": None},
            ]
            (job_dir / "annotations.json").write_text(json.dumps(annotations), encoding="utf-8")
            handler, responses = self._handler(job_dir, {})
            handler._delete_manual_annotations("a" * 16)
            self.assertEqual(responses[-1]["deleted"], 2)
            self.assertEqual([item["id"] for item in responses[-1]["annotations"]], ["ai", "legacy-ai"])
            persisted = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual([item["id"] for item in persisted], ["ai", "legacy-ai"])

    def test_ignored_ai_suggestion_survives_empty_and_repeated_sync(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-ignore-ai-suggestion-") as temp:
            job_dir = Path(temp)
            suggestion = {"block_id": "body", "quote": "Important sentence.", "category": "method", "reason": "Key method"}
            annotation = {
                "id": "ai-suggestion",
                "kind": "highlight",
                "source": "ai",
                "block_id": suggestion["block_id"],
                "quote": suggestion["quote"],
                "category": suggestion["category"],
                "start": None,
                "end": None,
            }
            (job_dir / "annotations.json").write_text(json.dumps([annotation]), encoding="utf-8")
            handler, responses = self._handler(job_dir, {"suggestion_state": "ignored"})
            handler._update_annotation("a" * 16, annotation["id"])
            self.assertEqual(responses[-1]["annotation"]["suggestion_state"], "ignored")

            _sync_ai_annotations(job_dir, {"highlights": []})
            after_empty = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual([item["id"] for item in after_empty], [annotation["id"]])
            self.assertEqual(after_empty[0]["suggestion_state"], "ignored")

            _sync_ai_annotations(job_dir, {"highlights": [suggestion]})
            after_repeat = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual(len(after_repeat), 1)
            self.assertEqual(after_repeat[0]["suggestion_state"], "ignored")
            self.assertEqual(after_repeat[0]["source"], "ai")
            self.assertEqual(after_repeat[0]["note"], suggestion["reason"])

    def test_ai_sync_prefers_ignored_duplicate_regardless_of_order(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-ignore-ai-duplicate-") as temp:
            job_dir = Path(temp)
            suggestion = {"block_id": "body", "quote": "Important sentence.", "category": "method", "reason": "Updated reason"}
            suggested = {"id": "suggested", "kind": "highlight", "source": "ai", "block_id": "body", "quote": "Important sentence.", "suggestion_state": "suggested"}
            ignored = {"id": "ignored", "kind": "highlight", "source": "ai", "block_id": "body", "quote": "Important sentence.", "suggestion_state": "ignored"}
            for order in ([suggested, ignored], [ignored, suggested]):
                with self.subTest(order=[item["id"] for item in order]):
                    (job_dir / "annotations.json").write_text(json.dumps(order), encoding="utf-8")
                    _sync_ai_annotations(job_dir, {"highlights": [suggestion]})
                    persisted = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
                    self.assertEqual(len(persisted), 1)
                    self.assertEqual(persisted[0]["id"], "ignored")
                    self.assertEqual(persisted[0]["suggestion_state"], "ignored")
                    self.assertEqual(persisted[0]["note"], suggestion["reason"])

            duplicate_ignored = [dict(ignored, id="ignored-first"), dict(ignored, id="ignored-second")]
            (job_dir / "annotations.json").write_text(json.dumps(duplicate_ignored), encoding="utf-8")
            _sync_ai_annotations(job_dir, {"highlights": []})
            persisted = json.loads((job_dir / "annotations.json").read_text(encoding="utf-8"))
            self.assertEqual(len(persisted), 1)
            self.assertEqual(persisted[0]["suggestion_state"], "ignored")


class NoteAssetTest(unittest.TestCase):
    def test_note_image_magic_bytes_are_validated(self) -> None:
        self.assertEqual(_note_image_type(b"\x89PNG\r\n\x1a\nrest"), ("png", "image/png"))
        self.assertEqual(_note_image_type(b"\xff\xd8\xffrest"), ("jpg", "image/jpeg"))
        self.assertEqual(_note_image_type(b"GIF89arest"), ("gif", "image/gif"))
        self.assertEqual(_note_image_type(b"RIFF\x04\x00\x00\x00WEBPrest"), ("webp", "image/webp"))
        with self.assertRaisesRegex(Exception, "仅支持"):
            _note_image_type(b"<svg></svg>")

    def test_note_asset_is_content_addressed_and_deduplicated(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-note-asset-") as temp:
            job_dir = Path(temp)
            data = b"\x89PNG\r\n\x1a\nsmall-note-image"
            first = _store_note_asset(job_dir, data)
            second = _store_note_asset(job_dir, data)
            self.assertEqual(first, second)
            target = job_dir / "content" / "notes" / first["ref"]
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(len(list((job_dir / "content" / "notes" / "assets").iterdir())), 1)
            manifest = json.loads((job_dir / "content" / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["note_assets"], "notes/assets/")

    def test_note_asset_rejects_oversized_images(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-note-limit-") as temp:
            with self.assertRaisesRegex(Exception, "超过 5 MB"):
                _store_note_asset(Path(temp), b"\x89PNG\r\n\x1a\n" + b"x" * MAX_NOTE_ASSET_BYTES)


class ChatImageContextTest(unittest.TestCase):
    def test_current_job_image_becomes_a_bounded_data_url(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-chat-image-") as temp:
            job_dir = Path(temp)
            image = job_dir / "assets" / "images" / "figure.png"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"\x89PNG\r\n\x1a\nsmall-paper-figure")
            result = _chat_image_context(job_dir, {
                "path": "assets/images/figure.png",
                "caption": "Figure 1. Overview.",
                "block_id": "block-3-0-image",
                "page": 3,
            })
            self.assertTrue(result["data_url"].startswith("data:image/png;base64,"))
            self.assertEqual(result["caption"], "Figure 1. Overview.")
            self.assertEqual(result["block_id"], "block-3-0-image")
            self.assertEqual(result["page"], "3")

    def test_chat_image_rejects_traversal_and_oversized_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-chat-image-safety-") as temp:
            job_dir = Path(temp)
            image_root = job_dir / "assets" / "images"
            image_root.mkdir(parents=True)
            (job_dir / "secret.png").write_bytes(b"\x89PNG\r\n\x1a\nsecret")
            with self.assertRaisesRegex(PipelineError, "路径无效"):
                _chat_image_context(job_dir, {"path": "assets/images/../../secret.png"})
            oversized = image_root / "oversized.png"
            oversized.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * MAX_CHAT_IMAGE_BYTES)
            with self.assertRaisesRegex(PipelineError, "超过 5 MB"):
                _chat_image_context(job_dir, {"path": "assets/images/oversized.png"})


class ReflowTest(unittest.TestCase):
    @staticmethod
    def _completed_store(root: Path) -> tuple[JobStore, dict, bytes]:
        store = JobStore(root)
        source = b"%PDF-1.4\noriginal-source"
        record = store.create("paper.pdf", len(source))
        job_dir = Path(record["job_dir"])
        (job_dir / "source.pdf").write_bytes(source)
        manifest = {"job_id": record["job_id"], "source": {"filename": "paper.pdf", "bytes": len(source)}, "counts": {"pages": 1}}
        (job_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        store.update(record["job_id"], status="completed", source_sha256=hashlib.sha256(source).hexdigest(), manifest=manifest)
        return store, store.get(record["job_id"]), source

    @staticmethod
    def _registry(provider: Optional[Any] = None) -> MagicMock:
        active_provider = provider if provider is not None else MagicMock()
        if provider is None:
            active_provider.capability.return_value = {"id": "local-mineru", "state": "ready", "ready": True}
        registry = MagicMock()
        registry.get.return_value = active_provider
        return registry

    def test_begin_reflow_is_atomic_and_rejects_duplicates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-claim-") as temp:
            store, record, _ = self._completed_store(Path(temp))

            def begin(_index: int) -> str:
                try:
                    store.begin_reflow(record["job_id"])
                    return "accepted"
                except server_module.ReflowConflictError:
                    return "conflict"

            with ThreadPoolExecutor(max_workers=12) as executor:
                results = list(executor.map(begin, range(24)))
            self.assertEqual(results.count("accepted"), 1)
            self.assertEqual(results.count("conflict"), 23)
            self.assertEqual(store.get(record["job_id"])["status"], "completed")

    def test_reflow_cancel_transitions_are_generation_safe(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-cancel-") as temp:
            store, record, _ = self._completed_store(Path(temp))
            queued = store.begin_reflow(record["job_id"])
            generation = queued["reflow"]["generation"]
            cancelled = store.request_reflow_cancel(record["job_id"])
            self.assertEqual(cancelled["reflow"]["status"], "cancelled")
            self.assertIsNone(store.claim_reflow(record["job_id"], generation))

            next_record = store.begin_reflow(record["job_id"])
            next_generation = next_record["reflow"]["generation"]
            self.assertGreater(next_generation, generation)
            self.assertIsNotNone(store.claim_reflow(record["job_id"], next_generation))
            cancelling = store.request_reflow_cancel(record["job_id"])
            self.assertEqual(cancelling["reflow"]["status"], "cancelling")
            self.assertFalse(store.update_reflow(
                record["job_id"],
                next_generation,
                expected_statuses={"running"},
                status="running",
                progress=0.8,
            ))
            self.assertFalse(store.complete_reflow(record["job_id"], next_generation, {}, {}))

    def test_reflow_success_switches_generation_without_touching_user_data(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-success-") as temp:
            store, record, source = self._completed_store(Path(temp))
            job_dir = Path(record["job_dir"])
            preserved = {
                "annotations.json": b'[{"id":"note-1"}]',
                "notes.md": b"# Notes",
                "translations.json": b'{"version":1,"entries":{}}',
                "media-layout.json": b'{"version":1,"items":{}}',
                "content/notes/assets/asset.png": b"note-image",
            }
            for relative, body in preserved.items():
                target = job_dir / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(body)
            queued = store.begin_reflow(record["job_id"])
            generation = queued["reflow"]["generation"]

            def fake_run(request: Any, **kwargs: Any) -> Any:
                output = Path(request.output_dir)
                self.assertEqual(Path(request.source_pdf).read_bytes(), source)
                (output / "source.pdf").write_bytes(source)
                (output / "document.html").write_text("<html>new</html>", encoding="utf-8")
                (output / "document.json").write_text("{}", encoding="utf-8")
                (output / "document-ir.json").write_text("{}", encoding="utf-8")
                (output / "validation.json").write_text(json.dumps({"status": "PASS"}), encoding="utf-8")
                manifest = {"job_id": record["job_id"], "source": {"filename": "paper.pdf"}, "validation": {"status": "PASS"}}
                (output / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                kwargs["progress"]("生成语义文档", 0.7)
                return SimpleNamespace(manifest=manifest, metrics={"provider_id": "local-mineru"})

            provider = MagicMock()
            provider.run.side_effect = fake_run

            with (
                patch.object(server_module, "STORE", store),
                patch.object(server_module, "_parsing_provider_registry", return_value=self._registry(provider)),
                patch.object(server_module, "_enqueue_metadata") as enqueue_metadata,
            ):
                server_module._run_reflow_job(record["job_id"], "paper.pdf", generation)

            current = store.get(record["job_id"])
            self.assertEqual(current["status"], "completed")
            self.assertEqual(current["active_render"], generation)
            self.assertEqual(current["reflow"]["status"], "completed")
            self.assertTrue((job_dir / "renders" / str(generation) / "document.html").is_file())
            for relative, body in preserved.items():
                self.assertEqual((job_dir / relative).read_bytes(), body)
            provider.run.assert_called_once()
            enqueue_metadata.assert_called_once_with(record["job_id"], False, "refine", force=True)
            public = server_module._public_job(current)
            expected_url = f"/api/jobs/{record['job_id']}/renders/{generation}/document.html"
            self.assertEqual(public["links"]["html"], expected_url)
            self.assertEqual(public["reflow"]["document_url"], expected_url)

    def test_reflow_failure_keeps_the_active_document(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-failure-") as temp:
            store, record, _ = self._completed_store(Path(temp))
            queued = store.begin_reflow(record["job_id"])
            generation = queued["reflow"]["generation"]
            old_url = server_module._public_job(record)["links"]["html"]
            provider = MagicMock()
            provider.run.side_effect = PipelineError("layout unavailable")
            with patch.object(server_module, "STORE", store), patch.object(
                server_module, "_parsing_provider_registry", return_value=self._registry(provider)
            ):
                server_module._run_reflow_job(record["job_id"], "paper.pdf", generation)
            current = store.get(record["job_id"])
            self.assertEqual(current["status"], "completed")
            self.assertNotIn("active_render", current)
            self.assertEqual(current["reflow"]["status"], "failed")
            self.assertEqual(server_module._public_job(current)["links"]["html"], old_url)

    def test_start_reflow_returns_public_job_and_conflicts_on_repeat(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-api-") as temp:
            store, record, _ = self._completed_store(Path(temp))
            handler = object.__new__(ScholarHandler)
            responses: list[tuple[dict, HTTPStatus]] = []
            errors: list[tuple[str, HTTPStatus]] = []
            handler._send_json = lambda body, status=HTTPStatus.OK: responses.append((body, status))
            handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **_kwargs: errors.append((message, status))
            work_queue: queue.Queue = queue.Queue()
            with patch.object(server_module, "STORE", store), patch.object(server_module, "REFLOW_QUEUE", work_queue), patch.object(
                server_module, "_parsing_provider_registry", return_value=self._registry()
            ):
                handler._start_reflow(record["job_id"])
                handler._start_reflow(record["job_id"])
            self.assertEqual(responses[0][1], HTTPStatus.ACCEPTED)
            self.assertEqual(responses[0][0]["status"], "completed")
            self.assertEqual(responses[0][0]["reflow"]["status"], "queued")
            self.assertIsNone(responses[0][0]["reflow"]["document_url"])
            self.assertEqual(errors[-1][1], HTTPStatus.CONFLICT)
            self.assertEqual(work_queue.qsize(), 1)

    def test_start_reflow_preflight_fails_before_reserving_generation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-preflight-") as temp:
            store, record, _ = self._completed_store(Path(temp))
            provider = MagicMock()
            provider.capability.return_value = {
                "id": "local-mineru",
                "state": "artifact_unavailable",
                "reason_code": "artifact_unavailable",
                "ready": False,
                "message": "本地版面引擎 artifact 尚未提供。",
            }
            handler = object.__new__(ScholarHandler)
            errors: list[tuple[str, HTTPStatus, dict]] = []
            handler._send_json = lambda *_args, **_kwargs: self.fail("unexpected success")
            handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **kwargs: errors.append((message, status, kwargs))
            work_queue: queue.Queue = queue.Queue()
            with patch.object(server_module, "STORE", store), patch.object(server_module, "REFLOW_QUEUE", work_queue), patch.object(
                server_module, "_parsing_provider_registry", return_value=self._registry(provider)
            ):
                handler._start_reflow(record["job_id"])
            self.assertNotIn("reflow", store.get(record["job_id"]))
            self.assertEqual(work_queue.qsize(), 0)
            self.assertEqual(errors[0][1], HTTPStatus.PRECONDITION_REQUIRED)
            self.assertEqual(errors[0][2]["code"], "artifact_unavailable")

    def test_start_reflow_rejects_active_component_install_before_reserving_generation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-install-race-") as temp:
            store, record, _ = self._completed_store(Path(temp))
            handler = object.__new__(ScholarHandler)
            errors: list[tuple[str, HTTPStatus, dict]] = []
            handler._send_json = lambda *_args, **_kwargs: self.fail("unexpected success")
            handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **kwargs: errors.append((message, status, kwargs))
            install_thread = MagicMock()
            install_thread.is_alive.return_value = True
            with patch.object(server_module, "STORE", store), patch.object(
                server_module, "PARSING_INSTALL_THREAD", install_thread
            ), patch.object(server_module, "_parsing_provider_registry", return_value=self._registry()):
                handler._start_reflow(record["job_id"])
            self.assertNotIn("reflow", store.get(record["job_id"]))
            self.assertEqual(errors[0][1], HTTPStatus.CONFLICT)
            self.assertEqual(errors[0][2]["code"], "busy")

    def test_cancel_reflow_sets_the_live_cancel_event(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-cancel-api-") as temp:
            store, record, _ = self._completed_store(Path(temp))
            queued = store.begin_reflow(record["job_id"])
            generation = queued["reflow"]["generation"]
            handler = object.__new__(ScholarHandler)
            responses: list[tuple[dict, HTTPStatus]] = []
            handler._send_json = lambda body, status=HTTPStatus.OK: responses.append((body, status))
            handler._send_error_json = lambda *_args, **_kwargs: self.fail("unexpected error")
            with patch.object(server_module, "STORE", store):
                handler._cancel_reflow(record["job_id"])
            self.assertEqual(responses[0][0]["reflow"]["status"], "cancelled")
            self.assertTrue(server_module._reflow_cancel_event(record["job_id"], generation).is_set())
            server_module._forget_reflow_cancel_event(record["job_id"], generation)

    def test_post_reflow_route_dispatches_to_single_contract(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler.path = f"/api/jobs/{'a' * 16}/reflow"
        dispatched: list[str] = []
        handler._start_reflow = lambda job_id: dispatched.append(job_id)
        with patch.object(server_module, "AI_REQUIRES_MEMBER", False):
            handler.do_POST()
        self.assertEqual(dispatched, ["a" * 16])

    def test_parsing_provider_status_route_returns_local_and_disabled_remote(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler.path = "/api/parsing/providers"
        responses: list[dict] = []
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        registry = MagicMock()
        registry.list_capabilities.return_value = [
            {"id": "local-mineru", "state": "artifact_unavailable", "ready": False},
            {"id": "remote-guzi", "state": "disabled", "reason_code": "not_configured", "ready": False},
        ]
        with patch.object(server_module, "_parsing_provider_registry", return_value=registry):
            handler.do_GET()
        self.assertEqual([item["id"] for item in responses[0]["providers"]], ["local-mineru", "remote-guzi"])

    def test_provider_discovery_returns_candidates_and_provider_status(self) -> None:
        handler = object.__new__(ScholarHandler)
        responses: list[tuple[dict, HTTPStatus]] = []
        handler._send_json = lambda payload, status=HTTPStatus.OK: responses.append((payload, status))
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **kwargs: self.fail(
            f"unexpected discovery error: {message} {status} {kwargs}"
        )
        result = {
            "provider": {"id": "local-mineru", "state": "ready", "ready": True},
            "candidates": [{"executable": "/opt/mineru/bin/mineru"}],
            "candidate_count": 1,
            "failures": [],
            "auto_selected": True,
            "selected": {"executable": "/opt/mineru/bin/mineru"},
        }
        provider = MagicMock()
        provider.discover_external.return_value = result
        registry = MagicMock()
        registry.get.return_value = provider
        with patch.object(server_module, "STORE", None), patch.object(
            server_module, "PARSING_INSTALL_THREAD", None
        ), patch.object(server_module, "_parsing_provider_registry", return_value=registry):
            handler._discover_provider_external("local-mineru")
        self.assertEqual(responses, [(result, HTTPStatus.OK)])
        provider.discover_external.assert_called_once_with()

    def test_provider_select_uses_explicit_external_path_synchronously(self) -> None:
        handler = object.__new__(ScholarHandler)
        body = json.dumps({"path": "/opt/mineru"}).encode("utf-8")
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        responses: list[tuple[dict, HTTPStatus]] = []
        handler._send_json = lambda payload, status=HTTPStatus.OK: responses.append((payload, status))
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **kwargs: self.fail(
            f"unexpected select error: {message} {status} {kwargs}"
        )
        provider = MagicMock()
        provider.capability.return_value = {"id": "local-mineru", "can_import": True}
        provider.select_external.return_value = {"id": "local-mineru", "state": "ready", "ready": True}
        registry = MagicMock()
        registry.get.return_value = provider
        with patch.object(server_module, "STORE", None), patch.object(
            server_module, "PARSING_INSTALL_THREAD", None
        ), patch.object(server_module, "_parsing_provider_registry", return_value=registry):
            handler._select_provider_external("local-mineru")
        self.assertTrue(responses[0][0]["provider"]["ready"])
        provider.select_external.assert_called_once_with(Path("/opt/mineru"))

    def test_provider_discovery_rejects_an_active_component_operation(self) -> None:
        handler = object.__new__(ScholarHandler)
        errors: list[tuple[str, HTTPStatus, dict]] = []
        handler._send_json = lambda *_args, **_kwargs: self.fail("unexpected discovery success")
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **kwargs: errors.append(
            (message, status, kwargs)
        )
        provider = MagicMock()
        registry = MagicMock()
        registry.get.return_value = provider
        active_thread = MagicMock()
        active_thread.is_alive.return_value = True
        with patch.object(server_module, "STORE", None), patch.object(
            server_module, "PARSING_INSTALL_THREAD", active_thread
        ), patch.object(server_module, "_parsing_provider_registry", return_value=registry):
            handler._discover_provider_external("local-mineru")
        self.assertEqual(errors[0][1], HTTPStatus.CONFLICT)
        self.assertEqual(errors[0][2]["code"], "busy")
        provider.discover_external.assert_not_called()

    def test_post_routes_dispatch_external_discovery_and_selection(self) -> None:
        discover = object.__new__(ScholarHandler)
        discover.path = "/api/parsing/providers/local-mineru/discover"
        discovered: list[str] = []
        discover._discover_provider_external = lambda provider_id: discovered.append(provider_id)
        discover.do_POST()

        select = object.__new__(ScholarHandler)
        select.path = "/api/parsing/providers/local-mineru/select"
        selected: list[str] = []
        select._select_provider_external = lambda provider_id: selected.append(provider_id)
        select.do_POST()
        self.assertEqual(discovered, ["local-mineru"])
        self.assertEqual(selected, ["local-mineru"])

    def test_provider_install_rejects_unpublished_artifact_without_starting_thread(self) -> None:
        handler = object.__new__(ScholarHandler)
        errors: list[tuple[str, HTTPStatus, dict]] = []
        handler._send_json = lambda *_args, **_kwargs: self.fail("unexpected success")
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **kwargs: errors.append((message, status, kwargs))
        provider = MagicMock()
        provider.capability.return_value = {
            "id": "local-mineru",
            "state": "artifact_unavailable",
            "reason_code": "artifact_unavailable",
            "ready": False,
            "can_install": False,
            "message": "本地版面引擎 artifact 尚未提供。",
        }
        registry = MagicMock()
        registry.get.return_value = provider
        with patch.object(server_module, "_parsing_provider_registry", return_value=registry), patch.object(
            server_module, "PARSING_INSTALL_THREAD", None
        ):
            handler._start_provider_install("local-mineru")
        provider.install.assert_not_called()
        self.assertEqual(errors[0][1], HTTPStatus.PRECONDITION_REQUIRED)
        self.assertEqual(errors[0][2]["code"], "artifact_unavailable")

    def test_provider_import_starts_only_for_explicit_component_directory(self) -> None:
        handler = object.__new__(ScholarHandler)
        body = json.dumps({"path": "/tmp/mineru-component"}).encode("utf-8")
        handler.headers = {"Content-Length": str(len(body))}
        handler.rfile = io.BytesIO(body)
        responses: list[tuple[dict, HTTPStatus]] = []
        handler._send_json = lambda payload, status=HTTPStatus.OK: responses.append((payload, status))
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **kwargs: self.fail(f"unexpected import error: {message} {status} {kwargs}")
        provider = MagicMock()
        provider.capability.return_value = {"id": "local-mineru", "ready": False, "can_import": True, "state": "artifact_unavailable"}
        registry = MagicMock()
        registry.get.return_value = provider
        thread = MagicMock()
        with patch.object(server_module, "STORE", None), patch.object(server_module, "PARSING_INSTALL_THREAD", None), patch.object(
            server_module, "_parsing_provider_registry", return_value=registry
        ), patch.object(server_module.threading, "Thread", return_value=thread) as thread_factory:
            handler._start_provider_import("local-mineru")
        self.assertEqual(responses[0][1], HTTPStatus.ACCEPTED)
        self.assertEqual(responses[0][0]["provider"]["state"], "importing")
        thread_factory.assert_called_once()
        self.assertEqual(thread_factory.call_args.kwargs["args"], ("local-mineru", Path("/tmp/mineru-component")))
        thread.start.assert_called_once()

    def test_start_reflow_rejects_missing_incomplete_and_readonly_jobs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-boundary-") as temp:
            store, record, _ = self._completed_store(Path(temp))
            handler = object.__new__(ScholarHandler)
            errors: list[tuple[str, HTTPStatus]] = []
            handler._send_json = lambda *_args, **_kwargs: self.fail("unexpected success")
            handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST, **_kwargs: errors.append((message, status))
            with patch.object(server_module, "STORE", store), patch.object(
                server_module, "_parsing_provider_registry", return_value=self._registry()
            ):
                handler._start_reflow("f" * 16)
                store.update(record["job_id"], status="running")
                handler._start_reflow(record["job_id"])
                store.update(record["job_id"], status="completed")
                with patch.object(server_module.runtime, "READONLY_MODE", True):
                    handler._start_reflow(record["job_id"])
            self.assertEqual([status for _message, status in errors], [HTTPStatus.NOT_FOUND, HTTPStatus.CONFLICT, HTTPStatus.FORBIDDEN])

    def test_interrupted_reflow_recovers_as_failed_without_switching_render(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-restart-") as temp:
            root = Path(temp)
            store, record, _ = self._completed_store(root)
            queued = store.begin_reflow(record["job_id"])
            store.claim_reflow(record["job_id"], queued["reflow"]["generation"])
            restored = JobStore(root).get(record["job_id"])
            self.assertEqual(restored["status"], "completed")
            self.assertEqual(restored["reflow"]["status"], "failed")
            self.assertNotIn("active_render", restored)

    def test_render_route_allows_known_generation_files_and_blocks_traversal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reflow-route-") as temp:
            store, record, _ = self._completed_store(Path(temp))
            target = Path(record["job_dir"]) / "renders" / "1" / "assets" / "images" / "figure@576.png"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"png")
            handler = object.__new__(ScholarHandler)
            served: list[Path] = []
            errors: list[HTTPStatus] = []
            handler._serve_file = lambda path, **_kwargs: served.append(path)
            handler._send_error_json = lambda _message, status=HTTPStatus.BAD_REQUEST: errors.append(status)
            with patch.object(server_module, "STORE", store):
                handler._serve_job_artifact(record["job_id"], "renders/1/assets/images/figure@576.png", "")
                handler._serve_job_artifact(record["job_id"], "renders/1/../../source.pdf", "")
            self.assertEqual(served, [target.resolve()])
            self.assertEqual(errors, [HTTPStatus.NOT_FOUND])


class ReferenceSummaryTest(unittest.TestCase):
    @staticmethod
    def _handler(job_dir: Path, payload: dict) -> tuple[ScholarHandler, list[dict], list[tuple[str, HTTPStatus]]]:
        handler = object.__new__(ScholarHandler)
        responses: list[dict] = []
        errors: list[tuple[str, HTTPStatus]] = []
        handler._completed_job_dir = lambda _job_id: job_dir
        handler._read_json_body = lambda **_kwargs: payload
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST: errors.append((message, status))
        return handler, responses, errors

    def test_reference_summary_uses_fixed_retrieval_and_returns_provenance(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reference-summary-") as temp:
            handler, responses, errors = self._handler(Path(temp), {
                "reference_number": "7",
                "reference_text": "[7] Ada Lovelace. A Safe Paper.",
                "context": "The current paragraph cites this as a baseline.",
            })
            evidence = {
                "fields": {"title": "A Safe Paper", "abstract": "Evidence."},
                "evidence_level": "abstract",
                "sources": [{"provider": "crossref-doi", "label": "Crossref DOI", "evidence": "abstract"}],
            }
            with (
                patch("server._public_settings", return_value={"metadata": {"online_lookup": True, "contact_email": "reader@example.org"}}),
                patch("server.retrieve_reference_evidence", return_value=evidence) as retrieve,
                patch("server.reference_quick_read", return_value={"text": "速读结果", "model": "chat-test"}) as summarize,
            ):
                handler._reference_summary("a" * 16)

            self.assertEqual(errors, [])
            retrieve.assert_called_once_with("[7] Ada Lovelace. A Safe Paper.", contact_email="reader@example.org")
            summarize.assert_called_once_with(
                "[7] Ada Lovelace. A Safe Paper.",
                context="The current paragraph cites this as a baseline.",
                evidence=evidence,
            )
            self.assertEqual(responses[0]["result"]["text"], "速读结果")
            self.assertEqual(responses[0]["result"]["evidence_level"], "abstract")
            self.assertEqual(responses[0]["result"]["sources"], evidence["sources"])

    def test_reference_summary_rejects_oversized_context_before_network(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reference-summary-limit-") as temp:
            handler, responses, errors = self._handler(Path(temp), {
                "reference_text": "[1] A sufficiently long reference.",
                "context": "x" * 8001,
            })
            with patch("server.retrieve_reference_evidence") as retrieve:
                handler._reference_summary("a" * 16)

            self.assertEqual(responses, [])
            self.assertIn("8000", errors[0][0])
            retrieve.assert_not_called()

    def test_reference_summary_respects_disabled_online_lookup(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-reference-summary-offline-") as temp:
            handler, responses, errors = self._handler(Path(temp), {
                "reference_text": "[1] A sufficiently long reference.",
                "context": "Context.",
            })
            with (
                patch("server._public_settings", return_value={"metadata": {"online_lookup": False}}),
                patch("server.retrieve_reference_evidence") as retrieve,
            ):
                handler._reference_summary("a" * 16)

            self.assertEqual(responses, [])
            self.assertIn("在线元数据检索已关闭", errors[0][0])
            retrieve.assert_not_called()


if __name__ == "__main__":
    unittest.main()


class DataRootLockPlatformTest(unittest.TestCase):
    """The lock must work on both POSIX (fcntl) and Windows (msvcrt)."""

    def test_runtime_locks_state_and_library_roots_without_duplicates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-lock-roots-") as temp:
            state_root = Path(temp) / "state"
            library_root = Path(temp) / "library"
            self.assertEqual(_runtime_lock_roots(state_root, state_root), [state_root.resolve()])
            roots = _runtime_lock_roots(state_root, library_root)
            self.assertEqual(len(roots), 2)
            self.assertEqual(set(roots), {state_root.resolve(), library_root.resolve()})
            self.assertEqual(roots, sorted(roots, key=lambda root: os.fsencode(str(root))))

    def test_posix_path_uses_flock(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-lock-posix-") as temp:
            lock = DataRootLock(Path(temp))
            calls: list[tuple] = []
            fake_fcntl = MagicMock()
            fake_fcntl.LOCK_EX, fake_fcntl.LOCK_NB, fake_fcntl.LOCK_UN = 2, 4, 8
            fake_fcntl.flock.side_effect = lambda fd, flags: calls.append(flags)
            with patch.object(server_module, "fcntl", fake_fcntl), patch.object(server_module, "msvcrt", None):
                lock.acquire()
                self.assertEqual(calls, [6])
                self.assertEqual((Path(temp) / ".my-scholar.lock").read_text(encoding="utf-8"), str(os.getpid()))
                lock.release()
            self.assertEqual(calls, [6, 8])

    def test_windows_path_uses_msvcrt_byte_range(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-lock-win-") as temp:
            lock = DataRootLock(Path(temp))
            offsets: list[int] = []
            fake_msvcrt = MagicMock()
            fake_msvcrt.LK_NBLCK, fake_msvcrt.LK_UNLCK = 1, 0
            handles: list[Any] = []

            def record(fd: int, mode: int, nbytes: int) -> None:
                handles.append(mode)

            fake_msvcrt.locking.side_effect = record
            with patch.object(server_module, "fcntl", None), patch.object(server_module, "msvcrt", fake_msvcrt):
                lock.acquire()
                offsets.append(fake_msvcrt.locking.call_args.args[2])
                lock.release()
            self.assertEqual(handles, [1, 0])
            self.assertEqual(offsets, [1])
            self.assertEqual(lock.WINDOWS_LOCK_OFFSET, 4096)

    def test_unsupported_platform_raises(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-lock-none-") as temp:
            lock = DataRootLock(Path(temp))
            with patch.object(server_module, "fcntl", None), patch.object(server_module, "msvcrt", None):
                with self.assertRaises(RuntimeError):
                    lock.acquire()

    def test_busy_range_error_reports_other_instance(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-lock-busy-") as temp:
            (Path(temp) / ".my-scholar.lock").write_text("4321", encoding="utf-8")
            lock = DataRootLock(Path(temp))
            fake_msvcrt = MagicMock()
            fake_msvcrt.LK_NBLCK, fake_msvcrt.LK_UNLCK = 1, 0
            fake_msvcrt.locking.side_effect = OSError(errno.EDEADLK, "locked")
            with patch.object(server_module, "fcntl", None), patch.object(server_module, "msvcrt", fake_msvcrt):
                with self.assertRaises(RuntimeError) as caught:
                    lock.acquire()
            self.assertIn("4321", str(caught.exception))


class MigrationRequestGateTest(unittest.TestCase):
    def setUp(self) -> None:
        with server_module.MIGRATION_REQUEST_CONDITION:
            server_module.MIGRATION_QUIESCING = False
            server_module.MIGRATION_ACTIVE_REQUESTS = 0
            server_module.MIGRATION_ACTIVE_MUTATIONS = 0

    def tearDown(self) -> None:
        with server_module.MIGRATION_REQUEST_CONDITION:
            server_module.MIGRATION_QUIESCING = False
            server_module.MIGRATION_ACTIVE_REQUESTS = 0
            server_module.MIGRATION_ACTIVE_MUTATIONS = 0
            server_module.MIGRATION_REQUEST_CONDITION.notify_all()

    def test_quiesce_waits_for_active_request_and_rejects_new_work(self) -> None:
        self.assertTrue(server_module._migration_request_enter(mutation=True))
        store = MagicMock()
        store.list.return_value = []
        library = MagicMock()
        library.snapshot.return_value = {"items": {}}
        result: dict[str, Any] = {}

        def quiesce() -> None:
            result.update(server_module._quiesce_library_requests(timeout=1.0))

        with (
            patch.object(server_module, "STORE", store),
            patch.object(server_module, "LIBRARY", library),
            patch.object(server_module, "_library_migration_status", return_value={"ready": True}),
        ):
            worker = threading.Thread(target=quiesce)
            worker.start()
            with server_module.MIGRATION_REQUEST_CONDITION:
                self.assertTrue(server_module.MIGRATION_REQUEST_CONDITION.wait_for(lambda: server_module.MIGRATION_QUIESCING, timeout=0.5))
            self.assertFalse(server_module._migration_request_enter(mutation=False))
            server_module._migration_request_leave(mutation=True)
            worker.join(timeout=1.0)
        self.assertFalse(worker.is_alive())
        self.assertTrue(result.get("ready"))
        self.assertEqual(result.get("baseline"), {"jobs": 0, "items": 0})
        self.assertFalse(server_module._migration_request_enter(mutation=True))
        server_module._resume_library_requests()
        self.assertTrue(server_module._migration_request_enter(mutation=True))
        server_module._migration_request_leave(mutation=True)

    def test_busy_library_reopens_requests(self) -> None:
        with patch.object(server_module, "_library_migration_status", return_value={"ready": False, "busy_jobs": ["job"]}):
            status = server_module._quiesce_library_requests(timeout=0.2)
        self.assertFalse(status.get("ready"))
        self.assertFalse(server_module.MIGRATION_QUIESCING)
        self.assertTrue(server_module._migration_request_enter(mutation=False))
        server_module._migration_request_leave(mutation=False)

    def test_status_failure_reopens_requests(self) -> None:
        with patch.object(server_module, "_library_migration_status", side_effect=OSError("status failed")):
            with self.assertRaisesRegex(OSError, "status failed"):
                server_module._quiesce_library_requests(timeout=0.2)
        self.assertFalse(server_module.MIGRATION_QUIESCING)
        self.assertTrue(server_module._migration_request_enter(mutation=False))
        server_module._migration_request_leave(mutation=False)

    def test_baseline_failure_reopens_requests(self) -> None:
        store = MagicMock()
        store.list.side_effect = OSError("baseline failed")
        with (
            patch.object(server_module, "STORE", store),
            patch.object(server_module, "_library_migration_status", return_value={"ready": True}),
        ):
            with self.assertRaisesRegex(OSError, "baseline failed"):
                server_module._quiesce_library_requests(timeout=0.2)
        self.assertFalse(server_module.MIGRATION_QUIESCING)
        self.assertTrue(server_module._migration_request_enter(mutation=False))
        server_module._migration_request_leave(mutation=False)

    def test_prepare_response_loss_reopens_requests(self) -> None:
        handler = object.__new__(ScholarHandler)
        handler._migration_control_authorized = lambda: True
        handler._send_json = lambda payload: False
        with patch.object(server_module, "_quiesce_library_requests", return_value={"ready": True, "baseline": {"jobs": 0, "items": 0}}):
            server_module.MIGRATION_QUIESCING = True
            handler._prepare_library_migration()
        self.assertFalse(server_module.MIGRATION_QUIESCING)


class MediaLayoutApiTest(unittest.TestCase):
    job_id = "a" * 16

    def _handler(self, job_dir: Optional[Path], payload: Optional[dict] = None) -> tuple[ScholarHandler, list[dict], list[tuple[str, int]]]:
        class StoreStub:
            @staticmethod
            def path(candidate: str) -> Optional[Path]:
                return job_dir if candidate == self.job_id else None

        handler = object.__new__(ScholarHandler)
        handler.path = f"/api/jobs/{self.job_id}/media-layout"
        handler._read_json_body = lambda **_kwargs: payload
        responses: list[dict] = []
        errors: list[tuple[str, int]] = []
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST: errors.append((message, status))
        handler._media_layout_store_patch = patch.object(server_module, "STORE", StoreStub())
        return handler, responses, errors

    def test_get_missing_layout_returns_empty_schema_without_writing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-media-layout-get-") as temp:
            job_dir = Path(temp)
            handler, responses, errors = self._handler(job_dir)
            with handler._media_layout_store_patch:
                handler.do_GET()
            self.assertEqual(errors, [])
            self.assertEqual(responses, [{"media_layout": {"version": 1, "items": {}}}])
            self.assertFalse((job_dir / "media-layout.json").exists())

    def test_patch_merges_and_atomically_persists_media_widths(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-media-layout-patch-") as temp:
            job_dir = Path(temp)
            payloads = [
                {"items": {"block-1-7-image": {"width_percent": 62}}},
                {"items": {"block-6-0-table": {"width_percent": 84.5}}},
            ]
            handler, responses, errors = self._handler(job_dir)
            handler._read_json_body = lambda **_kwargs: payloads.pop(0)
            with handler._media_layout_store_patch:
                handler.do_PATCH()
                handler.do_PATCH()
            expected = {
                "version": 1,
                "items": {
                    "block-1-7-image": {"width_percent": 62.0},
                    "block-6-0-table": {"width_percent": 84.5},
                },
            }
            self.assertEqual(errors, [])
            self.assertEqual(responses[-1], {"media_layout": expected})
            self.assertEqual(json.loads((job_dir / "media-layout.json").read_text(encoding="utf-8")), expected)
            self.assertEqual(list(job_dir.glob(".media-layout.json.*.tmp")), [])

    def test_patch_rejects_invalid_schema_keys_widths_and_item_count(self) -> None:
        invalid_payloads = [
            {"items": {"block-1-image": {"width_percent": True}}},
            {"items": {"block-1-image": {"width_percent": float("inf")}}},
            {"items": {"block-1-image": {"width_percent": 23.99}}},
            {"items": {"block-1-image": {"width_percent": 100.01}}},
            {"items": {"../document.html": {"width_percent": 50}}},
            {"items": {"block-1-image": {"width_percent": 50, "other": 1}}},
            {"items": {}, "version": 1},
            {"items": {f"block-{index}": {"width_percent": 50} for index in range(server_module.MAX_MEDIA_LAYOUT_ITEMS + 1)}},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=list(payload)):
                with tempfile.TemporaryDirectory(prefix="my-scholar-media-layout-invalid-") as temp:
                    job_dir = Path(temp)
                    handler, responses, errors = self._handler(job_dir, payload)
                    with handler._media_layout_store_patch:
                        handler.do_PATCH()
                    self.assertEqual(responses, [])
                    self.assertEqual(errors[0][1], HTTPStatus.BAD_REQUEST)
                    self.assertFalse((job_dir / "media-layout.json").exists())

    def test_invalid_job_ids_never_reach_the_store(self) -> None:
        store = MagicMock()
        handler = object.__new__(ScholarHandler)
        handler.path = "/api/jobs/not-a-job/media-layout"
        errors: list[tuple[str, int]] = []
        handler._send_error_json = lambda message, status=HTTPStatus.BAD_REQUEST: errors.append((message, status))
        with patch.object(server_module, "STORE", store):
            handler.do_GET()
        store.path.assert_not_called()
        self.assertEqual(errors[-1][1], HTTPStatus.NOT_FOUND)

    def test_readonly_patch_is_forbidden_and_does_not_touch_layout(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-media-layout-readonly-") as temp:
            job_dir = Path(temp)
            layout_path = job_dir / "media-layout.json"
            original = '{"version":1,"items":{"block-1-image":{"width_percent":50}}}'
            layout_path.write_text(original, encoding="utf-8")
            handler, responses, errors = self._handler(job_dir, {"items": {"block-1-image": {"width_percent": 80}}})
            handler._read_json_body = MagicMock(return_value={})
            with handler._media_layout_store_patch, patch.object(server_module.runtime, "READONLY_MODE", True):
                handler.do_PATCH()
            handler._read_json_body.assert_not_called()
            self.assertEqual(responses, [])
            self.assertEqual(errors, [("只读演示模式，暂不支持修改。", HTTPStatus.FORBIDDEN)])
            self.assertEqual(layout_path.read_text(encoding="utf-8"), original)

    def test_failed_atomic_replace_keeps_previous_layout_and_cleans_temp_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-media-layout-atomic-") as temp:
            job_dir = Path(temp)
            layout_path = job_dir / "media-layout.json"
            original = '{"version":1,"items":{"block-1-image":{"width_percent":50}}}'
            layout_path.write_text(original, encoding="utf-8")
            with patch.object(server_module.os, "replace", side_effect=OSError("replace failed")):
                with self.assertRaisesRegex(OSError, "replace failed"):
                    server_module._write_media_layout(job_dir, {"block-1-image": {"width_percent": 80}})
            self.assertEqual(layout_path.read_text(encoding="utf-8"), original)
            self.assertEqual(list(job_dir.glob(".media-layout.json.*.tmp")), [])


class ReadonlyHardeningTest(unittest.TestCase):
    """Read-only deployments must never write, leak paths, or accept writes."""

    def test_every_mutating_verb_is_refused(self) -> None:
        class Handler(ScholarHandler):
            pass

        server_module._install_readonly_guard(Handler)
        for verb in ("do_POST", "do_PUT", "do_PATCH", "do_DELETE"):
            handler = object.__new__(Handler)
            refused: list[tuple] = []
            handler._send_error_json = lambda message, status=None: refused.append((message, status))
            getattr(handler, verb)()
            self.assertEqual(refused[0][1], HTTPStatus.FORBIDDEN, verb)
        self.assertIs(Handler.do_GET, ScholarHandler.do_GET)

    def test_write_primitives_are_inert(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-ro-write-") as temp:
            job_dir = Path(temp)
            (job_dir / "document.json").write_text("{}", encoding="utf-8")
            with patch.object(server_module.runtime, "READONLY_MODE", True):
                server_module._ensure_content_layout(job_dir)
                server_module._write_content_manifest(job_dir)
                server_module._sync_content_file(job_dir, "notes/notes.md", "x")
                server_module._write_translation_records(job_dir, [{"cache_key": "k"}])
                server_module._write_english_snapshot(job_dir)
                with self.assertRaises(PipelineError):
                    server_module._write_settings({"highlight_color": "#ff0000"})
            self.assertEqual(sorted(p.name for p in job_dir.iterdir()), ["document.json"])

    def test_local_paths_are_redacted_from_json_responses(self) -> None:
        payload = {
            "job_dir": "/Users/someone/Desktop/scholar/data/jobs/abc",
            "windows": "C:\\Users\\someone\\scholar",
            "nested": [{"source": "/home/ubuntu/my-scholar-web/data/x.json"}],
            "keep": "Advances in Neural Information Processing Systems",
        }
        redacted = server_module._redact_local_paths(payload)
        self.assertEqual(redacted["job_dir"], "[local]")
        self.assertEqual(redacted["windows"], "[local]")
        self.assertEqual(redacted["nested"][0]["source"], "[local]")
        self.assertEqual(redacted["keep"], payload["keep"])

    def test_diagnostic_artifacts_are_blocked(self) -> None:
        handler = object.__new__(ScholarHandler)
        blocked: list[tuple] = []
        handler._send_error_json = lambda message, status=None: blocked.append((message, status))
        with patch.object(server_module.runtime, "READONLY_MODE", True):
            handler._serve_job_artifact("a" * 16, "manifest.json", "")
        self.assertEqual(blocked[0][1], HTTPStatus.FORBIDDEN)

    def test_account_status_hides_service_endpoint(self) -> None:
        handler = object.__new__(ScholarHandler)
        responses: list[dict] = []
        handler._send_json = lambda body, *_args, **_kwargs: responses.append(body)
        with patch.object(server_module.runtime, "READONLY_MODE", True):
            handler._account_status()
        self.assertNotIn("server", responses[0])
        self.assertNotIn("local_used_bytes", responses[0])
        self.assertFalse(responses[0]["logged_in"])


class ManifestRebaseTest(unittest.TestCase):
    """Publishing must repoint attempt paths on every platform."""

    def test_posix_and_windows_paths_are_rebased(self) -> None:
        for attempt, job in (
            ("/data/jobs/abc/work/attempt-1", "/data/jobs/abc"),
            ("C:\\data\\jobs\\abc\\work\\attempt-1", "C:\\data\\jobs\\abc"),
        ):
            manifest = {
                "engine": {"layout": f"{attempt}/layout/source.json", "formula": "/elsewhere/nougat"},
                "assets": ["pages/page-1.png"],
                "counts": {"pages": 12},
            }
            rebased = server_module._rebase_manifest_paths(manifest, Path(attempt), Path(job))
            self.assertEqual(rebased["engine"]["layout"], f"{job}/layout/source.json")
            self.assertEqual(rebased["engine"]["formula"], "/elsewhere/nougat")
            self.assertEqual(rebased["assets"], ["pages/page-1.png"])
            self.assertEqual(rebased["counts"]["pages"], 12)

    def test_serialized_replacement_would_have_missed_windows_paths(self) -> None:
        # Guards the reason the structural helper exists: json.dumps escapes
        # backslashes, so a string replace on the serialized form never hits.
        attempt = "C:\\data\\jobs\\abc\\work\\attempt-1"
        serialized = json.dumps({"engine": {"layout": f"{attempt}/x.json"}})
        self.assertNotIn(attempt, serialized)
