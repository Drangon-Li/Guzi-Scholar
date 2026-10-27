'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nativeMode = process.argv.includes('--electron');
const { launchManagedChromium } = nativeMode ? {} : require('./playwright.cjs');

let baseURL = nativeMode ? null : process.argv[2];
if (!nativeMode && (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA)) throw new Error('Use the isolated local fixture runner.');
let origin = baseURL && new URL(baseURL).origin;
if (baseURL && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Local fixtures only.');
const baseline = process.env.MY_SCHOLAR_TRANSLATION_BASELINE === '1';
const colorScheme = process.env.MY_SCHOLAR_PROCESS_COLOR_SCHEME || 'light';
assert(['dark', 'light'].includes(colorScheme), 'MY_SCHOLAR_PROCESS_COLOR_SCHEME must be dark or light.');
const overriddenApp = process.env.MY_SCHOLAR_TEST_APP_JS ? fs.readFileSync(process.env.MY_SCHOLAR_TEST_APP_JS, 'utf8') : null;
const jobId = 'eeeeeeeeeeeeeeee';
const count = 233;
let profile = 'process-profile';
// Extracted from demo-5.pdf b-3ad02e5e7a97460c503966b0: five MathML
// formulas, punctuation inside math, and a lazy formula image under pre-wrap.
const complexParagraph = 'Physical theories of the nineteenth century would predict <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mi>&#x003B1;</mi><mo>&#x0003D;</mo><mn>0</mn><mo>&#x0003D;</mo><mi>&#x003B2;</mi><mo>&#x0002E;</mo></mrow></math> Yet, equation (1) yields <strong>an interesting objective</strong>: designing experiments that are particularly sensitive to shifts of <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mi>&#x003B1;</mi></mrow></math> and <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mi>&#x003B2;</mi></mrow></math> from zero. Such experiments would have revealed that <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mi>&#x003B1;</mi></mrow></math> is indistinguishable from zero but <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mi>&#x003B2;</mi></mrow></math> is not (owing to special relativity, <img class="math-source-inline" src="/api/test-assets/process-formula.svg" alt="" loading="lazy"> This would have been a critical indication for exploring new science-an opportunity to glimpse effects of special relativity well before 1905.';
const documentHTML = `<!doctype html><html><head><style>body{margin:0;font-family:Georgia,'Times New Roman',serif;font-size:calc(18px * var(--reader-font-scale,1));line-height:var(--reader-line-height,1.7)}.reader-content{max-width:820px;margin:auto;padding:40px}.pdf-page{padding:12px 0}p{white-space:pre-wrap}img{max-width:100%;height:auto}.math-source-inline{display:inline;vertical-align:middle;max-height:3.6em;max-width:100%;width:auto}math{font-size:1.08em}strong{font-weight:700}</style></head><body><main class="reader-content"><section class="pdf-page" data-page="1"><h2>Incremental translation process fixture</h2>${Array.from({ length: count }, (_, i) => `<p data-block-id="process-${i}" data-page="1">${complexParagraph.replace('would predict ', 'would predict <math><mfrac><msup><mi>x</mi><mn>2</mn></msup><mrow><mi>c</mi><mo>+</mo><mn>1</mn></mrow></mfrac></math> and ')}</p>`).join('\n')}</section></main></body></html>`;
const jobs = [{ job_id: jobId, status: 'completed', source_filename: 'Incremental process fixture.pdf', created_at: '2026-10-26T00:00:00Z', links: { html: `/api/jobs/${jobId}/document.html` }, manifest: { counts: { pages: 1, images: count, tables: 0 } } }];
const library = { folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] }, items: { [jobId]: { folder_ids: [], values: {}, metadata: { status: 'complete', fields: { title: 'Incremental process fixture' } } } } };
const note = { id: 'process-source-note', block_id: 'process-0', surface: 'paper', quote: 'Physical theories of the nineteenth century', start: 0, end: 43, kind: 'highlight', note: 'Preserve this source annotation while other paragraphs arrive.', source: 'manual', render_generation: 'base' };

(async () => {
  const session = nativeMode ? await require('./managed_electron.cjs').launchManagedElectron({ jobId, documentHTML, note, paragraphCount: count }) : await launchManagedChromium();
  if (nativeMode) { baseURL = session.info.baseURL; origin = new URL(baseURL).origin; }
  const errors = [];
  const requests = [];
  const selectionRequests = [];
  let selectionSurface = null;
  const manualSelection = { hoverRequests: 0, snapshots: [], screenshots: [], cleared: false, copyVerified: false };
  const records = [];
  const themeChecks = [];
  let inFlight = 0;
  let peakInFlight = 0;
  let completed = 0;
  let nativeClosing = false;
  let cancelledRequests = 0;
  const expectedRouteClosures = [];
  const realApiResponses = [];
  let releaseTail;
  const tailGate = new Promise((resolve) => { releaseTail = resolve; });
  let report;
  const tracePath = process.env.MY_SCHOLAR_PROCESS_TRACE;
  let traceClient = null;
  let stopTracePromise = null;
  const stopTrace = () => {
    if (!traceClient) return Promise.resolve();
    stopTracePromise ||= (async () => {
      const finished = new Promise((resolve) => traceClient.once('Tracing.tracingComplete', resolve));
      const { profile } = await traceClient.send('Profiler.stop');
      fs.writeFileSync(`${tracePath}.cpuprofile`, JSON.stringify(profile));
      await traceClient.send('Tracing.end');
      const { stream } = await finished;
      fs.writeFileSync(tracePath, '');
      for (;;) {
        const chunk = await traceClient.send('IO.read', { handle: stream });
        fs.appendFileSync(tracePath, chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
        if (chunk.eof) break;
      }
      await traceClient.send('IO.close', { handle: stream });
    })();
    return stopTracePromise;
  };
  let failure;
  let started = Date.now();
  try {
    const page = nativeMode ? session.page : await session.browser.newPage({ viewport: { width: 1400, height: 940 }, reducedMotion: 'reduce' });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    page.setDefaultTimeout(30000);
    const artifactDirectory = process.env.MY_SCHOLAR_PROCESS_ARTIFACT_DIR || os.tmpdir();
    fs.mkdirSync(artifactDirectory, { recursive: true });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__processCopiedText = text; } } });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('crash', () => errors.push('Renderer crashed'));
    if (nativeMode) page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') && !url.pathname.endsWith('/translate') && url.pathname !== '/api/test-assets/process-formula.svg') realApiResponses.push({ path: url.pathname, method: response.request().method(), status: response.status() });
    });
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      try {
        if (url.origin !== origin) { await route.abort(); return; }
        if (overriddenApp && url.pathname === '/web/app.js') { await route.fulfill({ contentType: 'text/javascript', body: overriddenApp }); return; }
        if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
        const pathname = url.pathname;
        let payload = {};
        if (pathname === '/api/test-assets/process-formula.svg') {
          await new Promise((resolve) => setTimeout(resolve, 180));
          await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="54"><text x="2" y="36" font-size="18">β = v² / 2c²).</text></svg>' }); return;
        }
        if (nativeMode && !pathname.endsWith('/translate')) { await route.continue(); return; }
        if (pathname === '/api/jobs') payload = { jobs };
        else if (pathname === '/api/library') payload = { library };
        else if (pathname === '/api/health') payload = { ok: true, ai: { services: { translation: { enabled: true, configured: true, provider: 'openai-compatible', model: 'process-engine', profile_id: profile, target_language: 'zh' }, chat: { enabled: false, configured: false } } } };
        else if (pathname === '/api/settings') payload = { metadata: { auto_retrieve: false }, ai: { translation: { provider: 'openai-compatible', mode: 'chat', model: 'process-engine', base_url: 'http://translation.invalid/v1', api_key_configured: true, target_language: 'zh', enabled: true }, chat: { enabled: false } } };
        else if (pathname === '/api/plugins') payload = { plugins: [], drafts: [], previews: [] };
        else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
        else if (pathname === '/api/library/location') payload = { location: {} };
        else if (pathname === '/api/account/status') payload = { authenticated: false };
        else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[jobId] };
        else if (pathname.endsWith('/document.html')) { await route.fulfill({ contentType: 'text/html', body: documentHTML }); return; }
        else if (pathname.endsWith('/translations')) payload = { translations: records, profile_id: profile };
        else if (pathname.endsWith('/annotations')) payload = { annotations: [note] };
        else if (pathname.endsWith('/media-layout')) payload = { media_layout: { version: 1, items: {} } };
        else if (pathname.endsWith('/notes')) payload = { markdown: '' };
        else if (pathname.endsWith('/auto-highlights')) payload = { result: { status: 'mock', highlights: [] } };
        else if (pathname.endsWith('/translate')) {
          const body = request.postDataJSON();
          if (!body.block_id) {
            selectionRequests.push({ ...body, surface: selectionSurface });
            assert(selectionSurface, 'Ordinary sentence hover must never request a translation.');
            if (selectionSurface === 'paper') assert.doesNotMatch(body.text, /\p{Script=Han}/u, 'An English selection request must exclude Chinese interlinear rows.');
            else assert.match(body.text, /\p{Script=Han}/u, 'A translated selection request must originate in Chinese text.');
            await route.fulfill({ json: { result: { text: '手动选区的独立模拟译文。', profile_id: profile } } });
            return;
          }
          requests.push(body);
          assert.equal(body.alignment_version, 'sentence-v1');
          inFlight += 1; peakInFlight = Math.max(peakInFlight, inFlight);
          if (Number(body.block_id.split('-').at(-1)) >= count - 3) await tailGate;
          if (nativeClosing && page.isClosed()) {
            inFlight -= 1; cancelledRequests += 1;
            try { await route.abort('aborted'); } catch (error) {
              if (!/closed|disposed|interception|invalid/i.test(error.message)) throw error;
              expectedRouteClosures.push({ pathname, message: error.message });
            }
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 110 + Number(body.block_id.split('-').at(-1)) % 3 * 25));
          const segments = body.segments.map((segment, index) => ({ id: segment.id, text: `${index === 0 ? '十九世纪的物理理论预测这些参数为零，而设计对参数变化敏感的实验能够揭示新的科学现象，保留公式与强调内容。' : '这些实验能够揭示参数与零之间的差异，为探索新的科学现象提供重要线索，并在较窄的屏幕上自然换行。'}${(segment.text.match(/__MY_SCHOLAR_[A-Z0-9_]+__/gu) || []).join(' ')}。` }));
          const result = { ...body, source_text: body.text, source_segments: body.segments, segments, text: segments.map((item) => item.text).join(' '), profile_id: profile, provider: 'openai-compatible', model: 'process-engine', provider_snapshot: { provider: 'openai-compatible', model: 'process-engine', mode: 'chat' }, cache_key: `${profile}:${body.block_id}` };
          records.push(result); completed += 1; inFlight -= 1;
          payload = { result };
        } else if (pathname === `/api/jobs/${jobId}`) payload = jobs[0];
        await route.fulfill({ json: payload });
      } catch (error) {
        if (nativeClosing && page.isClosed() && /closed|disposed|interception|invalid/i.test(error.message)) { expectedRouteClosures.push({ pathname: url.pathname, message: error.message }); return; }
        errors.push(`${url.pathname}: ${error.message}`);
        try { await route.fulfill({ status: 503, json: { error: error.message } }); } catch (_) { /* The reader can close with a request outstanding. */ }
      }
    });
    if (nativeMode) profile = await session.configureTranslation();
    await page.goto(baseURL);
    if (nativeMode) {
      await page.locator('#onboarding-dialog[open]').waitFor();
      await page.locator('#onboarding-skip').click();
      await page.locator('#onboarding-dialog[open]').waitFor({ state: 'hidden' });
    }
    await page.locator('[data-view="library-view"]').click();
    await page.locator(`#library-view .library-row[data-job-id="${jobId}"]`).dblclick();
    await page.mouse.move(12, 12);
    const frame = page.frameLocator('#html-preview');
    await frame.locator('[data-block-id="process-0"] .paragraph-translate-trigger').waitFor();
    await frame.locator('[data-annotation-id="process-source-note"]').first().waitFor();
    async function checkReaderTheme(phase, scheme) {
      const result = await frame.locator('.reader-content').evaluate((content, { phase, scheme }) => {
        const doc = content.ownerDocument;
        const view = doc.defaultView;
        const probe = doc.createElement('div');
        probe.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';
        probe.innerHTML = '<span style="color:var(--reader-ui-muted,#625c56)"></span><figure><img></figure>';
        content.append(probe);
        try {
          const context = doc.createElement('canvas').getContext('2d', { willReadFrequently: true });
          const rgba = (color) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color; context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value);
          };
          const composite = (foreground, background) => foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
          const background = (element) => {
            const ancestors = [];
            for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
            return ancestors.reduce((color, node) => composite(rgba(view.getComputedStyle(node).backgroundColor), color), [255, 255, 255]);
          };
          const luminance = (color) => color.slice(0, 3).map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
          const measure = (element) => {
            const style = view.getComputedStyle(element);
            const backdrop = background(element);
            const text = composite(rgba(style.color), backdrop);
            const a = luminance(text); const b = luminance(backdrop);
            return { color: style.color, background: backdrop, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
          };
          const block = content.querySelector('[data-block-id="process-0"]');
          const source = block.querySelector('.reader-source-sentence') || block;
          const translation = block.querySelector('.translation-text');
          return { phase, scheme, matchesDark: view.matchMedia('(prefers-color-scheme: dark)').matches, body: measure(doc.body), content: measure(content), heading: measure(content.querySelector('h2')), source: measure(source), math: [...source.querySelectorAll('math,math mi,math mo,math mn')].map(measure), highlight: measure(block.querySelector('[data-annotation-id="process-source-note"]')), mutedColor: view.getComputedStyle(probe.querySelector('span')).color, translation: translation ? measure(translation) : null, formulaFilter: view.getComputedStyle(block.querySelector('.reader-source-sentence img.math-source-inline') || block.querySelector('img.math-source-inline')).filter, figureFilter: view.getComputedStyle(probe.querySelector('figure img')).filter };
        } finally { probe.remove(); }
      }, { phase, scheme });
      themeChecks.push(result);
      assert.equal(result.matchesDark, scheme === 'dark', 'The embedded reader must follow the requested color scheme.');
      for (const [name, text] of Object.entries({ body: result.body, content: result.content, heading: result.heading, source: result.source, highlight: result.highlight })) {
        assert.equal(text.color, result.body.color, `${phase}: ${name} must inherit the reader text color.`);
        assert(text.contrast >= 4.5, `${phase}: ${name} contrast ${text.contrast} must remain readable in ${scheme} mode.`);
      }
      assert(result.math.length > 0, 'The theme regression must exercise actual source MathML.');
      for (const math of result.math) {
        assert.equal(math.color, result.body.color, `${phase}: MathML must retain the source text color.`);
        assert(math.contrast >= 4.5, `${phase}: MathML must remain readable in ${scheme} mode.`);
      }
      if (phase === 'translated') {
        assert(result.translation, 'The translated theme check must exercise a real interlinear row.');
        assert.equal(result.translation.color, result.mutedColor, 'Chinese interlinear rows must retain the muted text color.');
        assert.notEqual(result.translation.color, result.source.color, 'Source and translated text must retain their separate color roles.');
        assert(result.translation.contrast >= 4.5, 'Chinese interlinear text must remain readable against the reader background.');
      }
      if (scheme === 'dark') assert.match(result.formulaFilter, /^invert\(0\.86\)$/u, 'Black formula SVG images must be inverted in dark mode.');
      else assert.equal(result.formulaFilter, 'none', 'Formula SVG images must retain their original pixels in light mode.');
      assert.equal(result.figureFilter, 'none', 'Ordinary figure images must not receive the formula color filter.');
    }
    if (!baseline) {
      await checkReaderTheme('ready', colorScheme);
      const alternateScheme = colorScheme === 'dark' ? 'light' : 'dark';
      await page.emulateMedia({ colorScheme: alternateScheme, reducedMotion: 'reduce' });
      await checkReaderTheme('theme-switch', alternateScheme);
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await checkReaderTheme('theme-restored', colorScheme);
    }
    await frame.locator('.reader-content').evaluate((content) => {
      const doc = content.ownerDocument;
      const view = doc.defaultView;
      const metrics = view.__processMetrics = { phase: 'paragraph-start', phases: [{ phase: 'paragraph-start', startTime: view.performance.now(), translatedParagraphs: 0 }], phaseDeltas: {}, frames: 0, deltas: [], longtasks: [], longtaskDetails: [], samples: 0, checkedSentences: 0, checkedTranslationRows: 0, misaligned: [], overlaps: [], alternationViolations: [], settledMutations: 0, stable: null, checkedBlocks: new Set() };
      new view.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          metrics.longtasks.push(entry.duration);
          metrics.longtaskDetails.push({ phase: metrics.phases.findLast((phase) => phase.startTime <= entry.startTime)?.phase, startTime: entry.startTime, duration: entry.duration, translatedParagraphs: content.querySelectorAll('.reader-sentence-pairs').length });
        }
      }).observe({ type: 'longtask', buffered: false });
      const rectangles = (root) => {
        const rects = [];
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          if (text.parentElement.closest('button,.annotation-note-trigger,.translation-source-label')) continue;
          const range = doc.createRange(); range.selectNodeContents(text);
          rects.push(...[...range.getClientRects()].filter((rect) => rect.width > .5 && rect.height > .5));
        }
        rects.push(...[...root.querySelectorAll('math,img')].map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > .5 && rect.height > .5));
        return rects;
      };
      const first = (root) => {
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) {
          if (text.parentElement.closest('button,.annotation-note-trigger,.translation-source-label')) continue;
          const offset = text.data.search(/\S/u); if (offset < 0) continue;
          const range = doc.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
          const rect = range.getBoundingClientRect(); if (rect.width && rect.height) return rect;
        }
        return null;
      };
      const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      let previous;
      function sample(now) {
        if (metrics.stopped) return;
        if (previous) {
          metrics.deltas.push(now - previous);
          (metrics.phaseDeltas[metrics.phase] ||= []).push(now - previous);
        }
        previous = now; metrics.frames += 1;
        const blocks = [...content.querySelectorAll('.reader-sentence-pairs')];
        const newlyTranslated = blocks.filter((block) => !metrics.checkedBlocks.has(block.dataset.blockId));
        const visible = blocks.filter((block) => { const rect = block.getBoundingClientRect(); return rect.bottom > 0 && rect.top < view.innerHeight; });
        for (const block of new Set([...newlyTranslated, ...visible])) {
          if (!block.querySelector('.reader-translation-line')) continue;
          metrics.checkedBlocks.add(block.dataset.blockId); metrics.samples += 1;
          const sources = [...block.querySelectorAll(':scope > .reader-source-sentence')];
          const translations = [...block.querySelectorAll(':scope > .reader-sentence-translation')];
          const sourceRects = sources.flatMap(rectangles);
          const sourceRows = [];
          for (const rect of sources.flatMap((source) => [...source.getClientRects()]).sort((a, b) => a.top - b.top)) {
            if (rect.width > .5 && rect.height > .5 && !sourceRows.some((top) => Math.abs(top - rect.top) < 2)) sourceRows.push(rect.top);
          }
          const translationRows = sourceRows.map(() => []);
          const earlier = [];
          translations.forEach((translation, index) => {
            const source = first(sources[index]); const translated = first(translation);
            metrics.checkedSentences += 1;
            if ((!source || !translated || Math.abs(source.left - translated.left) > 1) && metrics.misaligned.length < 20) metrics.misaligned.push({ block: block.dataset.blockId, sentence: index, source: source?.left, translation: translated?.left });
            const walker = doc.createTreeWalker(translation.querySelector('.translation-text'), NodeFilter.SHOW_TEXT);
            let text;
            while ((text = walker.nextNode())) {
              if (!text.data.trim() || text.parentElement.closest('math,.katex,.math-source-visual,sup,sub,button')) continue;
              const range = doc.createRange(); range.selectNodeContents(text);
              for (const rect of range.getClientRects()) {
                if (rect.width <= .5 || rect.height <= .5) continue;
                const row = sourceRows.findLastIndex((top) => top < rect.top);
                if (row < 0) continue;
                if (!translationRows[row].some((top) => Math.abs(top - rect.top) < 2)) translationRows[row].push(rect.top);
              }
            }
            const rects = rectangles(translation);
            if (rects.some((rect) => sourceRects.some((sourceRect) => overlaps(rect, sourceRect)) || earlier.some((other) => overlaps(rect, other))) && metrics.overlaps.length < 20) metrics.overlaps.push({ block: block.dataset.blockId, sentence: index, frame: metrics.frames });
            earlier.push(...rects);
          });
          translationRows.forEach((tops, row) => {
            metrics.checkedTranslationRows += tops.length;
            if (tops.length > 1 && metrics.alternationViolations.length < 20) metrics.alternationViolations.push({ block: block.dataset.blockId, row, tops, frame: metrics.frames });
          });
        }
        if (!metrics.stable && blocks.length >= 8) {
          const block = blocks[0];
          metrics.stable = { block, sources: [...block.querySelectorAll('.reader-source-sentence')], lines: [...block.querySelectorAll('.reader-translation-line')], mark: block.querySelector('[data-annotation-id="process-source-note"]') };
          metrics.observer = new view.MutationObserver((changes) => { metrics.settledMutations += changes.filter((change) => change.type !== 'attributes' || !['class', 'data-annotation-drawing'].includes(change.attributeName)).length; });
          metrics.observer.observe(block, { childList: true, subtree: true, characterData: true });
        }
        view.requestAnimationFrame(sample);
      }
      view.requestAnimationFrame(sample);
    });
    if (tracePath) {
      traceClient = await page.context().newCDPSession(page);
      await traceClient.send('Profiler.enable');
      await traceClient.send('Profiler.start');
      await traceClient.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.user_timing', transferMode: 'ReturnAsStream' });
    }
    started = Date.now();
    await page.locator('#full-translate-button').click();
    await page.waitForFunction(() => document.querySelector('#translation-progress-count')?.textContent.includes('/ 233'));
    await frame.locator('.reader-sentence-pairs').nth(15).waitFor({ state: 'attached' });
    if (!baseline) await checkReaderTheme('translated', colorScheme);
    assert(inFlight > 0 && completed < count, 'Interaction must occur while delayed translation requests remain outstanding.');
    const scrolled = await frame.locator('[data-block-id="process-8"]').evaluate((node) => { node.scrollIntoView({ block: 'center', behavior: 'instant' }); return node.ownerDocument.scrollingElement.scrollTop; });
    assert(scrolled > 0, 'The reader must scroll during translation.');
    const interactionParagraph = frame.locator('[data-block-id="process-8"]');
    async function interactionPhase(phase) {
      const event = await interactionParagraph.evaluate((block, name) => {
        const view = block.ownerDocument.defaultView;
        const metrics = view.__processMetrics;
        const event = { phase: name, startTime: view.performance.now(), translatedParagraphs: block.closest('.reader-content').querySelectorAll('.reader-sentence-pairs').length };
        metrics.phase = name; metrics.phases.push(event);
        return event;
      }, phase);
      (manualSelection.phases ||= []).push(event);
    }
    async function dragPoints(surface) {
      const geometry = await interactionParagraph.evaluate((block, targetSurface) => {
        const doc = block.ownerDocument;
        const view = doc.defaultView;
        const roots = targetSurface === 'paper' ? [...block.querySelectorAll(':scope > .reader-source-sentence')] : [...block.querySelectorAll(':scope > .reader-sentence-translation .translation-text')];
        const rows = [];
        for (const root of roots) {
          const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let text;
          while ((text = walker.nextNode())) {
            if (text.parentElement.closest('math,.katex,.math-source-visual,sup,sub,button,.reader-interlinear-gap')) continue;
            for (let index = 0; index < text.length; index += 1) {
              if (!text.data[index].trim()) continue;
              const range = doc.createRange(); range.setStart(text, index); range.setEnd(text, index + 1);
              const rect = range.getBoundingClientRect();
              if (rect.width <= .5 || rect.height <= .5 || rect.top < 8 || rect.bottom > view.innerHeight - 8) continue;
              const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
              const hit = doc.elementFromPoint(x, y);
              if (!hit || Boolean(hit.closest('.my-scholar-translation')) !== (targetSurface === 'translation')) continue;
              let row = rows.find((item) => Math.abs(item.top - rect.top) < 2);
              if (!row) { row = { top: rect.top, characters: [] }; rows.push(row); }
              row.characters.push({ left: rect.left, right: rect.right, y });
            }
          }
        }
        rows.sort((a, b) => a.top - b.top);
        for (const row of rows) row.characters.sort((a, b) => a.left - b.left);
        const usable = rows.filter((row) => row.characters.length > 12);
        const lastRow = targetSurface === 'paper' ? 2 : 1;
        if (usable.length <= lastRow) throw new Error(`Not enough visible ${targetSurface} rows for a real multiline drag: ${usable.length}`);
        const first = usable[0].characters[3];
        const last = usable[lastRow].characters[Math.min(18, usable[lastRow].characters.length - 2)];
        return { start: { x: first.left + .2, y: first.y }, end: { x: last.right - .2, y: last.y }, rowCount: lastRow + 1, width: view.innerWidth, height: view.innerHeight };
      }, surface);
      const box = await page.locator('#html-preview').boundingBox();
      assert(box);
      const point = ({ x, y }) => ({ x: box.x + x * box.width / geometry.width, y: box.y + y * box.height / geometry.height });
      return { start: point(geometry.start), end: point(geometry.end), rowCount: geometry.rowCount };
    }
    async function clearManualSelection() {
      await interactionPhase('selection-clear');
      await page.keyboard.press('Escape');
      await interactionParagraph.evaluate((block) => block.ownerDocument.getSelection().removeAllRanges());
      await page.waitForFunction(() => {
        const doc = document.querySelector('#html-preview')?.contentDocument;
        return doc && !doc.getElementById('reader-text-selection-overlay') && !doc.getSelection().toString();
      });
      await page.locator('#selection-popover').waitFor({ state: 'hidden' });
    }
    async function dragSelection(surface, direction) {
      selectionSurface = surface;
      manualSelection.phase = `${surface}-${direction}`;
      await interactionPhase(manualSelection.phase);
      const points = await dragPoints(surface);
      const from = direction === 'backward' ? points.end : points.start;
      const to = direction === 'backward' ? points.start : points.end;
      const interactionStarted = Date.now();
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      try { await page.mouse.move(to.x, to.y, { steps: 24 }); }
      finally { await page.mouse.up(); }
      await page.locator('#selection-popover').waitFor({ state: 'visible' });
      const responseMs = Date.now() - interactionStarted;
      await frame.locator('#reader-text-selection-overlay path').waitFor({ state: 'attached' });
      const snapshot = await interactionParagraph.evaluate((block, selectedSurface) => {
        const doc = block.ownerDocument;
        const view = doc.defaultView;
        const nativeRange = doc.getSelection().getRangeAt(0);
        const details = [];
        const oppositeRects = [];
        const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node;
        const rectangles = (range) => [...range.getClientRects()].filter((rect) => rect.width > .5 && rect.height > .5).map((rect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }));
        while ((node = walker.nextNode())) {
          const element = node.parentElement;
          if (element.closest('button,.annotation-note-trigger,.paragraph-translate-trigger,.translation-source-label,.translation-retained-status,.reader-interlinear-gap')) continue;
          const translated = Boolean(element.closest('.my-scholar-translation'));
          const range = doc.createRange(); range.selectNodeContents(node);
          if (translated !== (selectedSurface === 'translation')) { oppositeRects.push(...rectangles(range)); continue; }
          if (!nativeRange.intersectsNode(node)) continue;
          if (nativeRange.compareBoundaryPoints(Range.START_TO_START, range) > 0) range.setStart(nativeRange.startContainer, nativeRange.startOffset);
          if (nativeRange.compareBoundaryPoints(Range.END_TO_END, range) < 0) range.setEnd(nativeRange.endContainer, nativeRange.endOffset);
          if (range.collapsed) continue;
          details.push({ text: range.toString(), sameTextNode: node === range.startContainer && node === range.endContainer, translated, source: Boolean(element.closest('.reader-source-sentence')), fontSize: parseFloat(view.getComputedStyle(element).fontSize), rects: rectangles(range) });
        }
        const overlay = doc.getElementById('reader-text-selection-overlay');
        const paths = [...overlay.querySelectorAll('path')];
        const pathData = paths.map((path) => path.getAttribute('d') || '').join('');
        const paintedRects = [...pathData.matchAll(/M([\d.e+-]+)\s+([\d.e+-]+)h([\d.e+-]+)v([\d.e+-]+)h([\d.e+-]+)Z/gu)].map((match) => ({ left: Number(match[1]), top: Number(match[2]), width: Number(match[3]), height: Number(match[4]), closingWidth: Number(match[5]) }));
        const overlayStyle = view.getComputedStyle(overlay);
        return { nativeText: doc.getSelection().toString(), surface: overlay.dataset.surface, gateSurface: doc.documentElement.dataset.readerSelectionSurface, overlay: { tag: overlay.localName, ariaHidden: overlay.getAttribute('aria-hidden'), position: overlayStyle.position, pointerEvents: overlayStyle.pointerEvents, pathCount: paths.length, pathData, pathFill: view.getComputedStyle(paths[0]).fill, interceptsPointer: paintedRects.some((rect) => doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('#reader-text-selection-overlay')) }, nativeSelectionBackground: view.getComputedStyle(block.querySelector('.reader-source-sentence'), '::selection').backgroundColor, ranges: details, paintedRects, oppositeRects };
      }, surface);
      snapshot.quote = await page.locator('#selected-context .selected-context-quote').textContent();
      snapshot.direction = direction; snapshot.responseMs = responseMs; snapshot.dragRows = points.rowCount;
      snapshot.withOutstanding = inFlight > 0 && completed < count;
      manualSelection.snapshots.push(snapshot);
      snapshot.paintedRows = [];
      for (const rect of snapshot.paintedRects) {
        if (!snapshot.paintedRows.some((top) => Math.abs(top - rect.top) < 2)) snapshot.paintedRows.push(rect.top);
      }
      assert(snapshot.paintedRows.length >= points.rowCount, 'The real selection must paint every crossed text row.');
      assert(snapshot.withOutstanding, 'Manual selection must work while paragraph requests remain outstanding.');
      assert.equal(snapshot.surface, surface);
      assert.equal(snapshot.gateSurface, surface);
      assert.equal(snapshot.overlay.tag, 'svg');
      assert.equal(snapshot.overlay.ariaHidden, 'true');
      assert.equal(snapshot.overlay.position, 'fixed');
      assert.equal(snapshot.overlay.pointerEvents, 'none');
      assert.equal(snapshot.overlay.interceptsPointer, false, 'The precise selection layer must not intercept text interaction.');
      assert.equal(snapshot.overlay.pathCount, 1, 'Selection glyph rectangles share one SVG path.');
      assert.notEqual(snapshot.overlay.pathFill, 'none');
      const expectedRects = snapshot.ranges.flatMap((range) => range.rects);
      assert(snapshot.paintedRects.length > 1, 'A multiline selection must paint individual text rectangles.');
      assert.equal(snapshot.paintedRects.length, expectedRects.length, 'Every selected text-node rectangle must be painted exactly once.');
      const sameRect = (a, b) => ['left', 'top', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= .1);
      const remainingRects = [...expectedRects];
      for (const painted of snapshot.paintedRects) {
        assert(Math.abs(painted.width + painted.closingWidth) <= .1, 'Each SVG subpath must close its glyph rectangle.');
        const index = remainingRects.findIndex((expected) => sameRect(painted, expected));
        assert(index >= 0, `Selection paint must match a selected text-node glyph rectangle: ${JSON.stringify(painted)}`);
        remainingRects.splice(index, 1);
        assert(!snapshot.oppositeRects.some((other) => Math.min(painted.left + painted.width, other.left + other.width) - Math.max(painted.left, other.left) > 1 && Math.min(painted.top + painted.height, other.top + other.height) - Math.max(painted.top, other.top) > 1), 'Selection paint must not overlap any text from the other language surface.');
      }
      assert.equal(snapshot.nativeSelectionBackground, 'rgba(0, 0, 0, 0)', 'The native tall line box must be transparent while precise glyph rectangles are painted.');
      assert(snapshot.ranges.length > 1, 'A multiline selection must highlight its individual text nodes.');
      for (const range of snapshot.ranges) {
        assert(range.sameTextNode, 'Each painted range must stay inside one exact text node.');
        assert.equal(range.translated, surface === 'translation', 'A painted range must stay on its selected language surface.');
        if (surface === 'paper') assert(range.source, 'Every English selection range must belong to the original sentence.');
        assert.doesNotMatch(range.text, /\u200b|\u200c|\u200d|\ufeff/u, 'Painted ranges must exclude invisible spacer characters.');
        for (const rect of range.rects) assert(rect.height <= range.fontSize * 1.8 + 2, `Selection paint extends past its text glyph: ${JSON.stringify(range)}`);
      }
      if (surface === 'paper') {
        assert.match(snapshot.nativeText, /[A-Za-z]{3}/u);
        assert.doesNotMatch(snapshot.nativeText, /\p{Script=Han}/u, 'Dragging English across interlinear rows must not include native Chinese text.');
        assert.match(snapshot.quote, /[A-Za-z]{3}/u);
        assert.doesNotMatch(snapshot.quote, /\p{Script=Han}/u, 'Selected context must contain only the original English surface.');
        await page.locator('#selection-translation-result[data-state="ready"]').waitFor();
      } else {
        assert.match(snapshot.nativeText, /\p{Script=Han}/u);
        assert.match(snapshot.quote, /\p{Script=Han}/u);
        assert.doesNotMatch(snapshot.nativeText, /Physical theories|designing experiments|exploring new science/u, 'Starting in Chinese must exclude the original English sentence.');
        await page.locator('#selection-translation-result').filter({ hasText: '当前选区已是译文' }).waitFor();
      }
      const screenshot = path.join(artifactDirectory, `guzi-manual-selection-${nativeMode ? 'electron-native' : baseline ? 'baseline' : 'chromium'}-${surface}-${direction}.png`);
      await interactionPhase(`${surface}-${direction}-screenshot`);
      await page.screenshot({ path: screenshot });
      manualSelection.screenshots.push(screenshot);
      return snapshot;
    }
    await interactionPhase('source-hover');
    const points = await dragPoints('paper');
    const hoverStarted = Date.now();
    const beforeHoverSelectionRequests = selectionRequests.length;
    await page.mouse.move(points.start.x, points.start.y);
    await page.waitForTimeout(700);
    const hoverMs = Date.now() - hoverStarted;
    manualSelection.hoverRequests = selectionRequests.length - beforeHoverSelectionRequests;
    assert.equal(manualSelection.hoverRequests, 0, 'Hovering ordinary source text must not issue a sentence translation request.');
    assert.equal(await page.locator('#selection-popover').isVisible(), false, 'Hovering ordinary source text must not open the manual selection toolbar.');
    assert.equal(await interactionParagraph.evaluate((block) => block.ownerDocument.getSelection().toString()), '', 'Hovering must not synthesize a native selection.');
    manualSelection.hoverToolbarAbsent = true;
    const forward = await dragSelection('paper', 'forward');
    const manualSelectionWithOutstanding = forward.withOutstanding;
    await interactionPhase('selection-copy');
    await page.locator('#selection-copy').hover();
    const copyStarted = Date.now();
    await page.locator('#selection-copy').click();
    await page.waitForFunction((quote) => window.__processCopiedText === quote, forward.quote);
    manualSelection.copyMs = Date.now() - copyStarted;
    manualSelection.copyVerified = true;
    await clearManualSelection();
    const backward = await dragSelection('paper', 'backward');
    assert.equal(backward.quote, forward.quote, 'Both real drag directions must select the same canonical English text.');
    await clearManualSelection();
    const beforeChineseRequests = selectionRequests.length;
    await dragSelection('translation', 'forward');
    assert.equal(selectionRequests.length, beforeChineseRequests, 'Selecting existing Chinese must not request another translation.');
    await clearManualSelection();
    manualSelection.cleared = true;
    await interactionPhase('paragraphs-after-manual-clear');
    manualSelection.requestCount = selectionRequests.length;
    assert(selectionRequests.length >= 1, 'A partial multiline English selection must exercise the independent selection translation request.');
    assert(selectionRequests.every((request) => request.surface === 'paper' && !/\p{Script=Han}/u.test(request.text)), 'Every selection API request must contain only English source text.');
    selectionSurface = null;
    await page.mouse.move(12, 12);
    await frame.locator('.reader-sentence-pairs').nth(count - 4).waitFor({ state: 'attached', timeout: 120000 });
    assert.equal(completed, count - 3);
    assert.equal(inFlight, 3);
    await frame.locator('[data-block-id="process-0"]').evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(250);
    const metrics = await frame.locator('.reader-content').evaluate((content) => {
      const value = content.ownerDocument.defaultView.__processMetrics;
      value.stopped = true; value.observer?.disconnect();
      const stable = value.stable;
      return { phases: value.phases, phaseFrameStats: Object.fromEntries(Object.entries(value.phaseDeltas).map(([phase, deltas]) => [phase, { frames: deltas.length, p95FrameMs: [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length * .95)], maxFrameMs: Math.max(...deltas) }])), frames: value.frames, samples: value.samples, checkedSentences: value.checkedSentences, checkedTranslationRows: value.checkedTranslationRows, checkedBlocks: value.checkedBlocks.size, misaligned: value.misaligned, overlaps: value.overlaps, alternationViolations: value.alternationViolations, settledMutations: value.settledMutations, sameSourceNodes: stable.sources.every((node, i) => node === stable.block.querySelectorAll('.reader-source-sentence')[i]), sameLineNodes: stable.lines.every((node, i) => node === stable.block.querySelectorAll('.reader-translation-line')[i]), sourceMarkRetained: stable.mark?.isConnected, maxFrameMs: Math.max(...value.deltas), p95FrameMs: [...value.deltas].sort((a, b) => a - b)[Math.floor(value.deltas.length * .95)], longtasks: value.longtasks, longtaskDetails: value.longtaskDetails, maxLongtaskMs: Math.max(0, ...value.longtasks) };
    });
    await stopTrace();
    await frame.locator('[data-block-id="process-0"]').screenshot({ path: path.join(artifactDirectory, `guzi-interleaved-sentence-${nativeMode ? 'electron-native' : baseline ? 'baseline' : 'new'}-complex-paragraph.png`) });
    if (nativeMode) {
      await page.screenshot({ path: path.join(artifactDirectory, 'guzi-interleaved-sentence-electron-full-window.png') });
      console.error(`[guzi-native] READY pending=${inFlight} mainPid=${session.info.mainPid} backendPid=${session.info.backendPid} tempRoot=${session.tempRoot}`);
      const inspectionMs = Number(process.env.MY_SCHOLAR_ELECTRON_INSPECTION_MS || 0);
      if (inspectionMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(inspectionMs, 30000)));
    }
    const closeStarted = Date.now();
    await page.locator(`[data-close-job-id="${jobId}"]`).click();
    await page.locator('#html-preview').waitFor({ state: 'detached' });
    const closeMs = Date.now() - closeStarted;
    assert.equal(inFlight, 3, 'Closing the reader is exercised with live requests.');
    let nativeClose = null;
    if (nativeMode) {
      nativeClosing = true;
      assert.equal(inFlight, 3, 'The actual BrowserWindow must close with three translation requests outstanding');
      nativeClose = await session.closeNativeWindow();
      assert.equal(inFlight, 3, 'The native save gate must not depend on unfinished translation requests');
    }
    releaseTail();
    if (!nativeMode) await page.waitForFunction(() => document.querySelector('[data-view="library-view"]') !== null);
    const deadline = Date.now() + 10000;
    while (completed + cancelledRequests < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    report = { mode: nativeMode ? 'electron-native' : 'managed-chromium', ...(nativeMode ? { native: session.info, nativeClose, expectedRouteClosures, realApiResponses } : {}), baseline, colorScheme, themeChecks, passed: false, ...(tracePath ? { tracePath } : {}), paragraphs: count, translatedBeforeClose: count - 3, completed, cancelledRequests, peakInFlight, durationMs: Date.now() - started, closeMs, hoverMs, manualSelectionWithOutstanding, manualSelection: { ...manualSelection, requests: selectionRequests }, ...metrics };
    assert.deepEqual(errors, []);
    assert.equal(requests.length, count);
    assert.equal(completed + cancelledRequests, count);
    if (nativeMode) {
      assert.equal(completed, count - 3);
      assert.equal(cancelledRequests, 3);
      assert(realApiResponses.some((response) => response.path === "/api/jobs" && response.status === 200), 'Native jobs must come from the real Python backend');
      assert(!realApiResponses.some((response) => response.status >= 500), 'Real backend requests must succeed');
      assert(nativeClose.nativeCloseMs < 1500, 'Native close must save and stop its backend without waiting for translations');
    }
    assert.equal(peakInFlight, 3);
    if (!baseline) {
      assert.equal(metrics.checkedBlocks, count - 3, 'Every arriving paragraph must be sampled before closing.');
      assert(metrics.checkedTranslationRows > 0, 'The translation process must sample visible Chinese rows.');
      assert.deepEqual(metrics.alternationViolations, [], 'The fixture has enough English rows: each English row may have only one Chinese row beneath it.');
      assert.deepEqual(metrics.misaligned, [], 'Every Chinese sentence must start at its English sentence x during translation.');
      assert.deepEqual(metrics.overlaps, [], 'No source/translation or translated sentence overlap may be visible in any sampled frame.');
      assert.equal(metrics.settledMutations, 0, 'Completed paragraphs must not be rebuilt as unrelated translations arrive.');
      assert(metrics.sameSourceNodes && metrics.sameLineNodes && metrics.sourceMarkRetained, 'Completed DOM and annotations must retain their identity.');
      assert(metrics.maxLongtaskMs < 250, `Translation produced a ${metrics.maxLongtaskMs} ms long task.`);
      assert(metrics.p95FrameMs < 45, `Translation p95 frame delay was ${metrics.p95FrameMs} ms.`);
      assert(closeMs < 1000, 'Closing the active reader must remain responsive.');
    }
  } catch (error) {
    failure = error;
    report ||= { baseline, colorScheme, themeChecks, passed: false, incomplete: true, paragraphs: count, completed, requests: requests.length, manualSelection: { ...manualSelection, requests: selectionRequests }, inFlight, peakInFlight, durationMs: Date.now() - started };
    report.error = error.message;
  } finally {
    releaseTail();
    try {
      try { await stopTrace(); } finally { await session.close(); }
      if (nativeMode && report) {
        report.cleanup = JSON.parse(fs.readFileSync(path.join(session.tempRoot, 'process-cleanup.json'), 'utf8'));
        assert.equal(session.diagnosticsAvailable, true, 'The native application diagnostic log must exist');
        const abnormal = session.diagnostics.split('\n').filter((line) => /window-unresponsive|renderer-process-gone|quit-error|window-close-error|stop-after-.*-error|startup-error/.test(line));
        assert.deepEqual(abnormal, [], 'Native diagnostics must contain no unresponsive, crashed, or failed close events');
      }
      assert(session.browserProcess.exitCode !== null || session.browserProcess.signalCode !== null, 'Managed browser process must exit.');
      if (report) report.passed = !failure;
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'Translation process test and cleanup failed') : error;
      report ||= { baseline, incomplete: true };
      report.passed = false;
      report.error = failure.message;
    } finally {
      if (report) {
        console.log(JSON.stringify(report));
        if (process.env.MY_SCHOLAR_PROCESS_REPORT) fs.writeFileSync(process.env.MY_SCHOLAR_PROCESS_REPORT, JSON.stringify(report, null, 2));
      }
    }
  }
  if (failure) throw failure;
})().catch((error) => { console.error(error); process.exitCode = 1; });
