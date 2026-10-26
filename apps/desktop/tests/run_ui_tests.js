'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const explicitBaseURL = args.find((arg) => !arg.startsWith('--')) || '';

const { selectTests } = require('./ui-test-plan.cjs');
const { ciOnly, shard, selected } = selectTests(args);
const reportArg = args.find((arg) => arg.startsWith('--report='));
const reportPath = reportArg ? path.resolve(reportArg.slice('--report='.length)) : '';
if (args.includes('--report') || reportArg === '--report=') throw new Error('UI report requires --report=PATH');

const desktopRoot = path.join(__dirname, '..');
function resolvePython() {
  const configured = String(process.env.MY_SCHOLAR_PYTHON || '').trim();
  const candidates = [
    [configured, []],
    ...(process.platform === 'win32' ? [
      [process.env.VIRTUAL_ENV ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe') : '', []],
      [process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, 'python.exe') : '', []],
      ['python', []], ['python3', []], ['py', ['-3']],
    ] : [['python3', []]]),
  ];
  for (const [command, prefix] of candidates) {
    if (!command || /\.(cmd|bat)$/i.test(command)) continue;
    if (/[\\/]/.test(command) && !fs.existsSync(command)) continue;
    const result = spawnSync(command, [...prefix, '-c', 'import hashlib, sqlite3; assert hasattr(hashlib, "scrypt")'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    if (result.status === 0) return { command, prefix };
  }
  throw new Error('UI 测试需要具备 hashlib.scrypt 与 sqlite3 的 Python；可通过 MY_SCHOLAR_PYTHON 指定。');
}
let python = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`server on port ${port} did not become healthy`));
      else setTimeout(attempt, 250);
    };
    const attempt = () => {
      const request = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve(); else retry();
      });
      request.on('error', retry);
      request.on('timeout', () => { request.destroy(); retry(); });
    };
    attempt();
  });
}

// Each suite gets its own seeded library and its own server process. The reader
// suites persist annotations, notes and media layout, so a shared data root
// makes later suites depend on what earlier ones wrote -- which is how `graph`
// began failing as soon as the reader suites joined the run.
async function runManaged(script) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'my-scholar-ui-'));
  const logPath = path.join(dataRoot, 'server.log');
  let server = null;
  try {
    const seed = spawnSync(python.command, [...python.prefix, path.join(__dirname, 'fixtures', 'seed_library.py'), dataRoot], {
      cwd: desktopRoot,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (seed.status !== 0) throw new Error(`fixture seed failed: ${seed.stderr || seed.stdout}`);

    const port = await freePort();
    const log = fs.openSync(logPath, 'a');
    server = spawn(python.command, [...python.prefix, path.join(desktopRoot, 'server.py'), '--port', String(port)], {
      cwd: desktopRoot,
      env: { ...process.env, MY_SCHOLAR_DATA_DIR: dataRoot, ...(script === 'plugin_market_smoke.js' ? { MY_SCHOLAR_PLUGIN_ADMISSION_TOKEN: 'fixture-admission-token' } : {}) },
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    fs.closeSync(log);
    await waitForHealth(port);

    const result = spawnSync(process.execPath, [path.join(__dirname, script), `http://127.0.0.1:${port}`], {
      cwd: desktopRoot,
      env: { ...process.env, MY_SCHOLAR_TEST_DATA: dataRoot },
      stdio: 'inherit',
      windowsHide: true,
    });
    const passed = result.status === 0 && !result.signal;
    if (!passed) process.stderr.write(fs.readFileSync(logPath, 'utf-8').slice(-4000));
    return { passed, status: result.status, signal: result.signal || null };
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((resolve) => {
        server.once('exit', resolve);
        setTimeout(resolve, 3000);
      });
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

function runShared(script, baseURL) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), baseURL], {
    cwd: desktopRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  return { passed: result.status === 0 && !result.signal, status: result.status, signal: result.signal || null };
}

async function main() {
  const report = {
    schemaVersion: 1,
    ciOnly,
    shard,
    expectedSuites: selected.map(([name]) => name),
    complete: false,
    error: null,
    results: [],
  };
  function writeReport() {
    if (!reportPath) return;
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const temporary = `${reportPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(temporary, reportPath);
  }
  writeReport();
  try {
    python = explicitBaseURL ? null : resolvePython();
    for (const [name, script] of selected) {
      console.log(`\n[UI ${report.results.length + 1}/${selected.length}, shard ${shard.index}/${shard.total}] ${name}`);
      const started = Date.now();
      try {
        const outcome = explicitBaseURL ? runShared(script, explicitBaseURL) : await runManaged(script);
        report.results.push({ name, script, ...outcome, error: null, durationMs: Date.now() - started });
      } catch (error) {
        report.results.push({ name, script, passed: false, status: null, signal: null, error: String(error), durationMs: Date.now() - started });
        throw error;
      } finally {
        writeReport();
      }
    }
    report.complete = true;
  } catch (error) {
    report.error = String(error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    writeReport();
  }
  const failed = report.results.filter((result) => !result.passed);
  console.log(JSON.stringify({
    total: report.results.length,
    passed: report.results.length - failed.length,
    failed: failed.map((result) => result.name),
    complete: report.complete,
    shard,
  }));
  if (failed.length || !report.complete) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
