'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const baseline = process.argv.includes('--baseline');
const requestedURL = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
const paragraphs = 180;
const annotationCount = 12;
const translationCount = 13;
const title = 'Synthetic navigation performance paper';
const sentence = 'This synthetic paragraph contains reproducible evidence for a navigation performance experiment.';
const paragraph = (index) => `${sentence} Paragraph ${index} measures first document preparation, annotations, and cached translations. The controlled fixture never contacts a real AI service. Repeated navigation should retain existing document and library elements.`;
const jobs = ids.map((id, index) => ({
  job_id: id, source_filename: `Synthetic navigation paper ${index ? 'B' : 'A'}.pdf`, status: 'completed',
  created_at: '2026-10-18T00:00:00Z', updated_at: '2026-10-18T00:00:00Z',
  links: { html: `/api/jobs/${id}/document.html` }, manifest: { counts: { pages: 12, images: 0 } },
}));
const library = {
  folders: [{ id: 'fixture-folder', name: 'Synthetic folder' }], properties: [], views: [],
  display: { columns: [{ id: 'name', visible: true, order: 0 }] },
  items: Object.fromEntries(ids.map((id) => [id, {
    folder_ids: [], values: { reading_status: '阅读中', importance: 0, research_topic: [] },
    metadata: { fields: {}, status: 'complete' }, created_at: jobs[0].created_at, updated_at: jobs[0].updated_at,
  }])),
};
let settings = {
  appearance: { app_font: 'system', reader_font: 'academic', accent: 'amber' },
  ai: {}, metadata: { auto_retrieve: false, online_lookup: false, contact_email: 'initial@example.invalid' },
};

function documentHTML(id) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}.reader-content{max-width:720px;margin:auto}p[data-block-id]{min-height:110px;margin:0;padding:12px;box-sizing:border-box}</style></head><body data-fixture-job="${id}"><main class="reader-content"><h1 class="paper-title" data-block-id="title" data-page="1">${title}</h1>${Array.from({ length: 12 }, (_, section) => `<section class="pdf-page" data-page="${section + 1}"><h2 data-block-id="heading-${section}" data-page="${section + 1}">${section + 1} Synthetic section</h2>${Array.from({ length: 15 }, (_, offset) => {
    const index = section * 15 + offset;
    return `<p data-block-id="paragraph-${index}" data-page="${section + 1}">${paragraph(index)}</p>`;
  }).join('')}</section>`).join('')}</main></body></html>`;
}
function instrument(source) {
  const functions = ['openReader', 'wireFrame', 'prepareMountedReader', 'prepareReaderMedia', 'prepareReaderImages',
    'renderFrameAnnotations', 'buildReaderIndexes', 'scheduleInterlinearTranslations', 'layoutInterlinearContainer', 'renderCachedTranslations',
    'renderLibrary', 'renderLibraryRows', 'renderFolderTree', 'showSettingsSection', 'applyAppearance', 'applyTypography', 'loadSettings', 'renderAISettings', 'renderAnnotationActionSettings', 'loadParsingProviders', 'ensureTitleTranslation'];
  for (const name of functions) assert.match(source, new RegExp(`function ${name}\\(`), `Missing instrumentation target ${name}`);
  const injection = `
  window.__navigationPerformance = {
    metrics: {}, refs: {}, refreshLibrary: () => loadLibrary(), refreshSettings: () => loadSettings({ refresh: true }), refreshProviders: () => loadParsingProviders({ refresh: true }),
    reader: () => ({ jobId: state.activeJob?.job_id, ready: readerMount?.ready, cachedAnnotations: readerMount?.annotations.length, notes: document.querySelector('#notes-editor')?.textContent }),
  };
  ${functions.map((name) => `{
    const original = ${name};
    ${name} = function (...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally {
        const metric = window.__navigationPerformance.metrics['${name}'] ||= { calls: 0, totalMs: 0, maxMs: 0 };
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
  console.error(`[navigation-performance] static server pid=${process.pid} port=${server.address().port}`);
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

(async () => {
  const server = requestedURL ? null : await staticServer();
  let session;
  const pending = new Set();
  try {
    session = await launchManagedChromium();
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 }, serviceWorkers: 'block' });
    page.setDefaultTimeout(15000);
    const errors = [];
    const unexpected = [];
    const requests = [];
    let holdSettings = false;
    let releaseSettings = null;
    let holdSecondReader = false;
    let holdFirstDocument = true;
    let releaseFirstDocument = null;
    let releaseTranslations = null;
    let holdTranslations = true;
    let releaseHighlights = null;
    let holdHighlights = true;
    let remoteConnected = false;
    let holdProviders = false;
    let releaseProviders = null;
    let releaseConnection = null;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__settingsSwitchSamples = [];
      document.addEventListener('click', (event) => {
        const link = event.target.closest('.settings-navigation a');
        if (!link) return;
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const section = document.querySelector(link.getAttribute('href'));
          const animations = section.getAnimations();
          const sample = { section: section.id, nextPaintMs: performance.now() - start,
            animationMs: Math.max(0, ...animations.map((animation) => Number(animation.effect.getTiming().duration) || 0)) };
          window.__settingsSwitchSamples.push(sample);
        }));
      }, true);
    });
    await page.route('**/web/app.js', (route) => route.fulfill({ contentType: 'text/javascript', body: instrument(fs.readFileSync(process.env.MY_SCHOLAR_NAVIGATION_APP_FIXTURE || path.join(__dirname, '../web/app.js'), 'utf8')) }));
    if (process.env.MY_SCHOLAR_NAVIGATION_STYLE_FIXTURE) await page.route('**/web/styles.css', (route) => route.fulfill({ contentType: 'text/css', body: fs.readFileSync(process.env.MY_SCHOLAR_NAVIGATION_STYLE_FIXTURE, 'utf8') }));
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      requests.push({ pathname, method });
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs };
      else if (pathname === '/api/plugins' && route.request().method() === 'GET') payload = { plugins: [], drafts: [], previews: [] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { translation: { enabled: true, configured: true, profile_id: 'navigation-fixture', target_language: '中文' }, chat: { enabled: true, configured: true } } } };
      else if (pathname === '/api/settings') {
        if (method === 'POST') { settings = { ...settings, ...request.postDataJSON() }; payload = { settings }; }
        else {
          payload = JSON.parse(JSON.stringify(settings));
          if (holdSettings) {
            holdSettings = false;
            await new Promise((resolve) => { releaseSettings = resolve; pending.add(resolve); });
          }
        }
      } else if (pathname === '/api/parsing/providers') {
        payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }, { id: 'remote-guzi', configured: true, ready: remoteConnected }] };
        if (holdProviders) {
          holdProviders = false;
          await new Promise((resolve) => { releaseProviders = resolve; pending.add(resolve); });
        }
      } else if (pathname === '/api/parsing/providers/remote-guzi/connect') {
        await new Promise((resolve) => { releaseConnection = resolve; pending.add(resolve); });
        remoteConnected = true;
        payload = { provider: { id: 'remote-guzi', configured: true, ready: true } };
      }
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[pathname.split('/')[4]] };
      else if (/^\/api\/jobs\/[ab]{16}(?:\/|$)/u.test(pathname)) {
        const [, id, endpoint = ''] = pathname.match(/^\/api\/jobs\/([ab]{16})\/?(.*)$/u);
        if (endpoint === 'document.html') {
          if (id === ids[0] && holdFirstDocument) {
            holdFirstDocument = false;
            await new Promise((resolve) => { releaseFirstDocument = resolve; pending.add(resolve); });
          }
          await route.fulfill({ contentType: 'text/html', body: documentHTML(id) }); return;
        }
        if (holdSecondReader && id === ids[1] && ['annotations', 'notes'].includes(endpoint)) await new Promise((resolve) => pending.add(resolve));
        if (endpoint === 'translations') {
          if (holdTranslations && id === ids[0]) {
            holdTranslations = false;
            await new Promise((resolve) => { releaseTranslations = resolve; pending.add(resolve); });
          }
          payload = { translations: [{ block_id: 'title', source_text: title, text: '合成导航性能论文', profile_id: 'navigation-fixture', target_language: '中文', formulas: [], alignment_version: 'sentence-v1', segments: [{ id: `s0-${title.length}`, text: '合成导航性能论文' }] }, ...Array.from({ length: translationCount - 1 }, (_, index) => ({ block_id: `paragraph-${index * 11}`, source_text: paragraph(index * 11), text: `文献 ${id[0].toUpperCase()} 第 ${index} 条合成缓存译文。`, profile_id: 'navigation-fixture', target_language: '中文', formulas: [] }))] };
        }
        else if (endpoint === 'media-layout') payload = { media_layout: { version: 1, items: {} } };
        else if (endpoint === 'annotations') payload = { annotations: Array.from({ length: annotationCount }, (_, index) => ({ id: `${id[0]}-mark-${index}`, block_id: `paragraph-${index * 7}`, quote: sentence, start: 0, end: sentence.length, page: Math.floor(index * 7 / 15) + 1, kind: 'highlight', color: '#ffd400', source: 'manual', surface: 'source', note: `Synthetic note ${index}` })) };
        else if (endpoint === 'notes') payload = { markdown: `Notes belonging to paper ${id[0].toUpperCase()}.` };
        else if (endpoint === 'translate' && method === 'POST') payload = { result: { ...request.postDataJSON(), text: '合成导航性能论文', profile_id: 'navigation-fixture' } };
        else if (endpoint === 'auto-highlights') {
          if (holdHighlights && id === ids[0] && method === 'GET') {
            holdHighlights = false;
            await new Promise((resolve) => { releaseHighlights = resolve; pending.add(resolve); });
          }
          payload = { result: { status: method === 'GET' ? 'not-run' : 'mock', highlights: [] } };
        }
        else if (!endpoint) payload = jobs.find((job) => job.job_id === id);
        else unexpected.push(`${method} ${pathname}`);
      } else unexpected.push(`${method} ${pathname}`);
      await route.fulfill({ json: payload });
    });
    const count = (pathname, method = 'GET') => requests.filter((request) => request.pathname === pathname && request.method === method).length;
    const snapshot = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__navigationPerformance.metrics)));
    const difference = (before, after) => Object.fromEntries(Object.entries(after).map(([name, value]) => [name, {
      calls: value.calls - (before[name]?.calls || 0), totalMs: Number((value.totalMs - (before[name]?.totalMs || 0)).toFixed(2)), maxMs: Number(value.maxMs.toFixed(2)),
    }]));
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    async function navigate(view) {
      await page.locator(`[data-view="${view}-view"]`).click();
      await page.locator(`#${view}-view.active-view`).waitFor();
      await settle();
    }
    async function ready(id) {
      try { await page.waitForFunction(({ id: jobId, marks, translations }) => {
        const doc = document.querySelector('#html-preview')?.contentDocument;
        return doc?.body?.dataset.fixtureJob === jobId && doc.querySelectorAll('mark[data-annotation-id]').length === marks
          && doc.querySelectorAll('.my-scholar-translation').length === translations
          && window.__navigationPerformance.reader().ready && !document.querySelector('#reader-view').classList.contains('is-document-loading');
      }, { id, marks: annotationCount, translations: translationCount }); }
      catch (error) {
        console.error('[navigation-performance] reader readiness failed', JSON.stringify(await page.evaluate(() => {
          const doc = document.querySelector('#html-preview')?.contentDocument;
          return { reader: window.__navigationPerformance.reader(), document: doc?.body?.dataset.fixtureJob, marks: doc?.querySelectorAll('mark[data-annotation-id]').length, translations: doc?.querySelectorAll('.my-scholar-translation').length, metrics: window.__navigationPerformance.metrics };
        })));
        throw error;
      }
      await settle();
    }
    await page.goto(requestedURL || server.url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#setting-metadata-email').value === 'initial@example.invalid');
    const beforeFirst = await snapshot();
    await page.locator(`#library-view .library-row[data-job-id="${ids[0]}"]`).dblclick();
    await page.waitForFunction((marks) => window.__navigationPerformance.reader().cachedAnnotations === marks, annotationCount);
    assert.ok(releaseFirstDocument, 'Document response must wait for annotations cached before reader wiring');
    pending.delete(releaseFirstDocument); releaseFirstDocument();
    await page.waitForFunction(() => window.__navigationPerformance.metrics.wireFrame?.calls === 1 && window.__navigationPerformance.metrics.ensureTitleTranslation?.calls > 0);
    assert.ok(releaseTranslations, 'Title cache request must be delayed until reader wiring');
    pending.delete(releaseTranslations); releaseTranslations();
    await ready(ids[0]);
    const firstOpen = difference(beforeFirst, await snapshot());
    assert.equal(count(`/api/jobs/${ids[0]}/document.html`), 1);
    assert.equal(firstOpen.openReader?.calls, 1, 'One double click must activate the reader once');
    assert.equal(firstOpen.wireFrame?.calls, 1, 'A new document must receive one set of reader event handlers');
    if (!baseline) {
      assert.equal(firstOpen.prepareMountedReader?.calls, 1, 'A newly loaded document must be prepared once');
      assert.equal(firstOpen.buildReaderIndexes?.calls, 1, 'A newly loaded document must build its section index once');
      // Wiring, annotations, and the deliberately delayed translation cache each get one reconciliation.
      assert.ok(firstOpen.renderFrameAnnotations.calls <= 3, 'First open repeated annotation DOM reconciliation');
      assert.ok(firstOpen.layoutInterlinearContainer?.calls > 0, 'Aligned cached title must exercise bilingual layout');
      assert.ok(firstOpen.layoutInterlinearContainer.calls <= 3, 'First open repeated bilingual layout of the aligned cached title');
    }
    const titleRequests = count(`/api/jobs/${ids[0]}/translate`, 'POST');
    if (!baseline) assert.equal(titleRequests, 0, 'Delayed cached title must not trigger a translation request');
    for (let attempt = 0; !releaseHighlights && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(releaseHighlights, 'Initial AI highlight request must be in flight during A → B → A');
    await navigate('library');
    await page.locator(`#recent-list .library-row[data-job-id="${ids[1]}"]`).dblclick();
    await ready(ids[1]);
    await page.locator(`#document-tabs .document-tab[data-job-id="${ids[0]}"]`).click();
    await ready(ids[0]);
    pending.delete(releaseHighlights); releaseHighlights();
    await page.waitForLoadState('networkidle');
    const highlightRequests = { get: count(`/api/jobs/${ids[0]}/auto-highlights`), post: count(`/api/jobs/${ids[0]}/auto-highlights`, 'POST') };
    if (!baseline) assert.deepEqual(highlightRequests, { get: 1, post: 1 }, 'An in-flight AI highlight run must be reused during A → B → A');

    await navigate('library');
    await navigate('settings');
    await page.waitForFunction(() => document.querySelector('#settings-save-status').dataset.state === 'saved');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      const refs = window.__navigationPerformance.refs;
      refs.row = document.querySelector('#recent-list .library-row');
      refs.header = document.querySelector('#library-columns .library-column-header');
      refs.folder = document.querySelector('#folder-tree .folder-button');
      refs.action = document.querySelector('#setting-annotation-builtins > *');
      refs.modelList = document.querySelector('#setting-translation-model-list');
      refs.modelList.append(Object.assign(document.createElement('span'), { textContent: 'Synthetic cached model result', id: 'fixture-model-result' }));
      refs.modelResult = document.querySelector('#fixture-model-result');
    });
    for (const section of ['settings-shortcuts', 'settings-metadata', 'settings-ai', 'settings-reading']) {
      await page.locator(`.settings-navigation a[href="#${section}"]`).click();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    const settingsSwitchSamples = await page.evaluate(() => window.__settingsSwitchSamples);
    if (!baseline) assert.ok(settingsSwitchSamples.every((sample) => sample.animationMs === 0), 'First settings category switches must not wait for a panel animation');
    const beforeNavigation = await snapshot();
    const beforeRequests = { settings: count('/api/settings'), providers: count('/api/parsing/providers'), jobs: count('/api/jobs'), library: count('/api/library') };
    for (let cycle = 0; cycle < 4; cycle += 1) { await navigate('library'); await navigate('settings'); }
    await page.waitForLoadState('networkidle');
    const navigation = difference(beforeNavigation, await snapshot());
    const navigationRequests = Object.fromEntries(Object.keys(beforeRequests).map((name) => [name, count(`/api/${name === 'providers' ? 'parsing/providers' : name}`) - beforeRequests[name]]));
    const preserved = await page.evaluate(() => Object.fromEntries(Object.entries(window.__navigationPerformance.refs).map(([name, node]) => [name, Boolean(node?.isConnected)])));
    if (!baseline) {
      for (const name of ['row', 'header', 'folder', 'action', 'modelResult']) assert.equal(preserved[name], true, `Unchanged navigation replaced ${name}`);
      assert.deepEqual(navigationRequests, { settings: 0, providers: 0, jobs: 0, library: 0 }, 'Unchanged navigation must reuse loaded data');
    }
    const beforeExplicitRefresh = count('/api/settings');
    await page.evaluate(() => window.__navigationPerformance.refreshSettings());
    assert.equal(count('/api/settings') - beforeExplicitRefresh, 1, 'Explicit settings refresh must reach the server');
    if (!baseline) assert.equal(await page.evaluate(() => window.__navigationPerformance.refs.action.isConnected && window.__navigationPerformance.refs.modelResult.isConnected), true, 'Unchanged settings response must preserve controls and cached model results');
    const beforeParsing = count('/api/parsing/providers');
    if (!baseline) assert.equal(beforeParsing, 0, 'Non-parsing settings sections must not probe parsing providers');
    await page.locator('.settings-navigation a[href="#settings-parsing"]').click();
    await page.waitForLoadState('networkidle');
    await page.locator('.settings-navigation a[href="#settings-reading"]').click();
    await page.locator('.settings-navigation a[href="#settings-parsing"]').click();
    await page.waitForLoadState('networkidle');
    if (!baseline) assert.equal(count('/api/parsing/providers') - beforeParsing, 1, 'Recently loaded parsing providers must be reused');
    if (!baseline) {
      holdProviders = true;
      await page.evaluate(() => { window.__pendingProviderRefresh = window.__navigationPerformance.refreshProviders(); });
      for (let attempt = 0; !releaseProviders && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(releaseProviders, 'An older provider GET must be in flight');
      await page.locator('#connect-remote-parser').click();
      for (let attempt = 0; !releaseConnection && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(releaseConnection, 'A remote parser connection must be in flight during navigation');
      const beforeConnectionNavigation = count('/api/parsing/providers');
      await navigate('library');
      await navigate('settings');
      pending.delete(releaseConnection); releaseConnection();
      await page.waitForFunction(() => document.querySelector('#remote-parsing-status').textContent === '已连接');
      pending.delete(releaseProviders); releaseProviders();
      await page.evaluate(() => window.__pendingProviderRefresh);
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#remote-parsing-status').textContent(), '已连接', 'An old provider GET must not overwrite the completed connection');
      assert.equal(count('/api/parsing/providers'), beforeConnectionNavigation, 'Reentry must await the connection rather than probing stale server state');
      assert.equal(count('/api/parsing/providers/remote-guzi/connect', 'POST'), 1);
    }
    await page.locator('.settings-navigation a[href="#settings-reading"]').click();

    await page.locator('#setting-app-font').selectOption('songti');
    await page.waitForFunction(() => document.querySelector('#settings-save-status').dataset.state === 'saved');
    assert.equal(settings.appearance.app_font, 'songti', 'Settings changes must reach only the mocked persistence endpoint');
    await navigate('library');
    await navigate('settings');
    assert.equal(await page.locator('#setting-app-font').inputValue(), 'songti');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#setting-app-font').value === 'songti');
    await navigate('library');
    library.items[ids[0]].metadata.fields.title = 'Updated synthetic library title';
    await page.evaluate(() => window.__navigationPerformance.refreshLibrary());
    assert.match(await page.locator(`#recent-list .library-row[data-job-id="${ids[0]}"]`).textContent(), /Updated synthetic library title/u, 'Changed library data must invalidate reused content');

    await navigate('settings');
    await page.waitForLoadState('networkidle');
    const beforeDelayedSettings = count('/api/settings');
    holdSettings = true;
    await page.evaluate(() => { window.__pendingNavigationRefresh = window.__navigationPerformance.refreshSettings(); });
    await page.waitForFunction(() => Boolean(window.__pendingNavigationRefresh));
    for (let attempt = 0; !releaseSettings && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(releaseSettings, 'The explicit settings refresh must issue a request');
    await navigate('library');
    await navigate('settings');
    await page.locator('.settings-navigation a[href="#settings-metadata"]').click();
    if (!baseline) assert.equal(count('/api/settings') - beforeDelayedSettings, 1, 'Rapid settings reentry must share its in-flight refresh');
    await page.locator('#setting-metadata-email').fill('new-draft@example.invalid');
    pending.delete(releaseSettings); releaseSettings();
    await page.evaluate(() => window.__pendingNavigationRefresh);
    assert.equal(await page.locator('#setting-metadata-email').inputValue(), 'new-draft@example.invalid', 'A stale settings response must not overwrite the current draft');
    await page.waitForFunction(() => document.querySelector('#settings-save-status').dataset.state === 'saved');
    assert.equal(settings.metadata.contact_email, 'new-draft@example.invalid');

    await navigate('library');
    holdSecondReader = true;
    await page.locator(`#recent-list .library-row[data-job-id="${ids[1]}"]`).dblclick();
    await page.waitForFunction((id) => document.querySelector('#html-preview')?.contentDocument?.body?.dataset.fixtureJob === id && window.__navigationPerformance.reader().ready, ids[1]);
    assert.equal(pending.size, 2, 'Paper B annotations and notes must remain in flight after its document mounts');
    await page.locator(`#document-tabs .document-tab[data-job-id="${ids[0]}"]`).click();
    await ready(ids[0]);
    holdSecondReader = false;
    for (const resolve of pending) resolve(); pending.clear();
    await page.waitForLoadState('networkidle');
    const finalReader = await page.evaluate(() => window.__navigationPerformance.reader());
    assert.equal(finalReader.jobId, ids[0], 'Delayed paper B requests must not change the active document');
    assert.match(finalReader.notes, /paper A/u, 'Delayed paper B notes must not overwrite paper A');
    assert.equal(await page.frameLocator('#html-preview').locator('mark[data-annotation-id^="b-"]').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, [], 'All API traffic must stay inside the synthetic fixture');
    console.log(JSON.stringify({ suite: 'navigation-performance', baseline, fixture: { paragraphs, annotations: annotationCount, translations: translationCount }, firstOpen, settingsSwitchSamples, titleRequests, highlightRequests, navigation, navigationRequests, preserved, finalReader }));
  } finally {
    for (const resolve of pending) resolve(); pending.clear();
    try { if (session) await session.close(); }
    finally { if (server) await server.close(); }
    if (session) {
      assert.ok(session.browserProcess.exitCode !== null || session.browserProcess.signalCode !== null, 'The managed browser must have exited');
      const profileArgument = session.browserProcess.spawnargs.find((argument) => argument.startsWith('--user-data-dir='));
      if (profileArgument) assert.equal(fs.existsSync(profileArgument.slice('--user-data-dir='.length)), false, 'The managed browser profile must be removed');
      console.error(`[navigation-performance] cleanup verified browser pid=${session.browserProcess.pid} exited; temporary profile removed`);
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
