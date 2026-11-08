#!/usr/bin/env bash
set -Eeuo pipefail

readonly REMOTE=tencent-2
readonly EXPECTED_HOST=82.157.59.128
readonly PUBLIC_HOST=guzilab.com
readonly CANONICAL_SOURCE_DB=/home/guzi/data/guzi-scholar/account/users.db
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd -P)
SOURCE_DB=
SOURCE_DB_EXPLICIT=0
RELEASE_ID=
ALLOW_DIRTY=0
ALLOW_VALID_CERT_WITHOUT_ACME=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-id) RELEASE_ID=${2:-}; shift 2 ;;
    --source-db) SOURCE_DB=${2:-}; SOURCE_DB_EXPLICIT=1; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --allow-valid-cert-without-acme) ALLOW_VALID_CERT_WITHOUT_ACME=1; shift ;;
    *)
      echo "usage: $0 [--release-id ID] [--source-db PATH] [--allow-dirty] [--allow-valid-cert-without-acme]" >&2
      exit 64
      ;;
  esac
done

if [[ -z "$RELEASE_ID" ]]; then
  GIT_ID=$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)
  RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$GIT_ID"
fi
if [[ ! "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "[deploy] invalid release id" >&2
  exit 64
fi
CONFIGURED_HOST=$(ssh -G "$REMOTE" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')
if [[ "$CONFIGURED_HOST" != "$EXPECTED_HOST" ]]; then
  echo "[deploy] ssh $REMOTE resolves to '$CONFIGURED_HOST', expected $EXPECTED_HOST" >&2
  exit 78
fi
if [[ $SOURCE_DB_EXPLICIT -ne 1 ]]; then
  SOURCE_DB=$CANONICAL_SOURCE_DB
fi
if [[ ! "$SOURCE_DB" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  echo "[deploy] invalid source database path" >&2
  exit 64
fi
if [[ $ALLOW_DIRTY -ne 1 && -n $(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal) ]]; then
  echo "[deploy] worktree is dirty; review it and pass --allow-dirty only for an intentional beta build" >&2
  exit 78
fi
if ! python3 -I -B "$REPO_ROOT/apps/desktop/user_service.py" --help | grep -q 'create-invite'; then
  echo "[deploy] account service does not expose create-invite; invitation-only registration is not ready" >&2
  exit 78
fi

# The legacy macOS beta update channel is optional. Without a manifest here, the server keeps serving
# the live release's updates/ unchanged.
UPDATE_MANIFEST="$SCRIPT_DIR/updates/macos/arm64/beta.json"
UPDATE_DMG_NAME=
if [[ -f "$UPDATE_MANIFEST" ]]; then
read -r UPDATE_DMG_NAME UPDATE_DMG_SHA UPDATE_VERSION < <(python3 - "$UPDATE_MANIFEST" "$PUBLIC_HOST" <<'PY'
import json
import pathlib
import re
import sys
import urllib.parse

payload = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
url = urllib.parse.urlsplit(payload.get("download_url", ""))
name = pathlib.PurePosixPath(url.path).name
if (
    url.scheme != "https"
    or url.netloc != sys.argv[2]
    or pathlib.PurePosixPath(url.path).parent != pathlib.PurePosixPath("/updates/macos/arm64")
    or url.query
    or url.fragment
    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.dmg", name)
):
    raise SystemExit("invalid update download URL")
sha256 = payload.get("sha256", "")
version = payload.get("version", "")
if not re.fullmatch(r"[0-9a-f]{64}", sha256):
    raise SystemExit("invalid update SHA-256")
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
    raise SystemExit("invalid update version")
print(name, sha256, version)
PY
)
UPDATE_DMG_SOURCE="$REPO_ROOT/apps/desktop/dist/mac.noindex/Guzi-Scholar-$UPDATE_VERSION-arm64-internal.dmg"
if [[ ! -f "$UPDATE_DMG_SOURCE" ]]; then
  echo "[deploy] build the macOS release first: $UPDATE_DMG_SOURCE" >&2
  exit 66
fi
if command -v sha256sum >/dev/null; then
  ACTUAL_UPDATE_DMG_SHA=$(sha256sum "$UPDATE_DMG_SOURCE" | awk '{print $1}')
else
  ACTUAL_UPDATE_DMG_SHA=$(shasum -a 256 "$UPDATE_DMG_SOURCE" | awk '{print $1}')
fi
if [[ "$ACTUAL_UPDATE_DMG_SHA" != "$UPDATE_DMG_SHA" ]]; then
  echo "[deploy] update manifest SHA-256 does not match the built DMG" >&2
  exit 78
fi
else
  echo "[deploy] no update manifest in deploy/tencent/updates; the live updates/ directory will be carried forward"
fi

PREFLIGHT_ARGS=(--source-db "$SOURCE_DB")
if [[ $ALLOW_VALID_CERT_WITHOUT_ACME -eq 1 ]]; then
  PREFLIGHT_ARGS+=(--allow-valid-cert-without-acme)
fi
"$SCRIPT_DIR/preflight.sh" "${PREFLIGHT_ARGS[@]}"

STAGE=$(mktemp -d /tmp/guzi-scholar-deploy.XXXXXX)
ARCHIVE="/tmp/guzi-scholar-$RELEASE_ID.tar.gz"
REMOTE_STAGE="/tmp/guzi-scholar-deploy-$RELEASE_ID"
REMOTE_ARCHIVE="/tmp/guzi-scholar-$RELEASE_ID.tar.gz"
REMOTE_STAGED=0

cleanup_all() {
  local status=$?
  if [[ -n "${STAGE:-}" && "$STAGE" == /tmp/guzi-scholar-deploy.* && -d "$STAGE" ]]; then
    find "$STAGE" -depth -delete
  fi
  [[ ! -e "${ARCHIVE:-}" ]] || unlink -- "$ARCHIVE"
  if [[ ${REMOTE_STAGED:-0} -eq 1 ]]; then
    ssh "$REMOTE" "if [ -d '$REMOTE_STAGE' ]; then find '$REMOTE_STAGE' -depth -delete; fi; if [ -f '$REMOTE_ARCHIVE' ]; then unlink -- '$REMOTE_ARCHIVE'; fi" \
      || echo "[deploy] warning: remote staging cleanup failed" >&2
  fi
  return "$status"
}
trap cleanup_all EXIT

install -d -m 0755 "$STAGE/account" "$STAGE/deployment"
install -m 0644 "$REPO_ROOT/apps/desktop/user_service.py" "$STAGE/account/user_service.py"
install -m 0644 "$REPO_ROOT/apps/desktop/ai_gateway.py" "$STAGE/account/ai_gateway.py"
install -m 0644 "$REPO_ROOT/apps/desktop/config.py" "$STAGE/account/config.py"
cp -R "$SCRIPT_DIR/." "$STAGE/deployment/"
CHECKSUM_FILES=(account/user_service.py account/ai_gateway.py account/config.py)
if [[ -n "$UPDATE_DMG_NAME" ]]; then
  install -m 0644 "$UPDATE_DMG_SOURCE" "$STAGE/deployment/updates/macos/arm64/$UPDATE_DMG_NAME"
  CHECKSUM_FILES+=("deployment/updates/macos/arm64/$UPDATE_DMG_NAME")
fi
git -C "$REPO_ROOT" rev-parse HEAD >"$STAGE/revision.txt" 2>/dev/null || printf 'unknown\n' >"$STAGE/revision.txt"
if command -v sha256sum >/dev/null; then
  (cd "$STAGE" && sha256sum "${CHECKSUM_FILES[@]}" >SHA256SUMS)
else
  (cd "$STAGE" && shasum -a 256 "${CHECKSUM_FILES[@]}" >SHA256SUMS)
fi
tar -czf "$ARCHIVE" -C "$STAGE" .

CONFIGURED_HOST=$(ssh -G "$REMOTE" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')
if [[ "$CONFIGURED_HOST" != "$EXPECTED_HOST" ]]; then
  echo "[deploy] target alias changed after preflight" >&2
  exit 78
fi
ssh "$REMOTE" "if [ -e '$REMOTE_STAGE' ] || [ -e '$REMOTE_ARCHIVE' ]; then exit 73; fi; install -d -m 0700 '$REMOTE_STAGE'"
REMOTE_STAGED=1
scp "$ARCHIVE" "$REMOTE:$REMOTE_ARCHIVE"
ssh "$REMOTE" "tar -xzf '$REMOTE_ARCHIVE' -C '$REMOTE_STAGE'"
ssh "$REMOTE" "cd '$REMOTE_STAGE' && sha256sum -c SHA256SUMS"

ssh "$REMOTE" sudo -n bash "$REMOTE_STAGE/deployment/scripts/remote-install.sh" \
  --release-id "$RELEASE_ID" \
  --bundle-root "$REMOTE_STAGE" \
  --source-db "$SOURCE_DB"

if "$SCRIPT_DIR/verify.sh"; then
  :
else
  VERIFY_STATUS=$?
  echo "[deploy] verification failed; restoring snapshot $RELEASE_ID" >&2
  if ! ssh "$REMOTE" sudo -n /home/guzi/services/guzi-scholar/sbin/guzi-scholar-rollback "$RELEASE_ID"; then
    echo "[deploy] automatic rollback failed; use deploy/tencent/rollback.sh $RELEASE_ID" >&2
    exit 70
  fi
  exit "$VERIFY_STATUS"
fi

ssh "$REMOTE" "find '$REMOTE_STAGE' -depth -delete; unlink -- '$REMOTE_ARCHIVE'"
REMOTE_STAGED=0
echo "[deploy] completed release=$RELEASE_ID snapshot=$RELEASE_ID"
echo "[deploy] create an invitation explicitly with the deployed user_service.py CLI after reviewing its --help"
