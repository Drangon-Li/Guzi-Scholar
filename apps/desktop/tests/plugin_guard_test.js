'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { configurePluginIsolation, pluginDocument, checkPreviewBoundaries, PluginProcessGuard } = require('../electron/plugin-guard.cjs');

const serverURL = 'http://127.0.0.1:18771';
const epoch = 'a'.repeat(32);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fixture({ pluginPID = 200, execute = () => Promise.resolve(0), metrics = [], extraFrames = [], interval = 10, timeout = 35 } = {}) {
  const root = { frameTreeNodeId: 1, url: `${serverURL}/`, osProcessId: 100, parent: null, isDestroyed: () => false, executeJavaScript: () => Promise.resolve(0) };
  const plugin = { frameTreeNodeId: 2, url: `${serverURL}/plugins/local.test/__preview/${epoch}/index.html`, osProcessId: pluginPID, parent: root, isDestroyed: () => false, executeJavaScript: execute };
  root.framesInSubtree = [root, plugin, ...extraFrames];
  const contents = Object.assign(new EventEmitter(), { mainFrame: root, isDestroyed: () => false });
  const killed = [];
  const stopped = [];
  const guard = new PluginProcessGuard({ contents, getServerURL: () => serverURL, allWebContents: () => [contents], getMetrics: () => metrics, killProcess: (pid) => killed.push(pid), onStop: (entry, details) => stopped.push({ pluginId: entry.pluginId, ...details }), mainPID: 99, probeInterval: interval, probeTimeout: timeout });
  return { root, plugin, contents, killed, stopped, guard };
}

async function run() {
  {
    const calls = [];
    const session = { pluginId: 'local.test', previewSession: epoch };
    const checks = await checkPreviewBoundaries(async (route, options) => {
      calls.push({ route, ...options });
      throw Object.assign(new Error('forbidden'), { statusCode: 403 });
    }, session);
    assert.deepEqual(checks, { capabilityBoundary: true, previewWriteIsolation: true });
    assert.deepEqual(calls.map((call) => call.body), [
      { name: 'get_preferences', arguments: {}, previewSession: epoch },
      { name: 'save_notes', arguments: { job_id: '0000000000000000', markdown: 'guard probe never committed', expected_revision: 'invalid' }, previewSession: epoch },
    ]);
    assert(calls.every((call) => call.method === 'POST' && call.route === '/api/plugins/local.test/invoke'));
    for (const statusCode of [401, 404, 500, undefined]) {
      const error = Object.assign(new Error('request failed'), { statusCode });
      await assert.rejects(checkPreviewBoundaries(async () => { throw error; }, session), (actual) => actual === error);
    }
    await assert.rejects(checkPreviewBoundaries(async () => ({ ok: true }), session), /未被拒绝/u);
    let index = 0;
    await assert.rejects(checkPreviewBoundaries(async () => {
      if (++index === 1) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
      throw Object.assign(new Error('server failed'), { statusCode: 500 });
    }, session), /server failed/u);
  }
  {
    const switches = new Map([['enable-features', 'Existing,IsolateSandboxedIframes:grouping/per-site'], ['disable-features', 'Other,IsolateSandboxedIframes,SitePerProcess'], ['single-process', ''], ['disable-site-isolation-trials', '']]);
    configurePluginIsolation({ getSwitchValue: (key) => switches.get(key) || '', appendSwitch: (key, value = '') => switches.set(key, value), removeSwitch: (key) => switches.delete(key) });
    assert.equal(switches.get('enable-features'), 'Existing,IsolateSandboxedIframes:grouping/per-document');
    assert.equal(switches.get('disable-features'), 'Other');
    assert(switches.has('site-per-process'));
    assert(!switches.has('single-process'));
    assert(!switches.has('disable-site-isolation-trials'));
    assert.equal(pluginDocument(`${serverURL}/plugins/local.test/index.html`, serverURL).pluginId, 'local.test');
    assert.equal(pluginDocument(`https://evil.test/plugins/local.test/index.html`, serverURL), null);
  }
  {
    const state = fixture();
    try {
      assert.deepEqual(await state.guard.check({ pluginId: 'local.test', previewSession: epoch }), { isolated: true });
      assert.equal(state.killed.length, 0);
      await assert.rejects(state.guard.check({ pluginId: 'local.test', previewSession: 'b'.repeat(32) }), /会话/u);
    } finally { state.guard.dispose(); }
  }
  {
    let executions = 0;
    const state = fixture({ execute: () => { executions += 1; return new Promise(() => {}); } });
    try {
      await sleep(80);
      assert.deepEqual(state.killed, [200], 'a frame that never connects the SDK must still be terminated');
      assert.equal(executions, 1, 'probes must not overlap or restart a stopped frame');
      assert.equal(state.stopped[0].reason, 'unresponsive');
      assert.equal(state.stopped.length, 1);
      assert.equal(await state.root.executeJavaScript('0'), 0);
    } finally { state.guard.dispose(); }
  }
  for (const pluginPID of [99, 100]) {
    const state = fixture({ pluginPID });
    try {
      await sleep(2);
      assert.deepEqual(state.killed, [], 'main process and core renderer must never be killed');
      assert.equal(state.stopped[0].reason, 'isolation');
    } finally { state.guard.dispose(); }
  }
  {
    const reader = { frameTreeNodeId: 3, url: `${serverURL}/api/jobs/abcdef123456/document.html`, osProcessId: 200, parent: null, isDestroyed: () => false };
    const state = fixture({ extraFrames: [reader] });
    try {
      assert.equal(state.stopped[0].reason, 'isolation');
      assert.deepEqual(state.killed, [], 'a process used by a non-plugin frame must never be killed');
    } finally { state.guard.dispose(); }
  }
  {
    const state = fixture({ execute: () => new Promise(() => {}), interval: 1000 });
    try {
      await sleep(2);
      state.plugin.osProcessId = 300;
      await sleep(65);
      assert.deepEqual(state.killed, [], 'a stale probe must never kill a replacement renderer');
      assert.equal(state.stopped[0].terminated, false);
    } finally { state.guard.dispose(); }
  }
  {
    const state = fixture({ metrics: [{ pid: 200, memory: { workingSetSize: 513 * 1024 } }] });
    try {
      assert.deepEqual(state.killed, [200]);
      assert.equal(state.stopped[0].reason, 'memory');
    } finally { state.guard.dispose(); }
  }
  {
    const state = fixture({ execute: () => new Promise(() => {}) });
    try {
      await sleep(2);
      state.guard.suspend();
      await sleep(65);
      assert.deepEqual(state.killed, [], 'system sleep must cancel timeout enforcement');
      assert.equal(state.stopped.length, 0);
    } finally { state.guard.dispose(); }
  }
  {
    const state = fixture({ execute: () => new Promise(() => {}) });
    await sleep(2);
    state.guard.dispose();
    await sleep(65);
    assert.deepEqual(state.killed, [], 'disposing the window must retire its watchdog');
  }
  {
    const state = fixture({ execute: () => new Promise(() => {}) });
    try {
      await sleep(2);
      state.plugin.url = `${serverURL}/api/settings`;
      state.contents.emit('did-frame-navigate');
      assert.deepEqual(state.killed, [], 'navigation into a core URL must not permit process termination');
      assert.equal(state.stopped[0].reason, 'navigation');
    } finally { state.guard.dispose(); }
  }
  {
    const state = fixture();
    try {
      Object.defineProperty(state.plugin, 'url', { get() { throw new Error('Render frame was disposed before WebFrameMain could be accessed'); } });
      state.contents.emit('did-frame-navigate');
      assert.deepEqual(state.killed, []);
      assert.equal(state.stopped[0].reason, 'crashed');
      assert.equal(await state.root.executeJavaScript('0'), 0);
    } finally { state.guard.dispose(); }
  }
  console.log('plugin process isolation and watchdog tests passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
