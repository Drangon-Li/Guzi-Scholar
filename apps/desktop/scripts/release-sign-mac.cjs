'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function sign({ archive, signer, publicKey, privateKey, app, execute = execFileSync }) {
  if (!privateKey?.trim()) throw new Error('SPARKLE_PRIVATE_KEY is required; no keychain fallback is permitted');
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(publicKey || '')) throw new Error('A 32-byte SPARKLE_PUBLIC_KEY is required');
  const embedded = execute('/usr/bin/plutil', ['-extract', 'SUPublicEDKey', 'raw', `${app}/Contents/Info.plist`], { encoding: 'utf8' }).trim();
  if (embedded !== publicKey) throw new Error('Packaged Sparkle public key differs from SPARKLE_PUBLIC_KEY');
  const environment = { ...process.env };
  delete environment.SPARKLE_PRIVATE_KEY;
  const signature = execute(signer, ['--ed-key-file', '-', '-p', archive], {
    input: `${privateKey.trim()}\n`, encoding: 'utf8', env: environment, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki' });
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(signature) || !crypto.verify(null, fs.readFileSync(archive), key, Buffer.from(signature, 'base64'))) {
    throw new Error('Sparkle signature does not verify with the embedded public key');
  }
  return { name: require('node:path').basename(archive), ed_signature: signature, public_key: publicKey };
}

module.exports = { sign };
if (require.main === module) {
  try {
    const [archive, app, signer, output] = process.argv.slice(2);
    if (!archive || !app || !signer || !output) throw new Error('Usage: release-sign-mac.cjs archive app sign_update output');
    fs.writeFileSync(output, `${JSON.stringify(sign({ archive, app, signer, publicKey: process.env.SPARKLE_PUBLIC_KEY, privateKey: process.env.SPARKLE_PRIVATE_KEY }), null, 2)}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
