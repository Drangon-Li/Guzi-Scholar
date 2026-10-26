'use strict';

async function flushRenderer(window, { intent = 'close', discard = false, timeout = 5000 } = {}) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('阅读窗口不可用，无法确认改动已保存。');
  let timer;
  try {
    const options = JSON.stringify({ intent, discard });
    const result = await Promise.race([
      window.webContents.executeJavaScript(`typeof window.__myScholarFlushBeforeClose === 'function' ? window.__myScholarFlushBeforeClose(${options}) : Promise.reject(new Error('保存门禁尚未就绪。'))`, true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('等待设置与笔记保存超时。')), timeout); }),
    ]);
    if (result !== true) throw new Error('设置或笔记尚未保存。');
  } finally {
    clearTimeout(timer);
  }
}

function createExitCoordinator(dependencies) {
  let pending = null;
  let replacement = null;
  let active = null;
  let state = { phase: 'idle', intent: null };
  const setPhase = (phase, extra = {}) => { state = { phase, intent: active?.intent || state.intent, ...extra }; };
  const assertNotCancelled = () => {
    if (active?.cancelled) throw Object.assign(new Error(active.cancelled), { cancelled: true });
  };

  async function run(request) {
    const { intent, install, cancelPreparedInstall } = request;
    let prepareAttempted = false;
    let stopAttempted = false;
    let completed = false;
    try {
      setPhase('waiting');
      await dependencies.waitForMigration();
      assertNotCancelled();
      if (intent === 'install-update') dependencies.assertInstallReady();
      let discard = false;
      if (dependencies.hasRenderer() || intent === 'install-update') {
        while (true) {
          setPhase('saving');
          try {
            await dependencies.flush({ intent, discard });
            assertNotCancelled();
            break;
          } catch (error) {
            assertNotCancelled();
            // Discard still requires a live renderer to finish its write barrier.
            if (discard) throw error;
            setPhase('save-failed');
            const choice = await dependencies.chooseSaveFailure(error, intent);
            assertNotCancelled();
            if (choice === 'retry') continue;
            if (choice === 'discard') { discard = true; continue; }
            throw Object.assign(new Error('已取消退出。'), { cancelled: true });
          }
        }
      }
      if (intent === 'install-update') {
        dependencies.assertInstallReady();
        setPhase('preparing');
        prepareAttempted = true;
        const preparation = await dependencies.prepareBackend();
        assertNotCancelled();
        if (preparation?.migration?.ready !== true) throw new Error(preparation?.migration?.reason || '当前仍有任务正在运行，请等待完成后再安装更新。');
        dependencies.assertInstallReady();
      } else {
        setPhase('cancelling-update');
        await dependencies.cancelPreparedUpdateForExit();
      }
      assertNotCancelled();
      setPhase('stopping');
      stopAttempted = true;
      await dependencies.stopBackend({ allowForce: intent !== 'install-update' });
      assertNotCancelled();
      setPhase(intent === 'install-update' ? 'installing' : 'finishing');
      if (intent === 'install-update') await install();
      else await dependencies.finish(intent);
      completed = true;
      setPhase('completed');
      return { ok: true, intent, discarded: discard };
    } catch (error) {
      const recoveryErrors = [];
      if (intent === 'install-update' && cancelPreparedInstall) {
        try { await cancelPreparedInstall(); } catch (failure) { recoveryErrors.push(failure); }
      }
      if (prepareAttempted) {
        try { await dependencies.cancelBackendPreparation(); } catch (failure) { recoveryErrors.push(failure); }
      }
      if (stopAttempted) {
        try { await dependencies.recoverBackend(); } catch (failure) { recoveryErrors.push(failure); }
      }
      try { await dependencies.resumeRenderer(); } catch (failure) { recoveryErrors.push(failure); }
      setPhase(error.cancelled ? 'cancelled' : 'error', { error: error.message, recoveryErrors: recoveryErrors.map((failure) => failure.message) });
      if (!error.cancelled || recoveryErrors.length) await dependencies.reportFailure(error, intent, recoveryErrors);
      return { ok: false, intent, cancelled: Boolean(error.cancelled), error: error.message, recoveryErrors: recoveryErrors.map((failure) => failure.message) };
    } finally {
      if (!completed) dependencies.resetExit();
    }
  }

  return {
    request(request) {
      if (!['close', 'quit', 'install-update'].includes(request?.intent)) return Promise.reject(new Error('退出意图无效。'));
      if (request.intent === 'install-update' && typeof request.install !== 'function') return Promise.reject(new Error('更新安装入口不可用。'));
      if (pending) {
        if (active.intent === request.intent) return pending;
        const refused = (error) => Promise.resolve({ ok: false, intent: request.intent, error });
        if (['installing', 'finishing', 'completed'].includes(state.phase)) return refused('先前操作已经开始执行，无法切换退出方式。');
        if (replacement) return replacement.intent === request.intent ? replacement.promise : refused('正在等待先前退出请求恢复，请稍后重试。');
        active.cancelled = '退出方式已变更，已取消先前操作。';
        const next = { intent: request.intent };
        next.promise = pending.then((result) => {
          if (result.recoveryErrors?.length) return { ok: false, intent: request.intent, error: '先前操作未能安全恢复，请稍后重试。', recoveryErrors: result.recoveryErrors };
          return this.request(request);
        }).finally(() => { if (replacement === next) replacement = null; });
        replacement = next;
        return next.promise;
      }
      active = { intent: request.intent, cancelled: null };
      pending = run(request).finally(() => { pending = null; active = null; });
      return pending;
    },
    cancel(reason = '已取消退出。') {
      if (active && !['installing', 'finishing', 'completed'].includes(state.phase)) active.cancelled = reason;
    },
    get state() { return { ...state, pending: Boolean(pending) }; },
  };
}

module.exports = { createExitCoordinator, flushRenderer };
