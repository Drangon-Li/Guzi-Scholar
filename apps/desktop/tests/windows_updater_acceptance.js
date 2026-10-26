'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createWindowsBuildConfig } = require('../../../platforms/windows/builder-config.cjs');
const desktopRoot = path.resolve(__dirname, '..');
const windowsRoot = path.resolve(desktopRoot, '../../platforms/windows');
const initialVersion = '0.6.2';
const targetVersion = '0.6.3';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (file, algorithm = 'sha256', encoding = 'hex') => new Promise((resolve, reject) => {
  const hash = crypto.createHash(algorithm);
  fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest(encoding)));
});
function run(command, args, options = {}) {
  const { logFile, onResult, ...spawnOptions } = options;
  const output = logFile ? fs.openSync(logFile, 'a') : undefined;
  let result;
  try {
    if (logFile) fs.writeSync(output, `${JSON.stringify({ command, args, cwd: desktopRoot })}\n`);
    result = spawnSync(command, args, { cwd: desktopRoot, encoding: 'utf8', windowsHide: true, timeout: 180000,
      ...spawnOptions, ...(logFile ? { stdio: ['ignore', output, output] } : {}) });
    onResult?.(result);
    if (logFile) fs.writeSync(output, `\n${JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message })}\n`);
  } finally { if (output !== undefined) fs.closeSync(output); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${logFile || `${result.stdout || ''}\n${result.stderr || ''}`}`);
  return result.stdout;
}
function requireWindows() {
  assert.equal(process.platform, 'win32', 'Real Windows x64 environment required; this harness cannot accept an upgrade on macOS/Linux.');
  assert.equal(process.arch, 'x64');
}
function configFor(root, id, version, output, evidence = root) {
  const config = createWindowsBuildConfig({ GUZI_WINDOWS_BUILD_MODE: 'acceptance', GUZI_WINDOWS_ACCEPTANCE_ID: id });
  config.directories.output = output;
  config.extraMetadata.version = version;
  config.extraMetadata.main = 'electron/windows-updater-probe-main.cjs';
  config.extraMetadata.windowsUpdateAcceptance.root = root;
  config.extraMetadata.windowsUpdateAcceptance.eventsPath = path.join(evidence, 'events.jsonl');
  config.extraResources.push({ from: path.join(__dirname, 'fixtures/windows-updater-probe-main.cjs'), to: 'app/electron/windows-updater-probe-main.cjs' });
  config.publish = [{ provider: 'generic', url: 'http://127.0.0.1/unused', channel: 'latest' }];
  if (version === targetVersion) config.extraResources.push({ from: path.join(root, 'sentinel'), to: 'upgrade-acceptance-sentinel' });
  return config;
}
async function main() {
  if (process.argv.includes('--check')) {
    const config = configFor(path.join(os.tmpdir(), 'guzi-acceptance-check'), 'check12345', initialVersion, path.join(os.tmpdir(), 'guzi-acceptance-output'));
    assert.match(config.appId, /^com\.guzi\.scholar\.update-acceptance\./u);
    assert.equal(config.forceCodeSigning, false);
    assert.equal(config.extraMetadata.updater.enabled, false);
    if (process.platform === 'win32') requireWindows();
    else assert.throws(() => requireWindows(), /Real Windows/u);
    console.log('Windows acceptance harness static checks passed; no installed upgrade was performed.');
    return;
  }
  requireWindows();
  assert.ok(process.argv.includes('--build-and-run'), 'Usage: node tests/windows_updater_acceptance.js --build-and-run (builds two isolated NSIS packages and installs only that identity)');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-windows-upgrade-'));
  const evidence = process.env.GUZI_WINDOWS_UPGRADE_EVIDENCE_DIR
    ? path.resolve(process.env.GUZI_WINDOWS_UPGRADE_EVIDENCE_DIR) : path.join(root, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  assert.ok(!fs.existsSync(path.join(evidence, 'report.json')), 'Use a fresh acceptance evidence directory');
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(root, '.owner'), id, { flag: 'wx' });
  fs.writeFileSync(path.join(root, 'sentinel'), id);
  const installed = path.join(root, '安装 路径');
  const executable = path.join(installed, 'Guzi-Scholar.exe');
  const environment = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    APPDATA: path.join(root, 'AppData/Roaming'), LOCALAPPDATA: path.join(root, 'AppData/Local') };
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) delete environment[name];
  const report = { schema: 1, kind: 'isolated-nsis-upgrade', status: 'running', root, evidence, id, platform: process.platform, arch: process.arch,
    osRelease: os.release(), initialVersion, targetVersion, signed: false, productionCertificateValidated: false, minimumWindowsVersionValidated: false, checks: [], artifacts: [] };
  const eventsPath = path.join(evidence, 'events.jsonl');
  const events = () => fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const persist = () => writeJSON(path.join(evidence, 'report.json'), report);
  const note = (name, data = {}) => { report.checks.push({ name, ...data }); persist(); console.log(name); };
  let sequence = 0;
  let currentPID;
  let server;
  let source;
  let brokenBytes = false;
  let uninstalled = false;
  let failure;
  let cleanupFailure;
  const owned = new Set();
  const execute = (name, executable, args, options = {}) => run(executable, args, { ...options,
    logFile: path.join(evidence, `${name}.log`), onResult: (result) => { if (result.pid) owned.add(result.pid); } });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  async function until(predicate, label, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await delay(150); }
    throw new Error(`Timed out: ${label}`);
  }
  function writeJSON(filename, value) {
    fs.writeFileSync(`${filename}.tmp`, JSON.stringify(value, null, 2));
    fs.renameSync(`${filename}.tmp`, filename);
  }
  function send(action, extra = {}) {
    const command = { id: `${Date.now()}-${++sequence}`, targetPID: currentPID, action, ...extra };
    writeJSON(path.join(root, 'command.json'), command);
    return command.id;
  }
  async function command(action, extra = {}, timeout) {
    const commandID = send(action, extra);
    const response = await until(() => events().find((event) => event.type === 'result' && event.id === commandID), action, timeout);
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  async function launch() {
    const output = fs.openSync(path.join(evidence, 'app-output.log'), 'a');
    const child = spawn(executable, [], { env: environment, stdio: ['ignore', output, output] });
    child.on('error', (error) => { report.launchError = error.stack || String(error); });
    fs.closeSync(output);
    currentPID = child.pid;
    owned.add(child.pid);
    await until(() => events().some((event) => event.type === 'launched' && event.pid === currentPID), 'launch installed app');
    await until(async () => { try { return (await command('status', {}, 3000)).ready; } catch (_) { return false; } }, 'real renderer save hook');
    return command('status');
  }
  async function quit() { const pid = currentPID; send('quit'); await until(() => !alive(pid), 'ordinary quit', 30000); }
  const idle = () => until(async () => Boolean(await command('eval', { code: "fetch('/api/health').then(r => r.json()).then(x => x.storage.migration.ready)" })), 'backend idle');
  function isolatedProcesses() {
    const rows = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress']));
    for (const row of rows) if (row.ProcessId !== process.pid && (row.ExecutablePath?.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)
      || row.CommandLine?.toLowerCase().includes(root.toLowerCase()))) owned.add(row.ProcessId);
    let count;
    do { count = owned.size; for (const row of rows) if (owned.has(row.ParentProcessId)) owned.add(row.ProcessId); } while (owned.size !== count);
    return rows.filter((row) => owned.has(row.ProcessId));
  }
  try {
    persist();
    fs.writeFileSync(eventsPath, '');
    for (const folder of [environment.APPDATA, environment.LOCALAPPDATA, path.join(root, 'user-data'), path.join(root, 'state')]) fs.mkdirSync(folder, { recursive: true });
    execute('prepare-runtime', process.execPath, [path.join(windowsRoot, 'build-windows.cjs'), 'prepare'], { env: environment, timeout: 30 * 60 * 1000 });
    const python = path.join(desktopRoot, 'build/windows-pyinstaller-env/Scripts/python.exe');
    const library = path.join(root, '文献 库');
    execute('seed-library', python, [path.join(__dirname, 'fixtures/seed_library.py'), library]);
    fs.copyFileSync(path.join(library, 'settings.json'), path.join(root, 'state/settings.json'));
    for (const version of [initialVersion, targetVersion]) {
      const output = path.join(root, version);
      const config = configFor(root, id, version, output, evidence);
      report.appId = config.appId;
      report.guid = config.nsis.guid;
      const configPath = path.join(root, `builder-${version}.json`);
      writeJSON(configPath, config);
      execute(`build-${version}`, process.execPath, [path.join(desktopRoot, 'node_modules/electron-builder/out/cli/cli.js'), '--projectDir', desktopRoot, '--config', configPath, '--win', 'nsis', '--x64', '--publish=never'],
        { env: environment, timeout: 30 * 60 * 1000 });
      const installer = path.join(output, `Guzi-Scholar-${version}-windows-x64-setup.exe`);
      report.artifacts.push({ version, path: installer, size: fs.statSync(installer).size, sha256: await digest(installer) });
      persist();
    }
    const initial = report.artifacts[0].path;
    const target = report.artifacts[1].path;
    source = fs.readFileSync(target);
    server = http.createServer((request, response) => {
      if (request.url?.split('?')[0] === '/latest.yml') {
        response.writeHead(200, { 'Content-Type': 'text/yaml' }).end(`version: ${targetVersion}\nfiles:\n  - url: ${path.basename(target)}\n    size: ${source.length}\n    sha512: ${crypto.createHash('sha512').update(source).digest('base64')}\npath: ${path.basename(target)}\nsha512: ${crypto.createHash('sha512').update(source).digest('base64')}\nreleaseDate: '${new Date().toISOString()}'\n`);
      } else if (request.url?.split('?')[0] === `/${path.basename(target)}`) {
        const data = Buffer.from(source);
        if (brokenBytes) data[Math.floor(data.length / 2)] ^= 1;
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length }).end(data);
      } else response.writeHead(404).end();
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const candidate = { repository: 'Drangon-Li/Guzi-Scholar', version: targetVersion, channel: 'stable', platform: 'win32', arch: 'x64', assetName: path.basename(target),
      downloadURL: `http://127.0.0.1:${server.address().port}/${path.basename(target)}`, size: source.length,
      sha256: await digest(target), sha512: await digest(target, 'sha512', 'base64'), minimumSystemVersion: '10.0.18362' };
    writeJSON(path.join(root, 'candidate.json'), candidate);
    execute('install-initial', initial, ['/S', `/D=${installed}`], { env: environment, windowsVerbatimArguments: true });
    const first = await launch();
    assert.equal(first.version, initialVersion);
    assert.equal(path.resolve(first.executable), path.resolve(executable));
    assert.equal(path.resolve(first.userData), path.join(root, 'user-data'));
    note('isolated-installed-identity', { appId: report.appId, guid: report.guid, executable });
    brokenBytes = true;
    await assert.rejects(command('download', {}, 180000), /checksum|sha|校验|完整性/iu);
    brokenBytes = false;
    assert.equal((await command('status')).version, initialVersion);
    note('corrupt-download-blocked');
    await command('download', {}, 180000);
    await idle();
    await command('eval', { code: "window.__acceptanceFetch = window.fetch; window.fetch = (u,o) => String(u).endsWith('/api/settings') && ['POST','PUT'].includes(o?.method) ? Promise.resolve(new Response(JSON.stringify({error:'acceptance save failure'}),{status:507,headers:{'Content-Type':'application/json'}})) : window.__acceptanceFetch(u,o); const c=document.querySelector('#setting-app-font'); c.selectedIndex=(c.selectedIndex+1)%c.options.length; c.dispatchEvent(new Event('change',{bubbles:true})); true;" });
    const blocked = await command('install', { dialogResponse: 1 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.cancelled, true);
    assert.equal((await command('status')).frozen, false);
    assert.ok(!events().some((event) => event.type === 'install-authorized'));
    note('save-cancel-blocks-installer');
    await command('eval', { code: 'window.fetch=window.__acceptanceFetch; delete window.__acceptanceFetch; (async()=>{const saved=await window.__myScholarFlushBeforeClose();window.__myScholarResumeAfterClose();return saved;})()' });
    await quit();
    await launch();
    assert.equal((await command('status')).version, initialVersion);
    note('ordinary-quit-does-not-install');
    const restored = await command('restore', {}, 180000);
    assert.equal(restored.version, targetVersion);
    assert.equal(await command('can-install'), false, 'Restoring a local cache must not silently initialize the installer');
    await command('download', {}, 180000);
    assert.equal(await command('can-install'), true);
    note('cached-package-revalidated-by-explicit-download');
    const job = fs.readdirSync(path.join(library, 'jobs')).find((name) => /^[a-f0-9]{16}$/u.test(name));
    assert.ok(job, 'Seeded paper must exist');
    const document = path.join(library, 'jobs', job, 'source.pdf');
    const notes = path.join(library, 'jobs', job, 'notes.md');
    const noteText = 'Windows NSIS upgrade preserves these notes.\n';
    fs.writeFileSync(notes, noteText);
    const documentHash = await digest(document);
    const settingsHash = await digest(path.join(root, 'state/settings.json'));
    await idle();
    const oldPID = currentPID;
    send('install');
    const relaunched = await until(() => events().find((event) => event.type === 'launched' && event.version === targetVersion), 'real NSIS upgrade and force relaunch', 180000);
    currentPID = relaunched.pid;
    owned.add(currentPID);
    assert.equal(relaunched.executable, executable);
    assert.equal(relaunched.userData, path.join(root, 'user-data'));
    assert.equal(relaunched.guid, report.guid);
    assert.equal(await digest(document), documentHash);
    assert.equal(await digest(path.join(root, 'state/settings.json')), settingsHash);
    assert.equal(fs.readFileSync(notes, 'utf8'), noteText);
    assert.equal(fs.readFileSync(path.join(installed, 'resources/upgrade-acceptance-sentinel'), 'utf8'), id);
    assert.ok(!alive(oldPID));
    await until(async () => { try { return (await command('status', {}, 3000)).ready; } catch (_) { return false; } }, 'new version renderer');
    note('real-upgrade-preserves-path-data-and-relaunches', { oldPID, newPID: currentPID, documentHash, settingsHash });
    await quit();
    const uninstall = fs.readdirSync(installed).find((name) => /^Uninstall.*\.exe$/iu.test(name));
    assert.ok(uninstall);
    execute('uninstall', path.join(installed, uninstall), ['/S', `_?=${installed}`], { env: environment, windowsVerbatimArguments: true });
    await until(() => !fs.existsSync(executable), 'isolated uninstallation');
    uninstalled = true;
    assert.equal(fs.readFileSync(notes, 'utf8'), noteText);
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.stack || String(error); failure = error; }
  finally {
    try {
      server?.close();
      assert.equal(fs.readFileSync(path.join(root, '.owner'), 'utf8'), id);
      const remaining = isolatedProcesses();
      const errors = [];
      for (const item of remaining) {
        try { if (alive(item.ProcessId)) execute(`cleanup-${item.ProcessId}`, path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(item.ProcessId), '/T', '/F']); }
        catch (error) { if (alive(item.ProcessId)) errors.push(error); }
      }
      if (!uninstalled && fs.existsSync(installed)) {
        const uninstall = fs.readdirSync(installed).find((name) => /^Uninstall.*\.exe$/iu.test(name));
        if (uninstall) execute('cleanup-uninstall', path.join(installed, uninstall), ['/S', `_?=${installed}`], { env: environment, windowsVerbatimArguments: true });
      }
      await delay(500);
      report.remainingProcesses = isolatedProcesses().map((item) => item.ProcessId);
      assert.deepEqual(report.remainingProcesses, []);
      assert.equal(errors.length, 0, errors.map((error) => error.message).join('\n'));
    } catch (error) { report.status = 'failed'; report.cleanupError = error.stack || String(error); cleanupFailure = error; }
    try {
      persist();
    }
    catch (error) { cleanupFailure = cleanupFailure ? new AggregateError([cleanupFailure, error], 'Cleanup and evidence write failed') : error; }
    console.log(`Windows acceptance evidence: ${path.join(evidence, 'report.json')}`);
  }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], 'Windows upgrade and cleanup failed');
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
}

module.exports = { configFor, requireWindows, run };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
