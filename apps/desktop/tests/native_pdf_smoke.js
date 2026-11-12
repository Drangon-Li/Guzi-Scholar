'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
const dataRoot = process.env.MY_SCHOLAR_TEST_DATA;
const sample = path.join(__dirname, '../web/assets/demo/attention/attention-is-all-you-need-pages-1-5.pdf');
const filename = 'native-pdf-selection-smoke.pdf';
const translated = '这是原版 PDF 选区的测试译文。';

async function dragSelection(page, pdfPage, index, beforeRelease) {
  const rect = await pdfPage.evaluate((node, index) => {
    const viewport = node.closest('.native-pdf-scroll').getBoundingClientRect();
    const candidates = [...node.querySelectorAll('.textLayer span')].flatMap((span) => {
      if (span.firstChild?.nodeType !== Node.TEXT_NODE || span.textContent.trim().length < 14) return [];
      const range = document.createRange();
      range.selectNodeContents(span);
      const { left, right, top, bottom, height } = range.getBoundingClientRect();
      if (top < viewport.top || bottom > viewport.bottom || left < viewport.left || right > viewport.right) return [];
      return [{ left, right, y: top + height / 2 }];
    });
    return candidates[index];
  }, index);
  assert(rect, `The PDF fixture has no visible text line ${index + 1}`);
  await page.mouse.move(rect.left + 0.5, rect.y);
  await page.mouse.down();
  await page.mouse.move(rect.right - 0.5, rect.y, { steps: 10 });
  try {
    if (beforeRelease) await beforeRelease();
  } finally {
    await page.mouse.up();
  }
  const selected = await page.evaluate(() => window.getSelection().toString().trim());
  assert(selected.length >= 10, `PDF drag selected too little text: ${JSON.stringify(selected)}`);
  return selected;
}

function assertPdfAnchor(annotation, kind, quote, pageNumber = 1) {
  assert.equal(annotation.kind, kind);
  assert.equal(annotation.surface, 'pdf');
  assert.equal(annotation.page, pageNumber);
  assert.equal(annotation.quote, quote);
  assert(annotation.pdf_rects.length > 0);
  for (const [left, top, right, bottom] of annotation.pdf_rects) {
    assert(0 <= left && left < right && right <= 1 && 0 <= top && top < bottom && bottom <= 1);
  }
}

async function main() {
  assert(baseURL && dataRoot, 'Run this suite through the isolated UI runner.');
  const prompts = [];
  const provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    prompts.push(body.messages.map(({ content }) => content).join('\n'));
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: translated } }] })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: translated } }] }));
    }
  });
  await new Promise((resolve, reject) => provider.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(path.join(dataRoot, 'developer.tokens.json'), JSON.stringify({ translation: {
      base_url: `http://127.0.0.1:${provider.address().port}/v1`, api_key: 'local-fixture',
      model: 'gpt-4.1-mini', api_format: 'openai-chat', target_language: 'zh',
    } }), { mode: 0o600 });
    const session = await launchManagedChromium();
    try {
      const page = await session.browser.newPage({ viewport: { width: 1440, height: 930 }, serviceWorkers: 'block' });
      page.setDefaultTimeout(15000);
      const errors = [];
      const translationRequests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith('/translate')) translationRequests.push(request.postDataJSON());
      });
      await page.addInitScript(() => {
        window.myScholarDesktop = { platform: 'darwin', state: {
          loadAll: async () => ({ 'my-scholar-onboarding-v2': '{"version":2,"action":"skipped"}' }),
          set: async () => {}, remove: async () => {},
        } };
      });
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      const uploaded = page.waitForResponse((response) => response.url() === baseURL + '/api/jobs' && response.request().method() === 'POST');
      await page.locator('#file-input').setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: fs.readFileSync(sample) });
      const uploadResponse = await uploaded;
      assert(uploadResponse.ok(), await uploadResponse.text());
      const { job } = await uploadResponse.json();
      assert.equal(job.status, 'unparsed');
      assert.equal(job.links.source, `/api/jobs/${job.job_id}/source.pdf`);
      assert(!job.links.html);
      const statusURL = `${baseURL}/api/jobs/${job.job_id}`;
      const annotationURL = `${statusURL}/annotations`;
      const notesURL = `${statusURL}/notes`;
      const write = (url, method) => page.waitForResponse((response) => response.url() === url && response.request().method() === method);
      const pdfView = page.locator('#reader-view.active-view #native-pdf-view');
      const pdfScroll = pdfView.locator('.native-pdf-scroll');
      const pageInput = pdfView.locator('.native-pdf-page-input');
      const pdfPageAt = (number) => pdfView.locator(`.native-pdf-page[data-page-number="${number}"]`);
      const waitForPageNumber = (number) => page.waitForFunction((expected) =>
        document.querySelector('.native-pdf-page-input').value === expected, String(number));
      const pdfPage = pdfPageAt(1);
      const selectionPopover = page.locator('#selection-popover');
      const translationResult = selectionPopover.locator('#selection-translation-result[data-state="ready"]').filter({ hasText: translated });
      const overlay = (annotation) => pdfPageAt(annotation.page).locator(`.native-pdf-mark[data-annotation-id="${annotation.id}"]`).first();
      await pdfPage.locator('.textLayer span').first().waitFor({ state: 'attached' });
      await pdfScroll.focus();
      await page.keyboard.press('ArrowRight');
      await waitForPageNumber(2);
      await pdfPageAt(2).locator('.textLayer span').first().waitFor({ state: 'attached' });
      await page.keyboard.press('ArrowLeft');
      await waitForPageNumber(1);
      await pageInput.focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await pageInput.inputValue(), '1', 'page keys must leave editable controls alone');
      await pageInput.fill('5');
      await pageInput.press('Enter');
      await waitForPageNumber(5);
      await pdfPageAt(5).locator('.textLayer span').first().waitFor({ state: 'attached' });
      assert.equal(await pdfPage.locator('canvas').count(), 0, 'distant pages must release their canvases');
      await pdfView.locator('[data-native-pdf-action="previous"]').click();
      await waitForPageNumber(4);
      await pageInput.fill('1');
      await pageInput.press('Enter');
      await waitForPageNumber(1);
      const secondPageTop = await pdfPageAt(2).evaluate((node) => node.offsetTop);
      await pdfScroll.hover();
      await page.mouse.wheel(0, secondPageTop + 32);
      await waitForPageNumber(2);
      await page.mouse.wheel(0, -secondPageTop - 32);
      await waitForPageNumber(1);
      await pdfPage.locator('.textLayer span').first().waitFor({ state: 'attached' });
      const selection = await dragSelection(page, pdfPage, 0, async () => {
        // Outlast the selection translation debounce with the mouse still held.
        await page.waitForTimeout(350);
        assert(await selectionPopover.isHidden(), 'selection actions must wait for mouse release');
        assert.equal(translationRequests.length, 0, 'dragging must not send a partial selection for translation');
      });
      await translationResult.waitFor();
      assert.equal(translationRequests.length, 1);
      assert.equal(translationRequests[0].source_kind, 'pdf');
      assert.equal(translationRequests[0].text, selection.replace(/\s+/gu, ' '));
      assert.equal(prompts.length, 1);
      assert(prompts[0].includes(translationRequests[0].text));

      const highlighted = write(annotationURL, 'POST');
      await selectionPopover.locator('#selection-highlight').click();
      const highlightResponse = await highlighted;
      assert.equal(highlightResponse.status(), 201, await highlightResponse.text());
      const { annotation: highlight } = await highlightResponse.json();
      assertPdfAnchor(highlight, 'highlight', selection);
      await overlay(highlight).waitFor();

      const assistantToggle = page.locator('#assistant-toggle');
      const assistantResizer = page.locator('#reader-sidebar-resizer');
      if (await assistantToggle.getAttribute('aria-expanded') === 'false') await assistantToggle.click();
      await overlay(highlight).waitFor();
      const currentPageWidth = () => pdfPage.evaluate((node) => node.getBoundingClientRect().width);
      const waitForRasterResize = (previousWidth) => page.waitForFunction((previous) => {
        const firstPage = document.querySelector('.native-pdf-page');
        const width = firstPage.getBoundingClientRect().width;
        return width !== previous && Math.abs(firstPage.querySelector('canvas')?.width - width * devicePixelRatio) <= 1;
      }, previousWidth);
      const resizeProbe = await pdfPage.evaluateHandle((node) => {
        const scroll = node.closest('.native-pdf-scroll');
        scroll.scrollTop = 150;
        const painted = () => {
          const canvas = node.querySelector('canvas');
          return canvas?.width > 0 && canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] > 0;
        };
        const probe = { blank: !painted(), layer: node.querySelector('.textLayer'), mark: node.querySelector('.native-pdf-mark') };
        probe.observer = new MutationObserver(() => { probe.blank ||= !painted(); });
        probe.observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });
        return probe;
      });
      const grip = await assistantResizer.boundingBox();
      const gripX = grip.x + grip.width / 2;
      const gripY = grip.y + grip.height / 2;
      const beforeDrag = await currentPageWidth();
      await page.mouse.move(gripX, gripY);
      await page.mouse.down();
      await page.mouse.move(gripX - 112, gripY, { steps: 8 });
      await page.mouse.up();
      await waitForRasterResize(beforeDrag);
      const beforeClose = await currentPageWidth();
      await assistantToggle.click();
      assert.equal(await assistantToggle.getAttribute('aria-expanded'), 'false');
      await waitForRasterResize(beforeClose);
      const beforeOpen = await currentPageWidth();
      await assistantToggle.click();
      assert.equal(await assistantToggle.getAttribute('aria-expanded'), 'true');
      await waitForRasterResize(beforeOpen);
      const resizeResult = await pdfPage.evaluate((node, probe) => {
        probe.observer.disconnect();
        const scroll = node.closest('.native-pdf-scroll');
        const stayedInPlace = scroll.scrollTop > 60 && scroll.scrollTop < 180;
        scroll.scrollTop = 0;
        return { blank: probe.blank, sameLayer: node.querySelector('.textLayer') === probe.layer,
          sameMark: node.querySelector('.native-pdf-mark') === probe.mark, stayedInPlace };
      }, resizeProbe);
      await resizeProbe.dispose();
      assert.deepEqual(resizeResult, { blank: false, sameLayer: true, sameMark: true, stayedInPlace: true });

      const noteSelection = await dragSelection(page, pdfPage, 1);
      assert.notEqual(noteSelection, selection);
      await translationResult.waitFor();
      const underlined = write(annotationURL, 'POST');
      await selectionPopover.locator('#selection-underline-note').click();
      const underlineResponse = await underlined;
      assert.equal(underlineResponse.status(), 201, await underlineResponse.text());
      const { annotation: underline } = await underlineResponse.json();
      assertPdfAnchor(underline, 'underline', noteSelection);
      await overlay(underline).waitFor();
      const notePopover = page.locator('.annotation-note-popover');
      const noteEditor = notePopover.locator('.annotation-note-editor');
      async function saveInlineNote(text) {
        await noteEditor.fill(text);
        const saved = write(`${annotationURL}/${underline.id}`, 'PATCH');
        await notePopover.locator('[data-action="save-note"]').click();
        const response = await saved;
        assert(response.ok(), await response.text());
        await notePopover.locator('.annotation-note-popover-body').getByText(text).waitFor();
        await notePopover.locator('[data-action="close"]').click();
        await notePopover.waitFor({ state: 'detached' });
      }
      const initialNote = '原版 PDF 的划线随笔';
      const editedNote = '重新编辑的原版 PDF 随笔';
      await saveInlineNote(initialNote);
      async function openSidebar(panel) {
        const sidebar = page.locator('#reader-sidebar');
        if (!(await sidebar.evaluate((node) => node.classList.contains('is-open')))) await page.locator('#assistant-toggle').click();
        await sidebar.locator(`[data-panel="${panel}"]`).click();
      }
      const sidebarItem = page.locator(`#annotations-list .annotation-item[data-annotation-id="${underline.id}"]`);
      await pdfScroll.hover();
      const halfScreen = await pdfScroll.evaluate((node) => Math.floor(node.clientHeight / 2));
      const pageTwoScroll = await pdfPageAt(2).evaluate((node) => node.offsetTop) - halfScreen;
      await page.mouse.wheel(0, pageTwoScroll);
      await page.waitForFunction((expected) => document.querySelector('.native-pdf-scroll').scrollTop >= expected,
        pageTwoScroll - 2);
      assert.equal(await pageInput.inputValue(), '1');
      await pdfPageAt(2).locator('.textLayer span').first().waitFor({ state: 'attached' });
      const pageTwoSelection = await dragSelection(page, pdfPageAt(2), 0);
      await translationResult.waitFor();
      const secondHighlight = write(annotationURL, 'POST');
      await selectionPopover.locator('#selection-highlight').click();
      const secondHighlightResponse = await secondHighlight;
      assert.equal(secondHighlightResponse.status(), 201, await secondHighlightResponse.text());
      const { annotation: pageTwoMark } = await secondHighlightResponse.json();
      assertPdfAnchor(pageTwoMark, 'highlight', pageTwoSelection, 2);
      await overlay(pageTwoMark).waitFor();
      await pageInput.fill('5');
      await pageInput.press('Enter');
      await openSidebar('annotations-panel');
      await sidebarItem.getByText(initialNote).waitFor();
      await sidebarItem.locator('.annotation-quote').click();
      await waitForPageNumber(1);
      await notePopover.locator('[data-action="edit"]').click();
      await saveInlineNote(editedNote);
      await sidebarItem.getByText(editedNote).waitFor();
      const { annotations } = await (await page.request.get(annotationURL)).json();
      const savedUnderline = annotations.find((item) => item.id === underline.id);
      assertPdfAnchor(savedUnderline, 'underline', noteSelection);
      assert.deepEqual(savedUnderline.pdf_rects, underline.pdf_rects);
      assert.equal(savedUnderline.note, editedNote);

      const articleNote = '阅读原版 PDF 时保存的文章笔记';
      await openSidebar('notes-panel');
      const savedNotes = write(notesURL, 'PUT');
      await page.locator('#notes-editor[contenteditable="true"]').fill(articleNote);
      await page.locator('#save-notes-button').click();
      const notesResponse = await savedNotes;
      assert(notesResponse.ok(), await notesResponse.text());
      assert.equal((await notesResponse.json()).markdown, articleNote);

      const stillUnparsed = await (await page.request.get(statusURL)).json();
      assert.equal(stillUnparsed.status, 'unparsed', 'reading, translation and notes must work without conversion');
      assert(!stillUnparsed.links.html);

      await page.reload({ waitUntil: 'networkidle' });
      if (!(await pdfView.isVisible())) {
        await page.locator(`#library-view.active-view .library-card[data-job-id="${job.job_id}"]:visible .library-row-name`).dblclick();
      }
      await overlay(highlight).waitFor();
      await overlay(underline).waitFor();
      await openSidebar('annotations-panel');
      await sidebarItem.getByText(editedNote).waitFor();
      await openSidebar('notes-panel');
      await page.locator('#notes-editor').getByText(articleNote).waitFor();

      const parse = write(`${statusURL}/parse`, 'POST');
      await pdfView.locator('[data-native-pdf-action="parse"]').click();
      const parseResponse = await parse;
      assert.equal(parseResponse.status(), 202, await parseResponse.text());
      assert(['queued', 'running'].includes((await parseResponse.json()).status));
      assert(await pdfView.isVisible());
      assert.deepEqual(errors, []);
      console.log('Native PDF smoke passed: continuous scroll, keyboard and page jumps, automatic translation, cross-page annotation navigation, persisted notes, and explicit parse.');
    } finally {
      await session.close();
    }
  } finally {
    await new Promise((resolve) => provider.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
