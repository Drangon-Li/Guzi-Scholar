(() => {
  'use strict';
  const hostPermissions = { translate_text: 'ai.translate', open_source: 'reader.open' };
  const previewCalls = new Set(['search_library', 'get_document', 'get_document_content', 'list_folders', 'list_properties', 'get_notes', 'vocabulary_list', 'storage_get', 'storage_set', 'storage_remove', 'storage.get', 'storage.set', 'storage.remove']);
  const bounded = (message) => { if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 65536) throw new Error('插件消息不能超过 64 KiB。'); return message; };
  const safeMessage = (error) => ({ message: String(error?.message || error).slice(0, 4000), code: String(error?.code || 'plugin_error') });
  function create({ api, jsonOptions, navigate, onRemoved, onContributionsChanged, translate, openSource, toast, confirm }) {
    const records = new Map();
    const runtimes = new Map();
    const views = new Map();
    const closedPreviewSessions = new Set();
    const closingPreviewSessions = new Map();
    let sequence = 0;
    let refreshSequence = 0;
    let contributionSignature = '';
    const viewId = (id) => id === 'guzi.vocabulary' ? 'vocabulary-view' : `plugin-view-${encodeURIComponent(id)}`;
    const current = (runtime) => runtimes.get(runtime.id) === runtime && !runtime.closed;
    const previewSessionKey = (id, previewId) => JSON.stringify([id, previewId]);
    const callRegistry = async (name, args = {}) => (await api('/api/plugins/call', jsonOptions({ name, arguments: args }))).result;
    function report(runtime, level, message, details) {
      if (!current(runtime) || (!['error', 'ready'].includes(level) && !(level === 'test' && details?.passed === false) && runtime.logCount++ > 60)) return Promise.resolve();
      return api('/api/plugins/runtime-event', jsonOptions({ pluginId: runtime.id, level, message: String(message).slice(0, 4000), details, previewSession: runtime.record.previewId, pluginSession: runtime.preview ? undefined : runtime.record.epoch }));
    }
    function destroy(id, message = '插件已停用。') {
      const runtime = runtimes.get(id);
      if (!runtime) return;
      runtime.closed = true;
      clearTimeout(runtime.timer);
      runtime.rejectReady(new Error(message));
      runtime.rejectChecked(new Error(message));
      for (const task of runtime.pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)); }
      runtime.pending.clear();
      runtime.leases.clear();
      runtime.port?.close(); runtime.frame.remove();
      runtimes.delete(id);
    }
    function showError(runtime, message, reportError = true) {
      if (!current(runtime)) return;
      const status = runtime.container.querySelector('.plugin-runtime-status');
      status.hidden = false; status.textContent = message;
      if (reportError) void report(runtime, 'error', message).catch(() => {});
    }
    function stop(runtime, message, reportError = true) {
      if (!current(runtime)) return;
      showError(runtime, message, reportError); destroy(runtime.id, message);
      if (runtime.preview) void closePreviewSession(runtime.record).catch((error) => toast(`停止插件预览失败：${error.message}`));
    }
    function context(runtime, extra = {}) {
      return { pluginId: runtime.id, sdkVersion: '1', preview: runtime.preview, previewId: runtime.record.previewId, manifest: runtime.record.manifest, ...extra };
    }
    async function invoke(runtime, message) {
      if (!runtime.preview && !runtime.record.bundled) await runtime.checked;
      if (!current(runtime) || runtime.stopping) throw new Error('插件已停用。');
      const args = message.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('插件能力参数必须为对象。');
      if (runtime.preview && !previewCalls.has(message.name)) throw new Error('预览不能修改用户数据、调用 AI、打开来源或显示全局提示。');
      const permission = hostPermissions[message.name];
      if (permission && !runtime.record.grants?.includes(permission)) throw new Error(`插件缺少权限：${permission}`);
      if (message.name === 'toast') { toast(String(args.message || '').slice(0, 1000)); return null; }
      if (message.name === 'confirm') return confirm(String(args.message || '').slice(0, 4000), String(args.title || '插件确认').slice(0, 120));
      if (permission) {
        await api(`/api/plugins/${encodeURIComponent(runtime.id)}/invoke`, jsonOptions({ name: message.name, arguments: args, previewSession: runtime.record.previewId, pluginSession: runtime.preview ? undefined : runtime.record.epoch }));
        if (!current(runtime)) throw new Error('插件已停用。');
      }
      if (message.name === 'open_source') return openSource(args.source).then(() => null);
      if (message.name === 'translate_text') {
        if (args.requestId) {
          const lease = runtime.leases.get(String(args.requestId));
          if (!lease) throw new Error('选区翻译请求已失效。');
          return lease;
        }
        return translate(String(args.text || ''), args.job_id);
      }
      return (await api(`/api/plugins/${encodeURIComponent(runtime.id)}/invoke`, jsonOptions({ name: message.name, arguments: args, previewSession: runtime.record.previewId, pluginSession: runtime.preview ? undefined : runtime.record.epoch }))).result;
    }
    function mount(record, container, preview = false) {
      if (runtimes.has(record.id)) return runtimes.get(record.id);
      container.replaceChildren();
      const status = document.createElement('p'); status.className = 'plugin-runtime-status panel-status'; status.hidden = true; status.setAttribute('role', 'status');
      const frame = document.createElement('iframe');
      frame.name = `guzi-plugin:${record.id}`;
      frame.className = 'plugin-frame'; frame.title = record.manifest.name; frame.dataset.pluginId = record.id;
      frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
      const runtime = { id: record.id, record, container, frame, preview, closed: false, port: null, pending: new Map(), calls: new Set(), leases: new Map(), logCount: 0, loadCount: 0, recentMessages: [] };
      runtime.ready = new Promise((resolve, reject) => { runtime.resolveReady = resolve; runtime.rejectReady = reject; });
      runtime.ready.catch(() => {});
      runtime.checked = new Promise((resolve, reject) => { runtime.resolveChecked = resolve; runtime.rejectChecked = reject; });
      runtime.checked.catch(() => {});
      runtimes.set(record.id, runtime);
      runtime.timer = setTimeout(() => { stop(runtime, '插件启动超时，请在市场中停用后重新启用。'); }, 15000);
      frame.addEventListener('load', () => {
        if (++runtime.loadCount > 1 && current(runtime)) {
          stop(runtime, '插件试图重新导航，运行已停止。');
        }
      });
      frame.src = record.url || `/plugins/${encodeURIComponent(record.id)}/${record.manifest.entry || 'index.html'}`;
      container.append(status, frame);
      return runtime;
    }
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'guzi-plugin-hello' || event.data?.sdkVersion !== '1' || event.origin !== 'null') return;
      const runtime = [...runtimes.values()].find((item) => item.frame.contentWindow === event.source);
      if (!runtime || runtime.port || !current(runtime)) return;
      const channel = new MessageChannel(); runtime.port = channel.port1;
      runtime.port.onmessage = async ({ data: message }) => {
        if (!current(runtime) || runtime.stopping) return;
        try {
          bounded(message);
          const now = Date.now();
          runtime.recentMessages = runtime.recentMessages.filter((time) => now - time < 10000);
          runtime.recentMessages.push(now);
          if (runtime.recentMessages.length > 120) throw new Error('插件消息过于频繁，运行已停止。');
        } catch (error) { stop(runtime, error.message); return; }
        if (!message || typeof message !== 'object') return;
        if (message.type === 'log') {
          const level = ['error', 'test'].includes(message.level) ? message.level : 'info';
          const fatal = level === 'error' || (level === 'test' && message.details?.passed === false);
          const reporting = report(runtime, level, message.message, message.details);
          if (fatal) {
            runtime.stopping = true;
            try { await reporting; stop(runtime, String(message.message).slice(0, 1000), false); }
            catch (error) { stop(runtime, error.message); }
          } else void reporting.catch(() => {});
          return;
        }
        if (message.type === 'action-result') {
          const task = runtime.pending.get(message.id);
          if (!task) return;
          runtime.pending.delete(message.id); clearTimeout(task.timer);
          if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
          return;
        }
        if (message.type !== 'call' || typeof message.id !== 'string' || message.id.length > 100 || typeof message.name !== 'string') return;
        if (runtime.calls.has(message.id)) return;
        if (runtime.calls.size >= 16) { runtime.port.postMessage({ type: 'result', id: message.id, error: { message: '插件请求过于频繁。', code: 'plugin_busy' } }); return; }
        runtime.calls.add(message.id);
        try {
          const result = await invoke(runtime, message);
          if (current(runtime)) runtime.port.postMessage(bounded({ type: 'result', id: message.id, result }));
        } catch (error) {
          if (current(runtime)) runtime.port.postMessage({ type: 'result', id: message.id, error: safeMessage(error) });
        } finally { runtime.calls.delete(message.id); }
      };
      runtime.port.start();
      event.source.postMessage({ type: 'guzi-plugin-connect', context: context(runtime) }, '*', [channel.port2]);
      void (async () => {
        try {
          await report(runtime, 'ready', '插件已连接 SDK。');
          if (!current(runtime)) return;
          if (!recordBundled(runtime)) {
            const check = window.myScholarDesktop?.pluginRuntimeCheck;
            if (typeof check !== 'function') {
              if (!runtime.preview) throw new Error('个人插件需在桌面版完成运行检查。');
              clearTimeout(runtime.timer); runtime.resolveReady();
              const message = '预览已连接；请使用桌面版完成运行检查后启用插件。';
              const status = runtime.container.querySelector('.plugin-runtime-status');
              status.hidden = false; status.textContent = message;
              runtime.rejectChecked(new Error(message)); return;
            }
            await check({ pluginId: runtime.id, previewSession: runtime.record.previewId, pluginSession: runtime.preview ? undefined : runtime.record.epoch });
          }
          if (!current(runtime)) return;
          clearTimeout(runtime.timer); runtime.resolveChecked(); runtime.resolveReady();
        } catch (error) { stop(runtime, error.message); }
      })();
    });
    const recordBundled = (runtime) => runtime.record.bundled && !runtime.preview;
    const unsubscribeStopped = window.myScholarDesktop?.onPluginStopped?.((event) => {
      const runtime = runtimes.get(event.pluginId);
      if (!runtime || (event.previewSession && event.previewSession !== runtime.record.previewId)) return;
      const message = `插件运行已停止：${event.reason || '运行检查失败'}`;
      stop(runtime, message);
    });
    function removeContribution(id) {
      const view = views.get(id);
      if (view?.classList.contains('active-view')) onRemoved(view.id);
      view?.remove(); views.delete(id);
      document.querySelectorAll('[data-plugin-nav]').forEach((node) => { if (node.dataset.pluginNav === id) node.remove(); });
      destroy(id);
    }
    async function refresh() {
      const token = ++refreshSequence;
      const result = await api('/api/plugins');
      if (token !== refreshSequence) return result;
      const next = new Map((result.plugins || []).map((item) => [item.id, item]));
      for (const [id, before] of records) {
        const after = next.get(id);
        if (!after?.enabled || JSON.stringify([before.epoch, before.version, before.sha256, before.grants, before.manifest]) !== JSON.stringify([after.epoch, after.version, after.sha256, after.grants, after.manifest])) removeContribution(id);
      }
      records.clear(); next.forEach((value, key) => records.set(key, value));
      for (const record of records.values()) {
        if (!record.enabled || views.has(record.id)) continue;
        const pages = record.manifest.contributes?.pages || [];
        const view = document.createElement('section'); view.id = viewId(record.id); view.className = 'view plugin-view'; view.hidden = true; view.dataset.pluginId = record.id;
        document.querySelector('#reader-view').before(view); views.set(record.id, view);
        for (const page of pages) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'nav-button'; button.dataset.view = view.id; button.dataset.pluginNav = record.id; button.dataset.pluginPage = page.id; button.textContent = page.title;
          button.addEventListener('click', () => { openView(view.id, page.id); navigate(view.id); });
          document.querySelector('.top-nav').append(button);
        }
      }
      const previews = new Map((result.previews || []).map((item) => [item.pluginId || item.id, item]));
      for (const runtime of [...runtimes.values()]) {
        if (runtime.preview && (!previews.has(runtime.id) || previews.get(runtime.id).previewId !== runtime.record.previewId)) {
          destroy(runtime.id, '预览已停止或更新。'); runtime.container.remove();
        }
      }
      const previewRoot = document.querySelector('#plugin-background-previews');
      for (const record of previews.values()) {
        if (runtimes.get(record.pluginId || record.id)?.preview) continue;
        if (previewRoot) preview(record, previewRoot);
      }
      const signature = JSON.stringify(result);
      if (signature !== contributionSignature) {
        contributionSignature = signature;
        onContributionsChanged();
        document.dispatchEvent(new CustomEvent('guzi-plugin-registry-changed', { detail: result }));
      }
      return result;
    }
    function openView(id, pageId) {
      const record = [...records.values()].find((item) => item.enabled && viewId(item.id) === id);
      if (!record) return false;
      const runtime = mount(record, views.get(record.id));
      runtime.pageId = pageId || runtime.pageId || record.manifest.contributes?.pages?.[0]?.id;
      document.querySelectorAll('[data-plugin-nav]').forEach((button) => { if (button.dataset.pluginNav === record.id) button.classList.toggle('active', button.dataset.pluginPage === runtime.pageId); });
      void runtime.ready.then(() => { if (current(runtime)) runtime.port.postMessage(bounded({ type: 'context', context: context(runtime, { pageId: runtime.pageId }) })); }).catch(() => {});
      return true;
    }
    function selectionActions() {
      return [...records.values()].filter((record) => record.enabled).flatMap((record) => (record.manifest.contributes?.selectionActions || []).map((action) => ({ ...action, pluginId: record.id })));
    }
    async function dispatchAction(pluginId, actionId, actionContext, translation = null) {
      const record = records.get(pluginId);
      if (!record?.enabled || !selectionActions().some((item) => item.pluginId === pluginId && item.id === actionId)) throw new Error('插件动作已失效。');
      const runtime = mount(record, views.get(pluginId));
      await runtime.ready;
      if (!current(runtime)) throw new Error('插件已停用。');
      const id = `a${++sequence}`;
      const requestId = translation ? `${id}-translation` : null;
      if (translation) {
        const lease = Promise.resolve(translation); lease.catch(() => {}); runtime.leases.set(requestId, lease);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { runtime.pending.delete(id); runtime.leases.delete(requestId); reject(new Error('插件动作超时。')); }, 180000);
        runtime.pending.set(id, { timer, resolve, reject });
        try { runtime.port.postMessage(bounded({ type: 'action', id, actionId, context: { ...actionContext, translationRequestId: requestId } })); }
        catch (error) { clearTimeout(timer); runtime.pending.delete(id); runtime.leases.delete(requestId); reject(error); }
        // Keep the translation lease after the action response: saving may finish
        // before its pending translation. Retirement always revokes the lease.
        if (translation) Promise.resolve(translation).finally(() => setTimeout(() => runtime.leases.delete(requestId), 180000)).catch(() => {});
      });
    }
    function preview(result, container) {
      const id = result.pluginId || result.id;
      refreshSequence++;
      if (closedPreviewSessions.has(previewSessionKey(id, result.previewId))) return null;
      const existing = runtimes.get(id);
      if (existing?.preview && existing.record.previewId === result.previewId) {
        if (existing.container.parentElement !== container) container.moveBefore(existing.container, null);
        return existing;
      }
      if (existing) { destroy(id, '预览已更新。'); existing.container.remove(); }
      const slot = document.createElement('div'); slot.className = 'plugin-preview-runtime'; slot.dataset.previewPlugin = id;
      container.append(slot);
      const record = { ...result, id, manifest: result.manifest, grants: result.grants || [], enabled: true };
      return mount(record, slot, true);
    }
    function closePreviewSession(result) {
      const id = result.pluginId || result.id;
      if (!id || !result.previewId) return Promise.reject(new Error('停止预览需要插件和预览会话 ID。'));
      const key = previewSessionKey(id, result.previewId);
      closedPreviewSessions.add(key);
      // Invalidate registry requests that started before this local revocation.
      refreshSequence++;
      const runtime = runtimes.get(id);
      if (runtime?.preview && runtime.record.previewId === result.previewId) {
        destroy(id, '预览已停止。'); runtime.container.remove();
      }
      if (closingPreviewSessions.has(key)) return closingPreviewSessions.get(key);
      const closing = callRegistry('stop_plugin_preview', { pluginId: id, previewId: result.previewId });
      closingPreviewSessions.set(key, closing);
      void closing.finally(() => { if (closingPreviewSessions.get(key) === closing) closingPreviewSessions.delete(key); }).catch(() => {});
      return closing;
    }
    function closePreview(container) {
      const previews = [...runtimes.values()].filter((runtime) => runtime.preview && container.contains(runtime.container));
      return Promise.all(previews.map((runtime) => closePreviewSession(runtime.record)));
    }
    let synchronizationInFlight = false;
    const synchronizationTimer = setInterval(async () => {
      if (synchronizationInFlight) return;
      synchronizationInFlight = true;
      try { await refresh(); } catch (_error) {} finally { synchronizationInFlight = false; }
    }, 2000);
    window.addEventListener('pagehide', () => { clearInterval(synchronizationTimer); unsubscribeStopped?.(); [...runtimes.keys()].forEach((id) => destroy(id)); });
    return { destroy, refresh, openView, selectionActions, dispatchAction, preview, closePreview, closePreviewSession, callRegistry, destroyAll: () => [...runtimes.keys()].forEach((id) => destroy(id)), records };
  }
  window.MyScholarPluginHost = { create };
})();
