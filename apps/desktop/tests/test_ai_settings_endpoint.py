from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
from pipeline import PipelineError


class AIOptionsEndpointTest(unittest.TestCase):
    def test_settings_roundtrip_preserves_secret_and_independent_service_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / "settings.json"
            with patch.object(server, "SETTINGS_PATH", settings), patch.object(server, "ai_services", return_value={}):
                server._write_settings({"ai": {
                    "chat": {"base_url": "https://api.example/v1", "api_key": "private-key", "model": "custom", "reasoning_effort": "high", "context_window": 64000},
                    "translation": {"base_url": "https://api.example/translate", "model": "translator", "reasoning_effort": "low", "thinking_budget": 1024, "context_window": 8000, "api_format": "qwen"},
                }})
                public = server._write_settings({"ai": {"chat": {"api_key": "", "thinking_budget": 2048}}})
                self.assertEqual(public["ai"]["chat"]["reasoning_effort"], "high")
                self.assertEqual(public["ai"]["chat"]["context_window"], 64000)
                self.assertEqual(public["ai"]["chat"]["thinking_budget"], 2048)
                self.assertEqual(public["ai"]["translation"]["reasoning_effort"], "low")
                self.assertNotIn("private-key", json.dumps(public))
                self.assertEqual(json.loads(settings.read_text())["ai"]["chat"]["api_key"], "private-key")
                copied = server._copy_ai_profile("translation", "chat")
                self.assertEqual(copied["ai"]["chat"]["context_window"], 8000)
                self.assertEqual(copied["ai"]["chat"]["api_format"], "qwen")

    def test_invalid_global_budget_is_rejected_before_write(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Path(directory) / "settings.json"
            with patch.object(server, "SETTINGS_PATH", settings):
                for invalid in (-1, True, 12.5, "oops"):
                    with self.subTest(invalid=invalid), self.assertRaises(PipelineError):
                        server._write_settings({"ai": {"chat": {"context_window": invalid}}})
            self.assertFalse(settings.exists())

    def test_sparse_session_options_keep_inheritance_and_explicit_auto(self):
        self.assertEqual(server._chat_options(None), {})
        self.assertEqual(server._chat_options({"context_window": None, "reasoning_effort": "auto", "thinking_budget": 0}),
                         {"reasoning_effort": "auto", "thinking_budget": 0})
        for invalid in ({"base_url": "https://other.example"}, {"api_key": "key"}, {"api_format": "anthropic"}, {"context_window": -1}):
            with self.subTest(invalid=invalid), self.assertRaises(PipelineError):
                server._chat_options(invalid)

    def test_stream_fallback_keeps_selection_and_options_without_writing_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            options = {"reasoning_effort": "high", "context_window": 48000, "thinking_budget": 1024}
            selection = "用户选文" * 2000
            messages = [
                {"role": "user", "content": "Explain earlier", "quote": "Earlier quote"},
                {"role": "assistant", "content": "Earlier answer"},
                {"role": "user", "content": "Explain this", "quote": selection},
            ]
            handler = object.__new__(server.ScholarHandler)
            handler._completed_job_dir = lambda _: Path(directory)
            handler._read_json_body = lambda **_: {"messages": messages, "selected_text": selection, "options": options, "stream": True}
            handler.send_response = handler.send_header = handler.end_headers = lambda *_: None
            handler.wfile = io.BytesIO()
            handler._send_error_json = lambda error, *_: self.fail(error)
            with patch.object(server, "chat_context_info", return_value={"window": 48000}) as info, \
                 patch.object(server, "ai_chat_stream", side_effect=RuntimeError("stream unsupported")) as streamed, \
                 patch.object(server, "ai_chat", return_value={"text": "Answer"}) as plain, \
                 patch.object(server, "_write_settings") as save:
                handler._chat("a" * 16)
            save.assert_not_called()
            for call in (info.call_args, streamed.call_args, plain.call_args):
                self.assertEqual(call.kwargs["options"], options)
                self.assertEqual(call.kwargs["selected_text"], selection)
                self.assertEqual(call.kwargs.get("messages", call.args[0] if call.args else None), messages)
            events = [json.loads(line[6:]) for line in handler.wfile.getvalue().decode().splitlines() if line.startswith("data: ")]
            self.assertEqual(events[-1], {"result": {"text": "Answer"}, "context": {"window": 48000}})


if __name__ == "__main__":
    unittest.main()
