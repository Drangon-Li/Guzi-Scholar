(() => {
  'use strict';
  // 设置 → MCP 连接里的「谷子云端 MCP」。只在桌面版出现（网页演示版没有 myScholarDesktop.cloud）。
  // 所有用户数据都通过 textContent 写入，不拼接 HTML。

  const STATUS = {
    signed_out: ['未登录', ''], disabled: ['已关闭', ''], idle: ['未连接', ''], connecting: ['连接中…', 'pending'],
    online: ['在线', 'online'], reconnecting: ['重新连接中…', 'pending'], error: ['出错', 'error'],
  };

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'class') node.className = value;
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  }

  function init() {
    const root = document.querySelector('#settings-cloud');
    const cloud = window.myScholarDesktop?.cloud;
    if (!root) return;
    if (!cloud) { root.hidden = true; return; }
    const body = root.querySelector('#settings-cloud-body');
    const badge = root.querySelector('#settings-cloud-status');
    const message = root.querySelector('#settings-cloud-message');
    let state = null;
    let mode = 'login';
    let tokens = [];
    let created = null;
    let cooldown = 0;
    let cooldownTimer = null;
    let busy = false;

    const report = (text, error = false) => { message.textContent = text || ''; message.classList.toggle('error', !!error); };
    const copy = async (text, label) => {
      try { await navigator.clipboard.writeText(text); report(label); }
      catch (error) { report(`复制失败：${error.message}`, true); }
    };
    async function run(task, success) {
      if (busy) return;
      busy = true;
      render();
      report('');
      try { await task(); if (success) report(success); }
      catch (error) { report(error.message, true); }
      finally { busy = false; render(); }
    }
    async function refreshTokens() {
      tokens = state?.signedIn ? await cloud.listTokens().catch(() => []) : [];
      render();
    }
    function startCooldown(seconds) {
      cooldown = seconds;
      clearInterval(cooldownTimer);
      cooldownTimer = setInterval(() => { cooldown -= 1; if (cooldown <= 0) clearInterval(cooldownTimer); render(); }, 1000);
    }

    function field(label, name, type = 'text', extra = {}) {
      return el('label', { class: 'settings-cloud-field' }, el('span', {}, label), el('input', { name, type, required: true, ...extra }));
    }

    function authForm() {
      const tabs = el('div', { class: 'settings-cloud-tabs', role: 'tablist' },
        [['login', '账号密码登录'], ['code', '邮箱验证码登录'], ['register', '注册']].map(([id, label]) =>
          el('button', { type: 'button', role: 'tab', 'aria-selected': String(mode === id), onclick: () => { mode = id; report(''); render(); } }, label)));
      const form = el('form', { class: 'settings-cloud-form' });
      if (mode === 'login') {
        form.append(field('账号 / 邮箱', 'identifier', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }), field('密码', 'password', 'password', { autocomplete: 'current-password' }));
      } else {
        const email = field('邮箱', 'email', 'email', { autocomplete: 'email' });
        const send = el('button', { type: 'button', class: 'secondary-button compact-button', disabled: busy || cooldown > 0 }, cooldown > 0 ? `${cooldown} 秒后重发` : '发送验证码');
        send.addEventListener('click', () => {
          const target = email.querySelector('input').value.trim();
          if (!target) { report('请先填写邮箱', true); return; }
          void run(async () => { const result = await cloud.requestCode(mode === 'register' ? 'register' : 'login', target); startCooldown(result.cooldownSeconds || 60); }, '验证码已发送，请查收邮件。');
        });
        const code = field('验证码', 'code', 'text', { inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code' });
        code.append(send);
        form.append(email, code);
        if (mode === 'register') {
          form.append(field('账号名', 'username', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
            el('small', {}, '3–32 位，以字母开头，可用字母、数字、下划线和连字符。'),
            field('密码', 'password', 'password', { autocomplete: 'new-password' }),
            el('small', {}, '至少 8 位，需同时包含字母和数字。'));
        }
      }
      form.append(el('div', { class: 'settings-mcp-actions' },
        el('button', { type: 'submit', class: 'primary-button compact-button', disabled: busy }, mode === 'register' ? '注册并登录' : '登录'),
        el('button', { type: 'button', class: 'secondary-button compact-button', onclick: () => void cloud.openAccount() }, '在网页上管理账号 / 找回密码')));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const value = (key) => String(data.get(key) || '').trim();
        void run(async () => {
          if (mode === 'login') await cloud.login(value('identifier'), String(data.get('password') || ''));
          else if (mode === 'code') await cloud.loginWithCode(value('email'), value('code'));
          else await cloud.register({ username: value('username'), password: String(data.get('password') || ''), email: value('email'), code: value('code') });
        }, '已登录谷子账号。');
      });
      return [tabs, form];
    }

    function signedInView() {
      const user = state.user || {};
      const toggle = el('input', { type: 'checkbox', 'aria-label': '启用云端 MCP', disabled: busy });
      toggle.checked = !!state.enabled;
      toggle.addEventListener('change', () => void run(() => cloud.setEnabled(toggle.checked)));
      const createForm = el('form', { class: 'settings-cloud-create' },
        el('input', { name: 'name', type: 'text', maxlength: '48', required: true, placeholder: '例如：工作电脑上的 Claude Code', 'aria-label': 'token 名称' }),
        el('label', { class: 'settings-cloud-check' }, el('input', { name: 'bind', type: 'checkbox' }), '只转发到这台电脑'),
        el('button', { type: 'submit', class: 'primary-button compact-button', disabled: busy }, '新建 token'));
      createForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const data = new FormData(createForm);
        void run(async () => { created = await cloud.createToken(String(data.get('name') || '').trim(), data.get('bind') === 'on'); await refreshTokens(); });
      });
      return [
        el('label', { class: 'settings-toggle' }, el('div', {}, el('strong', {}, '启用云端 MCP'), el('small', {}, '关闭后 AI 客户端调用会收到「不在线」提示。')), toggle),
        el('div', { class: 'settings-cloud-line' }, el('span', {}, '账号'), el('code', {}, `${user.username || ''}${user.email ? `（${user.email}）` : ''}`),
          el('button', { type: 'button', class: 'secondary-button compact-button', onclick: () => void cloud.openAccount() }, '管理账号'),
          el('button', { type: 'button', class: 'secondary-button compact-button', disabled: busy, onclick: () => void run(() => cloud.logout(), '已退出谷子账号。') }, '退出登录')),
        el('div', { class: 'settings-cloud-line' }, el('span', {}, '地址'), el('code', {}, state.endpoint),
          el('button', { type: 'button', class: 'secondary-button compact-button', onclick: () => void copy(state.endpoint, '地址已复制。') }, '复制')),
        el('strong', { class: 'settings-cloud-subtitle' }, '访问 token'),
        el('small', {}, '每个 token 只能访问谷子学术，能力范围以下方「允许访问的能力范围」为准；删除后立即失效。'),
        tokens.length ? el('ul', { class: 'settings-cloud-tokens' }, tokens.map((token) => el('li', {},
          el('div', {}, el('span', {}, token.name, token.deviceId === state.deviceId ? el('em', {}, ' · 仅这台电脑') : null),
            el('small', {}, `${token.hint} · 最近使用 ${token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : '从未'}`)),
          el('button', { type: 'button', class: 'secondary-button compact-button', disabled: busy, onclick: () => void run(async () => { await cloud.revokeToken(token.id); await refreshTokens(); }, 'token 已删除。') }, '删除'))))
          : el('small', {}, '还没有 token。'),
        created
          ? el('div', { class: 'settings-cloud-created' },
            el('small', {}, '这是唯一一次显示完整 token，请现在复制保存。之后只能删除重建。'),
            el('code', {}, created.token),
            el('div', { class: 'settings-mcp-actions' },
              el('button', { type: 'button', class: 'secondary-button compact-button', onclick: () => void copy(created.token, 'token 已复制。') }, '复制 token'),
              el('button', { type: 'button', class: 'secondary-button compact-button', onclick: () => void copy(created.configs.claudeCode, '已复制 Claude Code 命令。') }, '复制 Claude Code 命令'),
              el('button', { type: 'button', class: 'secondary-button compact-button', onclick: () => void copy(created.configs.json, '已复制 JSON 配置。') }, '复制 JSON 配置'),
              el('button', { type: 'button', class: 'secondary-button compact-button', onclick: () => void copy(created.configs.codex, '已复制 Codex 配置。') }, '复制 Codex 配置'),
              el('button', { type: 'button', class: 'secondary-button compact-button', onclick: () => { created = null; render(); } }, '完成')))
          : createForm,
      ];
    }

    function render() {
      const [label, tone] = STATUS[state?.connection || 'signed_out'] || STATUS.signed_out;
      badge.textContent = label;
      badge.dataset.tone = tone;
      const nodes = [];
      if (state?.error) nodes.push(el('p', { class: 'panel-status error' }, state.error));
      nodes.push(...(state?.signedIn ? signedInView() : authForm()));
      body.replaceChildren(...nodes);
    }

    cloud.onState((next) => {
      const wasSignedIn = state?.signedIn;
      state = next;
      if (!!wasSignedIn !== !!next.signedIn) { created = null; void refreshTokens(); }
      else render();
    });
    cloud.getState().then((next) => { state = next; render(); return refreshTokens(); }).catch((error) => { report(error.message, true); render(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
