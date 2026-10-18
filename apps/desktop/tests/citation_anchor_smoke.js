'use strict';
const assert = require('node:assert/strict');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2];
if (!baseURL || !process.env.MY_SCHOLAR_TEST_DATA) throw new Error('Run through the isolated UI runner.');

(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('.library-card[data-status="completed"] .library-row-name').first().dblclick();
    const frame = page.frameLocator('#html-preview');
    await frame.locator('.reader-content').waitFor();
    await frame.locator('#my-scholar-annotation-runtime-style').waitFor({ state: 'attached' });
    await frame.locator('.reader-content').evaluate((reader) => {
      const source = reader.ownerDocument.createElement('p');
      source.id = 'citation-contrast-case';
      source.dataset.blockId = 'citation-case-body';
      source.innerHTML = 'Evidence <a class="citation" data-ref="501" href="#ref-501">[501]</a>, <sup><a class="citation" data-ref="502" href="#ref-502">502</a></sup> and <a class="citation" data-ref="503" href="#ref-503">[503]</a>. Legacy <a href="#ref-503">[503]</a> and <a class="cross-reference" href="#fig-3">Figure 3</a>.';
      reader.prepend(source);
      const legacyStyle = reader.ownerDocument.createElement('style');
      legacyStyle.textContent = '.reader-content a, .reader-content a:visited { color: #0000ee !important; }';
      reader.ownerDocument.head.append(legacyStyle);
      const references = reader.ownerDocument.createElement('p');
      references.dataset.blockId = 'citation-case-references';
      references.innerHTML = '<span id="ref-501" data-ref="501"></span>501. First author. First paper.\n<span id="ref-502" data-ref="502"></span>502. Second author. Second paper.<button class="paragraph-translate-trigger">译</button><span class="annotation-note-trigger">✦</span>';
      const legacy = reader.ownerDocument.createElement('p');
      legacy.id = 'ref-503';
      legacy.dataset.blockId = 'citation-case-legacy';
      legacy.innerHTML = '[503] Legacy author. Legacy paper.<button class="paragraph-translate-trigger">译</button><span class="annotation-note-trigger">✦</span>';
      reader.append(references, legacy);
    });
    const readLinkStyles = () => frame.locator('#citation-contrast-case a').evaluateAll((links) => links.map((link) => {
      const css = getComputedStyle(link);
      const background = getComputedStyle(link.ownerDocument.body).backgroundColor;
      const luminance = (color) => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map((channel) => {
          const value = Number(channel) / 255;
          return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const levels = [luminance(css.color), luminance(background)].sort((a, b) => b - a);
      return { color: css.color, background, contrast: (levels[0] + .05) / (levels[1] + .05), decoration: css.textDecorationLine };
    }));
    await page.emulateMedia({ colorScheme: 'light' });
    const lightColors = (await readLinkStyles()).map((link) => link.color);
    assert(lightColors.every((color) => color === 'rgb(0, 0, 238)'), 'Legacy blue citation fixture was not applied');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.querySelector('#html-preview').contentDocument.documentElement.style.getPropertyValue('--paper') === '#1e2124');
    const darkLinks = await readLinkStyles();
    darkLinks.forEach((link) => {
      assert(link.contrast >= 4.5, `Dark citation contrast is too low: ${JSON.stringify(link)}`);
      assert(link.decoration.includes('underline'), 'Citation lost its link affordance');
    });
    const citation = frame.locator('#citation-contrast-case a').first();
    await citation.hover();
    const hovered = (await readLinkStyles())[0];
    assert.notEqual(hovered.color, darkLinks[0].color);
    assert(hovered.contrast >= 4.5);
    await page.mouse.move(0, 0);
    await page.keyboard.press('Tab');
    await citation.focus();
    const focus = await citation.evaluate((link) => ({ visible: link.matches(':focus-visible'), outline: getComputedStyle(link).outlineStyle }));
    assert.deepEqual(focus, { visible: true, outline: 'solid' });
    await citation.evaluate((link) => link.blur());
    await frame.locator('#citation-contrast-case').screenshot({ path: '/tmp/guzi-dark-citation-contrast.png' });
    await page.emulateMedia({ colorScheme: 'light' });
    assert.deepEqual((await readLinkStyles()).map((link) => link.color), lightColors, 'Dark reference styling leaked into light mode');
    for (const [number, expected] of [[501, 'First author. First paper.'], [502, 'Second author. Second paper.'], [503, 'Legacy author. Legacy paper.']]) {
      await frame.locator(`a.citation[data-ref="${number}"]`).click();
      await page.locator('#quick-preview-content h3').filter({ hasText: `参考文献 [${number}]` }).waitFor();
      assert.equal(await page.locator('.quick-preview-reference').textContent(), expected);
      await page.waitForFunction((value) => {
        const doc = document.querySelector('#html-preview').contentDocument;
        const rect = doc.getElementById(`ref-${value}`).getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= doc.documentElement.clientHeight;
      }, number);
      await page.getByRole('button', { name: '跳转到参考文献', exact: true }).click();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, cases: ['empty-inline-anchor', 'multiple-references-in-one-block', 'legacy-reference-element', 'reader-controls-excluded', 'click-navigation-and-preview', 'dark-citation-and-cross-reference-contrast', 'legacy-blue-style-override', 'citation-hover-and-keyboard-focus', 'live-theme-switch-restores-light-colors'], minimumDarkContrast: Math.min(...darkLinks.map((link) => link.contrast)) }));
  } finally { await session.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
