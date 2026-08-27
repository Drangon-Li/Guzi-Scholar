'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const explicitBaseURL = args.find((arg) => !arg.startsWith('--')) || '';

// Every suite runs against the synthetic library produced by
// tests/fixtures/seed_library.py. The reader suites assert on fixed block ids,
// verbatim sentences and an exact document census, so the fixture reproduces
// that shape deliberately -- see the comments in seed_library.py.
const tests = [
  ['document', 'web_smoke.js', { ci: true }],
  ['features', 'feature_smoke.js', { ci: true }],
  ['translation', 'translation_smoke.js', { ci: true }],
  ['library', 'library_smoke.js', { ci: true }],
  ['library-v3', 'library_v3_smoke.js', { ci: true }],
  ['interactions', 'interaction_regression.js', { ci: true }],
  ['library-v4', 'library_interactions_v4.js', { ci: true }],
  ['reading-progress', 'reading_progress_retirement_smoke.js', { ci: true }],
  ['graph', 'graph_ui_smoke.js', { ci: true }],
  ['onboarding', 'onboarding_smoke.js', { ci: true }],
];

const ciOnly = args.includes('--ci')
  || ['1', 'true', 'yes'].includes(String(process.env.MY_SCHOLAR_UI_CI || '').toLowerCase());
const selected = ciOnly ? tests.filter(([, , meta]) => meta.ci) : tests;

const desktopRoot = path.join(__dirname, '..');
const python = process.env.MY_SCHOLAR_PYTHON || 'python3';

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
    const seed = spawnSync(python, [path.join(__dirname, 'fixtures', 'seed_library.py'), dataRoot], {
      cwd: desktopRoot,
      encoding: 'utf-8',
    });
    if (seed.status !== 0) throw new Error(`fixture seed failed: ${seed.stderr || seed.stdout}`);

    const port = await freePort();
    const log = fs.openSync(logPath, 'a');
    server = spawn(python, [path.join(desktopRoot, 'server.py'), '--port', String(port)], {
      cwd: desktopRoot,
      env: { ...process.env, MY_SCHOLAR_DATA_DIR: dataRoot },
      stdio: ['ignore', log, log],
    });
    await waitForHealth(port);

    const result = spawnSync(process.execPath, [path.join(__dirname, script), `http://127.0.0.1:${port}`], {
      cwd: desktopRoot,
      env: { ...process.env, MY_SCHOLAR_TEST_DATA: dataRoot },
      stdio: 'inherit',
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
  });
  return { passed: result.status === 0 && !result.signal, status: result.status, signal: result.signal || null };
}

(async () => {
  const results = [];
  for (const [name, script] of selected) {
    console.log(`\n[UI ${results.length + 1}/${selected.length}] ${name}`);
    const outcome = explicitBaseURL ? runShared(script, explicitBaseURL) : await runManaged(script);
    results.push({ name, ...outcome });
  }
  const failed = results.filter((result) => !result.passed);
  console.log(JSON.stringify({
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.map((result) => result.name),
  }));
  if (failed.length) process.exitCode = 1;
})();
