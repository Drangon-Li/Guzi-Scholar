from __future__ import annotations

import json
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ai
import config
import runtime
from pipeline import PipelineError
from settings_schema import _normalize_ai_profile, _public_ai_settings


API_PROFILE = {
    "base_url": "https://private.example/v1", "api_key": "private-token", "model": "http-model",
    "api_format": "anthropic", "reasoning_effort": "high", "thinking_budget": 4096, "context_window": 16000,
}
CODEX_PROFILE = {"cli_kind": "codex", "cli_path": "~/bin/codex", "cli_model": "cli-model", "cli_args": []}
CUSTOM_PROFILE = {"cli_kind": "custom", "cli_path": "~/bin/local wrapper", "cli_model": "",
                  "cli_args": ["--literal", " \"a b\" ", "$(example)", ""]}


class CLIProfileTest(unittest.TestCase):
    def test_transport_switch_retains_api_and_redacts_cli_settings_without_desktop(self):
        active = _normalize_ai_profile(CUSTOM_PROFILE, API_PROFILE)
        updated = _normalize_ai_profile({"thinking_budget": 8192}, active)
        self.assertEqual({field: updated[field] for field in config.CLI_PROFILE_FIELDS}, CUSTOM_PROFILE)
        public = _public_ai_settings({"chat": updated}, include_cli=True)["chat"]
        self.assertEqual({field: public[field] for field in config.CLI_PROFILE_FIELDS}, CUSTOM_PROFILE)
        self.assertNotIn("private-token", json.dumps(public))
        self.assertFalse(public["capabilities"]["vision_supported"])
        with patch.object(runtime, "desktop_cli_available", return_value=False):
            public = _public_ai_settings({"chat": updated})["chat"]
        self.assertTrue(public["api_key_configured"])
        self.assertFalse(set(config.CLI_PROFILE_FIELDS) & public.keys())

        switched = _normalize_ai_profile({"cli_kind": ""}, active)
        self.assertFalse(set(config.CLI_PROFILE_FIELDS) & switched.keys())
        self.assertEqual({field: switched[field] for field in API_PROFILE}, API_PROFILE)
        self.assertEqual(_normalize_ai_profile({"cli_kind": "claude"}, active)["cli_path"], "")

    def test_rejects_invalid_executable_configuration(self):
        for fields in (
            {"cli_kind": "shell"}, {"cli_kind": "custom"},
            {"cli_kind": "codex", "cli_path": "relative/codex"},
            {"cli_kind": "claude", "cli_args": ["--tools=all"]},
            {**CUSTOM_PROFILE, "cli_model": "model"}, {**CUSTOM_PROFILE, "cli_args": "--one --two"},
            {**CUSTOM_PROFILE, "cli_args": [1]}, {**CUSTOM_PROFILE, "cli_args": ["null\x00byte"]},
        ):
            with self.subTest(fields=fields), self.assertRaises(PipelineError):
                _normalize_ai_profile(fields)

    def test_translation_cache_identity_uses_active_transport_and_config(self):
        stored = {**API_PROFILE, **CODEX_PROFILE, "provider": "deepl", "target_language": "fr"}
        profile = config._normalize_profile(stored, service="translation")
        self.assertEqual(profile["provider"], "cli")
        self.assertEqual(profile["mode"], "chat")
        self.assertEqual(profile["api_key"], "")
        self.assertEqual(profile["model"], "cli-model")
        self.assertEqual(profile["profile_id"], config._normalize_profile(
            {**stored, "api_key": "new-token", "base_url": "https://new.example", "thinking_budget": 32},
            service="translation",
        )["profile_id"])
        for updated in (
            {"cli_kind": ""}, {"cli_kind": "claude"}, {"cli_model": "different"},
            {"cli_path": "/new/codex"}, {"context_window": 20000}, {"target_language": "zh"}, {"source_language": "de"},
        ):
            self.assertNotEqual(profile["profile_id"], config._normalize_profile(
                {**stored, **updated}, service="translation",
            )["profile_id"])
        custom = config._normalize_profile(CUSTOM_PROFILE, service="translation")
        self.assertNotEqual(custom["profile_id"], config._normalize_profile(
            {**CUSTOM_PROFILE, "cli_args": []}, service="translation",
        )["profile_id"])


class CLITransportTest(unittest.TestCase):
    def setUp(self):
        self.chat_profile = config._normalize_profile({**API_PROFILE, **CODEX_PROFILE})
        self.translation_profile = config._normalize_profile(
            {**API_PROFILE, **CUSTOM_PROFILE, "provider": "deepl", "source_language": "en"}, service="translation",
        )
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(runtime, "desktop_cli_available", return_value=True))
        stack.enter_context(patch.object(ai, "_config", side_effect={
            "chat": self.chat_profile, "translation": self.translation_profile,
        }.__getitem__))
        self.http = stack.enter_context(patch.object(ai.urllib.request, "urlopen"))
        self.runner = stack.enter_context(patch.object(ai.cli_adapter, "complete"))
        self.configured = stack.enter_context(patch.object(ai.cli_adapter, "configured", return_value=True))

    def tearDown(self):
        self.http.assert_not_called()

    def test_chat_and_stream_share_text_only_budget_and_cli_options(self):
        self.runner.return_value = "<think>hidden reasoning</think> Answer"
        messages = [{"role": "user", "content": "Explain this", "quote": "quoted evidence"}]
        context = "very long paper text " * 5000
        options = {"context_window": 12000, "reasoning_effort": "high", "thinking_budget": 8000}
        result = ai.chat(messages, context=context, options=options)
        self.assertEqual(result["text"], "Answer")
        self.assertEqual(result["model"], "cli-model")
        self.assertEqual(result["context"]["window"], 12000)
        self.assertEqual(result["context"]["thinking_tokens"], 0)
        self.assertTrue(result["context"]["truncated"])
        self.assertEqual(list(ai.chat_stream(messages, context=context, options=options)), ["Answer"])
        self.assertEqual(self.runner.call_args_list[0], self.runner.call_args_list[1])
        clean, cli = self.runner.call_args.args
        self.assertIn("quoted evidence", clean[-1]["content"])
        self.assertEqual(cli, CODEX_PROFILE)

    def test_images_and_non_desktop_execution_are_rejected_before_runner(self):
        messages = [{"role": "user", "content": "Explain this"}]
        with self.assertRaisesRegex(ValueError, "仅支持文本"):
            ai.chat(messages, image={"data_url": "data:image/png;base64,example"})
        with self.assertRaisesRegex(ValueError, "仅支持文本"):
            ai.chat([{"role": "user", "content": [{"type": "image_url"}]}])
        with patch.object(runtime, "desktop_cli_available", return_value=False):
            self.assertFalse(ai.status()["enabled"])
            with self.assertRaisesRegex(RuntimeError, "桌面客户端"):
                ai.chat(messages)
        self.runner.assert_not_called()
        self.configured.assert_not_called()

    def test_cli_status_and_probe_hide_command_and_unsafe_runner_diagnostics(self):
        status = ai.status("translation")
        self.assertTrue(status["enabled"])
        self.assertEqual(status["configured"], {"cli": True})
        self.assertEqual(status["cli_kind"], "custom")
        self.assertEqual(status["provider"], "cli")
        self.assertNotIn("local wrapper", json.dumps(status))
        self.runner.return_value = "private answer"
        probe = ai.test_connection("translation")
        self.assertTrue(probe["ok"])
        self.assertNotIn("private answer", json.dumps(probe))
        self.assertEqual(self.runner.call_args.kwargs["timeout_seconds"], 60)
        self.runner.side_effect = OSError("private stderr with private-token")
        batch = ai.test_connections()
        self.assertFalse(batch["chat"]["ok"])
        self.assertFalse(batch["translation"]["ok"])
        self.assertNotIn("private", json.dumps(batch))

    def test_cli_streamed_translation_retries_before_showing_invalid_placeholders(self):
        token = "__MY_SCHOLAR_MATH_0__"
        self.runner.side_effect = ["公式已丢失。", f"公式是 {token}。"]
        self.assertEqual(list(ai.translate_text_stream(f"The formula is {token}.")), [f"公式是 {token}。"])
        self.assertEqual(self.runner.call_count, 2)
        messages, cli = self.runner.call_args.args
        self.assertEqual(messages[0]["role"], "system")
        self.assertIn(token, messages[0]["content"])
        self.assertIn("原文语言为 en", messages[0]["content"])
        self.assertEqual(cli, CUSTOM_PROFILE)

    def test_cli_aligned_translation_passes_json_hint_and_checks_ids(self):
        segments = [{"id": "a", "text": "First."}, {"id": "b", "text": "Second."}]
        values = [{"id": "b", "text": "第二句。"}, {"id": "a", "text": "第一句。"}]
        self.runner.return_value = "```json\n" + json.dumps({"segments": values}) + "\n```"
        result = ai.translate_text("First. Second.", segments=segments, alignment_version="sentence-v1")
        self.assertEqual(result["segments"], list(reversed(values)))
        self.assertEqual(result["provider"], "cli")
        self.assertIn("原文语言为 en", self.runner.call_args.args[0][0]["content"])
        self.assertEqual(self.runner.call_args.kwargs["response_format"], {"type": "json_object"})
        self.runner.return_value = json.dumps({"segments": [values[0], values[0]]})
        with self.assertRaises(ai.TranslationQualityError):
            ai.translate_text("First. Second.", segments=segments, alignment_version="sentence-v1")


if __name__ == "__main__":
    unittest.main()
