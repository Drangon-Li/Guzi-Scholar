'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2];
if (!baseURL) throw new Error('Run through run_ui_tests.js --only=annotation-hover');
const ids = ['cccccccccccccccc', 'bbbbbbbbbbbbbbbb'];
const texts = {
  first: 'The first annotated sentence explains the research method and its evaluation protocol. The remaining unmarked sentence discusses limitations.',
  second: 'The second annotated sentence describes an independent result with a different personal note, including the separate evaluation dataset, the measurements collected across repeated trials, the practical interpretation of the observed differences, and the limitations that should guide any comparison with the research method discussed in the preceding paragraph.',
  empty: 'This highlighted sentence has no personal note and should still offer a translation.',
  nested: 'This outer annotation includes an overlapping inner highlight and a personal note.',
  delayed: 'This sentence waits for a delayed translation response while the pointer moves to a note.',
};
const jobs = ids.map((job_id, index) => ({ job_id, source_filename: `Hover fixture ${index + 1}.pdf`, status: 'completed', created_at: '2026-10-22T00:00:00Z', links: { html: `/api/jobs/${job_id}/document.html` }, manifest: { counts: { pages: 1 } } }));
const library = { folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] }, items: Object.fromEntries(ids.map((id) => [id, { folder_ids: [], values: {}, metadata: { fields: {}, status: 'complete' } }])) };
function annotation(id, block, quote, note, kind = 'underline') {
  return { id, block_id: block, quote, note, kind, source: 'manual', color: '#ff6666', page: '1', start: texts[block].indexOf(quote), end: texts[block].indexOf(quote) + quote.length, surface: 'paper', render_generation: 'base' };
}
const annotations = [
  annotation('first-note', 'first', texts.first.split('. ')[0] + '.', '第一条：研究方法笔记。'),
  annotation('second-note', 'second', texts.second, '第二条：独立结果笔记。', 'highlight'),
  annotation('empty-note', 'empty', texts.empty, '   ', 'highlight'),
  annotation('outer-note', 'nested', texts.nested, '外层笔记不应被内部空标记遮蔽。'),
  annotation('inner-empty', 'nested', 'overlapping inner highlight', '', 'highlight'),
];
const html = `<!doctype html><html><head><style>
body { margin:0; } .reader-content { max-width:620px; margin:30px auto 300px; }
.reader-content, .reader-content * { -webkit-user-select:text; user-select:text; }
p { font-size:20px; line-height:1.65; margin:24px 0; }
</style></head><body><main class="reader-content"><section class="pdf-page" data-page="1">
<h1 class="paper-title">Note hover interactions</h1>
${Object.entries(texts).map(([id, text]) => `<p data-block-id="${id}" data-page="1">${text}</p>`).join('')}
</section></main></body></html>`;

(async () => {
  const session = await launchManagedChromium();
  let releaseDelayed;
  const delayed = new Promise((resolve) => { releaseDelayed = resolve; });
  let gateFullTranslation = false;
  const fullTranslationWaiters = new Map();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(12000);
    const errors = []; const requests = []; const unexpected = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const request = route.request(); const pathname = new URL(request.url()).pathname;
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs };
      else if (pathname === '/api/plugins' && route.request().method() === 'GET') payload = { plugins: [], drafts: [], previews: [] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { translation: { enabled: true, configured: true, profile_id: 'hover-fixture', target_language: 'zh' }, chat: { enabled: false } } } };
      else if (pathname === '/api/settings') payload = { metadata: { auto_retrieve: false }, ai: { translation: { provider: 'openai-compatible', model: 'synthetic', enabled: true }, chat: { enabled: false } } };
      else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[pathname.split('/')[4]] };
      else if (pathname.endsWith('/document.html')) { await route.fulfill({ contentType: 'text/html', body: html }); return; }
      else if (pathname.endsWith('/translate')) {
        const body = request.postDataJSON(); requests.push(body);
        if (!body.block_id && body.text === texts.delayed) await delayed;
        if (body.block_id && gateFullTranslation) await new Promise((resolve) => fullTranslationWaiters.set(body.block_id, resolve));
        const text = !body.block_id && body.text === texts.delayed ? '过期句译不应出现在另一句的卡片。' : '这是模拟句译结果。';
        payload = { result: { ...body, text, ...(body.segments ? { segments: body.segments.map(({ id }) => ({ id, text })) } : {}), profile_id: 'hover-fixture' } };
      } else if (pathname.endsWith('/translations')) payload = { translations: [] };
      else if (pathname.endsWith('/annotations')) payload = { annotations: pathname.includes(ids[0]) ? annotations : [] };
      else if (pathname.endsWith('/media-layout')) payload = { media_layout: { version: 1, items: {} } };
      else if (pathname.endsWith('/notes')) payload = { markdown: '' };
      else if (pathname.endsWith('/auto-highlights')) payload = { result: { status: 'mock', highlights: [] } };
      else if (jobs.some((job) => pathname === `/api/jobs/${job.job_id}`)) payload = jobs.find((job) => job.job_id === pathname.split('/')[3]);
      else unexpected.push(`${request.method()} ${pathname}`);
      await route.fulfill({ json: payload });
    });
    async function open(id) {
      await page.locator('[data-view="library-view"]').click();
      await page.locator(`#library-view .library-row[data-job-id="${id}"]`).dblclick();
      await page.frameLocator('#html-preview').locator('[data-block-id="first"]').waitFor();
      await page.locator('#reader-view.active-view:not(.is-document-loading)').waitFor();
      await page.frameLocator('#html-preview').locator('body').evaluate((node) => node.ownerDocument.fonts.ready);
      return page.frameLocator('#html-preview');
    }
    async function textPoint(locator, needle = '') {
      await locator.scrollIntoViewIfNeeded();
      const result = await locator.evaluate((node, needle) => {
        const doc = node.ownerDocument;
        const iframe = doc.defaultView.frameElement;
        const iframeRect = iframe.getBoundingClientRect();
        const describe = (element) => element ? { tag: element.tagName, id: element.id, className: element.getAttribute('class'), rect: element.getBoundingClientRect().toJSON() } : null;
        const blockers = new Map();
        const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          if (!text.textContent.trim() || text.parentElement.closest('button')) continue;
          const start = needle ? text.textContent.indexOf(needle) : 0;
          if (start < 0) continue;
          for (let offset = start; offset < text.length; offset += 4) {
            const range = doc.createRange(); range.setStart(text, offset); range.setEnd(text, Math.min(offset + 1, text.length));
            const rect = [...range.getClientRects()].find((item) => item.width && item.height);
            if (!rect) continue;
            const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
            const hit = doc.elementFromPoint(x, y);
            const hostX = iframeRect.left + iframe.clientLeft + x;
            const hostY = iframeRect.top + iframe.clientTop + y;
            const hostHit = iframe.ownerDocument.elementFromPoint(hostX, hostY);
            // A host toolbar can cover text without affecting the iframe's hit test.
            if (node.contains(hit) && hostHit === iframe) return { point: { x: hostX, y: hostY } };
            if (!blockers.has(hostHit)) blockers.set(hostHit, { host: describe(hostHit), frame: describe(hit), count: 0, first: { x: hostX, y: hostY } });
            const blocker = blockers.get(hostHit);
            blocker.count += 1;
            blocker.last = { x: hostX, y: hostY };
          }
        }
        return { point: null, diagnostics: { target: describe(node), iframe: describe(iframe), popover: describe(iframe.ownerDocument.querySelector('#selection-popover:not([hidden])')), blockers: [...blockers.values()] } };
      }, needle);
      assert(result.point, `Fixture text must be visible: ${JSON.stringify(result.diagnostics)}`);
      return result.point;
    }
    async function hover(locator, needle = '') {
      const point = await textPoint(locator, needle);
      await page.mouse.move(point.x, point.y);
      return point;
    }
    async function idle() {
      const box = await page.locator('#html-preview').boundingBox();
      await page.mouse.move(box.x + 8, box.y + 8);
      await page.locator('#selection-popover:not([hidden])').waitFor({ state: 'detached' });
    }
    async function toggleHover() {
      await page.locator('#full-translate-scope-button').click();
      await page.locator('#translation-hover-toggle').click();
      await page.keyboard.press('Escape');
    }
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    let frame = await open(ids[0]);
    const mark = (id) => frame.locator(`mark[data-annotation-id="${id}"]`).first();
    const popup = () => frame.locator('.annotation-note-popover:not(.is-closing)');
    const tooltip = () => page.locator('#selection-popover:not([hidden])');
    const sentences = () => requests.filter((body) => !body.block_id);
    await mark('first-note').waitFor();
    await page.bringToFront();
    const initialBox = await mark('first-note').boundingBox();
    const initialDrag = { x: initialBox.x + 10, y: initialBox.y + 10 };
    await page.mouse.move(initialDrag.x, initialDrag.y);
    await page.mouse.down();
    await page.mouse.move(initialDrag.x + 110, initialDrag.y, { steps: 12 });
    await page.mouse.up();
    assert(await mark('first-note').evaluate((node) => node.ownerDocument.getSelection().toString()), 'The fixture must support native text selection');
    await frame.locator('body').evaluate((node) => node.ownerDocument.getSelection().removeAllRanges());
    await page.keyboard.press('Escape');
    await idle();

    await hover(mark('first-note'));
    await tooltip().filter({ hasText: '第一条：研究方法笔记' }).filter({ hasText: '这是模拟句译结果' }).waitFor();
    assert.equal(sentences().filter((body) => body.text === annotations[0].quote).length, 1,
      `A noted range requests its sentence translation exactly once; sentence requests: ${JSON.stringify(sentences().map((body) => body.text))}`);
    assert(await tooltip().locator('button').count() > 0, 'Sentence hover exposes the complete selection toolbar');
    assert.equal(await frame.locator('body').evaluate((node) => node.ownerDocument.getSelection().toString()), '', 'Hover actions do not require native text selection');
    assert.equal(await popup().count(), 0);
    await hover(mark('second-note'));
    await tooltip().filter({ hasText: '第二条：独立结果笔记' }).filter({ hasText: '这是模拟句译结果' }).waitFor();
    assert.equal(await tooltip().count(), 1, 'Moving to an adjacent note must replace the preview');
    await idle();
    assert.equal(await tooltip().count(), 0, 'Moving to blank space closes a hover preview');

    await hover(mark('inner-empty'));
    await tooltip().filter({ hasText: '外层笔记不应被内部空标记遮蔽' }).filter({ hasText: '这是模拟句译结果' }).waitFor();
    await idle();
    await toggleHover();
    const beforeDisabled = sentences().length;
    await hover(mark('first-note'));
    await tooltip().filter({ hasText: '第一条：研究方法笔记' }).waitFor();
    assert.equal(await tooltip().locator('#selection-translation-result').isVisible(), false);
    assert.equal(sentences().length, beforeDisabled, 'Disabling sentence translation still previews notes without a request');
    await idle();
    await hover(mark('empty-note'));
    await page.waitForTimeout(600);
    assert.equal(await tooltip().count(), 1, 'The toolbar remains available when automatic translation is disabled');
    assert.equal(await tooltip().locator('.selection-hover-note').isVisible(), false);
    assert.equal(await popup().count(), 0, 'Whitespace-only notes must not capture text hover');
    await toggleHover();
    await hover(mark('empty-note'));
    await tooltip().filter({ hasText: '这是模拟句译结果' }).waitFor();
    assert.equal(sentences().length, beforeDisabled + 1, 'An empty-note highlight still supports sentence translation');
    assert.equal(await tooltip().evaluate((node) => getComputedStyle(node).animationName), 'none');
    await idle();

    await hover(frame.locator('[data-block-id="first"]'), 'The remaining');
    await tooltip().filter({ hasText: '这是模拟句译结果' }).waitFor();
    assert.equal(await popup().count(), 0, 'A note must not capture unmarked text in the same paragraph');
    assert.equal(await tooltip().locator('.selection-hover-note').isVisible(), false);
    await idle();
    await hover(frame.locator('[data-block-id="delayed"]'));
    await tooltip().filter({ hasText: '正在翻译当前句' }).waitFor();
    await hover(mark('second-note'));
    await tooltip().filter({ hasText: '第二条：独立结果笔记' }).waitFor();
    const response = page.waitForResponse((result) => result.url().endsWith('/translate') && result.request().postDataJSON().text === texts.delayed);
    releaseDelayed(); await (await response).finished();
    await page.waitForTimeout(150);
    assert.equal(await tooltip().count(), 1, 'A late translation must not replace the current card');
    assert.doesNotMatch(await tooltip().innerText(), /过期句译/u);

    await frame.locator('.annotation-note-trigger[data-annotation-id="second-note"]').click();
    await popup().locator('[data-action="edit"]').click();
    const editor = frame.locator('.annotation-note-editor');
    await editor.fill('未保存的编辑内容');
    const beforeEditHover = sentences().length;
    await hover(mark('first-note'));
    await page.waitForTimeout(600);
    assert.equal(await editor.innerText(), '未保存的编辑内容', 'Hover cannot replace a pinned editor');
    await hover(mark('empty-note'));
    await page.waitForTimeout(600);
    assert.equal(await tooltip().count(), 0, 'Translation cannot cover a pinned editor');
    assert.equal(sentences().length, beforeEditHover);
    await popup().locator('[data-action="close"]').click();
    await idle();

    await page.bringToFront();
    await mark('first-note').scrollIntoViewIfNeeded();
    const dragBox = await mark('first-note').boundingBox();
    const firstPoint = { x: dragBox.x + 10, y: dragBox.y + 10 };
    await page.mouse.move(firstPoint.x, firstPoint.y);
    await page.mouse.down();
    await page.mouse.move(firstPoint.x + 110, firstPoint.y, { steps: 12 });
    await page.waitForTimeout(300);
    assert.equal(await popup().count(), 0, 'Dragging annotated text must not open a note');
    await page.mouse.up();
    await page.locator('#selection-popover:not([hidden])').waitFor();
    await frame.locator('body').evaluate((node) => node.ownerDocument.getSelection().removeAllRanges());
    await page.keyboard.press('Escape');
    await idle();

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await hover(mark('empty-note'));
    await tooltip().filter({ hasText: '这是模拟句译结果' }).waitFor();
    assert.notEqual(await tooltip().evaluate((node) => getComputedStyle(node).animationName), 'none', 'Sentence preview should animate with ordinary motion preferences');
    await page.waitForTimeout(200);
    await idle();
    await hover(mark('first-note'));
    await tooltip().filter({ hasText: '第一条：研究方法笔记' }).waitFor();
    assert.notEqual(await tooltip().evaluate((node) => getComputedStyle(node).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await tooltip().evaluate((node) => getComputedStyle(node).animationName), 'none');
    await frame.locator('.annotation-note-trigger[data-annotation-id="first-note"]').click();
    const pinnedLeft = await popup().evaluate((node) => node.getBoundingClientRect().left);
    await frame.locator('body').evaluate((node) => node.ownerDocument.defaultView.scrollBy(0, 40));
    await page.waitForTimeout(150);
    assert(Math.abs(await popup().evaluate((node) => node.getBoundingClientRect().left) - pinnedLeft) < 2, 'Pinning a text preview must retain its source anchor on scroll');
    await popup().locator('[data-action="close"]').click();
    await idle();

    gateFullTranslation = true;
    await page.locator('#full-translate-button').click();
    await frame.locator('.my-scholar-translation.is-pending').first().waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await hover(mark('first-note'));
    await tooltip().filter({ hasText: '第一条：研究方法笔记' }).filter({ hasText: '这是模拟句译结果' }).waitFor().catch(async (error) => {
      console.error(JSON.stringify(await mark('first-note').evaluate((node) => {
        const doc = node.ownerDocument;
        return { card: doc.defaultView.parent.document.querySelector('#selection-popover:not([hidden])')?.outerHTML, popover: doc.querySelector('.annotation-note-popover')?.outerHTML, selection: doc.getSelection()?.toString(), mark: node.getBoundingClientRect().toJSON(), highlight: [...(doc.defaultView.CSS.highlights.get('my-scholar-sentence-hover') || [])].map((range) => range.toString()), scroll: doc.defaultView.scrollY };
      })));
      await page.screenshot({ path: '/tmp/guzi-annotation-hover-full-run-failure.png' });
      throw error;
    });
    await mark('first-note').evaluate((node) => {
      const doc = node.ownerDocument;
      doc.defaultView.hoverReferences = { annotationId: node.dataset.annotationId, quote: node.textContent, card: doc.defaultView.parent.document.querySelector('#selection-popover:not([hidden])'), sentence: [...doc.defaultView.CSS.highlights.get('my-scholar-sentence-hover')][0].toString() };
      doc.defaultView.hoverLayoutScrolls = 0;
      doc.defaultView.hoverLayoutObserver = new MutationObserver((records) => {
        if (!records.some((record) => [...record.addedNodes].some((item) => item.nodeType === 1 && item.matches('.my-scholar-translation:not(.is-pending):not(.is-error)')))) return;
        doc.defaultView.hoverLayoutScrolls += 1;
        doc.dispatchEvent(new Event('scroll'));
      });
      doc.defaultView.hoverLayoutObserver.observe(doc.querySelector('.reader-content'), { childList: true, subtree: true });
    });
    const [translatedBlock, releaseBlock] = fullTranslationWaiters.entries().next().value;
    fullTranslationWaiters.delete(translatedBlock);
    releaseBlock();
    const completedTranslations = frame.locator(`.my-scholar-translation[data-for="${translatedBlock}"]:not(.is-pending):not(.is-error)`);
    await completedTranslations.first().waitFor();
    assert.equal(await completedTranslations.count(), requests.find((body) => body.block_id === translatedBlock).segments.length, 'Every requested sentence renders a translation');
    assert((await completedTranslations.allTextContents()).every((text) => text.includes('这是模拟句译结果')), 'Every displayed sentence uses the translated fixture response');
    assert.deepEqual(await mark('first-note').evaluate((node) => {
      const doc = node.ownerDocument; const saved = doc.defaultView.hoverReferences;
      return { annotationId: saved.annotationId === node.dataset.annotationId, quote: saved.quote === node.textContent, card: saved.card === doc.defaultView.parent.document.querySelector('#selection-popover:not([hidden])'), sentence: saved.sentence === [...(doc.defaultView.CSS.highlights.get('my-scholar-sentence-hover') || [])][0]?.toString() };
    }), { annotationId: true, quote: true, card: true, sentence: true }, 'An arriving full-document paragraph preserves the card, source annotation and highlighted sentence');
    assert(await frame.locator('body').evaluate((node) => node.ownerDocument.defaultView.hoverLayoutScrolls > 0), 'Translation layout emitted the simulated scroll event');
    await frame.locator('body').evaluate(async (node) => {
      node.ownerDocument.defaultView.hoverLayoutObserver.disconnect();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    });
    await frame.locator('body').evaluate((node) => node.ownerDocument.dispatchEvent(new Event('scroll')));
    await tooltip().waitFor({ state: 'detached' });
    await hover(mark('first-note'));
    await tooltip().filter({ hasText: '第一条：研究方法笔记' }).waitFor();
    await page.mouse.wheel(0, 40);
    await tooltip().waitFor({ state: 'detached' });
    gateFullTranslation = false;
    for (const release of fullTranslationWaiters.values()) release();
    fullTranslationWaiters.clear();
    await page.waitForFunction(() => {
      const panel = document.querySelector('#translation-progress');
      return panel?.hidden && panel.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '100';
    });
    await idle();

    await hover(mark('first-note'));
    frame = await open(ids[1]);
    await page.waitForTimeout(600);
    assert.equal(await popup().count(), 0, 'A delayed hover from the previous document must not reopen');
    assert.equal(await tooltip().count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log('annotation hover smoke passed');
  } finally {
    releaseDelayed();
    for (const release of fullTranslationWaiters.values()) release();
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
