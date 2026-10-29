'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const vm = require('node:vm');
const os = require('node:os');

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
assert.equal(upload.with.overwrite, true);

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
assert.deepEqual(Object.keys(windows.on), ['workflow_dispatch'], 'Windows builds must remain manual');
assert.equal(checks.jobs.desktop.name, 'Desktop checks', 'Keep the existing branch protection check context');
assert.equal(checks.jobs.desktop['runs-on'], 'macos-15');
assert.equal(shards['runs-on'], 'macos-15');
assert.equal(checks.jobs.runtime['runs-on'], 'macos-15');
assert.equal(release.on.workflow_dispatch.inputs.include_windows.default, false);
assert.match(release.jobs.windows.if, /github.event_name == 'workflow_dispatch'/u);
assert.match(release.jobs.windows.if, /inputs.include_windows/u);
assert.match(release.jobs.draft.if, /needs.macos.result == 'success'/u);
assert.match(release.jobs.draft.if, /needs.windows.result == 'skipped'/u);
const assemble = release.jobs.draft.steps.find((step) => step.run?.includes('release-pipeline.cjs prepare'));
assert.match(assemble.run, /if \[\[ "\$INCLUDE_WINDOWS" == true \]\]/u);
assert.match(assemble.run, /options\+=\(--with-windows\)/u);
const acceptance = read('release-acceptance.yml');
assert.match(acceptance.jobs.windows.if, /needs.validate.outputs.windows == 'true'/u);
assert.match(acceptance.jobs.record.if, /needs.validate.outputs.windows != 'true' \|\| needs.windows.result == 'success'/u);
const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
for (const name of ['check', 'test:runtime', 'check:release-contracts']) {
  assert.doesNotMatch(metadata.scripts[name], /test:windows|windows_(?:updater|release)|test_runner_windows/u, `Default ${name} must not run Windows-specific suites`);
}
assert.match(metadata.scripts['test:windows'], /windows_release_acceptance/u);
assert.match(metadata.scripts['test:unit:windows'], /--windows$/u);
assert.match(metadata.scripts['test:unit:all'], /--all$/u);

function checkPythonSelection() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-python-selection-'));
  try {
    const tests = path.join(root, 'tests');
    fs.mkdirSync(tests);
    fs.copyFileSync(path.join(__dirname, 'run_python_suite.py'), path.join(tests, 'run_python_suite.py'));
    for (const [name, marker] of [['common', 'shared-imported'], ['windows_runtime', 'windows-imported']]) {
      fs.writeFileSync(path.join(tests, `test_${name}.py`), `import pathlib, unittest\npathlib.Path('${marker}').touch()\nclass Case(unittest.TestCase):\n    def test_pass(self):\n        pass\n`);
    }
    for (const [args, shared, windows] of [[[], true, false], [['--windows'], false, true], [['--all'], true, true]]) {
      for (const marker of ['shared-imported', 'windows-imported']) fs.rmSync(path.join(root, marker), { force: true });
      const result = spawnSync(process.execPath, [path.join(__dirname, 'run_python_tests.js'), ...args], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.existsSync(path.join(root, 'shared-imported')), shared);
      assert.equal(fs.existsSync(path.join(root, 'windows-imported')), windows);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
checkPythonSelection();

async function checkAcceptanceModes() {
  const step = acceptance.jobs.validate.steps.find((item) => item.run?.includes("node <<'NODE'"));
  const script = step.run.split("node <<'NODE'\n")[1].split('\nNODE')[0];
  const context = { tag: 'v0.6.9', version: '0.6.9', channel: 'stable', commit: 'a'.repeat(40) };
  const repository = 'Drangon-Li/Guzi-Scholar';
  for (const windowsCandidate of [false, true]) {
    for (const mac of ['', '{}']) for (const win of ['', '{}']) {
      let output = '';
      const downloaded = [];
      const manifest = { schema: 2, repository, version: context.version, channel: context.channel, artifacts: [{ platform: 'darwin' }, ...(windowsCandidate ? [{ platform: 'win32' }] : [])] };
      const processMock = { env: { MACOS_REPORT: mac, WINDOWS_REPORT: win, GITHUB_SHA: context.commit, GITHUB_WORKFLOW_SHA: context.commit, GITHUB_REF: `refs/tags/${context.tag}`, GITHUB_OUTPUT: 'output' }, exitCode: 0 };
      vm.runInNewContext(script, {
        process: processMock,
        console: { error() {} },
        require(name) {
          if (name === 'node:fs') return { readFileSync: () => JSON.stringify(context), appendFileSync: (_file, value) => { output += value; } };
          return { REPOSITORY: repository, GitHub: class {
            async releases() { return [{ tag_name: context.tag, draft: true, prerelease: false }]; }
            async assets() { return [{ name: 'update-manifest.json' }, { name: 'candidate.zip' }, { name: 'candidate.dmg' }]; }
            async download(asset) { downloaded.push(asset.name); return JSON.stringify(manifest); }
          } };
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(downloaded, ['update-manifest.json'], 'Routing must not download package payloads; native, record and promote verify them');
      const valid = windowsCandidate ? Boolean(mac) === Boolean(win) : !win;
      assert.equal(processMock.exitCode, valid ? 0 : 1, `Acceptance report mode must match actual candidate platforms: ${windowsCandidate}/${Boolean(mac)}/${Boolean(win)}`);
      if (valid) assert.equal(output, `mode=${mac ? 'external' : 'native'}\nwindows=${windowsCandidate}\n`);
      else assert.equal(output, '');
    }
  }
  console.log('CI workflow gates passed: Mac defaults, manual Windows, platform-matched native/external acceptance, early release contracts, complete UI coverage and release isolation');
}
checkAcceptanceModes().catch((error) => { console.error(error); process.exitCode = 1; });
