'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const VERSION = '2.10.1';
const SHA256 = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27';
const ARCHIVE_URL = `https://github.com/sparkle-project/Sparkle/releases/download/${VERSION}/Sparkle-${VERSION}.tar.xz`;
const root = path.resolve(__dirname, '..');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
async function sha256(file) {
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
async function download(url, destination, expected) {
  try { if (await sha256(destination) === expected) return; } catch (_) { /* No cached archive yet. */ }
  const temporary = `${destination}.${crypto.randomBytes(6).toString('hex')}.partial`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}: ${url}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
    if (await sha256(temporary) !== expected) throw new Error(`Archive SHA-256 mismatch: ${url}`);
    await fsp.rename(temporary, destination);
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}
async function nodeHeaders(directory, environment) {
  const candidates = [environment.NODE_INCLUDE, environment.npm_config_nodedir && path.join(environment.npm_config_nodedir, 'include/node'), path.resolve(path.dirname(process.execPath), '../include/node'), '/opt/homebrew/include/node', '/usr/local/include/node'];
  for (const candidate of candidates.filter(Boolean)) if (fs.existsSync(path.join(candidate, 'node_api.h'))) return candidate;
  const version = process.versions.node;
  const filename = `node-v${version}-headers.tar.gz`;
  const url = `https://nodejs.org/dist/v${version}`;
  const response = await fetch(`${url}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Cannot fetch Node headers checksums (${response.status})`);
  const line = (await response.text()).split('\n').find((item) => item.endsWith(`  ${filename}`));
  if (!line || !/^[a-f\d]{64}\s/u.test(line)) throw new Error('Node headers checksum missing');
  const archive = path.join(directory, filename);
  await download(`${url}/${filename}`, archive, line.slice(0, 64));
  run('/usr/bin/tar', ['-xf', archive, '-C', directory]);
  const include = path.join(directory, `node-v${version}`, 'include/node');
  if (!fs.existsSync(path.join(include, 'node_api.h'))) throw new Error('Node N-API headers were not extracted');
  return include;
}
async function prepareSparkle({ architecture = process.arch, environment = process.env } = {}) {
  if (process.platform !== 'darwin') throw new Error('Preparing Sparkle requires macOS');
  if (!['arm64', 'x64'].includes(architecture)) throw new Error(`Unsupported macOS architecture: ${architecture}`);
  const directory = path.join(root, 'build/updater');
  await fsp.mkdir(directory, { recursive: true });
  const archive = path.join(directory, `Sparkle-${VERSION}.tar.xz`);
  await download(ARCHIVE_URL, archive, SHA256);
  const extracted = path.join(directory, `Sparkle-${VERSION}`);
  // Refresh upstream framework files from the verified archive on every build.
  await fsp.mkdir(extracted, { recursive: true });
  run('/usr/bin/tar', ['-xf', archive, '-C', extracted]);
  const framework = path.join(extracted, 'Sparkle.framework');
  const include = await nodeHeaders(directory, environment);
  const addon = path.join(directory, architecture, 'sparkle-bridge.node');
  run(process.execPath, [path.join(root, 'native/sparkle/build.mjs'), '--framework', framework, '--node-include', include, '--out', addon, '--arch', architecture]);
  return { framework, addon, version: VERSION, sha256: SHA256 };
}
module.exports = { prepareSparkle, VERSION, SHA256, ARCHIVE_URL };
if (require.main === module) prepareSparkle({ architecture: process.argv[2] || process.arch }).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
