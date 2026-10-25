'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '../../apps/desktop');
const builder = path.join(appRoot, 'node_modules/electron-builder/out/cli/cli.js');

function builderArguments(target) {
  if (!['dir', 'dist'].includes(target)) throw new Error(`Unknown Windows build target: ${target}`);
  return [builder, '--projectDir', appRoot, '--config', path.join(__dirname, 'electron-builder.win.json'),
    '--win', '--x64', '--publish=never', ...(target === 'dir' ? ['--dir'] : [])];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: appRoot, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return result;
}

function buildPython(environment = process.env) {
  if (environment.MY_SCHOLAR_BUILD_PYTHON) return { command: environment.MY_SCHOLAR_BUILD_PYTHON, args: [] };
  for (const candidate of [{ command: 'py.exe', args: ['-3.11'] }, { command: 'python.exe', args: [] }]) {
    const result = spawnSync(candidate.command, [...candidate.args, '-c',
      'import sys, struct; assert sys.version_info[:2] == (3, 11) and struct.calcsize("P") == 8'],
    { encoding: 'utf8', windowsHide: true, env: environment });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('Windows x64 Python 3.11 is required; set MY_SCHOLAR_BUILD_PYTHON to its executable.');
}

function main(target = process.argv[2] || 'dist') {
  if (!['check', 'prepare', 'dir', 'dist'].includes(target)) throw new Error('Usage: node build-windows.cjs <check|prepare|dir|dist>');
  if (target === 'check') {
    JSON.parse(fs.readFileSync(path.join(__dirname, 'electron-builder.win.json'), 'utf8'));
    JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime-dependencies.json'), 'utf8'));
    return;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build Windows x64 packages on a native Windows x64 host.');
  if (!fs.existsSync(builder)) throw new Error('Missing locked electron-builder; run npm ci in apps/desktop first.');
  const python = buildPython();
  run(process.execPath, [path.join(appRoot, 'scripts/build-mcp.cjs')]);
  run(python.command, [...python.args, path.join(appRoot, 'scripts/prepare-windows-release.py')]);
  if (target !== 'prepare') run(process.execPath, builderArguments(target));
}

module.exports = { builderArguments, buildPython, appRoot };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
