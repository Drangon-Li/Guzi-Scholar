const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

const [baseURL, jobId] = process.argv.slice(2);
const canonical = 'Visible 🧪 prose12 costs $200 and formula [公式原图] after.';
let session;
let context;
(async () => {
  session = await launchManagedChromium();
  context = await session.browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const requests = [];
  let generation = false;
  await page.route('**/api/health', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ai: { services: { translation: { enabled: true, configured: true, model: 'synthetic-mock', profile_id: 'synthetic-mock' } } } }) }));
  await page.route('**/api/jobs/*/auto-highlights', (route) => route.fulfill({ contentType: 'application/json', body: '{"result":{"highlights":[]}}' }));
  await page.route('**/api/jobs/*/translate', (route) => {
    const payload = route.request().postDataJSON();
    requests.push(payload);
    return route.continue();
  });
  await page.route(`**/api/jobs/${jobId}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (generation) { body.active_render = '2'; body.links.html += '?synthetic-generation=2'; }
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/jobs', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (generation) body.jobs.forEach((job) => {
      if (job.job_id === jobId) { job.active_render = '2'; job.links.html += '?synthetic-generation=2'; }
    });
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/jobs/${jobId}/document.html*`, async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    if (generation) body = body.replaceAll('data-block-id="b-', 'data-block-id="new-b-').replace('Visible 🧪 prose', 'Reflow prefix. Visible 🧪 prose');
    await route.fulfill({ response, body });
  });
  const open = async () => {
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator(`.library-card[data-job-id="${jobId}"]`).first().dblclick();
    const frame = page.frameLocator('#html-preview');
    await frame.locator('#my-scholar-annotation-runtime-style').waitFor({ state: 'attached' });
    await page.waitForFunction(() => !document.querySelector('#reader-view').classList.contains('is-document-loading'));
    return frame;
  };
  let frame = await open();
  let paragraph = frame.locator('p[data-block-id]').filter({ hasText: 'Visible 🧪 prose' });
  const metrics = await paragraph.evaluate((block) => {
    const image = block.querySelector('img');
    const style = getComputedStyle(image);
    const copy = block.cloneNode(true);
    copy.querySelectorAll('button').forEach((node) => node.remove());
    return { canonical: copy.textContent, sup: block.querySelector('sup').textContent, visibleProse: block.firstChild.nodeValue, cropHeightEm: parseFloat(style.height) / parseFloat(style.fontSize), baselineEm: parseFloat(style.verticalAlign) / parseFloat(style.fontSize), cropWrapped: Boolean(image.closest('.my-scholar-media-block')), cropRole: image.getAttribute('role') };
  });
  assert.equal(metrics.canonical, canonical);
  assert.equal(metrics.sup, '12');
  assert.equal(metrics.visibleProse, 'Visible 🧪 prose');
  assert.ok(Math.abs(metrics.cropHeightEm - 1.25) < .02);
  assert.ok(Math.abs(metrics.baselineEm + .25) < .02);
  assert.equal(metrics.cropWrapped, false);
  assert.equal(metrics.cropRole, null);
  await paragraph.locator('.paragraph-translate-trigger').click();
  const translated = frame.locator('.my-scholar-translation').filter({ hasText: 'Mock: Visible' });
  await translated.locator('img.math-source-inline').waitFor();
  assert.equal(await translated.locator('sup').textContent(), '12');
  assert.ok(requests.some((payload) => payload.block_id && payload.text.includes('costs $200') && payload.text.match(/__MY_SCHOLAR_MATH_/g)?.length === 2));
  const quote = canonical.slice(canonical.indexOf('prose'), canonical.indexOf(' after.'));
  await paragraph.evaluate((block, selectedQuote) => {
    const doc = block.ownerDocument;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) if (!node.parentElement.closest('button')) nodes.push(node);
    const text = nodes.map((item) => item.nodeValue).join('');
    let start = text.indexOf(selectedQuote);
    let end = start + selectedQuote.length;
    const range = doc.createRange();
    for (const item of nodes) {
      if (start >= 0 && start < item.length) { range.setStart(item, start); start = -1; }
      else if (start >= 0) start -= item.length;
      if (end <= item.length) { range.setEnd(item, end); break; }
      end -= item.length;
    }
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    block.focus();
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, quote);
  await page.locator('#selection-popover:not([hidden])').waitFor();
  const clipboardEvent = await paragraph.evaluate((block) => {
    const transfer = new DataTransfer();
    const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer });
    block.dispatchEvent(event);
    return { prevented: event.defaultPrevented, text: transfer.getData('text/plain') };
  });
  assert.equal(clipboardEvent.text, quote);
  assert.equal(clipboardEvent.prevented, true);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clipboard, quote);
  await page.locator('#selection-underline').click();
  const underline = paragraph.locator('mark.my-scholar-underline');
  await underline.waitFor();
  const annotationId = await underline.getAttribute('data-annotation-id');
  const saved = await page.evaluate(async ({ id, annotationId }) => (await (await fetch(`/api/jobs/${id}/annotations`)).json()).annotations.find((item) => item.id === annotationId), { id: jobId, annotationId });
  assert.equal(saved.quote, quote);
  assert.equal(saved.start, canonical.indexOf(quote));
  assert.equal(saved.end, saved.start + quote.length);
  assert.equal(saved.quote_prefix, canonical.slice(0, saved.start));
  assert.equal(saved.quote_suffix, ' after.');
  frame = await open();
  await frame.locator(`mark[data-annotation-id="${annotationId}"]`).waitFor();
  const persisted = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/translations`)).json()).translations, jobId);
  const cachedParagraph = persisted.find((item) => item.block_id === saved.block_id);
  assert.equal(cachedParagraph.formulas.length, 2);
  assert.ok(cachedParagraph.formulas.every((formula) => Object.keys(formula).sort().join(',') === 'tex,token'));
  const replayed = frame.locator(`.my-scholar-translation[data-for="${saved.block_id}"]`);
  await replayed.locator('img.math-source-inline').waitFor();
  assert.equal(await replayed.locator('sup').textContent(), '12');
  generation = true;
  frame = await open();
  const relocated = frame.locator(`mark[data-annotation-id="${annotationId}"]`);
  await relocated.filter({ hasText: quote }).waitFor();
  const relocation = await relocated.evaluate((mark) => ({ text: mark.textContent, html: mark.outerHTML, parent: mark.parentElement.outerHTML }));
  assert.equal(relocation.text, quote, JSON.stringify(relocation));
  assert.match(await relocated.evaluate((mark) => mark.closest('[data-block-id]').dataset.blockId), /^new-b-/);
  assert.equal(await relocated.locator('sup').textContent(), '12');
  assert.equal(await relocated.locator('img').count(), 1);
  const scriptParagraph = frame.locator('p[data-block-id]').filter({ hasText: 'A second visible reference' });
  await scriptParagraph.locator('sup').evaluate((script) => {
    const doc = script.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(script);
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#selection-popover:not([hidden])').waitFor();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+U' : 'Control+Shift+U');
  await scriptParagraph.locator('mark.my-scholar-underline').waitFor();
  assert.equal(await scriptParagraph.locator('mark.my-scholar-underline').textContent(), '34');
  const latest = await page.evaluate(async (id) => (await (await fetch(`/api/jobs/${id}/annotations`)).json()).annotations, jobId);
  assert.equal(latest.find((item) => item.quote === '34').render_generation, '2');
  console.log(JSON.stringify({ syntheticOnly: true, translation: 'mock model through real server persistence; interaction and script/crop preservation only', persistedFormulaFields: Object.keys(cachedParagraph.formulas[0]).sort(), cachedLiveMarkupReplay: true, clipboard, metrics, quote, saved, reload: true, simulatedGenerationRelocation: true, quickUnderlineSuperscript: true }));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  try { await context?.close(); } finally { await session?.close(); }
});
