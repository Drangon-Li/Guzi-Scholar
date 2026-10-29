'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = new URL(process.argv[2] || 'http://127.0.0.1:8896');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(baseURL.hostname), 'Use a local read-only fixture server.');
assert(!process.env.MY_SCHOLAR_PLAYWRIGHT_EXECUTABLE, 'Use the Playwright-managed browser without an executable override.');
const jobId = '8065bbad761a6255';
const notesPath = `/api/jobs/${jobId}/notes`;
const annotationsPath = `/api/jobs/${jobId}/annotations`;
const itemPath = `/api/library/items/${jobId}`;
const statePrefix = 'my-scholar-browser-demo-v1:';
const demoMeta = '<meta name="my-scholar-demo" content="browser-local-v1">';

function libraryContents(payload) {
  const { updated_at: _updatedAt, ...contents } = payload.library;
  return contents;
}

async function openPage(context, demo = true) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.route((url) => url.origin === baseURL.origin && ['/', '/index.html'].includes(url.pathname), async (route) => {
    assert.equal(route.request().method(), 'GET');
    const response = await route.fetch();
    assert(response.ok(), `Fixture HTML returned ${response.status()}`);
    let body = (await response.text()).replace(/<meta\b[^>]*\bname=["']my-scholar-demo["'][^>]*>/giu, '');
    if (demo) body = body.replace('</head>', `${demoMeta}</head>`);
    await route.fulfill({ response, body });
  });
  await page.goto(baseURL.href, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.MyScholarDemo));
  await page.evaluate(() => window.MyScholarDemo.ready);
  assert.equal(await page.evaluate(() => window.MyScholarDemo.enabled), demo);
  return page;
}

async function call(page, url, method = 'GET', body) {
  return page.evaluate(async ({ url, method, body }) => {
    const response = await window.MyScholarDemo.fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, standardResponse: response instanceof Response, body: await response.json() };
  }, { url, method, body });
}

async function read(page, url) {
  const response = await call(page, url);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert(response.standardResponse, 'Demo fetch must return a standard browser Response.');
  return response.body;
}

async function write(page, url, method, body, status = 200) {
  const response = await call(page, url, method, body);
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert(response.standardResponse);
  return response.body;
}

async function localStorageSentinels(page) {
  await page.evaluate(async (prefix) => {
    localStorage.setItem('browser-demo-smoke-unrelated', 'preserve');
    localStorage.setItem('my-scholar-open-documents', '["ordinary-browser-state"]');
    localStorage.setItem(`${prefix}smoke-reset`, 'remove');
    await new Promise((resolve, reject) => {
      const opening = indexedDB.open('browser-demo-smoke-unrelated', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('sentinel');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const transaction = db.transaction('sentinel', 'readwrite');
        transaction.objectStore('sentinel').put('preserve', 'value');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
  }, statePrefix);
}

async function preservedSentinels(page) {
  return page.evaluate(async (prefix) => {
    const idb = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('browser-demo-smoke-unrelated', 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const transaction = db.transaction('sentinel');
        const request = transaction.objectStore('sentinel').get('value');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      };
    });
    return {
      idb,
      unrelated: localStorage.getItem('browser-demo-smoke-unrelated'),
      ordinary: localStorage.getItem('my-scholar-open-documents'),
      demo: localStorage.getItem(`${prefix}smoke-reset`),
    };
  }, statePrefix);
}

async function run() {
  const session = await launchManagedChromium();
  const profileArgument = session.browserProcess.spawnargs.find((arg) => arg.startsWith('--user-data-dir='));
  assert(profileArgument, 'Managed browser must have an identifiable temporary profile.');
  const profilePath = profileArgument.slice('--user-data-dir='.length);
  const contexts = [];
  const networkWrites = [];
  try {
    const context = await session.browser.newContext({ viewport: { width: 1460, height: 960 } });
    contexts.push(context);
    const health = await context.request.get(new URL('/api/health', baseURL).href);
    assert(health.ok(), 'Fixture health endpoint must be available.');
    assert.equal((await health.json()).readonly, true, 'Browser demo smoke requires a read-only fixture server.');
    context.on('request', (request) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) networkWrites.push(`${request.method()} ${request.url()}`);
    });
    const page = await openPage(context);
    await page.locator('#browser-demo-banner').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.MyScholarDemo.statePrefix), statePrefix);
    const original = await read(page, notesPath);
    const originalLibrary = await read(page, '/api/library');
    const baselineResponse = await context.request.get(new URL(notesPath, baseURL).href);
    assert(baselineResponse.ok());
    const serverNotes = await baselineResponse.json();
    assert.equal(original.revision, serverNotes.revision, 'Seed notes must retain the original revision contract.');

    const initialText = 'browser demo persisted notes — 独立本地副本';
    const saved = await write(page, notesPath, 'PUT', { markdown: initialText, expected_revision: original.revision });
    assert.equal(saved.markdown, initialText);
    assert.notEqual(saved.revision, original.revision);
    assert((await page.evaluate(() => indexedDB.databases())).some((db) => db.name === 'my-scholar-browser-demo-v1'));
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(() => window.MyScholarDemo.ready);
    assert.equal((await read(page, notesPath)).markdown, initialText, 'Notes must survive refresh through IndexedDB.');

    const isolatedContext = await session.browser.newContext();
    contexts.push(isolatedContext);
    isolatedContext.on('request', (request) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) networkWrites.push(`${request.method()} ${request.url()}`);
    });
    const isolatedPage = await openPage(isolatedContext);
    assert.deepEqual(await read(isolatedPage, notesPath), original, 'Independent contexts must start from their own seed.');
    const isolatedText = 'a different browser context';
    await write(isolatedPage, notesPath, 'PUT', { markdown: isolatedText, expected_revision: original.revision });
    assert.equal((await read(page, notesPath)).markdown, initialText);

    const peer = await openPage(context);
    const shared = await read(peer, notesPath);
    const competingTexts = ['first competing tab', 'second competing tab'];
    const competing = await Promise.all(competingTexts.map((markdown, index) => call(index ? peer : page, notesPath, 'PUT', {
      markdown, expected_revision: shared.revision,
    })));
    assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409], 'Concurrent notes writes must use transactional revision checks.');
    const winner = competingTexts[competing.findIndex((result) => result.status === 200)];
    assert.equal((await read(peer, notesPath)).markdown, winner);
    const missingRevision = await call(page, notesPath, 'PUT', { markdown: 'must not overwrite without a revision' });
    assert(missingRevision.status >= 400);
    assert.equal((await read(page, notesPath)).markdown, winner);

    const paper = page.locator(`#library-view .library-card[data-job-id="${jobId}"] .library-row-name`);
    await paper.dblclick();
    if (await page.locator('#assistant-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#assistant-toggle').click();
    await page.locator('[data-panel="chat-panel"]').click();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      if (viewport.width <= 880) {
        await page.waitForFunction(() => document.querySelector('#assistant-toggle').getAttribute('aria-expanded') === 'false');
        await page.locator('#assistant-toggle').click();
      }
      const question = `Explain attention at ${viewport.width}px`;
      await page.locator('#chat-input').fill(question);
      const send = page.locator('#chat-form button[type="submit"]');
      await send.waitFor({ state: 'visible' });
      await page.locator('#toast').waitFor({ state: 'hidden' });
      await send.click({ trial: true });
      const layout = await send.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const banner = document.querySelector('#browser-demo-banner').getBoundingClientRect();
        const unobscured = [0.2, 0.5, 0.8].every((x) => [0.2, 0.5, 0.8].every((y) => button.contains(document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y))));
        return { unobscured, inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, bannerAbove: banner.bottom <= rect.top };
      });
      assert.deepEqual(layout, { unobscured: true, inViewport: true, bannerAbove: true }, `Demo send button must remain clickable at ${viewport.width}px.`);
      await send.click();
      await page.locator('#chat-messages .chat-bubble.user').filter({ hasText: question }).waitFor();
      await page.waitForFunction(() => !document.querySelector('#chat-messages .chat-bubble.assistant.is-streaming'));
      assert.match(await page.locator('#chat-messages .chat-bubble.assistant').last().innerText(), /示例/u);
      console.log(`Demo chat send unobscured and clickable at ${viewport.width}×${viewport.height}.`);
    }
    await page.setViewportSize({ width: 1460, height: 960 });
    await page.locator('[data-panel="notes-panel"]').click();
    const editor = page.locator('#notes-editor');
    await page.waitForFunction(() => document.querySelector('#notes-editor')?.contentEditable === 'true');
    await editor.fill('notes saved through the real UI');
    await page.locator('#save-notes-button').click();
    await page.waitForFunction(async (url) => (await (await window.MyScholarDemo.fetch(url)).json()).markdown === 'notes saved through the real UI', notesPath);
    const beforeExternal = await read(peer, notesPath);
    await write(peer, notesPath, 'PUT', { markdown: 'external tab keeps the winning notes', expected_revision: beforeExternal.revision });
    await editor.fill('local draft must survive the conflict');
    await page.locator('#save-notes-button').click();
    await page.locator('#notes-conflict:not([hidden])').waitFor();
    assert.equal(await editor.innerText(), 'local draft must survive the conflict');
    assert.equal(await page.locator('#notes-external-version').inputValue(), 'external tab keeps the winning notes');
    assert.equal((await read(peer, notesPath)).markdown, 'external tab keeps the winning notes');

    const originalAnnotations = await read(page, annotationsPath);
    const created = await write(page, annotationsPath, 'POST', {
      kind: 'highlight', quote: 'Browser demo annotation fixture', block_id: 'browser-demo-smoke',
      page: 1, start: 0, end: 31, color: '#2563eb', note: 'original note', source: 'manual',
    }, 201);
    assert(created.annotation?.id);
    const annotationId = created.annotation.id;
    const edited = await write(page, `${annotationsPath}/${annotationId}`, 'PATCH', { note: 'edited note', kind: 'underline', color: '#16a34a' });
    assert.deepEqual([edited.annotation.note, edited.annotation.kind, edited.annotation.color], ['edited note', 'underline', '#16a34a']);
    assert.equal((await read(peer, annotationsPath)).annotations.find((item) => item.id === annotationId)?.note, 'edited note');
    const deleted = await write(page, `${annotationsPath}/${annotationId}`, 'DELETE');
    assert(!deleted.annotations.some((item) => item.id === annotationId));
    assert.deepEqual(deleted.annotations, originalAnnotations.annotations, 'Deleting one annotation must preserve every other annotation.');

    const property = await write(page, '/api/library/properties', 'POST', { label: 'Browser smoke custom field', type: 'text', visible: true }, 201);
    assert(property.property?.id);
    const customId = property.property.id;
    const updated = await write(page, itemPath, 'PATCH', { values: { importance: 4, [customId]: 'only in this browser' }, alias: 'Local browser alias' });
    assert.equal(updated.item.values.importance, 4);
    assert.equal(updated.item.values[customId], 'only in this browser');
    assert.equal(updated.item.alias, 'Local browser alias');
    await peer.reload({ waitUntil: 'networkidle' });
    await peer.evaluate(() => window.MyScholarDemo.ready);
    const persistedLibrary = await read(peer, '/api/library');
    assert.equal(persistedLibrary.library.items[jobId].values[customId], 'only in this browser');
    assert.deepEqual(libraryContents(await read(isolatedPage, '/api/library')), libraryContents(originalLibrary));

    const vocabularyPath = '/api/plugins/guzi.vocabulary/invoke';
    const vocabularyPlugin = (await read(page, '/api/plugins')).plugins.find((plugin) => plugin.id === 'guzi.vocabulary');
    assert(vocabularyPlugin?.enabled);
    const isolatedVocabularyBefore = await write(isolatedPage, vocabularyPath, 'POST', { pluginSession: vocabularyPlugin.epoch, name: 'vocabulary_list', arguments: {} });
    const vocabulary = await write(page, vocabularyPath, 'POST', {
      pluginSession: vocabularyPlugin.epoch, name: 'vocabulary_save',
      arguments: { term: 'browser local attention', meaning: '浏览器本地词条', language: 'en', source: { job_id: jobId, quote: 'Browser local attention fixture.', surface: 'source' } },
    });
    const vocabularyId = vocabulary.result?.entry?.id;
    assert(vocabularyId);
    await page.locator('[data-view="vocabulary-view"]').click();
    const vocabularyFrame = page.frameLocator('iframe[data-plugin-id="guzi.vocabulary"]');
    const vocabularyCard = vocabularyFrame.locator(`[data-vocabulary-id="${vocabularyId}"]`);
    await vocabularyCard.waitFor();
    assert.match(await vocabularyCard.innerText(), /browser local attention/u);
    await vocabularyCard.locator('[data-vocab-action="edit"]').click();
    await vocabularyCard.locator('[name="meaning"]').fill('插件 UI 编辑后的本地释义');
    await vocabularyCard.locator('[data-vocab-action="save-edit"]').click();
    await vocabularyCard.locator('.vocabulary-meaning').filter({ hasText: '插件 UI 编辑后的本地释义' }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(() => window.MyScholarDemo.ready);
    await page.locator('[data-view="vocabulary-view"]').click();
    await vocabularyFrame.locator(`[data-vocabulary-id="${vocabularyId}"] .vocabulary-meaning`).filter({ hasText: '插件 UI 编辑后的本地释义' }).waitFor();
    const isolatedVocabulary = await write(isolatedPage, vocabularyPath, 'POST', { pluginSession: vocabularyPlugin.epoch, name: 'vocabulary_list', arguments: {} });
    assert.deepEqual(isolatedVocabulary.result.entries, isolatedVocabularyBefore.result.entries, 'Editing a vocabulary entry must not change another browser context or its bundled sample.');
    const chat = await write(page, `/api/jobs/${jobId}/chat`, 'POST', { message: 'Explain the attention mechanism', messages: [{ role: 'user', content: 'Explain the attention mechanism' }] });
    assert.match(chat.result.text, /示例/u);
    assert(chat.result.demo || chat.demo, 'AI responses must identify the local example.');

    for (const [url, method] of [['/api/not-a-demo-route', 'POST'], [`/api/jobs/${jobId}/not-supported`, 'PUT'], ['/api/settings/unknown', 'DELETE']]) {
      const blocked = await call(page, url, method, { write: 'must never reach the fixture' });
      assert.equal(blocked.status, 501, JSON.stringify(blocked.body));
    }
    assert.deepEqual(networkWrites, [], 'Demo operations must not send network writes.');
    assert.deepEqual(await (await context.request.get(new URL(notesPath, baseURL).href)).json(), serverNotes, 'The read-only server seed must remain unchanged.');

    await localStorageSentinels(page);
    const resetKeys = ['my-scholar-reading-locations-v1', `my-scholar-chat-v2:${jobId}`];
    const staleMarker = 'browser-demo-reset-stale-state';
    for (const [index, target] of [page, peer].entries()) {
      await target.evaluate(({ keys, marker, jobId, index }) => {
        const stamp = new Date().toISOString();
        const reading = { version: 1, locations: { [jobId]: { blockId: `${marker}-${index}`, page: 1, offsetPx: 0, offsetRatio: 0, blockHeight: 100, progress: 0, generation: 'base', updatedAt: stamp } } };
        const chat = { version: 2, activeSessionId: 'reset-regression', sessions: [{ id: 'reset-regression', title: marker, titleMode: 'manual', options: {}, messages: [{ id: `reset-${index}`, role: 'user', content: `${marker}-${index}` }], createdAt: stamp, updatedAt: stamp }] };
        window.MyScholarCore.persistentStateSet(keys[0], JSON.stringify(reading));
        window.MyScholarCore.persistentStateSet(keys[1], JSON.stringify(chat));
      }, { keys: resetKeys, marker: staleMarker, jobId, index });
    }
    await peer.reload({ waitUntil: 'networkidle' });
    await peer.evaluate(() => window.MyScholarDemo.ready);
    await peer.locator('[data-view="library-view"]').click();
    await peer.locator(`#library-view .library-card[data-job-id="${jobId}"] .library-row-name`).dblclick();
    for (const target of [page, peer]) {
      await target.evaluate(() => {
        window.demoInvalidationEvents = 0;
        window.addEventListener('my-scholar-demo-invalidated', () => { window.demoInvalidationEvents += 1; });
      });
    }
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    const synchronouslyInvalidated = await page.evaluate(async () => {
      const resetting = window.MyScholarDemo.reset();
      const invalidated = window.MyScholarDemo.invalidated;
      await resetting;
      return invalidated;
    });
    assert(synchronouslyInvalidated, 'Reset must invalidate the initiating page before its first await.');
    await peer.waitForFunction(() => window.MyScholarDemo.invalidated === true);
    await peer.locator('#browser-demo-invalidated-dialog[open]').waitFor();
    assert.match(await peer.locator('#browser-demo-invalidated-dialog').innerText(), /测试数据已重置.*刷新/u);
    assert.equal(await peer.locator('#browser-demo-reload').count(), 1);
    assert(await peer.locator('.app-header').evaluate((node) => node.inert));
    assert(await peer.locator('.app-shell').evaluate((node) => node.inert));
    for (const target of [page, peer]) {
      assert.equal(await target.evaluate(() => window.demoInvalidationEvents), 1, 'Each old page must receive one invalidation event.');
      assert.deepEqual(await target.evaluate((keys) => keys.map((key) => window.MyScholarCore.persistentStateGet(key)), resetKeys), [null, null]);
      await target.evaluate(({ keys, marker }) => {
        for (const key of keys) {
          window.MyScholarCore.persistentStateSet(key, marker);
          window.MyScholarCore.persistentStateRemove(key);
        }
        window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
      }, { keys: resetKeys, marker: staleMarker });
    }
    assert.deepEqual(await page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)), statePrefix), [], 'Old pages must not resurrect any demo state after reset.');
    await peer.goto('about:blank');
    assert.deepEqual(await page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)), statePrefix), [], 'The old peer must not resurrect state during real pagehide.');
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, 'The runtime reset must let the UI control reload.');
    assert.deepEqual(await preservedSentinels(page), {
      idb: 'preserve', unrelated: 'preserve', ordinary: '["ordinary-browser-state"]', demo: null,
    });
    assert.equal((await call(page, notesPath, 'PUT', { markdown: 'old page must stay closed', expected_revision: original.revision })).status, 503);
    assert.equal((await read(isolatedPage, notesPath)).markdown, isolatedText, 'Reset must not affect another context.');

    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(() => window.MyScholarDemo.ready);
    assert.equal(await page.evaluate(() => window.MyScholarDemo.invalidated), false);
    const restoredOldState = await page.evaluate(({ prefix, keys, marker }) => keys.some((key) => (localStorage.getItem(`${prefix}${key}`) || '').includes(marker)), { prefix: statePrefix, keys: resetKeys, marker: staleMarker });
    assert.equal(restoredOldState, false, 'Reload after reset must not restore the old reading or chat state.');
    assert.deepEqual(await read(page, notesPath), original);
    assert.deepEqual(libraryContents(await read(page, '/api/library')), libraryContents(originalLibrary));
    await page.locator('#browser-demo-reset').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await Promise.all([page.waitForEvent('load'), page.locator('#confirm-accept').click()]);
    await page.locator('#browser-demo-banner').waitFor({ state: 'visible' });
    assert.deepEqual(await preservedSentinels(page), {
      idb: 'preserve', unrelated: 'preserve', ordinary: '["ordinary-browser-state"]', demo: null,
    });
    await page.goto('about:blank');
    assert.deepEqual(networkWrites, [], 'Pagehide persistence must stay local in demo mode.');

    const ordinaryContext = await session.browser.newContext();
    contexts.push(ordinaryContext);
    const ordinary = await openPage(ordinaryContext, false);
    assert.equal(await ordinary.locator('#browser-demo-banner').count(), 0);
    const ordinaryRequests = [];
    ordinary.on('request', (request) => { if (new URL(request.url()).pathname === '/api/jobs') ordinaryRequests.push(request.method()); });
    const expectedJobs = await (await ordinaryContext.request.get(new URL('/api/jobs', baseURL).href)).json();
    assert.deepEqual(await read(ordinary, '/api/jobs'), expectedJobs, 'Without the meta marker, demo fetch must preserve network behavior.');
    assert.deepEqual(ordinaryRequests, ['GET']);
    await ordinary.evaluate(() => window.MyScholarCore.persistentStateSet('browser-demo-smoke-normal', 'ordinary'));
    assert.equal(await ordinary.evaluate(() => localStorage.getItem('browser-demo-smoke-normal')), 'ordinary');
    assert.equal(await ordinary.evaluate((prefix) => localStorage.getItem(`${prefix}browser-demo-smoke-normal`), statePrefix), null);
    console.log('Browser demo smoke passed: IndexedDB refresh, context isolation, notes CAS + conflict UI, annotation CRUD, library properties, vocabulary plugin persistence, AI example, scoped reset, zero network writes, and ordinary-mode passthrough.');
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await session.close();
    const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    assert(!processes.split('\n').some((line) => line.includes(profileArgument)), `Browser profile still has a process: ${profilePath}`);
    assert(!fs.existsSync(profilePath), `Temporary browser profile was not removed: ${profilePath}`);
    console.log(`Browser cleanup verified: pid=${session.browserProcess.pid}, profile=${profilePath}, zero matching processes.`);
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
