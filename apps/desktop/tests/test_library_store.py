from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from library_store import DEFAULT_GROUP_BY, READING_STATUSES, LibraryStore, LibraryValidationError, SCHEMA_VERSION  # noqa: E402


class LibraryStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="my-scholar-library-")
        self.store = LibraryStore(Path(self.temp.name))
        self.jobs = [
            {"job_id": "a" * 16, "status": "completed", "source_filename": "One.pdf", "created_at": "2026-01-01", "updated_at": "2026-01-01"},
            {"job_id": "b" * 16, "status": "completed", "source_filename": "Two.pdf", "created_at": "2026-01-02", "updated_at": "2026-01-02"},
        ]
        self.store.sync_jobs(self.jobs)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_snapshot_accepts_one_shot_iterable(self) -> None:
        snapshot = self.store.snapshot(iter(self.jobs))
        self.assertEqual(set(snapshot["items"]), {"a" * 16, "b" * 16})
        self.assertEqual(snapshot["items"]["a" * 16]["job"]["source_filename"], "One.pdf")

    def test_documents_can_belong_to_multiple_folders_and_folder_delete_is_safe(self) -> None:
        first = self.store.create_folder("视觉语言")
        second = self.store.create_folder("待读")
        job_id = "a" * 16
        item = self.store.update_item(job_id, {"folder_ids": [first["id"], second["id"], first["id"]]})
        self.assertEqual(item["folder_ids"], [first["id"], second["id"]])
        self.store.delete_folder(first["id"])
        self.assertEqual(self.store.state["items"][job_id]["folder_ids"], [second["id"]])
        with self.assertRaises(LibraryValidationError):
            self.store.delete_folder("system-all")

    def test_duplicate_import_can_append_one_folder_without_removing_existing_memberships(self) -> None:
        first = self.store.create_folder("视觉语言")
        second = self.store.create_folder("本周阅读")
        job_id = "a" * 16
        self.store.update_item(job_id, {"folder_ids": [first["id"]]})
        item = self.store.add_to_folder(job_id, second["id"])
        self.assertEqual(item["folder_ids"], [first["id"], second["id"]])
        self.assertEqual(self.store.add_to_folder(job_id, second["id"])["folder_ids"], [first["id"], second["id"]])
        with self.assertRaises(LibraryValidationError):
            self.store.validate_user_folder("missing-folder")

    def test_folder_hierarchy_rejects_cycles_and_reparents_children_on_delete(self) -> None:
        parent = self.store.create_folder("父目录")
        child = self.store.create_folder("子目录", parent["id"])
        with self.assertRaises(LibraryValidationError):
            self.store.update_folder(parent["id"], {"parent_id": child["id"]})
        with self.assertRaises(LibraryValidationError):
            self.store.create_folder("隐藏目录", "system-all")
        self.store.delete_folder(parent["id"])
        remaining = next(folder for folder in self.store.state["folders"] if folder["id"] == child["id"])
        self.assertIsNone(remaining["parent_id"])

    def test_job_sync_does_not_overwrite_library_update_timestamp(self) -> None:
        job_id = "a" * 16
        updated = self.store.update_item(job_id, {"values": {"reading_status": "阅读中"}})
        metadata_updated_at = updated["updated_at"]
        self.store.sync_jobs([{**self.jobs[0], "updated_at": "2025-01-01"}])
        self.assertEqual(self.store.state["items"][job_id]["updated_at"], metadata_updated_at)
        self.assertEqual(self.store.state["items"][job_id]["job_updated_at"], "2025-01-01")

    def test_custom_properties_validate_values_and_progress(self) -> None:
        prop = self.store.create_property({"label": "实验阶段", "type": "select", "options": ["基线", "消融"]})
        column = next(column for column in self.store.display()["columns"] if column["id"] == prop["id"])
        self.assertTrue(column["visible"])
        job_id = "b" * 16
        item = self.store.update_item(job_id, {"values": {prop["id"]: "消融", "reading_status": "阅读中"}, "progress": {"percent": 48.5, "page": 4, "scroll_top": 812}})
        self.assertEqual(item["values"][prop["id"]], "消融")
        self.assertEqual(item["values"]["reading_status"], "阅读中")
        self.assertEqual(item["progress"]["percent"], 48.5)
        with self.assertRaises(LibraryValidationError):
            self.store.update_item(job_id, {"values": {prop["id"]: "不存在"}})

    def test_custom_property_visibility_is_persisted_in_display(self) -> None:
        prop = self.store.create_property({"label": "暂不展示", "type": "text", "visible": False})
        reloaded = LibraryStore(Path(self.temp.name))
        column = next(column for column in reloaded.display()["columns"] if column["id"] == prop["id"])
        self.assertFalse(column["visible"])
        self.assertFalse(column["system"])

        updated = self.store.update_display({"columns": [{"id": prop["id"], "visible": True}]})
        column = next(column for column in updated["columns"] if column["id"] == prop["id"])
        self.assertTrue(column["visible"])

    def test_delete_property_removes_display_column_and_item_values(self) -> None:
        prop = self.store.create_property({"label": "临时属性", "type": "text"})
        job_id = "a" * 16
        self.store.update_item(job_id, {"values": {prop["id"]: "待删除"}})

        self.store.delete_property(prop["id"])
        reloaded = LibraryStore(Path(self.temp.name))

        self.assertNotIn(prop["id"], {column["id"] for column in reloaded.display()["columns"]})
        self.assertNotIn(prop["id"], reloaded.state["items"][job_id]["values"])
        with self.assertRaises(LibraryValidationError):
            self.store.update_item(job_id, {"values": {prop["id"]: "不应存在"}})

        with self.assertRaisesRegex(LibraryValidationError, "系统属性不能删除"):
            self.store.delete_property("reading_status")

    def test_reading_status_and_rating_inputs_are_strictly_validated(self) -> None:
        job_id = "a" * 16
        with self.assertRaises(LibraryValidationError):
            self.store.update_item(job_id, {"values": {"reading_status": "稍后再读"}})
        with self.assertRaises(LibraryValidationError):
            self.store.create_property({"label": "评分", "type": "rating", "max": "not-a-number"})

    def test_malformed_schema_version_falls_back_to_current_schema(self) -> None:
        self.store.path.write_text('{"version":"broken","items":{}}', encoding="utf-8")
        reloaded = LibraryStore(Path(self.temp.name))
        self.assertEqual(reloaded.state["version"], SCHEMA_VERSION)
        self.assertIn("system-all", {folder["id"] for folder in reloaded.state["folders"]})
        reloaded.sync_jobs([self.jobs[0]])
        self.assertIn("metadata", reloaded.state["items"]["a" * 16])

    def test_corrupt_primary_library_recovers_from_valid_backup(self) -> None:
        job_id = "a" * 16
        self.store.update_item(job_id, {"values": {"reading_status": "阅读中"}})
        backup = self.store.path.with_suffix(".json.bak")
        backup.write_bytes(self.store.path.read_bytes())
        self.store.path.write_text('{"version":', encoding="utf-8")

        recovered = LibraryStore(Path(self.temp.name))

        self.assertEqual(recovered.state["items"][job_id]["values"]["reading_status"], "阅读中")
        repaired = json.loads(recovered.path.read_text(encoding="utf-8"))
        self.assertEqual(repaired["items"][job_id]["values"]["reading_status"], "阅读中")
        preserved_backup = json.loads(backup.read_text(encoding="utf-8"))
        self.assertEqual(preserved_backup["items"][job_id]["values"]["reading_status"], "阅读中")
        self.assertTrue(list(Path(self.temp.name).glob("library.json.corrupt-*")))

    def test_two_corrupt_library_indexes_are_archived_before_rebuild(self) -> None:
        self.store.update_item("a" * 16, {"values": {"reading_status": "阅读中"}})
        backup = self.store.path.with_suffix(".json.bak")
        backup.write_text('{"version":', encoding="utf-8")
        self.store.path.write_text('{"items":', encoding="utf-8")

        recovered = LibraryStore(Path(self.temp.name))
        recovered.sync_jobs(self.jobs)

        self.assertIn("损坏", recovered.recovery_warning)
        self.assertGreaterEqual(len(list(Path(self.temp.name).glob("library.json*.corrupt-*"))), 2)
        json.loads(recovered.path.read_text(encoding="utf-8"))

    def test_weaker_metadata_refresh_does_not_downgrade_complete_result(self) -> None:
        job_id = "a" * 16
        complete = self.store.merge_metadata_result(job_id, {
            "status": "complete",
            "fields": {"title": "Stable Paper", "venue": "StableConf"},
            "sources": {
                "title": {"provider": "crossref", "confidence": 0.99},
                "venue": {"provider": "crossref", "confidence": 0.99},
            },
            "candidates": [{"provider": "crossref"}],
        })
        self.assertEqual(complete["status"], "complete")
        self.store.mark_metadata_retrieving(job_id)
        weaker = self.store.merge_metadata_result(job_id, {"status": "failed", "error": "temporary outage", "fields": {}, "sources": {}, "candidates": []})
        self.assertEqual(weaker["status"], "complete")
        self.assertEqual(weaker["fields"]["venue"], "StableConf")
        self.assertEqual(weaker["candidates"], [{"provider": "crossref"}])

    def test_trash_restore_and_saved_view_do_not_remove_job_metadata(self) -> None:
        job_id = "a" * 16
        self.store.trash_item(job_id)
        snapshot = self.store.snapshot(self.jobs)
        self.assertTrue(snapshot["items"][job_id]["deleted_at"])
        self.assertEqual(snapshot["folder_counts"]["system-trash"], 1)
        self.store.restore_item(job_id)
        view = self.store.create_view({"name": "高优先级", "filters": [{"field": "importance", "operator": "gte", "value": 4}]})
        self.assertFalse(view["system"])
        self.assertIn("source_filename", snapshot["items"][job_id]["job"])
        self.store.delete_view(view["id"])
        with self.assertRaises(LibraryValidationError):
            self.store.delete_view("view-all")

    def test_permanent_delete_requires_trash_and_supports_transaction_rollback(self) -> None:
        job_id = "a" * 16
        with self.assertRaisesRegex(LibraryValidationError, "只能彻底清除回收站"):
            self.store.permanently_delete_item(job_id)

        trashed = self.store.trash_item(job_id)
        removed = self.store.permanently_delete_item(job_id)
        self.assertEqual(removed, trashed)
        self.assertNotIn(job_id, self.store.state["items"])

        restored = self.store.restore_deleted_item(job_id, removed)
        self.assertEqual(restored, removed)
        self.assertIn(job_id, self.store.state["items"])
        with self.assertRaises(LibraryValidationError):
            self.store.restore_deleted_item(job_id, removed)

    def test_tombstone_blocks_stale_sync_and_library_mutations(self) -> None:
        job_id = "a" * 16
        self.store.trash_item(job_id)
        removed = self.store.permanently_delete_item(job_id)
        self.assertNotIn(job_id, self.store.state["items"])

        # A delayed worker may still publish its old job record. It must not
        # recreate either the item or a partial folder membership.
        self.store.sync_jobs([{**self.jobs[0], "updated_at": "2099-01-01"}])
        self.assertNotIn(job_id, self.store.state["items"])
        with self.assertRaisesRegex(LibraryValidationError, "彻底清除"):
            self.store.update_item(job_id, {"progress": {"percent": 20}})
        folder = self.store.create_folder("迟到任务")
        with self.assertRaisesRegex(LibraryValidationError, "彻底清除"):
            self.store.add_to_folder(job_id, folder["id"])

        # Rollback removes the tombstone and makes the original item writable.
        self.store.restore_deleted_item(job_id, removed)
        self.assertIn(job_id, self.store.state["items"])
        self.store.update_item(job_id, {"progress": {"percent": 20}})

    def test_bibliographic_metadata_user_edits_are_locked_against_auto_merge(self) -> None:
        job_id = "a" * 16
        self.store.update_metadata(job_id, {"fields": {"title": "我的标题", "year": 2025}})
        merged = self.store.merge_metadata_result(job_id, {"status": "complete", "fields": {"title": "远端标题", "year": 2024, "venue": "测试会议"}, "sources": {"title": {"provider": "crossref", "confidence": 0.99}, "year": {"provider": "crossref", "confidence": 0.99}, "venue": {"provider": "crossref", "confidence": 0.99}}, "candidates": []})
        self.assertEqual(merged["fields"]["title"], "我的标题")
        self.assertEqual(merged["fields"]["year"], 2025)
        self.assertEqual(merged["fields"]["venue"], "测试会议")

    def test_library_columns_can_be_hidden_and_renamed_without_touching_items(self) -> None:
        before = dict(self.store.state["items"]["a" * 16])
        columns = self.store.display()["columns"]
        self.assertNotIn("status", {column["id"] for column in columns})
        updated = self.store.update_display({"columns": [
            {**column, "label": "论文名称" if column["id"] == "name" else column["label"], "visible": column["id"] != "title"}
            for column in columns
        ]})
        name = next(column for column in updated["columns"] if column["id"] == "name")
        title = next(column for column in updated["columns"] if column["id"] == "title")
        self.assertEqual(name["label"], "论文名称")
        self.assertFalse(title["visible"])
        self.assertEqual(self.store.state["items"]["a" * 16], before)

    def test_display_rejects_unknown_columns_and_preserves_builtin_columns(self) -> None:
        before = {column["id"]: column for column in self.store.display()["columns"]}
        updated = self.store.update_display({"columns": [{"id": "name", "label": "论文名称", "visible": True}]})
        updated_ids = {column["id"] for column in updated["columns"]}

        self.assertTrue({column["id"] for column in before.values()} <= updated_ids)
        self.assertEqual(next(column for column in updated["columns"] if column["id"] == "name")["label"], "论文名称")
        self.assertEqual(
            next(column for column in updated["columns"] if column["id"] == "reading_status")["visible"],
            before["reading_status"]["visible"],
        )

        legacy = self.store.update_display({
            "columns": [{"id": "status", "label": "状态", "visible": True}, {"id": "name", "visible": True}],
            "group_by": "status",
        })
        self.assertNotIn("status", {column["id"] for column in legacy["columns"]})
        self.assertEqual(legacy["group_by"], DEFAULT_GROUP_BY)

        with self.assertRaisesRegex(LibraryValidationError, "未知列"):
            self.store.update_display({"columns": [{"id": "column-does-not-exist", "visible": True}]})
        self.assertEqual(self.store.display(), updated)

    def test_legacy_library_gains_planned_status_option_and_system_view(self) -> None:
        self.store.save()
        legacy = json.loads(self.store.path.read_text(encoding="utf-8"))
        legacy["version"] = 4
        for prop in legacy["properties"]:
            if prop["id"] == "reading_status":
                prop["options"] = ["未开始", "阅读中", "已完成"]
        legacy["views"] = [view for view in legacy["views"] if view["id"] != "view-planned"]
        self.store.path.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")

        reloaded = LibraryStore(Path(self.temp.name))

        status = next(prop for prop in reloaded.state["properties"] if prop["id"] == "reading_status")
        self.assertEqual(status["options"], list(READING_STATUSES))
        view_ids = [view["id"] for view in reloaded.state["views"]]
        self.assertEqual(view_ids.index("view-planned"), view_ids.index("view-unread") + 1)
        self.assertTrue(next(view for view in reloaded.state["views"] if view["id"] == "view-planned")["system"])
        persisted = json.loads(reloaded.path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["version"], SCHEMA_VERSION)
        self.assertIn("view-planned", [view["id"] for view in persisted["views"]])
        reloaded.sync_jobs(self.jobs)
        item = reloaded.update_item("a" * 16, {"values": {"reading_status": "计划中"}})
        self.assertEqual(item["values"]["reading_status"], "计划中")

    def test_property_labels_cannot_shadow_system_columns_or_each_other(self) -> None:
        with self.assertRaisesRegex(LibraryValidationError, "同名"):
            self.store.create_property({"label": "阅读状态", "type": "select"})
        with self.assertRaisesRegex(LibraryValidationError, "同名"):
            self.store.create_property({"label": " 名称 ", "type": "text"})
        created = self.store.create_property({"label": "实验阶段", "type": "text"})
        with self.assertRaisesRegex(LibraryValidationError, "同名"):
            self.store.create_property({"label": "实验阶段", "type": "text"})
        with self.assertRaisesRegex(LibraryValidationError, "同名"):
            self.store.update_property(created["id"], {"label": "重要程度"})
        self.assertEqual(self.store.update_property(created["id"], {"label": "实验阶段"})["label"], "实验阶段")


if __name__ == "__main__":
    unittest.main()
