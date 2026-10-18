import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from user_service import (  # noqa: E402
    AccountError,
    AccountStore,
    DEFAULT_QUOTA_BYTES,
    EMAIL_CHALLENGE_RETENTION_SECONDS,
    EMAIL_CODE_ATTEMPT_LIMIT,
    EMAIL_CODE_TTL_SECONDS,
    EMAIL_RESET_REQUEST_MESSAGE,
    EmailConfig,
    EmailOutboxWorker,
    OUTBOX_RETENTION_SECONDS,
    PASSWORD_RESET_NOTICE_MAX_AGE_SECONDS,
    PRIVACY_VERSION,
    TERMS_VERSION,
    _hash_password,
    _token_hash,
    build_handler,
    email_preflight,
    load_email_config,
)


def enabled_email_config(required: bool = False) -> EmailConfig:
    return EmailConfig(
        enabled=True,
        required=required,
        host="smtp.163.com",
        port=465,
        security="ssl",
        username="guzilab_notify@163.com",
        password="smtp-authorization-code",
        from_address="guzilab_notify@163.com",
        from_name="谷子学术",
        reply_to="guzilab@163.com",
        code_secret="email-code-secret-that-is-independent-and-long",
    )


class AccountStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="my-scholar-users-")
        self.store = AccountStore(str(Path(self.temp.name) / "users.db"))

    def tearDown(self) -> None:
        self.store.close()
        self.temp.cleanup()

    def _invite(self, **kwargs) -> dict:
        return self.store.admin_create_invite(**kwargs)

    def _register(self, username: str, password: str, invite_code: str = "") -> dict:
        code = invite_code or self._invite()["invite_code"]
        return self.store.register(username, password, code, TERMS_VERSION, PRIVACY_VERSION)

    def test_invited_users_receive_free_beta_access_and_recovery_code(self) -> None:
        first = self._register("owner", "password-1")
        second = self._register("guest", "password-2")
        self.assertTrue(first["profile"]["member"])
        self.assertTrue(second["profile"]["member"])
        self.assertEqual(first["profile"]["quota_bytes"], DEFAULT_QUOTA_BYTES)
        self.assertTrue(first["token"])
        self.assertGreaterEqual(len(first["recovery_code"]), 32)

        with self.store._lock:
            row = self.store._connection.execute(
                "SELECT recovery_code_hash, terms_version, privacy_version FROM users WHERE username = ?",
                ("owner",),
            ).fetchone()
        self.assertNotEqual(row["recovery_code_hash"], first["recovery_code"])
        self.assertEqual(row["recovery_code_hash"], _token_hash(first["recovery_code"]))
        self.assertEqual(row["terms_version"], TERMS_VERSION)
        self.assertEqual(row["privacy_version"], PRIVACY_VERSION)

    def test_duplicate_username_does_not_consume_invite(self) -> None:
        self._register("owner", "password-1")
        reusable = self._invite()["invite_code"]
        with self.assertRaises(AccountError) as caught:
            self.store.register("owner", "password-9", reusable, TERMS_VERSION, PRIVACY_VERSION)
        self.assertEqual(caught.exception.status, 409)
        guest = self.store.register("guest", "password-2", reusable, TERMS_VERSION, PRIVACY_VERSION)
        self.assertEqual(guest["profile"]["username"], "guest")

    def test_invalid_username_and_password_bounds_rejected_without_consuming_invite(self) -> None:
        invite = self._invite()["invite_code"]
        with self.assertRaises(AccountError):
            self.store.register("a", "password-1", invite, TERMS_VERSION, PRIVACY_VERSION)
        with self.assertRaises(AccountError):
            self.store.register("valid-name", "short", invite, TERMS_VERSION, PRIVACY_VERSION)
        with self.assertRaises(AccountError):
            self.store.register("valid-name", "x" * 129, invite, TERMS_VERSION, PRIVACY_VERSION)
        session = self.store.register("valid-name", "password-1", invite, TERMS_VERSION, PRIVACY_VERSION)
        self.assertTrue(session["token"])

    def test_current_agreement_versions_are_required_without_consuming_invite(self) -> None:
        invite = self._invite()["invite_code"]
        for terms, privacy in (("", PRIVACY_VERSION), (TERMS_VERSION, "old")):
            with self.assertRaises(AccountError) as caught:
                self.store.register("owner", "password-1", invite, terms, privacy)
            self.assertEqual(caught.exception.status, 400)
        session = self.store.register("owner", "password-1", invite, TERMS_VERSION, PRIVACY_VERSION)
        self.assertTrue(session["profile"]["member"])

    def test_invalid_expired_revoked_and_used_invites_are_rejected(self) -> None:
        with mock.patch("user_service._hash_password") as expensive_hash, self.assertRaises(AccountError) as invalid:
            self.store.register("invalid", "password-1", "not-an-invite", TERMS_VERSION, PRIVACY_VERSION)
        self.assertEqual(invalid.exception.status, 403)
        expensive_hash.assert_not_called()

        expired = self._invite()
        with mock.patch("user_service.time.time", return_value=time.time() + 31 * 24 * 3600):
            with self.assertRaises(AccountError) as caught:
                self.store.register("expired", "password-1", expired["invite_code"], TERMS_VERSION, PRIVACY_VERSION)
        self.assertEqual(caught.exception.status, 403)

        revoked = self._invite()
        self.store.admin_revoke_invite(revoked["id"])
        with self.assertRaises(AccountError) as caught:
            self.store.register("revoked", "password-1", revoked["invite_code"], TERMS_VERSION, PRIVACY_VERSION)
        self.assertEqual(caught.exception.status, 403)

        used = self._invite()["invite_code"]
        self.store.register("first", "password-1", used, TERMS_VERSION, PRIVACY_VERSION)
        with self.assertRaises(AccountError) as caught:
            self.store.register("second", "password-2", used, TERMS_VERSION, PRIVACY_VERSION)
        self.assertEqual(caught.exception.status, 403)

    def test_invite_codes_are_hashed_and_list_output_contains_no_secret(self) -> None:
        created = self._invite(max_uses=2, valid_days=10)
        with self.store._lock:
            row = self.store._connection.execute(
                "SELECT code_hash FROM invites WHERE id = ?",
                (created["id"],),
            ).fetchone()
        self.assertEqual(row["code_hash"], _token_hash(created["invite_code"]))
        self.assertNotEqual(row["code_hash"], created["invite_code"])
        listed = self.store.admin_list_invites()[0]
        self.assertNotIn("invite_code", listed)
        self.assertNotIn("code_hash", listed)
        self.assertTrue(listed["available"])

    def test_single_use_invite_is_atomic_across_connections(self) -> None:
        path = str(Path(self.temp.name) / "concurrent.db")
        first_store = AccountStore(path)
        second_store = AccountStore(path)
        invite = first_store.admin_create_invite()["invite_code"]
        barrier = threading.Barrier(2)
        outcomes = []
        outcomes_lock = threading.Lock()

        def register(store: AccountStore, username: str) -> None:
            barrier.wait(timeout=5)
            try:
                store.register(username, "password-1", invite, TERMS_VERSION, PRIVACY_VERSION)
                result = "ok"
            except AccountError as exc:
                result = exc.status
            with outcomes_lock:
                outcomes.append(result)

        threads = [
            threading.Thread(target=register, args=(first_store, "first")),
            threading.Thread(target=register, args=(second_store, "second")),
        ]
        try:
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
            self.assertEqual(sorted(outcomes, key=str), [403, "ok"])
            self.assertEqual(len(first_store.admin_list()), 1)
        finally:
            first_store.close()
            second_store.close()

    def test_login_token_round_trip_and_logout(self) -> None:
        self._register("owner", "password-1")
        session = self.store.login("owner", "password-1")
        self.assertEqual(self.store.profile(session["token"])["username"], "owner")
        self.store.logout(session["token"])
        with self.assertRaises(AccountError) as caught:
            self.store.profile(session["token"])
        self.assertEqual(caught.exception.status, 401)

    def test_wrong_password_rejected_without_user_disclosure(self) -> None:
        self._register("owner", "password-1")
        for username in ("owner", "nobody"):
            with self.assertRaises(AccountError) as caught:
                self.store.login(username, "wrong-password")
            self.assertEqual(caught.exception.status, 401)
            self.assertEqual(str(caught.exception), "用户名或密码错误。")

    def test_missing_username_still_runs_password_hash(self) -> None:
        with mock.patch("user_service._hash_password", wraps=_hash_password) as password_hash:
            with self.assertRaises(AccountError):
                self.store.login("missing-user", "wrong-password")
        password_hash.assert_called_once()

    def test_password_recovery_rotates_code_and_revokes_all_sessions(self) -> None:
        registration = self._register("owner", "password-1")
        second_session = self.store.login("owner", "password-1")
        reset = self.store.reset_password("owner", registration["recovery_code"], "password-2")
        self.assertNotEqual(reset["recovery_code"], registration["recovery_code"])

        for token in (registration["token"], second_session["token"]):
            with self.assertRaises(AccountError) as caught:
                self.store.profile(token)
            self.assertEqual(caught.exception.status, 401)
        with self.assertRaises(AccountError):
            self.store.login("owner", "password-1")
        self.assertTrue(self.store.login("owner", "password-2")["token"])
        with self.assertRaises(AccountError) as caught:
            self.store.reset_password("owner", registration["recovery_code"], "password-3")
        self.assertEqual(caught.exception.status, 401)
        rotated = self.store.reset_password("owner", reset["recovery_code"], "password-3")
        self.assertTrue(rotated["recovery_code"])

    def test_concurrent_password_reset_cannot_leave_old_password_session(self) -> None:
        registration = self._register("owner", "password-1")
        with self.store._lock:
            self.store._connection.execute(
                "UPDATE users SET terms_version = '', privacy_version = '', agreements_accepted_at = ''"
                " WHERE username = ?",
                ("owner",),
            )
            self.store._connection.commit()

        second_store = AccountStore(str(Path(self.temp.name) / "users.db"))
        password_verified = threading.Event()
        continue_login = threading.Event()
        outcomes = []
        real_hash_password = _hash_password

        def pause_old_password_login(password: str, salt: bytes) -> bytes:
            digest = real_hash_password(password, salt)
            if password == "password-1":
                password_verified.set()
                if not continue_login.wait(timeout=5):
                    raise RuntimeError("timed out waiting for concurrent password reset")
            return digest

        def login_with_old_password() -> None:
            try:
                self.store.login("owner", "password-1", TERMS_VERSION, PRIVACY_VERSION)
                outcomes.append("ok")
            except AccountError as exc:
                outcomes.append(exc.status)

        thread = threading.Thread(target=login_with_old_password)
        try:
            with mock.patch("user_service._hash_password", side_effect=pause_old_password_login):
                thread.start()
                self.assertTrue(password_verified.wait(timeout=5))
                second_store.reset_password("owner", registration["recovery_code"], "password-2")
                continue_login.set()
                thread.join(timeout=10)
            self.assertFalse(thread.is_alive())
            self.assertEqual(outcomes, [HTTPStatus.UNAUTHORIZED])
            with second_store._lock:
                row = second_store._connection.execute(
                    "SELECT terms_version, privacy_version FROM users WHERE username = ?",
                    ("owner",),
                ).fetchone()
                session_count = second_store._connection.execute(
                    "SELECT COUNT(*) FROM sessions WHERE user_id ="
                    " (SELECT id FROM users WHERE username = ?)",
                    ("owner",),
                ).fetchone()[0]
            self.assertEqual(row["terms_version"], "")
            self.assertEqual(row["privacy_version"], "")
            self.assertEqual(session_count, 0)
        finally:
            continue_login.set()
            thread.join(timeout=5)
            second_store.close()

    def test_invalid_recovery_code_is_rejected_before_password_hashing(self) -> None:
        self._register("owner", "password-1")
        with mock.patch("user_service._hash_password") as expensive_hash, self.assertRaises(AccountError) as caught:
            self.store.reset_password("owner", "wrong-recovery-code", "password-2")
        self.assertEqual(caught.exception.status, 401)
        expensive_hash.assert_not_called()

    def test_ai_daily_budget_is_persistent_and_scoped_by_service(self) -> None:
        registration = self._register("owner", "password-1")
        user_id = int(self.store.authenticate(registration["token"])["id"])
        self.assertEqual(self.store.reserve_ai_request(user_id, "chat", 2, 40, 100)["request_count"], 1)
        self.assertEqual(self.store.reserve_ai_request(user_id, "chat", 2, 40, 100)["input_units"], 80)
        with self.assertRaises(AccountError) as caught:
            self.store.reserve_ai_request(user_id, "chat", 2, 10, 100)
        self.assertEqual(caught.exception.status, 429)
        self.store.refund_ai_request(user_id, "chat", 40)
        self.assertEqual(self.store.reserve_ai_request(user_id, "chat", 2, 20, 100)["input_units"], 60)
        self.assertEqual(self.store.reserve_ai_request(user_id, "translation", 1, 50, 100)["request_count"], 1)

    def test_usage_report_updates_profile(self) -> None:
        session = self._register("owner", "password-1")
        profile = self.store.report_usage(session["token"], 123456)
        self.assertEqual(profile["used_bytes"], 123456)
        with self.assertRaises(AccountError):
            self.store.report_usage(session["token"], "not-a-number")

    def test_profile_update_nickname_and_avatar_with_validation(self) -> None:
        session = self._register("owner", "password-1")
        token = session["token"]
        avatar = "data:image/jpeg;base64," + "A" * 400
        profile = self.store.update_profile(token, nickname="小谷", avatar=avatar)
        self.assertEqual(profile["nickname"], "小谷")
        self.assertEqual(profile["avatar"], avatar)
        profile = self.store.update_profile(token, nickname="谷子")
        self.assertEqual(profile["avatar"], avatar)
        profile = self.store.update_profile(token, avatar="")
        self.assertEqual(profile["avatar"], "")
        self.assertEqual(profile["nickname"], "谷子")
        with self.assertRaises(AccountError):
            self.store.update_profile(token, nickname="x" * 33)
        with self.assertRaises(AccountError):
            self.store.update_profile(token, avatar="data:text/html;base64,AAAA")
        with self.assertRaises(AccountError):
            self.store.update_profile(token, avatar="data:image/png;base64," + "A" * 200_001)

    def test_versioned_schema_migration_preserves_legacy_user_and_session(self) -> None:
        path = str(Path(self.temp.name) / "legacy.db")
        connection = sqlite3.connect(path)
        connection.executescript(
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,"
            " password_hash BLOB NOT NULL, salt BLOB NOT NULL, member INTEGER NOT NULL DEFAULT 0,"
            " quota_bytes INTEGER NOT NULL, used_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);"
            "CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id)"
            " ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at REAL NOT NULL);"
        )
        salt = b"0123456789abcdef"
        cursor = connection.execute(
            "INSERT INTO users (username, password_hash, salt, member, quota_bytes, created_at)"
            " VALUES (?, ?, ?, 1, ?, ?)",
            ("legacy", _hash_password("password-1", salt), salt, DEFAULT_QUOTA_BYTES, "2026-01-01T00:00:00+00:00"),
        )
        legacy_token = "legacy-session-token"
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (_token_hash(legacy_token), cursor.lastrowid, "2026-01-01T00:00:00+00:00", time.time() + 3600),
        )
        connection.commit()
        connection.close()

        migrated = AccountStore(path)
        try:
            profile = migrated.profile(legacy_token)
            self.assertEqual(profile["username"], "legacy")
            self.assertEqual(profile["nickname"], "")
            self.assertEqual(profile["avatar"], "")
            versions = [row[0] for row in migrated._connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            )]
            self.assertEqual(versions, [1, 2, 3, 4, 5, 6])
            self.assertFalse(profile["beta_access"])
            with self.assertRaises(AccountError):
                migrated.login("legacy", "password-1")
            accepted = migrated.login("legacy", "password-1", TERMS_VERSION, PRIVACY_VERSION)
            self.assertTrue(accepted["profile"]["beta_access"])
            self.assertEqual(migrated._connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(migrated._connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertGreaterEqual(migrated._connection.execute("PRAGMA busy_timeout").fetchone()[0], 5000)
            recovery = migrated.admin_issue_recovery("legacy")
            self.assertEqual(recovery["username"], "legacy")
            self.assertNotEqual(
                migrated._connection.execute(
                    "SELECT recovery_code_hash FROM users WHERE username = 'legacy'"
                ).fetchone()[0],
                recovery["recovery_code"],
            )
            self.assertTrue(migrated.reset_password("legacy", recovery["recovery_code"], "password-3")["recovery_code"])
            invite = migrated.admin_create_invite()["invite_code"]
            created = migrated.register("new-user", "password-2", invite, TERMS_VERSION, PRIVACY_VERSION)
            self.assertTrue(created["profile"]["member"])
        finally:
            migrated.close()

    def test_schema_version_five_upgrades_an_already_applied_v4_usage_table(self) -> None:
        path = str(Path(self.temp.name) / "v4.db")
        AccountStore(path).close()
        connection = sqlite3.connect(path)
        connection.execute("DELETE FROM schema_migrations WHERE version = 5")
        connection.execute("DROP TABLE ai_usage_daily")
        connection.execute(
            "CREATE TABLE ai_usage_daily ("
            "user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,"
            "usage_date TEXT NOT NULL, service TEXT NOT NULL, request_count INTEGER NOT NULL DEFAULT 0,"
            "PRIMARY KEY (user_id, usage_date, service))"
        )
        connection.commit()
        connection.close()

        upgraded = AccountStore(path)
        try:
            columns = {row["name"] for row in upgraded._connection.execute("PRAGMA table_info(ai_usage_daily)")}
            versions = [row[0] for row in upgraded._connection.execute("SELECT version FROM schema_migrations ORDER BY version")]
            self.assertIn("input_units", columns)
            self.assertEqual(versions, [1, 2, 3, 4, 5, 6])
        finally:
            upgraded.close()

    def test_admin_membership_and_quota_updates(self) -> None:
        self._register("owner", "password-1")
        self._register("guest", "password-2")
        granted = self.store.admin_update("guest", member=1)
        self.assertTrue(granted["member"])
        revoked = self.store.admin_update("guest", member=0)
        self.assertFalse(revoked["member"])
        widened = self.store.admin_update("guest", quota_bytes=5 * DEFAULT_QUOTA_BYTES)
        self.assertEqual(widened["quota_bytes"], 5 * DEFAULT_QUOTA_BYTES)
        with self.assertRaises(AccountError):
            self.store.admin_update("missing", member=1)

    def test_context_manager_closes_connection(self) -> None:
        path = str(Path(self.temp.name) / "context.db")
        with AccountStore(path) as scoped:
            self.assertFalse(scoped._closed)
        self.assertTrue(scoped._closed)


class EmailAccountStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="my-scholar-email-users-")
        self.store = AccountStore(
            str(Path(self.temp.name) / "users.db"),
            email_config=enabled_email_config(),
        )

    def tearDown(self) -> None:
        self.store.close()
        self.temp.cleanup()

    def _register(self, username: str = "owner", email: str = "owner@example.com") -> dict:
        invite = self.store.admin_create_invite()
        challenge = self.store.request_email_code("register", email, invite["invite_code"])
        code = self.store._derive_email_code(challenge["challenge_id"], "register", email.casefold())
        return self.store.register(
            username,
            "password-1",
            invite["invite_code"],
            TERMS_VERSION,
            PRIVACY_VERSION,
            email,
            challenge["challenge_id"],
            code,
        )

    def test_preflight_reports_only_non_sensitive_configuration(self) -> None:
        config = enabled_email_config()
        result = email_preflight(config)
        self.assertTrue(result["email_auth_available"])
        self.assertFalse(result["email_auth_required"])
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(config.password, serialized)
        self.assertNotIn(config.code_secret, serialized)
        with self.assertRaises(AccountError):
            email_preflight(EmailConfig(**{**config.__dict__, "security": "starttls"}))
        with self.assertRaises(AccountError):
            email_preflight(EmailConfig(**{**config.__dict__, "code_secret": config.password}))

    def test_required_email_auth_fails_closed_and_requires_verified_registration(self) -> None:
        with mock.patch.dict(os.environ, {
            "MY_SCHOLAR_REQUIRE_EMAIL_AUTH": "true",
            "MY_SCHOLAR_EMAIL_ENABLED": "false",
        }, clear=True):
            config = load_email_config()
        self.assertTrue(config.required)
        self.assertFalse(config.enabled)
        with self.assertRaises(AccountError):
            email_preflight(config)
        unopened_db = Path(self.temp.name) / "unopened-required.db"
        with self.assertRaises(AccountError):
            AccountStore(str(unopened_db), email_config=config)
        self.assertFalse(unopened_db.exists())

        with AccountStore(
            str(Path(self.temp.name) / "required.db"),
            email_config=enabled_email_config(required=True),
        ) as required_store:
            invite = required_store.admin_create_invite()
            with self.assertRaises(AccountError):
                required_store.register(
                    "required", "password-1", invite["invite_code"], TERMS_VERSION, PRIVACY_VERSION
                )
            challenge = required_store.request_email_code(
                "register", "required@example.com", invite["invite_code"]
            )
            code = required_store._derive_email_code(
                challenge["challenge_id"], "register", "required@example.com"
            )
            result = required_store.register(
                "required", "password-1", invite["invite_code"], TERMS_VERSION, PRIVACY_VERSION,
                "required@example.com", challenge["challenge_id"], code,
            )
            self.assertEqual(result["profile"]["email"], "required@example.com")

    def test_registration_requires_single_use_email_code_and_consumes_invite_only_at_finish(self) -> None:
        invite = self.store.admin_create_invite()
        requested = self.store.request_email_code("register", "Owner@Example.COM", invite["invite_code"])
        challenge_id = requested["challenge_id"]
        code = self.store._derive_email_code(challenge_id, "register", "owner@example.com")
        self.assertRegex(code, r"^\d{8}$")
        with self.store._lock:
            invite_uses = self.store._connection.execute(
                "SELECT use_count FROM invites WHERE id = ?", (invite["id"],)
            ).fetchone()[0]
            challenge_columns = {
                row["name"] for row in self.store._connection.execute("PRAGMA table_info(email_challenges)")
            }
            persisted = repr(tuple(self.store._connection.execute(
                "SELECT * FROM email_challenges WHERE id = ?", (challenge_id,)
            ).fetchone())) + repr(tuple(self.store._connection.execute(
                "SELECT * FROM mail_outbox WHERE challenge_id = ?", (challenge_id,)
            ).fetchone()))
        self.assertEqual(invite_uses, 0)
        self.assertNotIn("email_code", challenge_columns)
        self.assertNotIn(code, persisted)

        with self.assertRaises(AccountError):
            self.store.register(
                "owner", "password-1", invite["invite_code"], TERMS_VERSION, PRIVACY_VERSION,
                "owner@example.com", challenge_id, "00000000" if code != "00000000" else "00000001",
            )
        self.assertEqual(self.store.admin_list_invites()[0]["use_count"], 0)
        registration = self.store.register(
            "owner", "password-1", invite["invite_code"], TERMS_VERSION, PRIVACY_VERSION,
            "owner@example.com", challenge_id, code,
        )
        self.assertEqual(registration["profile"]["email"], "owner@example.com")
        self.assertTrue(registration["profile"]["email_verified"])
        self.assertTrue(self.store.login("OWNER@EXAMPLE.COM", "password-1")["token"])
        with self.assertRaises(AccountError):
            self.store.register(
                "other", "password-2", self.store.admin_create_invite()["invite_code"],
                TERMS_VERSION, PRIVACY_VERSION, "owner@example.com", challenge_id, code,
            )

    def test_email_code_expires_after_maximum_attempts(self) -> None:
        invite = self.store.admin_create_invite()
        challenge = self.store.request_email_code("register", "owner@example.com", invite["invite_code"])
        correct = self.store._derive_email_code(challenge["challenge_id"], "register", "owner@example.com")
        wrong = "00000000" if correct != "00000000" else "00000001"
        for _ in range(EMAIL_CODE_ATTEMPT_LIMIT):
            with self.assertRaises(AccountError):
                self.store.register(
                    "owner", "password-1", invite["invite_code"], TERMS_VERSION, PRIVACY_VERSION,
                    "owner@example.com", challenge["challenge_id"], wrong,
                )
        with self.assertRaises(AccountError):
            self.store.register(
                "owner", "password-1", invite["invite_code"], TERMS_VERSION, PRIVACY_VERSION,
                "owner@example.com", challenge["challenge_id"], correct,
            )
        self.assertEqual(self.store.admin_list_invites()[0]["use_count"], 0)

    def test_unknown_reset_has_same_response_and_email_reset_revokes_sessions(self) -> None:
        registration = self._register()
        second = self.store.login("owner@example.com", "password-1")
        known = self.store.request_email_code("reset", "owner@example.com")
        unknown = self.store.request_email_code("reset", "missing@example.com")
        self.assertEqual(known["message"], EMAIL_RESET_REQUEST_MESSAGE)
        self.assertEqual(unknown["message"], EMAIL_RESET_REQUEST_MESSAGE)
        self.assertEqual(known["expires_in"], EMAIL_CODE_TTL_SECONDS)
        self.assertEqual(set(known), set(unknown))
        with self.store._lock:
            reset_mail_count = self.store._connection.execute(
                "SELECT COUNT(*) FROM mail_outbox WHERE kind = 'reset_code'"
            ).fetchone()[0]
        self.assertEqual(reset_mail_count, 1)

        code = self.store._derive_email_code(known["challenge_id"], "reset", "owner@example.com")
        reset = self.store.reset_password_email(known["challenge_id"], code, "password-2")
        self.assertTrue(reset["recovery_code"])
        for token in (registration["token"], second["token"]):
            with self.assertRaises(AccountError):
                self.store.profile(token)
        with self.assertRaises(AccountError):
            self.store.login("owner@example.com", "password-1")
        self.assertTrue(self.store.login("owner@example.com", "password-2")["token"])
        with self.store._lock:
            notice_count = self.store._connection.execute(
                "SELECT COUNT(*) FROM mail_outbox WHERE kind = 'password_reset_notice'"
            ).fetchone()[0]
        self.assertEqual(notice_count, 1)

    def test_authenticated_user_can_bind_a_new_email(self) -> None:
        registration = self._register()
        with self.assertRaises(AccountError) as already_bound:
            self.store.request_email_code(
                "bind", "bound@example.com", token=registration["token"]
            )
        self.assertEqual(already_bound.exception.status, HTTPStatus.CONFLICT)
        with self.store._lock:
            self.store._connection.execute(
                "UPDATE users SET email = NULL, email_verified_at = '' WHERE username = 'owner'"
            )
            self.store._connection.commit()
        challenge = self.store.request_email_code(
            "bind", "bound@example.com", token=registration["token"]
        )
        code = self.store._derive_email_code(challenge["challenge_id"], "bind", "bound@example.com")
        with self.store._lock:
            self.store._connection.execute(
                "UPDATE users SET email = ?, email_verified_at = ? WHERE username = 'owner'",
                ("intervening@example.com", "2026-08-06T00:00:00+00:00"),
            )
            self.store._connection.commit()
        with self.assertRaises(AccountError) as intervening_bind:
            self.store.bind_email(registration["token"], challenge["challenge_id"], code)
        self.assertEqual(intervening_bind.exception.status, HTTPStatus.CONFLICT)
        with self.store._lock:
            self.store._connection.execute(
                "UPDATE users SET email = NULL, email_verified_at = '' WHERE username = 'owner'"
            )
            self.store._connection.commit()
        result = self.store.bind_email(registration["token"], challenge["challenge_id"], code)
        self.assertEqual(result["profile"]["email"], "bound@example.com")
        self.assertTrue(result["profile"]["email_verified"])

    def test_outbox_worker_uses_smtp_ssl_without_persisting_raw_code(self) -> None:
        invite = self.store.admin_create_invite()
        challenge = self.store.request_email_code("register", "owner@example.com", invite["invite_code"])
        code = self.store._derive_email_code(challenge["challenge_id"], "register", "owner@example.com")
        captured = {}

        class FakeSMTP:
            def __init__(self, host, port, **kwargs):
                captured.update({"host": host, "port": port, **kwargs})

            def __enter__(self):
                return self

            def __exit__(self, _exc_type, _exc, _traceback):
                return None

            def login(self, username, password):
                captured["login"] = (username, password)

            def send_message(self, message, **kwargs):
                captured["message"] = message
                captured["envelope"] = kwargs

        self.assertTrue(EmailOutboxWorker(self.store, smtp_factory=FakeSMTP).process_once())
        self.assertEqual((captured["host"], captured["port"]), ("smtp.163.com", 465))
        self.assertIsNotNone(captured["context"])
        self.assertEqual(captured["login"], ("guzilab_notify@163.com", "smtp-authorization-code"))
        self.assertEqual(captured["envelope"]["from_addr"], "guzilab_notify@163.com")
        self.assertEqual(captured["envelope"]["to_addrs"], ["owner@example.com"])
        self.assertEqual(captured["message"]["Reply-To"], "guzilab@163.com")
        self.assertIn(code, captured["message"].get_content())
        with self.store._lock:
            outbox = self.store._connection.execute(
                "SELECT * FROM mail_outbox WHERE challenge_id = ?", (challenge["challenge_id"],)
            ).fetchone()
        self.assertEqual(outbox["status"], "sent")
        self.assertNotIn(code, repr(tuple(outbox)))

    def test_new_email_code_request_cancels_pending_old_message(self) -> None:
        invite = self.store.admin_create_invite()
        first = self.store.request_email_code("register", "owner@example.com", invite["invite_code"])
        second = self.store.request_email_code("register", "owner@example.com", invite["invite_code"])
        captured = []

        class FakeSMTP:
            def __init__(self, _host, _port, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, _exc_type, _exc, _traceback):
                return None

            def login(self, _username, _password):
                pass

            def send_message(self, message, **_kwargs):
                captured.append(message)

        with self.store._lock:
            first_outbox = self.store._connection.execute(
                "SELECT status, last_error FROM mail_outbox WHERE challenge_id = ?",
                (first["challenge_id"],),
            ).fetchone()
        self.assertEqual((first_outbox["status"], first_outbox["last_error"]), (
            "failed", "StaleEmailChallenge"
        ))
        worker = EmailOutboxWorker(self.store, smtp_factory=FakeSMTP)
        self.assertTrue(worker.process_once())
        self.assertFalse(worker.process_once())
        self.assertEqual(len(captured), 1)
        current_code = self.store._derive_email_code(
            second["challenge_id"], "register", "owner@example.com"
        )
        self.assertIn(current_code, captured[0].get_content())

    def test_outbox_worker_skips_expired_email_challenge(self) -> None:
        invite = self.store.admin_create_invite()
        challenge = self.store.request_email_code("register", "owner@example.com", invite["invite_code"])
        smtp_opened = []

        class FakeSMTP:
            def __init__(self, *_args, **_kwargs):
                smtp_opened.append(True)

        with self.store._lock:
            self.store._connection.execute(
                "UPDATE email_challenges SET expires_at = ? WHERE id = ?",
                (time.time() - 1, challenge["challenge_id"]),
            )
            self.store._connection.commit()
        self.assertFalse(EmailOutboxWorker(self.store, smtp_factory=FakeSMTP).process_once())
        self.assertEqual(smtp_opened, [])
        with self.store._lock:
            outbox = self.store._connection.execute(
                "SELECT status, last_error FROM mail_outbox WHERE challenge_id = ?",
                (challenge["challenge_id"],),
            ).fetchone()
        self.assertEqual((outbox["status"], outbox["last_error"]), (
            "failed", "StaleEmailChallenge"
        ))

    def test_outbox_worker_rechecks_challenge_after_smtp_login(self) -> None:
        invite = self.store.admin_create_invite()
        first = self.store.request_email_code("register", "owner@example.com", invite["invite_code"])
        replacement = {}
        sent = []

        class RacingSMTP:
            def __init__(self, *_args, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, _exc_type, _exc, _traceback):
                return None

            def login(self, _username, _password):
                replacement.update(self_store.request_email_code(
                    "register", "owner@example.com", invite["invite_code"]
                ))

            def send_message(self, _message, **_kwargs):
                sent.append(True)

        self_store = self.store
        self.assertTrue(EmailOutboxWorker(self.store, smtp_factory=RacingSMTP).process_once())
        self.assertEqual(sent, [])
        self.assertTrue(replacement["challenge_id"])
        with self.store._lock:
            first_outbox = self.store._connection.execute(
                "SELECT status, last_error FROM mail_outbox WHERE challenge_id = ?",
                (first["challenge_id"],),
            ).fetchone()
            replacement_outbox = self.store._connection.execute(
                "SELECT status FROM mail_outbox WHERE challenge_id = ?",
                (replacement["challenge_id"],),
            ).fetchone()
        self.assertEqual(
            (first_outbox["status"], first_outbox["last_error"]),
            ("failed", "StaleEmailChallenge"),
        )
        self.assertEqual(replacement_outbox["status"], "pending")

    def test_password_reset_notice_has_reset_time_and_expires_after_one_day(self) -> None:
        self._register()
        challenge = self.store.request_email_code("reset", "owner@example.com")
        code = self.store._derive_email_code(challenge["challenge_id"], "reset", "owner@example.com")
        self.store.reset_password_email(challenge["challenge_id"], code, "password-2")
        captured = []

        class FakeSMTP:
            def __init__(self, *_args, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, _exc_type, _exc, _traceback):
                return None

            def login(self, _username, _password):
                pass

            def send_message(self, message, **_kwargs):
                captured.append(message)

        with self.store._lock:
            notice = self.store._connection.execute(
                "SELECT id, created_at FROM mail_outbox WHERE kind = 'password_reset_notice'"
            ).fetchone()
        self.assertTrue(EmailOutboxWorker(self.store, smtp_factory=FakeSMTP).process_once())
        reset_at = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(float(notice["created_at"])))
        self.assertIn(reset_at, captured[0].get_content())

        now = time.time()
        with self.store._lock:
            self.store._enqueue_mail_locked(
                "password_reset_notice",
                "owner@example.com",
                now=now - PASSWORD_RESET_NOTICE_MAX_AGE_SECONDS - 1,
            )
            stale_notice_id = self.store._connection.execute("SELECT last_insert_rowid()").fetchone()[0]
            self.store._connection.commit()
        self.assertIsNone(self.store.claim_next_mail(now=now))
        with self.store._lock:
            stale_notice = self.store._connection.execute(
                "SELECT status, last_error FROM mail_outbox WHERE id = ?", (stale_notice_id,)
            ).fetchone()
        self.assertEqual(
            (stale_notice["status"], stale_notice["last_error"]),
            ("failed", "ExpiredPasswordResetNotice"),
        )

    def test_email_challenge_and_outbox_retention_is_bounded(self) -> None:
        invite = self.store.admin_create_invite()
        challenge = self.store.request_email_code("register", "owner@example.com", invite["invite_code"])
        now = time.time()
        with self.store._lock:
            self.store._connection.execute(
                "UPDATE email_challenges SET created_at = ?, expires_at = ? WHERE id = ?",
                (
                    now - EMAIL_CHALLENGE_RETENTION_SECONDS - 1,
                    now - 1,
                    challenge["challenge_id"],
                ),
            )
            self.store._connection.execute(
                "UPDATE mail_outbox SET created_at = ? WHERE challenge_id = ?",
                (now - OUTBOX_RETENTION_SECONDS - 1, challenge["challenge_id"]),
            )
            self.store._connection.commit()
        self.assertIsNone(self.store.claim_next_mail(now=now))
        with self.store._lock:
            challenge_count = self.store._connection.execute(
                "SELECT COUNT(*) FROM email_challenges WHERE id = ?", (challenge["challenge_id"],)
            ).fetchone()[0]
            outbox_count = self.store._connection.execute(
                "SELECT COUNT(*) FROM mail_outbox WHERE recipient = 'owner@example.com'"
            ).fetchone()[0]
        self.assertEqual((challenge_count, outbox_count), (0, 0))


class AccountHandlerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="my-scholar-users-http-")
        self.store = AccountStore(str(Path(self.temp.name) / "users.db"))
        self.invite_code = self.store.admin_create_invite()["invite_code"]
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), build_handler(self.store))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.store.close()
        self.temp.cleanup()

    def _call(self, path: str, payload=None, token: str = "", method: str = "GET"):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def _registration_payload(self, **overrides) -> dict:
        payload = {
            "username": "owner",
            "password": "password-1",
            "invite_code": self.invite_code,
            "terms_version": TERMS_VERSION,
            "privacy_version": PRIVACY_VERSION,
        }
        payload.update(overrides)
        return payload

    def test_register_requires_invite_and_agreements_and_returns_recovery_code(self) -> None:
        status, body = self._call(
            "/api/auth/register",
            self._registration_payload(invite_code=""),
            method="POST",
        )
        self.assertEqual(status, 403)
        self.assertIn("邀请码", body["error"])
        status, body = self._call(
            "/api/auth/register",
            self._registration_payload(terms_version=""),
            method="POST",
        )
        self.assertEqual(status, 400)
        status, body = self._call("/api/auth/register", self._registration_payload(), method="POST")
        self.assertEqual(status, 200)
        self.assertTrue(body["recovery_code"])
        token = body["token"]
        status, body = self._call("/api/auth/profile", token=token)
        self.assertEqual(status, 200)
        self.assertEqual(body["profile"]["username"], "owner")
        status, body = self._call("/api/auth/usage", {"used_bytes": 2048}, token=token, method="POST")
        self.assertEqual(status, 200)
        self.assertEqual(body["profile"]["used_bytes"], 2048)

    def test_reset_password_route_revokes_existing_session(self) -> None:
        status, registration = self._call("/api/auth/register", self._registration_payload(), method="POST")
        self.assertEqual(status, 200)
        status, reset = self._call(
            "/api/auth/reset-password",
            {
                "username": "owner",
                "recovery_code": registration["recovery_code"],
                "new_password": "password-2",
            },
            method="POST",
        )
        self.assertEqual(status, 200)
        self.assertTrue(reset["recovery_code"])
        status, _body = self._call("/api/auth/profile", token=registration["token"])
        self.assertEqual(status, 401)
        status, body = self._call(
            "/api/auth/login",
            {"username": "owner", "password": "password-2"},
            method="POST",
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["token"])

    def test_health_and_unknown_paths(self) -> None:
        status, body = self._call("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["service"], "my-scholar-account")
        self.assertEqual(body["version"], "0.3.0")
        self.assertFalse(body["email_auth_available"])
        status, _body = self._call("/api/missing")
        self.assertEqual(status, 404)

    def test_login_rate_limit_returns_429(self) -> None:
        self._call("/api/auth/register", self._registration_payload(), method="POST")
        last_status = None
        for _ in range(11):
            last_status, _body = self._call(
                "/api/auth/login",
                {"username": "owner", "password": "bad"},
                method="POST",
            )
        self.assertEqual(last_status, 429)

    def test_forwarded_rate_limit_key_is_trusted_only_from_loopback(self) -> None:
        handler = object.__new__(build_handler(self.store))
        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {"X-Forwarded-For": "203.0.113.8, 198.51.100.4"}
        self.assertEqual(handler._client_key(), "198.51.100.4")

        handler.client_address = ("192.0.2.5", 12345)
        self.assertEqual(handler._client_key(), "192.0.2.5")

        handler.client_address = ("127.0.0.1", 12345)
        handler.headers = {"X-Forwarded-For": "not-an-ip"}
        self.assertEqual(handler._client_key(), "127.0.0.1")


class EmailAccountHandlerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="my-scholar-email-http-")
        self.store = AccountStore(
            str(Path(self.temp.name) / "users.db"),
            email_config=enabled_email_config(),
        )
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), build_handler(self.store))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.store.close()
        self.temp.cleanup()

    def _call(self, path: str, payload=None, token: str = "", method: str = "GET"):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def test_email_registration_login_bind_and_reset_routes(self) -> None:
        status, health = self._call("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["email_auth_available"])

        invite = self.store.admin_create_invite()
        status, requested = self._call(
            "/api/auth/email-code/request",
            {"purpose": "register", "email": "owner@example.com", "invite_code": invite["invite_code"]},
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.ACCEPTED)
        self.assertEqual(set(requested), {"ok", "challenge_id", "expires_in", "message"})
        code = self.store._derive_email_code(requested["challenge_id"], "register", "owner@example.com")
        status, registered = self._call(
            "/api/auth/register",
            {
                "username": "owner",
                "password": "password-1",
                "invite_code": invite["invite_code"],
                "terms_version": TERMS_VERSION,
                "privacy_version": PRIVACY_VERSION,
                "email": "owner@example.com",
                "email_challenge_id": requested["challenge_id"],
                "email_code": code,
            },
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(registered["profile"]["email"], "owner@example.com")
        status, login = self._call(
            "/api/auth/login",
            {"username": "OWNER@EXAMPLE.COM", "password": "password-1"},
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.OK)

        status, rejected_bind = self._call(
            "/api/auth/email-code/request",
            {"purpose": "bind", "email": "bound@example.com"},
            token=login["token"],
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.CONFLICT)
        self.assertIn("不支持换绑", rejected_bind["error"])

        legacy_invite = self.store.admin_create_invite()
        status, legacy = self._call(
            "/api/auth/register",
            {
                "username": "legacy",
                "password": "password-1",
                "invite_code": legacy_invite["invite_code"],
                "terms_version": TERMS_VERSION,
                "privacy_version": PRIVACY_VERSION,
            },
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(legacy["profile"]["email"], "")
        status, bind_request = self._call(
            "/api/auth/email-code/request",
            {"purpose": "bind", "email": "bound@example.com"},
            token=legacy["token"],
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.ACCEPTED)
        bind_code = self.store._derive_email_code(bind_request["challenge_id"], "bind", "bound@example.com")
        status, bound = self._call(
            "/api/auth/email-bind",
            {"challenge_id": bind_request["challenge_id"], "email_code": bind_code},
            token=legacy["token"],
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(bound["profile"]["email"], "bound@example.com")

        status, missing = self._call(
            "/api/auth/email-code/request",
            {"purpose": "reset", "email": "missing@example.com"},
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.ACCEPTED)
        status, reset_request = self._call(
            "/api/auth/email-code/request",
            {"purpose": "reset", "email": "bound@example.com"},
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.ACCEPTED)
        self.assertEqual(missing["message"], reset_request["message"])
        reset_code = self.store._derive_email_code(
            reset_request["challenge_id"], "reset", "bound@example.com"
        )
        status, reset = self._call(
            "/api/auth/password-reset/email",
            {
                "challenge_id": reset_request["challenge_id"],
                "email_code": reset_code,
                "new_password": "password-2",
            },
            method="POST",
        )
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(set(reset), {"ok", "recovery_code", "message"})
        status, _profile = self._call("/api/auth/profile", token=legacy["token"])
        self.assertEqual(status, HTTPStatus.UNAUTHORIZED)


if __name__ == "__main__":
    unittest.main()
