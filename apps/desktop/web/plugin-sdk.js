(() => {
  'use strict';
  if (window.GuziPlugin) return;
  let port = null;
  let sequence = 0;
  let initialContext = null;
  const pending = new Map();
  let recentCalls = [];
  const bounded = (message) => { if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 65536) throw new Error('插件消息不能超过 64 KiB。'); return message; };
  const post = (message) => port?.postMessage(bounded(message));
  const actionHandlers = new Set();
  const queuedActions = [];
  const contextHandlers = new Set();
  let resolveReady, rejectReady;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const handshakeTimer = setTimeout(() => rejectReady(new Error('插件宿主未响应，请重新载入插件。')), 15000);
  // Errors may precede the handshake; keep a small bounded diagnostic buffer.
  const logs = [];
  let logCount = 0;
  function report(level, message, details) {
    if (level !== 'error' && !(level === 'test' && details?.passed === false) && ++logCount > 40) return;
    const payload = { type: 'log', level, message: String(message).slice(0, 4000), details };
    try { bounded(payload); if (port) post(payload); else logs.push(payload); } catch (_error) {}
  }
  function receive(event) {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'result') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new Error(message.error.message || '插件请求失败'), { code: message.error.code }));
      else request.resolve(message.result);
    } else if (message.type === 'context') {
      initialContext = message.context;
      for (const handler of contextHandlers) Promise.resolve().then(() => handler(message.context)).catch((error) => report('error', error.message));
    } else if (message.type === 'action') {
      if (!actionHandlers.size) { if (queuedActions.length < 20) queuedActions.push(message); return; }
      Promise.all([...actionHandlers].map((handler) => Promise.resolve().then(() => handler({ actionId: message.actionId, context: message.context })))).then(
        (results) => post({ type: 'action-result', id: message.id, result: results[0] ?? null }),
        (error) => post({ type: 'action-result', id: message.id, error: { message: String(error.message || error).slice(0, 4000) } }),
      ).catch((error) => report('error', error.message));
    }
  }
  function connect(event) {
    if (event.source !== parent || event.data?.type !== 'guzi-plugin-connect' || port || !event.ports[0]) return;
    window.removeEventListener('message', connect);
    port = event.ports[0]; port.onmessage = receive; port.start();
    initialContext = event.data.context;
    clearTimeout(handshakeTimer);
    for (const entry of logs.splice(0)) post(entry);
    resolveReady(initialContext);
  }
  window.addEventListener('message', connect);
  window.addEventListener('error', (event) => report('error', `${event.message} (${event.filename || ''}:${event.lineno || 0})`));
  window.addEventListener('unhandledrejection', (event) => report('error', event.reason?.message || event.reason));
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { original(...args); report(level === 'error' ? 'error' : 'info', args.map((arg) => typeof arg === 'string' ? arg : String(arg)).join(' ')); };
  }
  async function call(name, args = {}) {
    await readyPromise;
    if (typeof name !== 'string' || !name) throw new Error('无效的插件能力名称。');
    const now = Date.now();
    recentCalls = recentCalls.filter((time) => now - time < 10000);
    if (pending.size >= 16 || recentCalls.length >= 120) throw new Error('插件请求过于频繁。');
    recentCalls.push(now);
    const id = `p${++sequence}`;
    bounded({ type: 'call', id, name, arguments: args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('插件能力请求超时。')); }, 180000);
      pending.set(id, { resolve, reject, timer });
      try { post({ type: 'call', id, name, arguments: args }); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  window.GuziPlugin = Object.freeze({
    ready: () => readyPromise,
    call,
    reportTest: (name, passed, details = {}) => report('test', name, { ...details, passed: Boolean(passed) }),
    storage: Object.freeze({ get: async (key) => (await call('storage_get', { key })).value, set: (key, value) => call('storage_set', { key, value }), remove: (key) => call('storage_remove', { key }) }),
    onAction(handler) { actionHandlers.add(handler); for (const action of queuedActions.splice(0)) receive({ data: action }); return () => actionHandlers.delete(handler); },
    onContext(handler) { contextHandlers.add(handler); return () => contextHandlers.delete(handler); },
    ui: Object.freeze({ openSource: (source) => call('open_source', { source }), toast: (message) => call('toast', { message }), confirm: (message, title) => call('confirm', { message, title }) }),
  });
  parent.postMessage({ type: 'guzi-plugin-hello', sdkVersion: '1' }, '*');
})();
