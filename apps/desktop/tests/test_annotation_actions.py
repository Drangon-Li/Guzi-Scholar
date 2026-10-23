from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
from pipeline import PipelineError


class AnnotationActionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="guzi-annotation-actions-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = self.root / "settings.json"
        self.actions = {"hidden_builtin": ["copy", "underline_note"], "custom": [
            {"id": "principle", "label": "原理段落", "kind": "highlight", "color": "#3366ff", "enabled": True},
        ]}
        for patcher in (
            patch.object(server, "SETTINGS_PATH", self.settings),
            patch.object(server, "ai_services", return_value={}),
            patch.object(server, "_ai_status_history", return_value=[]),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def handler(self, payload):
        handler = object.__new__(server.ScholarHandler)
        replies = []
        handler._completed_job_dir = lambda _job_id: self.root
        handler._read_json_body = lambda **_kwargs: payload
        handler._send_json = lambda body, *_args, **_kwargs: replies.append(body)
        handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)
        return handler, replies

    def test_toolbar_roundtrip_and_legacy_defaults(self):
        self.assertEqual(server._public_settings()["annotation_actions"],
                         {"hidden_builtin": [], "custom": [], "show_shortcut_hints": True})
        saved = server._write_settings({"annotation_actions": self.actions})
        self.assertEqual(saved["annotation_actions"]["custom"], self.actions["custom"])
        self.assertEqual(set(saved["annotation_actions"]["hidden_builtin"]), set(self.actions["hidden_builtin"]))
        self.assertEqual(server._public_settings()["annotation_actions"], saved["annotation_actions"])
        self.assertEqual(json.loads(self.settings.read_text())["annotation_actions"], saved["annotation_actions"])

    def test_legacy_toolbar_settings_default_to_visible_shortcut_hints(self):
        self.settings.write_text(json.dumps({"annotation_actions": self.actions}))
        self.assertEqual(server._public_settings()["annotation_actions"],
                         {**self.actions, "hidden_builtin": ["underline_note", "copy"],
                          "show_shortcut_hints": True})

    def test_shortcut_hint_toggle_roundtrip_does_not_sync_annotation_styles(self):
        self.settings.write_text(json.dumps({"annotation_actions": self.actions}))
        with patch.object(server, "commit_style_sync") as style_sync:
            for visible in (False, True):
                with self.subTest(visible=visible):
                    saved = server._write_settings({"annotation_actions": {
                        **self.actions, "show_shortcut_hints": visible,
                    }})
                    self.assertIs(saved["annotation_actions"]["show_shortcut_hints"], visible)
                    self.assertEqual(saved["annotation_actions"]["custom"], self.actions["custom"])
                    self.assertEqual(set(saved["annotation_actions"]["hidden_builtin"]),
                                     set(self.actions["hidden_builtin"]))
                    self.assertEqual(server._public_settings()["annotation_actions"], saved["annotation_actions"])
                    self.assertEqual(json.loads(self.settings.read_text())["annotation_actions"],
                                     saved["annotation_actions"])
                    self.assertNotIn("annotation_style_revision", json.loads(self.settings.read_text()))
            style_sync.assert_not_called()

    def test_shortcut_hint_normalization_in_valid_and_invalid_stored_settings(self):
        for raw, expected in ((None, True), ("false", False), ("off", False), ("true", True)):
            for invalid in ({}, {"hidden_builtin": None}, {"custom": {}}):
                with self.subTest(raw=raw, invalid=invalid):
                    self.settings.write_text(json.dumps({"annotation_actions": {
                        **invalid, "show_shortcut_hints": raw,
                    }}))
                    self.assertEqual(server._public_settings()["annotation_actions"], {
                        "hidden_builtin": [], "custom": [], "show_shortcut_hints": expected,
                    })

    def test_invalid_action_cannot_replace_saved_settings(self):
        server._write_settings({"annotation_actions": self.actions})
        before = self.settings.read_bytes()
        for field, value in (("kind", "strike"), ("color", "red"), ("label", ""), ("id", "bad id")):
            with self.subTest(field=field):
                invalid = {"custom": [{**self.actions["custom"][0], field: value}]}
                with self.assertRaises(PipelineError):
                    server._write_settings({"annotation_actions": invalid})
                self.assertEqual(self.settings.read_bytes(), before)
        with self.assertRaises(PipelineError):
            server._write_settings({"annotation_actions": {"custom": self.actions["custom"] * 2}})

    def test_semantic_labels_persist_and_are_independent_at_same_anchor(self):
        payload = {"kind": "highlight", "quote": "The physical principle.", "block_id": "p1",
                   "start": 0, "end": 23, "surface": "paper", "color": "#3366ff",
                   "action_id": "principle", "label": "原理段落"}
        handler, replies = self.handler(payload)
        handler._add_annotation("a" * 16)
        first = replies[-1]["annotation"]
        handler._add_annotation("a" * 16)
        self.assertEqual(replies[-1]["annotation"]["id"], first["id"])
        payload.update(action_id="method", label="方法段落")
        handler._add_annotation("a" * 16)
        self.assertEqual(len(replies[-1]["annotations"]), 2)
        payload.pop("action_id")
        payload.pop("label")
        handler._add_annotation("a" * 16)
        self.assertEqual(len(replies[-1]["annotations"]), 3)
        server._write_settings({"annotation_actions": {"custom": []}})
        stored = json.loads((self.root / "annotations.json").read_text())
        self.assertEqual(stored[0]["label"], "原理段落")
        self.assertEqual(stored[0]["color"], "#3366ff")
        self.assertEqual(stored[1]["label"], "方法段落")
        self.assertNotIn("label", stored[2])

    def test_note_and_kind_edits_keep_semantic_snapshot_and_anchor(self):
        payload = {"kind": "highlight", "quote": "Quote", "block_id": "p1", "start": 2, "end": 7,
                   "action_id": "principle", "label": "原理段落", "color": "#3366ff"}
        handler, replies = self.handler(payload)
        handler._add_annotation("a" * 16)
        annotation_id = replies[-1]["annotation"]["id"]
        payload.clear()
        payload.update(note="A saved explanation", kind="underline")
        handler._update_annotation("a" * 16, annotation_id)
        stored = json.loads((self.root / "annotations.json").read_text())[0]
        self.assertEqual(stored["kind"], "underline")
        self.assertEqual(stored["note"], "A saved explanation")
        self.assertEqual(stored["label"], "原理段落")
        self.assertEqual(stored["action_id"], "principle")
        self.assertEqual((stored["start"], stored["end"]), (2, 7))


if __name__ == "__main__":
    unittest.main()
