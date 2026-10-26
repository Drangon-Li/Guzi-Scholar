'use strict';
const { EventEmitter } = require('node:events');
const { REPOSITORY, compareVersions, versionChannel, findReleaseUpdate } = require('./update-service.cjs');
function systemSupports(current, minimum) {
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(current || '')) return false;
  const a = current.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}
function createUpdateController({ config, currentVersion, platform, arch, systemVersion, adapter, requestInstallation, discover = findReleaseUpdate }) {
  const events = new EventEmitter(); let candidate = null, busy = false, downloaded = false;
  let state = { status: config.enabled ? 'idle' : 'disabled', currentVersion, channel: config.channel, enabled: config.enabled, error: config.reason || '', progress: null };
  const snapshot = () => ({ ...(candidate || {}), ...state, canCheck: config.enabled && !busy, canDownload: config.enabled && !busy && Boolean(candidate) && !downloaded, canInstall: config.enabled && !busy && downloaded });
  const emit = (patch) => { state = { ...state, ...patch }; events.emit('state', snapshot()); };
  const fallbackStatus = () => downloaded ? 'ready' : candidate ? 'available' : 'error';
  const ensureIdle = () => { if (!config.enabled) throw new Error(config.reason || '应用内更新未启用。'); if (busy) throw new Error('更新操作正在进行，请稍后重试。'); };
  const ready = (async () => {
    if (!config.enabled || !adapter) return;
    try {
      const cached = await adapter.getDownloadedCandidate();
      if (cached && cached.repository === REPOSITORY && cached.channel === config.channel && versionChannel(cached.version) === config.channel && cached.platform === platform && cached.arch === arch && compareVersions(cached.version, currentVersion) > 0 && systemSupports(systemVersion, cached.minimumSystemVersion)) {
        candidate = Object.freeze({ ...cached }); downloaded = await adapter.canInstall(cached);
        emit({ status: downloaded ? 'ready' : 'available', error: '' });
      }
    } catch (error) { emit({ status: 'error', error: `无法恢复上次下载：${error.message}` }); }
  })();
  return {
    ready, getState: async () => { await ready; return snapshot(); },
    onState(callback) { events.on('state', callback); return () => events.off('state', callback); },
    async check() {
      await ready; ensureIdle(); busy = true; emit({ status: 'checking', error: '' });
      try {
        const result = await discover({ currentVersion, channel: config.channel, platform, arch });
        if (result.status === 'available') {
          if (!systemSupports(systemVersion, result.minimumSystemVersion)) throw new Error(`此更新需要系统版本 ${result.minimumSystemVersion} 或更新版本。`);
          downloaded = downloaded && await adapter.canInstall(result);
          candidate = Object.freeze({ ...result });
          emit({ status: downloaded ? 'ready' : 'available', version: result.version, checkedAt: result.checkedAt, error: '' });
        } else if (downloaded) emit({ status: 'ready', checkedAt: result.checkedAt });
        else { candidate = null; emit({ status: result.status, version: result.version, checkedAt: result.checkedAt, error: '', progress: null }); }
      } catch (error) { emit({ status: fallbackStatus(), error: error.message }); }
      finally { busy = false; emit({}); }
      return snapshot();
    },
    async download() {
      await ready; ensureIdle(); if (!candidate) throw new Error('请先检查更新。');
      busy = true; downloaded = false; emit({ status: 'downloading', progress: { percent: 0, transferred: 0, total: candidate.size }, error: '' });
      try {
        await adapter.download(candidate, (progress) => emit({ progress: { ...progress, percent: Math.min(100, Math.max(0, Number(progress.percent) || 0)) } }));
        downloaded = await adapter.canInstall(candidate);
        if (!downloaded) throw new Error('更新包已下载，但安装服务尚未就绪，请稍后重试。');
        emit({ status: 'ready', progress: null });
      } catch (error) { emit({ status: 'available', progress: null, error: error.message }); }
      finally { busy = false; emit({}); }
      return snapshot();
    },
    async install() {
      await ready; ensureIdle(); if (!candidate || !downloaded) throw new Error('请先完整下载更新。');
      busy = true; emit({ status: 'saving', error: '' });
      try {
        const result = await requestInstallation({ install: async () => {
          emit({ status: 'installing' }); await adapter.install(candidate);
          throw new Error('安装程序没有退出当前应用，请重试。');
        } });
        if (!result.ok) { downloaded = await adapter.canInstall(candidate); emit({ status: fallbackStatus(), error: result.cancelled ? '已取消安装，更新包仍保留。' : result.error || '未能安装更新。' }); }
      } catch (error) { downloaded = await Promise.resolve(adapter.canInstall(candidate)).catch(() => false); emit({ status: fallbackStatus(), error: error.message }); }
      finally { busy = false; emit({}); }
      return snapshot();
    },
    cancelPreparedUpdateForExit: () => adapter?.cancelPreparedUpdateForExit(), dispose: () => adapter?.dispose(),
  };
}
module.exports = { createUpdateController, systemSupports };
