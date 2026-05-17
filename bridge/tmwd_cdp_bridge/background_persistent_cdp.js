// background_persistent_cdp.js — P4 persistent CDP / iframe helpers for GA/TMWD Browser Pro
// Generated package only. Load from background.js after review, or merge selected helpers.
// Design notes: chrome.debugger cannot attach to iframe targets with Target.attachToTarget in this bridge;
// cross-origin iframe execution is performed on the owning tab by Page.getFrameTree -> Page.createIsolatedWorld -> Runtime.evaluate.

const GA_PERSISTENT_CDP_VERSION = 'p4.0.0';
const GA_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS = 15000;
const GA_PERSISTENT_CDP_MAX_SESSIONS = 16;

const gaPersistentCdpSessions = new Map();

function gaPersistentCdpHasSessionForTab(tabId) {
  return Array.from(gaPersistentCdpSessions.values()).some(rec => Number(rec.tabId) === Number(tabId));
}

function gaCdpNow() { return Date.now(); }
function gaCdpSessionKey(tabId, name) { return String(tabId) + ':' + (name || 'default'); }
function gaCdpError(code, message, details) {
  const safeDetails = (details && typeof details === 'object') ? details : (details === undefined ? {} : { raw: details });
  return { ok: false, error: { code, message: message || String(code || 'ERROR'), details: safeDetails } };
}
function gaCdpRawError(e) {
  return { name: e && e.name, message: e && e.message, stack: e && e.stack };
}
function gaCdpOk(data) { return { ok: true, data }; }
function gaCdpWithTimeout(promise, timeoutMs, label) {
  const ms = Math.max(1, Number(timeoutMs || GA_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'CDP command') + ' timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function gaCdpFlattenFrameTree(node, out) {
  if (!node) return out;
  const frame = node.frame || node;
  if (frame && frame.id) out.push({
    id: frame.id,
    frameId: frame.id,
    parentId: frame.parentId || null,
    url: frame.url || '',
    name: frame.name || '',
    mimeType: frame.mimeType || '',
    securityOrigin: frame.securityOrigin || ''
  });
  for (const child of (node.childFrames || [])) gaCdpFlattenFrameTree(child, out);
  return out;
}
function gaCdpNormalizeFrameTreeNode(node) {
  if (!node) return null;
  const frame = node.frame || node;
  const out = {
    id: frame?.id || '',
    frameId: frame?.id || '',
    parentId: frame?.parentId || null,
    url: frame?.url || '',
    name: frame?.name || '',
    mimeType: frame?.mimeType || '',
    securityOrigin: frame?.securityOrigin || '',
    children: []
  };
  out.childFrames = out.children;
  for (const child of (node.childFrames || [])) {
    const c = gaCdpNormalizeFrameTreeNode(child);
    if (c) out.children.push(c);
  }
  return out;
}

function gaCdpResolveFrame(frames, selector) {
  if (!selector || selector === 'main' || selector === 'root') return frames[0] || null;
  if (typeof selector === 'string') {
    return frames.find(f => f.frameId === selector || f.name === selector || f.url.includes(selector)) || null;
  }
  if (selector.frameId) return frames.find(f => f.frameId === selector.frameId) || null;
  if (selector.name) return frames.find(f => f.name === selector.name) || null;
  if (selector.urlContains) return frames.find(f => f.url.includes(selector.urlContains)) || null;
  if (selector.index !== undefined) return frames[Number(selector.index)] || null;
  return null;
}

async function gaPersistentCdpAttach(tabId, options) {
  if (!tabId) return gaCdpError('NO_TAB_ID', 'tabId is required');
  const name = options?.name || 'default';
  const key = gaCdpSessionKey(tabId, name);
  if (gaPersistentCdpSessions.has(key)) {
    const old = gaPersistentCdpSessions.get(key);
    old.lastUsed = gaCdpNow();
    return gaCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: old.attachedAt });
  }
  if (gaPersistentCdpSessions.size >= GA_PERSISTENT_CDP_MAX_SESSIONS) {
    return gaCdpError('SESSION_LIMIT', 'too many persistent CDP sessions', { max: GA_PERSISTENT_CDP_MAX_SESSIONS });
  }
  try {
    if (options?.bringToFront) await chrome.tabs.update(tabId, { active: true });
    await chrome.debugger.attach({ tabId }, options?.protocolVersion || '1.3');
    const rec = { tabId, name, key, attachedAt: gaCdpNow(), lastUsed: gaCdpNow(), commands: 0, pending: 0, lockedUntil: 0 };
    gaPersistentCdpSessions.set(key, rec);
    // Enable Page/Runtime domains immediately. Without this, Chrome may return only
    // the main frame from Page.getFrameTree until domains are explicitly enabled,
    // which breaks iframe-targeted evaluation in fresh persistent sessions.
    try { await gaPersistentCdpSend(tabId, 'Page.enable', {}, { name }); } catch (_) {}
    try { await gaPersistentCdpSend(tabId, 'Runtime.enable', {}, { name }); } catch (_) {}
    return gaCdpOk({ sessionKey: key, tabId, name, reused: false, attachedAt: rec.attachedAt });
  } catch (e) {
    const msg = e && (e.message || String(e));
    if (/Another debugger is already attached|Cannot attach/i.test(String(msg || ''))) {
      const existingKey = gaCdpSessionKey(tabId, 'default');
      const existing = gaPersistentCdpSessions.get(existingKey);
      if (existing) {
        existing.lastUsed = gaCdpNow();
        if (name !== 'default') gaPersistentCdpSessions.set(key, existing);
        return gaCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: existing.attachedAt, alreadyAttached: true });
      }
      for (const [k, rec] of gaPersistentCdpSessions.entries()) {
        if (rec && rec.tabId === tabId) {
          rec.lastUsed = gaCdpNow();
          gaPersistentCdpSessions.set(key, rec);
          return gaCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: rec.attachedAt, alreadyAttached: true });
        }
      }
    }
    return gaCdpError('ATTACH_FAILED', msg, { tabId, name, raw: gaCdpRawError(e) });
  }
}

async function gaPersistentCdpDetach(tabId, options) {
  const name = options?.name || 'default';
  const key = gaCdpSessionKey(tabId, name);
  const rec = gaPersistentCdpSessions.get(key);
  if (!rec) return gaCdpOk({ sessionKey: key, detached: false });
  gaPersistentCdpSessions.delete(key);
  // chrome.debugger attachment is physical per tab, while this bridge exposes
  // logical sessions by name (default/new_document/etc.).  Detaching one
  // logical session must not tear down the tab-wide debugger while another
  // logical session for the same tab still owns CDP state; otherwise Chrome
  // invalidates Page.addScriptToEvaluateOnNewDocument identifiers and a later
  // Page.removeScriptToEvaluateOnNewDocument fails with "Script not found".
  const stillOwned = Array.from(gaPersistentCdpSessions.values()).some(other => other && Number(other.tabId) === Number(rec.tabId));
  if (stillOwned) {
    return gaCdpOk({ sessionKey: key, detached: false, logicalDetached: true, physicalKept: true, lifetimeMs: gaCdpNow() - rec.attachedAt, commands: rec.commands });
  }
  try { await chrome.debugger.detach({ tabId: rec.tabId }); }
  catch (e) { return gaCdpError('DETACH_FAILED', e.message || String(e), { sessionKey: key, raw: gaCdpRawError(e) }); }
  return gaCdpOk({ sessionKey: key, detached: true, lifetimeMs: gaCdpNow() - rec.attachedAt, commands: rec.commands });
}

async function gaPersistentCdpSend(tabId, method, params, options) {
  if (!method) return gaCdpError('NO_METHOD', 'CDP method is required');
  const name = options?.name || 'default';
  const key = gaCdpSessionKey(tabId, name);
  const retrying = Boolean(options?.__gaRetryAfterNotAttached);
  let rec = gaPersistentCdpSessions.get(key);
  let temporary = false;
  if (!rec) {
    const attached = await gaPersistentCdpAttach(tabId, { name, protocolVersion: options?.protocolVersion, bringToFront: options?.bringToFront });
    if (!attached.ok) return attached;
    rec = gaPersistentCdpSessions.get(key);
    temporary = options?.persistent === false;
  }
  rec.pending = (rec.pending || 0) + 1;
  rec.lockedUntil = Math.max(rec.lockedUntil || 0, gaCdpNow() + Number(options?.timeoutMs || 30000));
  try {
    const data = await gaCdpWithTimeout(
      chrome.debugger.sendCommand({ tabId: rec.tabId }, method, params || {}),
      options?.timeoutMs,
      method
    );
    rec.commands += 1; rec.lastUsed = gaCdpNow();
    return gaCdpOk({ result: data, sessionKey: key, method });
  } catch (e) {
    const msg = e && (e.message || String(e));
    if (!retrying && /Debugger is not attached|Cannot access a chrome:\/\/ URL|No tab with id/i.test(String(msg || ''))) {
      for (const [staleKey, staleRec] of Array.from(gaPersistentCdpSessions.entries())) {
        if (staleRec && Number(staleRec.tabId) === Number(rec.tabId)) gaPersistentCdpSessions.delete(staleKey);
      }
      return await gaPersistentCdpSend(tabId, method, params, { ...(options || {}), __gaRetryAfterNotAttached: true });
    }
    if (options?.detachOnError) await gaPersistentCdpDetach(tabId, { name });
    return gaCdpError('SEND_FAILED', msg || String(e), { sessionKey: key, method, raw: gaCdpRawError(e) });
  } finally {
    rec.pending = Math.max(0, (rec.pending || 1) - 1);
    rec.lockedUntil = 0;
    rec.lastUsed = gaCdpNow();
    if (temporary) await gaPersistentCdpDetach(tabId, { name });
  }
}

async function gaPersistentCdpFrameTree(tabId, options) {
  const resp = await gaPersistentCdpSend(tabId, 'Page.getFrameTree', {}, options || {});
  if (!resp.ok) return resp;
  const rawTree = resp.data.result.frameTree;
  return gaCdpOk({ frameTree: gaCdpNormalizeFrameTreeNode(rawTree), frames: gaCdpFlattenFrameTree(rawTree, []) });
}

async function gaPersistentCdpEvaluateInFrame(tabId, expression, options) {
  const frameTree = await gaPersistentCdpFrameTree(tabId, options || {});
  if (!frameTree.ok) return frameTree;
  const frame = gaCdpResolveFrame(frameTree.data.frames, options?.frame || options?.frameId || 'main');
  if (!frame) return gaCdpError('FRAME_NOT_FOUND', 'requested frame not found', { frame: options?.frame || options?.frameId, frames: frameTree.data.frames });
  try {
    const worldName = options?.worldName || ('ga_browser_pro_' + Math.random().toString(36).slice(2));
    const world = await gaPersistentCdpSend(tabId, 'Page.createIsolatedWorld', {
      frameId: frame.frameId,
      worldName,
      grantUniveralAccess: Boolean(options?.grantUniversalAccess)
    }, options || {});
    if (!world.ok) return world;
    const evalResp = await gaPersistentCdpSend(tabId, 'Runtime.evaluate', {
      expression: String(expression || ''),
      contextId: world.data.result.executionContextId,
      awaitPromise: options?.awaitPromise !== false,
      returnByValue: options?.returnByValue !== false,
      userGesture: Boolean(options?.userGesture)
    }, options || {});
    if (!evalResp.ok) return evalResp;
    return gaCdpOk({ frame, executionContextId: world.data.result.executionContextId, result: evalResp.data.result });
  } catch (e) {
    return gaCdpError('FRAME_EVAL_FAILED', e.message || String(e), { frame, raw: gaCdpRawError(e) });
  }
}

async function gaPersistentCdpAddNewDocumentScript(tabId, source, options) {
  if (!source) return gaCdpError('NO_SOURCE', 'script source is required');
  const cdpOptions = { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' };
  const resp = await gaPersistentCdpSend(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
    source: String(source),
    worldName: options?.worldName,
    includeCommandLineAPI: Boolean(options?.includeCommandLineAPI),
    runImmediately: Boolean(options?.runImmediately)
  }, cdpOptions);
  if (!resp.ok) return resp;
  return gaCdpOk({ identifier: resp.data.result.identifier, sessionKey: resp.data.sessionKey, cdpSessionName: cdpOptions.name, detached: cdpOptions.persistent !== true });
}

async function gaPersistentCdpRemoveNewDocumentScript(tabId, identifier, options) {
  if (!identifier) return gaCdpError('NO_IDENTIFIER', 'script identifier is required');
  const resp = await gaPersistentCdpSend(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }, { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' });
  if (!resp.ok) {
    const msg = String(resp.error?.message || resp.message || resp.error || '');
    // Chrome may drop new-document identifiers when an older debugger client detached.
    // Removal is a cleanup operation; make "not found" idempotent so acceptance can
    // continue while the root cause (temporary detach) is eliminated above.
    if (/script.*(not\s*found|does\s*not\s*exist)|identifier.*(not\s*found|does\s*not\s*exist)/i.test(msg)) {
      return gaCdpOk({ identifier, alreadyRemoved: true, cdpSessionName: options?.name || 'new_document' });
    }
  }
  return resp;
}

async function gaPersistentCdpReleaseIdle(maxIdleMs) {
  const now = gaCdpNow();
  const released = [];
  const skipped = [];
  for (const rec of Array.from(gaPersistentCdpSessions.values())) {
    if ((rec.pending || 0) > 0 || (rec.lockedUntil || 0) > now) { skipped.push({ sessionKey: rec.key, pending: rec.pending || 0, reason: 'idle busy' }); continue; }
    if (now - rec.lastUsed >= Number(maxIdleMs || 60000)) {
      const res = await gaPersistentCdpDetach(rec.tabId, { name: rec.name });
      released.push({ sessionKey: rec.key, ok: res.ok });
    }
  }
  return gaCdpOk({ released, skipped, remaining: gaPersistentCdpSessions.size });
}

async function handlePersistentCdpCommand(msg, sender) {
  const tabId = msg.tabId || sender?.tab?.id;
  const action = msg.action || msg.method;
  if (!tabId && action !== 'releaseIdle') return gaCdpError('NO_TAB_ID', 'tabId is required');
  if (action === 'attach') return await gaPersistentCdpAttach(tabId, msg);
  if (action === 'send') return await gaPersistentCdpSend(tabId, msg.cdpMethod, msg.params || {}, msg);
  if (action === 'detach') return await gaPersistentCdpDetach(tabId, msg);
  if (action === 'frameTree') return await gaPersistentCdpFrameTree(tabId, msg);
  if (action === 'evaluateInFrame') return await gaPersistentCdpEvaluateInFrame(tabId, msg.expression, msg);
  if (action === 'addNewDocumentScript') return await gaPersistentCdpAddNewDocumentScript(tabId, msg.source, msg);
  if (action === 'removeNewDocumentScript') return await gaPersistentCdpRemoveNewDocumentScript(tabId, msg.identifier, msg);
  if (action === 'releaseIdle') return await gaPersistentCdpReleaseIdle(msg.maxIdleMs);
  return gaCdpError('UNKNOWN_ACTION', 'unknown persistent CDP action: ' + action, { action });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source || !source.tabId) return;
  for (const [key, rec] of Array.from(gaPersistentCdpSessions.entries())) {
    if (rec.tabId === source.tabId) gaPersistentCdpSessions.delete(key);
  }
});

const gaPersistentCdpBridge = {
  version: GA_PERSISTENT_CDP_VERSION,
  sessions: gaPersistentCdpSessions,
  attach: gaPersistentCdpAttach,
  send: gaPersistentCdpSend,
  detach: gaPersistentCdpDetach,
  frameTree: gaPersistentCdpFrameTree,
  evaluateInFrame: gaPersistentCdpEvaluateInFrame,
  addNewDocumentScript: gaPersistentCdpAddNewDocumentScript,
  removeNewDocumentScript: gaPersistentCdpRemoveNewDocumentScript,
  releaseIdle: gaPersistentCdpReleaseIdle,
  hasSessionForTab: gaPersistentCdpHasSessionForTab,
  handleCommand: handlePersistentCdpCommand
};
self.GAPersistentCdp = gaPersistentCdpBridge;
self.gaPersistentCdpBridge = gaPersistentCdpBridge;
