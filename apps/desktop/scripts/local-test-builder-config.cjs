'use strict';

const path = require('path');
const { build } = require('../package.json');
const { LOCAL_TEST_BUILD } = require('./build-mac-target.cjs');

module.exports = {
  ...build,
  appId: 'com.guzi.scholar.local-test',
  productName: '谷子学术测试版',
  artifactName: `Guzi-Scholar-\${version}-\${arch}-local-test-${LOCAL_TEST_BUILD}.\${ext}`,
  extraMetadata: { ...build.extraMetadata, localTestBuild: LOCAL_TEST_BUILD },
  directories: { ...build.directories, output: path.join(__dirname, '..', 'dist', `local-test-${LOCAL_TEST_BUILD}.noindex`) },
  mac: {
    ...build.mac,
    identity: '-',
    hardenedRuntime: false,
    notarize: false,
    extendInfo: { ...build.mac.extendInfo, CFBundleName: '谷子学术测试版', CFBundleDisplayName: '谷子学术测试版' },
  },
  dmg: { ...build.dmg, title: `谷子学术测试版 ${LOCAL_TEST_BUILD}` },
};
