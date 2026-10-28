'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { tests, selectTests } = require('./ui-test-plan.cjs');
const { verifyReports, readReports } = require('../scripts/verify-ui-results.cjs');

const ciTests = tests.filter(([, , meta]) => meta.ci);
const plans = Array.from({ length: 4 }, (_, index) => selectTests(['--ci', `--shard=${index + 1}/4`], {}));
assert.deepStrictEqual(selectTests([], {}).selected, tests);
assert.deepStrictEqual(selectTests([], { MY_SCHOLAR_UI_CI: 'yes' }).selected, selectTests(['--ci'], {}).selected);
assert.deepStrictEqual(selectTests(['--only=graph'], {}).selected.map(([name]) => name), ['graph']);
assert.deepStrictEqual(selectTests(['--only=browser-demo'], {}).selected.map(([name]) => name), ['browser-demo']);
assert(!ciTests.some(([name]) => name === 'browser-demo'));
assert.deepStrictEqual(selectTests(['--ci', '--only=graph', '--shard=1/1'], {}).selected.map(([name]) => name), ['graph']);
const shardSizes = plans.map((plan) => plan.selected.length);
assert(Math.max(...shardSizes) - Math.min(...shardSizes) <= 1);
const names = plans.flatMap((plan) => plan.selected.map(([name]) => name));
assert.equal(new Set(names).size, ciTests.length);
assert.deepStrictEqual([...names].sort(), ciTests.map(([name]) => name).sort());
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

assert.deepStrictEqual(verifyReports(passingReports(), 4), { shards: 4, suites: ciTests.length });
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

async function exerciseHealthProbe() {
  const requests = [];
  const timers = [];
  let now = 0;
  const context = {
    Date: { now: () => now },
    setTimeout(callback) { timers.push(callback); },
    http: {
      get(options, callback) {
        const request = new EventEmitter();
        request.destroyed = false;
        request.destroy = (error) => {
          request.destroyed = true;
          if (error) request.emit('error', error);
        };
        requests.push({ request, options, callback });
        return request;
      },
    },
  };
  const source = fs.readFileSync(path.join(__dirname, 'run_ui_tests.js'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('async function waitForHealth'), source.indexOf('// Each suite')), context);
  const healthy = context.waitForHealth(8123, 1000);
  requests[0].request.emit('timeout');
  await Promise.resolve();
  assert.equal(timers.length, 1, 'timeout and error must schedule only one retry');
  timers.shift()();
  await Promise.resolve();
  assert.equal(requests.length, 2);
  assert(requests[0].request.destroyed);
  const response = new EventEmitter();
  response.statusCode = 200;
  response.resume = () => {};
  requests[1].callback(response);
  assert.equal(requests[1].request.destroyed, false, 'wait for the health response to finish');
  response.emit('end');
  await healthy;
  requests[1].request.emit('error', new Error('late error'));
  assert.equal(timers.length, 0, 'completed probes must not create background retries');
  assert(requests[1].request.destroyed, 'release the health socket before starting a suite');
  assert(requests.every(({ options }) => options.agent === false));

  const unhealthy = context.waitForHealth(8123, 1000);
  requests[2].request.emit('error', new Error('connection refused'));
  await Promise.resolve();
  assert.equal(timers.length, 1);
  now = 1000;
  timers.shift()();
  await assert.rejects(unhealthy, /did not become healthy/);
  assert.equal(requests.length, 3, 'the overall deadline must stop new probes');
}

async function exerciseManagedFixture(name, status) {
  const [, script, meta] = tests.find(([suite]) => suite === name);
  const calls = [];
  let dataRoot;
  let serverStopped = false;
  const context = {
    fs, os, path,
    __dirname,
    desktopRoot: path.join(__dirname, '..'),
    python: { command: 'python3', prefix: [] },
    process: {
      execPath: process.execPath,
      env: {
        MY_SCHOLAR_DATA_DIR: '/existing/data',
        MY_SCHOLAR_LIBRARY_DIR: '/existing/library',
        MY_SCHOLAR_COMPONENTS_DIR: '/existing/components',
        MY_SCHOLAR_READONLY: '1',
      },
      stderr: { write() {} },
    },
    freePort: async () => 8123,
    waitForHealth: async () => {},
    setTimeout() {},
    spawnSync(command, args, options) {
      calls.push({ command, args: Array.from(args), options });
      if (calls.length === 1) dataRoot = args.at(-1);
      return { status: calls.length === 1 ? 0 : status, signal: null };
    },
    spawn(command, args, options) {
      calls.push({ command, args: Array.from(args), options });
      const server = new EventEmitter();
      server.kill = (signal) => {
        assert.equal(signal, 'SIGTERM');
        serverStopped = true;
        queueMicrotask(() => server.emit('exit', 0));
      };
      return server;
    },
  };
  const source = fs.readFileSync(path.join(__dirname, 'run_ui_tests.js'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('async function runManaged'), source.indexOf('function runShared')), context);
  const result = await context.runManaged(script, meta);
  assert.equal(result.passed, status === 0);
  assert.equal(path.basename(calls[0].args[0]), meta.fixture || 'seed_library.py');
  assert.equal(calls[0].options.env.MY_SCHOLAR_READONLY, '0', 'Seed construction must remain writable.');
  assert(calls[1].args.includes('--host') && calls[1].args.includes('127.0.0.1'));
  for (const call of calls) {
    assert.equal(call.options.env.MY_SCHOLAR_DATA_DIR, dataRoot);
    assert.equal(call.options.env.MY_SCHOLAR_LIBRARY_DIR, dataRoot, 'Never inherit the existing library.');
    assert.equal(call.options.env.MY_SCHOLAR_COMPONENTS_DIR, path.join(dataRoot, 'components'));
    assert.equal(call.options.env.MY_SCHOLAR_SETTINGS_FILE, path.join(dataRoot, 'settings.json'));
  }
  assert.equal(calls[1].options.env.MY_SCHOLAR_READONLY, meta.readonly ? '1' : '0');
  assert.equal(calls[2].options.env.MY_SCHOLAR_TEST_DATA, dataRoot);
  assert(serverStopped, 'Stop the owned server after both passing and failing suites.');
  assert(!fs.existsSync(dataRoot), 'Remove the owned fixture after both passing and failing suites.');
}

async function main() {
  await exerciseHealthProbe();
  await exerciseManagedFixture('browser-demo', 0);
  await exerciseManagedFixture('browser-demo', 1);
  await exerciseManagedFixture('graph', 0);
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
    assert.equal(verifyReports(reports, 4).suites, ciTests.length);

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
    const spawnFailure = await exerciseRunner(['http://127.0.0.1:8123', '--only=features'], reportPath, () => ({ status: null, error: new Error('spawn EMFILE') }));
    assert.equal(spawnFailure.exitCode, 1);
    assert.equal(spawnFailure.report.complete, false);
    assert.match(spawnFailure.report.error, /spawn EMFILE/);
    const preflight = await exerciseRunner(['--ci', '--shard=1/4'], reportPath, () => ({ status: 1 }));
    assert.equal(preflight.exitCode, 1);
    assert.equal(preflight.report.complete, false);
    assert.equal(preflight.report.results.length, 0);

    fs.unlinkSync(reportPath);
    const nested = path.join(directory, 'artifacts');
    fs.mkdirSync(nested);
    passingReports().forEach((report, index) => fs.writeFileSync(path.join(nested, `shard-${index + 1}.json`), JSON.stringify(report)));
    assert.equal(verifyReports(readReports(directory), 4).suites, ciTests.length);
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
