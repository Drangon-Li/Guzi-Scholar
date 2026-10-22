'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function segment(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source: ${start}`);
  return source.slice(from, to);
}
const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, { value: '', hidden: false, dataset: {}, textContent: '', innerHTML: '' });
  return nodes.get(selector);
};
let sequence = 0;
const context = vm.createContext({
  state: { aiProfiles: {}, aiModelCapabilities: {} },
  $: node,
  escapeHTML: (value) => String(value).replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  chatRecordId: () => `record-${++sequence}`,
  chatSessionTitle: () => 'new',
  normalizedChatMessage: (message) => message,
  chatMaxSessions: 50, chatMaxMessagesPerSession: 100,
  chatPersistReserveBytes: 32768, chatPersistMaxBytes: 512000,
  chatTextEncoder: new TextEncoder(),
  TextDecoder,
  aiStreamMaxBytes: 1000000, aiStreamMaxBufferChars: 200000,
  jsonOptions: (body) => ({ body }),
});
vm.runInContext(segment('  function newChatThread(', '  function recoverInterruptedChat(')
  + segment('  function normalizeChatPinnedAt(', '  function newChatThread(')
  + segment('  function serializableChatEnvelope(', '  function persistChatSession(')
  + segment('  async function streamApiRequest(', '  async function requestTranslation(')
  + '\nthis.test = { normalizeChatOptions, normalizeChatContext, normalizeChatEnvelope, serializableChatEnvelope, chatEffectiveOptions, aiReasoningChoices, aiOptionWarning, aiCapabilities, aiProfileIdentity, renderReasoningControl, streamApiRequest };', context);
const t = context.test;
const plain = (value) => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(t.normalizeChatOptions({ reasoning_effort: ' high ', thinking_budget: 0, context_window: 20000, api_key: 'never' })),
  { reasoning_effort: 'high', thinking_budget: 0, context_window: 20000 });
assert.deepEqual(plain(t.normalizeChatOptions({ thinking_budget: -1, context_window: '20000' })), {});
const capabilities = { context_window: 128000, reasoning_efforts: ['low', 'medium', 'high'], thinking_supported: true, thinking_required: false, thinking_budget_min: 1024, thinking_budget_max: 32000 };
assert.deepEqual(plain(t.aiReasoningChoices(capabilities)), ['none', 'low', 'medium', 'high']);
assert.equal(t.aiOptionWarning({ reasoning_effort: 'none' }, { ...capabilities, reasoning_efforts: null }), '', 'Budget-based models can disable optional thinking');
assert.match(t.aiOptionWarning({ reasoning_effort: 'none' }, { ...capabilities, thinking_required: true }), /要求开启思考/u);
assert.match(t.aiOptionWarning({ reasoning_effort: 'xhigh' }, capabilities), /不支持推理档位/u);
assert.equal(t.aiOptionWarning({ reasoning_effort: 'manual-vendor-value', thinking_budget: 2048 }, {}), '', 'Unknown models retain manual configuration');
assert.match(t.aiOptionWarning({ thinking_budget: 100 }, capabilities), /至少/u);
assert.match(t.aiOptionWarning({ thinking_budget: 33000 }, capabilities), /最多/u);
assert.match(t.aiOptionWarning({ reasoning_effort: 'none', thinking_budget: 2048 }, capabilities), /关闭思考/u);
assert.match(t.aiOptionWarning({ thinking_budget: 2048 }, { thinking_supported: false }), /不支持思考预算/u);
assert.match(t.aiOptionWarning({ thinking_budget: 2048 }, { thinking_supported: true, thinking_budget_supported: false }), /不支持思考预算/u);
assert.match(t.aiOptionWarning({ context_window: 2048, thinking_budget: 2048 }, {}), /小于上下文/u);

const profile = { base_url: 'https://gateway.test/v1', api_format: 'openai', model: 'reasoner', reasoning_effort: 'high', thinking_budget: 8000, context_window: 64000, capabilities };
context.state.aiProfiles.chat = profile;
assert.deepEqual(plain(t.chatEffectiveOptions({ options: {} })), { reasoning_effort: 'high', thinking_budget: 8000, context_window: 64000 });
assert.deepEqual(plain(t.chatEffectiveOptions({ options: { reasoning_effort: 'auto', thinking_budget: 0, context_window: 0 } })), { reasoning_effort: 'auto', thinking_budget: 0, context_window: 0 });
context.state.aiModelCapabilities.chat = { identity: t.aiProfileIdentity(profile), models: { other: { thinking_supported: false } } };
assert.deepEqual(plain(t.aiCapabilities('chat', profile)), capabilities);
assert.deepEqual(plain(t.aiCapabilities('chat', { ...profile, model: 'other' })), { thinking_supported: false });
assert.deepEqual(plain(t.aiCapabilities('chat', { ...profile, base_url: 'https://another.test' })), {}, 'Endpoint changes must not reuse stale capabilities');
assert.deepEqual(plain(t.aiCapabilities('chat', { ...profile, api_format: 'anthropic' })), {}, 'Protocol changes must not reuse stale capabilities');

t.renderReasoningControl('chat', 'manual-value', {}, { inherit: true });
assert.equal(node('#chat-reasoning-effort').value, 'custom');
assert.match(node('#chat-reasoning-effort').innerHTML, /跟随设置/u);
assert.equal(node('#chat-reasoning-custom').value, 'manual-value');
t.renderReasoningControl('chat', 'high', { thinking_supported: false, reasoning_efforts: [] }, { inherit: true });
assert.equal(node('#chat-reasoning-field').hidden, false, 'An incompatible saved override must stay editable');
assert.match(node('#chat-reasoning-effort').innerHTML, /当前模型不支持/u);
t.renderReasoningControl('chat', 'auto', { thinking_supported: true, thinking_budget_supported: false, reasoning_efforts: ['low', 'high'] });
assert.equal(node('#chat-thinking-field').hidden, true, 'Effort-only models must not expose budget controls');
t.renderReasoningControl('chat', undefined, { thinking_supported: false, reasoning_efforts: [] }, { inherit: true });
assert.equal(node('#chat-reasoning-field').hidden, true);

const original = { version: 2, activeSessionId: 'custom', sessions: [
  { id: 'follow', title: 'f', messages: [], options: {} },
  { id: 'custom', title: 'c', messages: [{ id: 'm', role: 'user', content: 'question' }], options: { reasoning_effort: 'high', thinking_budget: 2048, context_window: 64000 },
    context: { window: 64000, estimated_input_tokens: 50000, output_tokens: 6000, truncated: true, source: 'provider', ignored: 'secret' } },
  { id: 'automatic', messages: [], options: { reasoning_effort: 'auto', thinking_budget: 0, context_window: 0 } },
] };
const saved = t.serializableChatEnvelope(t.normalizeChatEnvelope(original));
const restarted = t.normalizeChatEnvelope(JSON.parse(JSON.stringify(saved)));
assert.equal(restarted.activeSessionId, 'custom');
assert.deepEqual(plain(restarted.sessions.map((session) => session.options)), original.sessions.map((session) => session.options));
assert.deepEqual(plain(restarted.sessions[1].context), { window: 64000, estimated_input_tokens: 50000, output_tokens: 6000, truncated: true, source: 'provider' });
assert.deepEqual(plain(t.normalizeChatEnvelope(null).sessions[0].options), {}, 'New sessions inherit settings');

(async () => {
  const details = { window: 32000, estimated_input_tokens: 24000, output_tokens: 4000, truncated: true, source: 'provider' };
  const events = [];
  context.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'text/event-stream' }), body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ context: details })}\n\ndata: ${JSON.stringify({ delta: 'answer' })}\n\ndata: ${JSON.stringify({ result: { text: 'answer' }, context: details })}\n\n`));
      controller.close();
    },
  }) });
  const deltas = [];
  const result = await t.streamApiRequest('/synthetic', {}, (delta) => deltas.push(delta), null, (meta) => events.push(plain(meta)));
  assert.deepEqual(deltas, ['answer']);
  assert.deepEqual(events, [details, details]);
  assert.deepEqual(plain(result.context), details);
  context.fetch = async () => ({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => ({ result: { text: 'json-answer' }, context: details }) });
  assert.deepEqual(plain((await t.streamApiRequest('/synthetic', {}, () => {})).context), details);
  console.log('AI controls tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
