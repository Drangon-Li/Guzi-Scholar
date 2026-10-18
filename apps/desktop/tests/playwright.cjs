const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CLOSE_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;

function positiveIntegerEnv(name, fallback) {
  const configured = String(process.env[name] || '').trim();
  if (!configured) return fallback;
  const value = Number(configured);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const closeTimeoutMs = positiveIntegerEnv('MY_SCHOLAR_PLAYWRIGHT_CLOSE_TIMEOUT_MS', DEFAULT_CLOSE_TIMEOUT_MS);
const runTimeoutMs = positiveIntegerEnv('MY_SCHOLAR_PLAYWRIGHT_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);

function loadPlaywright() {
  const configured = String(process.env.MY_SCHOLAR_PLAYWRIGHT_MODULE || '').trim();
  const candidates = [
    configured,
    'playwright',
    path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'playwright'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    let entry;
    try {
      entry = require.resolve(candidate);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
      continue;
    }
    return require(entry);
  }

  throw new Error(
    '找不到 Playwright。请安装 playwright，或设置 MY_SCHOLAR_PLAYWRIGHT_MODULE 指向其包目录。',
  );
}

const playwright = loadPlaywright();
const activeSessions = new Set();
const pendingLaunches = new Set();
let terminating = false;

function configuredExecutablePath() {
  const configured = String(process.env.MY_SCHOLAR_PLAYWRIGHT_EXECUTABLE || '').trim();
  if (!configured) return undefined;

  let executablePath;
  try {
    executablePath = fs.realpathSync(configured);
  } catch (error) {
    throw new Error(`MY_SCHOLAR_PLAYWRIGHT_EXECUTABLE is not a valid executable: ${configured}`, { cause: error });
  }

  const normalized = executablePath.split(path.sep).join('/');
  const isGoogleChromeApp = /\/(?:Google Chrome|Google Chrome for Testing)(?: [^/]*)?\.app\/Contents\/MacOS\//u.test(normalized);
  if (isGoogleChromeApp) {
    throw new Error(
      'Refusing to launch a Google Chrome app through MY_SCHOLAR_PLAYWRIGHT_EXECUTABLE. '
      + 'Use the Playwright-managed headless browser instead.',
    );
  }
  return executablePath;
}

function processExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        () => ({ status: 'fulfilled' }),
        (error) => ({ status: 'rejected', error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function forceKill(session, closeResult) {
  if (processExited(session.browserProcess)) return;
  const result = await settleWithin(session.server.kill(), closeTimeoutMs);
  if (result.status === 'fulfilled' || processExited(session.browserProcess)) return;

  const closeError = closeResult?.error || new Error('Timed out while closing the Playwright browser');
  const killError = result.error || new Error('Timed out while force-killing the Playwright browser');
  process.exitCode = process.exitCode || 1;
  setTimeout(() => process.exit(process.exitCode || 1), 1000);
  throw new AggregateError([closeError, killError], 'Playwright browser close and kill both failed');
}

function closeSession(session) {
  if (session.closePromise) return session.closePromise;
  session.closePromise = (async () => {
    clearTimeout(session.runTimer);
    try {
      const result = await settleWithin(session.server.close(), closeTimeoutMs);
      if (result.status === 'fulfilled' || processExited(session.browserProcess)) return;

      const detail = result.status === 'timeout' ? `${closeTimeoutMs} ms timeout` : result.error?.message || 'unknown error';
      console.error(`[my-scholar-playwright] graceful close failed for pid=${session.browserProcess.pid}: ${detail}; force-killing this browser session`);
      await forceKill(session, result);
    } finally {
      activeSessions.delete(session);
    }
  })();
  return session.closePromise;
}

async function closeAllSessions() {
  // A signal can arrive while launchServer() is still starting Chromium.
  // Wait for in-flight launches so their sessions are registered and closable.
  await Promise.allSettled([...pendingLaunches]);
  const results = await Promise.allSettled([...activeSessions].map((session) => closeSession(session)));
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Failed to close all Playwright browser sessions');
}

function exitAfterCleanup(code, reason) {
  if (terminating) {
    process.exit(code);
    return;
  }
  terminating = true;
  process.exitCode = code;
  console.error(`[my-scholar-playwright] ${reason}`);
  const hardExitTimer = setTimeout(() => {
    console.error('[my-scholar-playwright] cleanup deadline exceeded; forcing test-process exit');
    process.exit(code);
  }, closeTimeoutMs * 2 + 2000);

  closeAllSessions()
    .catch((error) => console.error(error))
    .finally(() => {
      clearTimeout(hardExitTimer);
      process.exit(code);
    });
}

for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => exitAfterCleanup(code, `received ${signal}; closing managed browser sessions`));
}

async function launchManagedChromium() {
  const executablePath = configuredExecutablePath();
  const launchPromise = playwright.chromium.launchServer({
    headless: true,
    host: '127.0.0.1',
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    ...(executablePath ? { executablePath } : {}),
  });
  pendingLaunches.add(launchPromise);
  let server;
  try {
    server = await launchPromise;
  } finally {
    pendingLaunches.delete(launchPromise);
  }
  const session = {
    server,
    browserProcess: server.process(),
    browser: null,
    closePromise: null,
    runTimer: null,
  };
  activeSessions.add(session);
  if (terminating) {
    await closeSession(session);
    throw new Error('Received a termination signal while the Playwright browser was starting');
  }
  session.runTimer = setTimeout(
    () => exitAfterCleanup(124, `test exceeded ${runTimeoutMs} ms; closing managed browser sessions`),
    runTimeoutMs,
  );
  session.runTimer.unref();

  const profileArgument = session.browserProcess.spawnargs.find((arg) => arg.startsWith('--user-data-dir='));
  console.error(`[my-scholar-playwright] launched pid=${session.browserProcess.pid} ${profileArgument || ''}`.trim());
  try {
    session.browser = await playwright.chromium.connect(server.wsEndpoint(), { timeout: DEFAULT_CONNECT_TIMEOUT_MS });
  } catch (error) {
    try {
      await closeSession(session);
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Failed to connect to and close the Playwright browser');
    }
    throw error;
  }

  return {
    browser: session.browser,
    browserProcess: session.browserProcess,
    close: () => closeSession(session),
  };
}

playwright.launchManagedChromium = launchManagedChromium;
module.exports = playwright;
