const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { packagedToolchainEnvironment, resolvePackagedServer } = require('../electron/packaged-runtime.cjs');
const {
  PythonRuntimeError,
  probePython,
  pythonCandidates,
  resolvePythonRuntime,
  versionSupported,
} = require('../electron/python-runtime.cjs');

function successfulProbe(version = { major: 3, minor: 11, micro: 9 }) {
  return { status: 0, stdout: `${JSON.stringify(version)}\n`, stderr: '' };
}

assert.equal(versionSupported({ major: 3, minor: 9 }), true);
assert.equal(versionSupported({ major: 3, minor: 8 }), false);

{
  let probeScript = '';
  const result = probePython(
    { command: 'python3', args: [], source: 'test' },
    { spawnSyncImpl: (_command, args) => { probeScript = args.at(-1); return { status: 1, stdout: '', stderr: 'missing scrypt' }; } },
  );
  assert.match(probeScript, /hashlib[\s\S]*scrypt/u);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing scrypt/u);
}

{
  const candidates = pythonCandidates({
    env: {},
    platform: 'darwin',
    resourcesPath: '/App/Contents/Resources',
    appPath: '/App/Contents/Resources/app',
  });
  assert.equal(candidates[0].command, path.join('/App/Contents/Resources', 'python', 'bin', 'python3'));
  assert.equal(candidates[0].source, 'bundled-python');
  assert(candidates.some((candidate) => candidate.command === '/opt/homebrew/bin/python3'));
}

{
  const calls = [];
  const runtime = resolvePythonRuntime({
    env: { MY_SCHOLAR_PYTHON: '/custom/python3' },
    platform: 'darwin',
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      return successfulProbe();
    },
  });
  assert.equal(runtime.command, '/custom/python3');
  assert.equal(runtime.source, 'MY_SCHOLAR_PYTHON');
  assert.equal(calls.length, 1);
}

{
  const result = probePython(
    { command: 'python3', args: [], source: 'test' },
    { spawnSyncImpl: () => successfulProbe({ major: 3, minor: 8, micro: 20 }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /低于 3\.9/u);
}

{
  let thrown = null;
  try {
    resolvePythonRuntime({
      env: { MY_SCHOLAR_PYTHON: '/missing/python3' },
      platform: 'darwin',
      spawnSyncImpl: () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') }),
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof PythonRuntimeError);
  assert.match(thrown.message, /MY_SCHOLAR_PYTHON/u);
  assert.equal(thrown.attempts.length, 1);
}

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-packaged-runtime-paths-'));
try {
  for (const platform of ['darwin', 'win32']) {
    const resourcesPath = path.join(temporary, platform, 'resources with spaces');
    const suffix = platform === 'win32' ? '.exe' : '';
    const server = path.join(resourcesPath, 'python-server', `my-scholar-server${suffix}`);
    const caBundle = path.join(resourcesPath, 'python-server', 'ca-certificates.crt');
    const jar = path.join(resourcesPath, 'toolchain', 'opendataloader-pdf-cli-0.0.0.jar');
    const java = path.join(resourcesPath, 'java', 'bin', `java${suffix}`);
    const pandoc = path.join(resourcesPath, 'toolchain', 'pandoc', `pandoc${suffix}`);
    const renderer = path.join(resourcesPath, 'toolchain', 'pdf-renderer', 'MyScholarPdfRenderer.class');
    for (const file of [server, caBundle, jar, java, pandoc, renderer]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'runtime fixture');
    }
    const options = { resourcesPath, platform };
    assert.deepStrictEqual(resolvePackagedServer(options), { command: server, args: [], source: 'bundled-server' });
    const environment = packagedToolchainEnvironment(options);
    assert.deepStrictEqual(environment, {
      MY_SCHOLAR_ODL_JAR: jar,
      MY_SCHOLAR_PANDOC: pandoc,
      MY_SCHOLAR_JAVA: java,
      MY_SCHOLAR_PDF_RENDERER_CLASSPATH: `${path.dirname(renderer)}${platform === 'win32' ? ';' : ':'}${jar}`,
      SSL_CERT_FILE: caBundle,
    });
    for (const file of [server, caBundle, jar, java, pandoc, renderer]) {
      const resolve = file === server ? () => resolvePackagedServer(options) : () => packagedToolchainEnvironment(options);
      const expected = file === server ? /缺少本地文献服务/u : file === caBundle ? /缺少 HTTPS 信任证书/u : /缺少 PDF 转换组件/u;
      fs.unlinkSync(file);
      assert.throws(resolve, expected, `${platform}: missing ${file} must fail`);
      fs.mkdirSync(file);
      assert.throws(resolve, expected, `${platform}: directory ${file} must fail`);
      fs.rmdirSync(file);
      fs.writeFileSync(file, '');
      assert.throws(resolve, expected, `${platform}: empty ${file} must fail`);
      fs.writeFileSync(file, 'runtime fixture');
    }
    const source = mainSource.slice(mainSource.indexOf('function backendExecutable('), mainSource.indexOf('\nfunction signalServer('));
    const context = vm.createContext({
      app: { isPackaged: true }, process: { env: {}, resourcesPath, platform }, path,
      pythonExecutable: () => assert.fail('A packaged build must never search for a host Python'),
      resolvePackagedServer, resolvePackagedToolchainEnvironment: packagedToolchainEnvironment,
    });
    vm.runInContext(source, context);
    assert.equal(vm.runInContext('backendExecutable("unused").command', context), server);
    assert.equal(vm.runInContext('packagedToolchainEnvironment().MY_SCHOLAR_JAVA', context), java);
    context.app.isPackaged = false;
    assert.equal(Object.keys(vm.runInContext('packagedToolchainEnvironment()', context)).length, 0);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

{
  const commands = [];
  const child = { exitCode: null, signalCode: null, pid: 4242, kill: () => assert.fail('taskkill must stop the entire Windows tree') };
  const source = mainSource.slice(mainSource.indexOf('function signalServer('), mainSource.indexOf('\nfunction waitForServerExit('));
  const signalServer = vm.runInNewContext(`${source}\nsignalServer`, {
    process: { platform: 'win32' },
    spawnSync: (command, args, options) => { commands.push({ command, args: Array.from(args), options }); return { status: 0 }; },
    diagnosticLog: () => assert.fail('Stopping a healthy child must not fail'),
  });
  signalServer(child, 'SIGTERM');
  signalServer(child, 'SIGKILL');
  assert.deepStrictEqual(commands.map(({ command, args }) => ({ command, args })), [
    { command: 'taskkill', args: ['/pid', '4242', '/T'] },
    { command: 'taskkill', args: ['/pid', '4242', '/T', '/F'] },
  ]);
  assert(commands.every(({ options }) => options.windowsHide && options.timeout === 8000));
  signalServer({ ...child, exitCode: 0 }, 'SIGKILL');
  assert.equal(commands.length, 2, 'Exited children must not be killed again');
}

console.log('python runtime tests passed');
