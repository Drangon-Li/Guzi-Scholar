'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const configured = String(process.env.MY_SCHOLAR_TEST_PYTHON || '').trim();
const candidates = [
  [configured, []],
  ...(process.platform === 'win32' ? [
    [process.env.VIRTUAL_ENV ? path.join(process.env.VIRTUAL_ENV, 'Scripts', 'python.exe') : '', []],
    [process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, 'python.exe') : '', []],
    ['python', []],
    ['python3', []],
    ['py', ['-3']],
  ] : [
    ['/opt/anaconda3/bin/python3', []],
    ['/opt/homebrew/bin/python3', []],
    ['/usr/local/bin/python3', []],
    ['/usr/bin/python3', []],
    ['python3', []],
  ]),
].filter(([command]) => command && !/\.(cmd|bat)$/i.test(command));

let python = null;
for (const [command, prefix] of candidates) {
  if (/[\\/]/.test(command) && !fs.existsSync(command)) continue;
  const probe = spawnSync(command, [...prefix, '-c', 'import hashlib, sqlite3; assert hasattr(hashlib, "scrypt")'], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  if (probe.status === 0) {
    python = { command, prefix };
    break;
  }
}

if (!python) {
  console.error('完整测试需要具备 hashlib.scrypt 与 sqlite3 的 Python；可通过 MY_SCHOLAR_TEST_PYTHON 指定。');
  process.exit(1);
}

const result = spawnSync(python.command, [...python.prefix, '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
