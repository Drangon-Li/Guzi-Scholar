'use strict';

const { spawnSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const electron = require('electron');
const requestedRoot = process.argv.find((value) => value.startsWith('--data-root='))?.slice('--data-root='.length);
const dataRoot = path.resolve(requestedRoot || path.join(projectRoot, 'data', 'mcp-development'));
const debugPort = process.argv.find((value) => value.startsWith('--remote-debugging-port='));
if (debugPort && !/^--remote-debugging-port=\d{1,5}$/u.test(debugPort)) throw new Error('调试端口无效。');
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const build = spawnSync(process.execPath, [path.join(__dirname, 'build-mcp.cjs')], { cwd: projectRoot, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);
const args = [projectRoot, '--guzi-development', `--guzi-dev-root=${dataRoot}`, ...(debugPort ? [debugPort] : [])];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform === 'darwin') {
  const electronApp = path.dirname(path.dirname(path.dirname(electron)));
  const launched = spawnSync('/usr/bin/open', ['-n', '-a', electronApp, '--args', ...args], { cwd: projectRoot, env, stdio: 'inherit' });
  if (launched.status !== 0) process.exit(launched.status || 1);
  console.log(`开发版已请求启动，独立数据目录：${dataRoot}`);
  console.log(`运行信息：${path.join(dataRoot, 'development-runtime.json')}`);
} else {
  const child = spawn(electron, args, { cwd: projectRoot, env, stdio: 'inherit' });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code || 0; });
}
