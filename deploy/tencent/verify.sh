#!/usr/bin/env bash
set -Eeuo pipefail

readonly REMOTE=tencent-2
readonly REMOTE_HOST=82.157.59.128
readonly PUBLIC_HOST=guzilab.com
if [[ $# -ne 0 ]]; then
  echo "usage: $0" >&2
  exit 64
fi

CONFIGURED_HOST=$(ssh -G "$REMOTE" 2>/dev/null | awk '$1 == "hostname" { print $2; exit }')
if [[ "$CONFIGURED_HOST" != "$REMOTE_HOST" ]]; then
  echo "[verify] ssh $REMOTE resolves to '$CONFIGURED_HOST', expected $REMOTE_HOST" >&2
  exit 78
fi

ssh "$REMOTE" bash -s <<'REMOTE'
set -Eeuo pipefail
# The account service (port 8478) is paused and is not part of a release.
for UNIT in guzi-scholar-ai.service guzi-scholar-account-backup.timer caddy.service; do
  systemctl is-active --quiet "$UNIT" || {
    echo "[verify] inactive service: $UNIT" >&2
    exit 69
  }
done
[[ $(caddy version | awk '{print $1}') == v2.11.4 ]]
sudo -n caddy validate --config /home/tools/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1

[[ $(sudo -n stat -c '%a:%U:%G' /home/guzi/data/guzi-scholar/account) == 700:guzi-account:guzi-account ]]
[[ $(sudo -n stat -c '%a:%U:%G' /home/guzi/data/guzi-scholar/account/users.db) == 600:guzi-account:guzi-account ]]
[[ $(sudo -n stat -c '%a:%U:%G' /home/guzi/backups/guzi-scholar/account) == 700:guzi-account:guzi-account ]]
[[ $(sudo -n stat -c '%a:%U:%G' /home/guzi/config/guzi-scholar/ai.tokens.json) == 640:root:guzi-account ]]
sudo -n /home/guzi/services/guzi-scholar/sbin/guzi-scholar-db-verify /home/guzi/data/guzi-scholar/account/users.db
sudo -n /home/guzi/services/guzi-scholar/sbin/guzi-scholar-ai-config-verify /home/guzi/config/guzi-scholar/ai.tokens.json
AI_PROBE=$(sudo -n -u guzi-account env \
  MY_SCHOLAR_DEVELOPER_TOKENS_FILE=/home/guzi/config/guzi-scholar/ai.tokens.json \
  /usr/bin/python3 -B /home/guzi/services/guzi-scholar/current/account/ai_gateway.py probe --timeout 20)
/usr/bin/python3 -c '
import json, sys
payload = json.loads(sys.stdin.read())
assert payload.get("ok") is True
assert all(payload.get("services", {}).get(name, {}).get("ok") is True for name in ("translation", "chat"))
' <<<"$AI_PROBE"

for SPEC in '8480 127.0.0.1:8480'; do
  set -- $SPEC
  PORT=$1
  EXPECTED=$2
  SOCKETS=$(sudo -n ss -H -ltn "sport = :$PORT")
  [[ "$SOCKETS" == *"$EXPECTED"* ]] || {
    echo "[verify] port $PORT is not bound to $EXPECTED" >&2
    exit 69
  }
  [[ "$SOCKETS" != *"0.0.0.0:$PORT"* && "$SOCKETS" != *"[::]:$PORT"* ]] || {
    echo "[verify] port $PORT is exposed publicly" >&2
    exit 78
  }
done

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8480/health >/dev/null

# The legacy macOS beta update channel is optional; when present, its DMG must match the manifest.
UPDATES=/home/guzi/services/guzi-scholar/current/updates/macos/arm64
if [[ -f "$UPDATES/beta.json" ]]; then
  python3 - "$UPDATES/beta.json" "$UPDATES" guzilab.com <<'PY'
import hashlib
import json
import pathlib
import re
import sys
import urllib.parse

manifest = pathlib.Path(sys.argv[1])
artifact_root = pathlib.Path(sys.argv[2]).resolve(strict=True)
public_host = sys.argv[3]
payload = json.loads(manifest.read_text(encoding="utf-8"))
url = urllib.parse.urlsplit(payload.get("download_url", ""))
name = pathlib.PurePosixPath(url.path).name
assert url.scheme == "https"
assert pathlib.PurePosixPath(url.path).parent == pathlib.PurePosixPath("/updates/macos/arm64")
assert not url.query and not url.fragment
assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.dmg", name)
assert re.fullmatch(r"[0-9a-f]{64}", payload.get("sha256", ""))
artifact = artifact_root / name
assert artifact.is_file() and artifact.resolve(strict=True).parent == artifact_root
assert artifact.stat().st_size > 0
digest = hashlib.sha256()
with artifact.open("rb") as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
assert digest.hexdigest() == payload["sha256"]
assert (artifact.stat().st_mode & 0o777) == 0o444
if url.netloc != public_host:
    print(f"[verify] warning: update manifest still points to {url.netloc}, not {public_host}", file=sys.stderr)
PY
fi

LATEST=$(sudo -n find /home/guzi/backups/guzi-scholar/account -maxdepth 1 -type f -name 'users-*.sqlite3' -printf '%T@ %p\n' | sort -rn | head -n 1 | cut -d' ' -f2-)
[[ -n "$LATEST" ]]
[[ $(sudo -n stat -c '%a:%U:%G' "$LATEST") == 600:guzi-account:guzi-account ]]
[[ $(sudo -n stat -c '%a:%U:%G' "$LATEST.sha256") == 600:guzi-account:guzi-account ]]
sudo -n sha256sum -c "$LATEST.sha256" >/dev/null
sudo -n /home/guzi/services/guzi-scholar/sbin/guzi-scholar-db-verify "$LATEST" >/dev/null
echo "[verify] remote services, permissions, listeners, live database and latest backup are valid"
REMOTE

for SPEC in '8480 /health'; do
  set -- $SPEC
  PORT=$1
  PATHNAME=$2
  if curl --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 5 \
    --output /dev/null "http://$REMOTE_HOST:$PORT$PATHNAME" 2>/dev/null; then
    echo "[verify] internal port $PORT is reachable from the public internet" >&2
    exit 78
  fi
done

HTTPS_LOCAL_READY=0
for ATTEMPT in $(seq 1 40); do
  if ssh "$REMOTE" curl --resolve "$PUBLIC_HOST:443:127.0.0.1" \
    --fail --silent --show-error --connect-timeout 3 --max-time 5 \
    "https://$PUBLIC_HOST/ai/health" >/dev/null 2>&1; then
    HTTPS_LOCAL_READY=1
    break
  fi
  sleep 2
done
if [[ $HTTPS_LOCAL_READY -ne 1 ]]; then
  echo "[verify] Caddy does not serve $PUBLIC_HOST locally with a usable certificate" >&2
  exit 69
fi
if ! curl --noproxy '*' --fail --silent --show-error \
  --connect-timeout 5 --max-time 15 "https://$PUBLIC_HOST/ai/health" >/dev/null; then
  echo "[verify] public HTTPS AI health on $PUBLIC_HOST is unreachable" >&2
  exit 69
fi
if UPDATE_MANIFEST=$(curl --noproxy '*' --fail --silent --show-error --max-time 10 "https://$PUBLIC_HOST/updates/macos/arm64/beta.json" 2>/dev/null); then
  /usr/bin/python3 -c '
import json, sys
payload = json.loads(sys.stdin.read())
assert payload.get("schema") == 1
assert payload.get("platform") == "darwin"
assert payload.get("arch") == "arm64"
assert payload.get("channel") == "beta"
assert isinstance(payload.get("version"), str) and payload["version"]
assert isinstance(payload.get("sha256"), str) and len(payload["sha256"]) == 64
' <<<"$UPDATE_MANIFEST"
  UPDATE_DOWNLOAD_URL=$(/usr/bin/python3 -c '
import json, sys
print(json.loads(sys.stdin.read())["download_url"])
' <<<"$UPDATE_MANIFEST")
  if [[ "$UPDATE_DOWNLOAD_URL" == "https://$PUBLIC_HOST/updates/"* ]]; then
    curl --noproxy '*' --fail --silent --show-error --head --max-time 15 "$UPDATE_DOWNLOAD_URL" >/dev/null
  else
    echo "[verify] warning: the public update manifest links to $UPDATE_DOWNLOAD_URL, which is not on $PUBLIC_HOST" >&2
  fi
fi

CERT_FILE=$(mktemp /tmp/guzi-scholar-cert.XXXXXX)
cleanup_cert() {
  [[ ! -e "$CERT_FILE" ]] || unlink -- "$CERT_FILE"
}
trap cleanup_cert EXIT
openssl s_client -connect "$REMOTE_HOST:443" -servername "$PUBLIC_HOST" </dev/null 2>/dev/null | openssl x509 -outform PEM >"$CERT_FILE"
# guzilab.com uses the short-lived ACME profile: require at least a day left, and no long-lived certificate.
openssl x509 -in "$CERT_FILE" -checkend 86400 -noout >/dev/null
if openssl x509 -in "$CERT_FILE" -checkend 691200 -noout >/dev/null; then
  echo "[verify] certificate lifetime exceeds the expected short-lived profile" >&2
  exit 78
fi
openssl x509 -in "$CERT_FILE" -text -noout | grep -F "DNS:$PUBLIC_HOST" >/dev/null

echo "[verify] HTTPS on $PUBLIC_HOST, short-lived certificate, AI API, and exposure checks passed"
