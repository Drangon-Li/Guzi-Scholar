'use strict';

// 谷子云端 MCP：用谷子账号登录后，经 wss://mcp.guzilab.com 把 AI 客户端的工具调用转到这台电脑。
// 权限与本机 MCP 完全一致：使用「设置 → MCP 连接」里启用的受限凭据（connection.json）调用能力入口，
// 只能访问用户勾选的能力范围；未启用 MCP 时云端没有任何工具可用。不监听任何端口。

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { CloudLink, createFileStorage } = require('./cloud-link.mjs');

const SEALED_PREFIX = 'safe:';
const CALL_TIMEOUT_MS = 110000;
const NOT_ENABLED = '谷子学术的 MCP 尚未启用：请在「设置 → MCP 连接」中启用服务并选择允许的能力范围，云端 MCP 使用同一套权限。';

/** 与 MCP 桥接相同的连接文件校验：仅当前用户可读、只能指向本机服务。 */
function readConnection(filename) {
  if (!path.isAbsolute(filename || '')) return null;
  let info;
  try { info = fs.lstatSync(filename); }
  catch { return null; }
  if (!info.isFile() || info.size > 16384 || (process.platform !== 'win32' && (info.mode & 0o077))) return null;
  const connection = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) return null;
  if (typeof connection.token !== 'string' || connection.token.length < 32 || /\s/u.test(connection.token)) return null;
  return { url, token: connection.token };
}

function capabilityRequest({ url, token }, route, payload, signal) {
  const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(route, url), {
      method: body ? 'POST' : 'GET',
      signal,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) },
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 12 * 1024 * 1024) { response.destroy(new Error('返回内容过大，请缩小查询范围。')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new Error('谷子学术返回了无效响应。')); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(Object.assign(new Error(value.error || `请求失败（${response.statusCode}）`), { code: value.code || `http_${response.statusCode}`, details: value.details }));
        } else resolve(value);
      });
    });
    request.on('error', (error) => reject(new Error(error.code === 'ECONNREFUSED' ? '谷子学术的本地服务暂不可用，请稍后重试。' : error.message)));
    request.setTimeout(CALL_TIMEOUT_MS, () => request.destroy(new Error('谷子学术操作超时，请检查应用中的运行状态。')));
    request.end(body);
  });
}

function sealer(safeStorage) {
  const available = () => {
    try { return safeStorage.isEncryptionAvailable(); }
    catch { return false; }
  };
  return {
    encrypt: (text) => (available() ? SEALED_PREFIX + safeStorage.encryptString(text).toString('base64') : text),
    decrypt: (text) => (text.startsWith(SEALED_PREFIX) ? safeStorage.decryptString(Buffer.from(text.slice(SEALED_PREFIX.length), 'base64')) : text),
  };
}

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

/**
 * @param {{ userData: string, appVersion: string, platform: string, safeStorage: object,
 *   mcpStatus: () => Promise<{ enabled?: boolean, connection_file?: string }>, send: (channel: string, value: unknown) => void,
 *   accountOrigin?: string, mcpOrigin?: string, log?: (line: string) => void }} options
 */
function createScholarCloud({ userData, appVersion, platform, safeStorage, mcpStatus, send, accountOrigin, mcpOrigin, log = () => {} }) {
  const credentials = async () => {
    const status = await mcpStatus();
    if (!status?.enabled || !status.connection_file) return null;
    try { return readConnection(status.connection_file); }
    catch { return null; }
  };
  const tools = {
    async list() {
      const connection = await credentials();
      if (!connection) return [];
      const { tools: list } = await capabilityRequest(connection, '/api/capabilities');
      return list.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) }));
    },
    async call(name, args, { signal }) {
      const connection = await credentials().catch(() => null);
      if (!connection) return { isError: true, content: [{ type: 'text', text: NOT_ENABLED }] };
      try {
        const { result: value } = await capabilityRequest(connection, '/api/capabilities/call', { name, arguments: args }, signal);
        const result = value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value ?? null };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const payload = { error: error.message, code: error.code || 'operation_failed', ...(error.details ? { details: error.details } : {}) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
      }
    },
  };
  const { encrypt, decrypt } = sealer(safeStorage);
  const link = new CloudLink({
    app: 'scholar',
    appVersion,
    platform,
    deviceName: () => os.hostname().replace(/\.local$/i, '').trim() || 'Mac',
    storage: createFileStorage({ file: path.join(userData, 'guzi-cloud.json'), encrypt, decrypt, writeFile: async (file, text) => writeFileAtomic(file, text) }),
    tools,
    accountOrigin,
    mcpOrigin,
    log,
  });
  link.on('state', (state) => send('my-scholar:cloud-state', state));
  return {
    link,
    tools,
    async initialize() {
      await link.initialize();
      return this;
    },
    dispose() {
      link.dispose();
    },
  };
}

module.exports = { createScholarCloud, readConnection, NOT_ENABLED };
