const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const start = app.indexOf('  function resolveAnnotationAnchor(');
const end = app.indexOf('\n  function applyMark(', start);
let generation = '2';
let blocks = [];
const readerContinuations = new WeakMap();
const doc = {
  querySelector(selector) { return blocks.find((block) => selector.includes(`"${block.dataset.blockId}"`)) || null; },
  querySelectorAll() { return blocks; },
};
const context = vm.createContext({
  readerContinuations,
  frameDocument: () => doc,
  cssEscape: (value) => value,
  normalizeChatSourceGeneration: (value) => value || '',
  activeChatSourceGeneration: () => generation,
  canonicalBlockText: (block) => block.text,
  rangeAtOffsets: (block, offset, endOffset) => ({ text: block.text.slice(offset, endOffset), offset, endOffset }),
  annotationRange: (block, annotation) => block.text.slice(annotation.start, annotation.end) === annotation.quote ? { text: annotation.quote } : null,
});
vm.runInContext(`${app.slice(start, end)}\nthis.resolve = resolveAnnotationAnchor;`, context);
const block = (id, text, page = '1') => ({ dataset: { blockId: id, page }, text, closest: () => null });
const annotation = { id: 'saved', block_id: 'old-block', quote: 'retained quote', page: 1, start: 4, end: 18, surface: 'paper' };
const original = JSON.stringify(annotation);
blocks = [block('new-block', 'New layout: retained quote and more.')];
assert.equal(context.resolve(annotation).root.dataset.blockId, 'new-block');
assert.equal(context.resolve({ ...annotation, import_anchor_disabled: true }), null, 'Unsupported Zotero anchors must never relocate even when their quote is unique.');
assert.equal(context.resolve(annotation).range.text, annotation.quote);
assert.equal(JSON.stringify(annotation), original, 'Locating an annotation must not overwrite its saved anchor.');
blocks.push(block('other-block', 'Another retained quote instance.'));
assert.equal(context.resolve(annotation), null, 'An ambiguous quote must remain saved without marking the wrong text.');
blocks = [block('old-block', 'Unrelated replacement text.'), block('new-block', 'The retained quote survives.')];
assert.equal(context.resolve(annotation).root.dataset.blockId, 'new-block', 'A reused block ID must not override quote evidence.');
blocks = [block('new-block', 'The retained quote survives.', '2')];
assert.equal(context.resolve(annotation), null, 'A quote on another source page is not the original anchor.');
blocks = [block('a', 'Wrong retained quote tail.'), block('b', 'Right retained quote context.')];
assert.equal(context.resolve({ ...annotation, quote_prefix: 'Right ', quote_suffix: ' context.' }).root.dataset.blockId, 'b');
generation = 'base';
blocks = [block('old-block', 'The retained quote text.')];
assert.equal(context.resolve(annotation).root.dataset.blockId, 'old-block');

const leftText = 'Both blind passes combined showed any';
const rightText = 'response (agreement between readers) was retained.';
const joined = block('left-block', `${leftText} ${rightText}`);
const rightStart = leftText.length + 1;
blocks = [joined];
readerContinuations.set(doc, new Map([
  ['left-block', { root: joined, page: '1', start: 0, end: leftText.length }],
  ['right-block', { root: joined, page: '2', start: rightStart, end: joined.text.length }],
]));
const rightAnnotation = {
  id: 'right-saved', block_id: 'right-block', quote: 'agreement between readers',
  page: 2, start: rightText.indexOf('agreement'), end: rightText.indexOf('agreement') + 'agreement between readers'.length,
  surface: 'paper', render_generation: 'base',
};
const originalRightAnnotation = JSON.stringify(rightAnnotation);
const rightAnchor = context.resolve(rightAnnotation);
assert.equal(rightAnchor.root, joined, 'A saved right-page annotation must resolve to the logical paragraph.');
assert.equal(rightAnchor.range.offset, rightStart + rightAnnotation.start, 'Original right-page offsets must be translated into logical paragraph offsets.');
assert.equal(rightAnchor.range.text, rightAnnotation.quote);
assert.equal(JSON.stringify(rightAnnotation), originalRightAnnotation, 'Continuation resolution must not rewrite the saved anchor.');

const spanningQuote = 'showed any response';
const spanningStart = joined.text.indexOf(spanningQuote);
const spanningAnnotation = {
  block_id: 'left-block', page: 1, start: spanningStart, end: spanningStart + spanningQuote.length,
  quote: spanningQuote, surface: 'paper', render_generation: 'base',
  quote_prefix: 'combined ', quote_suffix: ' (agreement',
};
assert.equal(context.resolve(spanningAnnotation).range.text, spanningQuote, 'New annotations may span the PDF page boundary in the logical paragraph.');

generation = '2';
assert.equal(context.resolve({ ...annotation, block_id: 'renumbered-left-block', quote: 'blind passes', page: 1 }).range.text, 'blind passes', 'Another generation must still recover a quote within the original left-page segment.');
assert.equal(context.resolve(rightAnnotation).range.offset, rightStart + rightAnnotation.start, 'Another generation must recover a unique quote within its original right-page segment.');
assert.equal(context.resolve({ ...rightAnnotation, block_id: 'renumbered-right-block', start: 999, end: 1023 }).range.text, rightAnnotation.quote, 'Quote evidence must recover a renumbered right-page source without reusing obsolete offsets.');
assert.equal(context.resolve({ ...rightAnnotation, page: 1 }), null, 'Text from the right-page segment must not be attributed to the original left page.');
assert.equal(context.resolve({ ...spanningAnnotation, render_generation: 'old' }).range.text, spanningQuote, 'A new logical-paragraph annotation that starts on the first page may recover across a page boundary after a generation change.');
assert.equal(context.resolve({ ...spanningAnnotation, page: 2, render_generation: 'old' }), null, 'A cross-page annotation must not recover from the wrong source page.');
assert.equal(context.resolve({ ...rightAnnotation, block_id: 'left-block', page: 1 }), null, 'Using the logical paragraph ID must not attribute a quote starting in its right-page fragment to the first page.');

blocks.push(block('other-page-one-block', `Different ${spanningQuote} context.`, '1'));
assert.equal(context.resolve({ ...spanningAnnotation, quote_prefix: '', quote_suffix: '' }), null, 'A cross-page quote repeated on the same source page must remain ambiguous without context.');
assert.equal(context.resolve(spanningAnnotation).range.offset, spanningStart, 'Unique prefix and suffix evidence may disambiguate a cross-page quote.');
blocks.pop();

blocks.push(block('other-page-two-block', `Repeated ${rightAnnotation.quote} here.`, '2'));
assert.equal(context.resolve(rightAnnotation), null, 'An ambiguous quote on the original page must remain unresolved.');
assert.equal(JSON.stringify(rightAnnotation), originalRightAnnotation, 'Fallback and ambiguity checks must leave the persisted annotation unchanged.');
blocks.pop();
assert.equal(context.resolve({ ...rightAnnotation, surface: 'translation' }), null, 'A paper continuation must not resolve a translation-surface annotation.');

joined.text += ` Repeated ${rightAnnotation.quote}.`;
readerContinuations.get(doc).get('right-block').end = joined.text.length;
assert.equal(context.resolve(rightAnnotation), null, 'Repeated quotes within the same original source segment must remain ambiguous after a generation change.');
generation = 'base';
assert.equal(context.resolve(rightAnnotation).range.offset, rightStart + rightAnnotation.start, 'Valid original offsets may disambiguate repeated quotes in the same generation.');
assert.equal(context.resolve({ ...rightAnnotation, surface: 'translation' }), null, 'The precise continuation-offset path must also reject a translation-surface annotation.');

console.log('annotation reflow anchors: base and cross-page continuation checks passed');
