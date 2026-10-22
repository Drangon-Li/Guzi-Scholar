'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const id = 'cccccccccccccccc';
const modelCapabilities = {
  reasoner: { context_window: 128000, reasoning_efforts: ['low', 'high'], thinking_supported: true, thinking_required: false, thinking_budget_supported: true, thinking_budget_min: 1024, thinking_budget_max: 32000, source: 'fixture' },
  mandatory: { context_window: 64000, reasoning_efforts: ['low', 'high'], thinking_supported: true, thinking_required: true, thinking_budget_supported: false, source: 'fixture' },
  plain: { context_window: 32000, reasoning_efforts: [], thinking_supported: false, thinking_required: false, thinking_budget_supported: false, source: 'fixture' },
  unknown: { reasoning_efforts: null, thinking_supported: null, thinking_required: null, source: 'unknown' },
};
const job = { job_id: id, source_filename: 'Synthetic AI controls.pdf', status: 'completed', created_at: '2026-10-22T00:00:00Z', links: { html: `/api/jobs/${id}/document.html` }, manifest: { counts: { pages: 1, images: 0 } } };
const library = { folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] }, items: { [id]: { folder_ids: [], values: { reading_status: '未读', importance: 0 }, metadata: { fields: {}, status: 'complete' } } } };
let settings = { metadata: { auto_retrieve: false }, ai: {
  chat: { base_url: 'https://synthetic.invalid/v1', model: 'reasoner', api_format: 'auto', reasoning_effort: 'high', thinking_budget: 0, context_window: 0 },
  translation: { provider: 'openai-compatible', mode: 'qwen-mt', base_url: 'https://synthetic.invalid/v1', model: 'unknown', api_format: 'auto', reasoning_effort: 'auto', thinking_budget: 0, context_window: 0 },
} };
function profile(value) { return { ...value, capabilities: modelCapabilities[value.model] || modelCapabilities.unknown }; }
const requests = [];
let useStream = true;
const info = { window: 64000, estimated_input_tokens: 51000, output_tokens: 4096, truncated: true, source: 'fixture' };
(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 } });
    const errors = [];
    const unexpected = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs: [job] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { chat: { ...profile(settings.ai.chat), enabled: true, configured: true }, translation: { ...profile(settings.ai.translation), enabled: false, configured: false } } } };
      else if (pathname === '/api/settings') {
        if (method === 'POST') { requests.push({ type: 'settings', body: request.postDataJSON() }); settings = request.postDataJSON(); }
        const result = { ...settings, ai: Object.fromEntries(Object.entries(settings.ai).map(([key, value]) => [key, profile(value)])) };
        payload = method === 'POST' ? { settings: result } : result;
      } else if (pathname === '/api/ai/models') {
        requests.push({ type: 'models', body: request.postDataJSON() });
        payload = { models: Object.keys(modelCapabilities), model_capabilities: modelCapabilities };
      } else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[id] };
      else if (pathname === `/api/jobs/${id}/document.html`) {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main class="reader-content"><section class="pdf-page" data-page="1"><h1 data-block-id="block-1-0-heading" data-page="1">Synthetic controls</h1><p data-block-id="block-1-1-paragraph" data-page="1">A synthetic article for AI controls.</p></section></main></body></html>' }); return;
      } else if (pathname === `/api/jobs/${id}/chat`) {
        requests.push({ type: 'chat', body: request.postDataJSON() });
        if (useStream) {
          await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ context: info })}\n\ndata: ${JSON.stringify({ delta: 'Synthetic answer' })}\n\ndata: ${JSON.stringify({ result: { text: 'Synthetic answer' }, context: info })}\n\n` }); return;
        }
        payload = { result: { text: 'Synthetic JSON answer' }, context: { ...info, truncated: false } };
      } else if (pathname === `/api/jobs/${id}`) payload = job;
      else if (pathname.endsWith('/annotations')) payload = { annotations: [] };
      else if (pathname.endsWith('/translations')) payload = { translations: [] };
      else if (pathname.endsWith('/media-layout')) payload = { media_layout: { version: 1, items: {} } };
      else if (pathname.endsWith('/notes')) payload = { markdown: '' };
      else if (pathname.endsWith('/auto-highlights')) payload = { result: { status: 'mock', highlights: [] } };
      else unexpected.push(`${method} ${pathname}`);
      await route.fulfill({ json: payload });
    });
    const saved = () => page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
    async function change(selector, value) {
      await page.locator(selector).fill(value);
      await page.locator(selector).dispatchEvent('change');
      await saved();
    }
    async function send(question) {
      const previous = requests.filter((request) => request.type === 'chat').length;
      await page.locator('#chat-input').fill(question);
      await page.locator('#chat-form button[type="submit"]').click();
      await page.waitForFunction(() => !document.querySelector('.chat-bubble.is-streaming') && document.querySelector('#chat-input').value === '');
      assert.equal(requests.filter((request) => request.type === 'chat').length, previous + 1);
      return requests.filter((request) => request.type === 'chat').at(-1).body;
    }
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('[data-view="settings-view"]').click();
    await page.locator('.settings-navigation a[href="#settings-ai"]').click();
    await page.waitForFunction(() => document.querySelector('#setting-chat-model').value === 'reasoner');
    assert.equal(await page.locator('#setting-translation-inference').isVisible(), false, 'qwen-mt must not expose chat inference controls');
    assert.equal(await page.locator('.ai-advanced-settings[open]').count(), 0, 'Advanced settings start collapsed');
    assert.equal(await page.locator('#setting-chat-model').isVisible(), true, 'The basic model field stays visible');
    await page.locator('#setting-chat-advanced > summary').click();
    await page.locator('#setting-chat-context-window').fill('-1');
    await page.locator('#setting-chat-advanced > summary').click();
    await page.locator('#setting-chat-context-window').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('#setting-chat-advanced').open && document.querySelector('#settings-save-status').dataset.state === 'error');
    assert.equal(await page.locator('#setting-chat-context-window').evaluate((node) => node === document.activeElement), true, 'Invalid advanced input is revealed and focused');
    await page.locator('#setting-chat-context-window').fill('0');
    await page.locator('#setting-chat-context-window').press('Tab');
    await saved();
    assert.deepEqual(await page.locator('#setting-chat-reasoning-effort option').evaluateAll((options) => options.map((option) => option.value)), ['auto', 'none', 'low', 'high']);
    await page.locator('#setting-chat-api-format').selectOption('anthropic'); await saved();
    assert.equal(settings.ai.chat.api_format, 'anthropic');
    await page.locator('[data-ai-models="chat"]').click();
    await page.waitForFunction(() => !document.querySelector('#setting-chat-model-picker').hidden);
    assert.equal(requests.filter((request) => request.type === 'models').at(-1).body.profile.api_format, 'anthropic');
    await page.locator('#setting-chat-model-list').selectOption('plain');
    await page.waitForFunction(() => !document.querySelector('#setting-chat-options-warning').hidden);
    assert.match(await page.locator('#setting-chat-options-warning').innerText(), /不支持/u);
    await page.locator('#setting-chat-reasoning-effort').selectOption('auto'); await saved();
    assert.equal(await page.locator('#setting-chat-thinking-field').isVisible(), false);
    await change('#setting-chat-model', 'mandatory');
    assert.equal(await page.locator('#setting-chat-reasoning-effort option[value="none"]').count(), 0);
    await change('#setting-chat-model', 'unknown');
    assert.match(await page.locator('#setting-chat-capability-status').innerText(), /能力未知/u);
    await page.locator('#setting-chat-reasoning-effort').selectOption('custom');
    await change('#setting-chat-reasoning-custom', 'vendor-depth');
    assert.equal(settings.ai.chat.reasoning_effort, 'vendor-depth');
    await page.locator('#setting-chat-reasoning-effort').selectOption('auto'); await saved();
    await change('#setting-chat-model', 'reasoner');
    await page.locator('#setting-chat-reasoning-effort').selectOption('high'); await saved();
    await change('#setting-chat-context-window', '96000');
    await page.locator('[data-view="library-view"]').click();
    await page.locator(`#library-view .library-row[data-job-id="${id}"]`).dblclick();
    await page.waitForFunction(() => document.querySelector('#html-preview')?.contentDocument?.querySelector('[data-block-id="block-1-1-paragraph"]'));
    if (await page.locator('#assistant-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#assistant-toggle').click();
    assert.deepEqual((await send('Inherited settings')).options, {});
    await page.locator('#chat-session-options summary').click();
    await page.locator('#chat-reasoning-effort').selectOption('low');
    await page.locator('#chat-thinking-mode').selectOption('custom');
    await page.locator('#chat-thinking-budget').fill('2048'); await page.locator('#chat-thinking-budget').dispatchEvent('change');
    await page.locator('#chat-context-mode').selectOption('custom');
    await page.locator('#chat-context-window').fill('64000'); await page.locator('#chat-context-window').dispatchEvent('change');
    assert.deepEqual((await send('Custom settings')).options, { reasoning_effort: 'low', thinking_budget: 2048, context_window: 64000 });
    assert.match(await page.locator('#chat-context-status').innerText(), /64,000.*51,000.*已裁剪/u);
    const customThread = await page.locator('#open-chat-history').getAttribute('data-chat-session-id');
    await page.locator('#new-chat-session').click();
    assert.equal(await page.locator('#chat-reasoning-effort').inputValue(), 'inherit');
    await page.locator('#chat-reasoning-effort').selectOption('auto');
    await page.locator('#chat-thinking-mode').selectOption('auto');
    await page.locator('#chat-context-mode').selectOption('auto');
    useStream = false;
    assert.deepEqual((await send('Explicit auto')).options, { reasoning_effort: 'auto', thinking_budget: 0, context_window: 0 });
    assert.doesNotMatch(await page.locator('#chat-context-status').innerText(), /已裁剪/u);
    await page.locator('#open-chat-history').click();
    await page.locator(`#chat-history-list [data-chat-session-id="${customThread}"]`).click();
    assert.equal(await page.locator('#chat-reasoning-effort').inputValue(), 'low');
    assert.equal(await page.locator('#chat-thinking-budget').inputValue(), '2048');
    assert.equal(await page.evaluate(({ id: jobId, sessionId }) => JSON.parse(localStorage.getItem(`my-scholar-chat-v2:${jobId}`)).sessions.find((session) => session.id === sessionId)?.context?.truncated, { id, sessionId: customThread }), true, 'The active thread context must persist before restart');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator(`#document-tabs .document-tab[data-job-id="${id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#chat-reasoning-effort')?.value === 'low');
    assert.equal(await page.locator('#chat-context-window').inputValue(), '64000');
    await page.locator('#chat-context-status').waitFor({ state: 'visible' });
    assert.match(await page.locator('#chat-context-status').innerText(), /已裁剪/u);
    assert.equal(settings.ai.chat.reasoning_effort, 'high', 'Session overrides must not change the global default');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log('AI controls smoke passed (synthetic AI only)');
  } finally { await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
