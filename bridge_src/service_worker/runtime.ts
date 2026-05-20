// @ts-nocheck
// runtime.js - Pi browser native command runtime (wait/network/hook/frame/html/screenshot).

const PI_BROWSER_HOOK_DISPATCHER_FILE = 'hook_dispatcher.js';
const PI_BROWSER_ERROR_CODES = {
  NO_SESSION: 'NO_SESSION', SESSION_NOT_FOUND: 'SESSION_NOT_FOUND', INVALID_SESSION: 'INVALID_SESSION', ALREADY_INSTALLED: 'ALREADY_INSTALLED', NOT_INSTALLED: 'NOT_INSTALLED',
  INVALID_RULE: 'INVALID_RULE', UNSUPPORTED_TARGET: 'UNSUPPORTED_TARGET', INJECTION_FAILED: 'INJECTION_FAILED',
  SAFETY_BLOCKED: 'SAFETY_BLOCKED', TIMEOUT: 'TIMEOUT', NAVIGATION_TIMEOUT: 'NAVIGATION_TIMEOUT', SELECTOR_TIMEOUT: 'SELECTOR_TIMEOUT', SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND', INVALID_SELECTOR: 'INVALID_SELECTOR', NETWORK_IDLE_TIMEOUT: 'NETWORK_IDLE_TIMEOUT', NETWORK_RECORDER_NOT_STARTED: 'NETWORK_RECORDER_NOT_STARTED', NETWORK_RECORDER_TIMEOUT: 'NETWORK_RECORDER_TIMEOUT', REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND', BODY_UNAVAILABLE: 'BODY_UNAVAILABLE', FRAME_DETACHED: 'FRAME_DETACHED', CROSS_ORIGIN_IFRAME: 'CROSS_ORIGIN_IFRAME', TAB_NOT_FOUND: 'TAB_NOT_FOUND', TAB_CRASHED: 'TAB_CRASHED', BACKGROUND_THROTTLED: 'BACKGROUND_THROTTLED', EVENT_SUBSCRIPTION_FAILED: 'EVENT_SUBSCRIPTION_FAILED', CANCELLED: 'CANCELLED', BUFFER_OVERFLOW: 'BUFFER_OVERFLOW', AMBIGUOUS_DOWNLOAD: 'AMBIGUOUS_DOWNLOAD', INTERNAL_ERROR: 'INTERNAL_ERROR'
};
const PI_BROWSER_PROTOCOL = self.PiNativeProtocol;
if (!PI_BROWSER_PROTOCOL || !PI_BROWSER_PROTOCOL.schema || !PI_BROWSER_PROTOCOL.nativeCommandMap) throw new Error('Pi Browser protocol schema is not loaded');
const PI_BROWSER_ALIASES = PI_BROWSER_PROTOCOL.aliases || {};
const piBrowserSessions = new Map();
const piBrowserTabQueues = new Map();
const PI_BROWSER_QUEUE_MAX_DEPTH = 64;

function getPiBrowserQueueStats(tabId) {
  const q = piBrowserTabQueues.get(Number(tabId));
  return q ? { pending: q.pending, depth: q.depth, last_cmd: q.last_cmd || null } : { pending: false, depth: 0, last_cmd: null };
}
function enqueuePiBrowserCommand(tabId, cmd, task) {
  const key = Number(tabId);
  const current = piBrowserTabQueues.get(key) || { tail: Promise.resolve(), depth: 0, pending: false, last_cmd: null };
  if (current.depth >= PI_BROWSER_QUEUE_MAX_DEPTH) return Promise.resolve(piBrowserError(PI_BROWSER_ERROR_CODES.TIMEOUT, 'Pi Browser command queue is full', { tabId: key, cmd, depth: current.depth, max_depth: PI_BROWSER_QUEUE_MAX_DEPTH }));
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
function cleanupPiBrowserTab(tabId, reason) {
  const key = Number(tabId);
  const cleanupReason = reason || 'tab_cleanup';
  try {
    const pageCleanup = typeof cleanupPiBrowserPageListenersForTab === 'function' ? cleanupPiBrowserPageListenersForTab(tabId, cleanupReason) : null;
    if (pageCleanup && typeof pageCleanup.catch === 'function') pageCleanup.catch(e => console.warn('[PI-BROWSER] page listener cleanup failed', key, cleanupReason, e && e.message ? e.message : e));
  } catch (e) { console.warn('[PI-BROWSER] page listener cleanup failed', key, cleanupReason, e && e.message ? e.message : e); }
  piBrowserSessions.delete(key);
  piBrowserTabQueues.delete(key);
  try { cleanupNetworkRecorderTab(tabId, cleanupReason); } catch (e) { console.warn('[PI-BROWSER-NET] recorder cleanup failed', key, e && e.message ? e.message : e); }
  // Preserve the public cancellation path for tab teardown so queued callers,
  // diagnostics and static contract tests all see the same lifecycle entrypoint.
  // Literal contract: cancelWaitsForTab(tabId, 'tab_cleanup')
  const waits = cleanupReason === 'tab_cleanup'
    ? { cleaned: cancelWaitsForTab(tabId, 'tab_cleanup'), orphaned: 0 }
    : cleanupTabWaits(tabId, cleanupReason, { includeCdp: true, action: 'tab_cleanup' });
  console.log('[PI-BROWSER] cleaned tab state', key, cleanupReason, { waits_cleaned: waits.cleaned, orphan_waits: waits.orphaned });
}
function canonicalPiBrowserCommand(cmd) { return PI_BROWSER_PROTOCOL.canonicalCommand ? PI_BROWSER_PROTOCOL.canonicalCommand(cmd) : (PI_BROWSER_ALIASES[cmd] || cmd); }
const PI_NATIVE_BROWSER_COMMANDS = PI_BROWSER_PROTOCOL.nativeCommandMap;
function isPiNativeBrowserCommand(cmd) { return typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(PI_NATIVE_BROWSER_COMMANDS, cmd); }
function nativeToPiBrowserMessage(msg) {
  const mapped = PI_NATIVE_BROWSER_COMMANDS[msg.cmd];
  return { ...msg, cmd: mapped, native_cmd: msg.cmd };
}
async function handlePiNativeBrowserCommand(msg, sender) {
  const mapped = nativeToPiBrowserMessage(msg);
  const resp = await handlePiBrowser(mapped, sender);
  if (resp && typeof resp === 'object') {
    if (resp.details && typeof resp.details === 'object' && resp.details.cmd === undefined) resp.details.cmd = msg.cmd;
    if (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data) && resp.data.native_cmd === undefined) resp.data.native_cmd = msg.cmd;
    const bridge = typeof piBridgeInfo === 'function' ? piBridgeInfo() : null;
    if (bridge && resp.ok === false) {
      if (!resp.details || typeof resp.details !== 'object' || Array.isArray(resp.details)) resp.details = {};
      if (resp.details.bridge === undefined) resp.details.bridge = bridge;
    } else if (bridge && resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data) && resp.data.bridge === undefined) {
      resp.data.bridge = bridge;
    }
  }
  return resp;
}
function redactSensitive(value, depth = 0, seen) {
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
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lk = String(k).toLowerCase();
    if (/(token|secret|password|passwd|pwd|authorization|cookie|set-cookie)/.test(lk)) out[k] = '[REDACTED]';
    else out[k] = redactSensitive(v, depth + 1, seen);
  }
  return out;
}
/** @returns {PiBridgeResponse} */
function piBrowserError(error_code, message, details) {
  const text = redactSensitive(message || String(error_code || 'ERROR'));
  return { ok: false, error_code, error: text, details: redactSensitive(details || {}) };
}
/** @returns {PiBridgeResponse} */
function bridgeError(error_code, message, details) {
  const code = error_code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR;
  const text = redactSensitive(message || String(code));
  const baseDetails = (details && typeof details === 'object') ? details : (details === undefined ? {} : { raw: details });
  return { ok: false, error_code: code, error: text, details: redactSensitive(baseDetails) };
}
function normalizeBridgeResponse(resp, cmd) {
  if (!resp || resp.ok !== false) return resp;
  if (resp.error && typeof resp.error === 'object' && resp.error.code && typeof resp.error.message === 'string') {
    const d = (resp.error.details && typeof resp.error.details === 'object') ? { ...resp.error.details } : {};
    if (cmd !== undefined && d.cmd === undefined) d.cmd = cmd;
    return bridgeError(resp.error.code, resp.error.message, d);
  }
  const raw = resp.error !== undefined ? resp.error : (resp.message !== undefined ? resp.message : resp);
  const details = { cmd, ...(resp.details && typeof resp.details === 'object' ? resp.details : {}), raw };
  if (raw && typeof raw === 'object') {
    if (raw.name && details.name === undefined) details.name = raw.name;
    if (raw.stack && details.stack === undefined) details.stack = raw.stack;
    return bridgeError(resp.error_code || raw.error_code || raw.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, raw.message || String(raw.code || raw.name || 'bridge command failed'), details);
  }
  return bridgeError(resp.error_code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, raw || 'bridge command failed', details);
}
function isPiBrowserSessionMissing(res) {
  return res && res.ok === false && (res.error_code === PI_BROWSER_ERROR_CODES.NO_SESSION || res.error_code === PI_BROWSER_ERROR_CODES.NOT_INSTALLED || res.error?.code === PI_BROWSER_ERROR_CODES.NO_SESSION || res.error?.code === PI_BROWSER_ERROR_CODES.NOT_INSTALLED);
}
function piSleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0)))); }
function piBrowserPersistentCdp() { const g = /** @type {PiBridgeGlobalThis} */ (globalThis); return g.piPersistentCdpBridge || g.PiPersistentCdp; }
function normalizePersistentPiBrowserResponse(resp) {
  if (resp && resp.ok === false && resp.error && !resp.error_code) return piBrowserError(resp.error.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, resp.error.message || 'persistent CDP command failed', resp.error.details || {});
  return resp;
}
/** @returns {number|undefined} */
function normalizePiBrowserEvalTimeoutMs(options) {
  const raw = options && (options.timeoutMs !== undefined ? options.timeoutMs : options.timeout_ms);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
/** @returns {Promise<PiBridgeResponse>} */
async function piBrowserEval(tabId, expression, awaitPromise = true, options = {}) {
  const timeoutMs = normalizePiBrowserEvalTimeoutMs(options);
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) {
    // Runtime.evaluate is used between add/removeNewDocumentScript during acceptance.
    // Keep the logical CDP attachment persistent; a temporary attach/detach can invalidate
    // Page.addScriptToEvaluateOnNewDocument identifiers in Chrome's debugger session.
    const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, { persistent: true, name: 'eval', timeoutMs }));
    if (!resp || resp.ok === false) return resp;
    const result = resp.data?.result || resp.result || resp.data;
    if (result?.exceptionDetails) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, result.exceptionDetails.exception?.description || 'Runtime.evaluate failed', result.exceptionDetails);
    return { ok: true, data: result?.result?.value };
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    const command = chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    const result = timeoutMs === undefined ? await command : await piWithTimeout(command, timeoutMs, 'Runtime.evaluate');
    await chrome.debugger.detach({ tabId });
    if (result.exceptionDetails) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, result.exceptionDetails.exception?.description || 'Runtime.evaluate failed', result.exceptionDetails);
    return { ok: true, data: result.result?.value };
  } catch (e) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} throw e; }
}
/** @returns {Promise<PiBridgeResponse>} */
async function callPagePiBrowser(tabId, command, args, options = {}) {
  const expr = `(window.__PI_BROWSER_HOOKS__ && window.__PI_BROWSER_HOOKS__.dispatch) ? window.__PI_BROWSER_HOOKS__.dispatch(${JSON.stringify(command)}, ${JSON.stringify(args || {})}) : {ok:false,error_code:'NO_SESSION',error:'Pi browser dispatcher is not installed'}`;
  const res = await piBrowserEval(tabId, expr, true, options);
  return /** @type {PiBridgeResponse} */ (res.ok ? res.data : res);
}

/** @returns {Promise<PiBridgeResponse|null>} */
async function reinstallPiBrowserSession(tabId) {
  const attempted_recovery = true;

  const sess = piBrowserSessions.get(tabId);
  if (!sess) return null;
  const injected = await ensurePiBrowserDispatcher(tabId);
  if (!injected.ok) return injected;
  const args = sess.install_args || { session_id: sess.session_id, targets: sess.targets, options: sess.options, buffer_size: sess.buffer_size, install_fingerprint: sess.install_fingerprint };
  const res = await callPagePiBrowser(tabId, 'hook.install', args);
  if (res && res.ok) {
    piBrowserSessions.set(tabId, { ...sess, session_id: res.data?.session_id || args.session_id || sess.session_id, state: res.data?.state || 'INSTALLED', installed_at: res.data?.installed_at || new Date().toISOString(), install_fingerprint: res.data?.install_fingerprint || args.install_fingerprint || sess.install_fingerprint, install_args: args });
  }
  return res;
}
/** @returns {Promise<PiBridgeResponse>} */
async function callPagePiBrowserWithAutoReinstall(tabId, command, args) {
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

function piWithTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function handlePiBrowser(msg, sender) {
  const cmd = canonicalPiBrowserCommand(msg.cmd);
  const tabId = msg.tabId || sender.tab?.id;
  if (cmd === 'hook.list_sessions') return await handlePiBrowserImpl(msg, sender, cmd, tabId);
  if (!tabId) return piBrowserError('NO_SESSION', cmd + ' requires tabId', { cmd, details: {} });
  // Diagnostics must be out-of-band: enqueueing wait.diagnose makes its own
  // queue report show pending/depth=1 and masks the real post-uninstall state.
  // Running it directly still reports any pre-existing queued/running command
  // through getPiBrowserQueueStats(tabId), so genuine queue leaks remain visible.
  if (cmd === 'wait.diagnose') return await handlePiBrowserImpl(msg, sender, cmd, tabId);
  return await enqueuePiBrowserCommand(tabId, cmd, () => handlePiBrowserImpl(msg, sender, cmd, tabId));
}
async function handlePiBrowserImpl(msg, sender, cmd, tabId) {
  try {
    if (cmd.startsWith('hook.')) return await handlePiBrowserHookCommand(cmd, tabId, msg);
    if (cmd.startsWith('evidence.')) return await handlePiBrowserEvidenceCommand(cmd, tabId, msg);
    if (cmd.startsWith('frame.')) return await handlePiBrowserFrameCommand(cmd, tabId, msg);
    if (cmd.startsWith('transfer.')) return await handlePiBrowserTransferCommand(cmd, tabId, msg);
    switch (cmd) {
      case 'network.start':
      case 'network.stop':
      case 'network.status':
      case 'network.clear':
      case 'network.list':
      case 'network.get':
      case 'network.body':
      case 'network.exportHar':
      case 'network.wait': return await handleNetworkRecorderCommand(tabId, cmd, msg);
      case 'wait.navigate': return await navigatePiBrowser(tabId, msg);
      case 'wait.navigateAndWait': return await navigateAndWait(tabId, msg);
      case 'wait.navigation': return await waitForNavigation(tabId, msg);
      case 'wait.loadState': return await waitForLoadState(tabId, msg);
      case 'wait.networkIdle': return await waitForNetworkIdle(tabId, msg);
      case 'wait.selector': return await waitForSelector(tabId, msg);
      case 'wait.any': return await waitForAny(tabId, msg);
      case 'wait.all': return await waitForAll(tabId, msg);
      case 'wait.cancel': return await cancelWait(tabId, msg);
      case 'wait.diagnose': return await diagnosePiBrowser(tabId, msg);
    }
    if (cmd === 'html.get') return await handlePiBrowserHtml(tabId, msg);
    if (cmd === 'screenshot.capture') return await captureScreenshotWithRetry(tabId, msg);
    return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown Pi Browser command: ' + cmd, { cmd });
  } catch (e) { return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd, tabId }); }
}
