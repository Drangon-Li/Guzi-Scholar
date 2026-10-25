'use strict';

const https = require('https');

const MAX_MANIFEST_BYTES = 64 * 1024;

function resolveUpdateManifestURL({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const configured = String(env.MY_SCHOLAR_UPDATE_MANIFEST_URL || '').trim();
  if (configured) return configured;
  if (platform === 'darwin' && arch === 'arm64') {
    return 'https://raw.githubusercontent.com/Drangon-Li/Guzi-Scholar/main/release-manifests/macos-arm64.json';
  }
  return '';
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(value || '').trim());
  if (!match) throw new Error('更新服务返回了无效的版本号。');
  return {
    raw: match[0],
    numbers: match.slice(1, 4).map((part) => Number.parseInt(part, 10)),
    prerelease: match[4] || '',
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true }) > 0 ? 1 : -1;
}

function safeURL(value, allowedOrigins, label) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (_) {
    throw new Error(`${label}无效。`);
  }
  if (url.protocol !== 'https:' || !allowedOrigins.has(url.origin)) throw new Error(`${label}不在受信任的 HTTPS 站点。`);
  return url;
}

function validateUpdateManifest(payload, { platform, arch, channel, allowedOrigins }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schema !== 1) {
    throw new Error('更新服务返回了不受支持的数据格式。');
  }
  const version = parseVersion(payload.version).raw;
  if (payload.platform !== platform || payload.arch !== arch || payload.channel !== channel) {
    throw new Error('更新信息与当前设备或更新通道不匹配。');
  }
  const downloadText = String(payload.download_url || '').trim();
  const downloadURL = downloadText ? safeURL(downloadText, allowedOrigins, '更新下载地址').toString() : '';
  const sha256 = String(payload.sha256 || '').trim().toLowerCase();
  if (sha256 && !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('更新文件校验值无效。');
  const notes = String(payload.notes || '').trim().slice(0, 4000);
  const publishedAt = String(payload.published_at || '').trim();
  if (publishedAt && !Number.isFinite(Date.parse(publishedAt))) throw new Error('更新发布时间无效。');
  return {
    version,
    platform,
    arch,
    channel,
    downloadURL,
    sha256,
    notes,
    publishedAt,
    minimumSystemVersion: String(payload.minimum_system_version || '').trim().slice(0, 40),
  };
}

function fetchJSON(url, { timeout = 10000, userAgent = 'GuziScholar' } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`更新服务暂时不可用（HTTP ${response.statusCode || 0}）。`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_MANIFEST_BYTES) {
          request.destroy(new Error('更新信息超过允许大小。'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (_) {
          reject(new Error('更新服务返回的内容无法解析。'));
        }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('检查更新超时，请稍后重试。')));
    request.once('error', reject);
  });
}

async function checkForUpdate({ manifestURL, currentVersion, platform, arch, channel, allowedOrigins, fetcher = fetchJSON }) {
  if (!manifestURL) return { status: 'unavailable', currentVersion: parseVersion(currentVersion).raw, platform, arch, channel };
  const origins = new Set(allowedOrigins);
  const endpoint = safeURL(manifestURL, origins, '更新服务地址');
  const payload = await fetcher(endpoint, { userAgent: `GuziScholar/${currentVersion} (${platform}; ${arch})` });
  const manifest = validateUpdateManifest(payload, { platform, arch, channel, allowedOrigins: origins });
  const comparison = compareVersions(manifest.version, currentVersion);
  if (comparison > 0 && (!manifest.downloadURL || !manifest.sha256)) throw new Error('新版本缺少下载地址或文件校验值。');
  return {
    status: comparison > 0 ? 'available' : (comparison < 0 ? 'ahead' : 'current'),
    currentVersion: parseVersion(currentVersion).raw,
    ...manifest,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  checkForUpdate,
  compareVersions,
  fetchJSON,
  parseVersion,
  resolveUpdateManifestURL,
  validateUpdateManifest,
};
