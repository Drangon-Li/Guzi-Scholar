'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_STORE_FILES = 512;
const STATIC_KEYS = new Set([
  'my-scholar-open-documents',
  'my-scholar-reading-locations-v1',
  'my-scholar-article-note-drafts-v1',
  'my-scholar-graph-preferences-v1',
  'my-scholar-graph-preferences-v2',
  'my-scholar-assistant-width-v1',
  'my-scholar-translation-scope-v1',
  'my-scholar-typography',
  'my-scholar-onboarding-v1',
  'my-scholar-onboarding-v2',
]);

function validateKey(key) {
  const allowed = typeof key === 'string'
    && key.length <= MAX_KEY_LENGTH
    && (STATIC_KEYS.has(key) || /^my-scholar-chat(?:-v2)?:[a-f0-9]{16}$/u.test(key));
  if (!allowed) {
    throw new Error('界面状态键无效。');
  }
  return key;
}

function validateValue(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new Error('界面状态内容无效或过大。');
  }
  return value;
}

class RendererStateStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
  }

  filePath(key) {
    const normalized = validateKey(key);
    return path.join(this.directory, `${crypto.createHash('sha256').update(normalized).digest('hex')}.json`);
  }

  async ensureDirectory() {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await fs.promises.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('界面状态目录无效。');
    await fs.promises.chmod(this.directory, 0o700);
  }

  quarantine(filePath) {
    const target = `${filePath}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(filePath, target); } catch (_) { /* A concurrent cleanup may already have moved it. */ }
  }

  get(key) {
    const filePath = this.filePath(key);
    let info;
    try {
      info = fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_VALUE_BYTES + 1024) {
      this.quarantine(filePath);
      return undefined;
    }
    const bytes = fs.readFileSync(filePath, 'utf8');
    try {
      const payload = JSON.parse(bytes);
      if (payload?.version !== STORE_VERSION || payload.key !== key) throw new Error('界面状态文件内容无效。');
      return validateValue(payload.value);
    } catch (_) {
      this.quarantine(filePath);
      return undefined;
    }
  }

  async loadAll() {
    await this.ensureDirectory();
    const values = {};
    const entries = await fs.promises.readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      const filePath = path.join(this.directory, entry.name);
      const info = await fs.promises.lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_VALUE_BYTES + 1024) {
        this.quarantine(filePath);
        continue;
      }
      const bytes = await fs.promises.readFile(filePath, 'utf8');
      try {
        const payload = JSON.parse(bytes);
        const key = validateKey(payload?.key);
        if (payload?.version !== STORE_VERSION || this.filePath(key) !== filePath) throw new Error('界面状态文件内容无效。');
        values[key] = validateValue(payload.value);
      } catch (_) {
        this.quarantine(filePath);
      }
    }
    return values;
  }

  async usageExcluding(filePath) {
    const entries = await fs.promises.readdir(this.directory, { withFileTypes: true });
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const candidate = path.join(this.directory, entry.name);
      if (candidate === filePath) continue;
      const info = await fs.promises.lstat(candidate);
      if (info.isSymbolicLink()) continue;
      files += 1;
      bytes += info.size;
    }
    return { files, bytes };
  }

  async set(key, value) {
    const normalizedKey = validateKey(key);
    const normalizedValue = validateValue(value);
    await this.ensureDirectory();
    const filePath = this.filePath(normalizedKey);
    const temporary = path.join(this.directory, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const payload = Buffer.from(JSON.stringify({ version: STORE_VERSION, key: normalizedKey, value: normalizedValue }), 'utf8');
    const usage = await this.usageExcluding(filePath);
    if (usage.files >= MAX_STORE_FILES || usage.bytes + payload.length > MAX_STORE_BYTES) throw new Error('界面状态存储空间已满。');
    let descriptor;
    try {
      descriptor = await fs.promises.open(temporary, 'wx', 0o600);
      await descriptor.writeFile(payload);
      await descriptor.sync();
      await descriptor.close();
      descriptor = undefined;
      await fs.promises.rename(temporary, filePath);
      await fs.promises.chmod(filePath, 0o600);
    } finally {
      if (descriptor !== undefined) await descriptor.close().catch(() => {});
      await fs.promises.unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    }
  }

  async remove(key) {
    const filePath = this.filePath(key);
    await fs.promises.unlink(filePath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
}

module.exports = { MAX_VALUE_BYTES, RendererStateStore };
