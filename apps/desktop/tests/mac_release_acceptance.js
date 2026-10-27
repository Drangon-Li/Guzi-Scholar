'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { REPOSITORY, identity, acceptance, prepare, ACCEPTANCE_CHECKS } = require('../scripts/release-pipeline.cjs');
const { compareVersions, versionChannel, validateReleaseManifest } = require('../electron/update-service.cjs');
const desktopRoot = path.resolve(__dirname, '..');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = (file) => digest(fs.readFileSync(file));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: desktopRoot, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options });
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function previousVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/u.exec(version);
  assert(match, 'Supported release version required');
  const numbers = match.slice(1, 4).map(Number);
  if (match[4] && Number(match[4]) > 0) return `${numbers.join('.')}-beta.${Number(match[4]) - 1}`;
  let index = 2;
  while (index >= 0 && numbers[index] === 0) index--;
  assert(index >= 0, 'Cannot construct an older version for 0.0.0');
  numbers[index]--;
  for (let position = index + 1; position < numbers.length; position++) numbers[position] = 0;
  return `${numbers.join('.')}${match[4] !== undefined ? '-beta.0' : ''}`;
}
function assertCIEnvironment(env = process.env, platform = process.platform, arch = process.arch) {
  assert.equal(platform, 'darwin', 'Real acceptance requires macOS');
  assert.equal(arch, 'arm64', 'Real acceptance requires native arm64');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Formal App ID may only run in GitHub Actions');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'Disposable GitHub-hosted VM required');
  assert.equal(env.RUNNER_OS, 'macOS');
  assert.equal(env.RUNNER_ARCH, 'ARM64');
  assert(path.isAbsolute(env.RUNNER_TEMP || ''), 'RUNNER_TEMP is required');
  for (const name of ['MY_SCHOLAR_DATA_DIR', 'MY_SCHOLAR_LIBRARY_DIR', 'MY_SCHOLAR_SERVER_EXECUTABLE']) assert(!env[name], `Production path override is forbidden: ${name}`);
}
function verifyCandidateDirectory(directory, context, publicKey) {
  assert.equal(context.schema, 1);
  assert.equal(context.repository, REPOSITORY);
  assert.match(context.commit, /^[a-f0-9]{40}$/u);
  assert.equal(identity(context.tag, context.version), context.channel);
  assert.equal(Buffer.from(publicKey || '', 'base64').length, 32, 'Pinned Sparkle public key required');
  assert.equal(Buffer.from(publicKey, 'base64').toString('base64'), publicKey);
  const sums = new Map();
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
    assert(match && !sums.has(match[2]), 'Invalid or duplicate SHA256SUMS entry');
    const asset = path.join(directory, match[2]);
    assert(fs.lstatSync(asset).isFile() && !fs.lstatSync(asset).isSymbolicLink(), 'Regular candidate files required');
    assert.equal(hash(asset), match[1], `Candidate checksum: ${match[2]}`);
    sums.set(match[2], match[1]);
  }
  for (const name of ['update-manifest.json', 'release-provenance.json']) assert(sums.has(name), `Checksummed ${name} required`);
  const provenance = json(path.join(directory, 'release-provenance.json'));
  for (const name of ['repository', 'tag', 'commit', 'version', 'channel']) assert.equal(provenance[name], context[name], `Provenance ${name}`);
  assert.equal(provenance.sparkle_public_key, publicKey, 'Candidate key must equal pinned application key');
  for (const asset of provenance.assets) {
    assert.equal(sums.get(asset.name), asset.sha256, 'Provenance checksum mismatch');
    assert.equal(fs.statSync(path.join(directory, asset.name)).size, asset.size, 'Provenance size mismatch');
  }
  const manifest = json(path.join(directory, 'update-manifest.json'));
  assert.equal(manifest.version, context.version);
  assert.equal(manifest.channel, context.channel);
  const release = { tag_name: context.tag, draft: false, prerelease: context.channel === 'beta', assets: manifest.artifacts.map((item) => ({ name: item.name, state: 'uploaded', size: item.size, browser_download_url: item.url })) };
  const candidate = validateReleaseManifest(manifest, { platform: 'darwin', arch: 'arm64', channel: context.channel, release });
  assert.equal(candidate.assetName, `Guzi-Scholar-${context.version}-arm64-${context.channel}.zip`);
  assert.equal(sums.get(candidate.assetName), candidate.sha256);
  const archive = path.join(directory, candidate.assetName);
  const bytes = fs.readFileSync(archive);
  assert.equal(bytes.length, candidate.size);
  assert.equal(crypto.createHash('sha512').update(bytes).digest('base64'), candidate.sha512);
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
  assert(crypto.verify(null, bytes, key, Buffer.from(candidate.edSignature, 'base64')), 'Published Ed25519 signature must verify the original candidate ZIP');
  assert([...sums.keys()].some((name) => name === `Guzi-Scholar-${context.version}-arm64-${context.channel}.dmg`), 'Matching candidate DMG required');
  return { candidate, archive, manifest, checksums: Object.fromEntries(sums) };
}
function tree(directory) {
  const entries = [];
  function visit(relative) {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const entry = path.join(relative, name), file = path.join(directory, entry), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) entries.push([entry, 'link', fs.readlinkSync(file)]);
      else if (stat.isDirectory()) { entries.push([entry, 'directory']); visit(entry); }
      else { assert(stat.isFile()); entries.push([entry, 'file', hash(file), stat.mode & 0o111]); }
    }
  }
  visit('');
  return digest(JSON.stringify(entries));
}
function processes() {
  return run('/bin/ps', ['-axo', 'pid=,ppid=,command=']).trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
async function until(predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await delay(200); }
  throw new Error(`Timed out: ${label}`);
}

function assertMainProcessHealthy(events) {
  const errors = events.filter((event) => event.type === 'main-process-error');
  assert.deepEqual(errors, [], 'Main process exceptions must fail release acceptance');
}

async function execute({ directory, contextFile, output }) {
  assertCIEnvironment();
  const context = json(contextFile);
  const source = verifyCandidateDirectory(directory, context, process.env.SPARKLE_PUBLIC_KEY);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.RUNNER_TEMP), 'guzi-release-acceptance-'));
  const eventPath = path.join(root, 'events.jsonl');
  const product = context.channel === 'beta' ? '谷子学术测试版' : '谷子学术';
  const bundleID = context.channel === 'beta' ? 'com.guzi.scholar.beta' : 'com.guzi.scholar';
  const installed = path.join(os.homedir(), 'Applications', `${product}.app`);
  const fromVersion = previousVersion(context.version);
  assert.equal(versionChannel(fromVersion), context.channel);
  assert(compareVersions(fromVersion, context.version) < 0);
  const report = { schema: 1, ...context, platform: 'darwin', arch: 'arm64', artifact_sha256: source.candidate.sha256, from_version: fromVersion, to_version: context.version, environment: `GitHub-hosted disposable ${os.release()} arm64 VM; run ${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}; production bundle ID and userData`, checks: {}, passed: false, evidence: { root, bundleID, installed, target_archive: source.candidate.assetName, target_ed_signature: source.candidate.edSignature, public_key: process.env.SPARKLE_PUBLIC_KEY, old_fixture: 'candidate-derived version downgrade; fixture only in old app', discovery: 'production release parser over mirrored candidate metadata', download: 'production checksum verifier over exact candidate ZIP served on loopback' } };
  const baselinePIDs = new Set(processes().map((item) => item.pid));
  const children = new Set();
  const childExits = new Map();
  let currentPID, data, server, appLog, sequence = 0, installOwned = false;
  let active = { archive: source.archive, signature: source.candidate.edSignature };
  const events = () => fs.existsSync(eventPath) ? fs.readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const plist = (app, key) => run('/usr/bin/plutil', ['-extract', key, 'raw', path.join(app, 'Contents/Info.plist')]).trim();
  const executable = () => path.join(installed, 'Contents/MacOS', plist(installed, 'CFBundleExecutable'));
  const setSource = (value) => { active = value; writeJSON(path.join(root, 'manifest.json'), value); };
  async function command(action, extra = {}, timeout = 90000) {
    const id = `${Date.now()}-${++sequence}`;
    writeJSON(path.join(root, 'command.json'), { id, targetPID: currentPID, action, ...extra });
    const response = await until(() => events().find((event) => event.type === 'result' && event.id === id), action, timeout);
    assert(!response.error, response.error);
    return response.result;
  }
  async function launch() {
    const fd = fs.openSync(path.join(root, 'app-output.log'), 'a', 0o600);
    const child = spawn(executable(), [], { env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    currentPID = child.pid;
    child.once('exit', (code, signal) => childExits.set(child.pid, { code, signal }));
    children.add(currentPID);
    await until(() => events().some((event) => event.type === 'launched' && event.pid === currentPID), 'old app launch');
    await until(async () => { try { return (await command('status', {}, 3000)).ready; } catch (_) { return false; } }, 'production renderer save gate');
    return command('status');
  }
  async function quit() {
    writeJSON(path.join(root, 'command.json'), { id: `${Date.now()}-${++sequence}`, targetPID: currentPID, action: 'quit' });
    await until(() => !alive(currentPID) && childExits.has(currentPID), 'ordinary quit', 30000);
    assert.deepEqual(childExits.get(currentPID), { code: 0, signal: null }, 'Ordinary quit must exit successfully');
    assertMainProcessHealthy(events());
    assert(events().some((event) => event.type === 'will-quit' && event.pid === currentPID), 'Production will-quit must complete');
  }
  const waitIdle = () => until(async () => {
    const state = await command('eval', { code: "fetch('/api/health').then(response => response.json()).then(health => health.storage.migration)" });
    return state.ready;
  }, 'backend idle');
  const check = (name, detail) => { report.checks[name] = true; report.evidence[name] = detail; console.log(`${name}: ${JSON.stringify(detail)}`); };
  let cleaning;
  async function cleanup() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      server?.close();
      const owned = () => {
        const rows = processes();
        let changed = true;
        while (changed) {
          changed = false;
          for (const item of rows) if (children.has(item.ppid) && !children.has(item.pid)) { children.add(item.pid); changed = true; }
        }
        return rows.filter((item) => item.pid !== process.pid && !baselinePIDs.has(item.pid) && (children.has(item.pid) || installOwned && item.command.startsWith(`${installed}/Contents/`) || item.command.startsWith(`${root}/`) || item.command.includes(`/${bundleID}/`) && /\/Autoupdate(?:\s|$)|\/Updater\.app\//u.test(item.command)));
      };
      report.evidence.cleanup_processes = owned();
      for (const item of report.evidence.cleanup_processes) { children.add(item.pid); try { process.kill(item.pid, 'SIGTERM'); } catch (_) {} }
      await delay(1000);
      for (const item of owned()) { try { process.kill(item.pid, 'SIGKILL'); } catch (_) {} }
      await delay(1000);
      report.evidence.remaining_processes = owned();
      assert.equal(report.evidence.remaining_processes.length, 0, 'All test-owned app, backend and Sparkle processes must exit');
    })();
    return cleaning;
  }
  const onSignal = () => { report.passed = false; report.error = 'Acceptance interrupted'; cleanup().finally(() => { writeJSON(output, report); process.exit(1); }); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
  try {
    assert(!fs.existsSync(installed), 'Refusing to replace an existing application');
    for (const name of [product, 'my-scholar', 'GuziScholar-Beta']) assert(!fs.existsSync(path.join(os.homedir(), 'Library/Application Support', name)), `VM has existing production data: ${name}`);
    assert(!processes().some((item) => item.command.includes(`/${product}.app/Contents/`) || item.command.includes(`/${bundleID}/`)), 'VM has a running production application');
    const extracted = path.join(root, 'original');
    fs.mkdirSync(extracted);
    run('/usr/bin/ditto', ['-x', '-k', source.archive, extracted]);
    const apps = fs.readdirSync(extracted).filter((name) => name.endsWith('.app'));
    assert.deepEqual(apps, [`${product}.app`]);
    const original = path.join(extracted, apps[0]);
    const originalMetadata = json(path.join(original, 'Contents/Resources/app/package.json'));
    assert.equal(originalMetadata.main, 'electron/main.cjs');
    assert.equal(originalMetadata.version, context.version);
    assert(!originalMetadata.localTestBuild && !originalMetadata.macReleaseAcceptance && !originalMetadata.updaterProbe);
    assert.equal(originalMetadata.updater.channel, context.channel);
    assert.equal(originalMetadata.updater.enabled, true);
    assert.equal(originalMetadata.updater.repository, REPOSITORY);
    assert.equal(originalMetadata.updater.publicKey, process.env.SPARKLE_PUBLIC_KEY);
    assert.equal(plist(original, 'CFBundleIdentifier'), bundleID);
    assert.equal(plist(original, 'CFBundleShortVersionString'), context.version);
    assert.equal(plist(original, 'SUPublicEDKey'), process.env.SPARKLE_PUBLIC_KEY);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', original]);
    report.evidence.original_bundle_sha256 = tree(original);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    run('/usr/bin/ditto', [original, installed]);
    installOwned = true;
    const metadataFile = path.join(installed, 'Contents/Resources/app/package.json');
    writeJSON(metadataFile, { ...originalMetadata, version: fromVersion, main: 'electron/mac-release-acceptance-main.cjs', macReleaseAcceptance: { protocol: 1, root, bundleID } });
    fs.copyFileSync(path.join(__dirname, 'fixtures/mac-release-acceptance-main.cjs'), path.join(installed, 'Contents/Resources/app/electron/mac-release-acceptance-main.cjs'));
    for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) run('/usr/bin/plutil', ['-replace', key, '-string', fromVersion, path.join(installed, 'Contents/Info.plist')]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', installed]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    writeJSON(path.join(root, 'update-manifest.json'), source.manifest);
    server = http.createServer((request, response) => {
      if (request.url !== '/candidate.zip') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(active.archive).size });
      const stream = fs.createReadStream(active.archive);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const valid = { ...active, downloadURL: `http://127.0.0.1:${server.address().port}/candidate.zip` };
    setSource(valid);
    const bootstrap = await launch();
    data = bootstrap.userData;
    assert(path.isAbsolute(bootstrap.logs), 'Production log directory must come from the running old app');
    appLog = path.join(bootstrap.logs, 'my-scholar-electron.log');
    assert(path.dirname(data) === path.join(os.homedir(), 'Library/Application Support'), 'Production userData must use the normal Application Support directory');
    if (context.channel === 'beta') assert.equal(path.basename(data), 'GuziScholar-Beta');
    else assert([product, originalMetadata.name].includes(path.basename(data)), 'Stable app must use its original Electron userData path');
    report.evidence.user_data = data;
    await quit();
    run(process.env.MY_SCHOLAR_TEST_PYTHON || 'python3', [path.join(__dirname, 'fixtures/seed_library.py'), path.join(data, 'library')]);
    fs.mkdirSync(path.join(data, 'state'), { recursive: true });
    fs.copyFileSync(path.join(data, 'library/settings.json'), path.join(data, 'state/settings.json'));
    const { RendererStateStore } = require('../electron/renderer-state.cjs');
    await new RendererStateStore(path.join(data, 'state/renderer-state')).set('my-scholar-onboarding-v2', JSON.stringify({ version: 2, action: 'completed' }));
    const first = await launch();
    assert.equal(first.version, fromVersion);
    assert.equal(first.userData, data);
    await waitIdle();
    const discovered = await command('discover');
    assert.equal(discovered.version, context.version);
    assert.equal(discovered.status, 'available');
    check('discover', discovered);
    assert.equal((await command('stage')).status, 'ready');
    const cached = await command('cached');
    assert.equal(cached.sha256, source.candidate.sha256);
    assert.equal(cached.edSignature, source.candidate.edSignature);
    assert(!events().some((event) => event.type === 'sparkle'));
    check('download', { sha256: cached.sha256, ed_signature: cached.edSignature });
    await command('capture');
    await command('eval', { code: "window.__acceptanceFetch = window.fetch; window.fetch = (url, options) => String(url).endsWith('/api/settings') && ['POST', 'PUT'].includes(options?.method) ? Promise.resolve(new Response(JSON.stringify({error:'acceptance save failure'}), {status:507, headers:{'Content-Type':'application/json'}})) : window.__acceptanceFetch(url, options); const control = document.querySelector('#setting-app-font'); control.selectedIndex = (control.selectedIndex + 1) % control.options.length; control.dispatchEvent(new Event('change', {bubbles:true})); true;" });
    const cancelled = await command('install', { dialogResponse: 1 });
    assert.equal(cancelled.status, 'ready');
    assert.match(cancelled.error, /取消/u);
    assert.equal((await command('status')).frozen, false);
    assert(!events().some((event) => event.type === 'install-authorized'));
    assert(events().some((event) => event.type === 'dialog' && event.title === '改动尚未保存' && event.response === 1));
    check('save_cancel', cancelled);
    await command('eval', { code: 'window.fetch = window.__acceptanceFetch; delete window.__acceptanceFetch; (async () => { const saved = await window.__myScholarFlushBeforeClose(); window.__myScholarResumeAfterClose(); return saved; })()' });
    await quit();
    assert.equal(plist(installed, 'CFBundleShortVersionString'), fromVersion);
    const restarted = await launch();
    assert.equal(restarted.version, fromVersion);
    assert.equal(restarted.update.status, 'ready');
    check('ordinary_quit', { version: restarted.version, cached_update: restarted.update.status, clean_main_exit: true });
    for (const variant of ['bad_signature', 'corrupt_archive']) {
      const offset = events().length;
      const modified = { ...valid };
      if (variant === 'bad_signature') modified.signature = Buffer.alloc(64, 1).toString('base64');
      else {
        modified.archive = path.join(root, 'corrupt.zip');
        const bytes = fs.readFileSync(source.archive); bytes[Math.floor(bytes.length / 2)] ^= 1; fs.writeFileSync(modified.archive, bytes);
        const cache = path.join(data, 'updates', context.channel);
        for (const name of fs.readdirSync(cache)) if (name.endsWith('.zip')) fs.writeFileSync(path.join(cache, name), 'invalid cache');
      }
      setSource(modified);
      await command('discover');
      const staged = await command('stage');
      await waitIdle();
      const rejected = variant === 'bad_signature' ? await command('install', {}, 180000) : staged;
      assert(rejected.error, 'Invalid candidate must report an error');
      const native = events().slice(offset).filter((event) => event.type === 'sparkle').map((event) => event.event);
      if (variant === 'bad_signature') {
        assert.equal(staged.status, 'ready');
        assert(native.some((event) => event.type === 'available'));
        assert(native.some((event) => event.type === 'error' && event.domain === 'SUSparkleErrorDomain'));
        assert(!native.some((event) => event.type === 'ready'));
      } else {
        assert.equal(staged.canInstall, false);
        assert.equal(native.length, 0);
        assert(!events().slice(offset).some((event) => event.type === 'install-authorized'));
      }
      assert.equal(plist(installed, 'CFBundleShortVersionString'), fromVersion);
      await until(async () => (await command('status')).ready, 'renderer restored after rejection');
      assert.equal((await command('status')).frozen, false);
      check(variant === 'bad_signature' ? 'bad_signature_rejected' : 'corrupt_rejected', { state: rejected, native });
    }
    setSource(valid);
    await command('discover');
    assert.equal((await command('stage')).status, 'ready');
    await waitIdle();
    const job = fs.readdirSync(path.join(data, 'library/jobs')).find((name) => /^[a-f0-9]{16}$/u.test(name));
    assert(job, 'Seeded production document required');
    const notes = path.join(data, 'library/jobs', job, 'notes.md');
    fs.writeFileSync(notes, 'Formal candidate upgrade: preserve this note.\n');
    const preserved = [path.join(data, 'state/settings.json'), path.join(data, 'library/library.json'), path.join(data, 'library/jobs', job, 'source.pdf'), notes];
    const hashes = Object.fromEntries(preserved.map((file) => [path.relative(data, file), hash(file)]));
    const previousPID = currentPID;
    writeJSON(path.join(root, 'command.json'), { id: `${Date.now()}-${++sequence}`, targetPID: currentPID, action: 'install' });
    await until(() => !alive(previousPID), 'old application exit for Sparkle install', 180000);
    const targetExecutable = executable();
    const target = await until(() => processes().find((item) => item.pid !== previousPID && (item.command === targetExecutable || item.command.startsWith(`${targetExecutable} `))), 'external observation of target relaunch', 180000);
    children.add(target.pid);
    currentPID = target.pid;
    assert.equal(plist(installed, 'CFBundleShortVersionString'), context.version);
    assert.equal(plist(installed, 'CFBundleIdentifier'), bundleID);
    assert.equal(plist(installed, 'SUPublicEDKey'), process.env.SPARKLE_PUBLIC_KEY);
    assert.equal(tree(installed), report.evidence.original_bundle_sha256, 'Installed app must equal the untouched original ZIP contents');
    assert(!fs.existsSync(path.join(installed, 'Contents/Resources/app/electron/mac-release-acceptance-main.cjs')), 'Target cannot contain the old fixture');
    assert.equal(json(path.join(installed, 'Contents/Resources/app/package.json')).main, 'electron/main.cjs');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    const opened = run('/usr/sbin/lsof', ['-p', String(target.pid), '-Fn']);
    assert(opened.split('\n').includes(`n${executable()}`), 'Relaunched process must execute the original installed binary');
    const startup = await until(() => {
      const rows = processes();
      const backend = rows.find((item) => item.ppid === target.pid && item.command.startsWith(path.join(installed, 'Contents/Resources/python-server/')));
      const renderer = rows.find((item) => item.ppid === target.pid && item.command.includes('--type=renderer'));
      const readyMarker = ` window-ready pid=${target.pid} version=${context.version}`;
      const windowReady = fs.existsSync(appLog) && fs.readFileSync(appLog, 'utf8').split('\n').find((line) => line.endsWith(readyMarker));
      return alive(target.pid) && backend && renderer && windowReady ? { backend, renderer, window_ready: windowReady, diagnostic_log: appLog } : null;
    }, 'unmodified target backend and renderer startup', 90000);
    check('relaunch', { previous_pid: previousPID, pid: target.pid, executable: executable(), version: context.version, bundle_sha256: tree(installed), startup });
    for (const [file, expected] of Object.entries(hashes)) assert.equal(hash(path.join(data, file)), expected, `Production data preserved: ${file}`);
    const openedData = run('/usr/sbin/lsof', ['-p', String(target.pid), '-Fn']);
    assert(openedData.split('\n').some((line) => line.startsWith(`n${data}/`)), 'Original target must open the production userData directory');
    check('data_preserved', hashes);
    verifyCandidateDirectory(directory, context, process.env.SPARKLE_PUBLIC_KEY);
    assertMainProcessHealthy(events());
    report.evidence.main_process_errors = events().filter((event) => event.type === 'main-process-error');
    for (const name of ACCEPTANCE_CHECKS) assert.equal(report.checks[name], true);
    report.passed = true;
    acceptance(report, context, source.manifest.artifacts.find((item) => item.platform === 'darwin'));
  } catch (error) {
    report.passed = false;
    report.error = error.stack || String(error);
    throw error;
  } finally {
    try { await cleanup(); } catch (error) { report.passed = false; report.cleanup_error = error.stack || String(error); process.exitCode = 1; }
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
    writeJSON(output, report);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    for (const [from, to] of [['events.jsonl', 'macos-events.jsonl'], ['app-output.log', 'macos-app.log'], ['update-settings.png', 'macos-update-settings.png']]) if (fs.existsSync(path.join(root, from))) fs.copyFileSync(path.join(root, from), path.join(path.dirname(output), to));
    if (appLog && fs.existsSync(appLog)) fs.copyFileSync(appLog, path.join(path.dirname(output), 'macos-electron.log'));
    console.log(`macOS acceptance report: ${output}`);
  }
}

function checkContract() {
  assert.doesNotThrow(() => assertMainProcessHealthy([{ type: 'will-quit' }]));
  assert.throws(() => assertMainProcessHealthy([{ type: 'main-process-error', origin: 'uncaughtException', error: 'ReferenceError: updater is not defined' }]), /Main process exceptions/u);
  assert.equal(previousVersion('0.6.3'), '0.6.2');
  assert.equal(previousVersion('0.6.3-beta.2'), '0.6.3-beta.1');
  assert.equal(previousVersion('0.6.3-beta.0'), '0.6.2-beta.0');
  assert.equal(previousVersion('1.0.0'), '0.0.0');
  assert.throws(() => previousVersion('0.0.0'));
  assert.throws(() => assertCIEnvironment({}, 'darwin', 'arm64'), /GitHub Actions/u);
  assert.throws(() => assertCIEnvironment({ GITHUB_ACTIONS: 'true' }, 'darwin', 'arm64'), /GitHub-hosted/u);
  assertCIEnvironment({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', RUNNER_TEMP: '/tmp/runner' }, 'darwin', 'arm64');
  assert.throws(() => assertCIEnvironment({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', RUNNER_TEMP: '/tmp/runner', MY_SCHOLAR_DATA_DIR: '/tmp/data' }, 'darwin', 'arm64'), /override/u);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-release-contract-'));
  try {
    const context = { schema: 1, repository: REPOSITORY, tag: 'v0.6.3', version: '0.6.3', channel: 'stable', commit: 'a'.repeat(40) };
    const archiveName = 'Guzi-Scholar-0.6.3-arm64-stable.zip';
    const bytes = Buffer.from('Synthetic contract archive; never installed');
    const key = crypto.generateKeyPairSync('ed25519');
    const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
    const signature = crypto.sign(null, bytes, key.privateKey).toString('base64');
    fs.writeFileSync(path.join(directory, archiveName), bytes);
    fs.writeFileSync(path.join(directory, 'Guzi-Scholar-0.6.3-arm64-stable.dmg'), 'contract DMG');
    prepare(directory, context, { name: archiveName, public_key: publicKey, ed_signature: signature });
    const source = verifyCandidateDirectory(directory, context, publicKey);
    assert.equal(source.candidate.sha256, digest(bytes));
    const contractReport = { ...context, schema: 1, passed: true, platform: 'darwin', arch: 'arm64', from_version: '0.6.2', to_version: context.version, artifact_sha256: digest(bytes), environment: 'Synthetic contract check, not an upgrade report', checks: Object.fromEntries(ACCEPTANCE_CHECKS.map((name) => [name, true])) };
    acceptance(contractReport, context, source.manifest.artifacts[0]);
    assert.throws(() => verifyCandidateDirectory(directory, { ...context, commit: 'b'.repeat(40) }, publicKey), /Provenance commit/u);
    assert.throws(() => verifyCandidateDirectory(directory, context, Buffer.alloc(32).toString('base64')), /pinned application key/u);
    fs.appendFileSync(path.join(directory, archiveName), 'corrupt');
    assert.throws(() => verifyCandidateDirectory(directory, context, publicKey), /checksum/u);
  } finally { fs.rmSync(directory, { recursive: true }); }
  console.log('macOS release acceptance CLI contract passed; no native application was launched');
}
async function main() {
  const { values } = parseArgs({ options: { 'candidate-directory': { type: 'string' }, 'release-context': { type: 'string' }, output: { type: 'string' }, check: { type: 'boolean', default: false } }, allowPositionals: false });
  if (values.check) return checkContract();
  assert(values['candidate-directory'] && values['release-context'] && values.output, 'Usage: mac_release_acceptance.js --candidate-directory DIR --release-context FILE --output FILE | --check');
  return execute({ directory: path.resolve(values['candidate-directory']), contextFile: path.resolve(values['release-context']), output: path.resolve(values.output) });
}
module.exports = { previousVersion, assertCIEnvironment, verifyCandidateDirectory, tree, checkContract };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
