'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const deployRoot = path.join(repoRoot, 'deploy', 'tencent');
const accountService = fs.readFileSync(path.join(desktopRoot, 'user_service.py'), 'utf8');
const scripts = [
  'deploy.sh',
  'preflight.sh',
  'rollback.sh',
  'verify.sh',
  'scripts/guzi-scholar-account-backup',
  'scripts/guzi-scholar-ai-config-verify',
  'scripts/guzi-scholar-db-verify',
  'scripts/remote-install.sh',
  'scripts/remote-rollback.sh',
];

for (const relative of scripts) {
  const absolute = path.join(deployRoot, relative);
  const result = spawnSync('/bin/bash', ['-n', absolute], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${relative} must pass bash -n: ${result.stderr}`);
}

const deploy = fs.readFileSync(path.join(deployRoot, 'deploy.sh'), 'utf8');
const preflight = fs.readFileSync(path.join(deployRoot, 'preflight.sh'), 'utf8');
const install = fs.readFileSync(path.join(deployRoot, 'scripts', 'remote-install.sh'), 'utf8');
const verify = fs.readFileSync(path.join(deployRoot, 'verify.sh'), 'utf8');
const caddy = fs.readFileSync(path.join(deployRoot, 'Caddyfile'), 'utf8');
const dbVerify = fs.readFileSync(path.join(deployRoot, 'scripts', 'guzi-scholar-db-verify'), 'utf8');
const backupScript = fs.readFileSync(path.join(deployRoot, 'scripts', 'guzi-scholar-account-backup'), 'utf8');
const accountUnit = fs.readFileSync(path.join(deployRoot, 'systemd', 'guzi-scholar-account.service'), 'utf8');
const backupUnit = fs.readFileSync(path.join(deployRoot, 'systemd', 'guzi-scholar-account-backup.service'), 'utf8');
const accountEnv = fs.readFileSync(path.join(deployRoot, 'account.env.example'), 'utf8');
const deployReadme = fs.readFileSync(path.join(deployRoot, 'README.md'), 'utf8');
const privacy = fs.readFileSync(path.join(desktopRoot, 'web', 'legal', 'privacy.html'), 'utf8');
const betaTerms = fs.readFileSync(path.join(desktopRoot, 'web', 'legal', 'beta-terms.html'), 'utf8');

assert.match(deploy, /SOURCE_DB=\nSOURCE_DB_EXPLICIT=0/u, 'deploy must resolve canonical DB before legacy DB');
assert.match(deploy, /if "\$SCRIPT_DIR\/verify\.sh"; then[\s\S]*VERIFY_STATUS=\$\?/u, 'verify failure status must survive rollback');
assert.match(deploy, /REMOTE_STAGED=1/u, 'deploy must track created remote staging');
assert.match(deploy, /warning: remote staging cleanup failed/u, 'failed deploys must clean exact remote staging paths');
assert.match(deploy, /update manifest SHA-256 does not match the built DMG/u, 'deploy must bind the manifest to the locally built DMG');
assert.match(deploy, /deployment\/updates\/macos\/arm64\/\$UPDATE_DMG_NAME" >SHA256SUMS/u, 'the transferred DMG must be covered by the deployment checksum list');
assert.match(deploy, /--allow-valid-cert-without-acme/u, 'the ACME fallback must require an explicit deployment flag');
assert.match(preflight, /ACME directory is unreachable; refusing deployment without the explicit valid-certificate fallback/u, 'ACME failure must remain fail-closed by default');
assert.match(preflight, /-checkend 432000/u, 'the explicit ACME fallback must require at least five days of certificate lifetime');
assert.match(preflight, /IP Address:\$EXPECTED_HOST/u, 'the explicit ACME fallback must require the correct IP SAN');
assert.match(install, /canonical database already exists; refusing to replace/u, 'installer must preserve the canonical DB');
assert.ok(
  install.indexOf('ai_gateway.py" probe --timeout 20') < install.indexOf('snapshot_db()'),
  'real provider probes must pass before managed deployment state changes',
);
assert.match(install, /systemctl is-active --quiet caddy\.service[\s\S]*systemctl reload caddy\.service/u, 'active Caddy must reload the new configuration');
assert.ok(
  install.indexOf('systemd-run --quiet --wait --collect --pipe') < install.indexOf('echo complete >"$SNAPSHOT/complete"'),
  'the hardened backup service must pass an isolated preflight before service switching is allowed',
);
assert.match(verify, /json\.loads\(sys\.stdin\.read\(\)\)[\s\S]*my-scholar-account/u, 'health checks must parse JSON instead of matching formatting');
assert.match(verify, /ai_gateway\.py probe --timeout 20/u, 'post-deploy verification must call both real providers');
assert.match(verify, /curl --noproxy '\*'[\s\S]*http:\/\/\$REMOTE_HOST:\$PORT\$PATHNAME/u, 'public exposure checks must perform real direct HTTP probes');
assert.match(verify, /--resolve "\$REMOTE_HOST:443:127\.0\.0\.1"[\s\S]*HTTPS_LOCAL_READY/u, 'certificate readiness must be separated from public firewall reachability');
assert.doesNotMatch(verify, /nc -z/u, 'proxy-intercepted TCP connects must not decide public exposure');
assert.match(caddy, /read_body 30s/u, 'Caddy must bound request body read time');
assert.match(caddy, /request_body \{\s*max_size 8MB/u, 'Caddy must reject oversized AI bodies at the edge');
assert.match(caddy, /default_sni 82\.156\.152\.27/u, 'literal-IP clients without SNI must receive the IP certificate');
assert.match(caddy, /log \{\s*output stdout\s*format json/u, 'Caddy access logs must go to journald through stdout');
assert.match(caddy, /handle_path \/updates\/\*[\s\S]*\/opt\/guzi-scholar\/current\/updates[\s\S]*Cache-Control "no-store"/u, 'update metadata must be served from the active immutable release without caching');
assert.doesNotMatch(caddy, /output file/u, 'Caddy validation must not create a root-owned access-log file');
assert.doesNotMatch(install, /\/var\/log\/caddy/u, 'the installer must not manage a separate Caddy log path');
assert.match(install, /updates\/macos\/arm64\/beta\.json/u, 'the immutable release must include the macOS beta update manifest');
assert.match(install, /update DMG SHA-256 mismatch/u, 'the server must verify the DMG against the manifest before switching releases');
assert.match(install, /\$UPDATE_DMG_NAME" "\$RELEASE_ROOT\/\$RELEASE_ID\/updates\/macos\/arm64\/\$UPDATE_DMG_NAME/u, 'the immutable release must include the verified DMG');
assert.match(verify, /https:\/\/\$REMOTE_HOST\/updates\/macos\/arm64\/beta\.json/u, 'deployment verification must fetch the public update manifest');
assert.match(verify, /--head --max-time 15 "\$UPDATE_DOWNLOAD_URL"/u, 'deployment verification must probe the public DMG download URL');
assert.match(verify, /-checkend 432000/u, 'post-deploy verification must preserve the five-day certificate runway');
assert.match(dbVerify, /versions != \{1, 2, 3, 4, 5, 6\}/u, 'database verification must require the current schema');
assert.match(dbVerify, /"input_units"/u, 'database verification must require persistent AI input accounting');
assert.match(dbVerify, /"email_challenges"/u, 'database verification must require email challenges');
assert.match(dbVerify, /"mail_outbox"/u, 'database verification must require the durable mail outbox');
assert.match(dbVerify, /"email",\s*"email_verified_at"/u, 'database verification must require verified user emails');
assert.match(accountUnit, /^EnvironmentFile=\/etc\/guzi-scholar\/account\.env$/mu, 'account secrets file must be mandatory');
assert.doesNotMatch(accountUnit, /^EnvironmentFile=-/mu, 'account service must not ignore a missing secrets file');
assert.match(accountService, /"email-preflight"/u, 'account CLI must expose the systemd email preflight');
assert.match(accountService, /MY_SCHOLAR_REQUIRE_EMAIL_AUTH/u, 'account service must implement a production email-auth requirement');
assert.ok(
  accountService.indexOf('if options.command == "email-preflight":') < accountService.indexOf('store = AccountStore('),
  'email preflight must return before opening or migrating the account database',
);
assert.ok(
  accountUnit.indexOf('user_service.py email-preflight') < accountUnit.indexOf('guzi-scholar-db-verify'),
  'offline email configuration must fail closed before database verification',
);
assert.match(accountEnv, /^MY_SCHOLAR_EMAIL_ENABLED=1$/mu, 'beta email verification must be enabled');
assert.match(accountEnv, /^MY_SCHOLAR_REQUIRE_EMAIL_AUTH=1$/mu, 'production beta registration must fail closed when email auth is unavailable');
assert.match(accountEnv, /^MY_SCHOLAR_SMTP_HOST=smtp\.163\.com$/mu, '163 SMTP host must be explicit');
assert.match(accountEnv, /^MY_SCHOLAR_SMTP_PORT=465$/mu, 'SMTP must use the implicit TLS port');
assert.match(accountEnv, /^MY_SCHOLAR_SMTP_SECURITY=ssl$/mu, 'SMTP must require implicit TLS');
assert.match(accountEnv, /^MY_SCHOLAR_SMTP_USERNAME=guzilab_notify@163\.com$/mu, 'SMTP auth user must be the notification mailbox');
assert.match(accountEnv, /^MY_SCHOLAR_SMTP_FROM=guzilab_notify@163\.com$/mu, 'SMTP sender must match the authenticated mailbox');
assert.match(accountEnv, /^MY_SCHOLAR_SMTP_REPLY_TO=guzilab@163\.com$/mu, 'user replies must go to the support mailbox');
assert.match(accountEnv, /^MY_SCHOLAR_SMTP_PASSWORD=$/mu, 'the SMTP authorization password must stay blank in the repository');
assert.match(accountEnv, /^MY_SCHOLAR_EMAIL_CODE_SECRET=$/mu, 'the email-code secret must stay blank in the repository');
assert.doesNotMatch(accountEnv, /STARTTLS|MY_SCHOLAR_SMTP_PORT=587/iu, 'the 163 profile must not silently fall back to STARTTLS');
assert.match(deployReadme, /email-preflight[\s\S]*does not connect to SMTP or send a message/u, 'deployment docs must explain the offline preflight boundary');
assert.match(privacy, /版本：2026-08-06-email/u, 'privacy policy must expose the current email-account version');
assert.match(privacy, /网易 163 邮箱服务/u, 'privacy policy must identify the mail processor');
assert.match(privacy, /guzilab_notify@163\.com/u, 'privacy policy must identify the notification sender');
assert.match(privacy, /guzilab@163\.com/u, 'privacy support contact must remain unchanged');
assert.match(betaTerms, /版本：2026-08-06-email/u, 'beta terms must expose the current email-account version');
assert.match(betaTerms, /经验证的本人常用邮箱/u, 'beta terms must require a verified registration email');
assert.match(betaTerms, /一次性恢复码/u, 'beta terms must preserve the recovery-code fallback');
assert.match(backupUnit, /RuntimeDirectory=guzi-scholar-account-backup/u, 'backup locks need a writable private runtime directory');
assert.match(backupUnit, /User=guzi-account[\s\S]*Group=guzi-account/u, 'backups must run as the database service account');
assert.match(backupUnit, /ReadWritePaths=.*\/var\/lib\/guzi-scholar\/account/u, 'SQLite must be able to maintain WAL metadata while backing up');
assert.match(backupUnit, /CapabilityBoundingSet=\s*$/mu, 'the backup service must not retain root capabilities');
assert.match(backupScript, /\/run\/guzi-scholar-account-backup\/backup\.lock/u, 'backup locking must stay inside the systemd runtime directory');
assert.doesNotMatch(backupUnit, /ConditionPathIsRegular/u, 'backup unit must use a systemd-supported path condition');

console.log('Tencent beta deployment script checks passed; checking release manifest.');
const updateManifest = JSON.parse(fs.readFileSync(path.join(deployRoot, 'updates', 'macos', 'arm64', 'beta.json'), 'utf8'));
assert.deepStrictEqual(
  { schema: updateManifest.schema, platform: updateManifest.platform, arch: updateManifest.arch, channel: updateManifest.channel, version: updateManifest.version },
  { schema: 1, platform: 'darwin', arch: 'arm64', channel: 'beta', version: '0.1.0' },
  'the checked-in beta manifest must match the current macOS release',
);
assert.equal(updateManifest.download_url, 'https://82.156.152.27/updates/macos/arm64/Guzi-Scholar-0.1.0-arm64.dmg', 'the beta manifest must expose the public DMG');
assert.match(updateManifest.sha256, /^[0-9a-f]{64}$/u, 'the beta manifest must publish the DMG SHA-256');
