import { chromeApi as chrome } from "./runtimeEnv";
import { RECOVERY_CODES, forget as forgetState, get as getState, persist as persistState, registerRecovery, recover as recoverState } from "./state_store";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotBridgeSender } from "./types";

type BrowserPilotCdpResponse = BrowserPilotBridgeResponse<JsonRecord>;
type BrowserPilotCdpSession = { tabId: number; name: string; key: string; attachedAt: number; lastUsed: number; commands: number; pending: number; lockedUntil: number; autoDetach: boolean; compiledScripts: Map<string, string>; scriptCompiles: Map<string, Promise<string | undefined>>; scriptHits: Map<string, number>; configuredFeatures: Set<string>; featurePromises: Map<string, Promise<void>> };
type BrowserPilotCdpChildSession = { tabId: number; parentKey: string; key: string; targetId: string; sessionId: string; name: string; attachedAt: number; lastUsed: number; commands: number; pending: number };
type BrowserPilotCdpCommandTarget = { debuggee: { tabId: number; sessionId?: string }; route: JsonRecord; child?: BrowserPilotCdpChildSession };
type BrowserPilotCdpNewDocumentScript = { key: string; tabId: number; identifier: string; sessionKey?: unknown; cdpSessionName: string; method: string; createdAt: number; runImmediately: boolean; includeCommandLineAPI: boolean; worldName?: string };
type BrowserPilotCdpFrame = { id: string; frameId: string; parentId: string | null; url: string; name: string; mimeType: string; securityOrigin: string; childFrames?: BrowserPilotCdpFrame[]; children?: BrowserPilotCdpFrame[] };
type BrowserPilotCdpFrameTreeNode = JsonRecord & { frame?: JsonRecord; childFrames?: BrowserPilotCdpFrameTreeNode[] };
type BrowserPilotCdpOptions = BrowserPilotBridgeCommand & { name?: string; protocolVersion?: string; bringToFront?: boolean; persistent?: boolean; detachOnError?: boolean; frame?: unknown; frameId?: unknown; targetId?: unknown; sessionId?: unknown; worldName?: string; grantUniversalAccess?: boolean; awaitPromise?: boolean; returnByValue?: boolean; userGesture?: boolean; includeCommandLineAPI?: boolean; runImmediately?: boolean; precompile?: boolean; scriptHash?: string; focusEmulation?: boolean; requiredDomains?: string[]; __browserPilotRetryAfterNotAttached?: boolean };

function cdpRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function cdpErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function cdpRawError(error: unknown): JsonRecord { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }

// cdp.js — Browser Pilot persistent CDP / iframe helpers.
// Flat Target sessions are optional and explicit: the default route remains tab-scoped, while
// callers with a targetId can attach that child target and send through chrome.debugger sessionId.

const BROWSER_PILOT_PERSISTENT_CDP_VERSION = 'p4.1.0';
const BROWSER_PILOT_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS = 15000;
const BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS = 16;
const BROWSER_PILOT_CDP_MAX_COMPILED_SCRIPTS = 32;
const BROWSER_PILOT_CDP_MAX_SCRIPT_HITS = 64;
const BROWSER_PILOT_CDP_MAX_NEW_DOCUMENT_SCRIPTS = 32;
const BROWSER_PILOT_CDP_MAX_NEW_DOCUMENT_SCRIPT_CHARS = 256 * 1024;

const browserPilotPersistentCdpSessions = new Map<string, BrowserPilotCdpSession>();
const browserPilotPersistentCdpChildSessions = new Map<string, BrowserPilotCdpChildSession>();
const browserPilotPersistentCdpNewDocumentScripts = new Map<string, BrowserPilotCdpNewDocumentScript>();
const browserPilotPersistentCdpTabAttaches = new Map<number, Promise<BrowserPilotCdpResponse>>();

function browserPilotPersistentCdpHasSessionForTab(tabId: unknown): boolean {
  return Array.from(browserPilotPersistentCdpSessions.values()).some(rec => Number(rec.tabId) === Number(tabId));
}

function browserPilotCdpNow(): number { return Date.now(); }
function browserPilotCdpSessionKey(tabId: unknown, name?: unknown): string { return String(tabId) + ':' + (name || 'default'); }
function browserPilotCdpTargetSessionKey(tabId: unknown, name: unknown, targetId: unknown): string { return browserPilotCdpSessionKey(tabId, name || 'default') + ':target:' + String(targetId || ''); }
function browserPilotCdpCleanTargetId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}
function browserPilotCdpCleanSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}
function browserPilotCdpScriptCacheKey(expression: string, params: JsonRecord, options: BrowserPilotCdpOptions): string {
  const explicit = typeof options.scriptHash === 'string' ? options.scriptHash : '';
  if (explicit) return [explicit, params.contextId ?? 'main'].join(':');
  let hash = 2166136261;
  for (let index = 0; index < expression.length; index += 1) {
    hash ^= expression.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return [(hash >>> 0).toString(36), expression.length, params.contextId ?? 'main'].join(':');
}
function browserPilotCdpNewDocumentScriptKey(tabId: unknown, name: unknown, identifier: unknown): string { return browserPilotCdpSessionKey(tabId, name || 'new_document') + ':' + String(identifier); }
function browserPilotCdpKnownNewDocumentIdentifiers(tabId: unknown, name?: string): string[] {
  return Array.from(browserPilotPersistentCdpNewDocumentScripts.values())
    .filter(rec => Number(rec.tabId) === Number(tabId) && (!name || rec.cdpSessionName === name))
    .map(rec => rec.identifier);
}
function browserPilotCdpStateStoreKey(tabId: unknown, name: unknown, identifier: unknown): string {
  return `new_document:${browserPilotCdpNewDocumentScriptKey(tabId, name, identifier)}`;
}
async function browserPilotCdpPersistNewDocumentScript(rec: BrowserPilotCdpNewDocumentScript): Promise<void> {
  await persistState('cdp', browserPilotCdpStateStoreKey(rec.tabId, rec.cdpSessionName, rec.identifier), {
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
async function browserPilotCdpForgetNewDocumentScriptState(tabId: unknown, name: unknown, identifier: unknown): Promise<void> {
  await forgetState('cdp', browserPilotCdpStateStoreKey(tabId, name, identifier));
}
async function browserPilotCdpLostNewDocumentScriptState(tabId: unknown, name: unknown, identifier: unknown): Promise<unknown> {
  const record = await getState('cdp', browserPilotCdpStateStoreKey(tabId, name, identifier));
  if (!record) return undefined;
  return record.workerBootId !== undefined ? record : undefined;
}
function browserPilotCdpError(code: string, message: unknown, details: unknown = {}): BrowserPilotCdpResponse {
  const safeDetails = (details && typeof details === 'object') ? details as JsonRecord : (details === undefined ? {} : { raw: details });
  return { ok: false, error: { code, message: String(message || code || 'ERROR'), details: safeDetails } };
}
function browserPilotCdpRawError(e: unknown): JsonRecord { return cdpRawError(e); }
function browserPilotCdpCommandTargetOk(data: BrowserPilotCdpCommandTarget): BrowserPilotBridgeResponse<BrowserPilotCdpCommandTarget> { return { ok: true, data }; }
function browserPilotCdpCommandTargetError(resp: BrowserPilotCdpResponse): BrowserPilotBridgeResponse<BrowserPilotCdpCommandTarget> { return resp as BrowserPilotBridgeResponse<BrowserPilotCdpCommandTarget>; }
function browserPilotCdpAugmentDebuggerEvidence(method: string, data: JsonRecord): JsonRecord {
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
function browserPilotCdpOk(data: JsonRecord): BrowserPilotCdpResponse { return { ok: true, data }; }
function browserPilotCdpWithTimeout<T>(promise: Promise<T>, timeoutMs?: unknown, label = 'CDP command'): Promise<T> {
  const ms = Math.max(1, Number(timeoutMs || BROWSER_PILOT_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS));
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || 'CDP command') + ' timed out after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function browserPilotCdpFlattenFrameTree(node: BrowserPilotCdpFrameTreeNode | null | undefined, out: BrowserPilotCdpFrame[] = []): BrowserPilotCdpFrame[] {
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
  for (const child of (node.childFrames || [])) browserPilotCdpFlattenFrameTree(child, out);
  return out;
}
function browserPilotCdpNormalizeFrameTreeNode(node: BrowserPilotCdpFrameTreeNode | null | undefined): BrowserPilotCdpFrame | null {
  if (!node) return null;
  const frame = cdpRecord(node.frame || node);
  const children: BrowserPilotCdpFrame[] = [];
  const out: BrowserPilotCdpFrame = {
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
    const c = browserPilotCdpNormalizeFrameTreeNode(child);
    if (c) children.push(c);
  }
  return out;
}

function browserPilotCdpResolveFrame(frames: BrowserPilotCdpFrame[], selector: unknown): BrowserPilotCdpFrame | null {
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

async function browserPilotCdpEnsureSessionCapacity(): Promise<BrowserPilotCdpResponse | undefined> {
  if (browserPilotPersistentCdpSessions.size < BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS) return undefined;
  try {
    await browserPilotPersistentCdpReleaseIdle(0);
  } catch (error) {
    console.warn('[BROWSER-PILOT-CDP] idle release before attach failed', error);
  }
  return browserPilotPersistentCdpSessions.size >= BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS
    ? browserPilotCdpError('SESSION_LIMIT', 'too many persistent CDP sessions', { max: BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS })
    : undefined;
}

function browserPilotCdpReuseAttachedSession(tabId: number, name: string, key: string): BrowserPilotCdpResponse | undefined {
  const existing = browserPilotPersistentCdpSessions.get(browserPilotCdpSessionKey(tabId, 'default'))
    ?? Array.from(browserPilotPersistentCdpSessions.values()).find((rec) => rec?.tabId === tabId);
	if (!existing) return undefined;
	existing.lastUsed = browserPilotCdpNow();
	browserPilotPersistentCdpSessions.set(key, existing);
	return browserPilotCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: existing.attachedAt, alreadyAttached: true });
}

async function browserPilotPersistentCdpAttachFresh(tabId: number, name: string, key: string, options: BrowserPilotCdpOptions): Promise<BrowserPilotCdpResponse> {
  // Long-running sessions accumulate persistent attachments faster than tab-close
  // cleanup releases them, so evict idle entries before enforcing the hard cap.
  const capacityError = await browserPilotCdpEnsureSessionCapacity();
  if (capacityError) return capacityError;
  try {
    if (options?.bringToFront) await chrome.tabs.update(tabId, { active: true });
    await chrome.debugger.attach({ tabId }, options?.protocolVersion || '1.3');
    const rec: BrowserPilotCdpSession = { tabId, name, key, attachedAt: browserPilotCdpNow(), lastUsed: browserPilotCdpNow(), commands: 0, pending: 0, lockedUntil: 0, autoDetach: options?.persistent === false, compiledScripts: new Map<string, string>(), scriptCompiles: new Map<string, Promise<string | undefined>>(), scriptHits: new Map<string, number>(), configuredFeatures: new Set<string>(), featurePromises: new Map<string, Promise<void>>() };
    browserPilotPersistentCdpSessions.set(key, rec);
    return browserPilotCdpOk({ sessionKey: key, tabId, name, reused: false, attachedAt: rec.attachedAt });
  } catch (e) {
    const msg = cdpErrorMessage(e);
    if (/Another debugger is already attached|Cannot attach/i.test(String(msg || ''))) {
      const reused = browserPilotCdpReuseAttachedSession(tabId, String(name), key);
      if (reused) return reused;
    }
    return browserPilotCdpError('ATTACH_FAILED', msg, { tabId, name, raw: browserPilotCdpRawError(e) });
  }
}

async function browserPilotPersistentCdpAttach(tabId: number, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  if (!tabId) return browserPilotCdpError('NO_TAB_ID', 'tabId is required');
  const name = String(options?.name || 'default');
  const key = browserPilotCdpSessionKey(tabId, name);
  const existing = browserPilotPersistentCdpSessions.get(key);
  if (existing) {
    existing.lastUsed = browserPilotCdpNow();
    return browserPilotCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: existing.attachedAt });
  }
  const attaching = browserPilotPersistentCdpTabAttaches.get(tabId);
  if (attaching) {
    const attached = await attaching;
    if (!attached.ok) return attached;
    return browserPilotCdpReuseAttachedSession(tabId, name, key)
      ?? browserPilotCdpError('ATTACH_FAILED', 'CDP session missing after concurrent attach', { tabId, name });
  }
  const pending = browserPilotPersistentCdpAttachFresh(tabId, name, key, options);
  browserPilotPersistentCdpTabAttaches.set(tabId, pending);
  try {
    return await pending;
  } finally {
    if (browserPilotPersistentCdpTabAttaches.get(tabId) === pending) browserPilotPersistentCdpTabAttaches.delete(tabId);
  }
}

async function browserPilotPersistentCdpDetachEntry(key: string): Promise<BrowserPilotCdpResponse> {
  const rec = browserPilotPersistentCdpSessions.get(key);
  if (!rec) return browserPilotCdpOk({ sessionKey: key, detached: false });
  for (const [childKey, child] of Array.from(browserPilotPersistentCdpChildSessions.entries())) {
    if (child.parentKey === key) browserPilotPersistentCdpChildSessions.delete(childKey);
  }
  browserPilotPersistentCdpSessions.delete(key);
  // chrome.debugger attachment is physical per tab, while this bridge exposes
  // logical sessions by name (default/new_document/etc.).  Detaching one
  // logical session must not tear down the tab-wide debugger while another
  // logical session for the same tab still owns CDP state; otherwise Chrome
  // invalidates Page.addScriptToEvaluateOnNewDocument identifiers and a later
  // Page.removeScriptToEvaluateOnNewDocument fails with "Script not found".
  const stillOwned = Array.from(browserPilotPersistentCdpSessions.values()).some(other => other && Number(other.tabId) === Number(rec.tabId));
  if (stillOwned) {
    return browserPilotCdpOk({ sessionKey: key, detached: false, logicalDetached: true, physicalKept: true, lifetimeMs: browserPilotCdpNow() - rec.attachedAt, commands: rec.commands });
  }
  try { await chrome.debugger.detach({ tabId: rec.tabId }); }
  catch (e) { return browserPilotCdpError('DETACH_FAILED', cdpErrorMessage(e), { sessionKey: key, raw: browserPilotCdpRawError(e) }); }
  return browserPilotCdpOk({ sessionKey: key, detached: true, lifetimeMs: browserPilotCdpNow() - rec.attachedAt, commands: rec.commands });
}

async function browserPilotPersistentCdpDetach(tabId: number, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  const name = options?.name || 'default';
  return await browserPilotPersistentCdpDetachEntry(browserPilotCdpSessionKey(tabId, name));
}

async function browserPilotPersistentCdpAttachTarget(tabId: number, targetId: unknown, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  const cleanTargetId = browserPilotCdpCleanTargetId(targetId);
  if (!tabId) return browserPilotCdpError('NO_TAB_ID', 'tabId is required');
  if (!cleanTargetId) return browserPilotCdpError('NO_TARGET_ID', 'targetId is required');
  const name = options?.name || 'default';
  const parent = await browserPilotPersistentCdpAttach(tabId, { name, protocolVersion: options?.protocolVersion, bringToFront: options?.bringToFront, persistent: true });
  if (!parent.ok) return parent;
  const parentKey = browserPilotCdpSessionKey(tabId, name);
  const key = browserPilotCdpTargetSessionKey(tabId, name, cleanTargetId);
  const existing = browserPilotPersistentCdpChildSessions.get(key);
  if (existing) {
    existing.lastUsed = browserPilotCdpNow();
    return browserPilotCdpOk({ sessionKey: parentKey, childSessionKey: key, tabId, targetId: cleanTargetId, sessionId: existing.sessionId, reused: true, attachedAt: existing.attachedAt });
  }
  const existingForTarget = Array.from(browserPilotPersistentCdpChildSessions.values()).find((item) => item.tabId === tabId && item.targetId === cleanTargetId);
  if (existingForTarget) {
    const alias: BrowserPilotCdpChildSession = { ...existingForTarget, key, parentKey, name: String(name), lastUsed: browserPilotCdpNow() };
    browserPilotPersistentCdpChildSessions.set(key, alias);
    return browserPilotCdpOk({ sessionKey: parentKey, childSessionKey: key, tabId, targetId: cleanTargetId, sessionId: alias.sessionId, reused: true, aliasOf: existingForTarget.key, attachedAt: alias.attachedAt });
  }
  let resolveAttached: (value: { sessionId: string; targetInfo: JsonRecord }) => void = () => {};
  const attached = new Promise<{ sessionId: string; targetInfo: JsonRecord }>((resolve) => { resolveAttached = resolve; });
  const listener = (source: { tabId?: number; targetId?: string; sessionId?: string }, method: string, params?: JsonRecord) => {
    if (Number(source?.tabId) !== Number(tabId) || method !== 'Target.attachedToTarget') return;
    const targetInfo = cdpRecord(params?.targetInfo);
    const eventTargetId = browserPilotCdpCleanTargetId(targetInfo.targetId);
    const sessionId = browserPilotCdpCleanSessionId(params?.sessionId);
    if (eventTargetId === cleanTargetId && sessionId) resolveAttached({ sessionId, targetInfo });
  };
  try {
    chrome.debugger.onEvent.addListener(listener);
    const params = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }, { type: 'other', exclude: false }],
    };
    try {
      await browserPilotCdpWithTimeout(chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', params), options?.timeoutMs, 'Target.setAutoAttach');
    } catch (_setAutoAttachError) {
      await browserPilotCdpWithTimeout(chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }), options?.timeoutMs, 'Target.setAutoAttach');
    }
    const waitMs = Math.max(500, Math.min(5000, Number(options?.timeoutMs || 5000)));
    const result = await browserPilotCdpWithTimeout(attached, waitMs, 'Target.attachedToTarget');
    const rec: BrowserPilotCdpChildSession = { tabId, parentKey, key, targetId: cleanTargetId, sessionId: result.sessionId, name: String(name), attachedAt: browserPilotCdpNow(), lastUsed: browserPilotCdpNow(), commands: 0, pending: 0 };
    browserPilotPersistentCdpChildSessions.set(key, rec);
    return browserPilotCdpOk({ sessionKey: parentKey, childSessionKey: key, tabId, targetId: cleanTargetId, sessionId: rec.sessionId, attachMethod: 'Target.setAutoAttach', targetInfo: result.targetInfo, reused: false, attachedAt: rec.attachedAt });
  } catch (e) {
    return browserPilotCdpError('TARGET_ATTACH_FAILED', cdpErrorMessage(e), { tabId, targetId: cleanTargetId, attachMethod: 'Target.setAutoAttach', raw: browserPilotCdpRawError(e) });
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }
}

async function browserPilotPersistentCdpDetachTarget(tabId: number, targetIdOrSessionId: unknown, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  const name = options?.name || 'default';
  const rawSessionId = browserPilotCdpCleanSessionId(options?.sessionId);
  const rawTargetId = browserPilotCdpCleanTargetId(targetIdOrSessionId ?? options?.targetId);
  let child: BrowserPilotCdpChildSession | undefined;
  if (rawSessionId) child = Array.from(browserPilotPersistentCdpChildSessions.values()).find((item) => item.tabId === tabId && item.sessionId === rawSessionId);
  if (!child && rawTargetId) child = browserPilotPersistentCdpChildSessions.get(browserPilotCdpTargetSessionKey(tabId, name, rawTargetId));
  if (!child) return browserPilotCdpOk({ tabId, targetId: rawTargetId, sessionId: rawSessionId, detached: false });
  browserPilotPersistentCdpChildSessions.delete(child.key);
  try {
    await browserPilotCdpWithTimeout(chrome.debugger.sendCommand({ tabId }, 'Target.detachFromTarget', { sessionId: child.sessionId }), options?.timeoutMs, 'Target.detachFromTarget');
    return browserPilotCdpOk({ tabId, targetId: child.targetId, sessionId: child.sessionId, childSessionKey: child.key, detached: true, lifetimeMs: browserPilotCdpNow() - child.attachedAt, commands: child.commands });
  } catch (e) {
    return browserPilotCdpError('TARGET_DETACH_FAILED', cdpErrorMessage(e), { tabId, targetId: child.targetId, sessionId: child.sessionId, raw: browserPilotCdpRawError(e) });
  }
}

async function browserPilotPersistentCdpCommandTarget(tabId: number, name: string, rec: BrowserPilotCdpSession, options: BrowserPilotCdpOptions): Promise<BrowserPilotBridgeResponse<BrowserPilotCdpCommandTarget>> {
  const sessionId = browserPilotCdpCleanSessionId(options?.sessionId);
  if (sessionId) return browserPilotCdpCommandTargetOk({ debuggee: { tabId: rec.tabId, sessionId }, route: { targetScoped: true, attachRouteUsed: false, sessionId } });
  const targetId = browserPilotCdpCleanTargetId(options?.targetId);
  if (!targetId) return browserPilotCdpCommandTargetOk({ debuggee: { tabId: rec.tabId }, route: { targetScoped: false, attachRouteUsed: false } });
  const attached = await browserPilotPersistentCdpAttachTarget(tabId, targetId, options);
  if (!attached.ok) return browserPilotCdpCommandTargetError(attached);
  const child = browserPilotPersistentCdpChildSessions.get(browserPilotCdpTargetSessionKey(tabId, name, targetId));
  const childSessionId = browserPilotCdpCleanSessionId(cdpRecord(attached.data).sessionId) ?? child?.sessionId;
  if (!childSessionId) return browserPilotCdpCommandTargetError(browserPilotCdpError('TARGET_ATTACH_FAILED', 'target session missing after attach', { tabId, targetId, attached: attached.data }));
  return browserPilotCdpCommandTargetOk({ debuggee: { tabId: rec.tabId, sessionId: childSessionId }, route: { targetScoped: true, attachRouteUsed: true, attachMethod: cdpRecord(attached.data).attachMethod || 'Target.setAutoAttach', targetId, sessionId: childSessionId, childSessionKey: child?.key }, child });
}

type BrowserPilotCdpSendSession = { name: string; key: string; rec: BrowserPilotCdpSession; retrying: boolean };
type BrowserPilotCdpSendSessionResult = { ok: true; session: BrowserPilotCdpSendSession } | { ok: false; response: BrowserPilotCdpResponse };
type BrowserPilotCdpPreparedCommand = { data: unknown; precompiled: boolean };

async function browserPilotCdpAcquireSendSession(tabId: number, options: BrowserPilotCdpOptions): Promise<BrowserPilotCdpSendSessionResult> {
  const name = options?.name || 'default';
  const key = browserPilotCdpSessionKey(tabId, name);
  let rec = browserPilotPersistentCdpSessions.get(key);
  if (!rec) {
    const attached = await browserPilotPersistentCdpAttach(tabId, { name, protocolVersion: options?.protocolVersion, bringToFront: options?.bringToFront, persistent: options?.persistent });
    if (!attached.ok) return { ok: false, response: attached };
    rec = browserPilotPersistentCdpSessions.get(key);
  }
  if (!rec) return { ok: false, response: browserPilotCdpError('ATTACH_FAILED', 'CDP session missing after attach', { tabId, name }) };
  // A persistent caller promotes a concurrently-created temporary attachment.
  // Temporary callers never demote an already-owned persistent session.
  if (options?.persistent !== false) rec.autoDetach = false;
  return { ok: true, session: { name: String(name), key, rec, retrying: Boolean(options?.__browserPilotRetryAfterNotAttached) } };
}

function browserPilotCdpBeginSend(rec: BrowserPilotCdpSession, options: BrowserPilotCdpOptions): void {
  rec.pending = (rec.pending || 0) + 1;
  rec.lockedUntil = Math.max(rec.lockedUntil || 0, browserPilotCdpNow() + Number(options?.timeoutMs || 30000));
}

function browserPilotCdpCompileParams(expression: string, params: JsonRecord, name: string, cacheKey: string): JsonRecord {
  const compileParams: JsonRecord = {
    expression,
    sourceURL: 'browser-pilot://' + encodeURIComponent(String(name || 'script')) + '/' + cacheKey + '.js',
    persistScript: true,
  };
  if (params.contextId !== undefined) compileParams.executionContextId = params.contextId;
  return compileParams;
}

function browserPilotCdpRunParams(scriptId: string, params: JsonRecord): JsonRecord {
  const runParams: JsonRecord = {
    scriptId,
    awaitPromise: params.awaitPromise !== false,
    returnByValue: params.returnByValue !== false,
  };
  for (const field of ['objectGroup', 'silent', 'includeCommandLineAPI', 'userGesture']) {
    if (params[field] !== undefined) runParams[field] = params[field];
  }
  return runParams;
}

async function browserPilotCdpCompileScript(debuggee: BrowserPilotCdpCommandTarget['debuggee'], expression: string, params: JsonRecord, options: BrowserPilotCdpOptions, name: string, key: string, cacheKey: string): Promise<string | undefined> {
  try {
    const compiled = cdpRecord(await browserPilotCdpWithTimeout(chrome.debugger.sendCommand(debuggee, 'Runtime.compileScript', browserPilotCdpCompileParams(expression, params, name, cacheKey)), options?.timeoutMs, 'Runtime.compileScript'));
    return typeof compiled.scriptId === 'string' ? compiled.scriptId : undefined;
  } catch (compileError) {
    console.debug('[BROWSER-PILOT-CDP] Runtime.compileScript fallback to evaluate', key, cdpErrorMessage(compileError));
    return undefined;
  }
}

function browserPilotCdpTouchBounded<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function browserPilotCdpFeatureKey(debuggee: BrowserPilotCdpCommandTarget['debuggee'], feature: string): string {
  return (debuggee.sessionId || 'root') + ':' + feature;
}

async function browserPilotCdpEnsureFeature(session: BrowserPilotCdpSendSession, feature: string, configure: () => Promise<unknown>): Promise<void> {
  if (session.rec.configuredFeatures.has(feature)) return;
  let pending = session.rec.featurePromises.get(feature);
  if (!pending) {
    pending = (async () => {
      await configure();
      session.rec.configuredFeatures.add(feature);
    })();
    session.rec.featurePromises.set(feature, pending);
  }
  try {
    await pending;
  } finally {
    if (session.rec.featurePromises.get(feature) === pending) session.rec.featurePromises.delete(feature);
  }
}

async function browserPilotCdpPrepareSessionFeatures(session: BrowserPilotCdpSendSession, debuggee: BrowserPilotCdpCommandTarget['debuggee'], options: BrowserPilotCdpOptions): Promise<void> {
  for (const rawDomain of options.requiredDomains || []) {
    const domain = String(rawDomain || '');
    if (!/^[A-Z][A-Za-z0-9]*$/.test(domain)) continue;
    const feature = browserPilotCdpFeatureKey(debuggee, 'domain:' + domain);
    await browserPilotCdpEnsureFeature(session, feature, () => browserPilotCdpWithTimeout(chrome.debugger.sendCommand(debuggee, domain + '.enable', {}), options?.timeoutMs, domain + '.enable'));
  }
  if (options.focusEmulation !== true) return;
  const focusFeature = browserPilotCdpFeatureKey(debuggee, 'focus-emulation');
  try {
    await browserPilotCdpEnsureFeature(session, focusFeature, () => browserPilotCdpWithTimeout(chrome.debugger.sendCommand(debuggee, 'Emulation.setFocusEmulationEnabled', { enabled: true }), Math.min(2000, Number(options?.timeoutMs || 2000)), 'Emulation.setFocusEmulationEnabled'));
  } catch (error) {
    // Timer-throttle mitigation is best-effort; Runtime.evaluate remains usable on
    // browsers that do not expose Emulation.setFocusEmulationEnabled.
    console.debug('[BROWSER-PILOT-CDP] focus emulation unavailable', session.key, cdpErrorMessage(error));
  }
}

function browserPilotCdpRecordDomainState(session: BrowserPilotCdpSendSession, debuggee: BrowserPilotCdpCommandTarget['debuggee'], method: string): void {
  const match = /^([A-Z][A-Za-z0-9]*)\.(enable|disable)$/.exec(method);
  if (!match) return;
  const feature = browserPilotCdpFeatureKey(debuggee, 'domain:' + match[1]);
  if (match[2] === 'enable') session.rec.configuredFeatures.add(feature);
  else session.rec.configuredFeatures.delete(feature);
}

async function browserPilotCdpPrepareCommand(method: string, params: JsonRecord, options: BrowserPilotCdpOptions, session: BrowserPilotCdpSendSession, debuggee: BrowserPilotCdpCommandTarget['debuggee']): Promise<BrowserPilotCdpPreparedCommand> {
  const expression = typeof params.expression === 'string' ? params.expression : '';
  if (options?.precompile !== true || method !== 'Runtime.evaluate' || !expression) return { data: undefined, precompiled: false };
  const cacheKey = browserPilotCdpScriptCacheKey(expression, params, options) + ':' + (debuggee.sessionId || 'root');
  let scriptId = session.rec.compiledScripts.get(cacheKey);
  if (scriptId) browserPilotCdpTouchBounded(session.rec.compiledScripts, cacheKey, scriptId, BROWSER_PILOT_CDP_MAX_COMPILED_SCRIPTS);
  if (!scriptId) {
    const hits = (session.rec.scriptHits.get(cacheKey) || 0) + 1;
    browserPilotCdpTouchBounded(session.rec.scriptHits, cacheKey, hits, BROWSER_PILOT_CDP_MAX_SCRIPT_HITS);
    // One-off scripts are normally temporary. Evaluate them directly on first use;
    // only a second identical request pays compile+run and occupies the persistent
    // V8 script cache. Two calls cost the same total CDP trips as eager compilation,
    // while the common one-shot case saves a trip and leaves no compiled script.
    if (hits < 2) return { data: undefined, precompiled: false };
    let compiling = session.rec.scriptCompiles.get(cacheKey);
    if (!compiling) {
      compiling = browserPilotCdpCompileScript(debuggee, expression, params, options, session.name, session.key, cacheKey);
      session.rec.scriptCompiles.set(cacheKey, compiling);
    }
    try {
      scriptId = await compiling;
    } finally {
      if (session.rec.scriptCompiles.get(cacheKey) === compiling) session.rec.scriptCompiles.delete(cacheKey);
    }
    if (scriptId) {
      session.rec.scriptHits.delete(cacheKey);
      browserPilotCdpTouchBounded(session.rec.compiledScripts, cacheKey, scriptId, BROWSER_PILOT_CDP_MAX_COMPILED_SCRIPTS);
    }
  }
  if (!scriptId) return { data: undefined, precompiled: false };
  try {
    const data = await browserPilotCdpWithTimeout(chrome.debugger.sendCommand(debuggee, 'Runtime.runScript', browserPilotCdpRunParams(scriptId, params)), options?.timeoutMs, 'Runtime.runScript');
    return { data, precompiled: true };
  } catch (runError) {
    const message = cdpErrorMessage(runError);
    if (!/No script with given id/i.test(message)) throw runError;
    session.rec.compiledScripts.delete(cacheKey);
    browserPilotCdpTouchBounded(session.rec.scriptHits, cacheKey, 1, BROWSER_PILOT_CDP_MAX_SCRIPT_HITS);
    console.debug('[BROWSER-PILOT-CDP] Runtime.runScript script cache stale; fallback to evaluate', session.key, message);
    return { data: undefined, precompiled: false };
  }
}

async function browserPilotCdpExecuteCommand(method: string, params: JsonRecord, options: BrowserPilotCdpOptions, session: BrowserPilotCdpSendSession, debuggee: BrowserPilotCdpCommandTarget['debuggee']): Promise<BrowserPilotCdpPreparedCommand> {
  await browserPilotCdpPrepareSessionFeatures(session, debuggee, options);
  const prepared = await browserPilotCdpPrepareCommand(method, params, options, session, debuggee);
  if (prepared.data !== undefined) return prepared;
  const data = await browserPilotCdpWithTimeout(chrome.debugger.sendCommand(debuggee, method, params || {}), options?.timeoutMs, method);
  browserPilotCdpRecordDomainState(session, debuggee, method);
  return {
    data,
    precompiled: prepared.precompiled,
  };
}

function browserPilotCdpRecordSend(session: BrowserPilotCdpSendSession, child?: BrowserPilotCdpChildSession): void {
  session.rec.commands += 1;
  session.rec.lastUsed = browserPilotCdpNow();
  if (child) {
    child.commands += 1;
    child.lastUsed = browserPilotCdpNow();
  }
}

function browserPilotCdpPurgeTabSessions(tabId: number): void {
  browserPilotPersistentCdpTabAttaches.delete(Number(tabId));
  for (const [staleKey, staleRec] of Array.from(browserPilotPersistentCdpSessions.entries())) {
    if (staleRec && Number(staleRec.tabId) === Number(tabId)) browserPilotPersistentCdpSessions.delete(staleKey);
  }
  for (const [staleKey, staleRec] of Array.from(browserPilotPersistentCdpChildSessions.entries())) {
    if (staleRec && Number(staleRec.tabId) === Number(tabId)) browserPilotPersistentCdpChildSessions.delete(staleKey);
  }
}

async function browserPilotCdpHandleSendError(tabId: number, method: string, params: JsonRecord, options: BrowserPilotCdpOptions, session: BrowserPilotCdpSendSession, error: unknown): Promise<BrowserPilotCdpResponse> {
  const message = cdpErrorMessage(error);
  if (!session.retrying && /Debugger is not attached|Detached while handling command|Session with given id not found|No session with given id/i.test(String(message || ''))) {
    browserPilotCdpPurgeTabSessions(session.rec.tabId);
    return browserPilotPersistentCdpSend(tabId, method, params, { ...(options || {}), __browserPilotRetryAfterNotAttached: true });
  }
  if (options?.detachOnError) await browserPilotPersistentCdpDetach(tabId, { name: session.name });
  return browserPilotCdpError('SEND_FAILED', message || String(error), { sessionKey: session.key, method, raw: browserPilotCdpRawError(error) });
}

async function browserPilotCdpFinishSend(session: BrowserPilotCdpSendSession, child?: BrowserPilotCdpChildSession): Promise<void> {
  session.rec.pending = Math.max(0, (session.rec.pending || 1) - 1);
  if (child) child.pending = Math.max(0, (child.pending || 1) - 1);
  session.rec.lockedUntil = 0;
  session.rec.lastUsed = browserPilotCdpNow();
  if (session.rec.autoDetach && session.rec.pending === 0) {
    const aliases = Array.from(browserPilotPersistentCdpSessions.entries()).filter(([, rec]) => rec === session.rec).map(([key]) => key);
    for (const key of aliases) await browserPilotPersistentCdpDetachEntry(key);
  }
}

async function browserPilotPersistentCdpSend(tabId: number, method: string, params: JsonRecord = {}, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  if (!method) return browserPilotCdpError('NO_METHOD', 'CDP method is required');
  const acquired = await browserPilotCdpAcquireSendSession(tabId, options);
  if (!acquired.ok) return acquired.response;
  const session = acquired.session;
  let child: BrowserPilotCdpChildSession | undefined;
  browserPilotCdpBeginSend(session.rec, options);
  try {
    const routeResp = await browserPilotPersistentCdpCommandTarget(tabId, session.name, session.rec, options);
    if (!routeResp.ok) return routeResp as BrowserPilotCdpResponse;
    const routeData = routeResp.data!;
    child = routeData.child;
    if (child) child.pending = (child.pending || 0) + 1;
    const executed = await browserPilotCdpExecuteCommand(method, params, options, session, routeData.debuggee);
    browserPilotCdpRecordSend(session, child);
    return browserPilotCdpOk(browserPilotCdpAugmentDebuggerEvidence(method, { result: executed.data, sessionKey: session.key, method, cdpRoute: routeData.route, ...(executed.precompiled ? { precompiled: true } : {}) }));
  } catch (e) {
    return browserPilotCdpHandleSendError(tabId, method, params, options, session, e);
  } finally {
    await browserPilotCdpFinishSend(session, child);
  }
}

async function browserPilotPersistentCdpFrameTree(tabId: number, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  // Page.getFrameTree can be incomplete on a fresh debugger attachment until the
  // Page domain is enabled. Request it as an in-session preflight so ordinary CDP
  // calls avoid eager Page/Runtime setup and temporary sessions still attach once.
  const resp = await browserPilotPersistentCdpSend(tabId, 'Page.getFrameTree', {}, { ...(options || {}), requiredDomains: ['Page'] });
  if (!resp.ok) return resp;
  const rawTree = cdpRecord(cdpRecord(cdpRecord(resp.data).result).frameTree) as BrowserPilotCdpFrameTreeNode;
  return browserPilotCdpOk({ frameTree: browserPilotCdpNormalizeFrameTreeNode(rawTree), frames: browserPilotCdpFlattenFrameTree(rawTree, []) });
}

function browserPilotCdpFrameSelector(options: BrowserPilotCdpOptions): unknown {
  return options?.frame || options?.frameId || 'main';
}

function browserPilotCdpIsolatedWorldParams(frame: BrowserPilotCdpFrame, options: BrowserPilotCdpOptions): JsonRecord {
  return {
    frameId: frame.frameId,
    worldName: options?.worldName || ('browser_pilot_' + Math.random().toString(36).slice(2)),
    grantUniversalAccess: Boolean(options?.grantUniversalAccess),
  };
}

function browserPilotCdpFrameEvaluationParams(expression: unknown, executionContextId: unknown, options: BrowserPilotCdpOptions): JsonRecord {
  return {
    expression: String(expression || ''),
    contextId: executionContextId,
    awaitPromise: options?.awaitPromise !== false,
    returnByValue: options?.returnByValue !== false,
    userGesture: Boolean(options?.userGesture),
  };
}

function browserPilotCdpExecutionContextId(response: BrowserPilotCdpResponse): unknown {
  return cdpRecord(cdpRecord(response.data).result).executionContextId;
}

async function browserPilotPersistentCdpEvaluateInFrame(tabId: number, expression: unknown, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  const frameTree = await browserPilotPersistentCdpFrameTree(tabId, options || {});
  if (!frameTree.ok) return frameTree;
  const frameTreeData = cdpRecord(frameTree.data);
  const frames = Array.isArray(frameTreeData.frames) ? frameTreeData.frames as BrowserPilotCdpFrame[] : [];
  const selector = browserPilotCdpFrameSelector(options);
  const frame = browserPilotCdpResolveFrame(frames, selector);
  if (!frame) return browserPilotCdpError('FRAME_NOT_FOUND', 'requested frame not found', { frame: selector, frames });
  try {
    const world = await browserPilotPersistentCdpSend(tabId, 'Page.createIsolatedWorld', browserPilotCdpIsolatedWorldParams(frame, options), options || {});
    if (!world.ok) return world;
    const executionContextId = browserPilotCdpExecutionContextId(world);
    const evalResp = await browserPilotPersistentCdpSend(tabId, 'Runtime.evaluate', browserPilotCdpFrameEvaluationParams(expression, executionContextId, options), options || {});
    if (!evalResp.ok) return evalResp;
    return browserPilotCdpOk({ frame, executionContextId, result: cdpRecord(evalResp.data).result });
  } catch (e) {
    return browserPilotCdpError('FRAME_EVAL_FAILED', cdpErrorMessage(e), { frame, raw: browserPilotCdpRawError(e) });
  }
}

function browserPilotCdpNewDocumentScriptLimitError(tabId: number, name: string, source: string): BrowserPilotCdpResponse | undefined {
  if (source.length > BROWSER_PILOT_CDP_MAX_NEW_DOCUMENT_SCRIPT_CHARS) return browserPilotCdpError('SCRIPT_TOO_LARGE', 'new document script source is too large', { maxChars:BROWSER_PILOT_CDP_MAX_NEW_DOCUMENT_SCRIPT_CHARS, chars:source.length });
  if (browserPilotCdpKnownNewDocumentIdentifiers(tabId, name).length >= BROWSER_PILOT_CDP_MAX_NEW_DOCUMENT_SCRIPTS) return browserPilotCdpError('SCRIPT_LIMIT', 'too many new document scripts', { tabId:Number(tabId), cdpSessionName:name, max:BROWSER_PILOT_CDP_MAX_NEW_DOCUMENT_SCRIPTS });
  return undefined;
}

async function browserPilotPersistentCdpAddNewDocumentScript(tabId: number, source: unknown, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  if (!source) return browserPilotCdpError('NO_SOURCE', 'script source is required');
  const cdpOptions = { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' };
  const scriptSource = String(source);
  const limitError = browserPilotCdpNewDocumentScriptLimitError(tabId, cdpOptions.name, scriptSource);
  if (limitError) return limitError;
  const params = {
    source: scriptSource,
    includeCommandLineAPI: Boolean(options?.includeCommandLineAPI),
    runImmediately: Boolean(options?.runImmediately)
  };
  if (options?.worldName !== undefined) (params as JsonRecord).worldName = String(options.worldName || '');
  const resp = await browserPilotPersistentCdpSend(tabId, 'Page.addScriptToEvaluateOnNewDocument', params, cdpOptions);
  if (!resp.ok) return resp;
  const respData = cdpRecord(resp.data);
  const identifier = String(cdpRecord(respData.result).identifier);
  const sessionKey = respData.sessionKey;
  const rec = {
    key: browserPilotCdpNewDocumentScriptKey(tabId, cdpOptions.name, identifier),
    tabId:Number(tabId),
    identifier,
    sessionKey,
    cdpSessionName: cdpOptions.name,
    method: 'Page.addScriptToEvaluateOnNewDocument',
    createdAt: browserPilotCdpNow(),
    runImmediately: Boolean(options?.runImmediately),
    includeCommandLineAPI: Boolean(options?.includeCommandLineAPI),
    worldName: options?.worldName !== undefined ? String(options.worldName || '') : undefined
  };
  browserPilotPersistentCdpNewDocumentScripts.set(rec.key, rec);
  try { await browserPilotCdpPersistNewDocumentScript(rec); } catch (error) { console.warn('[BROWSER-PILOT-CDP] Failed to persist new-document script state', rec.key, error); }
  return browserPilotCdpOk({ identifier, sessionKey, cdpSessionName: cdpOptions.name, tabId:Number(tabId), method: rec.method, detached: cdpOptions.persistent !== true });
}

async function browserPilotPersistentCdpRemoveNewDocumentScript(tabId: number, identifier: unknown, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  if (!identifier) return browserPilotCdpError('NO_IDENTIFIER', 'script identifier is required');
  const cdpOptions = { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' };
  const id = String(identifier);
  const key = browserPilotCdpNewDocumentScriptKey(tabId, cdpOptions.name, id);
  const known = browserPilotPersistentCdpNewDocumentScripts.get(key);
  if (!known) {
    const lost = await browserPilotCdpLostNewDocumentScriptState(tabId, cdpOptions.name, id);
    if (lost) {
      return browserPilotCdpError(RECOVERY_CODES.LOST, 'new document script state was lost after service worker restart', { tabId:Number(tabId), identifier:id, cdpSessionName:String(cdpOptions.name), knownIdentifiers:browserPilotCdpKnownNewDocumentIdentifiers(tabId, String(cdpOptions.name)), historyLost:true, nextAction:'re-add the new-document script with frame.addNewDocumentScript' });
    }
    return browserPilotCdpError('SCRIPT_NOT_FOUND', 'new document script identifier is not registered', { tabId:Number(tabId), identifier:id, cdpSessionName:String(cdpOptions.name), knownIdentifiers:browserPilotCdpKnownNewDocumentIdentifiers(tabId, String(cdpOptions.name)) });
  }
  const method = 'Page.removeScriptToEvaluateOnNewDocument';
  const resp = await browserPilotPersistentCdpSend(tabId, method, { identifier:id }, cdpOptions);
  if (!resp.ok) {
    const errorRecord = cdpRecord(resp.error);
    const msg = String(errorRecord.message || resp.message || resp.error || '');
    // Chrome may drop a previously registered new-document identifier after a debugger
    // detach or navigation lifecycle reset.  Only known identifiers are treated as
    // idempotent cleanup; arbitrary unknown ids still return SCRIPT_NOT_FOUND above.
    if (/(no\s+script|script.*(not\s*found|does\s*not\s*exist|given\s+id)|identifier.*(not\s*found|does\s*not\s*exist))/i.test(msg)) {
      browserPilotPersistentCdpNewDocumentScripts.delete(key);
      try { await browserPilotCdpForgetNewDocumentScriptState(tabId, cdpOptions.name, id); } catch (error) { console.warn('[BROWSER-PILOT-CDP] Failed to forget already-removed new-document script state', key, error); }
      return browserPilotCdpOk({ identifier:id, removed:false, alreadyRemoved:true, sessionKey:known.sessionKey, cdpSessionName:known.cdpSessionName, tabId:Number(tabId), method, error:msg });
    }
    return resp;
  }
  browserPilotPersistentCdpNewDocumentScripts.delete(key);
  try { await browserPilotCdpForgetNewDocumentScriptState(tabId, cdpOptions.name, id); } catch (error) { console.warn('[BROWSER-PILOT-CDP] Failed to forget new-document script state after removal', key, error); }
  return browserPilotCdpOk({ identifier:id, removed:true, alreadyRemoved:false, sessionKey:cdpRecord(resp.data).sessionKey || known.sessionKey, cdpSessionName:known.cdpSessionName, tabId:Number(tabId), method });
}

async function browserPilotPersistentCdpReleaseIdle(maxIdleMs?: unknown): Promise<BrowserPilotCdpResponse> {
  const now = browserPilotCdpNow();
  const rawIdleMs = maxIdleMs === undefined || maxIdleMs === null ? 60000 : Number(maxIdleMs);
  const idleMs = Number.isFinite(rawIdleMs) ? rawIdleMs : 60000;
  const released: JsonRecord[] = [];
  const skipped: JsonRecord[] = [];
  for (const [key, rec] of Array.from(browserPilotPersistentCdpSessions.entries())) {
    if (!browserPilotPersistentCdpSessions.has(key)) continue;
    if ((rec.pending || 0) > 0 || (rec.lockedUntil || 0) > now) { skipped.push({ sessionKey: key, pending: rec.pending || 0, reason: 'idle busy' }); continue; }
    if (now - rec.lastUsed >= idleMs) {
      const res = await browserPilotPersistentCdpDetachEntry(key);
      released.push({ sessionKey: key, ok: res.ok, detached: cdpRecord(res.data).detached === true });
    }
  }
  return browserPilotCdpOk({ released, skipped, remaining: browserPilotPersistentCdpSessions.size });
}

async function browserPilotPersistentCdpTargets(tabId?: unknown): Promise<BrowserPilotCdpResponse> {
  try {
    const allTargets = typeof chrome.debugger.getTargets === 'function' ? await chrome.debugger.getTargets() : [];
    const scopedTargets = tabId === undefined || tabId === null || tabId === ''
      ? allTargets
      : allTargets.filter((target: JsonRecord) => Number(target.tabId) === Number(tabId));
    return browserPilotCdpOk({ targets: allTargets, scopedTargets, count: allTargets.length, scopedCount: scopedTargets.length, tabId: tabId === undefined ? undefined : Number(tabId) });
  } catch (e) {
    return browserPilotCdpError('SEND_FAILED', cdpErrorMessage(e), { action: 'targets', raw: browserPilotCdpRawError(e) });
  }
}

// Release every persistent CDP session bound to a tab. Invoked from the shared
// tab-teardown path (chrome.tabs.onRemoved / navigation churn) so attachments do
// not leak and fill BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS over a long session.
// Synchronous by contract: browserPilotPersistentCdpDetachEntry removes each entry from the
// map before its first await, so the map is drained for this tab by the time this
// returns; the physical chrome.debugger.detach completes best-effort afterwards.
function cleanupPersistentCdpForTab(tabId: number, _reason?: string): JsonRecord {
  const target = Number(tabId);
  browserPilotPersistentCdpTabAttaches.delete(target);
  const removed: string[] = [];
  for (const [key, rec] of Array.from(browserPilotPersistentCdpSessions.entries())) {
    if (!rec || Number(rec.tabId) !== target) continue;
    removed.push(key);
    void browserPilotPersistentCdpDetachEntry(key).catch(() => browserPilotPersistentCdpSessions.delete(key));
  }
  for (const [key, rec] of Array.from(browserPilotPersistentCdpChildSessions.entries())) {
    if (rec && Number(rec.tabId) === target) browserPilotPersistentCdpChildSessions.delete(key);
  }
  for (const [key, rec] of Array.from(browserPilotPersistentCdpNewDocumentScripts.entries())) {
    if (rec && Number(rec.tabId) === target) {
      browserPilotPersistentCdpNewDocumentScripts.delete(key);
      void browserPilotCdpForgetNewDocumentScriptState(rec.tabId, rec.cdpSessionName, rec.identifier).catch(() => {});
    }
  }
  return { tabId: target, released: removed.length, sessionKeys: removed };
}

type BrowserPilotCdpActionHandler = (tabId: number, msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender) => Promise<BrowserPilotCdpResponse>;

const browserPilotCdpActionHandlers: Record<string, BrowserPilotCdpActionHandler> = {
  attach: (tabId, msg) => browserPilotPersistentCdpAttach(tabId, msg as BrowserPilotCdpOptions),
  attachTarget: (tabId, msg) => browserPilotPersistentCdpAttachTarget(tabId, msg.targetId, msg as BrowserPilotCdpOptions),
  send: (tabId, msg) => browserPilotPersistentCdpSend(tabId, String(msg.cdpMethod || ''), cdpRecord(msg.params), msg as BrowserPilotCdpOptions),
  detachTarget: (tabId, msg) => browserPilotPersistentCdpDetachTarget(tabId, msg.targetId ?? msg.sessionId, msg as BrowserPilotCdpOptions),
  detach: (tabId, msg) => browserPilotPersistentCdpDetach(tabId, msg as BrowserPilotCdpOptions),
  targets: (_tabId, msg, sender) => browserPilotPersistentCdpTargets(msg.tabId || sender?.tab?.id),
  frameTree: (tabId, msg) => browserPilotPersistentCdpFrameTree(tabId, msg as BrowserPilotCdpOptions),
  evaluateInFrame: (tabId, msg) => browserPilotPersistentCdpEvaluateInFrame(tabId, msg.expression, msg as BrowserPilotCdpOptions),
  addNewDocumentScript: (tabId, msg) => browserPilotPersistentCdpAddNewDocumentScript(tabId, msg.source, msg as BrowserPilotCdpOptions),
  removeNewDocumentScript: (tabId, msg) => browserPilotPersistentCdpRemoveNewDocumentScript(tabId, msg.identifier, msg as BrowserPilotCdpOptions),
  releaseIdle: (_tabId, msg) => browserPilotPersistentCdpReleaseIdle(msg.maxIdleMs),
};

async function handlePersistentCdpCommand(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotCdpResponse> {
  const tabId = Number(msg.tabId || sender?.tab?.id || 0);
  const action = msg.action || msg.method;
  if (!tabId && action !== 'releaseIdle') return browserPilotCdpError('NO_TAB_ID', 'tabId is required');
  const handler = typeof action === 'string' ? browserPilotCdpActionHandlers[action] : undefined;
  if (handler) return handler(tabId, msg, sender);
  return browserPilotCdpError('UNKNOWN_ACTION', 'unknown persistent CDP action: ' + action, { action });
}

chrome.debugger.onDetach.addListener((source, _reason) => {
  if (!source || !source.tabId) return;
  browserPilotPersistentCdpTabAttaches.delete(Number(source.tabId));
  for (const [key, rec] of Array.from(browserPilotPersistentCdpSessions.entries())) {
    if (rec.tabId === source.tabId) browserPilotPersistentCdpSessions.delete(key);
  }
  for (const [key, rec] of Array.from(browserPilotPersistentCdpChildSessions.entries())) {
    if (rec.tabId === source.tabId) browserPilotPersistentCdpChildSessions.delete(key);
  }
  for (const [key, rec] of Array.from(browserPilotPersistentCdpNewDocumentScripts.entries())) {
    if (rec.tabId === source.tabId) {
      browserPilotPersistentCdpNewDocumentScripts.delete(key);
      void browserPilotCdpForgetNewDocumentScriptState(rec.tabId, rec.cdpSessionName, rec.identifier).catch(() => {});
    }
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

const browserPilotPersistentCdpBridge = {
  version: BROWSER_PILOT_PERSISTENT_CDP_VERSION,
  sessions: browserPilotPersistentCdpSessions,
  childSessions: browserPilotPersistentCdpChildSessions,
  newDocumentScripts: browserPilotPersistentCdpNewDocumentScripts,
  attach: browserPilotPersistentCdpAttach,
  attachTarget: browserPilotPersistentCdpAttachTarget,
  send: browserPilotPersistentCdpSend,
  detachTarget: browserPilotPersistentCdpDetachTarget,
  detach: browserPilotPersistentCdpDetach,
  frameTree: browserPilotPersistentCdpFrameTree,
  evaluateInFrame: browserPilotPersistentCdpEvaluateInFrame,
  addNewDocumentScript: browserPilotPersistentCdpAddNewDocumentScript,
  removeNewDocumentScript: browserPilotPersistentCdpRemoveNewDocumentScript,
  releaseIdle: browserPilotPersistentCdpReleaseIdle,
  targets: browserPilotPersistentCdpTargets,
  hasSessionForTab: browserPilotPersistentCdpHasSessionForTab,
  handleCommand: handlePersistentCdpCommand
};
const cdpGlobal = self as typeof self & { BrowserPilotPersistentCdp?: unknown; browserPilotPersistentCdpBridge?: unknown };
cdpGlobal.BrowserPilotPersistentCdp = browserPilotPersistentCdpBridge;
cdpGlobal.browserPilotPersistentCdpBridge = browserPilotPersistentCdpBridge;
export { browserPilotPersistentCdpSend, cleanupPersistentCdpForTab, handlePersistentCdpCommand, browserPilotPersistentCdpBridge };
