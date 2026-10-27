'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function exerciseUnitRunner(platform, env, available) {
  const calls = [];
  const exit = {};
  let status;
  try {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'run_python_tests.js'), 'utf8'), {
      require(name) {
        if (name === 'child_process') return { spawnSync(command, args, options) {
          calls.push({ command, args: Array.from(args), options });
          return { status: available(command) ? 0 : 1 };
        } };
        if (name === 'fs') return { existsSync: () => true };
        return require(name);
      },
      process: { platform, env, argv: ['node', 'runner', '--all'], cwd: () => __dirname, exit(value) { status = value; throw exit; } },
      console,
    });
  } catch (error) {
    if (error !== exit) throw error;
  }
  return { calls, status };
}

{
  const { calls, status } = exerciseUnitRunner('win32', {}, (command) => command === 'py');
  assert.equal(status, 0);
  assert.deepEqual(calls.map((call) => call.command), ['python', 'python3', 'py', 'py']);
  assert.deepEqual(calls.at(-1).args, ['-3', '-B', 'tests/run_python_suite.py', '--all']);
  assert(calls.every((call) => call.options.windowsHide === true && !call.options.shell));
}

{
  const configured = 'C:\\Python With Spaces\\python.exe';
  const { calls } = exerciseUnitRunner('win32', { MY_SCHOLAR_TEST_PYTHON: configured }, () => true);
  assert.equal(calls[0].command, configured);
  assert.equal(calls[1].command, configured);
  assert.equal(calls[1].args[0], '-B');
}

{
  const { calls } = exerciseUnitRunner('win32', { MY_SCHOLAR_TEST_PYTHON: 'unsafe.cmd' }, () => true);
  assert.equal(calls[0].command, 'python');
}

{
  const { calls } = exerciseUnitRunner('darwin', {}, () => true);
  assert.equal(calls[0].command, '/opt/anaconda3/bin/python3');
  assert.equal(calls[1].args[0], '-B');
}

{
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, 'run_ui_tests.js'), 'utf8');
  const context = {
    require(name) {
      if (name === 'child_process') return { spawnSync(command, args, options) {
        calls.push({ command, args: Array.from(args), options });
        return { status: command === 'py' ? 0 : 1 };
      } };
      return require(name);
    },
    __dirname,
    process: { platform: 'win32', env: { MY_SCHOLAR_PYTHON: 'unsafe.bat' }, argv: ['node', 'runner', 'http://127.0.0.1:8123'] },
  };
  vm.runInNewContext(`${source.slice(0, source.indexOf('function freePort()'))}\nglobalThis.selectedPython = resolvePython();`, context);
  assert.equal(context.selectedPython.command, 'py');
  assert.deepEqual(Array.from(context.selectedPython.prefix), ['-3']);
  assert.deepEqual(calls.map((call) => call.command), ['python', 'python3', 'py']);
  assert(calls.every((call) => call.options.windowsHide === true && !call.options.shell));
}

console.log('Windows Python test runner behavior passed');
