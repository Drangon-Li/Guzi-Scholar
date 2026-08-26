'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const baseURL = args.find((arg) => !arg.startsWith('--')) || 'http://127.0.0.1:8766';

// `ci: true` means the suite runs against the synthetic library produced by
// tests/fixtures/seed_library.py. The rest still assume a locally imported
// copy of a specific paper (they assert on real block IDs, quoted sentences
// and the TeX/MathML formula pipeline), so they stay a local-only suite until
// a real conversion artifact is checked in as a fixture.
const tests = [
  ['document', 'web_smoke.js', { ci: false }],
  ['features', 'feature_smoke.js', { ci: false }],
  ['translation', 'translation_smoke.js', { ci: false }],
  ['library', 'library_smoke.js', { ci: true }],
  ['library-v3', 'library_v3_smoke.js', { ci: false }],
  ['interactions', 'interaction_regression.js', { ci: true }],
  ['library-v4', 'library_interactions_v4.js', { ci: true }],
  ['reading-progress', 'reading_progress_retirement_smoke.js', { ci: true }],
  ['graph', 'graph_ui_smoke.js', { ci: true }],
  ['onboarding', 'onboarding_smoke.js', { ci: true }],
];

const ciOnly = args.includes('--ci')
  || ['1', 'true', 'yes'].includes(String(process.env.MY_SCHOLAR_UI_CI || '').toLowerCase());
const selected = ciOnly ? tests.filter(([, , meta]) => meta.ci) : tests;
const results = [];

for (const [name, script] of selected) {
  console.log(`\n[UI ${results.length + 1}/${selected.length}] ${name}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script), baseURL], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  });
  const passed = result.status === 0 && !result.signal;
  results.push({ name, passed, status: result.status, signal: result.signal || null });
}

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((result) => result.name) }));
if (failed.length) process.exitCode = 1;
