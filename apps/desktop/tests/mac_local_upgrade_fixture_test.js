'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, 'fixtures/mac-local-upgrade-main.cjs'), 'utf8');

function harness({ ownerMismatch = false, onMain = () => {}, appPath } = {}) {
  const root = '/private/tmp/guzi-real-upgrade-fixture-test';
  const owner = { protocol: 1, root, bundleID: 'com.guzi.scholar.upgradetest.abcdef', installed: `${root}/installed/谷子学术.app`, userData: `${root}/user-data` };
  const metadata = { version: '0.6.10', updater: { channel: 'stable' }, macLocalUpgrade: { ...owner } };
  const events = [], dialogs = [], paths = new Map();
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getVersion: () => metadata.version,
    getAppPath: () => appPath || `${owner.installed}/Contents/Resources/app`,
    setPath: (key, value) => paths.set(key, value),
    getPath: (key) => paths.get(key),
    setAppLogsPath: (value) => paths.set('logs', value),
    commandLine: { appendSwitch() {} },
    whenReady: () => Promise.resolve(),
  });
  const dialog = {
    showErrorBox: (...args) => { dialogs.push(['error', ...args]); return 'visible-error'; },
    showMessageBoxSync: (...args) => { dialogs.push(['sync', ...args]); return 'visible-sync'; },
    showMessageBox: (...args) => { dialogs.push(['async', ...args]); return Promise.resolve({ response: 1 }); },
  };
  const process = Object.assign(new EventEmitter(), { platform: 'darwin', pid: 123, env: {} });
  const modules = {
    'node:assert/strict': assert, 'node:path': path,
    'node:fs': {
      realpathSync: (file) => file, mkdirSync() {}, writeFileSync() {}, existsSync: () => false,
      readFileSync: (file) => {
        assert.equal(file, path.join(root, 'owner.json'));
        return JSON.stringify(ownerMismatch ? { ...owner, installed: '/Applications/谷子学术.app' } : owner);
      },
      appendFileSync: (_file, value) => events.push(JSON.parse(value)),
    },
    electron: { app, dialog, BrowserWindow: { getAllWindows: () => [] } },
    '../package.json': metadata,
    './macos-installation.cjs': {},
    './update-service.cjs': { findReleaseUpdate() {} },
    './mac-updater.cjs': { createMacUpdater() {} },
    './update-controller.cjs': { createUpdateController() {} },
  };
  vm.runInNewContext(source, {
    require(name) {
      if (name === './main.cjs') { onMain(app); return {}; }
      assert(Object.hasOwn(modules, name), name);
      return modules[name];
    },
    process, setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout,
  });
  return { app, process, dialog, paths, events, dialogs, owner };
}

(async () => {
  assert.throws(() => harness({ ownerMismatch: true }), /Expected values/u);
  assert.throws(() => harness({ appPath: '/Applications/谷子学术.app/Contents/Resources/app' }), /Expected values/u);
  assert.throws(() => harness({ onMain: (app) => app.setPath('userData', '/Users/example/Library/Application Support/my-scholar') }), /must remain isolated/u);
  assert.throws(() => harness({ onMain: (app) => app.moveToApplicationsFolder() }), /never replace/u);
  const current = harness();
  assert.equal(current.paths.get('userData'), current.owner.userData);
  assert.equal(current.process.env.MY_SCHOLAR_SETTINGS_FILE, `${current.owner.userData}/state/settings.json`);
  assert.equal(current.process.env.MY_SCHOLAR_DEVELOPER_TOKENS_FILE, `${current.owner.root}/developer-tokens.json`);
  assert.equal(current.process.listenerCount('uncaughtException'), 0, 'Observing exceptions must not replace Electron error handling');
  current.process.emit('uncaughtExceptionMonitor', new Error('Cannot dispose an active Sparkle installation'), 'uncaughtException');
  assert(current.events.some((event) => event.type === 'main-process-error' && event.error.includes('Cannot dispose')));
  assert.equal(current.dialog.showErrorBox('JavaScript error', 'active install'), 'visible-error');
  assert.equal(current.dialogs.length, 1, 'Error observation must still invoke the real dialog');
  assert(current.events.some((event) => event.type === 'error-dialog'));
  await current.dialog.showMessageBox({ type: 'warning', title: 'Unexpected failure' });
  assert(current.events.some((event) => event.type === 'unexpected-dialog'));
  assert.equal(current.dialogs.length, 2);
  const confirmation = await current.dialog.showMessageBox({ title: '安装更新并重新启动' });
  assert.equal(confirmation.response, 0);
  assert(current.events.some((event) => event.type === 'dialog' && event.expected));
  assert.equal((await current.dialog.showMessageBox({ title: '发现新版本', type: 'info', buttons: ['查看更新', '稍后'] })).response, 1);
  const contents = Object.assign(new EventEmitter(), { executeJavaScript: async () => true });
  current.app.emit('web-contents-created', {}, contents);
  assert.equal(await contents.executeJavaScript('window.__myScholarFlushBeforeClose({intent:"install-update"})'), true);
  assert(current.events.some((event) => event.type === 'save-gate' && event.phase === 'complete' && event.result === true));
  assert.equal(current.app.getVersion(), '0.6.10', 'The actual source version must not be disguised');
  console.log('Local upgrade fixture isolation, visible-error observation, and save-gate tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
