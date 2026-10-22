'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
if (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA) throw new Error('Run with an isolated fixture server and MY_SCHOLAR_TEST_DATA; this suite writes settings and annotations.');

function documentHTML(legacy) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { color-scheme:light dark; --highlight-orange:#f59e0b; --user-highlight:#f59e0b; }
    body { margin:0; color:#191919; background:#fff; font:18px/1.8 serif; }
    .reader-content { max-width:760px; margin:40px auto; }
    p { margin:28px 0; }
    .my-scholar-highlight-innovation { background:rgba(139,110,219,.24); box-shadow:inset 0 -.09em 0 rgba(139,110,219,.46); }
    ${legacy ? `
      .reader-content .my-scholar-highlight { background:rgba(246,166,35,.38)!important; box-shadow:inset 0 -.09em 0 rgba(224,128,0,.42)!important; }
      .reader-content .my-scholar-underline { text-decoration:underline 2px #f59e0b!important; }
      .reader-content .my-scholar-highlight-innovation { background:rgba(139,110,219,.24)!important; box-shadow:inset 0 -.09em 0 rgba(139,110,219,.46)!important; }
    ` : ''}
    @media(prefers-color-scheme:dark) {
      body { color:#dcdcde; background:#1e2124; }
      .reader-content .my-scholar-highlight-innovation { background:rgba(157,132,236,.36)${legacy ? '!important' : ''}; box-shadow:inset 0 -.09em 0 rgba(157,132,236,.66)${legacy ? '!important' : ''}; }
    }
  </style></head><body data-color-fixture="${legacy ? 'legacy-important' : 'without-color-css'}"><main class="reader-content"><section class="pdf-page" data-page="1">
    <p data-block-id="color-underline" data-page="1">Underline this synthetic principle with the selected semantic preset.</p>
    <p data-block-id="color-highlight" data-page="1">Highlight this synthetic method with a different semantic preset.</p>
    <p data-block-id="color-new" data-page="1">Use the revised preset for this newly created annotation.</p>
    <p data-block-id="color-ai" data-page="1"><mark id="ai-color-control" class="my-scholar-highlight my-scholar-highlight-innovation" data-annotation-source="ai">AI innovation keeps its category color.</mark></p>
  </section></main></body></html>`;
}

(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    const posts = [];
    const fixtureKinds = new Map();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (/\/api\/jobs\/[^/]+\/annotations$/u.test(new URL(request.url()).pathname) && request.method() === 'POST') posts.push(request.postDataJSON());
    });
    await page.route('**/api/jobs/*/document.html*', (route) => {
      const jobId = new URL(route.request().url()).pathname.split('/')[3];
      assert(fixtureKinds.has(jobId), `Unexpected fixture document: ${jobId}`);
      return route.fulfill({ contentType: 'text/html', body: documentHTML(fixtureKinds.get(jobId) === 'legacy-important') });
    });
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    const cards = page.locator('.library-card[data-status="completed"]');
    await cards.first().waitFor();
    const jobIds = [await cards.nth(0).getAttribute('data-job-id'), await cards.nth(1).getAttribute('data-job-id')];
    fixtureKinds.set(jobIds[0], 'without-color-css');
    fixtureKinds.set(jobIds[1], 'legacy-important');

    await page.locator('[data-view="settings-view"]').click();
    await page.locator('a[href="#settings-shortcuts"]').click();
    const actions = [];
    for (const action of [
      { label: '蓝色原理', kind: 'underline', color: '#2563eb' },
      { label: '绿色方法', kind: 'highlight', color: '#16a34a' },
    ]) {
      await page.locator('#add-annotation-action').click();
      const row = page.locator('.annotation-action-row').last();
      await row.locator('[data-action-field="label"]').fill(action.label);
      await row.locator('[data-action-field="kind"]').selectOption(action.kind);
      await row.locator('[data-action-field="color"]').fill(action.color);
      actions.push({ ...action, id: await row.getAttribute('data-annotation-action-id') });
    }
    const waitSettings = () => page.waitForFunction(() => document.querySelector('#settings-save-status')?.dataset.state === 'saved');
    await waitSettings();
    const settings = await (await page.request.get(`${baseURL}/api/settings`)).json();
    for (const action of actions) {
      const saved = settings.annotation_actions.custom.find((item) => item.id === action.id);
      assert.equal(saved.color, action.color);
      assert.equal(saved.kind, action.kind);
    }

    const frame = page.frameLocator('#html-preview');
    const openDocument = async (jobId) => {
      await page.locator('[data-view="library-view"]').click();
      await page.locator(`#library-view .library-card[data-job-id="${jobId}"] .library-row-name`).dblclick();
      await frame.locator(`body[data-color-fixture="${fixtureKinds.get(jobId)}"]`).waitFor();
      await frame.locator('#my-scholar-annotation-runtime-style').waitFor({ state: 'attached' });
      await page.waitForFunction(() => !document.querySelector('#reader-view').classList.contains('is-document-loading'));
    };
    const annotate = async (jobId, blockId, action, start = 0) => {
      const paragraph = frame.locator(`p[data-block-id="${blockId}"]`);
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.evaluate((node, start) => {
        const doc = node.ownerDocument;
        const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
          acceptNode: (text) => text.parentElement.closest('button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        const texts = [];
        let text;
        while ((text = walker.nextNode())) texts.push(text);
        const point = (offset) => {
          for (const item of texts) {
            if (offset <= item.length) return [item, offset];
            offset -= item.length;
          }
          return [texts.at(-1), texts.at(-1).length];
        };
        const range = doc.createRange();
        range.setStart(...point(start));
        range.setEnd(...point(start + 36));
        doc.getSelection().removeAllRanges();
        doc.getSelection().addRange(range);
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, start);
      await page.locator('#selection-popover:not([hidden])').waitFor();
      const response = page.waitForResponse((item) => item.url().endsWith(`/api/jobs/${jobId}/annotations`) && item.request().method() === 'POST');
      await page.locator(`[data-semantic-action="${action.id}"]`).click();
      const payload = await (await response).json();
      assert(payload.annotation, 'Selection action did not create an annotation');
      assert.deepEqual([posts.at(-1).action_id, posts.at(-1).color, posts.at(-1).kind], [action.id, action.color, action.kind]);
      const saved = (await (await page.request.get(`${baseURL}/api/jobs/${jobId}/annotations`)).json()).annotations.find((item) => item.id === payload.annotation.id);
      assert.deepEqual([saved.action_id, saved.label, saved.color, saved.kind], [action.id, action.label, action.color, action.kind]);
      await frame.locator(`mark[data-annotation-id="${saved.id}"]`).waitFor();
      return saved;
    };
    const assertColors = async (annotations, theme, label) => {
      await page.emulateMedia({ colorScheme: theme });
      for (const annotation of annotations) {
        const fragments = await frame.locator(`mark[data-annotation-id="${annotation.id}"]`).evaluateAll((marks, annotation) => marks.map((mark) => {
          const doc = mark.ownerDocument;
          const actual = getComputedStyle(mark);
          const dark = doc.defaultView.matchMedia('(prefers-color-scheme:dark)').matches;
          const probe = doc.createElement('span');
          probe.style.font = actual.font;
          probe.style.textDecorationColor = annotation.color;
          probe.style.backgroundColor = `color-mix(in srgb,${annotation.color} ${dark ? 42 : 32}%,transparent)`;
          probe.style.boxShadow = `inset 0 -.09em 0 color-mix(in srgb,${annotation.color} ${dark ? 72 : 62}%,transparent)`;
          doc.body.append(probe);
          const expected = getComputedStyle(probe);
          const result = {
            userColor: mark.dataset.userColor,
            actual: [actual.textDecorationColor, actual.backgroundColor, actual.boxShadow],
            expected: [expected.textDecorationColor, expected.backgroundColor, expected.boxShadow],
          };
          probe.remove();
          return result;
        }), annotation);
        assert(fragments.length > 0, `${label}: annotation has no rendered fragments`);
        for (const colors of fragments) {
          assert.equal(colors.userColor, 'true');
          if (annotation.kind === 'underline') assert.equal(colors.actual[0], colors.expected[0], `${label}: underline color in ${theme}`);
          else assert.deepEqual(colors.actual.slice(1), colors.expected.slice(1), `${label}: highlight color and shadow in ${theme}`);
        }
      }
      const ai = await frame.locator('#ai-color-control').evaluate((mark) => ({ background: getComputedStyle(mark).backgroundColor, userColor: mark.dataset.userColor || '' }));
      assert.equal(ai.background, theme === 'dark' ? 'rgba(157, 132, 236, 0.36)' : 'rgba(139, 110, 219, 0.24)', `${label}: AI category color changed`);
      assert.equal(ai.userColor, '');
    };

    const savedByJob = new Map();
    for (const jobId of jobIds) {
      await openDocument(jobId);
      const annotations = [];
      for (const action of actions) annotations.push(await annotate(jobId, `color-${action.kind}`, action));
      savedByJob.set(jobId, annotations);
      for (const theme of ['light', 'dark']) await assertColors(annotations, theme, fixtureKinds.get(jobId));
    }

    const manuallyColored = savedByJob.get(jobIds[1])[0];
    await frame.locator(`.annotation-note-trigger[data-annotation-id="${manuallyColored.id}"]`).click();
    const manualColorResponse = page.waitForResponse((response) => response.url().endsWith(`/annotations/${manuallyColored.id}`) && response.request().method() === 'PATCH');
    await frame.locator('.annotation-note-popover [data-annotation-color="#ff6666"]').click();
    await (await manualColorResponse).finished();
    manuallyColored.color = '#ff6666';
    await frame.locator('.annotation-note-popover [data-action="close"]').click();

    await page.locator('[data-view="settings-view"]').click();
    await page.locator('a[href="#settings-shortcuts"]').click();
    const revised = { ...actions[0], label: '紫色原理', kind: 'highlight', color: '#9333ea' };
    const revisedRow = page.locator(`[data-annotation-action-id="${actions[0].id}"]`);
    await revisedRow.locator('[data-action-field="label"]').fill(revised.label);
    await revisedRow.locator('[data-action-field="kind"]').selectOption(revised.kind);
    await revisedRow.locator('[data-action-field="color"]').fill(revised.color);
    await waitSettings();
    for (const jobId of jobIds) {
      Object.assign(savedByJob.get(jobId)[0], { label: revised.label, kind: revised.kind, color: revised.color });
      const stored = (await (await page.request.get(`${baseURL}/api/jobs/${jobId}/annotations`)).json()).annotations;
      const copy = (await (await page.request.get(`${baseURL}/api/jobs/${jobId}/content/annotations/annotations.json`)).json());
      for (const expected of savedByJob.get(jobId)) {
        for (const rows of [stored, copy]) {
          const actual = rows.find((item) => item.id === expected.id);
          assert.deepEqual([actual.label, actual.kind, actual.color], [expected.label, expected.kind, expected.color], 'An action update synchronizes only its matching annotations in both stored copies');
        }
      }
      await openDocument(jobId);
      for (const theme of ['light', 'dark']) await assertColors(savedByJob.get(jobId), theme, `${fixtureKinds.get(jobId)} in kept-alive reader`);
    }
    await page.reload({ waitUntil: 'networkidle' });
    for (const jobId of jobIds) {
      await openDocument(jobId);
      const annotations = savedByJob.get(jobId);
      for (const theme of ['light', 'dark']) await assertColors(annotations, theme, `${fixtureKinds.get(jobId)} after reload`);
    }
    const newAnnotation = await annotate(jobIds[1], 'color-new', revised);
    await assertColors([...savedByJob.get(jobIds[1]), newAnnotation], 'light', 'new and prior annotations share the revised action style');
    const overlap = await annotate(jobIds[1], 'color-underline', actions[1], 18);
    const splitAnnotation = savedByJob.get(jobIds[1])[0];
    assert(await frame.locator(`mark[data-annotation-id="${splitAnnotation.id}"]`).count() > 1, 'Overlap must split the original annotation into multiple marks');
    await frame.locator(`.annotation-note-trigger[data-annotation-id="${splitAnnotation.id}"]`).first().click();
    const paletteColor = '#ff6666';
    const recolored = page.waitForResponse((response) => response.url().endsWith(`/annotations/${splitAnnotation.id}`) && response.request().method() === 'PATCH');
    await frame.locator(`.annotation-note-popover[data-annotation-id="${splitAnnotation.id}"] [data-annotation-color="${paletteColor}"]`).click();
    await (await recolored).finished();
    await frame.locator(`[data-annotation-color="${paletteColor}"][aria-pressed="true"]`).waitFor();
    const persisted = (await (await page.request.get(`${baseURL}/api/jobs/${jobIds[1]}/annotations`)).json()).annotations.find((annotation) => annotation.id === splitAnnotation.id);
    assert.equal(persisted.color, paletteColor);
    splitAnnotation.color = paletteColor;
    for (const theme of ['light', 'dark']) await assertColors([...savedByJob.get(jobIds[1]), newAnnotation, overlap], theme, 'all overlapping fragments recolored');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, cases: ['semantic-settings-and-selection-request', 'stored-annotation-color', 'runtime-colors-without-template-css', 'runtime-overrides-legacy-important', 'light-and-dark-colors', 'ai-category-colors-preserved', 'reload-color-persistence', 'action-edits-update-all-documents-and-kept-alive-readers', 'action-color-overrides-prior-manual-color', 'recolor-all-overlapping-fragments'] }));
  } finally { await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
