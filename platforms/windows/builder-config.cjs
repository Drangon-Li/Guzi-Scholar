'use strict';

const base = require('./electron-builder.win.json');
const path = require('node:path');

const identities = {
  stable: { appId: 'com.guzi.scholar', guid: 'acfa1927-3d90-5574-b27a-fde562713e6a', productName: '谷子学术' },
  beta: { appId: 'com.guzi.scholar.beta', guid: 'ad45d8e0-4776-5040-bb81-94dd0e1f67f7', productName: '谷子学术 Beta' },
};

function createWindowsBuildConfig(environment = process.env) {
  const channel = environment.GUZI_UPDATE_CHANNEL || '';
  if (channel && !Object.hasOwn(identities, channel)) throw new Error('GUZI_UPDATE_CHANNEL must be stable or beta.');
  const mode = environment.GUZI_WINDOWS_BUILD_MODE || 'internal';
  if (!['internal', 'release', 'acceptance'].includes(mode)) throw new Error('GUZI_WINDOWS_BUILD_MODE must be internal, release or acceptance.');
  const signed = mode === 'release';
  const publisher = environment.GUZI_WINDOWS_PUBLISHER_NAME?.trim();
  if (signed && (!(environment.WIN_CSC_LINK || environment.CSC_LINK) || !publisher)) throw new Error('Signed Windows release requires an explicit certificate link and GUZI_WINDOWS_PUBLISHER_NAME.');
  const identity = identities[channel || 'stable'];
  const config = JSON.parse(JSON.stringify(base));
  config.appId = identity.appId;
  config.productName = identity.productName;
  config.nsis.guid = identity.guid;
  config.nsis.shortcutName = identity.productName;
  config.nsis.deleteAppDataOnUninstall = false;
  config.nsis.include = path.join(__dirname, 'installer.nsh');
  config.forceCodeSigning = signed;
  config.win.verifyUpdateCodeSignature = signed;
  if (signed) config.win.signtoolOptions = { publisherName: publisher, signingHashAlgorithms: ['sha256'] };
  config.extraMetadata.updater = { enabled: Boolean(channel), channel: channel || 'stable',
    repository: 'Drangon-Li/Guzi-Scholar', minimumSystemVersion: '10.0.18362', signing: signed ? 'authenticode' : 'unsigned-internal' };
  if (channel) {
    config.publish = [{ provider: 'generic', url: 'https://github.com/Drangon-Li/Guzi-Scholar/releases/download/v${version}/',
      channel: channel === 'stable' ? 'latest' : 'beta', useMultipleRangeRequest: false }];
    config.generateUpdatesFilesForAllChannels = false;
  } else config.publish = null;
  if (mode === 'acceptance') {
    const id = environment.GUZI_WINDOWS_ACCEPTANCE_ID || '';
    if (!/^[a-z0-9]{8,32}$/u.test(id)) throw new Error('Acceptance builds need a unique GUZI_WINDOWS_ACCEPTANCE_ID (8–32 lowercase letters/digits).');
    const { UUID } = require('../../apps/desktop/node_modules/builder-util-runtime');
    config.appId = `com.guzi.scholar.update-acceptance.${id}`;
    config.nsis.guid = UUID.v5(config.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'));
    config.productName = `Guzi Update Acceptance ${id}`;
    config.nsis.shortcutName = config.productName;
    config.extraMetadata.windowsUpdateAcceptance = { id, appId: config.appId, guid: config.nsis.guid };
  }
  return config;
}

module.exports = () => createWindowsBuildConfig();
module.exports.createWindowsBuildConfig = createWindowsBuildConfig;
module.exports.identities = identities;
