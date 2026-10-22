const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POINTER_VERSION = 1;
const LIBRARY_FILES = new Set(['library.json', 'library.json.bak', 'vocabulary.json', 'vocabulary.json.bak']);
const DESKTOP_STATE_FILES = ['settings.json', 'ai-status-history.json', 'account.json'];

function expandHome(value) {
  const text = String(value || '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith(`~${path.sep}`)) return path.join(os.homedir(), text.slice(2));
  return text;
}

function absolutePath(value) {
  return path.resolve(expandHome(value));
}

function libraryPointerPath(stateDir) {
  return path.join(absolutePath(stateDir), '.library-location.json');
}

function desktopStorageLayout({ projectRoot, userDataDir, isPackaged, env = process.env }) {
  const root = absolutePath(projectRoot);
  const packagedUserDataDir = absolutePath(userDataDir);
  const explicitStateDir = String(env.MY_SCHOLAR_DATA_DIR || '').trim();
  const stateDir = explicitStateDir
    ? absolutePath(explicitStateDir)
    : (isPackaged ? path.join(packagedUserDataDir, 'state') : path.join(root, 'data'));
  const defaultLibraryDir = explicitStateDir
    ? stateDir
    : (isPackaged ? path.join(packagedUserDataDir, 'library') : stateDir);
  const legacyDataDir = isPackaged && !explicitStateDir ? path.join(packagedUserDataDir, 'data') : null;
  const legacyStateDir = isPackaged && !explicitStateDir ? defaultLibraryDir : null;
  const legacyPointerPath = legacyStateDir ? libraryPointerPath(legacyStateDir) : null;
  return {
    projectRoot: root,
    stateDir,
    defaultLibraryDir,
    pointerPath: libraryPointerPath(stateDir),
    legacyStateDir,
    legacyPointerPath,
    legacyStateDirs: [legacyStateDir, legacyDataDir].filter(Boolean),
    legacyPointerPaths: [legacyPointerPath, legacyDataDir ? libraryPointerPath(legacyDataDir) : null].filter(Boolean),
    legacyLibraryDirs: legacyDataDir ? [legacyDataDir] : [],
  };
}

function readLibraryPointer(pointerPath) {
  try {
    const payload = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    if (payload?.version !== POINTER_VERSION || typeof payload.libraryPath !== 'string' || !payload.libraryPath.trim()) {
      throw new Error('文献库位置记录内容无效。');
    }
    return absolutePath(payload.libraryPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error('文献库位置记录已损坏。请恢复该记录，或在确认原文献库位置后重新选择存放位置。');
    }
    if (error?.message === '文献库位置记录内容无效。') {
      throw new Error('文献库位置记录内容无效。请确认原文献库位置后重新选择存放位置。');
    }
    throw new Error(`无法读取文献库位置记录：${error?.message || error}`);
  }
}

function resolveLibraryLocation({ defaultLibraryDir, pointerPath, env = process.env }) {
  const environmentPath = String(env.MY_SCHOLAR_LIBRARY_DIR || '').trim();
  if (environmentPath) {
    return {
      currentPath: absolutePath(environmentPath),
      source: 'environment',
      readOnly: true,
      canChange: false,
    };
  }
  const savedPath = readLibraryPointer(pointerPath);
  if (savedPath) {
    return { currentPath: savedPath, source: 'saved', readOnly: false, canChange: true };
  }
  return {
    currentPath: absolutePath(defaultLibraryDir),
    source: 'default',
    readOnly: false,
    canChange: true,
  };
}

function pathContains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalDirectory(directory, label) {
  const requested = absolutePath(directory);
  let info;
  try {
    info = await fs.promises.lstat(requested);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label}不存在。`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${label}不能是符号链接。`);
  if (!info.isDirectory()) throw new Error(`${label}必须是文件夹。`);
  return fs.promises.realpath(requested);
}

async function inspectLibraryDirectory(directory) {
  const requested = absolutePath(directory);
  let rootInfo;
  try {
    rootInfo = await fs.promises.lstat(requested);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path: requested, exists: false, valid: true, empty: true, itemCount: 0, jobCount: 0, updatedAt: '' };
    }
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return { path: requested, exists: true, valid: false, empty: false, itemCount: 0, jobCount: 0, updatedAt: '', error: '文献库路径不是安全的本地文件夹。' };
  }

  const root = await fs.promises.realpath(requested);
  const jobsPath = path.join(root, 'jobs');
  let jobCount = 0;
  let durableJobEntry = false;
  try {
    const jobsInfo = await fs.promises.lstat(jobsPath);
    if (jobsInfo.isSymbolicLink() || !jobsInfo.isDirectory()) {
      return { path: root, exists: true, valid: false, empty: false, itemCount: 0, jobCount: 0, updatedAt: '', error: '文献任务目录结构无效。' };
    }
    const entries = await fs.promises.readdir(jobsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.incoming') continue;
      durableJobEntry = true;
      if (entry.isSymbolicLink()) {
        return { path: root, exists: true, valid: false, empty: false, itemCount: 0, jobCount: 0, updatedAt: '', error: '文献任务目录包含不受支持的符号链接。' };
      }
      if (entry.isDirectory() && !entry.name.startsWith('.')) jobCount += 1;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const libraryPath = path.join(root, 'library.json');
  let libraryInfo;
  try {
    libraryInfo = await fs.promises.lstat(libraryPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!libraryInfo) {
    const ignoredRootEntries = new Set([...DESKTOP_STATE_FILES, '.library-location.json', '.my-scholar.lock', 'jobs']);
    const rootEntries = await fs.promises.readdir(root);
    const unknownEntries = rootEntries.filter((name) => !ignoredRootEntries.has(name));
    const empty = !durableJobEntry && unknownEntries.length === 0;
    return {
      path: root,
      exists: true,
      valid: empty,
      empty,
      itemCount: 0,
      jobCount,
      updatedAt: '',
      ...(empty ? {} : { error: '目录中存在文献文件，但缺少 library.json，未自动切换。' }),
    };
  }
  if (libraryInfo.isSymbolicLink() || !libraryInfo.isFile()) {
    return { path: root, exists: true, valid: false, empty: false, itemCount: 0, jobCount, updatedAt: '', error: 'library.json 不是安全的普通文件。' };
  }

  let payload;
  try {
    payload = JSON.parse(await fs.promises.readFile(libraryPath, 'utf8'));
  } catch (_) {
    return { path: root, exists: true, valid: false, empty: false, itemCount: 0, jobCount, updatedAt: '', error: 'library.json 无法解析，未自动切换。' };
  }
  const items = payload?.items;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (!Array.isArray(items) && (!items || typeof items !== 'object'))) {
    return { path: root, exists: true, valid: false, empty: false, itemCount: 0, jobCount, updatedAt: '', error: 'library.json 结构不受支持，未自动切换。' };
  }
  const itemCount = Array.isArray(items) ? items.length : Object.keys(items).length;
  const hasVocabulary = (await fs.promises.readdir(root)).some((name) => name === 'vocabulary.json' || name === 'vocabulary.json.bak');
  return {
    path: root,
    exists: true,
    valid: true,
    empty: itemCount === 0 && jobCount === 0 && !hasVocabulary,
    itemCount,
    jobCount,
    updatedAt: typeof payload.updated_at === 'string' ? payload.updated_at : '',
  };
}

async function adoptLegacyLibraryIfSafe({ currentPath, currentSource, pointerPath, legacyLibraryDirs = [] }) {
  const current = await inspectLibraryDirectory(currentPath);
  const legacy = [];
  const seen = new Set([absolutePath(currentPath)]);
  for (const directory of legacyLibraryDirs) {
    const candidate = absolutePath(directory);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    legacy.push(await inspectLibraryDirectory(candidate));
  }
  const available = legacy.filter((candidate) => candidate.valid && !candidate.empty);
  const report = { state: 'none', adopted: false, current, legacy };
  if (currentSource !== 'default') return { ...report, state: 'already-selected' };
  if (!available.length) {
    return { ...report, state: legacy.some((candidate) => candidate.exists && !candidate.valid) ? 'invalid' : 'none' };
  }
  if (!current.valid || !current.empty || available.length > 1) return { ...report, state: 'conflict' };
  const selected = available[0];
  await writeLibraryPointer(pointerPath, selected.path);
  return { ...report, state: 'adopted', adopted: true, selectedPath: selected.path, selected };
}

async function validateMigrationTarget(sourceDir, targetDir) {
  const source = await canonicalDirectory(sourceDir, '当前文献库');
  const target = await canonicalDirectory(targetDir, '目标位置');
  if (pathContains(source, target) || pathContains(target, source)) {
    throw new Error('目标位置不能是当前文献库，也不能与它互相嵌套。');
  }
  const entries = await fs.promises.readdir(target);
  if (entries.length) throw new Error('目标文件夹必须为空，请新建一个空文件夹后重试。');
  const parent = path.dirname(target);
  const [targetInfo, parentInfo] = await Promise.all([fs.promises.stat(target), fs.promises.stat(parent)]);
  if (targetInfo.dev !== parentInfo.dev) {
    throw new Error('不能直接使用磁盘根目录，请在磁盘中创建一个空文件夹。');
  }
  await Promise.all([
    fs.promises.access(target, fs.constants.R_OK | fs.constants.W_OK),
    fs.promises.access(parent, fs.constants.R_OK | fs.constants.W_OK),
  ]);
  return { source, target, parent };
}

function excludedRelativePath(relativePath, directory = false) {
  const normalized = relativePath.split(path.sep).join('/');
  if (normalized === 'jobs/.incoming' || normalized.startsWith('jobs/.incoming/')) return true;
  if (!directory && (normalized.endsWith('.tmp') || normalized.endsWith('.part'))) return true;
  return false;
}

async function sha256File(filePath) {
  const hasher = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hasher.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return hasher.digest('hex');
}

async function walkLibrary(source) {
  const files = [];
  const directories = new Set(['jobs']);

  async function walk(relativeDirectory) {
    const absoluteDirectory = path.join(source, relativeDirectory);
    let entries;
    try {
      entries = await fs.promises.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      if (excludedRelativePath(relative, entry.isDirectory())) continue;
      const absolute = path.join(source, relative);
      const info = await fs.promises.lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`文献库包含不受支持的符号链接：${relative}`);
      if (info.isDirectory()) {
        directories.add(relative);
        await walk(relative);
      } else if (info.isFile()) {
        files.push({ relative, size: info.size, mode: info.mode, sha256: await sha256File(absolute) });
      }
    }
  }

  for (const name of LIBRARY_FILES) {
    const absolute = path.join(source, name);
    try {
      const info = await fs.promises.lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`文献库包含不受支持的符号链接：${name}`);
      if (info.isFile()) files.push({ relative: name, size: info.size, mode: info.mode, sha256: await sha256File(absolute) });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await walk('jobs');
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  return {
    directories: [...directories].sort((left, right) => left.localeCompare(right)),
    files,
    bytes: files.reduce((total, file) => total + file.size, 0),
  };
}

async function availableBytes(directory) {
  if (typeof fs.promises.statfs !== 'function') return null;
  const stats = await fs.promises.statfs(directory, { bigint: true });
  return stats.bavail * stats.bsize;
}

async function verifyManifest(root, expected) {
  let bytes = 0;
  for (const file of expected.files) {
    const candidate = path.join(root, file.relative);
    const info = await fs.promises.lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) {
      throw new Error(`迁移校验失败：${file.relative}`);
    }
    const digest = await sha256File(candidate);
    if (digest !== file.sha256) throw new Error(`迁移校验失败：${file.relative}`);
    bytes += info.size;
  }
  return { files: expected.files.length, bytes };
}

async function copyLibraryToEmptyTarget({ sourceDir, targetDir, onProgress = () => {} }) {
  const { source, target, parent } = await validateMigrationTarget(sourceDir, targetDir);
  onProgress({ phase: 'scan', message: '正在核对现有文献…' });
  const manifest = await walkLibrary(source);
  const free = await availableBytes(parent);
  if (free !== null && free < BigInt(manifest.bytes)) throw new Error('目标磁盘可用空间不足。');

  const staging = path.join(parent, `.${path.basename(target)}.my-scholar-staging-${crypto.randomUUID()}`);
  await fs.promises.mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    for (const relative of manifest.directories) {
      await fs.promises.mkdir(path.join(staging, relative), { recursive: true });
    }
    let copiedFiles = 0;
    let copiedBytes = 0;
    for (const file of manifest.files) {
      const destination = path.join(staging, file.relative);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await fs.promises.copyFile(path.join(source, file.relative), destination, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(destination, file.mode & 0o777);
      copiedFiles += 1;
      copiedBytes += file.size;
      onProgress({ phase: 'copy', message: '正在复制文献…', files: copiedFiles, bytes: copiedBytes, totalFiles: manifest.files.length, totalBytes: manifest.bytes });
    }
    onProgress({ phase: 'verify', message: '正在校验复制结果…' });
    const verified = await verifyManifest(staging, manifest);
    const targetEntries = await fs.promises.readdir(target);
    if (targetEntries.length) throw new Error('复制期间目标文件夹发生了变化，已取消切换。');
    await fs.promises.rmdir(target);
    await fs.promises.rename(staging, target);
    return { sourcePath: source, targetPath: target, files: verified.files, bytes: verified.bytes };
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteFile(targetPath, bytes) {
  const parent = path.dirname(targetPath);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(targetPath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, targetPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

async function writeLibraryPointer(pointerPath, libraryPath) {
  const payload = Buffer.from(`${JSON.stringify({
    version: POINTER_VERSION,
    libraryPath: absolutePath(libraryPath),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  await atomicWriteFile(pointerPath, payload);
}

async function migrateLegacyDesktopState({ stateDir, pointerPath, legacyStateDir, legacyPointerPath, legacyStateDirs, legacyPointerPaths }) {
  const stateSources = (Array.isArray(legacyStateDirs) ? legacyStateDirs : [legacyStateDir]).filter(Boolean)
    .map(absolutePath)
    .filter((source, index, sources) => source !== absolutePath(stateDir) && sources.indexOf(source) === index);
  const pointerSources = (Array.isArray(legacyPointerPaths) ? legacyPointerPaths : [legacyPointerPath]).filter(Boolean);
  if (!stateSources.length && !pointerSources.length) {
    return { copied: [], pointerMigrated: false };
  }
  const destinationRoot = absolutePath(stateDir);
  await fs.promises.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const name of DESKTOP_STATE_FILES) {
    const destination = path.join(destinationRoot, name);
    if (fs.existsSync(destination)) continue;
    for (const legacyRoot of stateSources) {
      const source = path.join(legacyRoot, name);
      try {
        const info = await fs.promises.lstat(source);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        await fs.promises.chmod(destination, 0o600);
        copied.push(name);
        break;
      } catch (error) {
        if (!['ENOENT', 'EEXIST'].includes(error?.code)) throw error;
        if (error?.code === 'EEXIST') break;
      }
    }
  }
  let pointerMigrated = false;
  if (!fs.existsSync(pointerPath)) {
    for (const legacyPointer of pointerSources) {
      const savedLibrary = readLibraryPointer(legacyPointer);
      if (savedLibrary) {
        await writeLibraryPointer(pointerPath, savedLibrary);
        pointerMigrated = true;
        break;
      }
    }
  }
  return { copied, pointerMigrated };
}

async function snapshotPointer(pointerPath) {
  try {
    return await fs.promises.readFile(pointerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function restorePointer(pointerPath, snapshot) {
  if (snapshot === null) {
    await fs.promises.unlink(pointerPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return;
  }
  await atomicWriteFile(pointerPath, snapshot);
}

module.exports = {
  adoptLegacyLibraryIfSafe,
  copyLibraryToEmptyTarget,
  desktopStorageLayout,
  inspectLibraryDirectory,
  libraryPointerPath,
  migrateLegacyDesktopState,
  readLibraryPointer,
  resolveLibraryLocation,
  restorePointer,
  snapshotPointer,
  validateMigrationTarget,
  writeLibraryPointer,
};
