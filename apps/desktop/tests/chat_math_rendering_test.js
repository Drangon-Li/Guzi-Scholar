'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchManagedChromium } = require('./playwright.cjs');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Missing chat source: ${startMarker}`);
  return source.slice(start, end);
}

// Keep the real render/cache/selection paths together so asynchronous cache
// upgrades cannot pass by testing the parser or mocked renderChat in isolation.
const harness = `(() => {
  const state = { chat: [] };
  const $ = (selector) => document.querySelector(selector);
  const chatMaxMessageChars = 120000;
  const chatMarkdownMaxDepth = 16;
  const browserDemo = false;
  const cssEscape = CSS.escape;
  const renderChatSessionControls = () => {};
  const renderChatOptions = () => {};
  const openChatBlockReference = () => {};
  const jsonOptions = (body) => ({ body });
  let sequence = 0;
  const chatRecordId = () => 'message-' + (++sequence);
  ${section('  function normalizeChatSourceGeneration(', '\n  function activeChatSourceGeneration(')}
  const requests = [];
  const waiting = [];
  let hold = false;
  let fail = false;
  let inFlight = 0;
  const api = async (url, { body }) => {
    if (url !== '/api/mathml') throw new Error('Unexpected request: ' + url);
    requests.push(body.formulas);
    inFlight += 1;
    try {
      if (hold) await new Promise((resolve) => waiting.push(resolve));
      if (fail) throw new Error('Synthetic MathML failure');
      return { results: body.formulas.map(({ tex, display }) => katex.renderToString(tex, {
        output: 'mathml', displayMode: display, throwOnError: false, trust: false,
      })) };
    } finally { inFlight -= 1; }
  };
  ${section('  function translationMathNode(', '\n  function renderTranslationText(')}
  ${section('  const chatMathCache = new Map();', '\n  let chatReferenceHighlight =')}
  ${section('  function chatSelectionTouches(', "\n  $('#chat-input')?.addEventListener('keydown'")}
  window.chatMathTest = {
    set(messages) { state.chat = messages; renderChat(); },
    render: renderChat,
    hold(value) { hold = value; },
    fail(value) { fail = value; },
    release() { waiting.splice(0).forEach((resolve) => resolve()); },
    finish() { state.chat.forEach((message) => { message.streaming = false; }); renderChat(); },
    status() { return { requests, waiting: waiting.length, inFlight,
      pending: chatMathPending.size, timer: Boolean(chatMathTimer) }; },
  };
})();`;

const assistant = (id, content, extra = {}) => ({ id, content, role: 'assistant', ...extra });

(async () => {
  const session = await launchManagedChromium();
  const errors = [];
  try {
    const page = await session.browser.newPage({ viewport: { width: 960, height: 900 } });
    page.setDefaultTimeout(5000);
    page.on('pageerror', (error) => errors.push(error.message));
    const setup = async () => {
      await page.goto('about:blank');
      await page.setContent('<!doctype html><html lang="zh"><body><div id="chat-messages"></div></body></html>');
      await page.addStyleTag({ path: path.join(__dirname, '../web/styles.css') });
      await page.addScriptTag({ path: path.join(__dirname, '../web/vendor/katex/katex.min.js') });
      await page.addScriptTag({ content: harness });
    };
    const show = (messages) => page.evaluate((value) => window.chatMathTest.set(value), messages);
    const status = () => page.evaluate(() => window.chatMathTest.status());
    const settled = () => page.waitForFunction(() => {
      const value = window.chatMathTest.status();
      return !value.inFlight && !value.pending && !value.timer;
    });
    const body = (id) => page.locator(`[data-chat-message-id="${id}"] .chat-message-body`);

    await setup();
    await page.evaluate(() => window.chatMathTest.hold(true));
    await show([assistant('formula', '下标 $r_i$，分数 \\(\\frac{a}{b}\\)。\n\\[\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\\]')]);
    assert.equal(await body('formula').locator('math').count(), 0, 'The cold-cache fixture must start as a fallback');
    await page.waitForFunction(() => window.chatMathTest.status().waiting === 1);
    await page.evaluate(() => { window.chatMathTest.hold(false); window.chatMathTest.release(); });
    await body('formula').locator('msub').waitFor({ state: 'visible' });
    await body('formula').locator('mfrac').waitFor({ state: 'visible' });
    await body('formula').locator('mtable').waitFor({ state: 'visible' });
    await settled();
    assert.equal(await body('formula').locator('.math-fallback').count(), 0);
    const requestCount = (await status()).requests.length;
    await show([assistant('cache-hit', '再次 $r_i$ 与 \\(\\frac{a}{b}\\)。')]);
    await body('cache-hit').locator('msub').waitFor({ state: 'visible' });
    assert.equal((await status()).requests.length, requestCount, 'Cache hits must not repeat MathML conversion');
    assert.equal((await status()).pending, 0);

    await show([assistant('delimiters', '$r_i$；\\(r_i\\)；中间 $$r_i$$ 结束。\n$$r_i$$\n\\[r_i\\]')]);
    await settled();
    assert.equal(await body('delimiters').locator('math').count(), 5);
    assert.equal(await body('delimiters').locator('math[display="block"]').count(), 3);
    assert.equal((await body('delimiters').textContent()).includes('$'), false, 'Double dollars must leave no stray delimiters');

    await show([assistant('code', '`r_i`、`x^{2}`、`r_{i+1}`、`\\alpha_i`、`$r_i$`、`\\(r_i\\)`\n`learning_rate` `API_KEY` `model.forward(x)` `src/main.py`\n```python\nr_i = learning_rate\nprint("$r_i$")\n```\n<img src=x onerror="window.__chatMathXSS=1">')]);
    await settled();
    assert.equal(await body('code').locator('math').count(), 6, 'Math-like backticks and wrapped delimiters should render as math');
    assert.deepEqual(await body('code').locator('p > code').allTextContents(), ['learning_rate', 'API_KEY', 'model.forward(x)', 'src/main.py']);
    assert.equal(await body('code').locator('pre code[data-lang="python"]').textContent(), 'r_i = learning_rate\nprint("$r_i$")');
    assert.equal(await body('code').locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.__chatMathXSS), undefined);

    await setup();
    await page.evaluate(() => window.chatMathTest.fail(true));
    await show([assistant('failed', '$r_i$')]);
    await settled();
    assert.equal(await body('failed').locator('.math-fallback code').textContent(), 'r_i');
    await page.evaluate(() => { for (let index = 0; index < 5; index += 1) window.chatMathTest.render(); });
    const failed = await status();
    assert.equal(failed.requests.length, 1, 'Failed conversions must not enter a retry loop');
    assert.equal(failed.pending, 0);
    assert.equal(failed.timer, false);

    await setup();
    await page.evaluate(() => window.chatMathTest.hold(true));
    await show([assistant('selected', '保留选择 $s_i$')]);
    await page.waitForFunction(() => window.chatMathTest.status().waiting === 1);
    await body('selected').evaluate((node) => {
      const text = node.querySelector('p').firstChild;
      const range = document.createRange();
      range.setStart(text, 0); range.setEnd(text, 4);
      const selection = document.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
    });
    await page.evaluate(() => { window.chatMathTest.hold(false); window.chatMathTest.release(); });
    await settled();
    assert.equal(await page.evaluate(() => document.getSelection().toString()), '保留选择');
    assert.equal(await body('selected').locator('math').count(), 0, 'Hydration must not replace a selected message');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    await body('selected').locator('msub').waitFor({ state: 'visible' });

    await setup();
    await page.evaluate(() => window.chatMathTest.hold(true));
    await show([assistant('pointer', '按住鼠标 $p_i$')]);
    await body('pointer').dispatchEvent('pointerdown', { button: 0 });
    await page.waitForFunction(() => window.chatMathTest.status().waiting === 1);
    await page.evaluate(() => { window.chatMathTest.hold(false); window.chatMathTest.release(); });
    await settled();
    assert.equal(await body('pointer').locator('math').count(), 0, 'Hydration must preserve a pointer-locked message');
    await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
    await body('pointer').locator('msub').waitFor({ state: 'visible' });

    await setup();
    await show([assistant('stream', '流式 $t_i$', { streaming: true })]);
    assert.equal((await status()).requests.length, 0);
    assert.equal((await status()).timer, false, 'Streaming must not schedule partial formula conversion');
    await page.evaluate(() => window.chatMathTest.finish());
    await body('stream').locator('msub').waitFor({ state: 'visible' });
    await settled();
    assert.equal((await status()).requests.length, 1);

    await setup();
    await page.evaluate(() => window.chatMathTest.hold(true));
    await show([assistant('old-session', '旧会话 $o_i$')]);
    await page.waitForFunction(() => window.chatMathTest.status().waiting === 1);
    await show([assistant('new-session', '新会话 $n_i$')]);
    await page.evaluate(() => { window.chatMathTest.hold(false); window.chatMathTest.release(); });
    await body('new-session').locator('msub').waitFor({ state: 'visible' });
    await settled();
    assert.equal(await page.locator('[data-chat-message-id="old-session"]').count(), 0, 'Late hydration must not restore the old session');
    assert.equal(await page.locator('.chat-bubble').count(), 1);
    assert.ok((await body('new-session').textContent()).includes('新会话'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, cases: [
      'cold-cache-msub-mfrac-aligned-upgrade', 'cache-hit-no-request', 'four-delimiters-and-inline-display',
      'math-backticks-and-safe-code', 'failure-no-retry-loop', 'selection-preserved-and-release-upgrade',
      'pointer-lock-preserved-and-release-upgrade', 'stream-completion-upgrade', 'late-old-session-hydration',
    ] }));
  } finally {
    await session.close();
    assert.ok(session.browserProcess.exitCode !== null || session.browserProcess.signalCode !== null,
      `Managed browser pid=${session.browserProcess.pid} must exit after cleanup`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
