'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const REPOSITORY = 'Drangon-Li/Guzi-Scholar';
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/u;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes) => crypto.createHash('sha512').update(bytes).digest('base64');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
function assert(value, message) { if (!value) throw new Error(message); }

function identity(tag, version) {
  assert(TAG.test(tag), 'Tag must be vX.Y.Z or vX.Y.Z-beta.N');
  assert(tag === `v${version}`, 'Tag and application version must match exactly');
  return tag.includes('-beta.') ? 'beta' : 'stable';
}

function preflight(root, tag, repository = process.env.GITHUB_REPOSITORY || REPOSITORY, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()) {
  assert(repository === REPOSITORY, 'Publishing is restricted to the canonical public repository');
  const rootMetadata = json(path.join(root, 'package.json'));
  assert(!rootMetadata.localTestBuild && !rootMetadata.build?.extraMetadata?.localTestBuild, 'Local test builds cannot enter the release pipeline');
  const version = rootMetadata.version;
  const channel = identity(tag, version);
  for (const file of ['apps/desktop/package.json', 'package-lock.json', 'apps/desktop/package-lock.json']) {
    const metadata = json(path.join(root, file));
    assert(!metadata.localTestBuild && !metadata.build?.extraMetadata?.localTestBuild, 'Local test builds cannot enter the release pipeline');
    assert(metadata.version === version, `Version mismatch: ${file}`);
    if (file.endsWith('lock.json')) assert(metadata.packages?.['']?.version === version, `Lock root version mismatch: ${file}`);
  }
  const commit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  assert(/^[a-f0-9]{40}$/u.test(commit), 'Invalid tag commit');
  assert(git(['rev-parse', 'HEAD']) === commit, 'Checkout must exactly match the tag commit');
  git(['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
  return { schema: 1, repository, tag, commit, version, channel };
}

function fileRecord(directory, name) {
  assert(name === path.basename(name) && !/[\r\n\\]/u.test(name), 'Unsafe asset name');
  const file = path.join(directory, name);
  assert(fs.lstatSync(file).isFile(), `Regular asset required: ${name}`);
  const bytes = fs.readFileSync(file);
  assert(bytes.length > 0, `Empty asset: ${name}`);
  return { name, size: bytes.length, sha256: sha256(bytes), sha512: sha512(bytes) };
}

function prepare(directory, context, signature, { publishedAt = new Date().toISOString(), notes = '' } = {}) {
  assert(context.repository === REPOSITORY && /^[a-f0-9]{40}$/u.test(context.commit), 'Invalid build context');
  assert(identity(context.tag, context.version) === context.channel, 'Channel mismatch');
  assert(!fs.existsSync(path.join(directory, 'SHA256SUMS')), 'Refusing to overwrite an existing release bundle');
  const names = fs.readdirSync(directory).sort();
  const mac = names.filter((name) => name === `Guzi-Scholar-${context.version}-arm64-${context.channel}.zip`);
  const win = names.filter((name) => name === `Guzi-Scholar-${context.version}-windows-x64-setup.exe`);
  assert(mac.length === 1 && win.length === 1, 'Exactly one macOS updater ZIP and Windows NSIS installer required');
  assert(names.some((name) => name.endsWith('.dmg')), 'macOS DMG is required');
  assert(names.includes(`${win[0]}.blockmap`), 'Windows blockmap is required');
  const feedName = context.channel === 'stable' ? 'latest.yml' : 'beta.yml';
  assert(names.includes(feedName), `Windows ${feedName} is required`);
  assert(!names.includes(context.channel === 'stable' ? 'beta.yml' : 'latest.yml'), 'Cross-channel Windows feed rejected');
  const records = names.map((name) => fileRecord(directory, name));
  const feed = fs.readFileSync(path.join(directory, feedName), 'utf8');
  const installer = records.find((record) => record.name === win[0]);
  assert(new RegExp(`^version: ['"]?${context.version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]?\\s*$`, 'mu').test(feed), 'Windows feed version mismatch');
  assert(feed.includes(win[0]) && feed.includes(installer.sha512) && feed.includes(String(installer.size)), 'Windows feed does not describe the candidate installer');
  assert(feed.split(/\r?\n/u).some((line) => [`path: ${win[0]}`, `path: '${win[0]}'`, `path: "${win[0]}"`].includes(line)), 'Windows feed must point to the candidate installer');
  assert(feed.split(/\r?\n/u).some((line) => [`sha512: ${installer.sha512}`, `sha512: '${installer.sha512}'`, `sha512: "${installer.sha512}"`].includes(line)), 'Windows feed root checksum mismatch');
  assert(signature.name === mac[0], 'Sparkle signature belongs to another archive');
  const macBytes = fs.readFileSync(path.join(directory, mac[0]));
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signature.public_key, 'base64')]), format: 'der', type: 'spki' });
  assert(crypto.verify(null, macBytes, key, Buffer.from(signature.ed_signature, 'base64')), 'Invalid Sparkle archive signature');
  const artifacts = [
    { ...records.find((record) => record.name === mac[0]), platform: 'darwin', arch: 'arm64', kind: 'sparkle', minimum_system_version: '12.0', ed_signature: signature.ed_signature },
    { ...installer, platform: 'win32', arch: 'x64', kind: 'nsis', minimum_system_version: '10.0.18362' },
  ].map((artifact) => ({ ...artifact, url: `https://github.com/${REPOSITORY}/releases/download/${context.tag}/${encodeURIComponent(artifact.name)}` }));
  const manifest = { schema: 2, repository: REPOSITORY, version: context.version, channel: context.channel, published_at: publishedAt, notes, artifacts };
  write(path.join(directory, 'update-manifest.json'), manifest);
  records.push(fileRecord(directory, 'update-manifest.json'));
  write(path.join(directory, 'release-provenance.json'), { ...context, source: `https://github.com/${REPOSITORY}/commit/${context.commit}`, signing: { macos: 'ad-hoc; Sparkle Ed25519 verified; not Apple notarized', windows: 'unsigned internal candidate; verify separately before distribution' }, sparkle_public_key: signature.public_key, assets: records });
  records.push(fileRecord(directory, 'release-provenance.json'));
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), records.map((record) => `${record.sha256}  ${record.name}\n`).join(''));
  return manifest;
}

class GitHub {
  constructor(token, fetcher = fetch) { assert(token, 'GH_TOKEN is required'); this.token = token; this.fetch = fetcher; }
  async request(route, options = {}) {
    const url = route.startsWith('https://') ? route : `https://api.github.com/repos/${REPOSITORY}${route}`;
    const response = await this.fetch(url, { ...options, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...options.headers } });
    assert(response.ok, `GitHub request failed (${response.status}) ${new URL(url).pathname}`);
    return options.binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  async releases() {
    const result = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(`/releases?per_page=100&page=${page}`);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
  async assets(release) {
    const result = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(`/releases/${release.id}/assets?per_page=100&page=${page}`);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }
  download(asset) { return this.request(`/releases/assets/${asset.id}`, { binary: true, headers: { Accept: 'application/octet-stream' } }); }
}

async function verifiedAssets(api, release) {
  const assets = await api.assets(release);
  const unique = new Set(assets.map((asset) => asset.name));
  assert(unique.size === assets.length && unique.has('SHA256SUMS'), 'Incomplete or duplicate release assets');
  const checksumAsset = assets.find((asset) => asset.name === 'SHA256SUMS');
  const checksumBytes = await api.download(checksumAsset);
  const sums = checksumBytes.toString('utf8').trim().split('\n').map((line) => {
    const match = /^([a-f0-9]{64}) {2}([^/\\\r\n]+)$/u.exec(line);
    assert(match && !['.', '..', 'SHA256SUMS'].includes(match[2]), 'Invalid SHA256SUMS line');
    return { name: match[2], sha256: match[1] };
  });
  assert(new Set(sums.map((record) => record.name)).size === sums.length, 'Duplicate checksum names');
  assert(sums.length + 1 === assets.length, 'Every release asset must be covered by SHA256SUMS');
  const downloads = new Map([['SHA256SUMS', checksumBytes]]);
  for (const expected of sums) {
    const asset = assets.find((value) => value.name === expected.name);
    assert(asset, `Missing remote asset: ${expected.name}`);
    const bytes = await api.download(asset);
    assert(bytes.length === asset.size && sha256(bytes) === expected.sha256, `Remote size/hash mismatch: ${expected.name}`);
    downloads.set(expected.name, bytes);
  }
  return { assets, downloads };
}

async function remoteContext(api, context) {
  assert(context.repository === REPOSITORY && identity(context.tag, context.version) === context.channel, 'Invalid release context');
  assert(/^[a-f0-9]{40}$/u.test(context.commit), 'Invalid candidate commit');
  const commit = await api.request(`/commits/${encodeURIComponent(context.tag)}`);
  assert(commit.sha === context.commit, 'Remote tag moved or no longer identifies the candidate commit');
  const comparison = await api.request(`/compare/${context.commit}...main`);
  assert(['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === context.commit, 'Candidate is no longer an ancestor of canonical main');
}

async function draft(api, directory, context) {
  const names = fs.readdirSync(directory).sort();
  assert(names.includes('SHA256SUMS') && names.includes('release-provenance.json'), 'Validated release bundle required');
  const provenance = json(path.join(directory, 'release-provenance.json'));
  for (const key of ['repository', 'tag', 'commit', 'version', 'channel']) assert(provenance[key] === context[key], `Provenance ${key} mismatch`);
  const localAssets = names.map((name, id) => ({ name, id, size: fs.statSync(path.join(directory, name)).size }));
  await verifiedAssets({ assets: async () => localAssets, download: async (asset) => fs.readFileSync(path.join(directory, asset.name)) }, {});
  await remoteContext(api, context);
  assert(!(await api.releases()).some((release) => release.tag_name === context.tag), 'A release already exists for this tag; existing drafts and published releases are never overwritten');
  const release = await api.request('/releases', { method: 'POST', body: JSON.stringify({ tag_name: context.tag, target_commitish: context.commit, name: `Guzi Scholar ${context.tag}`, draft: true, prerelease: context.channel === 'beta', body: `Candidate ${context.tag} (${context.commit}).\n\nmacOS: ad-hoc code signing, independently verified Sparkle Ed25519 update signature; not Apple Developer ID signed or notarized. On first launch, Gatekeeper may warn: in Finder right-click 谷子学术.app, choose Open and confirm.\nWindows: unsigned internal candidate.\n\nPublication requires explicit promotion and real upgrade acceptance evidence for both platforms.` }), headers: { 'Content-Type': 'application/json' } });
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(directory, name));
    await api.request(`https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
  }
  await verifiedAssets(api, release);
  return release;
}

const ACCEPTANCE_CHECKS = ['discover', 'download', 'corrupt_rejected', 'save_cancel', 'ordinary_quit', 'relaunch', 'data_preserved'];
function acceptance(report, context, artifact) {
  for (const key of ['repository', 'tag', 'commit', 'version', 'channel']) assert(report[key] === context[key], `Acceptance ${key} mismatch`);
  assert(report.schema === 1 && report.passed === true, 'Acceptance must explicitly pass schema 1');
  assert(report.platform === artifact.platform && report.arch === artifact.arch, 'Acceptance platform mismatch');
  assert(report.artifact_sha256 === artifact.sha256 && report.to_version === context.version, 'Acceptance candidate mismatch');
  assert(typeof report.from_version === 'string' && report.from_version !== report.to_version && /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(report.from_version), 'Acceptance must exercise a real version upgrade');
  assert(typeof report.environment === 'string' && report.environment.trim().length >= 8, 'Real acceptance environment description required');
  for (const name of ACCEPTANCE_CHECKS) assert(report.checks?.[name] === true, `Acceptance check failed or missing: ${name}`);
}

async function verifiedCandidate(api, context, publicKey = process.env.SPARKLE_PUBLIC_KEY) {
  assert(/^[A-Za-z0-9+/]{43}=$/u.test(publicKey || ''), 'Pinned SPARKLE_PUBLIC_KEY is required for acceptance and publication');
  await remoteContext(api, context);
  const matches = (await api.releases()).filter((release) => release.tag_name === context.tag);
  assert(matches.length === 1 && matches[0].draft === true, 'Exactly one unpublished draft required; published releases cannot be overwritten');
  const release = matches[0];
  assert(release.prerelease === (context.channel === 'beta'), 'Release channel mismatch');
  const { downloads } = await verifiedAssets(api, release);
  assert(downloads.has('release-provenance.json') && downloads.has('update-manifest.json'), 'Candidate provenance and manifest required');
  const provenance = JSON.parse(downloads.get('release-provenance.json'));
  for (const key of ['repository', 'tag', 'commit', 'version', 'channel']) assert(provenance[key] === context[key], `Remote provenance ${key} mismatch`);
  assert(provenance.schema === 1 && provenance.sparkle_public_key === publicKey, 'Remote signing key differs from the configured app key');
  const covered = [...downloads.keys()].filter((name) => !['SHA256SUMS', 'release-provenance.json'].includes(name));
  assert(Array.isArray(provenance.assets) && provenance.assets.length === covered.length && new Set(provenance.assets.map((asset) => asset.name)).size === covered.length, 'Provenance must cover every candidate asset');
  for (const name of covered) {
    const record = provenance.assets.find((asset) => asset.name === name);
    const bytes = downloads.get(name);
    assert(record && record.size === bytes.length && record.sha256 === sha256(bytes) && record.sha512 === sha512(bytes), `Provenance asset mismatch: ${name}`);
  }
  const manifest = JSON.parse(downloads.get('update-manifest.json'));
  assert(manifest.schema === 2 && manifest.repository === REPOSITORY && manifest.version === context.version && manifest.channel === context.channel, 'Remote manifest mismatch');
  assert(manifest.artifacts.length === 2, 'Both platform update artifacts required');
  for (const artifact of manifest.artifacts) {
    const bytes = downloads.get(artifact.name);
    assert(bytes && bytes.length === artifact.size && sha256(bytes) === artifact.sha256 && sha512(bytes) === artifact.sha512, 'Manifest artifact hash/size mismatch');
    assert(artifact.url === `https://github.com/${REPOSITORY}/releases/download/${context.tag}/${encodeURIComponent(artifact.name)}`, 'Manifest asset URL mismatch');
    if (artifact.platform === 'darwin') {
      assert(artifact.arch === 'arm64' && artifact.kind === 'sparkle' && artifact.minimum_system_version === '12.0', 'Invalid macOS artifact contract');
      const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
      assert(crypto.verify(null, bytes, key, Buffer.from(artifact.ed_signature || '', 'base64')), 'Remote Sparkle signature invalid');
    } else assert(artifact.platform === 'win32' && artifact.arch === 'x64' && artifact.kind === 'nsis' && artifact.minimum_system_version === '10.0.18362', 'Invalid Windows artifact contract');
    assert(artifact.name === (artifact.platform === 'darwin' ? `Guzi-Scholar-${context.version}-arm64-${context.channel}.zip` : `Guzi-Scholar-${context.version}-windows-x64-setup.exe`), 'Candidate artifact name mismatch');
  }
  assert(new Set(manifest.artifacts.map((artifact) => artifact.platform)).size === 2, 'Distinct platform acceptance required');
  const feedName = context.channel === 'stable' ? 'latest.yml' : 'beta.yml';
  const installer = manifest.artifacts.find((artifact) => artifact.platform === 'win32');
  assert(downloads.has(feedName) && !downloads.has(context.channel === 'stable' ? 'beta.yml' : 'latest.yml'), 'Candidate Windows feed channel mismatch');
  const feed = downloads.get(feedName).toString('utf8');
  for (const line of [`version: ${context.version}`, `path: ${installer.name}`, `sha512: ${installer.sha512}`]) {
    const [field, value] = line.split(': ');
    assert(feed.split(/\r?\n/u).some((item) => [line, `${field}: '${value}'`, `${field}: "${value}"`].includes(item)), `Candidate Windows feed mismatch: ${field}`);
  }
  assert(feed.includes(String(installer.size)) && downloads.has(`${installer.name}.blockmap`), 'Candidate Windows update metadata incomplete');
  return { release, manifest, downloads };
}

async function downloadCandidate(api, directory, context, publicKey = process.env.SPARKLE_PUBLIC_KEY) {
  assert(!fs.existsSync(directory), 'Candidate download directory must not already exist');
  const candidate = await verifiedCandidate(api, context, publicKey);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of candidate.downloads) fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx' });
  return candidate.manifest;
}

async function review(api, context, reports, publicKey = process.env.SPARKLE_PUBLIC_KEY) {
  const { release, manifest } = await verifiedCandidate(api, context, publicKey);
  for (const artifact of manifest.artifacts) acceptance(reports[artifact.platform], context, artifact);
  return release;
}

function releaseNotes(context) {
  return `谷子学术 ${context.tag}\n\n支持 macOS Apple Silicon（arm64）与 Windows x64。应用内更新会先保存阅读状态与文献库数据，取消保存时不会安装更新。\n\n旧版用户请先手动安装一次 0.6.3 或更新版本，之后可使用应用内更新。安装包、更新附件与 SHA256SUMS 校验文件见本页附件。\n\nmacOS 使用 ad-hoc 代码签名及 Sparkle Ed25519 更新签名，未使用 Apple Developer ID 签名或公证，首次打开可能出现系统安全提示。Windows 安装包未使用发布者证书签名。\n\n本次原始候选已通过 macOS 与 Windows 的升级验收，包含保存取消、普通退出、重启和数据保留检查。`;
}

async function promote(api, context, reports, acceptanceRunID, publicKey = process.env.SPARKLE_PUBLIC_KEY) {
  assert(/^\d+$/u.test(acceptanceRunID || ''), 'A successful acceptance workflow run ID is required');
  const run = await api.request(`/actions/runs/${acceptanceRunID}`);
  assert(run.head_sha === context.commit && run.conclusion === 'success' && run.event === 'workflow_dispatch' && run.path === '.github/workflows/release-acceptance.yml', 'Acceptance artifact must come from the successful manual acceptance workflow on this exact tag commit');
  const release = await review(api, context, reports, publicKey);
  return api.request(`/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, make_latest: context.channel === 'stable' ? 'true' : 'false', body: releaseNotes(context) }) });
}

module.exports = { REPOSITORY, identity, preflight, prepare, draft, review, promote, acceptance, verifiedAssets, GitHub, sha256, sha512, ACCEPTANCE_CHECKS, verifiedCandidate, downloadCandidate, releaseNotes };
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'preflight') {
    const context = preflight(process.cwd(), args[0]);
    write(args[1], context);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${context.tag}\nversion=${context.version}\nchannel=${context.channel}\ncommit=${context.commit}\n`);
  } else if (command === 'prepare') prepare(args[0], json(args[1]), json(args[2]));
  else if (command === 'draft') console.log(JSON.stringify(await draft(new GitHub(process.env.GH_TOKEN), args[0], json(args[1]))));
  else if (command === 'download-candidate') console.log(JSON.stringify(await downloadCandidate(new GitHub(process.env.GH_TOKEN), args[0], json(args[1]))));
  else if (command === 'review') console.log(JSON.stringify(await review(new GitHub(process.env.GH_TOKEN), json(args[0]), { darwin: json(path.join(args[1], 'macos-acceptance.json')), win32: json(path.join(args[1], 'windows-acceptance.json')) })));
  else if (command === 'promote') console.log(JSON.stringify(await promote(new GitHub(process.env.GH_TOKEN), json(args[0]), { darwin: json(path.join(args[1], 'macos-acceptance.json')), win32: json(path.join(args[1], 'windows-acceptance.json')) }, args[2])));
  else throw new Error('Usage: release-pipeline.cjs preflight tag context | prepare directory context signature | draft directory context | download-candidate directory context | review context reports | promote context reports acceptance-run-id');
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
