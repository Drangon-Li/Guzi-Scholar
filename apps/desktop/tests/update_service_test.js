'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  checkForUpdate,
  compareVersions,
  resolveUpdateManifestURL,
  validateUpdateManifest,
} = require('../electron/update-service.cjs');

const allowedOrigins = ['https://82.156.152.27', 'https://guzilab.com'];
const manifest = {
  schema: 1,
  version: '0.1.1',
  platform: 'darwin',
  arch: 'arm64',
  channel: 'beta',
  published_at: '2026-08-06T00:00:00Z',
  notes: '修复旧版文献库恢复。',
  download_url: 'https://82.156.152.27/updates/macos/arm64/Guzi-Scholar-0.1.1.dmg',
  sha256: 'a'.repeat(64),
};

async function main() {
  const macManifestURL = 'https://raw.githubusercontent.com/Drangon-Li/Guzi-Scholar/main/release-manifests/macos-arm64.json';
  assert.equal(resolveUpdateManifestURL({ env: {}, platform: 'darwin', arch: 'arm64' }), macManifestURL);
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['linux', 'x64']]) {
    assert.equal(resolveUpdateManifestURL({ env: {}, platform, arch }), '');
    assert.equal(resolveUpdateManifestURL({ env: { MY_SCHOLAR_UPDATE_MANIFEST_URL: ' https://guzilab.com/real-manifest.json ' }, platform, arch }), 'https://guzilab.com/real-manifest.json');
  }
  const unavailable = await checkForUpdate({
    manifestURL: resolveUpdateManifestURL({ env: {}, platform: 'win32', arch: 'x64' }),
    currentVersion: '0.1.0', platform: 'win32', arch: 'x64', channel: 'beta', allowedOrigins,
    fetcher: () => assert.fail('An unconfigured Windows update must not fetch the macOS manifest'),
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.currentVersion, '0.1.0');
  assert.equal(unavailable.downloadURL, undefined);
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  const handlerSource = mainSource.slice(mainSource.indexOf("ipcMain.handle('my-scholar:check-for-updates'"), mainSource.indexOf("ipcMain.handle('my-scholar:open-update-download'"));
  let handler;
  const context = vm.createContext({
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    requireMainWindowSender: () => {}, isolatedBuild: false, checkForUpdate,
    UPDATE_MANIFEST_URL: '', UPDATE_ALLOWED_ORIGINS: allowedOrigins, UPDATE_CHANNEL: 'beta',
    app: { getVersion: () => '0.1.0' }, process: { platform: 'win32', arch: 'x64' },
    availableUpdate: { downloadURL: 'https://guzilab.com/stale-update.exe' }, diagnosticLog: () => {},
  });
  vm.runInContext(handlerSource, context);
  const response = await handler({});
  assert.equal(response.ok, false);
  assert.equal(response.status, 'unavailable');
  assert.match(response.error, /尚未配置更新服务/u);
  assert.equal(context.availableUpdate, null, 'An unavailable check must clear any stale download');
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0-beta.2', '0.1.0-beta.1'), 1);
  assert.equal(compareVersions('0.1.0-beta.1', '0.1.0'), -1);

  const validated = validateUpdateManifest(manifest, {
    platform: 'darwin', arch: 'arm64', channel: 'beta', allowedOrigins: new Set(allowedOrigins),
  });
  assert.equal(validated.version, '0.1.1');
  assert.equal(validated.downloadURL, manifest.download_url);
  assert.throws(
    () => validateUpdateManifest({ ...manifest, download_url: 'https://example.com/update.dmg' }, {
      platform: 'darwin', arch: 'arm64', channel: 'beta', allowedOrigins: new Set(allowedOrigins),
    }),
    /受信任/,
  );
  assert.throws(
    () => validateUpdateManifest({ ...manifest, arch: 'x64' }, {
      platform: 'darwin', arch: 'arm64', channel: 'beta', allowedOrigins: new Set(allowedOrigins),
    }),
    /不匹配/,
  );

  const available = await checkForUpdate({
    manifestURL: 'https://82.156.152.27/updates/macos/arm64/beta.json',
    currentVersion: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    channel: 'beta',
    allowedOrigins,
    fetcher: async () => manifest,
  });
  assert.equal(available.status, 'available');
  assert.equal(available.version, '0.1.1');

  const windowsAvailable = await checkForUpdate({
    manifestURL: resolveUpdateManifestURL({ env: { MY_SCHOLAR_UPDATE_MANIFEST_URL: 'https://guzilab.com/windows.json' }, platform: 'win32', arch: 'x64' }),
    currentVersion: '0.1.0', platform: 'win32', arch: 'x64', channel: 'beta', allowedOrigins,
    fetcher: async (endpoint) => {
      assert.equal(endpoint.toString(), 'https://guzilab.com/windows.json');
      return { ...manifest, platform: 'win32', arch: 'x64', download_url: 'https://guzilab.com/Guzi-Scholar-0.1.1-x64.exe' };
    },
  });
  assert.equal(windowsAvailable.status, 'available');
  assert.equal(windowsAvailable.platform, 'win32');
  await assert.rejects(checkForUpdate({
    manifestURL: 'https://guzilab.com/windows.json', currentVersion: '0.1.0',
    platform: 'win32', arch: 'x64', channel: 'beta', allowedOrigins, fetcher: async () => manifest,
  }), /不匹配/u);

  const current = await checkForUpdate({
    manifestURL: 'https://82.156.152.27/updates/macos/arm64/beta.json',
    currentVersion: '0.1.0',
    platform: 'darwin',
    arch: 'arm64',
    channel: 'beta',
    allowedOrigins,
    fetcher: async () => ({ ...manifest, version: '0.1.0', download_url: '', sha256: '' }),
  });
  assert.equal(current.status, 'current');

  await assert.rejects(
    checkForUpdate({
      manifestURL: 'https://82.156.152.27/updates/macos/arm64/beta.json',
      currentVersion: '0.1.0',
      platform: 'darwin', arch: 'arm64', channel: 'beta', allowedOrigins,
      fetcher: async () => ({ ...manifest, sha256: '' }),
    }),
    /缺少下载地址或文件校验值/,
  );
  console.log('update service tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
