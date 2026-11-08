#!/usr/bin/env bash
set -Eeuo pipefail

readonly REMOTE=tencent-2
readonly EXPECTED_HOST=82.157.59.128
readonly EXPECTED_CADDY_VERSION=v2.11.4
readonly PUBLIC_HOST=guzilab.com
readonly CANONICAL_SOURCE_DB=/home/guzi/data/guzi-scholar/account/users.db
SOURCE_DB=
SOURCE_DB_EXPLICIT=0
ALLOW_VALID_CERT_WITHOUT_ACME=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-db) SOURCE_DB=${2:-}; SOURCE_DB_EXPLICIT=1; shift 2 ;;
    --allow-valid-cert-without-acme) ALLOW_VALID_CERT_WITHOUT_ACME=1; shift ;;
    *) echo "usage: $0 [--source-db /absolute/path/users.db] [--allow-valid-cert-without-acme]" >&2; exit 64 ;;
  esac
done
for COMMAND in ssh awk; do
  command -v "$COMMAND" >/dev/null || {
    echo "[preflight] missing local command: $COMMAND" >&2
    exit 69
  }
done
CONFIGURED_HOST=$(ssh -G "$REMOTE" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')
if [[ "$CONFIGURED_HOST" != "$EXPECTED_HOST" ]]; then
  echo "[preflight] ssh $REMOTE resolves to '$CONFIGURED_HOST', expected $EXPECTED_HOST" >&2
  exit 78
fi
if [[ $SOURCE_DB_EXPLICIT -ne 1 ]]; then
  SOURCE_DB=$CANONICAL_SOURCE_DB
fi
if [[ ! "$SOURCE_DB" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  echo "[preflight] source database path contains unsupported characters" >&2
  exit 64
fi

echo "[preflight] target=$REMOTE host=$CONFIGURED_HOST source_db=$SOURCE_DB"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" bash -s -- "$SOURCE_DB" "$EXPECTED_CADDY_VERSION" "$PUBLIC_HOST" "$ALLOW_VALID_CERT_WITHOUT_ACME" <<'REMOTE'
set -Eeuo pipefail
SOURCE_DB=$1
EXPECTED_CADDY_VERSION=$2
PUBLIC_HOST=$3
ALLOW_VALID_CERT_WITHOUT_ACME=$4

if ! sudo -n true; then
  echo "[preflight] passwordless sudo is required for the transactional installer" >&2
  exit 77
fi
. /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04* ]]; then
  echo "[preflight] expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}" >&2
  exit 69
fi
MEMORY_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
AVAILABLE_KB=$(df -Pk / | awk 'NR == 2 {print $4}')
if (( MEMORY_KB < 1500000 )); then
  echo "[preflight] at least 1.5 GiB RAM is required" >&2
  exit 69
fi
if (( AVAILABLE_KB < 8000000 )); then
  echo "[preflight] at least 8 GiB free disk space is required" >&2
  exit 69
fi
for COMMAND in caddy curl flock openssl python3 realpath ss systemctl; do
  command -v "$COMMAND" >/dev/null || {
    echo "[preflight] missing remote command: $COMMAND" >&2
    exit 69
  }
done
CADDY_VERSION=$(caddy version | awk '{print $1}')
if [[ "$CADDY_VERSION" != "$EXPECTED_CADDY_VERSION" ]]; then
  echo "[preflight] expected Caddy $EXPECTED_CADDY_VERSION, found $CADDY_VERSION" >&2
  exit 69
fi
getent passwd caddy >/dev/null || {
  echo "[preflight] the Caddy service user is missing" >&2
  exit 69
}
# Caddy serves every site on this server; deployment only checks that its configuration still loads.
sudo -n caddy validate --config /home/tools/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || {
  echo "[preflight] the server-wide Caddy configuration does not validate" >&2
  exit 69
}
if sudo -n test -L /home/guzi/config/guzi-scholar/ai.tokens.json || ! sudo -n test -f /home/guzi/config/guzi-scholar/ai.tokens.json; then
  echo "[preflight] provision the real /home/guzi/config/guzi-scholar/ai.tokens.json out of band before deployment" >&2
  exit 66
fi
TOKENS_META=$(sudo -n stat -c '%a:%U:%G' /home/guzi/config/guzi-scholar/ai.tokens.json)
case "$TOKENS_META" in
  600:root:root|640:root:guzi-account) ;;
  *)
    echo "[preflight] unsafe AI token metadata: $TOKENS_META (expected root-only staging or root:guzi-account 0640)" >&2
    exit 78
    ;;
esac
sudo -n python3 - /home/guzi/config/guzi-scholar/ai.tokens.json <<'PY'
import json
import pathlib
import sys
from urllib.parse import urlsplit

path = pathlib.Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
for service in ("translation", "chat"):
    profile = payload.get(service) if isinstance(payload, dict) else None
    if not isinstance(profile, dict):
        raise SystemExit(f"missing AI profile: {service}")
    parsed = urlsplit(str(profile.get("base_url", "")).strip())
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise SystemExit(f"invalid HTTPS base_url for {service}")
    if not str(profile.get("api_key", "")).strip() or not str(profile.get("model", "")).strip():
        raise SystemExit(f"incomplete AI profile: {service}")
print("[preflight] AI profiles are structurally complete; secret values were not printed")
PY
if [[ $(timedatectl show -p NTPSynchronized --value 2>/dev/null) != yes ]]; then
  echo "[preflight] system time is not NTP-synchronized; short-lived ACME certificates are unsafe" >&2
  exit 69
fi

SOURCE_REAL=$(sudo -n realpath -e -- "$SOURCE_DB")
if ! sudo -n test -f "$SOURCE_REAL"; then
  echo "[preflight] source database is missing: $SOURCE_DB" >&2
  exit 66
fi
sudo -n python3 - "$SOURCE_REAL" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    users = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0] if "users" in tables else -1
finally:
    connection.close()
if quick_check != "ok" or not {"users", "sessions"}.issubset(tables) or users < 1:
    raise SystemExit(f"database preflight failed: quick_check={quick_check} users={users} tables={sorted(tables)}")
print(f"[preflight] database ok users={users} path={sys.argv[1]}")
PY

if ! curl --fail --silent --show-error --max-time 10 https://acme-v02.api.letsencrypt.org/directory >/dev/null; then
  if [[ "$ALLOW_VALID_CERT_WITHOUT_ACME" -ne 1 ]]; then
    echo "[preflight] ACME directory is unreachable; refusing deployment without the explicit valid-certificate fallback" >&2
    exit 69
  fi
  CERT_FILE=$(mktemp /tmp/guzi-scholar-preflight-cert.XXXXXX)
  cleanup_cert() {
    [[ ! -e "$CERT_FILE" ]] || unlink -- "$CERT_FILE"
  }
  trap cleanup_cert EXIT
  if ! openssl s_client -connect 127.0.0.1:443 -servername "$PUBLIC_HOST" </dev/null 2>/dev/null \
    | openssl x509 -outform PEM >"$CERT_FILE"; then
    echo "[preflight] unable to read the currently served certificate" >&2
    exit 69
  fi
  # guzilab.com uses the short-lived ACME profile, so a healthy certificate often has only a few days left.
  if ! openssl x509 -in "$CERT_FILE" -checkend 86400 -noout >/dev/null; then
    echo "[preflight] ACME is unreachable and the current certificate expires within a day" >&2
    exit 69
  fi
  if ! openssl x509 -in "$CERT_FILE" -text -noout | grep -F "DNS:$PUBLIC_HOST" >/dev/null; then
    echo "[preflight] current certificate does not cover $PUBLIC_HOST" >&2
    exit 69
  fi
  echo "[preflight] warning: ACME is unreachable; proceeding with an explicit fallback because the $PUBLIC_HOST certificate is still valid for at least a day" >&2
  cleanup_cert
  trap - EXIT
fi

echo "[preflight] os=$PRETTY_NAME ram_kib=$MEMORY_KB root_available_kib=$AVAILABLE_KB caddy=$CADDY_VERSION"
echo "[preflight] current listeners on managed ports:"
sudo -n ss -H -ltnp '( sport = :80 or sport = :443 or sport = :8480 )' || true
REMOTE

echo "[preflight] passed"
echo "[preflight] note: this does not modify or prove Tencent Cloud firewall rules; TCP 80/443 must be allowed separately"
