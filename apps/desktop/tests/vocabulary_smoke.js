'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
if (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA) throw new Error('Use an isolated fixture server with MY_SCHOLAR_TEST_DATA. This suite writes vocabulary.');

function vocabularyRequest(request) {
  if (new URL(request.url()).pathname !== '/api/plugins/guzi.vocabulary/invoke') return null;
  const payload = request.postDataJSON();
  const args = payload.arguments || {};
  const { entry_id, ...body } = args;
  const operations = { vocabulary_list: ['GET', ''], vocabulary_save: ['POST', ''], vocabulary_update: ['PATCH', `/${entry_id}`], vocabulary_delete: ['DELETE', `/${entry_id}`], vocabulary_review: ['POST', `/${entry_id}/review`], vocabulary_explain: ['POST', `/${entry_id}/explain`] };
  const operation = operations[payload.name];
  return operation ? { method: operation[0], path: `/api/vocabulary${operation[1]}`, body } : null;
}

const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:19px/1.8 serif}.reader-content{max-width:760px;margin:40px auto}p{margin:30px 0}.spacer{height:1200px}</style></head><body data-vocabulary-fixture="true"><main class="reader-content"><section class="pdf-page" data-page="1"><p data-block-id="vocab-one" data-page="1">We apply variational inference to approximate the posterior.</p><p data-block-id="vocab-two" data-page="1">Our variational inference method shares evidence with the first sentence.</p><p data-block-id="vocab-three" data-page="1">A stochastic gradient estimator improves the objective.</p><p data-block-id="vocab-failure" data-page="1">The failed concept remains available for later study.</p><p data-block-id="vocab-long" data-page="1">${'a'.repeat(121)}</p><div class="spacer"></div></section></main></body></html>`;

(async () => {
  const session = await launchManagedChromium();
  let releaseDelayed = () => {};
  let releaseExplanation = () => {};
  try {
    const page = await session.browser.newPage({ viewport: { width: 1460, height: 960 } });
    page.setDefaultTimeout(20000);
    const vocab = page.frameLocator('iframe[data-plugin-id="guzi.vocabulary"]');
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
      if (vocabularyRequest(request)?.path === '/api/vocabulary' && vocabularyRequest(request)?.method === 'POST') vocabularyPosts.push(vocabularyRequest(request).body);
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
    await page.route('**/api/plugins/guzi.vocabulary/invoke', async (route) => {
      if (route.request().postDataJSON()?.name !== 'vocabulary_explain') return route.continue();
      explanations.push(vocabularyRequest(route.request()).body);
      if (explanationMode === 'failure') return route.fulfill({ status: 503, json: { error: '模拟详细释义暂不可用' } });
      await new Promise((resolve) => { releaseExplanation = resolve; });
      return route.fulfill({ json: { result: { details: generatedDetails, model: 'vocabulary-explain-fixture' } } });
    });
    const previousEntries = (await (await page.request.get(`${baseURL}/api/vocabulary`)).json()).entries || [];
    for (const entry of previousEntries) await page.request.delete(`${baseURL}/api/vocabulary/${entry.id}`);
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
      const response = page.waitForResponse((item) => vocabularyRequest(item.request())?.path === '/api/vocabulary' && vocabularyRequest(item.request())?.method === 'POST');
      await page.locator('#selection-add-vocabulary').click();
      const payload = (await (await response).json()).result;
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
    await vocab.locator(`[data-vocabulary-id="${second.id}"]`).waitFor();
    assert.equal(await initialFrame.evaluate((node) => node.isConnected), true, 'Vocabulary navigation must preserve mounted reader');
    assert.equal(await page.locator('#reader-view').getAttribute('aria-hidden'), 'true');
    const secondCard = vocab.locator(`[data-vocabulary-id="${second.id}"]`);
    await secondCard.locator('[data-vocab-action="edit"]').click();
    await secondCard.locator('[name="meaning"]').fill('用户编写释义');
    await secondCard.locator('[name="tags"]').fill('机器学习, 优化');
    await secondCard.locator('[name="note"]').fill('检查异步补全不覆盖编辑');
    await secondCard.locator('[data-vocab-action="save-edit"]').click();
    await secondCard.locator('.vocabulary-meaning').filter({ hasText: '用户编写释义' }).waitFor().catch(async (error) => { console.error('Vocabulary status:', await vocab.locator('#vocabulary-status').textContent(), errors); throw error; });
    const completedPatch = page.waitForResponse((response) => vocabularyRequest(response.request())?.path === `/api/vocabulary/${second.id}` && vocabularyRequest(response.request())?.method === 'PATCH' && vocabularyRequest(response.request())?.body.only_if_meaning_empty === true);
    releaseDelayed();
    await completedPatch;
    assert.equal((await getEntry(second.id)).meaning, '用户编写释义', 'Delayed AI result must not overwrite edited meaning');
    assert.equal(translationRequests.filter((term) => term === second.term).length, 1, 'Saving pending translation must not issue another AI request');
    assert.equal(explanations.length, 0, 'Detailed explanation must only run on request');
    await secondCard.locator('[data-vocab-action="explain"]').click();
    await vocab.locator('#vocabulary-status').filter({ hasText: '模拟详细释义暂不可用' }).waitFor();
    assert(await secondCard.locator('[data-vocab-action="explain"]').isEnabled(), 'Failed explanations can be retried');
    explanationMode = 'success';
    const explanationRequest = page.waitForRequest((request) => vocabularyRequest(request)?.path.endsWith('/explain'));
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
    const detailSave = page.waitForResponse((response) => vocabularyRequest(response.request())?.path === `/api/vocabulary/${second.id}` && vocabularyRequest(response.request())?.method === 'PATCH');
    await secondCard.locator('[data-vocab-action="save-edit"]').click();
    assert.deepEqual(vocabularyRequest((await detailSave).request()).body, { details: { examples: 'A manual example. 用户编辑的例句。' } });
    await secondCard.locator('.vocabulary-meaning').waitFor();
    const enriched = await getEntry(second.id);
    assert.equal(enriched.meaning, '用户编写释义');
    assert.equal(enriched.details.synonyms, generatedDetails.synonyms, 'Editing one detail preserves the others');
    assert.equal(enriched.details.examples, 'A manual example. 用户编辑的例句。');
    await vocab.locator('#vocabulary-tag').selectOption('优化');
    assert.equal(await vocab.locator('.vocabulary-card').count(), 1);
    await vocab.locator('#vocabulary-start-review').click();
    assert.equal(await vocab.locator('#vocabulary-review .vocabulary-review-meaning').count(), 0);
    assert.equal(await vocab.locator('#vocabulary-review .vocabulary-details').count(), 0, 'Review front must hide detailed answers');
    await vocab.locator('[data-vocab-action="reveal"]').click();
    await vocab.locator('#vocabulary-review .vocabulary-details > summary').click();
    assert.match(await vocab.locator('#vocabulary-review .vocabulary-details').innerText(), /用户编辑的例句/u);
    await vocab.locator('[data-vocab-action="rate"][data-status="mastered"]').click();
    await vocab.getByText('本轮复习完成', { exact: true }).waitFor();
    assert.equal((await getEntry(second.id)).review.status, 'mastered');
    await vocab.locator('[data-vocab-action="end-review"]').click();
    await vocab.locator('#vocabulary-filter').selectOption('learning');
    assert.equal(await vocab.locator('.vocabulary-card').count(), 0);
    await vocab.locator('#vocabulary-filter').selectOption('mastered');
    assert.equal(await vocab.locator('.vocabulary-card').count(), 1);
    await vocab.locator('#vocabulary-filter').selectOption('all');
    await vocab.locator('#vocabulary-tag').selectOption('');
    await vocab.locator('#vocabulary-search').fill('posterior');
    assert.equal(await vocab.locator('.vocabulary-card').count(), 1);
    const firstCard = vocab.locator(`[data-vocabulary-id="${first.id}"]`);
    await firstCard.locator('[data-vocab-action="source"]').first().click();
    await page.locator('#reader-view.active-view').waitFor();
    assert.equal(await frame.locator('body').evaluate((node) => node.ownerDocument.getSelection().toString()), first.term);

    await select('vocab-failure', 'failed concept');
    await page.locator('#selection-translation-result[data-state="error"]').waitFor();
    const failed = await save();
    assert.equal(failed.meaning, '');
    await page.locator('[data-view="vocabulary-view"]').click();
    await vocab.locator('#vocabulary-search').fill('failed concept');
    const failedCard = vocab.locator(`[data-vocabulary-id="${failed.id}"]`);
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

    await vocab.locator('#vocabulary-search').fill('variational inference');
    // A stale source may still point to the same block id; exact text and
    // surrounding-context validation must prevent a jump into changed text.
    await initialFrame.evaluate((node) => { node.contentDocument.querySelector('[data-block-id="vocab-one"]').firstChild.textContent = 'This paragraph was replaced by a new render.'; });
    await firstCard.locator('[data-vocab-action="source"]').first().click();
    await page.locator('#toast').filter({ hasText: '未找到可确认的原文位置' }).waitFor();
    assert(vocabularyPosts.every((post) => post.source.surface === 'source' && post.meaning !== '当前选区已是译文'));
    const aiCallsBeforePaging = { translations: translationRequests.length, explanations: explanations.length };
    for (let index = 0; index < 25; index += 1) {
      const response = await page.request.post(`${baseURL}/api/vocabulary`, { data: { term: `pagination fixture ${index}`, meaning: '完整释义'.repeat(80), tags: ['分页测试'], source: { ...first.sources[0], quote: 'A source sentence. '.repeat(30) } } });
      assert(response.ok(), await response.text());
      const saved = (await response.json()).entry;
      await page.request.post(`${baseURL}/api/vocabulary`, { data: { term: saved.term, source: { ...first.sources[0], quote: 'A second source sentence.' }, tags: ['分页测试'] } });
    }
    await page.locator('[data-view="vocabulary-view"]').click();
    await vocab.locator('#vocabulary-search').fill('pagination fixture');
    await vocab.locator('#vocabulary-reload').click();
    await vocab.locator('#vocabulary-range').filter({ hasText: '显示 1–12 / 25' }).waitFor().catch(async (error) => {
      console.error('Pagination state:', await vocab.locator('#vocabulary-view').evaluate((node) => ({ range: node.querySelector('#vocabulary-range')?.textContent, page: node.querySelector('#vocabulary-page')?.textContent, query: node.querySelector('#vocabulary-search')?.value, status: node.querySelector('#vocabulary-filter')?.value, tag: node.querySelector('#vocabulary-tag')?.value, count: node.querySelector('#vocabulary-count')?.textContent, message: node.querySelector('#vocabulary-status')?.textContent })));
      const stored = (await (await page.request.get(`${baseURL}/api/vocabulary`)).json()).entries;
      console.error('Pagination fixtures:', stored.filter((entry) => entry.term.startsWith('pagination fixture')).map((entry) => ({ term: entry.term, tags: entry.tags, status: entry.review.status })));
      throw error;
    });
    assert.equal(await vocab.locator('.vocabulary-card').count(), 12);
    assert.equal(await vocab.locator('.vocabulary-list').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length), 2);
    await page.screenshot({ path: '/tmp/guzi-vocabulary-pagination.png' });
    const pagedCard = vocab.locator('.vocabulary-card').first();
    const longMeaning = pagedCard.locator('.vocabulary-long-content').first();
    assert.equal(await longMeaning.getAttribute('open'), null);
    await longMeaning.locator('summary').click();
    assert.equal((await longMeaning.locator('.vocabulary-meaning').innerText()).length, '完整释义'.repeat(80).length);
    await pagedCard.locator('.vocabulary-more-sources > summary').click();
    assert.match(await pagedCard.locator('.vocabulary-more-sources').innerText(), /A second source sentence/u);
    await vocab.locator('[data-vocab-action="next-page"]').click();
    await vocab.locator('#vocabulary-range').filter({ hasText: '显示 13–24 / 25' }).waitFor();
    const draftCard = vocab.locator('.vocabulary-card').first();
    const draftId = await draftCard.getAttribute('data-vocabulary-id');
    await draftCard.locator('[data-vocab-action="edit"]').click();
    await draftCard.locator('[name="note"]').fill('跨刷新保留草稿');
    await vocab.locator('#vocabulary-reload').click();
    await vocab.locator('#vocabulary-status').waitFor({ state: 'hidden' });
    assert.equal(await vocab.locator(`[data-vocabulary-id="${draftId}"] [name="note"]`).inputValue(), '跨刷新保留草稿');
    await vocab.locator('[data-vocab-action="next-page"]').click();
    assert.equal(await vocab.locator('.vocabulary-card').count(), 1);
    assert(await vocab.locator('[data-vocab-action="next-page"]').isDisabled());
    await vocab.locator('#vocabulary-start-review').click();
    assert.match(await vocab.locator('.vocabulary-review-heading').innerText(), /复习 1 \/ 25/u);
    await vocab.locator('[data-vocab-action="end-review"]').click();
    await vocab.locator('#vocabulary-search').fill('pagination fixture 2');
    assert.match(await vocab.locator('#vocabulary-page').innerText(), /第 1 \/ 1 页/u);
    await page.setViewportSize({ width: 620, height: 960 });
    assert.equal(await vocab.locator('.vocabulary-list').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length), 1);
    assert(await vocab.locator('body').evaluate((node) => node.scrollWidth <= node.ownerDocument.documentElement.clientWidth), 'Narrow layout must not overflow horizontally');
    assert.deepEqual({ translations: translationRequests.length, explanations: explanations.length }, aiCallsBeforePaging, 'Browsing pages must not generate AI requests');
    assert.deepEqual(errors, []);
    console.log('Vocabulary UI smoke passed: reuse, deduplication, source snapshots, filters, editing, review, retry, keepalive, safe jumps, pagination, draft retention, long content and responsive cards');
  } finally {
    releaseDelayed();
    releaseExplanation();
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
