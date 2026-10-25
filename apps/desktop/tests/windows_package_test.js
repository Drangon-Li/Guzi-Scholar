'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const windowsRoot = path.resolve(appRoot, '../../platforms/windows');
const config = require(path.join(windowsRoot, 'electron-builder.win.json'));
const lock = require(path.join(windowsRoot, 'runtime-dependencies.json'));
const { builderArguments } = require(path.join(windowsRoot, 'build-windows.cjs'));
const activeApps = new Set();

function requireHostedInstallerEnvironment(environment = process.env) {
  assert.strictEqual(environment.GITHUB_ACTIONS, 'true', 'Installer smoke requires a temporary GitHub-hosted runner');
  assert.strictEqual(environment.RUNNER_ENVIRONMENT, 'github-hosted', 'Installer smoke must not modify a local or self-hosted installation');
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, ...options });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, `${command} failed:\n${result.stdout || ''}\n${result.stderr || ''}`);
  return result;
}

function requirePE(filename) {
  const data = fs.readFileSync(filename);
  assert.strictEqual(data.subarray(0, 2).toString('ascii'), 'MZ', `${filename}: Windows PE executable required`);
  assert.ok(data.length >= 64, `${filename}: truncated PE DOS header`);
  const offset = data.readUInt32LE(0x3c);
  assert.ok(offset >= 64 && offset + 6 <= data.length, `${filename}: invalid PE header offset`);
  assert.strictEqual(data.subarray(offset, offset + 4).toString('hex'), '50450000', `${filename}: invalid PE signature`);
  return data.readUInt16LE(offset + 4);
}

function requireX64PE(filename) {
  assert.strictEqual(requirePE(filename), 0x8664, `${filename}: Windows x64 executable required`);
}

function sanitizedEnvironment(temporary, environment = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/^(?:PATH|PYTHON.*|JAVA_HOME|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|APPDATA|LOCALAPPDATA)$/iu.test(key)
      || /^MY_SCHOLAR_/iu.test(key)) continue;
    clean[key] = value;
  }
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
  assert.ok(systemRoot, 'Windows SystemRoot is required');
  return { ...clean, PATH: path.join(systemRoot, 'System32'),
    APPDATA: path.join(temporary, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(temporary, 'AppData', 'Local'),
    MY_SCHOLAR_DATA_DIR: path.join(temporary, '应用 状态'), MY_SCHOLAR_LIBRARY_DIR: path.join(temporary, '文献 库'),
    MY_SCHOLAR_PACKAGED: '1' };
}

function walk(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected link in Windows package: ${relative}`);
    return entry.isDirectory() ? walk(absolute, relative) : [{ relative, absolute }];
  });
}

function staticTests() {
  assert.strictEqual(config.appId, 'com.guzi.scholar');
  assert.strictEqual(config.asar, false);
  assert.strictEqual(config.directories.app, '.');
  assert.strictEqual(config.directories.output, '../../platforms/windows/dist');
  assert.strictEqual(config.electronVersion, require('../package.json').devDependencies.electron);
  assert.strictEqual(config.win.executableName, 'Guzi-Scholar');
  assert.deepStrictEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }]);
  assert.strictEqual(config.nsis.perMachine, false);
  assert.strictEqual(config.nsis.allowToChangeInstallationDirectory, true);
  assert.strictEqual(config.win.signAndEditExecutable, undefined, 'native executable resources must be edited normally');
  const resources = new Map(config.extraResources.map((entry) => [entry.to, entry.from]));
  for (const [to, from] of Object.entries({
    'python-server': 'my-scholar-server', java: 'java',
    'toolchain/opendataloader-pdf-cli-0.0.0.jar': 'opendataloader-pdf-cli-0.0.0.jar',
    'toolchain/pandoc': 'pandoc', 'toolchain/pdf-renderer': 'pdf-renderer',
  })) assert.strictEqual(resources.get(to), `build/windows-runtime/${from}`);
  assert.ok(config.files.includes('*.py'));
  assert.ok(config.files.includes('mcp/bridge.cjs'));
  assert.ok(config.files.includes('plugin_templates/**/*'));
  assert.ok(config.files.includes('!**/.env*'));
  assert.ok(config.files.includes('!developer.tokens.json'));
  assert.doesNotMatch(JSON.stringify(config), /mac-runtime|npx|mineru|safetensors/u);
  assert.ok(builderArguments('dir').includes('--dir'));
  assert.ok(!builderArguments('dist').includes('--dir'));
  assert.ok(builderArguments('dist').includes('--publish=never'));
  assert.ok(builderArguments('dist')[0].includes('node_modules'));
  assert.throws(() => builderArguments('arm64'), /Unknown/u);
  requireHostedInstallerEnvironment({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' });
  assert.throws(() => requireHostedInstallerEnvironment({}), /GitHub-hosted/u);
  assert.throws(() => requireHostedInstallerEnvironment({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }), /local or self-hosted/u);
  runChecked(process.execPath, [path.join(windowsRoot, 'build-windows.cjs'), 'check']);
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    const rejected = spawnSync(process.execPath, [path.join(windowsRoot, 'build-windows.cjs'), 'dir'], { encoding: 'utf8' });
    assert.strictEqual(rejected.status, 1);
    assert.match(rejected.stderr, /native Windows x64 host/u);
  }
  assert.strictEqual(lock.python, '3.11');
  assert.strictEqual(lock.java, '21');
  assert.ok(lock.pip.includes('PyMuPDF==1.28.2'));
  assert.ok(lock.pip.every((pin) => /^[\w-]+==[\d.]+$/u.test(pin)));
  assert.match(lock.pandoc.sha256, /^[a-f\d]{64}$/u);
  assert.strictEqual(lock.pandoc.version, '3.10.2');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-pe-test-'));
  try {
    const executable = path.join(temporary, 'runtime.exe');
    const data = Buffer.alloc(134);
    data.write('MZ'); data.writeUInt32LE(128, 0x3c); data.write('PE\0\0', 128); data.writeUInt16LE(0x8664, 132);
    fs.writeFileSync(executable, data);
    requireX64PE(executable);
    data.writeUInt16LE(0xaa64, 132); fs.writeFileSync(executable, data);
    assert.throws(() => requireX64PE(executable), /Windows x64/u);
    fs.writeFileSync(executable, Buffer.from('Mach-O foreign executable'));
    assert.throws(() => requireX64PE(executable), /Windows PE/u);
    assert.throws(() => requireX64PE(path.join(temporary, 'missing.exe')), /ENOENT/u);
    const clean = sanitizedEnvironment(temporary, { SystemRoot: 'C:\\Windows', Path: 'C:\\Python;C:\\Java',
      PYTHONHOME: '/foreign', JAVA_HOME: '/foreign', NODE_OPTIONS: '--inspect', MY_SCHOLAR_PANDOC: '/foreign', KEEP: 'yes' });
    assert.strictEqual(clean.KEEP, 'yes');
    assert.strictEqual(clean.PYTHONHOME, undefined);
    assert.strictEqual(clean.JAVA_HOME, undefined);
    assert.strictEqual(clean.MY_SCHOLAR_PANDOC, undefined);
    assert.strictEqual(clean.Path, undefined);
    assert.strictEqual(clean.PATH, path.join('C:\\Windows', 'System32'));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function minimalPdf() {
  const stream = 'BT /F1 12 Tf 20 100 Td 1 0 0 rg (Guzi Scholar red) Tj 0 0 1 rg ( blue) Tj 0 0 0 rg ( runtime smoke) Tj /F2 12 Tf ( bold) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(`${output}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'ascii');
}

function verifyLayout(packageRoot) {
  const resources = path.join(packageRoot, 'resources');
  const paths = { executable: path.join(packageRoot, 'Guzi-Scholar.exe'),
    server: path.join(resources, 'python-server/my-scholar-server.exe'),
    ca: path.join(resources, 'python-server/ca-certificates.crt'),
    java: path.join(resources, 'java/bin/java.exe'), pandoc: path.join(resources, 'toolchain/pandoc/pandoc.exe'),
    jar: path.join(resources, 'toolchain/opendataloader-pdf-cli-0.0.0.jar'),
    renderer: path.join(resources, 'toolchain/pdf-renderer') };
  for (const executable of [paths.executable, paths.server, paths.java, paths.pandoc]) requireX64PE(executable);
  assert.ok(fs.statSync(paths.ca).size > 10000, 'frozen service must ship its CA bundle');
  assert.ok(fs.readFileSync(paths.ca, 'utf8').includes('BEGIN CERTIFICATE'));
  assert.ok(fs.statSync(path.join(paths.renderer, 'MyScholarPdfRenderer.class')).size > 0);
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(paths.jar)).digest('hex'), lock.opendataloader.jarSha256);
  for (const relative of ['server.py', 'component_manager.py', 'parsing_providers.py', 'electron/main.cjs',
    'electron/packaged-runtime.cjs', 'web/index.html', 'mcp/bridge.cjs', 'mcp/bridge.cjs.LEGAL.txt', 'plugin_templates/starter/index.html']) {
    assert.ok(fs.statSync(path.join(resources, 'app', relative)).isFile(), `Missing packaged ${relative}`);
  }
  for (const relative of ['licenses/Guzi-Scholar-LICENSE', 'licenses/Guzi-Scholar-NOTICE.md',
    'licenses/opendataloader-pdf/LICENSE', 'licenses/opendataloader-pdf/NOTICE', 'licenses/pandoc/COPYING.md',
    'licenses/runtime/python/LICENSE.txt']) assert.ok(fs.statSync(path.join(resources, relative)).isFile(), `Missing ${relative}`);
  const pdfLicenses = path.join(appRoot, 'resources/licenses/pdf-runtime');
  for (const name of fs.readdirSync(pdfLicenses)) {
    assert.deepStrictEqual(fs.readFileSync(path.join(resources, 'python-server/_internal/licenses/pdf-runtime', name)),
      fs.readFileSync(path.join(pdfLicenses, name)), `Packaged PDF license differs: ${name}`);
  }
  const files = walk(packageRoot);
  const forbidden = files.filter(({ relative }) => /(?:^|\/)(?:developer\.tokens\.json|config\.local\.json|\.env[^/]*|models?|mineru)(?:\/|$)|\.(?:safetensors|onnx|ckpt|pth|key)$/iu.test(relative));
  assert.deepStrictEqual(forbidden, [], 'Package must not contain secrets, managed model runtimes, or model weights');
  assert.strictEqual(fs.existsSync(path.join(resources, 'app/data')), false);
  assert.strictEqual(fs.existsSync(path.join(resources, 'components')), false);
  const bytes = files.reduce((sum, { absolute }) => sum + fs.statSync(absolute).size, 0);
  assert.ok(bytes <= 768 * 1024 * 1024, `Package exceeds 768 MiB budget: ${bytes} bytes`);
  return paths;
}

function verifyTools(paths, temporary) {
  fs.mkdirSync(temporary, { recursive: true });
  const env = { ...sanitizedEnvironment(temporary), SSL_CERT_FILE: paths.ca };
  const smoke = runChecked(paths.server, ['--dependency-smoke'], { env });
  const status = JSON.parse(smoke.stdout.trim().split(/\r?\n/u).at(-1));
  assert.strictEqual(status.ok, true);
  assert.match(status.python, /^3\.11\./u);
  assert.match(status.arch, /^(?:amd64|x86_64)$/iu);
  assert.strictEqual(status.hashlib_scrypt, true);
  assert.strictEqual(status.pdf_glyph_extraction, true);
  assert.deepStrictEqual(status.providers.map((provider) => provider.id), ['local-mineru', 'remote-guzi']);
  const modules = runChecked(paths.java, ['--list-modules'], { env }).stdout;
  for (const name of ['java.base', 'java.compiler', 'java.desktop', 'java.management', 'java.sql']) {
    assert.match(modules, new RegExp(`^${name}@21(?:\\.|$)`, 'mu'));
  }
  assert.match(runChecked(paths.pandoc, ['--version'], { env }).stdout, /^pandoc 3\.10\.2\r?\n/u);
  const math = runChecked(paths.pandoc, ['--from=markdown+tex_math_dollars', '--to=html5', '--mathml'],
    { env, input: '$$\\pmb{H}_l^{\\prime}=\\mathrm{MSA}\\tag{1}$$\n' });
  assert.match(math.stdout, /<math\b/u);
  const pdf = path.join(temporary, '论文 源文档.pdf');
  fs.writeFileSync(pdf, minimalPdf());
  const odlOutput = path.join(temporary, '转换 输出');
  const javaArgs = ['--add-opens=java.base/java.nio=ALL-UNNAMED', '-Djava.awt.headless=true'];
  runChecked(paths.java, [...javaArgs, '-jar', paths.jar, '-q', '-f', 'json,html', '--image-output', 'external', '-o', odlOutput, pdf], { env });
  for (const extension of ['json', 'html']) assert.ok(fs.statSync(path.join(odlOutput, `论文 源文档.${extension}`)).size > 0);
  const pages = path.join(temporary, '页面 渲染'); fs.mkdirSync(pages);
  const rendererArgs = [...javaArgs, '-cp', `${paths.renderer};${paths.jar}`, 'MyScholarPdfRenderer'];
  runChecked(paths.java, [...rendererArgs, pdf, pages, '72', '1'], { env });
  const png = fs.readFileSync(path.join(pages, 'page-001.png'));
  assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [200, 200]);
  const evidence = path.join(temporary, '文字 证据.json');
  runChecked(paths.java, [...rendererArgs, '--evidence', pdf, evidence], { env });
  const spans = JSON.parse(fs.readFileSync(evidence, 'utf8')).flatMap((page) => page.spans || []);
  assert.ok(spans.some((span) => span.color === 0xFF0000));
  assert.ok(spans.some((span) => span.color === 0x0000FF));
  assert.ok(spans.some((span) => span.bold === true && /bold/u.test(span.text || '')));
  assert.ok(spans.some((span) => span.color !== 0 && span.chars?.length > 0));
  runChecked(process.execPath, [path.join(__dirname, 'mcp_bridge_test.js'), paths.executable,
    path.join(path.dirname(paths.executable), 'resources/app/mcp/bridge.cjs')], { env });
}

function powershell(script, options = {}) {
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return runChecked(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64')], options);
}

function descendants(pid) {
  const processes = JSON.parse(powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress').stdout);
  const owned = new Set([pid]);
  let size;
  do {
    size = owned.size;
    for (const item of processes) if (owned.has(item.ParentProcessId)) owned.add(item.ProcessId);
  } while (size !== owned.size);
  return [...owned];
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function within(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function closeApp(session) {
  if (session.closePromise) return session.closePromise;
  session.closePromise = (async () => {
    let owned = [session.child.pid];
    const failures = [];
    try { if (session.child.exitCode === null) owned = descendants(session.child.pid); }
    catch (error) { failures.push(error); }
    try {
      await within(session.app.close(), 15000, 'Electron close timed out');
      const deadline = Date.now() + 3000;
      while (owned.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      const leaked = owned.filter(alive);
      assert.deepStrictEqual(leaked, [], `Electron graceful close left owned processes: ${leaked.join(', ')}`);
    } catch (error) { failures.push(error); }
    finally {
      const taskkill = path.join(process.env.SystemRoot, 'System32/taskkill.exe');
      for (const pid of owned.reverse()) {
        try {
          if (!alive(pid)) continue;
          const killed = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
          if (alive(pid)) failures.push(new Error(`Owned process leaked: ${pid}: ${killed.stderr || killed.error || ''}`));
        } catch (error) { failures.push(error); }
      }
      activeApps.delete(session);
    }
    if (failures.length) throw new AggregateError(failures, 'Windows application exit or process cleanup failed');
  })();
  return session.closePromise;
}

async function verifyElectron(paths, temporary) {
  const modulePath = process.env.MY_SCHOLAR_PLAYWRIGHT_MODULE || 'playwright';
  const { _electron: electron } = require(modulePath);
  const userData = path.join(temporary, '用户 数据');
  const env = sanitizedEnvironment(temporary);
  for (const directory of [userData, env.APPDATA, env.LOCALAPPDATA, env.MY_SCHOLAR_DATA_DIR, env.MY_SCHOLAR_LIBRARY_DIR]) fs.mkdirSync(directory, { recursive: true });
  const app = await electron.launch({ executablePath: paths.executable, args: [`--user-data-dir=${userData}`], env, timeout: 60000 });
  const session = { app, child: app.process(), closePromise: null };
  activeApps.add(session);
  console.log(`Windows packaged Electron smoke pid=${session.child.pid} userData=${userData}`);
  try {
    const runtime = await app.evaluate(({ app: electronApp }) => ({
      packaged: electronApp.isPackaged, arch: process.arch, platform: process.platform,
      userData: electronApp.getPath('userData'), resources: process.resourcesPath,
    }));
    assert.strictEqual(runtime.packaged, true);
    assert.strictEqual(runtime.arch, 'x64');
    assert.strictEqual(runtime.platform, 'win32');
    assert.strictEqual(path.resolve(runtime.userData), path.resolve(userData));
    assert.strictEqual(path.resolve(runtime.resources), path.join(path.dirname(paths.executable), 'resources'));
    const page = await app.firstWindow({ timeout: 60000 });
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/u, { timeout: 60000 });
    const health = await page.evaluate(async () => {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
      return response.json();
    });
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.service, 'my-scholar');
    const imported = await within(page.evaluate(async (encodedPdf) => {
      const request = async (url, options = {}) => {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}: ${await response.text()}`);
        return response.json();
      };
      const math = await request('/api/mathml', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formulas: [{ tex: '\\frac{x}{2}=y', display: true }] }) });
      if (!math.results?.[0]?.includes('<math')) throw new Error('Frozen service failed to run bundled Pandoc');
      await request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: { auto_retrieve: false, online_lookup: false } }) });
      const pdf = Uint8Array.from(atob(encodedPdf), (character) => character.charCodeAt(0));
      const form = new FormData();
      form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'Windows 原生 PDF 测试.pdf');
      const created = await request('/api/jobs', { method: 'POST', body: form });
      const id = created.job?.job_id;
      if (!id) throw new Error(`PDF upload did not return a job: ${JSON.stringify(created)}`);
      const deadline = Date.now() + 120000;
      let job;
      do {
        job = await request(`/api/jobs/${id}`);
        if (job.status === 'failed') throw new Error(`Frozen service PDF conversion failed: ${JSON.stringify(job)}`);
        if (job.status === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      if (job.status !== 'completed') throw new Error(`PDF import timed out: ${JSON.stringify(job)}`);
      const document = await fetch(job.links.html, { signal: AbortSignal.timeout(15000) });
      if (!document.ok || !(await document.text()).includes('Guzi Scholar')) throw new Error('Imported PDF document is missing fixture text');
      return { jobId: id, status: job.status, engine: job.engine, sourceFilename: job.source_filename };
    }, minimalPdf().toString('base64')), 180000, 'Packaged Electron PDF and MathML import smoke timed out');
    assert.strictEqual(imported.status, 'completed');
    assert.strictEqual(imported.sourceFilename, 'Windows 原生 PDF 测试.pdf');
    const jobDirectory = path.join(env.MY_SCHOLAR_LIBRARY_DIR, 'jobs', imported.jobId);
    assert.ok(fs.statSync(path.join(jobDirectory, 'source.pdf')).size > 0, 'Imported source PDF must be written under the selected Unicode library');
    assert.ok(fs.statSync(path.join(jobDirectory, 'document.html')).size > 0, 'Converted document must be written under the selected Unicode library');
    console.log(`Frozen service PDF import passed: ${imported.jobId}`);
    assert.ok(descendants(session.child.pid).length > 1, 'Electron must launch its bundled service process');
  } finally { await closeApp(session); }
}

async function verifyArtifacts(packageRoot, temporary) {
  requireHostedInstallerEnvironment();
  const directory = path.dirname(packageRoot);
  const version = require('../package.json').version;
  const installer = path.join(directory, `Guzi-Scholar-${version}-windows-x64-setup.exe`);
  const zip = path.join(directory, `Guzi-Scholar-${version}-windows-x64.zip`);
  assert.ok([0x014c, 0x8664].includes(requirePE(installer)), 'NSIS installer must be a Windows PE executable');
  assert.ok(fs.statSync(zip).size > 0, 'ZIP artifact is missing');
  const extracted = path.join(temporary, 'ZIP 解压 测试');
  const quote = (value) => `'${value.replace(/'/gu, "''")}'`;
  powershell(`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(extracted)}`);
  const zipped = verifyLayout(extracted);
  verifyTools(zipped, path.join(temporary, 'ZIP 中文工具 验证'));
  await verifyElectron(zipped, path.join(temporary, 'ZIP 用户 验证'));
  const installed = path.join(temporary, '安装 路径 测试');
  const installState = path.join(temporary, '安装 用户 验证');
  let uninstall;
  let uninstalled = false;
  try {
    runChecked(installer, ['/S', `/D=${installed}`], { windowsVerbatimArguments: true, timeout: 180000 });
    const installedPaths = verifyLayout(installed);
    uninstall = fs.readdirSync(installed).find((file) => /^Uninstall.*\.exe$/iu.test(file));
    assert.ok(uninstall, 'NSIS uninstaller is missing');
    verifyTools(installedPaths, path.join(temporary, '安装 中文工具 验证'));
    await verifyElectron(installedPaths, installState);
    const marker = path.join(sanitizedEnvironment(installState).MY_SCHOLAR_LIBRARY_DIR, '保留 用户文献.txt');
    fs.writeFileSync(marker, 'User library must survive uninstall.\n');
    runChecked(path.join(installed, uninstall), ['/S', `_?=${installed}`], { windowsVerbatimArguments: true, timeout: 120000 });
    const deadline = Date.now() + 30000;
    while (fs.existsSync(path.join(installed, 'Guzi-Scholar.exe')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(!fs.existsSync(path.join(installed, 'Guzi-Scholar.exe')), 'NSIS uninstall did not remove the installed executable');
    uninstalled = true;
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'User library must survive uninstall.\n');
  } finally {
    if (!uninstall && fs.existsSync(installed)) uninstall = fs.readdirSync(installed).find((file) => /^Uninstall.*\.exe$/iu.test(file));
    const uninstaller = uninstall && path.join(installed, uninstall);
    if (!uninstalled && uninstaller && fs.existsSync(uninstaller)) runChecked(uninstaller, ['/S', `_?=${installed}`], { windowsVerbatimArguments: true, timeout: 120000 });
  }
}

async function main() {
  staticTests();
  const supplied = process.argv[2];
  if (supplied) {
    assert.strictEqual(process.platform, 'win32', 'Native packaged runtime verification requires Windows');
    assert.strictEqual(process.arch, 'x64');
    const packageRoot = path.resolve(supplied);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), '谷子 Windows 验证-'));
    try {
      const paths = verifyLayout(packageRoot);
      verifyTools(paths, temporary);
      await verifyElectron(paths, path.join(temporary, 'unpacked-user'));
      if (process.argv.includes('--artifacts')) await verifyArtifacts(packageRoot, temporary);
    } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
  }
  console.log(supplied ? 'Windows packaged runtime and application tests passed' : 'Windows package static and helper tests passed (native verification requires a package path)');
}

module.exports = { requireX64PE, sanitizedEnvironment, verifyLayout };
if (require.main === module) {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      Promise.allSettled([...activeApps].map(closeApp)).finally(() => process.exit(code));
    });
  }
  main().catch(async (error) => {
    console.error(error);
    await Promise.allSettled([...activeApps].map(closeApp));
    process.exitCode = 1;
  });
}
