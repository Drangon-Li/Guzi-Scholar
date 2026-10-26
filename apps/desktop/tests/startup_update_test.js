'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStartupUpdateCheck } = require('../electron/startup-update.cjs');
const { createUpdateController } = require('../electron/update-controller.cjs');
const { REPOSITORY } = require('../electron/update-service.cjs');

const announcement = { status: 'available', repository: REPOSITORY, channel: 'stable', version: '0.6.5', externalOnly: true, releaseURL: 'https://evil.example/update' };
function fixture(options = {}) {
  const calls = { discoveries: [], prompts: [], opened: [] };
  const control = { result: announcement, window: {}, response: 1, ...options };
  const check = createStartupUpdateCheck({
    config: { discoveryEnabled: true, channel: 'stable', enabled: false, ...options.config }, currentVersion: '0.6.4',
    getWindow: () => control.window,
    discover: async (query) => { calls.discoveries.push(query); if (control.pending) await control.pending; if (control.discoveryError) throw new Error('offline'); return control.result; },
    showMessageBox: async (window, prompt) => { calls.prompts.push({ window, ...prompt }); if (control.promptError) throw new Error('window closed'); return { response: control.response }; },
    openExternal: async (url) => { calls.opened.push(url); if (control.openError) throw new Error('browser unavailable'); },
  });
  return { calls, control, check };
}

(async () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const createWindow = main.slice(main.indexOf('async function createWindow()'), main.indexOf('function ensureWindow()'));
  assert(createWindow.indexOf('void checkStartupUpdate();') > createWindow.indexOf('await mainWindow.loadURL(url);'), 'Discovery starts after the first window has loaded');
  assert(!main.includes('await checkStartupUpdate('), 'Window startup must not wait for discovery');
  {
    let release;
    const f = fixture({ pending: new Promise((resolve) => { release = resolve; }) });
    const first = f.check();
    await f.check(); await f.check();
    assert.equal(f.calls.discoveries.length, 1); assert.equal(f.calls.prompts.length, 0);
    release(); await first;
    f.control.window = {};
    await f.check();
    assert.equal(f.calls.discoveries.length, 1, 'Reload, window recreation and activate share the same process guard');
    assert.equal(f.calls.prompts.length, 1);
    assert.deepEqual(f.calls.prompts[0].buttons, ['查看更新', '稍后']);
    assert.equal(f.calls.opened.length, 0, 'Later does not open or download anything');
  }
  {
    const f = fixture({ config: { discoveryEnabled: false } });
    await f.check(); await f.check();
    assert.equal(f.calls.discoveries.length, 0); assert.equal(f.calls.prompts.length, 0);
  }
  for (const result of [
    { status: 'current', version: '0.6.4' }, { status: 'ahead', version: '0.6.3' },
    { ...announcement, version: '0.6.4' }, { ...announcement, version: '0.6.3' },
    { ...announcement, version: '0.6.5-beta.1' }, { ...announcement, repository: 'other/repo' },
    { ...announcement, version: '0.6.5/../../evil' }, { ...announcement, channel: 'beta' },
  ]) {
    const f = fixture({ result }); await f.check();
    assert.equal(f.calls.prompts.length, 0); assert.equal(f.calls.opened.length, 0);
  }
  {
    const f = fixture({ discoveryError: true }); await f.check(); await f.check();
    assert.equal(f.calls.discoveries.length, 1); assert.equal(f.calls.prompts.length, 0);
  }
  {
    const f = fixture({ response: 0 }); await f.check(); await f.check();
    assert.equal(f.calls.prompts.length, 1);
    assert.deepEqual(f.calls.opened, [`https://github.com/${REPOSITORY}/releases/tag/v0.6.5`], 'Only a locally generated repository release URL may be opened');
  }
  for (const options of [{ window: null }, { promptError: true }, { response: 0, openError: true }]) await fixture(options).check();
  {
    let release;
    const f = fixture({ pending: new Promise((resolve) => { release = resolve; }) });
    const pending = f.check(); f.control.window = null; release(); await pending;
    assert.equal(f.calls.prompts.length, 0, 'Do not show a prompt after the reading window closed');
  }
  {
    const cached = { repository: REPOSITORY, channel: 'stable', version: '0.6.5', platform: 'darwin', arch: 'arm64', minimumSystemVersion: '12.0' };
    const updater = createUpdateController({ config: { enabled: true, channel: 'stable' }, currentVersion: '0.6.4', platform: 'darwin', arch: 'arm64', systemVersion: '13.0',
      adapter: { getDownloadedCandidate: async () => cached, canInstall: async () => true, download: () => assert.fail('Startup must not download'), install: () => assert.fail('Startup must not install') },
      discover: () => assert.fail('Startup must not mutate the update controller'), requestInstallation: () => assert.fail('Startup must not request installation'),
    });
    const before = await updater.getState(); assert.equal(before.status, 'ready'); assert.equal(before.canInstall, true);
    await fixture({ response: 0 }).check();
    assert.deepEqual(await updater.getState(), before, 'Discovery preserves the existing ready candidate and capabilities');
  }
  console.log('Startup update once-only, silent failure, official URL and cached-update isolation tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
