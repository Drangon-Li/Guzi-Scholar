'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
const profile = 'reader-keepalive-fixture';
const prose = 'This synthetic paragraph explains a controlled experiment with observable and reproducible reading behavior.';
const jobs = ids.map((id, index) => ({
  job_id: id, source_filename: `Synthetic keepalive ${index ? 'B' : 'A'}.pdf`, status: 'completed',
  created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z',
  links: { html: `/api/jobs/${id}/document.html` }, manifest: { counts: { pages: 1, images: 1 } },
}));
const library = {
  folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] },
  items: Object.fromEntries(ids.map((id) => [id, {
    folder_ids: [], values: { reading_status: '阅读中', importance: 0, research_topic: [] },
    metadata: { fields: {}, status: 'complete' }, created_at: jobs[0].created_at, updated_at: jobs[0].updated_at,
  }])),
};

function documentHTML(id, generation, revision) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; } .reader-content { max-width: 720px; margin: auto; }
    p[data-block-id] { min-height: 340px; margin: 0; padding: 12px; box-sizing: border-box; }
    img { display: block; width: 100%; height: auto; } figure { margin: 0; }
    img.math-source-inline { display: inline; width: 24px; height: 12px; }
  </style></head><body data-fixture-job="${id}" data-generation="${generation}" data-source-revision="${revision}"><main class="reader-content"><section class="pdf-page" data-page="1">
    <h2 data-block-id="heading" data-page="1">Synthetic generation ${generation}</h2>
    <details id="body-details"><summary>Experimental details</summary><div>Native expanded reading state.</div></details>
    <figure class="pdf-figure" data-block-id="fixture-figure" data-page="1"><img width="720" height="240" src="/api/jobs/${id}/assets/images/fixture.svg" alt="Synthetic keepalive figure"><figcaption>Synthetic figure.</figcaption></figure>
    ${Array.from({ length: 6 }, (_, index) => `<p data-block-id="paragraph-${index}" data-page="1">${prose} Document ${id[0].toUpperCase()}, paragraph ${index}. Source revision ${revision}.${index === 1 ? `<span class="math-source-visual"><img class="math-source-inline" src="/api/jobs/${id}/assets/images/inline.png" alt="x + y" data-height-em="1"></span>` : ''}</p>`).join('')}
  </section></main></body></html>`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function signal(promise, label) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

(async () => {
  const session = await launchManagedChromium();
  const pending = [];
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    const unexpected = [];
    const requests = [];
    const gates = new Map();
    const fullCompleted = deferred();
    let activeProfile = profile;
    const data = new Map(ids.map((id) => [id, { translations: [], width: 100, revision: 'original' }]));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (window === window.top) { window.__keepaliveRefs = {}; return; }
      window.__documentBindings = {};
      const add = Document.prototype.addEventListener;
      Document.prototype.addEventListener = function (type, listener, options) {
        window.__documentBindings[type] = (window.__documentBindings[type] || 0) + 1;
        return add.call(this, type, listener, options);
      };
    });
    const hold = (id, endpoint, method = 'GET') => {
      const seen = deferred();
      const released = deferred();
      const done = deferred();
      const gate = { seen: seen.promise, signal: seen.resolve, wait: released.promise,
        release: released.resolve, done: done.promise, finish: done.resolve };
      gates.set(`${method}:${id}/${endpoint}`, gate);
      pending.push(gate);
      return gate;
    };
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs };
      else if (pathname === '/api/plugins' && route.request().method() === 'GET') payload = { plugins: [], drafts: [], previews: [] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: {
        translation: { enabled: true, configured: true, profile_id: activeProfile, target_language: '中文' },
        chat: { enabled: false, configured: false },
      } } };
      else if (pathname === '/api/settings') {
        if (method === 'POST') {
          activeProfile = `${profile}-changed`;
          payload = { settings: request.postDataJSON() };
        } else payload = { appearance: { app_font: 'system', reader_font: 'academic', accent: 'amber' }, ai: {}, metadata: { auto_retrieve: false } };
      }
      else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[pathname.split('/')[4]] };
      else if (/^\/api\/jobs\/[ab]{16}(?:\/|$)/u.test(pathname)) {
        const [, id, endpoint = ''] = pathname.match(/^\/api\/jobs\/([ab]{16})\/?(.*)$/u);
        const fixture = data.get(id);
        const job = jobs.find((item) => item.job_id === id);
        const body = method === 'POST' || method === 'PATCH' ? request.postDataJSON() : null;
        requests.push({ id, endpoint, method, body });
        const gate = gates.get(`${method}:${id}/${endpoint}`);
        if (gate) { gate.signal(); await gate.wait; }
        if (/^(?:renders\/\d+\/)?document\.html$/u.test(endpoint)) {
          const generation = endpoint.match(/^renders\/(\d+)/u)?.[1] || 'base';
          await route.fulfill({ contentType: 'text/html', body: documentHTML(id, generation, fixture.revision) });
          gate?.finish();
          return;
        }
        if (endpoint === 'assets/images/fixture.svg') {
          await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="240"><rect width="720" height="240" fill="#b8cad8"/></svg>' });
          gate?.finish();
          return;
        }
        if (endpoint === 'assets/images/inline.png') {
          await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64') });
          gate?.finish();
          return;
        }
        if (endpoint === 'translations') payload = { translations: fixture.translations };
        else if (endpoint === 'media-layout') {
          if (method === 'PATCH') fixture.width = body.items['fixture-figure'].width_percent;
          payload = { media_layout: { version: 1, items: { 'fixture-figure': { width_percent: fixture.width } } } };
        } else if (endpoint === 'annotations') payload = { annotations: [] };
        else if (endpoint === 'notes') payload = { markdown: '' };
        else if (endpoint === 'auto-highlights') payload = { result: { status: 'mock', highlights: [] } };
        else if (endpoint === 'translate') {
          const revision = body.text.match(/Source revision ([a-z-]+)\./u)?.[1] || 'hover';
          const text = `${id[0].toUpperCase()} mocked translation for ${body.block_id || 'hover'}. Source revision ${revision}. ${(body.formulas || []).map((formula) => formula.token).join(' ')}`.trim();
          const segments = body.segments?.map((segment, index) => ({ ...segment, text: index ? `合成续句 ${index}。` : text }));
          const record = { ...body, text: segments ? segments.map((segment) => segment.text).join(' ') : text, ...(segments ? { segments } : {}), profile_id: activeProfile };
          fixture.translations = fixture.translations.filter((item) => item.block_id !== record.block_id).concat(record);
          if (id === ids[0] && fixture.translations.filter((item) => /^paragraph-/u.test(item.block_id || '')).length === 6) fullCompleted.resolve();
          payload = { result: record };
        } else if (endpoint === 'reflow' && method === 'POST') {
          job.reflow = { status: 'running', progress: 10, generation: String(Number(job.reflow?.generation || 0) + 1) };
          payload = job;
        } else if (!endpoint) payload = job;
        else unexpected.push(`${method} ${pathname}`);
        await route.fulfill({ json: payload });
        gate?.finish();
        return;
      } else unexpected.push(`${method} ${pathname}`);
      await route.fulfill({ json: payload });
    });

    const [a, b] = ids;
    const tab = (id) => page.locator(`#document-tabs .document-tab[data-job-id="${id}"]`);
    const active = () => page.frameLocator('#html-preview');
    const count = (id, endpoint, method = 'GET') => requests.filter((item) => item.id === id && item.endpoint === endpoint && item.method === method).length;
    async function ready(id, generation = null) {
      await page.waitForFunction(({ jobId, gen }) => {
        const frame = document.querySelector('#html-preview');
        const doc = frame?.contentDocument;
        return doc?.body?.dataset.fixtureJob === jobId
          && (!gen || doc.body.dataset.generation === gen)
          && doc.querySelector('[data-block-id="paragraph-0"] > .paragraph-translate-trigger')
          && !document.querySelector('#reader-view').classList.contains('is-document-loading');
      }, { jobId: id, gen: generation });
    }
    async function open(id, wait = true) {
      await page.locator('[data-view="library-view"]').click();
      await page.locator(`#library-view .library-row[data-job-id="${id}"]`).dblclick();
      if (wait) await ready(id);
    }
    async function activate(id) { await tab(id).click(); await ready(id); }
    async function close(id) {
      await page.locator(`[data-close-job-id="${id}"]`).click();
      await tab(id).waitFor({ state: 'detached' });
    }
    async function remember(id, key = id) {
      await page.evaluate(({ id: jobId, key: refKey }) => {
        const frame = document.querySelector('#html-preview');
        const doc = frame.contentDocument;
        window.__keepaliveRefs[refKey] = { frame, doc, node: doc.querySelector('[data-block-id="paragraph-0"]'),
          translation: doc.querySelector('.my-scholar-translation'), y: doc.defaultView.scrollY,
          width: doc.querySelector('[data-media-key="fixture-figure"]').dataset.mediaWidth,
          expanded: doc.querySelector('#body-details').open,
          bindings: JSON.stringify(doc.defaultView.__documentBindings), jobId };
      }, { id, key });
    }
    async function preserved(key, { viewport = true } = {}) {
      const result = await page.evaluate(({ key: refKey, viewport: checkViewport }) => {
        const old = window.__keepaliveRefs[refKey];
        const frame = document.querySelector('#html-preview');
        const doc = frame?.contentDocument;
        return { frame: frame === old.frame, document: doc === old.doc,
          node: doc?.querySelector('[data-block-id="paragraph-0"]') === old.node,
          translation: doc?.querySelector('.my-scholar-translation') === old.translation,
          y: !checkViewport || Math.abs(doc.defaultView.scrollY - old.y) <= 2,
          width: doc?.querySelector('[data-media-key="fixture-figure"]')?.dataset.mediaWidth === old.width,
          expanded: doc?.querySelector('#body-details')?.open === old.expanded,
          bindings: JSON.stringify(doc?.defaultView.__documentBindings) === old.bindings };
      }, { key, viewport });
      const scroll = await page.evaluate((refKey) => ({ before: window.__keepaliveRefs[refKey].y, after: document.querySelector('#html-preview')?.contentWindow.scrollY }), key);
      assert.deepEqual(result, Object.fromEntries(Object.keys(result).map((field) => [field, true])), `State lost for ${key}; scroll=${JSON.stringify(scroll)}`);
    }
    async function structure(expectedFrames) {
      const actual = await page.evaluate(() => [...document.querySelectorAll('iframe.reader-document-frame')].map((frame) => ({
        active: frame.id === 'html-preview', hidden: getComputedStyle(frame).visibility === 'hidden', inert: frame.inert,
      })));
      assert.equal(actual.length, expectedFrames, 'One resident frame per open document');
      assert.equal(actual.filter((frame) => frame.active).length, expectedFrames ? 1 : 0, 'Unique active frame id');
      actual.filter((frame) => !frame.active).forEach((frame) => assert.ok(frame.hidden && frame.inert, 'Background frames must be hidden and inert'));
    }
    async function discarded(key) {
      assert.equal(await page.evaluate((refKey) => window.__keepaliveRefs[refKey].frame.isConnected, key), false, `Closed/reflowed frame retained: ${key}`);
    }
    async function translateParagraph(index) {
      await active().locator(`[data-block-id="paragraph-${index}"] > .paragraph-translate-trigger`).click({ force: true });
    }
    async function startReflow(id) {
      const before = count(id, 'reflow', 'POST');
      await page.locator('#reflow-button').click();
      await page.locator('#confirm-dialog[open]').waitFor();
      await Promise.all([page.waitForResponse((response) => response.url().endsWith(`/api/jobs/${id}/reflow`) && response.request().method() === 'POST'), page.locator('#confirm-accept').click()]);
      await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open);
      assert.equal(count(id, 'reflow', 'POST'), before + 1);
    }
    function completeReflow(id) {
      const job = jobs.find((item) => item.job_id === id);
      job.reflow = { ...job.reflow, status: 'completed', progress: 100,
        document_url: `/api/jobs/${id}/renders/${job.reflow.generation}/document.html` };
    }

    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await open(a);
    await active().locator('#body-details summary').click();
    await translateParagraph(0);
    await active().locator('.my-scholar-translation[data-for="paragraph-0"]:not(.is-pending)').filter({ hasText: 'A mocked translation' }).waitFor();
    await active().locator('.my-scholar-media-resize-handle.is-right').press('Shift+ArrowLeft');
    await active().locator('[data-media-key="fixture-figure"]').evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    await active().locator('body').evaluate(() => scrollTo(0, 1100));
    await page.waitForFunction(() => document.querySelector('#html-preview').contentWindow.scrollY >= 1000);
    await remember(a);
    const aResources = [count(a, 'document.html'), count(a, 'assets/images/fixture.svg'), count(a, 'assets/images/inline.png')];
    assert.deepEqual(aResources, [1, 1, 1], 'Opening and translating A duplicated document resources');
    await open(b);
    await remember(b);
    const bResources = [count(b, 'document.html'), count(b, 'assets/images/fixture.svg'), count(b, 'assets/images/inline.png')];
    assert.deepEqual(bResources, [1, 1, 1], 'Opening B duplicated document resources');
    for (let index = 0; index < 4; index += 1) {
      await activate(a); await preserved(a);
      await activate(b); await preserved(b);
    }
    await activate(a);
    for (const width of [1450, 760]) {
      await page.setViewportSize({ width, height: 940 });
      // The media-query change handler can run after setViewportSize resolves.
      await page.waitForFunction((wide) => document.querySelector('#assistant-toggle').getAttribute('aria-expanded') === String(wide), width > 880);
      if (await page.locator('#assistant-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#assistant-toggle').click();
      await page.waitForFunction(() => document.querySelector('#reader-sidebar').classList.contains('is-open'));
      for (const destination of ['settings-view', 'library-view']) {
        await page.locator(`[data-view="${destination}"]`).click();
        const parked = await page.locator('#reader-view').evaluate((view) => ({
          opacity: getComputedStyle(view).opacity, inert: view.inert, ariaHidden: view.getAttribute('aria-hidden'),
          width: view.getBoundingClientRect().width, height: view.getBoundingClientRect().height,
          sidebarOpen: view.querySelector('#reader-sidebar').classList.contains('is-open'),
          hitIsReader: Boolean(document.elementFromPoint(30, 300)?.closest('#reader-view')),
        }));
        assert.equal(parked.opacity, '0', `Open reader assistant leaked into ${destination} at ${width}px`);
        assert.equal(parked.inert, true);
        assert.equal(parked.ariaHidden, 'true');
        assert.equal(parked.sidebarOpen, true, `Parking must preserve expanded assistant state in ${destination} at ${width}px`);
        assert.ok(parked.width > 0 && parked.height > 0, 'Parked iframe viewport must retain its dimensions');
        assert.equal(parked.hitIsReader, false, 'Parked assistant must not intercept destination interactions');
        await activate(a);
        await preserved(a, { viewport: false });
        assert.equal(await page.locator('#reader-view').evaluate((view) => getComputedStyle(view).opacity), '1');
        assert.equal(await page.locator('#assistant-toggle').getAttribute('aria-expanded'), 'true');
      }
    }
    await page.setViewportSize({ width: 1450, height: 940 });
    await remember(a);
    await page.locator('[data-view="library-view"]').click();
    await activate(a);
    await preserved(a);
    await structure(2);
    assert.deepEqual([count(a, 'document.html'), count(a, 'assets/images/fixture.svg'), count(a, 'assets/images/inline.png')], aResources, 'Warm A switches requested resources');
    assert.deepEqual([count(b, 'document.html'), count(b, 'assets/images/fixture.svg'), count(b, 'assets/images/inline.png')], bResources, 'Warm B switches requested resources');

    const hoverBefore = count(a, 'translate', 'POST');
    const hoverSource = active().locator('[data-block-id="paragraph-2"]');
    await hoverSource.scrollIntoViewIfNeeded();
    await active().locator('body').evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await hoverSource.evaluate((node) => {
      const doc = node.ownerDocument;
      doc.getSelection().removeAllRanges();
      const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      const range = doc.createRange(); range.selectNodeContents(text);
      const rect = range.getClientRects()[0];
      doc.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.x + 5, clientY: rect.y + rect.height / 2 }));
    });
    await page.locator('#selection-popover:not([hidden])').filter({ hasText: 'A mocked translation' }).waitFor();
    assert.equal(count(a, 'translate', 'POST') - hoverBefore, 1, 'Hover dispatched duplicate translation requests');
    const paragraphBefore = count(a, 'translate', 'POST');
    await translateParagraph(1);
    await active().locator('.my-scholar-translation[data-for="paragraph-1"]:not(.is-pending)').filter({ hasText: 'A mocked translation' }).waitFor();
    const inlineFormula = active().locator('.my-scholar-translation[data-for="paragraph-1"] img.math-source-inline');
    await inlineFormula.waitFor();
    await inlineFormula.evaluate((image) => image.decode());
    assert.deepEqual(requests.find((item) => item.id === a && item.endpoint === 'translate' && item.body.block_id === 'paragraph-1').body.formulas,
      [{ token: '__MY_SCHOLAR_MATH_0__', tex: '[公式原图]' }], 'Inline formula extraction lost its source image');
    assert.equal(count(a, 'translate', 'POST') - paragraphBefore, 1, 'Paragraph control dispatched duplicate requests');
    assert.equal(await active().locator('[data-block-id="paragraph-1"] > .paragraph-translate-trigger').count(), 1);

    const paragraphGate = hold(a, 'translate', 'POST');
    await translateParagraph(3);
    await signal(paragraphGate.seen, 'background paragraph start');
    await activate(b);
    paragraphGate.release();
    await signal(paragraphGate.done, 'background paragraph completion');
    assert.equal(await active().locator('.my-scholar-translation').count(), 0, 'A paragraph leaked into B');
    await activate(a);
    await active().locator('.my-scholar-translation[data-for="paragraph-3"]:not(.is-pending)').filter({ hasText: 'A mocked translation' }).waitFor();

    const fullGate = hold(a, 'translate', 'POST');
    await page.locator('#full-translate-button').click();
    await signal(fullGate.seen, 'full translation start');
    await activate(b);
    fullGate.release();
    await signal(fullCompleted.promise, 'background full translation completion');
    assert.equal(await active().locator('.my-scholar-translation').count(), 0, 'Full translation leaked into B while completing');
    await activate(a);
    await page.waitForFunction(() => {
      const doc = document.querySelector('#html-preview').contentDocument;
      const translated = [...doc.querySelectorAll('.my-scholar-translation:not(.is-pending):not(.is-error)')];
      return new Set(translated.map((node) => node.dataset.for)).size === 6
        && !doc.querySelector('.my-scholar-translation.is-pending, .my-scholar-translation.is-error');
    });
    assert.equal(await active().locator('.my-scholar-translation').filter({ hasText: 'B mocked translation' }).count(), 0);
    await activate(b);
    assert.equal(await active().locator('.my-scholar-translation').count(), 0, 'Full translation leaked into B');

    await close(a);
    await discarded(a);
    const loading = hold(a, 'translations');
    await open(a, false);
    await signal(loading.seen, 'initial A cache load');
    await tab(b).click(); await ready(b); await preserved(b);
    await tab(a).click();
    await tab(b).click(); await ready(b);
    loading.release();
    await signal(loading.done, 'background initial A cache completion');
    await ready(b); await preserved(b);
    await activate(a);
    assert.equal(await page.evaluate((id) => document.querySelector('#html-preview').contentDocument !== window.__keepaliveRefs[id].doc, a), true, 'Reopen reused closed Document');
    await remember(a, 'reopened-a');
    await structure(2);
    assert.equal(count(a, 'document.html'), aResources[0] + 1, 'Pending A switches restarted navigation');

    const activeReflow = hold(a, '');
    await startReflow(a);
    await signal(activeReflow.seen, 'active reflow polling');
    completeReflow(a); activeReflow.release();
    await ready(a, '1');
    await discarded('reopened-a');
    await remember(a, 'reflow-a');
    await structure(2);
    await activate(b);
    const backgroundReflow = hold(b, '');
    await startReflow(b);
    await signal(backgroundReflow.seen, 'background reflow polling');
    await activate(a);
    completeReflow(b); backgroundReflow.release();
    await signal(backgroundReflow.done, 'background reflow completion');
    await page.waitForFunction(() => !window.__keepaliveRefs.bbbbbbbbbbbbbbbb.frame.isConnected);
    await preserved('reflow-a');
    await activate(b); await ready(b, '1');
    await discarded(b);
    await remember(b, 'reflow-b');
    await structure(2);
    assert.equal(count(a, 'renders/1/document.html'), 1);
    assert.equal(count(b, 'renders/1/document.html'), 1);

    await close(a);
    await discarded('reflow-a');
    await ready(b); await structure(1);
    await open(a);
    await remember(a, 'last-a');
    await close(a);
    await discarded('last-a');
    await ready(b); await structure(1);
    await close(b);
    await discarded('reflow-b');
    await page.locator('#library-view.active-view').waitFor();
    await structure(0);
    await open(b);
    assert.equal(await page.evaluate(() => document.querySelector('#html-preview').contentDocument !== window.__keepaliveRefs['reflow-b'].doc), true);
    await structure(1);

    await remember(b, 'full-before-reopen');
    const fullAcrossReopen = hold(b, 'translate', 'POST');
    await page.locator('#full-translate-button').click({ modifiers: ['Alt'] });
    await signal(fullAcrossReopen.seen, 'full translation before close');
    await close(b);
    await discarded('full-before-reopen');
    data.get(b).revision = 'after-reopen';
    await open(b);
    assert.equal(await active().locator('body').getAttribute('data-source-revision'), 'after-reopen');
    assert.equal(await active().locator('.my-scholar-translation').count(), 0, 'Reopened source inherited pending old translations');
    assert.equal(await page.locator('#full-translate-button').isDisabled(), true, 'Closing must preserve the old background translation run');
    fullAcrossReopen.release();
    await page.waitForFunction(() => !document.querySelector('#full-translate-button').disabled);
    assert.equal(requests.filter((item) => item.id === b && item.endpoint === 'translate' && item.body.text.includes('Source revision original.')).length, 6,
      'The old run must finish every original source snapshot after reopening');
    assert.equal(await active().locator('.my-scholar-translation').count(), 0,
      'Old full translation wrote into a reopened Document with reused block ids and different source text');
    await remember(b, 'full-before-reflow');

    const fullAcrossReflow = hold(b, 'translate', 'POST');
    await page.locator('#full-translate-button').click({ modifiers: ['Alt'] });
    await signal(fullAcrossReflow.seen, 'full translation before reflow');
    const reflowDuringFull = hold(b, '');
    await startReflow(b);
    await signal(reflowDuringFull.seen, 'reflow while full translation is pending');
    data.get(b).revision = 'after-reflow';
    completeReflow(b); reflowDuringFull.release();
    await ready(b, '2');
    await discarded('full-before-reflow');
    assert.equal(await active().locator('body').getAttribute('data-source-revision'), 'after-reflow');
    assert.equal(await active().locator('.my-scholar-translation').count(), 0, 'Reflowed source inherited pending old translations');
    fullAcrossReflow.release();
    await page.waitForFunction(() => !document.querySelector('#full-translate-button').disabled);
    assert.equal(requests.filter((item) => item.id === b && item.endpoint === 'translate' && item.body.text.includes('Source revision after-reopen.')).length, 6,
      'The old run must finish every original source snapshot after reflow');
    assert.equal(await active().locator('.my-scholar-translation').count(), 0,
      'Old full translation wrote into a new reflow generation with reused block ids and different source text');
    await structure(1);

    await open(a);
    assert.equal(await active().locator('.my-scholar-translation').evaluateAll((nodes) => new Set(nodes.map((node) => node.dataset.for)).size), 6, 'Profile case needs rendered A translations');
    await remember(a, 'profile-a');
    await activate(b);
    await page.locator('[data-view="settings-view"]').click();
    await page.locator('.settings-navigation a[href="#settings-ai"]').click();
    const translationsBeforeProfileChange = requests.filter((item) => item.endpoint === 'translate').length;
    const changedHealth = page.waitForResponse((response) => response.url().endsWith('/api/health'));
    await page.locator('#setting-translation-model').fill('keepalive-new-model');
    assert.equal((await (await changedHealth).json()).ai.services.translation.profile_id, `${profile}-changed`);
    assert.equal(await page.evaluate(() => {
      const ref = window.__keepaliveRefs['profile-a'];
      return ref.doc.querySelector('.my-scholar-translation') === ref.translation && ref.translation.isConnected;
    }), true, 'Profile change must preserve existing background translation nodes');
    await activate(a);
    assert.equal(await active().locator('.my-scholar-translation').evaluateAll((nodes) => new Set(nodes.map((node) => node.dataset.for)).size), 6, 'Profile change must retain all previously translated paragraphs');
    assert.equal(await active().locator('.my-scholar-translation').evaluateAll((nodes, oldProfile) => nodes.every((node) => node.dataset.profileId === oldProfile), profile), true, 'Retained translations must preserve their original engine provenance');
    assert.equal(requests.filter((item) => item.endpoint === 'translate').length, translationsBeforeProfileChange, 'Profile change must not automatically retranslate background papers');
    assert.equal(await page.evaluate(() => document.querySelector('#html-preview').contentDocument === window.__keepaliveRefs['profile-a'].doc), true,
      'Profile change must preserve the resident Document');
    await structure(2);
    assert.deepEqual(errors, [], 'Unexpected page errors');
    assert.deepEqual(unexpected, [], 'Unexpected endpoint: synthetic tests must never call real AI');
    console.log(JSON.stringify({ passed: true, syntheticOnly: true, mockedAI: true, cases: [
      'A-B-A-and-home-preserve-document-node-scroll-translation-media-details', 'no-warm-resource-requests',
      'expanded-assistant-settings-library-return-wide-and-narrow',
      'no-duplicate-hover-or-paragraph-handlers', 'background-paragraph-and-full-translation-isolation',
      'pending-initial-load-switch-isolation', 'close-background-active-last-and-reopen', 'active-and-background-reflow-invalidate-generation',
      'pending-full-translation-cannot-write-into-reopened-or-reflowed-document', 'profile-change-preserves-background-translations-and-provenance',
    ] }));
  } finally {
    pending.forEach((gate) => gate.release());
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
