'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { REPOSITORY, assetURL } = require('./update-service.cjs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const FIELDS = ['version', 'channel', 'platform', 'arch', 'downloadURL', 'assetName', 'size', 'sha256', 'sha512', 'edSignature', 'minimumSystemVersion', 'notes', 'publishedAt', 'repository'];
const xml = (value) => String(value).replace(/[<>&"']/gu, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character]));
function base64Bytes(value, length) {
  return typeof value === 'string' && Buffer.from(value, 'base64').length === length && Buffer.from(value, 'base64').toString('base64') === value;
}
function snapshot(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('Missing update candidate');
  const result = {};
  for (const field of FIELDS) {
    if (candidate[field] !== undefined) {
      if (!['string', 'number'].includes(typeof candidate[field])) throw new Error(`Invalid update ${field}`);
      result[field] = candidate[field];
    }
  }
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/iu.test(result.version) || !['stable', 'beta'].includes(result.channel) || result.platform !== 'darwin' || !['arm64', 'x64'].includes(result.arch)) throw new Error('Invalid macOS update identity');
  if (!Number.isSafeInteger(result.size) || result.size <= 0 || !/^[a-f\d]{64}$/iu.test(result.sha256) || !(/^[a-f\d]{128}$/iu.test(result.sha512) || base64Bytes(result.sha512, 64)) || !base64Bytes(result.edSignature, 64)) throw new Error('Invalid macOS update integrity metadata');
  if (typeof result.assetName !== 'string' || !result.assetName.endsWith('.zip') || typeof result.downloadURL !== 'string') throw new Error('macOS updates require a ZIP archive');
  const url = new URL(result.downloadURL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Invalid update download URL');
  result.sha256 = result.sha256.toLowerCase();
  return Object.freeze(result);
}
const identity = (candidate) => crypto.createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
const expectedSha512 = (candidate) => /^[a-f\d]{128}$/iu.test(candidate.sha512) ? candidate.sha512.toLowerCase() : Buffer.from(candidate.sha512, 'base64').toString('hex');
async function digestFile(file, candidate) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.size) throw new Error('Cached update size mismatch');
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  for await (const bytes of fs.createReadStream(file)) { sha256.update(bytes); sha512.update(bytes); }
  if (sha256.digest('hex') !== candidate.sha256 || sha512.digest('hex') !== expectedSha512(candidate)) throw new Error('Cached update checksum mismatch');
}
function appcast(candidate, base) {
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Guzi Scholar</title><item><title>${xml(candidate.version)}</title><sparkle:version>${xml(candidate.version)}</sparkle:version><sparkle:shortVersionString>${xml(candidate.version)}</sparkle:shortVersionString><sparkle:minimumSystemVersion>${xml(candidate.minimumSystemVersion || '12.0')}</sparkle:minimumSystemVersion><enclosure url="${xml(base)}/update.zip" length="${candidate.size}" type="application/octet-stream" sparkle:edSignature="${xml(candidate.edSignature)}" /></item></channel></rss>`;
}
function createMacUpdater({ app, cacheDirectory, publicKey, resourcesPath = process.resourcesPath, bridge: suppliedBridge, fetch: fetchArchive = globalThis.fetch, onEvent = () => {}, installationTimeoutMs = 180000, downloadTimeoutMs = 600000, allowTestURLs = false } = {}) {
  if (!app || !path.isAbsolute(cacheDirectory || '') || !base64Bytes(publicKey, 32)) throw new Error('macOS updater requires an app, absolute cache directory, and Ed25519 public key');
  let bridge;
  let initialized = false;
  let downloading = null;
  let downloadAbort = null;
  let installation = null;
  let disposed = false;
  let cycleInProgress = false;
  let installerMayBeArmed = false;
  let eventHandler = null;
  function validateCandidate(candidate) {
    const selected = snapshot(candidate);
    const url = new URL(selected.downloadURL);
    const loopback = allowTestURLs && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password;
    if (selected.repository !== REPOSITORY || (!loopback && selected.downloadURL !== assetURL(`v${selected.version}`, selected.assetName))) throw new Error('Update candidate does not match the trusted release repository');
    return selected;
  }
  const archivePath = (candidate) => path.join(cacheDirectory, `${identity(candidate)}.zip`);
  const candidatePath = (candidate) => path.join(cacheDirectory, `${identity(candidate)}.json`);
  const pointerPath = path.join(cacheDirectory, 'downloaded.json');
  function assertActive() { if (disposed) throw new Error('macOS updater is disposed'); }
  function getBridge() {
    if (!bridge) {
      bridge = suppliedBridge || require(path.join(resourcesPath, 'sparkle-bridge.node'));
      bridge.setEventHandler((event) => {
        if (event.installerMayBeArmed) installerMayBeArmed = true;
        if (event.type === 'checking') cycleInProgress = true;
        if (event.type === 'cycle-finished') { cycleInProgress = false; installerMayBeArmed = Boolean(event.installerMayBeArmed); }
        try { onEvent(event); } catch (_) { /* Diagnostic observers cannot interrupt installation. */ }
        eventHandler?.(event);
      });
    }
    return bridge;
  }
  async function atomicJSON(file, value) {
    const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try { await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await fsp.rename(temporary, file); }
    finally { await fsp.unlink(temporary).catch(() => {}); }
  }
  async function verify(candidate) {
    const saved = validateCandidate(JSON.parse(await fsp.readFile(candidatePath(candidate), 'utf8')));
    if (identity(saved) !== identity(candidate)) throw new Error('Cached update metadata mismatch');
    await digestFile(archivePath(saved), saved);
    return saved;
  }
  async function getDownloadedCandidate() {
    assertActive();
    try {
      const pointer = JSON.parse(await fsp.readFile(pointerPath, 'utf8'));
      if (!/^[a-f\d]{64}$/u.test(pointer.id)) return null;
      const candidate = validateCandidate(JSON.parse(await fsp.readFile(path.join(cacheDirectory, `${pointer.id}.json`), 'utf8')));
      if (identity(candidate) !== pointer.id) return null;
      return await verify(candidate);
    } catch (_) { return null; }
  }
  async function download(candidate, onProgress = () => {}) {
    assertActive();
    if (installation || downloading) throw new Error('An update operation is already in progress');
    const selected = validateCandidate(candidate);
    const url = new URL(selected.downloadURL);
    if (!allowTestURLs && url.protocol !== 'https:') throw new Error('Production update downloads require HTTPS');
    downloading = selected;
    let temporary;
    let timer;
    try {
      await fsp.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
      try {
        const cached = await verify(selected);
        await atomicJSON(pointerPath, { id: identity(cached) });
        onProgress({ transferred: cached.size, total: cached.size, percent: 100 });
        return cached;
      } catch (_) { /* A missing or invalid cache is replaced only after a verified download. */ }
      downloadAbort = new AbortController();
      timer = setTimeout(() => downloadAbort?.abort(new Error('Update download timed out')), downloadTimeoutMs);
      const response = await fetchArchive(selected.downloadURL, { signal: downloadAbort.signal, cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(`Update download HTTP ${response.status}`);
      const length = response.headers.get('content-length');
      if (length !== null && Number(length) !== selected.size) throw new Error('Update Content-Length mismatch');
      temporary = `${archivePath(selected)}.${crypto.randomBytes(8).toString('hex')}.partial`;
      const sha256 = crypto.createHash('sha256');
      const sha512 = crypto.createHash('sha512');
      let receivedBytes = 0;
      const integrity = new Transform({ transform(bytes, encoding, callback) {
        receivedBytes += bytes.length;
        if (receivedBytes > selected.size) { callback(new Error('Update exceeds expected size')); return; }
        sha256.update(bytes); sha512.update(bytes);
        try { onProgress({ transferred: receivedBytes, total: selected.size, percent: Math.min(99, receivedBytes / selected.size * 100) }); callback(null, bytes); }
        catch (error) { callback(error); }
      } });
      await pipeline(Readable.fromWeb(response.body), integrity, fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' }), { signal: downloadAbort.signal });
      if (receivedBytes !== selected.size || sha256.digest('hex') !== selected.sha256 || sha512.digest('hex') !== expectedSha512(selected)) throw new Error('Update archive integrity mismatch');
      assertActive();
      await fsp.rename(temporary, archivePath(selected));
      await atomicJSON(candidatePath(selected), selected);
      await atomicJSON(pointerPath, { id: identity(selected) });
      onProgress({ transferred: receivedBytes, total: selected.size, percent: 100 });
      return selected;
    } finally {
      clearTimeout(timer);
      if (temporary) await fsp.unlink(temporary).catch(() => {});
      downloadAbort = null;
      downloading = null;
    }
  }
  async function performInstall(candidate) {
    const selected = await verify(validateCandidate(candidate));
    assertActive();
    const native = getBridge();
    const token = crypto.randomBytes(32).toString('hex');
    let base;
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      if (request.url === `/${token}/appcast.xml`) { response.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store' }).end(appcast(selected, base)); return; }
      if (request.url === `/${token}/update.zip`) {
        response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': selected.size, 'Cache-Control': 'no-store' });
        const stream = fs.createReadStream(archivePath(selected));
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
        return;
      }
      response.writeHead(404).end();
    });
    const sockets = new Set();
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    let timer;
    let settled = false;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      base = `http://127.0.0.1:${server.address().port}/${token}`;
      await new Promise((resolve, reject) => {
        const fail = (error) => {
          if (!settled) {
            settled = true;
            if (cycleInProgress && !installerMayBeArmed) native.cancel().catch(() => {});
            reject(error);
          }
        };
        let cycleError;
        eventHandler = (event) => {
          if (event.type === 'error' || event.type === 'not-available') {
            cycleError = new Error(event.message || 'Sparkle rejected the update');
            cycleError.details = event;
          }
          if (event.type === 'available') {
            if (event.version !== selected.version || event.informationOnly || event.installerMayBeArmed) { fail(new Error('Sparkle candidate differs from prepared archive')); return; }
            native.download().catch(fail);
          } else if (event.type === 'ready') native.install().catch(fail);
          else if (event.type === 'cycle-finished') {
            installerMayBeArmed = Boolean(event.installerMayBeArmed);
            fail(cycleError || new Error('Sparkle installation ended before application exit'));
          } else if (event.type === 'installed' && !settled) { settled = true; resolve(event); }
        };
        timer = setTimeout(() => fail(cycleError || new Error('Sparkle installation timed out')), installationTimeoutMs);
        (async () => {
          if (!initialized) { await native.init({ feedURL: `${base}/appcast.xml`, publicKey }); initialized = true; }
          else await native.setFeedURL(`${base}/appcast.xml`);
          await native.check();
        })().catch(fail);
      });
    } finally {
      clearTimeout(timer);
      eventHandler = null;
      server.close();
      for (const socket of sockets) socket.destroy();
    }
  }
  function install(candidate) {
    assertActive();
    if (downloading || installation || cycleInProgress || installerMayBeArmed) return Promise.reject(new Error('An update installation is already active'));
    installation = performInstall(candidate).finally(() => { installation = null; });
    return installation;
  }
  async function cancelPreparedUpdateForExit() {
    if (installation || cycleInProgress || installerMayBeArmed) throw new Error('Sparkle installation is active; quitting cannot be acknowledged as safe');
    return { safeToExit: true, installerMayBeArmed: false };
  }
  async function canInstall(candidate) {
    if (disposed || installation || downloading || cycleInProgress || installerMayBeArmed) return false;
    try { await verify(validateCandidate(candidate)); return true; } catch (_) { return false; }
  }
  function dispose() {
    if (installation || cycleInProgress || installerMayBeArmed) throw new Error('Cannot dispose an active Sparkle installation');
    disposed = true;
    downloadAbort?.abort(new Error('Updater disposed'));
  }
  return { download, install, getDownloadedCandidate, cancelPreparedUpdateForExit, canInstall, dispose };
}
module.exports = { createMacUpdater };
