(() => {
  'use strict';
  const permissionLabels = { 'library.read': '读取文献库', 'library.write': '修改文献库', 'notes.read': '读取笔记', 'notes.write': '修改笔记', 'vocabulary.read': '读取生词本', 'vocabulary.write': '修改生词本', 'ai.translate': '调用 AI 翻译', 'preferences.read': '读取偏好设置', 'preferences.write': '修改偏好设置', 'annotations.read': '读取批注', 'annotations.write': '修改批注', 'plugins.manage': '管理和开发插件' };

  function create({ api, jsonOptions, escapeHTML: h, confirm, toast }) {
    const root = document.querySelector('#settings-mcp');
    const status = root.querySelector('#settings-mcp-status');
    let connection = null;
    let service = null;
    let busy = false;
    const report = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };

    function renderConnection() {
      const value = connection?.[root.querySelector('#settings-mcp-format').value];
      root.querySelector('#settings-mcp-copy').disabled = busy || !value;
      root.querySelector('#settings-mcp-connection').textContent = value ? typeof value === 'string' ? value : JSON.stringify(value, null, 2) : service?.connection_file ? `请在桌面版复制客户端配置。连接凭据文件：${service.connection_file}` : '启用服务后生成连接配置。';
    }
    function setBusy(value) {
      busy = value;
      root.querySelectorAll('input, select, button').forEach((control) => { control.disabled = value; });
      renderConnection();
    }
    async function refresh() {
      service = await api('/api/mcp/status');
      root.querySelector('#settings-mcp-enabled').checked = Boolean(service.enabled);
      const available = service.available_scopes || service.availableScopes || Object.keys(permissionLabels);
      const scopes = service.scopes || [];
      root.querySelector('#settings-mcp-scopes').innerHTML = '<legend>允许访问的能力范围</legend>' + available.map((item) => {
        const value = typeof item === 'string' ? item : item.id || item.name;
        return `<label><input type="checkbox" name="mcp-scope" value="${h(value)}"${scopes.includes(value) ? ' checked' : ''}${busy ? ' disabled' : ''}>${h(permissionLabels[value] || value)}</label>`;
      }).join('');
      const desktop = window.myScholarDesktop;
      connection = typeof desktop?.getMcpConfig === 'function' ? await desktop.getMcpConfig() : service.connection || service.config || null;
      renderConnection();
    }
    async function load() {
      if (busy) return;
      setBusy(true);
      report('正在读取 MCP 设置…');
      try { await refresh(); report(service.enabled ? 'MCP 已启用' : 'MCP 已关闭'); }
      catch (error) { report(error.message, true); }
      finally { setBusy(false); }
    }
    async function run(task) {
      if (busy) return;
      setBusy(true);
      try {
        if (await task() === false) return;
        await refresh();
        report(service.enabled ? 'MCP 已启用 · 设置已保存' : 'MCP 已关闭 · 设置已保存');
      } catch (error) { report(error.message, true); }
      finally { setBusy(false); }
    }
    root.addEventListener('change', (event) => {
      if (event.target.matches('input[type="checkbox"]')) report('MCP 设置尚未保存。');
    });
    root.querySelector('#settings-mcp-format').addEventListener('change', renderConnection);
    root.querySelector('#settings-mcp-save').addEventListener('click', () => {
      const payload = { enabled: root.querySelector('#settings-mcp-enabled').checked, scopes: [...root.querySelectorAll('[name="mcp-scope"]:checked')].map((input) => input.value) };
      void run(() => api('/api/mcp/configure', jsonOptions(payload)));
    });
    root.querySelector('#settings-mcp-rotate').addEventListener('click', () => void run(async () => {
      if (!await confirm('当前 MCP 客户端连接会失效，请使用新配置重新连接。', '轮换 MCP 凭据？')) return false;
      return api('/api/mcp/rotate', jsonOptions({}));
    }));
    root.querySelector('#settings-mcp-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(root.querySelector('#settings-mcp-connection').textContent); toast('连接配置已复制。'); }
      catch (error) { report(`复制失败：${error.message}`, true); }
    });
    return { load };
  }
  window.MyScholarMcpSettings = { create };
})();
