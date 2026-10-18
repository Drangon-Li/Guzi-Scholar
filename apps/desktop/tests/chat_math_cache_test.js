'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const start = source.indexOf('  const chatMathCache = new Map();');
const end = source.indexOf('\n  function chatMarkdownInline(', start);
assert.ok(start >= 0 && end > start, 'Chat math cache source must be available');
const timers = new Map();
const requests = [];
let timerId = 0;
let renders = 0;
let failRequest = false;
const doc = { createTextNode: (text) => ({ text }) };
const context = vm.createContext({
  state: { chat: [] },
  window: { setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; } },
  jsonOptions: (body) => ({ body }),
  translationMathNode: (formula) => ({ ...formula }),
  renderChat: () => { renders += 1; },
  api: async (url, { body }) => {
    assert.equal(url, '/api/mathml');
    requests.push(JSON.parse(JSON.stringify(body.formulas)));
    if (failRequest) throw new Error('Synthetic MathML service failure');
    return { results: body.formulas.map(({ tex }) => `<math><mi>${tex}</mi></math>`) };
  },
});
vm.runInContext(`${source.slice(start, end)}
this.cache = chatMathCache; this.pending = chatMathPending;
this.node = chatMathNode; this.schedule = scheduleChatMathHydration;`, context);

async function fireTimer() {
  assert.equal(timers.size, 1, 'Only one hydration timer may be outstanding');
  const [id, callback] = timers.entries().next().value;
  timers.delete(id);
  await callback();
  assert.ok(context.cache.size <= 256, 'Completed MathML cache exceeds its bound');
}
async function drainPending() {
  while (context.pending.size) { context.schedule(); await fireTimer(); }
}
function enqueue(tex, display = false) {
  const node = context.node(tex, display, doc);
  assert.ok(context.pending.size <= 256, 'Streaming pending formula keys exceed their bound');
  return node;
}

(async () => {
  context.state.chat = [{ streaming: true }];
  for (let index = 0; index < 600; index += 1) {
    enqueue(`stream-${index}`);
    context.schedule();
  }
  assert.equal(context.pending.size, 256);
  assert.equal(context.pending.has('I:stream-0'), false, 'Old partial formulas should leave the pending set');
  assert.equal(context.pending.has('I:stream-599'), true, 'Latest streaming formula must survive');
  assert.equal(timers.size, 0, 'Streaming replies must not schedule partial formula hydration');
  assert.equal(requests.length, 0);

  context.state.chat = [];
  context.schedule(); context.schedule(); context.schedule();
  await fireTimer();
  assert.equal(requests.length, 1, 'Repeated renders must share one hydration timer');
  assert.equal(requests[0].length, 64, 'Hydration requests must remain bounded batches');
  assert.equal(context.pending.size, 192);
  await drainPending();
  assert.equal(requests.length, 4);
  assert.equal(context.cache.size, 256);

  const beforeHit = requests.length;
  assert.equal(enqueue('stream-344').markup, '<math><mi>stream-344</mi></math>');
  context.schedule();
  assert.equal(context.pending.size, 0, 'A cached formula must not requeue conversion');
  assert.equal(timers.size, 0); assert.equal(requests.length, beforeHit);
  enqueue('newest'); await drainPending();
  assert.equal(context.cache.size, 256);
  assert.equal(context.cache.has('I:stream-344'), true, 'Recently reused formula must survive eviction');
  assert.equal(context.cache.has('I:stream-345'), false, 'Eviction should remove the least recently used formula');
  assert.equal(context.cache.has('I:newest'), true);

  enqueue('same-tex', false); enqueue('same-tex', true);
  await drainPending();
  assert.equal(context.cache.has('I:same-tex'), true);
  assert.equal(context.cache.has('D:same-tex'), true, 'Inline and display formulas have distinct cache entries');
  assert.deepEqual(requests.at(-1), [{ display: false, tex: 'same-tex' }, { display: true, tex: 'same-tex' }]);
  for (let index = 0; index < 600; index += 1) {
    enqueue(`later-${index}`);
    if (context.pending.size === 64) await drainPending();
  }
  await drainPending();
  assert.equal(context.cache.size, 256, 'Repeated non-streaming hydration must keep completed cache bounded');

  failRequest = true;
  const rendersBeforeFailure = renders;
  enqueue('failed-formula'); await drainPending();
  assert.equal(context.cache.get('I:failed-formula'), '');
  enqueue('failed-formula'); context.schedule();
  assert.equal(timers.size, 0, 'Failed conversions should not cause a hydration retry loop');
  assert.equal(renders, rendersBeforeFailure, 'Failed conversions should not rerender chat');
  assert.equal(context.pending.size, 0);
  assert.equal(context.cache.size, 256);
  console.log(JSON.stringify({ passed: true, cacheLimit: 256, pendingLimit: 256, cases: [
    'streaming-pending-cap-and-no-hydration', 'batched-and-deduplicated-hydration',
    'recent-cache-hit-survives-eviction', 'inline-display-cache-isolation', 'repeated-cache-cap', 'failed-conversion-no-retry-loop',
  ] }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
