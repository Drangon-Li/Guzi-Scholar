import copy
import io
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import ai_capabilities as capabilities


class AICapabilitiesTest(unittest.TestCase):
    def setUp(self):
        capabilities._capability_cache.clear()
        self.catalog = patch.object(capabilities, "_catalog", capabilities.CATALOG)
        self.catalog.start()
        self.date = patch.object(capabilities, "_catalog_date", capabilities.CATALOG_DATE)
        self.date.start()
        self.refresh = patch.object(capabilities, "_refresh_catalog")
        self.refresh.start()

    def tearDown(self):
        self.refresh.stop()
        self.date.stop()
        self.catalog.stop()
        capabilities._capability_cache.clear()

    def test_normalization_defaults_and_custom_effort(self):
        self.assertEqual(capabilities.normalize_ai_options(None), capabilities.DEFAULT_AI_OPTIONS)
        self.assertEqual(capabilities.normalize_ai_options({"api_format": "QWEN", "reasoning_effort": "ULTRA", "context_window": 8192}, strict=True), {
            "api_format": "qwen", "reasoning_effort": "ultra", "thinking_budget": 0, "context_window": 8192,
        })
        self.assertEqual(capabilities.normalize_ai_options({"api_format": "invalid", "thinking_budget": -5}), capabilities.DEFAULT_AI_OPTIONS)

    def test_strict_input_validation(self):
        for value in ([], {"api_format": "claude"}, {"thinking_budget": True}, {"context_window": -1},
                      {"context_window": 2**31}, {"thinking_budget": "32"}, {"reasoning_effort": "x\nunsafe"},
                      {"reasoning_effort": "a" * 33}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                capabilities.normalize_ai_options(value, strict=True)

    def test_protocol_detection_depends_on_endpoint(self):
        cases = {
            "https://api.anthropic.com": "anthropic",
            "https://dashscope.aliyuncs.com/compatible-mode/v1": "qwen",
            "https://api.deepseek.com/v1": "deepseek",
            "https://open.bigmodel.cn/api/paas/v4": "glm",
            "https://api.z.ai/api/paas/v4": "glm",
            "https://openrouter.ai/api/v1": "openrouter",
            "https://gateway.test/v1/messages": "anthropic",
            "https://gateway.test/v1/responses": "openai-responses",
            "https://api.anthropic.com.evil.test/v1": "openai",
            "https://gateway.test/v1": "openai",
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(capabilities.resolve_api_format({"base_url": url, "model": "claude-opus-4-6"}), expected)
        self.assertEqual(capabilities.resolve_api_format({"base_url": "https://api.anthropic.com", "api_format": "openai"}), "openai")

    def test_offline_catalog_and_unknown_models_never_call_network(self):
        with patch.object(capabilities, "_request_json", side_effect=AssertionError("Unexpected network")):
            known = capabilities.get_model_capabilities({"base_url": "https://api.openai.com/v1", "model": "gpt-5.4-pro", "context_window": 8192})
            self.assertEqual(known["context_window"], 1050000)
            self.assertEqual(known["max_output_tokens"], 128000)
            self.assertEqual(known["reasoning_efforts"], ["medium", "high", "xhigh"])
            self.assertFalse(known["temperature_supported"])
            self.assertEqual(known["source"], "models.dev:2026-10-22")
            unknown = capabilities.get_model_capabilities({"base_url": "https://gateway.test", "model": "my-custom-model", "context_window": 32000})
            self.assertIsNone(unknown["context_window"])
            self.assertIsNone(unknown["thinking_supported"])
            self.assertEqual(unknown["source"], "unknown")
            self.assertEqual(set(known), set(unknown))

    def test_catalog_only_matches_exact_ids(self):
        self.assertIsNone(capabilities.get_model_capabilities({"model": "qwen3-future-100b-custom"})["matched_model"])
        matched = capabilities.get_model_capabilities({"model": "anthropic/claude-haiku-4-5"})
        self.assertEqual(matched["matched_model"], "anthropic/claude-haiku-4-5")
        self.assertTrue(matched["thinking_supported"])
        self.assertIsNone(matched["thinking_required"])
        self.assertEqual(matched["thinking_budget_min"], 1024)

    def test_endpoint_limits_override_catalog_and_only_return_accessible_models(self):
        profile = {"base_url": "https://api.openai.com/v1", "api_key": "test-key", "model": "gpt-5.4-pro"}
        payload = {"data": [{"id": "gpt-5.4-pro", "context_window": 16000, "max_output_tokens": 2048},
                            {"id": "custom-model", "context_length": 12000}, {"id": "custom-model"}]}
        with patch.object(capabilities, "_request_json", return_value=payload) as request:
            result = capabilities.discover_models(profile)
        self.assertEqual([model["id"] for model in result], ["gpt-5.4-pro", "custom-model"])
        self.assertEqual(request.call_args.args[0], "https://api.openai.com/v1/models")
        self.assertEqual(request.call_args.args[1]["Authorization"], "Bearer test-key")
        self.assertEqual(result[0]["capabilities"]["context_window"], 16000)
        self.assertEqual(result[0]["capabilities"]["max_output_tokens"], 2048)
        self.assertTrue(result[0]["capabilities"]["source"].startswith("endpoint"))
        self.assertEqual(capabilities.get_model_capabilities(profile), result[0]["capabilities"])
        modified = copy.deepcopy(result)
        modified[0]["capabilities"]["reasoning_efforts"].append("bad")
        self.assertNotIn("bad", capabilities.get_model_capabilities(profile)["reasoning_efforts"])

    def test_cached_capabilities_are_isolated_by_key_and_protocol(self):
        profile = {"base_url": "https://gateway.test/v1", "api_key": "key-one", "model": "custom"}
        with patch.object(capabilities, "_request_json", return_value={"data": [{"id": "custom", "context_window": 9000}]}):
            capabilities.discover_models(profile)
        self.assertEqual(capabilities.get_model_capabilities(profile)["context_window"], 9000)
        self.assertIsNone(capabilities.get_model_capabilities({**profile, "api_key": "key-two"})["context_window"])
        self.assertIsNone(capabilities.get_model_capabilities({**profile, "api_format": "qwen"})["context_window"])
        self.assertIsNone(capabilities.get_model_capabilities({**profile, "base_url": "https://other.test/v1"})["context_window"])
        self.assertNotIn("key-one", repr(capabilities._capability_cache))

    def test_anthropic_native_auth_capabilities_and_pagination(self):
        payloads = [{"data": [{"id": "custom-claude", "max_input_tokens": 200000, "max_tokens": 64000,
                                "capabilities": {"effort": {"low": {"supported": True}, "high": {"supported": True}, "max": {"supported": False}},
                                                 "thinking": {"types": {"adaptive": {"supported": True}, "disabled": {"supported": False}}}}}],
                     "has_more": True, "last_id": "custom-claude"},
                    {"data": [{"id": "custom-second"}], "has_more": False}]
        with patch.object(capabilities, "_request_json", side_effect=payloads) as request:
            result = capabilities.discover_models({"base_url": "https://api.anthropic.com", "api_key": "anthropic-test-key"})
        self.assertEqual(len(result), 2)
        first = result[0]["capabilities"]
        self.assertEqual(first["max_input_tokens"], 200000)
        self.assertEqual(first["max_output_tokens"], 64000)
        self.assertEqual(first["reasoning_efforts"], ["low", "high"])
        self.assertTrue(first["thinking_supported"])
        self.assertTrue(first["thinking_required"])
        self.assertEqual(request.call_args_list[0].args[1]["x-api-key"], "anthropic-test-key")
        self.assertNotIn("Authorization", request.call_args_list[0].args[1])
        self.assertEqual(request.call_args_list[1].args[0], "https://api.anthropic.com/v1/models?after_id=custom-claude")

    def test_qwen_native_and_deepseek_metadata(self):
        qwen = {"output": {"models": [{"model_info": {"model_name": "custom-qwen", "max_input_length": 32768, "max_output_length": 8192}}]}}
        with patch.object(capabilities, "_request_json", return_value=qwen) as request:
            result = capabilities.discover_models({"base_url": "https://dashscope.aliyuncs.com", "api_key": "qwen-key"})
        self.assertEqual(request.call_args.args[0], "https://dashscope.aliyuncs.com/api/v1/models")
        self.assertEqual(result[0]["id"], "custom-qwen")
        self.assertEqual(result[0]["capabilities"]["max_input_tokens"], 32768)
        deepseek = {"data": [{"id": "deepseek-new", "context_window": 1048576, "max_output_tokens": 32000,
                               "effort": {"supported_levels": ["low", "high", "max"], "default_level": "high"}}]}
        with patch.object(capabilities, "_request_json", return_value=deepseek) as request:
            result = capabilities.discover_models({"base_url": "https://api.deepseek.com"})
        self.assertEqual(request.call_args.args[0], "https://api.deepseek.com/models")
        self.assertEqual(result[0]["capabilities"]["reasoning_efforts"], ["low", "high", "max"])

    def test_legacy_and_schema_two_reasoning_formats(self):
        modern = capabilities._metadata_capabilities({"capabilities": {"reasoning": {"supported": True, "effort": {"values": ["none", "low", "high"]}, "budget": {"min": 128, "max": 8192}}}})
        self.assertFalse(modern["thinking_required"])
        self.assertEqual(modern["thinking_budget_min"], 128)
        self.assertEqual(modern["thinking_budget_max"], 8192)
        legacy = capabilities._metadata_capabilities({"reasoning": True, "reasoning_options": [{"type": "toggle"}, {"type": "budget_tokens", "min": -1}]})
        self.assertFalse(legacy["thinking_required"])
        self.assertIsNone(legacy["thinking_budget_min"])
        unknown = capabilities._metadata_capabilities({"reasoning": True})
        self.assertIsNone(unknown["thinking_required"])

    def test_openrouter_metadata(self):
        with patch.object(capabilities, "_request_json", return_value={"data": [{"id": "custom/remote", "context_length": 90000, "top_provider": {"max_completion_tokens": 4096}}]}) as request:
            result = capabilities.discover_models({"base_url": "https://openrouter.ai"})
        self.assertEqual(request.call_args.args[0], "https://openrouter.ai/api/v1/models")
        self.assertEqual(result[0]["capabilities"]["context_window"], 90000)
        self.assertEqual(result[0]["capabilities"]["max_output_tokens"], 4096)

    def test_catalog_refresh_has_no_provider_credentials(self):
        self.refresh.stop()
        try:
            directory = {"openai": {"models": {"catalog-only": {"limit": {"context": 120000, "output": 8192}}}}}
            with patch.object(capabilities, "_catalog_checked_at", 0), patch.object(capabilities, "_request_json", side_effect=[{"data": [{"id": "key-visible"}]}, directory]) as request:
                result = capabilities.discover_models({"base_url": "https://gateway.test", "api_key": "private-provider-key"})
            self.assertEqual([item["id"] for item in result], ["key-visible"])
            self.assertEqual(request.call_args_list[1].args[0], capabilities.CATALOG_URL)
            self.assertEqual(request.call_args_list[1].args[1], {"Accept": "application/json"})
        finally:
            self.refresh.start()

    def test_empty_or_failed_endpoint_does_not_claim_catalog_access(self):
        for payload in ({"data": []}, {"data": {}}, {"models": [{"id": "x" * 257}]}, {"data": [None, {}, 1]}):
            with self.subTest(payload=payload), patch.object(capabilities, "_request_json", return_value=payload), self.assertRaises(RuntimeError):
                capabilities.discover_models({"base_url": "https://api.openai.com"})
        error = urllib.error.HTTPError("url", 401, "Unauthorized", {}, None)
        try:
            with patch.object(capabilities, "_request_json", side_effect=error), self.assertRaisesRegex(RuntimeError, "HTTP 401"):
                capabilities.discover_models({"base_url": "https://api.openai.com"})
        finally:
            error.close()

    def test_redirect_refuses_cross_origin_and_downgrade(self):
        handler = capabilities._SameOriginRedirect()
        request = urllib.request.Request("https://endpoint.test/v1/models", headers={"Authorization": "Bearer test"})
        for target in ("https://evil.test/models", "http://endpoint.test/models", "https://endpoint.test:444/models"):
            with self.subTest(target=target), self.assertRaises(urllib.error.HTTPError) as raised:
                handler.redirect_request(request, None, 302, "Found", {}, target)
            raised.exception.close()
        forwarded = handler.redirect_request(request, None, 302, "Found", {}, "https://endpoint.test/other")
        self.assertEqual(forwarded.get_header("Authorization"), "Bearer test")

    def test_response_size_and_json_validation(self):
        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        for body, message in ((b"123456", "安全上限"), (b"not-json", "有效 JSON")):
            with self.subTest(body=body), patch("ai_capabilities.urllib.request.build_opener") as opener:
                opener.return_value.open.return_value = Response(body)
                with self.assertRaisesRegex(RuntimeError, message):
                    capabilities._request_json("https://endpoint.test/models", {}, 1, 5 if body == b"123456" else 100)


class AnthropicThinkingRulesTest(unittest.TestCase):
    def test_verified_anthropic_models_share_rules_with_transport(self):
        for model, required, modes, budget in [
            ('claude-opus-4-6', False, ['adaptive', 'manual'], True),
            ('claude-sonnet-4-6', False, ['adaptive', 'manual'], True),
            ('claude-opus-4-7', False, ['adaptive'], False),
            ('claude-opus-4-8', False, ['adaptive'], False),
            ('claude-opus-5-5', True, ['adaptive'], False),
            ('claude-fable-5-1', True, ['adaptive'], False),
            ('claude-mythos-preview', True, ['adaptive', 'manual'], True),
            ('claude-sonnet-4-5', False, ['manual'], True),
        ]:
            with self.subTest(model=model):
                caps = capabilities.get_model_capabilities({'base_url': 'https://api.anthropic.com', 'model': model})
                self.assertEqual(caps['thinking_required'], required)
                self.assertEqual(caps['thinking_modes'], modes)
                self.assertEqual(caps['thinking_budget_supported'], budget)
                self.assertIn('platform.claude.com', caps['thinking_source'])

    def test_unknown_future_model_and_gateway_do_not_gain_forced_thinking_rules(self):
        unknown = capabilities.get_model_capabilities({'base_url': 'https://api.anthropic.com', 'model': 'claude-opus-9-9'})
        gateway = capabilities.get_model_capabilities({'base_url': 'https://custom.test/v1', 'api_format': 'anthropic', 'model': 'claude-opus-5-5'})
        self.assertIsNone(unknown['thinking_required'])
        self.assertIsNone(gateway['thinking_required'])

    def test_supported_budget_metadata_distinguishes_unknown_and_effort_only(self):
        for record, expected in [
            ({}, None),
            ({'reasoning_options': [{'type': 'effort', 'values': ['low', 'high']}]}, False),
            ({'reasoning_options': [{'type': 'toggle'}, {'type': 'budget_tokens'}]}, True),
            ({'thinking_budget_supported': False}, False),
            ({'thinking_budget_min': 1024}, True),
            ({'capabilities': {'thinking': {'types': {'enabled': {'supported': True}}}}}, True),
        ]:
            with self.subTest(record=record):
                self.assertEqual(capabilities._metadata_capabilities(record)['thinking_budget_supported'], expected)

    def test_anthropic_special_off_modes_are_explicit_capabilities(self):
        for model, kind in [('claude-sonnet-5-5', 'between_tools'), ('claude-opus-5', 'disabled')]:
            caps = capabilities.get_model_capabilities({'base_url': 'https://api.anthropic.com', 'model': model})
            self.assertEqual(caps.get('thinking_off_type', 'disabled'), kind)
            self.assertEqual(caps['thinking_off_effort'], 'high')


if __name__ == "__main__":
    unittest.main()
