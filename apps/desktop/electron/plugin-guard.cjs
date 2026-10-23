'use strict';

function configurePluginIsolation(commandLine) {
  const featureName = (value) => value.split(/[<:]/u)[0];
  const enabled = commandLine.getSwitchValue('enable-features').split(',').map((value) => value.trim()).filter(Boolean).filter((value) => featureName(value) !== 'IsolateSandboxedIframes');
  const disabled = commandLine.getSwitchValue('disable-features').split(',').map((value) => value.trim()).filter(Boolean).filter((value) => !['IsolateSandboxedIframes', 'SitePerProcess', 'IsolateOrigins'].includes(featureName(value)));
  commandLine.removeSwitch('single-process');
  commandLine.removeSwitch('disable-site-isolation-trials');
  commandLine.appendSwitch('site-per-process');
  commandLine.appendSwitch('enable-features', [...enabled, 'IsolateSandboxedIframes:grouping/per-document'].join(','));
  commandLine.removeSwitch('disable-features');
  if (disabled.length) commandLine.appendSwitch('disable-features', disabled.join(','));
}

function pluginDocument(url, serverURL) {
  try {
    const target = new URL(url);
    if (target.origin !== new URL(serverURL).origin) return null;
    const match = /^\/plugins\/([a-z0-9][a-z0-9._-]*)\/(?:__preview\/([a-f0-9]+)\/)?(.+)$/u.exec(target.pathname);
    return match ? { pluginId: match[1], previewSession: match[2] || null } : null;
  } catch (_) { return null; }
}

async function checkPreviewBoundaries(request, session) {
  const probes = [
    { name: 'get_preferences', arguments: {} },
    { name: 'save_notes', arguments: { job_id: '0000000000000000', markdown: 'guard probe never committed', expected_revision: 'invalid' } },
  ];
  for (const probe of probes) {
    try {
      await request(`/api/plugins/${encodeURIComponent(session.pluginId)}/invoke`, { method: 'POST', body: { ...probe, previewSession: session.previewSession } });
    } catch (error) {
      if (error.statusCode === 403) continue;
      throw error;
    }
    throw new Error(`插件预览隔离检查失败：${probe.name} 未被拒绝。`);
  }
  return { capabilityBoundary: true, previewWriteIsolation: true };
}

class PluginProcessGuard {
  constructor({ contents, getServerURL, allWebContents, getMetrics, killProcess, onStart = () => {}, onStop, log = () => {}, mainPID = process.pid, probeTimeout = 5000, probeInterval = 1000, memoryLimitKiB = 512 * 1024 }) {
    Object.assign(this, { contents, getServerURL, allWebContents, getMetrics, killProcess, onStart, onStop, log, mainPID, probeTimeout, probeInterval, memoryLimitKiB });
    this.entries = new Map();
    this.closed = false;
    this.paused = false;
    this.generation = 0;
    this.rootProbe = null;
    this.onNavigate = () => this.scan();
    this.onDestroyed = () => this.dispose();
    contents.on('did-frame-navigate', this.onNavigate);
    contents.once('destroyed', this.onDestroyed);
    this.tick();
  }

  frameInfo(frame) {
    // A crashed OOPIF can remain in framesInSubtree while its getters already throw.
    try {
      if (frame.isDestroyed()) return null;
      return { key: frame.frameTreeNodeId, url: frame.url, pid: frame.osProcessId, parent: frame.parent };
    } catch (_) { return null; }
  }

  frames(contents = this.contents, includeDisposed = false) {
    try {
      const frames = contents.isDestroyed() ? [] : contents.mainFrame.framesInSubtree;
      return includeDisposed ? frames : frames.filter((frame) => this.frameInfo(frame));
    } catch (_) { return []; }
  }

  live(entry) {
    return !this.closed && !entry.stopped && this.entries.get(entry.key) === entry && this.frames().includes(entry.frame) && !entry.frame.isDestroyed();
  }

  owner(frame) {
    for (let current = frame; current;) {
      const info = this.frameInfo(current);
      if (!info) return null;
      const entry = this.entries.get(info.key);
      if (entry && !entry.stopped && info.url.split('#')[0] === entry.url) return entry;
      current = info.parent;
    }
    return null;
  }

  isolated(entry) {
    if (!this.live(entry)) return false;
    const pid = this.frameInfo(entry.frame)?.pid;
    const root = this.frameInfo(this.contents.mainFrame);
    if (!root || !Number.isInteger(pid) || pid <= 0 || pid === this.mainPID || pid === root.pid) return false;
    for (const contents of this.allWebContents()) {
      for (const frame of this.frames(contents)) {
        if (this.frameInfo(frame)?.pid === pid && this.owner(frame) !== entry) return false;
      }
    }
    return true;
  }

  scan() {
    if (this.closed || this.paused || this.contents.isDestroyed()) return;
    const rawFrames = this.frames(this.contents, true);
    const frames = this.frames();
    for (const [key, entry] of this.entries) {
      if (!frames.includes(entry.frame) || entry.frame.isDestroyed()) {
        if (rawFrames.includes(entry.frame) && !entry.frame.isDestroyed()) this.stop(entry, 'crashed', '插件运行进程异常，已停止。');
        entry.probe?.abort();
        this.entries.delete(key);
      }
    }
    for (const frame of frames) {
      if (frame === this.contents.mainFrame) continue;
      const existing = this.entries.get(frame.frameTreeNodeId);
      if (existing && !existing.stopped && existing.url !== frame.url.split('#')[0]) {
        this.stop(existing, 'navigation', '插件发生未授权导航。');
        continue;
      }
      const descriptor = pluginDocument(frame.url, this.getServerURL());
      if (!descriptor) continue;
      let entry = this.entries.get(frame.frameTreeNodeId);
      if (entry) {
        if (!entry.stopped && entry.url !== frame.url.split('#')[0]) this.stop(entry, 'navigation', '插件发生未授权导航。');
        continue;
      }
      entry = { ...descriptor, key: frame.frameTreeNodeId, frame, url: frame.url.split('#')[0], pid: frame.osProcessId, stopped: false, probe: null };
      this.entries.set(entry.key, entry);
      entry.metadata = Promise.resolve().then(() => this.onStart(entry)).catch((error) => { this.log('plugin-session-error', error.message); return null; });
    }
    for (const entry of this.entries.values()) {
      if (entry.stopped) continue;
      if (entry.frame.osProcessId !== entry.pid) { this.stop(entry, 'process-changed', '插件运行进程已变化，已停止。'); continue; }
      if (!this.isolated(entry)) { this.stop(entry, 'isolation', '插件未获得独立运行进程，已停止。'); continue; }
      const metric = this.getMetrics().find((item) => item.pid === entry.pid);
      if (metric?.memory?.workingSetSize > this.memoryLimitKiB) this.stop(entry, 'memory', '插件内存使用超过 512 MiB，已停止。');
      else void this.probe(entry).catch(() => {});
    }
  }

  tick() {
    if (this.closed) return;
    this.scan();
    this.timer = setTimeout(() => this.tick(), this.probeInterval);
    this.timer.unref?.();
  }

  probe(entry = null) {
    const current = entry ? entry.probe : this.rootProbe;
    if (current) return current.promise;
    const frame = entry ? entry.frame : this.contents.mainFrame;
    const state = {};
    let finish;
    state.promise = new Promise((resolve, reject) => {
      let settled = false;
      finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(state.timer);
        if (entry?.probe === state) entry.probe = null;
        if (!entry && this.rootProbe === state) this.rootProbe = null;
        if (error) reject(error); else resolve(value);
      };
      state.abort = () => finish(new Error('插件检查已取消。'));
      state.timer = setTimeout(() => {
        if (entry && this.live(entry) && !this.paused) this.stop(entry, 'unresponsive', '插件连续 5 秒无响应，已停止。');
        finish(new Error(entry ? '插件无响应。' : '阅读器无响应，插件验收已取消。'));
      }, this.probeTimeout);
      Promise.resolve().then(() => frame.executeJavaScript('0')).then((value) => finish(null, value), (error) => {
        if (entry && this.live(entry) && !this.paused) this.stop(entry, 'crashed', '插件运行进程异常，已停止。');
        finish(error);
      });
    });
    if (entry) entry.probe = state; else this.rootProbe = state;
    return state.promise;
  }

  stop(entry, reason, message) {
    if (this.closed || entry.stopped || this.entries.get(entry.key) !== entry) return;
    const pid = this.frameInfo(entry.frame)?.pid;
    const mayKill = pid === entry.pid && this.isolated(entry);
    entry.stopped = true;
    entry.probe?.abort();
    if (mayKill) {
      try { this.killProcess(pid); } catch (error) { if (error.code !== 'ESRCH') this.log('plugin-kill-error', error.message); }
    }
    this.log('plugin-stopped', `${entry.pluginId} reason=${reason} pid=${pid} terminated=${mayKill}`);
    void Promise.resolve(this.onStop(entry, { reason, message, terminated: mayKill })).catch((error) => this.log('plugin-stop-report-error', error.message));
  }

  async check({ pluginId, previewSession = null }) {
    this.scan();
    const candidates = [...this.entries.values()].filter((entry) => entry.pluginId === pluginId && entry.previewSession === previewSession && !entry.stopped);
    if (candidates.length !== 1) throw new Error('找不到当前会话的插件运行页面。');
    const entry = candidates[0];
    const frame = entry.frame;
    const pid = frame.osProcessId;
    const generation = this.generation;
    for (let index = 0; index < 3; index += 1) {
      if (this.paused || generation !== this.generation || !this.live(entry) || !this.isolated(entry) || frame.osProcessId !== pid) throw new Error('插件运行隔离检查未通过。');
      await Promise.all([this.probe(entry), this.probe()]);
      if (index < 2) await new Promise((resolve) => setTimeout(resolve, this.probeInterval));
    }
    if (this.paused || generation !== this.generation || !this.live(entry) || !this.isolated(entry) || frame.osProcessId !== pid) throw new Error('插件运行会话已失效。');
    return { isolated: true };
  }

  suspend() {
    this.paused = true;
    this.generation += 1;
    for (const entry of this.entries.values()) entry.probe?.abort();
    this.rootProbe?.abort();
  }

  resume() { this.paused = false; this.scan(); }

  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const entry of this.entries.values()) entry.probe?.abort();
    this.rootProbe?.abort();
    this.entries.clear();
    this.contents.removeListener('did-frame-navigate', this.onNavigate);
    this.contents.removeListener('destroyed', this.onDestroyed);
  }
}

module.exports = { configurePluginIsolation, pluginDocument, checkPreviewBoundaries, PluginProcessGuard };
