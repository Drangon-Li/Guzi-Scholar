from __future__ import annotations

import json
import stat
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT))

from config import (  # noqa: E402
    DEVELOPER_TOKENS_FILE_ENV,
    SETTINGS_FILE_ENV,
    resolve_ai_profile,
)
from library_store import DEFAULT_GROUP_BY, LibraryStore, LibraryValidationError  # noqa: E402


class LibraryDisplayPreferencesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="my-scholar-display-")
        self.store = LibraryStore(Path(self.temp.name))
        self.store.sync_jobs([{"job_id": "a" * 16, "status": "completed"}])

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_default_group_by_is_reading_status(self) -> None:
        display = self.store.display()
        self.assertEqual(display["group_by"], DEFAULT_GROUP_BY)
        self.assertTrue(all("width" not in column for column in display["columns"]))
        self.assertNotIn("status", {column["id"] for column in display["columns"]})

    def test_group_and_width_preferences_round_trip(self) -> None:
        prop = self.store.create_property({"label": "研究阶段", "type": "select", "options": ["基线", "消融"]})
        columns = []
        for column in self.store.display()["columns"]:
            value = {"id": column["id"], "label": column["label"], "visible": column["visible"]}
            if column["id"] == "name":
                value["width"] = 240
            elif column["id"] == prop["id"]:
                value["width"] = 300
            columns.append(value)
        updated = self.store.update_display({"group_by": prop["id"], "columns": columns})
        self.assertEqual(updated["group_by"], prop["id"])
        self.assertEqual(next(item for item in updated["columns"] if item["id"] == "name")["width"], 240)
        self.assertEqual(next(item for item in updated["columns"] if item["id"] == prop["id"])["width"], 300)

        reloaded = LibraryStore(Path(self.temp.name))
        self.assertEqual(reloaded.display()["group_by"], prop["id"])
        self.assertEqual(next(item for item in reloaded.display()["columns"] if item["id"] == "name")["width"], 240)

        # A grouping-only update must not discard existing column widths.
        reloaded.update_display({"group_by": "reading_status"})
        self.assertEqual(reloaded.display()["group_by"], "reading_status")
        self.assertEqual(next(item for item in reloaded.display()["columns"] if item["id"] == "name")["width"], 240)

    def test_group_and_width_payloads_are_validated(self) -> None:
        with self.assertRaisesRegex(LibraryValidationError, "未知分类列"):
            self.store.update_display({"group_by": "missing-column"})
        with self.assertRaisesRegex(LibraryValidationError, "列宽"):
            self.store.update_display({"columns": [{"id": "name", "width": 40}]})
        with self.assertRaisesRegex(LibraryValidationError, "有限数字"):
            self.store.update_display({"columns": [{"id": "name", "width": "NaN"}]})

    def test_malformed_display_preferences_are_repaired_on_schema_migration(self) -> None:
        raw = self.store.state
        raw["version"] = 3
        raw["display"] = {
            "group_by": "status",
            "columns": [
                {"id": "name", "label": "名称", "visible": True, "width": 9999},
                {"id": "status", "label": "状态", "visible": True, "width": "bad"},
                {"id": "stale-column", "label": "旧列", "visible": True},
            ],
        }
        self.store.path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        reloaded = LibraryStore(Path(self.temp.name))
        display = reloaded.display()
        self.assertEqual(display["group_by"], DEFAULT_GROUP_BY)
        self.assertEqual(next(item for item in display["columns"] if item["id"] == "name")["width"], 520)
        self.assertNotIn("status", {item["id"] for item in display["columns"]})
        self.assertNotIn("stale-column", {item["id"] for item in display["columns"]})

    def test_deleting_group_property_falls_back_to_reading_status(self) -> None:
        prop = self.store.create_property({"label": "临时分组", "type": "text"})
        self.store.update_display({"group_by": prop["id"]})
        self.store.delete_property(prop["id"])
        self.assertEqual(self.store.display()["group_by"], DEFAULT_GROUP_BY)


class ConfigResolutionTest(unittest.TestCase):
    def test_resolves_fixed_translation_and_chat_profiles(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-config-") as temp:
            path = Path(temp) / "developer.tokens.json"
            path.write_text(json.dumps({
                "translation": {"base_url": "http://translation.test/v1/", "api_key": "translation-key", "model": "qwen-mt-test"},
                "chat": {"base_url": "http://chat.test/v1", "api_key": "chat-key", "model": "chat-test"},
            }), encoding="utf-8")
            environ = {DEVELOPER_TOKENS_FILE_ENV: str(path), SETTINGS_FILE_ENV: str(Path(temp) / "missing-settings.json")}
            translation = resolve_ai_profile("translation", environ=environ)
            chat = resolve_ai_profile("chat", environ=environ)
            mode = stat.S_IMODE(path.stat().st_mode)
        self.assertEqual(translation["base_url"], "http://translation.test/v1")
        self.assertEqual(translation["model"], "qwen-mt-test")
        self.assertEqual(translation["mode"], "qwen-mt")
        self.assertEqual(chat["base_url"], "http://chat.test/v1")
        self.assertEqual(chat["model"], "chat-test")
        self.assertNotEqual(translation["profile_id"], chat["profile_id"])
        self.assertEqual(mode, 0o600)

    def test_profile_id_depends_on_base_url_and_model_not_key(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-config-") as temp:
            path = Path(temp) / "developer.tokens.json"
            environ = {DEVELOPER_TOKENS_FILE_ENV: str(path), SETTINGS_FILE_ENV: str(Path(temp) / "missing-settings.json")}
            def resolve(payload: dict) -> dict:
                path.write_text(json.dumps({"translation": payload}), encoding="utf-8")
                return resolve_ai_profile("translation", environ=environ)

            first = resolve({"base_url": "http://translation.test/v1", "api_key": "key-a", "model": "model-a"})
            rotated_key = resolve({"base_url": "http://translation.test/v1/", "api_key": "key-b", "model": "model-a"})
            changed_model = resolve({"base_url": "http://translation.test/v1", "api_key": "key-b", "model": "model-b"})
        self.assertEqual(first["profile_id"], rotated_key["profile_id"])
        self.assertNotEqual(first["profile_id"], changed_model["profile_id"])

    def test_translation_profile_id_depends_on_protocol_mode(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-config-mode-") as temp:
            path = Path(temp) / "developer.tokens.json"
            environ = {DEVELOPER_TOKENS_FILE_ENV: str(path), SETTINGS_FILE_ENV: str(Path(temp) / "missing-settings.json")}
            payload = {"base_url": "http://translation.test/v1", "api_key": "key", "model": "model", "mode": "qwen-mt"}
            path.write_text(json.dumps({"translation": payload}), encoding="utf-8")
            qwen = resolve_ai_profile("translation", environ=environ)
            payload["mode"] = "chat"
            path.write_text(json.dumps({"translation": payload}), encoding="utf-8")
            chat = resolve_ai_profile("translation", environ=environ)
        self.assertNotEqual(qwen["profile_id"], chat["profile_id"])

    def test_missing_or_malformed_tokens_are_disabled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-config-") as temp:
            path = Path(temp) / "missing.json"
            profile = resolve_ai_profile("chat", environ={DEVELOPER_TOKENS_FILE_ENV: str(path), SETTINGS_FILE_ENV: str(Path(temp) / "missing-settings.json")})
        self.assertEqual(profile, {
            "base_url": "", "api_key": "", "model": "", "profile_id": "",
            "api_format": "auto", "reasoning_effort": "auto", "thinking_budget": 0, "context_window": 0,
        })

    def test_user_settings_take_priority_over_developer_tokens(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-user-ai-") as temp:
            root = Path(temp)
            settings = root / "settings.json"
            tokens = root / "developer.tokens.json"
            settings.write_text(json.dumps({"ai": {
                "translation": {"base_url": "https://user.example/v1", "api_key": "user-key", "model": "user-model"},
            }}), encoding="utf-8")
            tokens.write_text(json.dumps({"translation": {"base_url": "https://developer.example/v1", "api_key": "developer-key", "model": "developer-model"}}), encoding="utf-8")
            environ = {SETTINGS_FILE_ENV: str(settings), DEVELOPER_TOKENS_FILE_ENV: str(tokens)}
            profile = resolve_ai_profile("translation", environ=environ)
        self.assertEqual(profile["base_url"], "https://user.example/v1")
        self.assertEqual(profile["api_key"], "user-key")
        self.assertEqual(profile["model"], "user-model")

    def test_incomplete_user_profile_is_explicit_and_does_not_fallback(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-user-ai-") as temp:
            root = Path(temp)
            settings = root / "settings.json"
            tokens = root / "developer.tokens.json"
            settings.write_text(json.dumps({"ai": {"chat": {"base_url": "", "model": ""}}}), encoding="utf-8")
            tokens.write_text(json.dumps({"chat": {"base_url": "https://developer.example/v1", "api_key": "developer-key", "model": "developer-model"}}), encoding="utf-8")
            profile = resolve_ai_profile("chat", environ={SETTINGS_FILE_ENV: str(settings), DEVELOPER_TOKENS_FILE_ENV: str(tokens)})
        self.assertEqual(profile, {
            "base_url": "", "api_key": "", "model": "", "profile_id": "",
            "api_format": "auto", "reasoning_effort": "auto", "thinking_budget": 0, "context_window": 0,
        })

    def test_no_user_or_developer_profile_is_disabled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="my-scholar-user-ai-") as temp:
            profile = resolve_ai_profile("chat", environ={
                SETTINGS_FILE_ENV: str(Path(temp) / "settings.json"),
                DEVELOPER_TOKENS_FILE_ENV: str(Path(temp) / "missing.json"),
            })
        self.assertEqual(profile, {
            "base_url": "", "api_key": "", "model": "", "profile_id": "",
            "api_format": "auto", "reasoning_effort": "auto", "thinking_budget": 0, "context_window": 0,
        })

    def test_unknown_service_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "未知 AI 服务"):
            resolve_ai_profile("other", environ={DEVELOPER_TOKENS_FILE_ENV: "/does/not/matter"})


if __name__ == "__main__":
    unittest.main()
