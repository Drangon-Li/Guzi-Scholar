'use strict';
const assert = require('node:assert/strict');
const { REPOSITORY, compareVersions, parseVersion, versionChannel, assetURL, safeNetworkURL, validateReleaseManifest, findReleaseUpdate } = require('../electron/update-service.cjs');
const { resolveUpdateConfig } = require('../electron/update-config.cjs');
const digest = Buffer.alloc(64, 1).toString('base64');
const tag = 'v0.6.3';
const asset = { platform: 'darwin', arch: 'arm64', kind: 'sparkle', name: 'Guzi-Scholar-0.6.3-arm64-stable.zip', size: 100, sha256: 'a'.repeat(64), sha512: digest, ed_signature: digest, minimum_system_version: '12.0' };
asset.url = assetURL(tag, asset.name);
const manifest = { schema: 2, repository: REPOSITORY, version: '0.6.3', channel: 'stable', published_at: '2026-10-26T00:00:00Z', artifacts: [asset] };
const release = { tag_name: tag, draft: false, prerelease: false, assets: [
  { name: 'update-manifest.json', browser_download_url: assetURL(tag, 'update-manifest.json'), size: 900, state: 'uploaded' },
  { name: asset.name, browser_download_url: asset.url, size: asset.size, state: 'uploaded' },
] };
const options = { channel: 'stable', platform: 'darwin', arch: 'arm64', release };
async function main() {
  for (const [left, right, expected] of [['1.2.3', '1.2.2', 1], ['1.2.3-beta.10', '1.2.3-beta.2', 1], ['1.2.3', '1.2.3-beta.9', 1], ['1.2.3-beta.1', '1.2.3-beta.1', 0], ['1.2.3-beta.2', '1.2.3', -1]]) assert.equal(compareVersions(left, right), expected);
  for (const value of ['01.2.3', '1.2.3-beta.01', '1.2', '1.2.3/../../']) assert.throws(() => parseVersion(value));
  assert.throws(() => versionChannel('1.2.3-alpha.1'));
  for (const url of ['http://github.com/x', 'https://github.com.evil.example/x', 'https://u:p@github.com/x', 'https://127.0.0.1/x']) assert.throws(() => safeNetworkURL(url));
  const found = validateReleaseManifest(manifest, options);
  assert.equal(found.downloadURL, asset.url); assert.equal(found.edSignature, digest); assert.equal(found.size, 100);
  for (const patch of [{ channel: 'beta' }, { repository: 'old/Guzi-Scholar' }, { version: '0.6.4' }, { schema: 1 }, { artifacts: [asset, asset] }]) assert.throws(() => validateReleaseManifest({ ...manifest, ...patch }, options));
  for (const patch of [{ size: 99 }, { sha512: '' }, { ed_signature: '' }, { url: 'https://evil.example/a.zip' }, { minimum_system_version: '' }]) assert.throws(() => validateReleaseManifest({ ...manifest, artifacts: [{ ...asset, ...patch }] }, options));
  for (const patch of [{ draft: true }, { prerelease: true }, { assets: release.assets.slice(0, 1) }]) assert.throws(() => validateReleaseManifest(manifest, { ...options, release: { ...release, ...patch } }));
  const calls = [];
  const result = await findReleaseUpdate({ ...options, currentVersion: '0.6.2', fetcher: async (url) => { calls.push(url); return url.includes('/releases/latest') ? release : manifest; } });
  assert.equal(result.status, 'available'); assert.equal(calls.length, 2);
  assert.equal((await findReleaseUpdate({ ...options, currentVersion: '0.6.3', fetcher: async () => release })).status, 'current');
  await assert.rejects(findReleaseUpdate({ ...options, currentVersion: '0.6.2', fetcher: async () => ({ ...release, draft: true }) }));
  await assert.rejects(findReleaseUpdate({ ...options, currentVersion: '0.6.2-beta.1', fetcher: async () => release }));
  assert.equal((await findReleaseUpdate({ ...options, channel: 'beta', currentVersion: '0.6.3-beta.1', fetcher: async () => [release, { ...release, tag_name: 'v0.6.4-beta.1', draft: true, prerelease: true }] })).status, 'current');
  const metadata = { version: '0.6.2', updater: { enabled: true, channel: 'stable', repository: REPOSITORY, publicKey: Buffer.alloc(32).toString('base64') } };
  const configOptions = { metadata, isPackaged: true, platform: 'darwin', arch: 'arm64' };
  assert.equal(resolveUpdateConfig(configOptions).enabled, true);
  assert.equal(resolveUpdateConfig({ ...configOptions, isPackaged: false }).enabled, false);
  assert.equal(resolveUpdateConfig({ ...configOptions, metadata: { ...metadata, localTestBuild: 'probe' } }).enabled, false);
  assert.equal(resolveUpdateConfig({ ...configOptions, metadata: { ...metadata, updater: { ...metadata.updater, channel: 'beta' } } }).enabled, false);
  assert.equal(resolveUpdateConfig({ ...configOptions, arch: 'x64' }).enabled, false);
  console.log('Release discovery, identity, integrity, channel and build policy tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
