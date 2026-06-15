import { BrowserPilotNativeProtocol } from "./protocol";
import { chromeApi as chrome } from "./runtimeEnv";
import { cancelWaitsForTab, cleanupTabWaits } from "./wait_coordinator";
import { navigateAndWait, navigateBrowserPilot, waitForLoadState, waitForNavigation } from "./wait_navigation";
import { waitForNetworkIdle } from "./wait_network_idle";
import { waitForSelector } from "./wait_selector";
import { cancelWait, cleanupBrowserPilotPageListenersForTab, diagnoseBrowserPilot, waitForAll, waitForAny } from "./wait";
import { cleanupNetworkRecorderTab, handleNetworkRecorderCommand } from "./network";
import { cleanupInterceptSessionTab, handleBrowserPilotInterceptCommand } from "./intercept";
import { ensureBrowserPilotDispatcher, handleBrowserPilotHookCommand } from "./hook";
import { handleBrowserPilotEvidenceCommand } from "./evidence";
import { handleBrowserPilotFrameCommand } from "./frame";
import { handleBrowserPilotLayerCommand } from "./layer";
import { handleBrowserPilotTransferCommand } from "./transfer";
import { handleBrowserPilotHtml } from "./html";
import { handleBrowserPilotInputCommand } from "./input";
import { cleanupWsSessionsForTab, handleBrowserPilotWsCommand } from "./ws";
import { cleanupPersistentCdpForTab } from "./cdp";
import { captureScreenshotWithRetry } from "./screenshot";
import { browserPilotBridgeInfo } from "./bridge_info";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotBridgeSender, BrowserPilotNativeProtocolRuntime, BrowserPilotPersistentCdpBridge } from "./types";

// runtime.js - Browser Pilot command runtime (wait/network/hook/frame/html/screenshot).

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeErrorPreview(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

function runtimeRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

const BROWSER_PILOT_HOOK_DISPATCHER_FILE = 'dist/hook_dispatcher.js';
const BROWSER_PILOT_ERROR_CODES = {
  NO_SESSION: 'NO_SESSION', SESSION_NOT_FOUND: 'SESSION_NOT_FOUND', INVALID_SESSION: 'INVALID_SESSION', ALREADY_INSTALLED: 'ALREADY_INSTALLED', NOT_INSTALLED: 'NOT_INSTALLED',
  INVALID_RULE: 'INVALID_RULE', UNSUPPORTED_TARGET: 'UNSUPPORTED_TARGET', INJECTION_FAILED: 'INJECTION_FAILED',
  SAFETY_BLOCKED: 'SAFETY_BLOCKED', TIMEOUT: 'TIMEOUT', NAVIGATION_TIMEOUT: 'NAVIGATION_TIMEOUT', SELECTOR_TIMEOUT: 'SELECTOR_TIMEOUT', SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND', INVALID_SELECTOR: 'INVALID_SELECTOR', NETWORK_IDLE_TIMEOUT: 'NETWORK_IDLE_TIMEOUT', NETWORK_RECORDER_NOT_STARTED: 'NETWORK_RECORDER_NOT_STARTED', NETWORK_RECORDER_TIMEOUT: 'NETWORK_RECORDER_TIMEOUT', REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND', BODY_UNAVAILABLE: 'BODY_UNAVAILABLE', FRAME_DETACHED: 'FRAME_DETACHED', CROSS_ORIGIN_IFRAME: 'CROSS_ORIGIN_IFRAME', TAB_NOT_FOUND: 'TAB_NOT_FOUND', TAB_CRASHED: 'TAB_CRASHED', BACKGROUND_THROTTLED: 'BACKGROUND_THROTTLED', EVENT_SUBSCRIPTION_FAILED: 'EVENT_SUBSCRIPTION_FAILED', CANCELLED: 'CANCELLED', BUFFER_OVERFLOW: 'BUFFER_OVERFLOW', AMBIGUOUS_DOWNLOAD: 'AMBIGUOUS_DOWNLOAD', INTERNAL_ERROR: 'INTERNAL_ERROR'
};
const BROWSER_PILOT_PROTOCOL = (typeof BrowserPilotNativeProtocol !== 'undefined' ? BrowserPilotNativeProtocol : (self as typeof self & { BrowserPilotNativeProtocol?: unknown }).BrowserPilotNativeProtocol) as BrowserPilotNativeProtocolRuntime;
if (!BROWSER_PILOT_PROTOCOL || !BROWSER_PILOT_PROTOCOL.schema || !BROWSER_PILOT_PROTOCOL.nativeCommandMap) throw new Error('Browser Pilot protocol schema is not loaded');
const BROWSER_PILOT_ALIASES = BROWSER_PILOT_PROTOCOL.aliases || {};
type BrowserPilotSessionRecord = JsonRecord & {
  session_id?: string;
  targets?: unknown;
  options?: unknown;
  buffer_size?: number;
  install_fingerprint?: string;
  install_args?: JsonRecord;
  state?: string;
  installed_at?: string;
};
type BrowserPilotQueueRecord = { tail: Promise<unknown>; depth: number; pending: boolean; last_cmd: string | null };
const browserPilotSessions = new Map<number, BrowserPilotSessionRecord>();
const browserPilotTabQueues = new Map<number, BrowserPilotQueueRecord>();
const BROWSER_PILOT_QUEUE_MAX_DEPTH = 64;
const BROWSER_PILOT_RUNTIME_STATE_KEY = 'browserPilotRuntimeState';

async function loadBrowserPilotRuntimeStateMap(): Promise<Record<string, JsonRecord>> {
  const session = chrome.storage?.session;
  if (!session?.get) return {};
  let raw: unknown;
  try {
    raw = await session.get(BROWSER_PILOT_RUNTIME_STATE_KEY);
  } catch (error) {
    console.warn('[BROWSER-PILOT-STATE] Failed to load runtime state map', runtimeErrorPreview(error));
    return {};
  }
  const value = raw && typeof raw === 'object' ? (raw as JsonRecord)[BROWSER_PILOT_RUNTIME_STATE_KEY] : undefined;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonRecord> : {};
}
function browserPilotRuntimeStateKey(kind: string, tabId: number, sessionId: string): string { return `${kind}:${Number(tabId)}:${String(sessionId || 'default')}`; }
async function saveBrowserPilotRuntimeStateMap(map: Record<string, JsonRecord>): Promise<void> {
  const session = chrome.storage?.session;
  if (!session?.set) return;
  try {
    await session.set({ [BROWSER_PILOT_RUNTIME_STATE_KEY]: map });
  } catch (error) {
    console.warn('[BROWSER-PILOT-STATE] Failed to save runtime state map', runtimeErrorPreview(error));
  }
}
function currentBrowserPilotWorkerBootId(): string {
  const bridge = runtimeRecord(browserPilotBridgeInfo());
  return typeof bridge.workerBootId === 'string' && bridge.workerBootId ? bridge.workerBootId : 'unknown';
}
async function rememberRuntimeSession(kind: string, tabId: number, sessionId: string, details: JsonRecord = {}): Promise<void> {
  const map = await loadBrowserPilotRuntimeStateMap();
  map[browserPilotRuntimeStateKey(kind, tabId, sessionId)] = { kind, tabId: Number(tabId), sessionId: String(sessionId || 'default'), active: true, workerBootId: currentBrowserPilotWorkerBootId(), updatedAt: Date.now(), details };
  await saveBrowserPilotRuntimeStateMap(map);
}
async function forgetRuntimeSession(kind: string, tabId: number, sessionId: string): Promise<void> {
  const map = await loadBrowserPilotRuntimeStateMap();
  delete map[browserPilotRuntimeStateKey(kind, tabId, sessionId)];
  await saveBrowserPilotRuntimeStateMap(map);
}
async function findLostRuntimeSession(kind: string, tabId: number, sessionId: string): Promise<JsonRecord | undefined> {
  const record = (await loadBrowserPilotRuntimeStateMap())[browserPilotRuntimeStateKey(kind, tabId, sessionId)];
  return record && record.active === true && record.workerBootId !== currentBrowserPilotWorkerBootId() ? record : undefined;
}
function summarizeLostRuntimeSession(record: JsonRecord | undefined): JsonRecord | undefined {
  if (!record) return undefined;
  return { stateLost: true, previousWorkerBootId: record.workerBootId, updatedAt: record.updatedAt, kind: record.kind, tabId: record.tabId, sessionId: record.sessionId, details: runtimeRecord(record.details) };
}

function getBrowserPilotQueueStats(tabId: unknown) {
  const q = browserPilotTabQueues.get(Number(tabId));
  return q ? { pending: q.pending, depth: q.depth, last_cmd: q.last_cmd || null } : { pending: false, depth: 0, last_cmd: null };
}
function enqueueBrowserPilotCommand(tabId: unknown, cmd: string, task: () => Promise<BrowserPilotBridgeResponse> | BrowserPilotBridgeResponse): Promise<BrowserPilotBridgeResponse> {
  const key = Number(tabId);
  const current = browserPilotTabQueues.get(key) || { tail: Promise.resolve(), depth: 0, pending: false, last_cmd: null } satisfies BrowserPilotQueueRecord;
  if (current.depth >= BROWSER_PILOT_QUEUE_MAX_DEPTH) return Promise.resolve(browserPilotError(BROWSER_PILOT_ERROR_CODES.TIMEOUT, 'Browser Pilot command queue is full', { tabId: key, cmd, depth: current.depth, max_depth: BROWSER_PILOT_QUEUE_MAX_DEPTH }));
  current.depth += 1;
  current.pending = true;
  current.last_cmd = cmd;
  const run = current.tail.catch(() => {}).then(async () => {
    try { return await task(); }
    finally {
      const latest = browserPilotTabQueues.get(key);
      if (latest) {
        latest.depth = Math.max(0, latest.depth - 1);
        latest.pending = latest.depth > 0;
        if (latest.depth === 0) latest.last_cmd = null;
      }
    }
  });
  current.tail = run.catch(() => {});
  browserPilotTabQueues.set(key, current);
  return run;
}
function cleanupBrowserPilotTab(tabId: number, reason?: string) {
  const key = Number(tabId);
  const cleanupReason = reason || 'tab_cleanup';
  try {
    const pageCleanup = cleanupBrowserPilotPageListenersForTab(tabId, cleanupReason);
    if ((pageCleanup as Promise<unknown> | undefined)?.catch) {
      void (pageCleanup as Promise<unknown>).catch((e: unknown) => console.warn('[BROWSER-PILOT] page listener cleanup failed', key, cleanupReason, runtimeErrorPreview(e)));
    }
  } catch (e) { console.warn('[BROWSER-PILOT] page listener cleanup failed', key, cleanupReason, runtimeErrorPreview(e)); }
  browserPilotSessions.delete(key);
  browserPilotTabQueues.delete(key);
  try { cleanupNetworkRecorderTab(tabId, cleanupReason); } catch (e) { console.warn('[BROWSER-PILOT-NET] recorder cleanup failed', key, runtimeErrorPreview(e)); }
  try { cleanupInterceptSessionTab(tabId, cleanupReason); } catch (e) { console.warn('[BROWSER-PILOT-INTERCEPT] session cleanup failed', key, runtimeErrorPreview(e)); }
  try { cleanupWsSessionsForTab(tabId, cleanupReason); } catch (e) { console.warn('[BROWSER-PILOT-WS] session cleanup failed', key, runtimeErrorPreview(e)); }
  try { cleanupPersistentCdpForTab(tabId, cleanupReason); } catch (e) { console.warn('[BROWSER-PILOT-CDP] persistent session cleanup failed', key, runtimeErrorPreview(e)); }
  // Preserve the public cancellation path for tab teardown so queued callers,
  // diagnostics and static contract tests all see the same lifecycle entrypoint.
  // Literal contract: cancelWaitsForTab(tabId, 'tab_cleanup')
  if (cleanupReason === 'tab_cleanup') cancelWaitsForTab(tabId, 'tab_cleanup');
  else cleanupTabWaits(tabId, cleanupReason, { includeCdp: true, action: 'tab_cleanup' });
}
function canonicalBrowserPilotCommand(cmd: unknown): string { const key = String(cmd || ''); return BROWSER_PILOT_PROTOCOL.canonicalCommand ? BROWSER_PILOT_PROTOCOL.canonicalCommand(key) : (BROWSER_PILOT_ALIASES[key] || key); }
const BROWSER_PILOT_NATIVE_COMMANDS = BROWSER_PILOT_PROTOCOL.nativeCommandMap;
function isBrowserPilotNativeCommand(cmd: unknown): boolean { return typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(BROWSER_PILOT_NATIVE_COMMANDS, cmd); }
function nativeToBrowserPilotMessage(msg: BrowserPilotBridgeCommand): BrowserPilotBridgeCommand {
  const rawCmd = String(msg.cmd || '');
  const mapped = BROWSER_PILOT_NATIVE_COMMANDS[rawCmd];
  return { ...msg, cmd: mapped, native_cmd: rawCmd };
}
async function handleBrowserPilotNativeCommand(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  const mapped = nativeToBrowserPilotMessage(msg);
  const resp = await handleBrowserPilot(mapped, sender);
  if (resp && typeof resp === 'object') {
    if (resp.details && typeof resp.details === 'object' && resp.details.cmd === undefined) resp.details.cmd = msg.cmd;
    if (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) {
      const dataRecord = resp.data as JsonRecord;
      if (dataRecord.native_cmd === undefined) dataRecord.native_cmd = msg.cmd;
    }
    const bridge = browserPilotBridgeInfo();
    if (bridge && resp.ok === false) {
      if (!resp.details || typeof resp.details !== 'object' || Array.isArray(resp.details)) resp.details = {};
      if (resp.details.bridge === undefined) resp.details.bridge = bridge;
    } else if (bridge && resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) {
      const dataRecord = resp.data as JsonRecord;
      if (dataRecord.bridge === undefined) dataRecord.bridge = bridge;
    }
  }
  return resp;
}
function redactSensitive(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  const patterns = [
    /bearer\s+fixture-secret/gi,
    /fixture-secret/gi,
    /fixture-password/gi,
    /(authorization[=:]\s*bearer\s+)[^\s&'"<>]+/gi,
    /([?&](?:token|secret|password|passwd|pwd|auth|authorization)=)[^&#\s'"<>]+/gi
  ];
  if (value == null) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const re of patterns) out = out.replace(re, (m, p1) => p1 ? p1 + '[REDACTED]' : '[REDACTED]');
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (depth > 8) return '[REDACTED_DEPTH]';
  seen = seen || new WeakSet();
  if (seen.has(value)) return '[REDACTED_CYCLE]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(v => redactSensitive(v, depth + 1, seen));
  const out: JsonRecord = {};
  for (const [k, v] of Object.entries(value)) {
    const lk = String(k).toLowerCase();
    if (/(token|secret|password|passwd|pwd|authorization|cookie|set-cookie)/.test(lk)) out[k] = '[REDACTED]';
    else out[k] = redactSensitive(v, depth + 1, seen);
  }
  return out;
}
/** @returns {BrowserPilotBridgeResponse} */
function browserPilotError(error_code: string, message: unknown, details?: unknown): BrowserPilotBridgeResponse {
  const text = String(redactSensitive(message || String(error_code || 'ERROR')));
  return { ok: false, error_code, error: text, details: runtimeRecord(redactSensitive(details || {})) };
}
/** @returns {BrowserPilotBridgeResponse} */
function bridgeError(error_code: string | undefined, message: unknown, details?: unknown): BrowserPilotBridgeResponse {
  const code = error_code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR;
  const text = String(redactSensitive(message || String(code)));
  const baseDetails = (details && typeof details === 'object') ? details : (details === undefined ? {} : { raw: details });
  return { ok: false, error_code: code, error: text, details: runtimeRecord(redactSensitive(baseDetails)) };
}
function normalizeBridgeResponse(resp: BrowserPilotBridgeResponse, cmd?: unknown): BrowserPilotBridgeResponse {
  if (!resp || resp.ok !== false) return resp;
  if (resp.error && typeof resp.error === 'object' && 'code' in resp.error && 'message' in resp.error && typeof resp.error.message === 'string') {
    const d: JsonRecord = ('details' in resp.error && resp.error.details && typeof resp.error.details === 'object') ? { ...(resp.error.details as JsonRecord) } : {};
    if (cmd !== undefined && d.cmd === undefined) d.cmd = cmd;
    return bridgeError(String(resp.error.code), resp.error.message, d);
  }
  const raw = resp.error !== undefined ? resp.error : (resp.message !== undefined ? resp.message : resp);
  const details: JsonRecord = { cmd, ...(resp.details && typeof resp.details === 'object' ? resp.details : {}), raw };
  if (raw && typeof raw === 'object') {
    const rawRecord = raw as JsonRecord;
    if (rawRecord.name && details.name === undefined) details.name = rawRecord.name;
    return bridgeError(String(resp.error_code || rawRecord.error_code || rawRecord.code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR), rawRecord.message || String(rawRecord.code || rawRecord.name || 'bridge command failed'), details);
  }
  return bridgeError(resp.error_code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, raw || 'bridge command failed', details);
}
function isBrowserPilotSessionMissing(res: BrowserPilotBridgeResponse | null | undefined): boolean {
  const error = runtimeRecord(res?.error);
  return Boolean(res && res.ok === false && (res.error_code === BROWSER_PILOT_ERROR_CODES.NO_SESSION || res.error_code === BROWSER_PILOT_ERROR_CODES.NOT_INSTALLED || error.code === BROWSER_PILOT_ERROR_CODES.NO_SESSION || error.code === BROWSER_PILOT_ERROR_CODES.NOT_INSTALLED));
}
function browserPilotSleep(ms: unknown): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0)))); }
function browserPilotPersistentCdp(): BrowserPilotPersistentCdpBridge | undefined { const g = globalThis as typeof globalThis & { browserPilotPersistentCdpBridge?: BrowserPilotPersistentCdpBridge; BrowserPilotPersistentCdp?: BrowserPilotPersistentCdpBridge }; return g.browserPilotPersistentCdpBridge || g.BrowserPilotPersistentCdp; }
function normalizePersistentBrowserPilotResponse(resp: BrowserPilotBridgeResponse): BrowserPilotBridgeResponse {
  const error = runtimeRecord(resp?.error);
  if (resp && resp.ok === false && resp.error && !resp.error_code) return browserPilotError(String(error.code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR), error.message || 'persistent CDP command failed', error.details || {});
  return resp;
}
/** @returns {number|undefined} */
function normalizeBrowserPilotEvalTimeoutMs(options?: BrowserPilotBridgeCommand): number | undefined {
  options = options || {};
  const raw = options && (options.timeoutMs !== undefined ? options.timeoutMs : options.timeout_ms);
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
/** @returns {Promise<BrowserPilotBridgeResponse>} */
async function browserPilotEval(tabId: number, expression: string, awaitPromise = true, options: BrowserPilotBridgeCommand = {}): Promise<BrowserPilotBridgeResponse> {
  const timeoutMs = normalizeBrowserPilotEvalTimeoutMs(options);
  const cdp = browserPilotPersistentCdp();
  if (cdp?.send) {
    // Runtime.evaluate is used between add/removeNewDocumentScript during acceptance.
    // Keep the logical CDP attachment persistent; a temporary attach/detach can invalidate
    // Page.addScriptToEvaluateOnNewDocument identifiers in Chrome's debugger session.
    const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, { persistent: true, name: 'eval', timeoutMs }));
    if (!resp || resp.ok === false) return resp;
    const result = runtimeRecord(runtimeRecord(resp.data).result || resp.result || resp.data);
    const exceptionDetails = runtimeRecord(result.exceptionDetails);
    if (result.exceptionDetails) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, runtimeRecord(exceptionDetails.exception).description || 'Runtime.evaluate failed', exceptionDetails);
    return { ok: true, data: runtimeRecord(result.result).value };
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    const command = chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    const result = timeoutMs === undefined ? await command : await browserPilotWithTimeout(command, timeoutMs, 'Runtime.evaluate');
    await chrome.debugger.detach({ tabId });
    const resultRecord = runtimeRecord(result);
    const exceptionDetails = runtimeRecord(resultRecord.exceptionDetails);
    if (resultRecord.exceptionDetails) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, runtimeRecord(exceptionDetails.exception).description || 'Runtime.evaluate failed', exceptionDetails);
    return { ok: true, data: runtimeRecord(resultRecord.result).value };
  } catch (e) { try { await chrome.debugger.detach({ tabId }); } catch (detachError) { console.warn('[BROWSER-PILOT] Failed to detach debugger after Runtime.evaluate fallback', tabId, runtimeErrorPreview(detachError)); } throw e; }
}
/** @returns {Promise<BrowserPilotBridgeResponse>} */
async function callPageBrowserPilot(tabId: number, command: string, args: unknown, options: BrowserPilotBridgeCommand = {}): Promise<BrowserPilotBridgeResponse> {
  const expr = `(window.__BROWSER_PILOT_HOOKS__ && window.__BROWSER_PILOT_HOOKS__.dispatch) ? window.__BROWSER_PILOT_HOOKS__.dispatch(${JSON.stringify(command)}, ${JSON.stringify(args || {})}) : {ok:false,error_code:'NO_SESSION',error:'Browser Pilot dispatcher is not installed'}`;
  const res = await browserPilotEval(tabId, expr, true, options);
  return (res.ok ? runtimeRecord(res.data) : res) as BrowserPilotBridgeResponse;
}

/** @returns {Promise<BrowserPilotBridgeResponse|null>} */
async function reinstallBrowserPilotSession(tabId: number): Promise<BrowserPilotBridgeResponse | null> {
  const sess = browserPilotSessions.get(tabId);
  if (!sess) return null;
  const injected = await ensureBrowserPilotDispatcher(tabId);
  if (!injected.ok) return injected;
  const args = sess.install_args || { session_id: sess.session_id, targets: sess.targets, options: sess.options, buffer_size: sess.buffer_size, install_fingerprint: sess.install_fingerprint };
  const res = await callPageBrowserPilot(tabId, 'hook.install', args);
  if (res && res.ok) {
    const data = runtimeRecord(res.data);
    browserPilotSessions.set(tabId, { ...sess, session_id: String(data.session_id || args.session_id || sess.session_id || ''), state: String(data.state || 'INSTALLED'), installed_at: String(data.installed_at || new Date().toISOString()), install_fingerprint: String(data.install_fingerprint || args.install_fingerprint || sess.install_fingerprint || ''), install_args: args });
  }
  return res;
}
/** @returns {Promise<BrowserPilotBridgeResponse>} */
async function callPageBrowserPilotWithAutoReinstall(tabId: number, command: string, args: unknown): Promise<BrowserPilotBridgeResponse | null> {
  let res = await callPageBrowserPilot(tabId, command, args);
  if (isBrowserPilotSessionMissing(res) && browserPilotSessions.has(tabId) && command !== 'hook.uninstall') {
    let last = res;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) await browserPilotSleep(150 * attempt);
      const reinstall = await reinstallBrowserPilotSession(tabId);
      if (!reinstall || reinstall.ok === false) { last = reinstall || last; continue; }
      res = await callPageBrowserPilot(tabId, command, args);
      if (!isBrowserPilotSessionMissing(res)) return res;
      last = res;
    }
    return last;
  }
  return res;
}

function browserPilotWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function handleBrowserPilot(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  const cmd = canonicalBrowserPilotCommand(msg.cmd);
  const tabId = Number(msg.tabId || sender.tab?.id || 0);
  if (cmd === 'hook.list_sessions') return await handleBrowserPilotImpl(msg, sender, cmd, tabId);
  if (!tabId) return browserPilotError('NO_SESSION', cmd + ' requires tabId', { cmd, details: {} });
  // Diagnostics must be out-of-band: enqueueing wait.diagnose makes its own
  // queue report show pending/depth=1 and masks the real post-uninstall state.
  // Running it directly still reports any pre-existing queued/running command
  // through getBrowserPilotQueueStats(tabId), so genuine queue leaks remain visible.
  if (cmd === 'wait.diagnose') return await handleBrowserPilotImpl(msg, sender, cmd, tabId);
  return await enqueueBrowserPilotCommand(tabId, cmd, () => handleBrowserPilotImpl(msg, sender, cmd, tabId));
}
async function handleBrowserPilotImpl(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender, cmd: string, tabId: number): Promise<BrowserPilotBridgeResponse> {
  try {
    if (cmd.startsWith('hook.')) return await handleBrowserPilotHookCommand(cmd, tabId, msg) as BrowserPilotBridgeResponse;
    if (cmd.startsWith('intercept.')) return await handleBrowserPilotInterceptCommand(cmd, tabId, msg) as BrowserPilotBridgeResponse;
    if (cmd.startsWith('evidence.')) return await handleBrowserPilotEvidenceCommand(cmd, tabId, msg) as BrowserPilotBridgeResponse;
    if (cmd.startsWith('ws.')) return await handleBrowserPilotWsCommand(cmd, tabId, msg) as BrowserPilotBridgeResponse;
    if (cmd.startsWith('frame.')) return await handleBrowserPilotFrameCommand(cmd, tabId, msg) as BrowserPilotBridgeResponse;
    if (cmd.startsWith('layer.')) return await handleBrowserPilotLayerCommand(cmd, tabId, msg) as BrowserPilotBridgeResponse;
    if (cmd.startsWith('transfer.')) return await handleBrowserPilotTransferCommand(cmd, tabId, msg) as BrowserPilotBridgeResponse;
    if (cmd.startsWith('input.')) return await handleBrowserPilotInputCommand(cmd, tabId, msg) as BrowserPilotBridgeResponse;
    switch (cmd) {
      case 'network.start':
      case 'network.stop':
      case 'network.status':
      case 'network.clear':
      case 'network.list':
      case 'network.get':
      case 'network.body':
      case 'network.exportHar':
      case 'network.wait': return await handleNetworkRecorderCommand(tabId, cmd, msg) as BrowserPilotBridgeResponse;
      case 'wait.navigate': return await navigateBrowserPilot(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.navigateAndWait': return await navigateAndWait(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.navigation': return await waitForNavigation(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.loadState': return await waitForLoadState(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.networkIdle': return await waitForNetworkIdle(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.selector': return await waitForSelector(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.any': return await waitForAny(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.all': return await waitForAll(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.cancel': return await cancelWait(tabId, msg) as BrowserPilotBridgeResponse;
      case 'wait.diagnose': return await diagnoseBrowserPilot(tabId, msg) as BrowserPilotBridgeResponse;
    }
    if (cmd === 'html.get') return await handleBrowserPilotHtml(tabId, msg) as BrowserPilotBridgeResponse;
    if (cmd === 'screenshot.capture') return await captureScreenshotWithRetry(tabId, msg) as BrowserPilotBridgeResponse;
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown Browser Pilot command: ' + cmd, { cmd });
  } catch (e) { return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, runtimeErrorMessage(e), { cmd, tabId }); }
}
export { BROWSER_PILOT_HOOK_DISPATCHER_FILE, BROWSER_PILOT_ERROR_CODES, BROWSER_PILOT_PROTOCOL, BROWSER_PILOT_ALIASES, browserPilotSessions, browserPilotTabQueues, BROWSER_PILOT_QUEUE_MAX_DEPTH, getBrowserPilotQueueStats, enqueueBrowserPilotCommand, cleanupBrowserPilotTab, canonicalBrowserPilotCommand, BROWSER_PILOT_NATIVE_COMMANDS, isBrowserPilotNativeCommand, nativeToBrowserPilotMessage, handleBrowserPilotNativeCommand, redactSensitive, browserPilotError, bridgeError, normalizeBridgeResponse, isBrowserPilotSessionMissing, browserPilotSleep, browserPilotPersistentCdp, normalizePersistentBrowserPilotResponse, normalizeBrowserPilotEvalTimeoutMs, browserPilotEval, callPageBrowserPilot, reinstallBrowserPilotSession, callPageBrowserPilotWithAutoReinstall, browserPilotWithTimeout, rememberRuntimeSession, forgetRuntimeSession, findLostRuntimeSession, summarizeLostRuntimeSession, handleBrowserPilot, handleBrowserPilotImpl };
// ESM module metadata
export const __browserPilotBridgeModule_runtime = { name: "runtime", symbols: { BROWSER_PILOT_HOOK_DISPATCHER_FILE, BROWSER_PILOT_ERROR_CODES, BROWSER_PILOT_PROTOCOL, BROWSER_PILOT_ALIASES, browserPilotSessions, browserPilotTabQueues, BROWSER_PILOT_QUEUE_MAX_DEPTH, getBrowserPilotQueueStats, enqueueBrowserPilotCommand, cleanupBrowserPilotTab, canonicalBrowserPilotCommand, BROWSER_PILOT_NATIVE_COMMANDS, isBrowserPilotNativeCommand, nativeToBrowserPilotMessage, handleBrowserPilotNativeCommand, redactSensitive, browserPilotError, bridgeError, normalizeBridgeResponse, isBrowserPilotSessionMissing, browserPilotSleep, browserPilotPersistentCdp, normalizePersistentBrowserPilotResponse, normalizeBrowserPilotEvalTimeoutMs, browserPilotEval, callPageBrowserPilot, reinstallBrowserPilotSession, callPageBrowserPilotWithAutoReinstall, browserPilotWithTimeout, rememberRuntimeSession, forgetRuntimeSession, findLostRuntimeSession, summarizeLostRuntimeSession, handleBrowserPilot, handleBrowserPilotImpl } };
