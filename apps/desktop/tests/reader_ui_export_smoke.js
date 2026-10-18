const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');
const [baseURL, jobId, outputDirectory] = process.argv.slice(2);
let session;
let context;
const result = { syntheticOnly: true, actualApp: true, themes: {}, errors: [] };
(async () => {
  const job = await (await fetch(`${baseURL}/api/jobs/${jobId}`)).json();
  assert.equal(job.source_filename, 'Synthetic selectable reader');
  const html = await (await fetch(`${baseURL}/api/jobs/${jobId}/document.html`)).text();
  assert.ok(html.includes('Synthetic figure behind reader popover'), 'Requires isolated reader UI fixture');
  const annotations = await (await fetch(`${baseURL}/api/jobs/${jobId}/annotations`)).json();
  for (const annotation of annotations.annotations || []) await fetch(`${baseURL}/api/jobs/${jobId}/annotations/${annotation.id}`, { method: 'DELETE' });
  const firstBlockId = html.match(/<p[^>]*data-block-id="([^"]+)"[^>]*>Visible /)[1];
  const staleBlockId = html.match(/<p[^>]*data-block-id="([^"]+)"[^>]*>The coefficient is /)[1];
  const oldSource = 'The coefficient is (R __MY_SCHOLAR_MATH_0__ ). This synthetic sentence checks inline scientific notation.';
  let oldHash = 2166136261;
  for (const char of oldSource) { oldHash ^= char.codePointAt(0); oldHash = Math.imul(oldHash, 16777619); }
  const staleHash = (`00000000${(oldHash >>> 0).toString(16)}`).slice(-8);

  session = await launchManagedChromium();
  context = await session.browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1500, height: 980 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => result.errors.push(error.message));
  const translationRequests = [];
  await page.route('**/api/jobs/*/translate', (route) => { translationRequests.push(route.request().postDataJSON()); return route.continue(); });
  const quote = 'Visible 🧪 prose';
  await page.addInitScript(() => {
    window.__readerCSPViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__readerCSPViolations.push(event.violatedDirective));
  });
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, ai: { services: { chat: { enabled: true, configured: true, model: 'synthetic-mock' }, translation: { enabled: true, configured: true, model: 'synthetic-mock', profile_id: 'synthetic-mock' } } } } }));
  await page.route('**/api/jobs/*/auto-highlights', (route) => route.fulfill({ json: { result: { status: 'mock', highlights: [{ block_id: firstBlockId, quote, reason: 'Synthetic method explanation for a popover overlapping the contrast figure.', category: 'method' }] } } }));
  await page.route(`**/api/jobs/${jobId}/translations`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.translations = (body.translations || []).filter((record) => record.block_id !== staleBlockId);
    body.translations.push({ block_id: staleBlockId, source_text: oldSource, source_hash: staleHash, text: 'STALE SCRIPT CACHE MUST NOT REPLAY', target_language: '中文', profile_id: 'synthetic-mock', formulas: [{ token: '__MY_SCHOLAR_MATH_0__', tex: '2' }] });
    await route.fulfill({ response, json: body });
  });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await page.locator(`.library-card[data-job-id="${jobId}"]`).first().dblclick();
  const frame = page.frameLocator('#html-preview');
  await frame.locator('#my-scholar-annotation-runtime-style').waitFor({ state: 'attached' });
  await page.waitForFunction(() => !document.querySelector('#reader-view').classList.contains('is-document-loading'));
  assert.equal(await frame.locator(`.my-scholar-translation[data-for="${staleBlockId}"]`).count(), 0, 'Old script-spacing cache must not replay into the new source');
  const suggestion = frame.locator('mark.my-scholar-ai-suggestion').first();
  await suggestion.waitFor();
  await frame.locator('#fig-ui img').evaluate((image) => { image.loading = 'eager'; });
  await page.waitForFunction(() => { const image = document.querySelector('#html-preview').contentDocument.querySelector('#fig-ui img'); return image.complete && image.naturalWidth === 900; });
  const inspectPopover = async () => frame.locator('.annotation-note-popover').evaluate((node) => {
    const doc = node.ownerDocument;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const figure = doc.querySelector('#fig-ui img').getBoundingClientRect();
    const overlap = { x: Math.max(rect.left, figure.left) + 3, y: Math.max(rect.top, figure.top) + 3 };
    const intersectsFigure = overlap.x < Math.min(rect.right, figure.right) && overlap.y < Math.min(rect.bottom, figure.bottom);
    const reasonColor = getComputedStyle(node.querySelector('.ai-suggestion-reason') || node.querySelector('.annotation-note-popover-body')).color;
    const luminance = (value) => { const rgb = value.match(/[\d.]+/g).slice(0, 3).map((channel) => { const v = Number(channel) / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
    const levels = [luminance(reasonColor), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return { reasonColor, reasonContrast: (levels[0] + .05) / (levels[1] + .05), background: style.backgroundColor, color: style.color, position: style.position, zIndex: style.zIndex, padding: style.padding, border: style.borderTopWidth, borderRadius: style.borderRadius, boxSizing: style.boxSizing, shadow: style.boxShadow, bounds: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }, viewport: { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight }, actionsDisplay: getComputedStyle(node.querySelector('.annotation-note-popover-actions')).display, buttons: [...node.querySelectorAll('.annotation-note-popover-actions button')].map((button) => { const css = getComputedStyle(button); return { border: css.borderTopWidth, radius: css.borderRadius, padding: css.padding, background: css.backgroundColor, color: css.color, cursor: css.cursor }; }), intersectsFigure, topAtIntersection: intersectsFigure && Boolean(doc.elementFromPoint(overlap.x, overlap.y)?.closest('.annotation-note-popover')) };
  });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await suggestion.click();
    const popover = frame.locator('.annotation-note-popover');
    await popover.waitFor();
    const metrics = await inspectPopover();
    result.themes[theme] = metrics;
    assert.equal(metrics.background, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(30, 33, 36)');
    assert.ok(metrics.reasonContrast >= 4.5, `${theme} reason text contrast must remain readable`);
    assert.equal(metrics.position, 'absolute');
    assert.ok(Number(metrics.zIndex) >= 30);
    assert.equal(metrics.boxSizing, 'border-box');
    assert.equal(metrics.border, '1px');
    assert.equal(metrics.borderRadius, '10px');
    assert.notEqual(metrics.shadow, 'none');
    assert.equal(metrics.actionsDisplay, 'flex');
    assert.equal(metrics.buttons.length, 4);
    assert.ok(metrics.buttons.every((button) => button.border === '1px' && button.radius === '6px' && button.cursor === 'pointer' && button.background === metrics.background));
    assert.ok(metrics.bounds.x >= 0 && metrics.bounds.y >= 0 && metrics.bounds.right <= metrics.viewport.width && metrics.bounds.bottom <= metrics.viewport.height);
    assert.ok(metrics.intersectsFigure && metrics.topAtIntersection, 'Opaque popover must stack over the figure');
    if (outputDirectory) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      await page.screenshot({ path: path.join(outputDirectory, `synthetic-reader-popover-${theme}.png`), animations: 'disabled' });
    }
    await popover.locator('[data-action="close"]').click();
    await popover.waitFor({ state: 'detached' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const paragraph = frame.locator(`p[data-block-id="${firstBlockId}"]`);
  await paragraph.hover();
  const triggerStyle = await paragraph.locator('.paragraph-translate-trigger').evaluate((node) => { const css = getComputedStyle(node); return { position: css.position, background: css.backgroundColor, border: css.borderTopWidth, radius: css.borderRadius, opacity: css.opacity }; });
  assert.equal(triggerStyle.position, 'absolute');
  assert.equal(triggerStyle.border, '1px');
  assert.equal(triggerStyle.radius, '6px');
  await paragraph.locator('.paragraph-translate-trigger').click();
  const translation = frame.locator(`.my-scholar-translation[data-for="${firstBlockId}"]`);
  await translation.locator('img.math-source-inline').waitFor();
  const geometry = async (locator) => locator.locator('img.math-source-inline').evaluate((image) => {
    const css = getComputedStyle(image);
    const fontSize = parseFloat(css.fontSize);
    return { heightEm: Number(image.dataset.heightEm), baselineEm: Number(image.dataset.baselineOffsetEm), renderedHeightEm: image.getBoundingClientRect().height / fontSize, renderedBaselineEm: -parseFloat(css.verticalAlign) / fontSize, display: css.display, wrappedAsMedia: Boolean(image.closest('.my-scholar-media-block')), role: image.getAttribute('role') };
  });
  assert.equal(await paragraph.locator('sup').textContent(), '12');
  assert.equal(await translation.locator('sup').textContent(), '12');
  result.nativeSuperscriptPreserved = true;
  result.formula = { original: await geometry(paragraph), translation: await geometry(translation) };
  for (const metrics of Object.values(result.formula)) {
    assert.ok(Math.abs(metrics.renderedHeightEm - metrics.heightEm) < .02);
    assert.ok(Math.abs(metrics.renderedBaselineEm - metrics.baselineEm) < .02);
    assert.equal(metrics.display, 'inline');
    assert.equal(metrics.wrappedAsMedia, false);
    assert.equal(metrics.role, null);
  }
  assert.deepEqual(result.formula.original, result.formula.translation);
  const citationPayload = translationRequests.find((request) => request.block_id === firstBlockId);
  assert.ok(citationPayload.text.includes('prose__MY_SCHOLAR_MATH_0__ costs'), 'Citation superscript must keep adjacent prose and its original following space');
  const select = async () => paragraph.evaluate((block) => {
    const doc = block.ownerDocument;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) if (!node.parentElement.closest('button')) nodes.push(node);
    const range = doc.createRange();
    range.setStart(nodes[0], 0);
    range.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].length);
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await select();
  await page.locator('#selection-popover:not([hidden])').waitFor();
  const copied = await paragraph.evaluate((block) => { const transfer = new DataTransfer(); const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }); block.dispatchEvent(event); return { text: transfer.getData('text/plain'), prevented: event.defaultPrevented }; });
  assert.equal(copied.text, 'Visible 🧪 prose12 costs $200 and formula [公式原图] after.');
  assert.equal(copied.prevented, true);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+U' : 'Control+Shift+U');
  await paragraph.locator('mark.my-scholar-underline').waitFor();
  assert.equal(await paragraph.locator('mark.my-scholar-underline').textContent(), copied.text);
  const manualTrigger = paragraph.locator('.annotation-note-trigger').last();
  await manualTrigger.click();
  const manualPopover = frame.locator('.annotation-note-popover');
  const manualMetrics = await inspectPopover();
  assert.equal(manualMetrics.background, 'rgb(255, 255, 255)');
  assert.equal(manualMetrics.actionsDisplay, 'flex');
  await manualPopover.locator('[data-action="edit"]').click();
  const editor = manualPopover.locator('.annotation-note-editor');
  await editor.fill('Synthetic personal note');
  await manualPopover.locator('[data-action="save-note"]').click();
  await manualPopover.locator('.annotation-note-popover-body').filter({ hasText: 'Synthetic personal note' }).waitFor();
  await manualPopover.locator('[data-action="close"]').click();
  await manualPopover.waitFor({ state: 'detached' });
  result.scientificScripts = [];
  for (const spec of [
    { prefix: 'The coefficient is ', scripts: ['sup:2'], formulas: ['(R2)'], protectedTex: ['2'] },
    { prefix: 'The mixture contains ', scripts: ['sub:2', 'sup:18'], formulas: ['CO2', 'δ18O'], protectedTex: ['2', '18'] },
    { prefix: 'The citation keeps ', scripts: ['sup:34'], formulas: ['34'], protectedTex: ['34'] },
  ]) {
    const original = frame.locator('p[data-block-id]').filter({ hasText: spec.prefix }).first();
    await original.waitFor();
    const blockId = await original.getAttribute('data-block-id');
    await original.locator('.paragraph-translate-trigger').click();
    const translated = frame.locator(`.my-scholar-translation[data-for="${blockId}"]`);
    await translated.locator('sup,sub').first().waitFor();
    const inspectScripts = async (block) => block.evaluate((root) => {
      const doc = root.ownerDocument;
      const rectFor = (node, start, end) => { const range = doc.createRange(); range.setStart(node, start); range.setEnd(node, end); return range.getBoundingClientRect(); };
      return { images: root.querySelectorAll('img,math').length, scripts: [...root.querySelectorAll('sup,sub')].map((script) => {
        const before = script.previousSibling;
        const after = script.nextSibling;
        const base = rectFor(before, before.length - 1, before.length);
        const glyph = rectFor(script.firstChild, 0, script.firstChild.length);
        const tail = after?.nodeType === Node.TEXT_NODE && after.length ? rectFor(after, 0, 1) : null;
        return { kind: script.localName, text: script.textContent, baseTop: base.top, scriptTop: glyph.top, scriptBottom: glyph.bottom, baseBottom: base.bottom, tailTop: tail?.top ?? null, baseFont: parseFloat(getComputedStyle(script.parentElement).fontSize), scriptFont: parseFloat(getComputedStyle(script).fontSize) };
      }) };
    });
    const sourceMetrics = await inspectScripts(original);
    const translationMetrics = await inspectScripts(translated);
    for (const metrics of [sourceMetrics, translationMetrics]) {
      assert.equal(metrics.images, 0, 'Native scientific scripts must never become crop images or duplicate math');
      assert.deepEqual(metrics.scripts.map((script) => `${script.kind}:${script.text}`), spec.scripts);
      for (const script of metrics.scripts) {
        assert.ok(script.scriptFont < script.baseFont);
        assert.ok(script.kind === 'sup' ? script.scriptTop < script.baseTop : script.scriptTop > script.baseTop);
        if (script.tailTop !== null) assert.ok(Math.abs(script.tailTop - script.baseTop) < 1, 'Base glyphs after a script must remain on the prose baseline');
      }
    }
    const payload = translationRequests.find((request) => request.block_id === blockId);
    assert.ok(payload, 'Must exercise a fresh translation request for scientific scripts');
    assert.deepEqual(payload.formulas.map((formula) => formula.tex), spec.protectedTex);
    assert.equal((payload.text.match(/__MY_SCHOLAR_MATH_/g) || []).length, spec.scripts.length);
    if (spec.prefix === 'The coefficient is ') {
      assert.ok(payload.text.includes('(R__MY_SCHOLAR_MATH_0__)'));
      assert.notEqual(payload.source_hash, staleHash);
      result.staleCache = { oldHash: staleHash, newHash: payload.source_hash, oldSource, newSource: payload.text, oldRecordReplayed: false, freshTranslationRequested: true };
    }
    if (spec.prefix === 'The mixture contains ') assert.ok(payload.text.includes('CO__MY_SCHOLAR_MATH_0__ and δ__MY_SCHOLAR_MATH_1__O.'));
    if (spec.prefix === 'The citation keeps ') assert.ok(payload.text.includes('keeps __MY_SCHOLAR_MATH_0__ between'));
    assert.ok(payload.formulas.every((formula) => Object.keys(formula).sort().join(',') === 'tex,token'), 'Backend payload carries protected script text, while rich markup stays on the reader');
    const copies = [];
    for (const block of [original, translated]) for (const formula of spec.formulas) {
      await block.evaluate((root, text) => {
        const doc = root.ownerDocument;
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) if (!node.parentElement.closest('button')) nodes.push(node);
        const full = nodes.map((item) => item.nodeValue).join('');
        let start = full.indexOf(text);
        if (start < 0) throw new Error(`Missing selectable scientific formula: ${text}`);
        let end = start + text.length;
        const range = doc.createRange();
        for (const item of nodes) {
          if (start >= 0 && start < item.length) { range.setStart(item, start); start = -1; }
          else if (start >= 0) start -= item.length;
          if (end <= item.length) { range.setEnd(item, end); break; }
          end -= item.length;
        }
        doc.getSelection().removeAllRanges();
        doc.getSelection().addRange(range);
        doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, formula);
      await page.locator('#selection-popover:not([hidden])').waitFor();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
      const copiedFormula = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(copiedFormula, formula, 'Plain clipboard must contain the complete DOM text projection of the formula');
      copies.push(copiedFormula);
    }
    result.scientificScripts.push({ prefix: spec.prefix, original: sourceMetrics, translation: translationMetrics, protectedPayload: { text: payload.text, formulas: payload.formulas }, copies, clipboardProjection: 'Standard plain DOM text: superscripts/subscripts preserve their digits, while sup/sub formatting is verified separately.' });
  }
  await frame.locator('p[data-block-id]').filter({ hasText: 'The coefficient is ' }).first().evaluate((block) => { block.ownerDocument.getSelection().removeAllRanges(); block.scrollIntoView({ block: 'center' }); });
  if (outputDirectory) await page.screenshot({ path: path.join(outputDirectory, 'synthetic-scientific-scripts.png'), animations: 'disabled' });
  result.cspViolations = await frame.locator('body').evaluate((node) => node.ownerDocument.defaultView.__readerCSPViolations);
  assert.deepEqual(result.cspViolations, []);
  result.paragraphTranslateTrigger = triggerStyle;
  result.copy = copied;
  result.quickUnderline = true;
  result.personalNote = true;
  assert.deepEqual(result.errors, []);
  if (outputDirectory) fs.writeFileSync(path.join(outputDirectory, 'synthetic-reader-ui-audit.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await context?.close();
  if (session) {
    const pid = session.browserProcess.pid;
    const profile = session.browserProcess.spawnargs.find((arg) => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    await session.close();
    assert.ok(session.browserProcess.exitCode !== null || session.browserProcess.signalCode !== null);
    assert.ok(!profile || !fs.existsSync(profile));
    result.lifecycle = { pid, profile, exited: true, profileRemoved: true };
    if (outputDirectory && !process.exitCode) fs.writeFileSync(path.join(outputDirectory, 'synthetic-reader-ui-audit.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ lifecycle: result.lifecycle }));
  }
});
