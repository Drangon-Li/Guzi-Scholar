'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { prepareSparkle } = require('../scripts/prepare-sparkle.cjs');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const desktopRoot = path.resolve(__dirname, '..');
const sparkleRoot = path.join(desktopRoot, 'build/updater/Sparkle-2.10.1');
const expectedDigest = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27';
const root = process.argv[2] ? path.resolve(process.argv[2]) : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'guzi-updater-'));
assert(new Set([fs.realpathSync(os.tmpdir()), '/private/tmp']).has(path.dirname(root)), 'Probe root must be a direct child of the system temporary directory');
assert.match(path.basename(root), /^guzi-updater-[a-zA-Z0-9]{6,}$/u, 'Use a dedicated probe directory');
const marker = path.join(root, '.guzi-updater-probe');
if (process.env.GUZI_UPDATER_PROBE_REUSE === '1') assert.equal(fs.readFileSync(marker, 'utf8'), root, 'Owned probe root required');
else {
  if (fs.existsSync(root)) assert.equal(fs.readdirSync(root).length, 0, 'New probe directory must be empty');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, root, { mode: 0o600, flag: 'wx' });
}
const runID = path.basename(root).replace(/[^a-zA-Z0-9]/gu, '').toLowerCase();
const bundleID = `com.guzi.scholar.update-probe.${runID}`;
const product = 'Guzi 更新验证';
const installed = path.join(root, 'installed', `${product}.app`);
const executable = path.join(installed, 'Contents/MacOS', product);
const manifestPath = path.join(root, 'manifest.json');
const eventPath = path.join(root, 'events.jsonl');
const initialVersion = '0.6.2';
const targetVersion = '0.6.3';
const report = { root, bundleID, initialVersion, targetVersion, platform: process.platform, arch: process.arch, checks: [], adapter: 'production-createMacUpdater', protocol: 2 };
let server;
let currentPID;
let sequence = 0;
const children = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(file, args, options = {}) { return execFileSync(file, args, { cwd: desktopRoot, encoding: 'utf8', ...options }); }
function note(name, detail) { report.checks.push({ name, detail }); console.log(`${name}: ${JSON.stringify(detail)}`); }
function events() { return fs.existsSync(eventPath) ? fs.readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
async function until(fn, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(150); }
  throw new Error(`Timed out: ${label}`);
}
function writeJSON(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
async function command(action, extra = {}, timeout = 90000) {
  const id = `${Date.now()}-${++sequence}`;
  writeJSON(path.join(root, 'command.json'), { id, targetPID: currentPID, action, ...extra });
  const response = await until(() => events().find((event) => event.type === 'result' && event.id === id), action, timeout);
  if (response.error) throw new Error(response.error);
  return response.result;
}
async function launch() {
  const output = fs.openSync(path.join(root, 'app-output.log'), 'a', 0o600);
  const child = spawn(executable, [], { env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', output, output] });
  fs.closeSync(output);
  children.add(child.pid);
  child.on('exit', () => children.delete(child.pid));
  currentPID = child.pid;
  await until(() => events().some((event) => event.type === 'launched' && event.pid === currentPID), 'launch');
  await until(async () => { try { return (await command('status', {}, 3000)).ready; } catch (_) { return false; } }, 'renderer save hook');
  return command('status');
}
async function quit() {
  const id = `${Date.now()}-${++sequence}`;
  writeJSON(path.join(root, 'command.json'), { id, targetPID: currentPID, action: 'quit' });
  await until(() => !alive(currentPID), 'ordinary quit', 20000);
}
async function prepare() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const sparkle = await prepareSparkle({ architecture: process.arch });
  assert.equal(hash(`${sparkleRoot}.tar.xz`), expectedDigest, 'Official Sparkle archive SHA-256');
  const key = crypto.generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const keyPath = path.join(root, 'temporary-signing-key');
  fs.writeFileSync(keyPath, key.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'), { mode: 0o600 });
  const addon = sparkle.addon;
  const build = require('../package.json').build;
  const config = {
    ...build, appId: bundleID, productName: product,
    directories: { output: path.join(root, 'build') },
    afterPack: path.join(desktopRoot, 'scripts/after-pack.cjs'),
    extraMetadata: { version: initialVersion, localTestBuild: runID, main: 'electron/updater-probe-main.cjs', updaterProbe: { root, publicKey, protocol: 2 }, updater: { enabled: true, channel: 'stable', publicKey, repository: 'Drangon-Li/Guzi-Scholar' } },
    extraResources: [...build.extraResources, { from: path.join(__dirname, 'fixtures/updater-probe-main.cjs'), to: 'app/electron/updater-probe-main.cjs' }, { from: addon, to: 'sparkle-bridge.node' }],
    extraFiles: [{ from: path.join(sparkleRoot, 'Sparkle.framework'), to: 'Frameworks/Sparkle.framework' }],
    mac: { ...build.mac, identity: '-', hardenedRuntime: false, notarize: false, extendInfo: { ...build.mac.extendInfo, CFBundleDisplayName: product, CFBundleName: product, SUPublicEDKey: publicKey, SUEnableAutomaticChecks: false, SUAllowsAutomaticUpdates: false, SUAutomaticallyUpdate: false, SUVerifyUpdateBeforeExtraction: true, SUFeedURL: 'http://127.0.0.1/unused' } },
  };
  const configPath = path.join(root, 'builder.json');
  writeJSON(configPath, config);
  const buildEnvironment = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE']) delete buildEnvironment[key];
  run(path.join(desktopRoot, 'node_modules/.bin/electron-builder'), ['--config', configPath, '--mac', 'dir', '--arm64', '--publish=never'], { env: buildEnvironment, stdio: 'inherit' });
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  run('/usr/bin/ditto', [path.join(root, 'build/mac-arm64', `${product}.app`), installed]);
  const newer = path.join(root, 'new', `${product}.app`);
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  run('/usr/bin/ditto', [installed, newer]);
  const metadataPath = path.join(newer, 'Contents/Resources/app/package.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  metadata.version = targetVersion;
  writeJSON(metadataPath, metadata);
  for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) run('/usr/bin/plutil', ['-replace', key, '-string', targetVersion, path.join(newer, 'Contents/Info.plist')]);
  fs.writeFileSync(path.join(newer, 'Contents/Resources/upgrade-sentinel'), runID);
  run('/usr/bin/codesign', ['--force', '--sign', '-', newer]);
  for (const appPath of [installed, newer]) run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
  const archive = path.join(root, 'update.zip');
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', newer, archive]);
  let signature;
  try { signature = run(path.join(sparkleRoot, 'bin/sign_update'), ['--ed-key-file', keyPath, '-p', archive]).trim(); }
  finally { fs.unlinkSync(keyPath); }
  const source = { version: targetVersion, archive, signature, length: fs.statSync(archive).size, sha256: hash(archive), sha512: crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64'), protocol: 2 };
  writeJSON(path.join(root, 'source.json'), source);
  const data = path.join(root, 'user-data');
  const python = process.env.MY_SCHOLAR_BUILD_PYTHON || (fs.existsSync(path.join(desktopRoot, 'build/pyinstaller-env/bin/python3')) ? path.join(desktopRoot, 'build/pyinstaller-env/bin/python3') : 'python3');
  run(python, [path.join(__dirname, 'fixtures/seed_library.py'), path.join(data, 'library')], { stdio: 'inherit' });
  fs.mkdirSync(path.join(data, 'state'), { recursive: true });
  fs.copyFileSync(path.join(data, 'library/settings.json'), path.join(data, 'state/settings.json'));
  const { RendererStateStore } = require('../electron/renderer-state.cjs');
  const state = new RendererStateStore(path.join(data, 'state/renderer-state'));
  await state.set('my-scholar-onboarding-v2', JSON.stringify({ version: 2, action: 'completed' }));
  note('isolated-build', { root, bundleID, publicKey, archiveBytes: source.length, adHoc: true, notarized: false });
  return source;
}
async function startSource(source) {
  server = http.createServer((request, response) => {
    if (request.url === '/update.zip') {
      const active = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': active.length });
      fs.createReadStream(active.archive).pipe(response); return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(source, { downloadURL: `${base}/update.zip` });
  writeJSON(manifestPath, source);
}
async function verify(source) {
  const data = path.join(root, 'user-data');
  const job = fs.readdirSync(path.join(data, 'library/jobs')).find((name) => /^[a-f0-9]{16}$/u.test(name));
  assert(job, 'Seeded document');
  const document = path.join(data, 'library/jobs', job, 'source.pdf');
  const documentHash = hash(document);
  const first = await launch();
  assert.equal(first.version, initialVersion);
  assert.equal(first.userData, data);
  const waitIdle = async () => until(async () => {
    const readiness = await command('eval', { code: "fetch('/api/health').then(response => response.json()).then(health => health.storage.migration)" });
    return readiness.ready;
  }, 'backend idle');
  await waitIdle();
  const found = await command('discover');
  assert.equal(found.version, targetVersion);
  assert.equal(found.status, 'available');
  assert.equal((await command('stage')).status, 'ready');
  const cached = await command('cached');
  assert.equal(cached.sha256, source.sha256);
  assert.equal(cached.sha512, source.sha512);
  assert(!events().some((event) => event.type === 'sparkle'), 'Production staging does not initialize Sparkle');
  note('discover-download', { found, cached });
  note('update-settings-screenshot', await command('capture'));
  const injectFailure = `window.__probeFetch = window.fetch; window.fetch = (url, options) => String(url).endsWith('/api/settings') && ['POST', 'PUT'].includes(options?.method) ? Promise.resolve(new Response(JSON.stringify({error:'probe save failure'}), {status:507, headers:{'Content-Type':'application/json'}})) : window.__probeFetch(url, options); const control = document.querySelector('#setting-app-font'); control.selectedIndex = (control.selectedIndex + 1) % control.options.length; control.dispatchEvent(new Event('change', {bubbles:true})); true;`;
  await command('eval', { code: injectFailure });
  const cancelled = await command('install', { dialogResponse: 1 });
  assert.equal(cancelled.status, 'ready');
  assert.match(cancelled.error, /取消/u);
  assert.equal((await command('status')).frozen, false);
  assert(!events().some((event) => event.type === 'install-authorized'));
  assert(events().some((event) => event.type === 'dialog' && event.title === '安装更新并重新启动' && event.response === 0), 'The production install confirmation was accepted');
  assert(events().some((event) => event.type === 'dialog' && event.title === '改动尚未保存' && event.response === 1), 'The production save failure dialog was cancelled');
  note('save-cancel-blocks-install', cancelled);
  await command('eval', { code: 'window.fetch = window.__probeFetch; delete window.__probeFetch; (async () => { const saved = await window.__myScholarFlushBeforeClose(); window.__myScholarResumeAfterClose(); return saved; })()' });
  const settingsPath = path.join(data, 'state/settings.json');
  assert(fs.existsSync(settingsPath));
  await quit();
  assert.equal(run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(installed, 'Contents/Info.plist')]).trim(), initialVersion);
  const restarted = await launch();
  assert.equal(restarted.version, initialVersion);
  assert.equal(restarted.update.status, 'ready', 'Production adapter restores verified cached update after restart');
  note('ordinary-quit-does-not-install', { version: restarted.version, executable: restarted.executable });
  const settingsHash = hash(settingsPath);
  const noteText = 'Upgrade verification: preserve this note.\n';
  const notesPath = path.join(data, 'library/jobs', job, 'notes.md');
  fs.writeFileSync(notesPath, noteText);
  for (const variant of ['wrong-signature', 'corrupt-archive']) {
    const eventStart = events().length;
    const modified = { ...source };
    if (variant === 'wrong-signature') modified.signature = crypto.randomBytes(64).toString('base64');
    else {
      modified.archive = path.join(root, 'corrupt.zip');
      const bytes = fs.readFileSync(source.archive);
      bytes[Math.floor(bytes.length / 2)] ^= 1;
      fs.writeFileSync(modified.archive, bytes);
      // Keep trusted release digests and invalidate prior valid caches to exercise the network verifier.
      const cache = path.join(data, 'updates', 'stable');
      for (const entry of fs.readdirSync(cache)) if (entry.endsWith('.zip')) fs.writeFileSync(path.join(cache, entry), Buffer.from('damaged cache'));
    }
    writeJSON(manifestPath, modified);
    await command('discover');
    const staged = await command('stage');
    await waitIdle();
    const rejected = variant === 'wrong-signature' ? await command('install', {}, 150000) : staged;
    assert(rejected.error, 'Invalid update must report a recoverable error');
    const nativeEvents = events().slice(eventStart).filter((event) => event.type === 'sparkle').map((event) => event.event);
    let validationError;
    if (variant === 'wrong-signature') {
      assert.equal(staged.status, 'ready');
      assert(nativeEvents.some((event) => event.type === 'available'), 'Sparkle discovered the prepared candidate');
      validationError = nativeEvents.find((event) => event.type === 'error' && event.domain === 'SUSparkleErrorDomain');
      assert(validationError, `Expected Sparkle signature validation failure: ${JSON.stringify(nativeEvents)}`);
      assert(!nativeEvents.some((event) => event.type === 'ready'), 'Invalid signature cannot reach installation readiness');
    } else {
      assert.equal(staged.status, 'available');
      assert.equal(staged.canInstall, false);
      assert.equal(nativeEvents.length, 0, 'Corrupt download is rejected before Sparkle starts');
      assert(!events().slice(eventStart).some((event) => event.type === 'install-authorized'));
    }
    assert.equal(run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(installed, 'Contents/Info.plist')]).trim(), initialVersion);
    await until(async () => (await command('status')).ready, 'renderer restored after rejection');
    assert.equal((await command('status')).version, initialVersion);
    assert.equal((await command('status')).frozen, false);
    note(variant, { rejected, validationError });
  }
  writeJSON(manifestPath, source);
  await command('discover');
  assert.equal((await command('stage')).status, 'ready');
  await waitIdle();
  const previousPID = currentPID;
  const id = `${Date.now()}-${++sequence}`;
  writeJSON(path.join(root, 'command.json'), { id, targetPID: currentPID, action: 'install' });
  const relaunched = await until(() => events().find((event) => event.type === 'launched' && event.version === targetVersion), 'Sparkle replacement and relaunch', 180000);
  currentPID = relaunched.pid;
  children.add(currentPID);
  await until(async () => { try { return (await command('status', {}, 3000)).ready; } catch (_) { return false; } }, 'updated renderer');
  assert.equal(relaunched.executable, executable);
  assert.equal(relaunched.userData, data);
  assert.equal(hash(document), documentHash);
  assert.equal(hash(settingsPath), settingsHash);
  assert.equal(fs.readFileSync(notesPath, 'utf8'), noteText);
  assert.equal(fs.readFileSync(path.join(installed, 'Contents/Resources/upgrade-sentinel'), 'utf8'), runID);
  assert(!alive(previousPID));
  note('real-upgrade-and-relaunch', { from: initialVersion, to: targetVersion, previousPID, currentPID, executable, documentHash, settingsHash, notesPreserved: true });
  await quit();
}
async function performCleanup() {
  server?.close();
  const ownedProcesses = () => run('/bin/ps', ['-axo', 'pid=,command=']).split('\n').map((row) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(row);
    return match ? { pid: Number(match[1]), command: match[2] } : null;
  }).filter((row) => row && row.pid !== process.pid && (
    row.command.startsWith(`${root}/`) && /\/Contents\/(?:MacOS\/|Resources\/python-server\/)/u.test(row.command)
    || row.command.includes(`/${bundleID}/`) && /\/Autoupdate(?:\s|$)|\/Updater\.app\//u.test(row.command)
  ));
  assert.equal(fs.readFileSync(marker, 'utf8'), root, 'Cleanup requires the ownership marker');
  report.cleanupProcesses = ownedProcesses();
  for (const row of report.cleanupProcesses) children.add(row.pid);
  for (const pid of children) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
  await delay(1000);
  for (const pid of children) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  await delay(1000);
  report.remainingProcesses = ownedProcesses();
  if (fs.existsSync(path.join(root, 'temporary-signing-key'))) fs.unlinkSync(path.join(root, 'temporary-signing-key'));
  writeJSON(path.join(root, 'report.json'), report);
  assert.equal(report.remainingProcesses.length, 0, 'All isolated test processes stopped');
}
let cleanupPromise;
function cleanup() { cleanupPromise ||= performCleanup(); return cleanupPromise; }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.error = `Acceptance interrupted by ${signal}`;
  cleanup().then(() => process.exit(1), (error) => { console.error(error); process.exit(1); });
});
(async () => {
  try {
    if (process.env.GUZI_UPDATER_PROBE_REUSE === '1') {
      if (fs.existsSync(eventPath)) fs.renameSync(eventPath, path.join(root, `events-${Date.now()}.jsonl`));
      report.reusedArchive = true;
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'source.json'), 'utf8')).protocol, 2, 'Reuse only a production-adapter fixture archive');
      const previous = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
      assert.deepEqual(previous.remainingProcesses, [], 'Only replay a fully cleaned isolated acceptance');
      assert.equal(fs.readFileSync(marker, 'utf8'), root, 'Replay requires the owned test root');
      fs.renameSync(installed, path.join(root, `previous-installed-${Date.now()}.app`));
      run('/usr/bin/ditto', [path.join(root, 'build/mac-arm64', `${product}.app`), installed]);
    }
    const source = process.env.GUZI_UPDATER_PROBE_REUSE === '1' ? JSON.parse(fs.readFileSync(path.join(root, 'source.json'), 'utf8')) : await prepare();
    await startSource(source);
    await verify(source);
    report.passed = true;
  } catch (error) { report.error = error.stack || String(error); throw error; }
  finally { await cleanup(); console.log(`Evidence: ${path.join(root, 'report.json')}`); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
