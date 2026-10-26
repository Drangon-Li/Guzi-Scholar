'use strict';
const assert = require('node:assert/strict');
const { createUpdateController, systemSupports } = require('../electron/update-controller.cjs');
const candidate = { repository: 'Drangon-Li/Guzi-Scholar', status: 'available', version: '0.6.3', channel: 'stable', platform: 'darwin', arch: 'arm64', minimumSystemVersion: '12.0', sha256: 'a'.repeat(64), size: 100 };
function fixture() {
  const calls = []; const state = { cached: null, saveCancelled: false, downloadError: false, installError: false, discoveryError: false };
  const adapter = {
    getDownloadedCandidate: async () => state.cached,
    canInstall: async (value) => Boolean(state.cached && JSON.stringify(value) === JSON.stringify(state.cached)),
    download: async (value, progress) => { calls.push('download'); progress({ percent: 50, transferred: 50, total: 100 }); if (state.downloadError) throw new Error('network lost'); state.cached = value; },
    install: async () => { calls.push('install'); if (state.installError) throw new Error('installer failed'); },
    cancelPreparedUpdateForExit: async () => calls.push('ordinary-exit'), dispose: async () => {},
  };
  const updater = createUpdateController({ config: { enabled: true, channel: 'stable' }, currentVersion: '0.6.2', platform: 'darwin', arch: 'arm64', systemVersion: '13.0', adapter,
    discover: async () => { if (state.discoveryError) throw new Error('GitHub offline'); return candidate; },
    requestInstallation: async ({ install }) => { calls.push('save'); if (state.saveCancelled) return { ok: false, cancelled: true }; await install(); return { ok: true }; },
  });
  return { updater, state, calls };
}
(async () => {
  assert(systemSupports('10.0.19045', '10.0.18362')); assert(!systemSupports('11.7.0', '12.0'));
  const { updater, state, calls } = fixture();
  const changes = []; updater.onState((value) => changes.push(value));
  await updater.check(); assert((await updater.getState()).canDownload);
  state.downloadError = true; await updater.download(); assert((await updater.getState()).canDownload); assert(!(await updater.getState()).canInstall);
  state.downloadError = false; await updater.download(); assert((await updater.getState()).canInstall); assert(changes.some((value) => value.progress?.percent === 50));
  await updater.cancelPreparedUpdateForExit(); assert(!calls.includes('install'));
  state.discoveryError = true; await updater.check(); assert((await updater.getState()).canInstall); assert.match((await updater.getState()).error, /offline/u);
  state.saveCancelled = true; await updater.install(); assert(!calls.includes('install')); assert((await updater.getState()).canInstall);
  state.saveCancelled = false; state.installError = true; await updater.install(); assert.match((await updater.getState()).error, /installer failed/u); assert((await updater.getState()).canInstall);
  state.installError = false; await updater.install(); assert.match((await updater.getState()).error, /没有退出/u, 'Accepted must not mean installed');
  console.log('Update controller retry, progress, save cancellation, ordinary exit and late failure tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
