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
      translationPostPayloads.push({ blockId: String(payload.block_id || ''), sourceHash: String(payload.source_hash || ''), text: String(payload.text || ''), refresh: payload.refresh === true });
    }
  });
  await page.route('**/api/health', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, service: 'my-scholar', version: '0.1', shell: 'reference', ai: { services: { translation: { enabled: true, configured: true, model: 'translation-smoke', profile_id: 'translation-smoke-profile' }, chat: { enabled: true, configured: true, model: 'chat-smoke', profile_id: 'chat-smoke-profile' } } } }),
  }));
  await page.route(/\/api\/jobs\/[^/]+\/translations(?:\?.*)?$/u, async (route) => {
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
    const card = requestedJobId ? page.locator(`.library-card[data-job-id="${requestedJobId}"]`).first() : process.env.MY_SCHOLAR_TEST_DATA ? page.locator('#library-view .library-card[data-status="completed"]').filter({ hasText: 'OneLLM: One Framework to Align All Modalities with Language' }) : page.locator('.library-card[data-status="completed"]').first();
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
  async function translateParagraph(id) {
    await frame.locator(`[data-block-id="${id}"] .paragraph-translate-trigger`).click();
    await page.waitForFunction((block) => {
      const trigger = document.querySelector('#html-preview')?.contentDocument?.querySelector(`[data-block-id="${CSS.escape(block)}"] .paragraph-translate-trigger`);
      return trigger && !trigger.disabled;
    }, id);
  }
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
  await translateParagraph(blockId);
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

  const source = frame.locator(`[data-block-id="${blockId}"]`);
  async function hoverText(locator) {
    await locator.scrollIntoViewIfNeeded();
    const point = await locator.evaluate((node) => {
      const doc = node.ownerDocument;
      const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.nodeValue.trim() || text.parentElement.closest('button, .annotation-note-trigger')) continue;
        const range = doc.createRange();
        range.selectNodeContents(text);
        const rect = [...range.getClientRects()].find((item) => item.width && item.height);
        if (rect) return { x: rect.left + Math.min(4, rect.width / 2), y: rect.top + rect.height / 2 };
      }
      return null;
    });
    if (!point) throw new Error('Hover fixture has no visible text');
    const iframe = await page.locator('#html-preview').boundingBox();
    await page.mouse.move(iframe.x + point.x, iframe.y + point.y);
    await page.waitForTimeout(650);
  }
  async function assertOrdinaryHover(locator, label) {
    const before = translationPostCount;
    await hoverText(locator);
    const hoverState = await frame.locator('body').evaluate(() => ({
      custom: Boolean(document.defaultView.CSS?.highlights?.has('my-scholar-sentence-hover')),
      fallback: document.querySelectorAll('.reader-sentence-hover-fallback').length,
      toolbar: Boolean(parent.document.querySelector('#selection-popover:not([hidden]):not(.is-closing)')),
    }));
    if (hoverState.custom || hoverState.fallback || hoverState.toolbar || translationPostCount !== before) throw new Error(`${label} hover triggered selection actions or translation (${JSON.stringify(hoverState)})`);
  }
  await assertOrdinaryHover(source, 'Source');

  const postsBeforeSelection = translationPostCount;
  const selectedQuote = await source.evaluate((node) => {
    const doc = node.ownerDocument;
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (text) => text.parentElement.closest('.my-scholar-translation, button, .annotation-note-trigger') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let text;
    while ((text = walker.nextNode())) {
      const start = text.nodeValue.search(/\S/u);
      if (start < 0 || text.length - start < 8) continue;
      const quote = text.nodeValue.slice(start, start + 40).trimEnd();
      const range = doc.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + quote.length);
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(range);
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return quote;
    }
    throw new Error('Manual selection fixture has no source text');
  });
  await page.locator('#selection-popover:not([hidden]):not(.is-closing)').waitFor();
  await page.locator('#selection-translation-result[data-state="ready"]').filter({ hasText: `测试译文：${selectedQuote}` }).waitFor();
  const selectionState = await source.evaluate((node) => {
    const doc = node.ownerDocument;
    const selection = doc.getSelection();
    return {
      quote: selection.toString(),
      translated: (selection.anchorNode?.parentElement || selection.anchorNode)?.closest?.('.my-scholar-translation') != null,
      overlay: Boolean(doc.querySelector('#reader-text-selection-overlay path[d]')),
    };
  });
  if (selectionState.quote !== selectedQuote || selectionState.translated || !selectionState.overlay) throw new Error(`Manual source selection did not remain isolated from its translation (${JSON.stringify(selectionState)})`);
  const selectionRequest = translationPostPayloads.at(-1);
  if (translationPostCount !== postsBeforeSelection + 1 || selectionRequest.blockId || selectionRequest.text !== selectedQuote) throw new Error(`Manual selection did not translate its exact source once (${JSON.stringify(selectionRequest)})`);
  await source.evaluate((node) => {
    const doc = node.ownerDocument;
    doc.getSelection().removeAllRanges();
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.keyboard.press('Escape');
  await page.locator('#selection-popover:not([hidden]):not(.is-closing)').waitFor({ state: 'detached' });
  await assertOrdinaryHover(translation, 'Translation');

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
  await translateParagraph(blockId);
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
  await translateParagraph(blockId);
  const markerTranslation = frame.locator(`.my-scholar-translation[data-for="${blockId}"]:not(.is-pending):not(.is-error)`);
  await markerTranslation.waitFor();
  if (!(await markerTranslation.locator('.translation-text .inline-legend-marker-circle.inline-legend-marker-blue').count())) throw new Error('Translated paragraph lost its inline marker shape or tone');
  const markerTranslationText = (await markerTranslation.locator('.translation-text').textContent() || '').trim();
  if (/__MY_SCHOLAR_(?:MARKER|RENDER_MARKER)_/u.test(markerTranslationText)) throw new Error(`Inline-marker placeholder leaked into the translation (${markerTranslationText})`);
  const markerRequest = translationPostPayloads.at(-1);
  if (!markerRequest?.text.includes('__MY_SCHOLAR_MARKER_0__')) throw new Error(`Inline marker was not protected in the translation request (${JSON.stringify(markerRequest)})`);

  const formatFixture = await frame.locator(`[data-block-id="${blockId}"]`).evaluate((block) => {
    const trigger = block.querySelector('.paragraph-translate-trigger');
    const fragment = block.ownerDocument.createElement('span');
    fragment.innerHTML = '<strong>Outer bold <span class="pdf-text-tone pdf-text-tone-blue">inner blue <sub>i</sub></span></strong> '
      + '<span class="pdf-text-tone pdf-text-tone-red">Outer red <strong>inner bold <sup>2</sup></strong></span> '
      + '<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="x/y"><mfrac><mi>x</mi><mi>y</mi></mfrac></math> '
      + '<span class="inline-legend-marker inline-legend-marker-square inline-legend-marker-orange"><span class="inline-legend-line"></span><span class="inline-legend-shape"></span></span> '
      + Array.from({ length: 12 }, (_, index) => `<strong>bold-${index}</strong> <span class="pdf-text-tone pdf-text-tone-green">green-${index}</span> `).join('');
    const expected = { strong: fragment.querySelectorAll('strong').length, tones: fragment.querySelectorAll('.pdf-text-tone').length, math: fragment.querySelector('math').innerHTML };
    block.replaceChildren(...fragment.childNodes, trigger);
    return expected;
  });
  await translateParagraph(blockId);
  const formatTranslation = frame.locator(`.my-scholar-translation[data-for="${blockId}"]:not(.is-pending):not(.is-error) .translation-text`);
  await formatTranslation.waitFor();
  const formatResult = await formatTranslation.evaluate((node) => ({
    strong: node.querySelectorAll('strong').length,
    tones: node.querySelectorAll('.pdf-text-tone').length,
    boldBlue: node.querySelector('strong > .pdf-text-tone-blue')?.textContent,
    redBold: node.querySelector('.pdf-text-tone-red > strong')?.textContent,
    sub: node.querySelector('strong > .pdf-text-tone-blue > sub')?.textContent,
    sup: node.querySelector('.pdf-text-tone-red > strong > sup')?.textContent,
    math: node.querySelector('math.translation-math')?.innerHTML,
    marker: node.querySelectorAll('.inline-legend-marker-square.inline-legend-marker-orange .inline-legend-line, .inline-legend-marker-square.inline-legend-marker-orange .inline-legend-shape').length,
    leaked: /__MY_SCHOLAR_/u.test(node.textContent),
  }));
  if (formatResult.strong !== formatFixture.strong || formatResult.tones !== formatFixture.tones || !formatResult.boldBlue?.includes('inner blue') || !formatResult.redBold?.includes('inner bold') || formatResult.sub !== 'i' || formatResult.sup !== '2' || formatResult.math !== formatFixture.math || formatResult.marker !== 2 || formatResult.leaked) {
    throw new Error(`Translation did not restore nested styles, all emphasis runs, math and legend (${JSON.stringify({ formatFixture, formatResult })})`);
  }

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
  const postCountBeforeFullRun = translationPostCount;
  await page.locator('#full-translate-button').click();
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
  const firstFullTranslationRequests = postCountAfterCompletedRun - postCountBeforeFullRun;
  const postBlocksAfterCompletedRun = translationPostBlocks.length;
  await page.locator('#full-translate-button').click();
  await page.waitForFunction(() => document.querySelector('#translation-progress')?.hidden);
  const repeatedFullTranslationRequests = translationPostCount - postCountAfterCompletedRun;
  if (!firstFullTranslationRequests || repeatedFullTranslationRequests !== firstFullTranslationRequests) {
    throw new Error(`A repeated ordinary click did not retranslate every block (${repeatedFullTranslationRequests}/${firstFullTranslationRequests})`);
  }
  if (translationPostPayloads.slice(postCountBeforeFullRun).some((payload) => !payload.refresh)) {
    throw new Error('An ordinary full-translation click did not refresh existing cached translations');
  }
  const repeatedBlocks = translationPostBlocks.slice(postBlocksAfterCompletedRun);
  if (new Set(repeatedBlocks).size !== repeatedBlocks.length) throw new Error('A repeated full translation requested a block more than once');

  // A synthetic fetch response exercises the real API error path without
  // emitting expected HTTP failures into the browser's console-error audit.
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.__translationErrorFixtureRequests = 0;
    window.fetch = function (url, options) {
      if (/\/translate$/u.test(String(url)) && options?.body) {
        const text = String(JSON.parse(options.body).text || '');
        if (/ERROR_FIXTURE_(?:PREFIXED|PLAIN)/u.test(text)) window.__translationErrorFixtureRequests += 1;
        if (text.includes('ERROR_FIXTURE_PREFIXED')) return Promise.resolve(new Response(JSON.stringify({ error: '翻译失败：测试服务不可用' }), { status: 503 }));
        if (text.includes('ERROR_FIXTURE_PLAIN')) return Promise.resolve(new Response(JSON.stringify({ error: '测试服务不可用' }), { status: 503 }));
      }
      return originalFetch.apply(this, arguments);
    };
  });
  const errorFixtureIds = [blockId, formulaBlockId === blockId ? boundaryBlockId : formulaBlockId];
  if (errorFixtureIds[0] === errorFixtureIds[1]) throw new Error('Error regression needs two distinct paragraph blocks');
  const retainedTranslations = new Map();
  async function assertRetainedFailure(id, scope) {
    const failure = frame.locator(`[data-block-id="${id}"] .translation-retained-status`);
    await failure.waitFor();
    if ((await failure.textContent()).trim() !== '翻译失败：测试服务不可用 · 原译文已保留') throw new Error(`${scope} error prefix repeated (${await failure.textContent()})`);
    const retained = frame.locator(`.my-scholar-translation[data-for="${id}"]:not(.is-pending):not(.is-error) .translation-text`);
    if (await retained.textContent() !== retainedTranslations.get(id)) throw new Error(`${scope} failure replaced the saved translation`);
  }
  for (const [index, id] of errorFixtureIds.entries()) {
    retainedTranslations.set(id, await frame.locator(`.my-scholar-translation[data-for="${id}"] .translation-text`).textContent());
    await frame.locator(`[data-block-id="${id}"]`).evaluate((block, suffix) => {
      const trigger = block.querySelector('.paragraph-translate-trigger');
      block.replaceChildren(block.ownerDocument.createTextNode(`ERROR_FIXTURE_${suffix} This paragraph tests the translation error label.`), trigger);
    }, index ? 'PLAIN' : 'PREFIXED');
    await translateParagraph(id);
    await assertRetainedFailure(id, 'Paragraph');
  }
  await page.locator('#full-translate-button').click();
  await page.waitForFunction(() => window.__translationErrorFixtureRequests === 4 && document.querySelector('#translation-progress')?.hidden);
  for (const id of errorFixtureIds) {
    await assertRetainedFailure(id, 'Full translation');
  }

  console.log(JSON.stringify({ blockId, titleBlockId, formulaBlockId, titleTranslated: true, metadataSkipped: true, inlineFormulaRendered: true, nestedStylesAndManyRunsRestored: true, errorPrefixNormalized: true, captionTranslations, listTranslations, translatedText, translationSpacing: { ...translationSpacing, sourceGapRatio, followingGapDelta }, specialTokenPreserved: tokenTranslationText.includes('[I_CLS]'), cacheRestored: true, fullTranslationPeakConcurrency, repeatedFullTranslationRequests, placedAfterSource: true, progress, errors }));
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
