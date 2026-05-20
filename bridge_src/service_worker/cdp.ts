import { chromeApi as chrome } from "./runtimeEnv";

// cdp.js — Pi browser persistent CDP / iframe helpers.
// Design notes: chrome.debugger cannot attach to iframe targets with Target.attachToTarget in this bridge;
// cross-origin iframe execution is performed on the owning tab by Page.getFrameTree -> Page.createIsolatedWorld -> Runtime.evaluate.

const PI_PERSISTENT_CDP_VERSION = 'p4.0.0';
const PI_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS = 15000;
const PI_PERSISTENT_CDP_MAX_SESSIONS = 16;

/** @type {Map<string, any>} */
const piPersistentCdpSessions = new Map();
/** @type {Map<string, any>} */
const piPersistentCdpNewDocumentScripts = new Map();

function piPersistentCdpHasSessionForTab(tabId) {
  return Array.from(piPersistentCdpSessions.values()).some(rec => Number(rec.tabId) === Number(tabId));
}

function piCdpNow() { return Date.now(); }
function piCdpSessionKey(tabId, name) { return String(tabId) + ':' + (name || 'default'); }
function piCdpNewDocumentScriptKey(tabId, name, identifier) { return piCdpSessionKey(tabId, name || 'new_document') + ':' + String(identifier); }
function piCdpKnownNewDocumentIdentifiers(tabId, name) {
  return Array.from(piPersistentCdpNewDocumentScripts.values())
    .filter(rec => Number(rec.tabId) === Number(tabId) && (!name || rec.cdpSessionName === name))
    .map(rec => rec.identifier);
}
function piCdpError(code, message, details = {}) {
  const safeDetails = (details && typeof details === 'object') ? details : (details === undefined ? {} : { raw: details });
  return { ok: false, error: { code, message: message || String(code || 'ERROR'), details: safeDetails } } as any;
}
function piCdpRawError(e) {
  return { name: e && e.name, message: e && e.message, stack: e && e.stack };
}
function piCdpOk(data) { return { ok: true, data } as any; }
function piCdpWithTimeout(promise, timeoutMs, label = 'CDP command') {
  const ms = Math.max(1, Number(timeoutMs || PI_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'CDP command') + ' timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function piCdpFlattenFrameTree(node, out = []) {
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
  for (const child of (node.childFrames || [])) piCdpFlattenFrameTree(child, out);
  return out;
}
function piCdpNormalizeFrameTreeNode(node) {
  if (!node) return null;
  const frame = node.frame || node;
  const out = {
    childFrames: [],
    id: frame?.id || '',
    frameId: frame?.id || '',
    parentId: frame?.parentId || null,
    url: frame?.url || '',
    name: frame?.name || '',
    mimeType: frame?.mimeType || '',
    securityOrigin: frame?.securityOrigin || '',
    children: []
  } as any;
  out.childFrames = out.children;
  for (const child of (node.childFrames || [])) {
    const c = piCdpNormalizeFrameTreeNode(child);
    if (c) out.children.push(c);
  }
  return out;
}

function piCdpResolveFrame(frames, selector) {
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

async function piPersistentCdpAttach(tabId, options) {
  if (!tabId) return piCdpError('NO_TAB_ID', 'tabId is required');
  const name = options?.name || 'default';
  const key = piCdpSessionKey(tabId, name);
  if (piPersistentCdpSessions.has(key)) {
    const old = piPersistentCdpSessions.get(key);
    old.lastUsed = piCdpNow();
    return piCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: old.attachedAt });
  }
  if (piPersistentCdpSessions.size >= PI_PERSISTENT_CDP_MAX_SESSIONS) {
    return piCdpError('SESSION_LIMIT', 'too many persistent CDP sessions', { max: PI_PERSISTENT_CDP_MAX_SESSIONS });
  }
  try {
    if (options?.bringToFront) await chrome.tabs.update(tabId, { active: true });
    await chrome.debugger.attach({ tabId }, options?.protocolVersion || '1.3');
    const rec = { tabId, name, key, attachedAt: piCdpNow(), lastUsed: piCdpNow(), commands: 0, pending: 0, lockedUntil: 0 };
    piPersistentCdpSessions.set(key, rec);
    // Enable Page/Runtime domains immediately. Without this, Chrome may return only
    // the main frame from Page.getFrameTree until domains are explicitly enabled,
    // which breaks iframe-targeted evaluation in fresh persistent sessions.
    try { await piPersistentCdpSend(tabId, 'Page.enable', {}, { name }); } catch (_) {}
    try { await piPersistentCdpSend(tabId, 'Runtime.enable', {}, { name }); } catch (_) {}
    return piCdpOk({ sessionKey: key, tabId, name, reused: false, attachedAt: rec.attachedAt });
  } catch (e) {
    const msg = e && (e.message || String(e));
    if (/Another debugger is already attached|Cannot attach/i.test(String(msg || ''))) {
      const existingKey = piCdpSessionKey(tabId, 'default');
      const existing = piPersistentCdpSessions.get(existingKey);
      if (existing) {
        existing.lastUsed = piCdpNow();
        if (name !== 'default') piPersistentCdpSessions.set(key, existing);
        return piCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: existing.attachedAt, alreadyAttached: true });
      }
      for (const [k, rec] of piPersistentCdpSessions.entries()) {
        if (rec && rec.tabId === tabId) {
          rec.lastUsed = piCdpNow();
          piPersistentCdpSessions.set(key, rec);
          return piCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: rec.attachedAt, alreadyAttached: true });
        }
      }
    }
    return piCdpError('ATTACH_FAILED', msg, { tabId, name, raw: piCdpRawError(e) });
  }
}

async function piPersistentCdpDetachEntry(key) {
  const rec = piPersistentCdpSessions.get(key);
  if (!rec) return piCdpOk({ sessionKey: key, detached: false });
  piPersistentCdpSessions.delete(key);
  // chrome.debugger attachment is physical per tab, while this bridge exposes
  // logical sessions by name (default/new_document/etc.).  Detaching one
  // logical session must not tear down the tab-wide debugger while another
  // logical session for the same tab still owns CDP state; otherwise Chrome
  // invalidates Page.addScriptToEvaluateOnNewDocument identifiers and a later
  // Page.removeScriptToEvaluateOnNewDocument fails with "Script not found".
  const stillOwned = Array.from(piPersistentCdpSessions.values()).some(other => other && Number(other.tabId) === Number(rec.tabId));
  if (stillOwned) {
    return piCdpOk({ sessionKey: key, detached: false, logicalDetached: true, physicalKept: true, lifetimeMs: piCdpNow() - rec.attachedAt, commands: rec.commands });
  }
  try { await chrome.debugger.detach({ tabId: rec.tabId }); }
  catch (e) { return piCdpError('DETACH_FAILED', e.message || String(e), { sessionKey: key, raw: piCdpRawError(e) }); }
  return piCdpOk({ sessionKey: key, detached: true, lifetimeMs: piCdpNow() - rec.attachedAt, commands: rec.commands });
}

async function piPersistentCdpDetach(tabId, options) {
  const name = options?.name || 'default';
  return await piPersistentCdpDetachEntry(piCdpSessionKey(tabId, name));
}

async function piPersistentCdpSend(tabId, method, params, options) {
  if (!method) return piCdpError('NO_METHOD', 'CDP method is required');
  const name = options?.name || 'default';
  const key = piCdpSessionKey(tabId, name);
  const retrying = Boolean(options?.__piRetryAfterNotAttached);
  let rec = piPersistentCdpSessions.get(key);
  let temporary = false;
  if (!rec) {
    const attached = await piPersistentCdpAttach(tabId, { name, protocolVersion: options?.protocolVersion, bringToFront: options?.bringToFront });
    if (!attached.ok) return attached;
    rec = piPersistentCdpSessions.get(key);
    temporary = options?.persistent === false;
  }
  rec.pending = (rec.pending || 0) + 1;
  rec.lockedUntil = Math.max(rec.lockedUntil || 0, piCdpNow() + Number(options?.timeoutMs || 30000));
  try {
    const data = await piCdpWithTimeout(
      chrome.debugger.sendCommand({ tabId: rec.tabId }, method, params || {}),
      options?.timeoutMs,
      method
    );
    rec.commands += 1; rec.lastUsed = piCdpNow();
    return piCdpOk({ result: data, sessionKey: key, method });
  } catch (e) {
    const msg = e && (e.message || String(e));
    if (!retrying && /Debugger is not attached|Cannot access a chrome:\/\/ URL|No tab with id/i.test(String(msg || ''))) {
      for (const [staleKey, staleRec] of Array.from(piPersistentCdpSessions.entries())) {
        if (staleRec && Number(staleRec.tabId) === Number(rec.tabId)) piPersistentCdpSessions.delete(staleKey);
      }
      return await piPersistentCdpSend(tabId, method, params, { ...(options || {}), __piRetryAfterNotAttached: true });
    }
    if (options?.detachOnError) await piPersistentCdpDetach(tabId, { name });
    return piCdpError('SEND_FAILED', msg || String(e), { sessionKey: key, method, raw: piCdpRawError(e) });
  } finally {
    rec.pending = Math.max(0, (rec.pending || 1) - 1);
    rec.lockedUntil = 0;
    rec.lastUsed = piCdpNow();
    if (temporary) await piPersistentCdpDetach(tabId, { name });
  }
}

async function piPersistentCdpFrameTree(tabId, options) {
  const resp = await piPersistentCdpSend(tabId, 'Page.getFrameTree', {}, options || {});
  if (!resp.ok) return resp;
  const rawTree = resp.data.result.frameTree;
  return piCdpOk({ frameTree: piCdpNormalizeFrameTreeNode(rawTree), frames: piCdpFlattenFrameTree(rawTree, []) });
}

async function piPersistentCdpEvaluateInFrame(tabId, expression, options) {
  const frameTree = await piPersistentCdpFrameTree(tabId, options || {});
  if (!frameTree.ok) return frameTree;
  const frame = piCdpResolveFrame(frameTree.data.frames, options?.frame || options?.frameId || 'main');
  if (!frame) return piCdpError('FRAME_NOT_FOUND', 'requested frame not found', { frame: options?.frame || options?.frameId, frames: frameTree.data.frames });
  try {
    const worldName = options?.worldName || ('pi_browser_' + Math.random().toString(36).slice(2));
    const world = await piPersistentCdpSend(tabId, 'Page.createIsolatedWorld', {
      frameId: frame.frameId,
      worldName,
      grantUniversalAccess: Boolean(options?.grantUniversalAccess)
    }, options || {});
    if (!world.ok) return world;
    const evalResp = await piPersistentCdpSend(tabId, 'Runtime.evaluate', {
      expression: String(expression || ''),
      contextId: world.data.result.executionContextId,
      awaitPromise: options?.awaitPromise !== false,
      returnByValue: options?.returnByValue !== false,
      userGesture: Boolean(options?.userGesture)
    }, options || {});
    if (!evalResp.ok) return evalResp;
    return piCdpOk({ frame, executionContextId: world.data.result.executionContextId, result: evalResp.data.result });
  } catch (e) {
    return piCdpError('FRAME_EVAL_FAILED', e.message || String(e), { frame, raw: piCdpRawError(e) });
  }
}

async function piPersistentCdpAddNewDocumentScript(tabId, source, options) {
  if (!source) return piCdpError('NO_SOURCE', 'script source is required');
  const cdpOptions = { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' };
  const params = {
    source: String(source),
    includeCommandLineAPI: Boolean(options?.includeCommandLineAPI),
    runImmediately: Boolean(options?.runImmediately)
  } as any;
  if (options?.worldName !== undefined) params.worldName = String(options.worldName || '');
  const resp = await piPersistentCdpSend(tabId, 'Page.addScriptToEvaluateOnNewDocument', params, cdpOptions);
  if (!resp.ok) return resp;
  const identifier = String(resp.data.result.identifier);
  const sessionKey = resp.data.sessionKey;
  const rec = {
    key: piCdpNewDocumentScriptKey(tabId, cdpOptions.name, identifier),
    tabId:Number(tabId),
    identifier,
    sessionKey,
    cdpSessionName: cdpOptions.name,
    method: 'Page.addScriptToEvaluateOnNewDocument',
    createdAt: piCdpNow(),
    runImmediately: Boolean(options?.runImmediately),
    includeCommandLineAPI: Boolean(options?.includeCommandLineAPI),
    worldName: options?.worldName !== undefined ? String(options.worldName || '') : undefined
  };
  piPersistentCdpNewDocumentScripts.set(rec.key, rec);
  return piCdpOk({ identifier, sessionKey, cdpSessionName: cdpOptions.name, tabId:Number(tabId), method: rec.method, detached: cdpOptions.persistent !== true });
}

async function piPersistentCdpRemoveNewDocumentScript(tabId, identifier, options) {
  if (!identifier) return piCdpError('NO_IDENTIFIER', 'script identifier is required');
  const cdpOptions = { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' };
  const id = String(identifier);
  const key = piCdpNewDocumentScriptKey(tabId, cdpOptions.name, id);
  const known = piPersistentCdpNewDocumentScripts.get(key);
  if (!known) {
    return piCdpError('SCRIPT_NOT_FOUND', 'new document script identifier is not registered', { tabId:Number(tabId), identifier:id, cdpSessionName:cdpOptions.name, knownIdentifiers:piCdpKnownNewDocumentIdentifiers(tabId, cdpOptions.name) });
  }
  const method = 'Page.removeScriptToEvaluateOnNewDocument';
  const resp = await piPersistentCdpSend(tabId, method, { identifier:id }, cdpOptions);
  if (!resp.ok) {
    const msg = String(resp.error?.message || resp.message || resp.error || '');
    // Chrome may drop a previously registered new-document identifier after a debugger
    // detach or navigation lifecycle reset.  Only known identifiers are treated as
    // idempotent cleanup; arbitrary unknown ids still return SCRIPT_NOT_FOUND above.
    if (/(no\s+script|script.*(not\s*found|does\s*not\s*exist|given\s+id)|identifier.*(not\s*found|does\s*not\s*exist))/i.test(msg)) {
      piPersistentCdpNewDocumentScripts.delete(key);
      return piCdpOk({ identifier:id, removed:false, alreadyRemoved:true, sessionKey:known.sessionKey, cdpSessionName:known.cdpSessionName, tabId:Number(tabId), method, error:msg });
    }
    return resp;
  }
  piPersistentCdpNewDocumentScripts.delete(key);
  return piCdpOk({ identifier:id, removed:true, alreadyRemoved:false, sessionKey:resp.data.sessionKey || known.sessionKey, cdpSessionName:known.cdpSessionName, tabId:Number(tabId), method });
}

async function piPersistentCdpReleaseIdle(maxIdleMs) {
  const now = piCdpNow();
  const rawIdleMs = maxIdleMs === undefined || maxIdleMs === null ? 60000 : Number(maxIdleMs);
  const idleMs = Number.isFinite(rawIdleMs) ? rawIdleMs : 60000;
  const released = [];
  const skipped = [];
  for (const [key, rec] of Array.from(piPersistentCdpSessions.entries())) {
    if (!piPersistentCdpSessions.has(key)) continue;
    if ((rec.pending || 0) > 0 || (rec.lockedUntil || 0) > now) { skipped.push({ sessionKey: key, pending: rec.pending || 0, reason: 'idle busy' }); continue; }
    if (now - rec.lastUsed >= idleMs) {
      const res = await piPersistentCdpDetachEntry(key);
      released.push({ sessionKey: key, ok: res.ok, detached: res.data && res.data.detached === true });
    }
  }
  return piCdpOk({ released, skipped, remaining: piPersistentCdpSessions.size });
}

async function handlePersistentCdpCommand(msg, sender) {
  const tabId = msg.tabId || sender?.tab?.id;
  const action = msg.action || msg.method;
  if (!tabId && action !== 'releaseIdle') return piCdpError('NO_TAB_ID', 'tabId is required');
  if (action === 'attach') return await piPersistentCdpAttach(tabId, msg);
  if (action === 'send') return await piPersistentCdpSend(tabId, msg.cdpMethod, msg.params || {}, msg);
  if (action === 'detach') return await piPersistentCdpDetach(tabId, msg);
  if (action === 'frameTree') return await piPersistentCdpFrameTree(tabId, msg);
  if (action === 'evaluateInFrame') return await piPersistentCdpEvaluateInFrame(tabId, msg.expression, msg);
  if (action === 'addNewDocumentScript') return await piPersistentCdpAddNewDocumentScript(tabId, msg.source, msg);
  if (action === 'removeNewDocumentScript') return await piPersistentCdpRemoveNewDocumentScript(tabId, msg.identifier, msg);
  if (action === 'releaseIdle') return await piPersistentCdpReleaseIdle(msg.maxIdleMs);
  return piCdpError('UNKNOWN_ACTION', 'unknown persistent CDP action: ' + action, { action });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source || !source.tabId) return;
  for (const [key, rec] of Array.from(piPersistentCdpSessions.entries())) {
    if (rec.tabId === source.tabId) piPersistentCdpSessions.delete(key);
  }
});

const piPersistentCdpBridge = {
  version: PI_PERSISTENT_CDP_VERSION,
  sessions: piPersistentCdpSessions,
  newDocumentScripts: piPersistentCdpNewDocumentScripts,
  attach: piPersistentCdpAttach,
  send: piPersistentCdpSend,
  detach: piPersistentCdpDetach,
  frameTree: piPersistentCdpFrameTree,
  evaluateInFrame: piPersistentCdpEvaluateInFrame,
  addNewDocumentScript: piPersistentCdpAddNewDocumentScript,
  removeNewDocumentScript: piPersistentCdpRemoveNewDocumentScript,
  releaseIdle: piPersistentCdpReleaseIdle,
  hasSessionForTab: piPersistentCdpHasSessionForTab,
  handleCommand: handlePersistentCdpCommand
};
self['PiPersistentCdp'] = piPersistentCdpBridge;
self['piPersistentCdpBridge'] = piPersistentCdpBridge;
export { PI_PERSISTENT_CDP_VERSION, PI_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS, PI_PERSISTENT_CDP_MAX_SESSIONS, piPersistentCdpSessions, piPersistentCdpNewDocumentScripts, piPersistentCdpHasSessionForTab, piCdpNow, piCdpSessionKey, piCdpNewDocumentScriptKey, piCdpKnownNewDocumentIdentifiers, piCdpError, piCdpRawError, piCdpOk, piCdpWithTimeout, piCdpFlattenFrameTree, piCdpNormalizeFrameTreeNode, piCdpResolveFrame, piPersistentCdpAttach, piPersistentCdpDetachEntry, piPersistentCdpDetach, piPersistentCdpSend, piPersistentCdpFrameTree, piPersistentCdpEvaluateInFrame, piPersistentCdpAddNewDocumentScript, piPersistentCdpRemoveNewDocumentScript, piPersistentCdpReleaseIdle, handlePersistentCdpCommand, piPersistentCdpBridge };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_cdp = { name: "cdp", symbols: { PI_PERSISTENT_CDP_VERSION, PI_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS, PI_PERSISTENT_CDP_MAX_SESSIONS, piPersistentCdpSessions, piPersistentCdpNewDocumentScripts, piPersistentCdpHasSessionForTab, piCdpNow, piCdpSessionKey, piCdpNewDocumentScriptKey, piCdpKnownNewDocumentIdentifiers, piCdpError, piCdpRawError, piCdpOk, piCdpWithTimeout, piCdpFlattenFrameTree, piCdpNormalizeFrameTreeNode, piCdpResolveFrame, piPersistentCdpAttach, piPersistentCdpDetachEntry, piPersistentCdpDetach, piPersistentCdpSend, piPersistentCdpFrameTree, piPersistentCdpEvaluateInFrame, piPersistentCdpAddNewDocumentScript, piPersistentCdpRemoveNewDocumentScript, piPersistentCdpReleaseIdle, handlePersistentCdpCommand, piPersistentCdpBridge } };
