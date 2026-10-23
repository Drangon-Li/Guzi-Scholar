'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { readConnection } = require('../mcp/bridge-source.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-mcp-bridge-'));
  const connectionFile = path.join(root, 'connection.json');
  let token = 'test-credential-'.repeat(4);
  let note = 'initial';
  const requests = [];
  const backend = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(JSON.stringify({ error: 'denied' })); return; }
    requests.push(request.url);
    if (request.url === '/api/capabilities') {
      response.end(JSON.stringify({ tools: [{ name: 'save_notes', description: 'Save notes', scope: 'notes.write', inputSchema: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'] } }, { name: 'get_notes', description: 'Get notes', inputSchema: { type: 'object' } }] }));
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const { name, arguments: args } = JSON.parse(text);
    if (name === 'save_notes') {
      if (args.markdown === 'conflict') { response.writeHead(409); response.end(JSON.stringify({ error: 'revision changed', code: 'revision_conflict' })); return; }
      note = args.markdown;
    } else if (name !== 'get_notes') { response.writeHead(400); response.end(JSON.stringify({ error: 'unknown tool' })); return; }
    response.end(JSON.stringify({ result: { markdown: note, revision: 'r1' } }));
  });
  let client;
  try {
    await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(0, '127.0.0.1', resolve); });
    const writeConnection = (url = `http://127.0.0.1:${backend.address().port}`) => fs.writeFileSync(connectionFile, JSON.stringify({ url, token }), { mode: 0o600 });
    writeConnection();
    assert.strictEqual(readConnection(connectionFile).token, token);
    writeConnection('https://example.com');
    assert.throws(() => readConnection(connectionFile), /本机服务/u);
    writeConnection();
    client = new Client({ name: 'guzi-integration-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.argv[2] || process.execPath,
      args: [process.argv[3] || path.join(__dirname, '..', 'mcp', 'bridge.cjs'), '--connection-file', connectionFile],
      env: process.argv[2] ? { ELECTRON_RUN_AS_NODE: '1' } : undefined,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepStrictEqual(tools.tools.map((tool) => tool.name), ['save_notes', 'get_notes']);
    assert(!Object.hasOwn(tools.tools[0], 'scope'));
    const saved = await client.callTool({ name: 'save_notes', arguments: { markdown: 'MCP saved this note' } });
    assert(!saved.isError, JSON.stringify(saved));
    assert.strictEqual(saved.structuredContent.markdown, 'MCP saved this note');
    const conflict = await client.callTool({ name: 'save_notes', arguments: { markdown: 'conflict' } });
    assert.strictEqual(conflict.isError, true);
    assert.strictEqual(JSON.parse(conflict.content[0].text).code, 'revision_conflict');
    token = 'rotated-credential-'.repeat(4);
    writeConnection();
    const read = await client.readResource({ uri: 'guzi://notes/abcdef123456' });
    assert.strictEqual(JSON.parse(read.contents[0].text).markdown, 'MCP saved this note');
    const templates = await client.listResourceTemplates();
    assert(templates.resourceTemplates.some((entry) => entry.uriTemplate === 'guzi://notes/{job_id}'));
    fs.unlinkSync(connectionFile);
    const disabled = await client.callTool({ name: 'get_notes', arguments: {} });
    assert.strictEqual(disabled.isError, true);
    assert.match(disabled.content[0].text, /未启用/u);
    assert(requests.every((route) => ['/api/capabilities', '/api/capabilities/call'].includes(route)));
    assert(!stderr.includes(token));
    console.log('MCP SDK stdio handshake, tool/resource calls, token rotation and errors passed');
  } finally {
    if (client) await client.close();
    await new Promise((resolve) => backend.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
