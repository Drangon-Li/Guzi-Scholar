'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const baseline = process.argv.includes('--baseline');
const requestedURL = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
const profile = 'reader-switch-performance-fixture';
const paragraphs = 360;
const annotationCount = 48;
const translationCount = 24;
const sentence = 'This synthetic paragraph explains a controlled experiment with observable and reproducible reading behavior.';
const paragraph = (id, index) => `${sentence} Document ${id[0].toUpperCase()}, paragraph ${index}. We measure resident document switching while preserving annotations and translations. The selected evidence remains attached to the original source text. Repeated observations expose unnecessary traversal over a complete paper. A warm reader should retain its sentence ranges and all persistent marks. Readers can continue at the same position without fetching another document. This fixture contains no external service requests.`;
const jobs = ids.map((id, index) => ({
  job_id: id, source_filename: `Synthetic long paper ${index ? 'B' : 'A'}.pdf`, status: 'completed',
  created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z',
  links: { html: `/api/jobs/${id}/document.html` }, manifest: { counts: { pages: 24, images: 0 } },
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
    body { margin: 0; } .reader-content { max-width: 720px; margin: auto; }
    p[data-block-id] { min-height: 110px; margin: 0; padding: 12px; box-sizing: border-box; }
  </style></head><body data-fixture-job="${id}"><main class="reader-content">
  ${Array.from({ length: 24 }, (_, section) => `<section class="pdf-page" data-page="${section + 1}">
    <h2 data-block-id="heading-${section}" data-page="${section + 1}">${section + 1} Experimental section ${id[0].toUpperCase()}</h2>
    ${Array.from({ length: 15 }, (_, offset) => {
      const index = section * 15 + offset;
      return `<p data-block-id="paragraph-${index}" data-page="${section + 1}">${paragraph(id, index)}</p>`;
    }).join('')}</section>`).join('')}</main></body></html>`;
}
function annotations(id) {
  return Array.from({ length: annotationCount }, (_, index) => ({
    id: `${id[0]}-annotation-${index}`, block_id: `paragraph-${index * 7}`,
    quote: sentence, start: 0, end: sentence.length, page: Math.floor(index * 7 / 15) + 1,
    kind: index % 2 ? 'underline' : 'highlight', color: '#ffd400', source: 'manual',
    surface: 'source', note: `Synthetic evidence ${index} for paper ${id[0].toUpperCase()}.`,
  }));
}
function instrument(source) {
  const functions = ['openReader', 'renderFrameAnnotations', 'rebuildReaderSentencePairs', 'buildReaderIndexes',
    'applyTypography', 'applyAppearance', 'renderCachedTranslations', 'installCitationHoverPreviews'];
  functions.forEach((name) => assert.match(source, new RegExp(`function ${name}\\(`), `Missing instrumentation target ${name}`));
  const injection = `
  window.__switchPerformance = { metrics: {}, refs: {}, internals: () => ({ pairs: readerSentenceState.pairs, sections: readerSections }) };
  ${functions.map((name) => `{
    const original = ${name};
    ${name} = function (...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally {
        const metrics = window.__switchPerformance.metrics;
        const metric = metrics['${name}'] ||= { calls: 0, totalMs: 0, maxMs: 0 };
        const elapsed = performance.now() - start;
        metric.calls += 1; metric.totalMs += elapsed; metric.maxMs = Math.max(metric.maxMs, elapsed);
      }
    };
  }`).join('\n')}
`;
  const end = source.lastIndexOf('\n})();');
  assert.ok(end > 0, 'App closure terminator is present');
  return source.slice(0, end) + injection + source.slice(end);
}
async function staticServer() {
  const root = path.join(__dirname, '..');
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const filename = path.join(root, pathname === '/' ? 'web/index.html' : pathname);
    if (!filename.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    fs.readFile(filename, (error, bytes) => {
      if (error) { response.writeHead(404).end(); return; }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(filename)];
      response.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(bytes);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.error(`[reader-switch-performance] static server pid=${process.pid} port=${server.address().port}`);
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

(async () => {
  const server = requestedURL ? null : await staticServer();
  let session;
  try {
    session = await launchManagedChromium();
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    const unexpected = [];
    const requests = [];
    const savedAnnotations = new Map(ids.map((id) => [id, annotations(id)]));
    const insertedTranslation = '新增的合成译文包含可以定位的证据。';
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      if (window !== window.top) return;
      window.__switchAnimations = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        const animation = animate.call(this, keyframes, options);
        if (this.matches('iframe.reader-document-frame')) {
          const record = { jobId: this.dataset.jobId, keyframes, options, canceled: false };
          window.__switchAnimations.push(record);
          const cancel = animation.cancel.bind(animation);
          animation.cancel = () => { record.canceled = true; return cancel(); };
        }
        return animation;
      };
    });
    await page.route('**/web/app.js', (route) => route.fulfill({ contentType: 'text/javascript', body: instrument(fs.readFileSync(process.env.MY_SCHOLAR_READER_APP_FIXTURE || path.join(__dirname, '../web/app.js'), 'utf8')) }));
    if (process.env.MY_SCHOLAR_READER_STYLE_FIXTURE) await page.route('**/web/styles.css', (route) => route.fulfill({ contentType: 'text/css', body: fs.readFileSync(process.env.MY_SCHOLAR_READER_STYLE_FIXTURE, 'utf8') }));
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs };
      else if (pathname === '/api/plugins' && route.request().method() === 'GET') payload = { plugins: [], drafts: [], previews: [] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: {
        translation: { enabled: true, configured: true, profile_id: profile, target_language: '中文' },
        chat: { enabled: false, configured: false },
      } } };
      else if (pathname === '/api/settings') payload = { appearance: { app_font: 'system', reader_font: 'academic', accent: 'amber' }, ai: {}, metadata: { auto_retrieve: false } };
      else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[pathname.split('/')[4]] };
      else if (/^\/api\/jobs\/[ab]{16}(?:\/|$)/u.test(pathname)) {
        const [, id, endpoint = ''] = pathname.match(/^\/api\/jobs\/([ab]{16})\/?(.*)$/u);
        requests.push({ id, endpoint, method });
        if (endpoint === 'document.html') { await route.fulfill({ contentType: 'text/html', body: documentHTML(id) }); return; }
        if (endpoint === 'translations') payload = { translations: Array.from({ length: translationCount }, (_, index) => ({ block_id: `paragraph-${index * 11}`, source_text: paragraph(id, index * 11), text: `文献 ${id[0].toUpperCase()} 第 ${index} 条合成缓存译文。`, profile_id: profile, target_language: '中文', formulas: [] })) };
        else if (endpoint === 'media-layout') payload = { media_layout: { version: 1, items: {} } };
        else if (endpoint === 'annotations') payload = { annotations: savedAnnotations.get(id) };
        else if (endpoint === 'translate' && method === 'POST') payload = { result: { ...request.postDataJSON(), text: insertedTranslation, profile_id: profile } };
        else if (endpoint === 'notes') payload = { markdown: '' };
        else if (endpoint === 'auto-highlights') payload = { result: { status: 'mock', highlights: [] } };
        else if (!endpoint) payload = jobs.find((job) => job.job_id === id);
        else unexpected.push(`${method} ${pathname}`);
      } else unexpected.push(`${method} ${pathname}`);
      await route.fulfill({ json: payload });
    });
    async function ready(id) {
      await page.waitForFunction(({ id: jobId, marks, translations }) => {
        const doc = document.querySelector('#html-preview')?.contentDocument;
        return doc?.body?.dataset.fixtureJob === jobId
          && doc.querySelectorAll('mark[data-annotation-id]').length === marks
          && doc.querySelectorAll('.my-scholar-translation').length === translations
          && doc.querySelector('[data-block-id="paragraph-0"] > .paragraph-translate-trigger')
          && !document.querySelector('#reader-view').classList.contains('is-document-loading');
      }, { id, marks: annotationCount, translations: translationCount });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    async function activate(id) {
      await page.locator(`#document-tabs .document-tab[data-job-id="${id}"]`).click();
      await ready(id);
      await page.evaluate((jobId) => {
        const ref = window.__switchPerformance.refs[jobId];
        if (ref) {
          const internals = window.__switchPerformance.internals();
          ref.rangesPreserved &&= internals.pairs === ref.pairs;
          ref.sectionsPreserved &&= internals.sections === ref.sections;
        }
      }, id);
    }
    async function remember(id) {
      await page.evaluate((jobId) => {
        const frame = document.querySelector('#html-preview');
        const doc = frame.contentDocument;
        doc.defaultView.scrollTo(0, 4000);
        const observation = { removedMarks: 0, removedTranslations: 0 };
        const observer = new MutationObserver((changes) => changes.forEach((change) => {
          for (const node of change.removedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.matches('mark[data-annotation-id]')) observation.removedMarks += 1;
            if (node.matches('.my-scholar-translation')) observation.removedTranslations += 1;
          }
        }));
        observer.observe(doc.body, { childList: true, subtree: true });
        window.__switchPerformance.refs[jobId] = {
          frame, doc, marks: [...doc.querySelectorAll('mark[data-annotation-id]')],
          translations: [...doc.querySelectorAll('.my-scholar-translation')],
          paragraph: doc.querySelector('[data-block-id="paragraph-0"]'),
          ...window.__switchPerformance.internals(), rangesPreserved: true, sectionsPreserved: true, observation, observer,
        };
      }, id);
      await page.waitForFunction(() => document.querySelector('#html-preview').contentWindow.scrollY >= 3998);
    }
    const snapshot = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__switchPerformance.metrics)));
    const difference = (before, after) => Object.fromEntries(Object.entries(after).map(([name, value]) => [name, {
      calls: value.calls - (before[name]?.calls || 0),
      totalMs: Number((value.totalMs - (before[name]?.totalMs || 0)).toFixed(2)),
      maxMs: Number(value.maxMs.toFixed(2)),
    }]));
    await page.goto(requestedURL || server.url, { waitUntil: 'networkidle' });
    for (const id of ids) {
      await page.locator('[data-view="library-view"]').click();
      await page.locator(`#library-view .library-row[data-job-id="${id}"]`).dblclick();
      await ready(id);
      await remember(id);
    }
    await page.evaluate(() => {
      for (const [id, ref] of Object.entries(window.__switchPerformance.refs)) ref.tab = document.querySelector(`#document-tabs .document-tab[data-job-id="${id}"]`);
    });
    const initialRequests = requests.filter((request) => request.endpoint === 'document.html').length;
    await page.evaluate(() => { window.__switchPerformance.metrics = {}; });
    const before = await snapshot();
    for (let cycle = 0; cycle < 4; cycle += 1) { await activate(ids[0]); await activate(ids[1]); }
    await activate(ids[0]);
    await page.locator('[data-view="library-view"]').click();
    await activate(ids[0]);
    const metrics = difference(before, await snapshot());
    const preserved = await page.evaluate(() => Object.fromEntries(Object.entries(window.__switchPerformance.refs).map(([id, ref]) => {
      const active = ref.frame.id === 'html-preview';
      const internals = active ? window.__switchPerformance.internals() : null;
      return [id, {
        frame: ref.frame.isConnected, tab: ref.tab.isConnected, document: ref.frame.contentDocument === ref.doc,
        paragraph: ref.doc.querySelector('[data-block-id="paragraph-0"]') === ref.paragraph,
        marks: ref.marks.every((node) => node.isConnected),
        translations: ref.translations.every((node) => node.isConnected),
        sectionIndexes: ref.sectionsPreserved && (!active || internals.sections === ref.sections),
        sentenceRanges: ref.rangesPreserved && (!active || internals.pairs === ref.pairs),
        scroll: Math.abs(ref.doc.defaultView.scrollY - 4000) <= 2,
        ...ref.observation,
      }];
    })));
    assert.equal(requests.filter((request) => request.endpoint === 'document.html').length, initialRequests, 'Warm switching must not request document resources');
    for (const value of Object.values(preserved)) {
      assert.ok(value.frame && value.document && value.paragraph && value.translations && value.scroll, `Resident reader lost state: ${JSON.stringify(value)}`);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, [], 'All API traffic must stay inside the synthetic fixture');
    if (!baseline) {
      for (const [id, value] of Object.entries(preserved)) {
        assert.ok(value.tab && value.marks && value.sentenceRanges && value.sectionIndexes, `Unchanged reader DOM or indexes rebuilt for ${id}: ${JSON.stringify(value)}`);
        assert.equal(value.removedMarks, 0, `Warm switches removed saved annotation marks for ${id}`);
        assert.equal(value.removedTranslations, 0, `Warm switches removed cached translations for ${id}`);
      }
      assert.equal(metrics.rebuildReaderSentencePairs?.calls || 0, 0, 'Warm switching rebuilt unchanged sentence ranges');

      const animations = await page.evaluate(() => window.__switchAnimations);
      assert.ok(animations.length >= 10, 'Warm activation should apply the document opacity animation');
      for (const animation of animations) {
        assert.deepEqual(animation.keyframes, [{ opacity: 0.88 }, { opacity: 1 }]);
        assert.equal(animation.options.duration, 100);
        assert.ok(animation.keyframes.every((keyframe) => !Object.hasOwn(keyframe, 'transform')), 'Reader animation must not move the document');
      }
      const rapid = await page.evaluate(([a, b]) => {
        const before = window.__switchAnimations.length;
        for (const id of [b, a, b]) document.querySelector(`#document-tabs .document-tab[data-job-id="${id}"]`).click();
        return window.__switchAnimations.slice(before);
      }, ids);
      assert.equal(rapid.length, 3);
      assert.ok(rapid[0].canceled && rapid[1].canceled, 'Rapid switching must cancel superseded reader animations');
      await ready(ids[1]);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
      const animationCount = await page.evaluate(() => window.__switchAnimations.length);
      await activate(ids[0]);
      await activate(ids[1]);
      assert.equal(await page.evaluate(() => window.__switchAnimations.length), animationCount, 'Reduced motion must disable reader animations');

      const updatedQuote = 'Document A, paragraph 0.';
      const updated = savedAnnotations.get(ids[0]).map((annotation, index) => index ? annotation : {
        ...annotation, quote: updatedQuote, start: sentence.length + 1,
        end: sentence.length + 1 + updatedQuote.length, color: '#2ea8e5',
      });
      updated.push({ id: 'translation-evidence', block_id: 'translation-paragraph-350', source_block_id: 'paragraph-350',
        quote: insertedTranslation, start: 0, end: insertedTranslation.length, page: 24,
        surface: 'translation', source: 'manual', kind: 'highlight', color: '#5fb236', note: 'New translation evidence.' });
      savedAnnotations.set(ids[0], updated);
      await activate(ids[1]);
      await activate(ids[0]);
      const frame = page.frameLocator('#html-preview');
      await page.waitForFunction(({ quote }) => {
        const doc = document.querySelector('#html-preview').contentDocument;
        const mark = doc.querySelector('mark[data-annotation-id="a-annotation-0"]');
        return mark?.textContent === quote && mark.style.getPropertyValue('--user-highlight') === '#2ea8e5';
      }, { quote: updatedQuote });
      assert.equal(await page.locator('#annotation-anchor-status').evaluate((node) => !node.hidden), true, 'Missing translated source must report its unresolved annotation');
      const beforeTranslation = requests.filter((request) => request.endpoint === 'translate').length;
      await frame.locator('[data-block-id="paragraph-350"] > .paragraph-translate-trigger').click({ force: true });
      await frame.locator('.my-scholar-translation[data-for="paragraph-350"]:not(.is-pending) mark[data-annotation-id="translation-evidence"]').waitFor();
      assert.equal(await frame.locator('mark[data-annotation-id="translation-evidence"]').textContent(), insertedTranslation);
      await page.waitForFunction(() => document.querySelector('#annotation-anchor-status').hidden);
      assert.equal(requests.filter((request) => request.endpoint === 'translate').length - beforeTranslation, 1, 'Translation control must have exactly one handler');
      await activate(ids[1]);
      assert.equal(await frame.locator('mark[data-annotation-id="translation-evidence"]').count(), 0, 'Translated annotation must stay inside its owning paper');
      assert.equal(await frame.locator('mark[data-annotation-id="b-annotation-0"]').textContent(), sentence);
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
    }
    console.log(JSON.stringify({ suite: 'reader-switch-performance', baseline, fixture: { paragraphs, annotations: annotationCount, translations: translationCount }, warmSwitches: 10, metrics, preserved }));
  } finally {
    if (session) await session.close();
    if (server) await server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
