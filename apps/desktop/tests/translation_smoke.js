const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
let blockId = process.argv[3] || '';
const requestedJobId = process.argv[4] || '';
let browser;
let browserSession;

(async () => {
  browserSession = await launchManagedChromium();
  browser = browserSession.browser;
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  page.setDefaultTimeout(120000);
  const errors = [];
  let translationPostCount = 0;
  const translationPostBlocks = [];
  const translationPostPayloads = [];
  const translationRecords = new Map();
  let translationInFlight = 0;
  let fullTranslationStarted = false;
  let fullTranslationPeakConcurrency = 0;
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/jobs\/[^/]+\/translate$/u.test(new URL(request.url()).pathname)) {
      translationPostCount += 1;
      const payload = request.postDataJSON() || {};
      translationPostBlocks.push(String(payload.block_id || ''));
      translationPostPayloads.push({ blockId: String(payload.block_id || ''), sourceHash: String(payload.source_hash || ''), text: String(payload.text || '') });
    }
  });
  await page.route('**/api/health', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, service: 'my-scholar', version: '0.1', shell: 'reference', ai: { services: { translation: { enabled: true, configured: true, model: 'translation-smoke', profile_id: 'translation-smoke-profile' }, chat: { enabled: true, configured: true, model: 'chat-smoke', profile_id: 'chat-smoke-profile' } } } }),
  }));
  await page.route('**/api/jobs/*/translations', async (route) => {
    const match = new URL(route.request().url()).pathname.match(/^\/api\/jobs\/([^/]+)\/translations$/u);
    const records = match ? translationRecords.get(match[1]) || [] : [];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ translations: records }) });
  });
  await page.route('**/api/jobs/*/translate', async (route) => {
    translationInFlight += 1;
    if (fullTranslationStarted) fullTranslationPeakConcurrency = Math.max(fullTranslationPeakConcurrency, translationInFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const request = route.request();
      const match = new URL(request.url()).pathname.match(/^\/api\/jobs\/([^/]+)\/translate$/u);
      const payload = request.postDataJSON();
      const result = {
        text: `测试译文：${String(payload.text || '')}`,
        block_id: payload.block_id || '',
        source_hash: payload.source_hash || '',
        target_language: payload.target_language || '中文',
        formulas: Array.isArray(payload.formulas) ? payload.formulas : [],
        profile_id: 'translation-smoke-profile',
        cached: false,
      };
      if (match && result.block_id) {
        const records = translationRecords.get(match[1]) || [];
        const index = records.findIndex((record) => record.block_id === result.block_id && record.source_hash === result.source_hash && record.target_language === result.target_language && record.profile_id === result.profile_id);
        if (index >= 0) records[index] = result; else records.push(result);
        translationRecords.set(match[1], records);
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result }) });
    } finally {
      translationInFlight -= 1;
    }
  });
  await page.route('**/api/jobs/*/auto-highlights', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ result: { status: 'mock', highlights: [] } }),
  }));

  async function openFirstDocument() {
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    const card = requestedJobId ? page.locator(`.library-card[data-job-id="${requestedJobId}"]`).first() : page.locator('.library-card[data-status="completed"]').first();
    await card.waitFor();
    await card.locator('.library-row-name').dblclick();
    await page.locator('#reader-view.active-view').waitFor();
    await page.locator('#reader-sidebar.is-open').waitFor();
    const frame = page.frameLocator('#html-preview');
    if (!blockId) {
      const firstTranslatable = frame.locator('p[data-block-id] .paragraph-translate-trigger').first();
      await firstTranslatable.waitFor();
      blockId = await firstTranslatable.locator('xpath=..').getAttribute('data-block-id');
    } else {
      await frame.locator(`[data-block-id="${blockId}"] .paragraph-translate-trigger`).waitFor();
    }
    if (!blockId) throw new Error('Document did not expose a translatable paragraph block');
    return frame;
  }

  let frame = await openFirstDocument();
  const translationSpacingFixture = await frame.locator('.reader-content').evaluate((root) => {
    const pages = [...root.querySelectorAll('.pdf-page')];
    let referenceGap = null;
    for (const page of pages) {
      const paragraphs = [...page.children].filter((node) => node.matches('p[data-block-id]'));
      for (let index = 0; index + 1 < paragraphs.length; index += 1) {
        const current = paragraphs[index];
        const next = paragraphs[index + 1];
        if (current.nextElementSibling !== next) continue;
        const gap = next.getBoundingClientRect().top - current.getBoundingClientRect().bottom;
        if (gap > 0.5) { referenceGap = gap; break; }
      }
      if (referenceGap != null) break;
    }
    let boundary = null;
    for (let index = 0; index + 1 < pages.length; index += 1) {
      const currentContent = [...pages[index].children].filter((node) => !node.classList.contains('page-label'));
      const nextContent = [...pages[index + 1].children].filter((node) => !node.classList.contains('page-label'));
      const source = currentContent.at(-1);
      const following = nextContent[0];
      if (!source?.matches('p[data-block-id]') || !following?.matches('p[data-block-id]') || !source.querySelector('.paragraph-translate-trigger')) continue;
      boundary = { sourceId: source.dataset.blockId, followingId: following.dataset.blockId };
      break;
    }
    return { referenceGap, boundary };
  });
  if (!(translationSpacingFixture.referenceGap > 0) || !translationSpacingFixture.boundary) throw new Error(`Document fixture did not expose a measurable cross-page translation boundary (${JSON.stringify(translationSpacingFixture)})`);
  const title = frame.locator('h1.paper-title[data-block-id]').first();
  await title.waitFor();
  const titleBlockId = await title.getAttribute('data-block-id');
  const titleTranslation = frame.locator(`.my-scholar-translation.title-translation[data-for="${titleBlockId}"]:not(.is-pending):not(.is-error)`);
  await titleTranslation.waitFor();
  if (!/[\u3400-\u9fff]/u.test((await titleTranslation.textContent()) || '')) throw new Error('Paper title did not receive its Chinese translation');
  if (await frame.locator('.paper-metadata .paragraph-translate-trigger').count()) throw new Error('Author or affiliation metadata exposed a translation control');
  if (await frame.locator('.paper-metadata + .my-scholar-translation').count()) throw new Error('Cached translation was rendered under author or affiliation metadata');
  await frame.locator(`[data-block-id="${blockId}"] .paragraph-translate-trigger`).click();
  const translation = frame.locator(`.my-scholar-translation[data-for="${blockId}"]:not(.is-pending):not(.is-error)`);
  await translation.waitFor();
  const translatedText = (await translation.locator('.translation-text').textContent() || '').trim();
  if (!/[\u3400-\u9fff]/u.test(translatedText)) throw new Error('Remote translation did not contain Chinese text');
  if (/<think>/i.test(translatedText)) throw new Error('Thinking trace leaked into the rendered translation');
  if (await translation.locator(':scope > span').count()) throw new Error('Translation still rendered a separate 译 badge');

  const searchQuery = await frame.locator(`[data-block-id="${blockId}"]`).evaluate((node) => {
    const value = (node.textContent || '').trim().match(/[A-Za-z][A-Za-z0-9-]{2,}/u)?.[0];
    return value || (node.textContent || '').trim().slice(0, 3);
  });
  await page.keyboard.press('Control+f');
  await page.locator('#reader-search:not([hidden])').waitFor();
  await page.locator('#reader-search-input').fill(searchQuery);
  await page.locator('#reader-search-count').waitFor({ state: 'visible' });
  const searchCount = await page.locator('#reader-search-count').textContent();
  if (!/^\d+\/\d+$/u.test(String(searchCount || '').trim())) throw new Error(`Reader search did not report match count (${searchCount})`);
  const searchState = await frame.locator('body').evaluate(() => ({
    custom: Boolean(document.defaultView.CSS?.highlights?.has('my-scholar-reader-search')),
    fallback: document.querySelectorAll('mark.reader-search-match').length,
  }));
  if (!searchState.custom && !searchState.fallback) throw new Error('Reader search did not render a visible match');
  await page.keyboard.press('Escape');
  await page.locator('#reader-search[hidden]').waitFor({ state: 'attached' });

  const sentenceHoverState = await frame.locator(`[data-block-id="${blockId}"]`).evaluate((source) => {
    const doc = source.ownerDocument;
    const walker = doc.createTreeWalker(source, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode()) && !textNode.nodeValue.trim()) { /* advance past blank text nodes */ }
    if (!textNode) return { ready: false, reason: 'source has no text node' };
    const range = doc.createRange();
    range.selectNodeContents(textNode);
    const rect = [...range.getClientRects()].find((item) => item.width && item.height);
    if (!rect) return { ready: false, reason: 'source text has no layout rect' };
    doc.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + Math.min(4, rect.width / 2), clientY: rect.top + rect.height / 2 }));
    return { ready: true };
  });
  if (!sentenceHoverState.ready) throw new Error(`Sentence hover fixture unavailable (${sentenceHoverState.reason})`);
  await frame.locator('body').evaluate(async () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const hoverState = await frame.locator('body').evaluate(() => ({
    custom: Boolean(document.defaultView.CSS?.highlights?.has('my-scholar-sentence-hover')),
    customRanges: document.defaultView.CSS?.highlights?.get('my-scholar-sentence-hover')?.size || 0,
    fallback: document.querySelectorAll('.reader-sentence-hover-fallback').length,
  }));
  if ((hoverState.custom && hoverState.customRanges < 2) || (!hoverState.custom && hoverState.fallback < 2)) throw new Error(`Hovering a sentence did not link source and translation (${JSON.stringify(hoverState)})`);

  const reverseHoverState = await frame.locator(`.my-scholar-translation[data-for="${blockId}"]`).evaluate((translation) => {
    const doc = translation.ownerDocument;
    const walker = doc.createTreeWalker(translation, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode()) && !textNode.nodeValue.trim()) { /* advance past blank text nodes */ }
    if (!textNode) return { ready: false, reason: 'translation has no text node' };
    const range = doc.createRange();
    range.selectNodeContents(textNode);
    const rect = [...range.getClientRects()].find((item) => item.width && item.height);
    if (!rect) return { ready: false, reason: 'translation text has no layout rect' };
    doc.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + Math.min(4, rect.width / 2), clientY: rect.top + rect.height / 2 }));
    return { ready: true };
  });
  if (!reverseHoverState.ready) throw new Error(`Reverse sentence hover fixture unavailable (${reverseHoverState.reason})`);
  await frame.locator('body').evaluate(async () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const reverseHoverResult = await frame.locator('body').evaluate(() => ({
    custom: Boolean(document.defaultView.CSS?.highlights?.has('my-scholar-sentence-hover')),
    customRanges: document.defaultView.CSS?.highlights?.get('my-scholar-sentence-hover')?.size || 0,
    fallback: document.querySelectorAll('.reader-sentence-hover-fallback').length,
  }));
  if ((reverseHoverResult.custom && reverseHoverResult.customRanges < 2) || (!reverseHoverResult.custom && reverseHoverResult.fallback < 2)) throw new Error(`Hovering a translation did not link source and translation (${JSON.stringify(reverseHoverResult)})`);

  const boundaryBlockId = translationSpacingFixture.boundary.sourceId;
  let boundaryTranslation = frame.locator(`.my-scholar-translation[data-for="${boundaryBlockId}"]:not(.is-pending):not(.is-error)`);
  if (!(await boundaryTranslation.count())) {
    await frame.locator(`[data-block-id="${boundaryBlockId}"] .paragraph-translate-trigger`).click();
    boundaryTranslation = frame.locator(`.my-scholar-translation[data-for="${boundaryBlockId}"]:not(.is-pending):not(.is-error)`);
    await boundaryTranslation.waitFor();
  }
  const translationSpacing = await boundaryTranslation.evaluate((node, fixture) => {
    const source = node.previousElementSibling;
    const currentPage = source?.closest('.pdf-page');
    const nextPage = currentPage?.nextElementSibling;
    const following = nextPage?.querySelector(`[data-block-id="${CSS.escape(fixture.boundary.followingId)}"]`);
    const sourceRect = source?.getBoundingClientRect();
    const translationRect = node.getBoundingClientRect();
    const followingRect = following?.getBoundingClientRect();
    return {
      sourceIsAdjacent: source?.dataset?.blockId === fixture.boundary.sourceId,
      followingIsNextPage: Boolean(nextPage?.classList.contains('pdf-page') && following),
      referenceGap: fixture.referenceGap,
      sourceGap: sourceRect ? translationRect.top - sourceRect.bottom : -1,
      followingGap: followingRect ? followingRect.top - translationRect.bottom : -1,
      translationMarginBottom: parseFloat(getComputedStyle(node).marginBottom),
    };
  }, translationSpacingFixture);
  const sourceGapRatio = translationSpacing.sourceGap / translationSpacing.referenceGap;
  const followingGapDelta = Math.abs(translationSpacing.followingGap - translationSpacing.translationMarginBottom);
  if (!translationSpacing.sourceIsAdjacent || !translationSpacing.followingIsNextPage || translationSpacing.sourceGap < 0 || sourceGapRatio > 0.5 || !(translationSpacing.translationMarginBottom > 0) || followingGapDelta > 1) throw new Error(`Cross-page translation spacing did not preserve source grouping and paragraph rhythm (${JSON.stringify({ ...translationSpacing, sourceGapRatio, followingGapDelta })})`);

  const formulaSource = frame.locator('p[data-block-id]:has(math):has(.paragraph-translate-trigger)').first();
  await formulaSource.waitFor();
  const formulaBlockId = await formulaSource.getAttribute('data-block-id');
  await formulaSource.locator('.paragraph-translate-trigger').click();
  const formulaTranslation = frame.locator(`.my-scholar-translation[data-for="${formulaBlockId}"]:not(.is-pending):not(.is-error)`);
  await formulaTranslation.waitFor();
  await formulaTranslation.locator('.translation-text math.translation-math').first().waitFor();
  const formulaTranslationText = (await formulaTranslation.locator('.translation-text').textContent() || '').trim();
  if (/__MY_SCHOLAR_(?:MATH|RENDER_MATH)_/u.test(formulaTranslationText)) throw new Error(`Formula placeholder leaked into the translation (${formulaTranslationText})`);

  await frame.locator(`[data-block-id="${blockId}"]`).evaluate((block) => {
    const trigger = block.querySelector('.paragraph-translate-trigger');
    const token = document.createElement('span');
    token.className = 'math-token';
    token.dataset.token = '[I_CLS]';
    token.setAttribute('translate', 'no');
    token.innerHTML = '[I<sub>CLS</sub>]';
    block.replaceChildren(document.createTextNode('The special token '), token, document.createTextNode(' remains unchanged during translation.'), trigger);
  });
  await frame.locator(`[data-block-id="${blockId}"] .paragraph-translate-trigger`).click();
  const tokenTranslation = frame.locator(`.my-scholar-translation[data-for="${blockId}"]:not(.is-pending):not(.is-error)`);
  await tokenTranslation.waitFor();
  const tokenTranslationText = (await tokenTranslation.locator('.translation-text').textContent() || '').trim();
  if (!tokenTranslationText.includes('[I_CLS]')) throw new Error(`Special token was not restored exactly (${tokenTranslationText})`);
  if (/__MY_SCHOLAR_SPECIAL_TOKEN_/u.test(tokenTranslationText) || tokenTranslationText.includes('[I CLS]')) throw new Error(`Special-token placeholder leaked or changed (${tokenTranslationText})`);

  await frame.locator(`[data-block-id="${blockId}"]`).evaluate((block) => {
    const trigger = block.querySelector('.paragraph-translate-trigger');
    const marker = document.createElement('span');
    marker.className = 'inline-legend-marker inline-legend-marker-circle inline-legend-marker-blue';
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', 'line with circle marker');
    marker.innerHTML = '<span class="inline-legend-line" aria-hidden="true"></span><span class="inline-legend-shape" aria-hidden="true"></span>';
    block.replaceChildren(document.createTextNode('Legend. '), marker, document.createTextNode(' indicates the blue baseline in this translated paragraph.'), trigger);
  });
  await frame.locator(`[data-block-id="${blockId}"] .paragraph-translate-trigger`).click();
  const markerTranslation = frame.locator(`.my-scholar-translation[data-for="${blockId}"]:not(.is-pending):not(.is-error)`);
  await markerTranslation.waitFor();
  if (!(await markerTranslation.locator('.translation-text .inline-legend-marker-circle.inline-legend-marker-blue').count())) throw new Error('Translated paragraph lost its inline marker shape or tone');
  const markerTranslationText = (await markerTranslation.locator('.translation-text').textContent() || '').trim();
  if (/__MY_SCHOLAR_(?:MARKER|RENDER_MARKER)_/u.test(markerTranslationText)) throw new Error(`Inline-marker placeholder leaked into the translation (${markerTranslationText})`);
  const markerRequest = translationPostPayloads.at(-1);
  if (!markerRequest?.text.includes('__MY_SCHOLAR_MARKER_0__')) throw new Error(`Inline marker was not protected in the translation request (${JSON.stringify(markerRequest)})`);

  frame = await openFirstDocument();
  const cached = frame.locator(`.my-scholar-translation.is-cached[data-for="${blockId}"]`);
  await cached.waitFor();
  const cachedText = (await cached.locator('.translation-text').textContent() || '').trim();
  if (cachedText !== translatedText) throw new Error('Cached translation did not match the original response');
  const placedAfterSource = await cached.evaluate((node, id) => {
    const source = node.previousElementSibling;
    return source?.dataset?.blockId === id || source?.dataset?.translateBlockId === id;
  }, blockId);
  if (!placedAfterSource) throw new Error('Translation was not inserted directly after its source paragraph or caption');

  fullTranslationStarted = true;
  await page.locator('#full-translate-button').click();
  // A cache-only run can finish before Playwright observes the transient
  // visible state; accept either the visible panel or its completed value.
  await page.waitForFunction(() => {
    const panel = document.querySelector('#translation-progress');
    const track = panel?.querySelector('[role="progressbar"]');
    return !panel?.hidden || track?.getAttribute('aria-valuenow') === '100';
  });
  await page.waitForFunction(() => {
    const panel = document.querySelector('#translation-progress');
    const track = panel?.querySelector('[role="progressbar"]');
    return panel?.hidden && track?.getAttribute('aria-valuenow') === '100';
  });
  if (await page.locator('#assistant-toggle').getAttribute('aria-expanded') !== 'true') throw new Error('Full translation collapsed the docked assistant');
  const progress = await page.locator('#translation-progress .translation-progress-track[role="progressbar"]').evaluate((node) => ({
    value: node.getAttribute('aria-valuenow'),
    width: node.firstElementChild?.style.width || '',
  }));
  if (progress.value !== '100' || progress.width !== '100%') throw new Error('Full-translation progress bar did not reach 100%');
  if (fullTranslationPeakConcurrency !== 3) throw new Error(`Full translation did not use exactly three concurrent requests (peak ${fullTranslationPeakConcurrency})`);
  const translatableCaptions = await frame.locator('figcaption[data-translate-block-id]').evaluateAll((captions) => captions.filter((caption) => {
    const text = String(caption.textContent || '').replace(/译\s*$/u, '').trim();
    return text.length >= 8 && !caption.closest('.references');
  }).length);
  const captionTranslationControls = await frame.locator('figcaption[data-translate-block-id] .paragraph-translate-trigger').count();
  if (captionTranslationControls !== 0) throw new Error(`Figure/table captions still exposed ${captionTranslationControls} redundant translation controls`);
  const captionTranslations = await frame.locator('figcaption + .my-scholar-translation:not(.is-pending):not(.is-error)').count();
  if (captionTranslations !== translatableCaptions) throw new Error(`Figure/table captions were not all translated (${captionTranslations}/${translatableCaptions})`);
  const translatableLists = await frame.locator('ul[data-block-id], ol[data-block-id]').evaluateAll((lists) => lists.filter((list) => {
    const text = String(list.textContent || '').replace(/译\s*$/u, '').trim();
    return text.length >= 32 && !list.closest('.references');
  }).length);
  const listTranslations = await frame.locator(':is(ul, ol)[data-block-id] + .my-scholar-translation:not(.is-pending):not(.is-error)').count();
  if (listTranslations !== translatableLists) throw new Error(`Document lists were not all translated (${listTranslations}/${translatableLists})`);
  if (await frame.locator('.paper-metadata + .my-scholar-translation').count()) throw new Error('Full translation included author or affiliation metadata');

  const postCountAfterCompletedRun = translationPostCount;
  const postBlocksAfterCompletedRun = translationPostBlocks.length;
  await page.locator('#full-translate-button').click();
  await page.waitForFunction(() => document.querySelector('#translation-progress')?.hidden);
  await page.waitForTimeout(250);
  if (translationPostCount !== postCountAfterCompletedRun) {
    const repeated = translationPostPayloads.slice(postBlocksAfterCompletedRun).map((payload) => {
      const previous = [...translationPostPayloads.slice(0, postBlocksAfterCompletedRun)].reverse().find((candidate) => candidate.blockId === payload.blockId);
      const before = previous?.text || '';
      const after = payload.text;
      let difference = 0;
      while (difference < before.length && difference < after.length && before[difference] === after[difference]) difference += 1;
      return `${payload.blockId}:${previous?.sourceHash || 'missing'}->${payload.sourceHash}@${difference} ${JSON.stringify(before.slice(Math.max(0, difference - 24), difference + 48))}=>${JSON.stringify(after.slice(Math.max(0, difference - 24), difference + 48))}`;
    });
    throw new Error(`A repeated full translation issued ${translationPostCount - postCountAfterCompletedRun} unnecessary model requests (${repeated.join(', ')})`);
  }

  console.log(JSON.stringify({ blockId, titleBlockId, formulaBlockId, titleTranslated: true, metadataSkipped: true, inlineFormulaRendered: true, captionTranslations, listTranslations, translatedText, translationSpacing: { ...translationSpacing, sourceGapRatio, followingGapDelta }, specialTokenPreserved: tokenTranslationText.includes('[I_CLS]'), cacheRestored: true, fullTranslationPeakConcurrency, repeatedFullTranslationRequests: 0, placedAfterSource: true, progress, errors }));
  if (errors.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await browserSession?.close();
  } catch (closeError) {
    console.error(`Failed to close browser: ${closeError.message}`);
    process.exitCode = 1;
  }
});
