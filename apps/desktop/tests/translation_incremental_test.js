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
console.log('translation incremental rendering tests passed');
