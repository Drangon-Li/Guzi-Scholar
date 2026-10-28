'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { compareVersions, versionChannel, assetURL, validateReleaseManifest } = require('../electron/update-service.cjs');

const desktopRoot = path.resolve(__dirname, '..');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const hash = (file) => digest(fs.readFileSync(file));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: desktopRoot, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options });
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
const within = (file, directory) => file === directory || file.startsWith(`${directory}${path.sep}`);
function validateOptions(options) {
  for (const name of ['sourceDirectory', 'targetDirectory', 'output']) assert(path.isAbsolute(options[name] || ''), `Absolute ${name} required`);
  for (const version of ['sourceVersion', 'targetSourceVersion', 'targetVersion']) assert.equal(versionChannel(options[version]), 'stable', 'Local real upgrade currently requires stable versions');
  assert(compareVersions(options.sourceVersion, options.targetVersion) < 0, 'Target must be newer than the actual source version');
  assert(compareVersions(options.targetSourceVersion, options.targetVersion) <= 0, 'Target source cannot be downgraded');
  assert(compareVersions(options.targetSourceVersion, options.sourceVersion) >= 0, 'Target business code cannot be older than the actual source');
  assert.equal(Buffer.from(options.publicKey || '', 'base64').length, 32, 'Explicit pinned published public key required');
  assert.equal(Buffer.from(options.publicKey, 'base64').toString('base64'), options.publicKey, 'Canonical public key required');
  assert(options.output.endsWith('.json'), 'JSON report output required');
  const output = path.resolve(options.output);
  const inputDirectories = [options.sourceDirectory, options.targetDirectory].map((directory) => fs.realpathSync(directory));
  for (const protectedDirectory of ['/Applications', path.join(os.homedir(), 'Applications'), path.join(os.homedir(), 'Library'), ...inputDirectories]) {
    assert(!within(output, protectedDirectory), `Report must not modify protected directory: ${protectedDirectory}`);
  }
  let ancestor = options.output;
  while (ancestor !== path.dirname(ancestor)) {
    if (fs.existsSync(ancestor)) assert(!fs.lstatSync(ancestor).isSymbolicLink(), 'Report path cannot traverse a symlink');
    ancestor = path.dirname(ancestor);
  }
}
function assertHealthy(events) {
  const failures = events.filter((event) => ['main-process-error', 'error-dialog', 'unexpected-dialog', 'renderer-error'].includes(event.type));
  assert.equal(failures.length, 0, `Native upgrade failed: ${JSON.stringify(failures)}`);
}
function inventory(directory) {
  const result = {};
  function visit(relative) {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const entry = path.join(relative, name), file = path.join(directory, entry), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) result[entry] = { link: fs.readlinkSync(file) };
      else if (stat.isDirectory()) visit(entry);
      else { assert(stat.isFile()); result[entry] = { sha256: hash(file), executable: stat.mode & 0o111 }; }
    }
  }
  visit('');
  return result;
}
function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((file) => JSON.stringify(before[file]) !== JSON.stringify(after[file]));
}
function assertCopyChanges(before, after, executable) {
  const allowed = new Set(['Contents/Info.plist', 'Contents/Resources/app/package.json', 'Contents/Resources/app/electron/mac-local-upgrade-main.cjs', `Contents/MacOS/${executable}`]);
  const changes = changedFiles(before, after);
  for (const file of changes) assert(allowed.has(file) || file.startsWith('Contents/_CodeSignature/'), `Unexpected business-code modification: ${file}`);
  assert(changes.includes('Contents/Resources/app/electron/mac-local-upgrade-main.cjs'), 'Isolation fixture must be added');
  return changes;
}
function processes() {
  return run('/bin/ps', ['-axo', 'pid=,ppid=,command=']).trim().split('\n').map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
function plist(app, key) { return run('/usr/bin/plutil', ['-extract', key, 'raw', path.join(app, 'Contents/Info.plist')]).trim(); }
function setPlist(app, key, value) { run('/usr/bin/plutil', ['-replace', key, '-string', value, path.join(app, 'Contents/Info.plist')]); }
function originalEvidence(release) {
  return { version: release.version, tag: release.tag, commit: release.commit, archive: release.archive, archive_name: release.archiveName, sha256: release.sha256, sha512: release.sha512, ed_signature: release.edSignature, published_public_key: release.publicKey, provenance: release.provenance };
}
async function execute(options) {
  validateOptions(options);
  assert.equal(process.platform, 'darwin', 'Native local acceptance requires macOS');
  assert.equal(process.arch, 'arm64', 'Native local acceptance requires arm64');
  for (const name of ['MY_SCHOLAR_DATA_DIR', 'MY_SCHOLAR_LIBRARY_DIR', 'MY_SCHOLAR_SERVER_EXECUTABLE', 'MY_SCHOLAR_DEVELOPMENT_DATA_DIR', 'ELECTRON_RUN_AS_NODE']) assert(!process.env[name], `Conflicting environment override: ${name}`);
  const { verifyPublishedMacRelease } = require('./published_mac_release.cjs');
  const source = verifyPublishedMacRelease(options.sourceDirectory, { version: options.sourceVersion, publicKey: options.publicKey });
  const target = verifyPublishedMacRelease(options.targetDirectory, { version: options.targetSourceVersion, publicKey: options.publicKey });
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'guzi-real-upgrade-'));
  const bundleID = `com.guzi.scholar.upgradetest.${crypto.randomBytes(12).toString('hex')}`;
  const installed = path.join(root, 'installed/谷子学术.app'), userData = path.join(root, 'user-data');
  const owner = { protocol: 1, root, bundleID, installed, userData };
  writeJSON(path.join(root, 'owner.json'), owner);
  fs.mkdirSync(userData);
  fs.mkdirSync(path.join(root, 'logs'));
  const key = crypto.generateKeyPairSync('ed25519');
  const testPublicKey = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const report = { schema: 1, kind: 'mac-local-real-upgrade', passed: false, from_version: source.version, to_version: options.targetVersion, target_source_version: target.version, target_local_only: true, platform: process.platform, arch: process.arch, environment: `Current isolated Mac ${os.release()}`, checks: {}, evidence: { ...owner, source: originalEvidence(source), target_source: originalEvidence(target), test_public_key: testPublicKey, fixture: 'Same isolation bootstrap added to both verified published bundles; original business code retained', publication: 'Local test archive only; no release or CI acceptance artifact' } };
  const baseline = processes(), baselinePIDs = new Set(baseline.map((item) => item.pid));
  report.evidence.preexisting_processes = baseline.filter((item) => /谷子学术|Guzi|guzi|my-scholar/iu.test(item.command));
  const ownedPIDs = new Set(), eventFile = path.join(root, 'events.jsonl');
  let currentPID, sequence = 0, server, cleaning, appLog, sourceExit;
  const childErrors = [];
  const events = () => fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  function ownedProcesses() {
    const rows = processes();
    for (const event of events()) if (event.type === 'launched' && !baselinePIDs.has(event.pid)) ownedPIDs.add(event.pid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of rows) if (ownedPIDs.has(item.ppid) && !ownedPIDs.has(item.pid) && !baselinePIDs.has(item.pid)) { ownedPIDs.add(item.pid); changed = true; }
    }
    return rows.filter((item) => item.pid !== process.pid && !baselinePIDs.has(item.pid) && (ownedPIDs.has(item.pid) || item.command.includes(`${root}/`) || item.command.includes(bundleID)));
  }
  async function until(predicate, label, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      ownedProcesses();
      assert.equal(childErrors.length, 0, `Application process error: ${JSON.stringify(childErrors)}`);
      assertHealthy(events());
      const value = await predicate();
      if (value) return value;
      await delay(200);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function command(action, extra = {}, timeout = 90000) {
    const id = `${Date.now()}-${++sequence}`;
    writeJSON(path.join(root, 'command.json'), { id, targetPID: currentPID, action, ...extra });
    const response = await until(() => events().find((event) => event.type === 'result' && event.id === id), action, timeout);
    assert(!response.error, response.error);
    return response.result;
  }
  function check(name, detail) { report.checks[name] = true; report.evidence[name] = detail; console.log(`${name}: ${JSON.stringify(detail)}`); }
  async function cleanup() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      report.evidence.cleanupStartedAt = new Date().toISOString();
      if (server) { server.closeAllConnections(); server.close(); }
      report.evidence.cleanup_processes = ownedProcesses();
      const steps = report.evidence.cleanup_steps = [];
      const cleanupErrors = report.evidence.cleanup_errors = [];
      const recordStep = (action, details = {}) => steps.push({ time: new Date().toISOString(), action, ...details });
      const waitQuietly = async (predicate, timeout) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          ownedProcesses();
          if (predicate()) return true;
          await delay(200);
        }
        return Boolean(predicate());
      };
      const signalOwned = (pid, signal) => {
        if (!ownedProcesses().some((item) => item.pid === pid)) return;
        recordStep('signal', { pid, signal });
        try { process.kill(pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push({ pid, signal, error: error.stack || String(error) }); }
      };
      for (const item of report.evidence.cleanup_processes) ownedPIDs.add(item.pid);
      const lastMain = events().filter((event) => event.type === 'launched').reverse().find((event) => alive(event.pid) && ownedPIDs.has(event.pid));
      const mainPID = currentPID && alive(currentPID) && ownedPIDs.has(currentPID) ? currentPID : lastMain?.pid;
      if (mainPID) {
        const id = `${Date.now()}-${++sequence}`;
        recordStep('request-quit', { pid: mainPID, id });
        writeJSON(path.join(root, 'command.json'), { id, targetPID: mainPID, action: 'quit' });
        if (!await waitQuietly(() => !alive(mainPID), 8000)) {
          signalOwned(mainPID, 'SIGTERM');
          if (!await waitQuietly(() => !alive(mainPID), 3000)) {
            signalOwned(mainPID, 'SIGKILL');
            await waitQuietly(() => !alive(mainPID), 2000);
          }
        }
        recordStep('main-exit', { pid: mainPID, exited: !alive(mainPID) });
      }
      await waitQuietly(() => ownedProcesses().length === 0, 2000);
      for (const item of ownedProcesses()) signalOwned(item.pid, 'SIGTERM');
      if (!await waitQuietly(() => ownedProcesses().length === 0, 2000)) {
        for (const item of ownedProcesses()) signalOwned(item.pid, 'SIGKILL');
        await waitQuietly(() => ownedProcesses().length === 0, 2000);
      }
      recordStep('complete');
      report.evidence.remaining_processes = ownedProcesses();
      assert.equal(report.evidence.remaining_processes.length, 0, 'All isolated app, backend and Sparkle processes must exit');
      report.evidence.preexisting_app_processes_preserved = report.evidence.preexisting_processes.map((item) => ({ ...item, alive: alive(item.pid) }));
    })();
    return cleaning;
  }
  function saveReport() {
    report.evidence.main_process_errors = events().filter((event) => event.type === 'main-process-error');
    report.evidence.error_dialogs = events().filter((event) => ['error-dialog', 'unexpected-dialog'].includes(event.type));
    report.evidence.renderer_errors = events().filter((event) => event.type === 'renderer-error');
    report.evidence.child_errors = childErrors;
    report.evidence.source_exit = sourceExit;
    report.evidence.events = eventFile;
    report.evidence.output_log = path.join(root, 'app-output.log');
    if (appLog) report.evidence.electron_log = appLog;
    writeJSON(options.output, report);
  }
  const onSignal = (signal) => { report.passed = false; report.error = `Interrupted: ${signal}`; cleanup().catch((error) => { report.cleanup_error = String(error); }).finally(() => { saveReport(); process.exit(1); }); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
  try {
    function prepare(release, destination, label, version) {
      if (label === 'source') assert.equal(version, release.version, 'Source version must never be downgraded or rewritten');
      const extraction = path.join(root, `${label}-published`);
      fs.mkdirSync(extraction);
      run('/usr/bin/ditto', ['-x', '-k', release.archive, extraction]);
      const names = fs.readdirSync(extraction).filter((name) => name.endsWith('.app'));
      assert.equal(names.length, 1, 'Exactly one published application required');
      const original = path.join(extraction, names[0]);
      const metadata = json(path.join(original, 'Contents/Resources/app/package.json'));
      assert.equal(metadata.version, release.version, 'Published bundle version must match verified release');
      assert.equal(metadata.main, 'electron/main.cjs');
      assert(!metadata.localTestBuild && !metadata.macReleaseAcceptance && !metadata.macLocalUpgrade && !metadata.updaterProbe, 'Unmodified published application required');
      assert.equal(metadata.updater.publicKey, options.publicKey);
      assert.equal(metadata.updater.enabled, true);
      assert.equal(metadata.updater.channel, 'stable');
      assert.equal(metadata.updater.repository, 'Drangon-Li/Guzi-Scholar');
      assert.equal(plist(original, 'CFBundleIdentifier'), 'com.guzi.scholar');
      for (const property of ['CFBundleVersion', 'CFBundleShortVersionString']) assert.equal(plist(original, property), release.version);
      assert.equal(plist(original, 'SUPublicEDKey'), options.publicKey);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', original]);
      const before = inventory(original), binary = plist(original, 'CFBundleExecutable');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      run('/usr/bin/ditto', [original, destination]);
      writeJSON(path.join(destination, 'Contents/Resources/app/package.json'), { ...metadata, version, main: 'electron/mac-local-upgrade-main.cjs', updater: { ...metadata.updater, publicKey: testPublicKey }, macLocalUpgrade: owner });
      assert.equal(json(path.join(destination, 'Contents/Resources/app/package.json')).version, version);
      fs.copyFileSync(path.join(__dirname, 'fixtures/mac-local-upgrade-main.cjs'), path.join(destination, 'Contents/Resources/app/electron/mac-local-upgrade-main.cjs'));
      setPlist(destination, 'CFBundleIdentifier', bundleID);
      setPlist(destination, 'SUPublicEDKey', testPublicKey);
      for (const property of ['CFBundleVersion', 'CFBundleShortVersionString']) setPlist(destination, property, version);
      run('/usr/bin/codesign', ['--force', '--sign', '-', destination]);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination]);
      const after = inventory(destination), changes = assertCopyChanges(before, after, binary);
      writeJSON(path.join(root, `${label}-original-inventory.json`), before);
      writeJSON(path.join(root, `${label}-isolated-inventory.json`), after);
      report.evidence[`${label}_copy`] = { original, isolated: destination, original_version: release.version, isolated_version: version, changed_files: changes, original_inventory: path.join(root, `${label}-original-inventory.json`), isolated_inventory: path.join(root, `${label}-isolated-inventory.json`), business_code_preserved: true, original_tree_sha256: digest(JSON.stringify(before)), isolated_tree_sha256: digest(JSON.stringify(after)) };
      return { metadata, binary, inventory: after };
    }
    const preparedSource = prepare(source, installed, 'source', source.version);
    const targetApp = path.join(root, 'target/谷子学术.app');
    const preparedTarget = prepare(target, targetApp, 'target', options.targetVersion);
    const archive = path.join(root, `Guzi-Scholar-${options.targetVersion}-arm64-stable.zip`);
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', targetApp, archive]);
    const bytes = fs.readFileSync(archive), signature = crypto.sign(null, bytes, key.privateKey).toString('base64');
    assert(crypto.verify(null, bytes, key.publicKey, Buffer.from(signature, 'base64')));
    const targetArtifact = target.manifest.artifacts.find((item) => item.platform === 'darwin' && item.arch === 'arm64');
    assert(targetArtifact, 'Verified target macOS artifact required');
    const artifact = { ...targetArtifact, name: path.basename(archive), url: assetURL(`v${options.targetVersion}`, path.basename(archive)), size: bytes.length, sha256: digest(bytes), sha512: digest(bytes, 'sha512', 'base64'), ed_signature: signature };
    const manifest = { ...target.manifest, version: options.targetVersion, artifacts: [artifact], notes: `LOCAL ISOLATED UPGRADE TEST ONLY: code from ${target.tag}` };
    validateReleaseManifest(manifest, { platform: 'darwin', arch: 'arm64', channel: 'stable', release: { tag_name: `v${options.targetVersion}`, draft: false, prerelease: false, assets: [{ name: artifact.name, size: artifact.size, state: 'uploaded', browser_download_url: artifact.url }] } });
    writeJSON(path.join(root, 'update-manifest.json'), manifest);
    server = http.createServer((request, response) => {
      if (request.url !== '/candidate.zip') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': bytes.length });
      const stream = fs.createReadStream(archive);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    writeJSON(path.join(root, 'manifest.json'), { downloadURL: `http://127.0.0.1:${server.address().port}/candidate.zip`, signature });
    check('isolated_verified_copies', { source_version: source.version, target_source_version: target.version, target_version: options.targetVersion, bundleID, local_archive: archive, sha256: artifact.sha256 });
    run(process.env.MY_SCHOLAR_TEST_PYTHON || 'python3', [path.join(__dirname, 'fixtures/seed_library.py'), path.join(userData, 'library')]);
    fs.mkdirSync(path.join(userData, 'state'), { recursive: true });
    fs.copyFileSync(path.join(userData, 'library/settings.json'), path.join(userData, 'state/settings.json'));
    const { RendererStateStore } = require(path.join(installed, 'Contents/Resources/app/electron/renderer-state.cjs'));
    await new RendererStateStore(path.join(userData, 'state/renderer-state')).set('my-scholar-onboarding-v2', JSON.stringify({ version: 2, action: 'completed' }));
    const job = fs.readdirSync(path.join(userData, 'library/jobs')).find((name) => /^[a-f0-9]{16}$/u.test(name));
    assert(job, 'Seeded document required');
    const notes = path.join(userData, 'library/jobs', job, 'notes.md');
    const seedNote = `Real ${source.version} to ${options.targetVersion}: preserve this note.\n`;
    fs.writeFileSync(notes, seedNote);
    const executable = path.join(installed, 'Contents/MacOS', preparedSource.binary);
    const fd = fs.openSync(path.join(root, 'app-output.log'), 'a', 0o600);
    const child = spawn(executable, [], { env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    assert(child.pid, 'Isolated source process must launch');
    child.on('error', (error) => { childErrors.push({ pid: child.pid, error: error.stack || String(error) }); });
    child.once('exit', (code, signal) => { sourceExit = { code, signal }; });
    currentPID = child.pid;
    ownedPIDs.add(currentPID);
    await until(() => events().some((event) => event.type === 'launched' && event.pid === currentPID), 'real published source startup');
    await until(async () => (await command('status')).ready, 'source renderer ready');
    const first = await command('status');
    assert.equal(first.version, source.version);
    assert.equal(first.userData, userData);
    assert.equal(first.executable || first.exe, executable);
    assert(within(first.logs, root), 'Source logs must remain isolated');
    appLog = path.join(first.logs, 'my-scholar-electron.log');
    const waitIdle = () => until(async () => {
      const health = await command('eval', { code: "fetch('/api/health').then(response => { if (!response.ok) throw new Error('Backend health failed'); return response.json(); })" });
      return health.storage?.migration?.ready;
    }, 'packaged backend healthy and idle');
    await waitIdle();
    check('real_source_started', first);
    const discovery = await command('discover');
    assert.equal(discovery.version, options.targetVersion);
    assert.equal(discovery.status, 'available');
    assert.equal((await command('stage')).status, 'ready');
    const cached = await command('cached');
    assert.equal(cached.sha256, artifact.sha256);
    assert.equal(cached.edSignature, signature);
    assert.equal(cached.size, artifact.size);
    check('production_discovery_and_download', { discovery, cached });
    await waitIdle();
    const beforeCapture = await command('capture', { name: 'before-upgrade' });
    report.evidence.before_screenshot = beforeCapture.file;
    const retained = ['state/settings.json', 'library/library.json', `library/jobs/${job}/source.pdf`, `library/jobs/${job}/notes.md`];
    const annotations = `library/jobs/${job}/annotations.json`;
    if (fs.existsSync(path.join(userData, annotations))) retained.push(annotations);
    const beforeHashes = Object.fromEntries(retained.map((file) => [file, hash(path.join(userData, file))]));
    report.evidence.data_before = beforeHashes;
    const previousPID = currentPID, installOffset = events().length;
    writeJSON(path.join(root, 'command.json'), { id: `${Date.now()}-${++sequence}`, targetPID: currentPID, action: 'install' });
    await until(() => !alive(previousPID) && sourceExit, 'source exit through real native install', 180000);
    assert.deepEqual(sourceExit, { code: 0, signal: null }, 'Source must exit normally during a successful native upgrade');
    const targetExecutable = path.join(installed, 'Contents/MacOS', preparedTarget.binary);
    const launch = await until(() => events().find((event) => event.type === 'launched' && event.pid !== previousPID && event.version === options.targetVersion), 'Sparkle target relaunch', 180000);
    currentPID = launch.pid;
    ownedPIDs.add(currentPID);
    assert(alive(currentPID));
    await until(async () => (await command('status')).ready, 'restarted target renderer ready');
    const restarted = await command('status');
    assert.equal(restarted.version, options.targetVersion);
    assert.equal(restarted.userData, userData);
    assert.equal(restarted.executable || restarted.exe, targetExecutable);
    assert(within(restarted.logs, root), 'Target logs must remain isolated');
    assert.equal(restarted.frozen, false);
    await waitIdle();
    const children = processes();
    const backend = children.find((item) => item.ppid === currentPID && item.command.includes(`${installed}/Contents/Resources/python-server/`));
    const renderer = children.find((item) => item.ppid === currentPID && item.command.includes('--type=renderer'));
    assert(backend && renderer, 'Actual packaged backend and renderer must run after relaunch');
    const opened = run('/usr/sbin/lsof', ['-p', String(currentPID), '-Fn']);
    assert(opened.split('\n').includes(`n${targetExecutable}`), 'Actual loaded executable must be the installed target');
    const runtimeData = await command('eval', { code: `Promise.all([
      window.myScholarDesktop.getLibraryLocation(),
      fetch('/api/jobs/${job}/notes').then(response => { if (!response.ok) throw new Error('Seeded notes read failed'); return response.json(); })
    ]).then(([library, notes]) => ({ library, notes }))` });
    assert.equal(runtimeData.library.currentPath, path.join(userData, 'library'), 'Restarted bridge must use the same isolated library');
    assert.equal(runtimeData.notes.markdown, seedNote, 'Restarted backend must read the retained seeded note');
    check('runtime_data_reused', { userData: restarted.userData, library: runtimeData.library, job, notes: runtimeData.notes });
    assert.equal(plist(installed, 'CFBundleIdentifier'), bundleID);
    assert.equal(plist(installed, 'CFBundleShortVersionString'), options.targetVersion);
    assert.equal(plist(installed, 'SUPublicEDKey'), testPublicKey);
    assert.equal(json(path.join(installed, 'Contents/Resources/app/package.json')).main, 'electron/mac-local-upgrade-main.cjs');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    assert.deepEqual(inventory(installed), preparedTarget.inventory, 'Installed target must equal prepared copy of verified published target code');
    const installationEvents = events().slice(installOffset);
    const authorization = installationEvents.findIndex((event) => event.type === 'install-authorized');
    const saved = installationEvents.findIndex((event) => event.type === 'save-gate' && event.phase === 'complete' && event.result === true);
    assert(authorization >= 0, 'Real update controller must authorize native installation');
    assert(saved >= 0 && saved < authorization, 'Actual renderer save gate must complete successfully before native installation is authorized');
    assert(installationEvents.some((event) => event.type === 'sparkle' && event.event?.type === 'ready'), 'Real native Sparkle must report ready');
    check('native_install_and_relaunch', { previous_pid: previousPID, pid: currentPID, executable: targetExecutable, status: restarted, backend, renderer, native_events: installationEvents.filter((event) => event.type === 'sparkle' || event.type === 'save-gate') });
    const afterHashes = Object.fromEntries(retained.map((file) => [file, hash(path.join(userData, file))]));
    report.evidence.data_after = afterHashes;
    assert.deepEqual(afterHashes, beforeHashes, 'Settings, library index, PDF and notes hashes must remain unchanged');
    check('data_preserved', afterHashes);
    report.evidence.after_screenshot = (await command('capture', { name: 'after-upgrade' })).file;
    assertHealthy(events());
    verifyPublishedMacRelease(options.sourceDirectory, { version: options.sourceVersion, publicKey: options.publicKey });
    verifyPublishedMacRelease(options.targetDirectory, { version: options.targetSourceVersion, publicKey: options.publicKey });
    check('original_archives_preserved', { source_sha256: hash(source.archive), target_sha256: hash(target.archive) });
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = error.stack || String(error);
    throw error;
  } finally {
    try { await cleanup(); } catch (error) { report.passed = false; report.cleanup_error = error.stack || String(error); process.exitCode = 1; }
    assertHealthyReport();
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
    saveReport();
    console.log(`Local real macOS upgrade report: ${options.output}`);
  }
  function assertHealthyReport() {
    try { assertHealthy(events()); } catch (error) { report.passed = false; report.error ||= error.stack || String(error); process.exitCode = 1; }
  }
  return report;
}
function checkContract() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'guzi-upgrade-contract-'));
  try {
    const options = { sourceDirectory: path.join(root, 'published-0.6.9'), sourceVersion: '0.6.9', targetDirectory: path.join(root, 'published-0.6.10'), targetSourceVersion: '0.6.10', targetVersion: '0.6.10', publicKey: Buffer.alloc(32, 1).toString('base64'), output: path.join(root, 'mac-real-upgrade-result.json') };
    for (const directory of [options.sourceDirectory, options.targetDirectory, path.join(root, 'reports')]) fs.mkdirSync(directory);
    validateOptions(options);
    validateOptions({ ...options, targetDirectory: options.sourceDirectory });
    validateOptions({ ...options, sourceVersion: '0.6.10', targetVersion: '0.6.11' });
    assert.throws(() => validateOptions({ ...options, publicKey: '' }), /public key/u);
    assert.throws(() => validateOptions({ ...options, sourceVersion: '0.6.10' }), /newer/u);
    assert.throws(() => validateOptions({ ...options, targetSourceVersion: '0.6.11' }), /downgraded/u);
    assert.throws(() => validateOptions({ ...options, targetSourceVersion: '0.6.8' }), /business code/u);
    assert.throws(() => validateOptions({ ...options, sourceVersion: 'not-a-version' }));
    assert.throws(() => validateOptions({ ...options, output: '/Applications/report.json' }), /protected/u);
    assert.throws(() => validateOptions({ ...options, output: path.join(options.sourceDirectory, 'report.json') }), /protected/u);
    assert.throws(() => validateOptions({ ...options, sourceDirectory: 'relative' }), /Absolute/u);
    for (const type of ['main-process-error', 'error-dialog', 'unexpected-dialog', 'renderer-error']) assert.throws(() => assertHealthy([{ type, error: 'Cannot dispose the macOS updater during an active installation' }]), /Native upgrade failed/u);
    assertHealthy([{ type: 'sparkle', event: { type: 'ready' } }]);
    assert.throws(() => assertCopyChanges({ 'Contents/Resources/app/electron/main.cjs': { sha256: 'old' } }, { 'Contents/Resources/app/electron/main.cjs': { sha256: 'new' } }, 'Guzi Scholar'), /business-code/u);
    for (const name of ['sourceDirectory', 'targetDirectory']) {
      const alias = path.join(root, `${name}-alias`);
      fs.symlinkSync(options[name], alias, 'dir');
      assert.throws(() => validateOptions({ ...options, [name]: alias, output: path.join(options[name], 'report.json') }), /protected/u);
      assert.throws(() => validateOptions({ ...options, [name]: `${options[name]}/../${path.basename(options[name])}`, output: path.join(options[name], 'report.json') }), /protected/u);
      assert.throws(() => validateOptions({ ...options, output: `${root}/reports/../${path.basename(options[name])}/report.json` }), /protected/u);
    }
    const reportAlias = path.join(root, 'report-alias');
    fs.symlinkSync(path.join(root, 'reports'), reportAlias, 'dir');
    assert.throws(() => validateOptions({ ...options, output: path.join(reportAlias, 'report.json') }), /symlink/u);
    console.log('Local macOS real-upgrade CLI contract passed; no application was launched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function main() {
  const { values } = parseArgs({ options: { 'source-directory': { type: 'string' }, 'source-version': { type: 'string' }, 'target-directory': { type: 'string' }, 'target-source-version': { type: 'string' }, 'target-version': { type: 'string' }, 'public-key': { type: 'string' }, output: { type: 'string' }, check: { type: 'boolean', default: false } }, allowPositionals: false });
  if (values.check) return checkContract();
  for (const name of ['source-directory', 'source-version', 'target-directory', 'target-source-version', 'target-version', 'public-key', 'output']) assert(values[name], `Required: --${name}`);
  return execute({ sourceDirectory: path.resolve(values['source-directory']), sourceVersion: values['source-version'], targetDirectory: path.resolve(values['target-directory']), targetSourceVersion: values['target-source-version'], targetVersion: values['target-version'], publicKey: values['public-key'], output: path.resolve(values.output) });
}
module.exports = { validateOptions, assertHealthy, inventory, changedFiles, assertCopyChanges, checkContract, execute };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
