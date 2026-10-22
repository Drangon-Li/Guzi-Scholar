from __future__ import annotations

import copy
import json
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import annotation_style_sync as sync
import server
from pipeline import PipelineError


class SimulatedCrash(BaseException):
    pass


class AnnotationStyleSyncTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="guzi-action-sync-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.settings = self.root / "state" / "settings.json"
        self.library = self.root / "library"
        self.jobs = []
        self.actions = {"custom": [{"id": "principle", "label": "原理", "kind": "highlight",
                                     "color": "#3366ff", "enabled": True}], "hidden_builtin": []}
        self.settings.parent.mkdir()
        self.settings.write_text(json.dumps({"annotation_actions": self.actions,
                                             "ai": {"chat": {"api_key": "private-test-key"}}}))
        for index in (1, 2):
            job_id = str(index) * 16
            job_dir = self.library / "jobs" / job_id
            job_dir.mkdir(parents=True)
            rows = [
                {"id": f"same-{index}", "action_id": "principle", "label": "原理", "kind": "highlight",
                 "color": "#ff6666", "source": "manual", "note": "Retain note", "quote": "Quote", "start": 2, "end": 7},
                {"id": f"other-{index}", "action_id": "method", "kind": "highlight", "color": "#111111", "source": "manual"},
                {"id": f"plain-{index}", "kind": "underline", "color": "#222222", "source": "manual"},
                {"id": f"ai-{index}", "action_id": "principle", "label": "AI", "kind": "highlight", "source": "ai"},
                {"id": f"legacy-ai-{index}", "action_id": "principle", "kind": "highlight"},
            ]
            (job_dir / "annotations.json").write_text(json.dumps(rows))
            content = job_dir / "content" / "annotations" / "annotations.json"
            content.parent.mkdir(parents=True)
            content.write_text(json.dumps(rows, indent=4))
            self.jobs.append({"job_id": job_id, "job_dir": str(job_dir)})
        for patcher in (
            patch.object(server, "SETTINGS_PATH", self.settings),
            patch.object(server, "LIBRARY_ROOT", self.library),
            patch.object(server, "STORE", SimpleNamespace(list=lambda: self.jobs, get=lambda _job_id: {})),
            patch.object(server, "ai_services", return_value={}),
            patch.object(server, "_ai_status_history", return_value=[]),
            patch.object(server, "ANNOTATION_STYLE_RECOVERY_REQUIRED", False),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def files(self):
        return [self.settings, *[Path(record["job_dir"]) / relative for record in self.jobs
                                 for relative in ("annotations.json", "content/annotations/annotations.json")]]

    def update(self, **fields):
        actions = copy.deepcopy(self.actions)
        actions["custom"][0].update(fields)
        return server._write_settings({"annotation_actions": actions})

    def journal(self):
        return next((self.settings.parent / "annotation-style-transactions").glob("*/journal.json"))

    def test_changed_action_updates_all_documents_and_keeps_unrelated_annotations(self):
        before = json.loads(self.files()[1].read_bytes())
        result = self.update(label="新原理", kind="underline", color="#55aa44")["annotation_style_sync"]
        self.assertEqual(result["annotations"], 2)
        self.assertEqual(result["job_ids"], [item["job_id"] for item in self.jobs])
        for record in self.jobs:
            job_dir = Path(record["job_dir"])
            rows = json.loads((job_dir / "annotations.json").read_bytes())
            self.assertEqual({field: rows[0][field] for field in sync.STYLE_FIELDS},
                             {"label": "新原理", "kind": "underline", "color": "#55aa44"})
            for field in ("id", "note", "quote", "start", "end"):
                expected = before[0][field] if field != "id" else f"same-{record['job_id'][0]}"
                self.assertEqual(rows[0][field], expected)
            self.assertEqual(rows[1:], json.loads((job_dir / "content/annotations/annotations.json").read_bytes())[1:])
            self.assertEqual([item.get("color") for item in rows[1:]], ["#111111", "#222222", None, None])
            self.assertEqual(rows[3]["label"], "AI")
        backup = Path(result["backup_path"])
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(backup.parent.stat().st_mode), 0o700)
        self.assertEqual(len(list(backup.glob("*.before"))), 5)
        for item in backup.iterdir():
            self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600)
        self.assertEqual(json.loads(self.journal().read_bytes())["state"], "committed")
        self.assertEqual(sync.recover_pending_transactions(self.settings, self.library), [])

    def test_rename_only_keeps_single_annotation_color(self):
        self.update(label="新原理")
        rows = json.loads(self.files()[1].read_bytes())
        self.assertEqual(rows[0]["label"], "新原理")
        self.assertEqual(rows[0]["color"], "#ff6666")

    def test_hiding_or_deleting_action_preserves_old_annotation_files(self):
        before = {path: path.read_bytes() for path in self.files()[1:]}
        self.update(enabled=False)
        server._write_settings({"annotation_actions": {"custom": []}})
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)
        self.assertFalse((self.settings.parent / "annotation-style-transactions").exists())

    def test_failed_commit_restores_exact_bytes_for_settings_and_both_copies(self):
        before = {path: path.read_bytes() for path in self.files()}
        failing_path = self.files()[-1]
        original = sync._atomic_write
        failed = False

        def fail_once(path, data):
            nonlocal failed
            if path == failing_path and not failed:
                failed = True
                raise OSError("simulated write failure")
            return original(path, data)

        with patch.object(sync, "_atomic_write", side_effect=fail_once):
            with self.assertRaisesRegex(PipelineError, "已恢复原文件"):
                self.update(color="#55aa44")
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)
        self.assertEqual(json.loads(self.journal().read_bytes())["state"], "rolled_back")

    def test_crash_after_settings_replace_recovers_only_the_matching_library(self):
        before = {path: path.read_bytes() for path in self.files()}
        original = sync._atomic_write

        def crash_before_commit_marker(path, data):
            if path.name == "journal.json" and json.loads(data).get("state") == "committed":
                raise SimulatedCrash()
            return original(path, data)

        with patch.object(sync, "_atomic_write", side_effect=crash_before_commit_marker):
            with self.assertRaises(SimulatedCrash):
                self.update(color="#55aa44")
        self.assertNotEqual(self.settings.read_bytes(), before[self.settings])
        self.assertEqual(sync.recover_pending_transactions(self.settings, self.root / "other-library"), [])
        self.assertEqual(json.loads(self.journal().read_bytes())["state"], "pending")
        self.assertEqual(len(sync.recover_pending_transactions(self.settings, self.library)), 1)
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)
        self.assertEqual(sync.recover_pending_transactions(self.settings, self.library), [])

    def test_missing_content_copy_is_removed_again_on_recovery(self):
        missing = self.files()[-1]
        missing.unlink()
        original = sync._atomic_write

        def crash_on_settings(path, data):
            if path == self.settings:
                raise SimulatedCrash()
            return original(path, data)

        with patch.object(sync, "_atomic_write", side_effect=crash_on_settings):
            with self.assertRaises(SimulatedCrash):
                self.update(color="#55aa44")
        self.assertTrue(missing.exists())
        sync.recover_pending_transactions(self.settings, self.library)
        self.assertFalse(missing.exists())

    def test_new_annotation_uses_current_action_instead_of_stale_client_snapshot(self):
        self.update(label="新原理", color="#55aa44", kind="underline")
        handler = object.__new__(server.ScholarHandler)
        replies = []
        handler._completed_job_dir = lambda _job_id: Path(self.jobs[0]["job_dir"])
        handler._read_json_body = lambda **_kwargs: {"action_id": "principle", "label": "原理", "color": "#3366ff",
                                                   "kind": "highlight", "source": "manual", "quote": "New quote",
                                                   "block_id": "new", "start": 0, "end": 9}
        handler._send_json = lambda value, *_args: replies.append(value)
        handler._send_error_json = lambda message, *_args: self.fail(message)
        handler._add_annotation(self.jobs[0]["job_id"])
        added = replies[-1]["annotation"]
        self.assertEqual(replies[-1]["annotation_style_revision"], 1)
        self.assertEqual({field: added[field] for field in sync.STYLE_FIELDS},
                         {"label": "新原理", "color": "#55aa44", "kind": "underline"})
        handler._add_annotation(self.jobs[0]["job_id"])
        self.assertEqual(replies[-1]["annotation"]["id"], added["id"], "Stale kind must not defeat deduplication")

    def test_failed_rollback_blocks_writes_and_migration_until_startup_recovery(self):
        before = {path: path.read_bytes() for path in self.files()}
        failing_path = self.files()[-1]
        original = sync._atomic_write

        def fail_apply_and_rollback(path, data):
            if path == failing_path:
                raise OSError("simulated persistent write failure")
            return original(path, data)

        with patch.object(sync, "_atomic_write", side_effect=fail_apply_and_rollback):
            with self.assertRaisesRegex(PipelineError, "待恢复"):
                self.update(color="#55aa44")
        self.assertTrue(server.ANNOTATION_STYLE_RECOVERY_REQUIRED)
        self.assertEqual(json.loads(self.journal().read_bytes())["state"], "rolling_back")
        for operation in (
            lambda: server._write_settings({"metadata": {"auto_retrieve": False}}),
            lambda: server._copy_ai_profile("translation", "chat"),
            lambda: server._sync_ai_annotations(Path(self.jobs[0]["job_dir"]), {}),
            lambda: server._migrate_job_artifacts(Path(self.jobs[0]["job_dir"]), {}),
        ):
            with self.assertRaisesRegex(PipelineError, "尚待恢复"):
                operation()
        with self.assertRaisesRegex(PipelineError, "尚待恢复"):
            with server._job_mutation(self.jobs[0]["job_id"]):
                self.fail("A queued document mutation must not enter")
        self.assertFalse(server._migration_request_enter(mutation=True))
        self.assertFalse(server._quiesce_library_requests()["ready"])
        with patch.object(server, "LIBRARY", object()), patch.object(server, "VOCABULARY", object()):
            server._initialize_runtime_stores()
        self.assertFalse(server.ANNOTATION_STYLE_RECOVERY_REQUIRED)
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)
        server._write_settings({"metadata": {"auto_retrieve": False}})
        handler = object.__new__(server.ScholarHandler)
        handler._completed_job_dir = lambda _job_id: Path(self.jobs[0]["job_dir"])
        handler._read_json_body = lambda **_kwargs: {"note": "A note written after recovery"}
        handler._send_json = lambda *_args: None
        handler._send_error_json = lambda message, *_args: self.fail(message)
        handler._update_annotation(self.jobs[0]["job_id"], "same-1")
        sync.recover_pending_transactions(self.settings, self.library)
        self.assertEqual(json.loads(self.files()[1].read_bytes())[0]["note"], "A note written after recovery")
        self.assertFalse(json.loads(self.settings.read_bytes())["metadata"]["auto_retrieve"])

    def test_commit_marker_sync_failure_is_durable_before_a_partial_rollback(self):
        before = {path: path.read_bytes() for path in self.files()}
        failing_path = self.files()[-1]
        original_write = sync._atomic_write
        original_directory_sync = sync._sync_directory
        committed_marker_failed = False

        def fail_committed_directory_sync(path):
            nonlocal committed_marker_failed
            journal = path / "journal.json"
            if not committed_marker_failed and journal.is_file() and json.loads(journal.read_bytes())["state"] == "committed":
                committed_marker_failed = True
                raise OSError("commit marker directory fsync failed")
            return original_directory_sync(path)

        def fail_partial_rollback(path, data):
            if committed_marker_failed and path == failing_path:
                raise OSError("rollback write failed")
            return original_write(path, data)

        with patch.object(sync, "_sync_directory", side_effect=fail_committed_directory_sync), \
             patch.object(sync, "_atomic_write", side_effect=fail_partial_rollback):
            with self.assertRaisesRegex(PipelineError, "待恢复"):
                self.update(color="#55aa44")
        self.assertEqual(json.loads(self.journal().read_bytes())["state"], "rolling_back")
        sync.recover_pending_transactions(self.settings, self.library)
        for path, data in before.items():
            self.assertEqual(path.read_bytes(), data)

    def test_settings_wait_for_job_lock_before_taking_annotation_lock(self):
        job_id = self.jobs[0]["job_id"]
        waiting_for_job = threading.Event()
        settings_finished = threading.Event()
        failures = []
        original = server._job_mutation_lock

        def observed_lock(value):
            if threading.current_thread().name == "style-settings" and value == job_id:
                waiting_for_job.set()
            return original(value)

        def save():
            try:
                self.update(color="#55aa44")
            except Exception as exc:
                failures.append(exc)
            finally:
                settings_finished.set()

        with patch.object(server, "_job_mutation_lock", side_effect=observed_lock):
            with server._job_mutation(job_id):
                worker = threading.Thread(target=save, name="style-settings", daemon=True)
                worker.start()
                self.assertTrue(waiting_for_job.wait(2))
                acquired = server.ANNOTATION_LOCK.acquire(timeout=2)
                if acquired:
                    server.ANNOTATION_LOCK.release()
                self.assertTrue(acquired, "Settings must not hold ANNOTATION_LOCK while waiting for a job")
            self.assertTrue(settings_finished.wait(3))
            worker.join(timeout=1)
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
