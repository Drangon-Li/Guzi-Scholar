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
const timers = new Map();
const listeners = new Map();
const opened = [];
const closed = [];
let nextTimer = 0;
let nativeText = '';
let currentMount = {};
let currentDoc;
let note = null;
const toolbarClasses = new Set();
const readerClasses = new Set(['active-view']);
const toolbar = { hidden: true, classList: { contains: (name) => toolbarClasses.has(name) } };
const reader = { classList: { contains: (name) => readerClasses.has(name) } };
const doc = {
  documentElement: { dataset: {} },
  defaultView: { addEventListener: (name, callback) => listeners.set(`window:${name}`, callback) },
  getSelection: () => ({ toString: () => nativeText }),
  querySelector: () => note,
  addEventListener: (name, callback) => listeners.set(name, callback),
};
currentDoc = doc;
const annotation = { id: 'note', label: '论文贡献', note: 'Saved note.' };
const context = vm.createContext({
  state: { selection: null, annotations: [annotation], activeJob: { job_id: 'paper' } },
  readerMount: currentMount,
  notePopoverHover: { openTimer: null, closeTimer: null, pendingAnnotationId: '', pendingDoc: null, pinned: false, anchor: null },
  NOTE_HOVER_OPEN_DELAY: 120,
  NOTE_HOVER_CLOSE_DELAY: 260,
  frameDocument: () => currentDoc,
  readerMountMatches: (mount, document) => mount === currentMount && document === currentDoc,
  window: {
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
  },
  $: (selector) => selector === '#selection-popover' ? toolbar : selector === '#reader-view' ? reader : null,
  activeChatSourceGeneration: () => 'base',
  isAIAnnotation: (item) => item.source === 'ai',
  hasAnnotationNote: (item) => Boolean(item.note?.trim()),
  isAnnotationInteraction: (target) => Boolean(target?.closest?.('.annotation-note-popover') || target?.closest?.('.annotation-note-trigger')),
  showInlineAnnotation: (...args) => { opened.push(args); },
  closeInlineAnnotation: (document, options) => { closed.push({ document, options }); context.notePopoverHover.pinned = false; context.cancelNoteHoverOpen(); context.cancelNoteHoverClose(); },
  clearSelectionPopover: () => { toolbar.hidden = true; context.state.selection = null; },
  requestTranslation: () => assert.fail('Pointer movement must never request translation'),
  beginSelectionTranslation: () => assert.fail('Pointer movement must never start selection translation'),
});
vm.runInContext([
  'hasAnnotationHoverDetails', 'cancelNoteHoverOpen', 'cancelNoteHoverClose', 'scheduleNoteHoverOpen',
  'scheduleNoteHoverClose', 'installReaderAnnotationHover', 'activeSelectionActionTarget',
].map(functionSource).join('\n'), context);
function flushTimers() {
  const pending = [...timers.values()]; timers.clear();
  for (const { callback } of pending) callback();
}
function targetFor(item, kind = 'mark') {
  const target = {
    ownerDocument: doc, isConnected: true, dataset: { annotationId: item.id }, parentElement: null,
    closest: (selector) => selector === (kind === 'trigger' ? '.annotation-note-trigger' : ':is(mark, mrow)[data-annotation-id]') ? target : null,
  };
  return target;
}
const pointer = (target = { closest: () => null }, changes = {}) => ({ target, pointerType: 'mouse', buttons: 0, ...changes });
context.installReaderAnnotationHover(doc);
assert.equal(listeners.size, 8);
context.installReaderAnnotationHover(doc);
assert.equal(listeners.size, 8, 'Reader activation does not duplicate annotation listeners');
for (const name of ['pointermove', 'pointerup', 'mouseleave', 'window:blur']) {
  listeners.get(name)(pointer());
  flushTimers();
}
assert.equal(context.state.selection, null, 'Ordinary sentences cannot create an action selection');
assert.equal(toolbar.hidden, true, 'Ordinary sentences cannot open the manual selection toolbar');
assert.equal(opened.length, 0);
assert.equal(timers.size, 0);

const mark = targetFor(annotation);
listeners.get('pointermove')(pointer(mark));
assert.equal(timers.size, 1);
assert.equal([...timers.values()][0].delay, 120);
const originalTimer = context.notePopoverHover.openTimer;
listeners.get('pointermove')(pointer(mark));
assert.equal(context.notePopoverHover.openTimer, originalTimer, 'Movement inside the same note does not postpone its preview');
flushTimers();
assert.equal(opened.length, 1);
assert.equal(opened[0][0], annotation);
assert.equal(opened[0][1], mark);
assert.equal(opened[0][2].pinned, false);
assert.equal(context.state.selection, null, 'A note preview does not create a selection action target');
assert.equal(toolbar.hidden, true);

for (const item of [
  { id: 'label', label: '原理', note: '' },
  { id: 'body', label: '', note: 'Personal note.' },
  { id: 'plain', label: '', note: '   ' },
  { id: 'ai', label: 'AI label', note: 'AI reason', source: 'ai' },
]) {
  context.state.annotations = [item];
  const before = opened.length;
  listeners.get('pointermove')(pointer(targetFor(item)));
  flushTimers();
  assert.equal(opened.length - before, item.id === 'label' || item.id === 'body' ? 1 : 0, `${item.id}: only manual marks with details open a note preview`);
}
const empty = { id: 'empty', label: '', note: '' };
context.state.annotations = [empty];
listeners.get('pointermove')(pointer(targetFor(empty, 'trigger')));
flushTimers();
assert.equal(opened.at(-1)[0], empty, 'An explicit note trigger can preview an empty manual annotation');

context.state.annotations = [annotation];
for (const invalidate of [
  () => { mark.isConnected = false; },
  () => { nativeText = 'Selected text'; },
  () => { context.notePopoverHover.pinned = true; },
  () => { currentMount = {}; },
  () => { currentDoc = {}; },
]) {
  mark.isConnected = true; nativeText = ''; context.notePopoverHover.pinned = false;
  currentMount = context.readerMount; currentDoc = doc;
  const before = opened.length;
  context.scheduleNoteHoverOpen(mark);
  invalidate();
  flushTimers();
  assert.equal(opened.length, before, 'A stale, pinned or selected reader cannot open a delayed preview');
}
currentMount = context.readerMount; currentDoc = doc; nativeText = ''; context.notePopoverHover.pinned = false;
context.scheduleNoteHoverOpen(mark);
listeners.get('pointermove')(pointer());
flushTimers();
assert.equal(opened.at(-1)[0], empty, 'Leaving a note before its delay cancels the preview');

note = { dataset: { annotationId: annotation.id }, isConnected: true, classList: { contains: () => false } };
listeners.get('pointermove')(pointer());
assert.equal([...timers.values()][0].delay, 260);
const noteTarget = { closest: (selector) => selector === '.annotation-note-popover' ? note : null };
listeners.get('pointermove')(pointer(noteTarget));
assert.equal(timers.size, 0, 'Entering the note cancels delayed close');
context.notePopoverHover.pinned = true;
listeners.get('scroll')(pointer());
assert.equal(context.notePopoverHover.pinned, true, 'Scrolling preserves an explicitly pinned note');
listeners.get('pointerdown')(pointer());
assert.equal(context.notePopoverHover.pinned, false, 'An outside click releases a pinned note');
assert.equal(closed.at(-1).options.immediate, true);

const selection = { origin: 'selection', quote: 'Manually selected.', job_id: 'paper', render_generation: 'base' };
context.state.selection = selection; toolbar.hidden = false;
assert.equal(context.activeSelectionActionTarget(), selection);
for (const invalidate of [
  () => { toolbar.hidden = true; },
  () => { toolbarClasses.add('is-closing'); },
  () => { selection.job_id = 'other'; },
  () => { selection.render_generation = 'other'; },
  () => { currentDoc = null; },
  () => { readerClasses.clear(); },
]) {
  invalidate();
  assert.equal(context.activeSelectionActionTarget(), null, 'Stale or hidden manual actions cannot receive shortcuts');
  toolbar.hidden = false; toolbarClasses.clear(); selection.job_id = 'paper'; selection.render_generation = 'base';
  currentDoc = doc; readerClasses.add('active-view');
}
listeners.get('keydown')({ key: 'Escape', defaultPrevented: false });
assert.equal(context.state.selection, null);
assert.equal(toolbar.hidden, true, 'Escape still dismisses a manual selection toolbar');
assert.doesNotMatch(source, /readerSentenceState|sentence-hover|installReaderSentenceHover|readerHoverTranslationEnabled/u);
assert.match(functionSource('showSelection'), /origin: 'selection'/u);
console.log('manual selection and annotation hover tests passed');
