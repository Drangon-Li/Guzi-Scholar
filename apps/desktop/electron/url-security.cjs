'use strict';

function hasTrustedOrigin(candidateURL, serverURL) {
  if (!candidateURL || !serverURL) return false;
  try {
    const candidate = new URL(String(candidateURL));
    const server = new URL(String(serverURL));
    if (!['http:', 'https:'].includes(server.protocol)) return false;
    return candidate.origin === server.origin;
  } catch (_) {
    return false;
  }
}

function pluginIdentity(frame, mainFrame, knownFrames) {
  for (let current = frame; current && current !== mainFrame; current = current.parent) {
    const key = current.frameTreeNodeId ?? current;
    if (knownFrames.has(key)) return knownFrames.get(key);
    const named = /^guzi-plugin:([a-z0-9][a-z0-9._-]*)$/u.exec(current.name || '')?.[1];
    let fromURL;
    try { fromURL = /^\/plugins\/([a-z0-9][a-z0-9._-]*)\//u.exec(new URL(current.url).pathname)?.[1]; } catch (_) { /* about:blank has no plugin path. */ }
    const id = named || fromURL;
    if (id) { knownFrames.set(key, id); return id; }
  }
  return null;
}

function localRequestPolicy(details, serverURL, mainFrame, knownFrames) {
  const frame = details.frame;
  let pluginId = pluginIdentity(frame, mainFrame, knownFrames);
  let target;
  try { target = new URL(details.url); } catch (_) { return { cancel: Boolean(pluginId), authorize: false }; }
  const local = hasTrustedOrigin(details.url, serverURL);
  if (!pluginId && local && details.resourceType === 'subFrame') {
    pluginId = /^\/plugins\/([a-z0-9][a-z0-9._-]*)\//u.exec(target.pathname)?.[1] || null;
    if (pluginId && frame && frame !== mainFrame) knownFrames.set(frame.frameTreeNodeId ?? frame, pluginId);
  }
  if (pluginId) {
    const ownAsset = target.pathname.startsWith(`/plugins/${pluginId}/`) || target.pathname === '/plugin-sdk.js';
    const allowed = local && ownAsset && details.method === 'GET';
    return { cancel: !allowed, authorize: allowed };
  }
  if (!local) return { cancel: false, authorize: false };
  if (mainFrame && frame === mainFrame) return { cancel: false, authorize: true };
  let reader = false;
  const readerDocument = /^\/api\/jobs\/[a-f0-9]{12,40}\/(?:renders\/[a-zA-Z0-9_-]+\/)?document\.html$/u;
  try {
    reader = Boolean(frame && frame.parent === mainFrame && hasTrustedOrigin(frame.url, serverURL) && readerDocument.test(new URL(frame.url).pathname));
  } catch (_) { /* An uncommitted frame has no readable URL yet. */ }
  const readerNavigation = frame?.parent === mainFrame && details.resourceType === 'subFrame' && readerDocument.test(target.pathname);
  return { cancel: !(reader || readerNavigation), authorize: reader || readerNavigation };
}

module.exports = { hasTrustedOrigin, localRequestPolicy };
