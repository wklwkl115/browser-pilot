import { chromeApi as chrome } from "./runtimeEnv";
import { RECOVERY_CODES, forget as forgetState, get as getState, persist as persistState, registerRecovery, recover as recoverState } from "./state_store";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotBridgeSender } from "./types";

type BrowserPilotCdpResponse = BrowserPilotBridgeResponse<JsonRecord>;
type BrowserPilotCdpSession = { tabId: number; name: string; key: string; attachedAt: number; lastUsed: number; commands: number; pending: number; lockedUntil: number; compiledScripts: Map<string, string> };
type BrowserPilotCdpChildSession = { tabId: number; parentKey: string; key: string; targetId: string; sessionId: string; name: string; attachedAt: number; lastUsed: number; commands: number; pending: number };
type BrowserPilotCdpCommandTarget = { debuggee: { tabId: number; sessionId?: string }; route: JsonRecord; child?: BrowserPilotCdpChildSession };
type BrowserPilotCdpNewDocumentScript = { key: string; tabId: number; identifier: string; sessionKey?: unknown; cdpSessionName: string; method: string; createdAt: number; runImmediately: boolean; includeCommandLineAPI: boolean; worldName?: string };
type BrowserPilotCdpFrame = { id: string; frameId: string; parentId: string | null; url: string; name: string; mimeType: string; securityOrigin: string; childFrames?: BrowserPilotCdpFrame[]; children?: BrowserPilotCdpFrame[] };
type BrowserPilotCdpFrameTreeNode = JsonRecord & { frame?: JsonRecord; childFrames?: BrowserPilotCdpFrameTreeNode[] };
type BrowserPilotCdpOptions = BrowserPilotBridgeCommand & { name?: string; protocolVersion?: string; bringToFront?: boolean; persistent?: boolean; detachOnError?: boolean; frame?: unknown; frameId?: unknown; targetId?: unknown; sessionId?: unknown; worldName?: string; grantUniversalAccess?: boolean; awaitPromise?: boolean; returnByValue?: boolean; userGesture?: boolean; includeCommandLineAPI?: boolean; runImmediately?: boolean; precompile?: boolean; scriptHash?: string; __browserPilotRetryAfterNotAttached?: boolean };

function cdpRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function cdpErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function cdpRawError(error: unknown): JsonRecord { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }

// cdp.js — Browser Pilot persistent CDP / iframe helpers.
// Flat Target sessions are optional and explicit: the default route remains tab-scoped, while
// callers with a targetId can attach that child target and send through chrome.debugger sessionId.

const BROWSER_PILOT_PERSISTENT_CDP_VERSION = 'p4.0.0';
const BROWSER_PILOT_PERSISTENT_CDP_DEFAULT_TIMEOUT_MS = 15000;
const BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS = 16;

const browserPilotPersistentCdpSessions = new Map<string, BrowserPilotCdpSession>();
const browserPilotPersistentCdpChildSessions = new Map<string, BrowserPilotCdpChildSession>();
const browserPilotPersistentCdpNewDocumentScripts = new Map<string, BrowserPilotCdpNewDocumentScript>();

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

async function browserPilotPersistentCdpAttach(tabId: number, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  if (!tabId) return browserPilotCdpError('NO_TAB_ID', 'tabId is required');
  const name = options?.name || 'default';
  const key = browserPilotCdpSessionKey(tabId, name);
  if (browserPilotPersistentCdpSessions.has(key)) {
    const old = browserPilotPersistentCdpSessions.get(key)!;
    old.lastUsed = browserPilotCdpNow();
    return browserPilotCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: old.attachedAt });
  }
  if (browserPilotPersistentCdpSessions.size >= BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS) {
    // Long-running sessions accumulate persistent CDP attachments faster than
    // tab-close cleanup releases them. Before hard-failing, opportunistically
    // evict idle (non-pending, unlocked) sessions and retry the cap check once.
    try { await browserPilotPersistentCdpReleaseIdle(0); } catch (error) { console.warn('[BROWSER-PILOT-CDP] idle release before attach failed', error); }
    if (browserPilotPersistentCdpSessions.size >= BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS) {
      return browserPilotCdpError('SESSION_LIMIT', 'too many persistent CDP sessions', { max: BROWSER_PILOT_PERSISTENT_CDP_MAX_SESSIONS });
    }
  }
  try {
    if (options?.bringToFront) await chrome.tabs.update(tabId, { active: true });
    await chrome.debugger.attach({ tabId }, options?.protocolVersion || '1.3');
    const rec = { tabId, name, key, attachedAt: browserPilotCdpNow(), lastUsed: browserPilotCdpNow(), commands: 0, pending: 0, lockedUntil: 0, compiledScripts: new Map<string, string>() };
    browserPilotPersistentCdpSessions.set(key, rec);
    // Enable Page/Runtime domains immediately. Without this, Chrome may return only
    // the main frame from Page.getFrameTree until domains are explicitly enabled,
    // which breaks iframe-targeted evaluation in fresh persistent sessions.
    try { await browserPilotPersistentCdpSend(tabId, 'Page.enable', {}, { name }); } catch (error) { console.warn('[BROWSER-PILOT-CDP] Failed to enable Page domain after attach', key, error); }
    try { await browserPilotPersistentCdpSend(tabId, 'Runtime.enable', {}, { name }); } catch (error) { console.warn('[BROWSER-PILOT-CDP] Failed to enable Runtime domain after attach', key, error); }
    return browserPilotCdpOk({ sessionKey: key, tabId, name, reused: false, attachedAt: rec.attachedAt });
  } catch (e) {
    const msg = cdpErrorMessage(e);
    if (/Another debugger is already attached|Cannot attach/i.test(String(msg || ''))) {
      const existingKey = browserPilotCdpSessionKey(tabId, 'default');
      const existing = browserPilotPersistentCdpSessions.get(existingKey);
      if (existing) {
        existing.lastUsed = browserPilotCdpNow();
        if (name !== 'default') browserPilotPersistentCdpSessions.set(key, existing);
        return browserPilotCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: existing.attachedAt, alreadyAttached: true });
      }
      for (const [, rec] of browserPilotPersistentCdpSessions.entries()) {
        if (rec && rec.tabId === tabId) {
          rec.lastUsed = browserPilotCdpNow();
          browserPilotPersistentCdpSessions.set(key, rec);
          return browserPilotCdpOk({ sessionKey: key, tabId, name, reused: true, attachedAt: rec.attachedAt, alreadyAttached: true });
        }
      }
    }
    return browserPilotCdpError('ATTACH_FAILED', msg, { tabId, name, raw: browserPilotCdpRawError(e) });
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

async function browserPilotPersistentCdpSend(tabId: number, method: string, params: JsonRecord = {}, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  if (!method) return browserPilotCdpError('NO_METHOD', 'CDP method is required');
  const name = options?.name || 'default';
  const key = browserPilotCdpSessionKey(tabId, name);
  const retrying = Boolean(options?.__browserPilotRetryAfterNotAttached);
  let rec = browserPilotPersistentCdpSessions.get(key);
  let temporary = false;
  if (!rec) {
    const attached = await browserPilotPersistentCdpAttach(tabId, { name, protocolVersion: options?.protocolVersion, bringToFront: options?.bringToFront });
    if (!attached.ok) return attached;
    rec = browserPilotPersistentCdpSessions.get(key);
    temporary = options?.persistent === false;
  }
  if (!rec) return browserPilotCdpError('ATTACH_FAILED', 'CDP session missing after attach', { tabId, name });
  rec.pending = (rec.pending || 0) + 1;
  rec.lockedUntil = Math.max(rec.lockedUntil || 0, browserPilotCdpNow() + Number(options?.timeoutMs || 30000));
  try {
    const routeResp = await browserPilotPersistentCdpCommandTarget(tabId, String(name), rec, options);
    if (!routeResp.ok) return routeResp as BrowserPilotCdpResponse;
    const routeData = routeResp.data!;
    const debuggee = routeData.debuggee;
    if (routeData.child) routeData.child.pending = (routeData.child.pending || 0) + 1;
    const expression = typeof params.expression === 'string' ? params.expression : '';
    let data: unknown;
    let precompiled = false;
    if (options?.precompile === true && method === 'Runtime.evaluate' && expression) {
      const cacheKey = browserPilotCdpScriptCacheKey(expression, params, options) + ':' + (debuggee.sessionId || 'root');
      let scriptId = rec.compiledScripts.get(cacheKey);
      if (!scriptId) {
        try {
          const compileParams: JsonRecord = {
            expression,
            sourceURL: 'browser-pilot://' + encodeURIComponent(String(name || 'script')) + '/' + cacheKey + '.js',
            persistScript: true,
          };
          if (params.contextId !== undefined) compileParams.executionContextId = params.contextId;
          const compiled = cdpRecord(await browserPilotCdpWithTimeout(chrome.debugger.sendCommand(debuggee, 'Runtime.compileScript', compileParams), options?.timeoutMs, 'Runtime.compileScript'));
          if (typeof compiled.scriptId === 'string') {
            scriptId = compiled.scriptId;
            rec.compiledScripts.set(cacheKey, scriptId);
          }
        } catch (compileError) {
          console.debug('[BROWSER-PILOT-CDP] Runtime.compileScript fallback to evaluate', key, cdpErrorMessage(compileError));
        }
      }
      if (scriptId) {
        const runParams: JsonRecord = {
          scriptId,
          awaitPromise: params.awaitPromise !== false,
          returnByValue: params.returnByValue !== false,
        };
        if (params.objectGroup !== undefined) runParams.objectGroup = params.objectGroup;
        if (params.silent !== undefined) runParams.silent = params.silent;
        if (params.includeCommandLineAPI !== undefined) runParams.includeCommandLineAPI = params.includeCommandLineAPI;
        if (params.userGesture !== undefined) runParams.userGesture = params.userGesture;
        try {
          data = await browserPilotCdpWithTimeout(chrome.debugger.sendCommand(debuggee, 'Runtime.runScript', runParams), options?.timeoutMs, 'Runtime.runScript');
          precompiled = true;
        } catch (runError) {
          const runMessage = cdpErrorMessage(runError);
          if (/No script with given id/i.test(runMessage)) {
            rec.compiledScripts.delete(cacheKey);
            console.debug('[BROWSER-PILOT-CDP] Runtime.runScript script cache stale; fallback to evaluate', key, runMessage);
          } else {
            throw runError;
          }
        }
      }
    }
    if (data === undefined) {
      data = await browserPilotCdpWithTimeout(
        chrome.debugger.sendCommand(debuggee, method, params || {}),
        options?.timeoutMs,
        method
      );
    }
    rec.commands += 1; rec.lastUsed = browserPilotCdpNow();
    if (routeData.child) { routeData.child.commands += 1; routeData.child.lastUsed = browserPilotCdpNow(); }
    return browserPilotCdpOk(browserPilotCdpAugmentDebuggerEvidence(method, { result: data, sessionKey: key, method, cdpRoute: routeData.route, ...(precompiled ? { precompiled: true } : {}) }));
  } catch (e) {
    const msg = cdpErrorMessage(e);
    if (!retrying && /Debugger is not attached|Cannot access a chrome:\/\/ URL|No tab with id/i.test(String(msg || ''))) {
      for (const [staleKey, staleRec] of Array.from(browserPilotPersistentCdpSessions.entries())) {
        if (staleRec && Number(staleRec.tabId) === Number(rec.tabId)) browserPilotPersistentCdpSessions.delete(staleKey);
      }
      return await browserPilotPersistentCdpSend(tabId, method, params, { ...(options || {}), __browserPilotRetryAfterNotAttached: true });
    }
    if (options?.detachOnError) await browserPilotPersistentCdpDetach(tabId, { name });
    return browserPilotCdpError('SEND_FAILED', msg || String(e), { sessionKey: key, method, raw: browserPilotCdpRawError(e) });
  } finally {
    rec.pending = Math.max(0, (rec.pending || 1) - 1);
    const targetId = browserPilotCdpCleanTargetId(options?.targetId);
    if (targetId) {
      const child = browserPilotPersistentCdpChildSessions.get(browserPilotCdpTargetSessionKey(tabId, name, targetId));
      if (child) child.pending = Math.max(0, (child.pending || 1) - 1);
    }
    rec.lockedUntil = 0;
    rec.lastUsed = browserPilotCdpNow();
    if (temporary) await browserPilotPersistentCdpDetach(tabId, { name });
  }
}

async function browserPilotPersistentCdpFrameTree(tabId: number, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  const resp = await browserPilotPersistentCdpSend(tabId, 'Page.getFrameTree', {}, options || {});
  if (!resp.ok) return resp;
  const rawTree = cdpRecord(cdpRecord(cdpRecord(resp.data).result).frameTree) as BrowserPilotCdpFrameTreeNode;
  return browserPilotCdpOk({ frameTree: browserPilotCdpNormalizeFrameTreeNode(rawTree), frames: browserPilotCdpFlattenFrameTree(rawTree, []) });
}

async function browserPilotPersistentCdpEvaluateInFrame(tabId: number, expression: unknown, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  const frameTree = await browserPilotPersistentCdpFrameTree(tabId, options || {});
  if (!frameTree.ok) return frameTree;
  const frameTreeData = cdpRecord(frameTree.data);
  const frames = Array.isArray(frameTreeData.frames) ? frameTreeData.frames as BrowserPilotCdpFrame[] : [];
  const frame = browserPilotCdpResolveFrame(frames, options?.frame || options?.frameId || 'main');
  if (!frame) return browserPilotCdpError('FRAME_NOT_FOUND', 'requested frame not found', { frame: options?.frame || options?.frameId, frames });
  try {
    const worldName = options?.worldName || ('browser_pilot_' + Math.random().toString(36).slice(2));
    const world = await browserPilotPersistentCdpSend(tabId, 'Page.createIsolatedWorld', {
      frameId: frame.frameId,
      worldName,
      grantUniversalAccess: Boolean(options?.grantUniversalAccess)
    }, options || {});
    if (!world.ok) return world;
    const evalResp = await browserPilotPersistentCdpSend(tabId, 'Runtime.evaluate', {
      expression: String(expression || ''),
      contextId: cdpRecord(cdpRecord(world.data).result).executionContextId,
      awaitPromise: options?.awaitPromise !== false,
      returnByValue: options?.returnByValue !== false,
      userGesture: Boolean(options?.userGesture)
    }, options || {});
    if (!evalResp.ok) return evalResp;
    return browserPilotCdpOk({ frame, executionContextId: cdpRecord(cdpRecord(world.data).result).executionContextId, result: cdpRecord(evalResp.data).result });
  } catch (e) {
    return browserPilotCdpError('FRAME_EVAL_FAILED', cdpErrorMessage(e), { frame, raw: browserPilotCdpRawError(e) });
  }
}

async function browserPilotPersistentCdpAddNewDocumentScript(tabId: number, source: unknown, options: BrowserPilotCdpOptions = {}): Promise<BrowserPilotCdpResponse> {
  if (!source) return browserPilotCdpError('NO_SOURCE', 'script source is required');
  const cdpOptions = { ...(options || {}), persistent: options?.persistent === true, name: options?.name || 'new_document' };
  const params = {
    source: String(source),
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
    if (rec && Number(rec.tabId) === target) browserPilotPersistentCdpNewDocumentScripts.delete(key);
  }
  return { tabId: target, released: removed.length, sessionKeys: removed };
}

async function handlePersistentCdpCommand(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotCdpResponse> {
  const tabId = Number(msg.tabId || sender?.tab?.id || 0);
  const action = msg.action || msg.method;
  if (!tabId && action !== 'releaseIdle') return browserPilotCdpError('NO_TAB_ID', 'tabId is required');
  if (action === 'attach') return await browserPilotPersistentCdpAttach(tabId, msg as BrowserPilotCdpOptions);
  if (action === 'attachTarget') return await browserPilotPersistentCdpAttachTarget(tabId, msg.targetId, msg as BrowserPilotCdpOptions);
  if (action === 'send') return await browserPilotPersistentCdpSend(tabId, String(msg.cdpMethod || ''), cdpRecord(msg.params), msg as BrowserPilotCdpOptions);
  if (action === 'detachTarget') return await browserPilotPersistentCdpDetachTarget(tabId, msg.targetId ?? msg.sessionId, msg as BrowserPilotCdpOptions);
  if (action === 'detach') return await browserPilotPersistentCdpDetach(tabId, msg as BrowserPilotCdpOptions);
  if (action === 'targets') return await browserPilotPersistentCdpTargets(msg.tabId || sender?.tab?.id);
  if (action === 'frameTree') return await browserPilotPersistentCdpFrameTree(tabId, msg as BrowserPilotCdpOptions);
  if (action === 'evaluateInFrame') return await browserPilotPersistentCdpEvaluateInFrame(tabId, msg.expression, msg as BrowserPilotCdpOptions);
  if (action === 'addNewDocumentScript') return await browserPilotPersistentCdpAddNewDocumentScript(tabId, msg.source, msg as BrowserPilotCdpOptions);
  if (action === 'removeNewDocumentScript') return await browserPilotPersistentCdpRemoveNewDocumentScript(tabId, msg.identifier, msg as BrowserPilotCdpOptions);
  if (action === 'releaseIdle') return await browserPilotPersistentCdpReleaseIdle(msg.maxIdleMs);
  return browserPilotCdpError('UNKNOWN_ACTION', 'unknown persistent CDP action: ' + action, { action });
}

chrome.debugger.onDetach.addListener((source, _reason) => {
  if (!source || !source.tabId) return;
  for (const [key, rec] of Array.from(browserPilotPersistentCdpSessions.entries())) {
    if (rec.tabId === source.tabId) browserPilotPersistentCdpSessions.delete(key);
  }
  for (const [key, rec] of Array.from(browserPilotPersistentCdpChildSessions.entries())) {
    if (rec.tabId === source.tabId) browserPilotPersistentCdpChildSessions.delete(key);
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
// ESM module metadata
export const __browserPilotBridgeModule_cdp = { name: "cdp", symbols: { browserPilotPersistentCdpSend, cleanupPersistentCdpForTab, handlePersistentCdpCommand, browserPilotPersistentCdpBridge } };
