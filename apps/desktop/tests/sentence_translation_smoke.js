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
const atomicId = 'block-1-5-paragraph';
const flowingId = 'block-1-6-paragraph';
const lazyFormulaPath = '/api/test-assets/sentence-inline-formula.svg';
const sentences = [
  'First sentence explains the experimental setup.',
  'Middle sentence describes the main principle.',
  'Final sentence states the conclusion.',
];
const sourceText = sentences.join(' ');
const chineseSentences = [
  '第一句介绍实验设置，并完整说明样本选择、数据准备、训练步骤与评价方式；这些内容组成一个连续译句，即使显示空间变窄，也应按照中文文本本身的长度自然换行，每一行英文下方显示对应的中文，放不下的中文继续在下一行显示。',
  '中间一句解释主要原理，说明方法如何在保留上下文的同时建立对应关系。',
  '最后一句给出研究结论，并概括实验观察所支持的主要发现。',
];
const flowingSentences = [
  'We evaluate InternAgent-1.5 on scientific reasoning benchmarks such as GAIA, HLE, GPQA, and FrontierScience, and the system achieves leading performance that demonstrates strong foundational capabilities.',
  'Beyond these benchmarks, we further assess two categories of discovery tasks.',
  'In algorithm discovery tasks, InternAgent-1.5 autonomously designs competitive methods for core machine learning problems.',
  'In empirical discovery tasks, it executes complete computational or wet lab experiments and produces scientific findings in earth, life, biological, and physical domains.',
];
const flowingChinese = [
  '我们在GAIA、HLE、GPQA和FrontierScience等科学推理基准上评估InternAgent-1.5，该系统取得了领先性能，展现出强大的基础能力。',
  '除这些基准之外，我们进一步评估两类发现任务。',
  '在算法发现任务中，InternAgent-1.5自主设计用于核心机器学习问题的有竞争力的方法。',
  '在实证发现任务中，它执行完整的计算实验或湿实验，并在地球、生命、生物和物理领域产生科学发现。',
];
const jobs = [{ job_id: jobId, status: 'completed', source_filename: 'Sentence translation fixture.pdf', created_at: '2026-10-26T00:00:00Z', links: { html: `/api/jobs/${jobId}/document.html` }, manifest: { counts: { pages: 1, images: 0, tables: 0 } } }];
const library = { folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] }, items: { [jobId]: { folder_ids: [], values: { reading_status: '未读', importance: 0 }, metadata: { status: 'complete', fields: { title: 'Sentence translation fixture' } } } } };
const documentHTML = `<!doctype html><html><head><style>
body{margin:0}.reader-content{max-width:720px;margin:32px auto;font-size:calc(18px * var(--reader-font-scale,1));line-height:1.72}p{margin:20px 0}
</style></head><body><main class="reader-content"><section class="pdf-page" data-page="1">
<h2>Sentence translation fixture</h2>
<p data-block-id="${paragraphId}" data-page="1">${sourceText}</p>
<p data-block-id="${richId}" data-page="1">Inline formula <math alttext="x/y"><mfrac><mi>x</mi><mi>y</mi></mfrac></math> remains atomic. The second sentence preserves citation <sup><a href="#ref-143">143,144</a></sup> and formula <math alttext="10^4"><msup><mn>10</mn><mn>4</mn></msup></math> without splitting its exponent.</p>
<ul data-block-id="${listId}" data-page="1"><li>First list item has two sentences. Its second sentence stays in the same item.</li><li>Second list item keeps its bullet without terminal punctuation</li></ul>
<p data-block-id="${atomicId}" data-page="1"><math alttext="x/(wide+denominator)"><mfrac><mi>x</mi><mrow><mi>wide</mi><mo>+</mo><mi>denominator</mi></mrow></mfrac></math> normalizes the input <img class="math-source-inline" data-lazy-formula loading="lazy" alt="" style="height:24px;width:auto;max-width:none;vertical-align:middle"> before estimation. The next sentence reports the resulting estimate.</p>
<p data-block-id="${flowingId}" data-page="1">${flowingSentences.join(' ')}</p>
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
    let releaseLazyImage;
    const lazyImageGate = new Promise((resolve) => { releaseLazyImage = resolve; });
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
      if (pathname === lazyFormulaPath) {
        await lazyImageGate;
        await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="380" height="24"><text x="4" y="18" font-size="18">z = a + b + c + d + e + f + g + h</text></svg>' });
        return;
      }
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
        const translated = body.segments.map((segment, index) => {
          const tokens = segment.text.match(/__MY_SCHOLAR_[A-Z0-9_]+__/gu) || [];
          const text = body.block_id === paragraphId ? chineseSentences[index] : body.block_id === flowingId ? flowingChinese[index]
            : `本句保留原文中的公式、引用和列表结构，完整呈现对应内容${tokens.length ? `：${tokens.join(' ')}` : ''}。`;
          return { id: segment.id, text: body.block_id === flowingId ? text : `${label}${index + 1}：${text}` };
        });
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
      assert.deepEqual(structure, ['source', 'source', 'source', 'translation', 'translation', 'translation']);
      assert.deepEqual(await translated().locator('.translation-text').allTextContents(), chineseSentences.map((text, index) => `${label}${index + 1}：${text}`));
      assert.equal(await translated().locator('.translation-text').count(), sentences.length, 'Each translated sentence must retain one complete text container');
      assert.equal(await translated().locator('br,.reader-sentence-translation,.reader-source-sentence').count(), 0, 'Translations must not clone source lines or slice sentences into visual rows');
      if (annotations.length) {
        assert(await source().locator('mark[data-annotation-id="sentence-annotation-1"]').count() >= 2, 'Original annotation marks must survive translation display updates');
        assert(await paragraph().locator('.annotation-note-trigger[data-annotation-id="sentence-annotation-1"]').count() > 0, 'Original annotation control must survive translation display updates');
        assert.equal(await translated().locator('[data-annotation-id="sentence-annotation-1"]').count(), 0, 'Original annotation must never move into translated sentences');
      }
    }
    async function hoverSourceSentence(index) {
      await source().nth(index).scrollIntoViewIfNeeded();
      await settleLayout();
      await page.mouse.move(12, 12);
      const character = await source().nth(index).evaluate((node) => {
        const doc = node.ownerDocument;
        const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          const offset = text.data.search(/\S/u);
          if (offset < 0 || text.parentElement.closest('button,.annotation-note-trigger')) continue;
          const range = doc.createRange();
          range.setStart(text, offset);
          range.setEnd(text, offset + 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
        throw new Error('Source sentence has no visible character');
      });
      const iframe = page.locator('#html-preview');
      const box = await iframe.boundingBox();
      const border = await iframe.evaluate((node) => ({ left: node.clientLeft, top: node.clientTop }));
      const result = { ...character, x: character.x + box.x + border.left, y: character.y + box.y + border.top };
      await page.mouse.move(result.x + result.width / 2, result.y + result.height / 2);
      return result;
    }
    async function selectWholeSourceSentence(index = 0) {
      await source().nth(index).evaluate((node) => {
        const doc = node.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(node);
        doc.getSelection().removeAllRanges();
        doc.getSelection().addRange(range);
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
    }
    async function settleLayout() {
      await paragraph().evaluate((node) => new Promise((resolve) => node.ownerDocument.defaultView.requestAnimationFrame(() => node.ownerDocument.defaultView.requestAnimationFrame(resolve))));
    }
    async function measureSentenceLayout(target = paragraph()) {
      return target.evaluate((node) => {
        const doc = node.ownerDocument;
        const block = node.getBoundingClientRect();
        const characters = (element) => {
          const result = [];
          const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let text;
          while ((text = walker.nextNode())) {
            if (text.parentElement.closest('button,.annotation-note-trigger,.annotation-note-popover,.paragraph-translate-trigger')) continue;
            for (let offset = 0; offset < text.length; offset += 1) {
              if (/\s/u.test(text.data[offset])) continue;
              const range = doc.createRange();
              range.setStart(text, offset);
              range.setEnd(text, offset + 1);
              const rect = range.getBoundingClientRect();
              if (!rect.width || !rect.height) continue;
              result.push({ text: text.data[offset], left: rect.left - block.left, right: rect.right - block.left, top: rect.top - block.top, bottom: rect.bottom - block.top });
            }
          }
          return result;
        };
        const sources = [...node.querySelectorAll(':scope > .reader-source-sentence')].map(characters);
        const lineTops = [];
        for (const sentence of sources) for (const character of sentence) {
          let line = lineTops.findIndex((top) => Math.abs(top - character.top) < 1);
          if (line < 0) { line = lineTops.length; lineTops.push(character.top); }
          character.line = line;
        }
        const translations = [...node.querySelectorAll(':scope > .reader-sentence-translation')].map((translation) => {
          const text = translation.querySelector('.translation-text');
          const lines = [];
          for (const character of characters(text)) {
            const line = lines.find((candidate) => Math.abs(candidate.top - character.top) < 1);
            if (line) {
              line.left = Math.min(line.left, character.left);
              line.right = Math.max(line.right, character.right);
              line.bottom = Math.max(line.bottom, character.bottom);
            } else lines.push({ ...character });
          }
          const glyphs = characters(text);
          const hits = [...new Set([0, Math.floor(glyphs.length / 2), glyphs.length - 1])].map((index) => glyphs[index]).filter(Boolean).filter((glyph) => {
            const x = block.left + (glyph.left + glyph.right) / 2;
            const y = block.top + (glyph.top + glyph.bottom) / 2;
            return x > 0 && y > 0 && x < doc.defaultView.innerWidth && y < doc.defaultView.innerHeight;
          }).map((glyph) => {
            const hit = doc.elementFromPoint(block.left + (glyph.left + glyph.right) / 2, block.top + (glyph.top + glyph.bottom) / 2);
            return { text: glyph.text, ownSentence: hit?.closest('.reader-sentence-translation') === translation };
          });
          return { first: glyphs[0], lines, hits, fragments: [...text.querySelectorAll('.reader-translation-line')].map((line) => ({ text: line.textContent, glyphs: characters(line) })), position: getComputedStyle(translation).position };
        });
        return { sources, translations, width: block.width, height: block.height, sourceLines: lineTops.length, fontSize: parseFloat(getComputedStyle(node.querySelector('.reader-source-sentence')).fontSize) };
      });
    }
    async function assertContinuousLayout(label, { expectWrappedTranslation = false } = {}) {
      await settleLayout();
      const bilingual = await measureSentenceLayout();
      diagnostics.latestLayout = { label, bilingual };
      const sourceRows = [];
      for (const sentence of bilingual.sources) for (const glyph of sentence) {
        let row = sourceRows.find((item) => item.id === glyph.line);
        if (!row) { row = { id: glyph.line, top: glyph.top, bottom: glyph.bottom, translationBottom: 0 }; sourceRows.push(row); }
        row.bottom = Math.max(row.bottom, glyph.bottom);
      }
      sourceRows.sort((a, b) => a.top - b.top);
      for (let index = 0; index < bilingual.translations.length; index += 1) {
        const translation = bilingual.translations[index];
        assert.equal(translation.position, 'absolute', `${label}: translated sentence identity must remain positioned over its paragraph`);
        for (const hit of translation.hits) assert(hit.ownSentence, `${label}: sentence ${index + 1} character ${hit.text} is blocked by another sentence's blank positioning layer`);
        assert(translation.first && bilingual.sources[index][0], `${label}: both sentences must expose visible text`);
        if (index === 0) assert(Math.abs(translation.first.left - bilingual.sources[index][0].left) <= 1, `${label}: the first Chinese row must align with the English row`);
        const translatedRows = new Set();
        for (const fragment of translation.fragments) {
          const row = sourceRows.findLast((item) => item.top < fragment.glyphs[0]?.top);
          assert(row, `${label}: Chinese fragment must follow an English line`);
          translatedRows.add(row.id);
          const next = sourceRows[sourceRows.indexOf(row) + 1];
          for (const glyph of fragment.glyphs) {
            assert(glyph.top >= row.bottom - 1, `${label}: Chinese overlaps its English source line`);
            assert(!next || glyph.bottom < next.top, `${label}: Chinese extends into the next English line`);
            row.translationBottom = Math.max(row.translationBottom, glyph.bottom);
          }
        }
        assert.deepEqual([...translatedRows], [...new Set(bilingual.sources[index].map((glyph) => glyph.line))], `${label}: Chinese must be distributed below every English line belonging to its sentence`);
        assert.equal(translation.fragments.map((fragment) => fragment.text).join(''), chineseSentences.map((text, i) => `旧引擎译文${i + 1}：${text}`)[index], `${label}: visual reflow must preserve every translated character exactly once`);
        for (const line of translation.lines) {
          assert(line.bottom <= bilingual.height + 1, `${label}: translated text extends below its paragraph`);
          assert(line.left >= -1 && line.right <= bilingual.width + 1, `${label}: translated text extends beyond its paragraph width`);
        }
        for (const previous of bilingual.translations.slice(0, index)) for (const a of previous.lines) for (const b of translation.lines) {
          const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          assert(overlapWidth <= 1 || overlapHeight <= 1, `${label}: translated sentences overlap`);
        }
      }
      for (let i = 0; i + 1 < sourceRows.length; i += 1) {
        const row = sourceRows[i];
        assert(sourceRows[i + 1].top - row.translationBottom < bilingual.fontSize * 1.5, `${label}: a short Chinese band must not inherit another band's excessive spacing`);
      }
      if (expectWrappedTranslation) assert(bilingual.translations[0].lines.length > 1, `${label}: the long Chinese sentence must wrap naturally`);
      await displayMode('original');
      await settleLayout();
      const original = await measureSentenceLayout();
      assert.equal(bilingual.sourceLines, original.sourceLines, `${label}: bilingual mode changed the English line count`);
      assert(original.sources.some((sentence, index) => index && original.sources[index - 1].at(-1).line === sentence[0].line), `${label}: fixture must include a natural sentence boundary within an English line`);
      for (let index = 0; index < original.sources.length; index += 1) {
        assert.equal(bilingual.sources[index].length, original.sources[index].length, `${label}: English characters changed`);
        for (let offset = 0; offset < original.sources[index].length; offset += 1) {
          const before = original.sources[index][offset];
          const after = bilingual.sources[index][offset];
          assert.equal(after.text, before.text);
          assert.equal(after.line, before.line, `${label}: English wraps at a different character`);
          assert(Math.abs(after.left - before.left) <= 1, `${label}: English horizontal flow changed`);
        }
      }
      await displayMode('bilingual');
      await settleLayout();
      return bilingual;
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
    assert(Math.abs(fontRatio - 0.8) < 0.015, `Sentence translation font must be 80% of source; got ${fontRatio}`);
    phase = 'continuous-interlinear-layout';
    const defaultLayout = await assertContinuousLayout('default', { expectWrappedTranslation: true });
    const layouts = [];
    const originalFontScale = await page.locator('#font-size-range').inputValue();
    for (const variant of [{ width: 1024, contentWidth: 420, fontScale: 100 }, { width: 1600, contentWidth: 720, fontScale: 100 }, { width: 1600, contentWidth: 720, fontScale: 140 }]) {
      await page.setViewportSize({ width: variant.width, height: 940 });
      await paragraph().evaluate((node, style) => {
        const content = node.closest('.reader-content');
        content.style.maxWidth = `${style.contentWidth}px`;
      }, variant);
      await page.locator('#font-size-range').evaluate((control, scale) => {
        control.value = String(scale);
        control.dispatchEvent(new Event('input', { bubbles: true }));
      }, variant.fontScale);
      layouts.push(await assertContinuousLayout(`${variant.width}px viewport / ${variant.fontScale}% text`, { expectWrappedTranslation: true }));
    }
    assert(layouts[0].width < layouts[1].width, 'Narrow viewport fixture must reduce the reading width');
    assert(layouts[0].sourceLines > layouts[1].sourceLines, 'Narrow layout must reflow continuous English');
    assert(layouts[2].fontSize > layouts[1].fontSize, 'The reader font-size control must change the displayed source size');
    assert(layouts[2].sourceLines > layouts[1].sourceLines, 'Increasing the text size must reflow continuous English');
    await page.setViewportSize({ width: 1450, height: 940 });
    await paragraph().evaluate((node) => {
      const content = node.closest('.reader-content');
      content.style.removeProperty('max-width');
    });
    await page.locator('#font-size-range').evaluate((control, scale) => {
      control.value = scale;
      control.dispatchEvent(new Event('input', { bubbles: true }));
    }, originalFontScale);
    await settleLayout();
    assert.equal((await measureSentenceLayout()).sourceLines, defaultLayout.sourceLines, 'Restoring width and text size must restore English wrapping');
    await page.screenshot({ path: '/tmp/guzi-sentence-translation.png' });

    phase = 'realistic-line-flow';
    const flowing = frame().locator(`p[data-block-id="${flowingId}"]`);
    await flowing.locator('.paragraph-translate-trigger').click();
    await page.mouse.move(12, 12);
    await flowing.locator('.reader-translation-line').first().waitFor();
    await settleLayout();
    const flowingLayout = await measureSentenceLayout(flowing);
    assert.deepEqual(await flowing.locator('.translation-text').allTextContents(), flowingChinese);
    for (const word of ['InternAgent-1.5', 'FrontierScience']) {
      const fragments = await flowing.locator('.reader-translation-line').allTextContents();
      assert.equal(fragments.filter((text) => text.includes(word)).length, flowingChinese.filter((text) => text.includes(word)).length, 'Visual row boundaries must preserve complete scientific names');
    }
    const flowingLines = new Set(flowingLayout.translations.flatMap((translation) => translation.lines.map((line) => Math.round(line.top))));
    assert.equal(flowingLines.size, flowingLayout.sourceLines, 'Normal-length Chinese must occupy one Chinese line beneath each natural English line');
    await flowing.screenshot({ path: '/tmp/guzi-v069-interlinear-realistic.png' });

    phase = 'explicit-aligned-hover';
    const requestsBeforeHover = requests.length;
    const hoverBox = await hoverSourceSentence(1);
    await page.locator('#selection-popover:not([hidden])').waitFor();
    await page.locator('#selection-translation-result').filter({ hasText: '旧引擎译文2' }).waitFor();
    assert.equal(blockRequests().length, 1, 'Hovering an aligned source sentence must reuse its translation');
    assert.equal(requests.length, requestsBeforeHover, `Aligned hover added a request: ${JSON.stringify(requests.slice(requestsBeforeHover))}`);
    assert.equal(requests.length, 2, `Unexpected translation before or during aligned hover: ${JSON.stringify(diagnostics)}`);
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
    await selectWholeSourceSentence();
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
    await page.evaluate(() => {
      const doc = document.querySelector('#html-preview').contentDocument;
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
      const audit = window.__annotationDrawAudit = { events: [] };
      const record = (event, layer = doc.querySelector('.annotation-draw-layer'), detail = {}) => {
        const marks = [...doc.querySelectorAll('mark[data-annotation-id="sentence-annotation-1"]')];
        audit.events.push({ event, time: performance.now(), reducedMotion: motion.matches,
          rects: marks.flatMap((mark) => [...mark.getClientRects()].map((rect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }))),
          markCount: marks.length, drawing: marks.map((mark) => mark.dataset.annotationDrawing || ''),
          layerConnected: Boolean(layer?.isConnected), ariaHidden: layer?.getAttribute('aria-hidden'), strokes: layer?.querySelectorAll('.annotation-draw-stroke').length || 0,
          animations: layer ? [...layer.querySelectorAll('.annotation-draw-stroke')].flatMap((stroke) => stroke.getAnimations().map((animation) => ({ state: animation.playState, time: animation.currentTime, duration: animation.effect.getTiming().duration }))) : [],
          ...detail });
      };
      const observer = new MutationObserver((records) => {
        for (const mutation of records) for (const [kind, nodes] of [['layer-added', mutation.addedNodes], ['layer-removed', mutation.removedNodes]]) {
          for (const node of nodes) if (node.nodeType === Node.ELEMENT_NODE && node.matches('.annotation-draw-layer')) {
            record(kind, node);
            if (kind === 'layer-added') {
              const animations = [...node.querySelectorAll('.annotation-draw-stroke')].flatMap((stroke) => stroke.getAnimations());
              animations.forEach((animation, stroke) => animation.finished.then(
                () => record('stroke-finished', node, { stroke }),
                (error) => record('stroke-cancelled', node, { stroke, reason: error.name }),
              ));
            }
          }
        }
      });
      observer.observe(doc.body, { childList: true, subtree: true });
      const changed = () => record('motion-change');
      const scrolled = () => record('scroll');
      const resized = () => record('resize');
      motion.addEventListener('change', changed);
      doc.addEventListener('scroll', scrolled, true);
      doc.defaultView.addEventListener('resize', resized);
      audit.stop = () => {
        observer.disconnect(); motion.removeEventListener('change', changed);
        doc.removeEventListener('scroll', scrolled, true); doc.defaultView.removeEventListener('resize', resized);
      };
      record('before-motion-change');
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/annotations') && response.request().method() === 'POST'),
      page.locator('#selection-highlight').click(),
    ]);
    await page.waitForFunction(() => window.__annotationDrawAudit.events.some((event) => event.event === 'layer-removed'));
    diagnostics.annotationDraw = await page.evaluate(() => { window.__annotationDrawAudit.stop(); return window.__annotationDrawAudit.events; });
    console.log(JSON.stringify({ annotationDraw: diagnostics.annotationDraw }));
    const drawCreated = diagnostics.annotationDraw.filter((event) => event.event === 'layer-added');
    const drawRemoved = diagnostics.annotationDraw.filter((event) => event.event === 'layer-removed');
    const drawFinished = diagnostics.annotationDraw.filter((event) => event.event === 'stroke-finished');
    const drawCancelled = diagnostics.annotationDraw.filter((event) => event.event === 'stroke-cancelled');
    assert.equal(drawCreated.length, 1, 'One newly saved annotation must create one drawing layer');
    assert.equal(drawCreated[0].ariaHidden, 'true');
    assert(drawCreated[0].strokes >= 2, 'A cross-sentence highlight draws each source line');
    assert.equal(drawCreated[0].animations.length, drawCreated[0].strokes, 'Every stroke must have a real Web Animation');
    assert.equal(drawCreated[0].reducedMotion, false);
    assert.deepEqual(drawCancelled, [], 'Layout or media changes must not cancel the annotation drawing');
    assert.equal(drawFinished.length, drawCreated[0].strokes, 'Every stroke must finish before drawing cleanup');
    assert.equal(new Set(drawFinished.map((event) => event.stroke)).size, drawCreated[0].strokes);
    assert.equal(drawRemoved.length, 1);
    assert.deepEqual(drawRemoved[0].rects, drawCreated[0].rects, 'Source mark geometry must remain stable throughout drawing');
    assert.equal(drawRemoved[0].markCount, 2, 'Animation cleanup must preserve both source annotation marks');
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
    assert.equal(await translated().locator('[data-annotation-id="sentence-annotation-1"]').count(), 0, 'Cross-sentence source highlighting must not mark the translated sentences');
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

    phase = 'leading-fraction-and-lazy-image';
    const atomic = frame().locator(`p[data-block-id="${atomicId}"]`);
    await atomic.locator('.paragraph-translate-trigger').click();
    await page.mouse.move(12, 12);
    await atomic.locator(':scope > .reader-sentence-translation').nth(1).waitFor();
    assert.equal(blockRequests(atomicId).length, 1, 'The formula/image paragraph must use one batch');
    const atomicRequest = blockRequests(atomicId)[0];
    assert.equal(atomicRequest.segments.length, 2);
    assert.equal(atomicRequest.formulas.length, 1, 'The leading fraction remains one protected formula');
    assert(atomicRequest.segments[0].text.includes(atomicRequest.formulas[0].token));
    assert.equal(await atomic.locator(':scope > .reader-source-sentence math mfrac').count(), 1);
    assert.equal(await atomic.locator(':scope > .reader-sentence-translation math mfrac').count(), 1, 'The translated fraction must remain whole');
    async function measureAtomicLayout() {
      return atomic.evaluate((node) => {
        const doc = node.ownerDocument;
        const box = node.getBoundingClientRect();
        const firstCharacter = (root) => {
          const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let text;
          while ((text = walker.nextNode())) {
            const offset = text.data.search(/\S/u);
            if (offset < 0 || text.parentElement.closest('button')) continue;
            const range = doc.createRange();
            range.setStart(text, offset); range.setEnd(text, offset + 1);
            const rect = range.getBoundingClientRect();
            return { left: rect.left - box.left, top: rect.top - box.top, bottom: rect.bottom - box.top };
          }
          throw new Error('Atomic layout fixture has no visible text');
        };
        const sources = [...node.querySelectorAll(':scope > .reader-source-sentence')];
        const translations = [...node.querySelectorAll(':scope > .reader-sentence-translation')];
        const math = sources[0].querySelector('math').getBoundingClientRect();
        const numerator = sources[0].querySelector('mfrac > mi').getBoundingClientRect();
        return {
          mathLeft: math.left - box.left, numeratorLeft: numerator.left - box.left,
          source: firstCharacter(sources[1]), translations: translations.map((translation) => firstCharacter(translation.querySelector('.translation-text'))),
          lines: new Set(sources.flatMap((source) => [...source.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top - box.top)))).size,
          imageWidth: sources[0].querySelector('img[data-lazy-formula]').getBoundingClientRect().width,
        };
      });
    }
    await settleLayout();
    const beforeImage = await measureAtomicLayout();
    assert(beforeImage.numeratorLeft - beforeImage.mathLeft > 5, 'The wide denominator must visibly center the numerator inside the fraction');
    assert(Math.abs(beforeImage.translations[0].left - beforeImage.mathLeft) <= 1, 'A leading fraction aligns Chinese with the whole math box, not its centered numerator');
    const requestsBeforeImage = requests.length;
    await atomic.locator('.reader-source-sentence img[data-lazy-formula]').scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForRequest((request) => new URL(request.url()).pathname === lazyFormulaPath),
      atomic.locator('.reader-source-sentence img[data-lazy-formula]').evaluate((image, path) => { image.src = path; }, lazyFormulaPath),
    ]);
    releaseLazyImage();
    await atomic.locator('.reader-source-sentence img[data-lazy-formula]').evaluate((image) => image.decode());
    await settleLayout();
    const afterImage = await measureAtomicLayout();
    diagnostics.atomicLayout = { beforeImage, afterImage };
    assert(Math.abs(afterImage.imageWidth - beforeImage.imageWidth) > 1, 'The delayed image must change its intrinsic inline width');
    assert(afterImage.lines !== beforeImage.lines || Math.abs(afterImage.source.left - beforeImage.source.left) > 1, 'The loaded image must actually change the English wrapping or sentence start');
    assert(afterImage.translations[1].left >= 0, 'Chinese must stay inside the paragraph after image load');
    assert(afterImage.translations[1].top >= afterImage.source.bottom - 1, 'The moved source sentence must remain above its translation after image load');
    assert(Math.abs(afterImage.translations[1].left - beforeImage.translations[1].left) > 1 || Math.abs(afterImage.translations[1].top - beforeImage.translations[1].top) > 1, 'Image load must update the positioned Chinese sentence');
    assert(Math.abs(afterImage.translations[0].left - afterImage.mathLeft) <= 1, 'Image reflow must retain the leading fraction alignment');
    assert.equal(requests.length, requestsBeforeImage, 'Image-only reflow must not request another translation');

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
    await selectWholeSourceSentence();
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
    phase = 'translated-annotation-reflow';
    await translated().first().locator('.translation-text').evaluate((body) => {
      const doc = body.ownerDocument;
      const nodes = [];
      const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) nodes.push(text);
      let offset = 0;
      const point = (at) => {
        offset = 0;
        for (const node of nodes) {
          if (at <= offset + node.length) return [node, at - offset];
          offset += node.length;
        }
      };
      const range = doc.createRange();
      range.setStart(...point(4)); range.setEnd(...point(body.textContent.length - 4));
      doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('#selection-popover:not([hidden])').waitFor();
    await page.locator('#selection-copy').click();
    const expectedTranslatedText = `新引擎译文1：${chineseSentences[0]}`;
    assert.equal(await page.evaluate(() => window.__copiedText), expectedTranslatedText.slice(4, -4), 'Copying across Chinese visual fragments must retain the original continuous text');
    await page.locator('#selection-highlight').click();
    await translated().locator('mark[data-annotation-id="sentence-annotation-2"]').first().waitFor();
    await clearNativeSelection();
    const markedBefore = await translated().locator('mark[data-annotation-id="sentence-annotation-2"]').count();
    for (let i = 0; i < 8; i += 1) {
      await paragraph().evaluate((node, width) => { node.closest('.reader-content').style.maxWidth = `${width}px`; }, i % 2 ? 720 : 420);
      await settleLayout();
    }
    await paragraph().evaluate((node) => { node.closest('.reader-content').style.removeProperty('max-width'); });
    await settleLayout();
    assert.equal(await translated().first().locator('.translation-text').evaluate((body) => {
      const clone = body.cloneNode(true);
      clone.querySelectorAll('.annotation-note-trigger,.annotation-note-popover').forEach((control) => control.remove());
      return clone.textContent;
    }), expectedTranslatedText);
    assert.equal(await translated().locator('mark[data-annotation-id="sentence-annotation-2"]').evaluateAll((nodes) => nodes.map((node) => node.textContent).join('')), expectedTranslatedText.slice(4, -4), 'Chinese marks must retain their exact quote after repeated line reflow');
    assert.equal(await translated().locator('mark[data-annotation-id="sentence-annotation-2"]').evaluateAll((nodes) => nodes.filter((node) => !node.textContent).length), 0, 'Repeated reflow must not accumulate empty marks');
    assert(await translated().locator('mark[data-annotation-id="sentence-annotation-2"]').count() <= markedBefore + 8, 'Reflow must not grow mark fragments on every pass');
    assert.equal(annotations[1].quote, expectedTranslatedText.slice(4, -4));
    assert.equal(annotations[1].surface, 'translation');
    phase = 'translated-formula-annotation-reflow';
    const richBody = rich.locator('.reader-sentence-translation').first().locator('.translation-text');
    const richOriginal = await richBody.evaluate((body) => body.textContent);
    await richBody.evaluate((body) => {
      const doc = body.ownerDocument;
      const range = doc.createRange();
      range.setStart(body, 0); range.setEndAfter(body.querySelector('math'));
      doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('#selection-popover:not([hidden])').waitFor();
    await page.locator('#selection-highlight').click();
    await richBody.locator('mark[data-annotation-id="sentence-annotation-3"]').first().waitFor();
    await clearNativeSelection();
    for (let i = 0; i < 8; i += 1) {
      await rich.evaluate((node, width) => { node.closest('.reader-content').style.maxWidth = `${width}px`; }, i % 2 ? 720 : 420);
      await settleLayout();
    }
    assert.equal(await richBody.locator('math mfrac').count(), 1, 'Formula annotation reflow must preserve its whole MathML tree');
    assert.equal(await richBody.locator('mark[data-annotation-id="sentence-annotation-3"]').evaluateAll((nodes) => nodes.filter((node) => !node.textContent).length), 0, 'Formula-ending annotations must not leave empty marks');
    assert.equal(await richBody.evaluate((body) => {
      const clone = body.cloneNode(true);
      clone.querySelectorAll('button,.annotation-note-popover').forEach((control) => control.remove());
      return clone.textContent;
    }), richOriginal, 'Formula annotation reflow must preserve its original text');
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, [], `Unexpected requests: ${JSON.stringify(unexpected)}`);
    assert.deepEqual(diagnostics.routeErrors, [], `Route errors: ${JSON.stringify(diagnostics.routeErrors)}`);
    console.log(JSON.stringify({ passed: true, cases: ['paragraph-batch-and-sentence-order', 'translation-font-80-percent', 'continuous-English-flow', 'line-by-line-Chinese-layout', 'English-Chinese-row-start-alignment', 'nonoverlapping-Chinese-natural-wrap', 'responsive-width-and-font-reflow', 'realistic-one-English-one-Chinese-line', 'translated-copy-and-annotation-reflow', 'translated-hover-cache', 'canonical-cross-sentence-selection', 'source-only-highlight', 'atomic-formulas-and-citations', 'math-before-later-sup-token-order', 'leading-fraction-whole-box-alignment', 'lazy-image-load-realignment', 'translated-glyph-hit-targets', 'list-sentence-pairs', 'original-translation-bilingual-modes', 'engine-switch-retains-and-prompts', 'history-survives-reload', 'failed-refresh-retains', 'successful-refresh-replaces'], translationRequests: requests.length }));
  } catch (error) {
    await session.browser.contexts()[0]?.pages()[0]?.screenshot({ path: '/tmp/guzi-v069-sentence-failure.png' }).catch(() => {});
    diagnostics.annotationDraw = await session.browser.contexts()[0]?.pages()[0]?.evaluate(() => { window.__annotationDrawAudit?.stop(); return window.__annotationDrawAudit?.events; }).catch(() => null);
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
