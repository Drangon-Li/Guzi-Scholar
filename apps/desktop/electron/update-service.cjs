'use strict';
const https = require('node:https');
const REPOSITORY = 'Drangon-Li/Guzi-Scholar';
const DOWNLOAD_HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(String(value || ''));
  if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part))) || (match[4] || '').split('.').some((part) => /^0\d+$/u.test(part))) throw new Error('更新版本号无效。');
  return { raw: match[0], numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '' };
}
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i += 1) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i]);
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : 1;
  const ap = a.prerelease.split('.'), bp = b.prerelease.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    const an = /^\d+$/u.test(ap[i]), bn = /^\d+$/u.test(bp[i]);
    if (an && bn) return BigInt(ap[i]) > BigInt(bp[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}
function versionChannel(version) {
  const parsed = parseVersion(version);
  if (!parsed.prerelease) return 'stable';
  if (/^beta\.(?:0|[1-9]\d*)$/u.test(parsed.prerelease)) return 'beta';
  throw new Error('该版本不属于稳定版或测试版更新通道。');
}
function assetURL(tag, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(name)) throw new Error('更新附件名称无效。');
  return `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}
function safeNetworkURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('更新服务地址不受信任。');
  return url;
}
function fetchJSON(value, { maxBytes = 4 * 1024 * 1024, timeout = 15000, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = safeNetworkURL(value); } catch (error) { reject(error); return; }
    const request = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Guzi-Scholar-Updater', 'X-GitHub-Api-Version': '2022-11-28' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirects >= 5) { reject(new Error('更新服务重定向异常。')); return; }
        let next;
        try { next = safeNetworkURL(new URL(response.headers.location, url)); } catch (error) { reject(error); return; }
        resolve(fetchJSON(next, { maxBytes, timeout, redirects: redirects + 1 })); return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        const error = new Error([403, 429].includes(response.statusCode) ? 'GitHub 暂时限制了更新请求，请稍后重试。' : `更新服务请求失败（HTTP ${response.statusCode}）。`);
        error.statusCode = response.statusCode; reject(error); return;
      }
      const chunks = []; let size = 0;
      response.on('data', (chunk) => { size += chunk.length; if (size > maxBytes) { request.destroy(new Error('更新信息超过允许大小。')); return; } chunks.push(chunk); });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('更新信息下载中断。')));
      response.once('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { reject(new Error('更新信息无法解析。')); } });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('更新服务连接超时，请稍后重试。')));
    request.once('error', reject);
  });
}
function base64Digest(value, bytes) { return typeof value === 'string' && Buffer.from(value, 'base64').length === bytes && Buffer.from(value, 'base64').toString('base64') === value; }
function validateReleaseManifest(payload, { platform, arch, channel, release }) {
  if (payload?.schema !== 2 || payload.repository !== REPOSITORY || !Array.isArray(payload.artifacts)) throw new Error('更新清单格式或仓库身份不匹配。');
  const version = parseVersion(payload.version).raw;
  if (versionChannel(version) !== channel || payload.channel !== channel || release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== (channel === 'beta')) throw new Error('更新版本、发布状态或通道不匹配。');
  const kind = platform === 'darwin' ? 'sparkle' : platform === 'win32' ? 'nsis' : '';
  const candidates = payload.artifacts.filter((item) => item.platform === platform && item.arch === arch && item.kind === kind);
  if (!kind || candidates.length !== 1) throw new Error('发布缺少当前设备唯一对应的更新包。');
  const item = candidates[0], downloadURL = assetURL(release.tag_name, item.name);
  if (item.url !== downloadURL || !item.name.endsWith(platform === 'darwin' ? '.zip' : '.exe')) throw new Error('更新包地址与发布附件不匹配。');
  if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > 4 * 1024 ** 3 || !/^[a-f0-9]{64}$/u.test(item.sha256 || '') || !base64Digest(item.sha512, 64)) throw new Error('更新包缺少有效的大小或校验值。');
  if (platform === 'darwin' && !base64Digest(item.ed_signature, 64)) throw new Error('macOS 更新包缺少有效的 Ed25519 签名。');
  const attachment = release.assets?.filter((asset) => asset.name === item.name);
  if (attachment?.length !== 1 || attachment[0].size !== item.size || attachment[0].browser_download_url !== downloadURL || attachment[0].state !== 'uploaded') throw new Error('更新包尚未完整发布，请稍后重试。');
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(item.minimum_system_version || '')) throw new Error('更新包最低系统版本无效。');
  if (!payload.published_at || !Number.isFinite(Date.parse(payload.published_at))) throw new Error('更新发布时间无效。');
  return Object.freeze({ version, channel, platform, arch, downloadURL, assetName: item.name, size: item.size, sha256: item.sha256, sha512: item.sha512,
    ...(platform === 'darwin' ? { edSignature: item.ed_signature } : {}), minimumSystemVersion: item.minimum_system_version,
    notes: String(payload.notes || '').slice(0, 8000), publishedAt: payload.published_at, repository: REPOSITORY });
}
async function findReleaseUpdate({ currentVersion, channel, platform, arch, fetcher = fetchJSON }) {
  if (!['stable', 'beta'].includes(channel) || versionChannel(currentVersion) !== channel) throw new Error('当前版本与更新通道不匹配。');
  let release;
  try {
    if (channel === 'stable') release = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases/latest`);
    else {
      const releases = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`);
      if (!Array.isArray(releases)) throw new Error('GitHub 更新列表无效。');
      const beta = releases.filter((entry) => { try { return !entry.draft && entry.prerelease && /^v/u.test(entry.tag_name) && versionChannel(entry.tag_name.slice(1)) === 'beta'; } catch (_) { return false; } });
      release = beta.sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
    }
  } catch (error) { if (error.statusCode !== 404) throw error; }
  if (!release) return { status: 'current', currentVersion, version: currentVersion, checkedAt: new Date().toISOString() };
  if (release.draft !== false || release.prerelease !== (channel === 'beta') || !/^v/u.test(release.tag_name || '') || versionChannel(release.tag_name.slice(1)) !== channel) throw new Error('GitHub 发布状态与当前通道不匹配。');
  const latest = release.tag_name.slice(1), comparison = compareVersions(latest, currentVersion);
  if (comparison <= 0) return { status: comparison < 0 ? 'ahead' : 'current', currentVersion, version: latest, checkedAt: new Date().toISOString() };
  const manifests = release.assets?.filter((item) => item.name === 'update-manifest.json');
  if (manifests?.length !== 1 || manifests[0].state !== 'uploaded' || manifests[0].size > 64 * 1024 || manifests[0].browser_download_url !== assetURL(release.tag_name, 'update-manifest.json')) throw new Error('该版本尚未完整提供应用内更新，请稍后重试。');
  const payload = await fetcher(manifests[0].browser_download_url, { maxBytes: 64 * 1024 });
  return { status: 'available', currentVersion, checkedAt: new Date().toISOString(), ...validateReleaseManifest(payload, { channel, platform, arch, release }) };
}
module.exports = { REPOSITORY, parseVersion, compareVersions, versionChannel, assetURL, safeNetworkURL, fetchJSON, base64Digest, validateReleaseManifest, findReleaseUpdate };
