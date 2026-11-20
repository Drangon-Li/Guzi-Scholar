'use strict';

// 谷子云端 MCP 适配层：只用「设置 → MCP 连接」启用的受限凭据访问能力入口，未启用时不暴露任何工具。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createScholarCloud, readConnection, NOT_ENABLED } = require('../electron/cloud.cjs');

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scholar-cloud-'));
  const token = 'm'.repeat(40);
  const seen = [];
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end(JSON.stringify({ error: 'MCP 访问凭据无效或已停用。' })); return; }
      if (req.url === '/api/capabilities') {
        res.end(JSON.stringify({ tools: [{ name: 'list_documents', description: '列出文献', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, scope: 'library.read' }] }));
        return;
      }
      const call = JSON.parse(body);
      if (call.name === 'update_notes') { res.statusCode = 403; res.end(JSON.stringify({ error: '未授予该能力。', code: 'scope_denied' })); return; }
      res.end(JSON.stringify({ result: [{ job_id: 'abc', title: 'Attention Is All You Need' }] }));
    });
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const connectionFile = path.join(temp, 'connection.json');
  fs.writeFileSync(connectionFile, JSON.stringify({ url: `http://127.0.0.1:${backend.address().port}`, token }), { mode: 0o600 });

  // 连接文件校验与 MCP 桥接一致
  assert.equal(readConnection('relative.json'), null);
  const loose = path.join(temp, 'loose.json');
  fs.writeFileSync(loose, fs.readFileSync(connectionFile), { mode: 0o644 });
  fs.chmodSync(loose, 0o644);
  assert.equal(readConnection(loose), null, 'group/world readable connection files are rejected');
  const remote = path.join(temp, 'remote.json');
  fs.writeFileSync(remote, JSON.stringify({ url: 'http://example.com:80', token }), { mode: 0o600 });
  assert.equal(readConnection(remote), null, 'connection must point at 127.0.0.1');
  assert.equal(readConnection(connectionFile).token, token);

  let status = { enabled: false, connection_file: connectionFile };
  const cloud = await createScholarCloud({
    userData: temp,
    appVersion: '0.7.1',
    platform: 'darwin',
    safeStorage: { isEncryptionAvailable: () => false },
    mcpStatus: async () => status,
    send: () => {},
  }).initialize();
  const signal = new AbortController().signal;

  // 本机 MCP 未启用：没有工具，调用给出明确提示
  assert.deepEqual(await cloud.tools.list(), []);
  const disabled = await cloud.tools.call('list_documents', {}, { signal });
  assert.equal(disabled.isError, true);
  assert.equal(disabled.content[0].text, NOT_ENABLED);
  assert.equal(seen.length, 0, 'nothing reaches the backend while MCP is disabled');

  // 启用后：用受限凭据列出能力（scope 等内部字段不外传）并执行
  status = { enabled: true, connection_file: connectionFile };
  const tools = await cloud.tools.list();
  assert.deepEqual(tools, [{ name: 'list_documents', description: '列出文献', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]);
  const result = await cloud.tools.call('list_documents', { limit: 5 }, { signal });
  assert.deepEqual(result.structuredContent, { result: [{ job_id: 'abc', title: 'Attention Is All You Need' }] });
  assert.deepEqual(seen.at(-1).body, { name: 'list_documents', arguments: { limit: 5 } });
  assert.ok(seen.every((request) => request.auth === `Bearer ${token}`), 'only the scoped MCP credential is used');

  // 权限不足等后端错误保留中文提示和错误码
  const denied = await cloud.tools.call('update_notes', {}, { signal });
  assert.equal(denied.isError, true);
  assert.deepEqual(JSON.parse(denied.content[0].text), { error: '未授予该能力。', code: 'scope_denied' });

  // 云端设置文件权限 0600，未登录时不保存会话
  const saved = path.join(temp, 'guzi-cloud.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(saved).mode & 0o777, 0o600); // Windows 没有 POSIX 权限位
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).session, null);
  assert.equal(cloud.link.getState().endpoint, 'https://mcp.guzilab.com/scholar');

  cloud.dispose();
  backend.close();
  fs.rmSync(temp, { recursive: true, force: true });
  console.log('cloud MCP adapter tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
