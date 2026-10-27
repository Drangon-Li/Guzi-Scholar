'use strict';

// Injected only into the older bundle on a disposable GitHub-hosted macOS VM.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const metadata = require('../package.json');
const probe = metadata.macReleaseAcceptance;
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !probe || probe.protocol !== 1 || !path.isAbsolute(probe.root) || !app.isPackaged || metadata.localTestBuild) throw new Error('Disposable hosted VM release acceptance required');
const root = probe.root;
const eventFile = path.join(root, 'events.jsonl');
const record = (type, data = {}) => fs.appendFileSync(eventFile, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, version: app.getVersion(), type, ...data })}\n`);
process.on('uncaughtExceptionMonitor', (error, origin) => record('main-process-error', { origin, error: error.stack || String(error) }));
let saveFailureResponse = 1;
let installConfirmationResponse = 0;
dialog.showMessageBox = async (...args) => {
  const title = args.at(-1).title;
  const response = title === '安装更新并重新启动' ? installConfirmationResponse : saveFailureResponse;
  record('dialog', { title, response });
  return { response };
};
dialog.showErrorBox = (title, content) => record('error-dialog', { title, content });
dialog.showMessageBoxSync = (...args) => { throw new Error(`Unexpected synchronous dialog: ${args.at(-1).title}`); };
const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const service = require('./update-service.cjs');
const findReleaseUpdate = service.findReleaseUpdate;
service.findReleaseUpdate = (options) => {
  const source = manifest();
  const releaseManifest = JSON.parse(fs.readFileSync(path.join(root, 'update-manifest.json'), 'utf8'));
  releaseManifest.artifacts.find((item) => item.platform === 'darwin').ed_signature = source.signature;
  const release = { tag_name: `v${releaseManifest.version}`, draft: false, prerelease: releaseManifest.channel === 'beta', assets: releaseManifest.artifacts.map((item) => ({ name: item.name, size: item.size, state: 'uploaded', browser_download_url: item.url })) };
  release.assets.push({ name: 'update-manifest.json', size: Buffer.byteLength(JSON.stringify(releaseManifest)), state: 'uploaded', browser_download_url: service.assetURL(release.tag_name, 'update-manifest.json') });
  return findReleaseUpdate({ ...options, fetcher: async (url) => url.endsWith('update-manifest.json') ? releaseManifest : releaseManifest.channel === 'beta' ? [release] : release });
};
const mac = require('./mac-updater.cjs');
const createMacUpdater = mac.createMacUpdater;
let adapter;
mac.createMacUpdater = (options) => {
  adapter = createMacUpdater({ ...options, fetch: (_url, request) => globalThis.fetch(manifest().downloadURL, request), onEvent: (event) => record('sparkle', { event }) });
  const install = adapter.install;
  adapter.install = (selected) => { record('install-authorized', { version: selected.version }); return install(selected); };
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
record('configuration', { userData: app.getPath('userData'), bundleID: probe.bundleID, channel: metadata.updater.channel });
async function evaluate(code) {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) throw new Error('No renderer');
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
    case 'status': return { version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'), logs: app.getPath('logs'), ready: await evaluate("typeof window.__myScholarFlushBeforeClose === 'function'"), frozen: await evaluate('document.body.inert'), update: await evaluate('window.myScholarDesktop.getUpdateState()') };
    case 'discover': return clickUpdate('#check-updates');
    case 'stage': return clickUpdate('#download-update');
    case 'install': saveFailureResponse = command.dialogResponse ?? 1; installConfirmationResponse = command.confirmationResponse ?? 0; return clickUpdate('#install-update');
    case 'capture': { const file = path.join(root, 'update-settings.png'); const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(); fs.writeFileSync(file, image.toPNG()); return { file }; }
    case 'cached': return adapter.getDownloadedCandidate();
    case 'click': return evaluate(`(() => { const button = document.querySelector(${JSON.stringify(command.selector)}); if (!button || button.disabled) throw new Error('Update UI button unavailable'); button.click(); return true; })()`);
    case 'eval': return evaluate(command.code);
    case 'quit': app.quit(); return { requested: true };
    default: throw new Error(`Unknown release acceptance action: ${command.action}`);
  }
}
let busy = false;
let lastID = null;
setInterval(async () => {
  if (busy) return;
  let command;
  try { command = JSON.parse(fs.readFileSync(path.join(root, 'command.json'), 'utf8')); } catch (_) { return; }
  if (!command.id || command.id === lastID || command.targetPID !== process.pid) return;
  lastID = command.id;
  busy = true;
  try { record('result', { id: command.id, result: await handle(command) }); }
  catch (error) { record('result', { id: command.id, error: error.stack || String(error) }); }
  finally { busy = false; }
}, 100).unref();
app.whenReady().then(() => record('launched', { executable: process.execPath, userData: app.getPath('userData') }));
app.on('will-quit', () => record('will-quit'));
