'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  }\n', start);
  assert(start >= 0 && end > start, name);
  return source.slice(start, end + 4);
}
(async () => {
  const session = await launchManagedChromium();
  try {
    const page = await session.browser.newPage();
    await page.setContent(`<main class="reader-content"><p class="my-scholar-translation-original reader-sentence-pairs" id="paired">
      <span class="reader-source-sentence" id="source-one">First sentence.</span><span class="my-scholar-translation reader-sentence-translation" id="translation-one">第一句。<small class="translation-source-label">fixture model</small></span><span class="reader-source-sentence" id="source-two"> Second sentence.</span><span class="my-scholar-translation reader-sentence-translation" id="translation-two">第二句。</span><button class="paragraph-translate-trigger">译</button>
    </p><p id="rich">Before <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math> after <span class="math-source-visual"><img><span class="math-source-text">[formula crop]</span></span><span hidden>hidden</span><span aria-hidden="true">aria hidden</span><span style="display:none">display hidden</span><span style="visibility:hidden">visibility hidden</span><button>button</button><span class="translation-retained-status">refreshing</span> done.</p><p id="plain">A <strong>bold</strong> phrase.</p></main>`);
    await page.evaluate((functions) => {
      window.state = { translationPreferences: { displayMode: 'bilingual' } };
      window.eval(functions);
      window.copyRange = (startId, startOffset, endId, endOffset, mode) => {
        document.documentElement.dataset.translationDisplay = mode;
        const start = document.getElementById(startId).firstChild;
        const end = document.getElementById(endId).firstChild;
        const range = document.createRange();
        range.setStart(start, startOffset);
        range.setEnd(end, endOffset);
        const selection = document.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        let text;
        let prevented = false;
        window.guardFrameSelection({ type: 'copy', currentTarget: document, target: start.parentElement,
          clipboardData: { setData(type, value) { if (type === 'text/plain') text = value; } },
          preventDefault() { prevented = true; },
        });
        if (!prevented) text = selection.toString();
        return { text, prevented };
      };
    }, ['selectionElement', 'isPaperSelectionSurface', 'guardFrameSelection'].map(functionSource).join('\n'));
    const pairedBefore = await page.locator('#paired').innerHTML();
    const copy = (...args) => page.evaluate((values) => window.copyRange(...values), args);
    assert.deepEqual(await copy('translation-one', 1, 'translation-two', 3, 'translation'), { text: '一句。第二句', prevented: true }, 'A partial cross-sentence translation copy excludes hidden originals and labels');
    assert.deepEqual(await copy('source-one', 2, 'source-two', 8, 'original'), { text: 'rst sentence. Second ', prevented: true });
    assert.deepEqual(await copy('source-one', 2, 'source-two', 8, 'bilingual'), { text: 'rst sentence. Second ', prevented: true }, 'A bilingual copy beginning on source prose stays on the source surface');
    assert.deepEqual(await copy('translation-one', 1, 'translation-two', 3, 'bilingual'), { text: '一句。第二句', prevented: true }, 'A bilingual copy beginning on translated prose stays on the translation surface');
    assert.deepEqual(await copy('translation-one', 1, 'translation-one', 3, 'translation'), { text: '一句', prevented: false }, 'A local text selection keeps native copying and is not expanded');
    assert.equal(await page.locator('#paired').innerHTML(), pairedBefore, 'Copy filtering never mutates the reader DOM');
    await page.locator('#paired').evaluate((node) => {
      for (const id of ['source-one', 'source-two', 'translation-one', 'translation-two']) node.append(node.ownerDocument.getElementById(id));
      node.append(node.querySelector('button'));
    });
    const continuousBefore = await page.locator('#paired').innerHTML();
    assert.deepEqual(await copy('source-one', 2, 'source-two', 8, 'bilingual'), { text: 'rst sentence. Second ', prevented: true }, 'Continuous source copying excludes the positioned translations');
    assert.deepEqual(await copy('translation-one', 1, 'translation-two', 3, 'bilingual'), { text: '一句。第二句', prevented: true }, 'Positioned translations retain their canonical sentence order');
    assert.equal(await page.locator('#paired').innerHTML(), continuousBefore);
    const richBefore = await page.locator('#rich').innerHTML();
    const rich = await page.evaluate(() => {
      const element = document.getElementById('rich');
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      let text;
      window.guardFrameSelection({ type: 'copy', currentTarget: document, target: element, clipboardData: { setData(_type, value) { text = value; } }, preventDefault() {} });
      return text;
    });
    assert.equal(rich, 'Before x^2 after [formula crop] done.', 'Formulas appear once while controls and hidden auxiliary text are omitted');
    assert.equal(await page.locator('#rich').innerHTML(), richBefore);
    const plain = await copy('plain', 0, 'plain', 2, 'original');
    assert.deepEqual(plain, { text: 'A ', prevented: false });
    console.log('reader copy DOM tests passed');
  } finally {
    await session.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
