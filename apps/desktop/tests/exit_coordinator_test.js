'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createExitCoordinator, flushRenderer } = require('../electron/exit-coordinator.cjs');

function renderer(hook) {
  const context = vm.createContext({ window: { ...(hook ? { __myScholarFlushBeforeClose: hook } : {}) } });
  return { isDestroyed: () => false, webContents: {
    isDestroyed: () => false,
    executeJavaScript: (source) => vm.runInContext(source, context),
  } };
}

function harness(overrides = {}) {
  const events = [];
  let backend = true;
  const dependencies = {
    waitForMigration: async () => { events.push('wait-migration'); },
    hasRenderer: () => true,
    flush: async (options) => { events.push(['flush', options]); },
    assertInstallReady: () => { if (!backend) throw new Error('backend dead'); },
    chooseSaveFailure: async () => 'cancel',
    prepareBackend: async () => { events.push('prepare'); return { migration: { ready: true } }; },
    cancelBackendPreparation: async () => { events.push('cancel-backend'); },
    cancelPreparedUpdateForExit: async () => { events.push('cancel-update'); },
    stopBackend: async (options) => { events.push(['stop', options]); backend = false; },
    recoverBackend: async () => { events.push('recover-backend'); backend = true; },
    resumeRenderer: async () => { events.push('resume'); },
    resetExit: () => { events.push('reset'); },
    finish: async (intent) => { events.push(['finish', intent]); },
    reportFailure: async (error) => { events.push(['error', error.message]); },
    ...overrides,
  };
  const coordinator = createExitCoordinator(dependencies);
  const install = async () => { events.push('install'); };
  const cancelPreparedInstall = async () => { events.push('cancel-install'); };
  return { coordinator, events, dependencies, install, cancelPreparedInstall, setBackend: (value) => { backend = value; } };
}

async function testFlushFailures() {
  for (const [name, window] of [
    ['false', renderer(async () => false)],
    ['rejection', renderer(async () => { throw new Error('save rejected'); })],
    ['timeout', renderer(() => new Promise(() => {}))],
    ['missing hook', renderer()],
    ['missing window', null],
    ['destroyed renderer', { isDestroyed: () => false, webContents: { isDestroyed: () => true } }],
  ]) {
    const current = harness({ flush: (options) => flushRenderer(window, { ...options, timeout: 10 }) });
    const result = await current.coordinator.request({ intent: 'install-update', install: current.install, cancelPreparedInstall: current.cancelPreparedInstall });
    assert.strictEqual(result.ok, false, name);
    assert.ok(current.events.includes('resume'), name);
    assert.ok(!current.events.includes('prepare'), `${name}: saving must precede prepare`);
    assert.ok(!current.events.some((entry) => Array.isArray(entry) && entry[0] === 'stop'), name);
    assert.ok(!current.events.includes('install'), name);
  }
  const seen = [];
  await flushRenderer(renderer((options) => { seen.push(options); return true; }), { intent: 'quit', discard: true });
  assert.strictEqual(seen[0].intent, 'quit');
  assert.strictEqual(seen[0].discard, true);
}

async function testRetryAndDiscard() {
  for (const choice of ['retry', 'discard']) {
    let calls = 0;
    const options = [];
    const current = harness({
      flush: async (value) => { options.push(value); if (++calls === 1) throw new Error('save failed'); },
      chooseSaveFailure: async () => choice,
    });
    const result = await current.coordinator.request({ intent: 'quit' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[1].discard, choice === 'discard');
    assert.strictEqual(result.discarded, choice === 'discard');
    assert.ok(current.events.includes('cancel-update'));
    assert.ok(!current.events.includes('install'));
  }
  const current = harness({ flush: async () => { throw new Error('discard barrier also failed'); }, chooseSaveFailure: async () => 'discard' });
  assert.strictEqual((await current.coordinator.request({ intent: 'quit' })).ok, false);
  assert.ok(!current.events.includes('cancel-update'));
}

async function testInstallBarriers() {
  const dead = harness();
  dead.setBackend(false);
  assert.strictEqual((await dead.coordinator.request({ intent: 'install-update', install: dead.install })).ok, false);
  assert.ok(!dead.events.includes('install'));

  for (const response of [{ migration: { ready: false, reason: 'busy' } }, {}, { migration: { ready: 'yes' } }]) {
    const busy = harness({ prepareBackend: async () => response });
    const result = await busy.coordinator.request({ intent: 'install-update', install: busy.install, cancelPreparedInstall: busy.cancelPreparedInstall });
    assert.strictEqual(result.ok, false);
    assert.ok(busy.events.includes('cancel-backend'));
    assert.ok(busy.events.includes('cancel-install'));
    assert.ok(busy.events.includes('resume'));
    assert.ok(!busy.events.some((entry) => Array.isArray(entry) && entry[0] === 'stop'));
    assert.ok(!busy.events.includes('install'));
  }
  const failedPrepare = harness({ prepareBackend: async () => { throw new Error('response lost after freeze'); } });
  await failedPrepare.coordinator.request({ intent: 'install-update', install: failedPrepare.install });
  assert.ok(failedPrepare.events.includes('cancel-backend'), 'failed prepare may have frozen backend');

  const failedStop = harness({ stopBackend: async ({ allowForce }) => { assert.strictEqual(allowForce, false); throw new Error('stop failed'); } });
  assert.strictEqual((await failedStop.coordinator.request({ intent: 'install-update', install: failedStop.install })).ok, false);
  assert.ok(!failedStop.events.includes('install'));
  assert.ok(failedStop.events.includes('recover-backend'));

  const failedInstall = harness();
  const failure = await failedInstall.coordinator.request({ intent: 'install-update', install: async () => { throw new Error('installer failed'); }, cancelPreparedInstall: failedInstall.cancelPreparedInstall });
  assert.strictEqual(failure.ok, false);
  assert.ok(failedInstall.events.includes('recover-backend'));
  assert.ok(failedInstall.events.includes('resume'));
  assert.ok(failedInstall.events.includes('cancel-install'));

  const successful = harness();
  const result = await successful.coordinator.request({ intent: 'install-update', install: successful.install });
  assert.strictEqual(result.ok, true);
  const meaningful = successful.events.filter((entry) => entry !== 'wait-migration');
  assert.deepStrictEqual(meaningful, [['flush', { intent: 'install-update', discard: false }], 'prepare', ['stop', { allowForce: false }], 'install']);
}

async function testCancellationAndDuplicates() {
  let release;
  const current = harness({ flush: () => new Promise((resolve) => { release = resolve; }) });
  const first = current.coordinator.request({ intent: 'install-update', install: current.install });
  const second = current.coordinator.request({ intent: 'install-update', install: current.install });
  assert.strictEqual(first, second, 'duplicate clicks must share one transaction');
  await new Promise((resolve) => setImmediate(resolve));
  current.coordinator.cancel('user cancelled');
  release();
  const result = await first;
  assert.strictEqual(result.cancelled, true);
  assert.ok(!current.events.includes('install'));
  assert.strictEqual(current.coordinator.state.phase, 'cancelled');
  current.dependencies.flush = async () => {};
  assert.strictEqual((await current.coordinator.request({ intent: 'quit' })).ok, true, 'cancelled request must allow retry');
}

async function testIntentChanges() {
  for (const [before, after] of [['install-update', 'quit'], ['close', 'quit'], ['quit', 'install-update']]) {
    let release;
    let calls = 0;
    const current = harness({ flush: () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve() });
    const first = current.coordinator.request({ intent: before, install: current.install });
    await new Promise((resolve) => setImmediate(resolve));
    const next = current.coordinator.request({ intent: after, install: current.install });
    assert.notStrictEqual(first, next, 'different intents must never share success');
    assert.strictEqual(current.coordinator.request({ intent: after, install: current.install }), next, 'duplicate replacement clicks must share one request');
    release();
    assert.strictEqual((await first).cancelled, true);
    const result = await next;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.intent, after);
    assert.ok(current.events.indexOf('resume') < current.events.findIndex((entry) => Array.isArray(entry) && entry[0] === 'stop'), 'restore must finish before replacement stops backend');
    assert.strictEqual(current.events.filter((entry) => entry === 'install').length, after === 'install-update' ? 1 : 0);
  }

  let releaseInstall;
  const committing = harness();
  const installing = committing.coordinator.request({ intent: 'install-update', install: () => new Promise((resolve) => { releaseInstall = resolve; }) });
  await new Promise((resolve) => setImmediate(resolve));
  const refused = await committing.coordinator.request({ intent: 'quit' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.intent, 'quit');
  assert.strictEqual(committing.coordinator.state.phase, 'installing');
  releaseInstall();
  assert.strictEqual((await installing).ok, true);

  let releaseSave;
  const failedRecovery = harness({
    flush: () => new Promise((resolve) => { releaseSave = resolve; }),
    resumeRenderer: async () => { throw new Error('resume failed'); },
  });
  const previous = failedRecovery.coordinator.request({ intent: 'install-update', install: failedRecovery.install });
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = failedRecovery.coordinator.request({ intent: 'quit' });
  releaseSave();
  await previous;
  assert.strictEqual((await replacement).ok, false);
  assert.ok(!failedRecovery.events.some((entry) => Array.isArray(entry) && entry[0] === 'stop'), 'failed recovery must block the replacement request');
}

async function testOrdinaryExit() {
  for (const intent of ['close', 'quit']) {
    const current = harness();
    const result = await current.coordinator.request({ intent, install: current.install });
    assert.strictEqual(result.ok, true);
    assert.ok(current.events.includes('cancel-update'));
    assert.ok(!current.events.includes('install'));
    assert.ok(current.events.indexOf('cancel-update') < current.events.findIndex((entry) => entry[0] === 'stop'));
    assert.ok(current.events.some((entry) => Array.isArray(entry) && entry[0] === 'finish' && entry[1] === intent));
  }
  const current = harness({ cancelPreparedUpdateForExit: async () => { throw new Error('updater still armed'); } });
  assert.strictEqual((await current.coordinator.request({ intent: 'quit' })).ok, false);
  assert.ok(!current.events.some((entry) => Array.isArray(entry) && ['stop', 'finish'].includes(entry[0])));
  assert.ok(current.events.includes('resume'));
}

async function testMainInstallationEntry() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('function flushRendererState(');
  const end = source.indexOf('\nasync function startServer()', start);
  const events = [];
  const window = renderer(async () => true);
  window.close = () => events.push('close');
  const context = vm.createContext({
    createExitCoordinator, flushRenderer, module: { exports: {} }, mainWindow: window,
    libraryMigrationPromise: null, pythonServer: { exitCode: null, signalCode: null }, serverURL: 'http://127.0.0.1:1234',
    rendererCrashShutdownPromise: null, shuttingDown: false, allowQuit: false,
    cancelPreparedUpdateForExit: async () => {}, windowsAllowedToClose: new WeakSet(), process,
    app: { quit: () => events.push('quit') },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox: () => events.push('report') },
    diagnosticLog() {}, backendMigrationControl: async (action) => { events.push(action); return { migration: { ready: true } }; },
    stopServer: async (options) => { events.push(['stop', options.allowForce]); }, startServer: async () => context.serverURL,
  });
  vm.runInContext(source.slice(start, end), context);
  const api = context.module.exports;
  api.setCancelPreparedUpdateForExit(async () => events.push('cancel-update'));
  const result = await api.requestUpdateInstallation({ install: () => { assert.strictEqual(context.allowQuit, true); events.push('installer'); } });
  assert.strictEqual(result.ok, true);
  assert.ok(events.includes('installer'));
  assert.ok(!events.includes('quit'), 'main installation entry must leave native installer in charge of relaunch');
  assert.ok(!events.includes('cancel-update'), 'explicit install must preserve the prepared native session');
  context.allowQuit = false;
  const failure = await api.requestUpdateInstallation({ install: () => { throw new Error('native callback failed'); } });
  assert.strictEqual(failure.ok, false);
  assert.strictEqual(context.allowQuit, false, 'failed native callback must close the quit bypass');

  let quitHandler;
  context.app.on = (_event, handler) => { quitHandler = handler; };
  const quitStart = source.indexOf("app.on('before-quit'");
  const quitEnd = source.indexOf("app.on('window-all-closed'", quitStart);
  vm.runInContext(source.slice(quitStart, quitEnd), context);
  context.pythonServer = null;
  let prevented = false;
  quitHandler({ preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(prevented, true, 'dead backend must never bypass renderer save or native updater cancellation');
  assert.ok(events.includes('cancel-update'));
  assert.ok(events.includes('quit'));
}

async function testMainInstallStopNeverForces() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const start = source.indexOf('function stopServer(');
  const end = source.indexOf('\nfunction flushRendererState(', start);
  const signals = [];
  const child = { pid: 1234, exitCode: null, signalCode: null };
  const context = vm.createContext({
    pythonServer: child, serverStopPromise: null, serverURL: 'http://127.0.0.1:1234',
    diagnosticLog() {}, signalServer: (_child, signal) => signals.push(signal), waitForServerExit: async () => false,
  });
  const stop = vm.runInContext(`${source.slice(start, end)}\nstopServer`, context);
  await assert.rejects(stop({ allowForce: false }), /无法停止/u);
  assert.deepStrictEqual(signals, ['SIGTERM'], 'an update must not force-kill a backend which did not stop');
  assert.strictEqual(context.pythonServer, child, 'failed stop must retain the backend identity for recovery');
  assert.strictEqual(context.serverStopPromise, null, 'failed stop must be retryable');
}

async function main() {
  await testFlushFailures();
  await testRetryAndDiscard();
  await testInstallBarriers();
  await testCancellationAndDuplicates();
  await testIntentChanges();
  await testOrdinaryExit();
  await testMainInstallationEntry();
  await testMainInstallStopNeverForces();
  console.log('exit coordinator tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
