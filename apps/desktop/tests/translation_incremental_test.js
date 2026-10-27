'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const from = source.indexOf('  function reconcileTranslationAnnotations(');
const to = source.indexOf('  async function translateBlock(', from);
assert(from >= 0 && to > from);

class Element {
  constructor() { this.dataset = {}; this.children = []; this.className = ''; this.style = { removeProperty() {} }; }
  get classList() { return { contains: (name) => this.className.split(/\s/u).includes(name), add: (name) => { this.className += ` ${name}`; }, remove: (name) => { this.className = this.className.split(/\s/u).filter((value) => value !== name).join(' '); } }; }
  append(node) { this.children.push(node); }
  setAttribute(name, value) { this[name] = value; }
  closest() { return null; }
  querySelectorAll(selector) { return selector.includes('data-annotation-id') ? this.marks || [] : this.children.filter((node) => !node.removed && node.className?.includes(selector.slice(1))); }
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
    querySelector: () => translations.find((node) => !node.removed && !node.classList.contains('is-pending') && !node.classList.contains('is-error')) || null,
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
  if (!states.has(value)) states.set(value, { annotationsKey: 'unchanged', unresolvedAnnotationIds: new Set() });
  return states.get(value);
};
const marked = []; const statuses = [];
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
  cssEscape: (value) => value,
  renderFrameAnnotations: () => assert.fail('Translation insertion must not repaint source annotations'),
});
vm.runInContext(`${source.slice(from, to)}\nthis.insert = insertTranslation;`, context);
context.insert('one', '正在翻译…', { pending: true });
assert.equal(previousTranslation.removed, undefined, 'Re-translation keeps the previous translation and its annotations visible');
assert.equal(doc.block.children.at(-1).role, 'status');
assert.match(doc.block.children.at(-1).textContent, /原译文已保留/u);
assert.deepEqual(marked, []);
assert.equal(docState(doc).annotationsKey, 'unchanged');
context.insert('one', '翻译失败', { error: true });
assert.equal(previousTranslation.removed, undefined, 'Failed re-translation must retain the saved translation');
assert.match(doc.block.children.at(-1).textContent, /翻译失败.*原译文已保留/u);
context.insert('one', 'Translated text');
assert.equal(previousTranslation.removed, true, 'Only a successful replacement removes the previous translation');
assert.deepEqual(marked, ['translation-note', 'relocated-note'], 'Only notes targeting the arriving translation are replayed, including marks displaced by a pending placeholder');
assert.equal(originalMark.removed, undefined);
assert.equal(docState(doc).unresolvedAnnotations, 0);
context.insert('one', 'Background text', { doc: background });
assert.equal(docState(background).annotationsKey, undefined, 'Inactive readers reconcile their own annotations when activated');
assert.deepEqual(marked, ['translation-note', 'relocated-note']);

function testAlignedUpdatesShareOneFrame() {
  const alignedDoc = documentFixture();
  alignedDoc.querySelector = () => ({});
  alignedDoc.block.isConnected = true;
  alignedDoc.block.matches = () => false;
  alignedDoc.addEventListener = () => {};
  alignedDoc.defaultView.ResizeObserver = class { observe() {} disconnect() {} };
  const laidOut = [];
  const replayed = [];
  const selectionPaints = [];
  const selectionStates = new WeakMap();
  const alignedContext = vm.createContext({
    state: { annotations: [{ id: 'translated-note', block_id: 'translation-one', surface: 'translation' }] },
    frameDocument: () => alignedDoc, readerDocumentState: docState,
    readerTextSelectionStates: selectionStates, renderFrameTextSelection: (doc) => selectionPaints.push(doc),
    translationTarget: () => alignedDoc.block,
    canonicalBlockText: () => 'One sentence.', paragraphSource: () => ({ text: 'One sentence.' }),
    syncTranslationBlockVisibility() {}, refreshReaderSearch() {}, renderTranslationText: (text) => text,
    applyMark: (annotation) => { replayed.push(annotation.id); return true; },
    isAIAnnotation: () => false, updateAnnotationAnchorStatus() {},
    cssEscape: (value) => value,
    renderFrameAnnotations: () => assert.fail('Aligned translation must not repaint the document'),
  });
  // The production scheduler remains intact; only geometry is replaced in this unit test.
  alignedContext.laidOut = laidOut;
  vm.runInContext(`${source.slice(from, to)}
    insertSentenceTranslations = (block) => { block.classList.add('reader-sentence-pairs'); return { dataset: {} }; };
    layoutInterlinearContainer = (block) => laidOut.push(block);
    this.insert = insertTranslation;`, alignedContext);
  alignedContext.insert('one', '译文一', { segments: [{ id: 's0-13', text: '译文一' }] });
  alignedContext.insert('one', '译文二', { segments: [{ id: 's0-13', text: '译文二' }] });
  assert.equal(docState(alignedDoc).annotationsKey, 'unchanged', 'An arriving aligned paragraph keeps the document annotation cache');
  assert.equal(laidOut.length, 0);
  alignedDoc.nextFrame();
  assert.deepEqual(laidOut, [alignedDoc.block]);
  assert.deepEqual(replayed, ['translated-note']);
  selectionStates.set(alignedDoc, {});
  alignedContext.insert('one', '旧格式整段译文');
  assert.equal(docState(alignedDoc).annotationsKey, 'unchanged', 'Legacy replacement also keeps unrelated annotation caches');
  alignedDoc.nextFrame();
  assert.deepEqual(laidOut, [alignedDoc.block, alignedDoc.block], 'Aligned and legacy replacements share the paragraph layout scheduler');
  assert.deepEqual(replayed, ['translated-note', 'translated-note']);
  assert.deepEqual(selectionPaints, [alignedDoc], 'A retained manual selection follows the completed translation layout');
}


testAlignedUpdatesShareOneFrame();

async function testReopenedTranslationRun() {
  const translateFrom = source.indexOf('  async function translateSnapshot(');
  const translateTo = source.indexOf('  const translationScopeStorageKey', translateFrom);
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
    const disposed = [];
    let finish;
    const lifecycle = vm.createContext({
      state: { activeJob: { job_id: 'paper' }, translationRuns: new Map([['paper', run]]) },
      readerMount: original, readerMounts: mounts, readerSections: [],
      window: { clearTimeout() {} }, deactivateReaderMount() {},
      disposeInterlinearTranslations: (document) => disposed.push(document),
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
      rememberDisplayedTranslation() {},
    });
    vm.runInContext(`${source.slice(disposeFrom, disposeTo)}\n${source.slice(translateFrom, translateTo)}\nthis.test = { disposeReaderMount, translateSnapshot };`, lifecycle);
    const pending = lifecycle.test.translateSnapshot(snapshot, run);
    assert.strictEqual(painted[0].document, original.frame.contentDocument);
    lifecycle.test.disposeReaderMount('paper');
    assert.deepEqual(disposed, [original.frame.contentDocument], 'Closing a reader releases its interlinear layout resources');
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

async function testFullTranslationPreparation() {
  const slots = source.slice(source.indexOf('  const FULL_TRANSLATION_MAX_DOCUMENTS'), source.indexOf('  // One paragraph of a run.'));
  const runs = source.slice(source.indexOf('  function fullTranslationSnapshot('), source.indexOf('  function stopFullTranslation('));
  const usable = source.slice(source.indexOf('  function hasUsableTranslation('), source.indexOf('  const FULL_TRANSLATION_CONCURRENCY'));
  for (const scenario of ['complete', 'stop', 'close', 'generation', 'background', 'cached', 'background cached']) {
    const callbacks = [];
    const extracted = [];
    const requested = [];
    const blocks = Array.from({ length: 20 }, (_value, index) => ({
      dataset: { blockId: String(index) }, text: `Original paragraph ${index}.`, matches: () => false,
    }));
    const doc = { querySelectorAll: () => blocks, querySelector: () => null };
    const mount = { jobId: 'paper', generation: 'base', frame: { contentDocument: doc } };
    const mounts = new Map([['paper', mount]]);
    const state = { activeJob: { job_id: 'paper' }, translationRuns: new Map() };
    const context = vm.createContext({
      state, readerMount: mount, AbortController, FULL_TRANSLATION_CONCURRENCY: 3,
      window: { setTimeout: (callback) => callbacks.push(callback) }, performance: { now: () => 0 },
      translationScope: () => 'all', aiServiceEnabled: () => true, frameDocument: () => context.readerMount.frame.contentDocument,
      readerMountIsCurrent: (value) => Boolean(value && mounts.get(value.jobId) === value),
      translationTarget: (id) => blocks[Number(id)], translatableParagraph: () => true,
      paragraphSource: (block) => ({ text: block.text }), translationSourceHash: (value) => value.text,
      cssEscape: (value) => value, translationTargetLanguage: () => '中文',
      cachedTranslationForSource: (blockId, _source, _language, jobId) => {
        assert.equal(jobId, 'paper', 'Preparation reads the cache belonging to its own document');
        return Number(blockId) % 2 === 0 ? { text: 'Cached translation.' } : null;
      },
      paragraphTranslationSource: (block) => { extracted.push(block.dataset.blockId); return { text: block.text }; },
      documentTitleFor: () => 'Paper', syncTranslationControls() {}, updateTranslationProgress() {},
      showToast() {}, setPanelStatus() {}, releaseClosedDocumentCaches() {}, translationErrorMessage: (error) => error.message,
      translateSnapshot: async (snapshot) => {
        requested.push(snapshot.source.text);
        blocks.forEach((block) => { block.text = 'Changed after translation started.'; });
        return true;
      },
    });
    vm.runInContext(`${usable}\n${slots}\n${runs}\nthis.run = runFullTranslation; this.cancel = cancelTranslationRun;`, context);
    const pending = context.run({ refresh: !scenario.includes('cached') });
    const run = state.translationRuns.get('paper');
    assert.equal(run.running, true, `${scenario}: stop controls are available before preparation`);
    assert.equal(extracted.length, 0, `${scenario}: source extraction yields before starting`);
    const nextChunk = async () => { assert.ok(callbacks.length); callbacks.shift()(); await Promise.resolve(); };
    await nextChunk();
    assert.equal(extracted.length, scenario.includes('cached') ? 4 : 8, `${scenario}: one turn prepares at most eight candidates`);
    assert.equal(requested.length, 0, `${scenario}: requests wait until every source is frozen`);
    if (scenario === 'stop') context.cancel(run);
    if (scenario === 'close') {
      mounts.delete('paper');
      run.mount = null;
      run.document = null;
    }
    if (scenario === 'generation') mount.generation = 'next';
    if (scenario.startsWith('background')) {
      context.readerMount = { jobId: 'other', frame: { contentDocument: {
        querySelector: () => assert.fail('Background preparation must not inspect the active reader'),
      } } };
      state.activeJob = { job_id: 'other' };
    }
    await nextChunk();
    if (['stop', 'close', 'generation'].includes(scenario)) {
      await pending;
      assert.equal(extracted.length, 8, `${scenario}: invalidated preparation extracts no further source`);
      assert.equal(requested.length, 0, `${scenario}: invalidated preparation sends no requests`);
      assert.equal(run.stop, true);
    } else {
      await nextChunk();
      await pending;
      const expected = blocks.filter((block) => !scenario.includes('cached') || Number(block.dataset.blockId) % 2 !== 0)
        .map((block) => `Original paragraph ${block.dataset.blockId}.`);
      assert.deepEqual(requested, expected, `${scenario}: all requests use their frozen original source`);
      assert.equal(run.done, 20);
      assert.equal(run.total, 20);
    }
    assert.equal(run.running, false);
    assert.equal(run.mount, null);
    assert.equal(run.document, null);
    assert.equal(callbacks.length, 0);
  }
}

Promise.all([testReopenedTranslationRun(), testFullTranslationPreparation()]).then(() => console.log('translation incremental rendering tests passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
