'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPOSITORY } = require('../scripts/release-pipeline.cjs');
const { verifyPublishedMacRelease } = require('./published_mac_release.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-published-mac-release-'));
const key = crypto.generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const version = '0.6.9', tag = `v${version}`, commit = 'a'.repeat(40);
const archiveName = `Guzi-Scholar-${version}-arm64-stable.zip`;
const hash = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest(algorithm === 'sha256' ? 'hex' : 'base64');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const record = (name, bytes) => ({ name, size: bytes.length, sha256: hash(bytes), sha512: hash(bytes, 'sha512') });
let count = 0;

function fixture({ editManifest = () => {}, editProvenance = () => {}, digests = true } = {}) {
  const directory = path.join(root, String(++count));
  fs.mkdirSync(directory);
  const archive = Buffer.from('An offline archive fixture signed only for these unit tests.');
  const mac = { ...record(archiveName, archive), platform: 'darwin', arch: 'arm64', kind: 'sparkle', minimum_system_version: '12.0', ed_signature: crypto.sign(null, archive, key.privateKey).toString('base64'), url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${archiveName}` };
  const manifest = { schema: 2, repository: REPOSITORY, version, channel: 'stable', published_at: '2026-10-26T18:46:33.288Z', artifacts: [mac] };
  editManifest(manifest);
  const payloads = new Map([[archiveName, archive], [`Guzi-Scholar-${version}-arm64-stable.dmg`, Buffer.from('not downloaded DMG')], ['third-party-source.tar.gz', Buffer.from('not downloaded source')], ['update-manifest.json', jsonBytes(manifest)]]);
  const provenance = { schema: 1, repository: REPOSITORY, version, tag, channel: 'stable', commit, source: `https://github.com/${REPOSITORY}/commit/${commit}`, sparkle_public_key: publicKey, assets: [...payloads].map(([name, bytes]) => record(name, bytes)) };
  editProvenance(provenance);
  payloads.set('release-provenance.json', jsonBytes(provenance));
  payloads.set('SHA256SUMS', Buffer.from([...payloads].map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join('')));
  const id = 100;
  const release = { id, url: `https://api.github.com/repos/${REPOSITORY}/releases/${id}`, assets_url: `https://api.github.com/repos/${REPOSITORY}/releases/${id}/assets`, html_url: `https://github.com/${REPOSITORY}/releases/tag/${tag}`, tag_name: tag, target_commitish: commit, draft: false, prerelease: false, published_at: '2026-10-26T18:57:11Z', assets: [...payloads].map(([name, bytes], index) => ({ id: index + 1, name, size: bytes.length, state: 'uploaded', url: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${index + 1}`, browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`, ...(digests ? { digest: `sha256:${hash(bytes)}` } : {}) })) };
  for (const name of [archiveName, 'update-manifest.json', 'release-provenance.json', 'SHA256SUMS']) fs.writeFileSync(path.join(directory, name), payloads.get(name));
  const releaseFile = path.join(directory, 'github-release.json');
  const writeRelease = () => fs.writeFileSync(releaseFile, jsonBytes(release));
  writeRelease();
  return { directory, archive, release, writeRelease };
}

function verify(value, options = {}) { return verifyPublishedMacRelease(value.directory, { version, publicKey, ...options }); }
function rejects(edit, expected, options) {
  const value = fixture(options);
  edit(value);
  value.writeRelease();
  assert.throws(() => verify(value), expected);
}

try {
  const value = fixture();
  const result = verify(value);
  assert.equal(result.archive, path.join(value.directory, archiveName));
  assert.equal(result.archiveName, archiveName);
  assert.equal(result.version, version);
  assert.equal(result.tag, tag);
  assert.equal(result.commit, commit);
  assert.equal(result.publicKey, publicKey);
  assert.equal(result.sha256, hash(value.archive));
  assert.equal(result.sha512, hash(value.archive, 'sha512'));
  assert.equal(result.edSignature, result.manifest.artifacts[0].ed_signature);
  assert.deepEqual(result.release, value.release);
  assert.equal(result.provenance.source, `https://github.com/${REPOSITORY}/commit/${commit}`);
  assert.equal(fs.readdirSync(value.directory).length, 5, 'Selective download needs no DMG or source archive');
  assert.equal(verify(fixture({ digests: false })).version, version, 'Older GitHub metadata may omit digests');

  assert.throws(() => verify(value, { version: '0.6.10' }), /tag URL|version mismatch/u);
  assert.throws(() => verify(value, { version: '0.6.9-beta.1' }), /stable release/u);
  assert.throws(() => verify(value, { publicKey: 'invalid' }), /Pinned Sparkle/u);
  assert.throws(() => verify(value, { publicKey: Buffer.alloc(32).toString('base64') }), /pinned application key/u);
  rejects(({ release }) => { release.draft = true; }, /original published/u);
  rejects(({ release }) => { release.prerelease = true; }, /Stable published/u);
  rejects(({ release }) => { release.url = release.url.replace(REPOSITORY, 'attacker/fork'); }, /repository mismatch/u);
  rejects(({ release }) => { release.tag_name = 'v0.6.8'; }, /version mismatch/u);
  rejects(({ release }) => { release.target_commitish = 'b'.repeat(40); }, /commit differs/u);
  rejects(({ release }) => { release.assets[0].browser_download_url += '?other=1'; }, /download URL/u);
  rejects(({ release }) => { release.assets[0].digest = `sha256:${'0'.repeat(64)}`; }, /checksum mismatch/u);
  rejects(({ release }) => { release.assets[0].digest = 'sha512:invalid'; }, /Invalid GitHub asset digest/u);
  rejects(({ release }) => { release.assets.push(release.assets[0]); }, /duplicate GitHub asset/u);
  rejects(({ release }) => { release.assets[0].size++; }, /Provenance size mismatch/u);
  rejects(({ directory }) => { fs.appendFileSync(path.join(directory, 'SHA256SUMS'), '0'.repeat(64)); }, /size mismatch/u);
  rejects(({ directory }) => { const file = path.join(directory, archiveName); const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes); }, /digest mismatch/u);
  rejects(({ directory }) => { fs.appendFileSync(path.join(directory, 'update-manifest.json'), ' '); }, /size mismatch/u);
  rejects(({ directory }) => { fs.appendFileSync(path.join(directory, 'release-provenance.json'), ' '); }, /size mismatch/u);
  rejects(() => {}, /provenance repository mismatch/u, { editProvenance: (provenance) => { provenance.repository = 'attacker/fork'; } });
  rejects(() => {}, /provenance source mismatch/u, { editProvenance: (provenance) => { provenance.source += '?other=1'; } });
  rejects(() => {}, /Provenance checksum mismatch/u, { editProvenance: (provenance) => { provenance.assets[0].sha256 = '0'.repeat(64); } });
  rejects(() => {}, /Provenance must cover/u, { editProvenance: (provenance) => { provenance.assets.pop(); } });
  rejects(() => {}, /duplicate provenance/u, { editProvenance: (provenance) => { provenance.assets.push(provenance.assets[0]); } });
  rejects(() => {}, /Manifest version mismatch/u, { editManifest: (manifest) => { manifest.version = '0.6.8'; } });
  rejects(() => {}, /仓库身份不匹配/u, { editManifest: (manifest) => { manifest.repository = 'attacker/fork'; } });
  rejects(() => {}, /Ed25519 signature invalid/u, { editManifest: (manifest) => { manifest.artifacts[0].ed_signature = Buffer.alloc(64).toString('base64'); } });
  rejects(() => {}, /Archive SHA512 mismatch/u, { editManifest: (manifest) => { manifest.artifacts[0].sha512 = Buffer.alloc(64).toString('base64'); }, editProvenance: (provenance) => { provenance.assets[0].sha512 = Buffer.alloc(64).toString('base64'); } });
  rejects(({ directory, release }) => {
    const file = path.join(directory, 'SHA256SUMS');
    const bytes = Buffer.from(fs.readFileSync(file, 'utf8').split('\n').filter((line) => !line.endsWith('update-manifest.json')).join('\n'));
    fs.writeFileSync(file, bytes);
    Object.assign(release.assets.find((asset) => asset.name === 'SHA256SUMS'), { size: bytes.length, digest: `sha256:${hash(bytes)}` });
  }, /cover every published asset/u);
  rejects(({ directory, release }) => {
    const file = path.join(directory, 'SHA256SUMS');
    const bytes = Buffer.concat([fs.readFileSync(file), Buffer.from(`${'0'.repeat(64)}  ../escape\n`)]);
    fs.writeFileSync(file, bytes);
    Object.assign(release.assets.find((asset) => asset.name === 'SHA256SUMS'), { size: bytes.length, digest: `sha256:${hash(bytes)}` });
  }, /Invalid or duplicate SHA256SUMS/u);
  rejects(({ directory }) => {
    const archive = path.join(directory, archiveName);
    fs.renameSync(archive, `${archive}.original`);
    fs.symlinkSync(`${archive}.original`, archive);
  }, /Regular published file/u);
  console.log('published Mac release verification tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
