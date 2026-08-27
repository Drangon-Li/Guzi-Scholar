// Shared primitives for the reader front end: DOM lookup, byte formatting and
// the desktop-backed persistent UI state. Split out of app.js as the first
// step of breaking that entrypoint into per-feature modules.
//
// Attaches to window like graph-model.js and graph-view.js do, so the page
// keeps loading plain classic scripts with no build step. A classic script
// cannot use top-level await, so the initial state load is exposed as `ready`
// and awaited by app.js before it touches any persisted value.
(function attachCore(root) {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  const desktopPersistentState = root.myScholarDesktop?.state || null;
  const isDesktopApp = Boolean(desktopPersistentState);
  const persistentStateValues = new Map();
  const persistentStatePending = new Map();
  const persistentStateFailures = new Map();
  let persistentStateDrainPromise = null;
  let persistentStateLoadError = null;

  const ready = (async () => {
    if (!desktopPersistentState) return;
    try {
      const values = await desktopPersistentState.loadAll();
      Object.entries(values || {}).forEach(([key, value]) => {
        if (typeof value === 'string') persistentStateValues.set(key, value);
      });
    } catch (error) {
      persistentStateLoadError = error;
    }
  })();

  function drainPersistentStateWrites() {
    if (!desktopPersistentState || persistentStateDrainPromise) return persistentStateDrainPromise || Promise.resolve();
    persistentStateDrainPromise = (async () => {
      while (persistentStatePending.size) {
        const batch = [...persistentStatePending.entries()];
        persistentStatePending.clear();
        for (const [key, operation] of batch) {
          try {
            if (operation.type === 'remove') await desktopPersistentState.remove(key);
            else await desktopPersistentState.set(key, operation.value);
            persistentStateFailures.delete(key);
            localStorage.removeItem(key);
          } catch (error) {
            persistentStateFailures.set(key, { error, operation });
          }
        }
      }
    })().finally(() => {
      persistentStateDrainPromise = null;
      if (persistentStatePending.size) void drainPersistentStateWrites();
    });
    return persistentStateDrainPromise;
  }

  function persistentStateGet(key) {
    if (!desktopPersistentState) return localStorage.getItem(key);
    const pending = persistentStatePending.get(key);
    if (pending) return pending.type === 'remove' ? null : pending.value;
    if (persistentStateValues.has(key)) return persistentStateValues.get(key);
    const legacy = localStorage.getItem(key);
    if (legacy !== null) persistentStateSet(key, legacy);
    return legacy;
  }

  function persistentStateSet(key, value) {
    const text = String(value);
    if (!desktopPersistentState) {
      localStorage.setItem(key, text);
      return;
    }
    persistentStateValues.set(key, text);
    persistentStatePending.set(key, { type: 'set', value: text });
    void drainPersistentStateWrites();
  }

  function persistentStateRemove(key) {
    localStorage.removeItem(key);
    if (!desktopPersistentState) return;
    persistentStateValues.delete(key);
    persistentStatePending.set(key, { type: 'remove' });
    void drainPersistentStateWrites();
  }

  async function flushPersistentStateWrites() {
    if (!desktopPersistentState) return true;
    if (persistentStateLoadError) {
      try {
        await desktopPersistentState.loadAll();
        persistentStateLoadError = null;
      } catch (error) {
        persistentStateLoadError = error;
      }
    }
    for (const [key, failure] of persistentStateFailures) persistentStatePending.set(key, failure.operation);
    persistentStateFailures.clear();
    await drainPersistentStateWrites();
    if (persistentStateLoadError || persistentStateFailures.size) {
      const errors = [persistentStateLoadError, ...[...persistentStateFailures.values()].map((failure) => failure.error)]
        .filter(Boolean)
        .map((error) => String(error?.message || error));
      if (errors.some((message) => message.includes('界面状态键无效') || message.includes('No handler registered'))) {
        throw new Error('应用组件版本不一致，请完全退出谷子学术后重新打开。');
      }
      throw new Error('部分界面状态无法保存，请检查磁盘空间或应用数据目录权限。');
    }
    return true;
  }

  const api = Object.freeze({
    $,
    $$,
    formatBytes,
    desktopPersistentState,
    isDesktopApp,
    ready,
    persistentStateGet,
    persistentStateSet,
    persistentStateRemove,
    flushPersistentStateWrites,
  });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MyScholarCore = api;
})(typeof window === 'undefined' ? globalThis : window);
