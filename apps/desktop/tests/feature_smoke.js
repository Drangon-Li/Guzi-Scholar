const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const requestedJobId = process.argv[3] || '';
let browser;
let browserSession;

(async () => {
  browserSession = await launchManagedChromium();
  browser = browserSession.browser;
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  await page.addInitScript(() => {
    window.__myScholarCopiedImageTypes = [];
    window.__myScholarCopiedText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.__myScholarCopiedText = String(text); },
        write: async (items) => {
          window.__myScholarCopiedImageTypes = items.map((item) => [...item.types]);
        },
      },
    });
  });
  page.setDefaultTimeout(6000);
  const errors = [];
  const expectedHTTPErrorPaths = [];
  let selectionTranslationRequestCount = 0;
  let translationRequestCount = 0;
  const chatRequestContents = [];
  const chatRequestPayloads = [];
  let chatResponseMode = 'normal';
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const location = message.location()?.url || '';
    const expectedIndex = expectedHTTPErrorPaths.findIndex((path) => location.includes(path));
    const fallbackIndex = expectedIndex < 0 && /Failed to load resource.*500/iu.test(text) && expectedHTTPErrorPaths.length ? 0 : -1;
    const index = expectedIndex >= 0 ? expectedIndex : fallbackIndex;
    if (index >= 0) { expectedHTTPErrorPaths.splice(index, 1); return; }
    errors.push(`console: ${text}`);
  });
  await page.route('**/api/health', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, service: 'my-scholar', version: '0.1', shell: 'reference', ai: { services: { translation: { enabled: true, configured: true, model: 'translation-smoke', profile_id: 'translation-smoke-profile' }, chat: { enabled: true, configured: true, model: 'chat-smoke', profile_id: 'chat-smoke-profile' } } } }),
  }));
  await page.route('**/api/jobs/*/translate', async (route) => {
    const payload = route.request().postDataJSON();
    translationRequestCount += 1;
    const isSelection = payload.block_id == null || payload.block_id === '';
    if (isSelection) selectionTranslationRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ result: { text: isSelection ? '这是功能回归测试的选区译文。' : String(payload.text || '这是功能回归测试译文。'), cached: false, profile_id: 'translation-smoke-profile' } }),
    });
  });
  await page.route('**/api/jobs/*/chat', async (route) => {
    const payload = route.request().postDataJSON();
    chatRequestPayloads.push(payload);
    chatRequestContents.push(String(payload.messages?.at(-1)?.content || ''));
    if (chatResponseMode === 'deep-markdown') {
      chatResponseMode = 'normal';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ result: { text: `${'> '.repeat(10000)}deep-safe`, model: 'chat-smoke' } }),
      });
      return;
    }
    if (chatResponseMode === 'oversized-stream') {
      chatResponseMode = 'normal';
      const delta = JSON.stringify({ delta: 'x'.repeat(120001) });
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${delta}\n\ndata: ${JSON.stringify({ result: { text: 'must-not-commit' } })}\n\n`,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ result: { text: '键盘交互回归回复。依据 [p1/block-1-6-paragraph]。短引用 [p1/block-6]，带页短引用 [p1/block-1-6]。错误页 [p2/block-1-6-paragraph]。代码 `[p1/block-1-6-paragraph]`，链接 [p1/block-1-6-paragraph](https://example.com)，数学 $[p1/block-1-6-paragraph]$，恶意 [p1/block-1-6-paragraph\"><img]。', model: 'chat-smoke' } }),
    });
  });
  await page.route('**/api/jobs/*/reference-summary', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ result: { text: '该文献提供了当前段落所采用的基线方法。', evidence_level: 'abstract', sources: [{ provider: 'crossref-doi', label: 'Crossref DOI' }] } }),
  }));
  await page.route('**/api/jobs/*/auto-highlights', async (route) => {
    const highlights = [
      { block_id: 'block-1-4-paragraph', quote: 'In this paper, we present OneLLM, an MLLM that aligns eight modalities to language using a unified framework.', reason: '概括论文的统一多模态目标。', category: 'research_goal' },
      { block_id: 'block-2-3-paragraph', quote: 'OneLLM consists of lightweight modality tokenizers, a universal encoder, a universal projection module (UPM), and an LLM.', reason: '列出方法的核心组成。', category: 'method' },
      { block_id: 'block-2-8-paragraph', quote: 'OneLLM is the first MLLM that integrates eight distinct modalities within a single model.', reason: '说明论文主张的创新点。', category: 'innovation' },
      { block_id: 'block-2-9-paragraph', quote: 'OneLLM finetuned on this dataset achieves superior performance on multimodal tasks', reason: '总结论文报告的实验结论。', category: 'conclusion' },
    ];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { status: 'mock', highlights } }) });
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  const firstCard = requestedJobId
    ? page.locator(`#recent-list .library-row[data-job-id="${requestedJobId}"], .library-card[data-job-id="${requestedJobId}"]`).first()
    : page.locator('#recent-list .library-row, #recent-list .library-card').filter({ hasText: 'OneLLM: One Framework' }).first();
  await firstCard.waitFor();
  const jobId = await firstCard.getAttribute('data-job-id');
  const annotationPayload = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  for (const annotation of annotationPayload.annotations || []) {
    if (annotation.block_id !== 'block-2-1-paragraph') continue;
    await page.evaluate(async ({ id, annotationId }) => fetch(`/api/jobs/${id}/annotations/${annotationId}`, { method: 'DELETE' }), { id: jobId, annotationId: annotation.id });
  }
  await firstCard.dblclick();
  await page.locator('#reader-view.active-view').waitFor();
  const frame = page.frameLocator('#html-preview');
  await frame.locator('.pdf-page').first().waitFor();
  if (await frame.locator('figcaption[data-translate-block-id] .paragraph-translate-trigger').count()) throw new Error('Figure/table captions still exposed redundant translation buttons');

  const boldTranslationBlock = frame.locator('[data-block-id="block-2-3-paragraph"]');
  await boldTranslationBlock.evaluate((block) => {
    const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text || text.nodeValue.length < 8) throw new Error('Bold translation fixture could not be created');
    const strong = block.ownerDocument.createElement('strong');
    strong.textContent = text.nodeValue.slice(0, 8);
    text.nodeValue = text.nodeValue.slice(8);
    block.insertBefore(strong, text);
    const tone = block.ownerDocument.createElement('span');
    tone.className = 'pdf-text-tone pdf-text-tone-orange unsafe-tone-class';
    tone.dataset.textTone = 'orange';
    tone.textContent = text.nodeValue.slice(0, 8);
    text.nodeValue = text.nodeValue.slice(8);
    block.insertBefore(tone, text);
  });
  await boldTranslationBlock.locator('.paragraph-translate-trigger').click();
  const boldTranslation = frame.locator('.my-scholar-translation[data-for="block-2-3-paragraph"]');
  await boldTranslation.locator('strong[data-emphasis-source="translated-source"]').waitFor();
  await boldTranslation.locator('.pdf-text-tone.pdf-text-tone-orange[data-text-tone="orange"]').waitFor();
  if (await boldTranslation.locator('.unsafe-tone-class').count()) throw new Error('Translated fixed text tone copied an untrusted class');
  const boldTranslationText = await boldTranslation.textContent();
  if (!boldTranslationText || boldTranslationText.includes('__MY_SCHOLAR_BOLD_')) throw new Error('Bold translation leaked an emphasis marker');

  async function selectText(selector, length = 34, startOffset = 0) {
    await frame.locator(selector).evaluate((block, { take, offset }) => {
      block.scrollIntoView({ block: 'center', inline: 'nearest' });
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('.annotation-note-trigger, .paragraph-translate-trigger')) continue;
        if (node.nodeValue) nodes.push(node);
      }
      if (!nodes.length) throw new Error(`No selectable text in ${block.dataset.blockId}`);
      const total = nodes.reduce((sum, current) => sum + current.nodeValue.length, 0);
      const startIndex = Math.min(offset, Math.max(0, total - 2));
      const endIndex = Math.min(total, startIndex + take);
      let cursor = 0;
      let startPoint;
      let endPoint;
      for (const current of nodes) {
        const next = cursor + current.nodeValue.length;
        if (!startPoint && startIndex >= cursor && startIndex <= next) startPoint = [current, startIndex - cursor];
        if (!endPoint && endIndex >= cursor && endIndex <= next) { endPoint = [current, endIndex - cursor]; break; }
        cursor = next;
      }
      const range = document.createRange();
      range.setStart(...startPoint);
      range.setEnd(...endPoint);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, { take: length, offset: startOffset });
    await page.locator('#selection-popover:not([hidden])').waitFor();
    const placement = await page.evaluate(() => {
      const sidebar = document.querySelector('#reader-sidebar').getBoundingClientRect();
      const wrap = document.querySelector('.reader-frame-wrap').getBoundingClientRect();
      const popover = document.querySelector('#selection-popover').getBoundingClientRect();
      return {
        sidebarLeft: sidebar.left,
        sidebarRight: sidebar.right,
        wrapLeft: wrap.left,
        wrapRight: wrap.right,
        wrapTop: wrap.top,
        wrapBottom: wrap.bottom,
        popoverLeft: popover.left,
        popoverRight: popover.right,
        popoverTop: popover.top,
        popoverBottom: popover.bottom,
      };
    });
    if (placement.wrapRight > placement.sidebarLeft + 1 || placement.popoverLeft < placement.wrapLeft - 1 || placement.popoverRight > placement.wrapRight + 1 || placement.popoverTop < placement.wrapTop - 1 || placement.popoverBottom > placement.wrapBottom + 1) throw new Error('Selection menu was not positioned inside the right-hand reading area');
    return placement;
  }

  async function openLibraryJob(targetJobId) {
    const row = page.locator(`.library-row[data-job-id="${targetJobId}"]:visible`).first();
    await row.waitFor();
    await row.dblclick();
  }

  async function measureInlineNoteGap(popoverLocator) {
    await popoverLocator.waitFor({ state: 'visible' });
    const measurement = await popoverLocator.evaluate(async (popover) => {
      const view = popover.ownerDocument.defaultView;
      await new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
      const annotationId = popover.dataset.annotationId;
      const trigger = [...popover.ownerDocument.querySelectorAll('.annotation-note-trigger[data-annotation-id]')]
        .find((node) => node.dataset.annotationId === annotationId);
      if (!trigger) return { ready: false, reason: 'annotation trigger is missing' };
      const popoverRect = popover.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      const popoverStyle = view.getComputedStyle(popover);
      const triggerStyle = view.getComputedStyle(trigger);
      const ready = popoverStyle.display !== 'none'
        && popoverStyle.visibility !== 'hidden'
        && triggerStyle.display !== 'none'
        && triggerStyle.visibility !== 'hidden'
        && popoverRect.width > 0
        && popoverRect.height > 0
        && triggerRect.width > 0
        && triggerRect.height > 0;
      return {
        ready,
        reason: ready ? '' : `popover or trigger has no visible layout box (popover=${popoverRect.width}x${popoverRect.height}, trigger=${triggerRect.width}x${triggerRect.height}, popover-display=${popoverStyle.display}, trigger-display=${triggerStyle.display})`,
        gap: popoverRect.top - triggerRect.bottom,
      };
    });
    if (!measurement.ready) throw new Error(`Inline note position could not be measured: ${measurement.reason}`);
    return measurement.gap;
  }

  async function waitForTestSignal(signal, label, timeout = 6000) {
    let timer;
    try {
      return await Promise.race([
        signal,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  const selectionPlacement = await selectText('[data-block-id="block-2-1-paragraph"]', 34, 0);
  if (!((await page.locator('#selected-context').textContent()) || '').includes('当前选中')) throw new Error('The assistant did not mirror the live reader selection');
  await page.locator('#selection-underline').click();
  await frame.locator('mark.my-scholar-underline').last().waitFor();
  const trigger = frame.locator('[data-block-id="block-2-1-paragraph"] mark.my-scholar-underline + .annotation-note-trigger').first();
  await trigger.waitFor();
  await trigger.click();
  let popover = frame.locator('.annotation-note-popover');
  await popover.waitFor();
  if (await page.locator('#selection-popover').isVisible()) throw new Error('Selection menu leaked into the annotation popover');
  let popoverText = await popover.textContent();
  if (!popoverText.includes('还没有笔记') || !popoverText.includes('划线笔记')) throw new Error('Empty inline annotation state was not rendered');
  if (await popover.locator('.annotation-color-swatch').count() !== 8) throw new Error('The Zotero-style annotation color palette was not rendered');
  const greenSwatch = popover.locator('[data-annotation-color="#5fb236"]');
  await greenSwatch.click();
  await popover.locator('[data-annotation-color="#5fb236"][aria-pressed="true"]').waitFor();
  const annotationId = await trigger.getAttribute('data-annotation-id');
  const coloredMarkStyle = await frame.locator('[data-block-id="block-2-1-paragraph"] mark.my-scholar-underline').first().getAttribute('style');
  if (!coloredMarkStyle?.includes('#5fb236')) throw new Error('Per-annotation color was not applied to the selected mark');
  const popoverTheme = await popover.evaluate((node) => getComputedStyle(node).getPropertyValue('--annotation-color').trim());
  if (popoverTheme !== '#5fb236') throw new Error('Inline note popover did not use the selected annotation color');
  const sidebarItem = page.locator(`#annotations-list .annotation-item[data-annotation-id="${annotationId}"]`);
  if (await sidebarItem.count()) throw new Error('A pure underline leaked into the note-only sidebar');
  const persistedColor = await page.evaluate(async ({ id, annotationId: targetId }) => {
    const payload = await (await fetch(`/api/jobs/${id}/annotations`)).json();
    return payload.annotations.find((item) => item.id === targetId)?.color;
  }, { id: jobId, annotationId });
  if (persistedColor !== '#5fb236') throw new Error('Annotation color was not persisted');
  await popover.locator('[data-action="convert"]').click();
  popover = frame.locator('.annotation-note-popover');
  await popover.getByText('重点笔记', { exact: false }).waitFor();
  if (await frame.locator(`mark.my-scholar-highlight[data-annotation-id="${annotationId}"]`).count() !== 1) throw new Error('Underline did not convert to a highlight in place');
  const convertedColor = await frame.locator(`mark[data-annotation-id="${annotationId}"]`).getAttribute('style');
  if (!convertedColor?.includes('#5fb236')) throw new Error('Annotation conversion changed the selected color');
  await popover.locator('[data-action="convert"]').click();
  popover = frame.locator('.annotation-note-popover');
  await popover.getByText('划线笔记', { exact: false }).waitFor();
  if (await frame.locator(`mark.my-scholar-underline[data-annotation-id="${annotationId}"]`).count() !== 1) throw new Error('Highlight did not convert back to an underline');
  await popover.locator('[data-action="edit"]').click();
  const editor = popover.locator('.annotation-note-editor');
  if (await editor.getAttribute('contenteditable') !== 'true') throw new Error('Inline note did not use a single rich-text editing surface');
  if (await popover.locator('.annotation-note-live-preview').count()) throw new Error('The obsolete split preview is still visible');
  if (!(await popover.evaluate((node) => node.classList.contains('is-editing')))) throw new Error('Inline note did not enter editing state');
  if (await popover.locator('.annotation-note-popover-quote').isVisible()) throw new Error('The selected source sentence was repeated while editing the note');
  if (!(await popover.locator('.annotation-color-palette').isVisible())) throw new Error('The color palette disappeared while editing the note');
  if (await popover.locator('.annotation-note-formatbar[role="toolbar"]').count() !== 1) throw new Error('Inline note format toolbar was not rendered');
  if (!(await editor.evaluate((node) => node.ownerDocument.activeElement === node))) throw new Error('Inline note editor did not receive focus');
  await editor.fill('句内 smoke note');
  await editor.press('Control+A');
  const selectedEditorText = await editor.evaluate((node) => node.ownerDocument.getSelection()?.toString());
  if (selectedEditorText !== '句内 smoke note') throw new Error('Select All did not select the full inline note');
  await popover.locator('[data-format="bold"]').click();
  await editor.locator('b, strong').filter({ hasText: '句内 smoke note' }).waitFor();
  await editor.evaluate((node) => {
    node.insertAdjacentHTML('beforeend', '<p><em>斜体补充</em></p><ul><li>步骤一</li><li>步骤二</li></ul><blockquote>关键结论</blockquote>');
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = node.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7FTEAAAAASUVORK5CYII=', 'base64');
  async function pastePng(target, name) {
    const result = await target.evaluate((node, { filename, base64 }) => {
      const view = node.ownerDocument.defaultView;
      const bytes = view.Uint8Array.from(view.atob(base64), (char) => char.charCodeAt(0));
      const file = new view.File([bytes], filename, { type: 'image/png' });
      const event = new view.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          files: [],
          items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
          getData: () => '',
        },
      });
      const dispatchResult = node.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, dispatchResult };
    }, { filename: name, base64: tinyPng.toString('base64') });
    if (!result.defaultPrevented || result.dispatchResult) throw new Error('Clipboard image paste was not handled');
  }
  await pastePng(editor, 'clipboard-note.png');
  await editor.locator('img[data-note-asset]').waitFor();
  await popover.locator('[data-action="save-note"]').click();
  popover = frame.locator('.annotation-note-popover');
  await sidebarItem.waitFor({ state: 'attached' });
  const sidebarBorder = await sidebarItem.evaluate((node) => getComputedStyle(node).borderLeftColor);
  if (sidebarBorder !== 'rgb(95, 178, 54)') throw new Error(`Annotation sidebar color did not match the noted mark: ${sidebarBorder}`);
  await popover.locator('.annotation-note-popover-body strong').filter({ hasText: '句内 smoke note' }).waitFor();
  await popover.locator('.annotation-note-popover-body em').filter({ hasText: '斜体补充' }).waitFor();
  if (await popover.locator('.annotation-note-popover-body ul > li').count() !== 2) throw new Error('Inline note list formatting did not round-trip');
  await popover.locator('.annotation-note-popover-body blockquote').filter({ hasText: '关键结论' }).waitFor();
  const savedImage = popover.locator('.annotation-note-popover-body img[data-note-asset]');
  await savedImage.waitFor();
  const savedImageState = await savedImage.evaluate(async (image) => {
    if (!image.complete) await new Promise((resolve) => image.addEventListener('load', resolve, { once: true }));
    return { src: image.getAttribute('src'), ref: image.dataset.noteAsset, width: image.naturalWidth };
  });
  if (!savedImageState.src?.includes('/content/notes/assets/') || !savedImageState.ref?.startsWith('assets/') || savedImageState.width < 1) throw new Error('Inline note image did not persist as a readable local asset');
  const savedAnnotationNote = await page.evaluate(async ({ id, annotationId: targetId }) => {
    const payload = await (await fetch(`/api/jobs/${id}/annotations`)).json();
    return payload.annotations.find((item) => item.id === targetId)?.note || '';
  }, { id: jobId, annotationId });
  if (!/!\[[^\]]*\]\(assets\/[a-f0-9]{64}\.png\)/.test(savedAnnotationNote) || savedAnnotationNote.includes('data:image')) throw new Error('Inline note stored image bytes inside annotation JSON instead of a short local asset reference');
  popoverText = await popover.textContent();
  if (!popoverText.includes('句内 smoke note')) throw new Error('Add-note action did not persist the note');
  await popover.locator('[data-action="edit"]').click();
  await popover.locator('.annotation-note-editor').fill('更新后的句内 smoke note');
  const editSaveResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/jobs/${jobId}/annotations/${annotationId}`));
  await popover.locator('[data-action="save-note"]').click();
  await editSaveResponse;
  popover = frame.locator('.annotation-note-popover');
  await popover.locator('.annotation-note-popover-body').getByText('更新后的句内 smoke note', { exact: false }).waitFor();
  if (!(await popover.textContent()).includes('更新后的句内 smoke note')) throw new Error('Edit-note action did not persist the note');
  const beforeGap = await measureInlineNoteGap(popover);
  await frame.locator('[data-block-id="block-2-1-paragraph"]').evaluate(() => window.scrollBy(0, 80));
  const afterGap = await measureInlineNoteGap(popover);
  if (Math.abs(beforeGap - afterGap) > 4) throw new Error('Inline note did not follow its sentence while scrolling');
  await popover.locator('[data-action="close"]').click();
  await popover.waitFor({ state: 'detached' });

  await frame.locator('[data-block-id="block-2-2-paragraph"]').evaluate((block) => {
    const firstText = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
    if (!firstText || firstText.nodeValue.length < 20) throw new Error('Element-boundary selection fixture is unavailable');
    const range = block.ownerDocument.createRange();
    range.setStart(block, 0);
    range.setEnd(firstText, 20);
    const selection = block.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    block.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#selection-popover:not([hidden])').waitFor();
  await page.locator('#selection-highlight').click();
  await frame.locator('[data-block-id="block-2-2-paragraph"] mark.my-scholar-highlight').waitFor();

  await selectText('[data-block-id="block-1-6-paragraph"]', 28);
  if (!((await page.locator('#selected-context').textContent()) || '').includes('当前选中')) throw new Error('A plain selection was not mirrored in the right assistant');
  await page.locator('#selection-add-chat').click();
  await page.locator('#selected-context:not([hidden])').waitFor();
  const selectedContext = await page.locator('#selected-context').textContent();
  if (!selectedContext.includes('已加入 Chat · 文本') || !selectedContext.includes('Large Language Models')) throw new Error('Selected text was not pinned as the right Chat context');
  if ((await page.locator('#chat-input').inputValue()).trim()) throw new Error('加入 Chat should not overwrite the user question draft');
  const chatInput = page.locator('#chat-input');
  await chatInput.fill('第一行');
  await chatInput.press('Meta+Enter');
  if (await chatInput.inputValue() !== '第一行\n') throw new Error('Command+Enter did not insert a line break');
  await chatInput.type('第二行');
  await chatInput.press('Enter');
  await page.locator('.chat-bubble.assistant').filter({ hasText: '键盘交互回归回复。' }).waitFor();
  if (chatRequestContents.length !== 1 || chatRequestContents[0] !== '第一行\n第二行') throw new Error(`Enter did not send the multiline Chat draft exactly once (${JSON.stringify(chatRequestContents)})`);
  if (!String(chatRequestPayloads[0]?.selected_text || '').includes('Large Language Models')) throw new Error('The pinned text context was not sent with the Chat question');
  if (await chatInput.inputValue()) throw new Error('Chat input was not cleared after Enter sent the question');
  const assistantBubble = page.locator('.chat-bubble.assistant').last();
  const assistantSelection = await assistantBubble.evaluate((bubble) => {
    const text = document.createTreeWalker(bubble.querySelector('.chat-message-body'), NodeFilter.SHOW_TEXT).nextNode();
    if (!text || text.nodeValue.length < 6) throw new Error('AI answer selection fixture is unavailable');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { text: selection.toString(), userSelect: getComputedStyle(bubble).userSelect };
  });
  if (assistantSelection.text !== '键盘交互回归' || assistantSelection.userSelect !== 'text') throw new Error(`AI answer could not be partially selected (${JSON.stringify(assistantSelection)})`);
  await assistantBubble.locator('.chat-copy').click();
  if (await page.evaluate(() => window.__myScholarCopiedText) !== assistantSelection.text) throw new Error('AI answer copy button ignored the current partial selection');
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await assistantBubble.locator('.chat-copy').click();
  if (!(await page.evaluate(() => window.__myScholarCopiedText)).includes('键盘交互回归回复。')) throw new Error('AI answer copy button did not fall back to the complete answer');
  const blockReferences = assistantBubble.locator('.chat-block-reference');
  if (await blockReferences.count() !== 4) throw new Error('Canonical block references were parsed outside ordinary Markdown text');
  if (await assistantBubble.locator('code .chat-block-reference, a .chat-block-reference, math .chat-block-reference').count()) throw new Error('Code, link or math contents became block-reference controls');
  if (await assistantBubble.locator('img').count()) throw new Error('Malformed block reference created executable HTML');
  const sourceGeneration = await assistantBubble.getAttribute('data-chat-source-generation');
  if (!/^(?:base|[1-9][0-9]{0,8})$/.test(sourceGeneration || '')) throw new Error(`AI answer did not bind a canonical source generation (${sourceGeneration})`);
  const validReference = blockReferences.filter({ hasText: '[p1/block-1-6-paragraph]' }).first();
  const shortReference = blockReferences.filter({ hasText: '[p1/block-6]' }).first();
  const pageShortReference = blockReferences.filter({ hasText: '[p1/block-1-6]' }).first();
  const wrongPageReference = blockReferences.filter({ hasText: '[p2/block-1-6-paragraph]' }).first();
  await wrongPageReference.click();
  await page.locator('#toast').filter({ hasText: '未找到这条引用对应的原文位置' }).waitFor();
  await assistantBubble.evaluate((bubble) => { delete bubble.dataset.chatSourceGeneration; });
  await validReference.click();
  await frame.locator('[data-block-id="block-1-6-paragraph"].block-selected').waitFor();
  const mismatchedGeneration = sourceGeneration === '1' ? '2' : '1';
  await assistantBubble.evaluate((bubble, generation) => { bubble.dataset.chatSourceGeneration = generation; }, mismatchedGeneration);
  await shortReference.click();
  await frame.locator('[data-block-id="block-1-6-paragraph"].block-selected').waitFor();
  await assistantBubble.evaluate((bubble, generation) => { bubble.dataset.chatSourceGeneration = generation; }, sourceGeneration);
  await frame.locator('[data-block-id="block-1-6-paragraph"]').evaluate((block) => {
    const duplicate = block.ownerDocument.createElement('p');
    duplicate.dataset.blockId = 'block-1-6-heading';
    duplicate.dataset.page = '1';
    duplicate.dataset.chatAliasSmoke = 'ambiguous';
    block.insertAdjacentElement('afterend', duplicate);
  });
  await shortReference.click();
  await page.locator('#toast').filter({ hasText: '未找到这条引用对应的原文位置' }).waitFor();
  await validReference.click();
  await frame.locator('[data-block-id="block-1-6-paragraph"].block-selected').waitFor();
  await frame.locator('[data-chat-alias-smoke="ambiguous"]').evaluate((node) => node.remove());
  await pageShortReference.click();
  await frame.locator('[data-block-id="block-1-6-paragraph"].block-selected').waitFor();
  await page.waitForTimeout(2100);
  if (await frame.locator('[data-block-id="block-1-6-paragraph"].block-selected').count()) throw new Error('Temporary Chat reference highlight was not cleared');
  await page.locator('#open-chat-history').click();
  await page.locator('#chat-history-view:not([hidden])').waitFor();
  if (!(await page.locator('.sidebar-tab[data-panel="chat-panel"]').getAttribute('aria-selected') === 'true')) throw new Error('Opening Chat history deactivated the AI tab');
  const firstSessionId = await page.locator('#chat-history-list [data-chat-session-id][aria-current="true"]').getAttribute('data-chat-session-id');
  await page.locator('#new-chat-session').click();
  await page.locator('#chat-conversation-view:not([hidden])').waitFor();
  if (!(await page.locator('#chat-messages .chat-empty').count())) throw new Error('A new Chat session was not empty');
  await page.locator('#open-chat-history').click();
  const secondSessionId = await page.locator('#chat-history-list [data-chat-session-id][aria-current="true"]').getAttribute('data-chat-session-id');
  if (!firstSessionId || !secondSessionId || firstSessionId === secondSessionId || await page.locator('#chat-history-list [data-chat-session-id]').count() !== 2) throw new Error('Creating a new Chat session did not preserve the first session');
  await page.locator('#open-chat-history').click();
  const currentSessionSwitcher = page.locator('#open-chat-history');
  if (await currentSessionSwitcher.getAttribute('data-chat-session-id') !== secondSessionId || await currentSessionSwitcher.getAttribute('aria-haspopup') !== 'menu') throw new Error('Current Chat session switcher did not expose its management target');
  await page.locator('#chat-current-session-title').click({ button: 'right' });
  const currentSessionMenuGeometry = await page.locator('#chat-session-menu:not([hidden])').evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 24));
    return { parentId: menu.parentElement?.id || '', position: getComputedStyle(menu).position, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, hit: Boolean(target && menu.contains(target)) };
  });
  const chatMenuViewport = page.viewportSize();
  if (currentSessionMenuGeometry.parentId !== 'global-menu-layer' || currentSessionMenuGeometry.position !== 'fixed' || currentSessionMenuGeometry.top < 7 || currentSessionMenuGeometry.left < 7 || currentSessionMenuGeometry.right > chatMenuViewport.width - 7 || currentSessionMenuGeometry.bottom > chatMenuViewport.height - 7 || !currentSessionMenuGeometry.hit) throw new Error(`Current Chat session menu was clipped or not hit-testable (${JSON.stringify(currentSessionMenuGeometry)})`);
  await page.locator('#chat-session-menu:not([hidden]) [data-chat-session-action="rename"]').click();
  await page.locator('#chat-session-title-input').fill('当前会话右键入口');
  await page.locator('#confirm-chat-session-rename').click();
  await page.locator('#chat-session-rename-dialog').waitFor({ state: 'hidden' });
  if ((await page.locator('#chat-current-session-title').textContent())?.trim() !== '当前会话右键入口') throw new Error('Current Chat session context menu did not target the active session');
  await page.locator('#open-chat-history').click();
  if ((await page.locator(`#chat-history-list [data-chat-session-id="${secondSessionId}"] .chat-history-item-title`).textContent())?.trim() !== '当前会话右键入口') throw new Error('Current Chat session rename was not reflected in history');
  const firstSession = page.locator(`#chat-history-list [data-chat-session-id="${firstSessionId}"]`);
  await firstSession.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: Math.round(rect.left + Math.min(rect.width / 2, 40)), clientY: window.innerHeight - 2 }));
  });
  const flippedSessionMenu = await page.locator('#chat-session-menu:not([hidden])').evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 24));
    return { placement: menu.dataset.placement || '', top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, hit: Boolean(target && menu.contains(target)) };
  });
  if (flippedSessionMenu.placement !== 'top' || flippedSessionMenu.top < 7 || flippedSessionMenu.left < 7 || flippedSessionMenu.right > chatMenuViewport.width - 7 || flippedSessionMenu.bottom > chatMenuViewport.height - 7 || !flippedSessionMenu.hit) throw new Error(`History Chat session menu did not flip or remain hit-testable (${JSON.stringify(flippedSessionMenu)})`);
  await page.locator('#chat-session-menu:not([hidden]) [data-chat-session-action="rename"]').click();
  await page.locator('#chat-session-title-input').fill('<img src=x> 手动标题');
  await page.locator('#confirm-chat-session-rename').click();
  await page.locator('#chat-session-rename-dialog').waitFor({ state: 'hidden' });
  if ((await firstSession.locator('.chat-history-item-title').textContent())?.trim() !== '<img src=x> 手动标题' || await firstSession.locator('img').count()) throw new Error('Session rename did not remain literal text');
  await firstSession.click();
  const existingAssistantBubble = page.locator('.chat-bubble.assistant').filter({ hasText: '键盘交互回归回复。' }).first();
  await existingAssistantBubble.waitFor();
  await existingAssistantBubble.locator('.chat-message-body').click({ button: 'right' });
  if (await page.locator('#chat-session-menu').isVisible()) throw new Error('Right-clicking an assistant answer incorrectly opened session management');
  await page.locator('#chat-input').fill('手动标题保持');
  await page.locator('#chat-input').press('Enter');
  await page.locator('.chat-bubble.assistant').last().filter({ hasText: '键盘交互回归回复。' }).waitFor();
  await page.locator('#open-chat-history').click();
  if ((await firstSession.locator('.chat-history-item-title').textContent())?.trim() !== '<img src=x> 手动标题') throw new Error('A new message overwrote a manually renamed session');
  await firstSession.click({ button: 'right' });
  await page.locator('#chat-session-menu:not([hidden]) [data-chat-session-action="pin"]').click();
  const firstSortedSessionId = await page.locator('#chat-history-list [data-chat-session-id]').first().getAttribute('data-chat-session-id');
  if (firstSortedSessionId !== firstSessionId || !(await firstSession.locator('.chat-history-item-pin').count())) throw new Error('Pinned session did not sort before newer unpinned sessions');
  await firstSession.focus();
  await firstSession.press('Shift+F10');
  await page.locator('#chat-session-menu:not([hidden])').waitFor();
  await page.locator('.sidebar-tab[data-panel="outline-panel"]').click();
  await page.locator('#chat-session-menu').waitFor({ state: 'hidden' });
  await page.locator('.sidebar-tab[data-panel="chat-panel"]').click();
  await firstSession.focus();
  await firstSession.press('Shift+F10');
  await page.locator('#chat-session-menu:not([hidden])').waitFor();
  await page.setViewportSize({ width: 1499, height: 980 });
  await page.locator('#chat-session-menu').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.waitForTimeout(50);
  await firstSession.focus();
  await firstSession.press('Shift+F10');
  await page.locator('#chat-session-menu:not([hidden])').waitFor();
  await page.keyboard.press('Escape');
  const storedSessionMetadata = await page.evaluate(({ id, sessionId }) => {
    const envelope = JSON.parse(localStorage.getItem(`my-scholar-chat-v2:${id}`) || '{}');
    const session = envelope.sessions?.find((item) => item.id === sessionId);
    return { version: envelope.version, title: session?.title, titleMode: session?.titleMode, pinnedAt: session?.pinnedAt };
  }, { id: jobId, sessionId: firstSessionId });
  if (storedSessionMetadata.version !== 2 || storedSessionMetadata.title !== '<img src=x> 手动标题' || storedSessionMetadata.titleMode !== 'manual' || !Number.isFinite(Date.parse(storedSessionMetadata.pinnedAt || ''))) throw new Error(`Session metadata was not persisted in the v2 allowlist (${JSON.stringify(storedSessionMetadata)})`);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator(`#chat-history-list [data-chat-session-id="${secondSessionId}"]`).click({ button: 'right' });
  await page.locator('#chat-session-menu:not([hidden]) [data-chat-session-action="delete"]').click();
  if (await page.locator(`#chat-history-list [data-chat-session-id="${secondSessionId}"]`).count()) throw new Error('Deleting an inactive Chat session failed');
  page.once('dialog', (dialog) => dialog.accept());
  await firstSession.click({ button: 'right' });
  await page.locator('#chat-session-menu:not([hidden]) [data-chat-session-action="delete"]').click();
  const replacementSessionId = await page.locator('#chat-history-list [data-chat-session-id][aria-current="true"]').getAttribute('data-chat-session-id');
  if (!replacementSessionId || replacementSessionId === firstSessionId || await page.locator('#chat-history-list [data-chat-session-id]').count() !== 1) throw new Error('Deleting the final Chat session did not create one blank replacement');
  await page.locator('#open-chat-history').click();
  await page.locator('#chat-input').waitFor();

  chatResponseMode = 'deep-markdown';
  await page.locator('#chat-input').fill('测试深层 Markdown');
  await page.locator('#chat-input').press('Enter');
  const deepMarkdownBubble = page.locator('.chat-bubble.assistant').filter({ hasText: 'deep-safe' }).last();
  await deepMarkdownBubble.waitFor();
  const nestedBlockquotes = await deepMarkdownBubble.locator('blockquote').count();
  if (nestedBlockquotes > 16) throw new Error(`Model Markdown exceeded the rendering depth budget (${nestedBlockquotes})`);

  chatResponseMode = 'oversized-stream';
  await page.locator('#chat-input').fill('测试超长流式回答');
  await page.locator('#chat-input').press('Enter');
  await page.locator('.chat-bubble.assistant').filter({ hasText: '模型回答超过安全上限' }).last().waitFor();
  const persistedChatBytes = await page.evaluate((id) => {
    const value = localStorage.getItem(`my-scholar-chat-v2:${id}`) || '';
    return new TextEncoder().encode(value).byteLength;
  }, jobId);
  if (persistedChatBytes > 4 * 1024 * 1024) throw new Error(`Persisted Chat exceeded its aggregate byte budget (${persistedChatBytes})`);

  const figureImage = frame.locator('figure.pdf-figure img').first();
  await figureImage.scrollIntoViewIfNeeded();
  await figureImage.waitFor();
  let figureShell = frame.locator('figure.pdf-figure').first();
  let figureBlock = figureShell.locator(':scope > .my-scholar-media-visual.my-scholar-media-resizable');
  await figureBlock.waitFor();
  if (await figureBlock.locator('figcaption').count() || await figureShell.locator(':scope > figcaption').count() !== 1) throw new Error('Figure caption was included in the resizable visual block');
  let figureHandles = figureBlock.locator(':scope > .my-scholar-media-resize-handle');
  if (await figureHandles.count() !== 2) throw new Error('Paper figure did not expose left and right resize handles');
  const figureKey = await figureBlock.getAttribute('data-media-key');
  if (!figureKey) throw new Error('Paper figure did not receive a stable media layout key');
  const figureRightHandle = figureBlock.locator(':scope > .my-scholar-media-resize-handle.is-right');
  const resetFigureResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/jobs/${jobId}/media-layout`));
  await figureRightHandle.press('End');
  await resetFigureResponse;
  const figureBeforeResize = await figureBlock.boundingBox();
  const figureShellBeforeResize = await figureShell.boundingBox();
  const figureCaptionBeforeResize = await figureShell.locator(':scope > figcaption').boundingBox();
  const handleBox = await figureRightHandle.boundingBox();
  if (!figureBeforeResize || !figureShellBeforeResize || !figureCaptionBeforeResize || !handleBox) throw new Error('Paper figure resize geometry was unavailable');
  const figureResizeResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/jobs/${jobId}/media-layout`));
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - Math.min(140, figureBeforeResize.width * .18), handleBox.y + handleBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const persistedResizeResponse = await figureResizeResponse;
  if (!persistedResizeResponse.ok()) throw new Error(`Paper figure resize was not persisted (${persistedResizeResponse.status()})`);
  const resizedFigure = await figureBlock.evaluate((block) => ({ width: block.getBoundingClientRect().width, percent: Number(block.dataset.mediaWidth) }));
  if (!(resizedFigure.percent >= 24 && resizedFigure.percent < 96) || resizedFigure.width >= figureBeforeResize.width - 20) throw new Error(`Dragging the figure handle did not shrink it (${JSON.stringify({ before: figureBeforeResize.width, after: resizedFigure })})`);
  const figureShellAfterResize = await figureShell.boundingBox();
  const figureCaptionAfterResize = await figureShell.locator(':scope > figcaption').boundingBox();
  if (!figureShellAfterResize || !figureCaptionAfterResize || Math.abs(figureShellAfterResize.width - figureShellBeforeResize.width) > 1 || Math.abs(figureCaptionAfterResize.width - figureCaptionBeforeResize.width) > 1) throw new Error('Resizing a figure changed the outer figure or caption width');
  if (!await page.locator('#image-lightbox').isHidden()) throw new Error('Dragging a resize handle incorrectly opened the image lightbox');
  const persistedLayout = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/media-layout`)).json()).media_layout, jobId);
  if (Math.abs(Number(persistedLayout?.items?.[figureKey]?.width_percent) - resizedFigure.percent) > .11) throw new Error(`Persisted figure width did not match the reader (${JSON.stringify(persistedLayout)})`);

  // Reassigning src to itself is the standard way to force an iframe reload.
  // eslint-disable-next-line no-self-assign
  await page.locator('#html-preview').evaluate((iframe) => { iframe.src = iframe.src; });
  figureShell = frame.locator('figure.pdf-figure').first();
  figureBlock = figureShell.locator(`:scope > .my-scholar-media-visual.my-scholar-media-resizable[data-media-key="${figureKey}"]`);
  await figureBlock.waitFor();
  await figureBlock.evaluate((block, expected) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 4000;
    const check = () => {
      if (Math.abs(Number(block.dataset.mediaWidth) - expected) <= .11) resolve();
      else if (Date.now() >= deadline) reject(new Error(`Reloaded width ${block.dataset.mediaWidth} did not match ${expected}`));
      else block.ownerDocument.defaultView.requestAnimationFrame(check);
    };
    check();
  }), resizedFigure.percent);
  figureHandles = figureBlock.locator(':scope > .my-scholar-media-resize-handle');
  const reloadedRightHandle = figureBlock.locator(':scope > .my-scholar-media-resize-handle.is-right');
  if (await figureHandles.count() !== 2 || await reloadedRightHandle.getAttribute('aria-valuenow') !== String(resizedFigure.percent)) throw new Error('Reloaded figure handles did not reflect the persisted width');
  const keyboardResizeResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/jobs/${jobId}/media-layout`));
  await reloadedRightHandle.press('ArrowLeft');
  await keyboardResizeResponse;
  const keyboardWidth = Number(await figureBlock.getAttribute('data-media-width'));
  if (Math.abs(keyboardWidth - Math.max(24, resizedFigure.percent - 2)) > .11) throw new Error(`Keyboard resize used the wrong step (${keyboardWidth})`);
  const doubleClickResetResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/jobs/${jobId}/media-layout`));
  await reloadedRightHandle.dblclick();
  await doubleClickResetResponse;
  if (Number(await figureBlock.getAttribute('data-media-width')) !== 100) throw new Error('Double-clicking the figure handle did not restore full width');

  const tableShell = frame.locator('figure.pdf-table').first();
  const tableBlock = tableShell.locator(':scope > .my-scholar-media-visual.my-scholar-media-resizable');
  await tableBlock.waitFor();
  if (await tableBlock.locator('figcaption').count() || await tableShell.locator(':scope > figcaption').count() !== 1) throw new Error('Table caption was included in the resizable visual block');
  const tableHandle = tableBlock.locator(':scope > .my-scholar-media-resize-handle.is-right');
  if (await tableBlock.locator(':scope > .my-scholar-media-resize-handle').count() !== 2) throw new Error('Paper table did not expose left and right resize handles');
  const tableMinimumResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/jobs/${jobId}/media-layout`));
  await tableHandle.press('Home');
  await tableMinimumResponse;
  if (Number(await tableBlock.getAttribute('data-media-width')) !== 24) throw new Error('Table keyboard resize did not honor the minimum width');
  const tableResetResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().endsWith(`/api/jobs/${jobId}/media-layout`));
  await tableHandle.press('End');
  await tableResetResponse;
  if (Number(await tableBlock.getAttribute('data-media-width')) !== 100) throw new Error('Table keyboard reset did not restore full width');

  const figureCrossReference = frame.locator('a.cross-reference[href^="#fig-"]').first();
  const mediaCrossReference = await figureCrossReference.count() ? figureCrossReference : frame.locator('a.cross-reference[href^="#table-"]').first();
  if (await mediaCrossReference.count()) {
    const generatedPreviewAsset = `/api/jobs/${jobId}/renders/2/assets/images/preview-smoke.png`;
    await page.route(`**${generatedPreviewAsset}`, async (route) => route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    }));
    const previewFixture = await mediaCrossReference.evaluate((link, assetURL) => {
      const target = document.querySelector(link.getAttribute('href'));
      const caption = target?.querySelector('figcaption');
      if (!target || !caption) return null;
      const image = target.querySelector('img');
      if (image) image.src = assetURL;
      const blockId = caption.dataset.translateBlockId || caption.dataset.blockId || `preview-caption-${Date.now()}`;
      caption.dataset.translateBlockId = blockId;
      const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
      const row = document.createElementNS(math.namespaceURI, 'mrow');
      const symbol = document.createElementNS(math.namespaceURI, 'mi');
      symbol.textContent = 'x';
      row.append(symbol);
      math.append(row);
      const marker = document.createElement('span');
      marker.className = 'inline-legend-marker inline-legend-marker-circle inline-legend-marker-blue unsafe-preview-class';
      marker.setAttribute('role', 'img');
      marker.setAttribute('aria-label', 'untrusted source label');
      marker.innerHTML = '<span class="inline-legend-line" aria-hidden="true"></span><span class="inline-legend-shape" aria-hidden="true"></span>';
      const tone = document.createElement('span');
      tone.className = 'pdf-text-tone pdf-text-tone-orange unsafe-preview-tone';
      tone.dataset.textTone = 'orange';
      tone.textContent = ' Layer Feature Matching (LFM)';
      caption.append(' ', math, ' ', marker, tone);
      let translation = document.querySelector(`.my-scholar-translation[data-for="${CSS.escape(blockId)}"]`);
      if (!translation) {
        translation = document.createElement('div');
        translation.className = 'my-scholar-translation';
        translation.dataset.for = blockId;
        caption.insertAdjacentElement('afterend', translation);
      }
      let body = translation.querySelector('.translation-text');
      if (!body) {
        body = document.createElement('div');
        body.className = 'translation-text';
        translation.append(body);
      }
      body.replaceChildren('预览缓存译文 ', marker.cloneNode(true), ' ', tone.cloneNode(true));
      return { targetId: target.id, blockId, generatedImage: Boolean(image) };
    }, generatedPreviewAsset);
    if (!previewFixture) throw new Error('Figure/table caption preview fixture was unavailable');
    const translationRequestsBeforePreview = translationRequestCount;
    await mediaCrossReference.scrollIntoViewIfNeeded();
    const scrollBeforePreview = await frame.locator('html').evaluate((root) => root.scrollTop);
    await mediaCrossReference.dispatchEvent('click', { button: 0 });
    await page.locator('#quick-preview-panel.active-panel:not([hidden])').waitFor();
    if (!(await page.locator('#quick-preview-content :is(img,.quick-preview-table)').count())) throw new Error('Figure/table cross-reference did not open a visual quick preview');
    if (previewFixture.generatedImage && !((await page.locator('#quick-preview-content img').getAttribute('src')) || '').includes('/renders/2/assets/images/preview-smoke.png')) throw new Error('Quick preview rejected a valid generated image asset');
    if (!(await page.locator('#quick-preview-content .quick-preview-caption math mi').filter({ hasText: 'x' }).count())) throw new Error('Quick preview did not preserve structured caption MathML');
    if (!(await page.locator('#quick-preview-content .quick-preview-caption .inline-legend-marker-circle.inline-legend-marker-blue').count())) throw new Error('Quick preview did not preserve the fixed marker shape and tone');
    if (!(await page.locator('#quick-preview-content .quick-preview-caption .pdf-text-tone-orange[data-text-tone="orange"]').count())) throw new Error('Quick preview did not preserve a fixed caption text tone');
    if (await page.locator('#quick-preview-content .unsafe-preview-class').count()) throw new Error('Quick preview copied an untrusted marker class');
    if (await page.locator('#quick-preview-content .unsafe-preview-tone').count()) throw new Error('Quick preview copied an untrusted text tone class');
    if (!((await page.locator('#quick-preview-content .quick-preview-translation').textContent()) || '').includes('预览缓存译文')) throw new Error('Quick preview did not reuse the rendered caption translation');
    if (!(await page.locator('#quick-preview-content .quick-preview-translation .inline-legend-marker-circle.inline-legend-marker-blue').count())) throw new Error('Quick preview lost a translated inline marker');
    if (!(await page.locator('#quick-preview-content .quick-preview-translation .pdf-text-tone-orange[data-text-tone="orange"]').count())) throw new Error('Quick preview lost a translated fixed text tone');
    if (translationRequestCount !== translationRequestsBeforePreview) throw new Error('Opening quick preview triggered an implicit translation request');
    const scrollAfterPreview = await frame.locator('html').evaluate((root) => root.scrollTop);
    if (Math.abs(scrollAfterPreview - scrollBeforePreview) > 2) throw new Error('Plain cross-reference click changed the reader position');
    await page.locator('#close-quick-preview').click();
  }
  const citation = frame.locator('a.citation[data-ref]').first();
  if (await citation.count()) {
    await citation.hover();
    await frame.locator('.reference-hover-card').waitFor();
    if (!((await frame.locator('.reference-hover-card').textContent()) || '').trim()) throw new Error('Citation hover preview was empty');
    await citation.click();
    await page.locator('#quick-preview-panel.active-panel:not([hidden])').waitFor();
    if (!(await page.locator('#quick-preview-content .quick-preview-reference').count())) throw new Error('Citation click did not open its reference quick preview');
    await page.locator('#quick-preview-content .quick-preview-actions button').click();
    await page.locator('#quick-preview-content .quick-preview-ai').filter({ hasText: '当前段落所采用的基线方法' }).waitFor();
    if (!((await page.locator('#quick-preview-content .quick-preview-ai-source').textContent()) || '').includes('Crossref DOI')) throw new Error('Reference quick read did not display evidence provenance');
    await page.locator('#close-quick-preview').click();
  }

  const figureDetails = await figureImage.evaluate(async (image) => {
    if (!image.complete) await new Promise((resolve) => image.addEventListener('load', resolve, { once: true }));
    const figure = image.closest('figure');
    const captionNode = figure?.querySelector('figcaption');
    const captionClone = captionNode?.cloneNode(true);
    captionClone?.querySelectorAll('.inline-legend-marker').forEach((marker) => {
      const tone = ['gray', 'blue', 'orange', 'green', 'red', 'purple', 'pink'].find((value) => marker.classList.contains(`inline-legend-marker-${value}`));
      const glyph = marker.classList.contains('inline-legend-marker-circle') ? '—●' : '—■';
      marker.replaceWith(tone ? `[${tone} ${glyph}]` : '');
    });
    return {
      src: image.currentSrc,
      caption: captionClone?.textContent?.replace(/\s+/gu, ' ').trim() || '',
      blockId: figure?.dataset.blockId || '',
      page: figure?.dataset.page || '',
      naturalWidth: image.naturalWidth,
      tabIndex: image.tabIndex,
    };
  });
  if (!figureDetails.naturalWidth || figureDetails.tabIndex !== 0) throw new Error(`Reader image was not loaded or keyboard accessible (${JSON.stringify(figureDetails)})`);
  const pagesBeforeLightbox = page.context().pages().length;
  await figureImage.click();
  const lightbox = page.locator('#image-lightbox:not([hidden])');
  await lightbox.waitFor();
  const enlargedSource = await page.locator('#image-lightbox-image').getAttribute('src');
  if (new URL(enlargedSource, baseURL).href !== figureDetails.src || page.context().pages().length !== pagesBeforeLightbox) throw new Error('Clicking a paper image did not use the in-app lightbox');
  const lightboxAccessibility = await page.evaluate(() => ({
    mainInert: document.querySelector('main')?.inert,
    headerInert: document.querySelector('.app-header')?.inert,
    focused: document.activeElement?.id || '',
  }));
  if (!lightboxAccessibility.mainInert || !lightboxAccessibility.headerInert || lightboxAccessibility.focused !== 'image-lightbox-close') throw new Error(`Lightbox did not isolate and focus its modal surface (${JSON.stringify(lightboxAccessibility)})`);
  await page.keyboard.press('Tab');
  if (await page.evaluate(() => document.activeElement?.id || '') !== 'image-lightbox-close') throw new Error('Tab escaped the image lightbox focus trap');
  await page.locator('#image-lightbox-image').click();
  if (await page.locator('#image-lightbox').isHidden()) throw new Error('Clicking the enlarged image incorrectly closed the lightbox');
  await page.locator('[data-image-lightbox-backdrop]').evaluate((node) => node.click());
  if (!await page.locator('#image-lightbox').evaluate((node) => node.classList.contains('is-closing'))) throw new Error('Lightbox closed without its restrained exit state');
  await page.locator('#image-lightbox').waitFor({ state: 'hidden' });
  if (await page.locator('.app-shell').evaluate((node) => node.inert)) throw new Error('Closing the lightbox left the application inert');
  await figureImage.click();
  await lightbox.waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#image-lightbox').waitFor({ state: 'hidden' });
  if (!await figureImage.evaluate((image) => image.ownerDocument.activeElement === image)) throw new Error('Escape did not restore focus to the source image');

  await figureImage.click({ button: 'right' });
  const imageMenu = page.locator('#image-context-menu:not([hidden])');
  await imageMenu.waitFor();
  if (await imageMenu.locator('[data-image-action="copy"]').count() !== 1 || await imageMenu.locator('[data-image-action="add-chat"]').count() !== 1) throw new Error('Image context menu did not expose copy and Chat actions');
  const menuRect = await imageMenu.boundingBox();
  const viewport = page.viewportSize();
  if (!menuRect || menuRect.x < 0 || menuRect.y < 0 || menuRect.x + menuRect.width > viewport.width || menuRect.y + menuRect.height > viewport.height) throw new Error(`Image context menu escaped the viewport (${JSON.stringify(menuRect)})`);
  await imageMenu.locator('[data-image-action="copy"]').click();
  await page.locator('#toast').filter({ hasText: '图片已复制到剪贴板' }).waitFor();
  const copiedTypes = await page.evaluate(() => window.__myScholarCopiedImageTypes);
  if (copiedTypes.length !== 1 || !copiedTypes[0].includes('image/png')) throw new Error(`Image copy did not write a PNG clipboard item (${JSON.stringify(copiedTypes)})`);

  await chatInput.fill('请解释这张图的结构');
  await figureImage.click({ button: 'right' });
  await page.locator('#image-context-menu [data-image-action="add-chat"]').click();
  const imageContext = page.locator('#selected-context:not([hidden])');
  await imageContext.locator('.selected-context-image').waitFor();
  if (!((await imageContext.textContent()) || '').includes('已加入 Chat · 图片')) throw new Error('Image context was not shown in the Chat panel');
  if (await chatInput.inputValue() !== '请解释这张图的结构') throw new Error('Adding an image to Chat overwrote the question draft');
  if (new URL(await imageContext.locator('.selected-context-image').getAttribute('src'), baseURL).href !== figureDetails.src) throw new Error('Chat image preview did not match the selected paper image');
  await chatInput.press('Enter');
  await page.locator('.chat-bubble.assistant').last().filter({ hasText: '键盘交互回归回复。' }).waitFor();
  const imageChatPayloads = chatRequestPayloads.filter((payload) => payload.selected_image);
  const imageChatPayload = imageChatPayloads.at(-1);
  if (imageChatPayloads.length !== 1 || imageChatPayload.selected_text || !imageChatPayload.selected_image?.path?.startsWith('assets/images/') || imageChatPayload.selected_image.block_id !== figureDetails.blockId || String(imageChatPayload.selected_image.page) !== String(figureDetails.page) || imageChatPayload.selected_image.caption !== figureDetails.caption) {
    throw new Error(`Image Chat payload was not scoped to the selected local figure (${JSON.stringify(imageChatPayload)})`);
  }

  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.__restoreFeatureSmokeFetch = () => { window.fetch = originalFetch; delete window.__restoreFeatureSmokeFetch; };
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      let payload = null;
      try { payload = JSON.parse(init?.body || '{}'); } catch (_) { /* Delegate malformed or unrelated requests. */ }
      const question = payload?.messages?.at?.(-1)?.content;
      if (!url.includes('/chat') || question !== '流式选区回归') return originalFetch(input, init);
      const encoder = new TextEncoder();
      const first = '流式选区开始，可以稳定选择。公式 $x^2$。';
      const second = '后续增量不会破坏选区。';
      return new Response(new ReadableStream({
        start(controller) {
          const send = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          send({ delta: first });
          window.setTimeout(() => send({ delta: second }), 900);
          window.setTimeout(() => { send({ result: { text: `${first}${second}最终结果已完成。`, model: 'chat-stream-smoke' } }); controller.close(); }, 3000);
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
    };
  });
  await chatInput.fill('流式选区回归');
  await chatInput.press('Enter');
  const streamingSelectionBubble = page.locator('.chat-bubble.assistant').last();
  await streamingSelectionBubble.filter({ hasText: '流式选区开始' }).waitFor();
  await page.locator('#open-chat-history').click();
  const streamingSession = page.locator('#chat-history-list [data-chat-session-id][aria-current="true"]');
  await streamingSession.click({ button: 'right' });
  const streamingDelete = page.locator('#chat-session-menu:not([hidden]) [data-chat-session-action="delete"]');
  if (!await streamingDelete.isDisabled()) throw new Error('A streaming Chat session exposed an enabled delete action');
  await page.keyboard.press('Escape');
  await page.locator('#open-chat-history').click();
  const streamSelectionPoints = () => streamingSelectionBubble.evaluate((bubble) => {
    const body = bubble.querySelector('.chat-message-body');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.nodeValue.includes('流式选区开始')) text = walker.nextNode();
    if (!text) throw new Error('Streaming selection text node is unavailable');
    const startOffset = text.nodeValue.indexOf('流式选区开始');
    const endOffset = startOffset + '流式选区开始'.length;
    const startRange = document.createRange();
    startRange.setStart(text, startOffset);
    startRange.setEnd(text, startOffset + 1);
    const endRange = document.createRange();
    endRange.setStart(text, endOffset - 1);
    endRange.setEnd(text, endOffset);
    const start = startRange.getBoundingClientRect();
    const end = endRange.getBoundingClientRect();
    return { start: { x: start.left + 1, y: start.top + start.height / 2 }, end: { x: end.right - 1, y: end.top + end.height / 2 } };
  });
  let selectionPoints = await streamSelectionPoints();
  const lockedBody = await streamingSelectionBubble.locator('.chat-message-body').elementHandle();
  await page.mouse.move(selectionPoints.start.x, selectionPoints.start.y);
  await page.mouse.down();
  await page.waitForTimeout(1050);
  if (!await lockedBody.evaluate((node) => node.isConnected)) throw new Error('Pointerdown lock allowed a streaming delta to replace the answer body');
  if ((await streamingSelectionBubble.textContent()).includes('后续增量不会破坏选区')) throw new Error('Pointerdown lock committed a streaming delta before the selection gesture completed');
  await page.mouse.up();
  await streamingSelectionBubble.filter({ hasText: '后续增量不会破坏选区' }).waitFor();
  selectionPoints = await streamSelectionPoints();
  await page.mouse.move(selectionPoints.start.x, selectionPoints.start.y);
  await page.mouse.down();
  await page.mouse.move(selectionPoints.end.x, selectionPoints.end.y, { steps: 6 });
  await page.mouse.up();
  const streamingSelectedText = await page.evaluate(() => document.getSelection()?.toString() || '');
  if (!streamingSelectedText.includes('流式选区')) throw new Error(`Real pointer selection did not survive a streaming delta (${JSON.stringify(streamingSelectedText)})`);
  await page.waitForTimeout(2200);
  if ((await streamingSelectionBubble.textContent()).includes('最终结果已完成')) throw new Error('Final streaming revision replaced a bubble while its selection was active');
  if ((await page.evaluate(() => document.getSelection()?.toString() || '')) !== streamingSelectedText) throw new Error('Math hydration or final stream rendering destroyed the active selection');
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await streamingSelectionBubble.filter({ hasText: '最终结果已完成' }).waitFor();
  if (await streamingSelectionBubble.evaluate((bubble) => bubble.classList.contains('is-streaming'))) throw new Error('Deferred streaming render did not flush the completed revision');
  await page.evaluate(() => window.__restoreFeatureSmokeFetch?.());

  await frame.locator('[data-block-id="block-1-6-paragraph"]').evaluate((block) => {
    const translation = document.createElement('div');
    translation.className = 'my-scholar-translation';
    translation.dataset.blockId = 'translation-smoke';
    translation.dataset.translationFor = block.dataset.blockId;
    translation.dataset.page = block.dataset.page || '1';
    translation.innerHTML = '<div class="translation-text">这是一个用于验证译文选区标注的中文段落。</div>';
    block.insertAdjacentElement('afterend', translation);
  });
  await selectText('[data-block-id="translation-smoke"]', 12);
  await page.locator('#selection-highlight-note').click();
  popover = frame.locator('.annotation-note-popover');
  await popover.locator('.annotation-note-editor').waitFor();
  await popover.locator('.annotation-note-editor').fill('译文重点 **smoke**');
  await popover.locator('[data-action="save-note"]').click();
  await frame.locator('[data-block-id="translation-smoke"] mark.my-scholar-highlight').waitFor();

  await page.locator('#auto-highlight-button').click();
  await page.locator('#highlights-panel.active-panel:not([hidden])').waitFor({ timeout: 120000 });
  await page.locator('#highlights-list .highlight-card').first().waitFor();
  const readTypographySurfaces = () => page.evaluate(() => {
    const measure = (node) => {
      const style = getComputedStyle(node);
      return { fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
    };
    const frameDocument = document.querySelector('#html-preview')?.contentDocument;
    const chatMessages = document.querySelector('#chat-messages');
    let chatEmpty = chatMessages.querySelector('.chat-empty');
    let temporaryEmpty = false;
    if (!chatEmpty) {
      chatEmpty = document.createElement('div');
      chatEmpty.className = 'chat-empty';
      chatEmpty.textContent = 'Typography smoke prompt';
      chatMessages.append(chatEmpty);
      temporaryEmpty = true;
    }
    let chatBubble = chatMessages.querySelector('.chat-bubble.assistant');
    let temporaryBubble = false;
    if (!chatBubble) {
      chatBubble = document.createElement('div');
      chatBubble.className = 'chat-bubble assistant';
      chatBubble.textContent = 'Typography smoke reply';
      chatMessages.append(chatBubble);
      temporaryBubble = true;
    }
    let paragraphTranslation = frameDocument.querySelector('.my-scholar-translation:not(.title-translation)');
    let temporaryParagraphTranslation = false;
    if (!paragraphTranslation) {
      paragraphTranslation = frameDocument.createElement('div');
      paragraphTranslation.className = 'my-scholar-translation';
      paragraphTranslation.textContent = '中文译文字体测量';
      frameDocument.querySelector('.reader-content')?.append(paragraphTranslation);
      temporaryParagraphTranslation = true;
    }
    const surfaces = {
      reader: measure(frameDocument.querySelector('.reader-content')),
      readingHighlight: measure(document.querySelector('#highlights-list .highlight-card-quote')),
      manualHighlight: measure(document.querySelector('#annotations-list .annotation-quote')),
      articleNote: measure(document.querySelector('#notes-editor')),
      translation: measure(document.querySelector('#selection-translation-result')),
      paragraphTranslation: measure(paragraphTranslation),
      chatBubble: measure(chatBubble),
      chatEmpty: measure(chatEmpty),
      chatInput: measure(document.querySelector('#chat-input')),
      sidebarTab: measure(document.querySelector('.sidebar-tab')),
      assistantToggle: measure(document.querySelector('#assistant-toggle')),
      panelHeading: measure(document.querySelector('#highlights-panel .panel-intro strong')),
    };
    if (temporaryEmpty) chatEmpty.remove();
    if (temporaryBubble) chatBubble.remove();
    if (temporaryParagraphTranslation) paragraphTranslation.remove();
    return surfaces;
  });
  const typographyBeforeScale = await readTypographySurfaces();
  await page.locator('#font-size-range').evaluate((node) => { node.value = '120'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#line-height-range').evaluate((node) => { node.value = '195'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(240);
  const typographyAfterScale = await readTypographySurfaces();
  for (const surface of ['reader', 'readingHighlight', 'manualHighlight', 'articleNote', 'translation', 'paragraphTranslation', 'chatBubble', 'panelHeading']) {
    const before = typographyBeforeScale[surface];
    const after = typographyAfterScale[surface];
    if (after.fontSize < before.fontSize * 1.16 || after.lineHeight < before.lineHeight * 1.10) throw new Error(`Reader typography did not scale ${surface} (${JSON.stringify({ before, after })})`);
  }
  for (const surface of ['readingHighlight', 'articleNote']) {
    const after = typographyAfterScale[surface];
    if (Math.abs(after.fontSize - typographyAfterScale.reader.fontSize) > 0.2 || Math.abs(after.lineHeight - typographyAfterScale.reader.lineHeight) > 0.2) throw new Error(`Reader content typography diverged for ${surface} (${JSON.stringify(typographyAfterScale)})`);
  }
  if (Math.abs(typographyAfterScale.chatBubble.fontSize - typographyAfterScale.paragraphTranslation.fontSize) > 0.2 || Math.abs(typographyAfterScale.chatBubble.lineHeight - typographyAfterScale.paragraphTranslation.lineHeight) > 0.2) throw new Error(`AI answer typography did not align with the Chinese translation (${JSON.stringify(typographyAfterScale)})`);
  for (const surface of ['manualHighlight', 'translation']) {
    const after = typographyAfterScale[surface];
    if (after.fontSize >= typographyAfterScale.reader.fontSize * .9 || after.lineHeight >= typographyAfterScale.reader.lineHeight * .9 || after.lineHeight < after.fontSize * 1.4) throw new Error(`Compact annotation typography was not preserved for ${surface} (${JSON.stringify(typographyAfterScale)})`);
  }
  const normalizedReaderFont = typographyAfterScale.reader.fontFamily.replace(/["']/gu, '').replace(/\s+/gu, '').toLowerCase();
  for (const surface of ['readingHighlight', 'manualHighlight', 'articleNote', 'chatBubble']) {
    const normalizedSurfaceFont = typographyAfterScale[surface].fontFamily.replace(/["']/gu, '').replace(/\s+/gu, '').toLowerCase();
    if (normalizedSurfaceFont !== normalizedReaderFont) throw new Error(`Reader note font diverged for ${surface} (${JSON.stringify(typographyAfterScale)})`);
  }
  const assistantTokens = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const toolbar = getComputedStyle(document.querySelector('.action-button'));
    return { toolbarSize: parseFloat(toolbar.fontSize), appFont: body.fontFamily };
  });
  const normalizedAppFont = assistantTokens.appFont.replace(/["']/gu, '').replace(/\s+/gu, '').toLowerCase();
  for (const surface of ['chatEmpty', 'chatInput', 'sidebarTab', 'assistantToggle']) {
    const after = typographyAfterScale[surface];
    const normalizedSurfaceFont = after.fontFamily.replace(/["']/gu, '').replace(/\s+/gu, '').toLowerCase();
    if (Math.abs(after.fontSize - assistantTokens.toolbarSize) > 0.2 || normalizedSurfaceFont !== normalizedAppFont) throw new Error(`Assistant UI typography diverged from the top toolbar for ${surface} (${JSON.stringify({ assistantTokens, typographyAfterScale })})`);
  }
  await page.locator('#font-size-range').evaluate((node) => { node.value = '100'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#line-height-range').evaluate((node) => { node.value = '172'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  const isAIAnnotation = (item) => item.source === 'ai' || (item.source !== 'manual' && item.kind === 'highlight' && item.start == null && item.end == null);
  const initialSplitAnnotations = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  const aiCount = (initialSplitAnnotations.annotations || []).filter((item) => isAIAnnotation(item)).length;
  if (!aiCount) throw new Error('Automatic highlights were not persisted with AI source');
  const initialNotedCount = (initialSplitAnnotations.annotations || []).filter((item) => !isAIAnnotation(item) && String(item.note || '').trim()).length;
  if (await page.locator('#annotations-list .annotation-item').count() !== initialNotedCount) throw new Error('Pure marks or AI reading highlights leaked into the note-only annotation panel');
  if ((await page.locator('#annotation-count').textContent()) !== `${initialNotedCount} 条笔记`) throw new Error('The note-only annotation count was incorrect');
  if (!(await frame.locator('mark.my-scholar-ai-suggestion[data-annotation-source="ai"]').count())) throw new Error('Automatic highlights did not render as AI suggestions');
  if (!(await page.locator('#highlights-list .highlight-group').count())) throw new Error('Automatic highlights were not grouped by research category');
  for (const category of ['research_goal', 'method', 'innovation', 'conclusion']) {
    if (!(await page.locator(`#highlights-list .highlight-group-${category}`).count())) throw new Error(`Missing ${category} highlight group`);
    if (!(await frame.locator(`mark.my-scholar-highlight-${category}`).count())) throw new Error(`Missing ${category} inline highlight color`);
  }
  if (!(await page.locator('#highlight-ai-status').textContent()).includes('点击可采纳或忽略')) throw new Error('Highlight panel did not explain the AI suggestion workflow');

  const firstAIMark = frame.locator('mark.my-scholar-ai-suggestion[data-annotation-source="ai"]').first();
  const firstAIId = await firstAIMark.getAttribute('data-annotation-id');
  const firstAIPresentation = await firstAIMark.evaluate((node) => ({
    role: node.getAttribute('role'),
    hasPopup: node.getAttribute('aria-haspopup'),
    expanded: node.getAttribute('aria-expanded'),
    title: node.getAttribute('title'),
    decoration: getComputedStyle(node).textDecorationStyle,
    userColor: node.dataset.userColor || '',
  }));
  if (firstAIPresentation.role !== 'button' || firstAIPresentation.hasPopup !== 'dialog' || firstAIPresentation.expanded !== 'false' || !firstAIPresentation.title.includes('AI 阅读建议') || firstAIPresentation.decoration !== 'dotted' || firstAIPresentation.userColor) throw new Error('AI suggestion styling or semantics were not distinct from personal highlights');
  const firstAIRecord = (initialSplitAnnotations.annotations || []).find((item) => item.id === firstAIId);
  await firstAIMark.evaluate((mark) => {
    const node = [...mark.childNodes].find((item) => item.nodeType === Node.TEXT_NODE && item.nodeValue);
    const range = mark.ownerDocument.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(12, node.nodeValue.length));
    const selection = mark.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    mark.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#selection-popover:not([hidden])').waitFor();
  await firstAIMark.evaluate((mark) => {
    mark.ownerDocument.getSelection().removeAllRanges();
    mark.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#selection-popover').waitFor({ state: 'hidden' });
  await firstAIMark.click();
  popover = frame.locator('.annotation-note-popover.ai-suggestion-popover');
  await popover.getByText('AI 生成内容 · 仅供参考', { exact: false }).waitFor();
  if (await popover.locator('[data-action="ai-add-note"]').count() !== 1 || await popover.locator('[data-action="ai-adopt"]').count() !== 1 || await popover.locator('[data-action="ai-ignore"]').count() !== 1) throw new Error('AI suggestion actions were incomplete');
  const firstCardReasonNode = page.locator(`.highlight-card[data-ai-annotation-id="${firstAIId}"] .highlight-card-reason`);
  const firstCardReason = await firstCardReasonNode.count() ? (await firstCardReasonNode.textContent())?.trim() : '';
  if (firstCardReason && !(await popover.textContent()).includes(firstCardReason)) throw new Error('AI suggestion card and inline dialog displayed different reasons');
  if (await firstAIMark.getAttribute('aria-expanded') !== 'true' || !(await popover.locator('[data-action="ai-add-note"]').evaluate((node) => node.ownerDocument.activeElement === node))) throw new Error('AI suggestion dialog did not move focus to its first action');
  await popover.locator('[data-action="ai-add-note"]').press('Escape');
  await popover.waitFor({ state: 'detached' });
  if (await firstAIMark.getAttribute('aria-expanded') !== 'false' || !(await firstAIMark.evaluate((node) => node.ownerDocument.activeElement === node))) throw new Error('AI suggestion dialog did not restore focus after Escape');
  await firstAIMark.click();
  popover = frame.locator('.annotation-note-popover.ai-suggestion-popover');
  await popover.locator('[data-action="ai-add-note"]').waitFor();
  await popover.locator('[data-action="ai-add-note"]').click();
  popover = frame.locator('.annotation-note-popover');
  const aiCreatedEditor = popover.locator('.annotation-note-editor');
  await aiCreatedEditor.waitFor();
  if ((await aiCreatedEditor.textContent()).trim()) throw new Error('AI reason leaked into a new personal note');
  await aiCreatedEditor.fill('从 AI 建议创建的个人笔记');
  await popover.locator('[data-action="save-note"]').click();
  await popover.getByText('从 AI 建议创建的个人笔记', { exact: false }).waitFor();
  const afterAddNote = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  const firstManual = (afterAddNote.annotations || []).find((item) => !isAIAnnotation(item) && item.block_id === firstAIRecord.block_id && item.quote === firstAIRecord.quote);
  if (!firstManual || firstManual.note !== '从 AI 建议创建的个人笔记' || !Number.isFinite(firstManual.start) || !Number.isFinite(firstManual.end)) throw new Error('Adding a note from an AI suggestion did not create a positioned personal annotation');
  if (await frame.locator(`mark[data-annotation-id="${firstAIId}"],mark[data-annotation-id="${firstManual.id}"]`).count() !== 1) throw new Error('AI and personal highlights were rendered on top of each other');
  if (await frame.locator(`mark[data-annotation-id="${firstManual.id}"][data-user-color="true"]`).count() !== 1) throw new Error('Adopted AI suggestion did not become a personal-color highlight');
  await page.locator(`.highlight-card[data-ai-annotation-id="${firstAIId}"][data-highlight-state="accepted"]`).waitFor();
  await popover.locator('[data-action="close"]').click();

  const secondAIMark = frame.locator('mark.my-scholar-ai-suggestion[data-annotation-source="ai"]').first();
  const secondAIId = await secondAIMark.getAttribute('data-annotation-id');
  await page.locator(`.highlight-card[data-ai-annotation-id="${secondAIId}"] [data-highlight-action="adopt"]`).click();
  await page.locator(`.highlight-card[data-ai-annotation-id="${secondAIId}"][data-highlight-state="accepted"]`).waitFor();
  const afterAdopt = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  const secondAIRecord = (afterAdopt.annotations || []).find((item) => item.id === secondAIId);
  const secondManual = (afterAdopt.annotations || []).find((item) => !isAIAnnotation(item) && item.block_id === secondAIRecord.block_id && item.quote === secondAIRecord.quote);
  if (!secondManual || secondManual.note) throw new Error('Convert-to-highlight did not create an empty personal highlight');
  await frame.locator('.annotation-note-popover [data-action="close"]').click();

  const ignoredAIMark = frame.locator('mark.my-scholar-ai-suggestion[data-annotation-source="ai"]').first();
  const ignoredAIId = await ignoredAIMark.getAttribute('data-annotation-id');
  const ignoredAIBlockId = await ignoredAIMark.evaluate((mark) => mark.closest('[data-block-id]')?.dataset.blockId || '');
  await page.locator('.sidebar-tab[data-panel="notes-panel"]').click();
  await page.locator('#notes-panel.active-panel:not([hidden])').waitFor();
  await ignoredAIMark.click();
  popover = frame.locator('.annotation-note-popover.ai-suggestion-popover');
  await popover.locator('[data-action="ai-ignore"]').press('Enter');
  await page.locator(`.highlight-card[data-ai-annotation-id="${ignoredAIId}"][data-highlight-state="ignored"]`).waitFor({ state: 'attached' });
  if (await frame.locator(`mark[data-annotation-id="${ignoredAIId}"]`).count()) throw new Error('Ignored AI suggestion remained visible in the article');
  const focusAfterHiddenPanelIgnore = await frame.locator('body').evaluate((body, blockId) => {
    const active = body.ownerDocument.activeElement;
    return Boolean(active && (active.matches?.('.my-scholar-ai-suggestion[data-annotation-id]') || active.dataset.blockId === blockId));
  }, ignoredAIBlockId);
  if (!focusAfterHiddenPanelIgnore) throw new Error('Ignoring an AI suggestion from a hidden highlights panel lost keyboard focus');

  await page.reload({ waitUntil: 'networkidle' });
  await openLibraryJob(jobId);
  await page.locator('#reader-view.active-view').waitFor();
  await frame.locator('.pdf-page').first().waitFor();
  await page.locator('.sidebar-tab[data-panel="highlights-panel"]').click();
  await page.locator(`.highlight-card[data-ai-annotation-id="${ignoredAIId}"][data-highlight-state="ignored"]`).waitFor({ timeout: 120000 });
  await page.locator(`.highlight-card[data-ai-annotation-id="${firstAIId}"][data-highlight-state="accepted"]`).waitFor();
  if (await frame.locator(`mark[data-annotation-id="${ignoredAIId}"]`).count()) throw new Error('Ignored AI suggestion returned after reload');
  const regenerateResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/jobs/${jobId}/auto-highlights`));
  await page.locator('#auto-highlight-button').click();
  await regenerateResponse;
  await page.locator(`.highlight-card[data-ai-annotation-id="${ignoredAIId}"][data-highlight-state="ignored"]`).waitFor();
  if (await frame.locator(`mark[data-annotation-id="${ignoredAIId}"]`).count()) throw new Error('Ignored AI suggestion returned after regenerating highlights');

  const splitAnnotations = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  const manualAnnotations = (splitAnnotations.annotations || []).filter((item) => !isAIAnnotation(item));
  const aiAnnotations = (splitAnnotations.annotations || []).filter((item) => isAIAnnotation(item));
  const manualCount = manualAnnotations.length;
  const notedCount = manualAnnotations.filter((item) => String(item.note || '').trim()).length;

  await page.locator('.sidebar-tab[data-panel="annotations-panel"]').click();
  await page.locator('#annotations-panel.active-panel:not([hidden])').waitFor();
  const clearButton = page.locator('#clear-annotations-button');
  if (await clearButton.isDisabled()) throw new Error('Clear-all annotations button was disabled while manual annotations existed');
  await clearButton.click();
  await page.locator('#confirm-dialog[open]').waitFor();
  if ((await page.locator('#confirm-title').textContent()) !== '清空全部个人标注') throw new Error('Clear-all confirmation title was incorrect');
  const confirmationMessage = await page.locator('#confirm-message').textContent();
  if (!confirmationMessage.includes(`${manualCount} 条个人标注`) || !confirmationMessage.includes(`${notedCount} 条包含笔记`) || !confirmationMessage.includes('纯高亮和划线也会一并删除') || !confirmationMessage.includes('AI 阅读重点不会受到影响')) throw new Error('Clear-all confirmation did not explain its scope');
  await page.locator('#confirm-cancel').click();
  await page.locator('#confirm-dialog').waitFor({ state: 'hidden' });
  const afterCancel = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  const afterCancelManualIds = (afterCancel.annotations || []).filter((item) => !isAIAnnotation(item)).map((item) => item.id).sort();
  if (JSON.stringify(afterCancelManualIds) !== JSON.stringify(manualAnnotations.map((item) => item.id).sort())) throw new Error('Cancelling clear-all annotations changed persisted notes');

  await clearButton.click();
  await page.locator('#confirm-dialog[open]').waitFor();
  const deleteResponsePromise = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/jobs/${jobId}/annotations`));
  await page.locator('#confirm-accept').click();
  const deleteResponse = await deleteResponsePromise;
  if (!deleteResponse.ok()) throw new Error(`Clear-all annotations request failed: ${deleteResponse.status()}`);
  const deletePayload = await deleteResponse.json();
  if (deletePayload.deleted !== manualCount) throw new Error('Clear-all annotations response reported the wrong deletion count');
  await page.waitForFunction(() => document.querySelector('#annotation-count')?.textContent === '0 条笔记');
  if (!(await clearButton.isDisabled())) throw new Error('Clear-all annotations button remained enabled after clearing');
  if (await page.locator('#annotations-list .annotation-item').count()) throw new Error('Manual annotations remained in the sidebar after clearing');
  const afterClear = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/annotations`)).json(), jobId);
  if ((afterClear.annotations || []).some((item) => !isAIAnnotation(item))) throw new Error('Manual annotations remained persisted after clearing');
  const remainingAIIds = (afterClear.annotations || []).filter((item) => isAIAnnotation(item)).map((item) => item.id).sort();
  if (JSON.stringify(remainingAIIds) !== JSON.stringify(aiAnnotations.map((item) => item.id).sort())) throw new Error('Clearing manual annotations changed AI reading highlights');
  for (const item of manualAnnotations) {
    if (await frame.locator(`[data-annotation-id="${item.id}"]`).count()) throw new Error('A manual inline annotation remained after clearing');
  }
  if (!(await page.locator('#highlights-list .highlight-card').count()) || !(await frame.locator('mark.my-scholar-highlight').count())) throw new Error('AI reading highlights disappeared after clearing manual annotations');
  await page.locator(`.highlight-card[data-ai-annotation-id="${firstAIId}"][data-highlight-state="suggested"]`).waitFor({ state: 'attached' });
  await page.locator(`.highlight-card[data-ai-annotation-id="${ignoredAIId}"][data-highlight-state="ignored"]`).waitFor({ state: 'attached' });

  await page.locator('.sidebar-tab[data-panel="notes-panel"]').click();
  await page.locator('#notes-panel.active-panel:not([hidden])').waitFor();
  const originalArticleNotes = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  let notesEditor = page.locator('#notes-editor[contenteditable="true"]');
  if (await page.locator('#notes-preview, .notes-preview-label').count()) throw new Error('The obsolete split article-note preview is still rendered');
  if (await notesEditor.getAttribute('role') !== 'textbox' || await notesEditor.getAttribute('aria-multiline') !== 'true') throw new Error('The unified article-note editor is missing textbox accessibility semantics');
  await notesEditor.evaluate((node) => node.replaceChildren());
  await notesEditor.fill('前文后文');
  await notesEditor.evaluate((node) => {
    const text = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
    if (!text || text.nodeValue.length < 2) throw new Error('Article-note caret fixture was not created');
    const range = node.ownerDocument.createRange();
    range.setStart(text, 2);
    range.collapse(true);
    const selection = node.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    node.focus();
  });
  await pastePng(notesEditor, 'clipboard-article-note.png');
  const articleNoteImage = notesEditor.locator('img[data-note-asset]').last();
  await articleNoteImage.waitFor();
  await page.waitForFunction(async (id) => {
    const payload = await (await fetch(`/api/jobs/${id}/notes`)).json();
    return /!\[[^\]]*\]\(assets\/[a-f0-9]{64}\.png\)/u.test(payload.markdown || '');
  }, jobId);
  const articleNoteMarkdown = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  const imageReference = articleNoteMarkdown.match(/!\[[^\]]*\]\(assets\/[a-f0-9]{64}\.png\)/u)?.[0] || '';
  if (!imageReference || articleNoteMarkdown.includes('data:image')) throw new Error('Article note image was not stored as a local asset reference');
  if (articleNoteMarkdown.indexOf('前文') < 0 || articleNoteMarkdown.indexOf(imageReference) <= articleNoteMarkdown.indexOf('前文') || articleNoteMarkdown.indexOf('后文') <= articleNoteMarkdown.indexOf(imageReference)) throw new Error(`Clipboard image did not persist at the article-note caret (${articleNoteMarkdown})`);
  const articleNoteImageState = await articleNoteImage.evaluate(async (image) => {
    if (!image.complete) await new Promise((resolve) => image.addEventListener('load', resolve, { once: true }));
    return { src: image.getAttribute('src'), width: image.naturalWidth };
  });
  if (!articleNoteImageState.src?.includes('/content/notes/assets/') || articleNoteImageState.width < 1) throw new Error('The pasted article-note image was not readable from the local asset endpoint');

  await page.reload({ waitUntil: 'networkidle' });
  await openLibraryJob(jobId);
  await page.locator('#reader-view.active-view').waitFor();
  await frame.locator('.pdf-page').first().waitFor();
  await page.locator('.sidebar-tab[data-panel="notes-panel"]').click();
  notesEditor = page.locator('#notes-editor[contenteditable="true"]');
  await notesEditor.locator('img[data-note-asset]').waitFor();
  const reloadedArticleNoteText = await notesEditor.textContent();
  if (!reloadedArticleNoteText.includes('前文') || !reloadedArticleNoteText.includes('后文')) throw new Error('Article-note text did not survive a full reload');
  const reloadedArticleNotes = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  if (reloadedArticleNotes !== articleNoteMarkdown) throw new Error('Reloading normalized or lost the persisted article-note Markdown');

  const jobsForRace = await page.evaluate(async () => (await (await fetch('/api/jobs')).json()).jobs || []);
  const libraryForRace = await page.evaluate(async () => (await (await fetch('/api/library')).json()).library);
  const sourceJob = jobsForRace.find((job) => job.job_id === jobId);
  const sourceLibraryItem = libraryForRace?.items?.[jobId];
  if (!sourceJob || !sourceLibraryItem) throw new Error('Could not prepare the article-note document-switch fixture');
  const virtualJobId = jobId === 'eeeeeeeeeeeeeeee' ? 'dddddddddddddddd' : 'eeeeeeeeeeeeeeee';
  const virtualJob = JSON.parse(JSON.stringify(sourceJob));
  virtualJob.job_id = virtualJobId;
  virtualJob.source_filename = 'Article note autosave target.pdf';
  const virtualLibrary = JSON.parse(JSON.stringify(libraryForRace));
  virtualLibrary.items[virtualJobId] = JSON.parse(JSON.stringify(sourceLibraryItem));
  virtualLibrary.items[virtualJobId].job = virtualJob;
  virtualLibrary.items[virtualJobId].created_at = new Date().toISOString();
  virtualLibrary.items[virtualJobId].updated_at = virtualLibrary.items[virtualJobId].created_at;
  const initialVirtualNotes = `B-original-${Date.now()}`;
  let virtualNotes = initialVirtualNotes;
  let delayVirtualNotes = false;
  let failSourceNotesPuts = false;
  let failedSourceNotesPutCount = 0;
  let lastFailedSourceNotesMarkdown = '';
  let blockNextVirtualAnnotationsGet = false;
  let blockedAnnotationsRouteReached = null;
  let releaseBlockedAnnotations = null;
  let delaySourceNoteAsset = false;
  let delayedAssetRouteReached = null;
  let releaseDelayedAsset = null;
  const reusableAssetRef = imageReference.match(/\((assets\/[a-f0-9]{64}\.png)\)/u)?.[1];
  if (!reusableAssetRef) throw new Error('Could not prepare the delayed note-asset fixture');
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jobs: [...jobsForRace, virtualJob] }) });
  });
  await page.route('**/api/library', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ library: virtualLibrary }) });
  });
  await page.route(`**/api/jobs/${jobId}/notes`, async (route) => {
    if (route.request().method() !== 'PUT' || !failSourceNotesPuts) return route.continue();
    failedSourceNotesPutCount += 1;
    lastFailedSourceNotesMarkdown = JSON.parse(route.request().postData() || '{}').markdown || '';
    expectedHTTPErrorPaths.push(`/api/jobs/${jobId}/notes`);
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'forced A PUT failure' }) });
  });
  await page.route(`**/api/jobs/${jobId}/note-assets`, async (route) => {
    if (route.request().method() !== 'POST' || !delaySourceNoteAsset) return route.continue();
    await new Promise((resolve) => {
      releaseDelayedAsset = resolve;
      delayedAssetRouteReached?.();
    });
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ asset: { ref: reusableAssetRef, url: `/api/jobs/${jobId}/content/notes/${reusableAssetRef}`, mime_type: 'image/png', size: 68 } }),
    });
  });
  await page.route(`**/api/jobs/${virtualJobId}/notes`, async (route) => {
    if (route.request().method() === 'GET') {
      if (delayVirtualNotes) await new Promise((resolve) => setTimeout(resolve, 1800));
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ markdown: virtualNotes }) });
      return;
    }
    if (route.request().method() === 'PUT') {
      virtualNotes = JSON.parse(route.request().postData() || '{}').markdown || '';
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ markdown: virtualNotes, saved_at: new Date().toISOString() }) });
      return;
    }
    await route.continue();
  });
  await page.route(`**/api/jobs/${virtualJobId}/annotations`, async (route) => {
    if (route.request().method() === 'GET' && blockNextVirtualAnnotationsGet) {
      blockNextVirtualAnnotationsGet = false;
      expectedHTTPErrorPaths.push(`/api/jobs/${virtualJobId}/annotations`);
      blockedAnnotationsRouteReached?.();
      await new Promise((resolve) => { releaseBlockedAnnotations = resolve; });
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'forced annotations GET failure' }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ annotations: [] }) });
  });
  await page.route(`**/api/jobs/${virtualJobId}/media-layout`, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ media_layout: { version: 1, items: {} } }) });
  });
  await page.route(`**/api/jobs/${virtualJobId}/translations`, async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ translations: [] }) }));
  await page.route(`**/api/jobs/${virtualJobId}/translate`, async (route) => {
    const payload = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { text: payload.text || '虚拟文献译文', cached: false, profile_id: 'translation-smoke-profile' } }) });
  });
  await page.route(`**/api/jobs/${virtualJobId}/auto-highlights`, async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { status: 'mock', highlights: [] } }) }));
  await page.route(`**/api/library/items/${virtualJobId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const payload = JSON.parse(route.request().postData() || '{}');
    const item = virtualLibrary.items[virtualJobId];
    if (payload.values) item.values = { ...(item.values || {}), ...payload.values };
    if (payload.progress) item.progress = { ...(item.progress || {}), ...payload.progress };
    item.updated_at = new Date().toISOString();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ item, library: virtualLibrary }) });
  });

  await page.reload({ waitUntil: 'networkidle' });
  await openLibraryJob(virtualJobId);
  await page.locator(`#document-tabs .document-tab[data-job-id="${virtualJobId}"].active`).first().waitFor();
  await page.locator(`#document-tabs .document-tab[data-job-id="${jobId}"]`).first().click();
  await page.locator(`#document-tabs .document-tab[data-job-id="${jobId}"].active`).first().waitFor();
  await page.locator('.sidebar-tab[data-panel="notes-panel"]').click();
  notesEditor = page.locator('#notes-editor[contenteditable="true"]');
  await notesEditor.locator('img[data-note-asset]').waitFor();
  const pendingSourceNote = `A-pending-${Date.now()}`;
  await notesEditor.evaluate((node) => node.replaceChildren());
  await notesEditor.fill(pendingSourceNote);
  delayVirtualNotes = true;
  await page.locator(`#document-tabs .document-tab[data-job-id="${virtualJobId}"]`).first().click();
  await page.waitForFunction((expected) => document.querySelector('#notes-editor')?.textContent?.includes(expected), initialVirtualNotes, { timeout: 5000 });
  delayVirtualNotes = false;
  await page.waitForTimeout(500);
  const sourceNotesAfterSwitch = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  if (!sourceNotesAfterSwitch.includes(pendingSourceNote)) throw new Error('Switching A→B discarded A\'s pending article-note autosave');
  if (virtualNotes !== initialVirtualNotes) throw new Error(`A delayed autosave wrote into the newly opened B document (${virtualNotes})`);
  if (!(await page.locator('#notes-editor').textContent()).includes(virtualNotes)) throw new Error('The active B editor diverged from B\'s persisted article note');

  await page.locator(`#document-tabs .document-tab[data-job-id="${jobId}"]`).first().click();
  await page.locator('.sidebar-tab[data-panel="notes-panel"]').click();
  notesEditor = page.locator(`#notes-editor[contenteditable="true"][data-job-id="${jobId}"]`);
  await notesEditor.waitFor();
  const failedDraft = `A-failed-draft-${Date.now()}`;
  await notesEditor.evaluate((node) => node.replaceChildren());
  await notesEditor.fill(failedDraft);
  failSourceNotesPuts = true;
  await page.locator('#save-notes-button').click();
  await page.locator('#notes-saved').filter({ hasText: 'forced A PUT failure' }).waitFor();
  if (failedSourceNotesPutCount < 1 || lastFailedSourceNotesMarkdown !== failedDraft) throw new Error(`The forced article-note PUT failure did not receive the current draft (${lastFailedSourceNotesMarkdown})`);
  await page.locator(`#document-tabs .document-tab[data-job-id="${virtualJobId}"]`).first().click();
  await page.waitForFunction((expected) => document.querySelector('#notes-editor')?.textContent?.includes(expected), initialVirtualNotes);
  const durableDraftBeforeReload = await page.evaluate((expected) => Object.keys(localStorage).some((key) => String(localStorage.getItem(key) || '').includes(expected)), failedDraft);
  if (!durableDraftBeforeReload) throw new Error('The failed A draft was not persisted to localStorage before leaving the page');
  await page.reload({ waitUntil: 'networkidle' });
  const sourceNotesBeforeRecovery = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  if (sourceNotesBeforeRecovery.includes(failedDraft)) throw new Error('The failed A draft unexpectedly reached the server before local recovery was exercised');
  await page.locator(`#document-tabs .document-tab[data-job-id="${jobId}"]`).first().click();
  await page.locator('.sidebar-tab[data-panel="notes-panel"]').click();
  notesEditor = page.locator(`#notes-editor[contenteditable="true"][data-job-id="${jobId}"]`);
  await page.waitForFunction((expected) => document.querySelector('#notes-editor')?.textContent?.includes(expected), failedDraft);
  if (!(await page.locator('#notes-saved').textContent()).includes('未保存草稿')) throw new Error('Reloading and returning to A did not identify its durable unsaved draft');
  failSourceNotesPuts = false;
  const retrySave = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/api/jobs/${jobId}/notes`) && response.status() === 200);
  await page.locator('#save-notes-button').click();
  await retrySave;
  const sourceNotesAfterRetry = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/notes`)).json()).markdown || '', jobId);
  if (sourceNotesAfterRetry !== failedDraft) throw new Error(`Retrying A's durable draft did not persist the exact note (${sourceNotesAfterRetry})`);
  await page.waitForFunction((expected) => !Object.keys(localStorage).some((key) => String(localStorage.getItem(key) || '').includes(expected)), failedDraft);

  virtualNotes = `B-notes-survive-annotations-${Date.now()}`;
  const blockedAnnotationsStarted = new Promise((resolve) => { blockedAnnotationsRouteReached = resolve; });
  blockNextVirtualAnnotationsGet = true;
  await page.locator(`#document-tabs .document-tab[data-job-id="${virtualJobId}"]`).first().click();
  await waitForTestSignal(blockedAnnotationsStarted, 'the blocked annotations GET');
  notesEditor = page.locator(`#notes-editor[data-job-id="${virtualJobId}"]`);
  await page.waitForFunction((expected) => document.querySelector('#notes-editor')?.textContent?.includes(expected), virtualNotes);
  const independentLoadState = await notesEditor.evaluate((editor) => ({
    contentEditable: editor.contentEditable,
    busy: editor.getAttribute('aria-busy'),
    text: editor.textContent,
  }));
  if (independentLoadState.contentEditable !== 'true' || independentLoadState.busy !== 'false' || !independentLoadState.text.includes(virtualNotes)) throw new Error(`A pending annotations request blocked the independent article-note load (${JSON.stringify(independentLoadState)})`);
  if (blockNextVirtualAnnotationsGet) throw new Error('The blocked annotations GET was not consumed');
  const annotationsFailureResponse = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().endsWith(`/api/jobs/${virtualJobId}/annotations`) && response.status() === 500);
  releaseBlockedAnnotations?.();
  await annotationsFailureResponse;
  await page.locator('#toast:not([hidden])').filter({ hasText: '高亮笔记加载失败：forced annotations GET failure' }).waitFor();

  await page.locator(`#document-tabs .document-tab[data-job-id="${jobId}"]`).first().click();
  notesEditor = page.locator(`#notes-editor[contenteditable="true"][data-job-id="${jobId}"]`);
  await notesEditor.waitFor();
  const uploadSessionText = `A-delayed-upload-${Date.now()}`;
  await notesEditor.evaluate((node) => node.replaceChildren());
  await notesEditor.fill(uploadSessionText);
  delaySourceNoteAsset = true;
  const delayedAssetStarted = new Promise((resolve) => { delayedAssetRouteReached = resolve; });
  const uploadStartSession = await notesEditor.getAttribute('data-session');
  await pastePng(notesEditor, 'delayed-cross-document-note.png');
  await waitForTestSignal(delayedAssetStarted, 'the delayed article-note image POST');
  await page.locator(`#document-tabs .document-tab[data-job-id="${virtualJobId}"]`).first().click();
  notesEditor = page.locator(`#notes-editor[contenteditable="true"][data-job-id="${virtualJobId}"]`);
  await page.waitForFunction((expected) => document.querySelector('#notes-editor')?.textContent?.includes(expected), virtualNotes);
  await page.locator(`#document-tabs .document-tab[data-job-id="${jobId}"]`).first().click();
  notesEditor = page.locator(`#notes-editor[contenteditable="true"][data-job-id="${jobId}"]`);
  await page.waitForFunction((expected) => document.querySelector('#notes-editor')?.textContent?.includes(expected), uploadSessionText);
  const returnedUploadSession = await notesEditor.getAttribute('data-session');
  if (!uploadStartSession || !returnedUploadSession || uploadStartSession === returnedUploadSession) throw new Error('The A→B→A upload fixture did not create a new editor session');
  const sourceEditorBeforeUpload = await notesEditor.evaluate((editor) => ({ html: editor.innerHTML, images: editor.querySelectorAll('img').length }));
  releaseDelayedAsset?.();
  await page.locator('#toast').filter({ hasText: '文献已经切换' }).waitFor();
  delaySourceNoteAsset = false;
  const sourceEditorAfterUpload = await notesEditor.evaluate((editor) => ({
    html: editor.innerHTML,
    images: editor.querySelectorAll('img').length,
    contentEditable: editor.contentEditable,
  }));
  if (sourceEditorAfterUpload.html !== sourceEditorBeforeUpload.html || sourceEditorAfterUpload.images !== sourceEditorBeforeUpload.images || sourceEditorAfterUpload.contentEditable !== 'true') throw new Error(`A delayed upload from an obsolete A session polluted or locked the new A editor (${JSON.stringify({ before: sourceEditorBeforeUpload, after: sourceEditorAfterUpload })})`);
  if (await page.locator('#insert-image-button').isDisabled()) throw new Error('The obsolete upload left the new A session image control disabled');
  await page.evaluate(async ({ id, markdown }) => fetch(`/api/jobs/${id}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown }) }), { id: jobId, markdown: originalArticleNotes });

  let reflowPollCount = 0;
  let reflowPostCount = 0;
  let reflowCancelCount = 0;
  let parsingCapability = 'artifact_unavailable';
  const reflowDocumentURL = `/api/jobs/${jobId}/renders/2/document.html`;
  const sourceDocumentHTML = await page.evaluate(async (id) => (await fetch(`/api/jobs/${id}/document.html`)).text(), jobId);
  await page.route(`**/api/jobs/${jobId}/renders/2/assets/images/**`, async (route) => {
    const requested = new URL(route.request().url());
    if (requested.pathname.endsWith('/preview-smoke.png')) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      });
      return;
    }
    requested.pathname = requested.pathname.replace('/renders/2/', '/');
    const response = await page.request.get(requested.href);
    await route.fulfill({ response });
  });
  await page.route(`**/api/jobs/${jobId}/renders/2/document.html*`, async (route) => route.fulfill({ status: 200, contentType: 'text/html', body: sourceDocumentHTML }));
  await page.route('**/api/parsing/providers', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ providers: [{ id: 'local-mineru', kind: 'local', state: parsingCapability, reason_code: parsingCapability, ready: parsingCapability === 'ready', can_install: false, version: parsingCapability === 'ready' ? '2.1.0' : 'unpublished', message: parsingCapability === 'artifact_unavailable' ? '测试环境没有组件包' : '' }] }),
  }));
  await page.route(`**/api/jobs/${jobId}/reflow`, async (route) => {
    if (route.request().method() === 'DELETE') {
      reflowCancelCount += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ job_id: jobId, status: 'completed', reflow: { status: 'cancelled', stage: '已停止版面解析', progress: 1, generation: 2, error: null, document_url: null } }),
      });
      return;
    }
    reflowPostCount += 1;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: jobId, status: 'completed', reflow: { status: 'queued', stage: '等待后台执行', progress: 0, generation: 2, error: null, document_url: null } }),
    });
  });
  await page.route(new RegExp(`/api/jobs/${jobId}$`), async (route) => {
    reflowPollCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: jobId, status: 'completed', reflow: { status: 'completed', stage: '新版已生成', progress: 1, generation: 2, error: null, document_url: reflowDocumentURL } }),
    });
  });
  const originalFrameSource = await page.locator('#html-preview').getAttribute('src');
  await page.locator('#reflow-button').click();
  await page.locator('#reflow-progress[hidden]').waitFor();
  if (reflowPostCount !== 0) throw new Error('Unavailable layout capability still submitted reflow');
  if (!/未发现可复用.*扫描本机.*选择已有环境.*官方安装/u.test(await page.locator('#toast').textContent())) throw new Error('Artifact-unavailable preflight did not show scan, manual reuse, and official installation guidance');
  parsingCapability = 'ready';
  await page.locator('#reflow-button').click();
  await page.locator('#confirm-dialog[open]').waitFor();
  let reflowPost = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/jobs/${jobId}/reflow`));
  await page.locator('#confirm-accept').click();
  await reflowPost;
  await page.locator('#reflow-progress:not([hidden])').waitFor();
  if (await page.locator('#html-preview').getAttribute('src') !== originalFrameSource) throw new Error('AI reflow replaced the current iframe before the new generation completed');
  await page.locator('#cancel-reflow-button').click();
  await page.locator('#reflow-progress[data-state="cancelled"]').waitFor();
  if (reflowCancelCount !== 1 || await page.locator('#reflow-progress-value').textContent() === '100%') throw new Error('Cancelled reflow did not reach a truthful terminal state');
  if (await page.locator('#html-preview').getAttribute('src') !== originalFrameSource) throw new Error('Cancelled reflow replaced the current iframe');
  await page.locator('#reflow-button').click();
  await page.locator('#confirm-dialog[open]').waitFor();
  reflowPost = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/jobs/${jobId}/reflow`));
  await page.locator('#confirm-accept').click();
  await reflowPost;
  await page.locator('#reflow-progress[data-state="completed"]').waitFor();
  await page.waitForFunction(({ id, generation }) => {
    const src = document.querySelector('#html-preview')?.src || '';
    return src.includes(`/api/jobs/${id}/renders/${generation}/document.html`) && src.includes('reader=1');
  }, { id: jobId, generation: 2 });
  if (reflowPostCount !== 2 || reflowPollCount < 1) throw new Error('AI reflow did not preserve preflight and polling boundaries');

  console.log(JSON.stringify({ underline: true, inlineNoteAdd: true, inlineNoteEdit: true, inlineRichText: true, inlineNoteFormats: true, inlineNoteClipboardImage: true, articleNoteUnifiedEditor: true, articleNoteClipboardImage: true, articleNoteReload: true, articleNoteDocumentIsolation: true, articleNoteFailedDraftRecovery: true, articleNoteIndependentLoads: true, articleNoteUploadSessionIsolation: true, readerTypographySurfaces: true, selectionTranslationRequestCount, chatEnterSends: true, chatCommandEnterLineBreak: true, chatHistorySubview: true, chatPartialCopy: true, mediaFigureDragResize: true, mediaTableResize: true, mediaResizeKeyboard: true, mediaResizeReset: true, mediaResizePersistence: true, quickPreviewStructuredCaption: true, quickPreviewCachedTranslation: true, reflowGenerationReload: true, imageLightbox: true, imageBackdropClose: true, imageEscapeClose: true, imageContextMenu: true, imageClipboard: true, imageChatContext: true, aiSuggestionStyle: true, aiSuggestionSelection: true, aiSuggestionKeyboardDialog: true, aiSuggestionDirectNote: true, aiSuggestionAdopt: true, aiSuggestionIgnore: true, aiSuggestionIgnoreFocus: true, aiSuggestionIgnorePersists: true, noStackedHighlights: true, clearAllAnnotations: true, clearAllConfirmation: true, preservesAIHighlights: true, editHidesSourceQuote: true, selectAll: true, annotationPalette: true, perAnnotationColor: true, sidebarAnnotationColor: true, inlineNoteFollowsText: true, isolatedPopover: true, selectionInReadingArea: true, selectionPlacement, chatContextExplicit: true, translatedSelectionAnnotation: true, autoHighlights: true, separatedHighlightPanels: true, categoryColors: true, errors }));
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
