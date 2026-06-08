import { chromeApi as chrome } from "./runtimeEnv";
import { RECOVERY_CODES, forget as forgetState, get as getState, persist as persistState, registerRecovery, recover as recoverState } from "./state_store";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse, PiBridgeSender } from "./types";

type PiCdpResponse = PiBridgeResponse<JsonRecord>;
type PiCdpSession = { tabId: number; name: string; key: string; attachedAt: number; lastUsed: number; commands: number; pending: number; lockedUntil: number };
type PiCdpNewDocumentScript = { key: string; tabId: number; identifier: string; sessionKey?: unknown; cdpSessionName: string; method: string; createdAt: number; runImmediately: boolean; includeCommandLineAPI: boolean; worldName?: string };
type PiCdpFrame = { id: string; frameId: string; parentId: string | null; url: string; name: string; mimeType: string; securityOrigin: string; childFrames?: PiCdpFrame[]; children?: PiCdpFrame[] };
type PiCdpFrameTreeNode = JsonRecord & { frame?: JsonRecord; childFrames?: PiCdpFrameTreeNode[] };
type PiCdpOptions = PiBridgeCommand & { name?: string; protocolVersion?: string; bringToFront?: boolean; persistent?: boolean; detachOnError?: boolean; frame?: unknown; frameId?: unknown; worldName?: string; grantUniversalAccess?: boolean; awaitPromise?: boolean; returnByValue?: boolean; userGesture?: boolean; includeCommandLineAPI?: boolean; runImmediately?: boolean; __piRetryAfterNotAttached?: boolean };

function cdpRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function cdpErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function cdpRawError(error: unknown): JsonRecord { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }

// cdp.js — Pi browser persistent CDP / iframe helpers.
// Design notes: chrome.debugger cannot attach to iframe targets with Target.attachToTarget in this bridge;
// cross-origin iframe execution is performed on the owning tab by Page.getFrameTree -> Page.createIsolatedWorld -> Runtime.evaluate.

const PI_PERSISTENT_CDP_VERSION = 'p4.0.0';
const PI_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS = 15000;
const PI_PERSISTENT_CDP_MAX_SESSIONS = 16;

const piPersistentCdpSessions = new Map<string, PiCdpSession>();
const piPersistentCdpNewDocumentScripts = new Map<string, PiCdpNewDocumentScript>();

function piPersistentCdpHasSessionForTab(tabId: unknown): boolean {
  return Array.from(piPersistentCdpSessions.values()).some(rec => Number(rec.tabId) === Number(tabId));
}

function piCdpNow(): number { return Date.now(); }
function piCdpSessionKey(tabId: unknown, name?: unknown): string { return String(tabId) + ':' + (name || 'default'); }
function piCdpNewDocumentScriptKey(tabId: unknown, name: unknown, identifier: unknown): string { return piCdpSessionKey(tabId, name || 'new_document') + ':' + String(identifier); }
function piCdpKnownNewDocumentIdentifiers(tabId: unknown, name?: string): string[] {
  return Array.from(piPersistentCdpNewDocumentScripts.values())
    .filter(rec => Number(rec.tabId) === Number(tabId) && (!name || rec.cdpSessionName === name))
    .map(rec => rec.identifier);
}
function piCdpStateStoreKey(tabId: unknown, name: unknown, identifier: unknown): string {
  return `new_document:${piCdpNewDocumentScriptKey(tabId, name, identifier)}`;
}
async function piCdpPersistNewDocumentScript(rec: PiCdpNewDocumentScript): Promise<void> {
  await persistState('cdp', piCdpStateStoreKey(rec.tabId, rec.cdpSessionName, rec.identifier), {
    tabId: rec.tabId,
    identifier: rec.identifier,
    cdpSessionName: rec.cdpSessionName,
    method: rec.method,
    runImmediately: rec.runImmediately,
    includeCommandLineAPI: rec.includeCommandLineAPI,
    worldName: rec.worldName,
  }, {
    tabId: rec.tabId,
    sessionId: String(rec.cdpSessionName || 'new_document'),
    recoveryPolicy: 'diagnosticOnly',
  });
}
async function piCdpForgetNewDocumentScriptState(tabId: unknown, name: unknown, identifier: unknown): Promise<void> {
  await forgetState('cdp', piCdpStateStoreKey(tabId, name, identifier));
}
async function piCdpLostNewDocumentScriptState(tabId: unknown, name: unknown, identifier: unknown): Promise<unknown> {
  const record = await getState('cdp', piCdpStateStoreKey(tabId, name, identifier));
  if (!record) return undefined;
  return record.workerBootId !== undefined ? record : undefined;
}
function piCdpError(code: string, message: unknown, details: unknown = {}): PiCdpResponse {
  const safeDetails = (details && typeof details === 'object') ? details as JsonRecord : (details === undefined ? {} : { raw: details });
  return { ok: false, error: { code, message: String(message || code || 'ERROR'), details: safeDetails } };
}
function piCdpRawError(e: unknown): JsonRecord { return cdpRawError(e); }
function piCdpAugmentDebuggerEvidence(method: string, data: JsonRecord): JsonRecord {
  const out = { ...data };
  const result = cdpRecord(out.result);
  if (method === 'Debugger.enable' && result.debuggerId !== undefined && out.debuggerId === undefined) out.debuggerId = result.debuggerId;
  if (method === 'Debugger.getScriptSource' && result.scriptSource !== undefined && out.scriptSource === undefined) out.scriptSource = result.scriptSource;
  if (method === 'Runtime.evaluate') {
    if (result.value !== undefined && out.value === undefined) out.value = result.value;
    if (result.exceptionDetails && out.exceptionDetails === undefined) out.exceptionDetails = result.exceptionDetails;
    const exceptionDetails = cdpRecord(out.exceptionDetails);
    if (exceptionDetails.scriptId !== undefined && out.scriptId === undefined) out.scriptId = exceptionDetails.scriptId;
    const stackTrace = cdpRecord(exceptionDetails.stackTrace);
    if (Array.isArray(stackTrace.callFrames) && out.callFrames === undefined) out.callFrames = stackTrace.callFrames;
  }
  return out;
}
function piCdpOk(data: JsonRecord): PiCdpResponse { return { ok: true, data }; }
function piCdpWithTimeout<T>(promise: Promise<T>, timeoutMs?: unknown, label = 'CDP command'): Promise<T> {
  const ms = Math.max(1, Number(timeoutMs || PI_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS));
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'CDP command') + ' timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function piCdpFlattenFrameTree(node: PiCdpFrameTreeNode | null | undefined, out: PiCdpFrame[] = []): PiCdpFrame[] {
  if (!node) return out;
  const frame = cdpRecord(node.frame || node);
  if (frame && frame.id) out.push({
    id: String(frame.id || ''),
    frameId: String(frame.id || ''),
    parentId: frame.parentId ? String(frame.parentId) : null,
    url: String(frame.url || ''),
    name: String(frame.name || ''),
    mimeType: String(frame.mimeType || ''),
    securityOrigin: String(frame.securityOrigin || '')
  });
  for (const child of (node.childFrames || [])) piCdpFlattenFrameTree(child, out);
  return out;
}
function piCdpNormalizeFrameTreeNode(node: PiCdpFrameTreeNode | null | undefined): PiCdpFrame | null {
  if (!node) return null;
  const frame = cdpRecord(node.frame || node);
  const children: PiCdpFrame[] = [];
  const out: PiCdpFrame = {
    childFrames: children,
    id: String(frame.id || ''),
    frameId: String(frame.id || ''),
    parentId: frame.parentId ? String(frame.parentId) : null,
    url: String(frame.url || ''),
    name: String(frame.name || ''),
    mimeType: String(frame.mimeType || ''),
    securityOrigin: String(frame.securityOrigin || ''),
    children
  };
  for (const child of (node.childFrames || [])) {
    const c = piCdpNormalizeFrameTreeNode(child);
    if (c) children.push(c);
  }
  return out;
}

function piCdpResolveFrame(frames: PiCdpFrame[], selector: unknown): PiCdpFrame | null {
  if (!selector || selector === 'main' || selector === 'root') return frames[0] || null;
  if (typeof selector === 'string') {
    return frames.find(f => f.frameId === selector || f.name === selector || f.url.includes(selector)) || null;
  }
  const selectorRecord = cdpRecord(selector);
  if (selectorRecord.frameId) return frames.find(f => f.frameId === selectorRecord.frameId) || null;
  if (selectorRecord.name) return frames.find(f => f.name === selectorRecord.name) || null;
  if (selectorRecord.urlContains) return frames.find(f => f.url.includes(String(selectorRecord.urlContains))) || null;
  if (selectorRecord.index !== undefined) return frames[Number(selectorRecord.index)] || null;
  return null;
}

async function piPersistentCdpAttach(tabId: number, options: PiCdpOptions = {}): Promise<PiCdpResponse> {
  if (!tabId) return piCdpError('NO_TAB_ID', 'tabId is required');
  const name = options?.name || 'default';
  const key = piCdpSessionKey(tabId, name);
  if (piPersistentCdpSessions.has(key)) {
    const old = piPersistentCdpSessions.get(key)!;
    old.lastUsed = piCdpNow();
    return piCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: old.attachedAt });
  }
  if (piPersistentCdpSessions.size >= PI_PERSISTENT_CDP_MAX_SESSIONS) {
    // Long-running sessions accumulate persistent CDP attachments faster than
    // tab-close cleanup releases them. Before hard-failing, opportunistically
    // evict idle (non-pending, unlocked) sessions and retry the cap check once.
    try { await piPersistentCdpReleaseIdle(0); } catch (error) { console.warn('[PI-BROWSER-CDP] idle release before attach failed', error); }
    if (piPersistentCdpSessions.size >= PI_PERSISTENT_CDP_MAX_SESSIONS) {
      return piCdpError('SESSION_LIMIT', 'too many persistent CDP sessions', { max: PI_PERSISTENT_CDP_MAX_SESSIONS });
    }
  }
  try {
    if (options?.bringToFront) await chrome.tabs.update(tabId, { active: true });
    await chrome.debugger.attach({ tabId }, options?.protocolVersion || '1.3');
    const rec = { tabId, name, key, attachedAt: piCdpNow(), lastUsed: piCdpNow(), commands: 0, pending: 0, lockedUntil: 0 };
    piPersistentCdpSessions.set(key, rec);
    // Enable Page/Runtime domains immediately. Without this, Chrome may return only
    // the main frame from Page.getFrameTree until domains are explicitly enabled,
    // which breaks iframe-targeted evaluation in fresh persistent sessions.
    try { await piPersistentCdpSend(tabId, 'Page.enable', {}, { name }); } catch (error) { console.warn('[PI-BROWSER-CDP] Failed to enable Page domain after attach', key, error); }
    try { await piPersistentCdpSend(tabId, 'Runtime.enable', {}, { name }); } catch (error) { console.warn('[PI-BROWSER-CDP] Failed to enable Runtime domain after attach', key, error); }
    return piCdpOk({ sessionKey: key, tabId, name, reused: false, attachedAt: rec.attachedAt });
  } catch (e) {
    const msg = cdpErrorMessage(e);
    if (/Another debugger is already attached|Cannot attach/i.test(String(msg || ''))) {
      const existingKey = piCdpSessionKey(tabId, 'default');
      const existing = piPersistentCdpSessions.get(existingKey);
      if (existing) {
        existing.lastUsed = piCdpNow();
        if (name !== 'default') piPersistentCdpSessions.set(key, existing);
        return piCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: existing.attachedAt, alreadyAttached: true });
      }
      for (const [, rec] of piPersistentCdpSessions.entries()) {
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

async function piPersistentCdpDetachEntry(key: string): Promise<PiCdpResponse> {
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
  catch (e) { return piCdpError('DETACH_FAILED', cdpErrorMessage(e), { sessionKey: key, raw: piCdpRawError(e) }); }
  return piCdpOk({ sessionKey: key, detached: true, lifetimeMs: piCdpNow() - rec.attachedAt, commands: rec.commands });
}

async function piPersistentCdpDetach(tabId: number, options: PiCdpOptions = {}): Promise<PiCdpResponse> {
  const name = options?.name || 'default';
  return await piPersistentCdpDetachEntry(piCdpSessionKey(tabId, name));
}

async function piPersistentCdpSend(tabId: number, method: string, params: JsonRecord = {}, options: PiCdpOptions = {}): Promise<PiCdpResponse> {
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
  if (!rec) return piCdpError('ATTACH_FAILED', 'CDP session missing after attach', { tabId, name });
  rec.pending = (rec.pending || 0) + 1;
  rec.lockedUntil = Math.max(rec.lockedUntil || 0, piCdpNow() + Number(options?.timeoutMs || 30000));
  try {
    const data = await piCdpWithTimeout(
      chrome.debugger.sendCommand({ tabId: rec.tabId }, method, params || {}),
      options?.timeoutMs,
      method
    );
    rec.commands += 1; rec.lastUsed = piCdpNow();
    return piCdpOk(piCdpAugmentDebuggerEvidence(method, { result: data, sessionKey: key, method }));
  } catch (e) {
    const msg = cdpErrorMessage(e);
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

async function piPersistentCdpFrameTree(tabId: number, options: PiCdpOptions = {}): Promise<PiCdpResponse> {
  const resp = await piPersistentCdpSend(tabId, 'Page.getFrameTree', {}, options || {});
  if (!resp.ok) return resp;
  const rawTree = cdpRecord(cdpRecord(cdpRecord(resp.data).result).frameTree) as PiCdpFrameTreeNode;
  return piCdpOk({ frameTree: piCdpNormalizeFrameTreeNode(rawTree), frames: piCdpFlattenFrameTree(rawTree, []) });
}

async function piPersistentCdpEvaluateInFrame(tabId: number, expression: unknown, options: PiCdpOptions = {}): Promise<PiCdpResponse> {
  const frameTree = await piPersistentCdpFrameTree(tabId, options || {});
  if (!frameTree.ok) return frameTree;
  const frameTreeData = cdpRecord(frameTree.data);
  const frames = Array.isArray(frameTreeData.frames) ? frameTreeData.frames as PiCdpFrame[] : [];
  const frame = piCdpResolveFrame(frames, options?.frame || options?.frameId || 'main');
  if (!frame) return piCdpError('FRAME_NOT_FOUND', 'requested frame not found', { frame: options?.frame || options?.frameId, frames });
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
      contextId: cdpRecord(cdpRecord(world.data).result).executionContextId,
      awaitPromise: options?.awaitPromise !== false,
      returnByValue: options?.returnByValue !== false,
      userGesture: Boolean(options?.userGesture)
    }, options || {});
    if (!evalResp.ok) return evalResp;
    return piCdpOk({ frame, executionContextId: cdpRecord(cdpRecord(world.data).result).executionContextId, result: cdpRecord(evalResp.data).result });
  } catch (e) {
    return piCdpError('FRAME_EVAL_FAILED', cdpErrorMessage(e), { frame, raw: piCdpRawError(e) });
  }
}

async function piPersistentCdpAddNewDocumentScript(tabId: number, source: unknown, options: PiCdpOptions = {}): Promise<PiCdpResponse> {
  if (!source) return piCdpError('NO_SOURCE', 'script source is required');
  const cdpOptions = { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' };
  const params = {
    source: String(source),
    includeCommandLineAPI: Boolean(options?.includeCommandLineAPI),
    runImmediately: Boolean(options?.runImmediately)
  };
  if (options?.worldName !== undefined) (params as JsonRecord).worldName = String(options.worldName || '');
  const resp = await piPersistentCdpSend(tabId, 'Page.addScriptToEvaluateOnNewDocument', params, cdpOptions);
  if (!resp.ok) return resp;
  const respData = cdpRecord(resp.data);
  const identifier = String(cdpRecord(respData.result).identifier);
  const sessionKey = respData.sessionKey;
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
  try { await piCdpPersistNewDocumentScript(rec); } catch (error) { console.warn('[PI-BROWSER-CDP] Failed to persist new-document script state', rec.key, error); }
  return piCdpOk({ identifier, sessionKey, cdpSessionName: cdpOptions.name, tabId:Number(tabId), method: rec.method, detached: cdpOptions.persistent !== true });
}

async function piPersistentCdpRemoveNewDocumentScript(tabId: number, identifier: unknown, options: PiCdpOptions = {}): Promise<PiCdpResponse> {
  if (!identifier) return piCdpError('NO_IDENTIFIER', 'script identifier is required');
  const cdpOptions = { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' };
  const id = String(identifier);
  const key = piCdpNewDocumentScriptKey(tabId, cdpOptions.name, id);
  const known = piPersistentCdpNewDocumentScripts.get(key);
  if (!known) {
    const lost = await piCdpLostNewDocumentScriptState(tabId, cdpOptions.name, id);
    if (lost) {
      return piCdpError(RECOVERY_CODES.LOST, 'new document script state was lost after service worker restart', { tabId:Number(tabId), identifier:id, cdpSessionName:String(cdpOptions.name), knownIdentifiers:piCdpKnownNewDocumentIdentifiers(tabId, String(cdpOptions.name)), historyLost:true, nextAction:'re-add the new-document script with frame.addNewDocumentScript' });
    }
    return piCdpError('SCRIPT_NOT_FOUND', 'new document script identifier is not registered', { tabId:Number(tabId), identifier:id, cdpSessionName:String(cdpOptions.name), knownIdentifiers:piCdpKnownNewDocumentIdentifiers(tabId, String(cdpOptions.name)) });
  }
  const method = 'Page.removeScriptToEvaluateOnNewDocument';
  const resp = await piPersistentCdpSend(tabId, method, { identifier:id }, cdpOptions);
  if (!resp.ok) {
    const errorRecord = cdpRecord(resp.error);
    const msg = String(errorRecord.message || resp.message || resp.error || '');
    // Chrome may drop a previously registered new-document identifier after a debugger
    // detach or navigation lifecycle reset.  Only known identifiers are treated as
    // idempotent cleanup; arbitrary unknown ids still return SCRIPT_NOT_FOUND above.
    if (/(no\s+script|script.*(not\s*found|does\s*not\s*exist|given\s+id)|identifier.*(not\s*found|does\s*not\s*exist))/i.test(msg)) {
      piPersistentCdpNewDocumentScripts.delete(key);
      try { await piCdpForgetNewDocumentScriptState(tabId, cdpOptions.name, id); } catch (error) { console.warn('[PI-BROWSER-CDP] Failed to forget already-removed new-document script state', key, error); }
      return piCdpOk({ identifier:id, removed:false, alreadyRemoved:true, sessionKey:known.sessionKey, cdpSessionName:known.cdpSessionName, tabId:Number(tabId), method, error:msg });
    }
    return resp;
  }
  piPersistentCdpNewDocumentScripts.delete(key);
  try { await piCdpForgetNewDocumentScriptState(tabId, cdpOptions.name, id); } catch (error) { console.warn('[PI-BROWSER-CDP] Failed to forget new-document script state after removal', key, error); }
  return piCdpOk({ identifier:id, removed:true, alreadyRemoved:false, sessionKey:cdpRecord(resp.data).sessionKey || known.sessionKey, cdpSessionName:known.cdpSessionName, tabId:Number(tabId), method });
}

async function piPersistentCdpReleaseIdle(maxIdleMs?: unknown): Promise<PiCdpResponse> {
  const now = piCdpNow();
  const rawIdleMs = maxIdleMs === undefined || maxIdleMs === null ? 60000 : Number(maxIdleMs);
  const idleMs = Number.isFinite(rawIdleMs) ? rawIdleMs : 60000;
  const released: JsonRecord[] = [];
  const skipped: JsonRecord[] = [];
  for (const [key, rec] of Array.from(piPersistentCdpSessions.entries())) {
    if (!piPersistentCdpSessions.has(key)) continue;
    if ((rec.pending || 0) > 0 || (rec.lockedUntil || 0) > now) { skipped.push({ sessionKey: key, pending: rec.pending || 0, reason: 'idle busy' }); continue; }
    if (now - rec.lastUsed >= idleMs) {
      const res = await piPersistentCdpDetachEntry(key);
      released.push({ sessionKey: key, ok: res.ok, detached: cdpRecord(res.data).detached === true });
    }
  }
  return piCdpOk({ released, skipped, remaining: piPersistentCdpSessions.size });
}

// Release every persistent CDP session bound to a tab. Invoked from the shared
// tab-teardown path (chrome.tabs.onRemoved / navigation churn) so attachments do
// not leak and fill PI_PERSISTENT_CDP_MAX_SESSIONS over a long session.
// Synchronous by contract: piPersistentCdpDetachEntry removes each entry from the
// map before its first await, so the map is drained for this tab by the time this
// returns; the physical chrome.debugger.detach completes best-effort afterwards.
function cleanupPersistentCdpForTab(tabId: number, _reason?: string): JsonRecord {
  const target = Number(tabId);
  const removed: string[] = [];
  for (const [key, rec] of Array.from(piPersistentCdpSessions.entries())) {
    if (!rec || Number(rec.tabId) !== target) continue;
    removed.push(key);
    void piPersistentCdpDetachEntry(key).catch(() => piPersistentCdpSessions.delete(key));
  }
  for (const [key, rec] of Array.from(piPersistentCdpNewDocumentScripts.entries())) {
    if (rec && Number(rec.tabId) === target) piPersistentCdpNewDocumentScripts.delete(key);
  }
  return { tabId: target, released: removed.length, sessionKeys: removed };
}

async function handlePersistentCdpCommand(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiCdpResponse> {
  const tabId = Number(msg.tabId || sender?.tab?.id || 0);
  const action = msg.action || msg.method;
  if (!tabId && action !== 'releaseIdle') return piCdpError('NO_TAB_ID', 'tabId is required');
  if (action === 'attach') return await piPersistentCdpAttach(tabId, msg as PiCdpOptions);
  if (action === 'send') return await piPersistentCdpSend(tabId, String(msg.cdpMethod || ''), cdpRecord(msg.params), msg as PiCdpOptions);
  if (action === 'detach') return await piPersistentCdpDetach(tabId, msg as PiCdpOptions);
  if (action === 'frameTree') return await piPersistentCdpFrameTree(tabId, msg as PiCdpOptions);
  if (action === 'evaluateInFrame') return await piPersistentCdpEvaluateInFrame(tabId, msg.expression, msg as PiCdpOptions);
  if (action === 'addNewDocumentScript') return await piPersistentCdpAddNewDocumentScript(tabId, msg.source, msg as PiCdpOptions);
  if (action === 'removeNewDocumentScript') return await piPersistentCdpRemoveNewDocumentScript(tabId, msg.identifier, msg as PiCdpOptions);
  if (action === 'releaseIdle') return await piPersistentCdpReleaseIdle(msg.maxIdleMs);
  return piCdpError('UNKNOWN_ACTION', 'unknown persistent CDP action: ' + action, { action });
}

chrome.debugger.onDetach.addListener((source, _reason) => {
  if (!source || !source.tabId) return;
  for (const [key, rec] of Array.from(piPersistentCdpSessions.entries())) {
    if (rec.tabId === source.tabId) piPersistentCdpSessions.delete(key);
  }
});

registerRecovery(async (results) => {
  const result = await recoverState('cdp', {
    validateTab: true,
    recover: async () => ({
      recovered: false,
      historyLost: true,
      reason: 'raw new-document script source is not persisted; explicit frame.addNewDocumentScript is required',
    }),
  });
  results.push(result);
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
const cdpGlobal = self as typeof self & { PiPersistentCdp?: unknown; piPersistentCdpBridge?: unknown };
cdpGlobal.PiPersistentCdp = piPersistentCdpBridge;
cdpGlobal.piPersistentCdpBridge = piPersistentCdpBridge;
export { PI_PERSISTENT_CDP_VERSION, PI_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS, PI_PERSISTENT_CDP_MAX_SESSIONS, piPersistentCdpSessions, piPersistentCdpNewDocumentScripts, piPersistentCdpHasSessionForTab, piCdpNow, piCdpSessionKey, piCdpNewDocumentScriptKey, piCdpKnownNewDocumentIdentifiers, piCdpError, piCdpRawError, piCdpOk, piCdpWithTimeout, piCdpFlattenFrameTree, piCdpNormalizeFrameTreeNode, piCdpResolveFrame, piPersistentCdpAttach, piPersistentCdpDetachEntry, piPersistentCdpDetach, piPersistentCdpSend, piPersistentCdpFrameTree, piPersistentCdpEvaluateInFrame, piPersistentCdpAddNewDocumentScript, piPersistentCdpRemoveNewDocumentScript, piPersistentCdpReleaseIdle, cleanupPersistentCdpForTab, handlePersistentCdpCommand, piPersistentCdpBridge };
// ESM module metadata
export const __piBridgeModule_cdp = { name: "cdp", symbols: { PI_PERSISTENT_CDP_VERSION, PI_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS, PI_PERSISTENT_CDP_MAX_SESSIONS, piPersistentCdpSessions, piPersistentCdpNewDocumentScripts, piPersistentCdpHasSessionForTab, piCdpNow, piCdpSessionKey, piCdpNewDocumentScriptKey, piCdpKnownNewDocumentIdentifiers, piCdpError, piCdpRawError, piCdpOk, piCdpWithTimeout, piCdpFlattenFrameTree, piCdpNormalizeFrameTreeNode, piCdpResolveFrame, piPersistentCdpAttach, piPersistentCdpDetachEntry, piPersistentCdpDetach, piPersistentCdpSend, piPersistentCdpFrameTree, piPersistentCdpEvaluateInFrame, piPersistentCdpAddNewDocumentScript, piPersistentCdpRemoveNewDocumentScript, piPersistentCdpReleaseIdle, cleanupPersistentCdpForTab, handlePersistentCdpCommand, piPersistentCdpBridge } };
