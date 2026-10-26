const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function section(start, end) {
  return app.slice(app.indexOf(`  ${start}`), app.indexOf(`\n  ${end}`, app.indexOf(`  ${start}`)));
}
const token = '__MY_SCHOLAR_MATH_0__';
const sentence = `We compute ${token}.`;
const math = (tex) => [{ token, tex, markup: `<math><mi>${tex}</mi></math>` }];
const requests = [];
let cache = [];
let profileId = 'profile';
let targetLanguage = 'zh';
let requestGate = null;
let requestFailure = false;
const context = vm.createContext({
  AbortController, DOMException,
  state: { activeJob: { job_id: 'fixture' }, translationCache: [], annotations: [] },
  readerMount: {},
  readerMountMatches: () => true,
  readerHoverTranslationEnabled: () => true,
  translationProfileId: () => profileId,
  translationTargetLanguage: () => targetLanguage,
  rememberDisplayedTranslation: () => {},
  translationCacheFor: () => cache,
  setTranslationCacheFor: (_job, records) => { cache = records; },
  jsonOptions: (body) => ({ body }),
  api: async (_url, { body }) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    const requestedProfile = profileId;
    await (requestGate || Promise.resolve());
    if (requestFailure) throw new Error('fixture translation unavailable');
    return { result: { text: body.text, profile_id: requestedProfile, ...(body.segments ? { alignment_version: 'sentence-v1', source_segments: body.segments, segments: body.segments } : {}) } };
  },
});
vm.runInContext([
  section('function hashText(', 'function paragraphSource('),
  section('function protectInlineMath(', 'function translationTargetLanguage('),
  section('function cachedTranslation(', 'async function streamApiRequest('),
  section('async function requestTranslation(', 'function insertTranslation('),
  section('function setReaderSentenceHover(', 'function installReaderSentenceHover('),
  section('function renderCachedTranslations(', 'async function loadTranslationCache('),
  section('function previewCaptionTranslation(', 'function attachQuickPreviewZoom('),
  section('function hasUsableTranslation(', 'const FULL_TRANSLATION_CONCURRENCY'),
  'this.request = requestTranslation; this.hash = hashText;',
  'this.identity = typeof translationSourceIdentity === "function" ? translationSourceIdentity : null;',
  'this.matches = typeof translationSourceMatches === "function" ? translationSourceMatches : null;',
  'this.hover = setReaderSentenceHover; this.replay = renderCachedTranslations; this.preview = previewCaptionTranslation; this.usable = hasUsableTranslation;',
].join('\n'), context);

const archived = { block_id: 'archived-block', source_hash: 'archived-source', target_language: '中文', profile_id: 'archived-profile', text: '已有译文', updated_at: '2026-10-25T00:00:00Z' };
const current = { ...archived, profile_id: 'current-profile', text: '当前译文', updated_at: '2026-10-26T00:00:00Z' };
const french = { ...archived, target_language: 'fr', text: 'Traduction' };
const displayWrites = [];
const profileContext = vm.createContext({
  state: { activeJob: { job_id: 'fixture' }, health: { ai: { services: { translation: { target_language: 'zh' } } } } },
  translationDisplayChoices: {}, translationDisplayStorageKey: 'display-choices',
  persistentStateSet: (...values) => displayWrites.push(values),
  translationCacheFor: () => [archived, current, french],
});
vm.runInContext([
  section('function healthAIService(', 'function translationCacheFor('),
  section('function translationTargetLanguage(', 'async function streamApiRequest('),
  'this.filter = translationsForActiveProfile; this.cached = cachedTranslation; this.remember = rememberDisplayedTranslation;',
].join('\n'), profileContext);
const filteredProfiles = () => Array.from(profileContext.filter([archived, current, french]), (record) => record.profile_id);
assert.deepEqual(filteredProfiles(), ['current-profile', 'archived-profile'], 'Saved translations remain visible without an active profile, newest first.');
assert.equal(profileContext.cached('archived-block', 'archived-source', 'zh', 'fixture'), null);
profileContext.state.health.readonly = true;
assert.deepEqual(filteredProfiles(), ['current-profile', 'archived-profile'], 'Read-only replay retains all profiles for the target language.');
assert.strictEqual(profileContext.cached('archived-block', 'archived-source', 'zh', 'fixture'), archived);
assert.equal(profileContext.cached('other-block', 'archived-source', 'zh', 'fixture'), undefined, 'Read-only cache lookup still requires the source block.');
assert.equal(profileContext.cached('archived-block', 'other-source', 'zh', 'fixture'), undefined, 'Read-only cache lookup still requires the source hash.');
assert.equal(profileContext.cached('archived-block', 'archived-source', 'de', 'fixture'), undefined, 'Read-only cache lookup still requires the target language.');
profileContext.state.health.ai.services.translation.profile_id = 'current-profile';
assert.strictEqual(profileContext.cached('archived-block', 'archived-source', 'zh', 'fixture'), archived, 'An active profile does not hide archived showcase translations.');
for (const readonly of [false, undefined, 'true']) {
  profileContext.state.health.readonly = readonly;
  assert.deepEqual(filteredProfiles(), ['current-profile', 'archived-profile'], 'Changing profiles preserves existing displayed translations.');
  assert.strictEqual(profileContext.cached('archived-block', 'archived-source', 'zh', 'fixture'), current);
}
profileContext.remember('fixture', archived);
assert.deepEqual(filteredProfiles(), ['archived-profile', 'current-profile'], 'A chosen archived translation outranks a newer record.');
assert.equal(JSON.parse(displayWrites.at(-1)[1]).fixture['archived-block'], 'archived-profile:archived-source:');
profileContext.state.activeJob.job_id = 'another-paper';
assert.deepEqual(filteredProfiles(), ['current-profile', 'archived-profile'], 'Display choices belong to their document.');
profileContext.state.health.ai.services.translation.target_language = 'fr';
assert.deepEqual(filteredProfiles(), ['archived-profile'], 'Retaining old profiles must not mix target languages.');
assert.deepEqual(Array.from(profileContext.filter([french]), (record) => record.text), ['Traduction']);

(async () => {
  await context.request(sentence, null, math('x'));
  const y = await context.request(sentence, null, math('y'));
  assert.equal(requests.length, 2, 'Different MathML must not reuse a placeholder-only cache entry.');
  assert.equal(y.formulas[0].tex, 'y');
  assert.notEqual(requests[0].source_hash, requests[1].source_hash);
  await context.request(sentence, null, math('x'));
  assert.equal(requests.length, 2, 'Identical formula requests reuse the cache.');
  assert.ok(context.identity, 'Hover requests share the structured source identity.');
  const variants = [
    { text: sentence, formulas: math('x') },
    { text: sentence, formulas: math('y') },
    { text: sentence, formulas: [{ token, tex: 'x', markup: '<sup>x</sup>' }] },
    { text: sentence, formulas: [{ token, tex: 'x', markup: '<sub>x</sub>' }] },
    { text: sentence, formulas: [{ token, tex: '[公式原图]', markup: '<span class="math-source-visual"><img src="x.png"></span>' }] },
    { text: sentence, formulas: [{ token, tex: '[公式原图]', markup: '<span class="math-source-visual"><img src="y.png"></span>' }] },
    { text: '__MY_SCHOLAR_MARKER_0__ curve.', markers: [{ token: '__MY_SCHOLAR_MARKER_0__', shape: 'circle', tone: 'blue' }] },
    { text: '__MY_SCHOLAR_MARKER_0__ curve.', markers: [{ token: '__MY_SCHOLAR_MARKER_0__', shape: 'circle', tone: 'red' }] },
    { text: '__MY_SCHOLAR_BOLD_START_0__blue__MY_SCHOLAR_BOLD_END_0__', emphasis: [{ index: 0, style: 'color', tone: 'blue' }] },
    { text: '__MY_SCHOLAR_BOLD_START_0__blue__MY_SCHOLAR_BOLD_END_0__', emphasis: [{ index: 0, style: 'color', tone: 'red' }] },
  ];
  assert.equal(new Set(variants.map((source) => context.identity(source))).size, variants.length);
  for (const source of variants) {
    await context.request(source.text, 'structured', source.formulas || [], source);
  }
  const persisted = JSON.parse(JSON.stringify(cache)).map((record) => ({ ...record, formulas: record.formulas.map(({ token, tex }) => ({ token, tex })) }));
  cache = persisted;
  const beforeReload = requests.length;
  for (const source of variants) {
    const result = await context.request(source.text, 'structured', source.formulas || [], source);
    assert.equal(result.cached, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.formulas)), source.formulas || [], 'Reload uses current source markup.');
  }
  assert.equal(requests.length, beforeReload, 'Persisted structured cache survives a reload without translation.');

  const inserted = [];
  let block;
  const doc = { querySelector: () => null };
  Object.assign(context, {
    frameDocument: () => doc,
    translationsForActiveProfile: (records) => records,
    cssEscape: (value) => value,
    translationTarget: () => block,
    translatableParagraph: () => true,
    paragraphSource: (node) => ({ formulas: [], markers: [], emphasis: [], ...node.source }),
    insertTranslation: (_id, text, options) => { inserted.push({ text, ...options }); return {}; },
    rebuildReaderSentencePairs: () => {}, refreshReaderSearch: () => {}, applyTranslationVisibility: () => {},
    document: { createElement: () => ({ children: [], append(...children) { this.children.push(...children); } }) },
    renderTranslationText: (text, formulas, _doc, markers, emphasis) => ({ text, formulas, markers, emphasis }),
  });
  context.state.translationCache = persisted;
  for (const source of variants) {
    block = { dataset: { blockId: 'structured' }, source, matches: () => false, ownerDocument: doc };
    inserted.length = 0;
    context.replay();
    assert.equal(inserted.length, 1, 'Reload replays only the record for the current structured source.');
    assert.deepEqual(JSON.parse(JSON.stringify(inserted[0].formulas)), source.formulas || []);
    assert.equal(context.usable(block), true);
    const preview = context.preview(block);
    assert.ok(preview);
    assert.deepEqual(JSON.parse(JSON.stringify(preview.children[0].formulas)), source.formulas || []);
  }
  block = { dataset: { blockId: 'structured' }, source: { text: sentence, formulas: math('unknown') }, matches: () => false };
  inserted.length = 0;
  context.replay();
  assert.equal(inserted.length, 0);
  assert.equal(context.usable(block), false);
  const staleRendered = { closest: () => ({ dataset: { sourceHash: 'obsolete' } }) };
  block = { dataset: { blockId: 'structured' }, source: variants[1], ownerDocument: { querySelector: () => staleRendered } };
  assert.deepEqual(JSON.parse(JSON.stringify(context.preview(block).children[0].formulas)), math('y'), 'Caption preview rejects stale rendered markup.');
  context.frameDocument = () => ({ querySelector: () => ({ dataset: { sourceHash: 'obsolete' }, classList: { contains: () => false } }) });
  assert.equal(context.usable(block), false, 'An outdated rendered translation must be replaced even when the matching cache exists.');
  context.frameDocument = () => doc;

  const timers = [];
  const tooltips = [];
  const hoverDoc = { querySelector: () => null, querySelectorAll: () => [], getSelection: () => ({ toString: () => '' }), createElement: () => ({ append(source) { this.source = source; }, querySelectorAll: () => [] }) };
  Object.assign(context, {
    readerSentenceState: { doc: hoverDoc, pendingTranslations: new Map() },
    window: { clearTimeout: () => {}, setTimeout: (callback) => { timers.push(callback); return timers.length; } },
    clearReaderSentenceHover: () => {}, aiServiceEnabled: () => true,
    paintReaderSentenceTooltip: (pair, text, options) => { if (text) tooltips.push({ pairId: pair.id, ...options }); },
  });
  cache = [];
  const beforeConcurrent = requests.length;
  const pending = [];
  for (const [index, source] of variants.entries()) {
    context.hover({ id: String(index), sourceRange: { cloneContents: () => source } });
    pending.push(timers.pop()());
  }
  context.hover({ id: 'same-formula-again', sourceRange: { cloneContents: () => variants[0] } });
  pending.push(timers.pop()());
  await Promise.all(pending);
  assert.equal(requests.length - beforeConcurrent, variants.length, 'Concurrent hover requests with different formulas or styles do not share a pending promise.');
  assert.equal(context.readerSentenceState.pendingTranslations.size, variants.length);
  assert.deepEqual(JSON.parse(JSON.stringify(tooltips.find(({ pairId }) => pairId === '1').formulas)), math('y'));

  const legacy = { block_id: '', source_hash: context.hash(sentence), target_language: 'zh', profile_id: 'profile', text: sentence, formulas: [{ token, tex: 'x' }] };
  cache = [legacy];
  const old = await context.request(sentence, null, math('x'));
  assert.equal(old.cached, true, 'Verified legacy TeX remains usable.');
  assert.equal(old.formulas[0].markup, math('x')[0].markup);
  cache = [{ ...legacy, formulas: [{ token, tex: 'x', markup: '<math>stale layout</math>' }] }];
  assert.equal((await context.request(sentence, null, math('x'))).formulas[0].markup, math('x')[0].markup, 'Verified legacy prose uses live markup instead of stale markup.');
  const mismatch = await context.request(sentence, null, math('z'));
  assert.equal(mismatch.cached, false, 'A legacy placeholder hash cannot validate different TeX.');
  cache = [{ ...legacy, formulas: [] }];
  assert.equal((await context.request(sentence, null, math('x'))).cached, false, 'Missing legacy formula metadata is unsafe.');
  cache = [{ ...legacy, formulas: [{ token, tex: '[公式原图]' }] }];
  assert.equal((await context.request(sentence, null, variants[4].formulas)).cached, false, 'A generic legacy image placeholder cannot validate the original image.');
  const plain = 'Ordinary words.';
  await context.request(plain, 'plain', []);
  assert.equal(requests.at(-1).source_hash, context.hash(plain), 'Plain text keeps its existing cache identity.');
  assert.equal(context.matches({ source_hash: 'old-source-hash', source_text: plain }, { text: plain }, true), true, 'Plain text keeps the legacy source_text replay fallback.');
  assert.match(section('function setReaderSentenceHover(', 'function installReaderSentenceHover('), /translationSourceIdentity\(source\)/, 'Hover pending requests use the complete structured identity.');
  const consumers = app.replace(section('function hashText(', 'function paragraphSource('), '');
  assert.doesNotMatch(consumers, /cachedTranslation\(\w+, hashText\(source\.text\)/, 'Cache consumers must use the same source identity.');

  cache = [];
  const alignedText = 'First sentence. Second sentence.';
  const boundary = alignedText.indexOf(' Second');
  const segments = [
    { id: `s0-${boundary}`, text: alignedText.slice(0, boundary) },
    { id: `s${boundary + 1}-${alignedText.length}`, text: alignedText.slice(boundary + 1) },
  ];
  await context.request(alignedText, 'aligned', []);
  const beforeAlignment = requests.length;
  const aligned = await context.request(alignedText, 'aligned', [], { segments });
  assert.equal(requests.length, beforeAlignment + 1, 'A legacy paragraph translation cannot satisfy an aligned request.');
  assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1).segments)), segments);
  assert.equal(requests.at(-1).alignment_version, 'sentence-v1');
  assert.equal(aligned.segments.length, 2);
  assert.equal((await context.request(alignedText, 'aligned', [], { segments })).cached, true);
  assert.equal(requests.length, beforeAlignment + 1, 'Matching sentence boundaries reuse the aligned cache.');
  await context.request(alignedText, 'aligned', [], { segments: [{ id: `s0-${alignedText.length}`, text: alignedText }] });
  assert.equal(requests.length, beforeAlignment + 2, 'Changed sentence boundaries require a newly aligned answer.');

  const isolatedText = 'A model-specific translation.';
  await context.request(isolatedText, 'isolation', []);
  const beforeProfile = requests.length;
  profileId = 'second-profile';
  assert.equal((await context.request(isolatedText, 'isolation', [])).cached, false);
  assert.equal(requests.length, beforeProfile + 1, 'A retained old model answer must not satisfy another model request.');
  profileId = 'profile';
  assert.equal((await context.request(isolatedText, 'isolation', [])).cached, true);
  targetLanguage = 'fr';
  assert.equal((await context.request(isolatedText, 'isolation', [])).cached, false);
  assert.equal(requests.at(-1).target_language, 'fr');
  targetLanguage = 'zh';
  assert.equal((await context.request(isolatedText, 'isolation', [])).cached, true);
  assert.equal(requests.length, beforeProfile + 2, 'Returning to the previous profile and language reuses its own answer.');

  let release;
  requestGate = new Promise((resolve) => { release = resolve; });
  const firstConsumer = new AbortController();
  const beforeShared = requests.length;
  const cancelled = context.request('Shared pending sentence.', 'singleflight', [], { signal: firstConsumer.signal });
  const cancellation = assert.rejects(cancelled, { name: 'AbortError' });
  const survivor = context.request('Shared pending sentence.', 'singleflight', []);
  assert.equal(requests.length, beforeShared + 1, 'Identical pending requests share one API operation.');
  firstConsumer.abort();
  await cancellation;
  release();
  assert.equal((await survivor).text, 'Shared pending sentence.', 'Cancelling one consumer must not cancel another consumer.');
  requestGate = null;
  assert.equal((await context.request('Shared pending sentence.', 'singleflight', [])).cached, true);
  assert.equal(requests.length, beforeShared + 1);

  requestFailure = true;
  await assert.rejects(context.request('Retry a failed operation.', 'retry', []), /fixture translation unavailable/u);
  const beforeRetry = requests.length;
  requestFailure = false;
  assert.equal((await context.request('Retry a failed operation.', 'retry', [])).text, 'Retry a failed operation.');
  assert.equal(requests.length, beforeRetry + 1, 'A rejected pending operation must not poison retries.');
  console.log(JSON.stringify({ translationCacheIdentity: true, formulaVariants: 6, markerAndStyleVariants: 4, persistedReload: true, verifiedLegacyReuse: true, plainTextCompatibility: true, readonlyArchivedReplay: true, desktopProfileIsolation: true, retainedDisplayChoices: true, alignedCacheBoundaries: true, singleflight: true, independentCancellation: true, failedRequestRetry: true }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
