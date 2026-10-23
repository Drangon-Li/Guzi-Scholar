'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const integration = '/api/integrations/zotero';
const importedJobId = 'dddddddddddddddd';
const fixtureItems = [
  { key: 'ONE', title: 'A single local PDF', authors: ['Fixture Author'], year: '2026', tags: ['test-tag'], attachments: [{ key: 'PDF1', filename: 'single.pdf' }] },
  { key: 'MULTI', title: 'Multiple PDF choices', authors: ['Fixture Author'], attachments: [{ key: 'PDFA', filename: 'draft.pdf' }, { key: 'PDFB', filename: 'published.pdf' }] },
  { key: 'MISSING', title: 'No local PDF', attachments: [], reason: '附件未下载，请先在 Zotero 中下载 PDF。' },
  { key: 'SPECIAL', title: 'Special pagination article', attachments: [{ key: 'PDF4', filename: 'special.pdf' }] },
];
const results = [
  { item_key: 'ONE', attachment_key: 'PDF1', title: fixtureItems[0].title, status: 'imported', job_id: importedJobId, notes_count: 2, annotations_count: 3, pending: true },
  { item_key: 'MULTI', attachment_key: 'PDFB', title: fixtureItems[1].title, status: 'existing', job_id: importedJobId, annotations_count: 2, unanchored_count: 1 },
  { item_key: 'SPECIAL', attachment_key: 'PDF4', title: fixtureItems[3].title, status: 'failed', error: '模拟：文件不可读' },
];
(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    const requests = [];
    const unexpected = [];
    let statusAttempts = 0;
    let progressReads = 0;
    let jobsReads = 0;
    let copied = false;
    let body = null;
    let holdItems = false, releaseItems = null, markHeldRead = null;
    let mode = 'normal';
    const bulkBodies = [];
    const bulkItems = Array.from({ length: 205 }, (_, index) => ({ key: `BULK${index}`, title: `Bulk article ${index}`, attachments: [{ key: `BULKPDF${index}`, filename: `${index}.pdf` }] }));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      const method = request.method();
      let payload = {};
      if (pathname.startsWith(integration)) requests.push({ pathname, method, query: Object.fromEntries(url.searchParams) });
      if (pathname === `${integration}/status`) {
        statusAttempts += 1;
        payload = statusAttempts === 1 ? { available: false, error: '模拟：Zotero 未启动' } : { available: true, libraries: [{ id: 'user:0', name: '我的文献库' }, { id: 'group:7', name: '研究组库' }] };
      } else if (pathname === `${integration}/collections`) payload = { collections: [{ key: 'PARENT', name: '研究', parent_key: null }, { key: 'CHILD', name: '子分类', parent_key: 'PARENT' }] };
      else if (pathname === `${integration}/items`) {
        if (holdItems) {
          holdItems = false;
          markHeldRead();
          await new Promise((resolve) => { releaseItems = resolve; });
        }
        if (url.searchParams.get('q') === 'error') { await route.fulfill({ status: 500, json: { error: '模拟查询失败' } }); return; }
        const start = Number(url.searchParams.get('start'));
        if (url.searchParams.get('q') === 'bulk') {
          await route.fulfill({ json: { items: bulkItems.slice(start, start + 25), total: bulkItems.length, start, next_start: start + 25 < bulkItems.length ? start + 25 : null } });
          return;
        }
        const items = url.searchParams.get('library') === 'group:7' ? [fixtureItems[0]] : url.searchParams.get('collection') === 'CHILD' ? [fixtureItems[1]] : url.searchParams.get('q') ? [fixtureItems[3]] : fixtureItems.slice(start, start + 3);
        const filtered = Boolean(url.searchParams.get('q') || url.searchParams.get('collection') || url.searchParams.get('library') === 'group:7');
        payload = { items, total: filtered ? items.length : fixtureItems.length, start, next_start: !filtered && start === 0 ? 3 : null };
      } else if (pathname === `${integration}/imports` && method === 'POST') {
        body = request.postDataJSON();
        if (mode.startsWith('bulk')) {
          bulkBodies.push(body);
          if (mode === 'bulk-fail' && bulkBodies.length === 2) {
            await route.fulfill({ status: 500, json: { error: '模拟后续批次提交失败' } });
            return;
          }
          await route.fulfill({ json: { import: { id: `bulk-${bulkBodies.length}`, status: 'running', total: body.items.length, completed: 0, results: [] } } });
          return;
        }
        payload = { import: { id: 'synthetic-batch', status: 'running', total: 3, completed: 0, results: [] } };
      } else if (pathname.startsWith(`${integration}/imports/bulk-`)) {
        const index = Number(pathname.split('bulk-')[1]) - 1;
        const items = bulkBodies[index].items;
        payload = { import: { id: `bulk-${index + 1}`, status: 'completed', total: items.length, completed: items.length, results: items.map((item) => ({ ...item, status: 'imported', pending: false })) } };
      } else if (pathname === `${integration}/imports/synthetic-batch`) {
        progressReads += 1;
        if (progressReads === 2) { await route.fulfill({ status: 500, json: { error: '模拟进度连接中断' } }); return; }
        copied = progressReads > 2;
        payload = { import: { id: 'synthetic-batch', status: copied ? 'completed' : 'running', total: 3, completed: copied ? 3 : 1, results: copied ? progressReads > 3 ? results.map((result, index) => index === 0 ? { ...result, pending: false, unanchored_count: 2, warnings: ['解析后保留了无法定位的标注'] } : result) : results : [results[0]] } };
      } else if (pathname === '/api/jobs') {
        jobsReads += 1;
        payload = { jobs: copied ? [{ job_id: importedJobId, source_filename: 'Imported Zotero Synthetic.pdf', status: 'queued', created_at: '2026-10-22T00:00:00Z', links: {}, manifest: { counts: {} } }] : [] };
      } else if (pathname === '/api/plugins' && route.request().method() === 'GET') payload = { plugins: [], drafts: [], previews: [] };
        else if (pathname === '/api/library') payload = { library: { folders: [], properties: [], views: [], items: copied ? { [importedJobId]: { values: { importance: 0 }, folder_ids: [], metadata: { fields: { title: 'Imported Zotero Synthetic' }, status: 'complete' } } } : {}, display: { columns: [{ id: 'name', visible: true, order: 0 }] } } };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { chat: { enabled: false }, translation: { enabled: false } } } };
      else if (pathname === '/api/settings') payload = { ai: {}, metadata: { auto_retrieve: false } };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname === '/api/parsing/providers') payload = { providers: [] };
      else unexpected.push(`${method} ${pathname}`);
      await route.fulfill({ json: payload });
    });
    const item = (key) => page.locator(`[data-zotero-item="${key}"]`);
    const selectItem = (key) => page.locator(`[data-zotero-select="${key}"]`);
    async function waitItems() { await page.waitForFunction(() => document.querySelector('#zotero-items').getAttribute('aria-busy') === 'false'); }
    async function search(text) { await page.locator('#zotero-search').fill(text); await page.locator('#zotero-search-button').click(); await waitItems(); }
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    assert.equal(requests.length, 0, 'Application startup must not read a real Zotero library');
    await page.locator('#import-zotero-button').click();
    await page.locator('#zotero-import-dialog[open]').waitFor();
    assert.equal(requests.length, 0, 'Opening the dialog must not connect before the user clicks Connect');
    await page.locator('#zotero-connect').click();
    await page.waitForFunction(() => document.querySelector('#zotero-status').textContent.includes('连接失败'));
    assert.match(await page.locator('#zotero-status').innerText(), /Zotero 未启动/u);
    await page.locator('#zotero-connect').click();
    await item('ONE').waitFor(); await waitItems();
    assert.equal(await selectItem('MISSING').isDisabled(), true);
    assert.match(await item('MISSING').innerText(), /附件未下载/u);
    assert.equal(await selectItem('MULTI').isDisabled(), true, 'Multiple PDFs require an explicit choice');
    await page.locator('[data-zotero-attachment="MULTI"]').selectOption('PDFB');
    await selectItem('ONE').check();
    const heldRead = new Promise((resolve) => { markHeldRead = resolve; });
    holdItems = true;
    await page.locator('#zotero-select-all').click();
    await heldRead;
    await page.locator('#zotero-cancel-select-all').click();
    releaseItems();
    assert.match(await page.locator('#zotero-selection-progress').innerText(), /已取消全选/u);
    assert.match(await page.locator('#zotero-selection-count').innerText(), /已选 1 篇/u);
    await page.locator('#zotero-select-all').click();
    await page.waitForFunction(() => document.querySelector('#zotero-selection-progress').textContent.includes('全选完成'));
    assert.match(await page.locator('#zotero-selection-count').innerText(), /已选 3 篇/u);
    assert.match(await page.locator('#zotero-selection-progress').innerText(), /无 PDF 跳过 1 篇/u);
    assert.ok(requests.some((request) => request.pathname.endsWith('/items') && request.query.start === '3'), 'Select all must read later pages');
    await page.locator('#zotero-clear-selection').click();
    await selectItem('MULTI').check();
    await selectItem('ONE').check();
    await page.locator('#zotero-next').click(); await item('SPECIAL').waitFor(); await waitItems();
    await selectItem('SPECIAL').check();
    await page.locator('#zotero-prev').click(); await item('ONE').waitFor(); await waitItems();
    assert.equal(await selectItem('MULTI').isChecked(), true);
    assert.equal(await page.locator('[data-zotero-attachment="MULTI"]').inputValue(), 'PDFB');
    await search('Special');
    assert.equal(await selectItem('SPECIAL').isChecked(), true);
    assert.match(await page.locator('#zotero-selection-count').innerText(), /已选 3 篇/u);
    await page.locator('#zotero-library').selectOption('group:7'); await waitItems();
    assert.match(await page.locator('#zotero-selection-count').innerText(), /已选 0 篇/u);
    await selectItem('ONE').check();
    await page.locator('#zotero-library').selectOption('user:0'); await waitItems();
    assert.equal(await selectItem('ONE').isChecked(), false, 'Library changes must not mix personal and group selections');
    assert.match(await page.locator('#zotero-collection option[value="CHILD"]').innerText(), /研究 \/ 子分类/u);
    await page.locator('#zotero-collection').selectOption('CHILD'); await waitItems();
    assert.equal(await item('ONE').count(), 0);
    await page.locator('[data-zotero-attachment="MULTI"]').selectOption('PDFB'); await selectItem('MULTI').check();
    await page.locator('#zotero-collection').selectOption(''); await waitItems();
    await selectItem('ONE').check();
    await page.locator('#zotero-next').click(); await waitItems(); await selectItem('SPECIAL').check();
    await search('error');
    assert.match(await page.locator('#zotero-status').innerText(), /模拟查询失败/u);
    await search('');
    assert.equal(await selectItem('ONE').isChecked(), true, 'Failed searches must not discard selections');
    assert.equal(await selectItem('MULTI').isChecked(), true);
    const beforeRefresh = jobsReads;
    await page.locator('#zotero-import-selected').click();
    await page.waitForFunction(() => document.querySelector('#zotero-batch-summary').textContent.includes('1/3'));
    assert.match(await page.locator('#zotero-results').innerText(), /正文正在解析/u);
    assert.deepEqual(body.items.slice().sort((a, b) => a.item_key.localeCompare(b.item_key)), [{ item_key: 'MULTI', attachment_key: 'PDFB' }, { item_key: 'ONE', attachment_key: 'PDF1' }, { item_key: 'SPECIAL', attachment_key: 'PDF4' }]);
    assert.equal(body.library, 'user:0');
    assert.equal(Object.hasOwn(body, 'folder_id'), false);
    await page.locator('#zotero-close').click();
    await page.locator('#import-zotero-button').click();
    assert.equal(statusAttempts, 2, 'Reopening progress must not reconnect to Zotero');
    await page.locator('#zotero-retry-progress').waitFor({ state: 'visible' });
    assert.match(await page.locator('#zotero-status').innerText(), /不会重复提交导入/u);
    await page.locator('#zotero-retry-progress').click();
    await page.waitForFunction(() => document.querySelector('#zotero-batch-summary').textContent.includes('复制结束'));
    await page.locator('#zotero-result-dialog[open]').waitFor();
    assert.match(await page.locator('#zotero-result-summary').innerText(), /新增 1 篇.*已有 1 篇.*失败 1 篇/u);
    assert.match(await page.locator('#zotero-result-explanation').innerText(), /正文仍在解析/u);
    assert.match(await page.locator('#zotero-batch-summary').innerText(), /失败 1 篇.*正文仍在解析/u);
    assert.match(await page.locator('#zotero-results').innerText(), /保留笔记与页码/u);
    assert.match(await page.locator('#zotero-results').innerText(), /文件不可读/u);
    assert.equal(requests.filter((request) => request.method === 'POST').length, 1, 'Progress retries must not duplicate import creation');
    assert.ok(jobsReads > beforeRefresh, 'Copy completion must refresh the local library');
    await page.waitForFunction(() => document.querySelector('#zotero-results').textContent.includes('解析后保留了无法定位的标注'));
    assert.match(await page.locator('#zotero-results').innerText(), /2 条标注未能唯一定位/u);
    assert.doesNotMatch(await page.locator('#zotero-batch-summary').innerText(), /仍在解析/u);
    await page.locator('#zotero-continue-import').click();
    assert.equal(await page.locator('#zotero-import-dialog').evaluate((dialog) => dialog.open), true);
    await page.locator('#zotero-close').click();
    await page.locator(`#library-view .library-row[data-job-id="${importedJobId}"]`).waitFor();
    await page.locator('[data-view="settings-view"]').click();
    await page.locator('.settings-navigation a[href="#settings-metadata"]').click();
    await page.locator('#setting-import-zotero').click();
    await page.locator('#zotero-import-dialog[open]').waitFor();
    assert.equal(statusAttempts, 2, 'The settings entry must reuse the same dialog without automatic reads');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#zotero-import-dialog').evaluate((dialog) => dialog.getBoundingClientRect().width <= innerWidth), true);
    await page.setViewportSize({ width: 1450, height: 940 });
    await page.locator('#zotero-clear-selection').click();
    mode = 'bulk';
    await search('bulk');
    await page.locator('#zotero-select-all').click();
    await page.waitForFunction(() => document.querySelector('#zotero-selection-progress').textContent.includes('全选完成'));
    assert.match(await page.locator('#zotero-selection-count').innerText(), /已选 205 篇/u);
    await page.locator('#zotero-import-selected').click();
    await page.locator('#zotero-result-dialog[open]').waitFor();
    assert.deepEqual(bulkBodies.map((batch) => batch.items.length), [100, 100, 5]);
    assert.match(await page.locator('#zotero-result-summary').innerText(), /新增 205 篇/u);
    assert.equal(await page.locator('#zotero-result-details li').count(), 205);
    await page.locator('#zotero-finish-import').click();
    assert.equal(await page.locator('#zotero-import-dialog').evaluate((dialog) => dialog.open), false);
    assert.equal(await page.locator('#zotero-result-dialog').evaluate((dialog) => dialog.open), false);
    await page.locator('#setting-import-zotero').click();
    await page.locator('#zotero-select-all').click();
    await page.waitForFunction(() => document.querySelector('#zotero-selection-progress').textContent.includes('全选完成'));
    bulkBodies.length = 0;
    mode = 'bulk-fail';
    await page.locator('#zotero-import-selected').click();
    await page.locator('#zotero-result-dialog[open]').waitFor();
    assert.deepEqual(bulkBodies.map((batch) => batch.items.length), [100, 100], 'A failed submission must stop the remaining queue');
    assert.match(await page.locator('#zotero-result-summary').innerText(), /批次已停止.*新增 100 篇.*跳过 105 篇/u);
    assert.equal(await page.locator('#zotero-result-details li').count(), 205);
    assert.match(await page.locator('#zotero-selection-count').innerText(), /已选 105 篇/u);
    await page.locator('#zotero-finish-import').click();
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log('Zotero import smoke passed (all Zotero requests mocked)');
  } finally { await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
