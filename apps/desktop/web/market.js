(() => {
  'use strict';
  const permissionLabels = { 'vocabulary.read': '读取生词本', 'vocabulary.write': '修改生词本', 'library.read': '读取文献库', 'library.write': '修改文献库', 'notes.read': '读取笔记', 'notes.write': '修改笔记', 'ai.translate': '调用 AI 翻译', 'ai.explain': '调用 AI 释义', 'reader.open': '定位阅读来源', storage: '插件独立存储', 'preferences.read': '读取偏好设置', 'preferences.write': '修改偏好设置', 'annotations.read': '读取批注', 'annotations.write': '修改批注', 'plugins.manage': '管理和开发插件' };
  const permissionText = (permissions) => (permissions || []).map((item) => permissionLabels[item] || item).join('、') || '无额外权限';
  function create({ host, escapeHTML: h, confirm, navigate, toast }) {
    const root = document.querySelector('#market-view');
    const status = root.querySelector('#market-status');
    const previewView = document.querySelector('#plugin-preview-view');
    const previewContainer = previewView.querySelector('#market-preview');
    const previewStatus = previewView.querySelector('#market-preview-status');
    const previewInstall = previewView.querySelector('#market-preview-install');
    let previewSession = null;
    let plugins = [];
    let drafts = [];
    let busy = false;
    const checkFailures = new Map();
    let loadSequence = 0;
    const report = (message, error = false) => { status.hidden = !message; status.textContent = message; status.classList.toggle('error', error); };
    function card(plugin, draft = false) {
      const manifest = plugin.manifest || plugin;
      const id = plugin.id || plugin.draftId || manifest.id;
      const actions = draft ? '<button data-market-action="preview" class="secondary-button compact-button" type="button">预览草稿</button><button data-market-action="install-draft" class="primary-button compact-button" type="button">安装</button>' : `<button data-market-action="toggle" class="${plugin.enabled ? 'secondary' : 'primary'}-button compact-button" type="button">${plugin.enabled ? '停用' : '启用'}</button>${plugin.previous_version || plugin.can_rollback || plugin.rollback_available ? '<button data-market-action="rollback" class="tiny-button" type="button">回滚</button>' : ''}${plugin.bundled ? '' : '<button data-market-action="uninstall" class="tiny-button" type="button">卸载</button>'}`;
      return `<article class="market-card" data-plugin-id="${h(id)}"${draft ? ' data-draft="true"' : ''}><div class="market-card-heading"><h3>${h(manifest.name || id)}</h3><span class="market-badge">${draft ? '开发草稿' : plugin.bundled ? '内置' : plugin.enabled ? '已启用' : (checkFailures.has(id) || plugin.admission?.status === 'failed') ? '检查失败' : plugin.admission?.status === 'passed' ? '已停用' : '待检查'}</span></div><div class="market-card-version">${h(manifest.version || plugin.version || '1.0.0')} · ${h(id)}</div><p>${h(manifest.description || '自定义阅读器插件')}</p><div class="market-permissions"><strong>权限</strong><span>${h(permissionText(manifest.permissions))}</span></div><div class="market-card-actions">${actions}</div></article>`;
    }
    function render() {
      root.querySelector('#market-plugins').innerHTML = plugins.length ? plugins.map((plugin) => card(plugin)).join('') : '<div class="empty-state">尚未安装插件。</div>';
      root.querySelector('#market-drafts-section').hidden = !drafts.length;
      root.querySelector('#market-drafts').innerHTML = drafts.map((draft) => card(draft, true)).join('');
      root.querySelectorAll('[data-market-action]').forEach((button) => { button.disabled = busy; });
    }
    async function load() {
      const token = ++loadSequence;
      try {
        const result = await host.refresh();
        if (token !== loadSequence) return;
        plugins = result.plugins || []; drafts = result.drafts || []; render();
      } catch (error) { if (token === loadSequence) report(error.message, true); }
    }
    async function authorize(manifest, action = '启用') {
      return confirm(`${action}「${manifest.name || manifest.id}」将允许：${permissionText(manifest.permissions)}。`, `${action}插件并授权？`);
    }
    const isCurrentPreview = (session) => previewSession === session;
    function updatePreview(session, phase, message) {
      if (!isCurrentPreview(session)) return;
      session.phase = phase;
      previewStatus.textContent = message;
      previewStatus.classList.toggle('error', phase === 'error');
      previewInstall.disabled = phase !== 'ready';
    }
    async function cleanupPreview(result) {
      try { await host.closePreviewSession(result); }
      catch (error) {
        const message = `预览已在本机停止，服务端清理失败：${error.message}`;
        report(message, true); toast(message);
      }
    }
    function leavePreview() {
      const session = previewSession;
      if (!session) return Promise.resolve();
      previewSession = null;
      previewInstall.disabled = true;
      const closing = session.result ? cleanupPreview(session.result) : Promise.resolve();
      previewContainer.replaceChildren();
      return closing;
    }
    async function admissionState(result) {
      const state = await host.callRegistry('get_plugin_runtime_status', { pluginId: result.pluginId || result.id });
      if (state.previewId !== result.previewId) throw new Error('预览已停止或更新，请返回市场重新预览。');
      if (state.admission?.status === 'failed' || state.status === 'error') throw new Error(state.lastError?.message || '插件安全检查失败，不能安装或启用。');
      return state;
    }
    async function waitForAdmission(result, runtime, active = () => true) {
      if (!runtime) throw new Error('预览已停止，请返回市场重新预览。');
      await runtime.checked;
      const deadline = Date.now() + 15000;
      while (active() && Date.now() < deadline) {
        if (runtime.closed) throw new Error('插件运行已停止，请返回市场重新预览。');
        const state = await admissionState(result);
        if (state.admission?.status === 'passed') return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (active()) throw new Error('插件安全检查超时，请返回市场重新预览。');
    }
    async function startPreview(draft) {
      const closing = leavePreview();
      const session = { draftId: draft.draftId || draft.id, phase: 'preparing', result: null, runtime: null };
      previewSession = session;
      const manifest = draft.manifest || draft;
      previewView.querySelector('#market-preview-title').textContent = manifest.name || '插件预览';
      previewView.querySelector('#market-preview-description').textContent = manifest.description || '先试用，再决定是否安装。';
      previewView.querySelector('#market-preview-permissions').textContent = permissionText(manifest.permissions);
      updatePreview(session, 'preparing', '正在准备预览…');
      navigate('plugin-preview-view');
      previewView.querySelector('#market-preview-title').focus();
      try {
        await closing;
        if (!isCurrentPreview(session)) return;
        const validation = await host.callRegistry('validate_plugin', { draftId: session.draftId });
        if (!isCurrentPreview(session)) return;
        session.manifest = validation.manifest;
        previewView.querySelector('#market-preview-title').textContent = validation.manifest.name;
        previewView.querySelector('#market-preview-permissions').textContent = permissionText(validation.manifest.permissions);
        const allowed = await confirm(`预览「${validation.manifest.name}」可读取授权范围内的数据，试用操作仅保存在临时空间。安装后申请的权限：${permissionText(validation.manifest.permissions)}。`, '预览插件并授权？');
        if (!isCurrentPreview(session)) return;
        if (!allowed) { navigate('market-view'); return; }
        updatePreview(session, 'checking', '正在启动预览并进行安全检查…');
        const result = await host.callRegistry('preview_plugin', { draftId: session.draftId, grants: validation.manifest.permissions || [] });
        session.result = result;
        if (!isCurrentPreview(session)) { await cleanupPreview(result); return; }
        session.runtime = host.preview(result, previewContainer);
        await waitForAdmission(result, session.runtime, () => isCurrentPreview(session));
        updatePreview(session, 'ready', '安全检查通过。可以试用，觉得有用再安装。');
      } catch (error) { updatePreview(session, 'error', error.message); }
    }
    async function installPreview() {
      const session = previewSession;
      if (!session || session.phase !== 'ready') return;
      updatePreview(session, 'installing', '等待安装确认…');
      try {
        const allowed = await authorize(session.manifest, '安装并启用');
        if (!isCurrentPreview(session)) return;
        if (session.runtime.closed) throw new Error('插件运行已停止，请重新预览。');
        const state = await admissionState(session.result);
        if (!isCurrentPreview(session)) return;
        if (state.admission?.status !== 'passed') throw new Error('插件内容或权限已变化，请重新预览并完成安全检查。');
        if (!allowed) { updatePreview(session, 'ready', '安全检查通过。可以继续试用。'); return; }
        updatePreview(session, 'installing', '正在安装…');
        await host.callRegistry('install_plugin', { draftId: session.draftId, enabled: true, grants: session.manifest.permissions || [] });
        await cleanupPreview(session.result);
        if (isCurrentPreview(session)) {
          previewSession = null;
          navigate('market-view');
          report('插件已安装并启用。');
        }
        await load();
      } catch (error) { updatePreview(session, 'error', error.message); }
    }
    async function enable(plugin) {
      if (!await authorize(plugin.manifest)) return;
      if (!plugin.bundled && plugin.admission?.status !== 'passed') {
        checkFailures.delete(plugin.id);
        report('正在预览并检查插件…');
        const result = await host.callRegistry('preview_plugin', { pluginId: plugin.id, grants: plugin.manifest.permissions || [] });
        const runtime = host.preview(result, document.querySelector('#plugin-background-previews'));
        try {
          await waitForAdmission(result, runtime);
        } catch (error) {
          checkFailures.set(plugin.id, error.message); throw error;
        } finally {
          await host.closePreviewSession(result);
        }
      }
      await host.callRegistry('set_plugin_enabled', { pluginId: plugin.id, enabled: true, grants: plugin.manifest.permissions || [] });
      checkFailures.delete(plugin.id);
    }
    async function install(args) {
      const result = await host.callRegistry('install_plugin', { ...args, enabled: false, grants: [] });
      await load();
      const plugin = result.plugin || result;
      const installed = plugins.find((item) => item.id === plugin.id || item.id === result.pluginId);
      if (installed) await enable(installed);
      report('插件已安装。');
    }
    async function run(task) {
      if (busy) return;
      busy = true; render(); report('正在处理…');
      try { await task(); await load(); report('已更新。'); }
      catch (error) { report(error.message, true); }
      finally { busy = false; render(); }
    }
    document.addEventListener('guzi-plugin-registry-changed', ({ detail }) => {
      plugins = detail.plugins || []; drafts = detail.drafts || []; render();
      if (previewSession?.runtime?.closed && previewSession.phase === 'ready') updatePreview(previewSession, 'error', '预览已停止或更新，请返回市场重新预览。');
    });
    root.querySelector('#market-refresh').addEventListener('click', () => void load());
    root.querySelector('#market-package').addEventListener('change', (event) => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { report('插件包不能超过 20 MB。', true); return; }
      void run(async () => {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        await install({ packageBase64: btoa(binary) });
      });
    });
    root.querySelector('#market-github-form').addEventListener('submit', (event) => { event.preventDefault(); void run(() => install({ githubUrl: root.querySelector('#market-github-url').value.trim(), ...(root.querySelector('#market-github-sha256').value.trim() ? { sha256: root.querySelector('#market-github-sha256').value.trim() } : {}) })); });
    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-market-action]'); if (!button || button.disabled) return;
      const node = button.closest('[data-plugin-id]'); const id = node.dataset.pluginId;
      const plugin = plugins.find((item) => item.id === id);
      const draft = drafts.find((item) => (item.id || item.draftId || item.manifest?.id) === id);
      if (['preview', 'install-draft'].includes(button.dataset.marketAction)) { void startPreview(draft); return; }
      void run(async () => {
        switch (button.dataset.marketAction) {
          case 'toggle':
            if (plugin.enabled) {
              // Revoke the live channel before the asynchronous registry mutation.
              host.destroy(id);
              await host.callRegistry('set_plugin_enabled', { pluginId: id, enabled: false });
            } else await enable(plugin);
            break;
          case 'uninstall':
            if (await confirm(`卸载「${plugin.manifest.name}」？插件保存的数据会保留。`, '卸载插件？')) { await host.callRegistry('uninstall_plugin', { pluginId: id }); }
            break;
          case 'rollback':
            if (await confirm(`将「${plugin.manifest.name}」恢复到上一个已安装版本。`, '回滚插件？')) await host.callRegistry('rollback_plugin', { pluginId: id });
            break;
        }
      });
    });
    previewView.querySelector('#market-preview-back').addEventListener('click', () => navigate('market-view'));
    previewInstall.addEventListener('click', () => void installPreview());
    return { load, leavePreview };
  }
  window.MyScholarMarket = { create, permissionText };
})();
