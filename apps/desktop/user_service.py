"""My Scholar account service.

A standalone, stdlib-only HTTP service that owns user accounts for the
desktop client: invitation registration, login tokens, beta AI entitlement,
password recovery, and legacy quota fields. It runs on a small always-on server;
the desktop app talks to it through the local server.py proxy.

Run:      python3 user_service.py serve --db users.db --host 0.0.0.0 --port 8478
Admin:    python3 user_service.py create-invite --db users.db
          python3 user_service.py list-invites --db users.db
          python3 user_service.py revoke-invite <id> --db users.db
          python3 user_service.py issue-recovery <username> --db users.db
          python3 user_service.py list-users --db users.db
          python3 user_service.py grant-member <username> --db users.db
          python3 user_service.py revoke-member <username> --db users.db
          python3 user_service.py set-quota <username> <bytes> --db users.db
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import threading
import time
from collections import deque
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional

DEFAULT_QUOTA_BYTES = 3 * 1024 * 1024 * 1024  # 3 GB free tier
TOKEN_TTL_SECONDS = 30 * 24 * 3600
TERMS_VERSION = "2026-08-06-email"
PRIVACY_VERSION = "2026-08-06-email"
MAX_NICKNAME_LENGTH = 32
MAX_AVATAR_CHARS = 140_000  # ~100KB image as a data URL
AVATAR_RE = re.compile(r"^data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128
LOGIN_ATTEMPT_WINDOW = 300.0
LOGIN_ATTEMPT_LIMIT = 10
MAX_BODY_BYTES = 192 * 1024
EMAIL_CODE_TTL_SECONDS = 10 * 60
EMAIL_CODE_ATTEMPT_LIMIT = 5
EMAIL_CODE_DIGITS = 8
EMAIL_REQUEST_MESSAGE = "如果该邮箱符合条件，验证码将发送到邮箱。"
EMAIL_RESET_REQUEST_MESSAGE = "如果该邮箱已绑定账号，验证码将发送到邮箱。"
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{2,63}$")
OUTBOX_MAX_ATTEMPTS = 3
OUTBOX_CLAIM_TIMEOUT = 5 * 60
EMAIL_CHALLENGE_RETENTION_SECONDS = 24 * 3600
OUTBOX_RETENTION_SECONDS = 7 * 24 * 3600
PASSWORD_RESET_NOTICE_MAX_AGE_SECONDS = 24 * 3600


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class AccountError(Exception):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST) -> None:
        super().__init__(message)
        self.status = status


class StaleEmailChallenge(Exception):
    pass


@dataclass(frozen=True)
class EmailConfig:
    enabled: bool
    required: bool
    host: str
    port: int
    security: str
    username: str
    password: str
    from_address: str
    from_name: str
    reply_to: str
    code_secret: str

    @property
    def available(self) -> bool:
        return self.enabled and not self.validation_errors()

    def validation_errors(self) -> list[str]:
        if not self.enabled:
            return ["已要求邮箱验证，但邮件服务未启用。"] if self.required else []
        errors = []
        if not self.host:
            errors.append("SMTP 主机不能为空。")
        if self.port != 465:
            errors.append("SMTP 端口必须为 465。")
        if self.security != "ssl":
            errors.append("SMTP 安全模式必须为 ssl。")
        if not self.username:
            errors.append("SMTP 用户名不能为空。")
        if not self.password:
            errors.append("SMTP 授权码不能为空。")
        if not self.from_address or self.from_address != self.username:
            errors.append("发件地址必须与 SMTP 用户名一致。")
        if not self.reply_to:
            errors.append("回复地址不能为空。")
        if len(self.code_secret.encode("utf-8")) < 32:
            errors.append("邮箱验证码密钥至少需要 32 字节。")
        if self.code_secret and hmac.compare_digest(self.code_secret, self.password):
            errors.append("邮箱验证码密钥不能与 SMTP 授权码相同。")
        for value in (self.host, self.username, self.from_address, self.from_name, self.reply_to):
            if "\r" in value or "\n" in value:
                errors.append("SMTP 配置不能包含换行符。")
                break
        return errors


def _env_enabled(value: str) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def load_email_config() -> EmailConfig:
    raw_port = os.environ.get("MY_SCHOLAR_SMTP_PORT", "465").strip()
    try:
        port = int(raw_port)
    except ValueError:
        port = 0
    username = os.environ.get("MY_SCHOLAR_SMTP_USERNAME", "guzilab_notify@163.com").strip()
    return EmailConfig(
        enabled=_env_enabled(os.environ.get("MY_SCHOLAR_EMAIL_ENABLED", "")),
        required=_env_enabled(os.environ.get("MY_SCHOLAR_REQUIRE_EMAIL_AUTH", "")),
        host=os.environ.get("MY_SCHOLAR_SMTP_HOST", "smtp.163.com").strip(),
        port=port,
        security=os.environ.get("MY_SCHOLAR_SMTP_SECURITY", "ssl").strip().lower(),
        username=username,
        password=os.environ.get("MY_SCHOLAR_SMTP_PASSWORD", "").strip(),
        from_address=os.environ.get("MY_SCHOLAR_SMTP_FROM", username).strip(),
        from_name=os.environ.get("MY_SCHOLAR_SMTP_FROM_NAME", "谷子学术").strip(),
        reply_to=os.environ.get("MY_SCHOLAR_SMTP_REPLY_TO", "guzilab@163.com").strip(),
        code_secret=os.environ.get("MY_SCHOLAR_EMAIL_CODE_SECRET", "").strip(),
    )


def email_preflight(config: Optional[EmailConfig] = None) -> Dict[str, Any]:
    current = config or load_email_config()
    errors = current.validation_errors()
    if errors:
        raise AccountError(" ".join(errors))
    result: Dict[str, Any] = {
        "ok": True,
        "email_enabled": current.enabled,
        "email_auth_required": current.required,
        "email_auth_available": current.available,
    }
    if current.enabled:
        result.update({
            "smtp_host": current.host,
            "smtp_port": current.port,
            "smtp_security": current.security,
            "smtp_username": current.username,
            "smtp_from": current.from_address,
            "smtp_from_name": current.from_name,
            "smtp_reply_to": current.reply_to,
        })
    return result


class AccountStore:
    """SQLite-backed accounts with a single guarded connection."""

    def __init__(self, path: str, email_config: Optional[EmailConfig] = None) -> None:
        self._lock = threading.Lock()
        self._closed = False
        self._email_config = email_config or load_email_config()
        errors = self._email_config.validation_errors()
        if errors:
            raise AccountError(" ".join(errors))
        self._dummy_password_salt = hashlib.sha256(b"guzi-scholar-login-timing-salt").digest()[:16]
        self._dummy_password_hash = _hash_password("not-a-real-account-password", self._dummy_password_salt)
        self._connection = sqlite3.connect(path, timeout=5.0, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute("PRAGMA busy_timeout = 5000")
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._migrate()

    def __enter__(self) -> "AccountStore":
        return self

    def __exit__(self, _exc_type: Any, _exc: Any, _traceback: Any) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._connection.close()
                self._closed = True

    def _migrate(self) -> None:
        self._connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        applied = {
            int(row["version"])
            for row in self._connection.execute("SELECT version FROM schema_migrations")
        }

        migrations = (
            (1, self._migration_accounts),
            (2, self._migration_profiles),
            (3, self._migration_invites_and_recovery),
            (4, self._migration_ai_usage),
            (5, self._migration_ai_input_units),
            (6, self._migration_email_auth),
        )
        for version, migration in migrations:
            if version in applied:
                continue
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                migration()
                self._connection.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                    (version, utc_now()),
                )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

    def _migration_accounts(self) -> None:
        self._connection.execute(
            """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password_hash BLOB NOT NULL,
                    salt BLOB NOT NULL,
                    member INTEGER NOT NULL DEFAULT 0,
                    quota_bytes INTEGER NOT NULL,
                    used_bytes INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
                """
        )
        self._connection.execute(
            """
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    expires_at REAL NOT NULL
                )
                """
        )

    def _migration_profiles(self) -> None:
        existing = {row["name"] for row in self._connection.execute("PRAGMA table_info(users)")}
        for column in ("nickname", "avatar"):
            if column not in existing:
                self._connection.execute(f"ALTER TABLE users ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")

    def _migration_invites_and_recovery(self) -> None:
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS invites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code_hash TEXT NOT NULL UNIQUE,
                max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses > 0),
                use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
                created_at TEXT NOT NULL,
                expires_at REAL NOT NULL,
                revoked_at TEXT
            )
            """
        )
        existing = {row["name"] for row in self._connection.execute("PRAGMA table_info(users)")}
        columns = {
            "recovery_code_hash": "TEXT NOT NULL DEFAULT ''",
            "terms_version": "TEXT NOT NULL DEFAULT ''",
            "privacy_version": "TEXT NOT NULL DEFAULT ''",
            "agreements_accepted_at": "TEXT NOT NULL DEFAULT ''",
            "invite_id": "INTEGER REFERENCES invites(id)",
        }
        for column, definition in columns.items():
            if column not in existing:
                self._connection.execute(f"ALTER TABLE users ADD COLUMN {column} {definition}")

    def _migration_ai_usage(self) -> None:
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS ai_usage_daily (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                usage_date TEXT NOT NULL,
                service TEXT NOT NULL,
                request_count INTEGER NOT NULL DEFAULT 0 CHECK(request_count >= 0),
                PRIMARY KEY (user_id, usage_date, service)
            )
            """
        )

    def _migration_ai_input_units(self) -> None:
        existing = {row["name"] for row in self._connection.execute("PRAGMA table_info(ai_usage_daily)")}
        if "input_units" not in existing:
            self._connection.execute(
                "ALTER TABLE ai_usage_daily ADD COLUMN input_units INTEGER NOT NULL DEFAULT 0 CHECK(input_units >= 0)"
            )

    def _migration_email_auth(self) -> None:
        existing = {row["name"] for row in self._connection.execute("PRAGMA table_info(users)")}
        if "email" not in existing:
            self._connection.execute("ALTER TABLE users ADD COLUMN email TEXT")
        if "email_verified_at" not in existing:
            self._connection.execute("ALTER TABLE users ADD COLUMN email_verified_at TEXT NOT NULL DEFAULT ''")
        self._connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email)"
            " WHERE email IS NOT NULL AND email <> ''"
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS email_challenges (
                id TEXT PRIMARY KEY,
                purpose TEXT NOT NULL CHECK(purpose IN ('register', 'reset', 'bind')),
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                invite_code_hash TEXT NOT NULL DEFAULT '',
                attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL,
                consumed_at REAL
            )
            """
        )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS email_challenges_lookup"
            " ON email_challenges(purpose, email, expires_at)"
        )
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS mail_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL CHECK(kind IN ('register_code', 'reset_code', 'bind_code', 'password_reset_notice')),
                recipient TEXT NOT NULL,
                challenge_id TEXT REFERENCES email_challenges(id) ON DELETE SET NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'sent', 'failed')),
                attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
                available_at REAL NOT NULL,
                claimed_at REAL,
                created_at REAL NOT NULL,
                sent_at REAL,
                last_error TEXT NOT NULL DEFAULT ''
            )
            """
        )
        self._connection.execute(
            "CREATE INDEX IF NOT EXISTS mail_outbox_pending"
            " ON mail_outbox(status, available_at, id)"
        )

    @staticmethod
    def _validate_registration(username: str, password: str) -> None:
        if not USERNAME_RE.fullmatch(username or ""):
            raise AccountError("用户名需为 3-32 位字母、数字或 _ . -。")
        AccountStore._validate_password(password)

    @staticmethod
    def _validate_password(password: str) -> None:
        if len(password or "") < MIN_PASSWORD_LENGTH:
            raise AccountError(f"密码至少 {MIN_PASSWORD_LENGTH} 位。")
        if len(password) > MAX_PASSWORD_LENGTH:
            raise AccountError(f"密码最长 {MAX_PASSWORD_LENGTH} 位。")

    @staticmethod
    def normalize_email(email: str) -> str:
        value = str(email or "").strip().casefold()
        if len(value) > 254 or not EMAIL_RE.fullmatch(value):
            raise AccountError("请输入有效的邮箱地址。")
        try:
            value.encode("ascii")
        except UnicodeEncodeError as exc:
            raise AccountError("邮箱地址暂不支持非 ASCII 字符。") from exc
        return value

    @property
    def email_auth_available(self) -> bool:
        return self._email_config.available

    def _require_email_auth(self) -> None:
        if not self.email_auth_available:
            raise AccountError("邮箱验证服务暂不可用。", HTTPStatus.SERVICE_UNAVAILABLE)

    def _derive_email_code(self, challenge_id: str, purpose: str, email: str) -> str:
        payload = f"my-scholar-email-v1\0{challenge_id}\0{purpose}\0{email}".encode("utf-8")
        digest = hmac.new(self._email_config.code_secret.encode("utf-8"), payload, hashlib.sha256).digest()
        value = int.from_bytes(digest, "big") % (10 ** EMAIL_CODE_DIGITS)
        return f"{value:0{EMAIL_CODE_DIGITS}d}"

    def request_email_code(
        self,
        purpose: str,
        email: str,
        invite_code: str = "",
        token: str = "",
    ) -> Dict[str, Any]:
        self._require_email_auth()
        name = str(purpose or "").strip().lower()
        if name not in {"register", "reset", "bind"}:
            raise AccountError("邮箱验证码用途无效。")
        normalized = self.normalize_email(email)
        invite_hash = ""
        user_id: Optional[int] = None
        should_send = True

        if name == "register":
            invite_hash = _token_hash(str(invite_code or "").strip())
            with self._lock:
                invite = self._connection.execute(
                    "SELECT * FROM invites WHERE code_hash = ?",
                    (invite_hash,),
                ).fetchone()
            if not self._invite_available(invite, time.time()):
                raise AccountError("邀请码无效或已失效。", HTTPStatus.FORBIDDEN)
        elif name == "bind":
            user = self.authenticate(token)
            if str(user["email"] or ""):
                raise AccountError("当前账号已绑定邮箱，暂不支持换绑。", HTTPStatus.CONFLICT)
            user_id = int(user["id"])
        else:
            with self._lock:
                user = self._connection.execute(
                    "SELECT id FROM users WHERE email = ?",
                    (normalized,),
                ).fetchone()
            user_id = int(user["id"]) if user is not None else None
            should_send = user is not None

        challenge_id = secrets.token_urlsafe(24)
        now = time.time()
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                if name == "bind":
                    current = self._connection.execute(
                        "SELECT email FROM users WHERE id = ?", (user_id,)
                    ).fetchone()
                    if current is None:
                        raise AccountError("登录已过期，请重新登录。", HTTPStatus.UNAUTHORIZED)
                    if str(current["email"] or ""):
                        raise AccountError("当前账号已绑定邮箱，暂不支持换绑。", HTTPStatus.CONFLICT)
                    self._connection.execute(
                        "UPDATE email_challenges SET consumed_at = ?"
                        " WHERE purpose = ? AND user_id = ? AND consumed_at IS NULL",
                        (now, name, user_id),
                    )
                else:
                    self._connection.execute(
                        "UPDATE email_challenges SET consumed_at = ?"
                        " WHERE purpose = ? AND email = ? AND consumed_at IS NULL",
                        (now, name, normalized),
                    )
                self._cleanup_email_records_locked(now)
                self._connection.execute(
                    "INSERT INTO email_challenges"
                    " (id, purpose, user_id, email, invite_code_hash, created_at, expires_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        challenge_id,
                        name,
                        user_id,
                        normalized,
                        invite_hash,
                        now,
                        now + EMAIL_CODE_TTL_SECONDS,
                    ),
                )
                if should_send:
                    self._enqueue_mail_locked(
                        f"{name}_code",
                        normalized,
                        challenge_id=challenge_id,
                        now=now,
                    )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

        message = EMAIL_RESET_REQUEST_MESSAGE if name == "reset" else EMAIL_REQUEST_MESSAGE
        return {
            "ok": True,
            "challenge_id": challenge_id,
            "expires_in": EMAIL_CODE_TTL_SECONDS,
            "message": message,
        }

    def _enqueue_mail_locked(
        self,
        kind: str,
        recipient: str,
        challenge_id: Optional[str] = None,
        now: Optional[float] = None,
    ) -> None:
        timestamp = time.time() if now is None else now
        self._connection.execute(
            "INSERT INTO mail_outbox"
            " (kind, recipient, challenge_id, available_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (kind, recipient, challenge_id, timestamp, timestamp),
        )

    def _cleanup_email_records_locked(self, now: float) -> None:
        self._connection.execute(
            "UPDATE mail_outbox SET status = 'failed', claimed_at = NULL,"
            " last_error = 'StaleEmailChallenge'"
            " WHERE status = 'pending' AND kind IN ('register_code', 'reset_code', 'bind_code')"
            " AND (challenge_id IS NULL OR NOT EXISTS ("
            " SELECT 1 FROM email_challenges"
            " WHERE email_challenges.id = mail_outbox.challenge_id"
            " AND email_challenges.consumed_at IS NULL"
            " AND email_challenges.expires_at > ?"
            " AND email_challenges.attempt_count < ?))",
            (now, EMAIL_CODE_ATTEMPT_LIMIT),
        )
        self._connection.execute(
            "UPDATE mail_outbox SET status = 'failed', claimed_at = NULL,"
            " last_error = 'ExpiredPasswordResetNotice'"
            " WHERE status = 'pending' AND kind = 'password_reset_notice' AND created_at <= ?",
            (now - PASSWORD_RESET_NOTICE_MAX_AGE_SECONDS,),
        )
        self._connection.execute(
            "DELETE FROM mail_outbox WHERE status IN ('sent', 'failed')"
            " AND COALESCE(sent_at, created_at) < ?",
            (now - OUTBOX_RETENTION_SECONDS,),
        )
        self._connection.execute(
            "DELETE FROM email_challenges"
            " WHERE created_at < ? AND (consumed_at IS NOT NULL OR expires_at <= ?)",
            (now - EMAIL_CHALLENGE_RETENTION_SECONDS, now),
        )

    def _challenge_matches(
        self,
        row: Optional[sqlite3.Row],
        code: str,
        purpose: str,
        email: Optional[str] = None,
        user_id: Optional[int] = None,
        invite_code_hash: Optional[str] = None,
    ) -> bool:
        if row is None:
            expected = self._derive_email_code("missing", purpose, email or "missing@example.invalid")
            hmac.compare_digest(expected, str(code or ""))
            return False
        expected = self._derive_email_code(str(row["id"]), str(row["purpose"]), str(row["email"]))
        code_matches = hmac.compare_digest(expected, str(code or ""))
        metadata_matches = (
            row["purpose"] == purpose
            and row["consumed_at"] is None
            and float(row["expires_at"]) > time.time()
            and int(row["attempt_count"]) < EMAIL_CODE_ATTEMPT_LIMIT
        )
        if email is not None:
            metadata_matches = metadata_matches and row["email"] == email
        if user_id is not None:
            metadata_matches = metadata_matches and row["user_id"] == user_id
        if invite_code_hash is not None:
            metadata_matches = metadata_matches and row["invite_code_hash"] == invite_code_hash
        return bool(code_matches and metadata_matches)

    def _verify_email_challenge(
        self,
        challenge_id: str,
        code: str,
        purpose: str,
        email: Optional[str] = None,
        user_id: Optional[int] = None,
        invite_code_hash: Optional[str] = None,
    ) -> None:
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                row = self._connection.execute(
                    "SELECT * FROM email_challenges WHERE id = ?",
                    (str(challenge_id or ""),),
                ).fetchone()
                if self._challenge_matches(row, code, purpose, email, user_id, invite_code_hash):
                    self._connection.commit()
                    return
                if (
                    row is not None
                    and row["consumed_at"] is None
                    and float(row["expires_at"]) > time.time()
                    and int(row["attempt_count"]) < EMAIL_CODE_ATTEMPT_LIMIT
                ):
                    self._connection.execute(
                        "UPDATE email_challenges SET attempt_count = attempt_count + 1 WHERE id = ?",
                        (row["id"],),
                    )
                self._cleanup_email_records_locked(time.time())
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        raise AccountError("验证码无效或已过期。", HTTPStatus.UNAUTHORIZED)

    @staticmethod
    def _validate_agreements(terms_version: str, privacy_version: str) -> None:
        if terms_version != TERMS_VERSION or privacy_version != PRIVACY_VERSION:
            raise AccountError("请阅读并同意当前版本的免费内测用户协议和隐私政策。")

    def register(
        self,
        username: str,
        password: str,
        invite_code: str,
        terms_version: str,
        privacy_version: str,
        email: str = "",
        email_challenge_id: str = "",
        email_code: str = "",
    ) -> Dict[str, Any]:
        self._validate_registration(username, password)
        self._validate_agreements(terms_version, privacy_version)
        if not invite_code:
            raise AccountError("邀请码无效或已失效。", HTTPStatus.FORBIDDEN)
        invite_hash = _token_hash(invite_code)
        with self._lock:
            preliminary_invite = self._connection.execute(
                "SELECT * FROM invites WHERE code_hash = ?",
                (invite_hash,),
            ).fetchone()
        if not self._invite_available(preliminary_invite, time.time()):
            raise AccountError("邀请码无效或已失效。", HTTPStatus.FORBIDDEN)
        use_email = bool(email or email_challenge_id or email_code or self._email_config.required)
        normalized_email: Optional[str] = None
        if use_email:
            self._require_email_auth()
            normalized_email = self.normalize_email(email)
            self._verify_email_challenge(
                email_challenge_id,
                email_code,
                "register",
                email=normalized_email,
                invite_code_hash=invite_hash,
            )
        salt = secrets.token_bytes(16)
        digest = _hash_password(password, salt)
        token = secrets.token_urlsafe(32)
        recovery_code = secrets.token_urlsafe(32)
        accepted_at = utc_now()
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                now = time.time()
                invite = self._connection.execute(
                    "SELECT * FROM invites WHERE code_hash = ?",
                    (invite_hash,),
                ).fetchone()
                if not self._invite_available(invite, now):
                    raise AccountError("邀请码无效或已失效。", HTTPStatus.FORBIDDEN)
                challenge = None
                if normalized_email is not None:
                    challenge = self._connection.execute(
                        "SELECT * FROM email_challenges WHERE id = ?",
                        (email_challenge_id,),
                    ).fetchone()
                    if not self._challenge_matches(
                        challenge,
                        email_code,
                        "register",
                        normalized_email,
                        invite_code_hash=invite_hash,
                    ):
                        raise AccountError("验证码无效或已过期。", HTTPStatus.UNAUTHORIZED)
                try:
                    cursor = self._connection.execute(
                        "INSERT INTO users (username, password_hash, salt, member, quota_bytes, created_at,"
                        " recovery_code_hash, terms_version, privacy_version, agreements_accepted_at, invite_id,"
                        " email, email_verified_at)"
                        " VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            username,
                            digest,
                            salt,
                            DEFAULT_QUOTA_BYTES,
                            accepted_at,
                            _token_hash(recovery_code),
                            terms_version,
                            privacy_version,
                            accepted_at,
                            invite["id"],
                            normalized_email,
                            accepted_at if normalized_email is not None else "",
                        ),
                    )
                except sqlite3.IntegrityError as exc:
                    raise AccountError("用户名或邮箱已被注册。", HTTPStatus.CONFLICT) from exc
                updated = self._connection.execute(
                    "UPDATE invites SET use_count = use_count + 1"
                    " WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND use_count < max_uses",
                    (invite["id"], now),
                )
                if updated.rowcount != 1:
                    raise AccountError("邀请码无效或已失效。", HTTPStatus.FORBIDDEN)
                if challenge is not None:
                    self._connection.execute(
                        "UPDATE email_challenges SET consumed_at = ? WHERE id = ?",
                        (now, challenge["id"]),
                    )
                    self._cleanup_email_records_locked(now)
                self._connection.execute(
                    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                    (_token_hash(token), cursor.lastrowid, accepted_at, now + TOKEN_TTL_SECONDS),
                )
                row = self._connection.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
                self._connection.commit()
            except AccountError:
                self._connection.rollback()
                raise
            except Exception:
                self._connection.rollback()
                raise
        return {"token": token, "profile": self._profile(row), "recovery_code": recovery_code}

    @staticmethod
    def _invite_available(invite: Optional[sqlite3.Row], now: float) -> bool:
        return bool(
            invite is not None
            and invite["revoked_at"] is None
            and float(invite["expires_at"]) > now
            and int(invite["use_count"]) < int(invite["max_uses"])
        )

    def login(
        self,
        username: str,
        password: str,
        terms_version: str = "",
        privacy_version: str = "",
    ) -> Dict[str, Any]:
        identifier = str(username or "").strip()
        email_identifier = identifier.casefold() if "@" in identifier else ""
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1",
                (identifier, email_identifier),
            ).fetchone()
        if len(password or "") > MAX_PASSWORD_LENGTH:
            raise AccountError("用户名或密码错误。", HTTPStatus.UNAUTHORIZED)
        if row is None:
            digest = _hash_password(password or "", self._dummy_password_salt)
            hmac.compare_digest(digest, self._dummy_password_hash)
            raise AccountError("用户名或密码错误。", HTTPStatus.UNAUTHORIZED)
        verified_salt = bytes(row["salt"])
        verified_password_hash = bytes(row["password_hash"])
        digest = _hash_password(password or "", verified_salt)
        if not hmac.compare_digest(digest, verified_password_hash):
            raise AccountError("用户名或密码错误。", HTTPStatus.UNAUTHORIZED)

        token = secrets.token_urlsafe(32)
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                row = self._connection.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
                if (
                    row is None
                    or not hmac.compare_digest(bytes(row["salt"]), verified_salt)
                    or not hmac.compare_digest(bytes(row["password_hash"]), verified_password_hash)
                ):
                    raise AccountError("用户名或密码错误。", HTTPStatus.UNAUTHORIZED)
                if not self._agreements_current(row):
                    self._validate_agreements(terms_version, privacy_version)
                    accepted_at = utc_now()
                    self._connection.execute(
                        "UPDATE users SET terms_version = ?, privacy_version = ?, agreements_accepted_at = ?"
                        " WHERE id = ?",
                        (terms_version, privacy_version, accepted_at, row["id"]),
                    )
                    row = self._connection.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
                now = time.time()
                self._connection.execute(
                    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                    (_token_hash(token), row["id"], utc_now(), now + TOKEN_TTL_SECONDS),
                )
                self._connection.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
                self._connection.commit()
            except AccountError:
                self._connection.rollback()
                raise
            except Exception:
                self._connection.rollback()
                raise
        return {"token": token, "profile": self._profile(row)}

    def reset_password(self, username: str, recovery_code: str, new_password: str) -> Dict[str, Any]:
        self._validate_registration(username, new_password)
        provided_hash = _token_hash(recovery_code or "")
        with self._lock:
            preliminary_row = self._connection.execute(
                "SELECT id, recovery_code_hash FROM users WHERE username = ?",
                (username,),
            ).fetchone()
        if (
            preliminary_row is None
            or not preliminary_row["recovery_code_hash"]
            or not hmac.compare_digest(provided_hash, str(preliminary_row["recovery_code_hash"]))
        ):
            raise AccountError("用户名或恢复码错误。", HTTPStatus.UNAUTHORIZED)
        salt = secrets.token_bytes(16)
        digest = _hash_password(new_password, salt)
        next_recovery_code = secrets.token_urlsafe(32)
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                row = self._connection.execute(
                    "SELECT id, recovery_code_hash FROM users WHERE username = ?",
                    (username,),
                ).fetchone()
                if (
                    row is None
                    or not row["recovery_code_hash"]
                    or not hmac.compare_digest(provided_hash, str(row["recovery_code_hash"]))
                ):
                    raise AccountError("用户名或恢复码错误。", HTTPStatus.UNAUTHORIZED)
                self._connection.execute(
                    "UPDATE users SET password_hash = ?, salt = ?, recovery_code_hash = ? WHERE id = ?",
                    (digest, salt, _token_hash(next_recovery_code), row["id"]),
                )
                self._connection.execute("DELETE FROM sessions WHERE user_id = ?", (row["id"],))
                self._connection.commit()
            except AccountError:
                self._connection.rollback()
                raise
            except Exception:
                self._connection.rollback()
                raise
        return {"recovery_code": next_recovery_code}

    def reset_password_email(self, challenge_id: str, email_code: str, new_password: str) -> Dict[str, Any]:
        self._require_email_auth()
        self._validate_password(new_password)
        self._verify_email_challenge(challenge_id, email_code, "reset")
        with self._lock:
            preliminary = self._connection.execute(
                "SELECT user_id, email FROM email_challenges WHERE id = ?",
                (str(challenge_id or ""),),
            ).fetchone()
        if preliminary is None or preliminary["user_id"] is None:
            raise AccountError("验证码无效或已过期。", HTTPStatus.UNAUTHORIZED)

        salt = secrets.token_bytes(16)
        digest = _hash_password(new_password, salt)
        next_recovery_code = secrets.token_urlsafe(32)
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                challenge = self._connection.execute(
                    "SELECT * FROM email_challenges WHERE id = ?",
                    (challenge_id,),
                ).fetchone()
                if not self._challenge_matches(challenge, email_code, "reset") or challenge["user_id"] is None:
                    raise AccountError("验证码无效或已过期。", HTTPStatus.UNAUTHORIZED)
                user = self._connection.execute(
                    "SELECT id, email FROM users WHERE id = ? AND email = ?",
                    (challenge["user_id"], challenge["email"]),
                ).fetchone()
                if user is None:
                    raise AccountError("验证码无效或已过期。", HTTPStatus.UNAUTHORIZED)
                self._connection.execute(
                    "UPDATE users SET password_hash = ?, salt = ?, recovery_code_hash = ? WHERE id = ?",
                    (digest, salt, _token_hash(next_recovery_code), user["id"]),
                )
                self._connection.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
                now = time.time()
                self._connection.execute(
                    "UPDATE email_challenges SET consumed_at = ? WHERE id = ?",
                    (now, challenge["id"]),
                )
                self._enqueue_mail_locked("password_reset_notice", user["email"], now=now)
                self._cleanup_email_records_locked(now)
                self._connection.commit()
            except AccountError:
                self._connection.rollback()
                raise
            except Exception:
                self._connection.rollback()
                raise
        return {
            "ok": True,
            "recovery_code": next_recovery_code,
            "message": "密码已重置，请使用新密码重新登录。",
        }

    def bind_email(self, token: str, challenge_id: str, email_code: str) -> Dict[str, Any]:
        self._require_email_auth()
        authenticated = self.authenticate(token)
        user_id = int(authenticated["id"])
        self._verify_email_challenge(challenge_id, email_code, "bind", user_id=user_id)
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                current = self._connection.execute(
                    "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id"
                    " WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
                    (_token_hash(token or ""), time.time()),
                ).fetchone()
                challenge = self._connection.execute(
                    "SELECT * FROM email_challenges WHERE id = ?",
                    (challenge_id,),
                ).fetchone()
                if current is None or int(current["id"]) != user_id or not self._challenge_matches(
                    challenge,
                    email_code,
                    "bind",
                    user_id=user_id,
                ):
                    raise AccountError("验证码无效或已过期。", HTTPStatus.UNAUTHORIZED)
                if str(current["email"] or ""):
                    raise AccountError("当前账号已绑定邮箱，暂不支持换绑。", HTTPStatus.CONFLICT)
                try:
                    updated = self._connection.execute(
                        "UPDATE users SET email = ?, email_verified_at = ?"
                        " WHERE id = ? AND (email IS NULL OR email = '')",
                        (challenge["email"], utc_now(), user_id),
                    )
                except sqlite3.IntegrityError as exc:
                    raise AccountError("该邮箱已绑定其他账号。", HTTPStatus.CONFLICT) from exc
                if updated.rowcount != 1:
                    raise AccountError("当前账号已绑定邮箱，暂不支持换绑。", HTTPStatus.CONFLICT)
                self._connection.execute(
                    "UPDATE email_challenges SET consumed_at = ? WHERE id = ?",
                    (time.time(), challenge["id"]),
                )
                self._cleanup_email_records_locked(time.time())
                fresh = self._connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                self._connection.commit()
            except AccountError:
                self._connection.rollback()
                raise
            except Exception:
                self._connection.rollback()
                raise
        return {"ok": True, "profile": self._profile(fresh)}

    def claim_next_mail(self, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
        timestamp = time.time() if now is None else now
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                self._connection.execute(
                    "UPDATE mail_outbox SET status = 'pending', claimed_at = NULL, available_at = ?"
                    " WHERE status = 'sending' AND claimed_at < ?",
                    (timestamp, timestamp - OUTBOX_CLAIM_TIMEOUT),
                )
                self._cleanup_email_records_locked(timestamp)
                row = self._connection.execute(
                    "SELECT id FROM mail_outbox"
                    " WHERE status = 'pending' AND available_at <= ? ORDER BY id LIMIT 1",
                    (timestamp,),
                ).fetchone()
                if row is None:
                    self._connection.commit()
                    return None
                self._connection.execute(
                    "UPDATE mail_outbox SET status = 'sending', claimed_at = ?,"
                    " attempt_count = attempt_count + 1 WHERE id = ?",
                    (timestamp, row["id"]),
                )
                claimed = self._connection.execute(
                    "SELECT mail_outbox.*, email_challenges.purpose AS challenge_purpose,"
                    " email_challenges.email AS challenge_email,"
                    " email_challenges.expires_at AS challenge_expires_at,"
                    " email_challenges.consumed_at AS challenge_consumed_at,"
                    " email_challenges.attempt_count AS challenge_attempt_count"
                    " FROM mail_outbox LEFT JOIN email_challenges"
                    " ON email_challenges.id = mail_outbox.challenge_id"
                    " WHERE mail_outbox.id = ?",
                    (row["id"],),
                ).fetchone()
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return dict(claimed)

    def mail_is_sendable(self, outbox_id: int, now: Optional[float] = None) -> bool:
        timestamp = time.time() if now is None else now
        with self._lock:
            row = self._connection.execute(
                "SELECT mail_outbox.status, mail_outbox.kind, mail_outbox.recipient,"
                " mail_outbox.challenge_id, mail_outbox.created_at,"
                " email_challenges.purpose AS challenge_purpose,"
                " email_challenges.email AS challenge_email,"
                " email_challenges.expires_at AS challenge_expires_at,"
                " email_challenges.consumed_at AS challenge_consumed_at,"
                " email_challenges.attempt_count AS challenge_attempt_count"
                " FROM mail_outbox LEFT JOIN email_challenges"
                " ON email_challenges.id = mail_outbox.challenge_id"
                " WHERE mail_outbox.id = ?",
                (int(outbox_id),),
            ).fetchone()
        if row is None or row["status"] != "sending":
            return False
        if row["kind"] == "password_reset_notice":
            return float(row["created_at"]) > timestamp - PASSWORD_RESET_NOTICE_MAX_AGE_SECONDS
        purposes = {
            "register_code": "register",
            "reset_code": "reset",
            "bind_code": "bind",
        }
        expected_purpose = purposes.get(str(row["kind"]))
        return bool(
            expected_purpose
            and row["challenge_id"]
            and row["challenge_purpose"] == expected_purpose
            and row["challenge_email"] == row["recipient"]
            and row["challenge_consumed_at"] is None
            and row["challenge_expires_at"] is not None
            and float(row["challenge_expires_at"]) > timestamp
            and row["challenge_attempt_count"] is not None
            and int(row["challenge_attempt_count"]) < EMAIL_CODE_ATTEMPT_LIMIT
        )

    def mark_mail_sent(self, outbox_id: int) -> None:
        with self._lock:
            self._connection.execute(
                "UPDATE mail_outbox SET status = 'sent', sent_at = ?, claimed_at = NULL, last_error = ''"
                " WHERE id = ? AND status = 'sending'",
                (time.time(), int(outbox_id)),
            )
            self._connection.commit()

    def mark_mail_cancelled(self, outbox_id: int) -> None:
        with self._lock:
            self._connection.execute(
                "UPDATE mail_outbox SET status = 'failed', claimed_at = NULL,"
                " last_error = 'StaleEmailChallenge' WHERE id = ? AND status = 'sending'",
                (int(outbox_id),),
            )
            self._connection.commit()

    def mark_mail_failed(self, outbox_id: int, error_name: str) -> None:
        with self._lock:
            row = self._connection.execute(
                "SELECT attempt_count FROM mail_outbox WHERE id = ? AND status = 'sending'",
                (int(outbox_id),),
            ).fetchone()
            if row is None:
                return
            attempts = int(row["attempt_count"])
            status = "failed" if attempts >= OUTBOX_MAX_ATTEMPTS else "pending"
            retry_at = time.time() + min(60, 2 ** attempts)
            self._connection.execute(
                "UPDATE mail_outbox SET status = ?, available_at = ?, claimed_at = NULL, last_error = ?"
                " WHERE id = ?",
                (status, retry_at, str(error_name or "MailDeliveryError")[:120], int(outbox_id)),
            )
            self._connection.commit()

    def reserve_ai_request(
        self,
        user_id: int,
        service: str,
        daily_limit: int,
        input_units: int,
        daily_unit_limit: int,
    ) -> Dict[str, Any]:
        name = str(service or "").strip().lower()
        if name not in {"translation", "chat"}:
            raise AccountError("AI 服务类型无效。")
        try:
            limit = int(daily_limit)
            units = int(input_units)
            unit_limit = int(daily_unit_limit)
        except (TypeError, ValueError) as exc:
            raise AccountError("AI 每日额度配置无效。") from exc
        if limit < 1 or units < 1 or unit_limit < 1 or units > unit_limit:
            raise AccountError("AI 每日额度配置无效。")
        usage_date = time.strftime("%Y-%m-%d", time.gmtime())
        with self._lock:
            try:
                self._connection.execute("BEGIN IMMEDIATE")
                cursor = self._connection.execute(
                    "INSERT INTO ai_usage_daily (user_id, usage_date, service, request_count, input_units)"
                    " VALUES (?, ?, ?, 1, ?)"
                    " ON CONFLICT(user_id, usage_date, service) DO UPDATE"
                    " SET request_count = request_count + 1, input_units = input_units + excluded.input_units"
                    " WHERE request_count < ? AND input_units + excluded.input_units <= ?",
                    (int(user_id), usage_date, name, units, limit, unit_limit),
                )
                if cursor.rowcount != 1:
                    raise AccountError("今日 AI 免费内测额度已用完，请明天再试。", HTTPStatus.TOO_MANY_REQUESTS)
                row = self._connection.execute(
                    "SELECT request_count, input_units FROM ai_usage_daily"
                    " WHERE user_id = ? AND usage_date = ? AND service = ?",
                    (int(user_id), usage_date, name),
                ).fetchone()
                self._connection.commit()
            except AccountError:
                self._connection.rollback()
                raise
            except Exception:
                self._connection.rollback()
                raise
        return {
            "usage_date": usage_date,
            "service": name,
            "request_count": int(row["request_count"]),
            "daily_limit": limit,
            "input_units": int(row["input_units"]),
            "daily_unit_limit": unit_limit,
        }

    def refund_ai_request(self, user_id: int, service: str, input_units: int) -> None:
        name = str(service or "").strip().lower()
        units = max(0, int(input_units))
        usage_date = time.strftime("%Y-%m-%d", time.gmtime())
        with self._lock:
            self._connection.execute(
                "UPDATE ai_usage_daily SET request_count = MAX(0, request_count - 1),"
                " input_units = MAX(0, input_units - ?)"
                " WHERE user_id = ? AND usage_date = ? AND service = ?",
                (units, int(user_id), usage_date, name),
            )
            self._connection.execute(
                "DELETE FROM ai_usage_daily WHERE user_id = ? AND usage_date = ? AND service = ?"
                " AND request_count = 0 AND input_units = 0",
                (int(user_id), usage_date, name),
            )
            self._connection.commit()

    def logout(self, token: str) -> None:
        with self._lock:
            self._connection.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token or ""),))
            self._connection.commit()

    def authenticate(self, token: str) -> sqlite3.Row:
        with self._lock:
            row = self._connection.execute(
                "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id"
                " WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
                (_token_hash(token or ""), time.time()),
            ).fetchone()
        if row is None:
            raise AccountError("登录已过期，请重新登录。", HTTPStatus.UNAUTHORIZED)
        return row

    def profile(self, token: str) -> Dict[str, Any]:
        return self._profile(self.authenticate(token))

    def report_usage(self, token: str, used_bytes: Any) -> Dict[str, Any]:
        row = self.authenticate(token)
        try:
            value = max(0, int(used_bytes))
        except (TypeError, ValueError):
            raise AccountError("used_bytes 必须是整数。") from None
        with self._lock:
            self._connection.execute("UPDATE users SET used_bytes = ? WHERE id = ?", (value, row["id"]))
            self._connection.commit()
            fresh = self._connection.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
        return self._profile(fresh)

    def update_profile(self, token: str, nickname: Any = None, avatar: Any = None) -> Dict[str, Any]:
        row = self.authenticate(token)
        updates: Dict[str, str] = {}
        if nickname is not None:
            value = str(nickname).strip()
            if len(value) > MAX_NICKNAME_LENGTH:
                raise AccountError(f"昵称最长 {MAX_NICKNAME_LENGTH} 个字符。")
            updates["nickname"] = value
        if avatar is not None:
            value = str(avatar).strip()
            if value and (len(value) > MAX_AVATAR_CHARS or not AVATAR_RE.fullmatch(value)):
                raise AccountError("头像需为 100KB 以内的 PNG/JPEG/WebP 图片。")
            updates["avatar"] = value
        with self._lock:
            for key, value in updates.items():
                self._connection.execute(f"UPDATE users SET {key} = ? WHERE id = ?", (value, row["id"]))
            self._connection.commit()
            fresh = self._connection.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
        return self._profile(fresh)

    @staticmethod
    def _profile(row: sqlite3.Row) -> Dict[str, Any]:
        agreements_current = AccountStore._agreements_current(row)
        keys = set(row.keys())
        email = str(row["email"] or "") if "email" in keys else ""
        return {
            "username": row["username"],
            "email": email,
            "email_verified": bool(email and row["email_verified_at"]) if "email_verified_at" in keys else False,
            "nickname": str(row["nickname"] or ""),
            "avatar": str(row["avatar"] or ""),
            "member": bool(row["member"]),
            "beta_access": AccountStore.has_beta_access(row),
            "agreements_current": agreements_current,
            "quota_bytes": int(row["quota_bytes"]),
            "used_bytes": int(row["used_bytes"]),
            "created_at": row["created_at"],
        }

    @staticmethod
    def _agreements_current(row: sqlite3.Row) -> bool:
        keys = set(row.keys())
        return bool(
            "terms_version" in keys
            and "privacy_version" in keys
            and row["terms_version"] == TERMS_VERSION
            and row["privacy_version"] == PRIVACY_VERSION
        )

    @staticmethod
    def has_beta_access(row: sqlite3.Row) -> bool:
        return bool(row["member"]) and AccountStore._agreements_current(row)

    # Operator commands (local CLI on the account host; not exposed over HTTP).
    def admin_list(self) -> list:
        with self._lock:
            rows = self._connection.execute("SELECT * FROM users ORDER BY id").fetchall()
        return [self._profile(row) for row in rows]

    def admin_update(self, username: str, **fields: Any) -> Dict[str, Any]:
        allowed = {key: value for key, value in fields.items() if key in {"member", "quota_bytes"}}
        with self._lock:
            row = self._connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
            if row is None:
                raise AccountError("用户不存在。", HTTPStatus.NOT_FOUND)
            for key, value in allowed.items():
                self._connection.execute(f"UPDATE users SET {key} = ? WHERE id = ?", (int(value), row["id"]))
            self._connection.commit()
            fresh = self._connection.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
        return self._profile(fresh)

    def admin_issue_recovery(self, username: str) -> Dict[str, str]:
        recovery_code = secrets.token_urlsafe(32)
        with self._lock:
            cursor = self._connection.execute(
                "UPDATE users SET recovery_code_hash = ? WHERE username = ?",
                (_token_hash(recovery_code), username),
            )
            if cursor.rowcount != 1:
                self._connection.rollback()
                raise AccountError("用户不存在。", HTTPStatus.NOT_FOUND)
            self._connection.commit()
        return {"username": username, "recovery_code": recovery_code}

    def admin_create_invite(self, max_uses: int = 1, valid_days: int = 30) -> Dict[str, Any]:
        try:
            uses = int(max_uses)
            days = int(valid_days)
        except (TypeError, ValueError):
            raise AccountError("邀请码使用次数和有效天数必须是整数。") from None
        if uses < 1 or days < 1:
            raise AccountError("邀请码使用次数和有效天数必须大于零。")
        code = secrets.token_urlsafe(32)
        created_at = utc_now()
        expires_at = time.time() + days * 24 * 3600
        with self._lock:
            cursor = self._connection.execute(
                "INSERT INTO invites (code_hash, max_uses, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (_token_hash(code), uses, created_at, expires_at),
            )
            self._connection.commit()
        return {
            "id": int(cursor.lastrowid),
            "invite_code": code,
            "max_uses": uses,
            "created_at": created_at,
            "expires_at": self._format_timestamp(expires_at),
        }

    def admin_list_invites(self) -> list:
        with self._lock:
            rows = self._connection.execute("SELECT * FROM invites ORDER BY id DESC").fetchall()
        return [self._invite_summary(row) for row in rows]

    def admin_revoke_invite(self, invite_id: Any) -> Dict[str, Any]:
        try:
            value = int(invite_id)
        except (TypeError, ValueError):
            raise AccountError("邀请码 ID 必须是整数。") from None
        with self._lock:
            row = self._connection.execute("SELECT * FROM invites WHERE id = ?", (value,)).fetchone()
            if row is None:
                raise AccountError("邀请码不存在。", HTTPStatus.NOT_FOUND)
            if row["revoked_at"] is None:
                self._connection.execute("UPDATE invites SET revoked_at = ? WHERE id = ?", (utc_now(), value))
                self._connection.commit()
            fresh = self._connection.execute("SELECT * FROM invites WHERE id = ?", (value,)).fetchone()
        return self._invite_summary(fresh)

    @staticmethod
    def _format_timestamp(value: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(value))

    @classmethod
    def _invite_summary(cls, row: sqlite3.Row) -> Dict[str, Any]:
        now = time.time()
        return {
            "id": int(row["id"]),
            "max_uses": int(row["max_uses"]),
            "use_count": int(row["use_count"]),
            "created_at": row["created_at"],
            "expires_at": cls._format_timestamp(float(row["expires_at"])),
            "revoked": row["revoked_at"] is not None,
            "available": (
                row["revoked_at"] is None
                and float(row["expires_at"]) > now
                and int(row["use_count"]) < int(row["max_uses"])
            ),
        }


class RateLimiter:
    def __init__(self, limit: int = LOGIN_ATTEMPT_LIMIT, window: float = LOGIN_ATTEMPT_WINDOW) -> None:
        self.limit = limit
        self.window = window
        self._lock = threading.Lock()
        self._attempts: Dict[str, deque] = {}

    def check(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            queue = self._attempts.setdefault(key, deque())
            while queue and now - queue[0] > self.window:
                queue.popleft()
            if len(queue) >= self.limit:
                raise AccountError("尝试过于频繁，请稍后再试。", HTTPStatus.TOO_MANY_REQUESTS)
            queue.append(now)


class EmailOutboxWorker:
    def __init__(
        self,
        store: AccountStore,
        smtp_factory: Callable[..., Any] = smtplib.SMTP_SSL,
        poll_interval: float = 1.0,
    ) -> None:
        self.store = store
        self.smtp_factory = smtp_factory
        self.poll_interval = poll_interval
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="my-scholar-email-outbox", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self.process_once():
                self._stop.wait(self.poll_interval)

    def process_once(self) -> bool:
        item = self.store.claim_next_mail()
        if item is None:
            return False
        try:
            if not self.store.mail_is_sendable(item["id"]):
                raise StaleEmailChallenge()
            message = self._build_message(item)
            config = self.store._email_config
            context = ssl.create_default_context()
            with self.smtp_factory(
                config.host,
                config.port,
                timeout=10,
                context=context,
            ) as smtp:
                smtp.login(config.username, config.password)
                if not self.store.mail_is_sendable(item["id"]):
                    raise StaleEmailChallenge()
                smtp.send_message(
                    message,
                    from_addr=config.from_address,
                    to_addrs=[item["recipient"]],
                )
        except StaleEmailChallenge:
            self.store.mark_mail_cancelled(item["id"])
        except Exception as exc:
            self.store.mark_mail_failed(item["id"], type(exc).__name__)
        else:
            self.store.mark_mail_sent(item["id"])
        return True

    def _build_message(self, item: Dict[str, Any]) -> EmailMessage:
        kind = str(item["kind"])
        subjects = {
            "register_code": "[谷子学术] 注册验证码",
            "reset_code": "[谷子学术] 密码重置验证码",
            "bind_code": "[谷子学术] 绑定邮箱验证码",
            "password_reset_notice": "[谷子学术] 密码已重置",
        }
        if kind not in subjects:
            raise ValueError("unsupported mail template")
        if kind == "password_reset_notice":
            reset_at = time.strftime(
                "%Y-%m-%d %H:%M:%S UTC",
                time.gmtime(float(item["created_at"])),
            )
            body = (
                f"你的谷子学术账号密码已于 {reset_at} 成功重置。"
                "若非本人操作，请立即联系 guzilab@163.com。"
            )
        else:
            challenge_id = str(item.get("challenge_id") or "")
            purpose = str(item.get("challenge_purpose") or "")
            email = str(item.get("challenge_email") or "")
            expires_at = item.get("challenge_expires_at")
            consumed_at = item.get("challenge_consumed_at")
            attempt_count = item.get("challenge_attempt_count")
            if (
                not challenge_id
                or not purpose
                or not email
                or expires_at is None
                or float(expires_at) <= time.time()
                or consumed_at is not None
                or attempt_count is None
                or int(attempt_count) >= EMAIL_CODE_ATTEMPT_LIMIT
            ):
                raise StaleEmailChallenge()
            code = self.store._derive_email_code(challenge_id, purpose, email)
            body = (
                f"你的验证码是：{code}\n\n"
                "验证码在 10 分钟内有效，请勿转发给任何人。若非本人操作，请忽略此邮件。"
            )

        config = self.store._email_config
        message = EmailMessage()
        message["Subject"] = subjects[kind]
        message["From"] = formataddr((config.from_name, config.from_address))
        message["To"] = str(item["recipient"])
        message["Reply-To"] = config.reply_to
        message.set_content(body)
        return message


def build_handler(store: AccountStore) -> type:
    limiter = RateLimiter()
    email_ip_limiter = RateLimiter(limit=20, window=3600)
    email_key_limiter = RateLimiter(limit=5, window=3600)

    class AccountHandler(BaseHTTPRequestHandler):
        server_version = "MyScholarAccount/0.2"

        def log_message(self, format: str, *args: Any) -> None:
            print("[account] " + format % args, flush=True)

        def _send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                return

        def _read_body(self) -> Dict[str, Any]:
            try:
                length = int(self.headers.get("Content-Length", "0") or 0)
            except ValueError as exc:
                raise AccountError("请求体长度无效。") from exc
            if length < 0 or length > MAX_BODY_BYTES:
                raise AccountError("请求体过大。", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise AccountError("请求体必须是 JSON。") from None
            return payload if isinstance(payload, dict) else {}

        def _bearer_token(self) -> str:
            header = self.headers.get("Authorization", "")
            token = header[len("Bearer "):].strip() if header.startswith("Bearer ") else ""
            return token if len(token) <= 4096 else ""

        def _client_key(self) -> str:
            peer = self.client_address[0] if self.client_address else "?"
            if peer not in {"127.0.0.1", "::1"}:
                return peer
            forwarded = str(self.headers.get("X-Forwarded-For", ""))
            candidate = forwarded.rsplit(",", 1)[-1].strip()
            try:
                return str(ipaddress.ip_address(candidate)) if candidate else peer
            except ValueError:
                return peer

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            try:
                if self.path == "/api/health":
                    self._send_json({
                        "ok": True,
                        "service": "my-scholar-account",
                        "version": "0.2.0",
                        "email_auth_available": store.email_auth_available,
                    })
                elif self.path == "/api/auth/profile":
                    self._send_json({"profile": store.profile(self._bearer_token())})
                else:
                    self._send_json({"error": "接口不存在。"}, HTTPStatus.NOT_FOUND)
            except AccountError as exc:
                self._send_json({"error": str(exc)}, exc.status)

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
            client = self._client_key()
            try:
                if self.path == "/api/auth/email-code/request":
                    payload = self._read_body()
                    purpose = str(payload.get("purpose", "")).strip().lower()
                    email = store.normalize_email(str(payload.get("email", "")))
                    email_ip_limiter.check(f"email:{purpose}:ip:{client}")
                    email_key_limiter.check(f"email:{purpose}:key:{_token_hash(email)}")
                    result = store.request_email_code(
                        purpose,
                        email,
                        invite_code=str(payload.get("invite_code", "")).strip(),
                        token=self._bearer_token(),
                    )
                    self._send_json(result, HTTPStatus.ACCEPTED)
                elif self.path == "/api/auth/register":
                    limiter.check(f"register:{client}")
                    payload = self._read_body()
                    self._send_json(store.register(
                        str(payload.get("username", "")).strip(),
                        str(payload.get("password", "")),
                        str(payload.get("invite_code", "")).strip(),
                        str(payload.get("terms_version", "")),
                        str(payload.get("privacy_version", "")),
                        str(payload.get("email", "")),
                        str(payload.get("email_challenge_id", "")).strip(),
                        str(payload.get("email_code", "")).strip(),
                    ))
                elif self.path == "/api/auth/login":
                    limiter.check(f"login:{client}")
                    payload = self._read_body()
                    self._send_json(store.login(
                        str(payload.get("username", "")).strip(),
                        str(payload.get("password", "")),
                        str(payload.get("terms_version", "")),
                        str(payload.get("privacy_version", "")),
                    ))
                elif self.path == "/api/auth/reset-password":
                    limiter.check(f"reset:{client}")
                    payload = self._read_body()
                    self._send_json(store.reset_password(
                        str(payload.get("username", "")).strip(),
                        str(payload.get("recovery_code", "")).strip(),
                        str(payload.get("new_password", "")),
                    ))
                elif self.path == "/api/auth/password-reset/email":
                    limiter.check(f"reset-email:{client}")
                    payload = self._read_body()
                    self._send_json(store.reset_password_email(
                        str(payload.get("challenge_id", "")).strip(),
                        str(payload.get("email_code", "")).strip(),
                        str(payload.get("new_password", "")),
                    ))
                elif self.path == "/api/auth/email-bind":
                    limiter.check(f"bind-email:{client}")
                    payload = self._read_body()
                    self._send_json(store.bind_email(
                        self._bearer_token(),
                        str(payload.get("challenge_id", "")).strip(),
                        str(payload.get("email_code", "")).strip(),
                    ))
                elif self.path == "/api/auth/logout":
                    store.logout(self._bearer_token())
                    self._send_json({"ok": True})
                elif self.path == "/api/auth/usage":
                    payload = self._read_body()
                    self._send_json({"profile": store.report_usage(self._bearer_token(), payload.get("used_bytes"))})
                elif self.path == "/api/auth/profile-update":
                    payload = self._read_body()
                    self._send_json({"profile": store.update_profile(
                        self._bearer_token(),
                        nickname=payload.get("nickname") if "nickname" in payload else None,
                        avatar=payload.get("avatar") if "avatar" in payload else None,
                    )})
                else:
                    self._send_json({"error": "接口不存在。"}, HTTPStatus.NOT_FOUND)
            except AccountError as exc:
                self._send_json({"error": str(exc)}, exc.status)

    return AccountHandler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=[
        "serve",
        "email-preflight",
        "create-invite",
        "list-invites",
        "revoke-invite",
        "issue-recovery",
        "list-users",
        "grant-member",
        "revoke-member",
        "set-quota",
    ])
    parser.add_argument("args", nargs="*")
    parser.add_argument("--db", default="users.db")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8478)
    parser.add_argument("--uses", type=int, default=1)
    parser.add_argument("--valid-days", type=int, default=30)
    options = parser.parse_args()

    def require_args(count: int) -> None:
        if len(options.args) != count:
            parser.error(f"{options.command} 需要 {count} 个参数")

    if options.command == "email-preflight":
        require_args(0)
        try:
            result = email_preflight()
        except AccountError as exc:
            parser.error(str(exc))
        print(json.dumps(result, ensure_ascii=False))
        return

    email_config = load_email_config()
    store = AccountStore(options.db, email_config=email_config)
    worker: Optional[EmailOutboxWorker] = None

    try:
        if options.command == "serve":
            if store.email_auth_available:
                worker = EmailOutboxWorker(store)
                worker.start()
            server = ThreadingHTTPServer((options.host, options.port), build_handler(store))
            print(f"[account] listening on {options.host}:{options.port} db={options.db} invite=required", flush=True)
            try:
                server.serve_forever()
            finally:
                server.server_close()
        elif options.command == "create-invite":
            require_args(0)
            print(json.dumps(store.admin_create_invite(options.uses, options.valid_days), ensure_ascii=False))
        elif options.command == "list-invites":
            require_args(0)
            for invite in store.admin_list_invites():
                print(json.dumps(invite, ensure_ascii=False))
        elif options.command == "revoke-invite":
            require_args(1)
            print(json.dumps(store.admin_revoke_invite(options.args[0]), ensure_ascii=False))
        elif options.command == "issue-recovery":
            require_args(1)
            print(json.dumps(store.admin_issue_recovery(options.args[0]), ensure_ascii=False))
        elif options.command == "list-users":
            require_args(0)
            for profile in store.admin_list():
                print(json.dumps(profile, ensure_ascii=False))
        elif options.command == "grant-member":
            require_args(1)
            print(json.dumps(store.admin_update(options.args[0], member=1), ensure_ascii=False))
        elif options.command == "revoke-member":
            require_args(1)
            print(json.dumps(store.admin_update(options.args[0], member=0), ensure_ascii=False))
        elif options.command == "set-quota":
            require_args(2)
            print(json.dumps(store.admin_update(options.args[0], quota_bytes=int(options.args[1])), ensure_ascii=False))
    finally:
        if worker is not None:
            worker.stop()
        store.close()


if __name__ == "__main__":
    main()
