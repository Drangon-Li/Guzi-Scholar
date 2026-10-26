'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMacUpdater } = require('../electron/mac-updater.cjs');
const { buildOptions } = require('../scripts/build-mac-target.cjs');
const key = Buffer.alloc(32, 7).toString('base64');
const bytes = Buffer.from('signed archive fixture');
const original = Object.freeze({ version: '0.7.0', channel: 'stable', platform: 'darwin', arch: 'arm64', downloadURL: 'https://github.com/Drangon-Li/Guzi-Scholar/releases/download/v0.7.0/Guzi-Scholar-0.7.0-arm64-stable.zip', assetName: 'Guzi-Scholar-0.7.0-arm64-stable.zip', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sha512: crypto.createHash('sha512').update(bytes).digest('base64'), edSignature: Buffer.alloc(64, 8).toString('base64'), repository: 'Drangon-Li/Guzi-Scholar', notes: '<test>&"', minimumSystemVersion: '12.0' });
const pause = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error('Fixture did not reach expected event'); }
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guzi-mac-updater-'));
  let calls = [];
  let receive;
  let feedURL;
  let fetches = 0;
  const native = {
    setEventHandler(handler) { receive = handler; },
    async init(options) { calls.push('init'); assert.equal(options.publicKey, key); feedURL = options.feedURL; },
    async setFeedURL(url) { calls.push('setFeedURL'); feedURL = url; },
    async check() { calls.push('check'); receive({ type: 'checking' }); },
    async download() { calls.push('download'); },
    async install() { calls.push('install'); return { accepted: true }; },
    async cancel() { calls.push('cancel'); receive({ type: 'cycle-finished', installerMayBeArmed: false }); },
  };
  const options = { app: { isPackaged: true }, publicKey: key, cacheDirectory: root, bridge: native, installationTimeoutMs: 5000, fetch: async () => { fetches++; return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); } };
  let updater = createMacUpdater(options);
  try {
    assert.equal(await updater.getDownloadedCandidate(), null);
    assert.equal(await updater.canInstall(original), false);
    await assert.rejects(updater.download({ ...original, downloadURL: 'https://example.com/update.zip' }), /repository/u);
    let lastProgress;
    const mutable = { ...original };
    const download = updater.download(mutable, (progress) => { lastProgress = progress; });
    mutable.version = '9.9.9';
    const prepared = await download;
    assert.equal(prepared.version, original.version);
    assert(Object.isFrozen(prepared));
    assert.equal(lastProgress.percent, 100);
    assert.equal(lastProgress.transferred, bytes.length);
    assert.equal(lastProgress.total, bytes.length);
    assert.deepEqual(calls, [], 'Download must never initialize Sparkle');
    assert.deepEqual(await updater.cancelPreparedUpdateForExit(), { safeToExit: true, installerMayBeArmed: false });
    updater.dispose();
    updater = createMacUpdater(options);
    assert.deepEqual(await updater.getDownloadedCandidate(), original);
    assert.equal(await updater.canInstall(original), true);
    await updater.download(original);
    assert.equal(fetches, 1, 'Verified restored archives can be reused without networking');
    assert.equal(await updater.canInstall({ ...original, edSignature: Buffer.alloc(64, 2).toString('base64') }), false);

    let settled = false;
    const install = updater.install(original).finally(() => { settled = true; });
    install.catch(() => {});
    await until(() => calls.includes('check'));
    const feedResponse = await fetch(feedURL);
    const feed = await feedResponse.text();
    assert(feed.includes(original.edSignature));
    const archiveURL = new URL('update.zip', feedURL).href;
    assert.deepEqual(Buffer.from(await (await fetch(archiveURL)).arrayBuffer()), bytes);
    assert.equal((await fetch(new URL('/appcast.xml', feedURL))).status, 404, 'Loopback requests require the random token');
    assert.equal((await fetch(feedURL, { method: 'POST' })).status, 405);
    receive({ type: 'available', version: original.version, informationOnly: false, installerMayBeArmed: false });
    await until(() => calls.includes('download'));
    receive({ type: 'ready', installerMayBeArmed: true });
    await until(() => calls.includes('install'));
    await pause();
    assert.equal(settled, false, 'Native accepted is not installation success');
    await assert.rejects(updater.cancelPreparedUpdateForExit(), /active/u);
    const details = { type: 'error', message: 'Signature rejected', domain: 'SUSparkleErrorDomain', underlyingError: { code: 3002 } };
    receive(details);
    assert.equal(settled, false, 'Failure must wait for cycle cleanup');
    receive({ type: 'cycle-finished', installerMayBeArmed: false, error: details });
    await assert.rejects(install, (error) => error.message === 'Signature rejected' && error.details === details);
    assert.equal(await updater.canInstall(original), true, 'Failed cycles remain retryable');
    assert.deepEqual(await updater.cancelPreparedUpdateForExit(), { safeToExit: true, installerMayBeArmed: false });

    const archive = (await fs.readdir(root)).find((file) => file.endsWith('.zip'));
    await fs.writeFile(path.join(root, archive), Buffer.alloc(bytes.length));
    assert.equal(await updater.getDownloadedCandidate(), null, 'Restart restoration rejects modified archives');
    assert.equal(await updater.canInstall(original), false);
    await updater.download(original);
    assert.equal(fetches, 2, 'Corrupt cache is safely replaced');
    updater.dispose();
    const failed = createMacUpdater({ ...options, cacheDirectory: path.join(root, 'failed'), fetch: async () => new Response(Buffer.alloc(bytes.length), { headers: { 'content-length': String(bytes.length) } }) });
    await assert.rejects(failed.download(original), /integrity/u);
    assert.equal(await failed.canInstall(original), false);
    assert.equal(await failed.getDownloadedCandidate(), null);
    assert.deepEqual((await fs.readdir(path.join(root, 'failed'))), [], 'Failed downloads cannot leave ready metadata or partial files');
    failed.dispose();
    const truncated = createMacUpdater({ ...options, cacheDirectory: path.join(root, 'truncated'), fetch: async () => new Response(bytes.subarray(0, -1)) });
    await assert.rejects(truncated.download(original), /integrity/u);
    assert.equal(await truncated.getDownloadedCandidate(), null);
    truncated.dispose();
    calls = [];
    const timeout = createMacUpdater({ ...options, installationTimeoutMs: 10 });
    await assert.rejects(timeout.install(original), /timed out/u);
    assert(calls.includes('cancel'), 'A check that times out before installer preparation is cancelled');
    timeout.dispose();
    calls = [];
    const late = createMacUpdater({ ...options, installationTimeoutMs: 100 });
    const waitingForExit = late.install(original);
    waitingForExit.catch(() => {});
    await until(() => calls.includes('check'));
    receive({ type: 'available', version: original.version, informationOnly: false, installerMayBeArmed: false });
    receive({ type: 'ready', installerMayBeArmed: true });
    await assert.rejects(waitingForExit, /timed out/u);
    assert(calls.includes('install'));
    assert(!calls.includes('cancel'), 'A possibly armed installer cannot be treated as cancelled');
    await assert.rejects(late.cancelPreparedUpdateForExit(), /active/u);
    receive({ type: 'cycle-finished', installerMayBeArmed: false });
    late.dispose();

    const internal = buildOptions('dmg', 'internal', {});
    assert.equal(internal.updater.enabled, false);
    const beta = buildOptions('all', 'internal', { GUZI_UPDATE_CHANNEL: 'beta', SPARKLE_PUBLIC_KEY: key });
    assert.deepEqual(beta.args.slice(0, 4), ['--mac', 'dmg', 'zip', '--arm64']);
    assert.equal(beta.configuration.appId, 'com.guzi.scholar.beta');
    assert.equal(beta.configuration.productName, '谷子学术测试版');
    assert.equal(beta.configuration.artifactName, 'Guzi-Scholar-${version}-${arch}-beta.${ext}');
    assert.equal(beta.configuration.extraMetadata.updater.publicKey, beta.configuration.mac.extendInfo.SUPublicEDKey);
    assert.equal(beta.configuration.extraMetadata.updater.repository, 'Drangon-Li/Guzi-Scholar');
    assert(!beta.args.some((argument) => argument.includes('artifactName=')), 'Legacy internal artifact override cannot hide the update channel');
    assert.throws(() => buildOptions('zip', 'internal', { GUZI_UPDATE_CHANNEL: 'stable' }), /PUBLIC_KEY/u);
    assert.equal(buildOptions('dmg', 'local-test', { GUZI_UPDATE_CHANNEL: 'beta' }).updater.enabled, false);
    console.log('macOS production updater tests passed');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
