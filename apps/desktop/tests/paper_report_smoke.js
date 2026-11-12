'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
const dataRoot = process.env.MY_SCHOLAR_TEST_DATA;
if (!baseURL || !dataRoot) throw new Error('Use the isolated paper report UI suite.');

const sections = ['why', 'what', 'how', 'results', 'so_what', 'summary', 'idea', 'implementation', 'example', 'experiments'];
const term = '多模态对齐';
const title = '模拟论文精读报告';
const manualText = '人工修订：保留 [[多模态对齐]] 和原文依据。';
const revisedText = 'AI 修订：先解释 [[多模态对齐]] 的适用范围。';
const knowledgeText = '可复用定义：把不同模态的表示对应起来。';
const editedKnowledgeText = knowledgeText + ' 论文用共享投影实现这种对应。';
const selectedReportText = `用 ${term} 说明这一部分。\n\n用 ${term} 说明这一部分。`;
const selectionQuestion = '这两段是什么意思？';
const selectionReply = '这两段都在说明多模态对齐。';
const followUpQuestion = '那它是怎么做的？';
const followUpReply = '这次追问仍在讨论刚才的选段。';
const conceptArticle = {
  sections: [
    { key: 'basics', paragraphs: [{ text: '同一件事可以用图片、文字或声音表示。对齐让系统能把这些不同形式对应起来。' }] },
    { key: 'mechanism', paragraphs: [{ text: '编码器先把输入变成向量，再把各模态的向量映射到可比较的空间。' }] },
    { key: 'example', paragraphs: [{ text: '自拟例子：给出一张猫图和两条描述，比较图像与两条文本的相似度。' }] },
    { key: 'paper', paragraphs: [{ text: '本文把对齐用于比较两种模态的表示。', citations: [] }] },
    { key: 'limits', paragraphs: [{ text: '相似度较高也可能来自背景捷径；验证时要改变背景并检查匹配是否仍成立。' }] },
  ],
};

async function main() {
  const { jobs } = await (await fetch(`${baseURL}/api/jobs`)).json();
  const job = jobs.find((item) => item.source_filename === 'unified-multimodal-alignment.pdf');
  assert(job, 'expected a seeded paper');
  const jobDir = path.join(dataRoot, 'jobs', job.job_id);
  const jsonPath = path.join(jobDir, 'document.json');
  const document = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const block = document.pages[0].elements.find((element) => (element.type || element.kind) === 'paragraph');
  const citation = { block_id: block.block_id || block.id, quote: block.text.trim() };
  const figureId = 'report-overview';
  const equationId = 'report-equation';
  const figureAsset = 'assets/images/report-overview.png';
  const figureCaption = 'Figure 1. Overview of the multimodal alignment architecture.';
  const figureExplanation = '整体架构图用于说明多模态对齐的工作流程。结合正文阅读，可以理解这套流程如何建立表示之间的对应关系。';
  const sourceTex = 'z = Wx';
  document.pages[0].elements.push(
    { block_id: figureId, type: 'image', anchor: 'fig-1', caption_number: '1', caption: figureCaption, visual_asset: figureAsset },
    { block_id: equationId, type: 'equation_interline', equations: [{ tex: sourceTex }] },
  );
  fs.writeFileSync(jsonPath, JSON.stringify(document));
  fs.mkdirSync(path.dirname(path.join(jobDir, figureAsset)), { recursive: true });
  fs.writeFileSync(path.join(jobDir, figureAsset), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64'));
  const htmlPath = path.join(jobDir, 'document.html');
  const mediaHtml = `<figure data-block-id="${figureId}" data-page="1"><img src="${figureAsset}" alt=""><figcaption>${figureCaption}</figcaption></figure><div class="pdf-equation" data-block-id="${equationId}" data-page="1">${sourceTex}</div>`;
  fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace('</section>', mediaHtml + '</section>'));
  const section = (key, text = `用 [[${term}]] 说明这一部分。`) => ({ key, paragraphs: [{ text, kind: 'paper', citations: [citation] }] });
  let modelCalls = 0;
  let generations = 0;
  let articleCalls = 0;
  const provider = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.url, '/v1/chat/completions');
      const body = JSON.parse(Buffer.concat(chunks));
      const task = JSON.parse(body.messages[2].content);
      modelCalls += 1;
      let result;
      if (task.mode === 'knowledge') result = { reply: knowledgeText };
      else if (task.mode === 'revise') result = { reply: '补充了概念的适用范围。', draft: { sections: [section('why', revisedText)] } };
      else if (task.mode === 'concept_article') {
        assert.equal(task.concept.term, term);
        articleCalls += 1;
        result = structuredClone(conceptArticle);
        result.sections[3].paragraphs[0].citations.push(citation);
      }
      else if (task.mode === 'question') {
        if (task.message === selectionQuestion) {
          assert.equal(task.selected_text, selectedReportText);
          result = { reply: selectionReply };
        } else {
          assert.equal(task.message, followUpQuestion);
          assert.equal(task.selected_text, undefined);
          assert.deepEqual(task.history.find((turn) => turn.role === 'user'), {
            role: 'user', content: selectionQuestion, selected_text: selectedReportText,
          });
          result = { reply: followUpReply };
        }
      }
      else {
        assert.match(body.messages[0].content, /玩具例子/u);
        assert.match(body.messages[0].content, /so_what/u);
        const attachments = body.messages[3]?.content;
        if (attachments) {
          assert.match(attachments[0].text, /figure:report-overview/u);
          assert.match(attachments[1].image_url.url, /^data:image\/png;base64,/u);
        }
        generations += 1;
        result = {
          title: generations === 1 ? title : title + '（重新生成）', sections: sections.map((key) => section(key)),
          concepts: [{ term, definition: '建立不同模态的表示之间的对应关系。' }],
          media_explanations: [{ id: `figure:${figureId}`, text: figureExplanation, visual_readable: false, citations: [citation] }],
        };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error.message));
    }
  });
  await new Promise((resolve, reject) => provider.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(path.join(dataRoot, 'developer.tokens.json'), JSON.stringify({ chat: {
      base_url: `http://127.0.0.1:${provider.address().port}/v1`, api_key: 'local-fixture', model: 'gpt-4.1-mini', api_format: 'openai-chat',
    } }), { mode: 0o600 });
    const session = await launchManagedChromium();
    try {
      const page = await session.browser.newPage({ viewport: { width: 1460, height: 960 }, serviceWorkers: 'block' });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.myScholarDesktop = { platform: 'darwin', state: {
          loadAll: async () => ({ 'my-scholar-onboarding-v2': '{"version":2,"action":"skipped"}' }),
          set: async () => {}, remove: async () => {},
        } };
      });
      const reportURL = `${baseURL}/api/jobs/${job.job_id}/report`;
      const read = async () => {
        const response = await page.request.get(reportURL);
        assert(response.ok(), await response.text());
        return response.json();
      };
      const openReport = async () => {
        await page.locator(`#library-view .library-card[data-job-id="${job.job_id}"] .library-row-name`).dblclick();
        await page.locator('#paper-report-shell.active-view table').waitFor();
      };
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      await openReport();
      assert.equal(await page.locator('#paper-report-title').textContent(), title);
      assert.equal(await page.locator('#paper-report-shell tbody tr').count(), 5);
      const initial = await read();
      assert.equal(initial.revision, 1);
      assert.deepEqual(initial.report.media.map((item) => item.kind).sort(), ['equation', 'figure']);
      const overview = page.locator('[data-report-media-kind="figure"]');
      await overview.getByText(figureCaption, { exact: false }).waitFor();
      await overview.getByText('图表解读 · 仅依据题注或正文').waitFor();
      await overview.getByText(figureExplanation, { exact: false }).waitFor();
      assert.equal(initial.report.media.find((item) => item.id === `figure:${figureId}`).explanation.text, figureExplanation);
      await overview.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const img = document.querySelector('[data-report-media-kind="figure"] img');
        return img?.complete && img.naturalWidth > 0;
      });
      await page.locator('[data-report-media-kind="equation"] .katex').waitFor();
      assert.equal(await page.locator('[data-report-media-kind="equation"] [data-tex]').getAttribute('data-tex'), sourceTex);

      const drawer = page.locator('#paper-report-drawer');
      const discussToggle = page.locator('#paper-report-discuss');
      const discussion = page.locator('.paper-report-chat');
      const composerQuote = discussion.locator('form blockquote');
      await page.locator('.paper-report-questions .paper-report-prose').first().scrollIntoViewIfNeeded();
      const [start, end] = await page.evaluate(() => {
        const drawer = document.querySelector('#paper-report-drawer');
        window.reportDrawerMotion = [];
        drawer.addEventListener('transitionrun', (event) => {
          if (event.target === drawer) window.reportDrawerMotion.push(drawer.inert ? 'close' : 'open');
        });
        const [first, second] = document.querySelectorAll('.paper-report-questions .paper-report-prose');
        const point = (node, offset, edge) => {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getBoundingClientRect();
          return [rect[edge], (rect.top + rect.bottom) / 2];
        };
        return [point(first.firstChild, 0, 'left'), point(second.lastChild, second.lastChild.length - 1, 'right')];
      });
      await page.mouse.move(...start);
      await page.mouse.down();
      await page.mouse.move(...end, { steps: 8 });
      assert.equal(await discussToggle.getAttribute('aria-expanded'), 'false', 'the drawer stays put during a drag');
      await page.mouse.up();
      await composerQuote.waitFor();
      assert.equal(await composerQuote.textContent(), selectedReportText);
      assert.equal(await discussToggle.getAttribute('aria-expanded'), 'true');
      assert(await page.evaluate(() => !getSelection().isCollapsed), 'opening the drawer must preserve the reading selection');
      assert.equal(modelCalls, 1, 'attaching a report excerpt should not contact the provider');
      await discussion.locator('textarea').fill(selectionQuestion);
      await discussion.getByRole('button', { name: '移除选段' }).click();
      assert.equal(await composerQuote.count(), 0);
      await page.evaluate(() => {
        const [first, second] = document.querySelectorAll('.paper-report-questions .paper-report-prose');
        getSelection().setBaseAndExtent(second.lastChild, second.lastChild.length, first, 0);
      });
      await composerQuote.waitFor();
      assert.equal(await discussion.locator('textarea').inputValue(), selectionQuestion, 'reselecting text preserves the question draft');
      assert.equal(modelCalls, 1, 'the model waits for explicit Send');
      await discussion.getByRole('button', { name: '发送' }).click();
      await discussion.getByText(selectionReply, { exact: true }).waitFor();
      assert.equal(await discussion.locator('ol blockquote').textContent(), selectedReportText);
      assert.equal(await composerQuote.count(), 0);
      await discussion.locator('textarea').fill(followUpQuestion);
      await discussion.getByRole('button', { name: '发送' }).click();
      await discussion.getByText(followUpReply, { exact: true }).waitFor();
      await page.locator('#paper-report-close-drawer').click();
      assert.equal(await drawer.getAttribute('inert'), '');
      await drawer.waitFor({ state: 'hidden' });
      const motion = await page.evaluate(() => window.reportDrawerMotion);
      assert(motion.includes('open') && motion.includes('close'), 'the drawer animates both directions');
      assert.equal(await discussToggle.getAttribute('aria-expanded'), 'false');
      assert.equal((await read()).revision, 1, 'a selection discussion must not change the saved report');

      await overview.locator('.paper-report-media-source').click();
      await page.locator('#reader-view.active-view').waitFor();
      await page.waitForFunction((id) => {
        const frame = document.querySelector('#html-preview');
        const rect = frame?.contentDocument?.querySelector(`[data-block-id="${id}"]`)?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.bottom <= frame.clientHeight;
      }, figureId);
      await page.locator('#reader-open-report').click();

      await overview.locator('.paper-report-media-explanation .paper-report-citation').click();
      assert.equal(await page.locator('#paper-report-quote').textContent(), citation.quote);
      await page.locator('#paper-report-locate').click();
      await page.locator('#reader-view.active-view').waitFor();
      await page.waitForFunction((quote) => {
        const doc = document.querySelector('#html-preview')?.contentDocument;
        const highlight = doc?.defaultView.CSS.highlights.get('my-scholar-report-evidence');
        return highlight?.size === 1 && [...highlight][0].toString() === quote;
      }, citation.quote);
      await page.locator('#reader-open-report').click();

      await page.locator('#paper-report-edit').click();
      await page.locator('#paper-report-content textarea').first().fill(manualText);
      await page.locator('#paper-report-save').click();
      await page.locator('#paper-report-content').getByText('人工修订：保留', { exact: false }).waitFor();
      assert.equal((await read()).revision, 2);

      await page.locator('.paper-report-term').first().click();
      const shortNote = page.locator('.paper-report-concept textarea');
      await shortNote.fill('我的未保存概念笔记。');
      assert.equal(articleCalls, 0, 'opening the short concept note should not call the model');
      const fullArticle = page.locator('#paper-report-concept-article');
      const readFull = page.locator('#paper-report-concept-read');
      const closeFull = page.locator('#paper-report-concept-article-close');
      const articleExample = fullArticle.getByText(conceptArticle.sections[2].paragraphs[0].text, { exact: true });
      await readFull.click();
      await articleExample.waitFor();
      assert.equal(await fullArticle.locator('#paper-report-concept-article-content h3').count(), 5);
      const articleURL = reportURL + '/concepts/' + initial.report.concepts[0].id + '/article';
      const cachedResponse = await page.request.get(articleURL + '?revision=2');
      assert(cachedResponse.ok(), await cachedResponse.text());
      const { article } = await cachedResponse.json();
      assert.equal(article.term, term);
      assert.deepEqual(article.sections[3].paragraphs[0].citations, [{ ...citation, page: 1, render_generation: 'base' }]);
      await fullArticle.getByRole('button', { name: '查看原文证据，第 1 页' }).click();
      assert.equal(await page.locator('#paper-report-quote').textContent(), citation.quote);
      await page.locator('#paper-report-evidence').getByRole('button', { name: '关闭证据' }).click();
      assert(await fullArticle.isVisible(), 'closing source evidence returns to the concept article');
      const stale = await page.request.get(articleURL + '?revision=1');
      assert.equal(stale.status(), 409);
      await closeFull.click();
      assert.equal(await shortNote.inputValue(), '我的未保存概念笔记。');
      await readFull.click();
      await articleExample.waitFor();
      assert.equal(articleCalls, 1, 'reopening the saved article should not call the provider');
      await closeFull.click();
      assert.equal((await read()).revision, 2, 'an article is saved separately from the reading report');

      await page.locator('.paper-report-chat textarea').fill('把这个概念整理成知识笔记');
      await page.locator('.paper-report-chat button[type="submit"]').click();
      await page.getByRole('button', { name: '用作笔记草稿' }).click();
      assert.equal(await page.locator('.paper-report-concept textarea').inputValue(), knowledgeText);
      await page.locator('.paper-report-concept textarea').fill(editedKnowledgeText);
      await page.locator('.paper-report-concept select').selectOption('mastered');
      await page.locator('.paper-report-concept input[type="checkbox"]').check();
      await page.locator('.paper-report-concept button[type="submit"]').click();
      await page.locator('.paper-report-concept').getByText('概念记录已保存。', { exact: true }).waitFor();
      await page.locator('#paper-report-knowledge').click();
      await page.locator('#report-knowledge-list').getByText(editedKnowledgeText, { exact: true }).waitFor();

      await page.locator('#report-knowledge-back').click();
      await openReport();
      await page.locator('#paper-report-discuss').click();
      await page.locator('.paper-report-chat textarea').fill('补充概念的适用范围');
      await page.locator('.paper-report-chat select').selectOption('revise');
      await page.locator('.paper-report-chat button[type="submit"]').click();
      await page.locator('#paper-report-draft').getByRole('button', { name: /应用/u }).click();
      await page.locator('#paper-report-content').getByText('AI 修订：先解释', { exact: false }).waitFor();
      const latest = await read();
      assert.equal(latest.revision, 3);
      assert.deepEqual(latest.history.map((version) => version.source).sort(), ['ai', 'ai', 'manual']);

      await page.reload({ waitUntil: 'networkidle' });
      await openReport();
      await page.locator('#paper-report-content').getByText('AI 修订：先解释', { exact: false }).waitFor();
      assert.equal(modelCalls, 6, 'reopening a saved report should not call the provider');

      await page.locator('#paper-report-edit').click();
      await page.locator('#paper-report-content textarea').first().fill('退出应用时保存的修订。');
      assert.equal(await page.evaluate(() => window.__myScholarFlushBeforeClose({ intent: 'quit' })), true);
      await page.evaluate(() => window.__myScholarResumeAfterClose());
      assert.equal((await read()).revision, 4);

      // The report still points to base after the library starts showing a newer render.
      await page.route(`${baseURL}/api/jobs`, async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        payload.jobs.find((item) => item.job_id === job.job_id).active_render = 2;
        await route.fulfill({ response, json: payload });
      });
      await page.reload({ waitUntil: 'networkidle' });
      await openReport();
      await page.locator('.paper-report-citation').first().click();
      await page.locator('#paper-report-locate').click();
      await page.locator('#paper-report-historical-source[open]').waitFor();
      await page.waitForFunction((quote) => {
        const doc = document.querySelector('.paper-report-historical-frame')?.contentDocument;
        const highlight = doc?.defaultView.CSS.highlights.get('my-scholar-report-evidence');
        return highlight?.size === 1 && [...highlight][0].toString() === quote;
      }, citation.quote);
      await page.locator('[data-report-historical-close]').click();
      assert(await page.locator('#paper-report-shell.active-view').isVisible());

      const other = jobs.find((item) => item.source_filename === 'layout-aware-table-recovery.pdf');
      await page.locator('#paper-report-back').click();
      await page.locator(`#library-view [data-row-menu-job-id="${other.job_id}"]`).click();
      await page.locator(`[data-row-action="original"][data-job-id="${other.job_id}"]:visible`).click();
      await page.locator('#reader-view.active-view').waitFor();
      await page.locator(`#document-tabs .document-tab[data-job-id="${job.job_id}"]`).click();
      await page.locator('#paper-report-shell.active-view').waitFor();
      const closeParked = page.locator(`[data-close-job-id="${other.job_id}"]`);
      await closeParked.click();
      await closeParked.waitFor({ state: 'detached' });
      assert(await page.locator('#paper-report-shell.active-view').isVisible());

      await page.locator('#paper-report-regenerate').click();
      const applyNewReport = page.locator('#paper-report-draft [data-report-apply]');
      await applyNewReport.waitFor();
      assert.equal((await read()).revision, 4, 'a regeneration preview must not replace the saved report');
      assert.equal(await page.locator('#paper-report-title').textContent(), title + '（重新生成）');
      await applyNewReport.click();
      await applyNewReport.waitFor({ state: 'detached' });
      assert.equal((await read()).revision, 5);
      assert(await page.locator('[data-report-media-kind="figure"]').isVisible());
      assert.deepEqual(errors, []);
      console.log('Paper report smoke passed: generation, concept articles, selection discussions, source visuals, evidence, revision preview, knowledge, reload and save on close.');
    } finally {
      await session.close();
    }
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
