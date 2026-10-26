'use strict';
const { REPOSITORY, versionChannel, base64Digest } = require('./update-service.cjs');
function resolveUpdateConfig({ metadata, isPackaged, platform, arch }) {
  const updater = metadata.updater || {};
  const channel = !isPackaged ? 'development' : metadata.localTestBuild ? 'local-test' : updater.channel || 'internal';
  const config = { enabled: false, channel, repository: REPOSITORY, publicKey: updater.publicKey || '', reason: '' };
  if (!isPackaged || metadata.localTestBuild || !['stable', 'beta'].includes(channel)) return { ...config, reason: '开发和本地测试版本不连接正式更新通道。' };
  if (!updater.enabled || updater.repository !== REPOSITORY) return { ...config, reason: '此安装包尚未配置应用内更新，请先安装支持更新的新版本。' };
  if (versionChannel(metadata.version) !== channel) return { ...config, reason: '应用版本与更新通道不匹配，请重新安装正确渠道的版本。' };
  if (!(platform === 'darwin' && arch === 'arm64' || platform === 'win32' && arch === 'x64')) return { ...config, reason: '当前平台或架构暂不支持应用内更新。' };
  if (platform === 'darwin' && !base64Digest(config.publicKey, 32)) return { ...config, reason: '此安装包缺少有效的更新签名公钥。' };
  return { ...config, enabled: true };
}
module.exports = { resolveUpdateConfig };
