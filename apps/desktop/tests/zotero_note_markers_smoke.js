'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { launchManagedChromium } = require('./playwright.cjs');
const baseURL = process.argv[2];
if (!baseURL) throw new Error('Run through run_ui_tests.js --only=zotero-note-markers');
const marker = '<!-- zotero-note:abcdef0123456789abcdef0123456789 -->';
const unanchored = '<!-- zotero-unanchored:0123456789abcdef0123456789abcdef -->';
const codeMarker = '<!-- zotero-note:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->';
const initial = [marker, '## Zotero 笔记 · NOTE', '', 'Imported note body.', '', unanchored, '## Zotero 未定位批注 · MARK', '', 'Unanchored comment.', '',
  '```html', codeMarker, '```', '', `Literal inline: \`${codeMarker}\``, '', '<!-- ordinary user comment -->', '',
  '<script>window.markerExecuted = true</script>', '<img src=x onerror="window.markerExecuted=true">'].join('\n');
const fixtureHTML = '<!doctype html><html><body data-note-marker-fixture><main class="reader-content"><section class="pdf-page" data-page="1"><p data-block-id="note-source" data-page="1">A synthetic source paragraph for note editing.</p></section></main></body></html>';

(async () => {
  const session = await launchManagedChromium();
  let markdown = initial;
  const revision = () => createHash('sha256').update(markdown).digest('hex');
  const saved = []; const errors = [];
  try {
    const page = await session.browser.newPage({ viewport: { width: 1450, height: 940 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, ai: { services: { translation: { enabled: false }, chat: { enabled: false } } } } }));
    await page.route('**/api/jobs/*/auto-highlights', (route) => route.fulfill({ json: { result: { status: 'mock', highlights: [] } } }));
    await page.route('**/api/jobs/*/document.html*', (route) => route.fulfill({ contentType: 'text/html', body: fixtureHTML }));
    await page.route('**/api/jobs/*/notes', (route) => {
      if (route.request().method() === 'PUT') {
        const payload = route.request().postDataJSON();
        assert.equal(payload.expected_revision, revision(), 'Editor must save against the current notes revision');
        markdown = payload.markdown;
        saved.push(markdown);
      }
      return route.fulfill({ json: { markdown, revision: revision() } });
    });
    const editor = page.locator('#notes-editor[contenteditable="true"]');
    const open = async () => {
      await page.locator('[data-view="library-view"]').click();
      await page.locator('.library-card[data-status="completed"]').first().locator('.library-row-name').dblclick();
      await page.frameLocator('#html-preview').locator('body[data-note-marker-fixture]').waitFor();
      await page.locator('[data-panel="notes-panel"]').click();
      await editor.waitFor();
    };
    const assertHiddenMetadata = async () => {
      const actual = await editor.evaluate((node) => {
        const comments = []; const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_COMMENT);
        while (walker.nextNode()) comments.push(`<!--${walker.currentNode.nodeValue}-->`);
        return { comments, text: node.innerText, rawElements: node.querySelectorAll('script,img,[onerror]').length, executed: Boolean(window.markerExecuted) };
      });
      assert.deepEqual(actual.comments, [marker, unanchored]);
      assert(!actual.text.includes('abcdef0123456789abcdef0123456789'));
      assert(!actual.text.includes('0123456789abcdef0123456789abcdef'));
      assert(actual.text.includes(codeMarker), 'Markers inside code examples stay visible');
      assert(actual.text.includes('<!-- ordinary user comment -->'), 'Ordinary comment source is still shown literally');
      assert.equal(actual.rawElements, 0);
      assert.equal(actual.executed, false);
      assert.equal(await editor.locator('pre code').innerText(), codeMarker);
      assert.equal(await editor.locator('p code').innerText(), codeMarker);
    };
    const save = async () => {
      const response = page.waitForResponse((item) => item.url().endsWith('/notes') && item.request().method() === 'PUT');
      await page.locator('#save-notes-button').click();
      await (await response).finished();
      await page.locator('#notes-saved').filter({ hasText: '已保存' }).waitFor();
      for (const value of [marker, unanchored]) assert.equal(markdown.split(value).length - 1, 1);
    };
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await open();
    await assertHiddenMetadata();
    await editor.locator('p').filter({ hasText: 'Imported note body.' }).evaluate((node) => {
      node.parentElement.focus();
      const range = node.ownerDocument.createRange(); range.selectNodeContents(node); range.collapse(false);
      const selection = node.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.type(' Edited without exposing metadata.');
    await save();
    assert(markdown.includes('Imported note body. Edited without exposing metadata.'));
    await assertHiddenMetadata();
    await page.reload({ waitUntil: 'networkidle' });
    await open();
    await assertHiddenMetadata();
    const before = markdown;
    await save();
    assert.equal(markdown, before, 'Reloading and saving again is stable');
    assert(saved.length >= 2);
    assert.deepEqual(errors, []);
    console.log('Zotero note marker editor load/edit/save/reload smoke passed');
  } finally {
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
