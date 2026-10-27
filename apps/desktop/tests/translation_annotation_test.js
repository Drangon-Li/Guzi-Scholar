'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function functionSource(name) {
  let start = source.indexOf(`  function ${name}(`);
  if (start < 0) start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf('\n  }\n', start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 4);
}
const functions = [
  'selectionElement', 'isPaperSelectionSurface', 'beginFrameTextSelection', 'renderFrameTextSelection',
  'blockForNode', 'canonicalSelectionOffsets', 'textNodes', 'textOffset', 'canonicalBlockText', 'rangeAtOffsets', 'annotationRange',
  'translationAnnotationGroup', 'translationGroupSelectionOffsets', 'translationGroupAnchor', 'resolveTranslationGroupAnnotation',
  'selectionTextRange', 'showSelection', 'resolveAnnotationAnchor', 'prepareMathAnnotationRange', 'applyMark', 'saveAnnotation',
].map(functionSource).join('\n');
(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage();
    await page.setContent(`<style>.reader-source-sentence { display:inline; }.reader-sentence-translation { display:block; }</style><main class="reader-content"><p data-block-id="fixture" data-page="1" class="reader-sentence-pairs">
      <span class="reader-source-sentence" id="source-one"><strong>ORIGINAL FIRST.</strong></span><span class="reader-source-sentence" id="source-two"><strong> ORIGINAL SECOND.</strong></span><span class="my-scholar-translation reader-sentence-translation" data-for="fixture" data-translation-for="fixture" data-block-id="translation-fixture--s0-6" data-page="1" id="translation-one">Alpha.</span><span class="my-scholar-translation reader-sentence-translation" data-for="fixture" data-translation-for="fixture" data-block-id="translation-fixture--s7-12" data-page="1" id="translation-two">Beta.</span>
    </p><p data-block-id="other"><span class="my-scholar-translation" data-for="other" data-translation-for="other" data-block-id="translation-other" id="other-translation">Other.</span></p></main><div id="selection-popover" hidden></div><div id="selection-translation-result"></div>`);
    await page.evaluate((code) => {
      Object.assign(window, {
        state: { health: {}, activeJob: { job_id: 'fixture-job' }, annotations: [], selection: null },
        readerContinuations: new WeakMap(), readerMount: {}, selectionTranslationKey: '',
        readerTextSelectionStates: new WeakMap(),
        frameDocument: () => document, cssEscape: (value) => CSS.escape(value),
        normalizeChatSourceGeneration: (value) => value || 'base', activeChatSourceGeneration: () => 'base',
        isAnnotationInteraction: () => false, selectionRequestKey: (value) => value.quote,
        clearSelectionPopover: () => { window.state.selection = null; document.getElementById('selection-popover').hidden = true; },
        showToast: (message) => { window.lastToast = message; }, setPanelStatus: (message) => { throw new Error(message); },
        renderSelectedContext() {}, renderSelectionActions() {}, beginSelectionTranslation() {}, positionSelectionPopover() {},
        openTransient: (element) => { element.hidden = false; },
        $: (selector) => document.querySelector(selector), MyScholarCore: { sentenceContext: (text) => text },
        isAIAnnotation: () => false, normalizeHighlightCategory: () => 'method', applyAnnotationColor() {}, applyAnnotationTheme() {},
        scheduleNoteHoverOpen() {}, cancelNoteHoverOpen() {}, scheduleNoteHoverClose() {},
        readerMountMatches: () => true, readerMountIsCurrent: () => true, jsonOptions: (value) => value, annotationColorFor: () => '#ffcc00',
        api: async (_url, value) => {
          window.savedPayload = value;
          const annotation = { ...value, id: 'saved' };
          return { annotations: [annotation], annotation };
        },
        renderFrameAnnotations: () => { window.state.annotations.forEach((annotation) => window.applyMark(annotation)); },
        renderAnnotations() {}, playAnnotationDrawAnimation() {},
        annotationAnchor: (_doc, id) => document.querySelector(`[data-annotation-id="${id}"]`),
      });
      window.eval(code);
      window.showSelectedRange = (range, backwards = false) => {
        const selection = document.getSelection(); selection.removeAllRanges();
        if (backwards) selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset);
        else selection.addRange(range);
        window.lastToast = null;
        window.showSelection();
        window.renderFrameTextSelection(document);
        return window.state.selection;
      };
      window.selectText = (from, start, to, end) => {
        const firstText = (id) => document.createTreeWalker(document.getElementById(id), NodeFilter.SHOW_TEXT).nextNode();
        const range = document.createRange(); range.setStart(firstText(from), start); range.setEnd(firstText(to), end);
        return window.showSelectedRange(range);
      };
      window.removeTestMarks = () => {
        document.querySelectorAll('.annotation-note-trigger').forEach((node) => node.remove());
        document.querySelectorAll(':is(mark,mrow)[data-annotation-id]').forEach((node) => node.replaceWith(...node.childNodes));
        document.querySelectorAll('[data-block-id]').forEach((node) => node.normalize());
      };
    }, functions);
    const originalBefore = await page.locator('#source-one').innerHTML() + await page.locator('#source-two').innerHTML();
    const nativeSelection = await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('source-one'));
      document.getSelection().removeAllRanges();
      document.getSelection().addRange(range);
      const quote = document.getSelection().toString().trim();
      window.showSelection();
      return { quote, selection: window.state.selection, toast: window.lastToast };
    });
    assert.equal(nativeSelection.quote, 'ORIGINAL FIRST.');
    assert.equal(nativeSelection.selection?.quote, nativeSelection.quote, 'An explicit complete-sentence Range opens the source selection toolbar');
    assert.equal(nativeSelection.selection.surface, 'paper');
    assert.equal(nativeSelection.toast, undefined);
    assert.equal(await page.locator('#selection-popover').evaluate((node) => node.hidden), false);
    const boundaries = await page.evaluate(() => {
      const source = document.querySelector('#source-one strong').firstChild;
      const translation = document.getElementById('translation-one');
      const parent = translation.parentNode;
      return ['text', 'element', 'parent', 'backwards'].map((boundary) => {
        const range = document.createRange(); range.setStart(source, 0);
        if (boundary === 'text' || boundary === 'backwards') range.setEnd(translation.firstChild, 0);
        else if (boundary === 'element') range.setEnd(translation, 0);
        else range.setEnd(parent, [...parent.childNodes].indexOf(translation));
        return window.showSelectedRange(range, boundary === 'backwards');
      });
    });
    for (const selected of boundaries) {
      assert.equal(selected?.quote, 'ORIGINAL FIRST. ORIGINAL SECOND.', 'An empty exclusive translation endpoint keeps the continuous source paragraph on its source surface');
      assert.equal(selected.block_id, 'fixture');
      assert.equal(selected.surface, 'paper');
    }
    const translationBoundary = await page.evaluate(() => window.selectText('source-two', 17, 'translation-one', 6));
    assert.equal(translationBoundary?.quote, 'Alpha.');
    assert.equal(translationBoundary.surface, 'translation');
    assert.equal(translationBoundary.block_id, 'translation-fixture');
    for (const [from, to] of [['source-one', 'translation-one'], ['source-two', 'translation-two']]) {
      const mixedSurface = await page.evaluate(([start, end]) => window.selectText(start, 0, end, 3), [from, to]);
      assert.equal(mixedSurface.surface, 'paper', 'A source-started selection keeps its source surface even when the pointer ends on Chinese');
      assert(!/Alpha|Beta/u.test(mixedSurface.quote));
      const painted = await page.evaluate(() => window.readerTextSelectionStates.get(document).ranges.map(range => ({
        sameText: range.startContainer === range.endContainer,
        translated: Boolean(range.startContainer.parentElement.closest('.my-scholar-translation')),
        text: range.toString(),
      })));
      assert(painted.length > 0);
      assert(painted.every(range => range.sameText && !range.translated), 'Selection painting uses source text ranges, never tall line boxes or translated text');
      assert.equal(await page.evaluate(() => {
        const existing = window.readerTextSelectionStates.get(document);
        const overlay = document.getElementById('reader-text-selection-overlay');
        const path = overlay.firstElementChild.getAttribute('d');
        const node = document.createElement('p'); node.textContent = 'Unrelated translation arrived.';
        document.querySelector('.reader-content').append(node);
        window.renderFrameTextSelection(document);
        const unchanged = window.readerTextSelectionStates.get(document) === existing
          && document.getElementById('reader-text-selection-overlay') === overlay && overlay.firstElementChild.getAttribute('d') === path;
        node.remove();
        return unchanged;
      }), true, 'Unchanged selections reuse their ranges and paint path when unrelated paragraphs arrive');
    }
    const backwardsTranslation = await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.querySelector('#source-one strong').firstChild, 0);
      range.setEnd(document.getElementById('translation-two').firstChild, 3);
      return window.showSelectedRange(range, true);
    });
    assert.equal(backwardsTranslation.surface, 'translation');
    assert.equal(backwardsTranslation.quote, 'Alpha. Bet', 'A reverse selection beginning on translated text excludes source prose');
    assert.equal(await page.evaluate(() => window.readerTextSelectionStates.get(document).ranges.every(range => range.startContainer.parentElement.closest('.my-scholar-translation'))), true);
    await page.evaluate(() => { document.getSelection().removeAllRanges(); window.renderFrameTextSelection(document); });
    assert.equal(await page.evaluate(() => window.readerTextSelectionStates.has(document)), false);
    assert.equal(await page.locator('#reader-text-selection-overlay').count(), 0);
    const selected = await page.evaluate(() => window.selectText('translation-one', 3, 'translation-two', 2));
    assert.equal(selected.quote, 'ha. Be');
    assert.equal(selected.block_id, 'translation-fixture');
    assert.equal(selected.source_block_id, 'fixture');
    assert.equal(selected.surface, 'translation');
    assert.equal(selected.start, 3); assert.equal(selected.end, 9);
    await page.evaluate(() => window.saveAnnotation('highlight'));
    assert.equal(await page.locator('.reader-sentence-translation mark[data-annotation-id="saved"]').count(), 2);
    assert.deepEqual(await page.locator('.reader-sentence-translation mark[data-annotation-id="saved"]').allTextContents(), ['ha.', 'Be']);
    assert.equal(await page.locator('.reader-source-sentence :is(mark,mrow)').count(), 0, 'Continuous source sentences are never marked by a translation annotation');
    assert.equal(await page.locator('#source-one').innerHTML() + await page.locator('#source-two').innerHTML(), originalBefore);
    const restored = await page.evaluate(() => {
      const annotation = window.state.annotations[0];
      window.removeTestMarks();
      document.documentElement.dataset.translationDisplay = 'original';
      return window.applyMark(annotation);
    });
    assert.equal(restored, true, 'Translation identity is preserved independently of the visible display mode');
    assert.deepEqual(await page.locator('.reader-sentence-translation mark').allTextContents(), ['ha.', 'Be']);
    const compatibility = await page.evaluate(() => {
      window.removeTestMarks();
      const legacy = { id: 'legacy', block_id: 'translation-fixture', surface: 'translation', quote: 'Alpha. Beta.', start: 0, end: 12, page: 1, kind: 'highlight' };
      const legacyApplied = window.applyMark(legacy);
      const legacyTexts = [...document.querySelectorAll('mark[data-annotation-id="legacy"]')].map((node) => node.textContent);
      window.removeTestMarks();
      const single = { ...legacy, id: 'single', block_id: 'translation-fixture--s7-12', source_block_id: 'fixture', quote: 'Beta', start: 0, end: 4 };
      const singleApplied = window.applyMark(single);
      return { legacyApplied, legacyTexts, singleApplied, singleText: document.querySelector('mark[data-annotation-id="single"]')?.textContent,
        singleRoot: document.querySelector('mark[data-annotation-id="single"]')?.closest('[data-block-id]').dataset.blockId };
    });
    assert.deepEqual(compatibility, { legacyApplied: true, legacyTexts: ['Alpha.', 'Beta.'], singleApplied: true, singleText: 'Beta', singleRoot: 'translation-fixture--s7-12' });
    const sourceAnnotation = await page.evaluate(() => {
      window.removeTestMarks();
      const block = document.querySelector('[data-block-id="fixture"]');
      const quote = window.canonicalBlockText(block);
      return window.applyMark({ id: 'source-spanning', block_id: 'fixture', quote, start: 0, end: quote.length, surface: 'paper', kind: 'underline' });
    });
    assert.equal(sourceAnnotation, true);
    assert.equal(await page.locator('.reader-source-sentence mark[data-annotation-id="source-spanning"]').count(), 2);
    assert.equal(await page.locator('.reader-sentence-translation mark').count(), 0, 'Existing source splitting never marks translations');
    const mixedGroup = await page.evaluate(() => { window.removeTestMarks(); return window.selectText('translation-one', 0, 'other-translation', 3); });
    assert.equal(mixedGroup, null, 'Separate logical source paragraphs cannot be merged into one annotation');
    assert.equal(await page.locator('#source-one').innerHTML() + await page.locator('#source-two').innerHTML(), originalBefore);
    const sourceSelected = await page.evaluate(() => window.selectText('source-one', 0, 'source-two', 17));
    assert.equal(sourceSelected.quote, 'ORIGINAL FIRST. ORIGINAL SECOND.');
    assert.equal(sourceSelected.surface, 'paper');
    await page.evaluate(() => window.saveAnnotation('underline'));
    assert.equal(await page.locator('.reader-source-sentence mark[data-annotation-id="saved"]').count(), 2);
    assert.equal(await page.locator('.reader-sentence-translation mark').count(), 0);
    const annotatedSentence = await page.evaluate(() => {
      const source = document.getElementById('source-one');
      const trigger = document.createElement('button');
      trigger.className = 'annotation-note-trigger'; trigger.textContent = '+';
      source.append(trigger);
      const range = document.createRange(); range.selectNodeContents(source);
      return window.showSelectedRange(range);
    });
    assert.equal(annotatedSentence.quote, 'ORIGINAL FIRST.', 'A note control at the selection endpoint must not invalidate or contaminate the source quote');
    const reusePage = await session.browser.newPage();
    await reusePage.setContent('<p data-block-id="reuse"><span class="reader-source-sentence">First sentence.</span><span class="reader-source-sentence"> Second sentence.</span><span class="reader-sentence-translation" data-for="reuse" data-sentence-id="s0-15">第一句。</span><span class="reader-sentence-translation" data-for="reuse" data-sentence-id="s16-32">第二句。</span></p><p data-block-id="other">First sentence.</p><div id="selection-popover"></div>');
    await reusePage.evaluate((code) => {
      Object.assign(window, {
        state: { activeJob: { job_id: 'reuse-job' }, selection: null },
        frameDocument: () => document,
        translationTarget: (id) => document.querySelector(`[data-block-id="${id}"]`),
        $: (selector) => document.querySelector(selector),
        selectionRequestKey: (selection) => JSON.stringify(selection),
        selectionTranslationRecord: null, selectionTranslationKey: '', selectionTranslationToken: 0,
        selectionTranslationTimer: null, selectionTranslationAbortController: null,
        aiServiceEnabled: () => true, hashText: (text) => text, cachedTranslation: () => null,
        translationTargetLanguage: () => 'zh', translationErrorMessage: (error) => error.message,
        renderSelectionTranslation: (status, result) => { window.rendered = { status, ...result }; },
        requestTranslation: async () => { window.requests += 1; return { text: 'Requested translation' }; },
        requests: 0,
      });
      const first = document.querySelector('.reader-sentence-translation');
      first.translationResult = { text: '第一句。', formulas: [{ tex: 'x/y' }], markers: [{ label: 'A' }], emphasis: ['bold'] };
      first.nextElementSibling.translationResult = { text: '第二句。' };
      window.eval(code);
      window.translateSelection = async (selection, options) => {
        window.state.selection = { surface: 'paper', block_id: 'reuse', ...selection };
        window.beginSelectionTranslation(window.state.selection, options);
        const meaning = await window.selectionTranslationRecord?.promise;
        return { meaning, rendered: window.rendered, requests: window.requests };
      };
    }, ['textNodes', 'canonicalBlockText', 'displayedSentenceTranslation', 'beginSelectionTranslation'].map(functionSource).join('\n'));
    const reused = await reusePage.evaluate(() => window.translateSelection({ start: 0, end: 15, quote: 'First sentence.' }));
    assert.equal(reused.requests, 0);
    assert.equal(reused.meaning, '第一句。', 'Vocabulary consumes the same resolved meaning without a second request');
    assert.deepEqual(reused.rendered, { status: 'ready', text: '第一句。', formulas: [{ tex: 'x/y' }], markers: [{ label: 'A' }], emphasis: ['bold'] });
    const withWhitespace = await reusePage.evaluate(() => window.translateSelection({ start: 15, end: 32, quote: ' Second sentence.' }));
    assert.equal(withWhitespace.requests, 0);
    assert.equal(withWhitespace.rendered.text, '第二句。');
    const partial = await reusePage.evaluate(() => window.translateSelection({ start: 0, end: 5, quote: 'First' }));
    assert.equal(partial.requests, 1, 'Partial sentences still request their own translation');
    const otherBlock = await reusePage.evaluate(() => window.translateSelection({ block_id: 'other', start: 0, end: 15, quote: 'First sentence.' }));
    assert.equal(otherBlock.requests, 2, 'Identical text in a different block cannot borrow the displayed sentence');
    const retry = await reusePage.evaluate(() => window.translateSelection({ start: 0, end: 15, quote: 'First sentence.' }, { immediate: true }));
    assert.equal(retry.requests, 3, 'Explicit retry bypasses display reuse');
    await reusePage.close();
    console.log('cross-sentence translation annotation DOM tests passed');
  } finally {
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
