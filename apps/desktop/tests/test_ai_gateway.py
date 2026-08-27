from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ai_gateway import (  # noqa: E402
    RequestLimiter,
    _SameOriginRedirectHandler,
    _sanitize_messages,
    _sanitize_request_body,
    build_handler,
    probe_profiles,
)
from user_service import AccountError, AccountStore, PRIVACY_VERSION, TERMS_VERSION  # noqa: E402


PROFILES = {
    "translation": {
        "base_url": "https://translation.example.test/compatible-mode/v1",
        "api_key": "translation-secret",
        "model": "translation-model",
    },
    "chat": {
        "base_url": "https://chat.example.test/compatible-mode/v1",
        "api_key": "chat-secret",
        "model": "chat-model",
    },
}


class StoreStub:
    reservations: list[tuple[Any, ...]] = []

    def authenticate(self, token: str) -> dict[str, Any]:
        if token == "valid-session":
            return {"id": 7, "member": 1, "terms_version": TERMS_VERSION, "privacy_version": PRIVACY_VERSION}
        if token == "no-access":
            return {"id": 8, "member": 0, "terms_version": TERMS_VERSION, "privacy_version": PRIVACY_VERSION}
        raise AccountError("登录已过期，请重新登录。", HTTPStatus.UNAUTHORIZED)

    def reserve_ai_request(
        self,
        user_id: int,
        service: str,
        daily_limit: int,
        input_units: int,
        daily_unit_limit: int,
    ) -> None:
        self.reservations.append((user_id, service, daily_limit, input_units, daily_unit_limit))

    def refund_ai_request(self, user_id: int, service: str, input_units: int) -> None:
        self.reservations.append(("refund", user_id, service, input_units))


class ResponseStub:
    status = HTTPStatus.OK
    headers = {"Content-Type": "application/json"}

    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def __enter__(self) -> "ResponseStub":
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self, _size: int = -1) -> bytes:
        payload, self.payload = self.payload, b""
        return payload


class GatewayServer:
    def __init__(self, opener: Any, store: Any = None) -> None:
        handler = build_handler(store or StoreStub(), PROFILES, opener=opener)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "GatewayServer":
        self.thread.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"


class AIGatewayTest(unittest.TestCase):
    @staticmethod
    def _post(gateway: GatewayServer, token: str, body: dict[str, Any], service: str = "chat") -> dict[str, Any]:
        request = urllib.request.Request(
            gateway.url + f"/{service}/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_health_reports_readiness_without_credentials_or_provider_urls(self) -> None:
        def unused_opener(*_args: Any, **_kwargs: Any) -> None:
            self.fail("health must not call an upstream service")

        with GatewayServer(unused_opener) as gateway:
            with urllib.request.urlopen(gateway.url + "/health", timeout=2) as response:
                payload = response.read().decode("utf-8")
        body = json.loads(payload)
        self.assertTrue(body["ok"])
        self.assertEqual(body["services"]["chat"], {"configured": True, "model": "chat-model"})
        self.assertNotIn("secret", payload)
        self.assertNotIn("example.test", payload)

    def test_proxy_requires_a_valid_member_session(self) -> None:
        calls: list[Any] = []

        def unused_opener(*args: Any, **kwargs: Any) -> None:
            calls.append((args, kwargs))
            self.fail("unauthorized request must not reach upstream")

        with GatewayServer(unused_opener) as gateway:
            request = urllib.request.Request(
                gateway.url + "/chat/v1/chat/completions",
                data=json.dumps({"messages": [{"role": "user", "content": "hello"}]}).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer no-access"},
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request, timeout=2)
            self.assertEqual(raised.exception.code, HTTPStatus.FORBIDDEN)
            self.assertIn("内测资格", raised.exception.read().decode("utf-8"))
        self.assertEqual(calls, [])

    def test_proxy_forces_server_model_and_replaces_client_authorization(self) -> None:
        upstream: dict[str, Any] = {}
        StoreStub.reservations = []

        def opener(request: urllib.request.Request, *, timeout: int) -> ResponseStub:
            upstream["url"] = request.full_url
            upstream["authorization"] = request.get_header("Authorization")
            upstream["body"] = json.loads(request.data.decode("utf-8"))
            upstream["timeout"] = timeout
            return ResponseStub(b'{"choices":[{"message":{"content":"ok"}}]}')

        with GatewayServer(opener) as gateway:
            request = urllib.request.Request(
                gateway.url + "/chat/v1/chat/completions",
                data=json.dumps({
                    "model": "expensive-user-selected-model",
                    "messages": [{"role": "user", "content": "hello"}],
                    "stream": False,
                    "n": 20,
                }).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer valid-session"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=2) as response:
                body = json.loads(response.read().decode("utf-8"))

        self.assertEqual(body["choices"][0]["message"]["content"], "ok")
        self.assertEqual(upstream["url"], "https://chat.example.test/compatible-mode/v1/chat/completions")
        self.assertEqual(upstream["authorization"], "Bearer chat-secret")
        self.assertEqual(upstream["body"]["model"], "chat-model")
        self.assertNotIn("n", upstream["body"])
        self.assertEqual(upstream["body"]["max_tokens"], 4096)
        self.assertEqual(upstream["timeout"], 120)
        self.assertEqual(StoreStub.reservations[0][:3], (7, "chat", 100))
        self.assertGreater(StoreStub.reservations[0][3], 5)
        self.assertEqual(StoreStub.reservations[0][4], 10_000_000)

    def test_request_budget_counts_all_sanitized_provider_fields(self) -> None:
        body = {
            "messages": [{"role": "user", "content": "hello"}],
            "response_format": {"type": "json_object"},
            "stop": ["END"],
            "ignored": "x" * 100_000,
        }
        clean, units = _sanitize_request_body("chat", body)
        self.assertNotIn("ignored", clean)
        self.assertEqual(
            units,
            len(json.dumps(clean, ensure_ascii=False, separators=(",", ":")).encode("utf-8")),
        )

    def test_translation_message_shapes_follow_configured_mode(self) -> None:
        qwen = _sanitize_messages("translation", [{"role": "user", "content": "hello"}])
        self.assertEqual(qwen[0]["role"], "user")
        chat = _sanitize_messages(
            "translation",
            [{"role": "system", "content": "Translate only."}, {"role": "user", "content": "hello"}],
            translation_mode="chat",
        )
        self.assertEqual([item["role"] for item in chat], ["system", "user"])
        with self.assertRaisesRegex(AccountError, "system"):
            _sanitize_messages("translation", [{"role": "user", "content": "hello"}], translation_mode="chat")

    def test_translation_budget_has_its_own_shared_ceiling(self) -> None:
        clean, _units = _sanitize_request_body(
            "translation",
            {"messages": [{"role": "system", "content": "Translate only."}, {"role": "user", "content": "hello"}], "max_tokens": 99999},
            translation_mode="chat",
        )
        self.assertEqual(clean["max_tokens"], 8192)

    def test_oversized_or_nested_provider_controls_are_rejected(self) -> None:
        with self.assertRaisesRegex(AccountError, "response_format"):
            _sanitize_request_body("chat", {
                "messages": [{"role": "user", "content": "hello"}],
                "response_format": {"type": "json_schema", "json_schema": {"description": "x" * 100_000}},
            })
        with self.assertRaisesRegex(AccountError, "stop"):
            _sanitize_request_body("chat", {
                "messages": [{"role": "user", "content": "hello"}],
                "stop": "x" * 257,
            })

    def test_default_redirect_policy_refuses_cross_origin_provider_redirects(self) -> None:
        handler = _SameOriginRedirectHandler()
        request = urllib.request.Request("https://provider.example.test/v1/chat/completions")
        with self.assertRaises(urllib.error.HTTPError) as raised:
            handler.redirect_request(
                request,
                None,
                HTTPStatus.FOUND,
                "Found",
                {},
                "https://attacker.example.test/collect",
            )
        self.assertEqual(raised.exception.code, HTTPStatus.BAD_GATEWAY)

    def test_provider_probe_checks_both_profiles_without_returning_secrets(self) -> None:
        calls: list[str] = []

        def opener(request: urllib.request.Request, *, timeout: int) -> ResponseStub:
            calls.append(request.full_url)
            self.assertEqual(timeout, 7)
            return ResponseStub(b'{"choices":[{"message":{"content":"OK"}}]}')

        result = probe_profiles(PROFILES, opener=opener, timeout=7)
        encoded = json.dumps(result)
        self.assertTrue(result["ok"])
        self.assertEqual(len(calls), 2)
        self.assertNotIn("secret", encoded)
        self.assertNotIn("example.test", encoded)

    def test_real_account_store_session_can_use_gateway(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-ai-integration-") as temp:
            store = AccountStore(Path(temp) / "users.db")
            try:
                invite = store.admin_create_invite()
                registration = store.register(
                    "beta-user",
                    "password-123",
                    invite["invite_code"],
                    TERMS_VERSION,
                    PRIVACY_VERSION,
                )

                def opener(_request: urllib.request.Request, *, timeout: int) -> ResponseStub:
                    self.assertEqual(timeout, 120)
                    return ResponseStub(b'{"choices":[{"message":{"content":"ok"}}]}')

                with GatewayServer(opener, store) as gateway:
                    response = self._post(
                        gateway,
                        registration["token"],
                        {"messages": [{"role": "user", "content": "hello"}]},
                    )
                self.assertEqual(response["choices"][0]["message"]["content"], "ok")
            finally:
                store.close()

    def test_legacy_agreement_session_is_rejected_until_current_login(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-ai-agreement-") as temp:
            store = AccountStore(Path(temp) / "users.db")
            try:
                invite = store.admin_create_invite()
                registration = store.register(
                    "legacy-user",
                    "password-123",
                    invite["invite_code"],
                    TERMS_VERSION,
                    PRIVACY_VERSION,
                )
                with store._lock:
                    store._connection.execute(
                        "UPDATE users SET terms_version = '', privacy_version = '' WHERE username = 'legacy-user'"
                    )
                    store._connection.commit()
                calls: list[str] = []

                def opener(request: urllib.request.Request, *, timeout: int) -> ResponseStub:
                    calls.append(request.full_url)
                    return ResponseStub(b'{"choices":[{"message":{"content":"ok"}}]}')

                with GatewayServer(opener, store) as gateway:
                    request = urllib.request.Request(
                        gateway.url + "/chat/v1/chat/completions",
                        data=json.dumps({"messages": [{"role": "user", "content": "hello"}]}).encode(),
                        headers={"Content-Type": "application/json", "Authorization": "Bearer " + registration["token"]},
                        method="POST",
                    )
                    with self.assertRaises(urllib.error.HTTPError) as raised:
                        urllib.request.urlopen(request, timeout=2)
                    self.assertEqual(raised.exception.code, HTTPStatus.FORBIDDEN)
                    current = store.login("legacy-user", "password-123", TERMS_VERSION, PRIVACY_VERSION)
                    self._post(gateway, current["token"], {"messages": [{"role": "user", "content": "hello"}]})
                self.assertEqual(len(calls), 1)
            finally:
                store.close()

    def test_failed_upstream_request_refunds_persistent_daily_usage(self) -> None:
        with tempfile.TemporaryDirectory(prefix="guzi-ai-refund-") as temp:
            store = AccountStore(Path(temp) / "users.db")
            try:
                invite = store.admin_create_invite()
                registration = store.register(
                    "refund-user",
                    "password-123",
                    invite["invite_code"],
                    TERMS_VERSION,
                    PRIVACY_VERSION,
                )

                def opener(_request: urllib.request.Request, *, timeout: int) -> None:
                    raise urllib.error.URLError("offline")

                with GatewayServer(opener, store) as gateway:
                    request = urllib.request.Request(
                        gateway.url + "/chat/v1/chat/completions",
                        data=json.dumps({"messages": [{"role": "user", "content": "hello"}]}).encode(),
                        headers={"Content-Type": "application/json", "Authorization": "Bearer " + registration["token"]},
                        method="POST",
                    )
                    with self.assertRaises(urllib.error.HTTPError) as raised:
                        urllib.request.urlopen(request, timeout=2)
                    self.assertEqual(raised.exception.code, HTTPStatus.BAD_GATEWAY)
                with store._lock:
                    count = store._connection.execute("SELECT COUNT(*) FROM ai_usage_daily").fetchone()[0]
                self.assertEqual(count, 0)
            finally:
                store.close()

    def test_limiter_caps_concurrency_and_minute_budget(self) -> None:
        limiter = RequestLimiter(requests_per_minute=2, concurrent_requests=1)
        self.assertEqual(limiter.acquire(1), (True, 0))
        accepted, retry_after = limiter.acquire(1)
        self.assertFalse(accepted)
        self.assertGreaterEqual(retry_after, 1)
        limiter.release(1)
        self.assertEqual(limiter.acquire(1), (True, 0))
        limiter.release(1)
        accepted, retry_after = limiter.acquire(1)
        self.assertFalse(accepted)
        self.assertGreaterEqual(retry_after, 1)


if __name__ == "__main__":
    unittest.main()
