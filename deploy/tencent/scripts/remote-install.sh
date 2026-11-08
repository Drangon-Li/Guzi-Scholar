#!/usr/bin/env bash
set -Eeuo pipefail

readonly TARGET_DB=/home/guzi/data/guzi-scholar/account/users.db
readonly RELEASE_ROOT=/home/guzi/services/guzi-scholar/releases
readonly SNAPSHOT_ROOT=/home/guzi/backups/guzi-scholar/deployments
readonly EXPECTED_CADDY_VERSION=v2.11.4
# Caddy serves every site on this server; this installer only validates it and never edits it.
readonly CADDY_MAIN=/home/tools/caddy/Caddyfile
readonly SERVICE_ROOT=/home/guzi/services/guzi-scholar
readonly SBIN_DIR=$SERVICE_ROOT/sbin
readonly PUBLIC_HOST=guzilab.com

RELEASE_ID=
BUNDLE_ROOT=
SOURCE_DB=$TARGET_DB
LEGACY_ACCOUNT_UNIT=my-scholar-account.service

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-id) RELEASE_ID=${2:-}; shift 2 ;;
    --bundle-root) BUNDLE_ROOT=${2:-}; shift 2 ;;
    --source-db) SOURCE_DB=${2:-}; shift 2 ;;
    --legacy-account-unit) LEGACY_ACCOUNT_UNIT=${2:-}; shift 2 ;;
    *) echo "[install] unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "[install] run as root" >&2
  exit 77
fi
if [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "[install] invalid release id" >&2
  exit 64
fi
if [[ ! "$LEGACY_ACCOUNT_UNIT" =~ ^[A-Za-z0-9_.@-]+\.service$ ]]; then
  echo "[install] invalid legacy unit name" >&2
  exit 64
fi
if [[ "$BUNDLE_ROOT" != /* || ! -d "$BUNDLE_ROOT" ]]; then
  echo "[install] bundle root must be an existing absolute directory" >&2
  exit 66
fi

BUNDLE_ROOT=$(realpath -e -- "$BUNDLE_ROOT")
SOURCE_DB=$(realpath -e -- "$SOURCE_DB")
if [[ -f "$TARGET_DB" ]]; then
  CANONICAL_REAL=$(realpath -e -- "$TARGET_DB")
  if [[ "$SOURCE_DB" != "$CANONICAL_REAL" ]]; then
    echo "[install] canonical database already exists; refusing to replace it from $SOURCE_DB" >&2
    exit 78
  fi
fi
if [[ ! -f "$SOURCE_DB" || ! -f "$BUNDLE_ROOT/account/user_service.py" || ! -f "$BUNDLE_ROOT/account/ai_gateway.py" || ! -f "$BUNDLE_ROOT/account/config.py" ]]; then
  echo "[install] source database or account service is missing" >&2
  exit 66
fi
for REQUIRED in \
  account.env.example \
  systemd/guzi-scholar-account.service \
  systemd/guzi-scholar-ai.service \
  systemd/guzi-scholar-account-backup.service \
  systemd/guzi-scholar-account-backup.timer \
  scripts/guzi-scholar-db-verify \
  scripts/guzi-scholar-ai-config-verify \
  scripts/guzi-scholar-account-backup \
  scripts/remote-rollback.sh; do
  [[ -f "$BUNDLE_ROOT/deployment/$REQUIRED" ]] || {
    echo "[install] bundle is missing deployment/$REQUIRED" >&2
    exit 66
  }
done

for COMMAND in caddy curl flock python3 realpath systemctl systemd-run; do
  command -v "$COMMAND" >/dev/null || {
    echo "[install] required command is missing: $COMMAND" >&2
    exit 69
  }
done
CADDY_VERSION=$(caddy version | awk '{print $1}')
if [[ "$CADDY_VERSION" != "$EXPECTED_CADDY_VERSION" ]]; then
  echo "[install] Caddy $EXPECTED_CADDY_VERSION is required, found $CADDY_VERSION" >&2
  exit 69
fi
caddy validate --config "$CADDY_MAIN" --adapter caddyfile >/dev/null
# The legacy macOS beta update channel is optional: ship a new manifest and DMG when the bundle has them,
# otherwise carry the live release's updates/ forward unchanged.
BUNDLED_UPDATES=0
UPDATE_DMG_NAME=
if [[ -f "$BUNDLE_ROOT/deployment/updates/macos/arm64/beta.json" ]]; then
BUNDLED_UPDATES=1
python3 - "$BUNDLE_ROOT/deployment/updates/macos/arm64/beta.json" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert payload == {
    **payload,
    "schema": 1,
    "platform": "darwin",
    "arch": "arm64",
    "channel": "beta",
}
assert isinstance(payload.get("version"), str) and payload["version"]
PY
UPDATE_DMG_NAME=$(python3 - "$BUNDLE_ROOT/deployment/updates/macos/arm64/beta.json" "$BUNDLE_ROOT/deployment/updates/macos/arm64" "$PUBLIC_HOST" <<'PY'
import hashlib
import json
import pathlib
import re
import sys
import urllib.parse

manifest = pathlib.Path(sys.argv[1])
artifact_root = pathlib.Path(sys.argv[2]).resolve(strict=True)
payload = json.loads(manifest.read_text(encoding="utf-8"))
url = urllib.parse.urlsplit(payload.get("download_url", ""))
name = pathlib.PurePosixPath(url.path).name
if (
    url.scheme != "https"
    or url.netloc != sys.argv[3]
    or pathlib.PurePosixPath(url.path).parent != pathlib.PurePosixPath("/updates/macos/arm64")
    or url.query
    or url.fragment
    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.dmg", name)
):
    raise SystemExit("invalid update download URL")
expected = payload.get("sha256", "")
if not re.fullmatch(r"[0-9a-f]{64}", expected):
    raise SystemExit("invalid update SHA-256")
artifact = artifact_root / name
if not artifact.is_file() or artifact.resolve(strict=True).parent != artifact_root:
    raise SystemExit("update DMG is missing")
digest = hashlib.sha256()
with artifact.open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected:
    raise SystemExit("update DMG SHA-256 mismatch")
print(name)
PY
)
fi
if ! python3 -I -B "$BUNDLE_ROOT/account/user_service.py" --help | grep -q 'create-invite'; then
  echo "[install] refusing to deploy an account build without create-invite" >&2
  exit 78
fi
python3 -B "$BUNDLE_ROOT/account/ai_gateway.py" --help >/dev/null
if [[ -e "$RELEASE_ROOT/$RELEASE_ID" ]]; then
  echo "[install] immutable release already exists: $RELEASE_ID" >&2
  exit 73
fi
if [[ -e "$SERVICE_ROOT/current" && ! -L "$SERVICE_ROOT/current" ]]; then
  echo "[install] $SERVICE_ROOT/current exists but is not a symlink" >&2
  exit 73
fi
if [[ ! -f /home/guzi/config/guzi-scholar/ai.tokens.json || -L /home/guzi/config/guzi-scholar/ai.tokens.json ]]; then
  echo "[install] provision /home/guzi/config/guzi-scholar/ai.tokens.json out of band before deployment" >&2
  exit 66
fi
PROBE_TOKENS=$(mktemp /tmp/guzi-scholar-ai-probe.XXXXXX)
cleanup_probe_tokens() {
  [[ ! -e "${PROBE_TOKENS:-}" ]] || unlink -- "$PROBE_TOKENS"
}
trap cleanup_probe_tokens EXIT
install -o root -g root -m 0600 /home/guzi/config/guzi-scholar/ai.tokens.json "$PROBE_TOKENS"
if ! MY_SCHOLAR_DEVELOPER_TOKENS_FILE="$PROBE_TOKENS" \
  python3 -B "$BUNDLE_ROOT/account/ai_gateway.py" probe --timeout 20 >/dev/null; then
  exit 69
fi
cleanup_probe_tokens
trap - EXIT

snapshot_db() {
  local source=$1 destination=$2
  python3 - "$source" "$destination" <<'PY'
import pathlib
import sqlite3
import sys
import urllib.parse

source_path = pathlib.Path(sys.argv[1]).resolve(strict=True)
destination_path = pathlib.Path(sys.argv[2])
source_uri = "file:" + urllib.parse.quote(str(source_path)) + "?mode=ro"
source = sqlite3.connect(source_uri, uri=True, timeout=30)
target = sqlite3.connect(str(destination_path), timeout=30)
try:
    source.backup(target)
    target.commit()
    result = target.execute("PRAGMA quick_check").fetchone()[0]
    if result != "ok":
        raise SystemExit(f"snapshot quick_check failed: {result}")
finally:
    target.close()
    source.close()
PY
  chmod 0600 "$destination"
}

user_count() {
  python3 - "$1" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    print(connection.execute("SELECT COUNT(*) FROM users").fetchone()[0])
finally:
    connection.close()
PY
}

capture_service() {
  local unit=$1 key=$2
  if systemctl is-active --quiet "$unit"; then
    echo active >"$SNAPSHOT/services/$key.active"
  else
    echo inactive >"$SNAPSHOT/services/$key.active"
  fi
  if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    echo enabled >"$SNAPSHOT/services/$key.enabled"
  else
    echo disabled >"$SNAPSHOT/services/$key.enabled"
  fi
}

save_file() {
  local source=$1 key=$2
  if [[ -f "$source" || -L "$source" ]]; then
    echo present >"$SNAPSHOT/files/$key.state"
    cp --archive -- "$source" "$SNAPSHOT/files/$key"
  else
    echo absent >"$SNAPSHOT/files/$key.state"
  fi
}

install -d -o root -g root -m 0700 "$SNAPSHOT_ROOT"
SNAPSHOT="$SNAPSHOT_ROOT/$RELEASE_ID"
if [[ -e "$SNAPSHOT" ]]; then
  echo "[install] snapshot already exists: $RELEASE_ID" >&2
  exit 73
fi
install -d -o root -g root -m 0700 "$SNAPSHOT" "$SNAPSHOT/files" "$SNAPSHOT/services"
printf '%s\n' "$SOURCE_DB" >"$SNAPSHOT/source-db-path"
printf '%s\n' "$LEGACY_ACCOUNT_UNIT" >"$SNAPSHOT/legacy-account-unit"
chmod 0600 "$SNAPSHOT/source-db-path" "$SNAPSHOT/legacy-account-unit"
if [[ -d /home/guzi/config/guzi-scholar ]]; then
  echo present >"$SNAPSHOT/etc-dir.state"
  stat -c '%a:%U:%G' /home/guzi/config/guzi-scholar >"$SNAPSHOT/etc-dir.metadata"
else
  echo absent >"$SNAPSHOT/etc-dir.state"
fi

save_file /home/guzi/config/guzi-scholar/account.env account-env
save_file /home/guzi/config/guzi-scholar/ai.tokens.json ai-tokens
save_file /etc/systemd/system/guzi-scholar-account.service account-unit
save_file /etc/systemd/system/guzi-scholar-ai.service ai-unit
save_file /etc/systemd/system/guzi-scholar-account-backup.service backup-service
save_file /etc/systemd/system/guzi-scholar-account-backup.timer backup-timer
save_file /home/guzi/services/guzi-scholar/sbin/guzi-scholar-db-verify db-verify
save_file /home/guzi/services/guzi-scholar/sbin/guzi-scholar-ai-config-verify ai-config-verify
save_file /home/guzi/services/guzi-scholar/sbin/guzi-scholar-account-backup db-backup
save_file /home/guzi/services/guzi-scholar/sbin/guzi-scholar-rollback rollback-script

capture_service "$LEGACY_ACCOUNT_UNIT" legacy-account
capture_service guzi-scholar-account.service account
capture_service guzi-scholar-ai.service ai
capture_service guzi-scholar-account-backup.timer backup-timer

if [[ -L "$SERVICE_ROOT/current" ]]; then
  echo symlink >"$SNAPSHOT/current.state"
  readlink -- "$SERVICE_ROOT/current" >"$SNAPSHOT/current.target"
else
  echo absent >"$SNAPSHOT/current.state"
fi

snapshot_db "$SOURCE_DB" "$SNAPSHOT/source-db.sqlite3"
if [[ -f "$TARGET_DB" ]]; then
  echo present >"$SNAPSHOT/canonical-db.state"
  snapshot_db "$TARGET_DB" "$SNAPSHOT/canonical-db.sqlite3"
else
  echo absent >"$SNAPSHOT/canonical-db.state"
fi
SOURCE_USERS=$(user_count "$SNAPSHOT/source-db.sqlite3")
if (( SOURCE_USERS < 1 )); then
  echo "[install] source database unexpectedly has no users" >&2
  exit 78
fi

PRELIMINARY="$SNAPSHOT/preliminary-migration.sqlite3"
cp -- "$SNAPSHOT/source-db.sqlite3" "$PRELIMINARY"
python3 -I -B "$BUNDLE_ROOT/account/user_service.py" list-users --db "$PRELIMINARY" >/dev/null
"$BUNDLE_ROOT/deployment/scripts/guzi-scholar-db-verify" "$PRELIMINARY"
if [[ $(user_count "$PRELIMINARY") -ne "$SOURCE_USERS" ]]; then
  echo "[install] preliminary migration changed the user count" >&2
  exit 78
fi

BACKUP_PREFLIGHT_CODE="/opt/guzi-scholar-backup-preflight-$RELEASE_ID"
BACKUP_PREFLIGHT_DATA="/var/lib/guzi-scholar-backup-preflight-$RELEASE_ID"
BACKUP_PREFLIGHT_OUTPUT="/var/backups/guzi-scholar-backup-preflight-$RELEASE_ID"
cleanup_backup_preflight() {
  systemctl stop guzi-scholar-account-backup-preflight.service >/dev/null 2>&1 || true
  for path in "$BACKUP_PREFLIGHT_CODE" "$BACKUP_PREFLIGHT_DATA" "$BACKUP_PREFLIGHT_OUTPUT"; do
    [[ ! -d "$path" ]] || find "$path" -depth -delete
  done
}
trap cleanup_backup_preflight EXIT
for path in "$BACKUP_PREFLIGHT_CODE" "$BACKUP_PREFLIGHT_DATA" "$BACKUP_PREFLIGHT_OUTPUT"; do
  if [[ -e "$path" ]]; then
    echo "[install] isolated backup preflight path already exists: $path" >&2
    exit 73
  fi
done
install -d -o root -g root -m 0755 "$BACKUP_PREFLIGHT_CODE"
install -d -o nobody -g nogroup -m 0700 "$BACKUP_PREFLIGHT_DATA" "$BACKUP_PREFLIGHT_OUTPUT"
install -o root -g root -m 0755 \
  "$BUNDLE_ROOT/deployment/scripts/guzi-scholar-account-backup" \
  "$BACKUP_PREFLIGHT_CODE/guzi-scholar-account-backup"
install -o root -g root -m 0755 \
  "$BUNDLE_ROOT/deployment/scripts/guzi-scholar-db-verify" \
  "$BACKUP_PREFLIGHT_CODE/guzi-scholar-db-verify"
install -o nobody -g nogroup -m 0600 "$PRELIMINARY" "$BACKUP_PREFLIGHT_DATA/source.sqlite3"
systemd-run --quiet --wait --collect --pipe \
  --unit=guzi-scholar-account-backup-preflight \
  --property=Type=oneshot \
  --property=User=nobody \
  --property=Group=nogroup \
  --property=UMask=0077 \
  --property=RuntimeDirectory=guzi-scholar-account-backup \
  --property=RuntimeDirectoryMode=0700 \
  --property=PrivateTmp=true \
  --property=PrivateDevices=true \
  --property=NoNewPrivileges=true \
  --property=ProtectSystem=strict \
  --property=ProtectHome=true \
  --property="ReadWritePaths=$BACKUP_PREFLIGHT_DATA $BACKUP_PREFLIGHT_OUTPUT" \
  --property=CapabilityBoundingSet= \
  --property=RestrictAddressFamilies=AF_UNIX \
  --property=LockPersonality=true \
  --property=RestrictRealtime=true \
  --property=RestrictSUIDSGID=true \
  --setenv="GUZI_SCHOLAR_BACKUP_DB_PATH=$BACKUP_PREFLIGHT_DATA/source.sqlite3" \
  --setenv="GUZI_SCHOLAR_BACKUP_DIR=$BACKUP_PREFLIGHT_OUTPUT" \
  --setenv=GUZI_SCHOLAR_BACKUP_LOCK_PATH=/run/guzi-scholar-account-backup/backup.lock \
  --setenv="GUZI_SCHOLAR_BACKUP_DB_VERIFY=$BACKUP_PREFLIGHT_CODE/guzi-scholar-db-verify" \
  "$BACKUP_PREFLIGHT_CODE/guzi-scholar-account-backup" >/dev/null
if [[ $(find "$BACKUP_PREFLIGHT_OUTPUT" -maxdepth 1 -type f -name 'users-*.sqlite3' | wc -l) -ne 1 ]]; then
  echo "[install] isolated backup preflight did not create exactly one database backup" >&2
  exit 69
fi
cleanup_backup_preflight
trap - EXIT
echo complete >"$SNAPSHOT/complete"
chmod 0600 "$SNAPSHOT/complete"

ROLLBACK_READY=1
on_error() {
  local status=$?
  trap - ERR
  echo "[install] failed; restoring snapshot $RELEASE_ID" >&2
  if [[ ${ROLLBACK_READY:-0} -eq 1 ]]; then
    bash "$BUNDLE_ROOT/deployment/scripts/remote-rollback.sh" "$RELEASE_ID" || {
      echo "[install] automatic rollback failed; run deploy/tencent/rollback.sh $RELEASE_ID" >&2
    }
  fi
  exit "$status"
}
trap on_error ERR

if ! getent passwd guzi-account >/dev/null; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin guzi-account
fi
if [[ $(getent passwd guzi-account | cut -d: -f7) != /usr/sbin/nologin ]]; then
  echo "[install] existing guzi-account user is not a no-login account" >&2
  false
fi

install -d -o root -g root -m 0755 "$SERVICE_ROOT" "$RELEASE_ROOT" "$SBIN_DIR"
install -d -o root -g root -m 0755 "$RELEASE_ROOT/$RELEASE_ID"
install -d -o root -g root -m 0755 "$RELEASE_ROOT/$RELEASE_ID/account"
install -o root -g root -m 0444 "$BUNDLE_ROOT/account/user_service.py" "$RELEASE_ROOT/$RELEASE_ID/account/user_service.py"
install -o root -g root -m 0444 "$BUNDLE_ROOT/account/ai_gateway.py" "$RELEASE_ROOT/$RELEASE_ID/account/ai_gateway.py"
install -o root -g root -m 0444 "$BUNDLE_ROOT/account/config.py" "$RELEASE_ROOT/$RELEASE_ID/account/config.py"
if [[ $BUNDLED_UPDATES -eq 1 ]]; then
  install -d -o root -g root -m 0755 "$RELEASE_ROOT/$RELEASE_ID/updates" "$RELEASE_ROOT/$RELEASE_ID/updates/macos" "$RELEASE_ROOT/$RELEASE_ID/updates/macos/arm64"
  install -o root -g root -m 0444 "$BUNDLE_ROOT/deployment/updates/macos/arm64/beta.json" "$RELEASE_ROOT/$RELEASE_ID/updates/macos/arm64/beta.json"
  install -o root -g root -m 0444 "$BUNDLE_ROOT/deployment/updates/macos/arm64/$UPDATE_DMG_NAME" "$RELEASE_ROOT/$RELEASE_ID/updates/macos/arm64/$UPDATE_DMG_NAME"
elif [[ -d "$SERVICE_ROOT/current/updates" ]]; then
  cp --archive -- "$(realpath -e -- "$SERVICE_ROOT/current/updates")" "$RELEASE_ROOT/$RELEASE_ID/updates"
fi
install -d -o root -g guzi-account -m 0710 /home/guzi/config/guzi-scholar
if [[ ! -e /home/guzi/config/guzi-scholar/account.env ]]; then
  install -o root -g root -m 0600 "$BUNDLE_ROOT/deployment/account.env.example" /home/guzi/config/guzi-scholar/account.env
fi
chown root:root /home/guzi/config/guzi-scholar/account.env
chmod 0600 /home/guzi/config/guzi-scholar/account.env
if [[ ! -f /home/guzi/config/guzi-scholar/ai.tokens.json || -L /home/guzi/config/guzi-scholar/ai.tokens.json ]]; then
  echo "[install] provision /home/guzi/config/guzi-scholar/ai.tokens.json out of band before deployment" >&2
  false
fi
chown root:guzi-account /home/guzi/config/guzi-scholar/ai.tokens.json
chmod 0640 /home/guzi/config/guzi-scholar/ai.tokens.json

install -d -o guzi-account -g guzi-account -m 0700 /home/guzi/data/guzi-scholar/account
install -d -o guzi-account -g guzi-account -m 0700 /home/guzi/backups/guzi-scholar/account

install -o root -g root -m 0755 "$BUNDLE_ROOT/deployment/scripts/guzi-scholar-db-verify" /home/guzi/services/guzi-scholar/sbin/guzi-scholar-db-verify
install -o root -g root -m 0755 "$BUNDLE_ROOT/deployment/scripts/guzi-scholar-ai-config-verify" /home/guzi/services/guzi-scholar/sbin/guzi-scholar-ai-config-verify
install -o root -g root -m 0755 "$BUNDLE_ROOT/deployment/scripts/guzi-scholar-account-backup" /home/guzi/services/guzi-scholar/sbin/guzi-scholar-account-backup
install -o root -g root -m 0755 "$BUNDLE_ROOT/deployment/scripts/remote-rollback.sh" /home/guzi/services/guzi-scholar/sbin/guzi-scholar-rollback
install -o root -g root -m 0644 "$BUNDLE_ROOT/deployment/systemd/guzi-scholar-account.service" /etc/systemd/system/guzi-scholar-account.service
install -o root -g root -m 0644 "$BUNDLE_ROOT/deployment/systemd/guzi-scholar-ai.service" /etc/systemd/system/guzi-scholar-ai.service
install -o root -g root -m 0644 "$BUNDLE_ROOT/deployment/systemd/guzi-scholar-account-backup.service" /etc/systemd/system/guzi-scholar-account-backup.service
install -o root -g root -m 0644 "$BUNDLE_ROOT/deployment/systemd/guzi-scholar-account-backup.timer" /etc/systemd/system/guzi-scholar-account-backup.timer
/home/guzi/services/guzi-scholar/sbin/guzi-scholar-ai-config-verify /home/guzi/config/guzi-scholar/ai.tokens.json

systemctl stop guzi-scholar-ai.service "$LEGACY_ACCOUNT_UNIT" guzi-scholar-account.service >/dev/null 2>&1 || true
for UNIT in guzi-scholar-ai.service "$LEGACY_ACCOUNT_UNIT" guzi-scholar-account.service; do
  if systemctl is-active --quiet "$UNIT"; then
    echo "[install] account database user is still active after stop: $UNIT" >&2
    false
  fi
done
snapshot_db "$SOURCE_DB" "$SNAPSHOT/source-db-final.sqlite3"
if [[ -f "$TARGET_DB" ]]; then
  if [[ $(realpath -e -- "$TARGET_DB") == "$SOURCE_DB" ]]; then
    cp -- "$SNAPSHOT/source-db-final.sqlite3" "$SNAPSHOT/canonical-db-final.sqlite3"
  else
    snapshot_db "$TARGET_DB" "$SNAPSHOT/canonical-db-final.sqlite3"
  fi
  mv -- "$SNAPSHOT/canonical-db-final.sqlite3" "$SNAPSHOT/canonical-db.sqlite3"
  chmod 0600 "$SNAPSHOT/canonical-db.sqlite3"
fi
FINAL_SOURCE_USERS=$(user_count "$SNAPSHOT/source-db-final.sqlite3")
if [[ "$FINAL_SOURCE_USERS" -lt "$SOURCE_USERS" ]]; then
  echo "[install] final snapshot lost users" >&2
  false
fi
FINAL_CANDIDATE=/home/guzi/data/guzi-scholar/account/.users-migration.sqlite3
install -o guzi-account -g guzi-account -m 0600 "$SNAPSHOT/source-db-final.sqlite3" "$FINAL_CANDIDATE"
python3 -I -B "$RELEASE_ROOT/$RELEASE_ID/account/user_service.py" list-users --db "$FINAL_CANDIDATE" >/dev/null
/home/guzi/services/guzi-scholar/sbin/guzi-scholar-db-verify "$FINAL_CANDIDATE"
if [[ $(user_count "$FINAL_CANDIDATE") -ne "$FINAL_SOURCE_USERS" ]]; then
  echo "[install] final migration changed the user count" >&2
  false
fi
for SUFFIX in -wal -shm; do
  FILE="$TARGET_DB$SUFFIX"
  [[ ! -e "$FILE" ]] || unlink -- "$FILE"
done
mv -- "$FINAL_CANDIDATE" "$TARGET_DB"
chown guzi-account:guzi-account "$TARGET_DB"
chmod 0600 "$TARGET_DB"
ln -sfn -- "releases/$RELEASE_ID" "$SERVICE_ROOT/current"

systemctl daemon-reload
systemctl disable "$LEGACY_ACCOUNT_UNIT" >/dev/null 2>&1 || true
systemctl enable --now guzi-scholar-account.service
systemctl enable --now guzi-scholar-ai.service
systemctl enable --now guzi-scholar-account-backup.timer

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8478/api/health >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8480/health >/dev/null
systemctl start guzi-scholar-account-backup.service
echo "$RELEASE_ID" >"$SNAPSHOT/deployed"
chmod 0600 "$SNAPSHOT/deployed"
trap - ERR

echo "[install] release $RELEASE_ID is active"
echo "[install] no invitation was generated; create one explicitly after HTTPS verification"
