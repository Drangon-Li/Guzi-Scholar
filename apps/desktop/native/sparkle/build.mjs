import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
  if (index % 2 === 0) pairs.push([value, args[index + 1]]);
  return pairs;
}, []));
for (const name of ['--framework', '--node-include', '--out']) {
  if (!options[name]) throw new Error(`Required: ${name}`);
}
if (process.platform !== 'darwin') throw new Error('The Sparkle bridge requires macOS.');
const framework = realpathSync(options['--framework']);
const nodeInclude = realpathSync(options['--node-include']);
const output = resolve(options['--out']);
const arch = options['--arch'] || process.arch;
if (!['arm64', 'x86_64', 'x64'].includes(arch)) throw new Error(`Unsupported arch: ${arch}`);
mkdirSync(dirname(output), { recursive: true });
const source = fileURLToPath(new URL('./bridge.mm', import.meta.url));
const result = spawnSync('xcrun', [
  'clang++', '-std=c++17', '-fobjc-arc', '-fblocks', '-DNAPI_VERSION=8',
  '-arch', arch === 'x64' ? 'x86_64' : arch,
  '-mmacosx-version-min=12.0', '-Wall', '-Wextra',
  '-Wno-unused-parameter', '-shared', '-undefined', 'dynamic_lookup',
  '-I', nodeInclude, '-F', dirname(framework),
  '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'Sparkle',
  '-Wl,-rpath,@executable_path/../Frameworks', '-Wl,-rpath,@loader_path',
  source, '-o', output,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(output);
