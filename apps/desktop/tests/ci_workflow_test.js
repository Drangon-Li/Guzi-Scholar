'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const directory = path.resolve(__dirname, '../../../.github/workflows');
const read = (name) => yaml.load(fs.readFileSync(path.join(directory, name), 'utf8'));
const checks = read('checks.yml');
assert.equal(checks.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
assert.match(checks.concurrency.group, /github\.event\.pull_request\.number/u);

const shards = checks.jobs['ui-shards'];
assert.deepEqual(shards.strategy.matrix.shard, [1, 2, 3, 4]);
assert.equal(shards.strategy['fail-fast'], false);
assert.ok(!shards['continue-on-error']);
const uiRun = shards.steps.find((step) => step.run?.includes('run test:ui:ci'));
assert.ok(uiRun.run.includes('--shard=${{ matrix.shard }}/4'));
assert.ok(uiRun.run.includes('--report=${{ runner.temp }}/ui-shard-${{ matrix.shard }}.json'));
assert.ok(!uiRun['continue-on-error']);
const upload = shards.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
assert.equal(upload.if, 'always()');
assert.equal(upload.with.name, 'ui-results-${{ matrix.shard }}');
assert.equal(upload.with.path, '${{ runner.temp }}/ui-shard-${{ matrix.shard }}.json');
assert.equal(upload.with['if-no-files-found'], 'error');

const ui = checks.jobs.ui;
assert.equal(ui.name, 'UI smoke tests');
assert.equal(ui.if, 'always()');
assert.deepEqual(ui.needs, ['ui-shards']);
assert.ok(!ui['continue-on-error']);
const resultGate = ui.steps.find((step) => step.env?.SHARD_RESULT);
assert.equal(resultGate.env.SHARD_RESULT, '${{ needs.ui-shards.result }}');
const download = ui.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
assert.equal(download.with.pattern, 'ui-results-*');
assert.equal(download.with.path, '${{ runner.temp }}/ui-results');
const verify = ui.steps.find((step) => step.run?.includes('verify-ui-results.cjs'));
assert.match(verify.run, /verify-ui-results\.cjs "\$\{\{ runner\.temp \}\}\/ui-results" 4$/u);
assert.ok(!verify.if && !verify['continue-on-error']);

const windows = read('windows.yml');
const windowsGate = windows.jobs['windows-status'].steps.find((step) => step.env?.PACKAGES_RESULT);
if (process.platform !== 'win32') {
  for (const state of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const result = spawnSync('bash', ['-e', '-c', resultGate.run], { env: { PATH: process.env.PATH, SHARD_RESULT: state } });
    assert.equal(result.status === 0, state === 'success', `UI aggregate must reject ${state || 'missing'} status`);
    for (const other of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const combined = spawnSync('bash', ['-e', '-c', windowsGate.run], {
        env: { PATH: process.env.PATH, PACKAGES_RESULT: state, UPGRADE_RESULT: other },
      });
      assert.equal(combined.status === 0, state === 'success' && other === 'success', 'Both Windows paths are required');
    }
  }
}

const contracts = 'npm --prefix apps/desktop run check:release-contracts';
const release = read('release.yml');
const macos = read('macos.yml');
for (const [job, operation] of [
  [windows.jobs.windows, 'npm run build:windows'],
  [windows.jobs['windows-upgrade'], 'npm --prefix apps/desktop run test:windows:upgrade'],
  [macos.jobs.macos, 'npm --prefix apps/desktop run prepare:mac'],
  [release.jobs.macos, 'npm --prefix apps/desktop run prepare:mac'],
  [release.jobs.windows, 'npm run build:windows'],
]) {
  const commands = job.steps.map((step) => step.run || '').join('\n');
  assert.ok(commands.indexOf(contracts) >= 0 && commands.indexOf(contracts) < commands.indexOf(operation), 'Release contracts must run before native packaging');
}
assert.ok(release.jobs.validate.steps.some((step) => step.run?.includes('node apps/desktop/tests/mac_release_test.js')));
for (const name of ['release.yml', 'release-acceptance.yml']) {
  assert.equal(read(name).concurrency['cancel-in-progress'], false, 'PR concurrency must not cancel release or acceptance runs');
}

const macCache = macos.jobs.macos.steps.find((step) => step.uses?.startsWith('actions/cache@'));
assert.match(macCache.uses, /^actions\/cache@[a-f0-9]{40}$/u);
assert.deepEqual(macCache.with.path.trim().split('\n'), ['${{ env.PIP_CACHE_DIR }}', '${{ env.ELECTRON_CACHE }}', '${{ env.ELECTRON_BUILDER_CACHE }}']);
for (const key of ['runner.os', 'runner.arch', 'steps.python.outputs.python-version', 'apps/desktop/package-lock.json', 'apps/desktop/scripts/prepare-mac-release.sh']) {
  assert.ok(macCache.with.key.includes(key));
}
console.log('CI workflow gates passed: all shards, both Windows jobs, early release contracts, download-only caches and release isolation');
