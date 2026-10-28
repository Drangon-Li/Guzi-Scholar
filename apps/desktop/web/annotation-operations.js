(function attachAnnotationOperations(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MyScholarAnnotationOperations = api;
}(typeof window === 'object' ? window : globalThis, function annotationOperations() {
  function create({ request, getCloseGate, waitForCloseResume, state, mounts, getCurrentMount, isCurrentMount, matchesMount, isAIAnnotation }) {
    const styleSyncs = [];
    const responseRevisions = new WeakMap();
    const mutationQueues = new Map();
    const pendingWrites = new Set();

    function applyStyleFields(annotation, updates, revision = 0) {
      if (revision && (responseRevisions.get(annotation) || 0) >= revision) return annotation;
      const fields = updates[annotation?.action_id];
      const updated = fields && !isAIAnnotation(annotation) ? { ...annotation, ...fields } : annotation;
      if (revision) responseRevisions.set(updated, revision);
      return updated;
    }

    async function requestWithStyles(url, options) {
      const payload = await request(url, options);
      const currentAnnotation = (annotation) => {
        responseRevisions.set(annotation, Number(payload.annotation_style_revision) || 0);
        for (const sync of styleSyncs) annotation = applyStyleFields(annotation, sync.updates, sync.revision);
        return annotation;
      };
      if (Array.isArray(payload.annotations)) payload.annotations = payload.annotations.map(currentAnnotation);
      if (payload.annotation) payload.annotation = currentAnnotation(payload.annotation);
      return payload;
    }

    function api(url, options = {}) {
      const jobId = /^(?:POST|PUT|PATCH|DELETE)$/iu.test(options.method || '')
        ? /^\/api\/jobs\/([^/]+)\/annotations(?:\/[^/]+)?$/u.exec(url)?.[1] : null;
      if (!jobId) return requestWithStyles(url, options);
      if (getCloseGate()) return waitForCloseResume().then(() => api(url, options));
      // Responses contain full snapshots, so writes must finish in document order.
      const previous = mutationQueues.get(jobId) || Promise.resolve();
      const pending = previous.catch(() => {}).then(() => requestWithStyles(url, { ...options, closeSave: true }));
      mutationQueues.set(jobId, pending);
      pendingWrites.add(pending);
      const cleanup = () => {
        pendingWrites.delete(pending);
        if (mutationQueues.get(jobId) === pending) mutationQueues.delete(jobId);
      };
      pending.then(cleanup, cleanup);
      return pending;
    }

    function applyResult(jobId, mount, payload, { defaultEmpty = false, deletedId = null, allowStateUpdate = true } = {}) {
      if (isCurrentMount(mount)) {
        if (deletedId !== null) mount.annotations = (mount.annotations || []).filter((item) => item.id !== deletedId);
        else if (payload.annotations) mount.annotations = payload.annotations;
      }
      if (!allowStateUpdate || !matchesMount(mount) || state.activeJob?.job_id !== jobId) return false;
      if (deletedId !== null) state.annotations = state.annotations.filter((item) => item.id !== deletedId);
      else state.annotations = payload.annotations || (defaultEmpty ? [] : state.annotations);
      return true;
    }

    function applyStyleSync(sync) {
      if (!sync?.updates || !Object.keys(sync.updates).length) return false;
      const revision = Number(sync.revision) || styleSyncs.length + 1;
      styleSyncs.push({ updates: sync.updates, revision });
      mounts.forEach((mount) => {
        mount.annotations = mount.annotations.map((annotation) => applyStyleFields(annotation, sync.updates, revision));
      });
      state.annotations = getCurrentMount()?.annotations || state.annotations.map((annotation) => applyStyleFields(annotation, sync.updates, revision));
      return true;
    }

    function capturePendingWrites() {
      return [...pendingWrites];
    }

    async function waitForPendingWrites(snapshot) {
      const results = await Promise.allSettled(snapshot);
      return results.every((result) => result.status === 'fulfilled');
    }

    return { api, applyResult, applyStyleSync, capturePendingWrites, waitForPendingWrites };
  }

  return { create };
}));
