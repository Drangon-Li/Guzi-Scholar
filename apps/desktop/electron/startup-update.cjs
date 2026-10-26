'use strict';
const { REPOSITORY, compareVersions, versionChannel, releasePageURL, findReleaseAnnouncement } = require('./update-service.cjs');

function createStartupUpdateCheck({ config, currentVersion, getWindow, showMessageBox, openExternal, discover = findReleaseAnnouncement }) {
  let started = false;
  return async function checkAfterWindowReady() {
    if (started || !config.discoveryEnabled) return;
    started = true;
    try {
      const result = await discover({ currentVersion, channel: config.channel });
      if (result.status !== 'available' || result.repository !== REPOSITORY || result.channel !== config.channel || versionChannel(result.version) !== config.channel || compareVersions(result.version, currentVersion) <= 0) return;
      const window = getWindow();
      if (!window) return;
      const choice = await showMessageBox(window, {
        type: 'info', title: '发现新版本', message: `谷子学术 v${result.version} 已发布`,
        detail: '查看发布说明和下载方式。当前阅读不会受到影响。',
        buttons: ['查看更新', '稍后'], defaultId: 1, cancelId: 1, noLink: true,
      });
      if (choice.response === 0 && getWindow() === window) await openExternal(releasePageURL(result.version));
    } catch (_) {
      // Startup discovery must never interrupt reading or the existing update cache.
    }
  };
}

module.exports = { createStartupUpdateCheck };
