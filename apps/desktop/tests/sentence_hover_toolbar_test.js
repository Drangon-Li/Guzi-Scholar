'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  }\n', start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 4);
}
class Element {
  constructor() {
    this.hidden = false; this.children = []; this.dataset = {}; this.attributes = {}; this.styles = {};
    this.classes = new Set(); this.classList = { contains: (name) => this.classes.has(name) };
    this.style = { setProperty: (name, value) => { this.styles[name] = value; } };
    this.offsetWidth = 520; this.offsetHeight = 120;
  }
  set innerHTML(value) {
    this.html = value;
    if (value.includes('selection-hover-note-label')) this.children = ['selection-hover-note-label', 'selection-hover-note-body'].map((className) => Object.assign(new Element(), { className }));
  }
  append(...nodes) { this.children.push(...nodes); }
  insertBefore(node, before) { const at = this.children.indexOf(before); this.children.splice(at < 0 ? this.children.length : at, 0, node); }
  querySelector(selector) { return this.children.find((node) => `.${node.className}` === selector) || null; }
  querySelectorAll() { return []; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  contains(node) { return node === this || this.children.includes(node); }
  addEventListener() {}
}
const popover = new Element(); popover.hidden = true;
const result = new Element(); popover.append(result);
const readerView = new Element(); readerView.classes.add('active-view');
const frame = { clientWidth: 1000, clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) };
const wrap = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) };
const host = { activeElement: null, createElement: () => new Element() };
const timers = new Map(); let timerId = 0;
const rendered = []; const translations = []; let actionsRendered = 0; let nativeText = ''; let enabled = true;
const doc = {
  defaultView: { cancelAnimationFrame() {} },
  getSelection: () => ({ toString: () => nativeText }),
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ append(value) { this.source = value; }, querySelectorAll: () => [] }),
};
let currentDoc = doc;
const mount = {};
const context = vm.createContext({
  state: { activeJob: { job_id: 'fixture' }, health: {}, selection: null },
  readerSentenceState: { doc, activePairId: '', activePair: null, revision: 0, pendingTranslations: new Map() },
  readerSentenceHighlightName: 'sentence',
  document: host, frameDocument: () => currentDoc,
  window: {
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    requestAnimationFrame: (callback) => callback(),
  },
  $: (selector) => ({ '#selection-popover': popover, '#selection-translation-result': result, '#reader-view': readerView, '#html-preview': frame, '.reader-frame-wrap': wrap })[selector],
  activeChatSourceGeneration: () => 'base',
  blockForNode: (node) => node.annotationBlock || node,
  textOffset: (_root, _node, offset) => offset,
  canonicalBlockText: (root) => root.text,
  readerHighlightRegistry: () => ({ set() {}, delete() {} }),
  readerHighlightForRanges: (_doc, ranges) => ranges,
  renderSelectedContext() {}, renderSelectionActions: () => { actionsRendered += 1; },
  openTransient: (node) => { node.hidden = false; node.classes.delete('is-closing'); },
  closeTransient: (node, options) => { node.hidden = true; options.onFinish?.(); },
  renderMarkdown: (text) => `<p>${text}</p>`, normalizeAnnotationColor: (color) => color,
  renderTranslationText: (text, formulas, _doc, markers, emphasis) => {
    const entry = { text, formulas, markers, emphasis }; rendered.push(entry); return entry;
  },
  readerHoverTranslationEnabled: () => enabled,
  readerMount: mount, readerMountMatches: (candidate, candidateDoc) => candidate === mount && candidateDoc === currentDoc,
  translationProfileId: () => 'profile', translationTargetLanguage: () => 'zh',
  paragraphSource: (node) => node.source,
  cachedTranslationForSource: () => null, aiServiceEnabled: () => true,
  translationSourceIdentity: (value) => JSON.stringify(value),
  requestTranslation: (text, _block, formulas, options) => new Promise((resolve) => translations.push({ text, formulas, options, resolve })),
  hashText: (text) => text,
  NOTE_HOVER_OPEN_DELAY: 120,
});
vm.runInContext('let selectionTranslationTimer = null; let selectionTranslationToken = 0; let selectionTranslationKey = ""; let selectionTranslationAbortController = null; let selectionTranslationRecord = null;\n' + [
  'clearReaderSentenceHover', 'readerSentenceSelection', 'paintReaderSentenceTooltip', 'positionReaderSentenceTooltip', 'setReaderSentenceHover',
  'isAIAnnotation', 'hasAnnotationNote', 'hasAnnotationHoverDetails', 'applyAnnotationTheme',
  'canonicalSelectionOffsets', 'clearSelectionPopover', 'selectionRequestKey', 'activeSelectionActionTarget', 'positionSelectionPopover', 'renderSelectionTranslation',
].map(functionSource).join('\n') + '\nthis.test = { readerSentenceSelection, setReaderSentenceHover, clearReaderSentenceHover, clearSelectionPopover, activeSelectionActionTarget, positionReaderSentenceTooltip };', context);
const t = context.test;
function pair(id, text, start = 0, end = text.length) {
  const root = { isConnected: true, text, dataset: { page: '2', blockId: `block-${id}` } };
  const formula = { token: '__MY_SCHOLAR_MATH_0__', tex: 'x', markup: '<math><mi>x</mi></math>' };
  return {
    id, blockId: `block-${id}`, source: root,
    sourceRange: {
      startContainer: root, endContainer: root, startOffset: start, endOffset: end,
      getClientRects: () => [{ left: 40, top: 70, bottom: 90, width: 260, height: 20 }],
      cloneContents: () => ({ text: text.slice(start, end), formulas: [formula], markers: [{ token: 'marker', tone: 'red' }], emphasis: [{ index: 0, style: 'bold' }] }),
    },
  };
}
async function runOpenTimer() {
  const id = context.readerSentenceState.hoverTimer;
  const callback = timers.get(id); assert(callback, 'A delayed hover must be scheduled'); timers.delete(id);
  const pending = callback(); await Promise.resolve(); return { pending };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
(async () => {
  const first = pair('first', 'Before. Current sentence. After.', 8, 25);
  const snapshot = t.readerSentenceSelection(first);
  assert.equal(snapshot.quote, 'Current sentence.');
  assert.equal(snapshot.origin, 'sentence-hover');
  assert.equal(snapshot.block_id, 'block-first');
  assert.equal(snapshot.start, 8); assert.equal(snapshot.end, 25);
  assert.equal(snapshot.quote_prefix, 'Before. '); assert.equal(snapshot.quote_suffix, ' After.');
  assert.equal(snapshot.job_id, 'fixture'); assert.equal(snapshot.render_generation, 'base');
  assert.equal(nativeText, '', 'Hover never creates a native browser selection');
  const caption = pair('caption', 'Figure caption.');
  const figure = { text: 'Figure caption.', dataset: { blockId: 'figure-1', page: '3' } };
  caption.source.dataset = { translateBlockId: 'caption-1' }; caption.source.annotationBlock = figure;
  assert.equal(t.readerSentenceSelection(caption).block_id, 'figure-1', 'A caption uses the actual annotation parent instead of its translation ID');
  delete caption.source.annotationBlock;
  assert.equal(t.readerSentenceSelection(caption), null, 'A source without an annotation root does not create an invalid action snapshot');

  t.setReaderSentenceHover(first, { id: 'note', label: '原理', note: 'Existing note' });
  const firstOpen = await runOpenTimer();
  assert.equal(context.state.selection.quote, 'Current sentence.');
  assert.equal(popover.hidden, false); assert.equal(actionsRendered, 1);
  assert.match(popover.querySelector('.selection-hover-note').querySelector('.selection-hover-note-body').html, /Existing note/);
  assert.equal(t.activeSelectionActionTarget(), context.state.selection);
  assert.equal(result.dataset.state, 'loading');

  const second = pair('second', 'Another sentence.');
  t.setReaderSentenceHover(second);
  const secondOpen = await runOpenTimer();
  assert.equal(context.state.selection.quote, 'Another sentence.');
  assert.equal(popover.querySelector('.selection-hover-note').hidden, true);
  translations[0].resolve({ text: 'Late first result' }); await firstOpen.pending;
  assert.equal(result.dataset.state, 'loading', 'A late response cannot replace a new sentence');
  assert.equal(rendered.length, 0);
  translations[1].resolve({ text: 'Second result', formulas: translations[1].formulas, markers: translations[1].options.markers, emphasis: translations[1].options.emphasis });
  await secondOpen.pending;
  assert.deepEqual(plain(rendered.at(-1)), { text: 'Second result', formulas: translations[1].formulas, markers: translations[1].options.markers, emphasis: translations[1].options.emphasis });

  for (const mutate of [
    () => { popover.hidden = true; },
    () => { popover.classes.add('is-closing'); },
    () => { context.state.selection.job_id = 'other'; },
    () => { context.state.selection.render_generation = 'other'; },
    () => { context.readerSentenceState.activePairId = 'other'; },
    () => { second.source.isConnected = false; },
    () => { currentDoc = {}; },
    () => { readerView.classes.delete('active-view'); },
  ]) {
    mutate(); assert.equal(t.activeSelectionActionTarget(), null, 'A stale or hidden toolbar cannot receive actions');
    popover.hidden = false; popover.classes.clear(); context.state.selection.job_id = 'fixture'; context.state.selection.render_generation = 'base';
    context.readerSentenceState.activePairId = second.id; second.source.isConnected = true; currentDoc = doc; readerView.classes.add('active-view');
  }

  context.readerSentenceState.toolbarPointerInside = true;
  popover.style.top = '123px'; t.positionReaderSentenceTooltip(doc);
  assert.equal(popover.style.top, '123px', 'Background layout changes keep the hovered toolbar stationary');
  t.setReaderSentenceHover(null);
  const close = timers.get(context.readerSentenceState.closeTimer); timers.delete(context.readerSentenceState.closeTimer); close();
  assert.equal(popover.hidden, false, 'The pointer can enter and operate the toolbar');
  context.readerSentenceState.toolbarPointerInside = false;
  t.setReaderSentenceHover(null); const leave = timers.get(context.readerSentenceState.closeTimer); leave();
  assert.equal(popover.hidden, true); assert.equal(context.state.selection, null);

  enabled = false;
  t.setReaderSentenceHover(second); const disabledOpen = await runOpenTimer(); await disabledOpen.pending;
  assert.equal(popover.hidden, false, 'Actions remain available when automatic hover translation is disabled');
  assert.equal(result.hidden, true); assert.equal(translations.length, 2);
  t.clearSelectionPopover();
  assert.equal(context.state.selection, null, 'Closing a hover toolbar clears its action object even without clearState');
  assert.equal(context.readerSentenceState.activePairId, '');

  enabled = true; nativeText = 'Real drag selection';
  t.setReaderSentenceHover(second); const nativeOpen = await runOpenTimer();
  assert.equal(context.state.selection, null, 'Native selection prevents a hover from claiming the action object');
  await nativeOpen.pending;
  assert.equal(translations.length, 2, 'A pending hover does not translate a newly selected sentence');
  assert.equal(popover.hidden, true);
  context.state.selection = { origin: 'selection', quote: nativeText };
  t.clearReaderSentenceHover(doc);
  assert.equal(context.state.selection.quote, nativeText, 'Hover cleanup preserves a real selection snapshot');
  nativeText = '';

  const listeners = new Map(); const pointerFrames = new Map(); let pointerFrameId = 0;
  doc.documentElement = { dataset: {} };
  doc.addEventListener = (type, callback) => listeners.set(type, callback);
  doc.defaultView.addEventListener = () => {};
  doc.defaultView.requestAnimationFrame = (callback) => { pointerFrames.set(++pointerFrameId, callback); return pointerFrameId; };
  doc.defaultView.cancelAnimationFrame = (id) => pointerFrames.delete(id);
  Object.assign(context, {
    notePopoverHover: { pinned: false },
    cancelNoteHoverOpen() {}, cancelNoteHoverClose() {}, scheduleNoteHoverClose() {}, closeInlineAnnotation() {},
    isAnnotationInteraction: () => false,
    readerSentencePairAtPoint: () => second,
  });
  vm.runInContext(functionSource('installReaderSentenceHover') + '\nthis.installHover = installReaderSentenceHover;', context);
  t.clearSelectionPopover({ clearState: true, immediate: true });
  context.installHover(doc);
  assert.equal(listeners.get('pointerup'), listeners.get('pointermove'), 'Pointer release reuses the same hover scheduling and selection guards');
  const pointerEvent = { target: { closest: () => null }, pointerType: 'mouse', buttons: 0, clientX: 90, clientY: 80 };
  listeners.get('pointerdown')({ ...pointerEvent, buttons: 1 });
  assert.equal(context.readerSentenceState.activePairId, '');
  listeners.get('pointerup')(pointerEvent);
  assert.equal(pointerFrames.size, 1, 'Releasing a click without a native selection schedules hover without another pointer move');
  const [frameId, pointerFrame] = pointerFrames.entries().next().value; pointerFrames.delete(frameId); pointerFrame();
  assert.equal(context.readerSentenceState.activePairId, second.id);
  assert(timers.has(context.readerSentenceState.hoverTimer), 'The sentence toolbar is scheduled to reopen after a click');
  listeners.get('pointerdown')({ ...pointerEvent, buttons: 1 });
  listeners.get('pointerup')({ ...pointerEvent, buttons: 1 });
  assert.equal(pointerFrames.size, 0, 'An ongoing pointer drag cannot schedule sentence hover');
  nativeText = 'Real drag selection';
  const draggedSelection = { origin: 'selection', quote: nativeText }; context.state.selection = draggedSelection;
  listeners.get('pointerup')(pointerEvent);
  assert.equal(pointerFrames.size, 0, 'Releasing a native text selection does not schedule sentence hover');
  assert.equal(context.state.selection, draggedSelection, 'Pointer release never replaces a real selection action object');
  assert.equal(timers.has(context.readerSentenceState.hoverTimer), false);

  nativeText = '';
  let notePreviewOpen = true;
  const notePreview = { dataset: { annotationId: 'note' }, classList: { add() {} }, remove: () => { notePreviewOpen = false; } };
  doc.querySelector = (selector) => selector === '.annotation-note-popover' && notePreviewOpen ? notePreview : null;
  context.annotationAnchor = () => null;
  context.reducedMotionQuery = { matches: false };
  vm.runInContext(functionSource('closeInlineAnnotation'), context);
  context.notePopoverHover.pinned = true;
  context.notePopoverHover.anchor = second.source;
  listeners.get('pointerdown')({ ...pointerEvent, buttons: 1 });
  assert.equal(context.notePopoverHover.pinned, false, 'Pressing outside a pinned note releases it before pointerup scheduling');
  assert.equal(notePreviewOpen, false, 'Outside pointerdown removes the old note immediately so its closing animation cannot block noted-sentence hover');
  listeners.get('pointerup')(pointerEvent);
  assert.equal(pointerFrames.size, 1, 'Clicking a sentence after cancelling note editing can schedule its toolbar again');
  const [noteFrameId, notePointerFrame] = pointerFrames.entries().next().value; pointerFrames.delete(noteFrameId); notePointerFrame();
  assert.equal(context.readerSentenceState.activePairId, second.id);
  assert(timers.has(context.readerSentenceState.hoverTimer));

  let annotationMark;
  doc.querySelector = (selector) => selector.startsWith(':is(mark, mrow)') ? annotationMark : null;
  context.cssEscape = (value) => value;
  context.readerSentenceState.pairs = [second];
  second.source.contains = (node) => node === annotationMark;
  second.sourceRange.intersectsNode = (node) => node === annotationMark;
  vm.runInContext(functionSource('scheduleNoteHoverOpen'), context);
  const hoverAnnotations = [
    { id: 'principle', source: 'manual', kind: 'underline', label: '论文原理', color: '#ff6666', note: '' },
    { id: 'contribution', source: 'manual', kind: 'highlight', label: '论文贡献', color: '#2ea8e5', note: '' },
    { id: 'written-note', source: 'manual', kind: 'underline', label: '', color: '#5fb236', note: 'Existing personal note' },
    { id: 'plain-mark', source: 'manual', kind: 'highlight', label: '', color: '#ffd400', note: '   ' },
    { id: 'ai-mark', source: 'ai', kind: 'highlight', label: 'AI label', color: '#a28ae5', note: 'AI reason' },
  ];
  context.state.annotations = hoverAnnotations;
  for (const annotation of hoverAnnotations) {
    annotationMark = {
      dataset: { annotationId: annotation.id }, parentElement: null,
      closest: (selector) => selector === ':is(mark, mrow)[data-annotation-id]' ? annotationMark : null,
    };
    const trigger = {
      ownerDocument: doc, isConnected: true, dataset: { annotationId: annotation.id }, matches: () => false,
      getBoundingClientRect: () => ({ left: 90, top: 80 }),
      closest: (selector) => selector === '.annotation-note-trigger' ? trigger : null,
    };
    for (const target of [annotationMark, trigger]) {
      t.clearReaderSentenceHover(doc);
      listeners.get('pointermove')({ ...pointerEvent, target });
      if (annotation.source === 'ai' && target === trigger) {
        assert.equal(context.readerSentenceState.activePairId, '', 'An AI trigger does not become a manual annotation detail preview');
        continue;
      }
      if (pointerFrames.size) {
        const [annotationFrameId, annotationFrame] = pointerFrames.entries().next().value;
        pointerFrames.delete(annotationFrameId); annotationFrame();
      }
      const hasDetails = annotation.source === 'manual' && Boolean(annotation.label || annotation.note.trim());
      assert.equal(context.readerSentenceState.annotation, hasDetails ? annotation : null, `${annotation.id} details are selected through ${target === trigger ? 'trigger' : 'mark'} hover`);
      const annotationOpen = await runOpenTimer(); await annotationOpen.pending;
      const details = popover.querySelector('.selection-hover-note');
      assert.equal(details.hidden, !hasDetails);
      assert.equal(result.hidden, false, 'The translation stays available with or without manual annotation details');
      if (hasDetails) {
        assert.equal(details.querySelector('.selection-hover-note-label').textContent, annotation.label || '笔记');
        assert.equal(details.styles['--annotation-color'], annotation.color, 'Custom labels preserve their original annotation color');
        const body = details.querySelector('.selection-hover-note-body');
        assert.equal(body.hidden, !annotation.note.trim());
        assert.equal(body.html, annotation.note.trim() ? `<p>${annotation.note}</p>` : '', 'Label-only annotations do not render an empty note body');
      }
    }
  }

  assert.doesNotMatch(functionSource('paintReaderSentenceTooltip'), /className = 'reader-sentence-tooltip'/u, 'The pure translation hover card has been removed');
  assert.match(functionSource('showSelection'), /origin: 'selection'/u);
  assert.match(source, /else if \(!translationLayoutPending \|\| state\.selection\?\.origin !== 'sentence-hover'\) clearSelectionPopover/u);
  console.log('sentence hover toolbar tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
