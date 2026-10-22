'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const ids = ['dddddddddddddddd', 'eeeeeeeeeeeeeeee'];
const profile = 'translation-controls-fixture';
const key = 'my-scholar-translation-preferences-v1';
const texts = {
  title: 'Synthetic translation display controls',
  ready: 'The cached paragraph explains the experiment and its reproducible evaluation protocol.',
  missing: 'This untranslated paragraph will fail once and then succeed when the reader retries it.',
  full: 'This remaining paragraph is reserved for the explicitly requested full translation run.',
  list: 'The first list item describes the method. The second item describes the evaluation.',
  caption: 'Figure 1. The synthetic evaluation diagram.',
};
for (let index = 0; index < 18; index += 1) texts[`position-${index}`] = `This is the source paragraph at position ${index} in a tall synthetic article used to check reading location restoration.`;
const jobs = ids.map((id, index) => ({ job_id: id, source_filename: `Display fixture ${index + 1}.pdf`, status: 'completed', created_at: '2026-10-22T00:00:00Z', links: { html: `/api/jobs/${id}/document.html` }, manifest: { counts: { pages: 1, images: 1 } } }));
const library = { folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] }, items: Object.fromEntries(ids.map((id) => [id, { folder_ids: [], values: { reading_status: '未读', importance: 0 }, metadata: { fields: {}, status: 'complete' } }])) };
const records = new Map(ids.map((id) => [id, ['title', 'ready', 'list', 'caption', ...Array.from({ length: 18 }, (_, index) => `position-${index}`)].map((block) => ({ block_id: block, source_text: texts[block], text: `缓存译文：${block}`, profile_id: profile, target_language: '中文' }))]));
const documentHTML = `<!doctype html><html><head><style>
body { margin:0; } .reader-content { max-width:720px; margin:auto; }
.my-scholar-translation[data-for^="position-"] { min-height:160px; }
p[data-block-id^="position-"] { min-height:120px; }
</style></head><body><main class="reader-content"><section class="pdf-page" data-page="1">
<h1 class="paper-title" data-block-id="title" data-page="1">${texts.title}</h1>
<p class="paper-metadata" data-translation-excluded="metadata" data-block-id="author">Author Name, Synthetic University</p>
<h2 data-block-id="section">Methods</h2><p data-block-id="ready">${texts.ready}</p>
<p data-block-id="missing">${texts.missing}</p><p data-block-id="full">${texts.full}</p>
<ul data-block-id="list"><li>The first list item describes the method.</li><li>The second item describes the evaluation.</li></ul>
<div class="pdf-equation" data-block-id="equation">x² + y² = z²</div>
<figure class="pdf-figure" data-block-id="figure"><img alt="Synthetic diagram" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='50'%3E%3Crect width='80' height='50' fill='tan'/%3E%3C/svg%3E"><figcaption data-translate-block-id="caption">${texts.caption}</figcaption></figure>
<table><tbody><tr><td>Original table content</td></tr></tbody></table>
${Array.from({ length: 18 }, (_, index) => `<p data-block-id="position-${index}" data-page="1">${texts[`position-${index}`]}</p>`).join('')}
</section></main></body></html>`;
(async () => {
  const session = await launchManagedChromium();
  let releaseFailure;
  let releaseSentence;
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = []; const requests = []; const unexpected = [];
    let failMissing = true;
    const delayedFailure = new Promise((resolve) => { releaseFailure = resolve; });
    const delayedSentence = new Promise((resolve) => { releaseSentence = resolve; });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const request = route.request(); const pathname = new URL(request.url()).pathname;
      const jobId = pathname.split('/')[3];
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { translation: { enabled: true, configured: true, profile_id: profile, target_language: '中文' }, chat: { enabled: false, configured: false } } } };
      else if (pathname === '/api/settings') payload = { metadata: { auto_retrieve: false }, ai: { translation: { provider: 'openai-compatible', model: 'synthetic', enabled: true }, chat: { enabled: false } } };
      else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[pathname.split('/')[4]] };
      else if (pathname.endsWith('/document.html')) { await route.fulfill({ contentType: 'text/html', body: documentHTML }); return; }
      else if (pathname.endsWith('/translate')) {
        const body = request.postDataJSON(); requests.push(body);
        if (!body.block_id) {
          await delayedSentence;
          await route.fulfill({ json: { result: { ...body, text: '关闭开关后返回的模拟句子译文。', profile_id: profile } } }); return;
        }
        if (body.block_id === 'missing' && failMissing) {
          failMissing = false; await delayedFailure;
          await route.fulfill({ status: 503, json: { error: 'synthetic temporary failure' } }); return;
        }
        const result = { ...body, text: `新译文：${body.block_id}`, profile_id: profile };
        records.set(jobId, [...records.get(jobId).filter((record) => record.block_id !== result.block_id), result]);
        payload = { result };
      } else if (pathname.endsWith('/translations')) payload = { translations: records.get(jobId) || [] };
      else if (pathname.endsWith('/annotations')) payload = { annotations: [] };
      else if (pathname.endsWith('/media-layout')) payload = { media_layout: { version: 1, items: {} } };
      else if (pathname.endsWith('/notes')) payload = { markdown: '' };
      else if (pathname.endsWith('/auto-highlights')) payload = { result: { status: 'mock', highlights: [] } };
      else if (jobs.some((job) => pathname === `/api/jobs/${job.job_id}`)) payload = jobs.find((job) => job.job_id === jobId);
      else unexpected.push(`${request.method()} ${pathname}`);
      await route.fulfill({ json: payload });
    });
    async function menu() { await page.locator('#full-translate-scope-button').click(); await page.locator('#translation-scope-menu').waitFor({ state: 'visible' }); }
    async function mode(value) { await menu(); await page.locator(`[data-translation-display="${value}"]`).click(); }
    async function toggleHover() {
      await menu(); await page.locator('#translation-hover-toggle').click(); await page.keyboard.press('Escape');
    }
    async function hoverSource() {
      const paragraph = frame.locator('p[data-block-id="ready"]');
      await paragraph.scrollIntoViewIfNeeded();
      const box = await paragraph.evaluate((node) => {
        const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          if (!text.textContent.trim() || text.parentElement.closest('button')) continue;
          const range = node.ownerDocument.createRange(); range.setStart(text, 0); range.setEnd(text, Math.min(8, text.length));
          const rect = [...range.getClientRects()].find((item) => item.width > 0 && item.height > 0);
          if (rect) return { x: rect.left + Math.min(4, rect.width / 2), y: rect.top + rect.height / 2 };
        }
        return null;
      });
      assert.ok(box, 'The real mouse hover fixture must have visible source text');
      const iframe = await page.locator('#html-preview').boundingBox();
      await page.mouse.move(iframe.x + box.x, iframe.y + box.y);
    }
    const sentenceRequests = () => requests.filter((request) => !request.block_id);
    const blockRequests = () => requests.filter((request) => request.block_id);
    async function open(id) {
      await page.locator('[data-view="library-view"]').click();
      await page.locator(`#library-view .library-row[data-job-id="${id}"]`).dblclick();
      await page.waitForFunction(() => document.querySelector('#html-preview')?.contentDocument?.querySelector('.my-scholar-translation[data-for="ready"]'));
      return page.frameLocator('#html-preview');
    }
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    let frame = await open(ids[0]);
    const source = () => frame.locator('p[data-block-id="ready"]');
    const ready = () => frame.locator('.my-scholar-translation[data-for="ready"]');
    await source().waitFor({ state: 'visible' }); await ready().waitFor({ state: 'visible' });
    assert.equal(requests.length, 0, 'Cache replay must not send requests');
    await hoverSource();
    const tooltip = () => frame.locator('.reader-sentence-tooltip');
    await tooltip().filter({ hasText: '正在翻译当前句' }).waitFor({ state: 'visible' });
    assert.equal(sentenceRequests().length, 1);
    await toggleHover();
    await tooltip().waitFor({ state: 'detached' });
    const sentenceResponse = page.waitForResponse((response) => response.url().endsWith('/translate') && !response.request().postDataJSON().block_id);
    releaseSentence(); await (await sentenceResponse).finished();
    await hoverSource();
    await page.waitForTimeout(650);
    assert.equal(sentenceRequests().length, 1, 'Disabled hover must not request a sentence');
    assert.equal(await tooltip().count(), 0, 'A late sentence response must not restore the tooltip after disabling hover');
    await toggleHover();
    await hoverSource();
    await tooltip().filter({ hasText: '关闭开关后返回的模拟句子译文' }).waitFor({ state: 'visible' });
    await toggleHover();
    await tooltip().waitFor({ state: 'detached' });
    assert.equal(sentenceRequests().length, 1, 'The exact sentence cache must survive toggling hover');
    await mode('original');
    assert.equal(await ready().isVisible(), false); assert.equal(await source().isVisible(), true);
    await mode('translation');
    assert.equal(await source().isVisible(), false); assert.equal(await ready().isVisible(), true);
    for (const selector of ['h1.paper-title', 'ul[data-block-id="list"]', 'figcaption']) assert.equal(await frame.locator(selector).isVisible(), false);
    for (const selector of ['.paper-metadata', '.pdf-equation', '.pdf-figure img', 'table', 'h2']) assert.equal(await frame.locator(selector).isVisible(), true, `${selector} must remain visible`);
    assert.equal(await frame.locator('p[data-block-id="missing"]').isVisible(), false);
    assert.equal(await frame.locator('[data-translation-placeholder-for="missing"]').innerText(), '待翻译\n翻译本段');
    assert.equal(blockRequests().length, 0, 'Changing display must not start translation');
    await page.keyboard.press('Control+f');
    await page.locator('#reader-search-input').fill('reproducible');
    await page.waitForFunction(() => document.querySelector('#reader-search-count').textContent === '无匹配');
    await mode('bilingual');
    await page.waitForFunction(() => document.querySelector('#reader-search-count').textContent === '1/1');
    await mode('translation');
    await page.waitForFunction(() => document.querySelector('#reader-search-count').textContent === '无匹配');
    await page.keyboard.press('Escape');
    await menu();
    assert.equal(await page.locator('#translation-hover-toggle').getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Escape');
    frame = await open(ids[1]);
    assert.equal(await source().isVisible(), false);
    await menu(); assert.equal(await page.locator('[data-translation-display="translation"]').getAttribute('aria-checked'), 'true'); assert.equal(await page.locator('#translation-hover-toggle').getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Escape');
    const locationSelector = '.my-scholar-translation[data-for="position-12"]';
    await frame.locator(locationSelector).evaluate((node) => {
      const view = node.ownerDocument.defaultView;
      view.scrollTo(0, view.scrollY + node.getBoundingClientRect().top + 10);
    });
    await page.waitForFunction(({ id, storageKey }) => {
      const location = JSON.parse(localStorage.getItem(storageKey) || '{}').locations?.[id];
      return location?.blockId === 'translation-position-12';
    }, { id: ids[1], storageKey: 'my-scholar-reading-locations-v1' });
    const beforeReload = await frame.locator(locationSelector).evaluate((node) => ({ top: node.getBoundingClientRect().top, scroll: node.ownerDocument.defaultView.scrollY }));
    assert.ok(beforeReload.scroll > 1000, 'Position restoration must use a genuinely scrolled document');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator(`#document-tabs .document-tab[data-job-id="${ids[1]}"]`).click();
    frame = page.frameLocator('#html-preview');
    await frame.locator('[data-translation-placeholder-for="missing"]').waitFor({ state: 'visible' });
    await page.waitForFunction((selector) => {
      const doc = document.querySelector('#html-preview')?.contentDocument;
      const target = doc?.querySelector(selector);
      return target && !doc.documentElement.classList.contains('my-scholar-reader-restoring') && Math.abs(target.getBoundingClientRect().top + 10) < 60;
    }, locationSelector);
    assert.equal(await frame.locator('p[data-block-id="position-12"]').isVisible(), false, 'Restoration must locate the visible translation, while preserving the hidden source');
    assert.deepEqual(await page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)), key), { hoverEnabled: false, displayMode: 'translation' });
    await frame.locator('[data-translation-placeholder-for="missing"] button').click();
    await frame.locator('.my-scholar-translation.is-pending[data-for="missing"]').waitFor({ state: 'visible' });
    assert.equal(await frame.locator('p[data-block-id="missing"]').isVisible(), false);
    releaseFailure();
    const retry = frame.locator('.my-scholar-translation.is-error[data-for="missing"] button');
    await retry.waitFor({ state: 'visible' }); await retry.click();
    await frame.locator('.my-scholar-translation[data-for="missing"]:not(.is-pending):not(.is-error)').waitFor({ state: 'visible' });
    assert.equal(blockRequests().length, 2); assert.ok(blockRequests()[1].refresh, 'Failure retry must bypass the failed attempt');
    await page.locator('#full-translate-button').click();
    await frame.locator('.my-scholar-translation[data-for="full"]:not(.is-pending):not(.is-error)').waitFor({ state: 'visible' });
    assert.equal(blockRequests().length, 3, 'Only the explicit full run may request the remaining paragraph');
    await mode('bilingual');
    await source().waitFor({ state: 'visible' }); await ready().waitFor({ state: 'visible' });
    assert.equal(await frame.locator('p[data-block-id="missing"]').textContent().then((text) => text.startsWith(texts.missing)), true);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log('translation controls smoke passed (synthetic translations only)');
  } finally { releaseFailure?.(); releaseSentence?.(); await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
