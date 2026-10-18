const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const [baseURL, jobId, outputDirectory] = process.argv.slice(2);
assert.ok(baseURL && jobId, 'Usage: node toc_export_reader_smoke.js SYNTHETIC_URL JOB_ID [SCREENSHOT_DIR]');
let session;
(async () => {
  const descriptor = await (await fetch(`${baseURL}/api/jobs/${jobId}`)).json();
  assert.equal(descriptor.source_filename, 'Synthetic contents reader', 'Run only against the synthetic TOC fixture');
  session = await launchManagedChromium();
  const page = await session.browser.newPage({ viewport: { width: 1500, height: 980 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/health', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, ai: { services: { translation: { enabled: true, configured: true, model: 'synthetic-mock', profile_id: 'synthetic-mock' } } } }) }));
  await page.route('**/api/jobs/*/auto-highlights', (route) => route.fulfill({ contentType: 'application/json', body: '{"result":{"highlights":[]}}' }));
  await page.route('**/api/jobs/*/translate', (route) => {
    const payload = route.request().postDataJSON();
    requests.push(payload);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { text: `Mock: ${payload.text}`, profile_id: 'synthetic-mock', cached: false } }) });
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator(`.library-card[data-job-id="${jobId}"]`).first().dblclick();
  const frame = page.frameLocator('#html-preview');
  await frame.locator('#my-scholar-annotation-runtime-style').waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('#reader-view').classList.contains('is-document-loading'));
  const metrics = await frame.locator('body').evaluate((body) => {
    const doc = body.ownerDocument;
    const navs = [...doc.querySelectorAll('nav.paper-toc')];
    const links = [...doc.querySelectorAll('a.toc-link')];
    const top = doc.querySelector('[data-toc-level="1"]');
    const nested = doc.querySelector('[data-toc-level="2"]');
    const title = links[0].querySelector('.toc-title');
    const label = links[0].querySelector('.toc-page-label');
    return {
      navs: navs.length, rows: links.length, tocPages: navs.map((nav) => nav.dataset.page),
      idlessChildren: navs.every((nav) => !nav.querySelector('[data-block-id], [data-translate-block-id]')),
      targets: links.every((link) => /^#section-/.test(link.getAttribute('href')) && /^H[1-6]$/.test(doc.getElementById(link.hash.slice(1))?.tagName || '')),
      controls: navs.reduce((count, nav) => count + nav.querySelectorAll('.paragraph-translate-trigger').length, 0),
      font: parseFloat(getComputedStyle(title).fontSize), proseFont: parseFloat(getComputedStyle(doc.querySelector('p[data-block-id]')).fontSize),
      indent: [parseFloat(getComputedStyle(top).paddingLeft), parseFloat(getComputedStyle(nested).paddingLeft)],
      grid: getComputedStyle(links[0]).display, pageAlign: getComputedStyle(label).textAlign,
      pageAfterTitle: label.getBoundingClientRect().left >= title.getBoundingClientRect().right - 1,
    };
  });
  assert.equal(metrics.navs, 2);
  assert.equal(metrics.rows, 40);
  assert.equal(new Set(metrics.tocPages).size, 2);
  assert.ok(metrics.idlessChildren && metrics.targets);
  assert.equal(metrics.controls, 0);
  assert.equal(metrics.font, metrics.proseFont);
  assert.ok(metrics.indent[1] > metrics.indent[0]);
  assert.equal(metrics.grid, 'grid');
  assert.equal(metrics.pageAlign, 'right');
  assert.ok(metrics.pageAfterTitle);
  for (const selector of ['#outline-list', '#reader-chapter-list']) {
    assert.equal(await page.locator(selector).getByText('Contents', { exact: true }).count(), 0);
    const text = await page.locator(selector).textContent();
    assert.equal((text.match(/Synthetic topic/g) || []).length, 40, `${selector} must contain only actual headings once`);
  }
  if (outputDirectory) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    await page.screenshot({ path: path.join(outputDirectory, 'synthetic-toc-reader.png'), animations: 'disabled' });
  }
  const link = frame.locator('a.toc-link').nth(35);
  const href = await link.getAttribute('href');
  await link.click();
  await page.waitForFunction((targetId) => {
    const doc = document.querySelector('#html-preview').contentDocument;
    const rect = doc.getElementById(targetId).getBoundingClientRect();
    return rect.top >= -2 && rect.top < doc.defaultView.innerHeight / 2;
  }, href.slice(1));
  assert.equal(await page.locator('#quick-preview-panel.active-panel').count(), 0);
  const paragraph = frame.locator('p[data-block-id]').filter({ hasText: 'Ordinary selectable paragraph 36 ' }).first();
  await paragraph.evaluate((block) => {
    const doc = block.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(block.firstChild);
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#selection-popover:not([hidden])').waitFor();
  assert.match(await paragraph.evaluate((block) => block.ownerDocument.getSelection().toString()), /^Ordinary selectable paragraph 36 /);
  await paragraph.evaluate((block) => block.ownerDocument.getSelection().removeAllRanges());
  await paragraph.locator('.paragraph-translate-trigger').click();
  await frame.locator('.my-scholar-translation').filter({ hasText: 'Mock: Ordinary selectable paragraph 36 ' }).waitFor();
  await page.locator('#full-translate-button').click();
  await page.waitForFunction(() => document.querySelectorAll('#html-preview')[0].contentDocument.querySelectorAll('.my-scholar-translation:not(.is-pending)').length >= 41);
  assert.equal(requests.filter((payload) => String(payload.text).includes('Ordinary selectable paragraph')).length, 40);
  assert.ok(requests.every((payload) => !/Contents|Synthetic topic/.test(String(payload.text))), 'TOC rows and Contents must never enter paragraph/full-text translation requests');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ syntheticOnly: true, actualApp: true, metrics, outlineAndRail: true, headingAnchorScroll: true, noQuickPreview: true, ordinarySelection: true, ordinaryTranslation: true, fulltextTranslationRequests: requests.length, errors }));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (!session) return;
  const browserPid = session.browserProcess.pid;
  const args = session.browserProcess.spawnargs;
  await session.close();
  assert.ok(session.browserProcess.exitCode !== null || session.browserProcess.signalCode !== null, 'Managed Chromium must exit');
  console.log(JSON.stringify({ lifecycle: { browserPid, temporaryProfile: args.find((arg) => arg.startsWith('--user-data-dir=')), exited: true } }));
});
