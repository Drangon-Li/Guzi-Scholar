'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LOCAL_TEST_BUILD = '20261022.5';
const { prepareSparkle } = require('./prepare-sparkle.cjs');

function preventBuildOutputIndexing(outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.closeSync(fs.openSync(path.join(outputDirectory, '.metadata_never_index'), 'a', 0o600));
}

function buildOptions(target, mode, environment = process.env) {
  const outputDirectory = path.join(root, 'dist', mode === 'local-test' ? `local-test-${LOCAL_TEST_BUILD}.noindex` : 'mac.noindex');
  const args = ['--mac', ...(target === 'all' ? ['dmg', 'zip'] : [target]), '--arm64', '--publish=never'];
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
  const channel = mode === 'local-test' ? 'local-test' : String(environment.GUZI_UPDATE_CHANNEL || (mode === 'release' ? 'stable' : 'internal'));
  if (!['stable', 'beta', 'internal', 'local-test'].includes(channel)) throw new Error('GUZI_UPDATE_CHANNEL must be stable or beta');
  const enabled = ['stable', 'beta'].includes(channel);
  const publicKey = String(environment.SPARKLE_PUBLIC_KEY || '').trim();
  if (enabled && (!publicKey || Buffer.from(publicKey, 'base64').length !== 32 || Buffer.from(publicKey, 'base64').toString('base64') !== publicKey)) throw new Error('Updater-enabled builds require SPARKLE_PUBLIC_KEY (32-byte canonical base64 public key)');
  const updater = enabled ? { enabled: true, channel, repository: 'Drangon-Li/Guzi-Scholar', publicKey, minimumSystemVersion: '12.0', frameworkVersion: '2.10.1' } : { enabled: false, channel };
  const { build } = require('../package.json');
  let configuration;
  if (enabled) {
    const productName = channel === 'beta' ? '谷子学术测试版' : build.productName;
    configuration = {
      ...build,
      appId: channel === 'beta' ? 'com.guzi.scholar.beta' : build.appId,
      productName,
      artifactName: `Guzi-Scholar-\${version}-\${arch}-${channel}.\${ext}`,
      extraMetadata: { ...build.extraMetadata, updater },
      directories: { ...build.directories, output: outputDirectory },
      extraResources: [...(build.extraResources || []), { from: 'build/updater/arm64/sparkle-bridge.node', to: 'sparkle-bridge.node' }],
      extraFiles: [...(build.extraFiles || []), { from: 'build/updater/Sparkle-2.10.1/Sparkle.framework', to: 'Frameworks/Sparkle.framework' }],
      mac: { ...build.mac, minimumSystemVersion: '12.0', extendInfo: { ...build.mac.extendInfo, CFBundleDisplayName: productName, CFBundleName: productName, SUPublicEDKey: publicKey, SUEnableAutomaticChecks: false, SUAutomaticallyUpdate: false, SUAllowsAutomaticUpdates: false } },
      dmg: { ...build.dmg, title: `${productName} \${version}` },
    };
    if (mode === 'internal') {
      configuration.mac.identity = '-';
      configuration.mac.hardenedRuntime = false;
      configuration.mac.notarize = false;
      const artifactOverride = args.indexOf('--config.artifactName=Guzi-Scholar-${version}-${arch}-internal.${ext}');
      if (artifactOverride >= 0) args.splice(artifactOverride, 1);
    }
    args.push('--config', path.join(root, 'build', 'updater', `mac-${channel}-builder.json`));
  } else if (mode !== 'local-test') {
    args.push('--config.extraMetadata.updater.enabled=false', `--config.extraMetadata.updater.channel=${channel}`);
  }
  return { args, env, outputDirectory, configuration, updater };
}

async function main() {
  const target = process.argv[2];
  const mode = process.argv[3];
  if (!['check', 'dir', 'dmg', 'zip', 'all'].includes(target) || !['internal', 'release', 'local-test'].includes(mode)) {
    console.error('usage: node scripts/build-mac-target.cjs <check|dir|dmg|zip|all> <internal|release|local-test>');
    return 1;
  }

  const { args, env, outputDirectory, configuration, updater } = buildOptions(target, mode);

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

  preventBuildOutputIndexing(outputDirectory);
  if (updater.enabled) {
    await prepareSparkle({ architecture: 'arm64', environment: env });
    fs.writeFileSync(path.join(root, 'build', 'updater', `mac-${updater.channel}-builder.json`), JSON.stringify(configuration));
  }

  const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');
  const result = spawnSync(builder, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  preventBuildOutputIndexing(outputDirectory);
  return result.status ?? 1;
}

module.exports = { buildOptions, LOCAL_TEST_BUILD };
if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
