#!/usr/bin/env bash
set -Eeuo pipefail

readonly SNAPSHOT_ROOT=/home/guzi/backups/guzi-scholar/deployments
readonly TARGET_DB=/home/guzi/data/guzi-scholar/account/users.db
readonly SERVICE_ROOT=/home/guzi/services/guzi-scholar
# Caddy serves every site on this server; rollback never stops it or touches its configuration.

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "[rollback] run as root" >&2
  exit 77
fi
if [[ $# -ne 1 || ! "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "usage: remote-rollback.sh SNAPSHOT_ID" >&2
  exit 64
fi

SNAPSHOT_ID=$1
SNAPSHOT=$(realpath -e -- "$SNAPSHOT_ROOT/$SNAPSHOT_ID")
case "$SNAPSHOT" in
  "$SNAPSHOT_ROOT"/*) ;;
  *) echo "[rollback] snapshot escaped the backup root" >&2; exit 65 ;;
esac
if [[ ! -f "$SNAPSHOT/complete" ]]; then
  echo "[rollback] incomplete snapshot: $SNAPSHOT" >&2
  exit 66
fi

read_value() {
  local path=$1 fallback=${2:-}
  if [[ -f "$path" ]]; then
    head -n 1 -- "$path"
  else
    printf '%s\n' "$fallback"
  fi
}

restore_file() {
  local destination=$1 key=$2 state parent
  state=$(read_value "$SNAPSHOT/files/$key.state" absent)
  if [[ "$state" == present ]]; then
    parent=$(dirname -- "$destination")
    if [[ ! -d "$parent" ]]; then
      if [[ "$parent" == /home/guzi/config/guzi-scholar ]]; then
        install -d -o root -g root -m 0700 "$parent"
      else
        install -d -o root -g root -m 0755 "$parent"
      fi
    fi
    if [[ -e "$destination" || -L "$destination" ]]; then
      if [[ -d "$destination" && ! -L "$destination" ]]; then
        echo "[rollback] refusing to replace directory: $destination" >&2
        exit 73
      fi
      unlink -- "$destination"
    fi
    cp --archive -- "$SNAPSHOT/files/$key" "$destination"
  elif [[ -e "$destination" || -L "$destination" ]]; then
    if [[ -d "$destination" && ! -L "$destination" ]]; then
      echo "[rollback] refusing to unlink directory: $destination" >&2
      exit 73
    fi
    unlink -- "$destination"
  fi
}

restore_enablement() {
  local unit=$1 key=$2 desired
  [[ -n "$unit" ]] || return 0
  systemctl cat "$unit" >/dev/null 2>&1 || return 0
  desired=$(read_value "$SNAPSHOT/services/$key.enabled" disabled)
  if [[ "$desired" == enabled ]]; then
    systemctl enable "$unit" >/dev/null
  else
    systemctl disable "$unit" >/dev/null 2>&1 || true
  fi
}

restore_activity() {
  local unit=$1 key=$2 desired
  [[ -n "$unit" ]] || return 0
  systemctl cat "$unit" >/dev/null 2>&1 || return 0
  desired=$(read_value "$SNAPSHOT/services/$key.active" inactive)
  if [[ "$desired" == active ]]; then
    systemctl start "$unit"
  else
    systemctl stop "$unit" >/dev/null 2>&1 || true
  fi
}

LEGACY_ACCOUNT_UNIT=$(read_value "$SNAPSHOT/legacy-account-unit" my-scholar-account.service)
for UNIT in guzi-scholar-account-backup.timer guzi-scholar-ai.service guzi-scholar-account.service; do
  systemctl stop "$UNIT" >/dev/null 2>&1 || true
done

restore_file /home/guzi/config/guzi-scholar/account.env account-env
restore_file /home/guzi/config/guzi-scholar/ai.tokens.json ai-tokens
restore_file /etc/systemd/system/guzi-scholar-account.service account-unit
restore_file /etc/systemd/system/guzi-scholar-ai.service ai-unit
restore_file /etc/systemd/system/guzi-scholar-account-backup.service backup-service
restore_file /etc/systemd/system/guzi-scholar-account-backup.timer backup-timer
restore_file /home/guzi/services/guzi-scholar/sbin/guzi-scholar-db-verify db-verify
restore_file /home/guzi/services/guzi-scholar/sbin/guzi-scholar-ai-config-verify ai-config-verify
restore_file /home/guzi/services/guzi-scholar/sbin/guzi-scholar-account-backup db-backup
restore_file /home/guzi/services/guzi-scholar/sbin/guzi-scholar-rollback rollback-script

ETC_DIR_STATE=$(read_value "$SNAPSHOT/etc-dir.state" absent)
if [[ "$ETC_DIR_STATE" == present ]]; then
  ETC_DIR_METADATA=$(read_value "$SNAPSHOT/etc-dir.metadata")
  ETC_DIR_MODE=${ETC_DIR_METADATA%%:*}
  ETC_DIR_OWNER_GROUP=${ETC_DIR_METADATA#*:}
  chown "$ETC_DIR_OWNER_GROUP" /home/guzi/config/guzi-scholar
  chmod "$ETC_DIR_MODE" /home/guzi/config/guzi-scholar
elif [[ -d /home/guzi/config/guzi-scholar ]]; then
  rmdir -- /home/guzi/config/guzi-scholar 2>/dev/null || true
fi

DB_STATE=$(read_value "$SNAPSHOT/canonical-db.state" absent)
if [[ "$DB_STATE" == present ]]; then
  DB_TEMP="/home/guzi/data/guzi-scholar/account/.rollback-$SNAPSHOT_ID.sqlite3"
  install -o guzi-account -g guzi-account -m 0600 "$SNAPSHOT/canonical-db.sqlite3" "$DB_TEMP"
  /usr/bin/python3 - "$DB_TEMP" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    result = connection.execute("PRAGMA quick_check").fetchone()[0]
finally:
    connection.close()
if result != "ok":
    raise SystemExit(f"rollback database quick_check failed: {result}")
PY
  for SUFFIX in -wal -shm; do
    FILE="$TARGET_DB$SUFFIX"
    [[ ! -e "$FILE" ]] || unlink -- "$FILE"
  done
  mv -- "$DB_TEMP" "$TARGET_DB"
  chown guzi-account:guzi-account "$TARGET_DB"
  chmod 0600 "$TARGET_DB"
else
  for SUFFIX in '' -wal -shm; do
    FILE="$TARGET_DB$SUFFIX"
    [[ ! -e "$FILE" ]] || unlink -- "$FILE"
  done
fi

CURRENT_STATE=$(read_value "$SNAPSHOT/current.state" absent)
if [[ "$CURRENT_STATE" == symlink ]]; then
  CURRENT_TARGET=$(read_value "$SNAPSHOT/current.target")
  ln -sfn -- "$CURRENT_TARGET" "$SERVICE_ROOT/current"
elif [[ -L "$SERVICE_ROOT/current" ]]; then
  unlink -- "$SERVICE_ROOT/current"
fi

systemctl daemon-reload
restore_enablement "$LEGACY_ACCOUNT_UNIT" legacy-account
restore_enablement guzi-scholar-account.service account
restore_enablement guzi-scholar-ai.service ai
restore_enablement guzi-scholar-account-backup.timer backup-timer

restore_activity "$LEGACY_ACCOUNT_UNIT" legacy-account
restore_activity guzi-scholar-account.service account
restore_activity guzi-scholar-ai.service ai
restore_activity guzi-scholar-account-backup.timer backup-timer

echo "[rollback] restored snapshot $SNAPSHOT_ID"
