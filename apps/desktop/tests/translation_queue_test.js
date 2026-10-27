'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const slots = source.slice(source.indexOf('  const FULL_TRANSLATION_MAX_DOCUMENTS'), source.indexOf('  // One paragraph of a run.'));
const runs = source.slice(source.indexOf('  function fullTranslationSnapshot('), source.indexOf('  function stopFullTranslation('));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const state = { activeJob: null, translationRuns: new Map() };
  const active = new Map();
  const mounts = new Map();
  const started = [];
  let peak = 0;
  const context = vm.createContext({
    state, readerMount: null, AbortController, FULL_TRANSLATION_CONCURRENCY: 3,
    window: { setTimeout: setImmediate }, performance: { now: () => 0 },
    translationScope: () => 'all', aiServiceEnabled: () => true,
    frameDocument: () => context.readerMount.frame.contentDocument,
    readerMountIsCurrent: (mount) => Boolean(mount && mounts.get(mount.jobId) === mount),
    translationTarget: (_id, doc) => doc.block, translatableParagraph: () => true,
    hasUsableTranslation: () => false, paragraphTranslationSource: () => ({ text: 'A paragraph.' }),
    documentTitleFor: (id) => id, syncTranslationControls: () => {},
    updateTranslationProgress: () => {}, showToast: () => {}, setPanelStatus: () => {},
    releaseClosedDocumentCaches: () => {},
    translationErrorMessage: (error) => error.message,
    translateSnapshot: (_snapshot, run) => new Promise((resolve) => {
      started.push(run.jobId);
      const finish = () => { active.delete(run.jobId); resolve(true); };
      active.set(run.jobId, finish);
      peak = Math.max(peak, active.size);
      run.abortController.signal.addEventListener('abort', finish, { once: true });
    }),
  });
  vm.runInContext(`${slots}\n${runs}\nthis.run = runFullTranslation; this.cancel = cancelTranslationRun;`, context);
  return {
    state, active, started, peak: () => peak,
    start(id) {
      const block = { dataset: { blockId: 'body' }, matches: () => false };
      const doc = { block, querySelectorAll: () => [block] };
      const mount = { jobId: id, generation: 'base', frame: { contentDocument: doc } };
      mounts.set(id, mount);
      context.readerMount = mount;
      state.activeJob = { job_id: id };
      return context.run();
    },
    cancel(id) { context.cancel(state.translationRuns.get(id)); },
  };
}

(async () => {
  const test = harness();
  const first = test.start('A');
  const second = test.start('B');
  const cancelled = test.start('C');
  const fourth = test.start('D');
  await flush();
  assert.deepEqual(test.started, ['A', 'B']);
  test.cancel('C');
  await cancelled;
  await flush();
  assert.deepEqual(test.started, ['A', 'B'], 'Cancelling a queued document must not release an occupied slot');
  assert.equal(test.state.translationRuns.get('D').phase, 'queued');
  test.active.get('A')();
  await first;
  await flush();
  assert.deepEqual(test.started, ['A', 'B', 'D']);
  const restarted = test.start('C');
  await flush();
  assert.equal(test.state.translationRuns.get('C').phase, 'queued');
  test.cancel('B');
  await second;
  await flush();
  assert.deepEqual(test.started, ['A', 'B', 'D', 'C'], 'A running cancellation must release exactly one slot');
  test.active.get('D')();
  test.active.get('C')();
  await Promise.all([fourth, restarted]);
  assert.equal(test.peak(), 2);
  assert.equal(test.active.size, 0);
  assert.ok([...test.state.translationRuns.values()].every((run) => !run.running));
  console.log(JSON.stringify({ translationQueue: true, queuedCancellation: true, runningCancellation: true, restart: true, peakDocuments: test.peak() }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
