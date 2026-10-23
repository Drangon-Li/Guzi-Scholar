'use strict';

const path = require('path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
buildSync({
  entryPoints: [path.join(root, 'mcp', 'bridge-source.cjs')],
  outfile: path.join(root, 'mcp', 'bridge.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  legalComments: 'linked',
});
