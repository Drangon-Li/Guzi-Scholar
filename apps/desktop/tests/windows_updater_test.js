'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { NsisUpdater } = require('electron-updater');
const { createWindowsUpdater, validateCandidate, verifyFeed } = require('../electron/windows-updater.cjs');
const { createWindowsBuildConfig, identities } = require('../../../platforms/windows/builder-config.cjs');

const bytes = Buffer.from('isolated NSIS contract fixture');
const name = 'Guzi-Scholar-0.6.3-windows-x64-setup.exe';
const candidate = { repository: 'Drangon-Li/Guzi-Scholar', version: '0.6.3', channel: 'stable', platform: 'win32', arch: 'x64', assetName: name,
  downloadURL: `https://github.com/Drangon-Li/Guzi-Scholar/releases/download/v0.6.3/${name}`,
  size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  sha512: crypto.createHash('sha512').update(bytes).digest('base64'), minimumSystemVersion: '10.0.18362' };
const feed = () => ({ version: candidate.version, files: [{ url: name, size: candidate.size, sha512: candidate.sha512 }] });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitUntil(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected updater operation to start');
}

function fixture(directory, { spawn = async () => true, info = feed(), content = bytes, timeout = 2000 } = {}) {
  const app = new EventEmitter();
  app.quitCalls = 0;
  app.quit = () => { app.quitCalls += 1; };
  const adapter = { version: '0.6.2', name: 'guzi-scholar', isPackaged: true,
    userDataPath: directory, baseCachePath: directory, appUpdateConfigPath: path.join(directory, 'app-update.yml'),
    whenReady: async () => {}, quit: app.quit, onQuit: (handler) => app.on('quit', (_, code) => handler(code)) };
  // Exercise the pinned production NsisUpdater.doInstall and BaseUpdater
  // quitAndInstall, replacing only network and detached process creation.
  const updater = new NsisUpdater(undefined, adapter);
  updater.logger = null;
  updater.spawnLog = spawn;
  updater.checkForUpdates = async () => ({ updateInfo: info });
  updater.downloadUpdate = async () => {
    const filename = path.join(directory, 'pending', name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    updater.downloadedUpdateHelper = { file: filename, downloadedFileInfo: { isAdminRightsRequired: false } };
    updater.emit('download-progress', { transferred: content.length, bytesPerSecond: 1024 });
    updater.addQuitHandler();
    return [filename];
  };
  const errors = [];
  const api = createWindowsUpdater({ app, cacheDirectory: directory, updater, onError: (error) => errors.push(error), installStartTimeout: timeout });
  return { app, updater, api, errors };
}

async function main() {
  assert.equal(require('electron-updater/package.json').version, '6.8.11', 'Private instance guard must be reviewed when updater changes');
  assert.equal(validateCandidate(candidate), new URL('.', candidate.downloadURL).toString());
  for (const changed of [{ size: 0 }, { sha512: '0'.repeat(128) }, { assetName: '../bad.exe' }, { downloadURL: 'http://127.0.0.1/update.exe' }, { channel: 'beta' }]) {
    assert.throws(() => validateCandidate({ ...candidate, ...changed }));
  }
  assert.throws(() => validateCandidate({ ...candidate, repository: 'attacker/repository' }));
  assert.throws(() => validateCandidate({ ...candidate, downloadURL: `https://attacker.invalid/${name}` }), /固定仓库/u);
  assert.throws(() => validateCandidate({ ...candidate, downloadURL: candidate.downloadURL.replace('/v0.6.3/', '/v0.6.4/') }), /固定仓库/u);
  assert.throws(() => validateCandidate({ ...candidate, version: '01.6.3' }));
  const loopbackCandidate = { ...candidate, downloadURL: `http://127.0.0.1:12345/${name}` };
  assert.throws(() => validateCandidate(loopbackCandidate));
  assert.equal(validateCandidate(loopbackCandidate, { allowLoopback: true }), 'http://127.0.0.1:12345/');
  assert.throws(() => validateCandidate({ ...loopbackCandidate, downloadURL: `http://localhost:12345/${name}` }, { allowLoopback: true }));
  for (const changed of [{ version: '99.0.0' }, { files: [{ ...feed().files[0], size: 1 }] },
    { files: [{ ...feed().files[0], sha512: crypto.randomBytes(64).toString('base64') }] },
    { files: [{ ...feed().files[0], url: 'https://attacker.invalid/installer.exe' }] },
    { files: [...feed().files, feed().files[0]] }, { packages: {} }]) {
    assert.throws(() => verifyFeed({ ...feed(), ...changed }, candidate, new URL('.', candidate.downloadURL).toString()));
  }
  const stable = createWindowsBuildConfig({ GUZI_UPDATE_CHANNEL: 'stable' });
  const beta = createWindowsBuildConfig({ GUZI_UPDATE_CHANNEL: 'beta' });
  assert.equal(stable.appId, 'com.guzi.scholar');
  assert.equal(stable.nsis.guid, identities.stable.guid);
  const { UUID } = require('builder-util-runtime');
  assert.equal(stable.nsis.guid, UUID.v5('com.guzi.scholar', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')), 'Stable GUID must preserve electron-builder previous default');
  assert.equal(beta.appId, 'com.guzi.scholar.beta');
  assert.notEqual(stable.nsis.guid, beta.nsis.guid);
  assert.equal(stable.nsis.perMachine, false);
  assert.equal(stable.nsis.oneClick, false);
  assert.equal(stable.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(stable.nsis.deleteAppDataOnUninstall, false);
  assert.equal(stable.publish[0].channel, 'latest');
  assert.equal(beta.publish[0].channel, 'beta');
  assert.equal(stable.extraMetadata.updater.minimumSystemVersion, '10.0.18362');
  assert.equal(stable.win.verifyUpdateCodeSignature, false);
  assert.equal(createWindowsBuildConfig({}).extraMetadata.updater.enabled, false);
  assert.throws(() => createWindowsBuildConfig({ GUZI_WINDOWS_BUILD_MODE: 'release' }), /explicit certificate/u);
  const signed = createWindowsBuildConfig({ GUZI_WINDOWS_BUILD_MODE: 'release', WIN_CSC_LINK: 'build-input.pfx', GUZI_WINDOWS_PUBLISHER_NAME: 'Build Publisher' });
  assert.equal(signed.forceCodeSigning, true);
  assert.equal(signed.win.signtoolOptions.publisherName, 'Build Publisher');
  const probe = createWindowsBuildConfig({ GUZI_WINDOWS_BUILD_MODE: 'acceptance', GUZI_WINDOWS_ACCEPTANCE_ID: 'isolated123' });
  assert.match(probe.appId, /^com\.guzi\.scholar\.update-acceptance\./u);
  assert.notEqual(probe.nsis.guid, stable.nsis.guid);
  assert.notEqual(probe.nsis.guid, beta.nsis.guid);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-windows-updater-'));
  const originalLoad = Module._load;
  Module._load = function load(request, ...args) {
    if (request === 'electron') return { autoUpdater: new EventEmitter() };
    return originalLoad.call(this, request, ...args);
  };
  try {
    const normal = fixture(path.join(directory, 'normal'));
    const progress = [];
    await normal.api.download(candidate, (event) => progress.push(event));
    assert.equal(normal.updater.autoDownload, false);
    assert.equal(normal.updater.autoInstallOnAppQuit, false);
    assert.equal(normal.updater.allowDowngrade, false);
    assert.equal(progress.at(-1).percent, 100);
    assert.deepEqual(await normal.api.getDownloadedCandidate(), candidate);
    assert.equal(await normal.api.canInstall(candidate), true);
    assert.equal(await normal.api.canInstall({ ...candidate, sha256: 'a'.repeat(64) }), false);
    assert.equal(await normal.api.canInstall({ ...candidate, size: candidate.size + 1 }), false);
    assert.equal(await normal.api.canInstall({ ...candidate, minimumSystemVersion: '10.0.19041' }), false);
    normal.api.cancelPreparedUpdateForExit();
    assert.equal(await normal.api.canInstall(candidate), true, 'Save cancellation preserves verified update readiness');
    normal.app.emit('quit', {}, 0);
    await tick();
    assert.equal(normal.app.quitCalls, 0, 'Ordinary quit must not launch updater');
    normal.api.dispose();

    const mismatch = fixture(path.join(directory, 'mismatch'), { content: Buffer.alloc(bytes.length) });
    await assert.rejects(mismatch.api.download(candidate), /完整性/u);
    await assert.rejects(mismatch.api.install(candidate), /先下载/u);
    mismatch.api.dispose();
    const wrongSize = fixture(path.join(directory, 'size'), { content: Buffer.from('short') });
    await assert.rejects(wrongSize.api.download(candidate), /大小/u);
    wrongSize.api.dispose();

    const badFeed = fixture(path.join(directory, 'bad-feed'), { info: { ...feed(), version: '0.6.4' } });
    await assert.rejects(badFeed.api.download(candidate), /元数据/u);
    badFeed.api.dispose();

    let acceptSpawn;
    let installArguments;
    const delayed = fixture(path.join(directory, 'delayed'), { spawn: (_filename, args) => new Promise((resolve) => { installArguments = args; acceptSpawn = resolve; }) });
    await delayed.api.download(candidate);
    let settled = false;
    delayed.api.install({ ...candidate }).finally(() => { settled = true; }).catch(() => {});
    await waitUntil(() => typeof acceptSpawn === 'function');
    assert.deepEqual(installArguments, ['--updated', '/S', '--force-run'], 'Silent subsequent update must relaunch without changing installation directory');
    assert.equal(delayed.app.quitCalls, 0, 'Real v6 BaseUpdater queued quit must wait for spawn');
    acceptSpawn(true);
    await tick();
    assert.equal(delayed.app.quitCalls, 1);
    assert.equal(settled, false, 'Installer accepted/start must not resolve install');
    delayed.updater.emit('error', new Error('late installer failure'));
    await tick();
    assert.equal(settled, true);
    assert.equal(delayed.errors.at(-1).message, 'late installer failure');
    delayed.api.dispose();

    const quitting = fixture(path.join(directory, 'quitting'));
    await quitting.api.download(candidate);
    let quitRejected = false;
    quitting.api.install(candidate).catch(() => { quitRejected = true; });
    await waitUntil(() => quitting.app.quitCalls === 1);
    quitting.api.dispose();
    await tick();
    assert.equal(quitRejected, false, 'will-quit disposal must not reject a started installer');
    assert.equal(quitting.updater.listenerCount('error'), 2, 'Keep default and factory error listeners until actual app quit');
    quitting.app.emit('quit', {}, 0);
    assert.equal(quitting.updater.listenerCount('error'), 1);

    const lateFailure = fixture(path.join(directory, 'late-error'));
    await lateFailure.api.download(candidate);
    const lateInstall = lateFailure.api.install(candidate);
    await waitUntil(() => lateFailure.app.quitCalls === 1);
    lateFailure.api.dispose();
    lateFailure.updater.emit('error', new Error('installer failed before quit'));
    await assert.rejects(lateInstall, /installer failed before quit/u);
    lateFailure.app.emit('quit', {}, 0);

    for (const code of ['ENOENT', 'EINVAL']) {
      const failed = fixture(path.join(directory, code), { spawn: async () => { throw Object.assign(new Error(`spawn failed ${code}`), { code }); } });
      await failed.api.download(candidate);
      await assert.rejects(failed.api.install(candidate), /spawn failed/u);
      await tick();
      assert.equal(failed.app.quitCalls, 0, 'Failed spawn must keep application running');
      failed.api.dispose();
    }
    const timeout = fixture(path.join(directory, 'timeout'), { spawn: () => new Promise(() => {}), timeout: 10 });
    await timeout.api.download(candidate);
    await assert.rejects(timeout.api.install(candidate), /启动超时/u);
    await tick();
    assert.equal(timeout.app.quitCalls, 0);
    timeout.api.dispose();

    const restored = fixture(path.join(directory, 'normal'));
    let restoreChecks = 0;
    let restoreDownloads = 0;
    const explicitCheck = restored.updater.checkForUpdates;
    const explicitDownload = restored.updater.downloadUpdate;
    restored.updater.checkForUpdates = async () => { restoreChecks += 1; return explicitCheck(); };
    restored.updater.downloadUpdate = async () => { restoreDownloads += 1; return explicitDownload(); };
    assert.deepEqual(await restored.api.getDownloadedCandidate(), candidate);
    assert.equal(restoreChecks, 0, 'Startup cache restoration must not check a remote feed');
    assert.equal(restoreDownloads, 0, 'Startup cache restoration must not download or hydrate');
    assert.equal(await restored.api.canInstall(candidate), false, 'A local cached package alone is not an initialized NSIS installer');
    await assert.rejects(restored.api.install(candidate), /先下载/u);
    assert.ok(fs.existsSync(path.join(directory, 'normal', 'pending', name)), 'Keep disk cache for a later explicit action');
    await restored.api.download(candidate);
    assert.equal(restoreChecks, 1);
    assert.equal(restoreDownloads, 1);
    assert.equal(await restored.api.canInstall(candidate), true);
    fs.writeFileSync(path.join(directory, 'normal', 'pending', name), Buffer.alloc(bytes.length));
    await assert.rejects(restored.api.getDownloadedCandidate(), /完整性/u);
    restored.api.dispose();

    const poisonDirectory = path.join(directory, 'poison');
    const cacheSource = fixture(poisonDirectory);
    await cacheSource.api.download(candidate);
    cacheSource.api.dispose();
    const recordPath = path.join(poisonDirectory, 'candidate.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.candidate.downloadURL = `https://attacker.invalid/${name}`;
    fs.writeFileSync(recordPath, JSON.stringify(record));
    const poisoned = fixture(poisonDirectory);
    let fetched = false;
    poisoned.updater.checkForUpdates = async () => { fetched = true; throw new Error('Must not fetch tampered cache feed'); };
    assert.equal(await poisoned.api.getDownloadedCandidate(), null);
    assert.equal(fetched, false, 'Reject a persisted external URL before any network access');
    poisoned.api.dispose();
  } finally { Module._load = originalLoad; fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('Windows updater tests passed (pinned NSIS contract, integrity, quit guard, cache, channel identity).');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
