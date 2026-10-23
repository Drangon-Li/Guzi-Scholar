'use strict';

const path = require('path');

function mcpClientConfiguration({ executable, projectRoot, connectionFile }) {
  if (!path.isAbsolute(executable || '') || !path.isAbsolute(connectionFile || '')) throw new Error('MCP 连接信息尚未就绪。');
  const command = executable;
  const args = [path.join(projectRoot, 'mcp', 'bridge.cjs'), '--connection-file', connectionFile];
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  const toml = [
    '[mcp_servers.guzi_scholar]',
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120',
    '',
    '[mcp_servers.guzi_scholar.env]',
    'ELECTRON_RUN_AS_NODE = "1"',
  ].join('\n');
  return { command, args, env, toml, json: { mcpServers: { guzi_scholar: { command, args, env } } } };
}

module.exports = { mcpClientConfiguration };
