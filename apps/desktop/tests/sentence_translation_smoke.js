'use strict';

const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
if (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA) {
  throw new Error('Run with an isolated fixture server and MY_SCHOLAR_TEST_DATA.');
}
const origin = new URL(baseURL).origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) {
  throw new Error('This mock-only suite requires a local fixture server.');
}

const jobId = 'dddddddddddddddd';
const paragraphId = 'block-1-2-paragraph';
const richId = 'block-1-3-paragraph';
const listId = 'block-1-4-list';
const sentences = [
  'First sentence explains the experimental setup.',
  'Middle sentence describes the main principle.',
  'Final sentence states the conclusion.',
];
const sourceText = sentences.join(' ');
const jobs = [{ job_id: jobId, status: 'completed', source_filename: 'Sentence translation fixture.pdf', created_at: '2026-10-26T00:00:00Z', links: { html: `/api/jobs/${jobId}/document.html` }, manifest: { counts: { pages: 1, images: 0, tables: 0 } } }];
const library = { folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] }, items: { [jobId]: { folder_ids: [], values: { reading_status: '未读', importance: 0 }, metadata: { status: 'complete', fields: { title: 'Sentence translation fixture' } } } } };
const documentHTML = `<!doctype html><html><head><style>
body{margin:0}.reader-content{max-width:720px;margin:32px auto;font-size:18px;line-height:1.72}p{margin:20px 0}
</style></head><body><main class="reader-content"><section class="pdf-page" data-page="1">
<h2>Sentence translation fixture</h2>
<p data-block-id="${paragraphId}" data-page="1">${sourceText}</p>
<p data-block-id="${richId}" data-page="1">Inline formula <math alttext="x/y"><mfrac><mi>x</mi><mi>y</mi></mfrac></math> remains atomic. The second sentence preserves citation <sup><a href="#ref-143">143,144</a></sup> and formula <math alttext="10^4"><msup><mn>10</mn><mn>4</mn></msup></math> without splitting its exponent.</p>
<ul data-block-id="${listId}" data-page="1"><li>First list item has two sentences. Its second sentence stays in the same item.</li><li>Second list item keeps its bullet without terminal punctuation</li></ul>
<section class="references"><p id="ref-143">[143] Synthetic reference.</p></section>
</section></main></body></html>`;

(async () => {
  const session = await launchManagedChromium();
  let phase = 'boot';
  const diagnostics = { requests: [], selectionRequests: [], unexpected: [], routeErrors: [] };
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedText = text; } } });
    });
    const errors = [];
    const unexpected = diagnostics.unexpected;
    const requests = diagnostics.requests;
    const historyReads = [];
    const records = [];
    const annotations = [];
    let explicitSelectionActive = false;
    let activeProfile = 'sentence-profile-a';
    let failNextRefresh = false;
    let successfulRevision = 0;
    let settings = {
      metadata: { auto_retrieve: false },
      ai: {
        translation: { provider: 'openai-compatible', mode: 'chat', model: 'fixture-engine-a', base_url: 'http://translation.invalid/v1', api_key_configured: true, source_language: 'auto', target_language: 'zh', enabled: true },
        chat: { provider: 'openai-compatible', enabled: false },
      },
    };
    page.on('pageerror', (error) => errors.push(error.message));
    async function handleRoute(route) {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { await route.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
      const pathname = url.pathname;
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { translation: { enabled: true, configured: true, provider: 'openai-compatible', model: settings.ai.translation.model, profile_id: activeProfile, target_language: 'zh' }, chat: { enabled: false, configured: false } } } };
      else if (pathname === '/api/settings') {
        if (request.method() !== 'GET') {
          const submitted = request.postDataJSON();
          const previousModel = settings.ai.translation.model;
          settings = { ...settings, ...submitted, ai: { ...settings.ai, ...submitted.ai } };
          if (settings.ai.translation.model !== previousModel) activeProfile = 'sentence-profile-b';
          payload = { settings };
        } else payload = settings;
      } else if (pathname === '/api/plugins') payload = { plugins: [], drafts: [], previews: [] };
      else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[jobId] };
      else if (pathname.endsWith('/document.html')) { await route.fulfill({ contentType: 'text/html', body: documentHTML }); return; }
      else if (pathname.endsWith('/translations')) {
        historyReads.push(url.searchParams.get('scope'));
        payload = { translations: url.searchParams.get('scope') === 'all' ? records : records.filter((record) => record.profile_id === activeProfile), profile_id: activeProfile };
      } else if (pathname.endsWith('/translate')) {
        const body = request.postDataJSON();
        requests.push({ ...body, requested_profile: activeProfile, test_phase: phase });
        if (!body.block_id) {
          const expectedSelectionRequest = explicitSelectionActive && phase === 'canonical-selection';
          if (expectedSelectionRequest) diagnostics.selectionRequests.push({ phase, body });
          else unexpected.push({ reason: phase === 'explicit-aligned-hover' ? 'aligned-hover-requested-standalone-translation' : 'unsolicited-standalone-translation', phase, body });
          await route.fulfill({ json: { result: { ...body, text: '意外单句请求的受控模拟译文。', profile_id: activeProfile } } });
          return;
        }
        assert.equal(body.alignment_version, 'sentence-v1');
        assert(Array.isArray(body.segments) && body.segments.length > 0, 'Paragraph translation must send sentence segments in one batch');
        const ids = body.segments.map((segment) => segment.id);
        assert.equal(new Set(ids).size, ids.length);
        ids.forEach((id) => assert.match(id, /^s\d+-\d+$/));
        if (body.refresh && failNextRefresh) {
          failNextRefresh = false;
          await route.fulfill({ status: 503, json: { error: 'synthetic refresh failure' } });
          return;
        }
        successfulRevision += 1;
        const label = activeProfile === 'sentence-profile-a' ? '旧引擎译文' : '新引擎译文';
        const translated = body.segments.map((segment, index) => ({ id: segment.id, text: `${label}${index + 1}：${segment.text}` }));
        const result = {
          ...body, source_text: body.text, source_segments: body.segments, segments: translated,
          text: translated.map((segment) => segment.text).join(' '),
          profile_id: activeProfile, provider: 'openai-compatible', model: settings.ai.translation.model,
          provider_snapshot: { provider: 'openai-compatible', model: settings.ai.translation.model, mode: 'chat' },
          cache_key: `${activeProfile}:${body.block_id}:${body.source_hash}:sentence-v1`, updated_at: `2026-10-26T00:00:${String(successfulRevision).padStart(2, '0')}Z`,
        };
        const previous = records.findIndex((record) => record.cache_key === result.cache_key);
        if (previous >= 0) records[previous] = result; else records.push(result);
        payload = { result };
      } else if (pathname.endsWith('/annotations')) {
        if (request.method() === 'POST') {
          const annotation = { ...request.postDataJSON(), id: `sentence-annotation-${annotations.length + 1}` };
          annotations.push(annotation);
          payload = { annotation, annotations };
        } else payload = { annotations };
      } else if (pathname.endsWith('/media-layout')) payload = { media_layout: { version: 1, items: {} } };
      else if (pathname.endsWith('/notes')) payload = { markdown: '' };
      else if (pathname.endsWith('/auto-highlights')) payload = { result: { status: 'mock', highlights: [] } };
      else if (pathname === `/api/jobs/${jobId}`) payload = jobs[0];
      else { unexpected.push({ method: request.method(), pathname, phase }); }
      await route.fulfill({ json: payload });
    }
    await page.route('**/*', async (route) => {
      try {
        await handleRoute(route);
      } catch (error) {
        const request = route.request();
        diagnostics.routeErrors.push({ phase, url: request.url(), body: request.postData(), error: error.message });
        try { await route.fulfill({ status: 503, json: { error: 'mock route validation failed' } }); } catch (_) { /* A closing page can cancel its intercepted request. */ }
      }
    });

    const frame = () => page.frameLocator('#html-preview');
    const paragraph = () => frame().locator(`p[data-block-id="${paragraphId}"]`);
    const source = () => paragraph().locator(':scope > .reader-source-sentence');
    const translated = () => paragraph().locator(':scope > .reader-sentence-translation');
    const blockRequests = (id = paragraphId) => requests.filter((request) => request.block_id === id);
    async function openDocument() {
      await page.locator('[data-view="library-view"]').click();
      await page.locator(`#library-view .library-row[data-job-id="${jobId}"]`).dblclick();
      await page.mouse.move(12, 12);
      await paragraph().locator('.paragraph-translate-trigger').waitFor();
    }
    async function displayMode(value) {
      await page.locator('#full-translate-scope-button').click();
      await page.locator('#translation-scope-menu').waitFor({ state: 'visible' });
      await page.locator(`[data-translation-display="${value}"]`).click();
    }
    async function assertSentenceDisplay(label) {
      await translated().filter({ hasText: label }).first().waitFor();
      assert.equal(await source().count(), 3);
      assert.equal(await translated().count(), 3);
      const canonicalSentences = await source().evaluateAll((nodes) => nodes.map((node) => {
        const copy = node.cloneNode(true);
        copy.querySelectorAll('button,.annotation-note-trigger,.annotation-note-popover,.paragraph-translate-trigger').forEach((control) => control.remove());
        return copy.textContent.trim();
      }));
      assert.deepEqual(canonicalSentences, sentences);
      const structure = await paragraph().evaluate((node) => [...node.children].filter((child) => child.matches('.reader-source-sentence,.reader-sentence-translation')).map((child) => child.classList.contains('reader-source-sentence') ? 'source' : 'translation'));
      assert.deepEqual(structure, ['source', 'translation', 'source', 'translation', 'source', 'translation']);
      for (const text of await translated().locator('.translation-text').allTextContents()) assert(text.startsWith(label));
      if (annotations.length) {
        assert(await source().locator('mark[data-annotation-id="sentence-annotation-1"]').count() >= 2, 'Original annotation marks must survive translation display updates');
        assert(await paragraph().locator('.annotation-note-trigger[data-annotation-id="sentence-annotation-1"]').count() > 0, 'Original annotation control must survive translation display updates');
        assert.equal(await translated().locator('[data-annotation-id="sentence-annotation-1"]').count(), 0, 'Original annotation must never move into translated sentences');
      }
    }
    async function clearNativeSelection() {
      await frame().locator('body').evaluate((node) => {
        const doc = node.ownerDocument;
        doc.getSelection().removeAllRanges();
        doc.dispatchEvent(new Event('selectionchange'));
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await page.keyboard.press('Escape');
      await page.mouse.move(12, 12);
      await page.locator('#selection-popover').waitFor({ state: 'hidden' });
      explicitSelectionActive = false;
    }

    await page.mouse.move(12, 12);
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    phase = 'initial-open';
    await openDocument();
    phase = 'initial-paragraph-batch';
    await paragraph().locator('.paragraph-translate-trigger').click();
    await page.mouse.move(12, 12);
    await assertSentenceDisplay('旧引擎译文');
    assert.equal(blockRequests().length, 1, 'Three sentences must use exactly one paragraph translation request');
    assert.deepEqual(blockRequests()[0].segments.map((segment) => segment.text), sentences);
    const fontRatio = await paragraph().evaluate((node) => {
      const sourceNode = node.querySelector('.reader-source-sentence');
      const translationNode = node.querySelector('.reader-sentence-translation .translation-text');
      return parseFloat(getComputedStyle(translationNode).fontSize) / parseFloat(getComputedStyle(sourceNode).fontSize);
    });
    assert(Math.abs(fontRatio - 0.9) < 0.015, `Sentence translation font must be 90% of source; got ${fontRatio}`);
    await page.screenshot({ path: '/tmp/guzi-sentence-translation.png' });

    phase = 'explicit-aligned-hover';
    const requestsBeforeHover = requests.length;
    await source().nth(1).hover();
    await page.locator('#selection-popover:not([hidden])').waitFor();
    await page.locator('#selection-translation-result').filter({ hasText: '旧引擎译文2' }).waitFor();
    assert.equal(blockRequests().length, 1, 'Hovering an aligned source sentence must reuse its translation');
    assert.equal(requests.length, requestsBeforeHover, `Aligned hover added a request: ${JSON.stringify(requests.slice(requestsBeforeHover))}`);
    assert.equal(requests.length, 1, `Unexpected translation before or during aligned hover: ${JSON.stringify(diagnostics)}`);
    const hoverBox = await source().nth(1).boundingBox();
    const copyBox = await page.locator('#selection-copy').boundingBox();
    for (let step = 1; step <= 12; step += 1) {
      const fraction = step / 12;
      await page.mouse.move((hoverBox.x + hoverBox.width / 2) * (1 - fraction) + (copyBox.x + copyBox.width / 2) * fraction,
        (hoverBox.y + hoverBox.height / 2) * (1 - fraction) + (copyBox.y + copyBox.height / 2) * fraction);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert(await page.locator('#selection-copy').isVisible(), 'Toolbar disappeared while moving from the sentence to its actions');
    }
    await page.locator('#selection-copy').click();
    assert.equal(await page.evaluate(() => window.__copiedText), sentences[1]);
    await page.keyboard.press('Escape');
    await page.mouse.move(12, 12);
    phase = 'whole-sentence-selection-reuse';
    await source().first().click({ clickCount: 3, position: { x: 20, y: 8 } });
    await page.locator('#selection-translation-result').filter({ hasText: '旧引擎译文1' }).waitFor();
    assert.equal(requests.length, requestsBeforeHover, 'Selecting an already translated whole sentence must not call AI again');
    await clearNativeSelection();
    phase = 'canonical-selection';
    explicitSelectionActive = true;

    const selectionStart = sourceText.indexOf('sentence explains');
    const selectionEnd = sourceText.indexOf('main principle') + 'main principle'.length;
    const selectedQuote = sourceText.slice(selectionStart, selectionEnd);
    await paragraph().evaluate((node, offsets) => {
      const doc = node.ownerDocument;
      const texts = [];
      for (const sentence of node.querySelectorAll(':scope > .reader-source-sentence')) {
        const walker = doc.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) texts.push(text);
      }
      const point = (offset) => {
        let consumed = 0;
        for (const text of texts) {
          if (offset <= consumed + text.length) return [text, offset - consumed];
          consumed += text.length;
        }
        throw new Error('Selection fixture offset exceeds canonical source');
      };
      const range = doc.createRange();
      range.setStart(...point(offsets.start));
      range.setEnd(...point(offsets.end));
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(range);
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, { start: selectionStart, end: selectionEnd });
    await page.locator('#selection-popover:not([hidden])').waitFor();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await Promise.all([
      frame().locator('.annotation-draw-layer').waitFor(),
      page.waitForResponse((response) => response.url().endsWith('/annotations') && response.request().method() === 'POST'),
      page.locator('#selection-highlight').click(),
    ]);
    assert.equal(await frame().locator('.annotation-draw-layer').getAttribute('aria-hidden'), 'true');
    assert(await frame().locator('.annotation-draw-stroke').count() >= 2, 'A cross-sentence highlight draws each source line');
    await frame().locator('.annotation-draw-layer').waitFor({ state: 'detached' });
    assert.equal(await frame().locator('[data-annotation-drawing="true"]').count(), 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].quote, selectedQuote);
    assert.equal(annotations[0].start, selectionStart);
    assert.equal(annotations[0].end, selectionEnd);
    assert.equal(annotations[0].block_id, paragraphId);
    assert(!annotations[0].quote.includes('引擎译文'), 'Canonical selection quote included translated text');
    await source().locator('[data-annotation-id="sentence-annotation-1"]').first().waitFor();
    assert.equal(await translated().locator('[data-annotation-id="sentence-annotation-1"]').count(), 0, 'Cross-sentence source highlighting must not mark the interleaved translation');
    assert(await source().locator('[data-annotation-id="sentence-annotation-1"]').count() >= 2, 'The original highlight must span both source sentences');

    await clearNativeSelection();
    phase = 'atomic-formulas-and-citations';
    const rich = frame().locator(`p[data-block-id="${richId}"]`);
    await rich.locator('.paragraph-translate-trigger').click();
    await page.mouse.move(12, 12);
    await rich.locator('.reader-sentence-translation').first().waitFor();
    const richRequest = blockRequests(richId)[0];
    assert.equal(blockRequests(richId).length, 1);
    assert.equal(richRequest.segments.length, 2, 'Inline citation and MathML must not create extra sentence boundaries');
    assert.equal(richRequest.formulas.length, 3, 'The two formulas and superscript citation are protected as atomic spans');
    assert.equal(new Set(richRequest.formulas.map((formula) => formula.token)).size, 3, 'Formula tokens must be unique across the whole batch');
    for (const formula of richRequest.formulas) assert.equal(richRequest.segments.filter((segment) => segment.text.includes(formula.token)).length, 1, 'Each formula belongs to exactly one sentence');
    const citation = richRequest.formulas.find((formula) => formula.tex === '143,144');
    assert(citation && richRequest.segments[1].text.includes(citation.token), 'The later superscript citation must stay in its source sentence');
    const firstFormula = richRequest.formulas.find((formula) => formula.tex === 'x/y');
    const secondFormula = richRequest.formulas.find((formula) => formula.tex === '10^4');
    assert(firstFormula && richRequest.segments[0].text.includes(firstFormula.token), 'The first-sentence MathML must not inherit the later superscript token');
    assert(secondFormula && richRequest.segments[1].text.includes(secondFormula.token), 'The later MathML must preserve its own formula token');
    assert.equal(await rich.locator('.reader-source-sentence math').count(), 2);
    assert.equal(await rich.locator('.reader-source-sentence sup a[href="#ref-143"]').count(), 1);
    assert.equal(await rich.locator('.reader-sentence-translation math').count(), 2, 'Translated formula placeholders must render as intact MathML');
    assert.equal(await rich.locator('.reader-sentence-translation sup').filter({ hasText: '143,144' }).count(), 1, 'Translated citation must remain an intact superscript');

    phase = 'list-sentence-pairs';
    const list = frame().locator(`ul[data-block-id="${listId}"]`);
    await list.locator('.paragraph-translate-trigger').click();
    await page.mouse.move(12, 12);
    await list.locator('.reader-sentence-translation').nth(2).waitFor();
    assert.equal(blockRequests(listId).length, 1, 'The entire list must use one translation batch');
    assert.equal(blockRequests(listId)[0].segments.length, 3, 'Each list item must keep its sentence boundaries, including an unpunctuated final item');
    assert.equal(await list.locator(':scope > li').count(), 2, 'Sentence insertion must retain both list items');
    assert.equal(await list.locator(':scope > li').nth(0).locator('.reader-sentence-translation').count(), 2);
    assert.equal(await list.locator(':scope > li').nth(1).locator('.reader-sentence-translation').count(), 1);
    assert.equal(await list.locator(':scope > .reader-source-sentence').count(), 0, 'Sentence spans belong inside list items');
    assert.equal((await list.locator('.reader-source-sentence').allTextContents()).join(''), 'First list item has two sentences. Its second sentence stays in the same item.Second list item keeps its bullet without terminal punctuation');

    await clearNativeSelection();
    phase = 'display-modes';
    await displayMode('original');
    assert.equal(await source().first().isVisible(), true);
    assert.equal(await translated().first().isVisible(), false);
    await displayMode('translation');
    assert.equal(await source().first().isVisible(), false);
    assert.equal(await translated().first().isVisible(), true);
    await displayMode('bilingual');
    assert.equal(await source().first().isVisible(), true);
    assert.equal(await translated().first().isVisible(), true);

    phase = 'engine-switch';
    const beforeSwitch = requests.length;
    await page.locator('[data-view="settings-view"]').click();
    await page.locator('a[href="#settings-ai"]').click();
    await page.locator('#setting-translation-model').fill('fixture-engine-b');
    await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
    await page.locator('#confirm-dialog[open]').waitFor();
    assert.match(await page.locator('#confirm-message').textContent(), /已有译文会保留/);
    assert.equal(await page.locator('#confirm-cancel').textContent(), '保留现有译文');
    await page.locator('#confirm-cancel').click();
    await openDocument();
    await assertSentenceDisplay('旧引擎译文');
    assert.equal(requests.length, beforeSwitch, 'Switching engines and retaining must not request translation');
    assert((await translated().first().getAttribute('title')).includes('fixture-engine-a'), 'Retained translation must identify its original engine');
    await source().first().click({ clickCount: 3, position: { x: 20, y: 8 } });
    await page.locator('#selection-translation-result').filter({ hasText: '旧引擎译文1' }).waitFor();
    assert.equal(requests.length, beforeSwitch, 'Whole-sentence selection must reuse the retained translation after switching engines');
    await clearNativeSelection();

    phase = 'reload-history';
    await page.mouse.move(12, 12);
    await page.reload({ waitUntil: 'networkidle' });
    await openDocument();
    await assertSentenceDisplay('旧引擎译文');
    assert.equal(requests.length, beforeSwitch, 'Reload must restore the chosen historical translation without calling AI');
    assert.equal(await frame().locator(`ul[data-block-id="${listId}"] > li`).count(), 2);
    assert.equal(await frame().locator(`ul[data-block-id="${listId}"] .reader-sentence-translation`).count(), 3, 'List sentence translations must survive reload');
    assert(historyReads.length >= 2 && historyReads.every((scope) => scope === 'all'), 'Reader cache replay must request history with scope=all');
    assert.equal(await translated().locator('[data-annotation-id="sentence-annotation-1"]').count(), 0);

    phase = 'failed-refresh';
    failNextRefresh = true;
    await paragraph().locator('.paragraph-translate-trigger').click();
    await page.mouse.move(12, 12);
    await paragraph().locator('.translation-retained-status').filter({ hasText: '原译文已保留' }).waitFor();
    await assertSentenceDisplay('旧引擎译文');
    assert.equal(blockRequests().at(-1).refresh, true, 'Clicking an already translated paragraph must explicitly refresh');
    assert.equal(blockRequests().at(-1).requested_profile, 'sentence-profile-b');
    assert.equal(records.filter((record) => record.block_id === paragraphId).length, 1, 'A failed refresh must not replace or append a persisted translation');
    phase = 'successful-refresh';
    await paragraph().locator('.paragraph-translate-trigger').click();
    await page.mouse.move(12, 12);
    await assertSentenceDisplay('新引擎译文');
    assert.equal(await paragraph().locator('.translation-retained-status').count(), 0);
    assert.equal(await translated().filter({ hasText: '旧引擎译文' }).count(), 0);
    assert((await translated().first().getAttribute('title')).includes('fixture-engine-b'));
    assert.equal(records.filter((record) => record.block_id === paragraphId).length, 2, 'Successful translation under a new engine must preserve historical records');
    assert.equal(blockRequests().length, 3, 'Initial translation, failed refresh and successful refresh each use one batch');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, [], `Unexpected requests: ${JSON.stringify(unexpected)}`);
    assert.deepEqual(diagnostics.routeErrors, [], `Route errors: ${JSON.stringify(diagnostics.routeErrors)}`);
    console.log(JSON.stringify({ passed: true, cases: ['paragraph-batch-and-sentence-order', 'translation-font-90-percent', 'translated-hover-cache', 'canonical-cross-sentence-selection', 'source-only-highlight', 'atomic-formulas-and-citations', 'math-before-later-sup-token-order', 'list-sentence-pairs', 'original-translation-bilingual-modes', 'engine-switch-retains-and-prompts', 'history-survives-reload', 'failed-refresh-retains', 'successful-refresh-replaces'], translationRequests: requests.length }));
  } catch (error) {
    diagnostics.selectionState = await session.browser.contexts()[0]?.pages()[0]?.evaluate(() => {
      const frameDocument = document.querySelector('#html-preview')?.contentDocument;
      const selection = frameDocument?.getSelection();
      return { quote: selection?.toString(), anchor: selection?.anchorNode?.parentElement?.outerHTML, focus: selection?.focusNode?.parentElement?.outerHTML, popover: document.querySelector('#selection-popover')?.outerHTML.slice(0, 1800), toasts: [...document.querySelectorAll('[role="status"], .toast')].map((node) => node.textContent) };
    }).catch(() => null);
    console.error(JSON.stringify({ failed_phase: phase, ...diagnostics }));
    throw error;
  } finally {
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
