'use strict';

// Only mac_updater_probe.js copies this entry into its dedicated test bundle.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const metadata = require('../package.json');
const probe = metadata.updaterProbe;
if (!probe || probe.protocol !== 2 || !path.isAbsolute(probe.root) || !app.isPackaged || !metadata.localTestBuild) throw new Error('Isolated packaged production-adapter probe required');
const root = probe.root;
const eventFile = path.join(root, 'events.jsonl');
const record = (type, data = {}) => fs.appendFileSync(eventFile, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, version: app.getVersion(), type, ...data })}\n`);
const setPath = app.setPath.bind(app);
app.setPath = (name, value) => setPath(name, name === 'userData' ? path.join(root, 'user-data') : value);
app.setPath('userData', path.join(root, 'user-data'));
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
const candidate = () => {
  const source = manifest();
  return { version: source.version, channel: 'stable', platform: 'darwin', arch: process.arch, assetName: `Guzi-Scholar-${source.version}-${process.arch}-stable.zip`, downloadURL: source.downloadURL, size: source.length, sha256: source.sha256, sha512: source.sha512, edSignature: source.signature, minimumSystemVersion: '12.0', publishedAt: '2026-10-01T00:00:00Z', notes: 'Isolated production updater acceptance', repository: 'Drangon-Li/Guzi-Scholar' };
};
// Test-only dependency injection leaves the production main/controller/IPC/save gate intact.
require('./update-config.cjs').resolveUpdateConfig = () => ({ enabled: true, channel: 'stable', publicKey: probe.publicKey, repository: 'Drangon-Li/Guzi-Scholar' });
require('./update-service.cjs').findReleaseUpdate = async ({ currentVersion }) => ({ ...candidate(), status: 'available', currentVersion, checkedAt: new Date().toISOString() });
const mac = require('./mac-updater.cjs');
const createMacUpdater = mac.createMacUpdater;
let adapter;
mac.createMacUpdater = (options) => {
  adapter = createMacUpdater({ ...options, allowTestURLs: true, onEvent: (event) => record('sparkle', { event }) });
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
    case 'status': return { version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'), ready: await evaluate("typeof window.__myScholarFlushBeforeClose === 'function'"), frozen: await evaluate('document.body.inert'), update: await evaluate('window.myScholarDesktop.getUpdateState()') };
    case 'discover': return clickUpdate('#check-updates');
    case 'stage': return clickUpdate('#download-update');
    case 'install': saveFailureResponse = command.dialogResponse ?? 1; installConfirmationResponse = command.confirmationResponse ?? 0; return clickUpdate('#install-update');
    case 'capture': { const file = path.join(root, 'update-settings.png'); const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(); fs.writeFileSync(file, image.toPNG()); return { file }; }
    case 'cached': return adapter.getDownloadedCandidate();
    case 'click': return evaluate(`(() => { const button = document.querySelector(${JSON.stringify(command.selector)}); if (!button || button.disabled) throw new Error('Update UI button unavailable'); button.click(); return true; })()`);
    case 'eval': return evaluate(command.code);
    case 'quit': app.quit(); return { requested: true };
    default: throw new Error(`Unknown probe action: ${command.action}`);
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
