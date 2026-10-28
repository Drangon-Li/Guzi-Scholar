'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const annotationOperations = require('../web/annotation-operations.js');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const start = source.indexOf('  const builtinAnnotationActions =');
const end = source.indexOf('  function renderAnnotationActionSettings(', start);
assert(start >= 0 && end > start);
const builtin = ['highlight', 'highlight_note', 'underline', 'underline_note', 'copy', 'chat'];
function harness() {
  const calls = [];
  const buttons = new Map(builtin.map((name) => [name, { dataset: { builtinAction: name }, setAttribute(key, value) { this[key] = value; }, click() { calls.push([name]); } }]));
  const container = {};
  const popoverClasses = new Set();
  const shortcutSettings = {};
  const popover = { classList: { toggle(name, enabled) { if (enabled) popoverClasses.add(name); else popoverClasses.delete(name); } } };
  const elements = { '#selection-custom-actions': container, '#selection-popover': popover, '#selection-shortcut-settings': shortcutSettings };
  let target = {};
  let ready = true;
  let release;
  const context = vm.createContext({
    state: { annotationActions: { hidden_builtin: [], custom: [] } },
    $: (selector) => elements[selector] || buttons.get(selector.match(/^\[data-builtin-action="(.*)"\]$/u)?.[1]),
    $$: () => [...buttons.values()],
    window: { MyScholarVocabulary: { validTerm: () => false } },
    normalizeAnnotationColor: (value) => value, escapeHTML: (value) => value,
    activeSelectionActionTarget: () => target,
    readerShortcutReady: () => ready,
    isEditableAppSurface: (node) => Boolean(node?.editable),
    saveAnnotation: (kind, options) => {
      calls.push([kind, JSON.parse(JSON.stringify(options))]);
      return context.hold ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
    },
  });
  vm.runInContext(source.slice(start, end) + '\nthis.handle = handleSelectionNumberShortcut; this.actions = selectionNumberActions; this.render = renderSelectionActions; this.normalize = normalizeAnnotationActions;', context);
  return { context, calls, buttons, container, popoverClasses, shortcutSettings, setTarget(value) { target = value; }, setReady(value) { ready = value; }, release: () => release() };
}
function event(key, changes = {}) {
  return { key, target: {}, preventDefault() { this.defaultPrevented = true; }, ...changes };
}
(async () => {
  const h = harness();
  assert.equal(h.context.normalize(undefined).show_shortcut_hints, true, 'Existing settings show number hints by default');
  assert.deepEqual(Array.from(h.context.actions(), (entry) => entry.builtin), builtin);
  for (const [key, kind, withNote] of [['1', 'highlight', false], ['2', 'highlight', true], ['3', 'underline', false], ['4', 'underline', true]]) {
    const e = event(key);
    assert.equal(h.context.handle(e), true);
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(h.calls.at(-1), [kind, { withNote }]);
    await Promise.resolve();
  }
  h.context.handle(event('5')); assert.deepEqual(h.calls.at(-1), ['copy']);
  h.context.handle(event('6')); assert.deepEqual(h.calls.at(-1), ['chat']);
  assert.equal(h.context.handle(event('7')), false, 'Absent custom actions leave the key untouched');
  h.context.state.annotationActions.hidden_builtin = ['highlight_note', 'copy'];
  h.context.render();
  assert.equal(h.buttons.get('highlight_note').hidden, true);
  assert.equal(h.buttons.get('underline').dataset.selectionShortcut, '3', 'Hiding a built-in must not renumber the remaining actions');
  h.context.handle(event('2')); assert.deepEqual(h.calls.at(-1), ['highlight', { withNote: true }]);
  await Promise.resolve();

  const custom = Array.from({ length: 5 }, (_, index) => ({ id: `custom-${index}`, label: `标记 ${index + 1}`, kind: index % 2 ? 'underline' : 'highlight', color: '#2563eb', enabled: true }));
  h.context.state.annotationActions.custom = custom;
  h.context.render();
  for (const [index, key] of ['7', '8', '9', '0'].entries()) {
    assert.equal(h.context.handle(event(key)), true);
    assert.deepEqual(h.calls.at(-1), [custom[index].kind, { action: custom[index] }]);
    assert.match(h.container.innerHTML, new RegExp(`data-semantic-action="custom-${index}" data-selection-shortcut="${key}"`));
    await Promise.resolve();
  }
  assert.doesNotMatch(h.container.innerHTML, /data-semantic-action="custom-4" data-selection-shortcut/u);
  h.context.state.annotationActions = h.context.normalize({ ...h.context.state.annotationActions, show_shortcut_hints: false });
  h.context.render();
  assert.equal(h.popoverClasses.has('hide-shortcut-hints'), true);
  assert.equal(h.shortcutSettings.hidden, true);
  assert.equal(h.buttons.get('highlight').title, '高亮', 'Hidden hints also remove numbers from hover titles');
  assert.equal(h.buttons.get('highlight')['aria-keyshortcuts'], '1', 'The shortcut remains available to assistive technology');
  assert.match(h.container.innerHTML, /aria-keyshortcuts="7" title="标记 1"/u);
  h.context.handle(event('5')); assert.deepEqual(h.calls.at(-1), ['copy'], 'Hiding hints does not disable built-in shortcuts');
  h.context.handle(event('7')); assert.deepEqual(h.calls.at(-1), ['highlight', { action: custom[0] }], 'Hiding hints does not disable custom shortcuts');
  await Promise.resolve();
  h.context.state.annotationActions.show_shortcut_hints = true;
  h.context.render();
  assert.equal(h.popoverClasses.has('hide-shortcut-hints'), false);
  assert.equal(h.shortcutSettings.hidden, false);
  assert.equal(h.buttons.get('highlight').title, '高亮（1）');
  h.context.state.annotationActions.custom = custom;
  custom[0].enabled = false;
  h.context.handle(event('7'));
  assert.deepEqual(h.calls.at(-1), ['underline', { action: custom[1] }], 'Only enabled custom actions consume number slots');
  await Promise.resolve();

  for (const change of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { target: { editable: true } }]) {
    const before = h.calls.length;
    assert.equal(h.context.handle(event('1', change)), false);
    assert.equal(h.calls.length, before);
  }
  h.setTarget(null); assert.equal(h.context.handle(event('1')), false);
  h.setTarget({}); h.setReady(false); assert.equal(h.context.handle(event('1')), false);
  h.setReady(true); h.context.hold = true;
  const before = h.calls.length;
  assert.equal(h.context.handle(event('1')), true);
  assert.equal(h.context.handle(event('3')), true);
  assert.equal(h.calls.length, before + 1, 'Rapid keys must not submit multiple annotations for the same target');
  h.release();
  await Promise.resolve();

  const saveStart = source.indexOf('  async function saveAnnotation(');
  const saveEnd = source.indexOf('  function applyAnnotationActionSync(', saveStart);
  assert(saveStart >= 0 && saveEnd > saveStart);
  let completeSave;
  const savedSelection = { block_id: 'source', start: 0, end: 13, quote: 'Stored quote.' };
  const saveContext = vm.createContext({
    state: { activeJob: { job_id: 'job' }, selection: savedSelection, annotations: [] },
    readerMount: { jobId: 'job', annotations: [] },
    frameDocument: () => ({ querySelector: () => ({}) }),
    cssEscape: (value) => value, rangeAtOffsets: () => ({}), canonicalBlockText: () => 'Stored quote.',
    readerMountMatches: () => true, readerMountIsCurrent: () => true,
    jsonOptions: (value) => value, annotationColorFor: () => '#f59e0b',
    api: () => new Promise((resolve) => { completeSave = resolve; }),
    renderFrameAnnotations() {},
    playAnnotationDrawAnimation() {},
    renderAnnotations() {}, annotationAnchor: () => ({}),
    clearSelectionPopover() { saveContext.state.selection = null; },
    setPanelStatus: (message) => assert.fail(message), showToast: (message) => assert.fail(message),
  });
  saveContext.annotationOperations = annotationOperations.create({
    request: saveContext.api, getCloseGate: () => null, waitForCloseResume: async () => {},
    state: saveContext.state, mounts: new Map([['job', saveContext.readerMount]]),
    getCurrentMount: () => saveContext.readerMount,
    isCurrentMount: saveContext.readerMountIsCurrent, matchesMount: saveContext.readerMountMatches,
    isAIAnnotation: (annotation) => annotation.source === 'ai',
  });
  saveContext.api = saveContext.annotationOperations.api;
  vm.runInContext(source.slice(saveStart, saveEnd) + '\nthis.save = saveAnnotation;', saveContext);
  for (const next of [null, { quote: 'A new manual selection.', origin: 'selection' }]) {
    saveContext.state.selection = savedSelection;
    const saving = saveContext.save('highlight');
    if (next) saveContext.state.selection = next;
    await Promise.resolve();
    completeSave({ annotations: [{ id: 'saved' }], annotation: { id: 'saved' } });
    await saving;
    if (!next) assert.equal(saveContext.state.selection, null);
    else assert.equal(saveContext.state.selection, next, 'A completed save must not clear a newer manual selection');
  }
  console.log('selection number shortcut tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
