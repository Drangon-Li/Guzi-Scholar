'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
if (!baseURL) throw new Error('Run through run_ui_tests.js --only=zotero-anchor-mapping');
const jobId = 'dddddddddddddddd';

// Short synthetic text reproduces the inline-span, formula and footnote shapes;
// no paper text, source identifiers or personal comments belong in this fixture.
const equation = '<div class="equation-layout"><div class="equation-body"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><msub><mi>g</mi><mi>t</mi></msub><mo>:=</mo><msub><mo>max</mo><mrow><mi>s</mi><mo>∈</mo><mi>C</mi></mrow></msub><mo>⟨</mo><mo>−</mo><mo>∇</mo><mi>f</mi><mrow><mo>(</mo><msub><mi>x</mi><mi>t</mi></msub><mo>)</mo></mrow><mo>,</mo><msub><mi>s</mi><mi>t</mi></msub><mo>−</mo><msub><mi>x</mi><mi>t</mi></msub><mo>⟩</mo><mo>,</mo></mrow></math></div> <span class="equation-number">(4)</span></div>';
const equationNative = 'gt:=max s∈C ⟨−∇f (xt), st − xt⟩,';
const cases = [
  { id: 'hyphen-transfer', html: '😀 The <span>transfer-based</span> method works.', native: '😀 The transfer-based method works.', query: 'transferbased', selected: 'transfer-based', expected: 'transfer-based', hyphen: true },
  { id: 'hyphen-task', html: '😀 Stage <strong data-fixture-part="emphasis">Model Selection</strong>: task-specific choice.', native: '😀 Stage Model Selection: task-specific choice.', query: 'Model Selection: taskspecific', selected: 'Model Selection: task-specific', expected: 'Model Selection: task-specific', hyphen: true, part: 'emphasis' },
  { id: 'math-max', block: 'equation', tag: 'figure', html: equation, native: equationNative, query: 'max  s∈C ⟨−∇f (xt), st − xt⟩,', selected: 'max s∈C ⟨−∇f (xt), st − xt⟩,', expected: 'maxs∈C⟨−∇f(xt),st−xt⟩,', subscripts: 4 },
  { id: 'math-direction', block: 'equation', tag: 'figure', html: equation, native: equationNative, query: 'st − xt', selected: 'st − xt', expected: 'st−xt', subscripts: 2 },
  { id: 'math-gradient', block: 'equation', tag: 'figure', html: equation, native: equationNative, query: '−∇f (xt)', selected: '−∇f (xt)', expected: '−∇f(xt)', subscripts: 1 },
  { id: 'footnote-space', html: '😀 We use unknown information <sup data-fixture-part="footnote">1</sup>.', native: '😀 We use unknown information 1.', query: 'unknown information1.', selected: 'unknown information 1.', expected: 'unknown information 1.', part: 'footnote' },
  { id: 'second-gap', html: 'because the top-<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mi>k</mi></mrow></math> FW <span data-gap="first">gap</span> subsumes the original FW <span data-gap="second">gap</span>.', native: 'because the top-k FW gap subsumes the original FW gap.', query: 'gap', selected: 'gap', expected: 'gap', last: true },
];
function blockHTML(item) {
  const tag = item.tag || 'p';
  return `<${tag} class="${tag === 'figure' ? 'pdf-equation' : ''}" data-block-id="${item.block || item.id}" data-page="1">${item.html}</${tag}>`;
}

function mappedFixture() {
  const python = process.env.MY_SCHOLAR_PYTHON || 'python3';
  const result = spawnSync(python, ['-c', String.raw`
import json, sys
import zotero_merge as merge
cases = json.load(sys.stdin)
output = []
for item in cases:
    parser = merge._DocumentBlocks()
    parser.feed(item['blockHTML'])
    parser.close()
    block = parser.blocks[0]
    block['text'] = ''.join(block.pop('parts'))
    block['bbox'] = [0, 0, 600, 40]
    glyphs = [{'text': char, 'bbox': [10 + index * 5, 10, 14 + index * 5, 20],
               'line_hyphen': bool(item.get('hyphen') and char == '-')}
              for index, char in enumerate(item['native'])]
    selected_start = item['native'].rindex(item['selected']) if item.get('last') else item['native'].index(item['selected'])
    selected_end = selected_start + len(item['selected'])
    annotation = {'text': item['query'], 'position': {'pageIndex': 0, 'rects': [
        [10 + selected_start * 5, 780, 10 + selected_end * 5, 790]]}}
    geometry = {'1': {'width': 600, 'height': 800, 'pdf_width': 600, 'pdf_height': 800, '_pdf_glyphs': glyphs}}
    anchor = merge._anchor(annotation, [block], geometry)
    if not anchor:
        raise AssertionError('Synthetic anchor did not resolve: ' + item['id'])
    output.append({'id': item['id'], 'raw': block['text'], 'anchor': anchor})
json.dump(output, sys.stdout, ensure_ascii=False)
`], { cwd: path.join(__dirname, '..'), input: JSON.stringify(cases.map((item) => ({ ...item, blockHTML: blockHTML(item) }))), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'Anchor fixture generator failed');
  return JSON.parse(result.stdout).map((item, index) => {
    const fixture = cases[index];
    const expectedStart = fixture.last ? item.raw.lastIndexOf(fixture.expected) : item.raw.indexOf(fixture.expected);
    assert(expectedStart >= 0, `${item.id}: expected raw quote exists`);
    assert.equal(item.anchor.quote, fixture.expected, `${item.id}: store original DOM quote`);
    assert.equal(item.anchor.start, expectedStart, `${item.id}: UTF-16 start matches original DOM`);
    assert.equal(item.anchor.end, expectedStart + fixture.expected.length, `${item.id}: UTF-16 end matches original DOM`);
    return { ...item, annotation: { ...item.anchor, id: item.id, kind: index % 2 ? 'underline' : 'highlight', color: '#ffd400', source: 'manual', import_provider: 'zotero', import_unanchored: false, surface: 'paper', render_generation: 'base', note: `Synthetic comment ${index + 1}` } };
  });
}

(async () => {
  const fixtures = mappedFixture();
  const annotations = fixtures.map((item) => item.annotation);
  const html = `<!doctype html><html><head><style>body{margin:0}.reader-content{max-width:680px;margin:24px auto 180px}p{font-size:20px;line-height:1.7;margin:20px 0}sup,sub{font-size:.7em}</style></head><body data-zotero-anchor-fixture><main class="reader-content"><section class="pdf-page" data-page="1"><h1>Imported anchor fixture</h1>${[...new Map(cases.map((item) => [item.block || item.id, blockHTML(item)])).values()].join('')}</section></main></body></html>`;
  const job = { job_id: jobId, source_filename: 'Synthetic anchor fixture.pdf', status: 'completed', created_at: '2026-10-22T00:00:00Z', links: { html: `/api/jobs/${jobId}/document.html` }, manifest: { counts: { pages: 1 } } };
  const library = { folders: [], properties: [], views: [], display: { columns: [{ id: 'name', visible: true, order: 0 }] }, items: { [jobId]: { folder_ids: [], values: {}, metadata: { fields: {}, status: 'complete' } } } };
  let activeHTML = html; let activeAnnotations = annotations;
  const session = await launchManagedChromium();
  const errors = []; const unexpected = [];
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 1050 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const request = route.request(); const pathname = new URL(request.url()).pathname;
      let payload = {};
      if (pathname === '/api/jobs') payload = { jobs: [job] };
      else if (pathname === '/api/library') payload = { library };
      else if (pathname === '/api/health') payload = { ok: true, ai: { services: { translation: { enabled: false }, chat: { enabled: false } } } };
      else if (pathname === '/api/settings') payload = { metadata: { auto_retrieve: false }, ai: { translation: { enabled: false }, chat: { enabled: false } } };
      else if (pathname === '/api/parsing/providers') payload = { providers: [{ id: 'local-mineru', status: 'ready', ready: true }] };
      else if (pathname === '/api/library/location') payload = { location: {} };
      else if (pathname === '/api/account/status') payload = { authenticated: false };
      else if (pathname.startsWith('/api/library/items/')) payload = { library, item: library.items[jobId] };
      else if (pathname.endsWith('/document.html')) { await route.fulfill({ contentType: 'text/html', body: activeHTML }); return; }
      else if (pathname.endsWith('/annotations')) payload = { annotations: activeAnnotations };
      else if (pathname.endsWith('/translations')) payload = { translations: [] };
      else if (pathname.endsWith('/media-layout')) payload = { media_layout: { version: 1, items: {} } };
      else if (pathname.endsWith('/notes')) payload = { markdown: '' };
      else if (pathname.endsWith('/auto-highlights')) payload = { result: { status: 'mock', highlights: [] } };
      else if (pathname === `/api/jobs/${jobId}`) payload = job;
      else unexpected.push(`${request.method()} ${pathname}`);
      await route.fulfill({ json: payload });
    });
    const open = async () => {
      await page.locator('[data-view="library-view"]').click();
      await page.locator(`#library-view .library-row[data-job-id="${jobId}"]`).dblclick();
      const frame = page.frameLocator('#html-preview');
      await frame.locator('body[data-zotero-anchor-fixture]').waitFor();
      await page.locator('#reader-view.active-view:not(.is-document-loading)').waitFor();
      await frame.locator(':is(mark, mrow)[data-annotation-id="second-gap"]').waitFor();
      return frame;
    };
    const assertMarks = async (frame) => {
      assert.equal(await frame.locator(':is(mark, mrow)[data-annotation-id]').count(), fixtures.length);
      assert.equal(await frame.locator('math mark, math button').count(), 0, 'MathML must not contain HTML annotation wrappers or controls');
      assert.equal(await frame.locator('math').count(), 2, 'Overlapping marks must preserve the equation and inline math roots');
      assert.equal(await frame.locator('.annotation-note-trigger').count(), fixtures.length, 'Each annotation has exactly one comment button outside MathML');
      const originalMath = await frame.locator('body').evaluate((body, source) => {
        const original = new DOMParser().parseFromString(source, 'text/html');
        return [...original.querySelectorAll('math')].map((node) => node.outerHTML);
      }, html);
      const unwrappedMath = await frame.locator('math').evaluateAll((nodes) => nodes.map((node) => {
        const clone = node.cloneNode(true);
        clone.querySelectorAll('mrow[data-annotation-id]').forEach((mark) => mark.replaceWith(...mark.childNodes));
        return clone.outerHTML;
      }));
      assert.deepEqual(unwrappedMath, originalMath, 'Removing annotation rows restores the exact original MathML tree');
      for (let index = 0; index < fixtures.length; index += 1) {
        const fixture = fixtures[index]; const test = cases[index];
        const mark = frame.locator(`:is(mark, mrow)[data-annotation-id="${fixture.id}"]`);
        const actual = await mark.evaluate((node) => {
          const root = node.closest('[data-block-id]');
          const walker = node.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let raw = ''; let quote = ''; let visibleText = ''; let start = null; let end = null; let text;
          while ((text = walker.nextNode())) {
            if (text.parentElement.closest('.annotation-note-trigger,.paragraph-translate-trigger')) continue;
            if (node.contains(text)) {
              if (start == null) start = raw.length;
              end = raw.length + text.length; quote += text.nodeValue;
              const range = node.ownerDocument.createRange(); range.selectNodeContents(text);
              if ([...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) visibleText += text.nodeValue;
            }
            raw += text.nodeValue;
          }
          return { raw, start, end, quote, visibleText, block: root.dataset.blockId, rects: [...node.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).length };
        });
        assert.deepEqual(actual, { raw: fixture.raw, start: fixture.anchor.start, end: fixture.anchor.end, quote: fixture.anchor.quote, visibleText: fixture.anchor.quote, block: test.block || fixture.id, rects: actual.rects });
        if (!actual.rects) console.error('Invisible MathML annotation diagnostic', await mark.evaluate((node) => {
          const rect = (element) => ({ tag: element.tagName, namespace: element.namespaceURI, display: getComputedStyle(element).display, rects: [...element.getClientRects()].map((value) => ({ width: value.width, height: value.height })) });
          const range = node.ownerDocument.createRange(); range.selectNodeContents(node);
          return { mark: rect(node), parent: rect(node.parentElement), math: rect(node.closest('math')), contents: [...range.getClientRects()].map((value) => ({ width: value.width, height: value.height })), html: node.outerHTML };
        }));
        assert(actual.rects > 0, `${fixture.id}: mark covers visible source text`);
        if (test.subscripts) assert.equal(await mark.locator('msub').count(), test.subscripts, `${fixture.id}: selected MathML subscripts remain inside the mark`);
        if (test.part) {
          assert.equal(await mark.locator(`[data-fixture-part="${test.part}"]`).count(), 1, `${fixture.id}: complete inline structure remains inside the mark`);
          assert.equal(await frame.locator(`[data-block-id="${test.block || fixture.id}"] [data-fixture-part="${test.part}"]`).count(), 1, `${fixture.id}: inline structure is not duplicated`);
        }
      }
      assert.equal(await frame.locator('[data-gap="first"] :is(mark, mrow)[data-annotation-id], :is(mark, mrow)[data-annotation-id] [data-gap="first"]').count(), 0, 'First gap must remain unmarked');
      assert.equal(await frame.locator(':is(mark, mrow)[data-annotation-id="second-gap"] [data-gap="second"]').count(), 1, 'Geometry-selected second gap must be marked');
    };
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    let frame = await open();
    await assertMarks(frame);
    await page.screenshot({ path: '/tmp/guzi-zotero-anchor-mapping.png' });
    for (const annotation of annotations) {
      await frame.locator(`.annotation-note-trigger[data-annotation-id="${annotation.id}"]`).click();
      const popup = frame.locator(`.annotation-note-popover[data-annotation-id="${annotation.id}"]:not(.is-closing)`);
      await popup.locator('.annotation-note-popover-body').filter({ hasText: annotation.note }).waitFor();
      assert.equal(await popup.locator('.annotation-note-popover-quote').textContent(), annotation.quote);
      await popup.locator('[data-action="close"]').click();
    }
    await page.reload({ waitUntil: 'networkidle' });
    frame = await open();
    await assertMarks(frame);
    const boundaries = [
      { id: 'mixed-complete', raw: '😀 Use x now.', html: '😀 Use <math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>x</mi></mrow></math> now.', quote: 'Use x', supported: true },
      { id: 'mixed-partial-start', raw: '😀 a+b follows.', html: '😀 <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mo>+</mo><mi>b</mi></math> follows.', quote: 'b follows.', supported: false },
      { id: 'mixed-partial-end', raw: '😀 Before a+b.', html: '😀 Before <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><mo>+</mo><mi>b</mi></math>.', quote: 'Before a', supported: false },
      { id: 'partial-subscript', raw: '😀 A xt formula.', html: '😀 A <math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><msub><mi>x</mi><mi>t</mi></msub></mrow></math> formula.', quote: 'x', supported: false },
      { id: 'partial-token', raw: '😀 An alpha token.', html: '😀 An <math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>alpha</mi></mrow></math> token.', quote: 'lph', supported: false },
    ];
    activeHTML = html.replace('</section>', `${boundaries.map((item) => `<p data-block-id="${item.id}" data-page="1">${item.html}</p>`).join('')}</section>`);
    activeAnnotations = [...annotations, ...boundaries.map((item) => ({ id: item.id, block_id: item.id, start: item.raw.indexOf(item.quote), end: item.raw.indexOf(item.quote) + item.quote.length, quote: item.quote, page: 1, kind: 'highlight', source: 'manual', surface: 'paper', render_generation: 'base', note: 'Synthetic boundary comment' }))];
    await page.reload({ waitUntil: 'networkidle' });
    frame = await open();
    for (const item of boundaries) {
      const block = frame.locator(`[data-block-id="${item.id}"]`);
      assert.equal(await block.locator(':is(mark, mrow)[data-annotation-id]').count(), Number(item.supported), `${item.id}: only structurally safe exact ranges are marked`);
      const actual = await block.evaluate((node) => {
        const clone = node.cloneNode(true);
        clone.querySelectorAll('.annotation-note-trigger,.paragraph-translate-trigger').forEach((control) => control.remove());
        clone.querySelectorAll(':is(mark,mrow)[data-annotation-id]').forEach((mark) => mark.replaceWith(...mark.childNodes));
        return { raw: clone.textContent, math: clone.querySelector('math').outerHTML };
      });
      assert.equal(actual.raw, item.raw);
      const expectedMath = await block.evaluate((node, source) => new DOMParser().parseFromString(source, 'text/html').querySelector('math').outerHTML, item.html);
      assert.equal(actual.math, expectedMath, `${item.id}: original formula stays intact`);
      if (item.supported) {
        const mark = block.locator('mark[data-annotation-id]');
        assert.equal(await mark.textContent(), item.quote, 'Mixed selection must not gain any unselected formula text');
        assert((await mark.boundingBox()).width > 0);
      }
    }
    await frame.locator('.annotation-note-trigger[data-annotation-id="mixed-complete"]').click();
    await frame.locator('.annotation-note-popover-body').filter({ hasText: 'Synthetic boundary comment' }).waitFor();
    assert.equal(await frame.locator('math mark,math button').count(), 0);
    assert.equal(await frame.locator('.annotation-note-trigger').count(), fixtures.length + 1);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log('Zotero normalized anchor mapping: 7 visible original DOM ranges, exact MathML trees, second gap, comments, reload and mixed/partial boundary safety passed');
  } finally {
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
