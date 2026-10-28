'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPOSITORY, identity } = require('../scripts/release-pipeline.cjs');
const { validateReleaseManifest } = require('../electron/update-service.cjs');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes) => crypto.createHash('sha512').update(bytes).digest('base64');
const assetName = (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(name);
const canonicalBase64 = (value, size) => typeof value === 'string' && Buffer.from(value, 'base64').length === size && Buffer.from(value, 'base64').toString('base64') === value;

function verifyPublishedMacRelease(directory, { version, publicKey }) {
  const tag = `v${version}`;
  assert.equal(identity(tag, version), 'stable', 'Published source must be a stable release');
  assert(canonicalBase64(publicKey, 32), 'Pinned Sparkle public key required');
  const read = (name) => {
    const filename = path.join(directory, name);
    const stat = fs.lstatSync(filename);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Regular published file required: ${name}`);
    return fs.readFileSync(filename);
  };
  const release = JSON.parse(read('github-release.json'));
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  const downloads = `https://github.com/${REPOSITORY}/releases/download/${tag}/`;
  assert(Number.isSafeInteger(release.id) && release.id > 0, 'Published GitHub release ID required');
  assert.equal(release.url, `${api}/releases/${release.id}`, 'GitHub release repository mismatch');
  assert.equal(release.assets_url, `${release.url}/assets`, 'GitHub assets repository mismatch');
  assert.equal(release.html_url, `https://github.com/${REPOSITORY}/releases/tag/${tag}`, 'GitHub release tag URL mismatch');
  assert.equal(release.tag_name, tag, 'Published version mismatch');
  assert.equal(release.draft, false, 'An original published release is required');
  assert.equal(release.prerelease, false, 'Stable published release required');
  assert(typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)), 'Published release timestamp required');
  assert(Array.isArray(release.assets), 'Published GitHub assets required');
  const assets = new Map();
  const ids = new Set();
  for (const asset of release.assets) {
    assert(assetName(asset.name) && !assets.has(asset.name), 'Invalid or duplicate GitHub asset name');
    assert(Number.isSafeInteger(asset.id) && asset.id > 0 && !ids.has(asset.id), 'Invalid or duplicate GitHub asset ID');
    assert.equal(asset.url, `${api}/releases/assets/${asset.id}`, `GitHub asset repository mismatch: ${asset.name}`);
    assert.equal(asset.browser_download_url, `${downloads}${encodeURIComponent(asset.name)}`, `GitHub asset download URL mismatch: ${asset.name}`);
    assert.equal(asset.state, 'uploaded', `Unfinished GitHub asset: ${asset.name}`);
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, `Invalid GitHub asset size: ${asset.name}`);
    assert(asset.digest == null || /^sha256:[a-f0-9]{64}$/u.test(asset.digest), `Invalid GitHub asset digest: ${asset.name}`);
    assets.set(asset.name, asset);
    ids.add(asset.id);
  }
  const verifyBytes = (name, bytes) => {
    const asset = assets.get(name);
    assert(asset, `Published GitHub asset missing: ${name}`);
    assert.equal(bytes.length, asset.size, `Published size mismatch: ${name}`);
    if (asset.digest != null) assert.equal(asset.digest, `sha256:${sha256(bytes)}`, `GitHub asset digest mismatch: ${name}`);
  };
  const sumsBytes = read('SHA256SUMS');
  verifyBytes('SHA256SUMS', sumsBytes);
  const sums = new Map();
  for (const line of sumsBytes.toString('utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._-]{0,180})$/u.exec(line);
    assert(match && match[2] !== 'SHA256SUMS' && !sums.has(match[2]), 'Invalid or duplicate SHA256SUMS entry');
    const asset = assets.get(match[2]);
    assert(asset, `Checksummed GitHub asset missing: ${match[2]}`);
    if (asset.digest != null) assert.equal(asset.digest, `sha256:${match[1]}`, `GitHub checksum mismatch: ${match[2]}`);
    sums.set(match[2], match[1]);
  }
  assert.equal(sums.size + 1, assets.size, 'SHA256SUMS must cover every published asset');
  const readChecked = (name) => {
    const bytes = read(name);
    verifyBytes(name, bytes);
    assert.equal(sums.get(name), sha256(bytes), `Published checksum mismatch: ${name}`);
    return bytes;
  };
  const provenance = JSON.parse(readChecked('release-provenance.json'));
  assert.equal(provenance.schema, 1, 'Published provenance schema mismatch');
  for (const [key, value] of Object.entries({ repository: REPOSITORY, tag, version, channel: 'stable' })) assert.equal(provenance[key], value, `Published provenance ${key} mismatch`);
  assert.match(provenance.commit, /^[a-f0-9]{40}$/u, 'Published provenance commit required');
  assert.equal(provenance.source, `https://github.com/${REPOSITORY}/commit/${provenance.commit}`, 'Published provenance source mismatch');
  assert.equal(release.target_commitish, provenance.commit, 'Published release commit differs from provenance');
  assert.equal(provenance.sparkle_public_key, publicKey, 'Published signing key differs from pinned application key');
  assert(Array.isArray(provenance.assets), 'Published provenance assets required');
  const records = new Map();
  for (const record of provenance.assets) {
    assert(assetName(record.name) && !['SHA256SUMS', 'release-provenance.json'].includes(record.name) && !records.has(record.name), 'Invalid or duplicate provenance asset');
    assert(Number.isSafeInteger(record.size) && record.size > 0 && canonicalBase64(record.sha512, 64), `Invalid provenance asset metadata: ${record.name}`);
    assert.equal(record.sha256, sums.get(record.name), `Provenance checksum mismatch: ${record.name}`);
    assert.equal(record.size, assets.get(record.name)?.size, `Provenance size mismatch: ${record.name}`);
    records.set(record.name, record);
  }
  assert.equal(records.size + 2, assets.size, 'Provenance must cover every published payload');
  const manifestBytes = readChecked('update-manifest.json');
  const manifestRecord = records.get('update-manifest.json');
  assert(manifestRecord, 'Manifest provenance required');
  assert.equal(manifestRecord.sha512, sha512(manifestBytes), 'Manifest provenance SHA512 mismatch');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.version, version, 'Manifest version mismatch');
  const candidate = validateReleaseManifest(manifest, { platform: 'darwin', arch: 'arm64', channel: 'stable', release });
  const archiveName = `Guzi-Scholar-${version}-arm64-stable.zip`;
  assert.equal(candidate.assetName, archiveName, 'Published archive identity mismatch');
  const record = records.get(archiveName);
  assert(record, 'Archive provenance required');
  for (const key of ['size', 'sha256', 'sha512']) assert.equal(record[key], candidate[key], `Archive provenance ${key} mismatch`);
  const bytes = readChecked(archiveName);
  assert.equal(bytes.length, candidate.size, 'Archive size mismatch');
  assert.equal(sha512(bytes), candidate.sha512, 'Archive SHA512 mismatch');
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
  assert(crypto.verify(null, bytes, key, Buffer.from(candidate.edSignature, 'base64')), 'Published Ed25519 signature invalid');
  return { version, tag, archive: path.resolve(directory, archiveName), archiveName, sha256: candidate.sha256, sha512: candidate.sha512, edSignature: candidate.edSignature, publicKey, manifest, release, provenance, commit: provenance.commit };
}

module.exports = { verifyPublishedMacRelease };
