'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { REPOSITORY, assetURL, versionChannel } = require('./update-service.cjs');

function validateCandidate(candidate, { allowLoopback = false } = {}) {
  if (!candidate || candidate.repository !== REPOSITORY || candidate.platform !== 'win32' || candidate.arch !== 'x64'
    || !['stable', 'beta'].includes(candidate.channel)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(candidate.version || '')
    || !Number.isSafeInteger(candidate.size) || candidate.size <= 0
    || !/^[a-f0-9]{64}$/u.test(candidate.sha256 || '')
    || !/^[A-Za-z0-9+/]{86}==$/u.test(candidate.sha512 || '')) throw new Error('Windows 更新信息或完整性校验值无效。');
  const url = new URL(candidate.downloadURL);
  const isolatedLoopback = allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (!isolatedLoopback && candidate.downloadURL !== assetURL(`v${candidate.version}`, candidate.assetName)) throw new Error('Windows 更新地址与固定仓库发布附件不匹配。');
  if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.search || url.hash
    || !candidate.assetName || path.basename(candidate.assetName) !== candidate.assetName
    || !candidate.assetName.endsWith('-windows-x64-setup.exe')
    || decodeURIComponent(url.pathname.split('/').pop()) !== candidate.assetName) throw new Error('Windows 更新安装包地址无效。');
  if (versionChannel(candidate.version) !== candidate.channel) throw new Error('Windows 更新通道与版本不匹配。');
  if (Buffer.from(candidate.sha512, 'base64').toString('base64') !== candidate.sha512) throw new Error('Windows 更新 SHA-512 编码无效。');
  return new URL('.', url).toString();
}

function verifyFeed(info, candidate, feedURL) {
  if (!info || info.version !== candidate.version || info.packages) throw new Error('NSIS 更新元数据与选定版本不匹配。');
  const installers = (info.files || []).filter((file) => {
    try { return new URL(file.url, feedURL).pathname.toLowerCase().endsWith('.exe'); } catch (_) { return false; }
  });
  const file = installers[0];
  if (installers.length !== 1 || new URL(file.url, feedURL).toString() !== candidate.downloadURL
    || file.sha512 !== candidate.sha512 || file.size !== candidate.size) throw new Error('NSIS 更新安装包、大小或 SHA-512 与发布清单不匹配。');
}

async function verifyFile(filename, candidate, cacheDirectory) {
  const relative = path.relative(cacheDirectory, filename);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('更新安装包不在专用缓存目录中。');
  const stat = await fs.promises.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.size) throw new Error('Windows 更新安装包大小不匹配。');
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(filename)) { sha256.update(chunk); sha512.update(chunk); }
  if (sha256.digest('hex') !== candidate.sha256 || sha512.digest('base64') !== candidate.sha512) throw new Error('Windows 更新安装包完整性校验失败。');
}

function createWindowsUpdater({ app, cacheDirectory, updater: injectedUpdater, onError = () => {},
  installStartTimeout = 15000, allowLoopbackForTesting = false } = {}) {
  if (!app || !path.isAbsolute(cacheDirectory || '')) throw new Error('Windows 更新器需要应用和绝对缓存路径。');
  const updater = injectedUpdater || new (require('electron-updater').NsisUpdater)();
  const originalAdapter = updater.app;
  const originalSpawn = updater.spawnLog;
  if (!originalAdapter || typeof originalSpawn !== 'function') throw new Error('不支持的 electron-updater 安装契约。');
  const adapter = Object.create(originalAdapter);
  Object.defineProperty(adapter, 'baseCachePath', { value: cacheDirectory });
  let pendingInstall = null;
  let prepared = null;
  let disposed = false;
  let downloading = false;
  let quitting = false;
  const recordPath = path.join(cacheDirectory, 'candidate.json');

  function failInstall(error) {
    const installation = pendingInstall;
    if (!installation) return;
    pendingInstall = null;
    clearTimeout(installation.timer);
    updater.quitAndInstallCalled = false;
    installation.reject(error);
  }
  const errorHandler = (error) => {
    failInstall(error);
    onError(error);
  };
  const removeListeners = () => { app.removeListener('quit', quitHandler); updater.removeListener('error', errorHandler); };
  const quitHandler = () => {
    quitting = true;
    if (pendingInstall) clearTimeout(pendingInstall.timer);
    if (disposed) removeListeners();
  };
  app.on('quit', quitHandler);
  updater.on('error', errorHandler);

  // v6.8.11 queues app.quit before its detached spawn promise settles. Keep the
  // real Electron HTTP executor, but gate that private instance's adapter quit.
  adapter.quit = () => {
    if (!pendingInstall) return;
    pendingInstall.quitRequested = true;
    if (pendingInstall.started) app.quit();
  };
  updater.app = adapter;
  updater.spawnLog = async (...args) => {
    const installation = pendingInstall;
    try {
      const started = await originalSpawn.apply(updater, args);
      if (started !== true) throw new Error('Windows 更新安装进程未启动。');
      if (installation && pendingInstall === installation) {
        installation.started = true;
        clearTimeout(installation.timer);
        if (installation.quitRequested) app.quit();
      }
      return started;
    } catch (error) {
      // NSIS v6 otherwise falls back to shell.openPath on ENOENT, whose result
      // cannot establish that the installer was started.
      if (error.code === 'ENOENT') error.code = 'GUZI_INSTALLER_SPAWN_FAILED';
      throw error;
    }
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;

  const assertActive = () => { if (disposed) throw new Error('Windows 更新器已经关闭。'); };
  const matchesPrepared = (candidate) => prepared && candidate
    && ['repository', 'version', 'channel', 'platform', 'arch', 'downloadURL', 'assetName', 'size', 'sha256', 'sha512', 'minimumSystemVersion'].every((key) => prepared.candidate[key] === candidate[key]);
  async function download(candidate, onProgress = () => {}) {
    assertActive();
    const feedURL = validateCandidate(candidate, { allowLoopback: allowLoopbackForTesting });
    if (downloading || pendingInstall) throw new Error('Windows 更新操作正在进行。');
    downloading = true;
    prepared = null;
    const progress = (event) => onProgress({ transferred: event.transferred, total: candidate.size,
      percent: Math.min(100, Math.max(0, event.transferred / candidate.size * 100)), bytesPerSecond: event.bytesPerSecond });
    updater.on('download-progress', progress);
    try {
      updater.setFeedURL({ provider: 'generic', url: feedURL, channel: candidate.channel === 'stable' ? 'latest' : 'beta', useMultipleRangeRequest: false });
      updater.channel = candidate.channel === 'stable' ? 'latest' : 'beta';
      updater.allowPrerelease = candidate.channel === 'beta';
      updater.allowDowngrade = false;
      const result = await updater.checkForUpdates();
      verifyFeed(result?.updateInfo, candidate, feedURL);
      const files = await updater.downloadUpdate();
      if (!Array.isArray(files) || files.length !== 1) throw new Error('NSIS 更新必须包含一个完整安装包。');
      await verifyFile(files[0], candidate, cacheDirectory);
      assertActive();
      prepared = { candidate: { ...candidate }, filename: files[0] };
      await fs.promises.mkdir(cacheDirectory, { recursive: true });
      const temporary = `${recordPath}.partial`;
      await fs.promises.writeFile(temporary, JSON.stringify(prepared), { mode: 0o600 });
      await fs.promises.rename(temporary, recordPath);
      return { ...candidate };
    } finally {
      downloading = false;
      updater.removeListener('download-progress', progress);
    }
  }

  return {
    download,
    async canInstall(candidate) {
      if (disposed || downloading || pendingInstall || !matchesPrepared(candidate)) return false;
      try { await verifyFile(prepared.filename, candidate, cacheDirectory); return true; }
      catch (_) { prepared = null; return false; }
    },
    async getDownloadedCandidate() {
      assertActive();
      if (prepared) { await verifyFile(prepared.filename, prepared.candidate, cacheDirectory); return { ...prepared.candidate }; }
      let record;
      try { record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
      try {
        validateCandidate(record.candidate, { allowLoopback: allowLoopbackForTesting });
        await verifyFile(record.filename, record.candidate, cacheDirectory);
        // Startup stays local. An explicit download action must hydrate the
        // updater's helper before this cached package can be installed.
        return { ...record.candidate };
      } catch (_) { prepared = null; return null; }
    },
    async install(candidate) {
      assertActive();
      validateCandidate(candidate, { allowLoopback: allowLoopbackForTesting });
      if (pendingInstall) throw new Error('Windows 更新安装已经开始。');
      if (!matchesPrepared(candidate)) throw new Error('请先下载并验证选定的 Windows 更新。');
      await verifyFile(prepared.filename, candidate, cacheDirectory);
      return new Promise((_resolve, reject) => {
        const installation = { reject, started: false, quitRequested: false };
        pendingInstall = installation;
        installation.timer = setTimeout(() => failInstall(new Error('Windows 更新安装进程启动超时。')), installStartTimeout);
        try { updater.quitAndInstall(true, true); } catch (error) { failInstall(error); }
        // The process must exit on success. Resolving here would incorrectly
        // mark the save/quiesce coordinator complete while errors remain possible.
      });
    },
    cancelPreparedUpdateForExit() {
      updater.autoInstallOnAppQuit = false;
      if (pendingInstall && !pendingInstall.started) failInstall(new Error('已取消 Windows 更新安装。'));
    },
    dispose() {
      disposed = true;
      updater.autoInstallOnAppQuit = false;
      // Main disposes on will-quit. Keep watching an accepted installer until
      // the actual quit event without rejecting the in-flight save coordinator.
      if (!quitting && pendingInstall?.started) return;
      if (!quitting) failInstall(new Error('Windows 更新器已经关闭。'));
      removeListeners();
      // Keep the adapter gate in place: a previously queued quit must stay inert.
    },
  };
}

module.exports = { createWindowsUpdater, validateCandidate, verifyFeed, verifyFile };
