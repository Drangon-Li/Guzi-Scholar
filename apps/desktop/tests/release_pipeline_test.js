'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { identity, preflight, prepare, draft, review, promote, acceptance, REPOSITORY, sha256, sha512, ACCEPTANCE_CHECKS, downloadCandidate, verifiedAssets } = require('../scripts/release-pipeline.cjs');
const { sign } = require('../scripts/release-sign-mac.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-release-test-'));
const key = crypto.generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const context = { schema: 1, repository: REPOSITORY, tag: 'v0.6.3', version: '0.6.3', channel: 'stable', commit: 'a'.repeat(40) };
const signing = (bytes) => crypto.sign(null, bytes, key.privateKey).toString('base64');
let count = 0;
function fixture(channel = 'stable') {
  const directory = path.join(root, `candidate-${++count}`);
  fs.mkdirSync(directory);
  const build = channel === 'stable' ? { ...context } : { ...context, tag: 'v0.6.3-beta.1', version: '0.6.3-beta.1', channel: 'beta' };
  const name = `Guzi-Scholar-${build.version}-arm64-${channel}.zip`;
  const win = `Guzi-Scholar-${build.version}-windows-x64-setup.exe`;
  const bytes = Buffer.from(`mac archive ${channel}`);
  fs.writeFileSync(path.join(directory, name), bytes);
  fs.writeFileSync(path.join(directory, `Guzi-Scholar-${build.version}-arm64-${channel}.dmg`), 'dmg candidate');
  fs.writeFileSync(path.join(directory, win), 'NSIS candidate');
  fs.writeFileSync(path.join(directory, `${win}.blockmap`), 'blockmap candidate');
  const exe = fs.readFileSync(path.join(directory, win));
  fs.writeFileSync(path.join(directory, channel === 'stable' ? 'latest.yml' : 'beta.yml'), `version: ${build.version}\nfiles:\n  - url: ${win}\n    sha512: ${sha512(exe)}\n    size: ${exe.length}\npath: ${win}\nsha512: ${sha512(exe)}\n`);
  const signature = { name, public_key: publicKey, ed_signature: signing(bytes) };
  return { directory, build, signature, name, win };
}
function reports(manifest, build = context) {
  return Object.fromEntries(manifest.artifacts.map((artifact) => [artifact.platform, { ...build, schema: 1, passed: true, platform: artifact.platform, arch: artifact.arch, artifact_sha256: artifact.sha256, from_version: '0.6.2', to_version: build.version, environment: artifact.platform === 'darwin' ? 'macOS 14 arm64 real install' : 'Windows 11 x64 real NSIS install', checks: Object.fromEntries(ACCEPTANCE_CHECKS.map((name) => [name, true])) }]));
}
class FakeAPI {
  constructor() { this.items = []; this.mutations = []; this.payloads = new Map(); this.nextID = 1; }
  async releases() { return this.items; }
  async assets(release) { return [...this.payloads.values()].filter((asset) => asset.release === release.id).map(({ bytes, ...asset }) => asset); }
  async download(asset) { return this.payloads.get(asset.id).bytes; }
  async request(route, options = {}) {
    if (route.startsWith('/commits/')) return { sha: context.commit };
    if (route.startsWith('/compare/')) return { status: 'ahead', merge_base_commit: { sha: context.commit } };
    if (route.startsWith('/actions/runs/')) return { head_sha: context.commit, conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/release-acceptance.yml' };
    this.mutations.push([route, options.method]);
    if (route === '/releases') {
      const release = { ...JSON.parse(options.body), id: this.nextID++ };
      this.items.push(release);
      return release;
    }
    if (route.startsWith('https://uploads.github.com/')) {
      const url = new URL(route);
      const id = this.nextID++;
      const asset = { id, name: url.searchParams.get('name'), release: Number(/releases\/(\d+)/u.exec(route)[1]), size: options.body.length, bytes: Buffer.from(options.body) };
      this.payloads.set(id, asset);
      return asset;
    }
    if (options.method === 'PATCH') {
      Object.assign(this.items[0], JSON.parse(options.body));
      return this.items[0];
    }
    throw new Error(`Unexpected fake request: ${route}`);
  }
}
async function main() {
  assert.equal(identity('v0.6.3', '0.6.3'), 'stable');
  assert.equal(identity('v0.6.3-beta.1', '0.6.3-beta.1'), 'beta');
  for (const tag of ['v0.6.3-dev', 'v0.6.3-rc.1', 'v01.2.3', 'v0.6.3\n', 'v0.6.3-beta.01']) assert.throws(() => identity(tag, tag.slice(1)));
  assert.throws(() => identity('v0.6.3', '0.6.2'), /match/u);
  const repo = path.join(root, 'repository');
  fs.mkdirSync(path.join(repo, 'apps/desktop'), { recursive: true });
  for (const file of ['package.json', 'apps/desktop/package.json', 'package-lock.json', 'apps/desktop/package-lock.json']) fs.writeFileSync(path.join(repo, file), JSON.stringify({ version: context.version, packages: { '': { version: context.version } } }));
  const git = (args) => args[0] === 'rev-parse' ? context.commit : '';
  assert.deepEqual(preflight(repo, context.tag, REPOSITORY, git), context);
  assert.throws(() => preflight(repo, context.tag, 'old-owner/Guzi-Scholar', git), /canonical/u);
  assert.throws(() => preflight(repo, context.tag, REPOSITORY, (args) => { if (args[0] === 'merge-base') throw new Error('not ancestor'); return context.commit; }), /ancestor/u);
  fs.writeFileSync(path.join(repo, 'apps/desktop/package-lock.json'), JSON.stringify({ version: '0.6.2' }));
  assert.throws(() => preflight(repo, context.tag, REPOSITORY, git), /Version mismatch/u);

  const candidate = fixture();
  const manifest = prepare(candidate.directory, candidate.build, candidate.signature);
  assert.deepEqual(Object.keys(manifest).sort(), ['schema', 'repository', 'version', 'channel', 'published_at', 'notes', 'artifacts'].sort());
  assert.equal(manifest.artifacts.length, 2);
  assert.equal(manifest.artifacts[0].minimum_system_version, '12.0');
  assert.equal(manifest.artifacts[1].minimum_system_version, '10.0.18362');
  assert.throws(() => prepare(candidate.directory, candidate.build, candidate.signature), /overwrite/u);
  const beta = fixture('beta');
  assert.equal(prepare(beta.directory, beta.build, beta.signature).channel, 'beta');
  const wrongFeed = fixture('beta');
  fs.writeFileSync(path.join(wrongFeed.directory, 'latest.yml'), 'wrong feed');
  assert.throws(() => prepare(wrongFeed.directory, wrongFeed.build, wrongFeed.signature), /Cross-channel/u);
  const wrongSignature = fixture();
  wrongSignature.signature.ed_signature = crypto.randomBytes(64).toString('base64');
  assert.throws(() => prepare(wrongSignature.directory, wrongSignature.build, wrongSignature.signature), /signature/u);
  let executions = 0;
  assert.throws(() => sign({ archive: path.join(candidate.directory, candidate.name), app: 'x', signer: 'x', publicKey, privateKey: '', execute: () => { executions += 1; } }), /required/u);
  assert.equal(executions, 0, 'Missing private key must not invoke any signer or keychain');
  const signed = sign({ archive: path.join(candidate.directory, candidate.name), app: 'x', signer: 'sign_update', publicKey, privateKey: 'TEST_PRIVATE_KEY', execute: (file, args, options) => {
    if (file === '/usr/bin/plutil') return publicKey;
    assert.deepEqual(args.slice(0, 2), ['--ed-key-file', '-']);
    assert.equal(options.input, 'TEST_PRIVATE_KEY\n');
    assert(!Object.hasOwn(options.env, 'SPARKLE_PRIVATE_KEY'));
    return candidate.signature.ed_signature;
  } });
  assert.equal(signed.ed_signature, candidate.signature.ed_signature);
  assert.throws(() => sign({ archive: path.join(candidate.directory, candidate.name), app: 'x', signer: 'x', publicKey, privateKey: 'TEST', execute: () => 'different-key' }), /differs/u);

  const moved = new FakeAPI();
  const ordinaryRequest = moved.request.bind(moved);
  moved.request = (route, options) => route.startsWith('/commits/') ? Promise.resolve({ sha: 'b'.repeat(40) }) : ordinaryRequest(route, options);
  await assert.rejects(draft(moved, candidate.directory, context), /Remote tag moved/u);
  assert.equal(moved.mutations.length, 0);
  const api = new FakeAPI();
  const release = await draft(api, candidate.directory, context);
  assert.equal(release.draft, true);
  const before = api.mutations.length;
  await assert.rejects(draft(api, candidate.directory, context), /already exists/u);
  assert.equal(api.mutations.length, before, 'Existing draft cannot be changed');
  const evidence = reports(manifest);
  await review(api, context, evidence, publicKey);
  const downloaded = path.join(root, 'downloaded-candidate');
  assert.deepEqual(await downloadCandidate(api, downloaded, context, publicKey), manifest);
  const remoteAssets = await api.assets(release);
  assert.deepEqual(fs.readdirSync(downloaded).sort(), remoteAssets.map((asset) => asset.name).sort());
  for (const asset of remoteAssets) assert.deepEqual(fs.readFileSync(path.join(downloaded, asset.name)), await api.download(asset), `Downloaded candidate must remain byte-identical: ${asset.name}`);
  const checksumAsset = remoteAssets.find((asset) => asset.name === 'SHA256SUMS');
  assert.deepEqual(fs.readFileSync(path.join(downloaded, 'SHA256SUMS')), await api.download(checksumAsset), 'Native harnesses require the original remote SHA256SUMS bytes');
  assert.doesNotThrow(() => require('./mac_release_acceptance.js').verifyCandidateDirectory(downloaded, context, publicKey), 'Downloaded bundle must satisfy the macOS native harness file contract');
  assert.doesNotThrow(() => require('./windows_release_acceptance.js').validateBundle(downloaded, context), 'Downloaded bundle must satisfy the Windows native harness file contract');
  await assert.rejects(downloadCandidate(api, downloaded, context, publicKey), /must not already exist/u);
  const wrongKeyDirectory = path.join(root, 'wrong-key-candidate');
  await assert.rejects(downloadCandidate(api, wrongKeyDirectory, context, crypto.randomBytes(32).toString('base64')), /signing key/u);
  assert(!fs.existsSync(wrongKeyDirectory), 'Rejected candidates must not leave an installable directory');
  const hostileAssets = [{ name: 'SHA256SUMS', id: 1 }, { name: '..', id: 2 }];
  await assert.rejects(verifiedAssets({ assets: async () => hostileAssets, download: async () => Buffer.from(`${'0'.repeat(64)}  ..\n`) }, {}), /Invalid SHA256SUMS/u);

  const provenanceAsset = [...api.payloads.values()].find((value) => value.name === 'release-provenance.json');
  const sumsAsset = [...api.payloads.values()].find((value) => value.name === 'SHA256SUMS');
  const originalProvenance = Buffer.from(provenanceAsset.bytes);
  const originalSums = Buffer.from(sumsAsset.bytes);
  const changedProvenance = JSON.parse(originalProvenance);
  changedProvenance.assets.find((value) => value.name === candidate.win).sha256 = '0'.repeat(64);
  provenanceAsset.bytes = Buffer.from(JSON.stringify(changedProvenance));
  provenanceAsset.size = provenanceAsset.bytes.length;
  sumsAsset.bytes = Buffer.from(originalSums.toString('utf8').replace(sha256(originalProvenance), sha256(provenanceAsset.bytes)));
  sumsAsset.size = sumsAsset.bytes.length;
  await assert.rejects(downloadCandidate(api, path.join(root, 'forged-provenance-candidate'), context, publicKey), /Provenance asset mismatch/u);
  provenanceAsset.bytes = originalProvenance;
  provenanceAsset.size = originalProvenance.length;
  sumsAsset.bytes = originalSums;
  sumsAsset.size = originalSums.length;
  await assert.rejects(promote(api, context, evidence, '', publicKey), /run ID/u);
  const realRequest = api.request.bind(api);
  for (const invalidRun of [{ head_sha: 'b'.repeat(40) }, { conclusion: 'failure' }, { event: 'push' }, { path: '.github/workflows/release.yml' }]) {
    api.request = (route, options) => route.startsWith('/actions/runs/') ? Promise.resolve({ head_sha: context.commit, conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/release-acceptance.yml', ...invalidRun }) : realRequest(route, options);
    await assert.rejects(promote(api, context, evidence, '123', publicKey), /exact tag commit/u);
    assert.equal(release.draft, true, 'An unrelated or failed workflow must not publish');
  }
  api.request = realRequest;
  await assert.rejects(promote(api, context, { darwin: evidence.darwin }, '123', publicKey));
  assert.equal(release.draft, true, 'Missing Windows report must not publish');
  const bad = structuredClone(evidence.win32);
  bad.artifact_sha256 = '0'.repeat(64);
  assert.throws(() => acceptance(bad, context, manifest.artifacts[1]), /candidate mismatch/u);
  for (const check of ACCEPTANCE_CHECKS) {
    const failed = structuredClone(evidence.win32);
    failed.checks[check] = false;
    assert.throws(() => acceptance(failed, context, manifest.artifacts[1]), /check failed/u);
  }
  const asset = [...api.payloads.values()].find((value) => value.name === candidate.win);
  const original = Buffer.from(asset.bytes);
  asset.bytes[0] ^= 1;
  await assert.rejects(promote(api, context, evidence, '123', publicKey), /hash mismatch/u);
  const tamperedDownload = path.join(root, 'tampered-remote-candidate');
  await assert.rejects(downloadCandidate(api, tamperedDownload, context, publicKey), /hash mismatch/u);
  assert(!fs.existsSync(tamperedDownload));
  assert.equal(release.draft, true);
  asset.bytes = original;
  await promote(api, context, evidence, '123', publicKey);
  assert.equal(release.draft, false);
  assert.equal(release.make_latest, 'true');
  assert.match(release.body, /应用内更新/u);
  assert.match(release.body, /0\.6\.3/u);
  assert.match(release.body, /Ed25519/u);
  assert.match(release.body, /未使用 Apple Developer ID 签名或公证/u);
  assert.match(release.body, /Windows 安装包未使用发布者证书签名/u);
  assert.match(release.body, /通过 macOS 与 Windows 的升级验收/u);
  assert.doesNotMatch(release.body, /Candidate|待验收|Publication requires/u);
  const publishedMutations = api.mutations.length;
  await assert.rejects(draft(api, candidate.directory, context), /already exists/u);
  await assert.rejects(promote(api, context, evidence, '123', publicKey), /published/u);
  assert.equal(api.mutations.length, publishedMutations);
  const tampered = fixture();
  prepare(tampered.directory, tampered.build, tampered.signature);
  fs.appendFileSync(path.join(tampered.directory, tampered.win), 'tampered');
  const untouched = new FakeAPI();
  await assert.rejects(draft(untouched, tampered.directory, context), /hash mismatch/u);
  assert.equal(untouched.mutations.length, 0, 'Local validation failures must precede draft creation');
  const betaAPI = new FakeAPI();
  const betaManifest = JSON.parse(fs.readFileSync(path.join(beta.directory, 'update-manifest.json')));
  const betaRelease = await draft(betaAPI, beta.directory, beta.build);
  await promote(betaAPI, beta.build, reports(betaManifest, beta.build), '456', publicKey);
  assert.equal(betaRelease.draft, false);
  assert.equal(betaRelease.make_latest, 'false', 'Beta promotion must not replace the stable latest release');
  assert.match(betaRelease.body, /v0\.6\.3-beta\.1/u);
  console.log('release_pipeline_test: passed (tag/version/ancestry, both channels, signatures, immutable drafts, byte-identical downloads, provenance and remote hashes, real acceptance gates, gated release notes)');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
