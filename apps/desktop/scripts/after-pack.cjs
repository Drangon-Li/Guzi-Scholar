'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const UNUSED_PERMISSION_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const productName = context.packager.appInfo.productFilename;
  const infoPath = path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Info.plist');
  for (const key of UNUSED_PERMISSION_KEYS) {
    try { execFileSync('/usr/bin/plutil', ['-remove', key, infoPath], { stdio: 'ignore' }); } catch (_) { /* The Electron template may stop adding this key. */ }
  }
  const updater = context.packager.config.extraMetadata?.updater;
  if (updater?.enabled) {
    const key = updater.publicKey;
    if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error('Updater-enabled macOS builds require a valid SPARKLE_PUBLIC_KEY');
    for (const [name, value] of Object.entries({ SUPublicEDKey: key, SUEnableAutomaticChecks: false, SUAutomaticallyUpdate: false, SUAllowsAutomaticUpdates: false, SUEnableInstallerLauncherService: false, SUEnableDownloaderService: false, LSMinimumSystemVersion: '12.0' })) {
      const args = typeof value === 'boolean' ? ['-bool', String(value)] : ['-string', value];
      execFileSync('/usr/bin/plutil', ['-replace', name, ...args, infoPath]);
    }
    const contents = path.dirname(infoPath);
    const framework = path.join(contents, 'Frameworks', 'Sparkle.framework');
    const addon = path.join(contents, 'Resources', 'sparkle-bridge.node');
    if (!fs.existsSync(path.join(framework, 'Sparkle')) || !fs.existsSync(addon)) throw new Error('Sparkle framework or bridge missing from updater-enabled package');
    const license = path.join(__dirname, '..', 'build', 'updater', 'Sparkle-2.10.1', 'LICENSE');
    const licenseTarget = path.join(contents, 'Resources', 'licenses', 'Sparkle-LICENSE');
    fs.mkdirSync(path.dirname(licenseTarget), { recursive: true });
    fs.copyFileSync(license, licenseTarget);
  }
  const transportSecurity = {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: true,
    NSExceptionDomains: {
      '127.0.0.1': { NSIncludesSubdomains: false, NSTemporaryExceptionAllowsInsecureHTTPLoads: true },
      localhost: { NSIncludesSubdomains: false, NSTemporaryExceptionAllowsInsecureHTTPLoads: true },
    },
  };
  execFileSync('/usr/bin/plutil', ['-replace', 'NSAppTransportSecurity', '-json', JSON.stringify(transportSecurity), infoPath]);
};
