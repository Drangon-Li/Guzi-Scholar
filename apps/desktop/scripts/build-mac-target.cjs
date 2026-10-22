'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LOCAL_TEST_BUILD = '20261022.5';

function preventBuildOutputIndexing(outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.closeSync(fs.openSync(path.join(outputDirectory, '.metadata_never_index'), 'a', 0o600));
}

function buildOptions(target, mode, environment = process.env) {
  const outputDirectory = path.join(root, 'dist', mode === 'local-test' ? `local-test-${LOCAL_TEST_BUILD}.noindex` : 'mac.noindex');
  const args = ['--mac', target, '--arm64', '--publish=never'];
  const env = { ...environment };
  if (mode === 'internal') {
    args.push(
      '--config.mac.identity=-',
      '--config.mac.hardenedRuntime=false',
      '--config.artifactName=Guzi-Scholar-${version}-${arch}-internal.${ext}',
    );
  }
  if (mode === 'local-test') {
    args.push('--config', path.join(__dirname, 'local-test-builder-config.cjs'));
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    delete env.CSC_LINK;
    delete env.CSC_KEY_PASSWORD;
  }
  return { args, env, outputDirectory };
}

function main() {
  const target = process.argv[2];
  const mode = process.argv[3];
  if (!['check', 'dir', 'dmg'].includes(target) || !['internal', 'release', 'local-test'].includes(mode)) {
    console.error('usage: node scripts/build-mac-target.cjs <check|dir|dmg> <internal|release|local-test>');
    return 1;
  }

  if (mode === 'release') {
    const identities = spawnSync(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8' },
    );
    const output = `${identities.stdout || ''}\n${identities.stderr || ''}`;
    const hasLinkedIdentity = Boolean(process.env.CSC_LINK?.trim());
    if (!hasLinkedIdentity && (identities.status !== 0 || !output.includes('Developer ID Application:'))) {
      console.error(
        '正式 macOS 发布需要 Developer ID Application 证书。当前未找到有效证书；请使用 npm run dist:mac:internal 生成内部测试包。',
      );
      return 1;
    }

    const hasAppleIdCredentials = [
      process.env.APPLE_ID,
      process.env.APPLE_APP_SPECIFIC_PASSWORD,
      process.env.APPLE_TEAM_ID,
    ].every((value) => Boolean(value?.trim()));
    const hasApiKeyCredentials = [
      process.env.APPLE_API_KEY,
      process.env.APPLE_API_KEY_ID,
      process.env.APPLE_API_ISSUER,
    ].every((value) => Boolean(value?.trim()));
    const hasKeychainProfile = Boolean(process.env.APPLE_KEYCHAIN_PROFILE?.trim());
    if (!hasAppleIdCredentials && !hasApiKeyCredentials && !hasKeychainProfile) {
      console.error('正式 macOS 发布还需要完整的 Apple 公证凭据；内部测试请使用 npm run dist:mac:internal。');
      return 1;
    }
  }

  if (target === 'check') return 0;

  const { args, env, outputDirectory } = buildOptions(target, mode);
  preventBuildOutputIndexing(outputDirectory);

  const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');
  const result = spawnSync(builder, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  preventBuildOutputIndexing(outputDirectory);
  return result.status ?? 1;
}

module.exports = { buildOptions, LOCAL_TEST_BUILD };
if (require.main === module) process.exitCode = main();
