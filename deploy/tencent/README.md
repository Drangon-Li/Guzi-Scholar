# Tencent invitation-beta deployment

This directory deploys the Guzi Scholar account service and AI gateway to
`ssh tencent-2` (82.157.59.128) only. It does not reuse or modify
`webseit/deploy.sh`.

## Server topology

The server hosts every super4science.cn and guzilab.com site, so this
deployment owns only the Guzi Scholar services and never edits Caddy:

- Public endpoint: `https://guzilab.com` (the bare-IP endpoint is retired)
- Caddy 2.11.4 with the global configuration in `/home/tools/caddy/Caddyfile`;
  the Guzi site blocks live in `/home/guzi/caddy/guzi.caddy` and are tracked by
  the Guzi-Lab-Website repository (`ops/server/`). Deployments only validate
  the global configuration.
- ACME: Let's Encrypt `shortlived` profile for `guzilab.com`, managed by Caddy
- ACME contact and product support: `guzilab@163.com`
- Account API: Caddy `/api/auth/*` -> `127.0.0.1:8478`
- Verification mail: account service -> `smtp.163.com:465` over implicit TLS
- AI gateway: Caddy strips `/ai` -> `127.0.0.1:8480`
- Legacy macOS beta updates: Caddy `/updates/*` -> `current/updates`
- Operating entity for the beta notices: 北京粟白科技有限公司
- Access logs: structured JSON on Caddy stdout, retained and rotated by journald

## Data and service boundaries

Account code is installed into an immutable release directory:

```text
/home/guzi/services/guzi-scholar/releases/<release-id>/account/user_service.py
/home/guzi/services/guzi-scholar/current -> releases/<release-id>
/home/guzi/services/guzi-scholar/sbin/guzi-scholar-*   (verify, backup and rollback helpers)
```

The account and AI services run as the non-login `guzi-account` user so both
can access the same SQLite database without weakening its permissions. State is
limited to `/home/guzi/data/guzi-scholar/account` (`0700`), with `users.db` at
`0600`. The operator environment file is
`/home/guzi/config/guzi-scholar/account.env`, owned by root at `0600`. It
contains the SMTP authorization password and a separate secret used to protect
short-lived email codes. The AI credential file is
`/home/guzi/config/guzi-scholar/ai.tokens.json`, owned by `root:guzi-account`
at `0640`. Real invite codes, SMTP credentials, email-code secrets, and
provider tokens must never be stored in this repository.

Because code, configuration and data live under `/home`, every unit uses
`ProtectHome=tmpfs` and binds in only the paths it needs.

Each deployment uses the canonical
`/home/guzi/data/guzi-scholar/account/users.db` and refuses to overwrite it
from another path. The installer first creates a consistent online snapshot,
migrates a copy through schema version 6, verifies SQLite integrity, email
tables, and the user count, then stops the account and AI services and repeats
the backup and migration against the final state. The live database is
replaced only after all checks pass.

## Deployment

The Tencent Cloud security group must allow public TCP 80 and 443. The scripts
do not change Tencent Cloud console rules and do not enable UFW automatically.

Before preflight, provision the account environment and real AI profile JSON
through an approved out-of-band secret path. The account environment must keep
`MY_SCHOLAR_EMAIL_ENABLED=1` and `MY_SCHOLAR_REQUIRE_EMAIL_AUTH=1`, use `smtp.163.com:465` with
`MY_SCHOLAR_SMTP_SECURITY=ssl`, and set the SMTP authorization password and an
independent high-entropy `MY_SCHOLAR_EMAIL_CODE_SECRET`. Do not use the mailbox
login password or reuse either secret. A safe initial server-side state is
root-only; the transactional installer changes only the AI profile's group-read
bit for the service user:

```bash
ssh tencent-2 'sudo install -d -o root -g root -m 0700 /home/guzi/config/guzi-scholar'
# Transfer from the approved secret source without printing its content.
ssh tencent-2 'sudo install -o root -g root -m 0600 \
  /path/to/staged-account.env /home/guzi/config/guzi-scholar/account.env'
ssh tencent-2 'sudo install -o root -g root -m 0600 \
  /path/to/staged-ai.tokens.json /home/guzi/config/guzi-scholar/ai.tokens.json'
```

`account.env.example` and `ai.tokens.example.json` document the schemas but
contain no usable secrets. Do not substitute either example during deployment.
The systemd unit requires `/home/guzi/config/guzi-scholar/account.env` and runs
the offline `email-preflight` command before opening the database or starting
the listener. A disabled or incomplete email service, non-SSL transport, or
mismatched sender configuration therefore fails closed. The preflight does not connect to SMTP or send a message.

Run the read-only preflight first:

```bash
deploy/tencent/preflight.sh
```

After reviewing the dirty worktree and the release diff, deploy an intentional
beta build with an explicit version:

```bash
deploy/tencent/deploy.sh \
  --release-id 20260806-beta1 \
  --allow-dirty
```

A deployment enables and starts `guzi-scholar-account.service`, which serves
`/api/auth/*`. On tencent-2 that service has been stopped since 2026-09-04, so
deploying turns account registration and login back on.

`deploy.sh` refuses builds that do not expose the invitation-management
`create-invite` command. It never creates an invite automatically. After HTTPS
verification, inspect the deployed CLI and create a one-time invite explicitly:

```bash
ssh tencent-2 'sudo -u guzi-account /usr/bin/python3 -I -B \
  /home/guzi/services/guzi-scholar/current/account/user_service.py create-invite --help'
```

Use the final syntax printed by the CLI. Treat the returned plaintext invite as
a secret and deliver it through a separate channel; only its hash belongs in
SQLite.

AI is a release requirement. `verify.sh` therefore requires
`guzi-scholar-ai.service`, a loopback listener on port 8480, and `GET /health`
through `https://guzilab.com/ai/health`. There is no release-mode bypass for an
unconfigured AI gateway because the beta promises the complete feature set.

### Legacy macOS beta updates

Desktop releases are now published through GitHub Releases. The server still
serves the original 0.1.0 beta manifest under `/updates/`. When
`deploy/tencent/updates/macos/arm64/beta.json` and the matching DMG exist, a
deployment ships them and requires the download URL to be on `guzilab.com`;
otherwise the live `updates/` directory is carried into the new release
unchanged.

## Backup and restore

`guzi-scholar-account-backup.timer` creates a SQLite online backup every day,
checks `quick_check`, `foreign_key_check`, and SHA-256, keeps at least 14
backups, and removes only backups older than 30 days beyond that minimum.
Backups are kept under `/home/guzi/backups/guzi-scholar/account`, readable only
by `guzi-account`.

Every deployment also creates a root-only transactional snapshot at:

```text
/home/guzi/backups/guzi-scholar/deployments/<release-id>
```

To restore one, provide the exact snapshot id. The command asks for the id a
second time before changing the server:

```bash
deploy/tencent/rollback.sh 20260806-beta1
```

Rollback restores the account and AI units, helpers, secrets, database and the
`current` link. It never stops Caddy or changes its configuration.

Automatic rollback runs when the remote installer fails after the snapshot is
complete. A failed automatic rollback is reported prominently and retains the
snapshot for manual recovery.

## Known limits before public launch

- The six-day `guzilab.com` certificate relies on frequent automatic renewal.
  Caddy and NTP must stay healthy; certificate monitoring is still required.
- The host is shared with the other super4science.cn and guzilab.com sites. It
  suits a low-volume SQLite invitation beta, not local model inference, bulk
  PDF processing, or high concurrency.
- The personal 163 mailbox is suitable only for low-volume transactional beta
  mail. Its documented daily allowance and anti-abuse decisions are dynamic,
  and successful SMTP acceptance does not guarantee inbox delivery. Keep
  application-level cooldowns, preserve the one-time recovery-code fallback,
  and move to a domain-based transactional mail service before public scale.
- Binding internal services to loopback prevents direct exposure, but cloud
  firewall policy must still be reviewed independently.
- Backups on the same host protect against database corruption and deployment
  mistakes, not total host loss. Add encrypted off-host backup before public
  registration.
