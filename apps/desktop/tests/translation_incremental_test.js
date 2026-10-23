'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const from = source.indexOf('  function preserveReaderHoverThroughTranslationLayout(');
const to = source.indexOf('  async function translateBlock(', from);
assert(from >= 0 && to > from);

class Element {
  constructor() { this.dataset = {}; this.children = []; this.className = ''; }
  get classList() { return { contains: (name) => this.className.split(/\s/u).includes(name), add: (name) => { this.className += ` ${name}`; } }; }
  append(node) { this.children.push(node); }
  closest() { return null; }
  querySelectorAll() { return this.marks || []; }
  remove() { this.removed = true; }
}
function documentFixture() {
  const frames = new Map(); let nextFrame = 0;
  const translations = [];
  const block = new Element(); block.dataset.blockId = 'one';
  block.insertAdjacentElement = (_position, node) => translations.push(node);
  const doc = {
    block, translations,
    createElement: () => new Element(),
    querySelectorAll: () => translations.filter((node) => !node.removed),
    defaultView: {
      requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
      cancelAnimationFrame(id) { frames.delete(id); },
    },
    nextFrame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); },
  };
  return doc;
}
const doc = documentFixture();
const background = documentFixture();
const states = new WeakMap();
const docState = (value) => {
  if (!states.has(value)) states.set(value, { annotationsKey: 'unchanged', sentences: [{}], unresolvedAnnotationIds: new Set() });
  return states.get(value);
};
const marked = []; const positioned = []; const statuses = [];
const originalMark = new Element(); originalMark.dataset.annotationId = 'paper-note';
const previousTranslation = new Element(); previousTranslation.marks = [{ dataset: { annotationId: 'relocated-note' } }];
doc.translations.push(previousTranslation);
const context = vm.createContext({
  state: { annotations: [
    { id: 'paper-note', block_id: 'one', surface: 'paper' },
    { id: 'translation-note', block_id: 'translation-one', surface: 'translation' },
    { id: 'relocated-note', block_id: 'old-translation-id', surface: 'translation' },
    { id: 'other-note', block_id: 'translation-two', surface: 'translation', source_block_id: 'two' },
  ] },
  frameDocument: () => doc, readerDocumentState: docState,
  translationTarget: (_blockId, value) => value.block,
  renderTranslationText: (text) => text,
  syncTranslationBlockVisibility() {}, refreshReaderSearch() {},
  applyMark: (annotation) => { marked.push(annotation.id); return true; },
  isAIAnnotation: () => false,
  updateAnnotationAnchorStatus: (count) => statuses.push(count),
  positionReaderSentenceTooltip: (value) => positioned.push(value),
  cssEscape: (value) => value,
  renderFrameAnnotations: () => assert.fail('Translation insertion must not repaint source annotations'),
  rebuildReaderSentencePairs: () => assert.fail('Translation insertion must not rebuild source sentence ranges'),
});
vm.runInContext(`${source.slice(from, to)}\nthis.insert = insertTranslation;`, context);
const sentences = docState(doc).sentences;
context.insert('one', '正在翻译…', { pending: true });
assert(previousTranslation.removed);
assert.deepEqual(marked, []);
assert.equal(docState(doc).annotationsKey, 'unchanged');
assert.equal(docState(doc).sentences, sentences);
context.insert('one', 'Translated text');
assert.deepEqual(marked, ['translation-note', 'relocated-note'], 'Only notes targeting the arriving translation are replayed, including marks displaced by a pending placeholder');
assert.equal(originalMark.removed, undefined);
assert.equal(docState(doc).translationLayoutPending, true);
doc.nextFrame();
assert.equal(docState(doc).translationLayoutPending, true, 'Layout scroll remains covered through its rendering frame');
doc.nextFrame();
assert.equal(docState(doc).translationLayoutPending, false);
assert.equal(docState(doc).unresolvedAnnotations, 0);
assert(positioned.length >= 3);
context.insert('one', 'Background text', { doc: background });
assert.equal(docState(background).annotationsKey, undefined, 'Inactive readers reconcile their own annotations when activated');
assert.deepEqual(marked, ['translation-note', 'relocated-note']);

async function testReopenedTranslationRun() {
  const translateFrom = source.indexOf('  async function translateSnapshot(');
  const translateTo = source.indexOf('  // Which part of the document', translateFrom);
  const disposeFrom = source.indexOf('  function disposeReaderMount(');
  const disposeTo = source.indexOf('  function resetReaderProgress(', disposeFrom);
  assert(translateFrom >= 0 && translateTo > translateFrom && disposeFrom >= 0 && disposeTo > disposeFrom);
  const scenarios = [
    { name: 'reopened reader', reopen: true, expected: true },
    { name: 'other active document', otherActive: true, expected: false },
    { name: 'reopened reader in background', reopen: true, otherActive: true, expected: true },
    { name: 'different generation', reopen: true, generation: '1', expected: false },
    { name: 'changed paragraph', reopen: true, text: 'Changed source.', expected: false },
  ];
  for (const scenario of scenarios) {
    const snapshot = { blockId: 'one', source: { text: 'Original source.', formulas: [] } };
    const makeMount = (jobId, generation = 'base', text = snapshot.source.text) => {
      const document = documentFixture();
      document.block.source = { ...snapshot.source, text };
      return { jobId, generation, loaded: true, frame: { contentDocument: document, remove() {} } };
    };
    const original = makeMount('paper');
    const mounts = new Map([['paper', original]]);
    const run = { jobId: 'paper', generation: 'base', mount: original, document: original.frame.contentDocument, abortController: new AbortController() };
    const painted = [];
    const requested = [];
    let finish;
    const lifecycle = vm.createContext({
      state: { activeJob: { job_id: 'paper' }, translationRuns: new Map([['paper', run]]) },
      readerMount: original, readerMounts: mounts, readerSections: [],
      window: { clearTimeout() {} }, deactivateReaderMount() {},
      readerMountIsCurrent: (mount) => Boolean(mount && mounts.get(mount.jobId) === mount),
      translationProfileId: () => 'profile',
      translationSourceHash: (value) => JSON.stringify(value),
      paragraphSource: (block) => block.source,
      translationTarget: (_id, document) => document.block,
      insertTranslation: (_id, text, options) => painted.push({ text, document: options.doc }),
      requestTranslation: (_text, _id, _formulas, options) => {
        requested.push(options.jobId);
        return new Promise((resolve) => { finish = resolve; });
      },
      translationErrorMessage: (error) => error.message,
    });
    vm.runInContext(`${source.slice(disposeFrom, disposeTo)}\n${source.slice(translateFrom, translateTo)}\nthis.test = { disposeReaderMount, translateSnapshot };`, lifecycle);
    const pending = lifecycle.test.translateSnapshot(snapshot, run);
    assert.strictEqual(painted[0].document, original.frame.contentDocument);
    lifecycle.test.disposeReaderMount('paper');
    assert.strictEqual(run.mount, null);
    assert.strictEqual(run.document, null);
    painted.length = 0;
    const reopened = scenario.reopen ? makeMount('paper', scenario.generation, scenario.text) : null;
    if (reopened) mounts.set('paper', reopened);
    const active = scenario.otherActive ? makeMount('other') : reopened;
    if (scenario.otherActive) mounts.set('other', active);
    lifecycle.readerMount = active;
    lifecycle.state.activeJob = active ? { job_id: active.jobId } : null;
    finish({ text: 'Translated text' });
    assert.strictEqual(await pending, true, `${scenario.name}: the request still completes`);
    assert.deepEqual(requested, ['paper']);
    assert.deepEqual(painted.map((entry) => entry.document), scenario.expected ? [reopened.frame.contentDocument] : [], `${scenario.name}: only a matching source document receives the arriving paragraph`);
  }
}

testReopenedTranslationRun().then(() => console.log('translation incremental rendering tests passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
