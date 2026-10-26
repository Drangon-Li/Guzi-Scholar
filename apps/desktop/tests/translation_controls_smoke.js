'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const ids = ['dddddddddddddddd', 'eeeeeeeeeeeeeeee', 'ffffffffffffffff'];
const continuationId = ids[2];
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
const jobs = ids.map((id, index) => ({ job_id: id, source_filename: `Display fixture ${index + 1}.pdf`, status: 'completed', created_at: '2026-10-22T00:00:00Z', links: { html: `/api/jobs/${id}/document.html` }, manifest: { counts: id === continuationId ? { pages: 3, images: 7 } : { pages: 1, images: 1 } } }));
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
const continuationTexts = {
  'same-start': 'This paragraph explains why the method can',
  'same-middle': 'preserve the original layout and',
  'same-end': 'keep the translated paragraph complete.',
  'page-start': 'The cross-page paragraph keeps its original',
  'page-end': 'meaning even when a large illustration starts the next page.',
  'trailing-start': 'A trailing illustration should not separate the',
  'trailing-end': 'rest of the paragraph from its translated beginning.',
};
const diagram = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="50"%3E%3Crect width="80" height="50" fill="tan"/%3E%3C/svg%3E';
const continuationParagraph = (id, page, box, text = continuationTexts[id]) => `<p data-block-id="${id}" data-page="${page}" data-bbox='${JSON.stringify(box)}'>${text}</p>`;
const continuationFigure = (id, page, box) => `<figure class="pdf-figure" data-block-id="${id}" data-page="${page}" data-bbox='${JSON.stringify(box)}'><img alt="${id}" src='${diagram}'><figcaption>Figure ${id}. Synthetic diagram.</figcaption></figure>`;
const continuationHTML = `<!doctype html><html><head><style>.reader-content{max-width:720px;margin:auto}figure img{width:160px;height:100px}</style></head><body><main class="reader-content">
<section class="pdf-page" data-page="1"><h1 class="paper-title" data-block-id="title">${texts.title}</h1><p data-block-id="ready">${texts.ready}</p><h2>Interrupted paragraph</h2>
${continuationParagraph('same-start', 1, [.1, .2, .9, .3])}
${continuationFigure('same-figure-1', 1, [.1, .32, .9, .42])}
${continuationParagraph('same-middle', 1, [.1, .44, .9, .5])}
${continuationFigure('same-figure-2', 1, [.1, .52, .9, .64])}
${continuationParagraph('same-end', 1, [.1, .66, .9, .74])}
<h2>Page-leading illustration</h2>${continuationParagraph('page-start', 1, [.1, .88, .9, .95])}</section>
<section class="pdf-page" data-page="2">${continuationFigure('leading-figure', 2, [.1, .05, .9, .35])}
${continuationParagraph('page-end', 2, [.1, .37, .9, .46])}
<h2>Page-trailing illustration</h2>${continuationParagraph('trailing-start', 2, [.1, .56, .9, .65])}
${continuationFigure('trailing-figure', 2, [.1, .67, .9, .92])}</section>
<section class="pdf-page" data-page="3">${continuationParagraph('trailing-end', 3, [.1, .06, .9, .15])}
<h2>Separate paragraphs</h2>${continuationParagraph('complete', 3, [.1, .2, .9, .25], 'This sentence is already complete.')}
${continuationFigure('separate-figure', 3, [.1, .27, .9, .35])}
${continuationParagraph('separate', 3, [.1, .37, .9, .42], 'another paragraph must remain independent.')}
<h2>New section boundary</h2>${continuationParagraph('before-heading', 3, [.1, .46, .9, .51], 'This fragment must not cross')}
${continuationFigure('heading-figure', 3, [.1, .53, .9, .61])}<h2>A new section</h2>
${continuationParagraph('after-heading', 3, [.1, .63, .9, .68], 'the heading between these independent paragraphs.')}
<h2>References</h2>${continuationParagraph('reference-start', 3, [.1, .7, .9, .74], 'reference content must stay')}
${continuationFigure('reference-figure', 3, [.1, .76, .9, .84])}
${continuationParagraph('reference-end', 3, [.1, .86, .9, .9], 'separate even if it resembles a continuation.')}</section></main></body></html>`;
records.get(continuationId).push({ block_id: 'same-start', source_text: continuationTexts['same-start'], text: '旧的半段译文', profile_id: profile, target_language: '中文' });
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
      else if (pathname === '/api/plugins' && route.request().method() === 'GET') payload = { plugins: [], drafts: [], previews: [] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { translation: { enabled: true, configured: true, profile_id: profile, target_language: '中文' }, chat: { enabled: false, configured: false } } } };
      else if (pathname === '/api/settings') payload = { metadata: { auto_retrieve: false }, ai: { translation: { provider: 'openai-compatible', model: 'synthetic', enabled: true }, chat: { enabled: false } } };
      else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[pathname.split('/')[4]] };
      else if (pathname.endsWith('/document.html')) { await route.fulfill({ contentType: 'text/html', body: jobId === continuationId ? continuationHTML : documentHTML }); return; }
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
        const translated = (text) => jobId === continuationId ? `连贯译文：${text}` : `新译文：${body.block_id}`;
        const segments = (body.segments || []).map((segment) => ({ id: segment.id, text: translated(segment.text) }));
        const result = { ...body, text: segments.length ? segments.map((segment) => segment.text).join(' ') : translated(body.text),
          ...(segments.length ? { segments, source_segments: body.segments } : {}), profile_id: profile };
        records.set(jobId, [...records.get(jobId).filter((record) => record.block_id !== result.block_id), result]);
        payload = { result };
      } else if (pathname.endsWith('/translations')) payload = { translations: records.get(jobId) || [] };
      else if (pathname.endsWith('/annotations')) payload = { annotations: jobId === continuationId ? [{ id: 'saved-continuation', kind: 'highlight', block_id: 'same-end', page: 1, start: 9, end: 29, quote: 'translated paragraph', surface: 'paper', render_generation: 'base' }] : [] };
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
    async function hoverSource(blockId = 'full') {
      const paragraph = frame.locator(`p[data-block-id="${blockId}"]`);
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
    const tooltip = () => page.locator('#selection-popover:not([hidden]):not(.is-closing)');
    await hoverSource('ready');
    await tooltip().filter({ hasText: '缓存译文：ready' }).waitFor({ state: 'visible' });
    assert.equal(sentenceRequests().length, 0, 'Hovering a cached paragraph must reuse its displayed translation');
    await page.mouse.move(0, 0);
    await tooltip().waitFor({ state: 'detached' });
    await hoverSource();
    await tooltip().filter({ hasText: '正在翻译当前句' }).waitFor({ state: 'visible' });
    assert.equal(sentenceRequests().length, 1);
    await toggleHover();
    await tooltip().waitFor({ state: 'detached' });
    const sentenceResponse = page.waitForResponse((response) => response.url().endsWith('/translate') && !response.request().postDataJSON().block_id);
    releaseSentence(); await (await sentenceResponse).finished();
    await hoverSource();
    await page.waitForTimeout(650);
    assert.equal(sentenceRequests().length, 1, 'Disabled hover must not request a sentence');
    assert.equal(await tooltip().count(), 1, 'Disabling automatic translation keeps the sentence toolbar available');
    assert(await tooltip().locator('.selection-actions button').count() > 0, 'The sentence toolbar retains its actions');
    assert.equal(await tooltip().locator('#selection-translation-result').isVisible(), false, 'A late sentence response must not restore translation after disabling hover');
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
    const fullRunStart = requests.length;
    await page.locator('#full-translate-button').click();
    await frame.locator('.my-scholar-translation[data-for="full"]:not(.is-pending):not(.is-error)').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#full-translate-button').disabled && document.querySelector('#translation-progress')?.hidden);
    const fullRunRequests = requests.slice(fullRunStart);
    assert.deepEqual(fullRunRequests.map((request) => request.block_id).sort(), Object.keys(texts).sort(), 'An explicit ordinary full run must request every eligible block exactly once, including existing translations');
    assert(fullRunRequests.every((request) => request.refresh === true), 'Every explicitly requested full-run block must bypass its existing cache');
    await mode('bilingual');
    await source().waitFor({ state: 'visible' }); await ready().waitFor({ state: 'visible' });
    assert.equal(await frame.locator('p[data-block-id="missing"]').textContent().then((text) => text.startsWith(texts.missing)), true);

    frame = await open(continuationId);
    const joined = ['same-start', 'same-middle', 'same-end'].map((id) => continuationTexts[id]).join(' ');
    const sourceText = await frame.locator('p[data-block-id="same-start"]').evaluate((node) => {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('button, .annotation-note-popover').forEach((child) => child.remove());
      return clone.textContent;
    });
    assert.equal(sourceText, joined, 'A paragraph interrupted by multiple figures must remain one logical source');
    for (const id of ['same-middle', 'same-end', 'page-end', 'trailing-end']) assert.equal(await frame.locator(`p[data-block-id="${id}"]`).count(), 0, `${id} must join its original paragraph`);
    assert.equal(await frame.locator('[data-annotation-id="saved-continuation"]').first().textContent(), 'translated paragraph', 'Saved offsets in a removed source fragment must still resolve');
    assert.equal(await frame.locator('.my-scholar-translation[data-for="same-start"]').count(), 0, 'A cached half-paragraph must not be replayed as the complete translation');
    for (const id of ['complete', 'separate', 'before-heading', 'after-heading', 'reference-start', 'reference-end']) assert.equal(await frame.locator(`p[data-block-id="${id}"]`).count(), 1, 'Independent paragraphs and section boundaries must remain separate');
    const expectedContinuationIds = ['title', 'ready', 'same-start', 'page-start', 'trailing-start', 'complete', 'separate', 'after-heading', 'reference-end'];
    expectedContinuationIds.push(...await frame.locator('figure.pdf-figure figcaption[data-translate-block-id]').evaluateAll((captions) => captions.map((caption) => caption.dataset.translateBlockId)));
    const requestStart = requests.length;
    await page.locator('#full-translate-button').click();
    for (const id of ['same-start', 'page-start', 'trailing-start']) await frame.locator(`.my-scholar-translation[data-for="${id}"]:not(.is-pending):not(.is-error)`).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#full-translate-button').disabled && document.querySelector('#translation-progress')?.hidden);
    const continuationRequests = requests.slice(requestStart);
    assert.deepEqual(continuationRequests.map((request) => request.block_id).sort(), expectedContinuationIds.sort(), 'The full run must refresh each complete eligible block once without translating removed fragments, metadata or short excluded paragraphs');
    assert(continuationRequests.every((request) => request.refresh === true), 'Continuation full-run requests must explicitly refresh existing translations');
    assert.equal(continuationRequests.filter((request) => request.block_id === 'same-start').length, 1);
    assert.equal(continuationRequests.find((request) => request.block_id === 'same-start').text, joined);
    assert.equal(continuationRequests.find((request) => request.block_id === 'page-start').text, `${continuationTexts['page-start']} ${continuationTexts['page-end']}`);
    assert.equal(continuationRequests.find((request) => request.block_id === 'trailing-start').text, `${continuationTexts['trailing-start']} ${continuationTexts['trailing-end']}`);
    assert.equal(continuationRequests.some((request) => ['same-middle', 'same-end', 'page-end', 'trailing-end'].includes(request.block_id)), false, 'Fragments must not send separate translation requests');
    const mediaOrder = await frame.locator('body').evaluate((body) => {
      const doc = body.ownerDocument;
      return [['same-start', 'same-figure-1'], ['same-start', 'same-figure-2'], ['page-start', 'leading-figure'], ['trailing-start', 'trailing-figure']].every(([id, figure]) => Boolean(doc.querySelector(`.my-scholar-translation[data-for="${id}"]`).compareDocumentPosition(doc.querySelector(`[data-block-id="${figure}"]`)) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(mediaOrder, true, 'Figures must follow the complete translation instead of interrupting it');
    assert.equal(await frame.locator('figure.pdf-figure img').count(), 7, 'Joining prose must preserve every image');
    assert.deepEqual(await frame.locator('figure.pdf-figure figcaption').allTextContents(), ['same-figure-1', 'same-figure-2', 'leading-figure', 'trailing-figure', 'separate-figure', 'heading-figure', 'reference-figure'].map((id) => `Figure ${id}. Synthetic diagram.`));
    await mode('translation');
    await frame.locator('.my-scholar-translation[data-for="same-start"]').waitFor({ state: 'visible' });
    assert.equal(await frame.locator('p[data-block-id="same-start"] .reader-source-sentence').isVisible(), false);
    assert.equal(await frame.locator('.my-scholar-translation[data-for="same-start"] .translation-text').textContent(), `连贯译文：${joined}`);
    await mode('original');
    assert.equal(await frame.locator('p[data-block-id="same-start"]').isVisible(), true);
    assert.equal(await frame.locator('.my-scholar-translation[data-for="same-start"]').isVisible(), false);
    const requestsBeforeReload = requests.length;
    await page.reload({ waitUntil: 'networkidle' });
    frame = await open(continuationId);
    assert.equal(await frame.locator('.my-scholar-translation[data-for="same-start"] .translation-text').textContent(), `连贯译文：${joined}`);
    assert.equal(await frame.locator('[data-annotation-id="saved-continuation"]').first().textContent(), 'translated paragraph');
    assert.equal(requests.length, requestsBeforeReload, 'Reopening the reader must reuse the complete cached translation');
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log('translation controls smoke passed (synthetic translations only)');
  } finally { releaseFailure?.(); releaseSentence?.(); await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
