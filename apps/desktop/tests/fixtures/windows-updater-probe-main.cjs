'use strict';

// Included only by windows_updater_acceptance.js in an isolated NSIS identity.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const metadata = require('../package.json').windowsUpdateAcceptance;
if (!app.isPackaged || !metadata?.appId?.startsWith('com.guzi.scholar.update-acceptance.')
  || !path.isAbsolute(metadata.root || '')) throw new Error('Isolated Windows acceptance package required.');
const root = metadata.root;
const record = (type, data = {}) => fs.appendFileSync(metadata.eventsPath, `${JSON.stringify({ time: new Date().toISOString(), type, pid: process.pid, version: app.getVersion(), ...data })}\n`);
process.env.MY_SCHOLAR_DATA_DIR = path.join(root, 'state');
process.env.MY_SCHOLAR_LIBRARY_DIR = path.join(root, '文献 库');
app.setPath('userData', path.join(root, 'user-data'));
let dialogResponse = 1;
dialog.showMessageBox = async (...args) => { record('dialog', { title: args.at(-1).title, response: dialogResponse }); return { response: dialogResponse }; };
dialog.showErrorBox = (title, content) => record('error-dialog', { title, content });
const desktop = require('./main.cjs');
const { createWindowsUpdater } = require('./windows-updater.cjs');
const updater = createWindowsUpdater({ app, cacheDirectory: path.join(root, 'updater-cache'), allowLoopbackForTesting: true,
  onError: (error) => record('updater-error', { message: error.message }) });
desktop.setCancelPreparedUpdateForExit(() => updater.cancelPreparedUpdateForExit());
const candidate = () => JSON.parse(fs.readFileSync(path.join(root, 'candidate.json'), 'utf8'));
const evaluate = (code) => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) throw new Error('Renderer not available');
  return window.webContents.executeJavaScript(code, true);
};
async function handle(command) {
  switch (command.action) {
    case 'status': return { version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'),
      ready: await evaluate("typeof window.__myScholarFlushBeforeClose === 'function'"), frozen: await evaluate('document.body.inert') };
    case 'download': return updater.download(candidate(), (progress) => record('progress', progress));
    case 'restore': return updater.getDownloadedCandidate();
    case 'can-install': return updater.canInstall(candidate());
    case 'install': {
      dialogResponse = command.dialogResponse ?? 1;
      return desktop.requestUpdateInstallation({ install: () => { record('install-authorized'); return updater.install(candidate()); },
        cancelPreparedInstall: () => updater.cancelPreparedUpdateForExit() });
    }
    case 'eval': return evaluate(command.code);
    case 'quit': app.quit(); return { requested: true };
    default: throw new Error(`Unknown acceptance action: ${command.action}`);
  }
}
let busy = false;
let lastID;
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
app.whenReady().then(() => record('launched', { executable: process.execPath, userData: app.getPath('userData'), appId: metadata.appId, guid: metadata.guid }));
app.on('will-quit', () => record('will-quit'));
