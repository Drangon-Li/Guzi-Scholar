'use strict';

const assert = require('assert');
const fs = require('fs');
const { createRequire } = require('module');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildOptions, LOCAL_TEST_BUILD } = require('../scripts/build-mac-target.cjs');
const { configureBuildCommand, createYargs, normalizeOptions } = require('electron-builder/out/builder');

const root = path.join(__dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const badgeSource = fs.readFileSync(path.join(root, 'web', 'test-build.js'), 'utf8');

function loadMain(metadata, directory, development = false) {
  const paths = { appData: directory, userData: path.join(directory, 'production') };
  const calls = [];
  const handlers = new Map();
  const frame = { url: 'http://127.0.0.1:8766/' };
  const webContents = { mainFrame: frame };
  let startup;
  const app = {
    commandLine: { getSwitchValue: () => '', appendSwitch: () => {}, removeSwitch: () => {} },
    isPackaged: !development,
    getPath: (key) => paths[key],
    setPath: (key, value) => { paths[key] = value; calls.push(['setPath', key, value]); },
    setName: (value) => calls.push(['setName', value]),
    setAppLogsPath: (value) => calls.push(['setAppLogsPath', value]),
    getVersion: () => '0.4.0',
    requestSingleInstanceLock: () => { calls.push(['lock', paths.userData]); return true; },
    whenReady: () => ({ then: (callback) => { startup = callback; return { catch: () => {} }; } }),
    on: () => {},
  };
  const projectRequire = createRequire(mainPath);
  const counters = { updates: 0, legacy: 0, installation: 0 };
  const context = vm.createContext({
    require: (name) => {
      if (name === 'electron') return { app, powerMonitor: { on: () => {} }, ipcMain: { handle: (key, handler) => handlers.set(key, handler) } };
      if (name === '../package.json') return metadata;
      if (name === './update-service.cjs') return { ...projectRequire(name), checkForUpdate: () => { counters.updates += 1; } };
      if (name === './macos-installation.cjs') return {
        consumeInstallationMarker: () => { counters.installation += 1; return null; },
        requestMacInstallation: () => { counters.installation += 1; return { action: 'continue' }; },
      };
      if (name === './library-storage.cjs') {
        return {
          ...projectRequire(name),
          migrateLegacyDesktopState: async () => { counters.legacy += 1; return { copied: [] }; },
          adoptLegacyLibraryIfSafe: async () => { counters.legacy += 1; return { state: 'none' }; },
        };
      }
      return projectRequire(name);
    },
    __dirname: path.dirname(mainPath),
    process: {
      platform: 'darwin', arch: 'arm64',
      argv: development ? ['electron', '--guzi-development', `--guzi-dev-root=${path.join(directory, 'isolated-development')}`] : [],
      env: { MY_SCHOLAR_DATA_DIR: path.join(directory, 'production-state'), MY_SCHOLAR_LIBRARY_DIR: path.join(directory, 'production-library') },
    },
    console,
  });
  vm.runInContext(mainSource, context);
  context.testWebContents = webContents;
  vm.runInContext("mainWindow = { isDestroyed: () => false, webContents: testWebContents }; serverURL = 'http://127.0.0.1:8766/'; ensureWindow = async () => mainWindow;", context);
  return { paths, calls, counters, context, handlers, startup, event: { sender: webContents, senderFrame: frame } };
}

async function renderBadge(startupContext) {
  const elements = new Map();
  const styles = [];
  const context = vm.createContext({
    window: { myScholarDesktop: { getStartupContext: async () => startupContext } },
    document: {
      readyState: 'complete',
      getElementById: (id) => elements.get(id),
      createElement: () => ({ setAttribute(key, value) { this[key] = value; } }),
      head: { appendChild: (element) => styles.push(element) },
      body: { appendChild: (element) => elements.set(element.id, element) },
    },
    console,
  });
  vm.runInContext(badgeSource, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, styles };
}

async function main() {
  const options = buildOptions('dmg', 'local-test', { CSC_LINK: '/production.p12', CSC_KEY_PASSWORD: 'secret' });
  const parsed = normalizeOptions(configureBuildCommand(createYargs()).parse(options.args));
  assert.strictEqual(parsed.publish, 'never');
  const config = require(parsed.config);
  assert.strictEqual(config.appId, 'com.guzi.scholar.local-test');
  assert.strictEqual(config.productName, '谷子学术测试版');
  assert.strictEqual(config.mac.extendInfo.CFBundleDisplayName, '谷子学术测试版');
  assert.strictEqual(config.mac.identity, '-');
  assert.strictEqual(config.mac.notarize, false);
  assert.strictEqual(config.extraMetadata.localTestBuild, LOCAL_TEST_BUILD);
  assert.strictEqual(config.artifactName, `Guzi-Scholar-\${version}-\${arch}-local-test-${LOCAL_TEST_BUILD}.\${ext}`);
  assert.strictEqual(config.directories.output, options.outputDirectory);
  assert.strictEqual(Object.hasOwn(options.env, 'CSC_LINK'), false);
  assert.strictEqual(Object.hasOwn(options.env, 'CSC_KEY_PASSWORD'), false);
  assert.strictEqual(options.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert(options.outputDirectory.endsWith(`local-test-${LOCAL_TEST_BUILD}.noindex`));
  assert(!buildOptions('dmg', 'internal').args.some((flag) => flag.includes('localTestBuild')));
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert(!metadata.localTestBuild, 'normal source package must not enable the test build');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guzi-local-build-'));
  try {
    const test = loadMain({ localTestBuild: LOCAL_TEST_BUILD }, directory);
    const testUserData = path.join(directory, 'GuziScholar-LocalTest');
    assert.strictEqual(test.paths.userData, testUserData);
    assert.deepStrictEqual(test.calls.find(([name]) => name === 'lock'), ['lock', testUserData]);
    const storage = vm.runInContext('storageConfiguration()', test.context);
    assert.strictEqual(storage.stateDir, path.join(testUserData, 'state'));
    assert.strictEqual(storage.currentPath, path.join(testUserData, 'library'));
    await vm.runInContext('prepareDesktopStorage()', test.context);
    await test.startup();
    assert.strictEqual(test.counters.legacy, 0, 'test build must not migrate or adopt legacy state');
    assert.strictEqual(test.counters.installation, 0, 'test build must run directly without offering installation or replacement');
    const startup = test.handlers.get('my-scholar:get-startup-context')(test.event);
    assert.strictEqual(startup.app.name, '谷子学术测试版');
    assert.strictEqual(startup.app.localTestBuild, LOCAL_TEST_BUILD);
    assert.strictEqual(startup.app.channel, 'local-test');
    assert.strictEqual((await test.handlers.get('my-scholar:check-for-updates')(test.event)).ok, false);
    assert.strictEqual((await test.handlers.get('my-scholar:open-update-download')(test.event)).ok, false);
    assert.strictEqual(test.counters.updates, 0, 'test build must never query a production manifest');
    const development = loadMain({}, directory, true);
    const developmentRoot = path.join(directory, 'isolated-development');
    assert.strictEqual(development.paths.userData, developmentRoot);
    const developmentStorage = vm.runInContext('storageConfiguration()', development.context);
    assert.strictEqual(developmentStorage.stateDir, path.join(developmentRoot, 'state'));
    assert.strictEqual(developmentStorage.currentPath, path.join(developmentRoot, 'library'));
    await development.startup();
    assert.strictEqual(development.counters.legacy, 0, 'development must not adopt production data');
    assert.strictEqual(development.counters.installation, 0);
    const developmentContext = development.handlers.get('my-scholar:get-startup-context')(development.event);
    assert.strictEqual(developmentContext.app.channel, 'development');
    assert.strictEqual(developmentContext.app.name, '谷子学术开发版');
    assert.strictEqual((await development.handlers.get('my-scholar:check-for-updates')(development.event)).ok, false);
    const production = loadMain({}, directory);
    assert.strictEqual(production.paths.userData, path.join(directory, 'production'));
    assert.strictEqual(vm.runInContext('storageConfiguration().stateDir', production.context), path.join(directory, 'production-state'));
    assert.strictEqual(production.handlers.get('my-scholar:get-startup-context')(production.event).app.localTestBuild, undefined);
    await production.startup();
    assert.strictEqual(production.counters.installation, 2, 'production startup must retain its installation flow');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const testBadge = await renderBadge({ ok: true, app: { localTestBuild: LOCAL_TEST_BUILD } });
  assert.strictEqual(testBadge.elements.get('localTestBuildBadge').textContent, `测试版 · ${LOCAL_TEST_BUILD}`);
  assert.strictEqual(testBadge.elements.get('localTestBuildBadge').role, 'note');
  assert.match(testBadge.styles[0].textContent, /position:fixed;right:14px;bottom:12px/u);
  assert.match(testBadge.styles[0].textContent, /z-index:95/u);
  assert.match(testBadge.styles[0].textContent, /pointer-events:none/u);
  assert.match(testBadge.styles[0].textContent, /body \.toast\{bottom:calc\(48px/u);
  const productionBadge = await renderBadge({ ok: true, app: {} });
  assert.strictEqual(productionBadge.elements.size, 0);
  assert.strictEqual(productionBadge.styles.length, 0);
  const developmentBadge = await renderBadge({ ok: true, app: { developmentBuild: 'MCP · Plugins' } });
  assert.strictEqual(developmentBadge.elements.get('localTestBuildBadge').textContent, '开发版 · MCP · Plugins');
  console.log('local test build tests passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
