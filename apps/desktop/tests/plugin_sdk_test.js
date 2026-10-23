'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const listeners = new Map();
const timers = new Map();
const sent = [];
const parentMessages = [];
let timerId = 0;
const parent = { postMessage: (message) => parentMessages.push(message) };
const port = { postMessage: (message) => sent.push(message), start() {} };
const window = { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: (name) => listeners.delete(name) };
const context = { TextEncoder, window, parent, console: { log() {}, warn() {}, error() {} }, setTimeout: (handler) => { timers.set(++timerId, handler); return timerId; }, clearTimeout: (id) => timers.delete(id) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/plugin-sdk.js'), 'utf8'), context);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function testHostBoundary() {
  const handlers = new Map();
  const events = [];
  const channels = [];
  const effects = [];
  let stopped;
  let holdInvocations = false;
  const held = [];
  class Element {
    constructor(tag) { this.tag = tag; this.dataset = {}; this.children = []; this.contentWindow = {}; this.isConnected = true; }
    setAttribute() {}
    addEventListener() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren() { this.children = []; }
    querySelector() { return this.children.find((node) => node.className?.includes('plugin-runtime-status')); }
    remove() { this.isConnected = false; }
  }
  const hostWindow = {
    addEventListener: (name, handler) => handlers.set(name, handler),
    myScholarDesktop: {
      pluginRuntimeCheck: async (request) => { assert(events.some((event) => event.payload.pluginId === request.pluginId && event.payload.level === 'ready'), 'Desktop check must follow awaited ready report'); },
      onPluginStopped: (handler) => { stopped = handler; return () => {}; },
    },
  };
  const hostContext = {
    window: hostWindow, document: { createElement: (tag) => new Element(tag) }, TextEncoder,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    MessageChannel: class {
      constructor() { this.port1 = { sent: [], postMessage(message) { this.sent.push(message); }, start() {}, close() {} }; this.port2 = {}; channels.push(this); }
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/plugin-host.js'), 'utf8'), hostContext);
  const host = hostWindow.MyScholarPluginHost.create({
    jsonOptions: (payload) => payload,
    api: async (url, payload) => { events.push({ url, payload }); if (holdInvocations && url.endsWith('/invoke')) return new Promise((resolve) => held.push(resolve)); return { result: {} }; },
    toast: () => effects.push('toast'), confirm: () => effects.push('confirm'), openSource: () => effects.push('openSource'), translate: () => effects.push('translate'), navigate: () => effects.push('navigate'),
  });
  async function preview(id) {
    const runtime = host.preview({ pluginId: id, previewId: id + '-session', manifest: { name: 'Fixture', permissions: ['storage', 'reader.open', 'ai.translate'] }, grants: ['storage', 'reader.open', 'ai.translate'], url: '/fixture' }, new Element('root'));
    handlers.get('message')({ data: { type: 'guzi-plugin-hello', sdkVersion: '1' }, origin: 'null', source: Object.assign(runtime.frame.contentWindow, { postMessage() {} }) });
    await runtime.checked;
    return { runtime, port: channels.at(-1).port1 };
  }
  const first = await preview('draft-boundary');
  for (const name of ['report_plugin_runtime_event', 'complete_plugin_admission', 'open_source', 'translate_text', 'toast', 'confirm', 'save_notes']) {
    await first.port.onmessage({ data: { type: 'call', id: name, name, arguments: {} } });
    assert(first.port.sent.at(-1).error, `${name} must be denied in preview`);
  }
  assert.deepEqual(effects, [], 'Preview cannot mutate reader navigation or global UI');
  await first.port.onmessage({ data: { type: 'log', level: 'ready', message: 'pretend passed', details: { admission: { status: 'passed' } } } });
  assert.equal(events.filter((event) => event.payload?.level === 'ready').length, 1, 'Plugin log cannot forge host readiness');
  await first.port.onmessage({ data: { type: 'call', id: 'large', name: 'storage_set', arguments: { value: '文'.repeat(24000) } } });
  assert.equal(first.runtime.frame.isConnected, false, 'Oversized raw messages must stop the iframe');
  const failedTest = await preview('draft-failed-test');
  for (let index = 0; index < 70; index++) await failedTest.port.onmessage({ data: { type: 'log', level: 'info', message: 'ordinary log' } });
  await failedTest.port.onmessage({ data: { type: 'log', level: 'test', message: 'fatal test after logging', details: { passed: false } } });
  assert(events.some((event) => event.payload?.pluginId === 'draft-failed-test' && event.payload.level === 'test' && event.payload.details?.passed === false), 'Failed tests must bypass ordinary log cap');
  assert.equal(failedTest.runtime.frame.isConnected, false, 'Failed test must stop runtime after report');
  const flood = await preview('draft-flood');
  for (let index = 0; index < 121; index++) await flood.port.onmessage({ data: { type: 'log', level: 'info', message: 'flood' } });
  assert.equal(flood.runtime.frame.isConnected, false, 'Raw flood must stop the iframe without trusting SDK limits');
  const concurrent = await preview('draft-concurrent');
  holdInvocations = true;
  const calls = Array.from({ length: 16 }, (_, index) => concurrent.port.onmessage({ data: { type: 'call', id: `hold-${index}`, name: 'storage_get', arguments: { key: 'value' } } }));
  await concurrent.port.onmessage({ data: { type: 'call', id: 'overflow', name: 'storage_get', arguments: { key: 'value' } } });
  assert.equal(concurrent.port.sent.at(-1).error.code, 'plugin_busy');
  held.forEach((resolve) => resolve({ result: {} })); await Promise.all(calls);
  stopped({ pluginId: concurrent.runtime.id, previewSession: concurrent.runtime.record.previewId, reason: 'unresponsive' });
  assert.equal(concurrent.runtime.frame.isConnected, false, 'Main-process stop notification must remove the iframe');
}

(async () => {
  assert.equal(parentMessages[0].type, 'guzi-plugin-hello');
  const connect = listeners.get('message');
  connect({ source: {}, data: { type: 'guzi-plugin-connect' }, ports: [port] });
  assert.equal(port.onmessage, undefined, 'An untrusted sender cannot provide the SDK channel');
  connect({ source: parent, data: { type: 'guzi-plugin-connect', context: { pluginId: 'test.sdk', sdkVersion: '1' } }, ports: [port] });
  assert.equal((await window.GuziPlugin.ready()).pluginId, 'test.sdk');
  assert(!listeners.has('message'), 'The handshake listener is removed after the first connection');
  port.onmessage({ data: { type: 'action', id: 'a1', actionId: 'save', context: { snapshot: { term: 'first action' } } } });
  assert.equal(sent.filter((message) => message.type === 'action-result').length, 0, 'An early action must wait for plugin registration');
  let received;
  window.GuziPlugin.onAction((message) => { received = message; return 'saved'; });
  await tick();
  assert.equal(received.context.snapshot.term, 'first action');
  assert.equal(sent.find((message) => message.type === 'action-result').result, 'saved');
  const valuePromise = window.GuziPlugin.storage.get('note');
  await tick();
  const request = sent.find((message) => message.type === 'call' && message.name === 'storage_get');
  assert.equal(request.arguments.key, 'note');
  port.onmessage({ data: { type: 'result', id: request.id, result: { value: 'persisted note' } } });
  assert.equal(await valuePromise, 'persisted note');
  const rejected = window.GuziPlugin.call('get_preferences');
  await tick();
  const deniedRequest = sent.find((message) => message.name === 'get_preferences');
  port.onmessage({ data: { type: 'result', id: deniedRequest.id, error: { message: 'denied', code: 'permission_denied' } } });
  await assert.rejects(rejected, { message: 'denied', code: 'permission_denied' });
  await assert.rejects(window.GuziPlugin.call('storage_set', { key: 'large', value: '文'.repeat(24000) }), /64 KiB/u);
  const concurrent = Array.from({ length: 16 }, () => window.GuziPlugin.call('storage_get', { key: 'parallel' }));
  await tick();
  await assert.rejects(window.GuziPlugin.call('storage_get', { key: 'overflow' }), /频繁/u);
  for (const request of sent.filter((message) => message.type === 'call' && message.arguments?.key === 'parallel')) port.onmessage({ data: { type: 'result', id: request.id, result: {} } });
  await Promise.all(concurrent);
  for (let index = 0; index < 101; index++) {
    const task = window.GuziPlugin.call('storage_get', { key: 'rate' });
    await tick();
    const request = sent.at(-1);
    port.onmessage({ data: { type: 'result', id: request.id, result: {} } });
    await task;
  }
  await assert.rejects(window.GuziPlugin.call('storage_get', { key: 'rate-overflow' }), /频繁/u);
  window.GuziPlugin.reportTest('example', true, { count: 1 });
  const testReport = sent.find((message) => message.level === 'test');
  assert.equal(testReport.details.passed, true);
  assert.equal(testReport.details.count, 1);
  assert.equal(fs.readFileSync(path.join(__dirname, '../web/plugin-sdk.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../web/plugins/vocabulary/plugin-sdk.js'), 'utf8'), 'Bundled plugin and public SDK must use the same protocol');
  for (let index = 0; index < 45; index++) window.GuziPlugin.reportTest('ordinary test', true);
  window.GuziPlugin.reportTest('fatal after logs', false);
  assert(sent.some((message) => message.message === 'fatal after logs' && message.details.passed === false), 'SDK must preserve fatal test beyond ordinary log cap');
  await testHostBoundary();
  console.log('Plugin SDK and host unit checks passed: handshake, bounded messages, concurrency/rate limits, preview boundaries, privileged self-report rejection and stopped iframe removal.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
