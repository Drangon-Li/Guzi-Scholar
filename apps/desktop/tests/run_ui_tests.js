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
  ['ai-controls', 'ai_controls_smoke.js', { ci: true }],
  ['vocabulary', 'vocabulary_smoke.js', { ci: true }],
  ['plugin-market', 'plugin_market_smoke.js', { ci: true }],
  ['notes-revision', 'notes_revision_smoke.js', { ci: true }],
  ['zotero-import', 'zotero_import_smoke.js', { ci: true }],
  ['zotero-note-markers', 'zotero_note_markers_smoke.js', { ci: true }],
  ['zotero-anchor-mapping', 'zotero_anchor_mapping_smoke.js', { ci: true }],
  ['translation', 'translation_smoke.js', { ci: true }],
  ['translation-controls', 'translation_controls_smoke.js', { ci: true }],
  ['math-typography', 'math_typography_smoke.js', { ci: true }],
  ['chat-math', 'chat_math_rendering_test.js', { ci: true }],
  ['reader-experience', 'reader_experience_smoke.js', { ci: true }],
  ['sentence-translation', 'sentence_translation_smoke.js', { ci: true }],
  ['reader-copy', 'reader_copy_test.js', { ci: true }],
  ['translation-annotation', 'translation_annotation_test.js', { ci: true }],
  ['annotation-colors', 'annotation_colors_smoke.js', { ci: true }],
  ['annotation-hover', 'annotation_hover_smoke.js', { ci: true }],
  ['reader-transition', 'reader_transition_smoke.js', { ci: true }],
  ['reader-keepalive', 'reader_keepalive_smoke.js', { ci: true }],
  ['reader-memory', 'reader_memory_smoke.js', { ci: true }],
  ['reader-switch-performance', 'reader_switch_performance_smoke.js', { ci: true }],
  ['navigation-performance', 'navigation_performance_smoke.js', { ci: true }],
  ['citations', 'citation_anchor_smoke.js', { ci: true }],
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
const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) || '';
if (only && !tests.some(([name]) => name === only)) throw new Error(`Unknown UI suite: ${only}`);
const selected = tests.filter(([name, , meta]) => (!ciOnly || meta.ci) && (!only || name === only));

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
const python = explicitBaseURL ? null : resolvePython();

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
