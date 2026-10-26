'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, canonicalPath, powershell } = require('./windows_updater_acceptance.js');
const { createWindowsBuildConfig, identities } = require('../../../platforms/windows/builder-config.cjs');
const { REPOSITORY, assetURL, compareVersions } = require('../electron/update-service.cjs');
const { identity, acceptance, ACCEPTANCE_CHECKS } = require('../scripts/release-pipeline.cjs');
const desktopRoot = path.resolve(__dirname, '..');
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const digest = (file) => hash(fs.readFileSync(file));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2)); fs.renameSync(`${file}.tmp`, file); };
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function requireCIWindows() {
  assert.equal(process.platform, 'win32', 'Real Windows VM required');
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Formal-identity acceptance is restricted to ephemeral GitHub Actions VMs');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'A disposable GitHub-hosted runner is required');
  assert.equal(process.env.RUNNER_OS, 'Windows');
  assert.equal(process.env.RUNNER_ARCH, 'X64');
}
function previousVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/u.exec(version);
  assert.ok(match, 'Release version required');
  let [, major, minor, patch, beta] = match.map((part) => part === undefined ? part : Number(part));
  if (beta > 0) return `${major}.${minor}.${patch}-beta.${beta - 1}`;
  if (patch > 0) patch--;
  else if (minor > 0) { minor--; patch = 0; }
  else { assert.ok(major > 0, 'No lower version available'); major--; minor = 0; patch = 0; }
  return `${major}.${minor}.${patch}${beta === undefined ? '' : '-beta.0'}`;
}
function rendererUserData(commandLine) {
  const match = /--user-data-dir=(?:"([^"]+)"|([^\s"]+))/u.exec(commandLine || '');
  return match?.[1] || match?.[2] || '';
}
function validateBundle(directory, context) {
  assert.equal(context.schema, 1);
  assert.equal(context.repository, REPOSITORY);
  assert.match(context.commit, /^[a-f0-9]{40}$/u);
  assert.equal(identity(context.tag, context.version), context.channel);
  const provenance = json(path.join(directory, 'release-provenance.json'));
  for (const key of ['repository', 'tag', 'commit', 'version', 'channel']) assert.equal(provenance[key], context[key], `Candidate provenance ${key}`);
  const sums = new Map();
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
    assert.ok(match && !sums.has(match[2]), 'Unique safe checksum records required');
    sums.set(match[2], match[1]);
  }
  const manifest = json(path.join(directory, 'update-manifest.json'));
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.repository, context.repository);
  assert.equal(manifest.version, context.version);
  assert.equal(manifest.channel, context.channel);
  const artifacts = manifest.artifacts.filter((item) => item.platform === 'win32' && item.arch === 'x64' && item.kind === 'nsis');
  assert.equal(artifacts.length, 1);
  const artifact = artifacts[0];
  assert.equal(artifact.name, `Guzi-Scholar-${context.version}-windows-x64-setup.exe`);
  assert.equal(artifact.url, assetURL(context.tag, artifact.name));
  const feedName = context.channel === 'stable' ? 'latest.yml' : 'beta.yml';
  for (const name of ['update-manifest.json', 'release-provenance.json', artifact.name, feedName]) {
    const file = path.join(directory, name);
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), `Regular candidate file required: ${name}`);
    assert.equal(digest(file), sums.get(name), `Candidate checksum mismatch: ${name}`);
    if (name !== 'release-provenance.json') {
      const records = provenance.assets.filter((item) => item.name === name);
      assert.equal(records.length, 1);
      assert.equal(records[0].sha256, sums.get(name));
      assert.equal(records[0].size, fs.statSync(file).size);
    }
  }
  const installer = path.join(directory, artifact.name);
  assert.equal(digest(installer), artifact.sha256);
  assert.equal(fs.statSync(installer).size, artifact.size);
  assert.equal(hash(fs.readFileSync(installer), 'sha512', 'base64'), artifact.sha512);
  return { artifact, manifest, installer, feedName };
}
function oldConfig(root, context, version, transportURL, evidence = root) {
  const config = createWindowsBuildConfig({ GUZI_UPDATE_CHANNEL: context.channel });
  config.extraMetadata.version = version;
  config.extraMetadata.main = 'electron/windows-release-probe-main.cjs';
  config.extraMetadata.windowsReleaseAcceptance = { root, transportURL, eventsPath: path.join(evidence, 'windows-events.jsonl') };
  config.extraResources.push({ from: path.join(__dirname, 'fixtures/windows-release-probe-main.cjs'), to: 'app/electron/windows-release-probe-main.cjs' });
  config.directories.output = path.join(root, 'old-package');
  assert.equal(config.appId, identities[context.channel].appId);
  assert.equal(config.nsis.guid, identities[context.channel].guid);
  return config;
}
function staticCheck() {
  assert.equal(previousVersion('0.6.3'), '0.6.2');
  assert.equal(previousVersion('0.6.3-beta.2'), '0.6.3-beta.1');
  assert.equal(previousVersion('0.6.3-beta.0'), '0.6.2-beta.0');
  assert.ok(compareVersions(previousVersion('1.0.0'), '1.0.0') < 0);
  assert.equal(rendererUserData('app.exe --type=renderer --user-data-dir="C:\\Users\\runner\\AppData\\Roaming\\guzi-scholar"'), 'C:\\Users\\runner\\AppData\\Roaming\\guzi-scholar');
  assert.equal(rendererUserData('app.exe --type=renderer --user-data-dir=C:\\profile'), 'C:\\profile');
  const hostedWindows = process.platform === 'win32' && process.arch === 'x64' && process.env.GITHUB_ACTIONS === 'true'
    && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_OS === 'Windows' && process.env.RUNNER_ARCH === 'X64';
  if (hostedWindows) requireCIWindows();
  else assert.throws(() => requireCIWindows());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-release-contract-'));
  try {
    assert.equal(canonicalPath(directory), canonicalPath(fs.realpathSync.native(directory)));
    const context = { schema: 1, repository: REPOSITORY, tag: 'v0.6.3', commit: 'a'.repeat(40), version: '0.6.3', channel: 'stable' };
    const name = 'Guzi-Scholar-0.6.3-windows-x64-setup.exe';
    const bytes = Buffer.from('Static contract fixture; never executed.');
    const artifact = { name, platform: 'win32', arch: 'x64', kind: 'nsis', size: bytes.length, sha256: hash(bytes), sha512: hash(bytes, 'sha512', 'base64'), url: assetURL(context.tag, name) };
    fs.writeFileSync(path.join(directory, name), bytes);
    fs.writeFileSync(path.join(directory, 'latest.yml'), 'static feed fixture');
    write(path.join(directory, 'update-manifest.json'), { schema: 2, repository: REPOSITORY, version: context.version, channel: context.channel, artifacts: [artifact] });
    const names = [name, 'latest.yml', 'update-manifest.json'];
    write(path.join(directory, 'release-provenance.json'), { ...context, assets: names.map((item) => ({ name: item, sha256: digest(path.join(directory, item)), size: fs.statSync(path.join(directory, item)).size })) });
    names.push('release-provenance.json');
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), names.map((item) => `${digest(path.join(directory, item))}  ${item}\n`).join(''));
    assert.equal(validateBundle(directory, context).artifact.sha256, artifact.sha256);
    assert.throws(() => validateBundle(directory, { ...context, commit: 'b'.repeat(40) }), /provenance commit/u);
    fs.appendFileSync(path.join(directory, name), 'corrupt');
    assert.throws(() => validateBundle(directory, context), /checksum mismatch/u);
    const config = oldConfig(directory, context, previousVersion(context.version), 'http://127.0.0.1:1');
    assert.equal(config.appId, identities.stable.appId);
    assert.equal(config.extraMetadata.updater.enabled, true);
    assert.equal(config.extraMetadata.main, 'electron/windows-release-probe-main.cjs');
    assert.equal(config.forceCodeSigning, false);
    const { resolveUpdateConfig } = require('../electron/update-config.cjs');
    const options = { metadata: { ...config.extraMetadata }, isPackaged: true, platform: 'win32', arch: 'x64' };
    const internal = resolveUpdateConfig(options);
    assert.equal(internal.enabled, false, 'Real internal builds must keep updates disabled');
    assert.equal(internal.discoveryEnabled, false);
    const fixtureSource = fs.readFileSync(path.join(__dirname, 'fixtures/windows-release-probe-main.cjs'), 'utf8');
    const fixtureSetup = fixtureSource.slice(0, fixtureSource.indexOf('const root = probe.root;'));
    assert.ok(fixtureSetup.includes('updateConfig.resolveUpdateConfig ='));
    const setup = (metadata, environment = 'true') => {
      const updateConfig = { resolveUpdateConfig };
      require('node:vm').runInNewContext(fixtureSetup, {
        process: { platform: 'win32', env: { GITHUB_ACTIONS: environment } }, URL,
        require: (name) => name === 'electron' ? { app: { isPackaged: true } }
          : name === '../package.json' ? metadata : name === './update-config.cjs' ? updateConfig : require(name),
      });
      return updateConfig.resolveUpdateConfig;
    };
    const fixtureResolver = setup(options.metadata);
    const fixture = fixtureResolver(options);
    assert.deepEqual({ ...fixture }, { ...internal, enabled: true, discoveryEnabled: false, reason: '' });
    assert.throws(() => fixtureResolver({ ...options, metadata: { ...options.metadata } }), /only to the old release fixture/u);
    assert.throws(() => setup(options.metadata, 'false'), /Ephemeral Windows/u);
    assert.throws(() => setup({ ...options.metadata, windowsReleaseAcceptance: { ...options.metadata.windowsReleaseAcceptance, transportURL: 'https://github.com' } }), /staged loopback/u);
    const candidateConfig = createWindowsBuildConfig({ GUZI_UPDATE_CHANNEL: context.channel });
    assert.ok(!candidateConfig.extraMetadata.windowsReleaseAcceptance);
    assert.ok(!candidateConfig.extraResources.some((resource) => resource.to === 'app/electron/windows-release-probe-main.cjs'));
    assert.equal(resolveUpdateConfig({ ...options, metadata: { version: context.version, ...candidateConfig.extraMetadata } }).enabled, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('Windows original-candidate acceptance static contracts passed; no installed upgrade was performed.');
}
async function main() {
  if (process.argv.includes('--check')) { staticCheck(); return; }
  const option = (name) => { const index = process.argv.indexOf(name); assert.ok(index >= 0 && process.argv[index + 1], `Missing ${name}`); return path.resolve(process.argv[index + 1]); };
  const output = option('--output');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  assert.ok(!fs.existsSync(output), 'Refusing to replace an acceptance report');
  const evidence = path.dirname(output);
  const report = { schema: 1, passed: false, platform: process.platform, arch: process.arch,
    environment: `GitHub Actions ${process.env.RUNNER_OS || process.platform} ${os.release()} ${process.arch}; run ${process.env.GITHUB_RUN_ID || 'local'}`,
    kind: 'original-release-nsis-upgrade', transport: 'staged draft descriptor and original manifest/feed over local test transport',
    production_certificate_validated: false, public_release_discovery_validated: false,
    checks: Object.fromEntries(ACCEPTANCE_CHECKS.map((name) => [name, false])) };
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-release-upgrade-')));
  const owner = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(root, '.owner'), owner, { flag: 'wx' });
  const eventsFile = path.join(evidence, 'windows-events.jsonl');
  fs.writeFileSync(eventsFile, '');
  report.root = root;
  const installed = path.join(root, '安装 路径');
  const executable = path.join(installed, 'Guzi-Scholar.exe');
  const owned = new Set();
  const environment = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const name of Object.keys(environment)) if (/^(?:CSC_|WIN_CSC_|GH_TOKEN$|GITHUB_TOKEN$|ACTIONS_RUNTIME_TOKEN$|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$|MY_SCHOLAR_DATA_DIR$|MY_SCHOLAR_LIBRARY_DIR$)/u.test(name)) delete environment[name];
  const persist = () => write(output, report);
  const execute = (name, command, args, options = {}) => run(command, args, { env: environment, ...options,
    logFile: path.join(evidence, `windows-${name}.log`), onResult: (result) => { if (result.pid) owned.add(result.pid); } });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  const rows = () => {
    const result = JSON.parse(powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'));
    return Array.isArray(result) ? result : [result];
  };
  const ownedProcesses = () => {
    const all = rows();
    for (const row of all) if (row.ProcessId !== process.pid && (row.ExecutablePath?.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)
      || row.CommandLine?.toLowerCase().includes(root.toLowerCase()))) owned.add(row.ProcessId);
    let size;
    do { size = owned.size; for (const row of all) if (row.ProcessId !== process.pid && owned.has(row.ParentProcessId)) owned.add(row.ProcessId); } while (owned.size !== size);
    return all.filter((row) => owned.has(row.ProcessId));
  };
  async function until(predicate, label, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(150); }
    throw new Error(`Timed out: ${label}`);
  }
  const events = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const check = (name, details = {}) => { report.checks[name] = true; report.observations ||= {}; report.observations[name] = details; persist(); console.log(`Windows release acceptance: ${name}`); };
  let currentPID;
  let sequence = 0;
  let server;
  let appLog;
  let failure;
  let uninstalled = false;
  function send(action, extra = {}) {
    const id = `${Date.now()}-${++sequence}`;
    write(path.join(root, 'command.json'), { id, targetPID: currentPID, action, ...extra });
    return id;
  }
  async function command(action, extra = {}, timeout = 190000) {
    const id = send(action, extra);
    const result = await until(() => events().find((event) => event.type === 'result' && event.id === id), action, timeout);
    if (result.error) throw new Error(result.error);
    return result.result;
  }
  async function launch() {
    const fd = fs.openSync(path.join(evidence, 'windows-app-output.log'), 'a');
    const child = spawn(executable, [], { env: environment, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    let error;
    child.on('error', (value) => { error = value; });
    currentPID = child.pid;
    if (child.pid) owned.add(child.pid);
    await until(() => { if (error) throw error; return events().find((event) => event.type === 'launched' && event.pid === child.pid); }, 'old app launch');
    await until(async () => { try { return (await command('status', {}, 3000)).ready; } catch (_) { return false; } }, 'old renderer');
    return command('status');
  }
  async function quit() { const pid = currentPID; send('quit'); await until(() => !alive(pid), 'ordinary old-version quit', 30000); }
  const idle = () => until(async () => Boolean(await command('eval', { code: "fetch('/api/health').then(r=>r.json()).then(x=>x.storage.migration.ready)" })), 'backend migration idle');
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ||= (async () => {
      server?.close();
      const errors = [];
      try {
        assert.equal(fs.readFileSync(path.join(root, '.owner'), 'utf8'), owner);
        if (process.platform === 'win32') {
          for (const row of ownedProcesses().reverse()) {
            try { if (alive(row.ProcessId)) execute(`cleanup-${row.ProcessId}`, path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(row.ProcessId), '/T', '/F']); }
            catch (error) { if (alive(row.ProcessId)) errors.push(error); }
          }
          if (!uninstalled && fs.existsSync(installed)) {
            const uninstall = fs.readdirSync(installed).find((name) => /^Uninstall.*\.exe$/iu.test(name));
            if (uninstall) {
              try { execute('uninstall', path.join(installed, uninstall), ['/S', `_?=${installed}`], { windowsVerbatimArguments: true }); uninstalled = true; }
              catch (error) { errors.push(error); }
            }
          }
          await delay(500);
          report.remaining_processes = ownedProcesses().map((row) => row.ProcessId);
          assert.deepEqual(report.remaining_processes, []);
        }
        if (appLog && fs.existsSync(appLog)) fs.copyFileSync(appLog, path.join(evidence, 'windows-electron.log'));
      } catch (error) { errors.push(error); }
      if (errors.length) { report.passed = false; report.cleanup_error = errors.map((error) => error.stack || String(error)).join('\n'); }
      persist();
      if (errors.length) throw new AggregateError(errors, 'Windows owned-process cleanup failed');
    })();
    return cleanupPromise;
  };
  const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
    report.passed = false;
    report.error = `Acceptance interrupted by ${signal}`;
    persist();
    cleanup().catch((error) => { report.cleanup_error = error.stack || String(error); persist(); }).finally(() => process.exit(1));
  }]));
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);
  try {
    persist();
    requireCIWindows();
    const context = json(option('--release-context'));
    const directory = option('--candidate-directory');
    Object.assign(report, context);
    assert.equal(run('git', ['rev-parse', 'HEAD']).trim(), context.commit, 'Acceptance fixture source must match the candidate commit');
    const { artifact, manifest, installer, feedName } = validateBundle(directory, context);
    report.artifact_sha256 = artifact.sha256;
    report.to_version = context.version;
    report.from_version = previousVersion(context.version);
    assert.ok(compareVersions(report.from_version, report.to_version) < 0);
    const userData = path.join(process.env.APPDATA, context.channel === 'beta' ? 'GuziScholar-Beta' : 'guzi-scholar');
    assert.ok(!fs.existsSync(userData), 'Fresh VM required: production user data already exists');
    report.user_data = userData;
    const guid = identities[context.channel].guid;
    powershell(`foreach ($hive in @('HKCU:', 'HKLM:')) { foreach ($key in @('Software\\${guid}', 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}')) { if (Test-Path ($hive + '\\' + $key)) { throw 'Formal installation already exists' } } }`);
    let corrupt = false;
    const requests = [];
    server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      requests.push({ time: new Date().toISOString(), pathname, corrupt });
      if (pathname === `/${feedName}`) { response.writeHead(200, { 'Content-Type': 'text/yaml' }); fs.createReadStream(path.join(directory, feedName)).pipe(response); }
      else if (pathname === `/${encodeURIComponent(artifact.name)}`) {
        const bytes = fs.readFileSync(installer);
        if (corrupt) bytes[Math.floor(bytes.length / 2)] ^= 1;
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length }).end(bytes);
      } else response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fs.copyFileSync(path.join(directory, 'update-manifest.json'), path.join(root, 'update-manifest.json'));
    // A draft is not publicly discoverable. Only this old-version test transport
    // supplies a staged published descriptor to the unchanged manifest parser.
    write(path.join(root, 'staged-release.json'), { tag_name: context.tag, draft: false, prerelease: context.channel === 'beta',
      assets: [{ name: 'update-manifest.json', size: fs.statSync(path.join(directory, 'update-manifest.json')).size, state: 'uploaded', browser_download_url: assetURL(context.tag, 'update-manifest.json') },
        ...manifest.artifacts.map((item) => ({ name: item.name, size: item.size, state: 'uploaded', browser_download_url: item.url }))] });
    execute('prepare-runtime', process.execPath, [path.resolve(desktopRoot, '../../platforms/windows/build-windows.cjs'), 'prepare'], { timeout: 30 * 60 * 1000 });
    const library = path.join(userData, 'library');
    const state = path.join(userData, 'state');
    fs.mkdirSync(state, { recursive: true });
    execute('seed-library', path.join(desktopRoot, 'build/windows-pyinstaller-env/Scripts/python.exe'), [path.join(__dirname, 'fixtures/seed_library.py'), library]);
    fs.copyFileSync(path.join(library, 'settings.json'), path.join(state, 'settings.json'));
    const config = oldConfig(root, context, report.from_version, `http://127.0.0.1:${server.address().port}`, evidence);
    write(path.join(root, 'old-builder.json'), config);
    execute('build-old', process.execPath, [path.join(desktopRoot, 'node_modules/electron-builder/out/cli/cli.js'), '--projectDir', desktopRoot,
      '--config', path.join(root, 'old-builder.json'), '--win', 'nsis', '--x64', '--publish=never'], { timeout: 30 * 60 * 1000 });
    const initial = path.join(root, 'old-package', `Guzi-Scholar-${report.from_version}-windows-x64-setup.exe`);
    report.initial_artifact_sha256 = digest(initial);
    report.app_id = config.appId;
    report.nsis_guid = config.nsis.guid;
    execute('install-old', initial, ['/S', `/D=${installed}`], { windowsVerbatimArguments: true });
    const first = await launch();
    assert.equal(first.version, report.from_version);
    assert.equal(canonicalPath(first.executable), canonicalPath(executable));
    assert.equal(canonicalPath(first.userData), canonicalPath(userData));
    appLog = path.join(first.logs, 'my-scholar-electron.log');
    const discovery = await command('discover');
    assert.equal(discovery.version, context.version);
    assert.equal(discovery.sha256, artifact.sha256);
    assert.equal(discovery.downloadURL, artifact.url);
    assert.equal(discovery.status, 'available');
    assert.equal(events().filter((event) => event.type === 'discovery-request').length, 2);
    check('discover', { version: discovery.version, sha256: discovery.sha256, original_manifest: true, staged_descriptor: true });
    corrupt = true;
    const rejected = await command('download');
    assert.equal(rejected.canInstall, false);
    assert.match(rejected.error, /checksum|sha|校验|完整性/iu);
    assert.equal((await command('status')).version, report.from_version);
    assert.ok(!events().some((event) => event.type === 'install-authorized'));
    check('corrupt_rejected', { error: rejected.error });
    corrupt = false;
    const downloaded = await command('download');
    assert.equal(downloaded.status, 'ready');
    assert.equal(downloaded.canInstall, true);
    assert.equal((await command('cached')).sha256, artifact.sha256);
    check('download', { sha256: artifact.sha256 });
    await idle();
    await command('eval', { code: "window.__acceptanceFetch=window.fetch; window.fetch=(u,o)=>String(u).endsWith('/api/settings')&&['POST','PUT'].includes(o?.method)?Promise.resolve(new Response(JSON.stringify({error:'acceptance save failure'}),{status:507,headers:{'Content-Type':'application/json'}})):window.__acceptanceFetch(u,o); const c=document.querySelector('#setting-app-font'); c.selectedIndex=(c.selectedIndex+1)%c.options.length; c.dispatchEvent(new Event('change',{bubbles:true})); true;" });
    const cancelled = await command('install', { dialogResponse: 1 });
    assert.match(cancelled.error, /已取消安装/u);
    assert.equal((await command('status')).frozen, false);
    assert.ok(!events().some((event) => event.type === 'install-authorized'));
    assert.ok(events().some((event) => event.type === 'dialog' && event.title !== '安装更新并重新启动' && event.response === 1));
    check('save_cancel', { error: cancelled.error });
    await command('eval', { code: 'window.fetch=window.__acceptanceFetch; delete window.__acceptanceFetch; (async()=>{const result=await window.__myScholarFlushBeforeClose();window.__myScholarResumeAfterClose();return result;})()' });
    await quit();
    const restarted = await launch();
    assert.equal(restarted.version, report.from_version);
    assert.equal(restarted.update.canInstall, false);
    assert.ok(!events().some((event) => event.type === 'install-authorized'));
    check('ordinary_quit', { restarted_version: restarted.version });
    assert.equal((await command('download')).canInstall, true);
    await idle();
    const job = fs.readdirSync(path.join(library, 'jobs')).find((name) => /^[a-f0-9]{16}$/u.test(name));
    assert.ok(job, 'Seeded document required');
    const document = path.join(library, 'jobs', job, 'source.pdf');
    const notes = path.join(library, 'jobs', job, 'notes.md');
    fs.writeFileSync(notes, 'Original candidate Windows NSIS upgrade preserves these notes.\n');
    const preserved = [document, notes, path.join(state, 'settings.json')].map((file) => ({ file, sha256: digest(file) }));
    const logOffset = fs.existsSync(appLog) ? fs.statSync(appLog).size : 0;
    const oldPID = currentPID;
    send('install');
    const next = await until(() => {
      const metadataFile = path.join(installed, 'resources/app/package.json');
      if (!fs.existsSync(metadataFile)) return false;
      let metadata;
      try { metadata = json(metadataFile); } catch (_) { return false; }
      if (metadata.version !== context.version || metadata.main !== 'electron/main.cjs' || metadata.windowsReleaseAcceptance) return false;
      return ownedProcesses().find((row) => row.ProcessId !== oldPID && row.ExecutablePath
        && path.basename(row.ExecutablePath).toLowerCase() === 'guzi-scholar.exe' && canonicalPath(row.ExecutablePath) === canonicalPath(executable)
        && !/--type=/u.test(row.CommandLine || ''));
    }, 'original NSIS installed and relaunched unmodified target', 180000);
    currentPID = next.ProcessId;
    owned.add(currentPID);
    assert.ok(!alive(oldPID));
    assert.equal(events().filter((event) => event.type === 'install-authorized').length, 1);
    assert.equal(events().find((event) => event.type === 'install-authorized').sha256, artifact.sha256);
    const targetMetadata = json(path.join(installed, 'resources/app/package.json'));
    assert.equal(targetMetadata.updater.channel, context.channel);
    assert.equal(targetMetadata.updater.enabled, true);
    assert.ok(!targetMetadata.localTestBuild && !targetMetadata.windowsUpdateAcceptance && !targetMetadata.windowsReleaseAcceptance);
    assert.ok(!fs.existsSync(path.join(installed, 'resources/app/electron/windows-release-probe-main.cjs')), 'Target cannot retain the old test entry');
    assert.equal(digest(installer), artifact.sha256, 'Original candidate must remain byte-identical');
    const registered = JSON.parse(powershell(`$ErrorActionPreference='Stop'; $install=Get-ItemProperty 'HKCU:\\Software\\${guid}'; $uninstall=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}'; @{ InstallLocation=$install.InstallLocation; DisplayVersion=$uninstall.DisplayVersion } | ConvertTo-Json -Compress`));
    assert.equal(canonicalPath(registered.InstallLocation), canonicalPath(installed));
    assert.equal(registered.DisplayVersion, context.version);
    const startup = await until(() => {
      if (!alive(currentPID)) throw new Error('Original target exited during startup');
      const all = ownedProcesses();
      const descendants = new Set([currentPID]);
      let size;
      do { size = descendants.size; for (const row of all) if (descendants.has(row.ParentProcessId)) descendants.add(row.ProcessId); } while (size !== descendants.size);
      const backend = all.find((row) => descendants.has(row.ProcessId) && row.ExecutablePath
        && path.basename(row.ExecutablePath).toLowerCase() === 'my-scholar-server.exe'
        && canonicalPath(row.ExecutablePath) === canonicalPath(path.join(installed, 'resources/python-server/my-scholar-server.exe')));
      const renderer = all.find((row) => row.ParentProcessId === currentPID && /--type=renderer(?:\s|$)/u.test(row.CommandLine || '')
        && rendererUserData(row.CommandLine) && canonicalPath(rendererUserData(row.CommandLine)) === canonicalPath(userData));
      const targetLog = fs.existsSync(appLog) ? fs.readFileSync(appLog).subarray(logOffset).toString('utf8') : '';
      const ready = targetLog.match(/create-window shell=\S+ url=(http:\/\/127\.0\.0\.1:\d+)/u);
      const windowReady = targetLog.split(/\r?\n/u).find((line) => line.endsWith(`] window-ready pid=${currentPID} version=${context.version}`));
      return backend && renderer && ready && windowReady ? { backend_pid: backend.ProcessId, renderer_pid: renderer.ProcessId,
        renderer_user_data: rendererUserData(renderer.CommandLine), backend_ready_url: ready[1], ready_log: ready[0], window_ready_log: windowReady } : null;
    }, 'unmodified target backend, renderer, production userData and ready diagnostic', 90000);
    check('relaunch', { oldPID, newPID: currentPID, executable: next.ExecutablePath, installed_version: targetMetadata.version,
      installed_main: targetMetadata.main, registered, startup, original_artifact_sha256: digest(installer) });
    for (const item of preserved) assert.equal(digest(item.file), item.sha256, `Upgrade changed ${path.basename(item.file)}`);
    check('data_preserved', { user_data: startup.renderer_user_data, files: preserved.map((item) => ({ name: path.basename(item.file), sha256: item.sha256 })) });
    write(path.join(evidence, 'windows-transport.json'), { requests });
    report.passed = true;
    acceptance(report, context, artifact);
  } catch (error) { report.passed = false; report.error = error.stack || String(error); failure = error; }
  finally {
    try { await cleanup(); }
    catch (error) { report.passed = false; failure = new AggregateError([...(failure ? [failure] : []), error], 'Windows upgrade or cleanup failed'); }
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    persist();
    console.log(`Windows release acceptance report: ${output}`);
  }
  if (failure) throw failure;
}

module.exports = { requireCIWindows, previousVersion, validateBundle, oldConfig, rendererUserData };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
