'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const sessions = new Set();
let terminating = false;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

async function waitForExit(pid, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (alive(pid) && Date.now() < deadline) await sleep(30);
  return !alive(pid);
}

async function cleanup(session) {
  if (session.cleanupPromise) return session.cleanupPromise;
  session.cleanupPromise = (async () => {
    clearTimeout(session.timer);
    const runtimePath = path.join(session.userData, 'development-runtime.json');
    if (!session.info?.backendPid && fs.existsSync(runtimePath)) {
      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
      assert.equal(runtime.pid, session.browserProcess?.pid, 'Cleanup runtime must belong to this Electron process');
      assert.equal(runtime.stateDir, path.join(session.userData, 'state'));
      assert.equal(runtime.libraryDir, path.join(session.userData, 'library'));
      session.info = { ...session.info, mainPid: runtime.pid, backendPid: runtime.backendPid };
    }
    try {
      if (session.application && alive(session.browserProcess.pid)) {
        let quitTimer;
        try {
          await Promise.race([
            session.application.close(),
            new Promise((_, reject) => { quitTimer = setTimeout(() => reject(new Error('Electron normal quit exceeded 12 seconds')), 12000); }),
          ]);
        } finally { clearTimeout(quitTimer); }
      }
      if (session.browserProcess) assert(await waitForExit(session.browserProcess.pid), 'Electron main process must exit');
      if (session.info?.backendPid) assert(await waitForExit(session.info.backendPid), 'The owned Python backend must exit');
      session.normalQuit = true;
    } finally {
      // Cleanup targets only PIDs recorded from this isolated launch.
      for (const pid of [session.browserProcess?.pid, session.info?.backendPid].filter(Boolean)) {
        if (!alive(pid)) continue;
        process.kill(pid, 'SIGTERM');
        if (!await waitForExit(pid, 2000)) { process.kill(pid, 'SIGKILL'); await waitForExit(pid, 2000); }
      }
      sessions.delete(session);
      const diagnosticPath = path.join(session.userData, 'logs', 'my-scholar-electron.log');
      session.diagnosticsAvailable = fs.existsSync(diagnosticPath);
      session.diagnostics = session.diagnosticsAvailable ? fs.readFileSync(diagnosticPath, 'utf8') : null;
      fs.writeFileSync(path.join(session.tempRoot, 'process-cleanup.json'), JSON.stringify({ mainPid: session.browserProcess?.pid, backendPid: session.info?.backendPid, mainExited: !session.browserProcess || !alive(session.browserProcess.pid), backendExited: !session.info?.backendPid || !alive(session.info.backendPid), normalQuit: Boolean(session.normalQuit) }, null, 2));
    }
  })();
  return session.cleanupPromise;
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    if (terminating) return;
    terminating = true;
    process.exitCode = code;
    Promise.allSettled([...sessions].map(cleanup)).finally(() => process.exit(code));
  });
}

async function launchManagedElectron({ jobId, documentHTML, note, paragraphCount }) {
  if (process.platform !== 'darwin') throw new Error('This native acceptance mode targets macOS.');
  const configured = String(process.env.MY_SCHOLAR_PLAYWRIGHT_MODULE || '').trim();
  const { _electron } = require(configured || 'playwright');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-native-process-'));
  const userData = path.join(tempRoot, 'userdata');
  const stateDirectory = path.join(userData, 'state');
  const libraryDirectory = path.join(userData, 'library');
  const jobDirectory = path.join(libraryDirectory, 'jobs', jobId);
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.mkdirSync(jobDirectory, { recursive: true });
  const settingsPath = path.join(stateDirectory, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ ai: { chat: {}, translation: {} }, metadata: { auto_retrieve: false, online_lookup: false, contact_email: '' } }));
  const developerTokensPath = path.join(tempRoot, 'developer-tokens.json');
  fs.writeFileSync(developerTokensPath, '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(jobDirectory, 'document.html'), documentHTML);
  fs.writeFileSync(path.join(jobDirectory, 'document.json'), JSON.stringify({ job_id: jobId, source: { filename: 'Native Electron translation process fixture.pdf' }, pages: [{ page: 1, elements: Array.from({ length: paragraphCount }, (_, index) => ({ id: `process-${index}`, kind: 'paragraph', page: 1, text: 'Physical theories of the nineteenth century would predict new science.' })) }], counts: { pages: 1, images: paragraphCount, tables: 0 } }));
  fs.writeFileSync(path.join(jobDirectory, 'manifest.json'), JSON.stringify({ job_id: jobId, source: { filename: 'Native Electron translation process fixture.pdf', bytes: 0 }, engine: { name: 'Native acceptance fixture', mode: 'synthetic' }, created_at: '2026-10-27T00:00:00Z', pages: 1, counts: { pages: 1, images: paragraphCount, tables: 0 }, outputs: ['document.html', 'document.json'], notes: [] }));
  fs.writeFileSync(path.join(jobDirectory, 'annotations.json'), JSON.stringify([note]));
  const session = { tempRoot, userData, application: null, browserProcess: null, info: null, normalQuit: false };
  sessions.add(session);
  session.timer = setTimeout(() => {
    console.error('[guzi-native] native test exceeded 120 seconds');
    process.exitCode = 124;
    cleanup(session).finally(() => process.exit(124));
  }, 120000);
  session.timer.unref();
  try {
    const env = { ...process.env, MY_SCHOLAR_DEVELOPER_TOKENS_FILE: developerTokensPath, MY_SCHOLAR_SETTINGS_FILE: settingsPath };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.MY_SCHOLAR_SERVER_EXECUTABLE;
    const application = session.application = await _electron.launch({
      executablePath: path.join(desktopRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [desktopRoot, '--guzi-development', `--guzi-dev-root=${userData}`],
      cwd: desktopRoot, env, timeout: 45000,
    });
    session.browserProcess = application.process();
    const logPath = path.join(tempRoot, 'electron-output.log');
    for (const stream of [session.browserProcess.stdout, session.browserProcess.stderr]) stream?.on('data', (chunk) => fs.appendFileSync(logPath, chunk));
    const page = session.page = await application.firstWindow({ timeout: 45000 });
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/?$/u, { timeout: 45000 });
    await page.waitForFunction(() => Boolean(window.myScholarDesktop?.versions?.electron) && typeof window.__myScholarFlushBeforeClose === 'function');
    const info = await application.evaluate(({ app, BrowserWindow }) => ({ mainPid: process.pid, electron: process.versions.electron, chrome: process.versions.chrome, isPackaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'), logDirectory: app.getPath('logs'), windows: BrowserWindow.getAllWindows().map((window) => ({ id: window.id, visible: window.isVisible(), url: window.webContents.getURL() })) }));
    const runtime = JSON.parse(fs.readFileSync(path.join(userData, 'development-runtime.json'), 'utf8'));
    assert.equal(info.isPackaged, false);
    assert.equal(info.appPath, desktopRoot);
    assert.equal(info.userData, userData);
    assert.equal(info.mainPid, session.browserProcess.pid);
    assert.equal(runtime.stateDir, stateDirectory);
    assert.equal(runtime.libraryDir, libraryDirectory);
    assert(info.windows.some((window) => window.visible && window.url === runtime.url + '/'), 'The real headed BrowserWindow must be visible');
    assert(alive(runtime.backendPid), 'The real Python backend must be running');
    const bridge = await page.evaluate(() => ({ versions: window.myScholarDesktop.versions, platform: window.myScholarDesktop.platform }));
    assert.equal(bridge.versions.electron, info.electron);
    session.info = { ...info, backendPid: runtime.backendPid, baseURL: runtime.url, stateDirectory, libraryDirectory, bridge };
    const initialHealth = await page.evaluate(async () => { const response = await fetch('/api/health'); if (!response.ok) throw new Error(`Health failed: ${response.status}`); return response.json(); });
    assert.equal(initialHealth.ai.services.translation.enabled, false, 'Native startup must use the empty isolated AI profile');
    assert(Object.values(initialHealth.ai.services.translation.configured).every((value) => value === false));
    assert.equal(initialHealth.ai.services.chat.enabled, false);
    assert(Object.values(initialHealth.ai.services.chat.configured).every((value) => value === false));
    session.info = { ...info, backendPid: runtime.backendPid, baseURL: runtime.url, stateDirectory, libraryDirectory, bridge, initialAIConfigured: false };
    fs.writeFileSync(path.join(tempRoot, 'native-identity.json'), JSON.stringify(session.info, null, 2));
    console.error(`[guzi-native] pid=${info.mainPid} backendPid=${runtime.backendPid} electron=${info.electron} tempRoot=${tempRoot}`);
    session.configureTranslation = async () => {
      const health = await page.evaluate(async () => {
        const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai: { translation: { provider: 'openai-compatible', mode: 'chat', model: 'process-engine', base_url: 'http://127.0.0.1:9/v1', api_key: 'fixture-only-no-real-credential', source_language: 'auto', target_language: 'zh' }, chat: {} }, metadata: { auto_retrieve: false, online_lookup: false } }) });
        if (!response.ok) throw new Error(`Isolated fixture settings failed: ${response.status}`);
        const actualHealth = await fetch('/api/health');
        return actualHealth.json();
      });
      assert.equal(health.ai.services.translation.enabled, true);
      return health.ai.services.translation.profile_id;
    };
    session.closeNativeWindow = async () => {
      session.nativeFlushEvents = [];
      await page.exposeFunction('__recordNativeCloseFlush', (event) => session.nativeFlushEvents.push(event));
      await page.evaluate(() => {
        const flush = window.__myScholarFlushBeforeClose;
        window.__myScholarFlushBeforeClose = async (options) => {
          const start = performance.now();
          const result = await flush(options);
          await window.__recordNativeCloseFlush({ intent: options.intent, result, durationMs: performance.now() - start });
          return result;
        };
      });
      const closeEvent = page.waitForEvent('close', { timeout: 15000 });
      const start = Date.now();
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await closeEvent;
      session.nativeCloseMs = Date.now() - start;
      assert.equal(session.nativeFlushEvents.length, 1, 'Native close must invoke the real renderer save gate once');
      assert.equal(session.nativeFlushEvents[0].intent, 'close');
      assert.equal(session.nativeFlushEvents[0].result, true);
      assert(await waitForExit(runtime.backendPid, 10000), 'Native window close must stop its Python backend');
      return { nativeCloseMs: session.nativeCloseMs, nativeFlushEvents: session.nativeFlushEvents };
    };
    session.close = () => cleanup(session);
    return session;
  } catch (error) {
    try { await cleanup(session); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Electron launch and cleanup failed'); }
    throw error;
  }
}

module.exports = { launchManagedElectron };
