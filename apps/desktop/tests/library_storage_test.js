const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  adoptLegacyLibraryIfSafe,
  copyLibraryToEmptyTarget,
  desktopStorageLayout,
  inspectLibraryDirectory,
  libraryPointerPath,
  migrateLegacyDesktopState,
  resolveLibraryLocation,
  restorePointer,
  snapshotPointer,
  validateMigrationTarget,
  writeLibraryPointer,
} = require('../electron/library-storage.cjs');

async function temporaryDirectory(prefix) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function write(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content);
}

async function testResolutionPrecedence() {
  const root = await temporaryDirectory('my-scholar-location-');
  try {
    const pointer = path.join(root, 'state', 'library-location.json');
    const fallback = path.join(root, 'fallback');
    const saved = path.join(root, 'saved');
    const environment = path.join(root, 'environment');
    assert.strictEqual(libraryPointerPath(path.join(root, 'state')), path.join(root, 'state', '.library-location.json'));
    await writeLibraryPointer(pointer, saved);
    assert.deepStrictEqual(resolveLibraryLocation({ defaultLibraryDir: fallback, pointerPath: pointer, env: {} }), {
      currentPath: saved,
      source: 'saved',
      readOnly: false,
      canChange: true,
    });
    assert.deepStrictEqual(resolveLibraryLocation({ defaultLibraryDir: fallback, pointerPath: pointer, env: { MY_SCHOLAR_LIBRARY_DIR: environment } }), {
      currentPath: environment,
      source: 'environment',
      readOnly: true,
      canChange: false,
    });
    await fs.promises.unlink(pointer);
    assert.strictEqual(resolveLibraryLocation({ defaultLibraryDir: fallback, pointerPath: pointer, env: {} }).currentPath, fallback);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testPackagedStateSurvivesDeletingTheOldDefaultLibrary() {
  const root = await temporaryDirectory('my-scholar-packaged-state-');
  try {
    const layout = desktopStorageLayout({ projectRoot: path.join(root, 'app'), userDataDir: path.join(root, 'user-data'), isPackaged: true, env: {} });
    assert.strictEqual(layout.stateDir, path.join(root, 'user-data', 'state'));
    assert.strictEqual(layout.defaultLibraryDir, path.join(root, 'user-data', 'library'));
    assert.notStrictEqual(layout.pointerPath, layout.legacyPointerPath);
    const externalLibrary = path.join(root, 'external-library');
    await writeLibraryPointer(layout.legacyPointerPath, externalLibrary);
    await write(path.join(layout.legacyStateDir, 'settings.json'), '{"appearance":{"theme":"dark"}}');
    await write(path.join(layout.legacyStateDir, 'account.json'), '{"token":"legacy"}');
    const migrated = await migrateLegacyDesktopState(layout);
    assert.strictEqual(migrated.pointerMigrated, true);
    assert.deepStrictEqual(migrated.copied.sort(), ['account.json', 'settings.json']);
    await fs.promises.rm(layout.legacyStateDir, { recursive: true, force: true });
    assert.strictEqual(resolveLibraryLocation({ defaultLibraryDir: layout.defaultLibraryDir, pointerPath: layout.pointerPath, env: {} }).currentPath, externalLibrary);
    assert.strictEqual(await fs.promises.readFile(path.join(layout.stateDir, 'settings.json'), 'utf8'), '{"appearance":{"theme":"dark"}}');
    assert.strictEqual((await fs.promises.stat(path.join(layout.stateDir, 'account.json'))).mode & 0o777, 0o600);

    const explicit = desktopStorageLayout({ projectRoot: path.join(root, 'app'), userDataDir: path.join(root, 'user-data'), isPackaged: true, env: { MY_SCHOLAR_DATA_DIR: path.join(root, 'custom') } });
    assert.strictEqual(explicit.stateDir, explicit.defaultLibraryDir);
    assert.strictEqual(explicit.legacyStateDir, null);
    assert.deepStrictEqual(explicit.legacyLibraryDirs, []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testLegacyDataLibraryIsAdoptedWithoutCopying() {
  const root = await temporaryDirectory('my-scholar-legacy-data-');
  try {
    const userData = path.join(root, 'user-data');
    const layout = desktopStorageLayout({ projectRoot: path.join(root, 'app'), userDataDir: userData, isPackaged: true, env: {} });
    const legacy = path.join(userData, 'data');
    await write(path.join(layout.defaultLibraryDir, 'jobs', '.incoming', 'ignored.part'), 'partial');
    await write(path.join(legacy, 'library.json'), JSON.stringify({ version: 4, updated_at: '2026-08-01T00:00:00Z', items: { paper1: {}, paper2: {} } }));
    await write(path.join(legacy, 'library.json.bak'), JSON.stringify({ version: 4, items: { paper1: {} } }));
    await write(path.join(legacy, 'jobs', 'paper1', 'source.pdf'), '%PDF-one');
    await write(path.join(legacy, 'jobs', 'paper2', 'source.pdf'), '%PDF-two');
    await write(path.join(legacy, 'settings.json'), '{"appearance":{"theme":"dark"}}');

    const migratedState = await migrateLegacyDesktopState(layout);
    assert.deepStrictEqual(migratedState.copied, ['settings.json']);
    const report = await adoptLegacyLibraryIfSafe({
      currentPath: layout.defaultLibraryDir,
      currentSource: 'default',
      pointerPath: layout.pointerPath,
      legacyLibraryDirs: layout.legacyLibraryDirs,
    });
    assert.strictEqual(report.state, 'adopted');
    assert.strictEqual(report.selected.itemCount, 2);
    assert.strictEqual(report.selected.jobCount, 2);
    assert.strictEqual(resolveLibraryLocation({ defaultLibraryDir: layout.defaultLibraryDir, pointerPath: layout.pointerPath, env: {} }).currentPath, await fs.promises.realpath(legacy));
    assert.strictEqual(await fs.promises.readFile(path.join(legacy, 'jobs', 'paper1', 'source.pdf'), 'utf8'), '%PDF-one');
    assert.strictEqual(fs.existsSync(path.join(layout.defaultLibraryDir, 'library.json')), false);

    const repeated = await adoptLegacyLibraryIfSafe({
      currentPath: legacy,
      currentSource: 'saved',
      pointerPath: layout.pointerPath,
      legacyLibraryDirs: layout.legacyLibraryDirs,
    });
    assert.strictEqual(repeated.state, 'already-selected');
    assert.strictEqual(repeated.adopted, false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testLegacyLibraryConflictNeverOverwritesCurrentLibrary() {
  const root = await temporaryDirectory('my-scholar-legacy-conflict-');
  try {
    const layout = desktopStorageLayout({ projectRoot: path.join(root, 'app'), userDataDir: path.join(root, 'user-data'), isPackaged: true, env: {} });
    const legacy = layout.legacyLibraryDirs[0];
    await write(path.join(layout.defaultLibraryDir, 'library.json'), JSON.stringify({ version: 4, items: { current: {} } }));
    await write(path.join(layout.defaultLibraryDir, 'jobs', 'current', 'source.pdf'), '%PDF-current');
    await write(path.join(legacy, 'library.json'), JSON.stringify({ version: 4, items: { old1: {}, old2: {} } }));
    await write(path.join(legacy, 'jobs', 'old1', 'source.pdf'), '%PDF-old');

    const report = await adoptLegacyLibraryIfSafe({
      currentPath: layout.defaultLibraryDir,
      currentSource: 'default',
      pointerPath: layout.pointerPath,
      legacyLibraryDirs: layout.legacyLibraryDirs,
    });
    assert.strictEqual(report.state, 'conflict');
    assert.strictEqual(report.current.itemCount, 1);
    assert.strictEqual(report.legacy[0].itemCount, 2);
    assert.strictEqual(fs.existsSync(layout.pointerPath), false);
    assert.strictEqual(await fs.promises.readFile(path.join(layout.defaultLibraryDir, 'jobs', 'current', 'source.pdf'), 'utf8'), '%PDF-current');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testVocabularyPreventsAutomaticLegacyLibraryReplacement() {
  const root = await temporaryDirectory('my-scholar-vocabulary-adoption-');
  try {
    const current = path.join(root, 'current');
    const legacy = path.join(root, 'legacy');
    const pointer = path.join(root, 'pointer.json');
    await write(path.join(current, 'library.json'), '{"items":{}}');
    await write(path.join(current, 'vocabulary.json'), '{"version":1,"entries":[{"term":"method"}]}');
    await write(path.join(legacy, 'library.json'), '{"items":{"old":{}}}');
    const report = await adoptLegacyLibraryIfSafe({ currentPath: current, currentSource: 'default', pointerPath: pointer, legacyLibraryDirs: [legacy] });
    assert.strictEqual(report.state, 'conflict');
    assert.strictEqual(report.current.empty, false);
    assert.strictEqual(fs.existsSync(pointer), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testInvalidLegacyLibraryIsReportedButNotSelected() {
  const root = await temporaryDirectory('my-scholar-legacy-invalid-');
  try {
    const layout = desktopStorageLayout({ projectRoot: path.join(root, 'app'), userDataDir: path.join(root, 'user-data'), isPackaged: true, env: {} });
    await write(path.join(layout.legacyLibraryDirs[0], 'library.json'), '{broken');
    const summary = await inspectLibraryDirectory(layout.legacyLibraryDirs[0]);
    assert.strictEqual(summary.valid, false);
    const report = await adoptLegacyLibraryIfSafe({
      currentPath: layout.defaultLibraryDir,
      currentSource: 'default',
      pointerPath: layout.pointerPath,
      legacyLibraryDirs: layout.legacyLibraryDirs,
    });
    assert.strictEqual(report.state, 'invalid');
    assert.strictEqual(fs.existsSync(layout.pointerPath), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testCopyScopeAndVerification() {
  const root = await temporaryDirectory('my-scholar-migration-');
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await Promise.all([fs.promises.mkdir(source), fs.promises.mkdir(target)]);
    await write(path.join(source, 'settings.json'), 'settings stay local');
    await write(path.join(source, 'account.json'), 'account stays local');
    await write(path.join(source, '.my-scholar.lock'), 'lock is never copied');
    await write(path.join(source, 'library.json'), '{"items":{}}');
    await write(path.join(source, 'library.json.bak'), '{"items":{"old":true}}');
    await write(path.join(source, 'vocabulary.json'), '{"version":1,"entries":[{"term":"method"}]}');
    await write(path.join(source, 'vocabulary.json.bak'), '{"version":1,"entries":[]}');
    await write(path.join(source, 'plugin-data', 'example.reading', 'storage.json'), '{"queue":["paper-a"]}');
    await write(path.join(source, 'jobs', 'abc123abc123', 'source.pdf'), Buffer.from('%PDF-test'));
    await write(path.join(source, 'jobs', 'abc123abc123', 'content', 'notes.md'), 'note');
    await write(path.join(source, 'jobs', '.duplicates', 'merge-manifest.json'), '{"groups":[]}');
    await write(path.join(source, 'jobs', '.incoming', 'upload.pdf.part'), 'partial upload');
    await write(path.join(source, 'jobs', 'abc123abc123', 'orphan.tmp'), 'temporary');
    const phases = [];
    const result = await copyLibraryToEmptyTarget({ sourceDir: source, targetDir: target, onProgress: ({ phase }) => phases.push(phase) });
    assert.strictEqual(result.sourcePath, await fs.promises.realpath(source));
    assert.strictEqual(result.targetPath, await fs.promises.realpath(target));
    assert.strictEqual(result.files, 8);
    assert.strictEqual(await fs.promises.readFile(path.join(target, 'vocabulary.json'), 'utf8'), '{"version":1,"entries":[{"term":"method"}]}');
    assert.strictEqual(await fs.promises.readFile(path.join(target, 'vocabulary.json.bak'), 'utf8'), '{"version":1,"entries":[]}');
    assert.strictEqual(await fs.promises.readFile(path.join(target, 'plugin-data', 'example.reading', 'storage.json'), 'utf8'), '{"queue":["paper-a"]}');
    assert.ok(result.bytes > 0);
    assert.deepStrictEqual([...new Set(phases)], ['scan', 'copy', 'verify']);
    assert.strictEqual(await fs.promises.readFile(path.join(target, 'jobs', 'abc123abc123', 'content', 'notes.md'), 'utf8'), 'note');
    assert.strictEqual(await fs.promises.readFile(path.join(target, 'jobs', '.duplicates', 'merge-manifest.json'), 'utf8'), '{"groups":[]}');
    for (const relative of ['settings.json', 'account.json', '.my-scholar.lock', 'jobs/.incoming', 'jobs/abc123abc123/orphan.tmp']) {
      assert.strictEqual(fs.existsSync(path.join(target, relative)), false, `${relative} should not be copied`);
    }
    assert.strictEqual(await fs.promises.readFile(path.join(source, 'account.json'), 'utf8'), 'account stays local');
    assert.strictEqual(await fs.promises.readFile(path.join(source, 'jobs', 'abc123abc123', 'source.pdf'), 'utf8'), '%PDF-test');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testUnsafeTargetsAreRejected() {
  const root = await temporaryDirectory('my-scholar-target-');
  try {
    const source = path.join(root, 'source');
    const nonEmpty = path.join(root, 'non-empty');
    const nested = path.join(source, 'nested');
    await Promise.all([fs.promises.mkdir(source), fs.promises.mkdir(nonEmpty)]);
    await fs.promises.mkdir(nested);
    await write(path.join(nonEmpty, 'existing.txt'), 'do not overwrite');
    await assert.rejects(validateMigrationTarget(source, nonEmpty), /必须为空/);
    await assert.rejects(validateMigrationTarget(source, nested), /互相嵌套/);
    assert.strictEqual(await fs.promises.readFile(path.join(nonEmpty, 'existing.txt'), 'utf8'), 'do not overwrite');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testSymlinkFailureLeavesSourceAndTargetUntouched() {
  if (process.platform === 'win32') return;
  const root = await temporaryDirectory('my-scholar-symlink-');
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await Promise.all([fs.promises.mkdir(source), fs.promises.mkdir(target)]);
    await write(path.join(source, 'outside.txt'), 'outside');
    await fs.promises.mkdir(path.join(source, 'jobs'));
    await fs.promises.symlink(path.join(source, 'outside.txt'), path.join(source, 'jobs', 'linked.pdf'));
    await assert.rejects(copyLibraryToEmptyTarget({ sourceDir: source, targetDir: target }), /符号链接/);
    assert.deepStrictEqual(await fs.promises.readdir(target), []);
    assert.strictEqual(await fs.promises.readFile(path.join(source, 'outside.txt'), 'utf8'), 'outside');
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testPointerRollback() {
  const root = await temporaryDirectory('my-scholar-pointer-');
  try {
    const pointer = path.join(root, 'state', 'library-location.json');
    const original = path.join(root, 'original');
    const next = path.join(root, 'next');
    await writeLibraryPointer(pointer, original);
    const snapshot = await snapshotPointer(pointer);
    await writeLibraryPointer(pointer, next);
    assert.strictEqual(resolveLibraryLocation({ defaultLibraryDir: original, pointerPath: pointer, env: {} }).currentPath, next);
    await restorePointer(pointer, snapshot);
    assert.strictEqual(resolveLibraryLocation({ defaultLibraryDir: next, pointerPath: pointer, env: {} }).currentPath, original);
    await fs.promises.unlink(pointer);
    const missingSnapshot = await snapshotPointer(pointer);
    await writeLibraryPointer(pointer, next);
    await restorePointer(pointer, missingSnapshot);
    assert.strictEqual(fs.existsSync(pointer), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testCorruptPointerNeverFallsBackToDefaultLibrary() {
  const root = await temporaryDirectory('my-scholar-pointer-corrupt-');
  try {
    const pointer = path.join(root, 'state', 'library-location.json');
    const fallback = path.join(root, 'fallback');
    await write(pointer, '{not-json');
    assert.throws(
      () => resolveLibraryLocation({ defaultLibraryDir: fallback, pointerPath: pointer, env: {} }),
      /已损坏/,
    );
    await write(pointer, JSON.stringify({ version: 1, libraryPath: '' }));
    assert.throws(
      () => resolveLibraryLocation({ defaultLibraryDir: fallback, pointerPath: pointer, env: {} }),
      /内容无效/,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function testQuitDuringMigrationStopsRestartedServer() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  const { createExitCoordinator } = require('../electron/exit-coordinator.cjs');
  const vm = require('vm');
  const waitBinding = source.match(/waitForMigration: (async \(\) => \{[^\n]+\})/u)?.[1];
  assert.ok(waitBinding, 'main must supply its live migration promise to the exit coordinator');
  assert.match(source, /before-quit[\s\S]*event\.preventDefault\(\)[\s\S]*exitCoordinator\.request\(\{ intent: 'quit' \}\)/u, 'quit during migration must enter the same awaited coordinator');
  for (const failMigration of [false, true]) {
    for (const failStop of [false, true]) {
      let finishMigration;
      let failPendingMigration;
      const events = [];
      let backend = 'original';
      let allowQuit = false;
      const migration = new Promise((resolve, reject) => { finishMigration = resolve; failPendingMigration = reject; });
      const waitForMigration = vm.runInNewContext(`(${waitBinding})`, { libraryMigrationPromise: migration });
      const coordinator = createExitCoordinator({
        waitForMigration,
        hasRenderer: () => true,
        flush: async () => { events.push('flush'); },
        cancelPreparedUpdateForExit: async () => { events.push('cancel-update'); },
        stopBackend: async () => { events.push(`stop-${backend}`); if (failStop) throw new Error('stop failed'); },
        finish: async (intent) => { assert.strictEqual(intent, 'quit'); events.push('quit'); allowQuit = true; },
        recoverBackend: async () => { events.push('recover'); },
        resumeRenderer: async () => { events.push('resume'); },
        resetExit: () => { allowQuit = false; },
        reportFailure: async () => {},
      });
      const quitting = coordinator.request({ intent: 'quit' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(events, [], 'quit must neither flush nor stop a service while migration is pending');
      backend = failMigration ? 'rollback-restarted' : 'migration-restarted';
      if (failMigration) failPendingMigration(new Error('migration failed after rollback'));
      else finishMigration();
      const result = await quitting;
      assert.ok(events.includes(`stop-${backend}`), 'quit must stop the backend restarted by successful migration or rollback');
      assert.ok(!events.includes('stop-original'), 'quit must not capture the old backend before migration completes');
      assert.strictEqual(result.ok, !failStop);
      assert.strictEqual(allowQuit, !failStop, 'a failed server stop must keep final quit blocked');
      if (!failStop) assert.ok(events.indexOf(`stop-${backend}`) < events.indexOf('quit'), 'the restarted backend must stop before final quit');
      else assert.ok(events.includes('resume'), 'failed stop must restore the renderer');
    }
  }
  assert.ok(source.includes('throw new Error(`本地文献服务进程'), 'a server that survives SIGKILL must keep the migration from copying a live library');
}

function testBrowserFallbackUsesTheSavedLibraryPointer() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'launcher.cjs'), 'utf8');
  assert.ok(source.includes('pointerPath: libraryPointerPath(stateDir)'), 'browser fallback must resolve the same saved library pointer as Electron');
  assert.ok(source.includes('MY_SCHOLAR_LIBRARY_DIR: location.currentPath'), 'browser fallback must start the server against the resolved library');
  assert.ok(source.includes('避免写入旧文献库'), 'an unavailable migrated library must not silently fall back to the old default');
}

async function main() {
  await testResolutionPrecedence();
  await testPackagedStateSurvivesDeletingTheOldDefaultLibrary();
  await testLegacyDataLibraryIsAdoptedWithoutCopying();
  await testLegacyLibraryConflictNeverOverwritesCurrentLibrary();
  await testInvalidLegacyLibraryIsReportedButNotSelected();
  await testVocabularyPreventsAutomaticLegacyLibraryReplacement();
  await testCopyScopeAndVerification();
  await testUnsafeTargetsAreRejected();
  await testSymlinkFailureLeavesSourceAndTargetUntouched();
  await testPointerRollback();
  await testCorruptPointerNeverFallsBackToDefaultLibrary();
  await testQuitDuringMigrationStopsRestartedServer();
  testBrowserFallbackUsesTheSavedLibraryPointer();
  console.log('library storage tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
