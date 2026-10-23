'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { MAX_VALUE_BYTES, RendererStateStore } = require('../electron/renderer-state.cjs');

function rendererCoreHarness() {
  const writes = [];
  const pending = [];
  const stored = new Map();
  const write = (key, operation) => {
    writes.push(operation);
    return new Promise((resolve, reject) => pending.push({
      reject,
      resolve() {
        if (operation.type === 'remove') stored.delete(key);
        else stored.set(key, operation.value);
        resolve();
      },
    }));
  };
  const context = vm.createContext({
    module: { exports: {} },
    localStorage: { getItem: () => null, removeItem() {} },
    myScholarDesktop: { state: {
      loadAll: async () => ({}),
      set: (key, value) => write(key, { type: 'set', value }),
      remove: (key) => write(key, { type: 'remove' }),
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/core.js'), 'utf8'), context);
  return { core: context.module.exports, writes, pending, stored };
}

async function testRendererWriteOrdering() {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const key = 'my-scholar-open-documents';
  const scenarios = [
    [{ type: 'set', value: 'old' }, { type: 'set', value: 'new' }],
    [{ type: 'remove' }, { type: 'set', value: 'new' }],
    [{ type: 'set', value: 'old' }, { type: 'remove' }],
  ];
  for (const [older, newer] of scenarios) {
    for (const failBeforeUpdate of [true, false]) {
      const { core, writes, pending, stored } = rendererCoreHarness();
      await core.ready;
      const apply = (operation) => operation.type === 'remove'
        ? core.persistentStateRemove(key) : core.persistentStateSet(key, operation.value);
      apply(older);
      const first = pending.shift();
      if (failBeforeUpdate) {
        first.reject(new Error('temporary write failure'));
        await tick();
        apply(newer);
      } else {
        apply(newer);
        first.reject(new Error('temporary write failure'));
      }
      await tick();
      assert.strictEqual(pending.length, 1, 'the newer write must be in flight');
      const flushed = core.flushPersistentStateWrites();
      pending.shift().resolve();
      await tick();
      assert.deepStrictEqual(writes, [older, newer], 'flush must not replay a superseded failure');
      await flushed;
      const expected = newer.type === 'remove' ? null : newer.value;
      assert.strictEqual(core.persistentStateGet(key), expected);
      assert.strictEqual(stored.get(key) ?? null, expected, 'disk must match the latest accepted operation');
    }
  }

  const { core, writes, pending, stored } = rendererCoreHarness();
  await core.ready;
  core.persistentStateSet(key, 'retry');
  pending.shift().reject(new Error('temporary write failure'));
  await tick();
  const flushed = core.flushPersistentStateWrites();
  pending.shift().resolve();
  await flushed;
  assert.strictEqual(writes.length, 2, 'an unsuperseded failure must still be retried');
  assert.strictEqual(stored.get(key), 'retry');
}

async function main() {
  await testRendererWriteOrdering();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'my-scholar-renderer-state-'));
  try {
  const directory = path.join(root, 'state', 'renderer');
  const first = new RendererStateStore(directory);
  assert.strictEqual(first.get('my-scholar-open-documents'), null);
  await first.set('my-scholar-open-documents', '["paper-a"]');
  const filePath = first.filePath('my-scholar-open-documents');
  assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700);

  const afterRestart = new RendererStateStore(directory);
  assert.strictEqual(afterRestart.get('my-scholar-open-documents'), '["paper-a"]');
  assert.deepStrictEqual(await afterRestart.loadAll(), { 'my-scholar-open-documents': '["paper-a"]' });
  const onboardingStateV1 = JSON.stringify({ version: 1, action: 'completed', completedAt: '2026-08-06T00:00:00.000Z' });
  await afterRestart.set('my-scholar-onboarding-v1', onboardingStateV1);
  assert.strictEqual(new RendererStateStore(directory).get('my-scholar-onboarding-v1'), onboardingStateV1);
  const onboardingStateV2 = JSON.stringify({ version: 2, action: 'completed', completedAt: '2026-08-07T00:00:00.000Z' });
  await afterRestart.set('my-scholar-onboarding-v2', onboardingStateV2);
  assert.strictEqual(new RendererStateStore(directory).get('my-scholar-onboarding-v2'), onboardingStateV2);
  const translationPreferences = JSON.stringify({ hoverEnabled: false, displayMode: 'translation' });
  await afterRestart.set('my-scholar-translation-preferences-v1', translationPreferences);
  assert.strictEqual(new RendererStateStore(directory).get('my-scholar-translation-preferences-v1'), translationPreferences, 'translation controls must survive store recreation');
  assert.strictEqual((await afterRestart.loadAll())['my-scholar-translation-preferences-v1'], translationPreferences);
  const readingLocations = JSON.stringify({
    version: 1,
    lastActiveJobId: '0123456789abcdef',
    locations: {
      '0123456789abcdef': {
        blockId: 'block-3-7-paragraph', page: 3, offsetPx: 184.5, offsetRatio: 0.31,
        blockHeight: 594.8, progress: 0.427, generation: '1', updatedAt: '2026-08-18T00:00:00.000Z',
      },
    },
    lru: ['0123456789abcdef'],
  });
  await afterRestart.set('my-scholar-reading-locations-v1', readingLocations);
  const withReadingLocations = new RendererStateStore(directory);
  assert.strictEqual(withReadingLocations.get('my-scholar-reading-locations-v1'), readingLocations, 'reading locations must survive store recreation');
  assert.strictEqual((await withReadingLocations.loadAll())['my-scholar-reading-locations-v1'], readingLocations);
  // Every key the renderer persists has to be on the allowlist: a key that is
  // not rejects its write, and the failed write then blocks a safe quit.
  const rendererKeys = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8')
    .concat(fs.readFileSync(path.join(__dirname, '..', 'web', 'onboarding.js'), 'utf8'))
    .matchAll(/StorageKey = '(my-scholar-[^']+)'/gu);
  for (const [, key] of rendererKeys) {
    await afterRestart.set(key, `probe:${key}`);
    assert.strictEqual(new RendererStateStore(directory).get(key), `probe:${key}`, `${key} must be an accepted renderer state key`);
    await afterRestart.remove(key);
  }

  const legacyChatKey = 'my-scholar-chat:0123456789abcdef';
  const chatV2Key = 'my-scholar-chat-v2:0123456789abcdef';
  const legacyChat = JSON.stringify([{ role: 'user', content: 'legacy question' }]);
  const chatV2 = JSON.stringify({ version: 2, activeSessionId: 'session-1', sessions: [] });
  await afterRestart.set(legacyChatKey, legacyChat);
  await afterRestart.set(chatV2Key, chatV2);
  const withChats = new RendererStateStore(directory);
  assert.strictEqual(withChats.get(legacyChatKey), legacyChat, 'legacy chat keys must remain readable');
  assert.strictEqual(withChats.get(chatV2Key), chatV2, 'v2 chat keys must persist independently');
  assert.notStrictEqual(withChats.filePath(legacyChatKey), withChats.filePath(chatV2Key));
  await afterRestart.remove('my-scholar-reading-locations-v1');
  assert.strictEqual(withReadingLocations.get('my-scholar-reading-locations-v1'), null);
  await afterRestart.remove('my-scholar-open-documents');
  assert.strictEqual(first.get('my-scholar-open-documents'), null);

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(first.filePath(legacyChatKey), '{broken');
  assert.strictEqual(first.get(legacyChatKey), undefined);
  assert.ok(fs.readdirSync(directory).some((name) => name.includes('.corrupt-')), 'malformed state must be quarantined');

  await assert.rejects(first.set('../escape', 'value'), /键无效/u);
  await assert.rejects(first.set('my-scholar-chat-v2:0123456789abcde', 'value'), /键无效/u);
  await assert.rejects(first.set('my-scholar-chat-v2:0123456789abcdeF', 'value'), /键无效/u);
  await assert.rejects(first.set(legacyChatKey, 'x'.repeat(MAX_VALUE_BYTES + 1)), /过大/u);
  await assert.rejects(first.set(chatV2Key, 'x'.repeat(MAX_VALUE_BYTES + 1)), /过大/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => console.log('renderer state tests passed')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
