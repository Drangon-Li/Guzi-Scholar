'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { tests, selectTests } = require('./ui-test-plan.cjs');
const { verifyReports, readReports } = require('../scripts/verify-ui-results.cjs');

const plans = Array.from({ length: 4 }, (_, index) => selectTests(['--ci', `--shard=${index + 1}/4`], {}));
assert.deepStrictEqual(selectTests([], {}).selected, tests);
assert.deepStrictEqual(selectTests([], { MY_SCHOLAR_UI_CI: 'yes' }).selected, selectTests(['--ci'], {}).selected);
assert.deepStrictEqual(selectTests(['--only=graph'], {}).selected.map(([name]) => name), ['graph']);
assert.deepStrictEqual(selectTests(['--ci', '--only=graph', '--shard=1/1'], {}).selected.map(([name]) => name), ['graph']);
const shardSizes = plans.map((plan) => plan.selected.length);
assert(Math.max(...shardSizes) - Math.min(...shardSizes) <= 1);
const names = plans.flatMap((plan) => plan.selected.map(([name]) => name));
assert.equal(new Set(names).size, tests.length);
assert.deepStrictEqual([...names].sort(), tests.filter(([, , meta]) => meta.ci).map(([name]) => name).sort());
for (const arg of ['--shard', '--shard=', '--shard=0/4', '--shard=5/4', '--shard=1/0', '--shard=1.5/4', '--shard=01/4', '--shard=1/4x', `--shard=${tests.length + 1}/${tests.length + 1}`, '--shard=1/9007199254740992']) {
  assert.throws(() => selectTests([arg], {}), /shard/i, arg);
}
assert.throws(() => selectTests(['--shard=1/4', '--shard=2/4'], {}), /shard/i);
assert.throws(() => selectTests(['--only=graph', '--shard=2/4'], {}), /no suites/);
assert.throws(() => selectTests(['--only=missing'], {}), /Unknown UI suite/);

function passingReports() {
  return plans.map(({ ciOnly, shard, selected }) => ({
    schemaVersion: 1,
    ciOnly,
    shard: { ...shard },
    expectedSuites: selected.map(([name]) => name),
    complete: true,
    error: null,
    results: selected.map(([name, script]) => ({ name, script, passed: true, status: 0, signal: null, error: null, durationMs: 1 })),
  }));
}

assert.deepStrictEqual(verifyReports(passingReports(), 4), { shards: 4, suites: tests.length });
function rejectChange(change) {
  const reports = passingReports();
  change(reports);
  assert.throws(() => verifyReports(reports, 4));
}
rejectChange((reports) => reports.pop());
rejectChange((reports) => reports.push(reports[0]));
rejectChange((reports) => { reports[1].shard = reports[0].shard; });
rejectChange((reports) => { reports[0].shard = { index: 0, total: 4 }; });
rejectChange((reports) => { reports[0].shard.total = 3; });
rejectChange((reports) => { reports[0].complete = false; });
rejectChange((reports) => { reports[0].error = 'runner terminated'; });
rejectChange((reports) => { reports[0].ciOnly = false; });
rejectChange((reports) => { reports[0].schemaVersion = 2; });
rejectChange((reports) => reports[0].expectedSuites.pop());
rejectChange((reports) => reports[0].results.pop());
rejectChange((reports) => reports[0].results.push(reports[0].results[0]));
rejectChange((reports) => { reports[0].results[1] = reports[0].results[0]; });
rejectChange((reports) => { reports[0].results[0].name = 'extra-suite'; });
rejectChange((reports) => { reports[0].results[0].script = 'other.js'; });
rejectChange((reports) => { reports[0].results[0].passed = false; });
rejectChange((reports) => { reports[0].results[0].status = 1; });
rejectChange((reports) => { reports[0].results[0].status = null; });
rejectChange((reports) => { reports[0].results[0].signal = 'SIGTERM'; });
rejectChange((reports) => { reports[0].results[0].error = 'cancelled'; });
rejectChange((reports) => { reports[0].results[0].durationMs = -1; });
rejectChange((reports) => { delete reports[0].results[0].durationMs; });
rejectChange((reports) => {
  reports[0].expectedSuites[0] = reports[1].expectedSuites[0];
  reports[0].results[0] = reports[1].results[0];
});
assert.throws(() => verifyReports([], 0));

async function exerciseRunner(args, reportPath, outcome = () => ({ status: 0, signal: null })) {
  const calls = [];
  const context = {
    require(name) {
      if (name === 'child_process') return {
        spawnSync(command, commandArgs, options) {
          calls.push({ command, args: Array.from(commandArgs), options });
          return outcome(calls.length);
        },
      };
      return require(name);
    },
    __dirname,
    process: { platform: process.platform, env: {}, pid: process.pid, argv: ['node', 'runner', ...args, `--report=${reportPath}`] },
    console: { log() {}, error() {} },
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'run_ui_tests.js'), 'utf8'), context);
  return { calls, exitCode: context.process.exitCode, report: JSON.parse(fs.readFileSync(reportPath, 'utf8')) };
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-sharding-unit-'));
  try {
    const reportPath = path.join(directory, 'runner.json');
    const successful = await exerciseRunner(['http://127.0.0.1:8123', '--ci', '--shard=1/4'], reportPath);
    assert.equal(successful.calls.length, plans[0].selected.length);
    assert(successful.calls.every((call) => call.args[1] === 'http://127.0.0.1:8123' && call.options.windowsHide && !call.options.shell));
    assert.deepStrictEqual(successful.calls.map((call) => path.basename(call.args[0])), plans[0].selected.map(([, script]) => script));
    assert.equal(successful.exitCode, undefined);
    const reports = passingReports();
    reports[0] = successful.report;
    assert.equal(verifyReports(reports, 4).suites, tests.length);

    const only = await exerciseRunner(['http://127.0.0.1:8123', '--only=graph'], reportPath);
    assert.deepStrictEqual(only.report.expectedSuites, ['graph']);
    const all = await exerciseRunner(['http://127.0.0.1:8123'], reportPath);
    assert.equal(all.calls.length, tests.length);
    const failed = await exerciseRunner(['http://127.0.0.1:8123', '--ci', '--shard=1/4'], reportPath, () => ({ status: 1, signal: null }));
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.report.complete, true);
    reports[0] = failed.report;
    assert.throws(() => verifyReports(reports, 4));

    const crashed = await exerciseRunner(['http://127.0.0.1:8123', '--ci', '--shard=1/4'], reportPath, () => { throw new Error('suite launch failed'); });
    assert.equal(crashed.exitCode, 1);
    assert.equal(crashed.report.complete, false);
    assert.equal(crashed.report.results[0].passed, false);
    assert.match(crashed.report.error, /suite launch failed/);
    reports[0] = crashed.report;
    assert.throws(() => verifyReports(reports, 4));
    const preflight = await exerciseRunner(['--ci', '--shard=1/4'], reportPath, () => ({ status: 1 }));
    assert.equal(preflight.exitCode, 1);
    assert.equal(preflight.report.complete, false);
    assert.equal(preflight.report.results.length, 0);

    fs.unlinkSync(reportPath);
    const nested = path.join(directory, 'artifacts');
    fs.mkdirSync(nested);
    passingReports().forEach((report, index) => fs.writeFileSync(path.join(nested, `shard-${index + 1}.json`), JSON.stringify(report)));
    assert.equal(verifyReports(readReports(directory), 4).suites, tests.length);
    const verifier = path.join(__dirname, '..', 'scripts', 'verify-ui-results.cjs');
    assert.equal(spawnSync(process.execPath, [verifier, directory, '4']).status, 0);
    fs.unlinkSync(path.join(nested, 'shard-4.json'));
    assert.equal(spawnSync(process.execPath, [verifier, directory, '4']).status, 1);
    fs.writeFileSync(path.join(nested, 'broken.json'), '{');
    assert.equal(spawnSync(process.execPath, [verifier, directory, '4']).status, 1);
    assert.equal(spawnSync(process.execPath, [verifier, directory, '0']).status, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('UI sharding selection, reporting, and aggregation passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
