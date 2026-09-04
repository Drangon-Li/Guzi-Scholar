const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  adoptLegacyLibraryIfSafe,
  copyLibraryToEmptyTarget,
  desktopStorageLayout,
  inspectLibraryDirectory,
  migrateLegacyDesktopState,
  resolveLibraryLocation,
  restorePointer,
  snapshotPointer,
  validateMigrationTarget,
  writeLibraryPointer,
} = require('./library-storage.cjs');
const { resolvePythonRuntime } = require('./python-runtime.cjs');
const { RendererStateStore } = require('./renderer-state.cjs');
const { hasTrustedOrigin } = require('./url-security.cjs');
const { checkForUpdate } = require('./update-service.cjs');
const { consumeInstallationMarker, requestMacInstallation } = require('./macos-installation.cjs');

const PRODUCT_NAME = '谷子学术';
const UPDATE_CHANNEL = 'internal';
const UPDATE_MANIFEST_URL = process.env.MY_SCHOLAR_UPDATE_MANIFEST_URL || 'https://raw.githubusercontent.com/Drangon-Li/Guzi-Scholar/main/release-manifests/macos-arm64.json';
const UPDATE_ALLOWED_ORIGINS = Object.freeze(['https://raw.githubusercontent.com', 'https://github.com']);
const defaultUserDataPath = app.getPath('userData');
app.setName(PRODUCT_NAME);
if (!app.isPackaged) app.setPath('userData', `${defaultUserDataPath}-development`);

let mainWindow = null;
let pythonServer = null;
let serverURL = null;
let serverStartupPromise = null;
let serverStopPromise = null;
let windowStartupPromise = null;
let shuttingDown = false;
let allowQuit = false;
let unresponsiveNoticeShown = false;
let libraryMigrationPromise = null;
let rendererStateStore = null;
let rendererCrashShutdownPromise = null;
let startupStorageReport = { state: 'pending', adopted: false, current: null, legacy: [] };
let availableUpdate = null;
const migrationControlToken = crypto.randomBytes(32).toString('hex');
const apiAccessToken = crypto.randomBytes(32).toString('hex');

function requireMainWindowSender(event) {
  const mainFrame = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.mainFrame : null;
  if (!mainFrame || event.sender !== mainWindow.webContents || event.senderFrame !== mainFrame || !hasTrustedOrigin(event.senderFrame?.url, serverURL)) {
    throw new Error('无权访问桌面功能。');
  }
}

ipcMain.handle('my-scholar:copy-image', (event, dataURL) => {
  requireMainWindowSender(event);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataURL || ''));
  if (!match) throw new Error('复制图片仅接受 PNG 数据。');
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > 16 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('图片数据无效或过大。');
  }
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('无法读取这张图片。');
  clipboard.writeImage(image);
  return { ok: true };
});

function resolveJobSourcePdf(jobId) {
  const safeId = String(jobId || '');
  if (!/^[a-f0-9]{12,40}$/.test(safeId)) throw new Error('文献标识无效。');
  const jobDir = path.join(storageConfiguration().currentPath, 'jobs', safeId);
  for (const name of ['source.pdf', 'upload.pdf']) {
    const candidate = path.join(jobDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('找不到该文献的原始 PDF 文件。');
}

ipcMain.handle('my-scholar:open-source-pdf', async (event, jobId) => {
  requireMainWindowSender(event);
  if (libraryMigrationPromise) throw new Error('文献库正在迁移，请等待当前操作完成。');
  const failure = await shell.openPath(resolveJobSourcePdf(jobId));
  if (failure) throw new Error(`无法打开原始文件：${failure}`);
  return { ok: true };
});

ipcMain.handle('my-scholar:show-item-in-folder', (event, jobId) => {
  requireMainWindowSender(event);
  if (libraryMigrationPromise) throw new Error('文献库正在迁移，请等待当前操作完成。');
  shell.showItemInFolder(resolveJobSourcePdf(jobId));
  return { ok: true };
});

ipcMain.handle('my-scholar:get-library-location', (event) => {
  requireMainWindowSender(event);
  return { ok: true, ...publicLibraryLocation(), migrating: Boolean(libraryMigrationPromise) };
});

ipcMain.handle('my-scholar:choose-library-location', (event) => {
  requireMainWindowSender(event);
  if (libraryMigrationPromise) throw new Error('文献库正在迁移，请等待当前操作完成。');
  libraryMigrationPromise = chooseAndMigrateLibrary().finally(() => { libraryMigrationPromise = null; });
  return libraryMigrationPromise;
});

ipcMain.handle('my-scholar:choose-mineru-component', async (event) => {
  requireMainWindowSender(event);
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: '选择已有版面引擎目录',
    buttonLabel: '选择并复用',
    properties: ['openDirectory'],
    message: '请选择包含 bin/mineru 或 mineru 可执行文件的 Python 环境目录。谷子学术只会校验并保存路径，不会复制或删除原环境。',
  });
  if (selection.canceled || !selection.filePaths.length) return { ok: true, cancelled: true };
  return { ok: true, cancelled: false, path: selection.filePaths[0] };
});

ipcMain.handle('my-scholar:get-startup-context', (event) => {
  requireMainWindowSender(event);
  return {
    ok: true,
    app: {
      name: PRODUCT_NAME,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      channel: UPDATE_CHANNEL,
    },
    storage: startupStorageReport,
  };
});

ipcMain.handle('my-scholar:check-for-updates', async (event) => {
  requireMainWindowSender(event);
  try {
    const result = await checkForUpdate({
      manifestURL: UPDATE_MANIFEST_URL,
      currentVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      channel: UPDATE_CHANNEL,
      allowedOrigins: UPDATE_ALLOWED_ORIGINS,
    });
    availableUpdate = result.status === 'available' ? result : null;
    diagnosticLog('update-check', `status=${result.status} current=${result.currentVersion} latest=${result.version}`);
    return { ok: true, ...result };
  } catch (error) {
    availableUpdate = null;
    diagnosticLog('update-check-error', error.message || String(error));
    return { ok: false, error: error.message || '暂时无法检查更新，请稍后重试。' };
  }
});

ipcMain.handle('my-scholar:open-update-download', async (event) => {
  requireMainWindowSender(event);
  if (!availableUpdate?.downloadURL) return { ok: false, error: '请先检查更新。' };
  await shell.openExternal(availableUpdate.downloadURL, { activate: true });
  return { ok: true };
});

ipcMain.handle('my-scholar:select-startup-library', (event, selectedPath) => {
  requireMainWindowSender(event);
  if (libraryMigrationPromise) throw new Error('文献库正在切换，请等待当前操作完成。');
  libraryMigrationPromise = selectStartupLibrary(selectedPath).finally(() => { libraryMigrationPromise = null; });
  return libraryMigrationPromise;
});

function desktopRendererState() {
  if (!rendererStateStore) rendererStateStore = new RendererStateStore(path.join(storageConfiguration().stateDir, 'renderer-state'));
  return rendererStateStore;
}

async function handleRendererStateIPC(event, operation) {
  try {
    requireMainWindowSender(event);
    return { ok: true, value: await operation(desktopRendererState()) };
  } catch (error) {
    diagnosticLog('renderer-state-error', error.message || String(error));
    return { ok: false, error: error.message || '无法保存界面状态。' };
  }
}

ipcMain.handle('my-scholar:state-load', (event) => handleRendererStateIPC(event, (store) => store.loadAll()));
ipcMain.handle('my-scholar:state-set', (event, key, value) => handleRendererStateIPC(event, async (store) => {
  await store.set(key, value);
  return true;
}));
ipcMain.handle('my-scholar:state-remove', (event, key) => handleRendererStateIPC(event, async (store) => {
  await store.remove(key);
  return true;
}));

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function storageConfiguration() {
  const projectRoot = path.resolve(__dirname, '..');
  const layout = desktopStorageLayout({
    projectRoot,
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged,
    env: process.env,
  });
  const location = resolveLibraryLocation({ defaultLibraryDir: layout.defaultLibraryDir, pointerPath: layout.pointerPath, env: process.env });
  return { ...layout, ...location };
}

async function prepareDesktopStorage() {
  let storage = storageConfiguration();
  const migrated = await migrateLegacyDesktopState(storage);
  if (migrated.pointerMigrated || migrated.copied.length) {
    diagnosticLog('migrate-desktop-state', `pointer=${migrated.pointerMigrated} files=${migrated.copied.join(',')}`);
  }
  storage = storageConfiguration();
  startupStorageReport = await adoptLegacyLibraryIfSafe({
    currentPath: storage.currentPath,
    currentSource: storage.source,
    pointerPath: storage.pointerPath,
    legacyLibraryDirs: storage.legacyLibraryDirs,
  });
  if (startupStorageReport.adopted) {
    diagnosticLog('adopt-legacy-library', `items=${startupStorageReport.selected.itemCount} jobs=${startupStorageReport.selected.jobCount}`);
  } else if (['conflict', 'invalid'].includes(startupStorageReport.state)) {
    diagnosticLog('legacy-library-needs-attention', `state=${startupStorageReport.state}`);
  }
}

function publicLibraryLocation() {
  const location = storageConfiguration();
  return {
    currentPath: location.currentPath,
    source: location.source,
    readOnly: location.readOnly,
    canChange: location.canChange,
  };
}

function reportLibraryMigration(progress) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('my-scholar:library-migration-progress', progress);
}

function backendRequestJSON(route, { method = 'GET', timeout = 10000, headers = {} } = {}) {
  if (!serverURL) return Promise.reject(new Error('本地服务尚未启动。'));
  const target = new URL(route, serverURL);
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method,
      headers: { Accept: 'application/json', ...headers, 'X-My-Scholar-Api-Token': apiAccessToken },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          request.destroy(new Error('本地服务返回的数据过大。'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`本地服务请求失败（HTTP ${response.statusCode || 500}）。`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (_) {
          reject(new Error('本地服务返回了无效数据。'));
        }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('本地服务响应超时。')));
    request.once('error', reject);
    request.end();
  });
}

function backendJSON(route, timeout = 10000) {
  return backendRequestJSON(route, { timeout });
}

function backendMigrationControl(action, timeout = 35000) {
  return backendRequestJSON(`/api/migration/${action}`, {
    method: 'POST',
    timeout,
    headers: {
      'Content-Length': '0',
      'X-My-Scholar-Migration-Token': migrationControlToken,
    },
  });
}

function scheduleWindowReload(url) {
  setTimeout(() => {
    if (shuttingDown || !mainWindow || mainWindow.isDestroyed()) return;
    const settingsURL = new URL('/#settings-metadata', url).toString();
    mainWindow.loadURL(settingsURL).catch((error) => diagnosticLog('reload-after-library-migration-error', error.message || String(error)));
  }, 250);
}

function snapshotCounts(jobsPayload, libraryPayload) {
  return {
    jobs: Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs.length : -1,
    items: libraryPayload?.library?.items && typeof libraryPayload.library.items === 'object'
      ? Object.keys(libraryPayload.library.items).length
      : -1,
  };
}

async function verifyMigratedServer(expectedPath, baseline) {
  const [health, jobs, library] = await Promise.all([
    backendJSON('/api/health'),
    backendJSON('/api/jobs'),
    backendJSON('/api/library'),
  ]);
  const expectedId = crypto.createHash('sha256').update(expectedPath).digest('hex');
  if (!health?.ok || health?.storage?.library_id !== expectedId) throw new Error('新文献库服务未能从目标路径启动。');
  const current = snapshotCounts(jobs, library);
  if (current.jobs !== baseline.jobs || current.items !== baseline.items) {
    throw new Error('切换后的文献数量与原文献库不一致。');
  }
}

async function selectStartupLibrary(selectedPath) {
  const requested = path.resolve(String(selectedPath || ''));
  const candidates = [startupStorageReport.current, ...(startupStorageReport.legacy || [])]
    .filter((candidate) => candidate?.valid && typeof candidate.path === 'string');
  const candidate = candidates.find((entry) => entry.path === requested);
  if (!candidate) throw new Error('只能选择本次启动时识别到的文献库。');
  const selected = await inspectLibraryDirectory(candidate.path);
  if (!selected.valid) throw new Error(selected.error || '所选文献库当前不可用。');

  const initial = storageConfiguration();
  if (!initial.canChange) throw new Error('文献库路径由 MY_SCHOLAR_LIBRARY_DIR 指定，请修改启动环境后重试。');
  if (path.resolve(initial.currentPath) === selected.path) {
    await writeLibraryPointer(initial.pointerPath, selected.path);
    startupStorageReport = { ...startupStorageReport, state: 'kept-current', selectedPath: selected.path, selected };
    return { ok: true, reloading: false, currentPath: selected.path, items: selected.itemCount, jobs: selected.jobCount };
  }

  const pointerBefore = await snapshotPointer(initial.pointerPath);
  let serverWasStopped = false;
  let pointerWasCommitted = false;
  let requestsQuiesced = false;
  let prepareAttempted = false;
  try {
    reportLibraryMigration({ phase: 'prepare', message: '正在等待当前保存操作完成…' });
    await flushRendererState();
    prepareAttempted = true;
    const preparation = await backendMigrationControl('prepare');
    const readiness = preparation?.migration;
    if (!readiness?.ready) throw new Error(readiness?.reason || '当前仍有文献正在导入或整理，请稍后再切换。');
    requestsQuiesced = true;
    reportLibraryMigration({ phase: 'stop', message: '正在切换到所选文献库…' });
    await stopServer();
    serverWasStopped = true;
    requestsQuiesced = false;
    prepareAttempted = false;
    await writeLibraryPointer(initial.pointerPath, selected.path);
    pointerWasCommitted = true;
    const selectedURL = await startServer();
    await verifyMigratedServer(selected.path, { jobs: selected.jobCount, items: selected.itemCount });
    startupStorageReport = { ...startupStorageReport, state: 'selected-legacy', selectedPath: selected.path, selected };
    reportLibraryMigration({ phase: 'done', message: `已切换到包含 ${selected.itemCount} 篇文献的旧版文献库。` });
    scheduleWindowReload(selectedURL);
    return { ok: true, reloading: true, currentPath: selected.path, items: selected.itemCount, jobs: selected.jobCount };
  } catch (error) {
    let rollbackError = null;
    if ((prepareAttempted || requestsQuiesced) && !serverWasStopped) {
      try {
        await backendMigrationControl('cancel', 5000);
      } catch (cancelFailure) {
        rollbackError = cancelFailure;
      }
    }
    if (serverWasStopped) {
      try {
        await stopServer();
        if (pointerWasCommitted) await restorePointer(initial.pointerPath, pointerBefore);
        const restoredURL = await startServer();
        scheduleWindowReload(restoredURL);
      } catch (rollbackFailure) {
        rollbackError = rollbackError || rollbackFailure;
      }
    }
    reportLibraryMigration({ phase: 'error', message: error.message || '文献库切换失败。' });
    if (rollbackError) throw new Error(`${error.message || '文献库切换失败。'} 原文献库自动恢复失败：${rollbackError.message || rollbackError}`);
    throw error;
  }
}

async function chooseAndMigrateLibrary() {
  const initial = storageConfiguration();
  if (!initial.canChange) throw new Error('文献库路径由 MY_SCHOLAR_LIBRARY_DIR 指定，请修改启动环境后重试。');
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: '选择空文件夹作为文献库',
    defaultPath: path.dirname(initial.currentPath),
    buttonLabel: '选择并复制文献',
    properties: ['openDirectory', 'createDirectory'],
    message: '请选择一个空文件夹。谷子学术会复制并校验现有文献，原目录不会删除。',
  });
  if (selection.canceled || !selection.filePaths.length) return { ok: true, cancelled: true, ...publicLibraryLocation() };
  const selectedPath = selection.filePaths[0];
  await validateMigrationTarget(initial.currentPath, selectedPath);

  const pointerBefore = await snapshotPointer(initial.pointerPath);
  let serverWasStopped = false;
  let pointerWasCommitted = false;
  let requestsQuiesced = false;
  let prepareAttempted = false;
  try {
    reportLibraryMigration({ phase: 'prepare', message: '正在等待当前保存操作完成…' });
    await flushRendererState();
    prepareAttempted = true;
    const preparation = await backendMigrationControl('prepare');
    const readiness = preparation?.migration;
    if (!readiness?.ready) {
      throw new Error(readiness?.reason || '当前仍有文献正在导入或整理，请等待任务完成后再修改存放位置。');
    }
    requestsQuiesced = true;
    const baseline = readiness.baseline;
    if (!baseline || baseline.jobs < 0 || baseline.items < 0) throw new Error('无法核对当前文献库内容。');
    reportLibraryMigration({ phase: 'stop', message: '正在暂停文献服务…' });
    await stopServer();
    serverWasStopped = true;
    requestsQuiesced = false;
    prepareAttempted = false;
    const copied = await copyLibraryToEmptyTarget({
      sourceDir: initial.currentPath,
      targetDir: selectedPath,
      onProgress: reportLibraryMigration,
    });
    reportLibraryMigration({ phase: 'switch', message: '正在切换文献库位置…' });
    await writeLibraryPointer(initial.pointerPath, copied.targetPath);
    pointerWasCommitted = true;
    const migratedURL = await startServer();
    await verifyMigratedServer(copied.targetPath, baseline);
    reportLibraryMigration({ phase: 'done', message: '文献库迁移完成。', files: copied.files, bytes: copied.bytes });
    scheduleWindowReload(migratedURL);
    return {
      ok: true,
      cancelled: false,
      currentPath: copied.targetPath,
      previousPath: copied.sourcePath,
      source: 'saved',
      readOnly: false,
      canChange: true,
      copied: { files: copied.files, bytes: copied.bytes },
    };
  } catch (error) {
    let rollbackError = null;
    if ((prepareAttempted || requestsQuiesced) && !serverWasStopped) {
      try {
        await backendMigrationControl('cancel', 5000);
      } catch (cancelFailure) {
        rollbackError = cancelFailure;
      }
    }
    if (serverWasStopped) {
      try {
        await stopServer();
        if (pointerWasCommitted) await restorePointer(initial.pointerPath, pointerBefore);
        const restoredURL = await startServer();
        scheduleWindowReload(restoredURL);
      } catch (rollbackFailure) {
        rollbackError = rollbackError || rollbackFailure;
      }
    }
    reportLibraryMigration({ phase: 'error', message: error.message || '文献库迁移失败。' });
    if (rollbackError) {
      throw new Error(`${error.message || '文献库迁移失败。'} 原文献库自动恢复失败：${rollbackError.message || rollbackError}`);
    }
    throw error;
  }
}

function diagnosticLog(event, details = '') {
  const line = `[${new Date().toISOString()}] ${event}${details ? ` ${details}` : ''}\n`;
  try {
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'my-scholar-electron.log'), line, 'utf8');
  } catch (_) {
    // Console output remains the fallback when the OS log directory is not writable.
  }
  console.error(line.trim());
}

let resolvedPython = null;
function pythonExecutable() {
  if (resolvedPython) return resolvedPython;
  resolvedPython = resolvePythonRuntime({
    env: process.env,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  return resolvedPython;
}

function backendExecutable(projectRoot) {
  const configured = String(process.env.MY_SCHOLAR_SERVER_EXECUTABLE || '').trim();
  if (configured) return { command: path.resolve(configured), args: [], source: 'MY_SCHOLAR_SERVER_EXECUTABLE' };
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'python-server', 'my-scholar-server');
    if (fs.existsSync(bundled)) return { command: bundled, args: [], source: 'bundled-server' };
    throw new Error('应用包缺少本地文献服务。请重新安装谷子学术。');
  }
  const python = pythonExecutable();
  return {
    command: python.command,
    args: [...python.args, path.join(projectRoot, 'server.py')],
    source: python.source,
  };
}

function packagedToolchainEnvironment() {
  if (!app.isPackaged) return {};
  const jar = path.join(process.resourcesPath, 'toolchain', 'opendataloader-pdf-cli-0.0.0.jar');
  const pandoc = path.join(process.resourcesPath, 'toolchain', 'pandoc', 'pandoc');
  const java = path.join(process.resourcesPath, 'java', 'bin', 'java');
  const renderer = path.join(process.resourcesPath, 'toolchain', 'pdf-renderer');
  const caBundle = path.join(process.resourcesPath, 'python-server', 'ca-certificates.crt');
  if (!fs.existsSync(jar) || !fs.existsSync(pandoc) || !fs.existsSync(java) || !fs.existsSync(renderer)) {
    throw new Error('应用包缺少 PDF 转换组件。请重新安装谷子学术。');
  }
  let caBundleReady = false;
  try {
    const stats = fs.statSync(caBundle);
    caBundleReady = stats.isFile() && stats.size > 0;
  } catch (_) {
    caBundleReady = false;
  }
  if (!caBundleReady) {
    throw new Error('应用包缺少 HTTPS 信任证书。请重新安装谷子学术。');
  }
  return {
    MY_SCHOLAR_ODL_JAR: jar,
    MY_SCHOLAR_PANDOC: pandoc,
    MY_SCHOLAR_JAVA: java,
    MY_SCHOLAR_PDF_RENDERER_CLASSPATH: `${renderer}${path.delimiter}${jar}`,
    SSL_CERT_FILE: caBundle,
  };
}

function signalServer(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') {
      if (!child.pid) return;
      // child.kill() leaves the interpreter's own children (converter
      // subprocesses) running; taskkill /T tears down the whole tree.
      const force = signal === 'SIGKILL' ? ['/F'] : [];
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', ...force], { windowsHide: true, timeout: 8000 });
      if (result.status !== 0 && signal !== 'SIGKILL') child.kill(signal);
      return;
    }
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') diagnosticLog('stop-local-service-error', error.message || String(error));
  }
}

function waitForServerExit(child, timeout) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeout);
    child.once('exit', onExit);
  });
}

function stopServer() {
  if (serverStopPromise) return serverStopPromise;
  const child = pythonServer;
  if (!child || child.exitCode !== null || child.signalCode) {
    if (pythonServer === child) pythonServer = null;
    serverURL = null;
    return Promise.resolve();
  }
  serverStopPromise = (async () => {
    diagnosticLog('stop-local-service', `pid=${child.pid}`);
    signalServer(child, 'SIGTERM');
    let stopped = await waitForServerExit(child, 5000);
    if (!stopped) {
      diagnosticLog('force-stop-local-service', `pid=${child.pid}`);
      signalServer(child, 'SIGKILL');
      stopped = await waitForServerExit(child, 1000);
    }
    if (!stopped && child.exitCode === null && !child.signalCode) {
      throw new Error(`本地文献服务进程 ${child.pid || ''} 无法停止。`);
    }
    if (pythonServer === child) {
      pythonServer = null;
      serverURL = null;
    }
  })().finally(() => { serverStopPromise = null; });
  return serverStopPromise;
}

function reportSafeQuitFailure(error) {
  if (rendererCrashShutdownPromise) {
    diagnosticLog('safe-quit-superseded-by-renderer-crash', error.message || String(error));
    return;
  }
  shuttingDown = false;
  diagnosticLog('safe-quit-error', error.message || String(error));
  dialog.showErrorBox('谷子学术暂时无法安全退出', '设置、笔记或本地文献服务尚未安全完成。请稍后重试；为避免丢失改动或留下文献库锁，谷子学术没有强制退出。');
}

async function flushRendererState(window = mainWindow, timeout = 5000) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  let timer;
  try {
    const result = await Promise.race([
      window.webContents.executeJavaScript('window.__myScholarFlushBeforeClose ? window.__myScholarFlushBeforeClose() : true', true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('等待设置与笔记保存超时。')), timeout); }),
    ]);
    if (result === false) throw new Error('设置或笔记尚未保存。');
  } finally {
    clearTimeout(timer);
  }
}

async function startServer() {
  if (serverStopPromise) await serverStopPromise;
  if (serverURL && pythonServer && pythonServer.exitCode === null && !pythonServer.signalCode) return serverURL;
  if (serverStartupPromise) return serverStartupPromise;
  serverStartupPromise = new Promise((resolve, reject) => {
    const storage = storageConfiguration();
    const projectRoot = storage.projectRoot;
    if (storage.source === 'saved') {
      try {
        const info = fs.lstatSync(storage.currentPath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a local directory');
      } catch (_) {
        reject(new Error('已保存的文献库位置不可用。请重新连接原磁盘或恢复该文件夹；如需改到其他位置，请在原路径恢复后启动，并前往“设置 > 文献管理”重新选择。谷子学术不会自动回退到默认目录，以免产生两份文献数据。'));
        return;
      }
    }
    const env = {
      ...process.env,
      ...packagedToolchainEnvironment(),
      MY_SCHOLAR_PROJECT_ROOT: projectRoot,
      MY_SCHOLAR_DATA_DIR: storage.stateDir,
      MY_SCHOLAR_LIBRARY_DIR: storage.currentPath,
      MY_SCHOLAR_COMPONENTS_DIR: path.join(app.getPath('userData'), 'components'),
      MY_SCHOLAR_PACKAGED: app.isPackaged ? '1' : '0',
      MY_SCHOLAR_MIGRATION_TOKEN: migrationControlToken,
      MY_SCHOLAR_API_TOKEN: apiAccessToken,
      MY_SCHOLAR_BACKEND: process.env.MY_SCHOLAR_BACKEND || 'auto',
      MY_SCHOLAR_READONLY: '',
    };
    const backend = backendExecutable(projectRoot);
    const child = spawn(
      backend.command,
      [...backend.args, '--host', '127.0.0.1', '--port', '0'],
      { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true },
    );
    pythonServer = child;
    let output = '';
    let ready = false;
    const appendOutput = (text) => { output = `${output}${text}`.slice(-8192); };
    const timer = setTimeout(() => {
      signalServer(child, 'SIGTERM');
      reject(new Error(`本地服务启动超时。\n${output.slice(-2000)}`));
    }, 30000);
    const onData = (chunk) => {
      const text = chunk.toString();
      if (!ready) appendOutput(text);
      const match = text.match(/My Scholar running at (http:\/\/127\.0\.0\.1:\d+)/u);
      if (match) {
        ready = true;
        clearTimeout(timer);
        serverURL = match[1];
        resolve(serverURL);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      appendOutput(text);
      diagnosticLog('python-stderr', text.trim().slice(-1000));
    });
    child.once('error', (error) => { diagnosticLog('python-process-error', error.stack || error.message); clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      diagnosticLog('python-process-exit', `code=${code}`);
      if (pythonServer === child) pythonServer = null;
      if (!ready) { clearTimeout(timer); reject(new Error(`本地服务提前退出（${code}）。\n${output.slice(-2000)}`)); }
    });
  });
  try {
    return await serverStartupPromise;
  } finally {
    serverStartupPromise = null;
  }
}

function secureWindowOptions() {
  return {
    width: 1480,
    height: 980,
    minWidth: 1040,
    minHeight: 720,
    // Keep the native macOS frame for reliable edge/corner resizing while
    // letting the renderer provide a safe drag strip below the traffic lights.
    frame: true,
    resizable: true,
    movable: true,
    fullscreenable: true,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    backgroundColor: '#f2f5f7',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };
}

function installLocalApiAuthorization(window) {
  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['http://127.0.0.1/*', 'http://localhost/*'] },
    (details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      if (hasTrustedOrigin(details.url, serverURL)) {
        requestHeaders['X-My-Scholar-Api-Token'] = apiAccessToken;
      }
      callback({ requestHeaders });
    },
  );
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (hasTrustedOrigin(url, serverURL)) {
      return { action: 'allow', overrideBrowserWindowOptions: secureWindowOptions() };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (!hasTrustedOrigin(url, serverURL)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  };
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnosticLog('renderer-process-gone', JSON.stringify(details));
    if (details.reason === 'clean-exit' || allowQuit || rendererCrashShutdownPromise) return;
    shuttingDown = true;
    dialog.showErrorBox('谷子学术阅读器异常退出', `阅读器渲染进程已停止（${details.reason || '未知原因'}）。\n\n诊断日志：${path.join(app.getPath('logs'), 'my-scholar-electron.log')}`);
    rendererCrashShutdownPromise = stopServer()
      .catch((error) => diagnosticLog('stop-after-renderer-error', error.message || String(error)))
      .finally(() => {
        allowQuit = true;
        app.quit();
      });
  });
  window.webContents.on('child-process-gone', (_event, details) => {
    diagnosticLog('child-process-gone', JSON.stringify(details));
  });
  window.on('unresponsive', () => {
    diagnosticLog('window-unresponsive');
    if (unresponsiveNoticeShown || shuttingDown) return;
    unresponsiveNoticeShown = true;
    dialog.showMessageBox(window, { type: 'warning', title: '谷子学术暂时无响应', message: '阅读窗口暂时没有响应。请稍等，或关闭窗口后重新打开。' }).finally(() => { unresponsiveNoticeShown = false; });
  });
  window.on('responsive', () => diagnosticLog('window-responsive'));
}

async function createWindow() {
  if (libraryMigrationPromise) {
    diagnosticLog('wait-for-library-migration-before-window');
    try {
      await libraryMigrationPromise;
    } catch (_) {
      // chooseAndMigrateLibrary completes its rollback before rejecting, so the
      // restored library is safe to reopen after an unsuccessful migration.
    }
  }
  const url = await startServer();
  console.log(`My Scholar desktop backend: ${url}`);
  mainWindow = new BrowserWindow(secureWindowOptions());
  diagnosticLog('create-window', `shell=${process.env.MY_SCHOLAR_SHELL || 'reference'} url=${url}`);
  installLocalApiAuthorization(mainWindow);
  hardenWindow(mainWindow);
  await mainWindow.loadURL(url);
  console.log('My Scholar desktop window ready');
  let closeAfterFlush = false;
  let closeFlushPromise = null;
  mainWindow.on('close', (event) => {
    if (closeAfterFlush || shuttingDown) return;
    event.preventDefault();
    if (closeFlushPromise) return;
    const closingWindow = mainWindow;
    closeFlushPromise = flushRendererState(closingWindow)
      .then(() => {
        closeAfterFlush = true;
        if (!closingWindow.isDestroyed()) closingWindow.close();
      })
      .catch((error) => {
        diagnosticLog('window-close-flush-error', error.message || String(error));
        if (!closingWindow.isDestroyed()) dialog.showMessageBox(closingWindow, { type: 'warning', title: '改动尚未保存', message: error.message || '设置或笔记尚未保存，请稍后重试。' });
      })
      .finally(() => { closeFlushPromise = null; });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    stopServer().catch((error) => diagnosticLog('stop-after-window-close-error', error.message || String(error)));
  });
}

function ensureWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve(mainWindow);
  if (windowStartupPromise) return windowStartupPromise;
  windowStartupPromise = createWindow().finally(() => { windowStartupPromise = null; });
  return windowStartupPromise;
}

app.whenReady().then(async () => {
  const installationCompletion = consumeInstallationMarker({ app });
  const installation = requestMacInstallation({ app, dialog });
  if (installation.action !== 'continue') {
    if (installation.action === 'quit') app.quit();
    return;
  }
  await prepareDesktopStorage();
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
    } catch (error) {
      diagnosticLog('dock-icon-error', error.message || String(error));
    }
  }
  const window = await ensureWindow();
  if (installationCompletion) {
    await dialog.showMessageBox(window, {
      type: 'info',
      title: '安装完成',
      message: '谷子学术已安装完成',
      detail: installationCompletion === 'assisted'
        ? '安装程序已自动退出；当前窗口来自“应用程序”中的谷子学术。'
        : '当前窗口来自“应用程序”中的谷子学术。你现在可以关闭并推出安装镜像。',
      buttons: ['开始使用'],
      defaultId: 0,
    });
  }
  return window;
}).catch((error) => {
  diagnosticLog('startup-error', error.stack || error.message || String(error));
  process.exitCode = 1;
  dialog.showErrorBox('谷子学术无法启动', error.stack || error.message || String(error));
  stopServer().catch((stopError) => diagnosticLog('stop-after-startup-error', stopError.message || String(stopError)));
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    ensureWindow().catch((error) => diagnosticLog('activate-error', error.stack || error.message || String(error)));
  }
});

app.on('before-quit', (event) => {
  if (!allowQuit && libraryMigrationPromise) {
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    libraryMigrationPromise
      .catch(() => {})
      .then(() => flushRendererState())
      .then(() => stopServer())
      .then(() => { allowQuit = true; app.quit(); })
      .catch(reportSafeQuitFailure);
    return;
  }
  if (allowQuit || !pythonServer || pythonServer.exitCode !== null || pythonServer.signalCode) {
    shuttingDown = true;
    return;
  }
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  flushRendererState()
    .then(() => stopServer())
    .then(() => { allowQuit = true; app.quit(); })
    .catch(reportSafeQuitFailure);
});
app.on('window-all-closed', () => {
  stopServer().catch((error) => diagnosticLog('stop-after-all-windows-closed-error', error.message || String(error)));
  if (process.platform !== 'darwin') app.quit();
});
