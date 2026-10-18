from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ai
import config
import server
import translation_providers as providers
from pipeline import PipelineError


VOLC = {"provider": "volcengine", "access_key_id": "fake-access-id", "secret_access_key": "fake-secret-key", "source_language": "auto", "target_language": "zh"}
DEEPL = {"provider": "deepl", "api_key": "fake-deepl-key", "deepl_tier": "free", "source_language": "auto", "target_language": "zh"}


def response(value):
    return io.BytesIO(json.dumps(value, ensure_ascii=False).encode())


class ProviderProtocolTest(unittest.TestCase):
    def test_signature_matches_official_published_post_vector(self):
        # Published dummy credential/vector, not a user secret:
        # https://www.volcengine.com/docs/6369/67269 (steps 1–5).
        canonical = "\n".join([
            "POST", "/", "Action=ListBill&Version=2022-01-01",
            "host:billing.volcengineapi.com\nx-date:20250329T180937Z\n",
            "host;x-date", "e8cc56e129d9759d56c936e679a345d001a4235b58bee8e935ccad97f23ed663",
        ])
        self.assertEqual(hashlib.sha256(canonical.encode()).hexdigest(), "27383e3b56d03850f5634483527fbddcbf06cf98de1bc8a6679ef2300bff3b15")
        public_example_secret = "WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ=="
        self.assertEqual(providers._volcengine_signature(canonical, public_example_secret, "20250329T180937Z", "cn-beijing", "billing"), "5e8480ceea12d0000a23c054151c50dd02c1a7dec835004057d19f13d53a7658")

    def test_volcengine_signature_uses_exact_host_scope_body_and_utc_date(self):
        body = b'{"TargetLanguage":"zh","TextList":["Hello"]}'
        headers = providers.volcengine_headers(body, "test-access-key", "test-secret-key", date="20260102T030405Z")
        self.assertEqual(headers["X-Date"], "20260102T030405Z")
        self.assertEqual(headers["X-Content-Sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(headers["Authorization"], "HMAC-SHA256 Credential=test-access-key/20260102/cn-north-1/translate/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=4243641dcf528ba3fdf2cabc98d30f640ce56f8bffc46782fce2fca853f758e4")
        changed = providers.volcengine_headers(body + b" ", "test-access-key", "test-secret-key", date="20260102T030405Z")
        self.assertNotEqual(changed["Authorization"], headers["Authorization"])

    def test_volcengine_posts_translation_protocol_with_optional_source(self):
        for source in ("auto", "en"):
            with self.subTest(source=source), patch("translation_providers.urllib.request.urlopen", return_value=response({"TranslationList": [{"Translation": "你好"}], "ResponseMetadata": {"Error": None}})) as call:
                self.assertEqual(providers.translate("Hello", dict(VOLC, source_language=source)), "你好")
                request = call.call_args.args[0]
                self.assertEqual(request.full_url, providers.VOLCENGINE_URL)
                self.assertEqual(request.method, "POST")
                payload = json.loads(request.data)
                self.assertEqual(payload["TargetLanguage"], "zh")
                self.assertEqual(payload["TextList"], ["Hello"])
                self.assertEqual(payload.get("SourceLanguage"), None if source == "auto" else "en")
                self.assertIn("HMAC-SHA256 Credential=fake-access-id/", request.get_header("Authorization"))
                self.assertNotIn("fake-secret-key", str(request.headers))

    def test_deepl_free_and_pro_use_auth_header_and_language_mapping(self):
        for tier in ("free", "pro"):
            with self.subTest(tier=tier), patch("translation_providers.urllib.request.urlopen", return_value=response({"translations": [{"text": "你好", "detected_source_language": "EN"}]})) as call:
                self.assertEqual(providers.translate("Hello", dict(DEEPL, deepl_tier=tier, source_language="English"), target_language="中文"), "你好")
                request = call.call_args.args[0]
                self.assertEqual(request.full_url, providers.DEEPL_URLS[tier])
                self.assertEqual(request.get_header("Authorization"), "DeepL-Auth-Key fake-deepl-key")
                payload = json.loads(request.data)
                self.assertEqual(payload, {"text": ["Hello"], "target_lang": "ZH", "source_lang": "EN", "preserve_formatting": True})
                self.assertNotIn("fake-deepl-key", str(payload))
                self.assertNotIn("model", payload)

    def test_deepl_automatic_source_is_omitted(self):
        with patch("translation_providers.urllib.request.urlopen", return_value=response({"translations": [{"text": "Hi"}]})) as call:
            providers.translate("你好", DEEPL, target_language="en-US")
        payload = json.loads(call.call_args.args[0].data)
        self.assertNotIn("source_lang", payload)
        self.assertEqual(payload["target_lang"], "EN-US")

    def test_machine_services_only_receive_text_and_locally_restore_all_formatting(self):
        source = (
            "  Alpha __MY_SCHOLAR_MATH_0__ beta.\r\n\n"
            "__MY_SCHOLAR_BOLD_START_1__Bold "
            "__MY_SCHOLAR_BOLD_START_2__colored__MY_SCHOLAR_BOLD_END_2__"
            "__MY_SCHOLAR_BOLD_END_1__\t"
            "__MY_SCHOLAR_MARKER_0__ __MY_SCHOLAR_SPECIAL_TOKEN_0__ "
            "__MY_SCHOLAR_MATH_1__ + __MY_SCHOLAR_MATH_0__ (12).  "
        )
        translations = {"Alpha": "阿尔法", "beta.": "贝塔。", "Bold": "粗体", "colored": "颜色"}
        expected = source
        for original, translated in translations.items():
            expected = expected.replace(original, translated)
        for profile in (VOLC, DEEPL):
            def translated(_url, body, _headers, _timeout, profile=profile):
                payload = json.loads(body)
                texts = payload["TextList" if profile == VOLC else "text"]
                self.assertEqual(texts, list(translations))
                self.assertNotIn("__MY_SCHOLAR_", str(payload))
                self.assertNotIn("tag_handling", payload)
                field = "Translation" if profile == VOLC else "text"
                return {"TranslationList" if profile == VOLC else "translations": [
                    {field: "  " + translations[item] + "  "} for item in texts
                ]}
            with self.subTest(provider=profile["provider"]), patch("translation_providers._post", side_effect=translated) as call:
                self.assertEqual(providers.translate(source, profile), expected)
                call.assert_called_once()

    def test_formula_and_punctuation_only_never_call_machine_service(self):
        source = " \n__MY_SCHOLAR_MATH_0__ + __MY_SCHOLAR_MATH_1__ = 12.5\n" \
                 "__MY_SCHOLAR_BOLD_START_0____MY_SCHOLAR_MARKER_0____MY_SCHOLAR_BOLD_END_0__" \
                 "__MY_SCHOLAR_SPECIAL_TOKEN_0__\t"
        with patch("translation_providers._post") as call:
            for profile in (VOLC, DEEPL):
                self.assertEqual(providers.translate(source, profile), source)
                self.assertEqual(providers.translate("", profile), "")
            call.assert_not_called()

    def test_text_around_adjacent_formulas_keeps_exact_order_and_spacing(self):
        source = "Before(__MY_SCHOLAR_MATH_0____MY_SCHOLAR_MATH_1__)after."
        with patch("translation_providers._post", return_value={"translations": [{"text": "之前（"}, {"text": "）之后。"}]}) as call:
            result = providers.translate(source, DEEPL)
        self.assertEqual(json.loads(call.call_args.args[1])["text"], ["Before(", ")after."])
        self.assertEqual(result, "之前（__MY_SCHOLAR_MATH_0____MY_SCHOLAR_MATH_1__）之后。")

    def test_plain_text_symbols_and_currency_are_not_interpreted_as_markup(self):
        text = "A & B cost $4.48 ± $1.02 and x < y."
        with patch("translation_providers._post", return_value={"translations": [{"text": text}]}) as call:
            self.assertEqual(providers.translate(text, DEEPL), text)
        self.assertEqual(json.loads(call.call_args.args[1])["text"], [text])

    def test_incomplete_fragment_translation_is_rejected(self):
        source = "Before __MY_SCHOLAR_MATH_0__ after."
        for items in ([], [{"Translation": "之前"}], [{"Translation": "之前"}, {"Translation": " "}]):
            with self.subTest(items=items), patch("translation_providers._post", return_value={"TranslationList": items}):
                with self.assertRaisesRegex(RuntimeError, "完整的译文"):
                    providers.translate(source, VOLC)

    def test_long_paragraphs_batch_within_official_volcengine_limits(self):
        text = ("a" * 5100 + "__MY_SCHOLAR_MATH_0__") * 18
        batches = []
        def translated(_url, body, _headers, _timeout):
            texts = json.loads(body)["TextList"]
            batches.append(texts)
            self.assertNotIn("__MY_SCHOLAR_", "".join(texts))
            self.assertLessEqual(len(texts), 16)
            self.assertLessEqual(sum(map(len, texts)), 5000)
            return {"TranslationList": [{"Translation": item} for item in texts]}
        with patch("translation_providers._post", side_effect=translated):
            self.assertEqual(providers.translate(text, VOLC), text)
        self.assertGreater(len(batches), 1)

    def test_provider_errors_do_not_echo_remote_messages_or_secrets(self):
        for code in ("-400", "-415", "-429", "-500", "InvalidAccessKey"):
            with self.subTest(code=code), patch("translation_providers.urllib.request.urlopen", return_value=response({"ResponseMetadata": {"Error": {"Code": code, "Message": "fake-secret-key echoed"}}})):
                with self.assertRaises(RuntimeError) as caught:
                    providers.translate("Hello", VOLC)
                self.assertNotIn("fake-secret-key", str(caught.exception))
        for code in (401, 403, 429, 456, 500):
            error = urllib.error.HTTPError("https://fake", code, "fake-deepl-key", {}, io.BytesIO(b"fake-deepl-key"))
            with self.subTest(code=code), patch("translation_providers.urllib.request.urlopen", side_effect=error):
                with self.assertRaisesRegex(RuntimeError, f"HTTP {code}") as caught:
                    providers.translate("Hello", DEEPL)
                self.assertNotIn("fake-deepl-key", str(caught.exception))

    def test_network_invalid_json_and_incomplete_responses_fail_clearly(self):
        with patch("translation_providers.urllib.request.urlopen", side_effect=urllib.error.URLError("fake-secret-key")):
            with self.assertRaisesRegex(RuntimeError, "无法连接"):
                providers.translate("Hello", VOLC)
        for raw in (b"not json", b"[]", b'{"translations":[]}', b'{"translations":[{"text":""}]}'):
            with self.subTest(raw=raw), patch("translation_providers.urllib.request.urlopen", return_value=io.BytesIO(raw)):
                with self.assertRaises(RuntimeError):
                    providers.translate("Hello", DEEPL)

    def test_missing_credentials_and_invalid_languages_never_send_requests(self):
        with patch("translation_providers.urllib.request.urlopen") as call:
            for profile in (dict(VOLC, access_key_id=""), dict(VOLC, secret_access_key=""), dict(DEEPL, api_key="")):
                with self.assertRaisesRegex(RuntimeError, "凭据"):
                    providers.translate("Hello", profile)
            with self.assertRaises(ValueError):
                providers.translate("Hello", DEEPL, target_language="invalid language")
            call.assert_not_called()


class TranslationConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "settings.json"
        self.env = patch.dict(os.environ, {config.SETTINGS_FILE_ENV: str(self.path), config.DEVELOPER_TOKENS_FILE_ENV: str(Path(self.temp.name) / "missing.json")})
        self.env.start()
        self.settings = patch("server.SETTINGS_PATH", self.path)
        self.settings.start()

    def tearDown(self):
        self.settings.stop()
        self.env.stop()
        self.temp.cleanup()

    def save(self, profile):
        return server._write_settings({"ai": {"translation": profile}})

    def test_legacy_profile_retains_protocol_and_cache_identity(self):
        self.save({"base_url": "https://fake.example/v1", "model": "model", "api_key": "fake-key"})
        profile = config.resolve_ai_profile("translation")
        self.assertEqual(profile["provider"], "openai-compatible")
        self.assertEqual(profile["mode"], "qwen-mt")
        self.assertEqual(profile["profile_id"], config._profile_id("https://fake.example/v1", "model", "qwen-mt"))

    def test_settings_write_only_credentials_rotation_retention_and_clear(self):
        public = self.save(VOLC)
        safe = public["ai"]["translation"]
        self.assertTrue(safe["access_key_id_configured"])
        self.assertTrue(safe["secret_access_key_configured"])
        self.assertNotIn("fake-access-id", json.dumps(public))
        self.assertNotIn("fake-secret-key", json.dumps(public))
        self.save({"access_key_id": "", "secret_access_key": ""})
        stored = json.loads(self.path.read_text())["ai"]["translation"]
        self.assertEqual(stored["secret_access_key"], "fake-secret-key")
        self.save({"secret_access_key": "rotated-fake-secret"})
        self.assertEqual(config.resolve_ai_profile("translation")["secret_access_key"], "rotated-fake-secret")
        self.save({"clear_access_key_id": True, "clear_secret_access_key": True})
        self.assertFalse(ai.status("translation")["enabled"])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_profile_cache_identity_changes_only_for_translation_behavior(self):
        self.save(DEEPL)
        free = ai.translation_profile_id()
        self.save({"api_key": "rotated-fake-key"})
        self.assertEqual(free, ai.translation_profile_id())
        identities = {free}
        for profile in ({"deepl_tier": "pro"}, {"source_language": "en"}, {"target_language": "ja"}, VOLC):
            self.save(profile)
            identities.add(ai.translation_profile_id())
        self.assertEqual(len(identities), 5)
        self.assertNotEqual(server._translation_key("Hello", "b1", "zh", "hash", free), server._translation_key("Hello", "b1", "zh", "hash", ai.translation_profile_id()))

    def test_machine_format_strategy_versions_cache_without_changing_chat_identity(self):
        server._write_settings({"ai": {"chat": {"base_url": "https://chat.fake/v1", "model": "chat", "api_key": "fake-chat-key"}}})
        chat = config.resolve_ai_profile("chat")["profile_id"]
        for profile in (VOLC, DEEPL):
            with self.subTest(provider=profile["provider"]):
                self.save(profile)
                old_identity = [profile["provider"], "auto", "zh"]
                if profile == DEEPL:
                    old_identity.append("free")
                old = hashlib.sha256(json.dumps(old_identity).encode()).hexdigest()
                current = ai.translation_profile_id()
                self.assertNotEqual(current, old)
                self.assertEqual(current, ai.translation_profile_id())
                with patch("config.MACHINE_TRANSLATION_FORMAT_VERSION", "future-format"):
                    self.assertNotEqual(current, ai.translation_profile_id())
                self.assertEqual(chat, config.resolve_ai_profile("chat")["profile_id"])

    def test_formula_requests_plain_and_stream_restore_locally_then_reuse_cache(self):
        source = "Energy __MY_SCHOLAR_MATH_0__ __MY_SCHOLAR_BOLD_START_0__increases__MY_SCHOLAR_BOLD_END_0__."
        expected = "能量 __MY_SCHOLAR_MATH_0__ __MY_SCHOLAR_BOLD_START_0__增加__MY_SCHOLAR_BOLD_END_0__."
        formulas = [{"token": "__MY_SCHOLAR_MATH_0__", "tex": r"E=mc^2"}]
        for profile in (VOLC, DEEPL):
            for stream in (False, True):
                with self.subTest(provider=profile["provider"], stream=stream):
                    self.save(profile)
                    job_dir = Path(self.temp.name) / f"{profile['provider']}-{stream}"
                    job_dir.mkdir()
                    payload = {"text": source, "formulas": formulas, "block_id": "block-1", "target_language": "zh", "source_hash": "format-source", "stream": stream}
                    old_identity = [profile["provider"], "auto", "zh"] + (["free"] if profile == DEEPL else [])
                    old_profile = hashlib.sha256(json.dumps(old_identity).encode()).hexdigest()
                    old_key = server._translation_key(source, "block-1", "zh", "format-source", old_profile)
                    server._write_translation_records(job_dir, [{"cache_key": old_key, "profile_id": old_profile, "text": "旧版无格式译文"}])
                    handler = object.__new__(server.ScholarHandler)
                    handler._completed_job_dir = lambda _job_id, job_dir=job_dir: job_dir
                    handler._read_json_body = lambda payload=payload, **_kwargs: payload
                    handler.send_response = lambda *_args, **_kwargs: None
                    handler.send_header = lambda *_args, **_kwargs: None
                    handler.end_headers = lambda *_args, **_kwargs: None
                    handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)
                    replies = []
                    handler._send_json = replies.append

                    def translated(_url, body, _headers, _timeout, profile=profile):
                        texts = json.loads(body)["TextList" if profile == VOLC else "text"]
                        self.assertEqual(texts, ["Energy", "increases"])
                        field = "Translation" if profile == VOLC else "text"
                        return {"TranslationList" if profile == VOLC else "translations": [{field: "能量"}, {field: "增加"}]}

                    with patch("server.STORE", None), patch("translation_providers._post", side_effect=translated) as call:
                        for cached in (False, True):
                            handler.wfile = io.BytesIO()
                            handler._translate("a" * 16)
                            if stream:
                                events = [json.loads(chunk[6:]) for chunk in handler.wfile.getvalue().decode().split("\n\n") if chunk.startswith("data: ")]
                                result = events[-1]["result"]
                                self.assertEqual([event["delta"] for event in events if "delta" in event], [] if cached else [expected])
                            else:
                                result = replies[-1]["result"]
                            self.assertEqual(result["text"], expected)
                            self.assertEqual(result["formulas"], formulas)
                            self.assertEqual(result["cached"], cached)
                        call.assert_called_once()
                    records = server._translation_records(job_dir)
                    self.assertEqual(len(records), 2)
                    self.assertTrue(any(item["cache_key"] == old_key for item in records))

    def test_formula_metadata_is_local_even_for_formula_only_stream(self):
        self.save(VOLC)
        source = "__MY_SCHOLAR_MATH_0__ + __MY_SCHOLAR_MATH_1__"
        formulas = [{"token": "__MY_SCHOLAR_MATH_0__", "tex": "x^2"}, {"token": "__MY_SCHOLAR_MATH_1__", "tex": "y^2"}]
        with patch("translation_providers._post") as call:
            self.assertEqual(ai.translate_text(source, formulas=formulas)["formulas"], formulas)
            self.assertEqual(list(ai.translate_text_stream(source, formulas=formulas)), [source])
        call.assert_not_called()

    def test_request_keeps_initial_profile_when_settings_change_before_translation(self):
        initial = {"provider": "openai-compatible", "base_url": "https://original.fake/v1", "model": "original-model", "api_key": "original-fake-key", "mode": "chat", "target_language": "ja"}
        for stream in (False, True):
            with self.subTest(stream=stream):
                self.save(initial)
                profile_id = ai.translation_profile_id()
                job_dir = Path(self.temp.name) / f"profile-switch-{stream}"
                job_dir.mkdir()
                handler = object.__new__(server.ScholarHandler)
                handler._completed_job_dir = lambda _job_id, job_dir=job_dir: job_dir
                handler._read_json_body = lambda stream=stream, **_kwargs: {"text": "Hello", "block_id": "b1", "stream": stream}
                handler.send_response = lambda *_args, **_kwargs: None
                handler.send_header = lambda *_args, **_kwargs: None
                handler.end_headers = lambda *_args, **_kwargs: None
                handler.wfile = io.BytesIO()
                replies = []
                handler._send_json = replies.append
                handler._send_error_json = lambda message, *_args, **_kwargs: self.fail(message)

                def change_settings(*_args):
                    self.save(DEEPL)
                    return ""

                if stream:
                    upstream = io.BytesIO(b'data: {"choices":[{"delta":{"content":"Translation"}}]}\n\ndata: [DONE]\n\n')
                else:
                    upstream = response({"choices": [{"message": {"content": "Translation"}}]})
                with patch("server.STORE", None), patch("server._job_context", side_effect=change_settings), patch("ai.urllib.request.urlopen", return_value=upstream) as request:
                    handler._translate("a" * 16)
                sent = request.call_args.args[0]
                self.assertEqual(sent.full_url, "https://original.fake/v1/chat/completions")
                self.assertEqual(sent.get_header("Authorization"), "Bearer original-fake-key")
                body = json.loads(sent.data)
                self.assertEqual(body["model"], "original-model")
                self.assertIn("ja", body["messages"][0]["content"])
                record = server._translation_records(job_dir)[0]
                self.assertEqual(record["profile_id"], profile_id)
                self.assertEqual(record["model"], "original-model")
                self.assertEqual(record["target_language"], "ja")
                self.assertEqual(record["cache_key"], server._translation_key("Hello", "b1", "ja", "", profile_id))
                self.assertNotEqual(record["profile_id"], ai.translation_profile_id())

    def test_ai_translation_resolves_profile_once_for_plain_and_stream_transport(self):
        for mode in ("chat", "qwen-mt", "deepl"):
            self.save(DEEPL if mode == "deepl" else {"provider": "openai-compatible", "base_url": "https://original.fake/v1", "model": "original-model", "api_key": "original-fake-key", "mode": mode})
            profile = config.resolve_ai_profile("translation")
            for stream in (False, True):
                with self.subTest(mode=mode, stream=stream):
                    if mode == "deepl":
                        upstream = response({"translations": [{"text": "Translation"}]})
                    else:
                        upstream = io.BytesIO(b'data: {"choices":[{"delta":{"content":"Translation"}}]}\n\ndata: [DONE]\n\n') if stream else response({"choices": [{"message": {"content": "Translation"}}]})
                    with patch("ai._config", side_effect=[profile]) as resolve, patch("ai.urllib.request.urlopen", return_value=upstream):
                        translated = "".join(ai.translate_text_stream("Hello")) if stream else ai.translate_text("Hello")["text"]
                    self.assertEqual(translated, "Translation")
                    resolve.assert_called_once_with("translation")

    def test_stream_quality_retry_keeps_initial_profile_after_settings_switch(self):
        self.save(DEEPL)
        profile_id = ai.translation_profile_id()
        job_dir = Path(self.temp.name) / "profile-switch-retry"
        job_dir.mkdir()
        handler = object.__new__(server.ScholarHandler)
        handler._completed_job_dir = lambda _job_id: job_dir
        handler._read_json_body = lambda **_kwargs: {"text": "Hello", "stream": True}
        handler.send_response = lambda *_args, **_kwargs: None
        handler.send_header = lambda *_args, **_kwargs: None
        handler.end_headers = lambda *_args, **_kwargs: None
        handler.wfile = io.BytesIO()

        def rejected_stream(*_args, **_kwargs):
            yield "partial"
            self.save(VOLC)
            raise ai.TranslationQualityError("需要重试")

        with patch("server.STORE", None), patch("server.translate_text_stream", side_effect=rejected_stream), patch("translation_providers.urllib.request.urlopen", return_value=response({"translations": [{"text": "Translation"}]})) as request:
            handler._translate("a" * 16)
        self.assertEqual(request.call_args.args[0].full_url, providers.DEEPL_URLS["free"])
        record = server._translation_records(job_dir)[0]
        self.assertEqual(record["profile_id"], profile_id)
        self.assertEqual(record["text"], "Translation")

    def test_dedicated_translation_and_chat_never_share_profiles_or_transport(self):
        server._write_settings({"ai": {"chat": {"base_url": "https://chat.fake/v1", "model": "chat", "api_key": "fake-chat-key"}}})
        before = config.resolve_ai_profile("chat")
        self.save(VOLC)
        self.assertEqual(before, config.resolve_ai_profile("chat"))
        with patch("ai._complete", return_value="Chat reply") as complete, patch("translation_providers.translate", return_value="译文") as translate:
            self.assertEqual(ai.translate_text("Hello")["text"], "译文")
            self.assertEqual(list(ai.translate_text_stream("Hello")), ["译文"])
            complete.assert_not_called()
            self.assertTrue(ai.status("translation")["enabled"])
            self.assertEqual(ai.chat([{"role": "user", "content": "Question"}])["text"], "Chat reply")
            self.assertEqual(complete.call_args.kwargs["service"], "chat")
            self.assertEqual(translate.call_count, 2)
        with self.assertRaisesRegex(PipelineError, "不能.*复用"):
            server._copy_ai_profile("translation", "chat")
        server._copy_ai_profile("chat", "translation")
        copied = config.resolve_ai_profile("translation")
        self.assertEqual(copied["provider"], "openai-compatible")
        self.assertEqual(copied["api_key"], "fake-chat-key")

    def test_translation_probe_succeeds_without_chat_configuration(self):
        self.save(DEEPL)
        self.assertFalse(ai.status("chat")["enabled"])
        handler = object.__new__(server.ScholarHandler)
        replies = []
        handler._send_json = replies.append
        with patch("translation_providers.translate", return_value="连接测试") as translated, patch("ai._complete") as chat:
            handler._test_translation_connection()
        chat.assert_not_called()
        translated.assert_called_once()
        result = replies[0]["result"]
        self.assertTrue(result["ok"])
        self.assertEqual(result["provider"], "deepl")
        self.assertIsNone(result["model"])

    def test_translation_probe_reports_safe_provider_failure(self):
        self.save(DEEPL)
        handler = object.__new__(server.ScholarHandler)
        replies = []
        handler._send_json = replies.append
        with patch("translation_providers.translate", side_effect=RuntimeError("机器翻译额度已用尽（HTTP 456）。")):
            handler._test_translation_connection()
        self.assertFalse(replies[0]["result"]["ok"])
        self.assertIn("HTTP 456", replies[0]["result"]["error"])

    def test_settings_reject_invalid_provider_tier_or_language(self):
        for profile in ({"provider": "cnki"}, {"provider": "unknown"}, {"deepl_tier": "invalid"}, {"target_language": "auto"}, {"source_language": "not a language"}):
            with self.subTest(profile=profile), self.assertRaises(PipelineError):
                self.save(profile)

    def test_switching_providers_does_not_send_the_previous_providers_token(self):
        self.save({"provider": "openai-compatible", "base_url": "https://fake.example/v1", "model": "model", "api_key": "fake-openai-key"})
        public = self.save({"provider": "deepl", "api_key": ""})
        self.assertFalse(public["ai"]["translation"]["api_key_configured"])
        self.assertEqual(config.resolve_ai_profile("translation")["api_key"], "")
        self.save({"api_key": "fake-deepl-key"})
        self.save({"provider": "openai-compatible"})
        self.assertEqual(config.resolve_ai_profile("translation")["api_key"], "")

    def test_default_target_and_source_settings_reach_translation(self):
        self.save(dict(DEEPL, source_language="en", target_language="ja"))
        with patch("translation_providers.urllib.request.urlopen", return_value=response({"translations": [{"text": "こんにちは"}]})) as call:
            self.assertEqual(ai.translate_text("Hello")["text"], "こんにちは")
        payload = json.loads(call.call_args.args[0].data)
        self.assertEqual(payload["target_lang"], "JA")
        self.assertEqual(payload["source_lang"], "EN")
        self.assertEqual(server.translation_target_language(), "ja")

    def test_chinese_language_aliases_reuse_legacy_cache_key(self):
        old = server._translation_key("Hello", "b1", "中文", "hash", "profile")
        for language in ("zh", "zh-CN", "Chinese", "简体中文"):
            self.assertEqual(old, server._translation_key("Hello", "b1", language, "hash", "profile"))


if __name__ == "__main__":
    unittest.main()
