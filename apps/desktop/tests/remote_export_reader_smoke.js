const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

const baseURL = process.argv[2];
const jobId = process.argv[3];
let session;
(async () => {
  session = await launchManagedChromium();
  const page = await session.browser.newPage({ viewport: { width: 1500, height: 980 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    window.__readerCSPViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__readerCSPViolations.push(event.violatedDirective));
  });
  await page.route('**/api/health', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, service: 'my-scholar', ai: { services: { translation: { enabled: true, configured: true, model: 'fixture', profile_id: 'fixture' }, chat: { enabled: false } } } }) }));
  await page.route('**/api/jobs/*/auto-highlights', (route) => route.fulfill({ contentType: 'application/json', body: '{"result":{"highlights":[]}}' }));
  await page.route('**/api/jobs/*/translate', (route) => {
    const payload = route.request().postDataJSON();
    requests.push(payload);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { text: payload.text, profile_id: 'fixture', cached: false } }) });
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator(`.library-card[data-job-id="${jobId}"]`).first().dblclick();
  const frame = page.frameLocator('#html-preview');
  await frame.locator('#my-scholar-annotation-runtime-style').waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('#reader-view').classList.contains('is-document-loading'));
  const metrics = await frame.locator('body').evaluate((body) => {
    const doc = body.ownerDocument;
    const crop = doc.querySelector('p .math-source-inline');
    const style = getComputedStyle(crop);
    const equationImage = doc.querySelector('.pdf-equation img');
    return {
      cropDisplay: style.display,
      cropMaxHeightEm: parseFloat(style.maxHeight) / parseFloat(style.fontSize),
      cropWrapped: Boolean(crop.closest('.my-scholar-media-block')),
      cropInteractive: crop.getAttribute('role') === 'button',
      equationWrapped: Boolean(equationImage.closest('.my-scholar-media-block')),
      equationInteractive: equationImage.getAttribute('role') === 'button',
      nativeMathML: doc.querySelectorAll('math').length,
      mathSpace: doc.querySelectorAll('math mspace').length,
      runtimeStyle: Boolean(doc.querySelector('#my-scholar-annotation-runtime-style')),
      katexScript: Boolean(doc.querySelector('#my-scholar-katex-script')),
      paragraphsInteractive: doc.querySelectorAll('.paragraph-translate-trigger').length,
      cspViolations: doc.defaultView.__readerCSPViolations,
      footnoteAnchors: doc.querySelectorAll('.footnote[id^="fn-1-"]').length,
    };
  });
  assert.equal(metrics.cropDisplay, 'inline');
  assert.ok(Math.abs(metrics.cropMaxHeightEm - 3.6) < 0.01);
  assert.equal(metrics.cropWrapped || metrics.cropInteractive || metrics.equationWrapped || metrics.equationInteractive, false);
  assert.ok(metrics.nativeMathML >= 2 && metrics.mathSpace >= 2);
  assert.equal(metrics.katexScript, false);
  assert.ok(metrics.runtimeStyle && metrics.paragraphsInteractive > 0);
  assert.deepEqual(metrics.cspViolations, []);
  assert.equal(metrics.footnoteAnchors, 1);
  assert.equal(await page.locator('#outline-list').getByText('Typical Limitations', { exact: true }).count(), 0);
  assert.equal(await page.locator('#outline-list').getByText('Remote compatibility paper', { exact: true }).count(), 0);
  await page.locator('#outline-list').getByText('Introduction', { exact: true }).waitFor({ state: 'attached' });
  const paragraph = frame.locator('p').filter({ hasText: 'A native formula' }).first();
  await paragraph.locator('.paragraph-translate-trigger').click();
  await frame.locator('.my-scholar-translation math mspace').first().waitFor({ state: 'attached' });
  assert.ok(requests.some((payload) => String(payload.text).includes('__MY_SCHOLAR_MATH_')));
  await frame.locator('a.cross-reference[href="#fig-8"]').first().click();
  await page.locator('#quick-preview-panel.active-panel').waitFor();
  assert.equal(await page.locator('#quick-preview-content > article > img').count(), 2);
  await frame.locator('a.cross-reference[href="#table-2"]').first().click();
  assert.equal(await page.locator('#quick-preview-content table').count(), 2);
  assert.ok(await page.locator('#quick-preview-content math mspace').count());
  const previewCrop = page.locator('#quick-preview-content img.math-source-inline');
  assert.equal(await previewCrop.count(), 1);
  assert.equal(await previewCrop.getAttribute('role'), null);
  assert.equal(await previewCrop.evaluate((node) => getComputedStyle(node).display), 'inline');
  const originalHeight = await frame.locator('.reader-content').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  await page.locator('#font-size-range').evaluate((input) => { input.value = '120'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  const scaled = await frame.locator('.reader-content').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  assert.ok(scaled > originalHeight);
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await frame.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(30, 33, 36)');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ remoteExportReader: true, inlineMathCrop: true, nativeMathML: true, cspHostWiring: true, tocHeaders: true, groupedFigurePreview: true, continuedTablePreview: true, translatedNativeMathML: true, explicitFootnoteAnchor: true, typographyAndDarkMode: true, errors, metrics }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  try { await session?.close(); } catch (error) { console.error(error); process.exitCode = 1; }
});
