'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const baseline = process.argv.includes('--baseline');
const requestedURL = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const ids = Array.from({ length: 6 }, (_, index) => (index + 10).toString(16).repeat(16));
const paragraphs = 120;
const markers = 16;
const profile = 'reader-memory-fixture';
const prose = 'This synthetic paragraph explains a controlled experiment with observable and reproducible reading behavior.';
const paragraph = (index) => `${prose} Paragraph ${index} includes enough source text for sentence ranges and translation controls. Memory measurements compare several complete document lifecycles after garbage collection.`;
const jobs = ids.map((id, index) => ({ job_id: id, source_filename: `Synthetic memory ${index}.pdf`, status: 'completed',
  created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z', links: { html: `/api/jobs/${id}/document.html` },
  manifest: { counts: { pages: 8, images: 8 } } }));
const library = { folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] },
  items: Object.fromEntries(ids.map((id) => [id, { folder_ids: [], values: { reading_status: '阅读中', importance: 0, research_topic: [] },
    metadata: { fields: {}, status: 'complete' }, created_at: jobs[0].created_at, updated_at: jobs[0].updated_at }])) };

function documentHTML(id) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.reader-content{max-width:720px;margin:auto}p[data-block-id]{min-height:100px;padding:12px;margin:0}img{display:block;width:100%;height:auto}</style></head><body data-fixture-job="${id}"><main class="reader-content">${Array.from({ length: 8 }, (_, section) => `<section class="pdf-page" data-page="${section + 1}"><h2 data-block-id="heading-${section}" data-page="${section + 1}">Synthetic section ${section}</h2><a class="cross-reference" href="#fig-${section}">Figure ${section}</a><figure id="fig-${section}" class="pdf-figure" data-block-id="figure-${section}" data-page="${section + 1}"><img width="720" height="240" src="/api/jobs/${id}/assets/images/fixture.png" alt="Synthetic memory image ${section}"><figcaption>Synthetic fixture image.</figcaption></figure>${Array.from({ length: paragraphs / 8 }, (_, offset) => { const index = section * paragraphs / 8 + offset; return `<p data-block-id="paragraph-${index}" data-page="${section + 1}">${paragraph(index)}</p>`; }).join('')}</section>`).join('')}</main></body></html>`;
}

function instrument(source) {
  assert.match(source, /function wireFrame\(/u);
  const restoreStart = source.indexOf('  async function restoreReadingLocationAfterLoad(');
  const fontsStart = source.indexOf('    if (doc.fonts?.ready) {', restoreStart);
  assert.ok(restoreStart >= 0 && fontsStart > restoreStart, 'Font readiness instrumentation target must exist');
  source = source.slice(0, fontsStart) + `
    if (window.__memoryHoldFonts) {
      Object.defineProperty(doc.fonts, 'ready', { configurable: true, value: new doc.defaultView.Promise(() => {}) });
      window.__memoryFontTimers.gatedDocuments += 1;
    }
` + source.slice(fontsStart);
  const injection = `
  {
    const documents = [];
    const original = wireFrame;
    wireFrame = function (...args) {
      const result = original.apply(this, args);
      const doc = args[0]?.frame?.contentDocument;
      if (doc && !documents.some((reference) => reference.deref() === doc)) documents.push(new WeakRef(doc));
      return result;
    };
    window.__readerMemory = {
      counts: () => ({
        mounts: readerMounts.size, open: state.openDocuments.length,
        translationCaches: state.translationCaches.size, mediaLayouts: state.mediaLayouts.size, chatSessions: state.chatSessions.size, translationRuns: state.translationRuns.size,
        chatStreaming: [...state.chatSessions.values()].reduce((count, envelope) => count + (envelope.sessions || []).reduce((total, thread) => total + thread.messages.filter((message) => message.streaming).length, 0), 0),
        activeMount: Number(Boolean(readerMount)), activeReady: Boolean(readerMount?.ready), sections: readerSections.length,
        fontWaits: [...readerMounts.values()].filter((mount) => mount.cancelFontWait).length,
        fontTimers: window.__memoryFontTimers.active.size, fontCallbacks: window.__memoryFontTimers.manual.size,
        activeTranslations: state.translationCache.length, activeChat: state.chat.length, annotations: state.annotations.length, aiHighlights: state.aiHighlights.length,
        sentenceDocuments: Number(Boolean(readerSentenceState.doc)), sentencePairs: readerSentenceState.pairs.length,
        sentencePending: readerSentenceState.pendingTranslations.size, searchMatches: readerSearchState.matches.length,
        runningTranslations: [...state.translationRuns.values()].filter((run) => run.running).length,
        translationDocumentRefs: [...state.translationRuns.values()].filter((run) => run.document).length,
        translationMountRefs: [...state.translationRuns.values()].filter((run) => run.mount).length,
        imageLightboxTrigger: Number(Boolean(imageLightboxTrigger)), imageContextTrigger: Number(Boolean(imageContextTrigger)),
        previewNodes: document.querySelector('#quick-preview-content')?.childElementCount || 0,
        detachedDocuments: documents.filter((reference) => { const doc = reference.deref(); return doc && ![...readerMounts.values()].some((mount) => mount.frame.contentDocument === doc); }).length,
        liveDocuments: documents.filter((reference) => Boolean(reference.deref())).length,
        detachedDocumentNumbers: documents.flatMap((reference, index) => { const doc = reference.deref(); return doc && ![...readerMounts.values()].some((mount) => mount.frame.contentDocument === doc) ? [index + 1] : []; }),
        observedDocuments: documents.length,
      }),
    };
  }
`;
  const end = source.lastIndexOf('\n})();');
  assert.ok(end > 0);
  return source.slice(0, end) + injection + source.slice(end);
}

async function staticServer() {
  const root = path.join(__dirname, '..');
  const server = http.createServer((request, response) => {
    const filename = path.join(root, new URL(request.url, 'http://localhost').pathname === '/' ? 'web/index.html' : new URL(request.url, 'http://localhost').pathname);
    if (!filename.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    fs.readFile(filename, (error, bytes) => {
      if (error) { response.writeHead(404).end(); return; }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(filename)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(bytes);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.error(`[reader-memory] static server pid=${process.pid} port=${server.address().port}`);
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function signal(promise, label) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 15000); })]); }
  finally { clearTimeout(timer); }
}

(async () => {
  const server = requestedURL ? null : await staticServer();
  let session;
  let cdp;
  const pending = [];
  try {
    session = await launchManagedChromium();
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    const errors = [];
    const unexpected = [];
    const gates = new Map();
    const translations = new Map(ids.map((id) => [id, []]));
    page.on('pageerror', (error) => errors.push(error.message));
    const hold = (id) => {
      const seen = deferred(); const released = deferred(); const completed = deferred();
      const gate = { seen: seen.promise, release: released.resolve, wait: released.promise, signal: seen.resolve, done: completed.promise, finish: completed.resolve };
      gates.set(id, gate); pending.push(gate); return gate;
    };
    await page.addInitScript(() => {
      if (window !== window.top) return;
      window.__memoryHoldFonts = false;
      window.__memoryFontTimers = { active: new Set(), manual: new Map(), scheduled: 0, cleared: 0, fired: 0, gatedDocuments: 0 };
      let manualTimerId = 0;
      const setTimeout = window.setTimeout.bind(window);
      const clearTimeout = window.clearTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 600) return setTimeout(callback, delay, ...args);
        const counters = window.__memoryFontTimers;
        if (window.__memoryHoldFonts) {
          // Only this font-cancellation case uses a manual clock: CI scheduling
          // must not race a real 600ms deadline between protocol commands.
          const id = --manualTimerId;
          counters.manual.set(id, () => callback(...args));
          counters.active.add(id); counters.scheduled += 1;
          return id;
        }
        const id = setTimeout(() => { counters.active.delete(id); counters.fired += 1; callback(...args); }, delay);
        counters.active.add(id); counters.scheduled += 1;
        return id;
      };
      window.clearTimeout = (id) => {
        const counters = window.__memoryFontTimers;
        if (counters.active.delete(id)) counters.cleared += 1;
        counters.manual.delete(id);
        return id < 0 ? undefined : clearTimeout(id);
      };
      const originalFetch = window.fetch.bind(window);
      window.__memoryChatStream = { requests: 0, finish: null };
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string'? input : input?.url || '';
        if (!/\/api\/jobs\/[a-f]{16}\/chat$/u.test(url)) return originalFetch(input, init);
        window.__memoryChatStream.requests += 1;
        const question = JSON.parse(init.body).messages.at(-1).content;
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            const send = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            send({ delta: `Streaming fixture reply to ${question}. ` });
            window.__memoryChatStream.finish = () => {
              send({ result: { text: `Completed fixture reply to ${question}.`, model: 'memory-mock-stream'} });
              controller.close(); window.__memoryChatStream.finish = null;
            };
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8'} });
      };
    });
    await page.route('**/web/app.js', (route) => route.fulfill({ contentType: 'text/javascript', body: instrument(fs.readFileSync(process.env.MY_SCHOLAR_MEMORY_APP_FIXTURE || path.join(__dirname, '../web/app.js'), 'utf8')) }));
    await page.route('**/api/**', async (route) => {
      const request = route.request(); const pathname = new URL(request.url()).pathname; const method = request.method();
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs };
      else if (pathname === '/api/plugins' && route.request().method() === 'GET') payload = { plugins: [], drafts: [], previews: [] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { translation: { enabled: true, configured: true, profile_id: profile, target_language: '中文' }, chat: { enabled: true, configured: true } } } };
      else if (pathname === '/api/settings') payload = { appearance: { app_font: 'system', reader_font: 'academic', accent: 'amber' }, ai: {}, metadata: { auto_retrieve: false, online_lookup: false } };
      else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[pathname.split('/')[4]] };
      else if (/^\/api\/jobs\/[a-f]{16}(?:\/|$)/u.test(pathname)) {
        const [, id, endpoint = ''] = pathname.match(/^\/api\/jobs\/([a-f]{16})\/?(.*)$/u);
        assert.ok(ids.includes(id), 'Only synthetic fixture documents may be requested');
        if (endpoint === 'document.html') { await route.fulfill({ contentType: 'text/html', body: documentHTML(id) }); return; }
        if (endpoint === 'assets/images/fixture.png') { await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }); return; }
        if (endpoint === 'translations') payload = { translations: translations.get(id) };
        else if (endpoint === 'media-layout') payload = { media_layout: { version: 1, items: {} } };
        else if (endpoint === 'annotations') payload = { annotations: Array.from({ length: markers }, (_, index) => ({ id: `${id}-${index}`, block_id: `paragraph-${index * 7}`, quote: prose, start: 0, end: prose.length, page: Math.floor(index * 7 / 15) + 1, kind: 'highlight', color: '#ffd400', source: 'manual', surface: 'source', note: `Synthetic note ${index}` })) };
        else if (endpoint === 'notes') payload = { markdown: '' };
        else if (endpoint === 'auto-highlights') payload = { result: { status: 'mock', highlights: [] } };
        else if (endpoint === 'translate' && method === 'POST') {
          const gate = gates.get(id);
          if (gate) { gate.signal(); await gate.wait; }
          const body = request.postDataJSON();
          const result = { ...body, text: `Synthetic mocked translation ${body.block_id || 'hover'}`, profile_id: profile };
          if (body.block_id) translations.set(id, translations.get(id).filter((item) => item.block_id !== body.block_id).concat(result));
          payload = { result };
          await route.fulfill({ json: payload }); gate?.finish(); return;
        } else if (!endpoint) payload = jobs.find((job) => job.job_id === id);
        else unexpected.push(`${method} ${pathname}`);
      } else unexpected.push(`${method} ${pathname}`);
      await route.fulfill({ json: payload });
    });
    const tab = (id) => page.locator(`#document-tabs .document-tab[data-job-id="${id}"]`);
    const active = () => page.frameLocator('#html-preview');
    async function ready(id) {
      await page.waitForFunction(({ jobId, marks }) => {
        const doc = document.querySelector('#html-preview')?.contentDocument;
        return doc?.body?.dataset.fixtureJob === jobId && doc.querySelector('[data-block-id="paragraph-0"] > .paragraph-translate-trigger')
          && doc.querySelectorAll('mark[data-annotation-id]').length === marks && !document.querySelector('#reader-view').classList.contains('is-document-loading')
          && window.__readerMemory.counts().activeReady;
      }, { jobId: id, marks: markers });
      if (!baseline) assert.equal(await page.evaluate(() => window.__readerMemory.counts().fontTimers), 0, 'Loaded fonts must clear the fallback timer immediately');
    }
    async function open(id, wait = true) { await page.locator('[data-view="library-view"]').click(); await page.locator(`#library-view .library-row[data-job-id="${id}"]`).dblclick(); if (wait) await ready(id); }
    async function close(id) { await page.locator(`[data-close-job-id="${id}"]`).click(); await tab(id).waitFor({ state: 'detached' }); }
    async function closeAll() { for (const id of ids) if (await tab(id).count()) await close(id); await page.locator('#library-view.active-view').waitFor(); }
    async function settled() { await page.waitForTimeout(250); await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
    const snapshots = [];
    async function measure(label) {
      await settled();
      // WeakRef deref keeps a target alive for its current task. Separate every
      // census from GC and never store a Document, Element, Range or JSHandle.
      for (let pass = 0; pass < 3; pass += 1) { await cdp.send('HeapProfiler.collectGarbage'); await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0))); }
      const heap = await cdp.send('Runtime.getHeapUsage');
      const dom = await cdp.send('Memory.getDOMCounters');
      const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((item) => [item.name, item.value]));
      const counts = await page.evaluate(() => window.__readerMemory.counts());
      const result = { label, usedHeap: heap.usedSize, totalHeap: heap.totalSize, ...dom,
        metricDocuments: metrics.Documents, metricNodes: metrics.Nodes, metricListeners: metrics.JSEventListeners, counts };
      snapshots.push(result); console.log(`[reader-memory] ${JSON.stringify(result)}`);
      if (process.env.MY_SCHOLAR_MEMORY_HEAP_SNAPSHOT && counts.detachedDocuments && ['preview-closed', 'saved-chat-closed', 'final-reopened-closed'].includes(label)) {
        const filename = `${process.env.MY_SCHOLAR_MEMORY_HEAP_SNAPSHOT}-${label}.heapsnapshot`;
        const output = fs.openSync(filename, 'w');
        const writeChunk = ({ chunk }) => fs.writeSync(output, chunk);
        cdp.on('HeapProfiler.addHeapSnapshotChunk', writeChunk);
        try { await cdp.send('HeapProfiler.takeHeapSnapshot'); }
        finally { cdp.off('HeapProfiler.addHeapSnapshotChunk', writeChunk); fs.closeSync(output); }
        console.error(`[reader-memory] heap snapshot ${filename}`);
      }
      return result;
    }
    await page.goto(requestedURL || server.url, { waitUntil: 'networkidle' });
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await measure('initial');
    // One warmup absorbs styles, settings, annotations and translation UI caches.
    for (let round = 0; round < 4; round += 1) {
      for (const id of ids) await open(id);
      const opened = await measure(`round-${round}-open`);
      assert.equal(opened.counts.mounts, ids.length);
      assert.equal(await page.locator('iframe.reader-document-frame').count(), ids.length);
      // Close a background document, the active document, then the last tab.
      await close(ids[0]); await close(ids.at(-1)); await closeAll();
      const closed = await measure(`round-${round}-closed`);
      assert.equal(closed.counts.mounts, 0); assert.equal(closed.counts.open, 0);
      assert.equal(await page.locator('iframe.reader-document-frame').count(), 0);
    }
    await open(ids[0]);
    await active().locator('.cross-reference').first().click();
    await page.locator('#quick-preview-content img').waitFor();
    await close(ids[0]);
    await measure('preview-closed');

    await open(ids[0]);
    const hover = hold(ids[0]);
    const hoverSource = active().locator('[data-block-id="paragraph-2"]');
    await hoverSource.scrollIntoViewIfNeeded();
    await active().locator('body').evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await hoverSource.evaluate((node) => {
      const doc = node.ownerDocument; doc.getSelection().removeAllRanges();
      const text = [...node.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim()) || doc.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
      const range = doc.createRange(); range.selectNodeContents(text); const rect = range.getClientRects()[0];
      doc.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.x + 5, clientY: rect.y + rect.height / 2 }));
    });
    await signal(hover.seen, 'hover translation');
    await close(ids[0]);
    // Network is deliberately pending: inspect ownership separately from final GC.
    const hoverPending = (await measure('hover-pending')).counts;
    hover.release(); gates.delete(ids[0]); await signal(hover.done, 'hover completion');
    await measure('hover-completed-closed');

    await open(ids[0]); await open(ids[1]); await tab(ids[0]).click(); await ready(ids[0]);
    const full = hold(ids[0]);
    await page.locator('#full-translate-button').click({ modifiers: ['Alt'] });
    await signal(full.seen, 'full translation');
    await tab(ids[1]).click(); await ready(ids[1]); await close(ids[0]);
    const fullPending = (await measure('background-translation-pending')).counts;
    full.release(); gates.delete(ids[0]);
    await page.waitForFunction(() => window.__readerMemory.counts().runningTranslations === 0);
    await closeAll(); await measure('background-translation-completed-closed');
    await open(ids[0]);
    await page.locator('[data-panel="chat-panel"]').click();
    await page.locator('#chat-input').fill('saved memory question'); await page.locator('#chat-input').press('Enter');
    await page.locator('.chat-bubble.assistant').filter({ hasText: 'Streaming fixture reply' }).waitFor();
    await page.evaluate(() => window.__memoryChatStream.finish());
    await page.locator('.chat-bubble.assistant').filter({ hasText: 'Completed fixture reply to saved memory question.' }).waitFor();
    await closeAll(); await measure('saved-chat-closed');
    await open(ids[0]);
    await page.locator('.chat-bubble.assistant').filter({ hasText: 'Completed fixture reply to saved memory question.' }).waitFor();
    await page.locator('#chat-input').fill('pending memory question'); await page.locator('#chat-input').press('Enter');
    await page.locator('.chat-bubble.assistant').filter({ hasText: 'Streaming fixture reply to pending memory question.' }).waitFor();
    await closeAll(); const chatPending = (await measure('chat-pending')).counts;
    await open(ids[0]);
    await page.locator('.chat-bubble.assistant').filter({ hasText: 'Streaming fixture reply to pending memory question.' }).waitFor();
    assert.equal(await page.evaluate(() => window.__memoryChatStream.requests), 2, 'Reopening must reuse the running stream');
    await closeAll();
    await page.evaluate(() => window.__memoryChatStream.finish());
    await page.waitForFunction(() => window.__readerMemory.counts().chatStreaming === 0);
    await measure('background-chat-completed-closed');
    await open(ids[0]);
    await page.locator('.chat-bubble.assistant').filter({ hasText: 'Completed fixture reply to pending memory question.' }).waitFor();
    await closeAll();
    if (!baseline) {
      await page.evaluate(() => { window.__memoryHoldFonts = true; });
      const fontsBefore = await page.evaluate(() => ({ ...window.__memoryFontTimers, active: window.__memoryFontTimers.active.size }));
      await open(ids[0], false);
      await page.waitForFunction(() => window.__readerMemory.counts().fontWaits === 1);
      assert.equal(await page.evaluate(() => window.__memoryFontTimers.gatedDocuments), fontsBefore.gatedDocuments + 1, 'The restored Document must consume the controlled font promise');
      assert.equal(await page.evaluate(() => window.__readerMemory.counts().fontTimers), 1, 'Unresolved font readiness must exercise the timeout path');
      await close(ids[0]);
      const fontsClosed = await page.evaluate(() => ({ ...window.__memoryFontTimers, active: window.__memoryFontTimers.active.size }));
      assert.equal(fontsClosed.fired, fontsBefore.fired, 'Closing must cancel font waiting before the fallback timeout fires');
      assert.equal(fontsClosed.active, 0, 'Closing a reader must synchronously clear its font fallback timer');
      assert.equal(await page.evaluate(() => window.__memoryFontTimers.manual.size), 0, 'Closing must release the fallback callback, including its captured document');
      assert.ok(fontsClosed.cleared > fontsBefore.cleared);
      await page.evaluate(() => { window.__memoryHoldFonts = false; });
      await measure('pending-fonts-closed');
    }
    await open(ids[0]); await closeAll(); const final = await measure('final-reopened-closed');

    const closedRounds = snapshots.filter((sample) => /round-\d-closed/u.test(sample.label)).slice(1);
    const growth = { heap: closedRounds.at(-1).usedHeap - closedRounds[0].usedHeap, nodes: closedRounds.at(-1).nodes - closedRounds[0].nodes,
      documents: closedRounds.at(-1).documents - closedRounds[0].documents, listeners: closedRounds.at(-1).jsEventListeners - closedRounds[0].jsEventListeners };
    if (!baseline) {
      for (const key of ['translationCaches', 'mediaLayouts', 'chatSessions', 'translationRuns']) assert.equal(final.counts[key], 0, `Closed job cache retained: ${key}`);
      assert.equal(final.counts.detachedDocuments, 0, 'Closed reader Documents remain strongly reachable after completed work and GC');
      assert.equal(final.counts.translationDocumentRefs, 0); assert.equal(final.counts.translationMountRefs, 0);
      assert.equal(final.counts.sentenceDocuments, 0); assert.equal(final.counts.sentencePairs, 0); assert.equal(final.counts.searchMatches, 0);
      assert.equal(fullPending.translationDocumentRefs, 0, 'A closed background translation must use its source snapshot');
      assert.equal(fullPending.translationMountRefs, 0);
      assert.equal(chatPending.chatSessions, 1, 'Streaming chat must pin its envelope after close');
      assert.equal(chatPending.chatStreaming, 1);
      for (const sample of snapshots.filter((item) => item.label.endsWith('-closed'))) {
        assert.equal(sample.counts.detachedDocuments, 0, `Detached document at ${sample.label}`);
        for (const key of ['translationCaches', 'mediaLayouts', 'chatSessions', 'translationRuns']) assert.equal(sample.counts[key], 0, `${sample.label} retained ${key}`);
      }
      assert.equal(final.counts.previewNodes, 0);
      for (const key of ['activeTranslations', 'activeChat', 'annotations', 'aiHighlights']) assert.equal(final.counts[key], 0, `Active alias retained ${key}`);
      assert.ok(growth.heap < 1024 * 1024, `Post-GC heap grows across repeated closes: ${JSON.stringify(growth)}`);
      assert.ok(growth.nodes < 128 && growth.documents <= 0 && growth.listeners < 16, `DOM/listener growth across repeated closes: ${JSON.stringify(growth)}`);
    }
    assert.deepEqual(errors, [], 'Unexpected page errors'); assert.deepEqual(unexpected, [], 'Unexpected endpoint: no real AI or user data is permitted');
    console.log(JSON.stringify({ passed: true, baseline, syntheticOnly: true, mockedAI: true, documents: ids.length, paragraphs, markers, growth, hoverPending, fullPending, chatPending, snapshots }));
  } finally {
    pending.forEach((gate) => gate.release());
    try { if (cdp) await cdp.detach(); }
    finally {
      try { if (session) await session.close(); }
      finally { if (server) await server.close(); }
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
