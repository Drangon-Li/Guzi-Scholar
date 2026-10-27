'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const from = source.indexOf("  const translationVisibilityStyleId = '");
const to = source.indexOf('  function scheduleReaderIdle(', from);
assert.ok(from >= 0 && to > from);
class Element {
  constructor(doc, tag = 'div') {
    this.ownerDocument = doc; this.tag = tag; this.dataset = {}; this.children = []; this.classes = new Set(); this.attributes = {}; this.listeners = {};
    this.classList = { contains: (name) => this.classes.has(name), toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  set className(value) { this.classes = new Set(value.split(/\s+/u)); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); this.ownerDocument.nodes.add(node); } }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.ownerDocument.nodes.delete(this); }
  matches(selector) { return selector === 'figcaption' && this.tag === 'figcaption'; }
  closest() { return this.preserve ? this : null; }
  querySelector(selector) { return this.children.find((node) => selector === '.translation-status-action' && node.classes.has('translation-status-action')) || null; }
  insertAdjacentElement(_position, node) { this.ownerDocument.head.append(node); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
}
function documentFixture() {
  const doc = { nodes: new Set(), blocks: [], createElement(tag) { return new Element(this, tag); }, getElementById(id) { return [...this.nodes].find((node) => node.id === id) || null; }, querySelector(selector) {
    const placeholder = selector.match(/^\[data-translation-placeholder-for="(.*)"\]$/u)?.[1];
    const translation = selector.match(/^\.my-scholar-translation\[data-for="(.*)"\]$/u)?.[1];
    return [...this.nodes].find((node) => placeholder ? node.dataset.translationPlaceholderFor === placeholder : translation && node.classes.has('my-scholar-translation') && node.dataset.for === translation) || null;
  }, querySelectorAll(selector) { return [...this.nodes].filter((node) => selector === '.my-scholar-translation-placeholder' && node.classes.has('my-scholar-translation-placeholder')); } };
  doc.head = new Element(doc, 'head'); doc.documentElement = new Element(doc, 'html');
  for (const id of ['ready', 'missing', 'pending', 'failure', 'formula', 'caption']) {
    const block = new Element(doc, id === 'caption' ? 'figcaption' : 'p'); block.dataset.blockId = id; block.preserve = id === 'formula'; doc.blocks.push(block);
    if (['ready', 'pending', 'failure'].includes(id)) {
      const node = new Element(doc); node.className = `my-scholar-translation${id === 'pending' ? ' is-pending' : id === 'failure' ? ' is-error' : ''}`; node.dataset.for = id; doc.head.append(node);
    }
  }
  return doc;
}
const doc = documentFixture(); const secondDoc = documentFixture();
const modeItems = ['original', 'bilingual', 'translation'].map((mode) => { const item = new Element(doc); item.dataset.translationDisplay = mode; return item; });
const writes = []; const translated = []; const layouts = [];
const context = vm.createContext({
  state: { translationPreferences: { displayMode: 'bilingual' } },
  translationPreferencesStorageKey: 'my-scholar-translation-preferences-v1',
  persistentStateSet: (...values) => writes.push(values),
  frameDocument: () => doc,
  readerMounts: new Map([['second', { frame: { contentDocument: secondDoc } }]]),
  refreshReaderSearch: () => {},
  scheduleInterlinearTranslations: (value) => layouts.push(value),
  translatableBlocks: (value) => value.blocks,
  cssEscape: (value) => value,
  $$: () => modeItems,
  translateBlock: (...values) => translated.push(values),
});
vm.runInContext(source.slice(from, to) + '\nthis.test = { normalizedTranslationPreferences, setTranslationPreferences, syncTranslationBlockVisibility, applyTranslationVisibility };', context);
const t = context.test;
const plain = (value) => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(t.normalizedTranslationPreferences(null)), { displayMode: 'bilingual' });
assert.deepEqual(plain(t.normalizedTranslationPreferences({ hoverEnabled: false, displayMode: 'translation', extra: true })), { displayMode: 'translation' });
assert.deepEqual(plain(t.normalizedTranslationPreferences({ hoverEnabled: 'false', displayMode: 'bad' })), { displayMode: 'bilingual' });
t.setTranslationPreferences({ displayMode: 'translation', hoverEnabled: false });
assert.equal(doc.documentElement.dataset.translationDisplay, 'translation');
assert.equal(secondDoc.documentElement.dataset.translationDisplay, 'translation');
assert.deepEqual(layouts, [secondDoc, doc], 'Both mounted readers must reflow when the display mode changes');
assert.equal(modeItems[2].attributes['aria-checked'], 'true');
assert.deepEqual(plain(JSON.parse(writes.at(-1)[1])), { displayMode: 'translation' });
assert.equal(translated.length, 0, 'Changing preferences must not request translations');
assert.ok(doc.blocks.find((block) => block.dataset.blockId === 'missing').classes.has('my-scholar-translation-original'));
assert.ok(!doc.blocks.find((block) => block.dataset.blockId === 'formula').classes.has('my-scholar-translation-original'), 'Independent equations stay visible');
assert.ok(doc.blocks.find((block) => block.dataset.blockId === 'caption').classes.has('my-scholar-translation-original'));
const placeholder = doc.querySelector('[data-translation-placeholder-for="missing"]');
assert.equal(placeholder.children[0].textContent, '待翻译');
placeholder.children[1].listeners.click({ preventDefault() {}, stopPropagation() {} });
assert.equal(translated[0][0], 'missing');
assert.equal(translated[0][2].refresh, false);
const failure = doc.querySelector('.my-scholar-translation[data-for="failure"]');
failure.querySelector('.translation-status-action').listeners.click({ preventDefault() {}, stopPropagation() {} });
assert.equal(translated[1][2].refresh, true);
assert.equal(doc.querySelector('[data-translation-placeholder-for="pending"]'), null);
t.setTranslationPreferences({ displayMode: 'original' });
assert.equal(doc.querySelector('[data-translation-placeholder-for="missing"]'), null);
assert.equal(doc.documentElement.dataset.translationDisplay, 'original');
t.setTranslationPreferences({ displayMode: 'bilingual' });
assert.equal(doc.documentElement.dataset.translationDisplay, 'bilingual');
assert.equal(doc.blocks.length, 6, 'Source DOM remains available for reversible display changes');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
assert.doesNotMatch(html, /id="toggle-translations-button"/u);
assert.doesNotMatch(html, /id="translation-hover-toggle"/u);
const scopeContext = vm.createContext({
  Node: { DOCUMENT_POSITION_PRECEDING: 2 },
  isMetadataParagraph: (block) => Boolean(block.metadata),
  paragraphText: (block) => block.textContent,
  persistentStateGet: () => 'body',
});
function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  }\n', start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 4);
}
const scopeStart = source.indexOf('  const translationScopeStorageKey =');
const scopeEnd = source.indexOf('  function syncTranslationScopeControls(', scopeStart);
vm.runInContext(functionSource('translatableParagraph') + '\n' + source.slice(scopeStart, scopeEnd)
  + '\nthis.scopeBlocks = translatableBlocks; this.boundary = referencesBoundary;', scopeContext);
function scopeDocument(entries) {
  const nodes = entries.map(([tag, textContent, id], index) => ({
    tag, textContent, dataset: id ? { blockId: id } : {},
    matches: (selector) => selector === 'h1.paper-title' ? id === 'title' : selector === 'h1.paper-title, h1[data-translate-block-id]' ? id === 'title' : false,
    closest: () => null,
    compareDocumentPosition: (node) => nodes.indexOf(node) < index ? 2 : 4,
  }));
  return { nodes, querySelectorAll: (selector) => selector === 'h1, h2, h3, h4, h5, h6'
    ? nodes.filter((node) => /^h[1-6]$/u.test(node.tag))
    : nodes.filter((node) => node.dataset.blockId && (node.tag === 'p' || node.dataset.blockId === 'title')) };
}
const paragraph = 'This paragraph contains enough source text for the translation candidate threshold.';
const bodyIds = (value, scope = 'body') => Array.from(scopeContext.scopeBlocks(value, scope), (block) => block.dataset.blockId);
for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
  for (const heading of ['Reference', ' REFERENCES ', '\n8.\tReferences\n', '8.References', 'VII REFERENCES', 'A. Reference', '[12] References:']) {
    const value = scopeDocument([['h1', 'Synthetic title', 'title'], ['p', paragraph, 'before'], ['h2', 'Appendix A'], ['p', paragraph, 'early-appendix'], [tag, heading], ['p', paragraph, 'references'], ['h2', 'Appendix B'], ['p', paragraph, 'late-appendix'], ['h2', 'References'], ['p', paragraph, 'last']]);
    assert.deepEqual(bodyIds(value), ['title', 'before', 'early-appendix'], `${tag} ${heading} ends the body permanently`);
    assert.equal(bodyIds(value, 'all').length, 6, 'The all scope keeps candidates after the reference boundary');
  }
}
const noReferences = scopeDocument([['p', `References to previous work explain the methods and ${paragraph}`, 'reference-words'], ['p', `Appendix techniques are useful here and ${paragraph}`, 'appendix-words'], ['h2', 'References to previous work'], ['p', paragraph, 'after-words'], ['h2', 'Appendix A'], ['p', paragraph, 'appendix']]);
assert.equal(scopeContext.boundary(noReferences), null, 'Reference words inside a longer heading are not a reference title');
assert.deepEqual(bodyIds(noReferences), ['reference-words', 'appendix-words', 'after-words', 'appendix']);
console.log('translation controls tests passed');
