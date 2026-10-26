'use strict';

// This entry belongs only to the old-version package on an ephemeral CI VM.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const metadata = require('../package.json');
const probe = metadata.windowsReleaseAcceptance;
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || !app.isPackaged
  || !probe || !path.isAbsolute(probe.root)) throw new Error('Ephemeral Windows release acceptance VM required');
const root = probe.root;
const record = (type, data = {}) => fs.appendFileSync(probe.eventsPath, `${JSON.stringify({ time: new Date().toISOString(), type, pid: process.pid, version: app.getVersion(), ...data })}\n`);
let saveFailureResponse = 1;
dialog.showMessageBox = async (...args) => {
  const title = args.at(-1).title;
  const response = title === '安装更新并重新启动' ? 0 : saveFailureResponse;
  record('dialog', { title, response });
  return { response };
};
dialog.showErrorBox = (title, content) => record('error-dialog', { title, content });
const service = require('./update-service.cjs');
const discover = service.findReleaseUpdate;
service.findReleaseUpdate = (options) => discover({ ...options, fetcher: async (url) => {
  record('discovery-request', { url });
  const release = JSON.parse(fs.readFileSync(path.join(root, 'staged-release.json'), 'utf8'));
  if (url === `https://api.github.com/repos/${service.REPOSITORY}/releases/latest`) return release;
  if (url === `https://api.github.com/repos/${service.REPOSITORY}/releases?per_page=100`) return [release];
  if (url === service.assetURL(release.tag_name, 'update-manifest.json')) return JSON.parse(fs.readFileSync(path.join(root, 'update-manifest.json'), 'utf8'));
  throw new Error(`Unexpected candidate discovery URL: ${url}`);
} });
const windows = require('./windows-updater.cjs');
const createWindowsUpdater = windows.createWindowsUpdater;
let adapter;
windows.createWindowsUpdater = (options) => {
  const actual = createWindowsUpdater({ ...options, allowLoopbackForTesting: true,
    onError: (error) => record('updater-error', { message: error.message }) });
  const transport = (candidate) => {
    windows.validateCandidate(candidate);
    return { ...candidate, downloadURL: `${probe.transportURL}/${encodeURIComponent(candidate.assetName)}` };
  };
  adapter = {
    getDownloadedCandidate: async () => {
      const cached = await actual.getDownloadedCandidate();
      return cached ? { ...cached, downloadURL: service.assetURL(`v${cached.version}`, cached.assetName) } : null;
    },
    canInstall: (candidate) => actual.canInstall(transport(candidate)),
    download: (candidate, progress) => actual.download(transport(candidate), progress),
    install: (candidate) => { record('install-authorized', { sha256: candidate.sha256, version: candidate.version }); return actual.install(transport(candidate)); },
    cancelPreparedUpdateForExit: () => actual.cancelPreparedUpdateForExit(),
    dispose: () => actual.dispose(),
  };
  return adapter;
};
const controllers = require('./update-controller.cjs');
const createUpdateController = controllers.createUpdateController;
let latestState;
let revision = 0;
controllers.createUpdateController = (options) => {
  const controller = createUpdateController(options);
  controller.onState((state) => { latestState = state; revision++; record('update-state', { state }); });
  return controller;
};
require('./main.cjs');
const evaluate = (code) => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) throw new Error('Renderer unavailable');
  return window.webContents.executeJavaScript(code, true);
};
async function clickUpdate(selector) {
  const before = revision;
  await evaluate(`(() => {
    document.querySelector('[data-view="settings-view"]').click();
    document.querySelector('a[href="#settings-updates"]').click();
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button || button.hidden || button.disabled) throw new Error('Update button unavailable');
    button.click(); return true;
  })()`);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (revision > before && latestState?.canCheck) return latestState;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Update UI action timed out: ${selector}`);
}
async function handle(command) {
  switch (command.action) {
    case 'status': return { version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'), logs: app.getPath('logs'),
      ready: await evaluate("typeof window.__myScholarFlushBeforeClose === 'function'"), frozen: await evaluate('document.body.inert'),
      update: await evaluate('window.myScholarDesktop.getUpdateState()') };
    case 'discover': return clickUpdate('#check-updates');
    case 'download': return clickUpdate('#download-update');
    case 'install': saveFailureResponse = command.dialogResponse ?? 1; return clickUpdate('#install-update');
    case 'can-install': return Boolean((await evaluate('window.myScholarDesktop.getUpdateState()')).canInstall);
    case 'cached': return adapter.getDownloadedCandidate();
    case 'eval': return evaluate(command.code);
    case 'quit': app.quit(); return { requested: true };
    default: throw new Error(`Unknown release acceptance action: ${command.action}`);
  }
}
let busy = false;
let lastID;
setInterval(async () => {
  if (busy) return;
  let command;
  try { command = JSON.parse(fs.readFileSync(path.join(root, 'command.json'), 'utf8')); } catch (_) { return; }
  if (!command.id || command.id === lastID || command.targetPID !== process.pid) return;
  busy = true;
  lastID = command.id;
  try { record('result', { id: command.id, result: await handle(command) }); }
  catch (error) { record('result', { id: command.id, error: error.stack || String(error) }); }
  finally { busy = false; }
}, 100).unref();
app.whenReady().then(() => record('launched', { executable: process.execPath, userData: app.getPath('userData') }));
app.on('will-quit', () => record('will-quit'));
