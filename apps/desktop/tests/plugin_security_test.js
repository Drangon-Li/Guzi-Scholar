'use strict';

const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { localRequestPolicy } = require('../electron/url-security.cjs');
const { mcpClientConfiguration } = require('../electron/mcp-config.cjs');

const url = 'http://127.0.0.1:18771/';
const main = { frameTreeNodeId: 1, url, parent: null };
const known = new Map();
const request = (frame, route, extra = {}) => localRequestPolicy({ frame, url: new URL(route, url).href, method: 'GET', resourceType: 'xhr', ...extra }, url, main, known);
assert.deepStrictEqual(request(main, '/api/settings'), { cancel: false, authorize: true });
assert.deepStrictEqual(request(null, '/api/settings'), { cancel: true, authorize: false });
const reader = { frameTreeNodeId: 2, parent: main, url: `${url}api/jobs/abcdef123456/document.html`, name: '' };
assert.deepStrictEqual(request(reader, '/api/jobs/abcdef123456/assets/page.png'), { cancel: false, authorize: true });
const loadingReader = { frameTreeNodeId: 6, parent: main, url: 'about:blank', name: '' };
assert.deepStrictEqual(request(loadingReader, '/api/jobs/abcdef123456/renders/3/document.html', { resourceType: 'subFrame' }), { cancel: false, authorize: true });
const plugin = { frameTreeNodeId: 3, parent: main, url: 'about:blank', name: 'guzi-plugin:example.test' };
assert.deepStrictEqual(request(plugin, '/plugins/example.test/index.html', { resourceType: 'subFrame' }), { cancel: false, authorize: true });
for (const target of ['/api/settings', '/api/library', '/api/plugins/example.test/invoke', '/files/abcdef123456/document.html', '/plugins/other.plugin/main.js', 'https://example.com/collect']) {
  assert.deepStrictEqual(request(plugin, target), { cancel: true, authorize: false }, target);
}
assert.deepStrictEqual(request(plugin, '/plugin-sdk.js', { resourceType: 'script' }), { cancel: false, authorize: true });
plugin.name = '';
plugin.url = `${url}api/jobs/abcdef123456/document.html`;
assert.deepStrictEqual(request(plugin, '/api/settings'), { cancel: true, authorize: false }, 'a plugin cannot gain credentials by renaming or navigating its frame');
const nested = { frameTreeNodeId: 4, parent: plugin, url: 'about:blank', name: '' };
assert.deepStrictEqual(request(nested, '/api/settings'), { cancel: true, authorize: false });
const unnamed = { frameTreeNodeId: 5, parent: main, url: 'about:blank', name: '' };
assert.deepStrictEqual(request(unnamed, '/plugins/example.test/index.html', { resourceType: 'subFrame' }), { cancel: false, authorize: true });
assert.deepStrictEqual(request(unnamed, '/api/settings'), { cancel: true, authorize: false });
assert.deepStrictEqual(request(plugin, '/plugins/example.test/main.js', { method: 'POST' }), { cancel: true, authorize: false });
const fixtureRoot = path.resolve(__dirname, 'MCP fixture with spaces');
const executable = path.join(fixtureRoot, process.platform === 'win32' ? 'Guzi Scholar.exe' : 'Guzi Scholar');
const projectRoot = path.join(fixtureRoot, 'resources', 'app');
const connectionFile = path.join(fixtureRoot, 'user data', 'mcp', 'connection.json');
const configuration = mcpClientConfiguration({ executable, projectRoot, connectionFile });
assert.strictEqual(configuration.command, executable);
assert.strictEqual(configuration.env.ELECTRON_RUN_AS_NODE, '1');
assert.deepStrictEqual(configuration.args, [path.join(projectRoot, 'mcp', 'bridge.cjs'), '--connection-file', connectionFile]);
assert(configuration.toml.includes(JSON.stringify(configuration.args)));
assert(!configuration.toml.includes('token'));

async function testPreviewLifecycle() {
  const handlers = new Map();
  const calls = [];
  const channels = [];
  const timers = new Map();
  const stopRequests = [];
  const registryRequests = [];
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  class Element {
    constructor(tag) { this.tag = tag; this.dataset = {}; this.children = []; this.parentElement = null; this.contentWindow = {}; this.navigationCount = 0; }
    set src(value) { this.source = value; this.navigationCount++; }
    get src() { return this.source; }
    setAttribute() {}
    addEventListener() {}
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    moveBefore(node) { this.append(node); this.moves = (this.moves || 0) + 1; }
    replaceChildren() { for (const node of [...this.children]) node.remove(); }
    querySelector() { return this.children.find((node) => node.className?.includes('plugin-runtime-status')); }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
  }
  const background = new Element('background');
  const ui = new Element('ui');
  let snapshot = { plugins: [], previews: [] };
  let holdRegistry = false;
  const hostWindow = { addEventListener: (name, handler) => handlers.set(name, handler) };
  const document = {
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => { assert.strictEqual(selector, '#plugin-background-previews'); return background; },
    querySelectorAll: () => [], dispatchEvent() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/plugin-host.js'), 'utf8'), {
    window: hostWindow, document, TextEncoder, CustomEvent: class {},
    setTimeout: (handler) => { const id = Symbol(); timers.set(id, handler); return id; }, clearTimeout: (id) => timers.delete(id),
    setInterval: () => 1, clearInterval() {},
    MessageChannel: class {
      constructor() { this.port1 = { closed: false, sent: [], postMessage(message) { this.sent.push(message); }, start() {}, close() { this.closed = true; } }; this.port2 = {}; channels.push(this); }
    },
  });
  const host = hostWindow.MyScholarPluginHost.create({
    jsonOptions: (payload) => payload,
    api: (route, payload) => {
      calls.push({ route, payload });
      if (route === '/api/plugins') {
        if (!holdRegistry) return Promise.resolve(snapshot);
        const request = deferred(); registryRequests.push(request); return request.promise;
      }
      if (payload?.name === 'stop_plugin_preview') { const request = deferred(); stopRequests.push(request); return request.promise; }
      return Promise.resolve({ result: {} });
    },
    onContributionsChanged() {}, navigate: () => assert.fail('Background preview must not navigate'), toast() {},
  });
  const result = (id, previewId) => ({ pluginId: id, previewId, manifest: { name: id }, url: `/preview/${previewId}` });
  const first = result('draft-first', 'session-1');
  const second = result('draft-second', 'session-2');
  snapshot = { plugins: [], previews: [first, second] };
  await host.refresh();
  assert.strictEqual(background.children.length, 2, 'Server previews should mount in the background');
  assert.strictEqual(ui.children.length, 0);
  const runtime = host.preview(first, ui);
  assert.strictEqual(ui.moves, 1, 'Moving a live iframe requires state-preserving DOM moveBefore');
  assert.strictEqual(background.children.length, 1);
  assert.strictEqual(runtime.container.parentElement, ui);
  assert.strictEqual(runtime.frame.navigationCount, 1);
  await host.refresh();
  assert.strictEqual(runtime.container.parentElement, ui, 'Polling must preserve an existing visible preview container');
  assert.strictEqual(host.preview(first, ui), runtime);
  assert.strictEqual(runtime.frame.navigationCount, 1, 'Reusing the same session must not navigate the iframe');
  handlers.get('message')({ data: { type: 'guzi-plugin-hello', sdkVersion: '1' }, origin: 'null', source: Object.assign(runtime.frame.contentWindow, { postMessage() {} }) });
  await runtime.ready;
  const port = channels.at(-1).port1;
  const staleRefresh = host.refresh();
  const closing = host.closePreview(ui);
  assert.strictEqual(runtime.closed, true, 'Closing must revoke the runtime before the stop RPC resolves');
  assert.strictEqual(port.closed, true, 'Closing must synchronously revoke the capability channel');
  assert.strictEqual(runtime.frame.parentElement, null);
  assert.strictEqual(ui.children.length, 0);
  await staleRefresh;
  await host.refresh();
  assert.strictEqual(background.children.length, 1, 'An old server snapshot cannot resurrect a closing session');
  assert.strictEqual(host.preview(first, ui), null, 'Explicit stale preview results are also retired');
  const duplicate = host.closePreviewSession(first);
  assert.strictEqual(stopRequests.length, 1, 'Concurrent closes of one session must share the server cleanup');
  stopRequests[0].reject(new Error('stop unavailable'));
  await assert.rejects(closing, /stop unavailable/u);
  await assert.rejects(duplicate, /stop unavailable/u);
  const retry = host.closePreviewSession(first);
  assert.strictEqual(stopRequests.length, 2, 'A failed cleanup must remain retryable');
  const replacement = result(first.pluginId, 'session-3');
  const newRuntime = host.preview(replacement, ui);
  stopRequests[1].resolve({ result: { stopped: false } });
  await retry;
  assert.strictEqual(newRuntime.closed, false, 'Completing an old close must not revoke a newer session');
  assert.strictEqual(newRuntime.container.parentElement, ui);
  assert.strictEqual(calls.filter((call) => call.payload?.name === 'stop_plugin_preview').at(-1).payload.arguments.previewId, first.previewId);
  holdRegistry = true;
  const olderRefresh = host.refresh();
  const newClosing = host.closePreviewSession(replacement);
  stopRequests.at(-1).resolve({ result: { stopped: true } });
  await newClosing;
  registryRequests[0].resolve({ plugins: [], previews: [replacement] });
  await olderRefresh;
  assert.strictEqual(ui.children.length, 0, 'A registry response started before close must be ignored');
  const unseen = result('never-mounted', 'session-4');
  const unseenClosing = host.closePreviewSession(unseen);
  stopRequests.at(-1).resolve({ result: { stopped: true } });
  await unseenClosing;
  assert.strictEqual(host.preview(unseen, ui), null, 'Unmounted sessions must support exact cleanup');
  const broken = host.preview(result('runtime-error', 'session-5'), ui);
  host.destroy(broken.id);
  const brokenClosing = host.closePreviewSession(broken.record);
  stopRequests.at(-1).resolve({ result: { stopped: true } });
  await brokenClosing;
  assert.strictEqual(host.preview(broken.record, ui), null, 'A destroyed runtime must still support server cleanup');
  const stopCount = stopRequests.length;
  await assert.rejects(host.closePreviewSession({ pluginId: 'draft-first' }), /会话 ID/u);
  assert.strictEqual(stopRequests.length, stopCount, 'A missing preview ID must never send a plugin-wide stop');
  handlers.get('pagehide')();
  assert.strictEqual(timers.size, 0);
}

testPreviewLifecycle().then(() => {
  console.log('plugin isolation, MCP configuration and preview lifecycle tests passed');
}).catch((error) => { console.error(error); process.exitCode = 1; });
