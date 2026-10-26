const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, powerMonitor, shell, webContents } = require('electron');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
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
const { packagedToolchainEnvironment: resolvePackagedToolchainEnvironment, resolvePackagedServer } = require('./packaged-runtime.cjs');
const { RendererStateStore } = require('./renderer-state.cjs');
const { hasTrustedOrigin, localRequestPolicy } = require('./url-security.cjs');
const { mcpClientConfiguration } = require('./mcp-config.cjs');
const { resolveUpdateConfig } = require('./update-config.cjs');
const { createUpdateController } = require('./update-controller.cjs');
const { createStartupUpdateCheck } = require('./startup-update.cjs');
const { consumeInstallationMarker, requestMacInstallation } = require('./macos-installation.cjs');
const { configurePluginIsolation, checkPreviewBoundaries, PluginProcessGuard } = require('./plugin-guard.cjs');
const { createExitCoordinator, flushRenderer } = require('./exit-coordinator.cjs');

configurePluginIsolation(app.commandLine);

const packageMetadata = require('../package.json');
const LOCAL_TEST_BUILD = typeof packageMetadata.localTestBuild === 'string' ? packageMetadata.localTestBuild.trim() : '';
const developmentArguments = !app.isPackaged ? (process.argv || []) : [];
const DEVELOPMENT_BUILD = developmentArguments.includes('--guzi-development') ? 'MCP · Plugins' : '';
const isolatedBuild = Boolean(LOCAL_TEST_BUILD || DEVELOPMENT_BUILD);
const updateConfig = resolveUpdateConfig({ metadata: packageMetadata, isPackaged: app.isPackaged, platform: process.platform, arch: process.arch });
const BETA_BUILD = !isolatedBuild && updateConfig.channel === 'beta';
const PRODUCT_NAME = DEVELOPMENT_BUILD ? '谷子学术开发版' : LOCAL_TEST_BUILD || BETA_BUILD ? '谷子学术测试版' : '谷子学术';
const UPDATE_CHANNEL = updateConfig.channel;
const defaultUserDataPath = app.getPath('userData');
app.setName(PRODUCT_NAME);
if (DEVELOPMENT_BUILD) {
  const requestedRoot = developmentArguments.find((argument) => argument.startsWith('--guzi-dev-root='))?.slice('--guzi-dev-root='.length);
  if (requestedRoot && !path.isAbsolute(requestedRoot)) throw new Error('开发版数据目录必须使用绝对路径。');
  app.setPath('userData', requestedRoot || path.join(app.getPath('appData'), 'GuziScholar-Development'));
  app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
} else if (LOCAL_TEST_BUILD) {
  app.setPath('userData', path.join(app.getPath('appData'), 'GuziScholar-LocalTest'));
  app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
} else if (BETA_BUILD) {
  app.setPath('userData', path.join(app.getPath('appData'), 'GuziScholar-Beta'));
  app.setAppLogsPath(path.join(app.getPath('userData'), 'logs'));
} else if (!app.isPackaged) app.setPath('userData', `${defaultUserDataPath}-development`);

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
let updateController = null;
let checkStartupUpdate = async () => {};
let pluginGuard = null;
let cancelPreparedUpdateForExit = async () => {};
const windowsAllowedToClose = new WeakSet();
const pluginRuntimeChecks = new Map();
const migrationControlToken = crypto.randomBytes(32).toString('hex');
const apiAccessToken = crypto.randomBytes(32).toString('hex');
const pluginAdmissionToken = crypto.randomBytes(32).toString('hex');

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
      channel: DEVELOPMENT_BUILD ? 'development' : LOCAL_TEST_BUILD ? 'local-test' : UPDATE_CHANNEL,
      updatesEnabled: updateConfig.enabled,
      ...(LOCAL_TEST_BUILD ? { localTestBuild: LOCAL_TEST_BUILD } : {}),
      ...(DEVELOPMENT_BUILD ? { developmentBuild: DEVELOPMENT_BUILD } : {}),
    },
    storage: startupStorageReport,
  };
});

async function pluginSession(payload) {
  const registry = await backendRequestJSON('/api/plugins');
  const previewSession = payload.previewSession || null;
  if (previewSession) {
    const preview = (registry.previews || []).find((item) => (item.pluginId || item.id) === payload.pluginId && item.previewId === previewSession);
    if (!preview) throw new Error('插件预览会话已失效。');
    return { pluginId: payload.pluginId, previewSession };
  }
  const record = (registry.plugins || []).find((item) => item.id === payload.pluginId && item.enabled);
  if (!record || (payload.pluginSession && payload.pluginSession !== record.epoch)) throw new Error('插件运行会话已失效。');
  return { pluginId: payload.pluginId, pluginSession: record.epoch };
}

ipcMain.handle('my-scholar:plugin-runtime-check', async (event, payload) => {
  requireMainWindowSender(event);
  if (!payload || typeof payload !== 'object' || !/^[a-z0-9][a-z0-9._-]*$/u.test(payload.pluginId || '') ||
      (payload.previewSession != null && !/^[a-f0-9]{32}$/u.test(payload.previewSession)) ||
      (payload.pluginSession != null && !/^[a-f0-9]{32}$/u.test(payload.pluginSession)) ||
      (!payload.previewSession && !payload.pluginSession)) throw new Error('插件运行检查参数无效。');
  const key = JSON.stringify([payload.pluginId, payload.previewSession, payload.pluginSession]);
  if (pluginRuntimeChecks.has(key)) return pluginRuntimeChecks.get(key);
  const guard = pluginGuard;
  if (!guard) throw new Error('插件运行守卫尚未启动。');
  const check = (async () => {
    const session = await pluginSession(payload);
    const verifyRuntime = async () => {
      const response = await backendRequestJSON(`/api/plugins/runtime-status?pluginId=${encodeURIComponent(payload.pluginId)}`);
      const runtime = response.runtime || response;
      if (runtime.status !== 'ready' || runtime.errorCount ||
          (session.previewSession && runtime.previewId !== session.previewSession) ||
          (!session.previewSession && runtime.epoch !== session.pluginSession)) throw new Error('插件 SDK 尚未就绪、发生错误，或运行会话已失效。');
    };
    await verifyRuntime();
    const result = await guard.check(payload);
    requireMainWindowSender(event);
    if (pluginGuard !== guard) throw new Error('插件运行守卫已重置。');
    await pluginSession(payload);
    await verifyRuntime();
    if (!session.previewSession) return result;
    const boundaries = await checkPreviewBoundaries(backendRequestJSON, session);
    const admission = await backendRequestJSON('/api/plugins/admission', { method: 'POST', body: {
      ...session,
      checks: { processIsolation: true, sdkHandshake: true, runtimeStable: true, hostResponsive: true, ...boundaries },
    } });
    return { ...result, admission: admission.admission || admission };
  })().finally(() => pluginRuntimeChecks.delete(key));
  pluginRuntimeChecks.set(key, check);
  return check;
});

ipcMain.handle('my-scholar:mcp-config', async (event) => {
  requireMainWindowSender(event);
  const status = await backendRequestJSON('/api/mcp/status');
  return { ok: true, ...mcpClientConfiguration({ executable: process.execPath, projectRoot: path.resolve(__dirname, '..'), connectionFile: status.connection_file }) };
});

async function updateAction(event, action) {
  requireMainWindowSender(event);
  if (!updateController) return { ok: false, error: '更新服务尚未就绪。' };
  try { return { ok: true, ...await updateController[action]() }; }
  catch (error) { return { ok: false, ...await updateController.getState(), error: error.message }; }
}
ipcMain.handle('my-scholar:get-update-state', (event) => updateAction(event, 'getState'));
ipcMain.handle('my-scholar:check-for-updates', (event) => updateAction(event, 'check'));
ipcMain.handle('my-scholar:download-update', (event) => updateAction(event, 'download'));
ipcMain.handle('my-scholar:install-update', async (event) => {
  requireMainWindowSender(event);
  const state = await updateController?.getState();
  if (!state?.canInstall) return { ok: false, ...state, error: '请先完整下载更新。' };
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: '安装更新并重新启动', message: `安装谷子学术 v${state.version}？`,
    detail: '将先保存当前笔记、设置和阅读记录，再退出并安装更新。若保存失败，你可以取消安装。',
    buttons: ['保存并安装', '取消'], defaultId: 0, cancelId: 1, noLink: true,
  });
  requireMainWindowSender(event);
  if (choice.response !== 0) return { ok: true, ...await updateController.getState(), cancelled: true };
  return updateAction(event, 'install');
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
  // A test launch must not inherit a production library or state override.
  const storageEnvironment = isolatedBuild || BETA_BUILD
    ? { ...process.env, MY_SCHOLAR_DATA_DIR: '', MY_SCHOLAR_LIBRARY_DIR: '' }
    : process.env;
  const layout = desktopStorageLayout({
    projectRoot,
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged || isolatedBuild,
    env: storageEnvironment,
  });
  const location = resolveLibraryLocation({ defaultLibraryDir: layout.defaultLibraryDir, pointerPath: layout.pointerPath, env: storageEnvironment });
  return { ...layout, ...location };
}

async function prepareDesktopStorage() {
  let storage = storageConfiguration();
  if (isolatedBuild || BETA_BUILD) {
    startupStorageReport = { state: 'none', adopted: false, current: await inspectLibraryDirectory(storage.currentPath), legacy: [] };
    return;
  }
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

function backendRequestJSON(route, { method = 'GET', timeout = 10000, headers = {}, body } = {}) {
  if (!serverURL) return Promise.reject(new Error('本地服务尚未启动。'));
  const target = new URL(route, serverURL);
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method,
      headers: { Accept: 'application/json', ...headers, ...(serialized === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) }), 'X-My-Scholar-Api-Token': apiAccessToken,
        ...(target.pathname === '/api/plugins/admission' ? { 'X-My-Scholar-Plugin-Admission': pluginAdmissionToken } : {}),
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.once('aborted', () => reject(new Error('本地服务响应中断。')));
      response.once('error', reject);
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
          const error = new Error(`本地服务请求失败（HTTP ${response.statusCode || 500}）。`);
          error.statusCode = response.statusCode || 500;
          reject(error);
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
    request.end(serialized);
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
    mainWindow.loadURL(settingsURL).catch(async (error) => {
      diagnosticLog('reload-after-library-migration-error', error.message || String(error));
      await resumeRendererState().catch((failure) => diagnosticLog('resume-after-library-migration-error', failure.message || String(failure)));
    });
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
    await resumeRendererState().catch((failure) => { rollbackError = rollbackError || failure; });
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
    await resumeRendererState().catch((failure) => { rollbackError = rollbackError || failure; });
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
    return resolvePackagedServer({ resourcesPath: process.resourcesPath, platform: process.platform });
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
  return resolvePackagedToolchainEnvironment({ resourcesPath: process.resourcesPath, platform: process.platform });
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

function stopServer({ allowForce = true } = {}) {
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
    if (!stopped && allowForce) {
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

function flushRendererState(window = mainWindow, timeout = 5000, options = {}) {
  return flushRenderer(window, { ...options, timeout });
}

async function resumeRendererState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  await mainWindow.webContents.executeJavaScript("typeof window.__myScholarResumeAfterClose === 'function' && window.__myScholarResumeAfterClose()", true);
}

function hasLiveBackend() {
  return Boolean(serverURL && pythonServer && pythonServer.exitCode === null && !pythonServer.signalCode);
}

const exitCoordinator = createExitCoordinator({
  waitForMigration: async () => { if (libraryMigrationPromise) await libraryMigrationPromise.catch(() => {}); },
  hasRenderer: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
  flush: (options) => flushRendererState(mainWindow, 5000, options),
  assertInstallReady: () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) throw new Error('阅读窗口不可用，无法安全安装更新。');
    if (!hasLiveBackend()) throw new Error('本地文献服务不可用，无法安全安装更新。');
    if (rendererCrashShutdownPromise) throw new Error('阅读器异常退出，已取消安装更新。');
  },
  chooseSaveFailure: async (error, intent) => {
    const options = {
      type: 'warning', title: '改动尚未保存', message: error.message || '设置或笔记尚未保存。',
      detail: intent === 'install-update' ? '保存完成或明确放弃本次保存后，才会安装更新。放弃后仍保留可恢复的草稿副本。' : '保存完成或明确放弃本次保存后，才会退出。放弃后仍保留可恢复的草稿副本。',
      buttons: ['重试保存', '取消', '放弃本次保存'], defaultId: 0, cancelId: 1, noLink: true,
    };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
    return ['retry', 'cancel', 'discard'][result.response] || 'cancel';
  },
  prepareBackend: () => backendMigrationControl('prepare'),
  cancelBackendPreparation: async () => { if (hasLiveBackend()) await backendMigrationControl('cancel', 5000); },
  cancelPreparedUpdateForExit: () => cancelPreparedUpdateForExit(),
  stopBackend: (options) => { shuttingDown = true; return stopServer(options); },
  recoverBackend: async () => {
    shuttingDown = false;
    allowQuit = false;
    const previousURL = serverURL;
    const restoredURL = await startServer();
    if (mainWindow && !mainWindow.isDestroyed() && previousURL !== restoredURL) await mainWindow.loadURL(restoredURL);
  },
  resumeRenderer: resumeRendererState,
  resetExit: () => { shuttingDown = false; allowQuit = false; },
  finish: (intent) => {
    if (intent === 'quit') { allowQuit = true; app.quit(); return; }
    const window = mainWindow;
    if (window && !window.isDestroyed()) {
      if (process.platform !== 'darwin') allowQuit = true;
      windowsAllowedToClose.add(window);
      window.close();
    }
  },
  reportFailure: async (error, intent, recoveryErrors) => {
    diagnosticLog(`${intent}-error`, [error.message, ...recoveryErrors.map((failure) => failure.message)].join(' '));
    const title = intent === 'install-update' ? '暂时无法安全安装更新' : '暂时无法安全退出';
    dialog.showErrorBox(title, `${error.message || '操作未能完成。'}${recoveryErrors.length ? `\n恢复时发生错误：${recoveryErrors.map((failure) => failure.message).join('；')}` : '\n已保留当前窗口，请稍后重试。'}`);
  },
});

function setCancelPreparedUpdateForExit(callback) {
  if (typeof callback !== 'function') throw new TypeError('更新撤销入口必须是函数。');
  cancelPreparedUpdateForExit = callback;
}

function requestUpdateInstallation({ install, cancelPreparedInstall } = {}) {
  if (typeof install !== 'function') return Promise.reject(new Error('更新安装入口不可用。'));
  return exitCoordinator.request({
    intent: 'install-update', cancelPreparedInstall,
    install: async () => {
      allowQuit = true;
      try { return await install(); } catch (error) { allowQuit = false; throw error; }
    },
  });
}

module.exports = { requestUpdateInstallation, setCancelPreparedUpdateForExit };

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
      MY_SCHOLAR_PLUGIN_ADMISSION_TOKEN: pluginAdmissionToken,
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
    let stdoutRemainder = '';
    let ready = false;
    const appendOutput = (text) => { output = `${output}${text}`.slice(-8192); };
    const timer = setTimeout(() => {
      signalServer(child, 'SIGTERM');
      reject(new Error(`本地服务启动超时。\n${output.slice(-2000)}`));
    }, 30000);
    const onData = (chunk) => {
      if (ready) return;
      const text = chunk.toString();
      appendOutput(text);
      const pending = `${stdoutRemainder}${text}`;
      const lastNewline = pending.lastIndexOf('\n');
      stdoutRemainder = pending.slice(lastNewline + 1).slice(-8192);
      if (lastNewline < 0) return;
      const match = pending.slice(0, lastNewline).match(/My Scholar running at (http:\/\/127\.0\.0\.1:\d+)/u);
      if (match) {
        ready = true;
        clearTimeout(timer);
        serverURL = match[1];
        if (DEVELOPMENT_BUILD) {
          fs.writeFileSync(path.join(app.getPath('userData'), 'development-runtime.json'), JSON.stringify({ pid: process.pid, backendPid: child.pid, url: serverURL, stateDir: storage.stateDir, libraryDir: storage.currentPath }, null, 2), { mode: 0o600 });
        }
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
  const pluginFrames = new Map();
  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const policy = localRequestPolicy(details, serverURL, window.webContents.mainFrame, pluginFrames);
      if (policy.cancel) { callback({ cancel: true }); return; }
      const requestHeaders = { ...details.requestHeaders };
      for (const key of Object.keys(requestHeaders)) {
        if (key.toLowerCase() === 'x-my-scholar-api-token') delete requestHeaders[key];
      }
      if (hasTrustedOrigin(details.url, serverURL) && policy.authorize) {
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
    if (exitCoordinator.state.pending && exitCoordinator.state.intent === 'install-update') {
      exitCoordinator.cancel('阅读器异常退出，已取消安装更新。');
      return;
    }
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
  const guardedWindow = mainWindow;
  pluginGuard?.dispose();
  pluginGuard = new PluginProcessGuard({
    contents: guardedWindow.webContents,
    getServerURL: () => serverURL,
    allWebContents: () => webContents.getAllWebContents(),
    getMetrics: () => app.getAppMetrics(),
    killProcess: (pid) => process.kill(pid, 'SIGKILL'),
    onStart: (entry) => pluginSession(entry),
    onStop: async (entry, details) => {
      if (!guardedWindow.isDestroyed() && hasTrustedOrigin(guardedWindow.webContents.mainFrame.url, serverURL)) {
        guardedWindow.webContents.mainFrame.send('my-scholar:plugin-stopped', { pluginId: entry.pluginId, previewSession: entry.previewSession, ...details });
      }
      const session = await entry.metadata;
      if (session) await backendRequestJSON('/api/plugins/runtime-event', { method: 'POST', body: {
        ...session, level: 'error', message: details.message, details: { reason: details.reason, containment: true, terminated: details.terminated },
      } });
    },
    log: diagnosticLog,
  });
  await mainWindow.loadURL(url);
  diagnosticLog('window-ready', `pid=${process.pid} version=${app.getVersion()}`);
  console.log('My Scholar desktop window ready');
  mainWindow.on('close', (event) => {
    if (windowsAllowedToClose.has(guardedWindow) || allowQuit) return;
    event.preventDefault();
    exitCoordinator.request({ intent: 'close' }).catch((error) => diagnosticLog('window-close-error', error.message || String(error)));
  });
  mainWindow.on('closed', () => {
    pluginGuard?.dispose();
    pluginGuard = null;
    mainWindow = null;
    shuttingDown = false;
    stopServer().catch((error) => diagnosticLog('stop-after-window-close-error', error.message || String(error)));
  });
  void checkStartupUpdate();
}

function ensureWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve(mainWindow);
  if (windowStartupPromise) return windowStartupPromise;
  windowStartupPromise = createWindow().finally(() => { windowStartupPromise = null; });
  return windowStartupPromise;
}

app.whenReady().then(async () => {
  powerMonitor.on('suspend', () => pluginGuard?.suspend());
  powerMonitor.on('resume', () => pluginGuard?.resume());
  const installationCompletion = isolatedBuild ? null : consumeInstallationMarker({ app });
  const installation = isolatedBuild ? { action: 'continue' } : requestMacInstallation({ app, dialog });
  if (installation.action !== 'continue') {
    if (installation.action === 'quit') app.quit();
    return;
  }
  let adapter = null;
  if (updateConfig.enabled) {
    try {
      const options = { app, cacheDirectory: path.join(app.getPath('userData'), 'updates', UPDATE_CHANNEL), publicKey: updateConfig.publicKey };
      adapter = process.platform === 'darwin'
        ? require('./mac-updater.cjs').createMacUpdater(options)
        : require('./windows-updater.cjs').createWindowsUpdater(options);
    } catch (error) {
      updateConfig.enabled = false;
      updateConfig.reason = `无法初始化更新服务：${error.message}`;
      diagnosticLog('updater-initialization-error', error.message);
    }
  }
  updateController = createUpdateController({
    config: updateConfig, currentVersion: app.getVersion(), platform: process.platform, arch: process.arch,
    systemVersion: process.platform === 'darwin' ? process.getSystemVersion() : os.release(),
    adapter, requestInstallation: requestUpdateInstallation,
  });
  updateController.onState((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('my-scholar:update-state', state);
  });
  setCancelPreparedUpdateForExit(() => updateController.cancelPreparedUpdateForExit());
  checkStartupUpdate = createStartupUpdateCheck({
    config: updateConfig, currentVersion: app.getVersion(),
    getWindow: () => !shuttingDown && mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
    showMessageBox: (window, options) => dialog.showMessageBox(window, options),
    openExternal: (url) => shell.openExternal(url),
  });
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
  if (allowQuit) {
    shuttingDown = true;
    return;
  }
  event.preventDefault();
  exitCoordinator.request({ intent: 'quit' }).catch((error) => diagnosticLog('quit-error', error.message || String(error)));
});
app.on('window-all-closed', () => {
  stopServer().catch((error) => diagnosticLog('stop-after-all-windows-closed-error', error.message || String(error)));
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => { Promise.resolve(updateController?.dispose()).catch((error) => diagnosticLog('updater-dispose-error', error.message)); });
