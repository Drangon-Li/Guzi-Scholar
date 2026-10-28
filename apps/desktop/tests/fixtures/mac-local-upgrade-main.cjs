'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const metadata = require('../package.json');
const probe = metadata.macLocalUpgrade;
assert.equal(process.platform, 'darwin');
assert(app.isPackaged && probe?.protocol === 1 && !metadata.localTestBuild);
assert(path.isAbsolute(probe.root));
const root = fs.realpathSync(probe.root);
const owner = JSON.parse(fs.readFileSync(path.join(root, 'owner.json'), 'utf8'));
assert.equal(owner.protocol, 1);
for (const key of ['root', 'bundleID', 'installed', 'userData']) assert.equal(owner[key], probe[key]);
assert.equal(path.resolve(app.getAppPath(), '../../..'), probe.installed);
assert.equal(probe.installed, path.join(root, 'installed', '谷子学术.app'));
assert.equal(probe.userData, path.join(root, 'user-data'));
assert.match(probe.bundleID, /^com\.guzi\.scholar\.upgradetest\.[a-f0-9]+$/u);

const eventFile = path.join(root, 'events.jsonl');
const record = (type, data = {}) => fs.appendFileSync(eventFile, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, version: app.getVersion(), type, ...data })}\n`);
process.on('uncaughtExceptionMonitor', (error, origin) => record('main-process-error', { origin, error: error.stack || String(error) }));

// Both installed versions use this bootstrap, so Sparkle relaunch cannot fall back to the user's profile.
const paths = { appData: path.join(root, 'app-data'), userData: probe.userData, sessionData: path.join(root, 'session-data'), logs: path.join(root, 'logs'), crashDumps: path.join(root, 'crash-dumps') };
const setPath = app.setPath.bind(app);
for (const [key, value] of Object.entries(paths)) {
  fs.mkdirSync(value, { recursive: true });
  setPath(key, value);
}
app.setPath = (key, value) => {
  if (Object.hasOwn(paths, key)) assert.equal(path.resolve(value), paths[key], `Test ${key} must remain isolated`);
  return setPath(key, value);
};
const setAppLogsPath = app.setAppLogsPath.bind(app);
app.setAppLogsPath = (value) => {
  assert.equal(path.resolve(value), paths.logs);
  return setAppLogsPath(value);
};
app.commandLine.appendSwitch('disk-cache-dir', path.join(root, 'cache'));
process.env.MY_SCHOLAR_SETTINGS_FILE = path.join(probe.userData, 'state', 'settings.json');
process.env.MY_SCHOLAR_DEVELOPER_TOKENS_FILE = path.join(root, 'developer-tokens.json');
if (!fs.existsSync(process.env.MY_SCHOLAR_DEVELOPER_TOKENS_FILE)) fs.writeFileSync(process.env.MY_SCHOLAR_DEVELOPER_TOKENS_FILE, '{}', { mode: 0o600 });
app.moveToApplicationsFolder = () => { throw new Error('Local upgrade acceptance must never replace a user application'); };
const installation = require('./macos-installation.cjs');
installation.requestMacInstallation = () => ({ action: 'continue' });
installation.consumeInstallationMarker = () => null;

const showMessageBox = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = (...args) => {
  const options = args.at(-1);
  if (options.title === '发现新版本' && options.type === 'info' && JSON.stringify(options.buttons) === JSON.stringify(['查看更新', '稍后'])) {
    record('dialog', { title: options.title, response: 1, expected: true });
    return Promise.resolve({ response: 1, checkboxChecked: false });
  }
  if (options.title === '安装更新并重新启动') {
    record('dialog', { title: options.title, response: 0, expected: true });
    return Promise.resolve({ response: 0, checkboxChecked: false });
  }
  record('unexpected-dialog', { title: options.title, message: options.message, dialogType: options.type });
  return showMessageBox(...args);
};
const showMessageBoxSync = dialog.showMessageBoxSync.bind(dialog);
dialog.showMessageBoxSync = (...args) => {
  const options = args.at(-1);
  record('unexpected-dialog', { title: options.title, message: options.message, dialogType: options.type });
  return showMessageBoxSync(...args);
};
const showErrorBox = dialog.showErrorBox.bind(dialog);
dialog.showErrorBox = (title, content) => {
  record('error-dialog', { title, content });
  return showErrorBox(title, content);
};

app.on('web-contents-created', (_event, contents) => {
  const execute = contents.executeJavaScript.bind(contents);
  contents.executeJavaScript = (code, ...args) => {
    if (!code.includes('window.__myScholarFlushBeforeClose(')) return execute(code, ...args);
    record('save-gate', { phase: 'start' });
    return execute(code, ...args).then((result) => {
      record('save-gate', { phase: 'complete', result });
      return result;
    }, (error) => {
      record('save-gate', { phase: 'failed', error: error.message });
      throw error;
    });
  };
  contents.on('render-process-gone', (_event, details) => record('renderer-error', details));
});
app.on('browser-window-created', (_event, window) => {
  window.on('unresponsive', () => record('renderer-error', { reason: 'unresponsive' }));
});

const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const service = require('./update-service.cjs');
const findReleaseUpdate = service.findReleaseUpdate;
service.findReleaseUpdate = (options) => {
  const releaseManifest = JSON.parse(fs.readFileSync(path.join(root, 'update-manifest.json'), 'utf8'));
  const release = { tag_name: `v${releaseManifest.version}`, draft: false, prerelease: false, assets: releaseManifest.artifacts.map((item) => ({ name: item.name, size: item.size, state: 'uploaded', browser_download_url: item.url })) };
  release.assets.push({ name: 'update-manifest.json', size: Buffer.byteLength(JSON.stringify(releaseManifest)), state: 'uploaded', browser_download_url: service.assetURL(release.tag_name, 'update-manifest.json') });
  return findReleaseUpdate({ ...options, fetcher: async (url) => url.endsWith('update-manifest.json') ? releaseManifest : release });
};
const mac = require('./mac-updater.cjs');
const createMacUpdater = mac.createMacUpdater;
let adapter;
mac.createMacUpdater = (options) => {
  adapter = createMacUpdater({ ...options, fetch: (_url, request) => globalThis.fetch(manifest().downloadURL, request), onEvent: (event) => record('sparkle', { event }) });
  const install = adapter.install;
  adapter.install = (selected) => {
    record('install-authorized', { version: selected.version });
    return install(selected);
  };
  return adapter;
};
const controllers = require('./update-controller.cjs');
const createUpdateController = controllers.createUpdateController;
let latestState;
let revision = 0;
controllers.createUpdateController = (options) => {
  const controller = createUpdateController(options);
  controller.onState((state) => { latestState = state; revision++; });
  return controller;
};

require('./main.cjs');
record('configuration', { userData: app.getPath('userData'), logs: app.getPath('logs'), bundleID: probe.bundleID, channel: metadata.updater.channel });

async function evaluate(code) {
  const window = BrowserWindow.getAllWindows()[0];
  assert(window, 'No renderer');
  return window.webContents.executeJavaScript(code, true);
}
async function clickUpdate(selector) {
  const before = revision;
  await evaluate(`(() => {
    document.querySelector('[data-view="settings-view"]').click();
    document.querySelector('a[href="#settings-updates"]').click();
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button || button.hidden || button.disabled) throw new Error('Update UI button unavailable: ' + ${JSON.stringify(selector)});
    button.click();
    return true;
  })()`);
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    if (revision > before && latestState?.canCheck) return latestState;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Update UI action timed out');
}
async function handle(command) {
  switch (command.action) {
    case 'status': {
      const identity = { pid: process.pid, version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'), logs: app.getPath('logs') };
      const window = BrowserWindow.getAllWindows()[0];
      if (!window || window.webContents.isLoading()) return { ...identity, ready: false };
      const state = await evaluate(`(async () => ({
        ready: typeof window.__myScholarFlushBeforeClose === 'function' && Boolean(window.myScholarDesktop),
        frozen: Boolean(document.body?.inert),
        update: window.myScholarDesktop ? await window.myScholarDesktop.getUpdateState() : null
      }))()`);
      return { ...identity, ...state };
    }
    case 'discover': return clickUpdate('#check-updates');
    case 'stage': return clickUpdate('#download-update');
    case 'cached': return adapter.getDownloadedCandidate();
    case 'install': return clickUpdate('#install-update');
    case 'capture': {
      const name = command.name || 'update-settings';
      assert.match(name, /^[a-z0-9-]+$/u);
      const file = path.join(root, `${name}.png`);
      fs.writeFileSync(file, (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG());
      return { file };
    }
    case 'eval': return evaluate(command.code);
    case 'quit': app.quit(); return { requested: true };
    default: throw new Error(`Unknown local upgrade command: ${command.action}`);
  }
}
let busy = false;
let lastID = null;
const timer = setInterval(async () => {
  if (busy) return;
  let command;
  try { command = JSON.parse(fs.readFileSync(path.join(root, 'command.json'), 'utf8')); } catch (_) { return; }
  if (!command.id || command.id === lastID || command.targetPID !== process.pid) return;
  lastID = command.id;
  busy = true;
  try { record('result', { id: command.id, result: await handle(command) }); }
  catch (error) { record('result', { id: command.id, error: error.stack || String(error) }); }
  finally { busy = false; }
}, 100);
timer.unref();
app.whenReady().then(() => record('launched', { executable: process.execPath, userData: app.getPath('userData') }));
app.on('will-quit', () => { clearInterval(timer); record('will-quit'); });
