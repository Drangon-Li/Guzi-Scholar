'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/plugins/vocabulary/vocabulary.js'), 'utf8'), context);
const { validTerm, matches, normalizeDetails, hasDetails } = context.window.MyScholarVocabulary;
const { sentenceContext, validSelectionTerm } = require('../web/core.js');
assert(validSelectionTerm('variational inference'));
assert(!validSelectionTerm('two\nlines'));
assert(validTerm('variational inference'));
assert(validTerm('字'.repeat(120)));
assert(!validTerm('字'.repeat(121)));
assert(!validTerm('two\nlines'));
assert(!validTerm(''));
const paragraph = 'Earlier work exists. We use variational inference for this task. A later result follows.';
const start = paragraph.indexOf('variational inference');
assert.equal(sentenceContext(paragraph, start, start + 'variational inference'.length), 'We use variational inference for this task.');
const entry = { term: 'Inference', meaning: '推断', note: '概率', tags: ['模型'], sources: [{ quote: 'An approximate posterior.', title: 'Paper' }], review: { status: 'new' } };
assert(matches(entry, { status: 'learning' }), 'new words must be included in unmastered filter');
assert(!matches(entry, { status: 'mastered' }));
assert(!matches(entry, { status: 'unfiled' }));
assert(matches(entry, { query: 'POSTERIOR' }));
assert(matches(entry, { query: '推断', tag: '模型' }));
assert(!matches(entry, { tag: 'other' }));
assert(matches({ ...entry, tags: [], review: { status: 'mastered' } }, { status: 'unfiled' }));

assert.equal(Object.keys(normalizeDetails()).length, 6);
assert(!hasDetails({ meanings: '  ' }));
assert(hasDetails({ examples: 'An example.' }));
assert(matches({ ...entry, details: { synonyms: 'deduction' } }, { query: 'deduction' }));

const clone = (value) => JSON.parse(JSON.stringify(value));
function harness(initialEntries) {
  const listeners = new Map();
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: id === '#vocabulary-filter' ? 'all' : '', innerHTML: '', textContent: '', hidden: false, classList: { toggle() {} }, replaceChildren() { this.innerHTML = ''; }, addEventListener() {} });
    return elements.get(id);
  };
  const root = { querySelector: element, addEventListener: (type, listener) => listeners.set(type, listener) };
  const stored = new Map(initialEntries.map((item) => [item.id, clone(item)]));
  const calls = [];
  let heldGet = null;
  let nextId = 0;
  let heldExplain = null;
  let heldDetailsPatch = null;
  let heldMeaningPatch = null;
  let confirmed = true;
  const api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const method = options.method || 'GET';
    calls.push({ url, method, body });
    if (method === 'GET') {
      const snapshot = { entries: clone([...stored.values()]) };
      if (heldGet) { const hold = heldGet; heldGet = null; return new Promise((resolve) => { hold.resolve = () => resolve(snapshot); }); }
      return snapshot;
    }
    if (method === 'POST' && url.endsWith('/explain')) {
      const result = { details: { meanings: '生成多义项', examples: 'An example. 示例。', context_explanation: '当前论文语境' }, model: 'synthetic' };
      if (heldExplain) { const hold = heldExplain; heldExplain = null; return new Promise((resolve) => { hold.resolve = () => resolve(result); }); }
      return result;
    }
    if (method === 'POST') {
      const existing = [...stored.values()].find((item) => item.term === body.term);
      if (existing) return { entry: clone(existing), created: false };
      const added = { id: `added-${++nextId}`, term: body.term, meaning: body.meaning, note: '', tags: [], sources: [body.source], review: { status: 'new' } };
      stored.set(added.id, added);
      return { entry: clone(added), created: true };
    }
    const id = url.split('/').at(-1);
    if (method === 'DELETE') { stored.delete(id); return { ok: true }; }
    const current = stored.get(id);
    assert(current, `Missing test entry ${id}`);
    for (const field of ['meaning', 'note', 'tags']) {
      if (!(field in body) || (field === 'meaning' && body.only_if_meaning_empty && current.meaning)) continue;
      current[field] = body[field];
    }
    if (body.details && !(body.only_if_details_empty && Object.values(current.details || {}).some((value) => value.trim()))) {
      current.details = { ...current.details, ...body.details };
    }
    const response = { entry: clone(current) };
    if (body.only_if_meaning_empty && heldMeaningPatch) { const hold = heldMeaningPatch; heldMeaningPatch = null; return new Promise((resolve) => { hold.resolve = () => resolve(response); }); }
    if (body.details && heldDetailsPatch) { const hold = heldDetailsPatch; heldDetailsPatch = null; return new Promise((resolve) => { hold.resolve = () => resolve(response); }); }
    return response;
  };
  const fixtureContext = { window: { confirm: () => true }, document: { querySelector: () => root } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/plugins/vocabulary/vocabulary.js'), 'utf8'), fixtureContext);
  const controller = fixtureContext.window.MyScholarVocabulary.create({ api, jsonOptions: (body, method = 'POST') => ({ method, body: JSON.stringify(body) }), escapeHTML: (value) => String(value), translate: () => { throw new Error('Unexpected additional translation'); }, openSource: async () => {}, toast: () => {}, confirm: async () => confirmed });
  return {
    controller, calls, stored, elements,
    holdGet() { heldGet = {}; return heldGet; },
    holdExplain() { heldExplain = {}; return heldExplain; },
    holdDetailsPatch() { heldDetailsPatch = {}; return heldDetailsPatch; },
    holdMeaningPatch() { heldMeaningPatch = {}; return heldMeaningPatch; },
    confirm(value) { confirmed = value; },
    click(action, id) {
      const button = { disabled: false, dataset: { vocabAction: action }, closest: () => ({ dataset: { vocabularyId: id } }) };
      return listeners.get('click')({ target: { closest: () => button } });
    },
    input(name, value) { listeners.get('input')({ target: { name, value, closest: () => ({}) } }); },
    submit() { return listeners.get('submit')({ preventDefault() {}, target: { matches: () => true } }); },
  };
}

const emptyEntry = { id: 'empty', term: 'empty term', meaning: '', note: '', tags: [], sources: [], review: { status: 'new' } };
const snapshot = (term = emptyEntry.term) => ({ term, source: { surface: 'source', job_id: 'job', quote: 'An example sentence.' } });

async function asyncChecks() {
  const ready = harness([emptyEntry]);
  await ready.controller.load();
  const filled = await ready.controller.saveSelection(snapshot(), { meaning: '已有成功译文' });
  assert.equal(filled.meaning, '已有成功译文', 'Duplicate empty entry must accept ready meaning through conditional PATCH');
  assert.deepEqual(ready.calls.find((call) => call.method === 'PATCH').body, { meaning: '已有成功译文', only_if_meaning_empty: true });

  const deleted = { ...emptyEntry, id: 'deleted', term: 'deleted term' };
  const race = harness([emptyEntry, deleted]);
  await race.controller.load();
  const pending = race.holdGet();
  const loading = race.controller.load();
  await race.controller.saveSelection(snapshot('new term'), { meaning: '新词释义' });
  await race.controller.saveSelection(snapshot(), { meaning: '后台补全释义' });
  await race.click('delete', deleted.id);
  pending.resolve();
  await loading;
  const html = race.elements.get('#vocabulary-list').innerHTML;
  assert(html.includes('new term'), 'Late GET must retain newly saved word');
  assert(html.includes('后台补全释义'), 'Late GET must retain completed meaning update');
  assert(!html.includes('deleted term'), 'Late GET must not resurrect deleted word');

  const draft = harness([emptyEntry]);
  await draft.controller.load();
  let resolveTranslation;
  const translation = new Promise((resolve) => { resolveTranslation = resolve; });
  await draft.controller.saveSelection(snapshot(), { translation });
  await draft.click('edit', emptyEntry.id);
  draft.input('tags', '数学, 优化');
  resolveTranslation('编辑期间补全');
  await new Promise((resolve) => setImmediate(resolve));
  assert(draft.elements.get('#vocabulary-list').innerHTML.includes('编辑期间补全'), 'Untouched draft meaning should reflect background fill');
  await draft.submit();
  assert.deepEqual(draft.calls.filter((call) => call.method === 'PATCH').at(-1).body, { tags: ['数学', '优化'] }, 'Editing tags must PATCH only the modified field');
  assert.equal(draft.stored.get(emptyEntry.id).meaning, '编辑期间补全', 'Saving tag draft must retain background meaning');

  const explicit = harness([emptyEntry]);
  await explicit.controller.load();
  await explicit.click('edit', emptyEntry.id);
  explicit.input('meaning', '用户释义');
  await explicit.controller.saveSelection(snapshot(), { meaning: '后台释义' });
  assert(explicit.elements.get('#vocabulary-list').innerHTML.includes('用户释义'), 'Background updates must not replace modified draft text');
  await explicit.submit();
  assert.equal(explicit.stored.get(emptyEntry.id).meaning, '用户释义');
  const detailed = harness([emptyEntry]);
  await detailed.controller.load();
  await detailed.click('explain', emptyEntry.id);
  assert.equal(detailed.stored.get(emptyEntry.id).details.meanings, '生成多义项');
  assert.equal(detailed.calls.filter((call) => call.url.endsWith('/explain')).length, 1);
  assert.equal(detailed.calls.find((call) => call.body?.details).body.only_if_details_empty, true);
  assert.equal(detailed.stored.get(emptyEntry.id).meaning, '', 'Detailed explanation must not change short meaning');
  await detailed.click('edit', emptyEntry.id);
  detailed.input('details.synonyms', '手动同义词');
  await detailed.submit();
  assert.deepEqual(detailed.calls.at(-1).body, { details: { synonyms: '手动同义词' } }, 'Detailed editor only saves dirty nested fields');
  assert.equal(detailed.stored.get(emptyEntry.id).details.examples, 'An example. 示例。');

  const meaningRace = harness([emptyEntry]);
  await meaningRace.controller.load();
  const heldMeaning = meaningRace.holdMeaningPatch();
  const meaningFill = meaningRace.controller.saveSelection(snapshot(), { meaning: '延迟返回的简短释义' });
  await new Promise((resolve) => setImmediate(resolve));
  await meaningRace.click('explain', emptyEntry.id);
  heldMeaning.resolve(); await meaningFill;
  const meaningHTML = meaningRace.elements.get('#vocabulary-list').innerHTML;
  assert(meaningHTML.includes('生成多义项') && meaningHTML.includes('延迟返回的简短释义'), 'Late meaning response must preserve newer detailed explanation');

  const pendingEdit = harness([emptyEntry]);
  await pendingEdit.controller.load();
  const heldExplain = pendingEdit.holdExplain();
  const explaining = pendingEdit.click('explain', emptyEntry.id);
  await pendingEdit.click('edit', emptyEntry.id);
  pendingEdit.input('details.meanings', '未保存的手写多义项');
  heldExplain.resolve(); await explaining;
  assert(pendingEdit.elements.get('#vocabulary-list').innerHTML.includes('未保存的手写多义项'));
  assert.equal(pendingEdit.calls.filter((call) => call.method === 'PATCH').length, 0, 'Generation must not fill over an active detailed draft');

  const detailDraft = harness([emptyEntry]);
  await detailDraft.controller.load();
  const heldDraftExplain = detailDraft.holdExplain();
  const draftExplaining = detailDraft.click('explain', emptyEntry.id);
  await detailDraft.click('edit', emptyEntry.id);
  detailDraft.input('tags', '保留标签草稿');
  heldDraftExplain.resolve(); await draftExplaining;
  assert(detailDraft.elements.get('#vocabulary-list').innerHTML.includes('生成多义项'), 'Untouched detailed draft fields receive generated details');
  await detailDraft.submit();
  assert.deepEqual(detailDraft.calls.at(-1).body, { tags: ['保留标签草稿'] }, 'Saving an unrelated draft must retain generated details');
  assert.equal(detailDraft.stored.get(emptyEntry.id).details.meanings, '生成多义项');

  const deletedDetails = harness([emptyEntry]);
  await deletedDetails.controller.load();
  const heldDeletedExplain = deletedDetails.holdExplain();
  const deletedExplaining = deletedDetails.click('explain', emptyEntry.id);
  deletedDetails.confirm(false); await deletedDetails.click('delete', emptyEntry.id);
  assert(deletedDetails.stored.has(emptyEntry.id), 'Cancelled confirmation retains the entry');
  deletedDetails.confirm(true); await deletedDetails.click('delete', emptyEntry.id);
  heldDeletedExplain.resolve(); await deletedExplaining;
  assert.equal(deletedDetails.calls.filter((call) => call.method === 'PATCH').length, 0, 'Late generation must not recreate a deleted entry');
  assert(!deletedDetails.elements.get('#vocabulary-list').innerHTML.includes(emptyEntry.term));

  const latePatch = harness([emptyEntry]);
  await latePatch.controller.load();
  const heldPatch = latePatch.holdDetailsPatch();
  const filling = latePatch.click('explain', emptyEntry.id);
  await new Promise((resolve) => setImmediate(resolve));
  await latePatch.click('edit', emptyEntry.id);
  latePatch.input('details.meanings', '生成保存期间的手动修改');
  await latePatch.submit();
  heldPatch.resolve(); await filling;
  assert(latePatch.elements.get('#vocabulary-list').innerHTML.includes('生成保存期间的手动修改'), 'Old conditional PATCH response must not replace later saved detail edits');
  console.log('Vocabulary unit checks passed, including details, conditional generation, deletion, dirty fields and delayed response races');
}

asyncChecks().catch((error) => { console.error(error); process.exitCode = 1; });
