'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
if (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA) throw new Error('Use an isolated fixture server with MY_SCHOLAR_TEST_DATA. This suite writes vocabulary.');

const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:19px/1.8 serif}.reader-content{max-width:760px;margin:40px auto}p{margin:30px 0}.spacer{height:1200px}</style></head><body data-vocabulary-fixture="true"><main class="reader-content"><section class="pdf-page" data-page="1"><p data-block-id="vocab-one" data-page="1">We apply variational inference to approximate the posterior.</p><p data-block-id="vocab-two" data-page="1">Our variational inference method shares evidence with the first sentence.</p><p data-block-id="vocab-three" data-page="1">A stochastic gradient estimator improves the objective.</p><p data-block-id="vocab-failure" data-page="1">The failed concept remains available for later study.</p><p data-block-id="vocab-long" data-page="1">${'a'.repeat(121)}</p><div class="spacer"></div></section></main></body></html>`;

(async () => {
  const session = await launchManagedChromium();
  let releaseDelayed = () => {};
  let releaseExplanation = () => {};
  try {
    const page = await session.browser.newPage({ viewport: { width: 1460, height: 960 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    const translationRequests = [];
    const vocabularyPosts = [];
    let failTranslation = true;
    let explanationMode = 'failure';
    const explanations = [];
    const generatedDetails = { part_of_speech: '名词短语', meanings: '1. 随机梯度；2. 梯度估计', synonyms: 'gradient estimate', antonyms: 'full gradient', examples: 'A stochastic gradient reduces cost. 随机梯度降低成本。', context_explanation: '当前论文使用随机梯度优化变分目标。' };
    const delayed = new Promise((resolve) => { releaseDelayed = resolve; });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', async (dialog) => { errors.push(`Unexpected native dialog: ${dialog.type()}`); await dialog.dismiss(); });
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/vocabulary' && request.method() === 'POST') vocabularyPosts.push(request.postDataJSON());
    });
    await page.route('**/api/health', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, service: 'my-scholar', version: 'test', ai: { services: { translation: { enabled: true, configured: true, model: 'vocabulary-mock', profile_id: 'vocabulary-mock' }, chat: { enabled: false, configured: false } } } }) }));
    await page.route('**/api/jobs/*/document.html*', (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.route('**/api/jobs/*/translate', async (route) => {
      const body = route.request().postDataJSON();
      translationRequests.push(body.text);
      if (body.text === 'stochastic gradient') await delayed;
      if (body.text === 'failed concept' && failTranslation) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '模拟翻译暂不可用' }) });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { text: `释义：${body.text}`, block_id: body.block_id, source_hash: body.source_hash, target_language: body.target_language, profile_id: 'vocabulary-mock' } }) });
    });
    await page.route('**/api/vocabulary/*/explain', async (route) => {
      explanations.push(route.request().postDataJSON());
      if (explanationMode === 'failure') return route.fulfill({ status: 503, json: { error: '模拟详细释义暂不可用' } });
      await new Promise((resolve) => { releaseExplanation = resolve; });
      return route.fulfill({ json: { details: generatedDetails, model: 'vocabulary-explain-fixture' } });
    });
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    const paper = page.locator('#library-view .library-card[data-status="completed"]').first();
    await paper.waitFor();
    const jobId = await paper.getAttribute('data-job-id');
    await paper.locator('.library-row-name').dblclick();
    const frame = page.frameLocator('#html-preview');
    await frame.locator('body[data-vocabulary-fixture]').waitFor();
    await page.waitForFunction(() => !document.querySelector('#reader-view').classList.contains('is-document-loading'));
    const initialFrame = await page.locator('#html-preview').elementHandle();
    const select = async (id, term) => {
      const paragraph = frame.locator(`[data-block-id="${id}"]`);
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.evaluate((node, term) => {
        const doc = node.ownerDocument;
        const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: (text) => text.parentElement.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
        let text;
        while ((text = walker.nextNode())) {
          const start = text.textContent.indexOf(term);
          if (start < 0) continue;
          const range = doc.createRange(); range.setStart(text, start); range.setEnd(text, start + term.length);
          doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range);
          // The reader applies mouse selections after its 20 ms debounce.
          // An already-visible popover still belongs to the previous range.
          const applied = new Promise((resolve, reject) => {
            const context = doc.defaultView.parent.document.querySelector('#selected-context');
            const observer = new MutationObserver(() => {
              if (context.querySelector('.selected-context-quote')?.textContent !== term) return;
              observer.disconnect(); clearTimeout(timeout); resolve();
            });
            const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Reader did not apply selection: ${term}`)); }, 5000);
            observer.observe(context, { childList: true, subtree: true, characterData: true });
          });
          doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return applied;
        }
        throw new Error(`Fixture term not found: ${term}`);
      }, term);
      await page.locator('#selection-popover:not([hidden])').waitFor();
    };
    const save = async () => {
      const response = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/vocabulary' && item.request().method() === 'POST');
      await page.locator('#selection-add-vocabulary').click();
      const payload = await (await response).json();
      assert(payload.entry, JSON.stringify(payload));
      return payload.entry;
    };
    const getEntry = async (id) => ((await (await page.request.get(`${baseURL}/api/vocabulary`)).json()).entries).find((item) => item.id === id);
    await select('vocab-one', 'variational inference');
    await page.locator('#selection-translation-result[data-state="ready"]').waitFor();
    let first = await save();
    assert.equal(first.meaning, '释义：variational inference');
    assert.equal(first.sources[0].quote, 'We apply variational inference to approximate the posterior.');
    assert.equal(first.sources[0].selected_text, first.term);
    assert.equal(first.sources[0].job_id, jobId);
    assert.equal(translationRequests.filter((term) => term === first.term).length, 1, 'Save must reuse completed translation');
    first = await save();
    assert.equal(first.sources.length, 1, 'Identical source must deduplicate');
    await select('vocab-two', 'variational inference');
    await page.locator('#selection-translation-result[data-state="ready"]').waitFor();
    first = await save();
    assert.equal(first.sources.length, 2, 'Same word in a new sentence must retain both sources');
    assert.equal(translationRequests.filter((term) => term === first.term).length, 1, 'Cached selection translation should be reused');

    await select('vocab-long', 'a'.repeat(121));
    assert(await page.locator('#selection-add-vocabulary').isDisabled());
    await frame.locator('.reader-content').evaluate((root) => {
      const p = root.ownerDocument.createElement('p'); p.dataset.blockId = 'vocab-translation'; p.dataset.page = '1'; p.className = 'my-scholar-translation'; p.dataset.translationFor = 'vocab-one'; p.textContent = '译文提示不可保存'; root.prepend(p);
    });
    await select('vocab-translation', '译文提示');
    assert(await page.locator('#selection-add-vocabulary').isDisabled(), 'Translation selection must not save a status message as meaning');

    const delayedRequest = page.waitForRequest((request) => request.url().endsWith('/translate') && request.postDataJSON()?.text === 'stochastic gradient');
    await select('vocab-three', 'stochastic gradient');
    await delayedRequest;
    const second = await save();
    assert.equal(second.meaning, '');
    await page.locator('[data-view="vocabulary-view"]').click();
    await page.locator(`[data-vocabulary-id="${second.id}"]`).waitFor();
    assert.equal(await initialFrame.evaluate((node) => node.isConnected), true, 'Vocabulary navigation must preserve mounted reader');
    assert.equal(await page.locator('#reader-view').getAttribute('aria-hidden'), 'true');
    const secondCard = page.locator(`[data-vocabulary-id="${second.id}"]`);
    await secondCard.locator('[data-vocab-action="edit"]').click();
    await secondCard.locator('[name="meaning"]').fill('用户编写释义');
    await secondCard.locator('[name="tags"]').fill('机器学习, 优化');
    await secondCard.locator('[name="note"]').fill('检查异步补全不覆盖编辑');
    await secondCard.locator('[type="submit"]').click();
    await secondCard.locator('.vocabulary-meaning').filter({ hasText: '用户编写释义' }).waitFor();
    const completedPatch = page.waitForResponse((response) => response.url().endsWith(`/api/vocabulary/${second.id}`) && response.request().method() === 'PATCH' && response.request().postDataJSON()?.only_if_meaning_empty === true);
    releaseDelayed();
    await completedPatch;
    assert.equal((await getEntry(second.id)).meaning, '用户编写释义', 'Delayed AI result must not overwrite edited meaning');
    assert.equal(translationRequests.filter((term) => term === second.term).length, 1, 'Saving pending translation must not issue another AI request');
    assert.equal(explanations.length, 0, 'Detailed explanation must only run on request');
    await secondCard.locator('[data-vocab-action="explain"]').click();
    await page.locator('#vocabulary-status').filter({ hasText: '模拟详细释义暂不可用' }).waitFor();
    assert(await secondCard.locator('[data-vocab-action="explain"]').isEnabled(), 'Failed explanations can be retried');
    explanationMode = 'success';
    const explanationRequest = page.waitForRequest((request) => request.url().endsWith('/explain'));
    await secondCard.locator('[data-vocab-action="explain"]').click();
    await explanationRequest;
    assert(await secondCard.locator('[data-vocab-action="explain"]').isDisabled(), 'Generation is guarded against duplicate requests');
    releaseExplanation();
    await secondCard.locator('.vocabulary-details').waitFor();
    assert.equal(await secondCard.locator('.vocabulary-details').getAttribute('open'), null, 'Generated details start collapsed');
    await secondCard.locator('.vocabulary-details > summary').click();
    assert.equal(await secondCard.locator('.vocabulary-detail-field').count(), 6);
    assert.match(await secondCard.locator('.vocabulary-details').innerText(), /当前论文使用随机梯度/u);
    await secondCard.locator('[data-vocab-action="edit"]').click();
    assert.equal(await secondCard.locator('.vocabulary-details').getAttribute('open'), null, 'Detail editor starts collapsed');
    await secondCard.locator('.vocabulary-details > summary').click();
    assert.equal(await secondCard.locator('.vocabulary-details textarea').count(), 6);
    await secondCard.locator('[name="details.examples"]').fill('A manual example. 用户编辑的例句。');
    const detailSave = page.waitForResponse((response) => response.url().endsWith(`/api/vocabulary/${second.id}`) && response.request().method() === 'PATCH');
    await secondCard.locator('[type="submit"]').click();
    assert.deepEqual((await detailSave).request().postDataJSON(), { details: { examples: 'A manual example. 用户编辑的例句。' } });
    await secondCard.locator('.vocabulary-meaning').waitFor();
    const enriched = await getEntry(second.id);
    assert.equal(enriched.meaning, '用户编写释义');
    assert.equal(enriched.details.synonyms, generatedDetails.synonyms, 'Editing one detail preserves the others');
    assert.equal(enriched.details.examples, 'A manual example. 用户编辑的例句。');
    await page.locator('#vocabulary-tag').selectOption('优化');
    assert.equal(await page.locator('.vocabulary-card').count(), 1);
    await page.locator('#vocabulary-start-review').click();
    assert.equal(await page.locator('#vocabulary-review .vocabulary-review-meaning').count(), 0);
    assert.equal(await page.locator('#vocabulary-review .vocabulary-details').count(), 0, 'Review front must hide detailed answers');
    await page.locator('[data-vocab-action="reveal"]').click();
    await page.locator('#vocabulary-review .vocabulary-details > summary').click();
    assert.match(await page.locator('#vocabulary-review .vocabulary-details').innerText(), /用户编辑的例句/u);
    await page.locator('[data-vocab-action="rate"][data-status="mastered"]').click();
    await page.getByText('本轮复习完成', { exact: true }).waitFor();
    assert.equal((await getEntry(second.id)).review.status, 'mastered');
    await page.locator('[data-vocab-action="end-review"]').click();
    await page.locator('#vocabulary-filter').selectOption('learning');
    assert.equal(await page.locator('.vocabulary-card').count(), 0);
    await page.locator('#vocabulary-filter').selectOption('mastered');
    assert.equal(await page.locator('.vocabulary-card').count(), 1);
    await page.locator('#vocabulary-filter').selectOption('all');
    await page.locator('#vocabulary-tag').selectOption('');
    await page.locator('#vocabulary-search').fill('posterior');
    assert.equal(await page.locator('.vocabulary-card').count(), 1);
    const firstCard = page.locator(`[data-vocabulary-id="${first.id}"]`);
    await firstCard.locator('[data-vocab-action="source"]').first().click();
    await page.locator('#reader-view.active-view').waitFor();
    assert.equal(await frame.locator('body').evaluate((node) => node.ownerDocument.getSelection().toString()), first.term);

    await select('vocab-failure', 'failed concept');
    await page.locator('#selection-translation-result[data-state="error"]').waitFor();
    const failed = await save();
    assert.equal(failed.meaning, '');
    await page.locator('[data-view="vocabulary-view"]').click();
    await page.locator('#vocabulary-search').fill('failed concept');
    const failedCard = page.locator(`[data-vocabulary-id="${failed.id}"]`);
    await failedCard.waitFor();
    failTranslation = false;
    await failedCard.locator('[data-vocab-action="complete"]').click();
    await failedCard.locator('.vocabulary-meaning').filter({ hasText: '释义：failed concept' }).waitFor();
    await failedCard.locator('[data-vocab-action="delete"]').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#confirm-cancel').click();
    assert(await getEntry(failed.id), 'Cancel deletion must retain word');
    await failedCard.locator('[data-vocab-action="delete"]').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#confirm-dialog[open]').waitFor({ state: 'hidden' });
    assert(await getEntry(failed.id), 'Escape must cancel deletion');
    await failedCard.locator('[data-vocab-action="delete"]').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#confirm-accept').click();
    await failedCard.waitFor({ state: 'detached' });
    assert.equal(await getEntry(failed.id), undefined);

    await page.locator('#vocabulary-search').fill('variational inference');
    // A stale source may still point to the same block id; exact text and
    // surrounding-context validation must prevent a jump into changed text.
    await initialFrame.evaluate((node) => { node.contentDocument.querySelector('[data-block-id="vocab-one"]').firstChild.textContent = 'This paragraph was replaced by a new render.'; });
    await firstCard.locator('[data-vocab-action="source"]').first().click();
    await page.locator('#toast').filter({ hasText: '未找到可确认的原文位置' }).waitFor();
    assert(vocabularyPosts.every((post) => post.source.surface === 'source' && post.meaning !== '当前选区已是译文'));
    assert.deepEqual(errors, []);
    console.log('Vocabulary UI smoke passed: reuse, deduplication, source snapshots, filters, editing, review, retry, keepalive, and safe jumps');
  } finally {
    releaseDelayed();
    releaseExplanation();
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
