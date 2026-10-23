'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2] || 'http://127.0.0.1:8766';
const storageKey = 'my-scholar-reading-locations-v1';
const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
const profile = 'reader-transition-fixture';
const prose = 'This synthetic paragraph describes a reproducible experiment and its observable reading behavior.';
const locations = Object.fromEntries(ids.map((id, index) => [id, {
  blockId: `paragraph-${index ? 50 : 30}`, page: 1, offsetPx: 24, offsetRatio: 0.2,
  blockHeight: 120, progress: index ? 0.6 : 0.4, generation: 'base', updatedAt: '2026-10-18T00:00:00.000Z',
}]));
const jobs = ids.map((id, index) => ({
  job_id: id, source_filename: `Synthetic transition ${index ? 'B' : 'A'}.pdf`, status: 'completed',
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

function documentHTML(id) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html { scroll-behavior: smooth; } body { margin: 0; }
    .reader-content { max-width: 720px; margin: auto; }
    p[data-block-id] { height: 120px !important; box-sizing: border-box; margin: 0 !important; padding: 12px; }
    figure { margin: 0; } img { display: block; width: 100%; height: auto; }
    .my-scholar-media-visual { width: var(--my-scholar-media-width, 100%); }
  </style></head><body data-fixture-job="${id}"><main class="reader-content"><section class="pdf-page" data-page="1">
    ${Array.from({ length: 80 }, (_, index) => `${index === 8 ? '<figure class="pdf-figure" data-block-id="transition-figure" data-page="1"><img width="720" height="400" src="assets/images/fixture.svg" alt="Synthetic transition figure"><figcaption>Figure: synthetic layout fixture.</figcaption></figure>' : ''}<p data-block-id="paragraph-${index}" data-page="1">${prose} Paragraph ${index}.</p>`).join('')}
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
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 12000);
    })]);
  } finally { clearTimeout(timer); }
}

(async () => {
  const session = await launchManagedChromium();
  const pendingGates = [];
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    const unexpected = [];
    const queues = new Map();
    const data = new Map(ids.map((id) => [id, { translations: [], width: 100 }]));
    page.on('pageerror', (error) => errors.push(error.message));
    const hold = (id, endpoint) => {
      const seen = deferred();
      const release = deferred();
      const done = deferred();
      const gate = { seen: seen.promise, release: release.resolve, done: done.promise, signal: seen.resolve, wait: release.promise, finish: done.resolve };
      const key = `${id}/${endpoint}`;
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push(gate);
      pendingGates.push(gate);
      return gate;
    };
    await page.addInitScript(({ storageKey: key, locations: saved }) => {
      if (window !== window.top) return;
      localStorage.setItem(key, JSON.stringify({ version: 1, locations: saved, lru: Object.keys(saved), lastActiveJobId: '' }));
      window.__transitionTrace = null;
      const sample = () => {
        const trace = window.__transitionTrace;
        if (trace?.running) {
          const frame = document.querySelector('#html-preview');
          let visible = Boolean(frame?.getBoundingClientRect().width && frame?.getBoundingClientRect().height);
          for (let node = frame; node && visible; node = node.parentElement) {
            const style = getComputedStyle(node);
            visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.001;
          }
          const doc = frame?.contentDocument;
          const target = doc?.querySelector(`[data-block-id="${trace.location.blockId}"]`);
          const rect = target?.getBoundingClientRect();
          trace.samples.push({ visible, job: doc?.body?.dataset.fixtureJob || '', y: doc?.defaultView?.scrollY || 0,
            error: rect ? rect.top + Math.min(rect.height, trace.location.offsetPx) : null });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { storageKey, locations });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs };
      else if (pathname === '/api/plugins' && route.request().method() === 'GET') payload = { plugins: [], drafts: [], previews: [] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: {
        translation: { enabled: true, configured: true, profile_id: profile, target_language: '中文' },
        chat: { enabled: false, configured: false },
      } } };
      else if (pathname === '/api/settings') payload = { appearance: { app_font: 'system', reader_font: 'academic', accent: 'amber' }, ai: {}, metadata: { auto_retrieve: false } };
      else if (pathname.match(/^\/api\/jobs\/([ab]{16})/u)) {
        const [, id, endpoint = ''] = pathname.match(/^\/api\/jobs\/([ab]{16})\/?(.*)$/u);
        const fixture = data.get(id);
        assert.ok(fixture, `Unexpected fixture job: ${id}`);
        const gate = queues.get(`${id}/${endpoint}`)?.shift();
        if (gate) { gate.signal(); await gate.wait; }
        if (endpoint === 'document.html') {
          await route.fulfill({ contentType: 'text/html', body: documentHTML(id) });
          gate?.finish();
          return;
        }
        if (endpoint === 'assets/images/fixture.svg') {
          await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="400"><rect width="720" height="400" fill="#b8cad8"/></svg>' });
          gate?.finish();
          return;
        }
        if (endpoint === 'translations') payload = { translations: fixture.translations };
        else if (endpoint === 'media-layout') payload = { media_layout: { version: 1, items: { 'transition-figure': { width_percent: fixture.width } } } };
        else if (endpoint === 'annotations') payload = { annotations: [] };
        else if (endpoint === 'notes') payload = { markdown: '' };
        else if (endpoint === 'auto-highlights') payload = { result: { status: 'mock', highlights: [] } };
        else if (endpoint === 'translate') {
          const body = route.request().postDataJSON();
          payload = { result: { ...body, text: 'Synthetic mocked translation.', profile_id: profile } };
        } else if (!endpoint) payload = jobs.find((job) => job.job_id === id);
        else unexpected.push(pathname);
        await route.fulfill({ json: payload });
        gate?.finish();
        return;
      } else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[pathname.split('/')[4]] };
      else if (pathname === '/api/parsing/providers') payload = { providers: [] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (/translate|chat|highlight/u.test(pathname)) unexpected.push(pathname);
      return route.fulfill({ json: payload });
    });

    const frames = (count) => page.evaluate((total) => new Promise((resolve) => {
      let left = total;
      const next = () => { if (--left <= 0) resolve(); else requestAnimationFrame(next); };
      requestAnimationFrame(next);
    }), count);
    const saved = (id) => page.evaluate(({ key, id: jobId }) => JSON.parse(localStorage.getItem(key)).locations[jobId], { key: storageKey, id });
    const tab = (id) => `#document-tabs .document-tab[data-job-id="${id}"]`;
    async function arm(id, selector = tab(id), event = 'click') {
      const location = await saved(id);
      await page.evaluate(({ id: jobId, location: position, selector: target, event: eventName }) => {
        document.addEventListener(eventName, function start(click) {
          if (!click.target.closest(target)) return;
          document.removeEventListener(eventName, start, true);
          window.__transitionTrace = { id: jobId, location: position, samples: [], running: true };
        }, true);
      }, { id, location, selector, event });
    }
    async function checkTrace(label) {
      await page.waitForFunction(() => window.__transitionTrace?.samples.some((sample) => sample.visible));
      await frames(80);
      const trace = await page.evaluate(() => { window.__transitionTrace.running = false; return window.__transitionTrace; });
      const visible = trace.samples.filter((sample) => sample.visible);
      assert.ok(visible.length > 0, `${label}: no visible frame`);
      const bad = visible.filter((sample) => sample.job !== trace.id || sample.error === null || Math.abs(sample.error) > 3 || sample.y < 500);
      assert.deepEqual(bad.slice(0, 8), [], `${label}: visible content must already be at the saved location; first=${JSON.stringify(visible[0])}`);
      const ys = visible.map((sample) => sample.y);
      assert.ok(Math.max(...ys) - Math.min(...ys) <= 3, `${label}: visible reader scrolled during reveal (${Math.min(...ys)} → ${Math.max(...ys)})`);
      return visible.length;
    }
    async function assertHidden(label) {
      await frames(12);
      const samples = await page.evaluate(() => window.__transitionTrace?.samples || []);
      assert.equal(samples.some((sample) => sample.visible), false, `${label}: unfinished document became visible`);
    }
    async function closeTab(id) {
      await page.locator(`[data-close-job-id="${id}"]`).click();
      await page.locator(tab(id)).waitFor({ state: 'detached' });
    }
    async function switchTab(id, label) {
      await arm(id);
      await page.locator(tab(id)).click();
      return checkTrace(label);
    }

    await page.goto(baseURL, { waitUntil: 'networkidle' });
    const aRow = `#library-view .library-row[data-job-id="${ids[0]}"]`;
    await page.locator(aRow).waitFor();
    await arm(ids[0], aRow, 'dblclick');
    await page.locator(aRow).dblclick();
    await checkTrace('initial saved A');
    const originalFigureHeight = await page.frameLocator('#html-preview').locator('figure').evaluate((node) => node.getBoundingClientRect().height);
    await page.locator('[data-view="library-view"]').click();
    await page.locator('#library-view.active-view').waitFor();
    await switchTab(ids[0], 'home to saved A');

    await page.locator('[data-view="library-view"]').click();
    const bRow = `#library-view .library-row[data-job-id="${ids[1]}"]`;
    const image = hold(ids[1], 'assets/images/fixture.svg');
    await arm(ids[1], bRow, 'dblclick');
    await page.locator(bRow).dblclick();
    await signal(image.seen, 'delayed initial image request');
    await assertHidden('initial image load pending');
    image.release();
    await signal(image.done, 'delayed initial image completion');
    await checkTrace('initial saved B with delayed image');
    await switchTab(ids[0], 'B to A');
    await switchTab(ids[1], 'A to B');

    const beforeRace = await saved(ids[0]);
    await closeTab(ids[0]);
    const obsolete = hold(ids[0], 'translations');
    await page.locator('[data-view="library-view"]').click();
    await arm(ids[0], aRow, 'dblclick');
    await page.locator(aRow).dblclick();
    await signal(obsolete.seen, 'first A translations');
    await assertHidden('first A load');
    await switchTab(ids[1], 'cancel A for B');
    await closeTab(ids[0]);
    const current = hold(ids[0], 'translations');
    const media = hold(ids[0], 'media-layout');
    data.get(ids[0]).translations = Array.from({ length: 6 }, (_, index) => ({
      block_id: `paragraph-${index}`, source_text: `${prose} Paragraph ${index}.`,
      text: '这是用于验证缓存译文改变文档高度的合成段落。'.repeat(30), profile_id: profile, target_language: '中文',
    }));
    data.get(ids[0]).width = 45;
    await page.locator('[data-view="library-view"]').click();
    await arm(ids[0], aRow, 'dblclick');
    await page.locator(aRow).dblclick();
    await signal(Promise.all([current.seen, media.seen]), 'new A translations and media');
    obsolete.release();
    await signal(obsolete.done, 'obsolete A response');
    await assertHidden('obsolete A response while new A still waits');
    const duringRace = await saved(ids[0]);
    for (const field of ['blockId', 'offsetPx', 'offsetRatio', 'blockHeight']) {
      assert.equal(duringRace[field], beforeRace[field], `Unfinished mounts overwrote saved ${field}`);
    }
    current.release();
    await signal(current.done, 'new A translations response');
    await assertHidden('translations finished but media layout pending');
    media.release();
    await signal(media.done, 'new A media response');
    await checkTrace('A with delayed translations and media layout');
    const frame = page.frameLocator('#html-preview');
    assert.equal(await frame.locator('.my-scholar-translation').count(), 6, 'Delayed cache must change document structure');
    assert.equal(await frame.locator('[data-media-key="transition-figure"]').getAttribute('data-media-width'), '45');
    assert.ok(await frame.locator('figure').evaluate((node) => node.getBoundingClientRect().height) < originalFigureHeight - 50,
      'Delayed media layout must change geometry above the saved position');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-view="library-view"]').click();
    await switchTab(ids[0], 'reduced motion home to A');
    await switchTab(ids[1], 'reduced motion A to B');
    assert.deepEqual(errors, [], 'Unexpected page errors');
    assert.deepEqual(unexpected, [], 'Unexpected AI or fixture endpoint');
    console.log(JSON.stringify({ passed: true, syntheticOnly: true, mockedAI: true, cases: [
      'home-first-visible-frame-at-saved-location', 'top-tabs-independent-locations',
      'A-B-A-obsolete-load-isolation', 'unfinished-mount-preserves-location',
      'delayed-cache-and-media-before-reveal', 'image-load-before-reveal', 'smooth-document-no-visible-scroll', 'reduced-motion',
    ] }));
  } finally {
    pendingGates.forEach((gate) => gate.release());
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
