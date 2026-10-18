const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');

(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1500, height: 980 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => {
      window.__mathStyleViolations = [];
      document.addEventListener('securitypolicyviolation', (event) => window.__mathStyleViolations.push(event.violatedDirective));
    });
    await page.route('**/api/jobs/*/document.html?*', async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="style-src \'unsafe-inline\'">');
      await route.fulfill({ response, body: html });
    });
    await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, ai: { services: { translation: { enabled: true, profile_id: 'math-fixture' }, chat: { enabled: false } } } } }));
    await page.route('**/api/jobs/*/auto-highlights', (route) => route.fulfill({ json: { result: { highlights: [] } } }));
    await page.route('**/api/jobs/*/translate', (route) => {
      const payload = route.request().postDataJSON();
      return route.fulfill({ json: { result: { text: payload.text, profile_id: 'math-fixture', formulas: payload.formulas } } });
    });
    await page.goto(process.argv[2], { waitUntil: 'networkidle' });
    await page.locator('.library-card[data-status="completed"] .library-row-name').first().dblclick();
    const frame = page.frameLocator('#html-preview');
    const trigger = frame.locator('p[data-block-id] .paragraph-translate-trigger').first();
    await trigger.waitFor();
    const blockId = await trigger.locator('xpath=..').getAttribute('data-block-id');
    const paragraph = frame.locator(`p[data-block-id="${blockId}"]`);
    assert.equal(await frame.locator('#my-scholar-math-style').evaluate((node) => node.tagName), 'STYLE');
    await paragraph.evaluate((block) => {
      const doc = block.ownerDocument;
      const control = block.querySelector('.paragraph-translate-trigger');
      block.innerHTML = 'A formula uses '
        + '<math id="math-fixture-power"><msup><mn>10</mn><mn>4</mn></msup></math> to '
        + '<math><msup><mn>10</mn><mn>5</mn></msup></math>, a fraction '
        + '<math id="math-fixture-fraction"><mfrac><mi>x</mi><mi>y</mi></mfrac></math>, and a root '
        + '<math id="math-fixture-root"><msqrt><mi>x</mi></msqrt></math>. '
        + '<a class="cross-reference" href="#table-math-fixture">Table 90</a>.';
      block.append(control);
      const table = doc.createElement('figure');
      table.id = 'table-math-fixture';
      table.className = 'pdf-table';
      table.innerHTML = '<table><tr><td>Formula: <math><msup><mn>10</mn><mn>4</mn></msup></math></td></tr></table><figcaption>Table 90. Math typography.</figcaption>';
      block.after(table);
      const legacy = doc.createElement('style');
      legacy.textContent = 'math{font-family:Arial,sans-serif;font-size:1.08em}.translation-text .translation-math{display:inline-block;vertical-align:-.16em;margin:0 .08em}';
      doc.head.append(legacy);
    });
    await trigger.click();
    const translation = frame.locator(`.my-scholar-translation[data-for="${blockId}"]:not(.is-pending) .translation-text`);
    await translation.locator('math').first().waitFor();
    await frame.locator('a[href="#table-math-fixture"]').click();
    const preview = page.locator('#quick-preview-content math');
    await preview.waitFor();
    const metrics = [];
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const scale of [100, 120, 200]) {
        await page.locator('#font-size-range').evaluate((input, value) => {
          input.value = String(value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }, scale);
        for (const root of [paragraph, translation, page.locator('#quick-preview-content')]) {
          const result = await root.evaluate(async (node) => {
            await node.ownerDocument.fonts.ready;
            const math = node.querySelector('math');
            const style = getComputedStyle(math);
            const rect = (element) => {
              const value = element.getBoundingClientRect();
              return { top: value.top, bottom: value.bottom, height: value.height, left: value.left, right: value.right };
            };
            const power = node.querySelector('msup');
            const fraction = node.querySelector('mfrac');
            const root = node.querySelector('msqrt');
            return {
              family: style.fontFamily, size: parseFloat(style.fontSize), parentSize: parseFloat(getComputedStyle(math.parentElement).fontSize),
              align: style.verticalAlign, display: style.display,
              power: [...power.children].map(rect),
              fraction: fraction && [...fraction.children].map(rect),
              root: root && [rect(root), rect(root.firstElementChild)],
            };
          });
          assert.match(result.family, /STIX Two Math/);
          assert.ok(Math.abs(result.size - result.parentSize) < 0.05, 'Formula must follow surrounding text size');
          assert.equal(result.align, 'baseline');
          assert.ok(['math', 'inline math'].includes(result.display), 'Keep the native inline MathML layout');
          assert.ok(result.power[1].top < result.power[0].top && result.power[1].height < result.power[0].height, 'Exponent must be smaller and raised');
          if (result.fraction) assert.ok(result.fraction[0].bottom < result.fraction[1].top, 'Fraction needs clearance between numerator and denominator');
          if (result.root) assert.ok(result.root[0].left < result.root[1].left && result.root[0].right >= result.root[1].right, 'Radical must contain its argument');
          metrics.push({ theme, scale, ...result });
        }
      }
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const actualFonts = [];
    for (const expression of [
      'document.querySelector("#html-preview").contentDocument.querySelector("#math-fixture-power mn")',
      `document.querySelector("#html-preview").contentDocument.querySelector('.my-scholar-translation[data-for="${blockId}"] mn')`,
      'document.querySelector("#quick-preview-content mn")',
    ]) {
      const { result } = await cdp.send('Runtime.evaluate', { expression });
      const { nodeId } = await cdp.send('DOM.requestNode', { objectId: result.objectId });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      assert.ok(fonts.some((font) => font.glyphCount > 0));
      if (process.platform === 'darwin') assert.ok(fonts.every((font) => font.familyName === 'STIX Two Math'), JSON.stringify(fonts));
      actualFonts.push(fonts.map((font) => font.familyName));
    }
    await cdp.detach();
    assert.deepEqual(await frame.locator('body').evaluate((node) => node.ownerDocument.defaultView.__mathStyleViolations), []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mathTypography: true, inlineStyleOnlyDocument: true, themes: 2, scales: 3, surfaces: 3, geometryChecks: metrics.length, actualFonts, errors }));
  } finally { await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
