'use strict';

const fs = require('node:fs');
const path = require('node:path');

const source = path.dirname(require.resolve('pdfjs-dist/package.json'));
const target = path.resolve(__dirname, '../web/vendor/pdfjs');
fs.mkdirSync(path.join(target, 'build'), { recursive: true });
for (const name of ['pdf', 'pdf.worker', 'pdf.renderer']) {
  fs.copyFileSync(path.join(source, 'legacy', 'build', name + '.min.mjs'), path.join(target, 'build', name + '.mjs'));
}
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'LICENSE'));
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  fs.cpSync(path.join(source, directory), path.join(target, directory), { recursive: true });
}
