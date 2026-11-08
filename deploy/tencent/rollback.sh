#!/usr/bin/env bash
set -Eeuo pipefail

readonly REMOTE=tencent-2
readonly EXPECTED_HOST=82.157.59.128
SNAPSHOT_ID=
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) ASSUME_YES=1; shift ;;
    *)
      if [[ -z "$SNAPSHOT_ID" ]]; then
        SNAPSHOT_ID=$1
        shift
      else
        echo "usage: $0 SNAPSHOT_ID [--yes]" >&2
        exit 64
      fi
      ;;
  esac
done
if [[ ! "$SNAPSHOT_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "usage: $0 SNAPSHOT_ID [--yes]" >&2
  exit 64
fi
CONFIGURED_HOST=$(ssh -G "$REMOTE" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')
if [[ "$CONFIGURED_HOST" != "$EXPECTED_HOST" ]]; then
  echo "[rollback] ssh $REMOTE resolves to '$CONFIGURED_HOST', expected $EXPECTED_HOST" >&2
  exit 78
fi
ssh "$REMOTE" "sudo -n test -f '/home/guzi/backups/guzi-scholar/deployments/$SNAPSHOT_ID/complete'" || {
  echo "[rollback] snapshot does not exist or is incomplete: $SNAPSHOT_ID" >&2
  exit 66
}
if [[ $ASSUME_YES -ne 1 ]]; then
  printf 'Restore snapshot %s on ssh %s (%s)? Type the snapshot id to continue: ' "$SNAPSHOT_ID" "$REMOTE" "$EXPECTED_HOST" >&2
  read -r CONFIRMATION
  if [[ "$CONFIRMATION" != "$SNAPSHOT_ID" ]]; then
    echo "[rollback] cancelled" >&2
    exit 1
  fi
fi

ssh "$REMOTE" sudo -n /home/guzi/services/guzi-scholar/sbin/guzi-scholar-rollback "$SNAPSHOT_ID"
ssh "$REMOTE" "systemctl --no-pager --full status guzi-scholar-account.service guzi-scholar-ai.service 2>/dev/null | head -n 50 || true"
echo "[rollback] completed snapshot=$SNAPSHOT_ID; verify the restored public endpoint before further changes"
