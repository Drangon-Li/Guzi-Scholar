'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const coreSource = fs.readFileSync(path.join(__dirname, '../web/core.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function section(from, to) {
  const start = source.indexOf(`  ${from}`);
  const end = source.indexOf(`  ${to}`, start);
  assert(start >= 0 && end > start, `Missing renderer section: ${from}`);
  return source.slice(start, end);
}

async function harness() {
  const disk = new Map();
  const requests = [];
  const listeners = new Map();
  const timers = new Map();
  const nodes = new Map();
  const controls = { failNotes: new Set(), conflictNotes: new Set(), failSettings: false, failDisk: false, rejectNotes: false, blockNotes: null };
  let timerId = 0;
  let diskWrites = 0;
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, { dataset: {}, textContent: '', value: '', contentEditable: 'true', classList: { add() {}, remove() {} } });
    return nodes.get(selector);
  };
  const document = {
    body: { inert: false },
    querySelector: node, querySelectorAll: () => [],
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  const context = vm.createContext({
    module: { exports: {} }, document, TextEncoder, TextDecoder, Date,
    aiStreamMaxBytes: 1000000, aiStreamMaxBufferChars: 200000,
    localStorage: { getItem: () => null, removeItem() {} },
    myScholarDesktop: { state: {
      loadAll: async () => ({}),
      async set(key, value) { diskWrites += 1; if (controls.failDisk) throw new Error('disk full'); disk.set(key, value); },
      async remove(key) { diskWrites += 1; if (controls.failDisk) throw new Error('disk full'); disk.delete(key); },
    } },
    state: { annotationActions: { custom: [] }, appearance: {}, shortcuts: {}, chatSessions: new Map() },
    $: node, $$: () => [],
    window: {
      setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/stream') return controls.streamResponse;
      if (url.endsWith('/translate') && controls.translationResponse) return controls.translationResponse;
      if (url === '/api/background' && controls.backgroundResponse) return controls.backgroundResponse;
      const noteId = url.match(/^\/api\/jobs\/([^/]+)\/notes$/u)?.[1];
      if (noteId && options.method === 'PUT' && controls.blockNotes) await controls.blockNotes;
      if (url === '/api/settings' && controls.blockSettings) await controls.blockSettings;
      if (noteId && controls.rejectNotes) throw new Error('connection lost');
      const status = noteId && options.method === 'PUT' && controls.conflictNotes.has(noteId) ? 409
        : noteId && options.method === 'PUT' && controls.failNotes.has(noteId) ? 503
          : url === '/api/settings' && controls.failSettings ? 503 : 200;
      const payload = status !== 200 ? { error: 'synthetic failure' }
        : noteId ? { revision: `saved-${noteId}`, markdown: 'external' }
          : url === '/api/settings' ? { settings: JSON.parse(options.body) } : {};
      return { ok: status === 200, status, json: async () => payload };
    },
    validateShortcutInputs: () => ({ valid: true, shortcuts: {} }),
    validateAISettingsControls: () => true,
    settingsPayload: () => ({ appearance: {}, shortcuts: {}, ai: {}, annotation_actions: { custom: [] }, metadata: { contact_email: controls.settingsValue || '' } }),
    applyAnnotationActionSync() {}, normalizeAppearance: (value) => value,
    normalizeAnnotationActions: (value) => value,
    syncReaderShortcutHints() {}, renderAISettings() {}, renderSelectionActions() {}, applyAppearance() {},
    cancelImportMetadataFollowup() {}, checkHealth: async () => {}, showToast(message) { controls.lastError = message; },
    setArticleNotesStatus() {}, renderArticleNoteConflict() {},
    captureCurrentReadingLocation() { context.module.exports.persistentStateSet('reading', 'last-location'); },
    frameDocument: () => controls.readerDocument || null,
    translationProfileId: () => 'profile', translationTargetLanguage: () => 'zh',
    translationSourceHash: () => 'hash', translationSourceIdentity: (source) => source.text,
    protectSpecialTokens: (text) => ({ text, tokens: [] }), SPECIAL_MATH_TOKEN_RE: /__MATH__/gu,
    cachedTranslationForSource: () => null, translationCacheFor: () => [], setTranslationCacheFor() {},
    repairFormulaTokens: (text) => text, restoreInlineMath: (text) => text,
    restoreInlineMarkers: (text) => text, restoreSpecialTokens: (text) => text,
    serializableChatEnvelope: (value) => value,
    chatStorageKey: (id) => `chat:${id}`, chatTextEncoder: new TextEncoder(), chatPersistMaxBytes: 100000,
  });
  context.window.myScholarDesktop = context.myScholarDesktop;
  document.defaultView = context.window;
  context.window.addEventListener = document.addEventListener;
  context.window.removeEventListener = document.removeEventListener;
  vm.runInContext(coreSource, context);
  await context.module.exports.ready;
  Object.assign(context, context.module.exports);
  vm.runInContext([
    'const browserDemo = null; let demoResetting = false;',
    'let notesTimer = null, pendingNotesSnapshot = null, notesSaveQueue = Promise.resolve();',
    'const articleNoteDraftStorageKey = "drafts", articleNoteDrafts = new Map(), articleNoteServerRevisions = new Map(), articleNoteConflicts = new Map(), chatPersistTimers = new Map();',
    section('const request =', 'const appearanceDefaults ='),
    section('const annotationStyleSyncs =', 'const jsonOptions ='),
    'const jsonOptions = (body, method = "POST") => ({ method, body: JSON.stringify(body) });',
    section('async function streamApiRequest(', 'async function requestTranslation('),
    section('async function requestTranslation(', 'function preserveReaderHoverThroughTranslationLayout('),
    section('function persistArticleNoteDrafts(', 'function isArticleNoteSession('),
    section('function queueArticleNotesSave(', 'function renderArticleNoteConflict('),
    section('async function flushPendingArticleNotes(', 'function saveNotes('),
    section('function persistChatSession(', 'function setChatHistoryOpen('),
    section('let settingsSaveTimer =', "$('#settings-form').addEventListener('submit'"),
    section('function freezeForClose(', "$('#setting-app-font')?.addEventListener"),
    'this.gateTest = { request, streamApiRequest, requestTranslation, queueArticleNotesSave, flushPendingArticleNotes, queueSettingsSave, settingsDirty: () => settingsSaveRevision - settingsSavedRevision, drafts: articleNoteDrafts, conflicts: articleNoteConflicts, setPending: (draft) => { pendingNotesSnapshot = draft; retainArticleNoteDraft(draft); }, dirtySettings: () => { settingsSaveRevision += 1; }, pending: () => pendingNotesSnapshot };',
  ].join('\n'), context);
  function edit(draft) {
    const event = { prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
    for (const callback of listeners.get('beforeinput') || []) callback(event);
    if (!event.prevented) context.gateTest.setPending(draft);
    return !event.prevented;
  }
  return { context, disk, requests, controls, timers, document, edit, api: context.gateTest, writes: () => diskWrites,
    close: (options) => context.window.__myScholarFlushBeforeClose(options), resume: () => context.window.__myScholarResumeAfterClose() };
}

const draft = (jobId, markdown = jobId) => ({ jobId, markdown, revision: 1, baseRevision: `base-${jobId}` });

(async () => {
  {
    const h = await harness();
    h.controls.failNotes.add('A');
    await h.api.queueArticleNotesSave(draft('A'));
    h.api.setPending(draft('B'));
    assert.equal(await h.close(), false, 'A failed draft must block exit even when the last queued B save succeeds');
    assert(h.api.drafts.has('A'));
    assert(!h.api.drafts.has('B'));
    assert.match(h.disk.get('drafts'), /"A"/u, 'Failed drafts must reach durable recovery storage');
    h.controls.failNotes.clear();
    assert.equal(await h.close({ intent: 'quit' }), true, 'Retry saves every remaining document');
    assert.equal(h.api.drafts.size, 0);
  }
  {
    const h = await harness();
    h.api.dirtySettings(); h.controls.failSettings = true;
    assert.equal(await h.close(), false, 'A settings false result blocks exit');
    assert.equal(h.api.settingsDirty(), 1);
    h.controls.failSettings = false;
    assert.equal(await h.close(), true, String(h.controls.lastError || 'settings retry failed'));
    assert.equal(h.api.settingsDirty(), 0);
  }
  {
    const h = await harness();
    h.api.setPending(draft('conflict')); h.controls.conflictNotes.add('conflict');
    assert.equal(await h.close(), false);
    assert(h.api.conflicts.has('conflict'), '409 must remain unresolved');
    const attempts = h.requests.length;
    assert.equal(await h.close(), false);
    assert.equal(h.requests.length, attempts, 'Conflicted drafts must never be blindly overwritten');
    h.resume();
    assert.equal(h.document.body.inert, false);
  }
  {
    const h = await harness();
    let release;
    h.controls.blockNotes = new Promise((resolve) => { release = resolve; });
    h.edit(draft('A', 'before freeze'));
    h.context.state.chatSessions.set('A', { sessions: [{ messages: [{ role: 'user', content: 'saved chat' }] }] });
    const closing = h.close({ intent: 'install-update' });
    await tick();
    assert.equal(h.document.body.inert, true);
    for (let i = 0; i < 20; i += 1) assert.equal(h.edit(draft('A', 'late edit')), false);
    const background = h.api.request('/api/background', { method: 'POST' });
    assert(!h.requests.some(({ url }) => url === '/api/background'));
    release(); assert.equal(await closing, true);
    assert.equal(h.disk.get('reading'), 'last-location');
    assert.match(h.disk.get('chat:A'), /saved chat/u);
    const written = h.writes();
    h.context.persistentStateSet('late-background', 'deferred');
    await tick();
    assert.equal(h.writes(), written, 'Background state cannot write to disk after the successful gate');
    h.resume(); await background; await tick();
    assert.equal(h.disk.get('late-background'), 'deferred', 'Cancel resumes deferred writes');
    assert.equal(h.edit(draft('A', 'after cancel')), true);
    assert.equal(h.document.body.inert, false);
  }
  {
    const h = await harness();
    h.api.setPending(draft('A', 'recoverable')); h.api.dirtySettings();
    assert.equal(await h.close({ discard: true }), true);
    assert.equal(h.requests.length, 0, 'Explicit discard skips server saves');
    assert.match(h.disk.get('drafts'), /recoverable/u, 'Discard must preserve recovery until the transition actually succeeds');
    assert.equal(h.api.settingsDirty(), 1);
    h.resume();
    assert.equal(h.api.pending().markdown, 'recoverable');
    assert.equal(await h.close(), true, 'Cancelled discard can be retried as a normal save');
    assert.equal(h.api.settingsDirty(), 0);
  }
  {
    const h = await harness();
    let release;
    h.controls.blockNotes = new Promise((resolve) => { release = resolve; });
    h.edit(draft('A', 'first revision'));
    const timedOut = h.close();
    await tick();
    h.resume();
    assert.equal(h.edit({ ...draft('A', 'new revision after timeout'), revision: 2 }), true);
    const retry = h.close({ intent: 'quit' });
    await tick();
    release();
    assert.equal(await timedOut, false, 'The cancelled old transaction cannot report success');
    assert.equal(await retry, true);
    const saves = h.requests.filter(({ url, options }) => url.endsWith('/notes') && options.method === 'PUT');
    assert.deepEqual(saves.map(({ options }) => JSON.parse(options.body).markdown), ['first revision', 'new revision after timeout']);
    assert.equal(h.api.drafts.size, 0);
    assert.equal(h.document.body.inert, true, 'Late completion of the old gate cannot unfreeze the new one');
    h.resume();
  }
  {
    const h = await harness();
    let release;
    h.controls.blockSettings = new Promise((resolve) => { release = resolve; });
    h.controls.settingsValue = 'first@example.test'; h.api.dirtySettings();
    const timedOut = h.close();
    await tick();
    h.resume();
    h.controls.settingsValue = 'new@example.test'; h.api.dirtySettings();
    const retry = h.close();
    await tick(); release();
    assert.equal(await timedOut, false);
    assert.equal(await retry, true);
    assert.equal(h.api.settingsDirty(), 0);
    const saves = h.requests.filter(({ url }) => url === '/api/settings');
    assert.deepEqual(saves.map(({ options }) => JSON.parse(options.body).metadata.contact_email), ['first@example.test', 'new@example.test']);
  }
  {
    const h = await harness();
    const readerListeners = new Map();
    const readerDoc = { body: { inert: false }, defaultView: {
      addEventListener(type, callback) { readerListeners.set(type, callback); },
      removeEventListener(type) { readerListeners.delete(type); },
    } };
    h.controls.readerDocument = readerDoc;
    assert.equal(await h.close(), true);
    assert.equal(readerDoc.body.inert, true, 'Reader iframe editing is frozen alongside the shell');
    let blocked = false;
    readerListeners.get('beforeinput')({ preventDefault() { blocked = true; }, stopImmediatePropagation() {} });
    assert.equal(blocked, true);
    h.resume();
    assert.equal(readerDoc.body.inert, false);
    assert.equal(readerListeners.size, 0);
  }
  {
    const h = await harness();
    let finish;
    h.controls.backgroundResponse = new Promise((resolve) => { finish = resolve; });
    const writing = h.api.request('/api/background', { method: 'POST' });
    const closing = h.close();
    let completed = false;
    closing.then(() => { completed = true; });
    await tick();
    assert.equal(completed, false, 'Existing background mutations must be acknowledged before exit');
    finish({ ok: false, status: 503 });
    assert.equal(await closing, false, 'An in-flight background write failure blocks exit');
    h.resume();
    assert.equal((await writing).status, 503);
  }
  {
    const h = await harness();
    h.api.setPending({ jobId: 'legacy', markdown: 'old recovery', revision: 1 });
    assert.equal(await h.close(), false, 'A recovery draft without a known server revision cannot overwrite notes');
    assert.equal(h.requests.length, 0);
    assert.match(h.disk.get('drafts'), /old recovery/u);
  }
  for (const streaming of [false, true]) {
    const h = await harness();
    let finish;
    h.controls.translationResponse = new Promise((resolve) => { finish = resolve; });
    let translated = false;
    const translation = h.api.requestTranslation('Source text.', 'block', [], {
      jobId: 'A', ...(streaming ? { onDelta() {} } : {}),
    }).then((result) => { translated = true; return result; });
    await tick();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.closeBarrier, undefined, 'The renderer-only barrier option must not reach fetch');
    let timeout;
    try {
      const saved = await Promise.race([
        h.close(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Inference blocked exit')), 1000); }),
      ]);
      assert.equal(saved, true, `${streaming ? 'Streaming' : 'Non-streaming'} translation must not delay exit while waiting for response headers`);
    } finally { clearTimeout(timeout); }
    finish({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ result: { text: 'Translated text.' } }) });
    await tick();
    assert.equal(translated, false, 'Late inference responses must remain paused while the window is frozen');
    h.resume();
    assert.equal((await translation).text, 'Translated text.');
  }
  {
    const h = await harness();
    let releaseChunk;
    const chunk = new Promise((resolve) => { releaseChunk = resolve; });
    let reads = 0;
    let released = false;
    h.controls.streamResponse = {
      ok: true, headers: { get: () => 'text/event-stream' },
      body: { getReader: () => ({ read: () => reads++ === 0 ? chunk : Promise.resolve({ done: true }), releaseLock() { released = true; }, cancel: async () => {} }) },
    };
    const deltas = [];
    const streaming = h.api.streamApiRequest('/api/stream', {}, (delta) => deltas.push(delta));
    await tick();
    assert.equal(await h.close(), true);
    releaseChunk({ value: new TextEncoder().encode('data: {"delta":"late response"}\n\ndata: {"result":{"text":"finished"}}\n\n'), done: false });
    await tick();
    assert.equal(deltas.length, 0, 'An active chat stream pauses before applying later deltas');
    h.resume();
    assert.equal((await streaming).text, 'finished');
    assert.deepEqual(deltas, ['late response']);
    assert.equal(released, true);
  }
  {
    const h = await harness();
    h.api.setPending(draft('A')); h.controls.rejectNotes = true;
    assert.equal(await h.close(), false, 'Rejected note requests block exit');
    h.resume(); h.controls.rejectNotes = false; h.controls.failDisk = true;
    assert.equal(await h.close(), false, 'A failed disk confirmation blocks exit even after successful server writes');
    h.resume(); h.controls.failDisk = false;
    assert.equal(await h.close(), true);
  }
  {
    const h = await harness();
    h.context.state.chatSessions.set('bad', { sessions: null });
    assert.equal(await h.close(), false, 'Chat serialization errors must block exit');
    h.resume();
    assert.equal(await h.close({ intent: 'invalid' }), false);
    assert.equal(h.document.body.inert, false, 'Invalid intents do not freeze editing');
  }
  console.log('Renderer exit save gate tests passed: all document drafts, settings failures, conflicts, freeze, cancellation, discard recovery, network rejection and disk confirmation.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
