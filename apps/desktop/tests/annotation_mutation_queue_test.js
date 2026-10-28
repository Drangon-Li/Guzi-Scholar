'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const annotationOperations = require('../web/annotation-operations.js');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(`  ${from}`);
  const end = source.indexOf(`  ${to}`, start);
  assert(start >= 0 && end > start, `${from} section exists`);
  return source.slice(start, end);
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const calls = [];
  const errors = [];
  const stored = new Map();
  const mounts = new Map();
  const button = { disabled: false };
  const doc = { querySelector: (selector) => selector.startsWith('[data-block-id=') ? {} : null };
  const context = vm.createContext({
    state: {}, readerMount: null, readerMounts: mounts,
    window: { MyScholarAnnotationOperations: annotationOperations },
    waitForCloseResume: async () => {},
    jsonOptions: (body, method = 'POST') => ({ method, body: JSON.stringify(body) }),
    frameDocument: () => doc,
    readerMountIsCurrent: (mount) => mounts.get(mount.jobId) === mount,
    readerMountMatches: (mount) => mounts.get(mount.jobId) === mount && context.readerMount === mount && context.state.activeJob.job_id === mount.jobId,
    isActiveReaderJob: (jobId) => context.state.activeJob.job_id === jobId,
    isAIAnnotation: (annotation) => annotation.source === 'ai',
    isIgnoredAISuggestion: (annotation) => annotation.suggestion_state === 'ignored',
    normalizeHighlightCategory: (value) => value || 'method',
    hasAnnotationNote: (annotation) => Boolean(annotation.note),
    cssEscape: (value) => value,
    rangeAtOffsets: () => ({}), canonicalBlockText: () => 'target',
    annotationColorFor: () => 'yellow', annotationAnchor: () => ({}),
    requestConfirmation: async () => true,
    renderAnnotations() {}, renderFrameAnnotations() {}, closeInlineAnnotation() {},
    clearSelectionPopover() {}, playAnnotationDrawAnimation() {}, showInlineAnnotation() {},
    showToast() {}, setPanelStatus: (message) => errors.push(message),
    $: () => button,
    request: (url, options = {}) => {
      const [, jobId, id] = url.match(/^\/api\/jobs\/([^/]+)\/annotations(?:\/([^/]+))?$/u) || [];
      assert(jobId, `Unexpected request: ${url}`);
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : {};
      let annotations = stored.get(jobId);
      let annotation;
      if (method === 'PATCH') {
        annotation = annotations.find((item) => item.id === id);
        Object.assign(annotation, body);
      } else if (method === 'POST') {
        annotation = { ...body, id: `created-${calls.length}` };
        annotations.push(annotation);
      } else if (method === 'DELETE') {
        annotations = annotations.filter((item) => id ? item.id !== id : item.source === 'ai');
        stored.set(jobId, annotations);
      }
      const payload = clone({ annotations, ...(annotation ? { annotation } : {}) });
      return new Promise((resolve, reject) => {
        calls.push({ jobId, method, id, body, release: () => resolve({ ok: true, json: async () => payload }), reject });
      });
    },
  });
  vm.runInContext([
    section('const requestAPI =', 'const jsonOptions ='),
    section('async function saveAnnotation(', 'function applyAnnotationActionSync('),
    section('async function editAnnotationNote(', '// Translation extraction,'),
    section('async function applyHighlightSuggestions(', 'async function loadAutoHighlights('),
    'this.api = api;',
  ].join('\n'), context);
  function activate(jobId, { replace = false } = {}) {
    if (!stored.has(jobId)) stored.set(jobId, [
      { id: 'A', note: 'old', source: 'manual' },
      { id: 'B', note: '', source: 'manual' },
      { id: 'AI', note: 'suggestion', source: 'ai' },
    ]);
    if (!mounts.has(jobId) || replace) mounts.set(jobId, { jobId, annotations: clone(stored.get(jobId)) });
    context.readerMount = mounts.get(jobId);
    Object.assign(context.state, { activeJob: { job_id: jobId }, annotations: context.readerMount.annotations, aiHighlights: [], selection: { block_id: 'block', start: 0, end: 6, quote: 'target' } });
    return context.readerMount;
  }
  activate('one');
  return { context, calls, errors, mounts, activate };
}

const watchdog = setTimeout(() => { throw new Error('Annotation mutation queue tests timed out'); }, 5000);
(async () => {
  const race = harness();
  const edit = race.context.editAnnotationNote({ id: 'A' }, 'updated');
  const deletion = race.context.deleteAnnotation({ id: 'B' });
  await flush();
  const concurrentDelete = race.calls.find((call) => call.method === 'DELETE');
  if (concurrentDelete) {
    // Reproduce the original bug: DELETE finishes before the older PATCH snapshot.
    concurrentDelete.release();
    await deletion;
    race.calls[0].release();
    await edit;
  } else {
    race.calls[0].release();
    await edit;
    await flush();
    race.calls[1].release();
    await deletion;
  }
  assert(!race.context.state.annotations.some((item) => item.id === 'B'), 'A late PATCH snapshot must not resurrect deleted B');
  assert.equal(race.context.state.annotations.find((item) => item.id === 'A').note, 'updated', 'The other target update is retained');

  const same = harness();
  const first = same.context.editAnnotationNote({ id: 'A' }, 'first');
  const second = same.context.editAnnotationNote({ id: 'A' }, 'second');
  await flush();
  assert.equal(same.calls.length, 1, 'Same-document writes wait for the previous response');
  same.calls[0].release(); await first; await flush();
  assert.equal(same.calls[1].body.note, 'second');
  same.calls[1].release(); await second;
  assert.equal(same.context.state.annotations.find((item) => item.id === 'A').note, 'second');

  const replacing = harness();
  const patchBeforePut = replacing.context.api('/api/jobs/one/annotations/A', { method: 'PATCH' });
  const put = replacing.context.api('/api/jobs/one/annotations/A', { method: 'PUT' });
  await flush();
  assert.equal(replacing.calls.length, 1, 'PUT joins the same document mutation queue');
  replacing.calls[0].release(); await patchBeforePut; await flush();
  assert.equal(replacing.calls[1].method, 'PUT');
  replacing.calls[1].release(); await put;

  const missingSnapshot = harness();
  missingSnapshot.context.request = async () => ({ ok: true, json: async () => ({}) });
  const originalAnnotations = missingSnapshot.context.state.annotations;
  await missingSnapshot.context.editAnnotationNote({ id: 'A' }, 'no snapshot');
  assert.equal(missingSnapshot.context.state.annotations, originalAnnotations, 'An edit without a snapshot keeps the current array');
  await missingSnapshot.context.saveAnnotation('highlight');
  assert.equal(missingSnapshot.context.state.annotations.length, 0, 'A creation without a snapshot falls back to an empty active array');
  assert.equal(missingSnapshot.context.readerMount.annotations, originalAnnotations, 'A missing creation snapshot does not invent a saved mount snapshot');
  missingSnapshot.context.state.annotations = originalAnnotations;
  await missingSnapshot.context.clearManualAnnotations();
  assert.equal(missingSnapshot.context.state.annotations.length, 0, 'A clear without a snapshot also falls back to an empty active array');

  const deleteSnapshot = harness();
  deleteSnapshot.context.request = async () => ({ ok: true, json: async () => ({ annotations: [{ id: 'unrelated-server-snapshot' }] }) });
  await deleteSnapshot.context.deleteAnnotation({ id: 'B' });
  assert.deepEqual(Array.from(deleteSnapshot.context.state.annotations, (item) => item.id), ['A', 'AI'], 'A single deletion filters the target locally instead of replacing unrelated annotations');
  assert.deepEqual(Array.from(deleteSnapshot.context.readerMount.annotations, (item) => item.id), ['A', 'AI']);

  const isolation = harness();
  const isolatedCalls = [];
  isolation.context.request = (url) => new Promise((resolve) => {
    isolatedCalls.push({ url, release: () => resolve({ ok: true, json: async () => ({}) }) });
  });
  const heldWrite = isolation.context.api('/api/jobs/one/annotations/A', { method: 'PATCH' });
  await flush();
  const reading = isolation.context.api('/api/jobs/one/annotations');
  const ordinaryWrite = isolation.context.api('/api/jobs/one/notes', { method: 'PUT' });
  await flush();
  assert.equal(isolatedCalls.length, 3, 'Annotation GET and ordinary requests do not join the mutation queue');
  isolatedCalls[1].release(); isolatedCalls[2].release();
  await Promise.all([reading, ordinaryWrite]);
  isolatedCalls[0].release(); await heldWrite;

  const clear = harness();
  const save = clear.context.saveAnnotation('highlight');
  const clearing = clear.context.clearManualAnnotations();
  await flush();
  assert.equal(clear.calls.length, 1, 'Clear waits for a pending creation');
  clear.calls[0].release(); await save; await flush();
  assert.equal(clear.calls[1].method, 'DELETE');
  clear.calls[1].release(); await clearing;
  assert.deepEqual(Array.from(clear.context.state.annotations, (item) => item.id), ['AI'], 'Clear removes the newly saved manual annotation and keeps AI annotations');

  const ai = harness();
  const note = ai.context.editAnnotationNote({ id: 'A' }, 'kept');
  const suggestions = ai.context.applyHighlightSuggestions({ highlights: [{ block_id: 'block', quote: 'target', reason: 'AI reason' }] });
  await flush();
  assert.equal(ai.calls.length, 1, 'Automatic AI annotation writes join the document queue');
  ai.calls[0].release(); await note; await flush();
  assert.equal(ai.calls[1].body.source, 'ai');
  ai.calls[1].release(); await suggestions;
  assert.equal(ai.context.state.annotations.find((item) => item.id === 'A').note, 'kept');

  const hiddenReader = harness();
  let readerVisible = true;
  hiddenReader.context.isActiveReaderJob = (jobId) => readerVisible && hiddenReader.context.state.activeJob.job_id === jobId;
  const beforeHidden = hiddenReader.context.state.annotations;
  const hiddenSuggestions = hiddenReader.context.applyHighlightSuggestions({ highlights: [
    { block_id: 'block', quote: 'target', reason: 'AI reason' },
    { block_id: 'other-block', quote: 'other target', reason: 'Must stay queued' },
  ] });
  await flush();
  readerVisible = false;
  hiddenReader.calls[0].release();
  assert.equal(await hiddenSuggestions, 0, 'A response arriving after hiding the reader does not count as an active-view addition');
  assert.equal(hiddenReader.context.state.annotations, beforeHidden, 'A hidden reader response leaves the active state array untouched');
  assert.equal(hiddenReader.context.readerMount.annotations.length, beforeHidden.length + 1, 'A hidden but registered reader mount still receives the saved snapshot');
  assert.equal(hiddenReader.calls.length, 1, 'Hiding the reader stops the remaining automatic suggestions');

  const failure = harness();
  const failed = failure.context.editAnnotationNote({ id: 'A' }, 'failed');
  const recovered = failure.context.deleteAnnotation({ id: 'B' });
  await flush(); failure.calls[0].reject(new Error('synthetic connection failure'));
  await failed; await flush();
  assert.deepEqual(failure.errors, ['synthetic connection failure']);
  assert.equal(failure.calls.length, 2, 'A rejection does not poison the queue');
  failure.calls[1].release(); await recovered;
  assert(!failure.context.state.annotations.some((item) => item.id === 'B'));

  const switching = harness();
  const originalMount = switching.context.readerMount;
  const background = switching.context.editAnnotationNote({ id: 'A' }, 'background');
  const backgroundDelete = switching.context.deleteAnnotation({ id: 'B' });
  await flush();
  const secondMount = switching.activate('two');
  const foreground = switching.context.editAnnotationNote({ id: 'A' }, 'foreground');
  await flush();
  assert.equal(switching.calls.length, 2, 'A different document is not blocked by the first document');
  switching.calls[1].release(); await foreground;
  switching.calls[0].release(); await background; await flush();
  assert.equal(switching.calls[2].jobId, 'one', 'Queued writes retain their original document');
  switching.calls[2].release(); await backgroundDelete;
  assert.equal(originalMount.annotations.find((item) => item.id === 'A').note, 'background');
  assert(!originalMount.annotations.some((item) => item.id === 'B'));
  assert.equal(switching.context.state.annotations, secondMount.annotations);
  assert.equal(secondMount.annotations.find((item) => item.id === 'A').note, 'foreground', 'Background responses cannot overwrite the active document');

  const remounting = harness();
  const obsolete = remounting.context.readerMount;
  const pending = remounting.context.editAnnotationNote({ id: 'A' }, 'obsolete');
  await flush();
  const replacement = remounting.activate('one', { replace: true });
  replacement.annotations = [{ id: 'replacement', source: 'manual' }];
  remounting.context.state.annotations = replacement.annotations;
  remounting.calls[0].release(); await pending;
  assert.equal(obsolete.annotations.find((item) => item.id === 'A').note, 'old', 'A disposed mount cannot receive responses');
  assert.equal(remounting.context.state.annotations[0].id, 'replacement', 'A response cannot overwrite a replacement mount');
  console.log('Annotation mutation queue tests passed, including stale snapshots, clear, AI, rejection recovery and mount switches');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
