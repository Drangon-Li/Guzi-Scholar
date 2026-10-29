'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const runtime = fs.readFileSync(path.join(__dirname, '../web/demo-runtime.js'), 'utf8');
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '../web/assets/demo/attention/reading-sample.json'), 'utf8'));
const jobId = '8065bbad761a6255';
const samplePath = '/web/assets/demo/attention/reading-sample.json';
const databaseName = 'my-scholar-browser-demo-v1';
const document = { pages: [{ page: 4, elements: sample.translations.map(({ block_id, source_text }) => ({ block_id, text: source_text })) }] };
const translations = [{ block_id: 'unrelated-block', text: 'Preserve this translation' }, ...sample.translations.map((record) => ({ ...record, text: 'Old archive translation', segments: undefined, source_segments: undefined, alignment_version: undefined }))];
const library = { items: { [jobId]: { job_id: jobId, alias: 'User alias', deleted_at: null } }, permanently_deleted: [] };
const fixture = {
  '/api/health': { readonly: true },
  '/api/jobs': { jobs: [{ job_id: jobId, document }] },
  '/api/library': { library },
  '/api/settings': {},
  [`/api/jobs/${jobId}/translations`]: { translations },
  [`/api/jobs/${jobId}/annotations`]: { annotations: [{ id: 'user-annotation', note: 'Keep annotation' }] },
  [`/api/jobs/${jobId}/notes`]: { markdown: 'Keep notes' },
  [`/api/jobs/${jobId}/media-layout`]: { media_layout: { version: 1, items: {} } },
};
const requests = [];
const server = http.createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.url === '/runtime.js') { response.setHeader('Content-Type', 'text/javascript; charset=utf-8'); response.end(runtime); }
  else if (request.url === samplePath) response.end(JSON.stringify(sample));
  else if (fixture[request.url]) response.end(JSON.stringify(fixture[request.url]));
  else if (['/demo', '/native', '/blank'].includes(request.url)) {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<html><head>${request.url === '/demo' ? '<meta name="my-scholar-demo" content="browser-local-v1">' : ''}</head><body>${request.url === '/blank' ? '' : '<script src="/runtime.js"></script>'}</body></html>`);
  } else { response.statusCode = 404; response.end('{}'); }
});

async function stored(page, value) {
  return page.evaluate(({ databaseName, value }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('state', value === null ? 'readonly' : 'readwrite');
      const store = tx.objectStore('state');
      const reading = value === null ? store.get('main') : store.put(value, 'main');
      tx.oncomplete = () => { db.close(); resolve(value === null ? reading.result : null); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), { databaseName, value: value ?? null });
}

async function open(context, base, route = '/demo') {
  const page = await context.newPage();
  await page.goto(base + route);
  if (route !== '/blank') await page.evaluate(() => window.MyScholarDemo.ready);
  return page;
}

function legacy(revision = 0) {
  return structuredClone({ version: 1, sampleRevision: revision, created_at: 'unchanged', library, jobs: fixture['/api/jobs'].jobs, settings: { appearance: { theme: 'dark' } }, health: {}, vocabulary: [], documents: { [jobId]: { document, translations, annotations: [{ id: 'user-annotation' }], notes: { markdown: 'Personal notes', revision: 'personal' }, chats: [{ content: 'Keep chat' }], media_layout: {} } }, pluginStorage: { 'guzi.vocabulary': { setting: 'keep' } } });
}

function checkTranslations(state) {
  for (const record of sample.translations) {
    const actual = state.documents[jobId].translations.filter((entry) => entry.block_id === record.block_id);
    assert.equal(actual.length, 1);
    for (const key of Object.keys(record)) assert.deepEqual(actual[0][key], record[key], key);
    assert.equal(actual[0].demo, true);
    assert.equal(actual[0].profile_id, 'browser-demo');
    assert.match(actual[0].model, /人工/);
  }
  assert.equal(state.documents[jobId].translations[0].text, 'Preserve this translation');
}

async function run() {
  assert.equal(sample.translations.length, 38);
  assert.equal(new Set(sample.translations.map((record) => record.block_id)).size, 38);
  assert.equal(sample.translations.reduce((count, record) => count + record.segments.length, 0), 102);
  const tokens = (value) => (value.match(/__MY_SCHOLAR_[A-Z_]+_\d+__/g) || []).sort();
  for (const record of sample.translations) {
    assert.equal(record.alignment_version, 'sentence-v1', record.block_id);
    assert(record.source_text && record.source_hash && record.text, record.block_id);
    assert(record.source_segments.length > 0, record.block_id);
    assert.deepEqual(record.segments.map(({ id }) => id), record.source_segments.map(({ id }) => id), record.block_id);
    assert.equal(new Set(record.segments.map(({ id }) => id)).size, record.segments.length, record.block_id);
    record.segments.forEach((segment, index) => {
      assert.match(segment.id, /^s\d+-\d+$/);
      assert(segment.text.trim(), `${record.block_id}:${segment.id}`);
      assert.deepEqual(tokens(segment.text), tokens(record.source_segments[index].text), `${record.block_id}:${segment.id} placeholders`);
    });
    assert.deepEqual(tokens(record.text), tokens(record.segments.map(({ text }) => text).join(' ')), `${record.block_id} complete translation placeholders`);
  }
  assert.equal(sample.vocabulary.length, 1);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await launchManagedChromium();
  const pid = session.browserProcess.pid;
  const profile = session.browserProcess.spawnargs.find((argument) => argument.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  const contexts = [];
  const context = async () => { const current = await session.browser.newContext(); contexts.push(current); return current; };
  try {
    const native = await open(await context(), base, '/native');
    assert.equal(await native.evaluate(() => window.MyScholarDemo.readingSource()), null);
    assert.equal(requests.filter((entry) => entry.path === samplePath).length, 0, 'Native mode must not request the sample.');

    const fresh = await open(await context(), base);
    const initial = await stored(fresh);
    checkTranslations(initial);
    assert.equal(initial.version, 1);
    assert.equal(initial.sampleRevision, 2);
    assert.equal(initial.vocabulary[0].term, 'attention');
    assert.equal(initial.settings.ai.translation.model, 'Attention 公开样例（示例）');
    assert.deepEqual(await fresh.evaluate(() => window.MyScholarDemo.readingSource()), sample.reading_source);
    const networkAPICount = requests.filter((entry) => entry.path.startsWith('/api/')).length;
    const cached = await fresh.evaluate(async (jobId) => {
      const path = `/api/jobs/${jobId}/translations`;
      const read = async (url, method = 'GET') => {
        const response = await window.MyScholarDemo.fetch(url, { method });
        return { status: response.status, body: await response.json() };
      };
      return {
        plain: await read(path),
        scoped: await read(`${path}?scope=all`),
        rejected: await Promise.all([
          `${path}?scope=all&scope=all`, `${path}?scope=all&extra=1`, `${path}?scope=partial`,
          `/api/jobs/${jobId}/notes?scope=all`, '/api/library?scope=all', '/api/jobs/other/translations?scope=all',
        ].map((url) => read(url))),
        post: await read(`${path}?scope=all`, 'POST'),
      };
    }, jobId);
    assert.equal(cached.plain.status, 200);
    assert.deepEqual(cached.scoped, cached.plain, 'scope=all must return the same local translation cache.');
    assert(cached.rejected.every((response) => response.status === 400), 'Only one scope=all on the seed translations GET is supported.');
    assert.equal(cached.post.status, 400);
    assert.equal(requests.filter((entry) => entry.path.startsWith('/api/')).length, networkAPICount, 'Translation cache queries and rejected queries must not reach the network.');
    const deleted = await fresh.evaluate(async (id) => (await window.MyScholarDemo.fetch(`/api/vocabulary/${id}`, { method: 'DELETE' })).status, initial.vocabulary[0].id);
    assert.equal(deleted, 200);
    const sampleLoads = requests.filter((entry) => entry.path === samplePath).length;
    await fresh.reload();
    await fresh.evaluate(() => window.MyScholarDemo.ready);
    assert.deepEqual((await stored(fresh)).vocabulary, [], 'Refresh must not restore a deleted sample term.');
    assert.equal(requests.filter((entry) => entry.path === samplePath).length, sampleLoads, 'A completed revision must not reload the static sample.');

    for (const revision of [0, 1]) {
      const shared = await context();
      const setup = await open(shared, base, '/blank');
      const before = legacy(revision);
      await stored(setup, before);
      let arrivals = 0;
      let release;
      const bothLoading = new Promise((resolve) => { release = resolve; });
      await shared.route(`**${samplePath}`, async (route) => {
        if (++arrivals === 2) release();
        await bothLoading;
        await route.fulfill({ json: sample });
      });
      const [first] = await Promise.all([open(shared, base), open(shared, base)]);
      const upgraded = await stored(first);
      checkTranslations(upgraded);
      assert.equal(upgraded.vocabulary.length, revision === 0 ? 1 : 0, 'Only the first sample migration may seed vocabulary.');
      const expected = structuredClone(before);
      expected.documents[jobId].translations = upgraded.documents[jobId].translations;
      expected.vocabulary = upgraded.vocabulary;
      expected.sampleRevision = 2;
      expected.readingSource = sample.reading_source;
      assert.deepEqual(upgraded, expected, 'Migration must preserve all unrelated user state.');
      const loads = requests.filter((entry) => entry.path === samplePath).length;
      await first.reload();
      await first.evaluate(() => window.MyScholarDemo.ready);
      assert.deepEqual(await stored(first), upgraded, 'A completed upgrade must be idempotent.');
      assert.equal(requests.filter((entry) => entry.path === samplePath).length, loads);
    }

    for (const revision of [0, 1]) {
      for (const scenario of ['same-term', 'edited-vocabulary', 'synthetic', 'permanent', 'trash']) {
        const currentContext = await context();
        const page = await open(currentContext, base, '/blank');
        const state = legacy(revision);
        if (scenario === 'same-term') state.vocabulary = [{ id: 'personal-term', term: ' Attention ', language: 'auto', meaning: 'Personal meaning', note: 'Personal note' }];
        if (scenario === 'edited-vocabulary') state.vocabulary = [{ ...structuredClone(sample.vocabulary[0]), meaning: 'Edited meaning', note: 'Edited note', review: { status: 'known', review_count: 7 } }, { id: 'personal-word', term: 'query', meaning: 'Personal query definition' }];
        if (scenario === 'synthetic') state.documents[jobId].document = { pages: [{ elements: [{ block_id: 'synthetic-attention' }] }] };
        if (scenario === 'permanent') { state.library.items = {}; state.library.permanently_deleted = [jobId]; state.documents = {}; state.jobs = []; }
        if (scenario === 'trash') state.library.items[jobId].deleted_at = 'user-deleted';
        await stored(page, state);
        await page.goto(base + '/demo');
        await page.evaluate(() => window.MyScholarDemo.ready);
        const migrated = await stored(page);
        if (['same-term', 'edited-vocabulary'].includes(scenario)) {
          checkTranslations(migrated);
          assert.deepEqual(migrated, { ...state, sampleRevision: 2, readingSource: sample.reading_source, documents: { [jobId]: { ...state.documents[jobId], translations: migrated.documents[jobId].translations } } }, 'Vocabulary and all unrelated user state must stay untouched.');
        } else {
          assert.deepEqual(migrated, { ...state, sampleRevision: 2 }, scenario);
          assert.equal(await page.evaluate(() => window.MyScholarDemo.readingSource()), null, scenario);
        }
      }
    }
    assert(requests.every((entry) => entry.method === 'GET'), 'Initialization must use only network GET requests.');
    console.log('Browser demo sample seed, legacy concurrent migration, deletion, native, and synthetic tests passed.');
  } finally {
    await Promise.allSettled(contexts.map((current) => current.close()));
    await session.close();
    await new Promise((resolve) => server.close(resolve));
    assert(session.browserProcess.exitCode !== null || session.browserProcess.signalCode !== null, `Managed browser ${pid} must exit.`);
    assert(!fs.existsSync(profile), `Managed browser profile must be removed: ${profile}`);
  }
}

run().catch((error) => { server.close(); console.error(error); process.exitCode = 1; });
