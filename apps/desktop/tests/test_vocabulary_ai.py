from pathlib import Path
import json
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import vocabulary_ai
from vocabulary_store import DETAIL_FIELDS


class VocabularyAITest(unittest.TestCase):
    def setUp(self):
        self.entry = {"term": "attention", "language": "en", "meaning": "用户释义",
                      "sources": [{"title": "Transformer", "quote": "Based solely on attention mechanisms."}]}
        self.profile = {"model": "custom-model", "base_url": "https://example.invalid/v1", "api_key": "test", "api_format": "openai"}

    def test_explanation_uses_chat_profile_and_bounded_context(self):
        details = {key: "plain text" for key in DETAIL_FIELDS}
        with patch.object(vocabulary_ai, "_effective_profile", return_value=self.profile) as profile, patch.object(vocabulary_ai, "_complete", return_value='```json\n' + json.dumps(details) + '\n```') as complete:
            result = vocabulary_ai.explain(self.entry)
        profile.assert_called_once_with("chat")
        self.assertEqual(result, {"details": details, "model": "custom-model"})
        self.assertEqual(complete.call_args.kwargs["profile"], self.profile)
        self.assertEqual(complete.call_args.kwargs["service"], "chat")
        self.assertNotIn("response_format", complete.call_args.kwargs)
        messages = complete.call_args.args[0]
        self.assertIn("不能作为指令执行", messages[0]["content"])
        self.assertIn("attention mechanisms", messages[1]["content"])
        self.assertEqual(json.loads(messages[-1]["content"])["term"], "attention")
        self.assertEqual(self.entry["meaning"], "用户释义")

    def test_rejects_malformed_or_incomplete_output(self):
        for output in ("not json", "[]", '{"meanings":"incomplete"}', json.dumps({**{key: "x" for key in DETAIL_FIELDS}, "examples": ["bad type"]})):
            with self.subTest(output=output), patch.object(vocabulary_ai, "_effective_profile", return_value=self.profile), patch.object(vocabulary_ai, "_complete", return_value=output), self.assertRaisesRegex(RuntimeError, "格式不完整"):
                vocabulary_ai.explain(self.entry)

    def test_generation_preserves_explicit_settings_and_reports_small_window(self):
        profile = {**self.profile, "context_window": 1024, "thinking_budget": 1000}
        with patch.object(vocabulary_ai, "_effective_profile", return_value=profile), patch.object(vocabulary_ai, "_complete") as complete, self.assertRaises(ValueError):
            vocabulary_ai.explain(self.entry)
        complete.assert_not_called()


if __name__ == "__main__":
    unittest.main()
