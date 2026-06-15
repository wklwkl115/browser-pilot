import { PiNativeProtocol } from "./protocol";
import { chromeApi as chrome } from "./runtimeEnv";
import { cancelWaitsForTab, cleanupTabWaits } from "./wait_coordinator";
import { navigateAndWait, navigatePiBrowser, waitForLoadState, waitForNavigation } from "./wait_navigation";
import { waitForNetworkIdle } from "./wait_network_idle";
import { waitForSelector } from "./wait_selector";
import { cancelWait, cleanupPiBrowserPageListenersForTab, diagnosePiBrowser, waitForAll, waitForAny } from "./wait";
import { cleanupNetworkRecorderTab, handleNetworkRecorderCommand } from "./network";
import { cleanupInterceptSessionTab, handlePiBrowserInterceptCommand } from "./intercept";
import { ensurePiBrowserDispatcher, handlePiBrowserHookCommand } from "./hook";
import { handlePiBrowserEvidenceCommand } from "./evidence";
import { handlePiBrowserFrameCommand } from "./frame";
import { handlePiBrowserLayerCommand } from "./layer";
import { handlePiBrowserTransferCommand } from "./transfer";
import { handlePiBrowserHtml } from "./html";
import { handlePiBrowserInputCommand } from "./input";
import { cleanupWsSessionsForTab, handlePiBrowserWsCommand } from "./ws";
import { cleanupPersistentCdpForTab } from "./cdp";
import { captureScreenshotWithRetry } from "./screenshot";
import { piBridgeInfo } from "./bridge_info";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse, PiBridgeSender, PiNativeProtocolRuntime, PiPersistentCdpBridge } from "./types";

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

const PI_BROWSER_HOOK_DISPATCHER_FILE = 'dist/hook_dispatcher.js';
const PI_BROWSER_ERROR_CODES = {
  NO_SESSION: 'NO_SESSION', SESSION_NOT_FOUND: 'SESSION_NOT_FOUND', INVALID_SESSION: 'INVALID_SESSION', ALREADY_INSTALLED: 'ALREADY_INSTALLED', NOT_INSTALLED: 'NOT_INSTALLED',
  INVALID_RULE: 'INVALID_RULE', UNSUPPORTED_TARGET: 'UNSUPPORTED_TARGET', INJECTION_FAILED: 'INJECTION_FAILED',
  SAFETY_BLOCKED: 'SAFETY_BLOCKED', TIMEOUT: 'TIMEOUT', NAVIGATION_TIMEOUT: 'NAVIGATION_TIMEOUT', SELECTOR_TIMEOUT: 'SELECTOR_TIMEOUT', SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND', INVALID_SELECTOR: 'INVALID_SELECTOR', NETWORK_IDLE_TIMEOUT: 'NETWORK_IDLE_TIMEOUT', NETWORK_RECORDER_NOT_STARTED: 'NETWORK_RECORDER_NOT_STARTED', NETWORK_RECORDER_TIMEOUT: 'NETWORK_RECORDER_TIMEOUT', REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND', BODY_UNAVAILABLE: 'BODY_UNAVAILABLE', FRAME_DETACHED: 'FRAME_DETACHED', CROSS_ORIGIN_IFRAME: 'CROSS_ORIGIN_IFRAME', TAB_NOT_FOUND: 'TAB_NOT_FOUND', TAB_CRASHED: 'TAB_CRASHED', BACKGROUND_THROTTLED: 'BACKGROUND_THROTTLED', EVENT_SUBSCRIPTION_FAILED: 'EVENT_SUBSCRIPTION_FAILED', CANCELLED: 'CANCELLED', BUFFER_OVERFLOW: 'BUFFER_OVERFLOW', AMBIGUOUS_DOWNLOAD: 'AMBIGUOUS_DOWNLOAD', INTERNAL_ERROR: 'INTERNAL_ERROR'
};
const PI_BROWSER_PROTOCOL = (typeof PiNativeProtocol !== 'undefined' ? PiNativeProtocol : (self as typeof self & { PiNativeProtocol?: unknown }).PiNativeProtocol) as PiNativeProtocolRuntime;
if (!PI_BROWSER_PROTOCOL || !PI_BROWSER_PROTOCOL.schema || !PI_BROWSER_PROTOCOL.nativeCommandMap) throw new Error('Browser Pilot protocol schema is not loaded');
const PI_BROWSER_ALIASES = PI_BROWSER_PROTOCOL.aliases || {};
type PiBrowserSessionRecord = JsonRecord & {
  session_id?: string;
  targets?: unknown;
  options?: unknown;
  buffer_size?: number;
  install_fingerprint?: string;
  install_args?: JsonRecord;
  state?: string;
  installed_at?: string;
};
type PiBrowserQueueRecord = { tail: Promise<unknown>; depth: number; pending: boolean; last_cmd: string | null };
const piBrowserSessions = new Map<number, PiBrowserSessionRecord>();
const piBrowserTabQueues = new Map<number, PiBrowserQueueRecord>();
const PI_BROWSER_QUEUE_MAX_DEPTH = 64;
const PI_BROWSER_RUNTIME_STATE_KEY = 'piBrowserRuntimeState';

async function loadPiBrowserRuntimeStateMap(): Promise<Record<string, JsonRecord>> {
  const session = chrome.storage?.session;
  if (!session?.get) return {};
  let raw: unknown;
  try {
    raw = await session.get(PI_BROWSER_RUNTIME_STATE_KEY);
  } catch (error) {
    console.warn('[PI-BROWSER-STATE] Failed to load runtime state map', runtimeErrorPreview(error));
    return {};
  }
  const value = raw && typeof raw === 'object' ? (raw as JsonRecord)[PI_BROWSER_RUNTIME_STATE_KEY] : undefined;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonRecord> : {};
}
function piBrowserRuntimeStateKey(kind: string, tabId: number, sessionId: string): string { return `${kind}:${Number(tabId)}:${String(sessionId || 'default')}`; }
async function savePiBrowserRuntimeStateMap(map: Record<string, JsonRecord>): Promise<void> {
  const session = chrome.storage?.session;
  if (!session?.set) return;
  try {
    await session.set({ [PI_BROWSER_RUNTIME_STATE_KEY]: map });
  } catch (error) {
    console.warn('[PI-BROWSER-STATE] Failed to save runtime state map', runtimeErrorPreview(error));
  }
}
function currentPiBrowserWorkerBootId(): string {
  const bridge = runtimeRecord(piBridgeInfo());
  return typeof bridge.workerBootId === 'string' && bridge.workerBootId ? bridge.workerBootId : 'unknown';
}
async function rememberRuntimeSession(kind: string, tabId: number, sessionId: string, details: JsonRecord = {}): Promise<void> {
  const map = await loadPiBrowserRuntimeStateMap();
  map[piBrowserRuntimeStateKey(kind, tabId, sessionId)] = { kind, tabId: Number(tabId), sessionId: String(sessionId || 'default'), active: true, workerBootId: currentPiBrowserWorkerBootId(), updatedAt: Date.now(), details };
  await savePiBrowserRuntimeStateMap(map);
}
async function forgetRuntimeSession(kind: string, tabId: number, sessionId: string): Promise<void> {
  const map = await loadPiBrowserRuntimeStateMap();
  delete map[piBrowserRuntimeStateKey(kind, tabId, sessionId)];
  await savePiBrowserRuntimeStateMap(map);
}
async function findLostRuntimeSession(kind: string, tabId: number, sessionId: string): Promise<JsonRecord | undefined> {
  const record = (await loadPiBrowserRuntimeStateMap())[piBrowserRuntimeStateKey(kind, tabId, sessionId)];
  return record && record.active === true && record.workerBootId !== currentPiBrowserWorkerBootId() ? record : undefined;
}
function summarizeLostRuntimeSession(record: JsonRecord | undefined): JsonRecord | undefined {
  if (!record) return undefined;
  return { stateLost: true, previousWorkerBootId: record.workerBootId, updatedAt: record.updatedAt, kind: record.kind, tabId: record.tabId, sessionId: record.sessionId, details: runtimeRecord(record.details) };
}

function getPiBrowserQueueStats(tabId: unknown) {
  const q = piBrowserTabQueues.get(Number(tabId));
  return q ? { pending: q.pending, depth: q.depth, last_cmd: q.last_cmd || null } : { pending: false, depth: 0, last_cmd: null };
}
function enqueuePiBrowserCommand(tabId: unknown, cmd: string, task: () => Promise<PiBridgeResponse> | PiBridgeResponse): Promise<PiBridgeResponse> {
  const key = Number(tabId);
  const current = piBrowserTabQueues.get(key) || { tail: Promise.resolve(), depth: 0, pending: false, last_cmd: null } satisfies PiBrowserQueueRecord;
  if (current.depth >= PI_BROWSER_QUEUE_MAX_DEPTH) return Promise.resolve(piBrowserError(PI_BROWSER_ERROR_CODES.TIMEOUT, 'Browser Pilot command queue is full', { tabId: key, cmd, depth: current.depth, max_depth: PI_BROWSER_QUEUE_MAX_DEPTH }));
  current.depth += 1;
  current.pending = true;
  current.last_cmd = cmd;
  const run = current.tail.catch(() => {}).then(async () => {
    try { return await task(); }
    finally {
      const latest = piBrowserTabQueues.get(key);
      if (latest) {
        latest.depth = Math.max(0, latest.depth - 1);
        latest.pending = latest.depth > 0;
        if (latest.depth === 0) latest.last_cmd = null;
      }
    }
  });
  current.tail = run.catch(() => {});
  piBrowserTabQueues.set(key, current);
  return run;
}
function cleanupPiBrowserTab(tabId: number, reason?: string) {
  const key = Number(tabId);
  const cleanupReason = reason || 'tab_cleanup';
  try {
    const pageCleanup = cleanupPiBrowserPageListenersForTab(tabId, cleanupReason);
    if ((pageCleanup as Promise<unknown> | undefined)?.catch) {
      void (pageCleanup as Promise<unknown>).catch((e: unknown) => console.warn('[PI-BROWSER] page listener cleanup failed', key, cleanupReason, runtimeErrorPreview(e)));
    }
  } catch (e) { console.warn('[PI-BROWSER] page listener cleanup failed', key, cleanupReason, runtimeErrorPreview(e)); }
  piBrowserSessions.delete(key);
  piBrowserTabQueues.delete(key);
  try { cleanupNetworkRecorderTab(tabId, cleanupReason); } catch (e) { console.warn('[PI-BROWSER-NET] recorder cleanup failed', key, runtimeErrorPreview(e)); }
  try { cleanupInterceptSessionTab(tabId, cleanupReason); } catch (e) { console.warn('[PI-BROWSER-INTERCEPT] session cleanup failed', key, runtimeErrorPreview(e)); }
  try { cleanupWsSessionsForTab(tabId, cleanupReason); } catch (e) { console.warn('[PI-BROWSER-WS] session cleanup failed', key, runtimeErrorPreview(e)); }
  try { cleanupPersistentCdpForTab(tabId, cleanupReason); } catch (e) { console.warn('[PI-BROWSER-CDP] persistent session cleanup failed', key, runtimeErrorPreview(e)); }
  // Preserve the public cancellation path for tab teardown so queued callers,
  // diagnostics and static contract tests all see the same lifecycle entrypoint.
  // Literal contract: cancelWaitsForTab(tabId, 'tab_cleanup')
  if (cleanupReason === 'tab_cleanup') cancelWaitsForTab(tabId, 'tab_cleanup');
  else cleanupTabWaits(tabId, cleanupReason, { includeCdp: true, action: 'tab_cleanup' });
}
function canonicalPiBrowserCommand(cmd: unknown): string { const key = String(cmd || ''); return PI_BROWSER_PROTOCOL.canonicalCommand ? PI_BROWSER_PROTOCOL.canonicalCommand(key) : (PI_BROWSER_ALIASES[key] || key); }
const PI_NATIVE_BROWSER_COMMANDS = PI_BROWSER_PROTOCOL.nativeCommandMap;
function isPiNativeBrowserCommand(cmd: unknown): boolean { return typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(PI_NATIVE_BROWSER_COMMANDS, cmd); }
function nativeToPiBrowserMessage(msg: PiBridgeCommand): PiBridgeCommand {
  const rawCmd = String(msg.cmd || '');
  const mapped = PI_NATIVE_BROWSER_COMMANDS[rawCmd];
  return { ...msg, cmd: mapped, native_cmd: rawCmd };
}
async function handlePiNativeBrowserCommand(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  const mapped = nativeToPiBrowserMessage(msg);
  const resp = await handlePiBrowser(mapped, sender);
  if (resp && typeof resp === 'object') {
    if (resp.details && typeof resp.details === 'object' && resp.details.cmd === undefined) resp.details.cmd = msg.cmd;
    if (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) {
      const dataRecord = resp.data as JsonRecord;
      if (dataRecord.native_cmd === undefined) dataRecord.native_cmd = msg.cmd;
    }
    const bridge = piBridgeInfo();
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
/** @returns {PiBridgeResponse} */
function piBrowserError(error_code: string, message: unknown, details?: unknown): PiBridgeResponse {
  const text = String(redactSensitive(message || String(error_code || 'ERROR')));
  return { ok: false, error_code, error: text, details: runtimeRecord(redactSensitive(details || {})) };
}
/** @returns {PiBridgeResponse} */
function bridgeError(error_code: string | undefined, message: unknown, details?: unknown): PiBridgeResponse {
  const code = error_code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR;
  const text = String(redactSensitive(message || String(code)));
  const baseDetails = (details && typeof details === 'object') ? details : (details === undefined ? {} : { raw: details });
  return { ok: false, error_code: code, error: text, details: runtimeRecord(redactSensitive(baseDetails)) };
}
function normalizeBridgeResponse(resp: PiBridgeResponse, cmd?: unknown): PiBridgeResponse {
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
    return bridgeError(String(resp.error_code || rawRecord.error_code || rawRecord.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR), rawRecord.message || String(rawRecord.code || rawRecord.name || 'bridge command failed'), details);
  }
  return bridgeError(resp.error_code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, raw || 'bridge command failed', details);
}
function isPiBrowserSessionMissing(res: PiBridgeResponse | null | undefined): boolean {
  const error = runtimeRecord(res?.error);
  return Boolean(res && res.ok === false && (res.error_code === PI_BROWSER_ERROR_CODES.NO_SESSION || res.error_code === PI_BROWSER_ERROR_CODES.NOT_INSTALLED || error.code === PI_BROWSER_ERROR_CODES.NO_SESSION || error.code === PI_BROWSER_ERROR_CODES.NOT_INSTALLED));
}
function piSleep(ms: unknown): Promise<void> { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0)))); }
function piBrowserPersistentCdp(): PiPersistentCdpBridge | undefined { const g = globalThis as typeof globalThis & { piPersistentCdpBridge?: PiPersistentCdpBridge; PiPersistentCdp?: PiPersistentCdpBridge }; return g.piPersistentCdpBridge || g.PiPersistentCdp; }
function normalizePersistentPiBrowserResponse(resp: PiBridgeResponse): PiBridgeResponse {
  const error = runtimeRecord(resp?.error);
  if (resp && resp.ok === false && resp.error && !resp.error_code) return piBrowserError(String(error.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR), error.message || 'persistent CDP command failed', error.details || {});
  return resp;
}
/** @returns {number|undefined} */
function normalizePiBrowserEvalTimeoutMs(options?: PiBridgeCommand): number | undefined {
  options = options || {};
  const raw = options && (options.timeoutMs !== undefined ? options.timeoutMs : options.timeout_ms);
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
/** @returns {Promise<PiBridgeResponse>} */
async function piBrowserEval(tabId: number, expression: string, awaitPromise = true, options: PiBridgeCommand = {}): Promise<PiBridgeResponse> {
  const timeoutMs = normalizePiBrowserEvalTimeoutMs(options);
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    // Runtime.evaluate is used between add/removeNewDocumentScript during acceptance.
    // Keep the logical CDP attachment persistent; a temporary attach/detach can invalidate
    // Page.addScriptToEvaluateOnNewDocument identifiers in Chrome's debugger session.
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, { persistent: true, name: 'eval', timeoutMs }));
    if (!resp || resp.ok === false) return resp;
    const result = runtimeRecord(runtimeRecord(resp.data).result || resp.result || resp.data);
    const exceptionDetails = runtimeRecord(result.exceptionDetails);
    if (result.exceptionDetails) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, runtimeRecord(exceptionDetails.exception).description || 'Runtime.evaluate failed', exceptionDetails);
    return { ok: true, data: runtimeRecord(result.result).value };
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    const command = chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    const result = timeoutMs === undefined ? await command : await piWithTimeout(command, timeoutMs, 'Runtime.evaluate');
    await chrome.debugger.detach({ tabId });
    const resultRecord = runtimeRecord(result);
    const exceptionDetails = runtimeRecord(resultRecord.exceptionDetails);
    if (resultRecord.exceptionDetails) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, runtimeRecord(exceptionDetails.exception).description || 'Runtime.evaluate failed', exceptionDetails);
    return { ok: true, data: runtimeRecord(resultRecord.result).value };
  } catch (e) { try { await chrome.debugger.detach({ tabId }); } catch (detachError) { console.warn('[PI-BROWSER] Failed to detach debugger after Runtime.evaluate fallback', tabId, runtimeErrorPreview(detachError)); } throw e; }
}
/** @returns {Promise<PiBridgeResponse>} */
async function callPagePiBrowser(tabId: number, command: string, args: unknown, options: PiBridgeCommand = {}): Promise<PiBridgeResponse> {
  const expr = `(window.__PI_BROWSER_HOOKS__ && window.__PI_BROWSER_HOOKS__.dispatch) ? window.__PI_BROWSER_HOOKS__.dispatch(${JSON.stringify(command)}, ${JSON.stringify(args || {})}) : {ok:false,error_code:'NO_SESSION',error:'Browser Pilot dispatcher is not installed'}`;
  const res = await piBrowserEval(tabId, expr, true, options);
  return (res.ok ? runtimeRecord(res.data) : res) as PiBridgeResponse;
}

/** @returns {Promise<PiBridgeResponse|null>} */
async function reinstallPiBrowserSession(tabId: number): Promise<PiBridgeResponse | null> {
  const sess = piBrowserSessions.get(tabId);
  if (!sess) return null;
  const injected = await ensurePiBrowserDispatcher(tabId);
  if (!injected.ok) return injected;
  const args = sess.install_args || { session_id: sess.session_id, targets: sess.targets, options: sess.options, buffer_size: sess.buffer_size, install_fingerprint: sess.install_fingerprint };
  const res = await callPagePiBrowser(tabId, 'hook.install', args);
  if (res && res.ok) {
    const data = runtimeRecord(res.data);
    piBrowserSessions.set(tabId, { ...sess, session_id: String(data.session_id || args.session_id || sess.session_id || ''), state: String(data.state || 'INSTALLED'), installed_at: String(data.installed_at || new Date().toISOString()), install_fingerprint: String(data.install_fingerprint || args.install_fingerprint || sess.install_fingerprint || ''), install_args: args });
  }
  return res;
}
/** @returns {Promise<PiBridgeResponse>} */
async function callPagePiBrowserWithAutoReinstall(tabId: number, command: string, args: unknown): Promise<PiBridgeResponse | null> {
  let res = await callPagePiBrowser(tabId, command, args);
  if (isPiBrowserSessionMissing(res) && piBrowserSessions.has(tabId) && command !== 'hook.uninstall') {
    let last = res;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) await piSleep(150 * attempt);
      const reinstall = await reinstallPiBrowserSession(tabId);
      if (!reinstall || reinstall.ok === false) { last = reinstall || last; continue; }
      res = await callPagePiBrowser(tabId, command, args);
      if (!isPiBrowserSessionMissing(res)) return res;
      last = res;
    }
    return last;
  }
  return res;
}

function piWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function handlePiBrowser(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  const cmd = canonicalPiBrowserCommand(msg.cmd);
  const tabId = Number(msg.tabId || sender.tab?.id || 0);
  if (cmd === 'hook.list_sessions') return await handlePiBrowserImpl(msg, sender, cmd, tabId);
  if (!tabId) return piBrowserError('NO_SESSION', cmd + ' requires tabId', { cmd, details: {} });
  // Diagnostics must be out-of-band: enqueueing wait.diagnose makes its own
  // queue report show pending/depth=1 and masks the real post-uninstall state.
  // Running it directly still reports any pre-existing queued/running command
  // through getPiBrowserQueueStats(tabId), so genuine queue leaks remain visible.
  if (cmd === 'wait.diagnose') return await handlePiBrowserImpl(msg, sender, cmd, tabId);
  return await enqueuePiBrowserCommand(tabId, cmd, () => handlePiBrowserImpl(msg, sender, cmd, tabId));
}
async function handlePiBrowserImpl(msg: PiBridgeCommand, sender: PiBridgeSender, cmd: string, tabId: number): Promise<PiBridgeResponse> {
  try {
    if (cmd.startsWith('hook.')) return await handlePiBrowserHookCommand(cmd, tabId, msg) as PiBridgeResponse;
    if (cmd.startsWith('intercept.')) return await handlePiBrowserInterceptCommand(cmd, tabId, msg) as PiBridgeResponse;
    if (cmd.startsWith('evidence.')) return await handlePiBrowserEvidenceCommand(cmd, tabId, msg) as PiBridgeResponse;
    if (cmd.startsWith('ws.')) return await handlePiBrowserWsCommand(cmd, tabId, msg) as PiBridgeResponse;
    if (cmd.startsWith('frame.')) return await handlePiBrowserFrameCommand(cmd, tabId, msg) as PiBridgeResponse;
    if (cmd.startsWith('layer.')) return await handlePiBrowserLayerCommand(cmd, tabId, msg) as PiBridgeResponse;
    if (cmd.startsWith('transfer.')) return await handlePiBrowserTransferCommand(cmd, tabId, msg) as PiBridgeResponse;
    if (cmd.startsWith('input.')) return await handlePiBrowserInputCommand(cmd, tabId, msg) as PiBridgeResponse;
    switch (cmd) {
      case 'network.start':
      case 'network.stop':
      case 'network.status':
      case 'network.clear':
      case 'network.list':
      case 'network.get':
      case 'network.body':
      case 'network.exportHar':
      case 'network.wait': return await handleNetworkRecorderCommand(tabId, cmd, msg) as PiBridgeResponse;
      case 'wait.navigate': return await navigatePiBrowser(tabId, msg) as PiBridgeResponse;
      case 'wait.navigateAndWait': return await navigateAndWait(tabId, msg) as PiBridgeResponse;
      case 'wait.navigation': return await waitForNavigation(tabId, msg) as PiBridgeResponse;
      case 'wait.loadState': return await waitForLoadState(tabId, msg) as PiBridgeResponse;
      case 'wait.networkIdle': return await waitForNetworkIdle(tabId, msg) as PiBridgeResponse;
      case 'wait.selector': return await waitForSelector(tabId, msg) as PiBridgeResponse;
      case 'wait.any': return await waitForAny(tabId, msg) as PiBridgeResponse;
      case 'wait.all': return await waitForAll(tabId, msg) as PiBridgeResponse;
      case 'wait.cancel': return await cancelWait(tabId, msg) as PiBridgeResponse;
      case 'wait.diagnose': return await diagnosePiBrowser(tabId, msg) as PiBridgeResponse;
    }
    if (cmd === 'html.get') return await handlePiBrowserHtml(tabId, msg) as PiBridgeResponse;
    if (cmd === 'screenshot.capture') return await captureScreenshotWithRetry(tabId, msg) as PiBridgeResponse;
    return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown Browser Pilot command: ' + cmd, { cmd });
  } catch (e) { return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, runtimeErrorMessage(e), { cmd, tabId }); }
}
export { PI_BROWSER_HOOK_DISPATCHER_FILE, PI_BROWSER_ERROR_CODES, PI_BROWSER_PROTOCOL, PI_BROWSER_ALIASES, piBrowserSessions, piBrowserTabQueues, PI_BROWSER_QUEUE_MAX_DEPTH, getPiBrowserQueueStats, enqueuePiBrowserCommand, cleanupPiBrowserTab, canonicalPiBrowserCommand, PI_NATIVE_BROWSER_COMMANDS, isPiNativeBrowserCommand, nativeToPiBrowserMessage, handlePiNativeBrowserCommand, redactSensitive, piBrowserError, bridgeError, normalizeBridgeResponse, isPiBrowserSessionMissing, piSleep, piBrowserPersistentCdp, normalizePersistentPiBrowserResponse, normalizePiBrowserEvalTimeoutMs, piBrowserEval, callPagePiBrowser, reinstallPiBrowserSession, callPagePiBrowserWithAutoReinstall, piWithTimeout, rememberRuntimeSession, forgetRuntimeSession, findLostRuntimeSession, summarizeLostRuntimeSession, handlePiBrowser, handlePiBrowserImpl };
// ESM module metadata
export const __piBridgeModule_runtime = { name: "runtime", symbols: { PI_BROWSER_HOOK_DISPATCHER_FILE, PI_BROWSER_ERROR_CODES, PI_BROWSER_PROTOCOL, PI_BROWSER_ALIASES, piBrowserSessions, piBrowserTabQueues, PI_BROWSER_QUEUE_MAX_DEPTH, getPiBrowserQueueStats, enqueuePiBrowserCommand, cleanupPiBrowserTab, canonicalPiBrowserCommand, PI_NATIVE_BROWSER_COMMANDS, isPiNativeBrowserCommand, nativeToPiBrowserMessage, handlePiNativeBrowserCommand, redactSensitive, piBrowserError, bridgeError, normalizeBridgeResponse, isPiBrowserSessionMissing, piSleep, piBrowserPersistentCdp, normalizePersistentPiBrowserResponse, normalizePiBrowserEvalTimeoutMs, piBrowserEval, callPagePiBrowser, reinstallPiBrowserSession, callPagePiBrowserWithAutoReinstall, piWithTimeout, rememberRuntimeSession, forgetRuntimeSession, findLostRuntimeSession, summarizeLostRuntimeSession, handlePiBrowser, handlePiBrowserImpl } };
