'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2];
if (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA) throw new Error('Run with an isolated fixture server and MY_SCHOLAR_TEST_DATA; this suite writes settings and annotations.');

(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    const requests = [];
    const records = new Map();
    const geometryResponses = new Map();
    let fullRun = false;
    let translationTests = 0;
    let chatTests = 0;
    let transientFailure = true;
    const sentenceFixture = ['First sentence explains the experimental setup.', 'Middle sentence describes the main principle.', 'Final sentence states the conclusion.'];
    let releaseSentenceResponse;
    const sentenceResponse = new Promise((resolve) => { releaseSentenceResponse = resolve; });
    const richSentenceHTML = 'Inline citation <sup><a href="#ref-143">143,144</a></sup> uses '
      + '<math alttext="10^4"><msup><mn>10</mn><mn>4</mn></msup></math> and '
      + '<math alttext="x/y"><mfrac><mi>x</mi><mi>y</mi></mfrac></math> with H<sub>2</sub>O, '
      + '<strong>bold <span class="pdf-text-tone pdf-text-tone-blue">blue text</span></strong> and '
      + '<span class="inline-legend-marker inline-legend-marker-circle inline-legend-marker-blue"></span> '
      + 'a legend, literal &lt;img src=x onerror=alert(1)&gt; remains text.';
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedText = text; } } });
    });
    await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, ai: { services: { translation: { enabled: true, configured: true, profile_id: 'reader-experience', target_language: 'zh' }, chat: { enabled: true, configured: true, profile_id: 'reader-chat' } } } } }));
    await page.route('**/api/jobs/*/document.html?reader=1', async (route) => {
      const response = await route.fetch();
      let html = await response.text();
      const replaceParagraph = (blockId, content) => {
        const pattern = new RegExp(`(<p\\b[^>]*data-block-id="${blockId}"[^>]*>)[\\s\\S]*?(</p>)`);
        assert(pattern.test(html), `Missing reader fixture block ${blockId}`);
        html = html.replace(pattern, (_match, open, close) => `${open}${content}${close}`);
      };
      // Sentence ranges are built at mount time; fixture source must exist before mounting.
      replaceParagraph('block-1-2-paragraph', sentenceFixture.join(' ') + ['empty', 'no-space'].map((geometry) =>
        `</p><p data-block-id="reader-geometry-${geometry}">Geometry fixture checks ${geometry} sentence bounds.`).join(''));
      replaceParagraph('block-2-1-paragraph', richSentenceHTML);
      await route.fulfill({ response, body: html });
    });
    await page.route('**/api/jobs/*/translations', (route) => {
      const jobId = new URL(route.request().url()).pathname.split('/')[3];
      return route.fulfill({ json: { translations: records.get(jobId) || [] } });
    });
    await page.route('**/api/jobs/*/translate', async (route) => {
      const body = route.request().postDataJSON();
      const jobId = new URL(route.request().url()).pathname.split('/')[3];
      requests.push(body);
      if (!body.block_id && geometryResponses.has(body.text)) await geometryResponses.get(body.text);
      if (!body.block_id && body.text === sentenceFixture[0]) await sentenceResponse;
      if (!body.block_id && body.text === sentenceFixture[1] && transientFailure) {
        transientFailure = false;
        await route.fulfill({ status: 503, json: { error: 'temporary fixture failure' } });
        return;
      }
      if (fullRun) await new Promise((resolve) => setTimeout(resolve, 700));
      const richSentence = body.text.startsWith('Inline citation');
      const text = richSentence ? body.text.replace('Inline citation', '参考文献')
        : body.block_id ? '用于回归测试的段落译文。' : `${'当前句的长译文，保留全部细节供滚动查看，'.repeat(180)}结束。`;
      const result = { ...body, text, block_id: body.block_id || '', profile_id: 'reader-experience' };
      if (body.block_id || richSentence) {
        const previous = records.get(jobId) || [];
        records.set(jobId, [...previous.filter((item) => item.block_id !== result.block_id || item.source_hash !== result.source_hash), result]);
      }
      await route.fulfill({ json: { result } });
    });
    await page.route('**/api/jobs/*/auto-highlights', (route) => route.fulfill({ json: { result: { status: 'mock', highlights: [] } } }));
    await page.route('**/api/translation/test', (route) => {
      translationTests += 1;
      return route.fulfill({ json: { result: { ok: true, provider: 'deepl', elapsed_ms: 7 } } });
    });
    await page.route('**/api/ai/test', (route) => { chatTests += 1; return route.abort(); });
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('.library-card[data-status="completed"]').first().waitFor();
    const initialSettings = await (await page.request.get(`${baseURL}/api/settings`)).json();
    await page.locator('[data-view="settings-view"]').click();
    await page.locator('a[href="#settings-ai"]').click();
    await page.locator('#setting-translation-provider').selectOption('volcengine');
    await page.locator('#setting-translation-access-key-id').fill('isolated-fixture-ak');
    await page.locator('#setting-translation-secret-access-key').fill('isolated-fixture-sk');
    assert.equal(await page.locator('#setting-translation-model').isVisible(), false);
    assert.equal(await page.locator('#setting-chat-model').isVisible(), true);
    await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
    let saved = await (await page.request.get(`${baseURL}/api/settings`)).json();
    assert.equal(saved.ai.translation.provider, 'volcengine');
    assert.equal(saved.ai.translation.access_key_id_configured, true);
    assert.equal(saved.ai.translation.secret_access_key_configured, true);
    assert.deepEqual(saved.ai.chat, initialSettings.ai.chat, 'Translation provider changes mutated chat');
    await page.locator('#setting-translation-provider').selectOption('deepl');
    await page.locator('#setting-translation-deepl-tier').selectOption('pro');
    await page.locator('#setting-translation-api-key').fill('isolated-fixture-deepl');
    await page.locator('#test-translation-button').click();
    await page.locator('#translation-provider-test-result').filter({ hasText: '连接成功' }).waitFor();
    assert.equal(translationTests, 1);
    assert.equal(chatTests, 0, 'Independent translation test invoked the chat test');
    saved = await (await page.request.get(`${baseURL}/api/settings`)).json();
    assert.equal(saved.ai.translation.deepl_tier, 'pro');
    assert.equal(saved.ai.translation.provider, 'deepl');
    assert.equal(await page.locator('#setting-translation-access-key-id').isVisible(), false);
    assert.equal(await page.locator('#setting-translation-base-url').isVisible(), false);
    await page.locator('#setting-translation-deepl-tier').selectOption('free');
    await page.locator('#setting-translation-provider').selectOption('openai-compatible');
    assert.equal(await page.locator('#setting-translation-model').isVisible(), true);

    await page.locator('a[href="#settings-shortcuts"]').click();
    await page.locator('[data-annotation-builtin="underline_note"]').uncheck();
    await page.locator('#add-annotation-action').click();
    const custom = page.locator('.annotation-action-row').last();
    await custom.locator('[data-action-field="label"]').fill('原理段落');
    await custom.locator('[data-action-field="kind"]').selectOption('underline');
    await custom.locator('[data-action-field="color"]').fill('#2563eb');
    const actionId = await custom.getAttribute('data-annotation-action-id');
    await page.locator('#add-annotation-action').click();
    const secondCustom = page.locator('.annotation-action-row').last();
    await secondCustom.locator('[data-action-field="label"]').fill('方法段落');
    await secondCustom.locator('[data-action-field="kind"]').selectOption('highlight');
    const secondActionId = await secondCustom.getAttribute('data-annotation-action-id');
    await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
    saved = await (await page.request.get(`${baseURL}/api/settings`)).json();
    assert(saved.annotation_actions.hidden_builtin.includes('underline_note'));
    assert.equal(saved.annotation_actions.custom.find((item) => item.id === actionId).label, '原理段落');

    const enabledToggle = secondCustom.locator('[data-action-field="enabled"]');
    await enabledToggle.focus();
    await enabledToggle.press('Space');
    assert.equal(await enabledToggle.isChecked(), false);
    await enabledToggle.press('Space');
    assert.equal(await enabledToggle.isChecked(), true);
    await page.locator('#add-annotation-action').click();
    await page.locator('.annotation-action-row').last().locator('[data-remove-annotation-action]').click();
    assert.equal(await page.locator('.annotation-action-row').count(), 2);
    await page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
    saved = await (await page.request.get(`${baseURL}/api/settings`)).json();
    const savedAction = saved.annotation_actions.custom.find((item) => item.id === actionId);
    assert.equal(savedAction.kind, 'underline');
    assert.equal(savedAction.color, '#2563eb');
    assert.equal(saved.annotation_actions.custom.find((item) => item.id === secondActionId).enabled, true);
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1450, 800, 390]) {
        await page.setViewportSize({ width, height: 940 });
        await page.locator('.annotation-action-settings').scrollIntoViewIfNeeded();
        const controls = await page.locator('.annotation-action-settings').evaluate((section) => {
          const measure = (node) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return { width: rect.width, height: rect.height, appearance: style.appearance, fontSize: style.fontSize };
          };
          const rows = [...section.querySelectorAll('.annotation-action-row')];
          return {
            toggles: [...section.querySelectorAll('input[type="checkbox"]')].map(measure),
            fields: [...section.querySelectorAll('input[type="text"],select,input[type="color"],[data-remove-annotation-action]')].map(measure),
            overflowing: [...section.querySelectorAll('input,select,button')].some((node) => {
              const rect = node.getBoundingClientRect();
              const parent = section.getBoundingClientRect();
              return rect.left < parent.left - 1 || rect.right > parent.right + 1 || rect.right > innerWidth;
            }),
            rowOverflow: rows.some((row) => row.scrollWidth > row.clientWidth + 1),
          };
        });
        assert.equal(controls.overflowing || controls.rowOverflow, false, `Selection settings overflow at ${width}px in ${colorScheme}`);
        controls.toggles.forEach((toggle) => assert.deepEqual([toggle.width, toggle.height, toggle.appearance], [40, 24, 'none']));
        controls.fields.forEach((field) => assert.equal(field.height, 32));
        await page.locator('.annotation-action-settings').screenshot({ path: `/tmp/guzi-selection-settings-${colorScheme}-${width}.png` });
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1450, height: 940 });

    await page.screenshot({ path: '/tmp/guzi-reader-experience-settings.png' });
    await page.locator('[data-view="library-view"]').click();
    const cards = page.locator('.library-card[data-status="completed"]');
    const jobId = await cards.first().getAttribute('data-job-id');
    const secondJobId = await cards.nth(1).getAttribute('data-job-id');
    await cards.first().locator('.library-row-name').dblclick();
    const frame = page.frameLocator('#html-preview');
    const source = frame.locator('p[data-block-id]:has(.paragraph-translate-trigger)').first();
    await source.waitFor();
    await frame.locator('.title-translation:not(.is-pending):not(.is-error)').waitFor();
    const hoverText = async (locator, sentence = '') => {
      await locator.scrollIntoViewIfNeeded();
      const position = await locator.evaluate((node, sentence) => {
        const doc = node.ownerDocument;
        doc.getSelection().removeAllRanges();
        const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode()) && (!text.textContent.trim() || text.parentElement.closest('button'))) { /* skip controls and whitespace */ }
        const start = sentence ? text.textContent.indexOf(sentence) : 0;
        const range = doc.createRange();
        range.setStart(text, start);
        range.setEnd(text, sentence ? start + sentence.length : text.length);
        const rect = range.getClientRects()[0];
        const box = node.getBoundingClientRect();
        return { x: rect.left - box.left + 4, y: rect.top - box.top + rect.height / 2 };
      }, sentence);
      await locator.hover({ position });
    };
    const hoverSource = () => hoverText(source);
    const firstSourceSentence = (await source.evaluate((node) => { const copy = node.cloneNode(true); copy.querySelectorAll('button').forEach((item) => item.remove()); return copy.textContent.trim(); })).match(/^[^.!?。！？]+[.!?。！？]?/u)?.[0];
    const blockRequests = () => requests.filter((item) => !item.block_id && item.text === firstSourceSentence).length;
    const tooltip = page.locator('#selection-popover:not([hidden])');
    const hoverFeedback = () => frame.locator('body').evaluate(() => {
      const ranges = [...(CSS.highlights.get('my-scholar-sentence-hover') || [])];
      return {
        tooltip: Boolean(parent.document.querySelector('#selection-popover:not([hidden])')),
        ranges: ranges.map((range) => {
          const fragment = range.cloneContents();
          fragment.querySelectorAll('.annotation-note-trigger,.paragraph-translate-trigger').forEach((node) => node.remove());
          return {
            text: fragment.textContent.trim(),
            translated: Boolean((range.commonAncestorContainer.parentElement || range.commonAncestorContainer).closest('.my-scholar-translation')),
          };
        }),
        background: getComputedStyle(document.body, '::highlight(my-scholar-sentence-hover)').backgroundColor,
      };
    });
    const assertSourceFeedback = async (sentence) => {
      const feedback = await hoverFeedback();
      assert.equal(feedback.tooltip, true);
      assert.deepEqual(feedback.ranges, [{ text: sentence, translated: false }]);
      assert.notEqual(feedback.background, 'rgba(0, 0, 0, 0)', 'Sentence background is transparent');
    };
    const assertFeedbackCleared = async () => {
      await tooltip.waitFor({ state: 'detached' });
      const feedback = await hoverFeedback();
      assert.equal(feedback.tooltip, false);
      assert.deepEqual(feedback.ranges, []);
    };
    const assertTooltipOutsideSentence = async ({ multiline = false, above = false } = {}) => {
      const geometry = await tooltip.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const iframe = document.querySelector('#html-preview');
        const frameRect = iframe.getBoundingClientRect();
        const ranges = [...(iframe.contentWindow.CSS.highlights.get('my-scholar-sentence-hover') || [])];
        const lines = ranges.flatMap((range) => [...range.getClientRects()]).filter((line) => line.width && line.height).map((line) => ({ left: line.left + frameRect.left, right: line.right + frameRect.left, top: line.top + frameRect.top, bottom: line.bottom + frameRect.top }));
        return {
          tooltip: rect.toJSON(), lines,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          scrollable: node.querySelector('#selection-translation-result').scrollHeight > node.querySelector('#selection-translation-result').clientHeight,
        };
      });
      const { tooltip: box, lines } = geometry;
      assert(lines.length > 0);
      if (multiline) assert(new Set(lines.map((line) => Math.round(line.top))).size > 1, 'Fixture sentence did not span multiple lines');
      assert(lines.every((line) => box.bottom <= line.top || box.top >= line.bottom), `Tooltip overlaps its source sentence: ${JSON.stringify(geometry)}`);
      assert(box.left >= 0 && box.right <= geometry.viewportWidth && box.top >= 0 && box.bottom <= geometry.viewportHeight, JSON.stringify(geometry));
      assert(geometry.scrollable, 'Long translation lost its scrollable height limit');
      if (above) assert(box.bottom <= Math.min(...lines.map((line) => line.top)), 'Tooltip did not use the space above a sentence near the viewport bottom');
    };
    const waitForPointerFrame = () => frame.locator('body').evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await hoverSource();
    await waitForPointerFrame();
    await assertFeedbackCleared();
    await tooltip.filter({ hasText: '结束。' }).waitFor().catch(async (error) => { console.error(JSON.stringify({ errors, requests, debug: await source.evaluate((node) => ({ ready: node.ownerDocument.documentElement.dataset.sentenceHoverReady, html: node.innerHTML.slice(0,700), box: node.getBoundingClientRect().toJSON(), body: node.ownerDocument.defaultView.parent.document.querySelector('#selection-popover:not([hidden])')?.outerHTML, selected: node.ownerDocument.getSelection()?.toString() })) })); await page.screenshot({ path: '/tmp/guzi-reader-experience-failure.png' }); throw error; });
    assert.equal(blockRequests(), 1);
    const tooltipGeometry = await tooltip.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { height: rect.height, top: rect.top, bottom: rect.bottom, width: rect.width, scrollable: node.querySelector('#selection-translation-result').scrollHeight > node.querySelector('#selection-translation-result').clientHeight, viewportHeight: innerHeight, buttons: node.querySelectorAll('.selection-actions button').length };
    });
    assert(tooltipGeometry.scrollable && tooltipGeometry.top >= 0 && tooltipGeometry.bottom <= tooltipGeometry.viewportHeight);
    assert(tooltipGeometry.buttons > 0, 'Hover exposes sentence actions');
    await assertTooltipOutsideSentence();
    assert.equal(requests.filter((item) => !item.block_id).at(-1).text, firstSourceSentence);
    await assertSourceFeedback(firstSourceSentence);
    await tooltip.locator('#selection-translation-result').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    assert(await tooltip.locator('#selection-translation-result').evaluate((node) => node.scrollTop > 0));
    await assertSourceFeedback(firstSourceSentence);
    await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await assertFeedbackCleared();
    await hoverSource();
    await tooltip.filter({ hasText: '结束。' }).waitFor();
    assert.equal(blockRequests(), 1, 'Hover requested a cached block again');
    assert.equal(await frame.locator('.reader-sentence-hover-fallback').count(), 0);
    await assertSourceFeedback(firstSourceSentence);
    await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await assertFeedbackCleared();

    const fixtureParagraph = frame.locator('p[data-block-id="block-1-2-paragraph"]');
    const fixtureId = await fixtureParagraph.getAttribute('data-block-id');
    await fixtureParagraph.locator('.paragraph-translate-trigger').click();
    await frame.locator(`.my-scholar-translation[data-for="${fixtureId}"]:not(.is-pending)`).waitFor();
    const hoverSentence = (sentence) => hoverText(fixtureParagraph, sentence);
    for (const sentence of sentenceFixture) {
      await hoverSentence(sentence);
      if (sentence === sentenceFixture[0]) {
        await tooltip.filter({ hasText: '正在翻译当前句' }).waitFor();
        await assertSourceFeedback(sentence);
        await frame.locator('body').evaluate(() => document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1, clientY: 1 })));
        await assertFeedbackCleared();
        const response = page.waitForResponse((item) => item.url().endsWith('/translate') && item.request().postDataJSON().text === sentence);
        releaseSentenceResponse();
        await (await response).finished();
        await waitForPointerFrame();
        await assertFeedbackCleared();
        await hoverSentence(sentence);
      }
      if (sentence === sentenceFixture[1]) {
        await tooltip.filter({ hasText: 'temporary fixture failure' }).waitFor();
        await assertSourceFeedback(sentence);
        await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
        await hoverSentence(sentence);
      }
      await tooltip.filter({ hasText: '结束。' }).waitFor();
      await assertSourceFeedback(sentence);
      assert.equal(requests.filter((item) => !item.block_id).at(-1).text, sentence, 'Hover translated a paragraph or guessed a sentence by position');
      const count = requests.length;
      await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      await hoverSentence(sentence);
      await tooltip.filter({ hasText: '结束。' }).waitFor();
      await assertSourceFeedback(sentence);
      assert.equal(requests.length, count, 'Repeated sentence hover bypassed the exact sentence cache');
      await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      await assertFeedbackCleared();
    }
    assert.equal(requests.filter((item) => !item.block_id && item.text === sentenceFixture[1]).length, 2, 'A failed sentence request could not be retried');
    await hoverSentence(sentenceFixture[0]);
    await tooltip.filter({ hasText: '结束。' }).waitFor();
    await hoverSentence(sentenceFixture[2]);
    await waitForPointerFrame();
    await assertFeedbackCleared();
    await tooltip.filter({ hasText: '结束。' }).waitFor();
    await assertSourceFeedback(sentenceFixture[2]);
    await frame.locator('body').evaluate(() => document.dispatchEvent(new Event('scroll')));
    await assertFeedbackCleared();
    await fixtureParagraph.evaluate((node) => { node.style.maxWidth = '240px'; });
    for (const width of [1450, 680]) {
      await page.setViewportSize({ width, height: 940 });
      await hoverSentence(sentenceFixture[2]);
      await tooltip.filter({ hasText: '结束。' }).waitFor();
      await assertTooltipOutsideSentence({ multiline: true });
      await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    }
    await page.setViewportSize({ width: 1450, height: 940 });
    await fixtureParagraph.evaluate((node) => {
      node.style.marginTop = `${innerHeight}px`;
      const rect = node.getBoundingClientRect();
      node.ownerDocument.defaultView.scrollBy(0, rect.bottom - innerHeight + 80);
    });
    await hoverSentence(sentenceFixture[2]);
    await tooltip.filter({ hasText: '结束。' }).waitFor();
    await assertTooltipOutsideSentence({ multiline: true, above: true });
    await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await fixtureParagraph.evaluate((node) => { node.style.maxWidth = ''; node.style.marginTop = ''; });
    for (const geometry of ['empty', 'no-space']) {
      const sentence = `Geometry fixture checks ${geometry} sentence bounds.`;
      let releaseGeometryResponse;
      geometryResponses.set(sentence, new Promise((resolve) => { releaseGeometryResponse = resolve; }));
      const geometryParagraph = frame.locator(`p[data-block-id="reader-geometry-${geometry}"]`);
      await geometryParagraph.locator('.paragraph-translate-trigger').click();
      await frame.locator(`.my-scholar-translation[data-for="reader-geometry-${geometry}"]:not(.is-pending)`).waitFor();
      await hoverText(geometryParagraph, sentence);
      await tooltip.filter({ hasText: '正在翻译当前句' }).waitFor();
      await tooltip.evaluate((_node, geometry) => {
        const view = document.querySelector('#html-preview').contentWindow;
        const range = [...view.CSS.highlights.get('my-scholar-sentence-hover')][0];
        range.getClientRects = () => geometry === 'empty' ? [] : [{ left: 12, right: 100, top: 0, bottom: view.innerHeight, width: 88, height: view.innerHeight }];
      }, geometry);
      const response = page.waitForResponse((item) => item.url().endsWith('/translate') && item.request().postDataJSON().text === sentence);
      releaseGeometryResponse();
      await (await response).finished();
      if (geometry === 'empty') await tooltip.waitFor({ state: 'detached' });
      else {
        await tooltip.locator('#selection-translation-result[data-state="ready"]').filter({ hasText: '结束。' }).waitFor();
        const constrained = await tooltip.evaluate((node) => {
          const box = node.getBoundingClientRect();
          const wrap = document.querySelector('.reader-frame-wrap').getBoundingClientRect();
          const result = node.querySelector('#selection-translation-result');
          result.scrollTop = result.scrollHeight;
          return { box: box.toJSON(), wrap: wrap.toJSON(), resultHeight: result.clientHeight, scrollTop: result.scrollTop };
        });
        assert(constrained.box.left >= constrained.wrap.left && constrained.box.right <= constrained.wrap.right
          && constrained.box.top >= constrained.wrap.top && constrained.box.bottom <= constrained.wrap.bottom,
        `A constrained sentence toolbar must remain inside the reading area: ${JSON.stringify(constrained)}`);
        assert(constrained.resultHeight > 0 && constrained.scrollTop > 0,
          `A constrained sentence toolbar must retain a visible, scrollable translation: ${JSON.stringify(constrained)}`);
      }
      await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    }
    await source.scrollIntoViewIfNeeded();

    const selectOriginalSource = async () => {
    await source.evaluate((node) => {
      const doc = node.ownerDocument;
      const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode()) && text.textContent.trim().length < 20) { /* use the first real sentence */ }
      const range = doc.createRange();
      range.setStart(text, 0); range.setEnd(text, Math.min(text.length, 30));
      doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    };
    await selectOriginalSource();
    await page.locator('#selection-popover:not([hidden])').waitFor();
    assert.equal(await page.locator('#selection-underline-note').isVisible(), false);
    await page.locator('#selection-copy').click();
    assert(await page.evaluate(() => window.__copiedText?.length > 0));
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/jobs/${jobId}/annotations`) && response.request().method() === 'POST').catch(async (error) => { console.error(JSON.stringify({ errors, toast: await page.locator('#toast').textContent(), status: await page.locator('#chat-status').textContent(), popover: await page.locator('#selection-popover').getAttribute('hidden') })); throw error; }),
      page.locator(`[data-semantic-action="${actionId}"]`).click(),
    ]);
    const annotationData = await (await page.request.get(`${baseURL}/api/jobs/${jobId}/annotations`)).json();
    const semantic = annotationData.annotations.find((item) => item.action_id === actionId);
    assert(semantic, 'Semantic annotation was not persisted');
    assert.equal(semantic.label, '原理段落');
    assert.equal(semantic.kind, 'underline');
    assert.equal(semantic.color, '#2563eb');
    const underline = frame.locator(`mark.my-scholar-underline[data-annotation-id="${semantic.id}"]`);
    await hoverText(underline);
    await tooltip.filter({ hasText: '结束。' }).waitFor();
    await assertSourceFeedback(firstSourceSentence);
    await assertTooltipOutsideSentence();
    const mark = frame.locator(`.annotation-note-trigger[data-annotation-id="${semantic.id}"]`);
    await mark.click();
    await assertFeedbackCleared();
    await frame.locator('.annotation-note-popover-head strong').filter({ hasText: '原理段落' }).waitFor();
    await frame.locator('.annotation-note-popover [data-action="close"]').click();
    await selectOriginalSource();
    await page.locator('#selection-popover:not([hidden])').waitFor();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/jobs/${jobId}/annotations`) && response.request().method() === 'POST'),
      page.locator(`[data-semantic-action="${secondActionId}"]`).click(),
    ]);
    const overlapping = await (await page.request.get(`${baseURL}/api/jobs/${jobId}/annotations`)).json();
    const secondSemantic = overlapping.annotations.find((item) => item.action_id === secondActionId);
    assert.equal(secondSemantic.quote, semantic.quote);
    await frame.locator(`.annotation-note-trigger[data-annotation-id="${semantic.id}"]`).waitFor();
    await frame.locator(`.annotation-note-trigger[data-annotation-id="${secondSemantic.id}"]`).waitFor();
    assert.equal(secondSemantic.kind, 'highlight');
    await hoverText(frame.locator(`mark.my-scholar-highlight[data-annotation-id="${secondSemantic.id}"]`));
    await tooltip.filter({ hasText: '结束。' }).waitFor();
    await assertSourceFeedback(firstSourceSentence);
    await assertTooltipOutsideSentence();
    await frame.locator(`.annotation-note-trigger[data-annotation-id="${secondSemantic.id}"]`).click();
    await assertFeedbackCleared();
    await frame.locator('.annotation-note-popover-head strong').filter({ hasText: '方法段落' }).waitFor();

    fullRun = true;
    await page.locator('#full-translate-button').click();
    await page.locator('#translation-progress:not([hidden])').waitFor();
    const layout = await page.evaluate(() => {
      const tray = document.querySelector('#background-tasks').getBoundingClientRect();
      const article = document.querySelector('#html-preview').getBoundingClientRect();
      const input = document.querySelector('#chat-input').getBoundingClientRect();
      return { trayBottom: tray.bottom, articleTop: article.top, inputTop: input.top, inputBottom: input.bottom, viewport: innerHeight, position: getComputedStyle(document.querySelector('#background-tasks')).position };
    });
    await page.screenshot({ path: '/tmp/guzi-reader-experience-progress.png' });
    assert.equal(layout.position, 'relative');
    assert(layout.trayBottom <= layout.articleTop && layout.trayBottom <= layout.inputTop && layout.inputBottom <= layout.viewport, JSON.stringify(layout));
    await page.locator('[data-view="library-view"]').click();
    await page.locator(`#library-view .library-card[data-job-id="${secondJobId}"] .library-row-name`).dblclick();
    const backgroundCard = page.locator(`[data-task-id="translation:${jobId}"]`);
    await backgroundCard.waitFor();
    await backgroundCard.locator('[data-task-open]').click();
    await page.locator(`#document-tabs .document-tab.active[data-job-id="${jobId}"]`).waitFor();
    await page.locator('#stop-translation-button').click();
    await page.locator('#translation-progress').waitFor({ state: 'hidden' });
    const reopened = page.frameLocator('#html-preview');
    const reopenedTrigger = reopened.locator(`.annotation-note-trigger[data-annotation-id="${semantic.id}"]`);
    await reopenedTrigger.hover();
    await tooltip.filter({ hasText: '结束。' }).waitFor();
    await assertSourceFeedback(firstSourceSentence);
    await reopenedTrigger.click();
    await assertFeedbackCleared();
    await reopened.locator('.annotation-note-popover-head strong').filter({ hasText: '原理段落' }).waitFor();
    await reopened.locator('.annotation-note-popover [data-action="close"]').click();
    const scrolling = await page.evaluate(() => ({ tabs: getComputedStyle(document.querySelector('#document-tabs')).scrollbarWidth, panel: getComputedStyle(document.querySelector('#chat-messages')).scrollbarWidth }));
    assert.equal(scrolling.tabs, 'none');
    assert.equal(scrolling.panel, 'thin');
    const originalFontScale = await page.locator('#font-size-range').inputValue();
    for (const scale of [100, 120, 200]) {
      await page.locator('#font-size-range').evaluate((node, value) => {
        node.value = String(value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      }, scale);
      const typography = await page.evaluate(() => {
        const chat = document.createElement('div');
        chat.className = 'chat-bubble assistant';
        chat.innerHTML = '<div class="chat-message-body"><div class="chat-markdown"><p>回答正文 Answer</p></div></div>';
        document.querySelector('#chat-messages').append(chat);
        const highlight = document.createElement('article');
        highlight.className = 'highlight-card is-suggested';
        highlight.innerHTML = '<button class="highlight-card-main"><span class="highlight-card-quote">阅读重点 Highlight</span></button>';
        document.querySelector('#highlights-list').append(highlight);
        const note = document.createElement('div');
        note.innerHTML = '<p>笔记正文 Note</p><ul><li>笔记列表</li></ul><blockquote>笔记引用</blockquote><h2>笔记标题</h2>';
        document.querySelector('#notes-editor').append(note);
        try {
          const measure = (node) => {
            const style = getComputedStyle(node);
            return { size: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) };
          };
          return {
            chat: measure(chat.querySelector('p')),
            bodies: [highlight.querySelector('.highlight-card-quote'), ...note.querySelectorAll('p,li,blockquote')].map(measure),
            heading: measure(note.querySelector('h2')),
          };
        } finally { chat.remove(); highlight.remove(); note.remove(); }
      });
      assert(Math.abs(typography.chat.size - 13 * scale / 100) < .1);
      typography.bodies.forEach((body) => assert.deepEqual(body, typography.chat, `Sidebar text differs from chat at ${scale}%`));
      assert(typography.heading.size > typography.chat.size, 'Note headings lost their hierarchy');
    }
    await page.locator('#font-size-range').evaluate((node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, originalFontScale);

    fullRun = false;
    const richRequests = () => requests.filter((item) => !item.block_id && item.text.startsWith('Inline citation')).length;
    const installRichSentence = async () => {
      const paragraph = frame.locator('p[data-block-id="block-2-1-paragraph"]');
      await paragraph.locator('.paragraph-translate-trigger').click();
      const blockId = await paragraph.getAttribute('data-block-id');
      await frame.locator(`.my-scholar-translation[data-for="${blockId}"]:not(.is-pending)`).waitFor();
      return paragraph;
    };
    const hoverRichSentence = async (paragraph) => {
      await hoverText(paragraph);
      await tooltip.filter({ hasText: '参考文献' }).waitFor();
      const rendered = await tooltip.locator('#selection-translation-result').evaluate((node) => ({
        text: node.textContent,
        citation: node.querySelector('sup')?.textContent,
        subscript: node.querySelector('sub')?.textContent,
        power: node.querySelector('math msup')?.textContent,
        fraction: node.querySelector('math mfrac')?.textContent,
        nestedTone: node.querySelector('strong > .pdf-text-tone-blue')?.textContent,
        marker: node.querySelectorAll('.inline-legend-marker-circle.inline-legend-marker-blue').length,
        images: node.querySelectorAll('img').length,
      }));
      assert.doesNotMatch(rendered.text, /__MY_SCHOLAR_/, 'Internal formatting token leaked into hover translation');
      assert.deepEqual([rendered.citation, rendered.subscript, rendered.power, rendered.fraction, rendered.nestedTone, rendered.marker, rendered.images], ['143,144', '2', '104', 'xy', 'blue text', 1, 0]);
      assert.match(rendered.text, /<img src=x onerror=alert\(1\)>/, 'Translation text must not become HTML');
      const feedback = await hoverFeedback();
      assert.equal(feedback.ranges.length, 1);
      assert.equal(feedback.ranges[0].translated, false);
    };
    let richParagraph = await installRichSentence();
    await hoverRichSentence(richParagraph);
    assert.equal(richRequests(), 1);
    await frame.locator('body').evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await assertFeedbackCleared();
    await hoverRichSentence(richParagraph);
    assert.equal(richRequests(), 1, 'Formatted hover bypassed the memory cache');

    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-view="library-view"]').click();
    await page.locator(`#library-view .library-card[data-job-id="${jobId}"] .library-row-name`).dblclick();
    await frame.locator('p[data-block-id] .paragraph-translate-trigger').first().waitFor();
    richParagraph = await installRichSentence();
    await page.emulateMedia({ colorScheme: 'dark' });
    await hoverRichSentence(richParagraph);
    assert.equal(richRequests(), 1, 'Formatted hover bypassed the persisted cache after reload');
    await page.screenshot({ path: '/tmp/guzi-hover-translation-format-fixed.png' });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, cases: ['provider-isolation-and-credentials', 'deepl-free-pro', 'independent-translation-test', 'toolbar-customization', 'selection-settings-theme-layout-keyboard-and-persistence', 'semantic-snapshot-persistence', 'hover-cache-and-long-text', 'multiline-hover-does-not-cover-source', 'narrow-hover-and-long-text-scroll', 'hover-above-viewport-bottom-sentence', 'highlight-and-underline-real-mouse-hover', 'annotation-note-click-after-hover', 'source-only-hover-background', 'synchronized-hover-feedback-lifecycle', 'late-translation-does-not-restore-hover', 'exact-first-middle-last-sentence', 'failed-hover-retry', 'overlapping-semantic-actions', 'inline-progress-and-background-stop', 'contextual-scrollbars', 'sidebar-body-typography-matches-chat-at-all-scales', 'hover-citation-math-marker-and-emphasis-rendering', 'hover-formatted-memory-and-persisted-cache', 'hover-translation-text-is-not-html'], annotationId: semantic.id }));
  } finally { await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
