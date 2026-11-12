'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reportSections = ['why', 'what', 'how', 'results', 'so_what', 'summary', 'idea', 'implementation', 'example', 'experiments'];

function runFixtureCli() {
  assert.equal(process.env.MY_SCHOLAR_API_TOKEN, undefined);
  assert.equal(process.argv[4], 'one literal argument; two words');
  const messages = JSON.parse(fs.readFileSync(0, 'utf8').trimEnd().split('\n').at(-1));
  const input = messages.at(-1).content;
  let payload;
  try { payload = JSON.parse(input); } catch (_) {}
  if (process.argv[3] === 'translation') {
    const translation = (text) => '这是本机翻译。' + (text.match(/__MY_SCHOLAR_MATH_\d+__/gu) || []).join(' ');
    process.stdout.write(payload?.segments
      ? JSON.stringify({ segments: payload.segments.map(({ id, text }) => ({ id, text: translation(text) })) })
      : translation(input));
    return;
  }
  if (payload?.task) {
    const evidence = messages[1].content;
    const blocks = JSON.parse(evidence.slice(evidence.indexOf('\n') + 1));
    const block = blocks.find((item) => item.type === 'paragraph' && item.text.length <= 600);
    assert(block);
    const paragraphs = [{ text: '根据论文原文整理。', kind: 'paper', citations: [{ block_id: block.block_id, quote: block.text }] }];
    process.stdout.write(JSON.stringify({
      title: '本机 CLI 报告', sections: reportSections.map((key) => ({ key, paragraphs })), concepts: [],
    }));
    return;
  }
  process.stdout.write('这是本机文章助手。');
}

async function main() {
  const { launchManagedChromium } = require('./playwright.cjs');
  const baseURL = process.argv[2];
  const token = process.env.MY_SCHOLAR_API_TOKEN;
  const dataRoot = process.env.MY_SCHOLAR_TEST_DATA;
  if (!baseURL || !token || !dataRoot) throw new Error('Use the isolated local CLI UI suite.');
  const headers = { 'X-My-Scholar-Api-Token': token };
  assert.equal((await fetch(baseURL + '/api/settings')).status, 401);
  const httpProfile = { base_url: 'https://synthetic.invalid/v1', model: 'previous-api-model', api_key: 'fixture-only' };
  const seeded = await fetch(baseURL + '/api/settings', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai: { translation: { ...httpProfile, mode: 'qwen-mt' }, chat: httpProfile } }),
  });
  assert(seeded.ok, await seeded.text());

  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', extraHTTPHeaders: headers });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.myScholarDesktop = { platform: 'darwin', state: {
        loadAll: async () => ({ 'my-scholar-onboarding-v2': '{"version":2,"action":"skipped"}' }),
        set: async () => {}, remove: async () => {},
      } };
    });
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('[data-view="settings-view"]').click();
    await page.locator('.settings-navigation a[href="#settings-ai"]').click();

    async function chooseCli(service) {
      await page.locator(`#setting-${service}-cli-kind`).selectOption('custom');
      const argumentsText = [__filename, '--fixture-cli', service, 'one literal argument; two words'].join('\n');
      await page.locator(`#setting-${service}-cli-args`).fill(argumentsText);
      const save = page.waitForResponse((response) => {
        if (!response.url().endsWith('/api/settings') || response.request().method() !== 'POST') return false;
        const submitted = response.request().postDataJSON()?.ai?.[service];
        return submitted?.cli_kind === 'custom' && submitted.cli_path === process.execPath && submitted.cli_args?.[2] === service;
      });
      await page.locator(`#setting-${service}-cli-path`).fill(process.execPath);
      await page.locator(`#setting-${service}-cli-path`).dispatchEvent('change');
      const saved = await save;
      assert(saved.ok(), await saved.text());
      await page.locator('#settings-save-status[data-state="saved"]').waitFor();
      assert(await page.locator(`#setting-${service}-base-url`).isHidden());
    }
    await chooseCli('translation');
    await chooseCli('chat');
    const tested = page.waitForResponse((response) => response.url().endsWith('/api/translation/test') && response.request().method() === 'POST');
    await page.locator('#test-translation-button').click();
    assert.equal((await (await tested).json()).result.ok, true);

    const settings = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf8'));
    assert.equal(settings.ai.translation.api_key, httpProfile.api_key);
    assert.equal(settings.ai.chat.model, httpProfile.model);
    const health = await (await page.request.get(baseURL + '/api/health')).json();
    for (const service of ['translation', 'chat']) {
      assert.equal(health.ai.services[service].cli_kind, 'custom');
      assert.equal(health.ai.services[service].enabled, true);
    }

    const { jobs } = await (await page.request.get(baseURL + '/api/jobs')).json();
    const job = jobs.find((record) => record.source_filename === 'unified-multimodal-alignment.pdf');
    const endpoint = baseURL + '/api/jobs/' + job.job_id;
    async function post(suffix, data) {
      const response = await page.request.post(endpoint + suffix, { data });
      assert(response.ok(), await response.text());
      return response.json();
    }
    const segments = [
      { id: 'one', text: 'The result is __MY_SCHOLAR_MATH_1__.' },
      { id: 'two', text: 'We use a separate benchmark.' },
    ];
    const translationInput = {
      text: segments.map((segment) => segment.text).join(' '),
      target_language: '中文', segments, alignment_version: 'sentence-v1',
      formulas: [{ token: '__MY_SCHOLAR_MATH_1__', tex: 'x=1' }],
    };
    const { result } = await post('/translate', translationInput);
    assert.equal(result.provider_snapshot.cli_kind, 'custom');
    assert.deepEqual(result.segments.map((segment) => segment.id), ['one', 'two']);
    assert.match(result.segments[0].text, /__MY_SCHOLAR_MATH_1__/u);
    assert.equal((await post('/translate', translationInput)).result.cached, true);
    const streamed = await page.request.post(endpoint + '/translate', { data: { text: 'A sentence for streaming.', stream: true } });
    assert.match(await streamed.text(), /这是本机翻译/u);
    assert.equal((await post('/chat', { messages: [{ role: 'user', content: '这篇论文讲了什么？' }] })).result.text, '这是本机文章助手。');
    const { draft } = await post('/report/draft', { expected_revision: 0 });
    assert.equal(draft.title, '本机 CLI 报告');
    assert.equal(draft.sections[0].paragraphs[0].citations.length, 1);

    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#setting-translation-cli-kind').waitFor();
    assert.equal(await page.locator('#setting-translation-cli-path').inputValue(), process.execPath);
    const apiRestored = page.waitForResponse((response) => response.url().endsWith('/api/settings')
      && response.request().method() === 'POST' && response.request().postDataJSON()?.ai?.translation?.cli_kind === '');
    await page.locator('#setting-translation-cli-kind').selectOption('');
    const restored = await apiRestored;
    assert(restored.ok(), await restored.text());
    await page.locator('#setting-translation-base-url').waitFor();
    assert.equal(await page.locator('#setting-translation-base-url').inputValue(), httpProfile.base_url);
    assert.deepEqual(errors, []);
    console.log('Local CLI smoke passed: desktop auth, settings, translation cache and formula alignment, chat, report, reload and API restore.');
  } finally {
    await session.close();
  }
}

if (process.argv[2] === '--fixture-cli') runFixtureCli();
else main().catch((error) => { console.error(error); process.exitCode = 1; });
