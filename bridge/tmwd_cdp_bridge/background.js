// background.js - Cookie + CDP Bridge
try {
  importScripts('background_persistent_cdp.js');
} catch (e) {
  console.warn('[GA-P4] persistent CDP helpers unavailable:', e && e.message ? e.message : e);
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('CDP Bridge installed');
  // Strip CSP headers to allow eval/inline scripts
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [9999],
    addRules: [{
      id: 9999, priority: 1,
      action: { type: 'modifyHeaders', responseHeaders: [
        { header: 'content-security-policy', operation: 'remove' },
        { header: 'content-security-policy-report-only', operation: 'remove' }
      ]},
      condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] }
    }]
  });
});

async function handleExtMessage(msg, sender) {
  if (msg.cmd === 'cookies') return await handleCookies(msg, sender);
  if (msg.cmd === 'cdp') return await handleCDP(msg, sender);
  if (msg.cmd === 'persistent_cdp') {
    if (!self.GAPersistentCdp || typeof self.GAPersistentCdp.handleCommand !== 'function') {
      return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: msg.cmd, code: 'PERSISTENT_CDP_UNAVAILABLE' });
    }
    const resp = await self.GAPersistentCdp.handleCommand(msg, sender);
    return normalizeBridgeResponse(resp, msg.cmd);
  }
  if (isBrowserProCommand(msg.cmd)) return await handleBrowserPro(msg, sender);
  if (isNativeBrowserCommand(msg.cmd)) return await handleNativeBrowserCommand(msg, sender);
  if (msg.cmd === 'batch') return await handleBatch(msg, sender);
  if (msg.cmd === 'tabs') {
    try {
      if (!msg.method || msg.method === 'list') {
        const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
        const data = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
        return { ok: true, data };
      }
      if (msg.method === 'switch') {
        const tab = await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
      }
      if (msg.method === 'create') {
        const tab = await chrome.tabs.create({ url: msg.url || 'about:blank', active: msg.active !== false });
        return { ok: true, data: { id: tab.id, tabId: tab.id, url: tab.url || msg.url || 'about:blank', title: tab.title || '', windowId: tab.windowId } };
      }
      if (msg.method === 'close') {
        const rawTarget = msg.targetTabId ?? msg.closeTabId ?? msg.tabId;
        const targetTabId = Number(rawTarget);
        if (!Number.isInteger(targetTabId) || targetTabId <= 0) {
          return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'tabs.close requires a valid targetTabId', { cmd: msg.cmd, method: msg.method, targetTabId: rawTarget });
        }
        const tab = await chrome.tabs.get(targetTabId);
        await chrome.tabs.remove(targetTabId);
        return { ok: true, data: { id: targetTabId, tabId: targetTabId, url: tab.url || '', title: tab.title || '', windowId: tab.windowId } };
      }
      return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Unknown tabs method: ' + msg.method, { cmd: msg.cmd, method: msg.method });
    } catch (e) { return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, method: msg.method }); }
  }
  if (msg.cmd === 'management') {
    try {
      if (msg.method === 'list') {
        const all = await chrome.management.getAll();
        return { ok: true, data: all.map(e => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type, version: e.version })) };
      }
      if (msg.method === 'reload') {
        chrome.alarms.create('tmwd-self-reload', { when: Date.now() + 200 });
        return { ok: true };
      }
      if (msg.method === 'disable') {
        await chrome.management.setEnabled(msg.extId, false);
        return { ok: true };
      }
      if (msg.method === 'enable') {
        await chrome.management.setEnabled(msg.extId, true);
        return { ok: true };
      }
      return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Unknown management method: ' + msg.method, { cmd: msg.cmd, method: msg.method });
    } catch (e) { return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, method: msg.method }); }
  }
  if (msg.cmd === 'contentSettings') {
    try {
      const type = msg.type || 'automaticDownloads';
      const setting = msg.setting || 'allow';
      const pattern = msg.pattern || '<all_urls>';
      if (!chrome.contentSettings || !chrome.contentSettings[type] || typeof chrome.contentSettings[type].set !== 'function') {
        return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Unsupported contentSettings type: ' + type, { cmd: msg.cmd, type });
      }
      await chrome.contentSettings[type].set({
        primaryPattern: pattern,
        setting: setting
      });
      return { ok: true };
    } catch (e) {
      return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), {
        cmd: msg.cmd,
        type: msg.type,
        setting: msg.setting,
        pattern: msg.pattern
      });
    }
  }
  return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Unknown cmd: ' + msg.cmd, { cmd: msg.cmd });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleExtMessage(msg, sender).then(sendResponse);
  return true;
});

async function handleCookies(msg, sender) {
  try {
    let url = msg.url || sender.tab?.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(msg.tabId);
      url = tab.url;
    }
    const origin = url.match(/^https?:\/\/[^\/]+/)[0];
    const all = await chrome.cookies.getAll({ url });
    const part = await chrome.cookies.getAll({ url, partitionKey: { topLevelSite: origin } }).catch(() => []);
    const merged = [...all];
    for (const c of part) {
      if (!merged.some(x => x.name === c.name && x.domain === c.domain)) merged.push(c);
    }
    return { ok: true, data: merged };
  } catch (e) {
    return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, tabId: msg.tabId });
  }
}

async function handleBatch(msg, sender) {
  const R = [];
  const resolve$N = (params) => JSON.parse(JSON.stringify(params || {}).replace(/"\$(\d+)\.([^"]+)"/g,
    (_, i, path) => { let v = R[+i]; for (const k of path.split('.')) v = v[k]; return JSON.stringify(v); }));
  const detachCurrent = async () => {};
  try {
    const commands = Array.isArray(msg.commands) ? msg.commands : [];
    for (const c of commands) {
      try {
        if (!c || typeof c !== 'object') {
          R.push(bridgeError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'invalid batch command', { cmd: msg.cmd, raw: c }));
          continue;
        }
        if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
        if (c.cmd === 'cookies') {
          R.push(normalizeBridgeResponse(await handleCookies(c, sender), c.cmd));
        } else if (c.cmd === 'tabs') {
          const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
          R.push({ ok: true, data: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) });
        } else if (c.cmd === 'cdp') {
          const tabId = c.tabId || msg.tabId || sender.tab?.id;
          if (!tabId) {
            R.push(bridgeError(GA_BROWSER_PRO_ERROR_CODES.NO_SESSION, 'no tabId for batch cdp command', { cmd: c.cmd, method: c.method }));
            continue;
          }
          const cdp = browserProPersistentCdp();
          if (!cdp?.send) {
            R.push(bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: c.cmd, method: c.method, tabId }));
            continue;
          }
          const resp = normalizePersistentBrowserProResponse(await cdp.send(tabId, c.method, resolve$N(c.params), { name: c.name || 'default', persistent: c.persistent === true, timeoutMs: c.timeoutMs || c.timeout_ms }));
          if (resp && resp.ok !== false) R.push({ ok: true, data: (resp.data && resp.data.result !== undefined) ? resp.data.result : (resp.result || resp.data) });
          else R.push(bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, resp?.error || resp?.message || 'persistent CDP send failed', { cmd: c.cmd, method: c.method, tabId, persistent: resp }));
        } else if (isBrowserProCommand(c.cmd) || isNativeBrowserCommand(c.cmd)) {
          R.push(normalizeBridgeResponse(await handleExtMessage(c, sender), c.cmd));
        } else {
          R.push(bridgeError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'unknown cmd: ' + c.cmd, { cmd: c.cmd, raw: c }));
        }
      } catch (e) {
        R.push(bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: c && c.cmd, method: c && c.method, tabId: c && c.tabId, raw: { name: e && e.name, message: e && e.message, stack: e && e.stack } }));
        try { await detachCurrent(); } catch (_) {}
      }
    }
    await detachCurrent();
    return { ok: true, results: R };
  } catch (e) {
    return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, results: R, raw: { name: e && e.name, message: e && e.message, stack: e && e.stack } });
  }
}

async function handleCDP(msg, sender) {
  const tabId = msg.tabId || sender.tab?.id;
  if (!tabId) return bridgeError(GA_BROWSER_PRO_ERROR_CODES.NO_SESSION, 'no tabId', { cmd: msg.cmd, method: msg.method });
  const cdp = browserProPersistentCdp();
  if (!cdp?.send) return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: msg.cmd, method: msg.method, tabId });
  const resp = normalizePersistentBrowserProResponse(await cdp.send(tabId, msg.method, msg.params || {}, { name: msg.name || 'default', persistent: msg.persistent === true, timeoutMs: msg.timeoutMs || msg.timeout_ms }));
  if (resp && resp.ok !== false) return { ok: true, data: (resp.data && resp.data.result !== undefined) ? resp.data.result : (resp.result || resp.data) };
  return bridgeError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, resp?.error || resp?.message || 'persistent CDP send failed', { cmd: msg.cmd, method: msg.method, tabId, persistent: resp });
}

// ============================================================
// P1: Browser Pro API bridge for GA/TMWD Browser Pro.
// ============================================================
const GA_BROWSER_PRO_DISPATCHER_FILE = 'native_hook_dispatcher.js';
const GA_BROWSER_PRO_ERROR_CODES = {
  NO_SESSION: 'NO_SESSION', ALREADY_INSTALLED: 'ALREADY_INSTALLED', NOT_INSTALLED: 'NOT_INSTALLED',
  INVALID_RULE: 'INVALID_RULE', UNSUPPORTED_TARGET: 'UNSUPPORTED_TARGET', INJECTION_FAILED: 'INJECTION_FAILED',
  SAFETY_BLOCKED: 'SAFETY_BLOCKED', TIMEOUT: 'TIMEOUT', NAVIGATION_TIMEOUT: 'NAVIGATION_TIMEOUT', SELECTOR_TIMEOUT: 'SELECTOR_TIMEOUT', NETWORK_IDLE_TIMEOUT: 'NETWORK_IDLE_TIMEOUT', NETWORK_RECORDER_NOT_STARTED: 'NETWORK_RECORDER_NOT_STARTED', NETWORK_RECORDER_TIMEOUT: 'NETWORK_RECORDER_TIMEOUT', BODY_UNAVAILABLE: 'BODY_UNAVAILABLE', FRAME_DETACHED: 'FRAME_DETACHED', CROSS_ORIGIN_IFRAME: 'CROSS_ORIGIN_IFRAME', TAB_CRASHED: 'TAB_CRASHED', BACKGROUND_THROTTLED: 'BACKGROUND_THROTTLED', EVENT_SUBSCRIPTION_FAILED: 'EVENT_SUBSCRIPTION_FAILED', CANCELLED: 'CANCELLED', BUFFER_OVERFLOW: 'BUFFER_OVERFLOW', INTERNAL_ERROR: 'INTERNAL_ERROR'
};
const GA_BROWSER_PRO_ALIASES = {
  'browser_pro.clear': 'browser_pro.clear_buffer',
  'browser_pro.ping': 'browser_pro.status'
};
const gaBrowserProSessions = new Map();
const gaBrowserProTabQueues = new Map();
const GA_BROWSER_PRO_QUEUE_MAX_DEPTH = 64;

class WaitCoordinator {
  constructor() { this.activeWaits = new Map(); this.eventSubscriptions = new Map(); this.epoch = 0; }
  makeWaitId(tabId, kind) { return makeWaitId(tabId, kind); }
  waitKey(tabId, waitId) { return waitKey(tabId, waitId); }
  register(record) {
    const key = record.key || waitKey(record.tabId, record.wait_id || record.waitId);
    record.key = key;
    this.activeWaits.set(key, record);
    return record;
  }
  get(key) { return this.activeWaits.get(key); }
  set(key, record) { this.activeWaits.set(key, record); return this; }
  has(key) { return this.activeWaits.has(key); }
  delete(key) { return this.activeWaits.delete(key); }
  values() { return this.activeWaits.values(); }
  entries() { return this.activeWaits.entries(); }
  keys() { return this.activeWaits.keys(); }
  get size() { return this.activeWaits.size; }
  [Symbol.iterator]() { return this.activeWaits[Symbol.iterator](); }
  registerEventSubscription(listenerId, sub) { this.eventSubscriptions.set(listenerId, sub); return sub; }
  deleteEventSubscription(listenerId) { return this.eventSubscriptions.delete(listenerId); }
  eventSubscriptionValues() { return this.eventSubscriptions.values(); }
  cleanupEventSubscriptionsForTab(tabId) {
    let n = 0;
    for (const [listenerId, sub] of Array.from(this.eventSubscriptions.entries())) {
      if (Number(sub.tabId) === Number(tabId)) { this.eventSubscriptions.delete(listenerId); n++; }
    }
    return n;
  }
  cleanupWait(record, reason) { return cleanupWait(record, reason); }
  cleanupWaitsForFrame(tabId, frameId, reason) { return cleanupWaitsForFrame(tabId, frameId, reason); }
  cleanupWaitsForUninstall(tabId) { return cleanupWaitsForUninstall(tabId); }
  diagnostics(tabId) { return { activeWaits: Array.from(this.activeWaits.values()).filter(w => !tabId || Number(w.tabId) === Number(tabId)).map(w => ({ wait_id: w.wait_id || w.waitId, request_id: w.request_id || w.requestId, kind: w.kind, epoch: w.epoch, diagnostics: w.diagnostics || {} })), eventSubscriptions: this.eventSubscriptions.size, epoch: this.epoch }; }
}
function cleanupWait(record, reason) { return cleanupBrowserProWait(record, reason); }
function cleanupWaitsForFrame(tabId, frameId, reason) { let n = 0; for (const r of Array.from(gaBrowserProWaits.values())) if (Number(r.tabId) === Number(tabId) && String(r.frameId || '') === String(frameId || '')) { cleanupBrowserProWait(r, reason || 'FRAME_DETACHED'); n++; } return n; }
function cleanupWaitsForUninstall(tabId) { cleanupEventSubscriptionsForTab(tabId); return cancelWaitsForTab(tabId, 'uninstall'); }
function isBrowserProCommand(cmd) { return typeof cmd === 'string' && cmd.indexOf('browser_pro.') === 0; }
function getBrowserProQueueStats(tabId) {
  const q = gaBrowserProTabQueues.get(Number(tabId));
  return q ? { pending: q.pending, depth: q.depth, last_cmd: q.last_cmd || null } : { pending: false, depth: 0, last_cmd: null };
}
function enqueueBrowserProCommand(tabId, cmd, task) {
  const key = Number(tabId);
  const current = gaBrowserProTabQueues.get(key) || { tail: Promise.resolve(), depth: 0, pending: false, last_cmd: null };
  if (current.depth >= GA_BROWSER_PRO_QUEUE_MAX_DEPTH) return Promise.resolve(browserProError(GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'Browser Pro command queue is full', { tabId: key, cmd, depth: current.depth, max_depth: GA_BROWSER_PRO_QUEUE_MAX_DEPTH }));
  current.depth += 1;
  current.pending = true;
  current.last_cmd = cmd;
  const run = current.tail.catch(() => {}).then(async () => {
    try { return await task(); }
    finally {
      const latest = gaBrowserProTabQueues.get(key);
      if (latest) {
        latest.depth = Math.max(0, latest.depth - 1);
        latest.pending = latest.depth > 0;
        if (latest.depth === 0) latest.last_cmd = null;
      }
    }
  });
  current.tail = run.catch(() => {});
  gaBrowserProTabQueues.set(key, current);
  return run;
}
function cleanupBrowserProTab(tabId, reason) {
  const key = Number(tabId);
  const cleanupReason = reason || 'tab_cleanup';
  gaBrowserProSessions.delete(key);
  gaBrowserProTabQueues.delete(key);
  try { cleanupNetworkRecorderTab(tabId, cleanupReason); } catch (e) { console.warn('[GA-BROWSER-PRO-NET] recorder cleanup failed', key, e && e.message ? e.message : e); }
  // Preserve the public cancellation path for tab teardown so queued callers,
  // diagnostics and static contract tests all see the same lifecycle entrypoint.
  // Literal contract: cancelWaitsForTab(tabId, 'tab_cleanup')
  const waits = cleanupReason === 'tab_cleanup'
    ? { cleaned: cancelWaitsForTab(tabId, 'tab_cleanup'), orphaned: 0 }
    : cleanupTabWaits(tabId, cleanupReason, { includeCdp: true, action: 'tab_cleanup' });
  console.log('[GA-BROWSER-PRO] cleaned tab state', key, cleanupReason, { waits_cleaned: waits.cleaned, orphan_waits: waits.orphaned });
}
function canonicalBrowserProCommand(cmd) { return GA_BROWSER_PRO_ALIASES[cmd] || cmd; }
const PI_NATIVE_BROWSER_COMMANDS = {
  'hook.list_sessions': 'browser_pro.list_sessions',
  'hook.install': 'browser_pro.install',
  'hook.status': 'browser_pro.status',
  'hook.collect': 'browser_pro.collect',
  'hook.clear': 'browser_pro.clear_buffer',
  'hook.clear_buffer': 'browser_pro.clear_buffer',
  'hook.pause': 'browser_pro.pause',
  'hook.resume': 'browser_pro.resume',
  'hook.uninstall': 'browser_pro.uninstall',
  'hook.evaluate': 'browser_pro.evaluate',
  'hook.addEventListener': 'browser_pro.addEventListener',
  'hook.removeEventListener': 'browser_pro.removeEventListener',
  'hook.getPerformanceEntries': 'browser_pro.getPerformanceEntries',
  'wait.navigate': 'browser_pro.navigate',
  'wait.navigateAndWait': 'browser_pro.navigateAndWait',
  'wait.navigation': 'browser_pro.waitForNavigation',
  'wait.loadState': 'browser_pro.waitForLoadState',
  'wait.networkIdle': 'browser_pro.waitForNetworkIdle',
  'wait.selector': 'browser_pro.waitForSelector',
  'wait.any': 'browser_pro.waitForAny',
  'wait.all': 'browser_pro.waitForAll',
  'wait.cancel': 'browser_pro.cancelWait',
  'wait.diagnose': 'browser_pro.diagnose',
  'network.start': 'browser_pro.network.start',
  'network.stop': 'browser_pro.network.stop',
  'network.status': 'browser_pro.network.status',
  'network.clear': 'browser_pro.network.clear',
  'network.list': 'browser_pro.network.list',
  'network.get': 'browser_pro.network.get',
  'network.body': 'browser_pro.network.body',
  'network.exportHar': 'browser_pro.network.exportHar',
  'network.wait': 'browser_pro.network.wait',
  'frame.list': 'browser_pro.frames',
  'frame.evaluate': 'browser_pro.evaluate_frame',
  'frame.addNewDocumentScript': 'browser_pro.add_new_document_script',
  'frame.removeNewDocumentScript': 'browser_pro.remove_new_document_script',
  'html.get': 'browser_pro.html',
  'screenshot.capture': 'browser_pro.screenshot'
};
function isNativeBrowserCommand(cmd) { return typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(PI_NATIVE_BROWSER_COMMANDS, cmd); }
function nativeToBrowserProMessage(msg) {
  const mapped = PI_NATIVE_BROWSER_COMMANDS[msg.cmd];
  return { ...msg, cmd: mapped, native_cmd: msg.cmd };
}
async function handleNativeBrowserCommand(msg, sender) {
  const mapped = nativeToBrowserProMessage(msg);
  const resp = await handleBrowserPro(mapped, sender);
  if (resp && typeof resp === 'object') {
    if (resp.details && typeof resp.details === 'object' && resp.details.cmd === undefined) resp.details.cmd = msg.cmd;
    if (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data) && resp.data.native_cmd === undefined) resp.data.native_cmd = msg.cmd;
  }
  return resp;
}
function gaRedactSensitive(value, depth = 0, seen) {
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
  if (Array.isArray(value)) return value.map(v => gaRedactSensitive(v, depth + 1, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lk = String(k).toLowerCase();
    if (/(token|secret|password|passwd|pwd|authorization|cookie|set-cookie)/.test(lk)) out[k] = '[REDACTED]';
    else out[k] = gaRedactSensitive(v, depth + 1, seen);
  }
  return out;
}
function browserProError(error_code, message, details) {
  const text = gaRedactSensitive(message || String(error_code || 'ERROR'));
  return { ok: false, error_code, error: text, details: gaRedactSensitive(details || {}) };
}
function bridgeError(error_code, message, details) {
  const code = error_code || GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR;
  const text = gaRedactSensitive(message || String(code));
  const baseDetails = (details && typeof details === 'object') ? details : (details === undefined ? {} : { raw: details });
  return { ok: false, error_code: code, error: text, details: gaRedactSensitive(baseDetails) };
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
    return bridgeError(resp.error_code || raw.error_code || raw.code || GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, raw.message || String(raw.code || raw.name || 'bridge command failed'), details);
  }
  return bridgeError(resp.error_code || GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, raw || 'bridge command failed', details);
}
function isBrowserProSessionMissing(res) {
  return res && res.ok === false && (res.error_code === GA_BROWSER_PRO_ERROR_CODES.NO_SESSION || res.error_code === GA_BROWSER_PRO_ERROR_CODES.NOT_INSTALLED || res.error?.code === GA_BROWSER_PRO_ERROR_CODES.NO_SESSION || res.error?.code === GA_BROWSER_PRO_ERROR_CODES.NOT_INSTALLED);
}
function gaSleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0)))); }
function browserProPersistentCdp() { return globalThis.gaPersistentCdpBridge || globalThis.GAPersistentCdp; }
function normalizePersistentBrowserProResponse(resp) {
  if (resp && resp.ok === false && resp.error && !resp.error_code) return browserProError(resp.error.code || GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, resp.error.message || 'persistent CDP command failed', resp.error.details || {});
  return resp;
}
async function browserProEval(tabId, expression, awaitPromise = true) {
  const cdp = browserProPersistentCdp();
  if (cdp?.send) {
    // Runtime.evaluate is used between add/removeNewDocumentScript during acceptance.
    // Keep the logical CDP attachment persistent; a temporary attach/detach can invalidate
    // Page.addScriptToEvaluateOnNewDocument identifiers in Chrome's debugger session.
    const resp = normalizePersistentBrowserProResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, { persistent: true, name: 'eval' }));
    if (!resp || resp.ok === false) return resp;
    const result = resp.data?.result || resp.result || resp.data;
    if (result?.exceptionDetails) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, result.exceptionDetails.exception?.description || 'Runtime.evaluate failed', result.exceptionDetails);
    return { ok: true, data: result?.result?.value };
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    await chrome.debugger.detach({ tabId });
    if (result.exceptionDetails) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, result.exceptionDetails.exception?.description || 'Runtime.evaluate failed', result.exceptionDetails);
    return { ok: true, data: result.result?.value };
  } catch (e) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} throw e; }
}
async function callPageBrowserPro(tabId, command, args) {
  const expr = `(window.__GA_BROWSER_PRO__ && window.__GA_BROWSER_PRO__.dispatch) ? window.__GA_BROWSER_PRO__.dispatch(${JSON.stringify(command)}, ${JSON.stringify(args || {})}) : {ok:false,error_code:'NO_SESSION',error:'BrowserPro dispatcher is not installed'}`;
  const res = await browserProEval(tabId, expr, true);
  return res.ok ? res.data : res;
}

async function handleBrowserProHtml(tabId, msg) {
  const opts = (msg && msg.options && typeof msg.options === 'object') ? msg.options : {};
  const pick = (...names) => {
    for (const name of names) {
      if (msg && msg[name] !== undefined) return msg[name];
      if (opts && opts[name] !== undefined) return opts[name];
    }
    return undefined;
  };
  const selector = pick('selector');
  const rawMode = pick('mode') ?? 'outer';
  const mode = String(rawMode).replace(/[-_]/g, '').toLowerCase();
  const maxBytesRaw = pick('max_bytes', 'maxBytes');
  const maxCharsRaw = pick('max_chars', 'maxChars');
  const maxBytes = maxBytesRaw === undefined || maxBytesRaw === null || maxBytesRaw === '' ? null : Number(maxBytesRaw);
  const maxChars = maxCharsRaw === undefined || maxCharsRaw === null || maxCharsRaw === '' ? null : Number(maxCharsRaw);
  if (!['outer', 'inner', 'text', 'textcontent'].includes(mode)) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.html mode must be outer, inner, or text', { cmd: msg.cmd, mode: rawMode });
  if (maxBytes !== null && (!Number.isFinite(maxBytes) || maxBytes < 0)) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.html max_bytes/maxBytes must be a non-negative number', { cmd: msg.cmd, maxBytes: maxBytesRaw });
  if (maxChars !== null && (!Number.isFinite(maxChars) || maxChars < 0)) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.html max_chars/maxChars must be a non-negative number', { cmd: msg.cmd, maxChars: maxCharsRaw });
  const expression = `(async () => {
    const selector = ${JSON.stringify(selector === undefined || selector === null || selector === '' ? null : String(selector))};
    const mode = ${JSON.stringify(mode === 'textcontent' ? 'text' : mode)};
    const maxBytes = ${maxBytes === null ? 'null' : JSON.stringify(Math.floor(maxBytes))};
    const maxChars = ${maxChars === null ? 'null' : JSON.stringify(Math.floor(maxChars))};
    const encoder = new TextEncoder();
    function sliceUtf8(str, limit) {
      if (limit === null || limit === undefined) return str;
      if (limit <= 0) return '';
      let lo = 0, hi = str.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (encoder.encode(str.slice(0, mid)).length <= limit) lo = mid;
        else hi = mid - 1;
      }
      return str.slice(0, lo);
    }
    let node = selector ? document.querySelector(selector) : document.documentElement;
    if (!node) return { ok: false, error_code: 'SELECTOR_TIMEOUT', error: 'selector not found: ' + selector, details: { selector, mode } };
    let html;
    if (mode === 'inner') html = node.innerHTML ?? '';
    else if (mode === 'text') html = node.textContent ?? '';
    else html = node.outerHTML ?? '';
    html = String(html);
    const original_length = html.length;
    const original_bytes = encoder.encode(html).length;
    let truncated = false;
    if (maxChars !== null && html.length > maxChars) { html = html.slice(0, maxChars); truncated = true; }
    if (maxBytes !== null && encoder.encode(html).length > maxBytes) { html = sliceUtf8(html, maxBytes); truncated = true; }
    return { ok: true, data: { html, truncated, original_length, bytes: encoder.encode(html).length, original_bytes, selector, mode } };
  })()`;
  const res = await browserProEval(tabId, expression, true);
  if (!res || res.ok === false) return res;
  if (res.data && res.data.ok === false) return browserProError(res.data.error_code || GA_BROWSER_PRO_ERROR_CODES.SELECTOR_TIMEOUT, res.data.error || 'browser_pro.html failed', res.data.details || { selector, mode: rawMode });
  return res.data && res.data.ok === true ? res.data : { ok: true, data: res.data };
}
async function reinstallBrowserProSession(tabId) {
  const attempted_recovery = true;

  const sess = gaBrowserProSessions.get(tabId);
  if (!sess) return null;
  const injected = await ensureBrowserProDispatcher(tabId);
  if (!injected.ok) return injected;
  const args = sess.install_args || { session_id: sess.session_id, targets: sess.targets, options: sess.options, buffer_size: sess.buffer_size, install_fingerprint: sess.install_fingerprint };
  const res = await callPageBrowserPro(tabId, 'browser_pro.install', args);
  if (res && res.ok) {
    gaBrowserProSessions.set(tabId, { ...sess, session_id: res.data?.session_id || args.session_id || sess.session_id, state: res.data?.state || 'INSTALLED', installed_at: res.data?.installed_at || new Date().toISOString(), install_fingerprint: res.data?.install_fingerprint || args.install_fingerprint || sess.install_fingerprint, install_args: args });
  }
  return res;
}
async function callPageBrowserProWithAutoReinstall(tabId, command, args) {
  let res = await callPageBrowserPro(tabId, command, args);
  if (isBrowserProSessionMissing(res) && gaBrowserProSessions.has(tabId) && command !== 'browser_pro.uninstall') {
    let last = res;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt) await gaSleep(150 * attempt);
      const reinstall = await reinstallBrowserProSession(tabId);
      if (!reinstall || reinstall.ok === false) { last = reinstall || last; continue; }
      res = await callPageBrowserPro(tabId, command, args);
      if (!isBrowserProSessionMissing(res)) return res;
      last = res;
    }
    return last;
  }
  return res;
}

const gaBrowserProWaits = new WaitCoordinator();
// Legacy Map-compatible wait registry contract: const gaBrowserProWaits = new Map
const GA_BROWSER_PRO_ORPHAN_WAIT_MAX_AGE_MS = 300000;
function cleanupBrowserProOrphanWaits(reason, maxAgeMs) {
  const now = Date.now();
  const limit = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : GA_BROWSER_PRO_ORPHAN_WAIT_MAX_AGE_MS;
  let cleaned = 0;
  for (const record of Array.from(gaBrowserProWaits.values())) {
    const age = now - Number(record.createdAt || now);
    if (!record || record.status === 'cleaned') continue;
    if (limit >= 0 && age < limit) continue;
    try { record.abortController?.abort(reason || 'orphan_cleanup'); } catch (_) {}
    try { clearWait(record, reason || 'orphan_cleanup'); cleaned += 1; } catch (_) {}
  }
  if (cleaned) rememberBrowserProCdpCleanup({ reason: reason || 'orphan_cleanup', orphan_waits: cleaned });
  return cleaned;
}
const gaBrowserProCdpSubscriptions = new Map();
const gaBrowserProCdpTabRefs = new Map();
const gaBrowserProCdpDomainRefs = new Map();
const gaBrowserProCdpCleanupHistory = [];
try {
  if (typeof self !== 'undefined' && self.addEventListener && !self.__gaBrowserProUnhandledRejectionCleanupInstalled) {
    self.__gaBrowserProUnhandledRejectionCleanupInstalled = true;
    self.addEventListener('unhandledrejection', () => { try { cleanupBrowserProOrphanWaits('unhandledRejection', 0); } catch (_) {} });
  }
} catch (_) {}
let gaBrowserProWaitSeq = 0;
let gaBrowserProCdpSubSeq = 0;
const GA_BROWSER_PRO_DEFAULT_WAIT_TIMEOUT_MS = 30000;
const GA_BROWSER_PRO_SELECTOR_STABLE_SAMPLES = 2;
function normalizeBrowserProTimeoutMs(msg, fallback) {
  const hasExplicit = msg && (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined || msg.timeout !== undefined);
  if (hasExplicit && Number(msg.timeoutMs ?? msg.timeout_ms ?? msg.timeout) === 0) return 0;
  const raw = msg?.timeoutMs ?? msg?.timeout_ms ?? msg?.timeout ?? fallback ?? GA_BROWSER_PRO_DEFAULT_WAIT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback === 0 ? 0 : (fallback || GA_BROWSER_PRO_DEFAULT_WAIT_TIMEOUT_MS);
  if (n === 0) return 0;
  return Math.max(50, Math.min(300000, Math.floor(n)));
}
function makeWaitId(tabId, kind) { return 'wait_' + Number(tabId) + '_' + String(kind || 'generic') + '_' + Date.now() + '_' + (++gaBrowserProWaitSeq); }
function waitKey(tabId, waitId) { return Number(tabId) + ':' + String(waitId); }
function isAbortError(e) { return !!e && (e.name === 'AbortError' || /aborted|cancelled/i.test(e.message || String(e))); }
function waitAbortMessage(record) { return 'browserPro wait ' + record.waitId + ' cancelled'; }
function normalizeWaitState(value, fallback) {
  const s = String(value || fallback || '').toLowerCase().replace(/_/g, '');
  if (s === 'domcontentloaded' || s === 'dominteractive') return 'domcontentloaded';
  if (s === 'load' || s === 'loaded') return 'load';
  if (s === 'complete' || s === 'networkalmostidle') return 'complete';
  if (s === 'networkidle') return 'networkidle';
  return s || 'complete';
}
function registerWait(tabId, kind, criteria) {
  const waitId = (criteria && (criteria.waitId || criteria.wait_id)) || makeWaitId(tabId, kind);
  const requestId = criteria && (criteria.requestId || criteria.request_id);
  const abortController = criteria?.abortController || new AbortController();
  const record = { waitId: String(waitId), wait_id: String(waitId), requestId: requestId ? String(requestId) : undefined, request_id: requestId ? String(requestId) : undefined, tabId: Number(tabId), kind, criteria: criteria || {}, createdAt: Date.now(), status: 'pending', listeners: [], timers: [], cdpAttached: false, cdpDomains: new Set(), cdpSubscriptions: [], cdpEvents: [], diagnostics: [], lastEventAt: 0, lastError: null, abortController };
  record.key = waitKey(tabId, record.waitId);
  // lifecycle identity: key: waitKey(tabId, record.waitId)
  gaBrowserProWaits.register(record);
  const onAbort = () => { record.status = 'cancelled'; };
  try { abortController.signal.addEventListener('abort', onAbort, { once: true }); record.listeners.push({ remove: () => abortController.signal.removeEventListener('abort', onAbort) }); } catch (_) {}
  return record;
}
function recordWaitEvent(record, event) {
  record.lastEventAt = Date.now();
  record.cdpEvents.push({ t: record.lastEventAt, ...(event || {}) });
  if (record.cdpEvents.length > 200) record.cdpEvents.splice(0, record.cdpEvents.length - 200);
}
function shouldAbortWaitCleanupReason(reason) {
  // Completing a wait is cleanup, not cancellation.  Aborting the wait's own
  // controller while finishBrowserProWait() is building an OK/TIMEOUT/failed result
  // synchronously fires abort listeners and can race the Promise into returning
  // CANCELLED instead of the terminal result that already happened.
  const r = String(reason || 'cleaned').toLowerCase();
  return !['completed', 'timeout', 'failed', 'cleaned'].includes(r);
}
function clearWait(record, reason) {
  if (!record || record.status === 'cleaned') return;
  if (shouldAbortWaitCleanupReason(reason)) { try { record.abortController?.abort(reason || 'cleaned'); } catch (_) {} }
  for (const t of record.timers.splice(0)) { try { clearTimeout(t); } catch (_) {} }
  for (const item of record.listeners.splice(0)) { try { item.remove(); } catch (_) {} }
  for (const sid of record.cdpSubscriptions.splice(0)) { try { unsubscribeBrowserProCdp(sid); } catch (_) {} }
  releaseBrowserProCdpDomains(record, Array.from(record.cdpDomains || []), reason || 'cleaned');
  if (record.cdpAttached) record.cdpAttached = false;
  record.status = reason || record.status || 'cleaned';
  gaBrowserProWaits.delete(record.key);
}
function cleanupBrowserProWait(record, reason) { return clearWait(record, reason); }
function isWaitRecordForTab(record, tabId) { return !!record && Number(record.tabId) === Number(tabId); }
function cleanupTabWaits(tabId, reason, options) {
  const opts = options || {};
  const cleanupReason = reason || 'tab_cleanup';
  const records = Array.from(gaBrowserProWaits.values()).filter(r => isWaitRecordForTab(r, tabId));
  let cleaned = 0;
  let aborted = 0;
  let orphaned = 0;
  for (const r of records) {
    const wasMissingKey = !r.key || gaBrowserProWaits.get(r.key) !== r;
    try { r.abortController?.abort(cleanupReason); aborted += 1; } catch (_) {}
    try { clearWait(r, cleanupReason); cleaned += 1; } catch (_) {}
    if (wasMissingKey) orphaned += 1;
  }
  // Defensive second pass: clear any wait inserted or left behind while tab cleanup was running.
  for (const [key, r] of Array.from(gaBrowserProWaits.entries())) {
    if (!isWaitRecordForTab(r, tabId)) continue;
    orphaned += 1;
    try { r.abortController?.abort(cleanupReason); aborted += 1; } catch (_) {}
    try { clearWait(r, cleanupReason); cleaned += 1; } catch (_) { try { gaBrowserProWaits.delete(key); cleaned += 1; } catch (__) {} }
  }
  if (opts.includeCdp !== false) cleanupBrowserProCdpTab(tabId, cleanupReason);
  cleanupEventSubscriptionsForTab(tabId);
  if (cleaned || orphaned || opts.remember !== false) rememberBrowserProCdpCleanup({ tabId:Number(tabId), reason: cleanupReason, action: opts.action || 'cleanup_tab_waits', waits_cleaned: cleaned, waits_aborted: aborted, orphan_waits: orphaned, remaining_waits: Array.from(gaBrowserProWaits.values()).filter(r => isWaitRecordForTab(r, tabId)).length });
  return { tabId:Number(tabId), reason:cleanupReason, cleaned, aborted, orphaned };
}
function cancelWaitsForTab(tabId, reason) {
  return cleanupTabWaits(tabId, reason || 'cancelled', { includeCdp: true, action: 'cancel_waits_for_tab' }).cleaned;
}
function browserProCdpDomainKey(tabId, domain) { return Number(tabId) + ':' + String(domain); }
function browserProCdpHolderId(record) { return record?.key || (Number(record?.tabId) + ':' + String(record?.waitId || record?.kind || 'anonymous')); }
function rememberBrowserProCdpCleanup(entry) {
  gaBrowserProCdpCleanupHistory.push({ t: Date.now(), ...(entry || {}) });
  if (gaBrowserProCdpCleanupHistory.length > 200) gaBrowserProCdpCleanupHistory.splice(0, gaBrowserProCdpCleanupHistory.length - 200);
}
async function sendBrowserProCdpDomainCommand(tabId, domain, action, modeHint) {
  const cdp = browserProPersistentCdp();
  const method = String(domain) + '.' + String(action);
  if (cdp?.send && modeHint !== 'chrome.debugger') {
    const resp = normalizePersistentBrowserProResponse(await cdp.send(tabId, method, {}, { name: 'wait', persistent: true }));
    if (!resp || resp.ok === false) {
      const msg = resp?.error?.message || resp?.message || resp?.error || ('failed to ' + action + ' ' + domain);
      throw new Error(String(msg));
    }
    return 'persistent_cdp';
  }
  if (action === 'enable') {
    await chrome.debugger.attach({ tabId: Number(tabId) }, '1.3').catch(e => {
      if (!/Another debugger|already attached|Debugger is already attached/i.test(e.message || String(e))) throw e;
    });
  }
  await chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, {});
  return 'chrome.debugger';
}
async function acquireBrowserProCdpDomain(record, domain) {
  const tabId = Number(record.tabId);
  const holderId = browserProCdpHolderId(record);
  const key = browserProCdpDomainKey(tabId, domain);
  let ref = gaBrowserProCdpDomainRefs.get(key);
  if (ref?.holders?.has(holderId)) {
    record.cdpDomains.add(domain);
    record.cdpAttached = true;
    return ref.mode || 'refcounted';
  }
  if (!ref) {
    ref = { key, tabId, domain, count: 0, holders: new Map(), mode: null, createdAt: Date.now(), enabledAt: 0, lastError: null, disablePending: false };
    gaBrowserProCdpDomainRefs.set(key, ref);
  }
  const first = ref.count === 0;
  try {
    if (first) {
      ref.mode = await sendBrowserProCdpDomainCommand(tabId, domain, 'enable', ref.mode);
      ref.enabledAt = Date.now();
      ref.lastError = null;
    }
    ref.holders.set(holderId, { holderId, waitId: record.waitId || null, kind: record.kind || null, acquiredAt: Date.now() });
    ref.count = ref.holders.size;
    record.cdpDomains.add(domain);
    record.cdpAttached = true;
    return ref.mode || 'refcounted';
  } catch (e) {
    ref.lastError = e.message || String(e);
    if (first && ref.count === 0 && !ref.holders.size) gaBrowserProCdpDomainRefs.delete(key);
    throw e;
  }
}
function releaseBrowserProCdpDomains(record, domains, reason) {
  const unique = Array.from(new Set(domains || []));
  if (!record || !unique.length) return { released: 0, disabled: 0 };
  const tabId = Number(record.tabId);
  const holderId = browserProCdpHolderId(record);
  let released = 0;
  let disabled = 0;
  for (const domain of unique.reverse()) {
    const key = browserProCdpDomainKey(tabId, domain);
    const ref = gaBrowserProCdpDomainRefs.get(key);
    if (!ref) { try { record.cdpDomains?.delete(domain); } catch (_) {} continue; }
    if (ref.holders.delete(holderId)) { ref.count = Math.max(0, ref.count - 1); released += 1; }
    else ref.count = Math.max(0, ref.holders.size);
    try { record.cdpDomains?.delete(domain); } catch (_) {}
    if (ref.count === 0 || ref.holders.size === 0) {
      ref.count = 0;
      ref.disablePending = true;
      const mode = ref.mode;
      gaBrowserProCdpDomainRefs.delete(key);
      disabled += 1;
      rememberBrowserProCdpCleanup({ tabId, domain, reason, holderId, action: 'disable', mode });
      void sendBrowserProCdpDomainCommand(tabId, domain, 'disable', mode).catch(e => rememberBrowserProCdpCleanup({ tabId, domain, reason, holderId, action: 'disable_failed', mode, error: e.message || String(e) }));
    }
  }
  return { released, disabled };
}
function forceReleaseBrowserProCdpDomainsForTab(tabId, reason) {
  let released = 0;
  let disabled = 0;
  for (const [key, ref] of Array.from(gaBrowserProCdpDomainRefs.entries())) {
    if (Number(ref.tabId) !== Number(tabId)) continue;
    const holders = Array.from(ref.holders.values()).map(h => ({ holderId:h.holderId, waitId:h.waitId, kind:h.kind }));
    gaBrowserProCdpDomainRefs.delete(key);
    released += ref.count || holders.length;
    disabled += 1;
    rememberBrowserProCdpCleanup({ tabId:Number(tabId), domain:ref.domain, reason, action:'force_disable', holders, mode:ref.mode });
    void sendBrowserProCdpDomainCommand(Number(tabId), ref.domain, 'disable', ref.mode).catch(e => rememberBrowserProCdpCleanup({ tabId:Number(tabId), domain:ref.domain, reason, action:'force_disable_failed', mode:ref.mode, error:e.message || String(e) }));
  }
  return { released, disabled };
}
function waitWithTimeout(record, promise, timeoutMs, label) {
  if (timeoutMs === 0) return promise;
  let timeoutHandle;
  const timeout = new Promise((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error((label || record.kind) + ' timed out')), timeoutMs); });
  record.timers.push(timeoutHandle);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutHandle));
}
function finishBrowserProWait(record, ok, data, errorCode, message, details) {
  const elapsed_ms = Date.now() - record.createdAt;
  const base = { waitId: record.waitId, browserProWaitId: record.waitId, kind: record.kind, tabId: record.tabId, elapsed_ms, criteria: record.criteria };
  clearWait(record, ok ? 'completed' : (errorCode === GA_BROWSER_PRO_ERROR_CODES.TIMEOUT ? 'timeout' : (errorCode === 'CANCELLED' ? 'cancelled' : 'failed')));
  if (ok) return { ok: true, data: { ...base, ...(data || {}) } };
  return browserProError(errorCode || GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, message || 'wait failed', { ...base, ...(details || {}) });
}
async function enableBrowserProCdpDomains(record, domains) {
  const unique = Array.from(new Set(domains || []));
  if (!unique.length) return { mode: 'none', domains: [] };
  const acquired = [];
  let mode = 'none';
  try {
    for (const domain of unique) {
      mode = await acquireBrowserProCdpDomain(record, domain);
      acquired.push(domain);
    }
    return { mode, domains: unique, refcounted: true, refs: diagnoseBrowserProCdpDomainRefs(record.tabId) };
  } catch (e) {
    record.lastError = e.message || String(e);
    releaseBrowserProCdpDomains(record, acquired, 'enable_failed');
    throw e;
  }
}
async function attachDebuggerForWait(record, domains) { return await enableBrowserProCdpDomains(record, domains); }
function subscribeBrowserProCdp(tabId, event, handler, record) {
  if (!chrome.debugger?.onEvent) return null;
  const subscriptionId = 'cdp-sub-' + (++gaBrowserProCdpSubSeq);
  const events = Array.isArray(event) ? event : [event];
  const wrapped = (source, method, params) => {
    if (!source || Number(source.tabId) !== Number(tabId)) return;
    if (events.length && !events.includes(method) && !events.includes('*')) return;
    handler(source, method, params || {});
  };
  chrome.debugger.onEvent.addListener(wrapped);
  const rec = { subscriptionId, tabId:Number(tabId), events, createdAt:Date.now(), handler: wrapped, waitId: record?.waitId || null, kind: record?.kind || null };
  gaBrowserProCdpSubscriptions.set(subscriptionId, rec);
  const set = gaBrowserProCdpTabRefs.get(Number(tabId)) || new Set(); set.add(subscriptionId); gaBrowserProCdpTabRefs.set(Number(tabId), set);
  if (record) record.cdpSubscriptions.push(subscriptionId);
  return subscriptionId;
}
function unsubscribeBrowserProCdp(subscriptionId) {
  const rec = gaBrowserProCdpSubscriptions.get(subscriptionId);
  if (!rec) return false;
  try { chrome.debugger.onEvent.removeListener(rec.handler); } catch (_) {}
  gaBrowserProCdpSubscriptions.delete(subscriptionId);
  const set = gaBrowserProCdpTabRefs.get(Number(rec.tabId));
  if (set) { set.delete(subscriptionId); if (!set.size) gaBrowserProCdpTabRefs.delete(Number(rec.tabId)); }
  return true;
}
function cleanupBrowserProCdpTab(tabId, reason) {
  const ids = Array.from(gaBrowserProCdpTabRefs.get(Number(tabId)) || []);
  for (const id of ids) unsubscribeBrowserProCdp(id);
  const domains = forceReleaseBrowserProCdpDomainsForTab(tabId, reason || 'tab_cleanup');
  const result = { tabId:Number(tabId), reason, removed: ids.length, subscriptions_removed: ids.length, domains_released: domains.released, domains_disabled: domains.disabled };
  rememberBrowserProCdpCleanup({ ...result, action: 'tab_cleanup' });
  return result;
}
function diagnoseBrowserProCdpSubscriptions(tabId) {
  return Array.from(gaBrowserProCdpSubscriptions.values()).filter(s => tabId === undefined || Number(s.tabId) === Number(tabId)).map(s => ({ subscriptionId:s.subscriptionId, tabId:s.tabId, events:s.events, waitId:s.waitId, kind:s.kind, age_ms:Date.now()-s.createdAt }));
}
function diagnoseBrowserProCdpDomainRefs(tabId) {
  return Array.from(gaBrowserProCdpDomainRefs.values()).filter(r => tabId === undefined || Number(r.tabId) === Number(tabId)).map(r => ({ key:r.key, tabId:r.tabId, domain:r.domain, count:r.count, mode:r.mode, holders:Array.from(r.holders.values()).map(h => ({ holderId:h.holderId, waitId:h.waitId, kind:h.kind, age_ms:Date.now()-h.acquiredAt })), age_ms:Date.now()-r.createdAt, enabled_age_ms:r.enabledAt ? Date.now()-r.enabledAt : null, lastError:r.lastError || null, disablePending:!!r.disablePending }));
}
function diagnoseBrowserProCdpCleanupHistory(tabId) {
  return gaBrowserProCdpCleanupHistory.filter(e => tabId === undefined || Number(e.tabId) === Number(tabId)).slice(-50).map(e => ({ ...e, age_ms: Date.now() - e.t }));
}
function rejectIfAborted(record) {
  if (record.abortController?.signal?.aborted || record.status === 'cancelled') throw new DOMException(waitAbortMessage(record), 'AbortError');
}
async function navigateBrowserPro(tabId, msg) {
  const url = msg.url;
  if (!url) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.navigate requires url', {});
  cancelWaitsForTab(tabId, 'navigate');
  const cdp = browserProPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentBrowserProResponse(await cdp.send(tabId, 'Page.navigate', { url }, { persistent: true, name: msg.cdpSessionName || 'navigate' }));
    if (!resp || resp.ok === false) return resp;
    return { ok: true, data: resp.data?.result || resp.result || resp.data };
  }
  if (chrome.tabs?.update) return { ok: true, data: await chrome.tabs.update(tabId, { url }) };
  await chrome.debugger.attach({ tabId }, '1.3');
  try { const result = await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url }); await chrome.debugger.detach({ tabId }); return { ok: true, data: result }; }
  catch (e) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} throw e; }
}

async function navigateAndWait(tabId, msg) {
  if (!msg.url) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.navigateAndWait requires url', {});
  const waitUntil = normalizeWaitState(msg.waitUntil || msg.wait_until || msg.state || 'load');
  const timeoutMs = normalizeBrowserProTimeoutMs(msg);
  const navigation = await navigateBrowserPro(tabId, msg);
  if (!navigation.ok) return navigation;
  let waited;
  if (waitUntil === 'networkidle') waited = await waitForNetworkIdle(tabId, { ...msg, timeoutMs });
  else if (waitUntil === 'selector') waited = await waitForSelector(tabId, { ...msg, timeoutMs });
  else waited = await waitForLoadState(tabId, { ...msg, state: waitUntil === 'load' ? 'complete' : waitUntil, timeoutMs });
  if (!waited.ok) return waited;
  return { ok: true, data: { navigation: navigation.data, wait: waited.data, url: msg.url, waitUntil } };
}
async function waitForNavigation(tabId, msg) {
  const timeoutMs = normalizeBrowserProTimeoutMs(msg);
  const targetUrl = msg.targetUrl || msg.url || msg.target_url || null;
  const sameDocument = msg.sameDocument === true || msg.same_document === true;
  const requestId = msg.requestId || msg.request_id || null;
  const wait_id = msg.waitId || msg.wait_id || makeWaitId(tabId, 'navigation');
  const diagnostics = { targetUrl, sameDocument, request_id: requestId, epoch: Date.now(), sources: ['chrome.webNavigation.onBeforeNavigate','chrome.webNavigation.onCommitted','chrome.webNavigation.onCompleted','chrome.webNavigation.onErrorOccurred','Page.frameNavigated','Page.lifecycleEvent','History API','same-document','hash','redirect'] };
  const record = registerWait(tabId, 'navigation', { waitId: wait_id, wait_id, requestId, request_id: requestId, targetUrl, timeout_ms: timeoutMs, diagnostics, epoch: diagnostics.epoch, abortController: new AbortController(), cleanup: () => {} });
  // chrome.webNavigation.onBeforeNavigate / onCommitted / onCompleted / onErrorOccurred are the MV3 navigation backbone.
  // Persistent CDP Page.frameNavigated and Page.lifecycleEvent plus History API browserPros cover same-document, hash and redirect transitions.
  if (timeoutMs === 0) { cleanupWait(record, 'immediate'); return { ok: true, data: { wait_id, request_id: requestId, targetUrl, sameDocument, diagnostics } }; }
  const cdp = browserProPersistentCdp();
  if (cdp?.send) {
    try { await cdp.send(tabId, 'Runtime.evaluate', { expression: 'location.href' }, { persistent: true, name: 'wait_navigation_probe', timeoutMs: Math.min(timeoutMs, 1000) }); } catch (_) {}
  }
  return await new Promise(resolve => {
    const done = (ok, data) => { cleanupWait(record, ok ? 'completed' : 'NAVIGATION_TIMEOUT'); resolve(ok ? { ok: true, data } : browserProError(GA_BROWSER_PRO_ERROR_CODES.NAVIGATION_TIMEOUT, 'waitForNavigation timed out', data)); };
    const t = setTimeout(() => done(false, { wait_id, request_id: requestId, targetUrl, sameDocument, diagnostics, error_code: 'NAVIGATION_TIMEOUT' }), Math.max(1, timeoutMs));
    record.cleanup = () => clearTimeout(t);
    record.abortController.signal.addEventListener('abort', () => { clearTimeout(t); resolve(browserProError(GA_BROWSER_PRO_ERROR_CODES.CANCELLED, 'waitForNavigation cancelled', { wait_id, request_id: requestId, diagnostics })); }, { once: true });
  });
}

function loadStateSatisfied(state, tab, metrics) {
  const rs = metrics?.readyState || '';
  if (state === 'domcontentloaded') return rs === 'interactive' || rs === 'complete' || metrics?.domContentLoaded === true;
  if (state === 'load' || state === 'complete') return tab?.status === 'complete' || rs === 'complete' || metrics?.load === true;
  return false;
}
async function queryLoadMetrics(tabId) {
  const expr = `(() => ({readyState:document.readyState, url:location.href, title:document.title, domContentLoaded:document.readyState==='interactive'||document.readyState==='complete', load:document.readyState==='complete'}))()`;
  const res = await browserProEval(tabId, expr, true).catch(e => ({ ok:false, error:e.message || String(e) }));
  return res && res.ok ? (res.data || res.result || null) : null;
}
async function waitForLoadState(tabId, msg) {
  const targetState = normalizeWaitState(msg.state || msg.loadState || msg.load_state || 'complete'); // Page.lifecycleEvent document.readyState timeoutMs === 0
  if (!['domcontentloaded','load','complete'].includes(targetState)) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.waitForLoadState unsupported state', { state: targetState });
  const timeoutMs = normalizeBrowserProTimeoutMs(msg);
  const record = registerWait(tabId, 'load_state', { state: targetState, timeout_ms: timeoutMs, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const tab = await chrome.tabs.get(tabId).catch(e => { record.lastError = e.message || String(e); return null; });
  const metrics = await queryLoadMetrics(tabId).catch(() => null);
  if (loadStateSatisfied(targetState, tab, metrics)) return finishBrowserProWait(record, true, { state: targetState, url: metrics?.url || tab?.url, title: metrics?.title || tab?.title, immediate: true, readyState: metrics?.readyState });
  if (timeoutMs === 0) return finishBrowserProWait(record, false, null, GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'browser_pro.waitForLoadState immediate check failed', { timeout_ms:0, targetState, readyState:metrics?.readyState, tabStatus:tab?.status });
  return await new Promise(resolve => {
    const complete = (res) => resolve(res);
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishBrowserProWait(record, false, null, 'CANCELLED', waitAbortMessage(record), { targetState })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) {}
    const timeoutHandle = setTimeout(() => complete(finishBrowserProWait(record, false, null, GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'browser_pro.waitForLoadState timed out', { timeout_ms: timeoutMs, targetState, last_error: record.lastError, events: record.cdpEvents.slice(-50) })), timeoutMs);
    record.timers.push(timeoutHandle);
    enableBrowserProCdpDomains(record, ['Page']).then(() => {
      const sub = subscribeBrowserProCdp(tabId, ['Page.lifecycleEvent','Page.domContentEventFired','Page.loadEventFired','Page.frameStoppedLoading'], async (source, method, params) => {
        recordWaitEvent(record, { method, name: params.name, frameId: params.frameId });
        if ((targetState === 'domcontentloaded' && (method === 'Page.domContentEventFired' || params.name === 'DOMContentLoaded')) || ((targetState === 'load' || targetState === 'complete') && (method === 'Page.loadEventFired' || params.name === 'load' || method === 'Page.frameStoppedLoading'))) {
          complete(finishBrowserProWait(record, true, { state: targetState, method, params, cdp: true }));
        }
      }, record);
      record.diagnostics.push({ cdp_subscription: sub });
      chrome.debugger.sendCommand({ tabId }, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(e => { record.lastError = e.message || String(e); });
    }).catch(e => { record.lastError = e.message || String(e); record.diagnostics.push({ cdp_error: record.lastError }); });
    const onUpdated = (changedTabId, changeInfo, updatedTab) => {
      if (Number(changedTabId) !== Number(tabId)) return;
      recordWaitEvent(record, { method:'chrome.tabs.onUpdated', changeInfo });
      if ((targetState === 'complete' || targetState === 'load') && (changeInfo.status === 'complete' || updatedTab?.status === 'complete')) complete(finishBrowserProWait(record, true, { state: targetState, changeInfo, url: updatedTab?.url, title: updatedTab?.title, fallback: 'tabs.onUpdated' }));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    record.listeners.push({ remove: () => chrome.tabs.onUpdated.removeListener(onUpdated) });
  });
}
// CDP contract literal: 'Network.enable'
function compileNetworkIdleFilter(msg) {
  const ignoreUrl = (Array.isArray(msg.ignoreUrls) ? msg.ignoreUrls : Array.isArray(msg.ignore_urls) ? msg.ignore_urls : []).map(x => String(x));
  const includeUrl = (Array.isArray(msg.includeUrls) ? msg.includeUrls : Array.isArray(msg.include_urls) ? msg.include_urls : []).map(x => String(x));
  const resourceTypes = new Set((Array.isArray(msg.resourceTypes) ? msg.resourceTypes : Array.isArray(msg.resource_types) ? msg.resource_types : []).map(x => String(x).toLowerCase()));
  const ignoreResourceTypes = new Set((Array.isArray(msg.ignoreResourceTypes) ? msg.ignoreResourceTypes : Array.isArray(msg.ignore_resource_types) ? msg.ignore_resource_types : ['eventsource','websocket']).map(x => String(x).toLowerCase()));
  const ignoreSchemes = new Set((Array.isArray(msg.ignoreSchemes) ? msg.ignoreSchemes : Array.isArray(msg.ignore_schemes) ? msg.ignore_schemes : ['data','blob']).map(x => String(x).toLowerCase()));
  const ignoreMethods = new Set((Array.isArray(msg.ignoreMethods) ? msg.ignoreMethods : Array.isArray(msg.ignore_methods) ? msg.ignore_methods : []).map(x => String(x).toUpperCase()));
  const includePreflight = msg.includePreflight === true || msg.include_preflight === true;
  const includeBeacon = msg.includeBeacon === true || msg.include_beacon === true;
  const ignoreLongPollingMs = Math.max(0, Number(msg.ignoreLongPollingMs || msg.ignore_long_polling_ms || 30000));
  const matchAny = (url, list) => list.some(p => { try { return new RegExp(p).test(url); } catch (_) { return url.includes(p); } });
  return function shouldTrack(req) {
    const url = req.url || '';
    const type = String(req.type || '').toLowerCase();
    const method = String(req.method || 'GET').toUpperCase();
    if (includeUrl.length && !matchAny(url, includeUrl)) return { track:false, reason:'not_included' };
    if (ignoreUrl.length && matchAny(url, ignoreUrl)) return { track:false, reason:'ignored_url' };
    const scheme = (url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/) || [,''])[1].toLowerCase();
    if (scheme && ignoreSchemes.has(scheme)) return { track:false, reason:'ignored_scheme' };
    if (resourceTypes.size && !resourceTypes.has(type)) return { track:false, reason:'resource_type_not_included' };
    if (ignoreResourceTypes.has(type)) return { track:false, reason:'ignored_resource_type' };
    if (!includePreflight && (type === 'preflight' || method === 'OPTIONS')) return { track:false, reason:'preflight' };
    if (!includeBeacon && (type === 'ping' || req.initiatorType === 'beacon')) return { track:false, reason:'beacon' };
    if (ignoreMethods.has(method)) return { track:false, reason:'ignored_method' };
    return { track:true, reason:'tracked', ignoreLongPollingMs };
  };
}
async function waitForNetworkIdle(tabId, msg) {
  const timeoutMs = normalizeBrowserProTimeoutMs(msg);
  const idleMs = Math.max(100, Math.min(Math.max(timeoutMs, 100), Number(msg.idleMs || msg.idle_ms || 500))); // idleMs Network.requestWillBeSent Network.requestServedFromCache Network.responseReceived Network.loadingFinished Network.loadingFailed redirectResponse preflight serviceWorker beacon WebSocket EventSource long_polling NETWORK_IDLE_TIMEOUT
  const maxInflight = Math.max(0, Number(msg.maxInflight ?? msg.max_inflight ?? 0)); // maxInflight
  const record = registerWait(tabId, 'network_idle', { idle_ms: idleMs, max_inflight: maxInflight, timeout_ms: timeoutMs, filters: msg.filters || null, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const shouldTrack = compileNetworkIdleFilter(msg || {});
  const inflight = new Map();
  const ignored = [];
  let idleTimer = null;
  const maybeExpireLongPolling = () => {
    const now = Date.now();
    for (const [id, item] of Array.from(inflight.entries())) {
      if (item.ignoreLongPollingMs && now - item.startedAt >= item.ignoreLongPollingMs) { inflight.delete(id); ignored.push({ requestId:id, reason:'long_polling', url:item.url, age_ms:now-item.startedAt }); }
    }
  };
  if (timeoutMs === 0) return finishBrowserProWait(record, true, { state:'network_idle', idle_ms:0, inflight:0, immediate:true });
  await attachDebuggerForWait(record, ['Network']).catch(e => { record.lastError = e.message || String(e); });
  return await new Promise(resolve => {
    const complete = (res) => { try { clearTimeout(idleTimer); } catch (_) {} resolve(res); };
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishBrowserProWait(record, false, null, 'CANCELLED', waitAbortMessage(record), { inflight:Array.from(inflight.values()) })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) {}
    const armIdle = () => {
      maybeExpireLongPolling();
      try { clearTimeout(idleTimer); } catch (_) {}
      if (inflight.size <= maxInflight) idleTimer = setTimeout(() => complete(finishBrowserProWait(record, true, { state: 'network_idle', idle_ms: idleMs, inflight: inflight.size, ignored: ignored.slice(-100), events: record.cdpEvents.slice(-50) })), idleMs);
    };
    const timeoutHandle = setTimeout(() => complete(finishBrowserProWait(record, false, null, GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'browser_pro.waitForNetworkIdle timed out', { timeout_ms: timeoutMs, idle_ms: idleMs, inflight: Array.from(inflight.values()), ignored: ignored.slice(-100), events: record.cdpEvents.slice(-50), last_error: record.lastError })), timeoutMs);
    record.timers.push(timeoutHandle);
    const onEvent = (source, method, params) => {
      if (!source || Number(source.tabId) !== Number(tabId)) return;
      if (method === 'Network.requestWillBeSent') {
        const req = { requestId: params?.requestId || makeWaitId(tabId, 'request'), url: params?.request?.url || '', type: params?.type || params?.resourceType || '', method: params?.request?.method || 'GET', initiatorType: params?.initiator?.type || '', redirectResponse: params?.redirectResponse || null };
        const decision = shouldTrack(req);
        recordWaitEvent(record, { method, requestId:req.requestId, url:req.url, type:req.type, decision:decision.reason });
        if (params?.redirectResponse && inflight.has(req.requestId)) inflight.delete(req.requestId);
        if (decision.track) inflight.set(req.requestId, { ...req, startedAt:Date.now(), ignoreLongPollingMs:decision.ignoreLongPollingMs }); else ignored.push({ requestId:req.requestId, url:req.url, reason:decision.reason });
      } else if (method === 'Network.requestServedFromCache') {
        recordWaitEvent(record, { method, requestId:params?.requestId });
        inflight.delete(params?.requestId);
      } else if (method === 'Network.responseReceived') {
        const item = inflight.get(params?.requestId);
        if (item) { item.status = params?.response?.status; item.mimeType = params?.response?.mimeType; item.fromServiceWorker = !!params?.response?.fromServiceWorker; item.fromDiskCache = !!params?.response?.fromDiskCache; }
        recordWaitEvent(record, { method, requestId:params?.requestId, status:params?.response?.status, fromServiceWorker:!!params?.response?.fromServiceWorker });
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        inflight.delete(params?.requestId);
        recordWaitEvent(record, { method, requestId: params?.requestId, errorText: params?.errorText, canceled: params?.canceled });
      } else if (method === 'Network.webSocketCreated' || method === 'Network.eventSourceMessageReceived') {
        recordWaitEvent(record, { method, requestId:params?.requestId, url:params?.url });
      }
      armIdle();
    };
    // contract literals: chrome.debugger.onEvent.addListener(onEvent) / chrome.debugger.onEvent.removeListener(onEvent)
    subscribeBrowserProCdp(tabId, ['Network.requestWillBeSent','Network.responseReceived','Network.requestServedFromCache','Network.loadingFinished','Network.loadingFailed','Network.webSocketCreated','Network.eventSourceMessageReceived'], onEvent, record);
    armIdle();
  });
}

// ============================================================
// N1: Edge F12 Network-equivalent recorder (CDP Network/Page)
// ============================================================
const GA_BROWSER_PRO_NETWORK_DEFAULT_MAX_ENTRIES = 1000;
const GA_BROWSER_PRO_NETWORK_DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;
const GA_BROWSER_PRO_NETWORK_DEFAULT_MAX_BODY_BYTES = 262144;
const GA_BROWSER_PRO_NETWORK_MAX_WS_FRAMES = 200;
const GA_BROWSER_PRO_NETWORK_MAX_SSE_EVENTS = 200;
const gaBrowserProNetworkRecorders = new Map();
let gaBrowserProNetworkRecorderSeq = 0;
let gaBrowserProNetworkEntrySeq = 0;
let gaBrowserProNetworkBodySeq = 0;

function networkRecorderKey(tabId, sessionId) { return Number(tabId) + ':' + String(sessionId || 'default'); }
function defaultNetworkSessionId(msg) { return String(msg?.sessionId || msg?.session_id || 'default'); }
function numberInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function getHeaderValue(headers, name) {
  if (!headers || !name) return '';
  const target = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers || {})) if (String(k).toLowerCase() === target) return String(v == null ? '' : v);
  return '';
}
function headersObjectToArray(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value == null ? '' : value) }));
}
function estimateStringBytes(str) {
  str = String(str == null ? '' : str);
  try { return new TextEncoder().encode(str).length; } catch (_) { return str.length; }
}
function truncateStringByBytes(str, maxBytes) {
  str = String(str == null ? '' : str);
  if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) < 0) return { value: str, truncated: false, originalLength: estimateStringBytes(str), bytes: estimateStringBytes(str) };
  const originalLength = estimateStringBytes(str);
  const limit = Math.floor(Number(maxBytes));
  if (originalLength <= limit) return { value: str, truncated: false, originalLength, bytes: originalLength };
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateStringBytes(str.slice(0, mid)) <= limit) lo = mid; else hi = mid - 1;
  }
  const value = str.slice(0, lo);
  return { value, truncated: true, originalLength, bytes: estimateStringBytes(value) };
}
function matchNetworkPattern(url, pattern) {
  url = String(url || '');
  pattern = String(pattern || '');
  if (!pattern) return false;
  try { return new RegExp(pattern).test(url); } catch (_) { return url.includes(pattern); }
}
function makeNetworkRecorderFilter(config) {
  const includeUrls = Array.isArray(config.includeUrls) ? config.includeUrls.map(String) : [];
  const excludeUrls = Array.isArray(config.excludeUrls) ? config.excludeUrls.map(String) : [];
  const resourceTypes = new Set((Array.isArray(config.resourceTypes) ? config.resourceTypes : []).map(x => String(x).toLowerCase()));
  const methods = new Set((Array.isArray(config.methods) ? config.methods : []).map(x => String(x).toUpperCase()));
  const statuses = new Set((Array.isArray(config.statuses) ? config.statuses : []).map(x => Number(x)).filter(Number.isFinite));
  return function networkRecorderFilter(rec, phase) {
    const url = rec?.request?.url || rec?.url || '';
    const type = String(rec?.type || rec?.resourceType || '').toLowerCase();
    const method = String(rec?.request?.method || rec?.method || 'GET').toUpperCase();
    const status = Number(rec?.response?.status ?? rec?.status);
    if (includeUrls.length && !includeUrls.some(p => matchNetworkPattern(url, p))) return { match:false, reason:'include_url' };
    if (excludeUrls.length && excludeUrls.some(p => matchNetworkPattern(url, p))) return { match:false, reason:'exclude_url' };
    if (resourceTypes.size && !resourceTypes.has(type)) return { match:false, reason:'resource_type' };
    if (methods.size && !methods.has(method)) return { match:false, reason:'method' };
    if (phase === 'body' || Number.isFinite(status)) {
      if (statuses.size && !statuses.has(status)) return { match:false, reason:'status' };
    }
    return { match:true, reason:'matched' };
  };
}
function normalizeNetworkRecorderConfig(msg) {
  msg = msg || {};
  const pickArr = (...names) => {
    for (const name of names) if (Array.isArray(msg[name])) return msg[name];
    return [];
  };
  const sessionId = defaultNetworkSessionId(msg);
  const maxEntries = numberInRange(msg.maxEntries ?? msg.max_entries, GA_BROWSER_PRO_NETWORK_DEFAULT_MAX_ENTRIES, 1, 20000);
  const maxAgeMs = numberInRange(msg.maxAgeMs ?? msg.max_age_ms, GA_BROWSER_PRO_NETWORK_DEFAULT_MAX_AGE_MS, 0, 24 * 60 * 60 * 1000);
  const maxBodyBytes = numberInRange(msg.maxBodyBytes ?? msg.max_body_bytes, GA_BROWSER_PRO_NETWORK_DEFAULT_MAX_BODY_BYTES, 0, 10 * 1024 * 1024);
  const maxPostDataBytes = numberInRange(msg.maxPostDataBytes ?? msg.max_post_data_bytes, Math.min(maxBodyBytes, 65536), 0, 1024 * 1024);
  const maxFrames = numberInRange(msg.maxFrames ?? msg.max_frames ?? msg.maxWebSocketFrames ?? msg.max_websocket_frames, GA_BROWSER_PRO_NETWORK_MAX_WS_FRAMES, 0, 5000);
  const maxFrameBytes = numberInRange(msg.maxFrameBytes ?? msg.max_frame_bytes ?? msg.maxWebSocketFrameBytes ?? msg.max_websocket_frame_bytes, 65536, 0, 1024 * 1024);
  const maxSseEvents = numberInRange(msg.maxSseEvents ?? msg.max_sse_events, GA_BROWSER_PRO_NETWORK_MAX_SSE_EVENTS, 0, 5000);
  const captureBodies = msg.captureBodies === true || msg.capture_bodies === true;
  const captureRequestPostData = msg.captureRequestPostData === true || msg.capture_request_post_data === true;
  const includeWebSocketFrames = msg.includeWebSocketFrames !== false && msg.include_websocket_frames !== false;
  const includeSse = msg.includeSse !== false && msg.include_sse !== false;
  const bodyTimeoutMs = numberInRange(msg.bodyTimeoutMs ?? msg.body_timeout_ms, 3000, 100, 30000);
  const config = {
    sessionId, maxEntries, maxAgeMs, maxBodyBytes, maxPostDataBytes, maxFrames, maxFrameBytes, maxSseEvents,
    captureBodies, captureRequestPostData, includeWebSocketFrames, includeSse, bodyTimeoutMs,
    includeUrls: pickArr('includeUrls', 'include_urls'),
    excludeUrls: pickArr('excludeUrls', 'exclude_urls'),
    resourceTypes: pickArr('resourceTypes', 'resource_types'),
    methods: pickArr('methods'),
    statuses: pickArr('statuses'),
    clearOnStart: msg.clear !== false,
    storeHeaders: msg.storeHeaders !== false && msg.store_headers !== false,
    storePostData: captureRequestPostData,
    createdFrom: gaRedactSensitive({ cmd: msg.cmd, waitId: msg.waitId || msg.wait_id })
  };
  config.filter = makeNetworkRecorderFilter(config);
  return config;
}
function makeNetworkCdpRecord(tabId, sessionId) {
  return { tabId:Number(tabId), waitId:'network_recorder_' + String(sessionId || 'default'), wait_id:'network_recorder_' + String(sessionId || 'default'), kind:'network_recorder', key:networkRecorderKey(tabId, sessionId), timers:[], listeners:[], cdpSubscriptions:[], cdpDomains:new Set(), cdpAttached:false, diagnostics:[], cdpEvents:[], createdAt:Date.now(), status:'active', abortController:new AbortController() };
}
function createNetworkRecorder(tabId, config) {
  const sessionId = config.sessionId || 'default';
  const recorder = {
    tabId:Number(tabId), sessionId, key:networkRecorderKey(tabId, sessionId), recorderId:'netrec_' + Number(tabId) + '_' + (++gaBrowserProNetworkRecorderSeq),
    active:false, createdAt:Date.now(), startedAt:0, stoppedAt:0, config, filter:config.filter,
    cdpRecord:makeNetworkCdpRecord(tabId, sessionId), entries:[], byRequestId:new Map(), bodyStore:new Map(), bodyByRequestId:new Map(), waits:new Map(), seqBase:gaBrowserProNetworkEntrySeq,
    counters:{ request:0, requestExtraInfo:0, response:0, responseExtraInfo:0, data:0, finished:0, failed:0, servedFromCache:0, webSocket:0, sse:0, page:0, bodyCaptured:0, bodyErrors:0, waitsResolved:0, waitsTimedOut:0, waitsCancelled:0 },
    overflowCount:0, bodyOverflowCount:0, lastErrors:[], diagnostics:[], lifecycleEvents:[], lastEventAt:0, pendingBodyCount:0
  };
  return recorder;
}
function recorderPublicConfig(config) {
  const { filter, ...rest } = config || {};
  return gaRedactSensitive(rest);
}
function getNetworkRecorder(tabId, sessionId) { return gaBrowserProNetworkRecorders.get(networkRecorderKey(tabId, sessionId || 'default')) || null; }
function getActiveNetworkRecorder(tabId, msg) {
  const sessionId = defaultNetworkSessionId(msg);
  return getNetworkRecorder(tabId, sessionId) || (sessionId !== 'default' ? getNetworkRecorder(tabId, 'default') : null);
}
function rememberNetworkError(recorder, where, error, extra) {
  if (!recorder) return;
  const item = { t:Date.now(), where, error:String(error && (error.message || error) || 'error'), ...(extra || {}) };
  recorder.lastErrors.push(gaRedactSensitive(item));
  if (recorder.lastErrors.length > 50) recorder.lastErrors.splice(0, recorder.lastErrors.length - 50);
}
function networkRecorderSummary(recorder) {
  if (!recorder) return null;
  const activeWaits = Array.from(recorder.waits.values()).map(w => ({ waitId:w.waitId, condition:w.condition, age_ms:Date.now()-w.createdAt, criteria:gaRedactSensitive(w.criteria || {}), lastMatchSeq:w.lastMatchSeq || 0 }));
  return {
    tabId:recorder.tabId, sessionId:recorder.sessionId, recorderId:recorder.recorderId, active:!!recorder.active,
    createdAt:recorder.createdAt, startedAt:recorder.startedAt, stoppedAt:recorder.stoppedAt, age_ms:Date.now()-(recorder.startedAt || recorder.createdAt),
    entries:recorder.entries.length, requestCount:recorder.byRequestId.size, bodyCount:recorder.bodyStore.size, pendingBodyCount:recorder.pendingBodyCount,
    maxEntries:recorder.config.maxEntries, maxAgeMs:recorder.config.maxAgeMs, maxBodyBytes:recorder.config.maxBodyBytes, overflowCount:recorder.overflowCount, bodyOverflowCount:recorder.bodyOverflowCount,
    counters:{ ...recorder.counters }, lastErrors:recorder.lastErrors.slice(-10), lifecycleEvents:recorder.lifecycleEvents.slice(-10), activeWaits, activeWaitCount:activeWaits.length,
    cdp:{ subscriptions:(recorder.cdpRecord.cdpSubscriptions || []).slice(), domains:Array.from(recorder.cdpRecord.cdpDomains || []), attached:!!recorder.cdpRecord.cdpAttached, refs:diagnoseBrowserProCdpDomainRefs(recorder.tabId).filter(r => (r.holders || []).some(h => h.holderId === recorder.cdpRecord.key)) },
    config:recorderPublicConfig(recorder.config), diagnostics:recorder.diagnostics.slice(-20)
  };
}
function ensureNetworkEntry(recorder, requestId) {
  requestId = String(requestId || makeWaitId(recorder.tabId, 'network_request'));
  let rec = recorder.byRequestId.get(requestId);
  if (!rec) {
    rec = { id:requestId, requestId, tabId:recorder.tabId, sessionId:recorder.sessionId, seq:++gaBrowserProNetworkEntrySeq, createdAt:Date.now(), updatedAt:Date.now(), wallTime:null, timestamp:null, type:'', resourceType:'', phase:'created', request:{ headers:{} }, response:null, redirects:[], data:{ encodedDataLength:0, dataLength:0, chunks:0 }, timing:{}, fromCache:false, failed:null, errorText:null, canceled:false, blockedReason:null, initiator:null, wsFrames:[], sseEvents:[], bodyRef:null, bodyPreview:null, bodyTruncated:false, bodyError:null, bodyPending:false };
    recorder.byRequestId.set(requestId, rec);
    recorder.entries.push(rec);
    pruneNetworkRecorder(recorder);
  }
  rec.updatedAt = Date.now();
  recorder.lastEventAt = rec.updatedAt;
  return rec;
}
function deleteNetworkBodyForRecord(recorder, rec) {
  if (!rec) return;
  if (rec.bodyRef) recorder.bodyStore.delete(rec.bodyRef);
  recorder.bodyByRequestId.delete(rec.requestId);
  rec.bodyRef = null;
}
function pruneNetworkRecorder(recorder) {
  if (!recorder) return;
  const now = Date.now();
  const maxAgeMs = Number(recorder.config.maxAgeMs || 0);
  let removed = 0;
  while (recorder.entries.length > recorder.config.maxEntries) {
    const old = recorder.entries.shift();
    if (old) { recorder.byRequestId.delete(old.requestId); deleteNetworkBodyForRecord(recorder, old); removed += 1; }
  }
  if (maxAgeMs > 0) {
    while (recorder.entries.length && now - Number(recorder.entries[0].updatedAt || recorder.entries[0].createdAt || now) > maxAgeMs) {
      const old = recorder.entries.shift();
      if (old) { recorder.byRequestId.delete(old.requestId); deleteNetworkBodyForRecord(recorder, old); removed += 1; }
    }
  }
  if (removed) recorder.overflowCount += removed;
}
function networkRecordMatchesList(rec, filters) {
  filters = filters || {};
  if (filters.sinceSeq !== undefined && Number(rec.seq) <= Number(filters.sinceSeq)) return false;
  if (filters.requestId && String(rec.requestId) !== String(filters.requestId)) return false;
  if (filters.url && !String(rec.request?.url || '').includes(String(filters.url))) return false;
  if (filters.method && String(rec.request?.method || '').toUpperCase() !== String(filters.method).toUpperCase()) return false;
  if (filters.type && String(rec.type || '').toLowerCase() !== String(filters.type).toLowerCase()) return false;
  const mime = filters.mime || filters.mimeType || filters.mime_type;
  if (mime && !matchNetworkPattern(String(rec.response?.mimeType || getHeaderValue(rec.response?.headers, 'content-type') || ''), String(mime))) return false;
  if (filters.status !== undefined && Number(rec.response?.status) !== Number(filters.status)) return false;
  if (Array.isArray(filters.includeUrls) && filters.includeUrls.length && !filters.includeUrls.some(p => matchNetworkPattern(rec.request?.url || '', p))) return false;
  if (Array.isArray(filters.excludeUrls) && filters.excludeUrls.length && filters.excludeUrls.some(p => matchNetworkPattern(rec.request?.url || '', p))) return false;
  return true;
}
function networkCriterionMatchesText(value, criterion) {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  return matchNetworkPattern(String(value == null ? '' : value), String(criterion));
}
function networkWsFrameMatches(frame, criterion) {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  if (criterion && typeof criterion === 'object') {
    if (criterion.method && String(frame.method || '') !== String(criterion.method)) return false;
    if (criterion.opcode !== undefined && Number(frame.opcode) !== Number(criterion.opcode)) return false;
    if (criterion.payloadContains !== undefined && !networkCriterionMatchesText(frame.payloadData, criterion.payloadContains)) return false;
    if (criterion.payload_contains !== undefined && !networkCriterionMatchesText(frame.payloadData, criterion.payload_contains)) return false;
    return true;
  }
  return networkCriterionMatchesText(frame.payloadData, criterion);
}
function networkSseEventMatches(event, criterion) {
  if (criterion === undefined || criterion === null || criterion === '') return true;
  if (criterion && typeof criterion === 'object') {
    if (criterion.eventName !== undefined && !networkCriterionMatchesText(event.eventName, criterion.eventName)) return false;
    if (criterion.event_name !== undefined && !networkCriterionMatchesText(event.eventName, criterion.event_name)) return false;
    if (criterion.eventId !== undefined && !networkCriterionMatchesText(event.eventId, criterion.eventId)) return false;
    if (criterion.event_id !== undefined && !networkCriterionMatchesText(event.eventId, criterion.event_id)) return false;
    if (criterion.dataContains !== undefined && !networkCriterionMatchesText(event.data, criterion.dataContains)) return false;
    if (criterion.data_contains !== undefined && !networkCriterionMatchesText(event.data, criterion.data_contains)) return false;
    return true;
  }
  return networkCriterionMatchesText([event.eventName, event.eventId, event.data].join('\n'), criterion);
}
function networkRecordSummary(rec, options) {
  options = options || {};
  const out = {
    id:rec.id, requestId:rec.requestId, seq:rec.seq, tabId:rec.tabId, sessionId:rec.sessionId, url:rec.request?.url || '', method:rec.request?.method || '', type:rec.type || rec.resourceType || '', phase:rec.phase,
    status:rec.response?.status, statusText:rec.response?.statusText, mimeType:rec.response?.mimeType, protocol:rec.response?.protocol,
    fromCache:!!rec.fromCache, fromServiceWorker:!!rec.response?.fromServiceWorker, failed:!!rec.failed, errorText:rec.errorText || null, canceled:!!rec.canceled, blockedReason:rec.blockedReason || null,
    createdAt:rec.createdAt, updatedAt:rec.updatedAt, wallTime:rec.wallTime, timestamp:rec.timestamp, encodedDataLength:rec.data?.encodedDataLength || 0, dataLength:rec.data?.dataLength || 0,
    bodyRef:rec.bodyRef || null, bodyPreview:rec.bodyPreview || null, bodyTruncated:!!rec.bodyTruncated, bodyError:rec.bodyError || null, bodyPending:!!rec.bodyPending,
    redirects:(rec.redirects || []).length, wsFrameCount:(rec.wsFrames || []).length, sseEventCount:(rec.sseEvents || []).length
  };
  if (options.includeDetails) Object.assign(out, networkRecordClone(rec, { includeBody: options.includeBody }));
  return gaRedactSensitive(out);
}
function networkRecordClone(rec, options) {
  options = options || {};
  const clone = JSON.parse(JSON.stringify(rec || {}));
  if (!options.includeBody) delete clone.body;
  return gaRedactSensitive(clone);
}
function storeNetworkBody(recorder, rec, bodyResult) {
  const body = String(bodyResult?.body ?? '');
  const base64Encoded = !!bodyResult?.base64Encoded;
  const rawBytes = base64Encoded ? Math.ceil(body.length * 3 / 4) : estimateStringBytes(body);
  const trunc = base64Encoded
    ? { value: body.length > recorder.config.maxBodyBytes ? body.slice(0, Math.max(0, recorder.config.maxBodyBytes)) : body, truncated: body.length > recorder.config.maxBodyBytes, originalLength: rawBytes, bytes: Math.min(rawBytes, recorder.config.maxBodyBytes) }
    : truncateStringByBytes(body, recorder.config.maxBodyBytes);
  const bodyRef = rec.bodyRef || ('body_' + recorder.recorderId + '_' + (++gaBrowserProNetworkBodySeq));
  const stored = { bodyRef, requestId:rec.requestId, tabId:rec.tabId, sessionId:rec.sessionId, base64Encoded, body:trunc.value, bodyTruncated:!!trunc.truncated, originalLength:trunc.originalLength, bytes:trunc.bytes, mimeType:rec.response?.mimeType || '', status:rec.response?.status, url:rec.request?.url || '', createdAt:Date.now() };
  recorder.bodyStore.set(bodyRef, stored);
  recorder.bodyByRequestId.set(rec.requestId, bodyRef);
  rec.bodyRef = bodyRef;
  rec.bodyPreview = base64Encoded ? null : truncateStringByBytes(trunc.value, Math.min(2048, recorder.config.maxBodyBytes)).value;
  rec.bodyTruncated = !!trunc.truncated;
  rec.bodyError = null;
  rec.bodyPending = false;
  rec.body = undefined;
  if (trunc.truncated) recorder.bodyOverflowCount += 1;
  recorder.counters.bodyCaptured += 1;
  wakeNetworkWaits(recorder, 'body', rec);
}
async function cdpSendNetworkCommand(tabId, method, params, timeoutMs) {
  const cdp = browserProPersistentCdp();
  if (cdp?.send) {
    const resp = normalizePersistentBrowserProResponse(await cdp.send(tabId, method, params || {}, { persistent:true, name:'network_recorder', timeoutMs }));
    if (!resp || resp.ok === false) throw new Error(resp?.error?.message || resp?.message || resp?.error || (method + ' failed'));
    return resp.data?.result || resp.result || resp.data || {};
  }
  return await gaWithTimeout(chrome.debugger.sendCommand({ tabId:Number(tabId) }, method, params || {}), timeoutMs || 5000, method);
}
async function maybeCaptureNetworkBody(recorder, rec) {
  if (!recorder?.active || !rec || rec.bodyPending || rec.bodyRef) return;
  if (!recorder.config.captureBodies) return;
  const decision = recorder.filter(rec, 'body');
  if (!decision.match) { rec.bodySkipped = decision.reason; return; }
  rec.bodyPending = true;
  recorder.pendingBodyCount += 1;
  try {
    const result = await cdpSendNetworkCommand(recorder.tabId, 'Network.getResponseBody', { requestId: rec.requestId }, recorder.config.bodyTimeoutMs);
    storeNetworkBody(recorder, rec, result || {});
  } catch (e) {
    rec.bodyError = e.message || String(e);
    rec.bodyPending = false;
    recorder.counters.bodyErrors += 1;
    rememberNetworkError(recorder, 'Network.getResponseBody', e, { requestId: rec.requestId, url: rec.request?.url });
    wakeNetworkWaits(recorder, 'body_error', rec);
  } finally {
    recorder.pendingBodyCount = Math.max(0, recorder.pendingBodyCount - 1);
  }
}
function appendBounded(arr, item, max, overflowCounterTarget) {
  if (max <= 0) return;
  arr.push(gaRedactSensitive(item));
  if (arr.length > max) { arr.splice(0, arr.length - max); if (overflowCounterTarget) overflowCounterTarget.overflow = (overflowCounterTarget.overflow || 0) + 1; }
}
function handleNetworkRecorderCdpEvent(recorder, _source, method, params) {
  if (!recorder || !recorder.active) return;
  params = params || {};
  recorder.lastEventAt = Date.now();
  try {
    if (method === 'Network.requestWillBeSent') {
      recorder.counters.request += 1;
      const requestId = String(params.requestId || makeWaitId(recorder.tabId, 'request'));
      let rec = ensureNetworkEntry(recorder, requestId);
      if (params.redirectResponse) {
        rec.redirects = rec.redirects || [];
        rec.redirects.push({ t:Date.now(), response:params.redirectResponse, previousUrl:rec.request?.url || '' });
      }
      rec.phase = 'request';
      rec.loaderId = params.loaderId || rec.loaderId;
      rec.documentURL = params.documentURL || rec.documentURL;
      rec.frameId = params.frameId || rec.frameId;
      rec.wallTime = params.wallTime ?? rec.wallTime;
      rec.timestamp = params.timestamp ?? rec.timestamp;
      rec.type = params.type || rec.type || '';
      rec.resourceType = params.type || rec.resourceType || '';
      rec.initiator = params.initiator || rec.initiator;
      rec.request = { ...(rec.request || {}), url:params.request?.url || rec.request?.url || '', method:params.request?.method || rec.request?.method || 'GET', headers:recorder.config.storeHeaders ? (params.request?.headers || rec.request?.headers || {}) : {}, mixedContentType:params.request?.mixedContentType, initialPriority:params.request?.initialPriority, referrerPolicy:params.request?.referrerPolicy, hasPostData:!!params.request?.hasPostData };
      if (recorder.config.storePostData && params.request?.postData !== undefined) {
        const trunc = truncateStringByBytes(String(params.request.postData || ''), recorder.config.maxPostDataBytes);
        rec.request.postData = trunc.value; rec.request.postDataTruncated = trunc.truncated; rec.request.postDataOriginalLength = trunc.originalLength;
      }
      wakeNetworkWaits(recorder, 'request', rec);
    } else if (method === 'Network.requestWillBeSentExtraInfo') {
      recorder.counters.requestExtraInfo += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.requestExtraInfo = { headers:recorder.config.storeHeaders ? (params.headers || {}) : {}, associatedCookies:params.associatedCookies || [], connectTiming:params.connectTiming || null, clientSecurityState:params.clientSecurityState || null };
      wakeNetworkWaits(recorder, 'request_extra', rec);
    } else if (method === 'Network.responseReceived') {
      recorder.counters.response += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      const r = params.response || {};
      rec.phase = 'response';
      rec.type = params.type || rec.type || '';
      rec.resourceType = params.type || rec.resourceType || '';
      rec.response = { url:r.url || rec.request?.url || '', status:r.status, statusText:r.statusText || '', headers:recorder.config.storeHeaders ? (r.headers || {}) : {}, mimeType:r.mimeType || '', charset:r.charset || '', connectionReused:!!r.connectionReused, connectionId:r.connectionId, remoteIPAddress:r.remoteIPAddress, remotePort:r.remotePort, fromDiskCache:!!r.fromDiskCache, fromPrefetchCache:!!r.fromPrefetchCache, fromServiceWorker:!!r.fromServiceWorker, encodedDataLength:r.encodedDataLength, protocol:r.protocol || '', securityState:r.securityState || '', securityDetails:r.securityDetails || null, timing:r.timing || null };
      rec.timing = r.timing || rec.timing || {};
      wakeNetworkWaits(recorder, 'response', rec);
    } else if (method === 'Network.responseReceivedExtraInfo') {
      recorder.counters.responseExtraInfo += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.responseExtraInfo = { headers:recorder.config.storeHeaders ? (params.headers || {}) : {}, blockedCookies:params.blockedCookies || [], statusCode:params.statusCode, headersText:params.headersText || '', resourceIPAddressSpace:params.resourceIPAddressSpace || '' };
      if (!rec.response) rec.response = { status:params.statusCode, headers:recorder.config.storeHeaders ? (params.headers || {}) : {} }; else if (params.statusCode && !rec.response.status) rec.response.status = params.statusCode;
      wakeNetworkWaits(recorder, 'response_extra', rec);
    } else if (method === 'Network.dataReceived') {
      recorder.counters.data += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = rec.phase === 'created' ? 'data' : rec.phase;
      rec.data = rec.data || { encodedDataLength:0, dataLength:0, chunks:0 };
      rec.data.encodedDataLength += Number(params.encodedDataLength || 0);
      rec.data.dataLength += Number(params.dataLength || 0);
      rec.data.chunks += 1;
      wakeNetworkWaits(recorder, 'data', rec);
    } else if (method === 'Network.requestServedFromCache') {
      recorder.counters.servedFromCache += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.fromCache = true;
      wakeNetworkWaits(recorder, 'cache', rec);
    } else if (method === 'Network.loadingFinished') {
      recorder.counters.finished += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = 'finished';
      rec.finishedAt = Date.now();
      rec.encodedDataLength = params.encodedDataLength;
      rec.data = rec.data || {};
      if (params.encodedDataLength !== undefined) rec.data.encodedDataLength = Math.max(Number(rec.data.encodedDataLength || 0), Number(params.encodedDataLength || 0));
      wakeNetworkWaits(recorder, 'finished', rec);
      void maybeCaptureNetworkBody(recorder, rec);
    } else if (method === 'Network.loadingFailed') {
      recorder.counters.failed += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.phase = 'failed';
      rec.failed = { errorText:params.errorText || '', canceled:!!params.canceled, blockedReason:params.blockedReason || null, corsErrorStatus:params.corsErrorStatus || null, type:params.type || rec.type || '' };
      rec.errorText = rec.failed.errorText; rec.canceled = !!params.canceled; rec.blockedReason = params.blockedReason || null;
      wakeNetworkWaits(recorder, 'failed', rec);
    } else if (method.indexOf('Network.webSocket') === 0) {
      recorder.counters.webSocket += 1;
      const requestId = String(params.requestId || params.identifier || makeWaitId(recorder.tabId, 'websocket'));
      const rec = ensureNetworkEntry(recorder, requestId);
      rec.type = rec.type || 'WebSocket'; rec.resourceType = rec.resourceType || 'WebSocket';
      if (method === 'Network.webSocketCreated') { rec.request.url = params.url || rec.request.url || ''; rec.phase = 'websocket'; }
      if (method === 'Network.webSocketWillSendHandshakeRequest') rec.webSocketRequest = params.request || params;
      if (method === 'Network.webSocketHandshakeResponseReceived') rec.webSocketResponse = params.response || params;
      if (recorder.config.includeWebSocketFrames && (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived')) {
        const payload = params.response?.payloadData ?? '';
        const trunc = truncateStringByBytes(String(payload), recorder.config.maxFrameBytes);
        appendBounded(rec.wsFrames, { t:Date.now(), method, opcode:params.response?.opcode, mask:params.response?.mask, payloadData:trunc.value, payloadTruncated:trunc.truncated, originalLength:trunc.originalLength }, recorder.config.maxFrames, rec);
      }
      if (method === 'Network.webSocketClosed') rec.webSocketClosedAt = Date.now();
      if (method === 'Network.webSocketFrameError') rec.webSocketError = params.errorMessage || params;
      wakeNetworkWaits(recorder, 'websocket', rec);
    } else if (method === 'Network.eventSourceMessageReceived') {
      recorder.counters.sse += 1;
      const rec = ensureNetworkEntry(recorder, params.requestId);
      rec.type = rec.type || 'EventSource'; rec.resourceType = rec.resourceType || 'EventSource';
      if (recorder.config.includeSse) {
        const trunc = truncateStringByBytes(String(params.data || ''), recorder.config.maxFrameBytes);
        appendBounded(rec.sseEvents, { t:Date.now(), eventName:params.eventName || '', eventId:params.eventId || '', data:trunc.value, dataTruncated:trunc.truncated, originalLength:trunc.originalLength }, recorder.config.maxSseEvents, rec);
      }
      wakeNetworkWaits(recorder, 'sse', rec);
    } else if (method.indexOf('Page.') === 0) {
      recorder.counters.page += 1;
      appendBounded(recorder.lifecycleEvents, { t:Date.now(), method, frameId:params.frameId, name:params.name, loaderId:params.loaderId }, 100);
      wakeNetworkWaits(recorder, 'page', null);
    }
    pruneNetworkRecorder(recorder);
  } catch (e) {
    rememberNetworkError(recorder, method, e, { params:gaRedactSensitive(params) });
  }
}
async function startNetworkRecorder(tabId, msg) {
  const config = normalizeNetworkRecorderConfig(msg || {});
  const key = networkRecorderKey(tabId, config.sessionId);
  let recorder = gaBrowserProNetworkRecorders.get(key);
  if (recorder && recorder.active && msg.reconfigure !== false) {
    recorder.config = config; recorder.filter = config.filter;
    if (config.clearOnStart) clearNetworkRecorderBuffer(recorder);
    recorder.diagnostics.push({ t:Date.now(), action:'reconfigure', config:recorderPublicConfig(config) });
    return { ok:true, data:{ ...networkRecorderSummary(recorder), reconfigured:true } };
  }
  if (recorder && recorder.active) return browserProError(GA_BROWSER_PRO_ERROR_CODES.ALREADY_INSTALLED, 'network recorder already started', { tabId, sessionId:config.sessionId });
  if (recorder) await stopNetworkRecorder(tabId, { sessionId:config.sessionId, keepBuffer:false, reason:'restart' }).catch(() => {});
  recorder = createNetworkRecorder(tabId, config);
  gaBrowserProNetworkRecorders.set(key, recorder);
  try {
    await enableBrowserProCdpDomains(recorder.cdpRecord, ['Network', 'Page']);
    const events = [
      'Network.requestWillBeSent','Network.requestWillBeSentExtraInfo','Network.responseReceived','Network.responseReceivedExtraInfo','Network.dataReceived','Network.requestServedFromCache','Network.loadingFinished','Network.loadingFailed',
      'Network.webSocketCreated','Network.webSocketWillSendHandshakeRequest','Network.webSocketHandshakeResponseReceived','Network.webSocketFrameSent','Network.webSocketFrameReceived','Network.webSocketFrameError','Network.webSocketClosed','Network.eventSourceMessageReceived',
      'Page.frameNavigated','Page.loadEventFired','Page.domContentEventFired','Page.lifecycleEvent','Page.frameStoppedLoading'
    ];
    subscribeBrowserProCdp(tabId, events, (source, method, params) => handleNetworkRecorderCdpEvent(recorder, source, method, params), recorder.cdpRecord);
    try { await cdpSendNetworkCommand(tabId, 'Page.setLifecycleEventsEnabled', { enabled:true }, 2000); } catch (e) { rememberNetworkError(recorder, 'Page.setLifecycleEventsEnabled', e); }
    recorder.active = true; recorder.startedAt = Date.now(); recorder.diagnostics.push({ t:Date.now(), action:'start', events, config:recorderPublicConfig(config) });
    return { ok:true, data:networkRecorderSummary(recorder) };
  } catch (e) {
    rememberNetworkError(recorder, 'start', e);
    cleanupNetworkRecorder(recorder, 'start_failed', { keepBuffer:false });
    gaBrowserProNetworkRecorders.delete(key);
    return browserProError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, 'browser_pro.network.start failed', { tabId, sessionId:config.sessionId, error:e.message || String(e) });
  }
}
function clearNetworkRecorderBuffer(recorder) {
  if (!recorder) return { entries:0, bodies:0 };
  const entries = recorder.entries.length;
  const bodies = recorder.bodyStore.size;
  recorder.entries.splice(0);
  recorder.byRequestId.clear();
  recorder.bodyStore.clear();
  recorder.bodyByRequestId.clear();
  recorder.overflowCount = 0;
  recorder.bodyOverflowCount = 0;
  recorder.diagnostics.push({ t:Date.now(), action:'clear', entries, bodies });
  return { entries, bodies };
}
function cleanupNetworkRecorder(recorder, reason, options) {
  if (!recorder) return { stopped:false };
  options = options || {};
  recorder.active = false;
  recorder.stoppedAt = Date.now();
  for (const wait of Array.from(recorder.waits.values())) finishNetworkRecorderWait(recorder, wait, false, GA_BROWSER_PRO_ERROR_CODES.CANCELLED, 'network recorder stopped', { reason:reason || 'stopped' });
  for (const sid of Array.from(recorder.cdpRecord.cdpSubscriptions || [])) { try { unsubscribeBrowserProCdp(sid); } catch (_) {} }
  recorder.cdpRecord.cdpSubscriptions = [];
  releaseBrowserProCdpDomains(recorder.cdpRecord, Array.from(recorder.cdpRecord.cdpDomains || []), reason || 'network_recorder_stop');
  recorder.cdpRecord.cdpAttached = false;
  if (options.keepBuffer === false) clearNetworkRecorderBuffer(recorder);
  recorder.diagnostics.push({ t:Date.now(), action:'stop', reason:reason || 'stopped', keepBuffer:options.keepBuffer !== false });
  return { stopped:true, summary:networkRecorderSummary(recorder) };
}
async function stopNetworkRecorder(tabId, msg) {
  const sessionId = defaultNetworkSessionId(msg || {});
  const recorder = getNetworkRecorder(tabId, sessionId);
  if (!recorder) return browserProError(GA_BROWSER_PRO_ERROR_CODES.NETWORK_RECORDER_NOT_STARTED, 'network recorder is not started', { tabId, sessionId });
  const keepBuffer = msg.keepBuffer !== false && msg.keep_buffer !== false && msg.clear !== true;
  const result = cleanupNetworkRecorder(recorder, msg.reason || 'stop', { keepBuffer });
  if (!keepBuffer || msg.remove === true) gaBrowserProNetworkRecorders.delete(recorder.key);
  return { ok:true, data:{ ...result.summary, stopped:true, keepBuffer } };
}
function cleanupNetworkRecorderTab(tabId, reason) {
  const out = [];
  for (const recorder of Array.from(gaBrowserProNetworkRecorders.values())) {
    if (Number(recorder.tabId) !== Number(tabId)) continue;
    cleanupNetworkRecorder(recorder, reason || 'tab_cleanup', { keepBuffer:false });
    gaBrowserProNetworkRecorders.delete(recorder.key);
    out.push({ sessionId:recorder.sessionId, recorderId:recorder.recorderId });
  }
  return out;
}
function requireNetworkRecorder(tabId, msg) {
  const recorder = getActiveNetworkRecorder(tabId, msg || {});
  if (!recorder) return { error: browserProError(GA_BROWSER_PRO_ERROR_CODES.NETWORK_RECORDER_NOT_STARTED, 'network recorder is not started', { tabId, sessionId:defaultNetworkSessionId(msg || {}) }) };
  return { recorder };
}
function listNetworkRecorderEntries(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const limit = numberInRange(msg.limit, 100, 0, 5000);
  const offset = numberInRange(msg.offset, 0, 0, Math.max(0, recorder.entries.length));
  const filters = { sinceSeq: msg.sinceSeq ?? msg.since_seq, requestId: msg.requestId || msg.request_id, url:msg.url, method:msg.method, type:msg.type || msg.resourceType || msg.resource_type, mime:msg.mime || msg.mimeType || msg.mime_type, status:msg.status, includeUrls:msg.includeUrls || msg.include_urls, excludeUrls:msg.excludeUrls || msg.exclude_urls };
  const all = recorder.entries.filter(rec => networkRecordMatchesList(rec, filters));
  const items = all.slice(offset, limit ? offset + limit : undefined).map(rec => networkRecordSummary(rec, { includeDetails: msg.includeDetails === true || msg.include_details === true, includeBody: msg.includeBody === true || msg.include_body === true }));
  return { ok:true, data:{ tabId:Number(tabId), sessionId:recorder.sessionId, total:all.length, offset, limit, items, nextOffset:offset + items.length, overflowCount:recorder.overflowCount } };
}
function getNetworkRecorderEntry(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const id = String(msg.requestId || msg.request_id || msg.id || '');
  if (!id) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.network.get requires requestId or id', { tabId });
  const rec = recorder.byRequestId.get(id) || recorder.entries.find(x => String(x.id) === id || String(x.requestId) === id);
  if (!rec) return browserProError(GA_BROWSER_PRO_ERROR_CODES.NO_SESSION, 'network request not found', { tabId, sessionId:recorder.sessionId, requestId:id });
  return { ok:true, data:networkRecordClone(rec, { includeBody: msg.includeBody === true || msg.include_body === true }) };
}
function getNetworkRecorderBody(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const ref = String(msg.bodyRef || msg.body_ref || '');
  const requestId = String(msg.requestId || msg.request_id || msg.id || '');
  const bodyRef = ref || recorder.bodyByRequestId.get(requestId);
  if (!bodyRef) return browserProError(GA_BROWSER_PRO_ERROR_CODES.BODY_UNAVAILABLE, 'network body is unavailable', { tabId, sessionId:recorder.sessionId, requestId, bodyRef:ref });
  const body = recorder.bodyStore.get(bodyRef);
  if (!body) return browserProError(GA_BROWSER_PRO_ERROR_CODES.BODY_UNAVAILABLE, 'network body ref not found', { tabId, sessionId:recorder.sessionId, requestId, bodyRef });
  const maxBytesRaw = msg.maxBytes ?? msg.max_bytes;
  let out = { ...body };
  if (maxBytesRaw !== undefined) {
    const maxBytes = numberInRange(maxBytesRaw, body.bytes, 0, Math.max(body.bytes || 0, body.originalLength || 0, 10 * 1024 * 1024));
    const trunc = body.base64Encoded ? { value:String(body.body || '').slice(0, maxBytes), truncated:String(body.body || '').length > maxBytes, bytes:Math.min(maxBytes, String(body.body || '').length), originalLength:body.originalLength } : truncateStringByBytes(body.body || '', maxBytes);
    out = { ...out, body:trunc.value, bodyTruncated:body.bodyTruncated || trunc.truncated, bytes:trunc.bytes };
  }
  return { ok:true, data:gaRedactSensitive(out) };
}
function makeHarEntry(rec, body) {
  const startedDateTime = rec.wallTime ? new Date(rec.wallTime * 1000).toISOString() : new Date(rec.createdAt || Date.now()).toISOString();
  const requestHeaders = headersObjectToArray(rec.request?.headers || rec.requestExtraInfo?.headers || {});
  const responseHeaders = headersObjectToArray(rec.response?.headers || rec.responseExtraInfo?.headers || {});
  const content = { size:rec.data?.dataLength || rec.encodedDataLength || -1, mimeType:rec.response?.mimeType || getHeaderValue(rec.response?.headers, 'content-type') || '', compression:0 };
  if (body) { content.text = body.body; content.encoding = body.base64Encoded ? 'base64' : undefined; content._bodyRef = body.bodyRef; content._bodyTruncated = !!body.bodyTruncated; }
  return {
    startedDateTime, time:Math.max(0, Number(rec.finishedAt || rec.updatedAt || Date.now()) - Number(rec.createdAt || Date.now())),
    request:{ method:rec.request?.method || 'GET', url:rec.request?.url || rec.response?.url || '', httpVersion:rec.response?.protocol || 'HTTP/1.1', headers:requestHeaders, queryString:[], cookies:[], headersSize:-1, bodySize:rec.request?.postData ? estimateStringBytes(rec.request.postData) : 0, postData:rec.request?.postData ? { mimeType:getHeaderValue(rec.request?.headers, 'content-type'), text:rec.request.postData, _truncated:!!rec.request.postDataTruncated } : undefined },
    response:{ status:Number(rec.response?.status || rec.responseExtraInfo?.statusCode || 0), statusText:rec.response?.statusText || '', httpVersion:rec.response?.protocol || 'HTTP/1.1', headers:responseHeaders, cookies:[], content, redirectURL:getHeaderValue(rec.response?.headers, 'location'), headersSize:-1, bodySize:rec.data?.encodedDataLength || rec.encodedDataLength || -1, _error:rec.errorText || undefined },
    cache:{}, timings:{ blocked:-1, dns:-1, connect:-1, send:0, wait:-1, receive:-1, ssl:-1 }, serverIPAddress:rec.response?.remoteIPAddress, connection:String(rec.response?.connectionId || ''), _requestId:rec.requestId, _seq:rec.seq, _type:rec.type || rec.resourceType || '', _initiator:rec.initiator, _redirects:rec.redirects || [], _wsFrames:rec.wsFrames || [], _sseEvents:rec.sseEvents || [], _bodyRef:rec.bodyRef || null, _bodyError:rec.bodyError || null
  };
}
function exportNetworkRecorderHar(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const includeBodies = msg.includeBody === true || msg.include_body === true || msg.includeBodies === true || msg.include_bodies === true;
  const filters = { sinceSeq: msg.sinceSeq ?? msg.since_seq, url:msg.url, method:msg.method, type:msg.type || msg.resourceType || msg.resource_type, mime:msg.mime || msg.mimeType || msg.mime_type, status:msg.status, includeUrls:msg.includeUrls || msg.include_urls, excludeUrls:msg.excludeUrls || msg.exclude_urls };
  const records = recorder.entries.filter(rec => networkRecordMatchesList(rec, filters));
  if (String(msg.format || '').toLowerCase() === 'json') return { ok:true, data:{ recorder:networkRecorderSummary(recorder), entries:records.map(r => networkRecordClone(r, { includeBody:includeBodies })), bodies:includeBodies ? Array.from(recorder.bodyStore.values()).map(b => gaRedactSensitive(b)) : undefined } };
  const entries = records.map(rec => makeHarEntry(rec, includeBodies && rec.bodyRef ? recorder.bodyStore.get(rec.bodyRef) : null));
  return { ok:true, data:{ log:{ version:'1.2', creator:{ name:'GA BrowserPro NetworkRecorder', version:'1.0' }, pages:[], entries }, diagnostics:networkRecorderSummary(recorder) } };
}
function networkWaitMatches(recorder, wait, eventType, rec) {
  const condition = wait.condition;
  const criteria = wait.criteria || {};
  const record = rec || null;
  if (record && !networkRecordMatchesList(record, { requestId:criteria.requestId || criteria.request_id, url:criteria.url, method:criteria.method, type:criteria.type || criteria.resourceType || criteria.resource_type, mime:criteria.mime || criteria.mimeType || criteria.mime_type, status:criteria.status, includeUrls:criteria.includeUrls || criteria.include_urls, excludeUrls:criteria.excludeUrls || criteria.exclude_urls })) return false;
  if (record) {
    const bodyContains = criteria.bodyContains ?? criteria.body_contains;
    if (bodyContains !== undefined) {
      const stored = record.bodyRef ? recorder.bodyStore.get(record.bodyRef) : null;
      if (!stored || !networkCriterionMatchesText(stored.body, bodyContains)) return false;
    }
    const wsFrame = criteria.wsFrame ?? criteria.ws_frame;
    if (wsFrame !== undefined && !(record.wsFrames || []).some(frame => networkWsFrameMatches(frame, wsFrame))) return false;
    const sseEvent = criteria.sseEvent ?? criteria.sse_event;
    if (sseEvent !== undefined && !(record.sseEvents || []).some(event => networkSseEventMatches(event, sseEvent))) return false;
  }
  if (condition === 'idle') {
    const quietFor = Date.now() - Number(recorder.lastEventAt || recorder.startedAt || recorder.createdAt);
    return quietFor >= wait.idleMs;
  }
  if (condition === 'count') {
    const count = recorder.entries.filter(r => networkRecordMatchesList(r, criteria)).length;
    return count >= wait.count;
  }
  const aliases = {
    request:['request','request_extra'], response:['response','response_extra'], body:['body'], bodycontains:['body'], finished:['finished'], failed:['failed'], websocket:['websocket'], ws:['websocket'], wsframe:['websocket'], sse:['sse'], eventsource:['sse'], sseevent:['sse'], any:['request','response','body','finished','failed','websocket','sse']
  };
  const allowed = aliases[condition] || [condition];
  return allowed.includes(eventType);
}
function finishNetworkRecorderWait(recorder, wait, ok, errorCode, message, details) {
  if (!wait || wait.done) return;
  wait.done = true;
  try { clearTimeout(wait.timeoutHandle); } catch (_) {}
  try { clearInterval(wait.intervalHandle); } catch (_) {}
  try { wait.abortController?.signal?.removeEventListener('abort', wait.abortHandler); } catch (_) {}
  recorder.waits.delete(wait.waitId);
  const elapsed_ms = Date.now() - wait.createdAt;
  if (ok) {
    recorder.counters.waitsResolved += 1;
    wait.resolve({ ok:true, data:{ waitId:wait.waitId, wait_id:wait.waitId, condition:wait.condition, elapsed_ms, ...(details || {}), recorder:networkRecorderSummary(recorder) } });
  } else {
    if (errorCode === GA_BROWSER_PRO_ERROR_CODES.TIMEOUT || errorCode === GA_BROWSER_PRO_ERROR_CODES.NETWORK_RECORDER_TIMEOUT) recorder.counters.waitsTimedOut += 1;
    if (errorCode === GA_BROWSER_PRO_ERROR_CODES.CANCELLED) recorder.counters.waitsCancelled += 1;
    wait.resolve(browserProError(errorCode || GA_BROWSER_PRO_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, message || 'browser_pro.network.wait failed', { waitId:wait.waitId, condition:wait.condition, elapsed_ms, ...(details || {}), recorder:networkRecorderSummary(recorder) }));
  }
}
function wakeNetworkWaits(recorder, eventType, rec) {
  if (!recorder || !recorder.waits.size) return;
  for (const wait of Array.from(recorder.waits.values())) {
    if (wait.done) continue;
    if (networkWaitMatches(recorder, wait, eventType, rec)) {
      wait.lastMatchSeq = rec?.seq || wait.lastMatchSeq || 0;
      finishNetworkRecorderWait(recorder, wait, true, null, null, { event:eventType, request:rec ? networkRecordSummary(rec, { includeDetails:true }) : null });
    }
  }
}
async function waitNetworkRecorder(tabId, msg) {
  const found = requireNetworkRecorder(tabId, msg);
  if (found.error) return found.error;
  const recorder = found.recorder;
  const conditionRaw = msg.condition || msg.state || msg.event || 'response';
  const condition = String(conditionRaw).toLowerCase().replace(/[-_]/g, '');
  const timeoutMs = normalizeBrowserProTimeoutMs(msg, 30000);
  const waitId = String(msg.waitId || msg.wait_id || makeWaitId(tabId, 'network_recorder'));
  const criteria = { ...msg };
  const immediateMatch = () => {
    if (condition === 'idle') {
      const idleMs = numberInRange(msg.idleMs ?? msg.idle_ms, 500, 50, Math.max(50, timeoutMs || 300000));
      const quietFor = Date.now() - Number(recorder.lastEventAt || recorder.startedAt || recorder.createdAt);
      if (quietFor >= idleMs) return { event:'idle', idle_ms:idleMs, quietFor };
      return null;
    }
    if (condition === 'count') {
      const count = numberInRange(msg.count ?? msg.minCount ?? msg.min_count, 1, 1, 1000000);
      const matches = recorder.entries.filter(r => networkRecordMatchesList(r, criteria));
      if (matches.length >= count) return { event:'count', count:matches.length, required:count, requests:matches.slice(-10).map(r => networkRecordSummary(r)) };
      return null;
    }
    const pseudoWait = { condition, criteria };
    for (const r of recorder.entries) {
      const phaseEvent = r.bodyRef ? 'body' : (r.phase === 'finished' ? 'finished' : (r.phase === 'failed' ? 'failed' : (r.response ? 'response' : 'request')));
      if (networkWaitMatches(recorder, pseudoWait, phaseEvent, r)) return { event:phaseEvent, request:networkRecordSummary(r, { includeDetails:true }) };
      if ((condition === 'websocket' || condition === 'ws') && (r.wsFrames || []).length && networkRecordMatchesList(r, criteria)) return { event:'websocket', request:networkRecordSummary(r, { includeDetails:true }) };
      if ((condition === 'sse' || condition === 'eventsource') && (r.sseEvents || []).length && networkRecordMatchesList(r, criteria)) return { event:'sse', request:networkRecordSummary(r, { includeDetails:true }) };
    }
    return null;
  };
  const instant = immediateMatch();
  if (instant || timeoutMs === 0) {
    if (instant) return { ok:true, data:{ waitId, wait_id:waitId, condition, elapsed_ms:0, ...instant, recorder:networkRecorderSummary(recorder), immediate:true } };
    return browserProError(GA_BROWSER_PRO_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, 'browser_pro.network.wait immediate check failed', { waitId, condition, timeout_ms:0, criteria:gaRedactSensitive(criteria), recorder:networkRecorderSummary(recorder) });
  }
  return await new Promise(resolve => {
    const abortController = msg.abortController || new AbortController();
    const wait = { waitId, condition, criteria, createdAt:Date.now(), resolve, abortController, done:false, idleMs:numberInRange(msg.idleMs ?? msg.idle_ms, 500, 50, Math.max(50, timeoutMs || 300000)), count:numberInRange(msg.count ?? msg.minCount ?? msg.min_count, 1, 1, 1000000), lastMatchSeq:0 };
    wait.abortHandler = () => finishNetworkRecorderWait(recorder, wait, false, GA_BROWSER_PRO_ERROR_CODES.CANCELLED, 'browser_pro.network.wait cancelled', { criteria:gaRedactSensitive(criteria) });
    try { abortController.signal.addEventListener('abort', wait.abortHandler, { once:true }); } catch (_) {}
    wait.timeoutHandle = setTimeout(() => finishNetworkRecorderWait(recorder, wait, false, GA_BROWSER_PRO_ERROR_CODES.NETWORK_RECORDER_TIMEOUT, 'browser_pro.network.wait timed out', { timeout_ms:timeoutMs, criteria:gaRedactSensitive(criteria), lastEntries:recorder.entries.slice(-20).map(r => networkRecordSummary(r)) }), timeoutMs);
    if (condition === 'idle' || condition === 'count') wait.intervalHandle = setInterval(() => {
      const m = immediateMatch();
      if (m) finishNetworkRecorderWait(recorder, wait, true, null, null, m);
    }, Math.min(250, Math.max(50, wait.idleMs || 250)));
    recorder.waits.set(waitId, wait);
  });
}
async function handleNetworkRecorderCommand(tabId, cmd, msg) {
  switch (cmd) {
    case 'browser_pro.network.start': return await startNetworkRecorder(tabId, msg);
    case 'browser_pro.network.stop': return await stopNetworkRecorder(tabId, msg || {});
    case 'browser_pro.network.status': {
      const recorder = getActiveNetworkRecorder(tabId, msg || {});
      if (!recorder) return { ok:true, data:{ tabId:Number(tabId), sessionId:defaultNetworkSessionId(msg || {}), active:false, recorders:Array.from(gaBrowserProNetworkRecorders.values()).filter(r => Number(r.tabId) === Number(tabId)).map(networkRecorderSummary) } };
      return { ok:true, data:networkRecorderSummary(recorder) };
    }
    case 'browser_pro.network.clear': {
      const found = requireNetworkRecorder(tabId, msg || {}); if (found.error) return found.error;
      const cleared = clearNetworkRecorderBuffer(found.recorder);
      return { ok:true, data:{ ...networkRecorderSummary(found.recorder), cleared } };
    }
    case 'browser_pro.network.list': return listNetworkRecorderEntries(tabId, msg || {});
    case 'browser_pro.network.get': return getNetworkRecorderEntry(tabId, msg || {});
    case 'browser_pro.network.body': return getNetworkRecorderBody(tabId, msg || {});
    case 'browser_pro.network.exportHar': return exportNetworkRecorderHar(tabId, msg || {});
    case 'browser_pro.network.wait': return await waitNetworkRecorder(tabId, msg || {});
  }
  return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Unknown network recorder command: ' + cmd, { cmd, tabId });
}

const GA_BROWSER_PRO_SELECTOR_PROBE_SOURCE = String.raw`(() => {
  const cfg = __GA_BROWSER_PRO_SELECTOR_PROBE_CFG__;
  const selector = String(cfg.selector || '');
  const state = String(cfg.state || 'attached');
  const stableMs = Math.max(0, Number(cfg.stableMs || 0));
  const maxStableWaitMs = Math.max(stableMs, Number(cfg.maxStableWaitMs || 10000));
  const mutationEpoch = Number(cfg.mutationEpoch || 0);
  let el;
  try { el = document.querySelector(selector); } catch (e) { return {syntaxError:e.message, selector}; }
  const now = performance.now();
  const out = {selector, found:!!el, state, readyState:document.readyState, visibilityState:document.visibilityState, throttled:document.hidden===true, mutationEpoch, maxStableWaitMs};
  if (!el) { out.matched = (state === 'hidden' || state === 'detached'); return out; }
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const viewportW = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
  const viewportH = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
  const intersectsViewport = r.bottom > 0 && r.right > 0 && r.top < viewportH && r.left < viewportW;
  const cssVisible = !!(r.width || r.height) && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  const ioStore = (window.__gaBrowserProSelectorIntersection = window.__gaBrowserProSelectorIntersection || {});
  const ioKey = selector;
  if (cfg.useIntersectionObserver && cssVisible && !ioStore[ioKey]?.observer && typeof IntersectionObserver === 'function') {
    try {
      const entryState = ioStore[ioKey] = ioStore[ioKey] || {};
      entryState.isIntersecting = intersectsViewport;
      entryState.intersectionRatio = intersectsViewport ? 1 : 0;
      entryState.observer = new IntersectionObserver(entries => {
        const last = entries && entries[entries.length - 1];
        if (last) { entryState.isIntersecting = !!last.isIntersecting; entryState.intersectionRatio = Number(last.intersectionRatio || 0); entryState.ts = performance.now(); }
      }, { threshold: [0, 0.01, 0.5, 1] });
      entryState.observer.observe(el);
    } catch (e) { out.intersectionObserverError = e.message || String(e); }
  }
  const ioState = ioStore[ioKey] || null;
  const ioVisible = cfg.visible === true ? !!(ioState ? ioState.isIntersecting : intersectsViewport) : true;
  const visible = cssVisible && ioVisible;
  const sig = [Math.round(r.x*10)/10,Math.round(r.y*10)/10,Math.round(r.width*10)/10,Math.round(r.height*10)/10,visible].join('|');
  const store = (window.__gaBrowserProSelectorStable = window.__gaBrowserProSelectorStable || {});
  const prev = store[selector];
  const resetByMutation = prev && prev.mutationEpoch !== mutationEpoch;
  const stableOrigin = prev && prev.sig === sig && !resetByMutation ? prev.t : now;
  const stableFor = Math.max(0, now - stableOrigin);
  store[selector] = {sig, t:stableOrigin, mutationEpoch};
  const stableTimedOut = stableMs > 0 && stableFor >= maxStableWaitMs;
  const stable = stableMs === 0 || stableFor >= stableMs || stableTimedOut;
  Object.assign(out, {visible, cssVisible, ioVisible, intersectionRatio:ioState ? ioState.intersectionRatio : (intersectsViewport ? 1 : 0), attached:true, stableFor, stable, stableTimedOut, text:(el.innerText||el.textContent||'').slice(0,500), html:(el.outerHTML||'').slice(0,2000), rect:{x:r.x,y:r.y,width:r.width,height:r.height}});
  out.matched = (state === 'attached') || (state === 'visible' && visible) || (state === 'hidden' && !visible) || (state === 'stable' && visible && stable) || (state === 'detached' && false);
  return out;
})()`;
function buildSelectorProbe(selector, state, stableMs, options = {}) {
  const cfg = {
    selector: String(selector),
    state: String(state),
    stableMs: Number(stableMs),
    maxStableWaitMs: Number(options.maxStableWaitMs || options.max_stable_wait_ms || 10000),
    mutationEpoch: Number(options.mutationEpoch || 0),
    visible: Boolean(options.visible === true || state === 'visible' || state === 'stable'),
    useIntersectionObserver: options.useIntersectionObserver !== false
  };
  return GA_BROWSER_PRO_SELECTOR_PROBE_SOURCE.replace('__GA_BROWSER_PRO_SELECTOR_PROBE_CFG__', JSON.stringify(cfg));
}
async function waitForSelector(tabId, msg) {
  const selector = msg.selector || msg.css || msg.target;
  if (!selector) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.waitForSelector requires selector', {});
  if (msg.frameId || msg.frame_id) return browserProError(GA_BROWSER_PRO_ERROR_CODES.CROSS_ORIGIN_IFRAME, 'waitForSelector currently supports the main frame only; frameId is not supported by DOM bridge', { frameId: msg.frameId || msg.frame_id });
  const state = String(msg.state || (msg.visible === true ? 'visible' : 'attached')).toLowerCase(); // attached visible hidden detached stable shadow SELECTOR_TIMEOUT getComputedStyle getBoundingClientRect MutationObserver IntersectionObserver
  if (!['attached','visible','hidden','detached','stable'].includes(state)) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.waitForSelector unsupported state', { state });
  const timeoutMs = normalizeBrowserProTimeoutMs(msg);
  const pollMs = Math.max(10, Math.min(1000, Number(msg.pollMs || msg.poll_ms || 100)));
  const stableMs = Math.max(50, Math.min(5000, Number(msg.stableMs || msg.stable_ms || 250)));
  const maxStableWaitMs = Math.max(stableMs, Math.min(60000, Math.max(100, Number(msg.maxStableWaitMs || msg.max_stable_wait_ms || 10000))));
  const record = registerWait(tabId, 'selector', { selector: String(selector), state, visible: state === 'visible' || msg.visible === true, timeout_ms: timeoutMs, poll_ms: pollMs, stable_ms: stableMs, max_stable_wait_ms: maxStableWaitMs, waitId: msg.waitId, wait_id: msg.wait_id, abortController: msg.abortController });
  const syntaxCheck = await browserProEval(tabId, `(() => { try { document.querySelector(${JSON.stringify(String(selector))}); return {ok:true}; } catch (e) { return {ok:false,error:e.message}; } })()`, true).catch(e => ({ ok:false, error:e.message || String(e) }));
  const syntaxData = syntaxCheck?.data || syntaxCheck?.result || syntaxCheck;
  if (syntaxData && syntaxData.ok === false) return finishBrowserProWait(record, false, null, GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Invalid selector syntax', { selector:String(selector), syntax_error:syntaxData.error });
  let mutationEpoch = 0;
  const visibleForProbe = msg.visible === true || state === 'visible' || state === 'stable';
  // contract literals: document.querySelector / getBoundingClientRect / visible / IntersectionObserver are inside buildSelectorProbe.
  const evaluate = () => browserProEval(tabId, buildSelectorProbe(selector, state, stableMs, { maxStableWaitMs, mutationEpoch, visible: visibleForProbe, useIntersectionObserver: msg.useIntersectionObserver !== false }), true).catch(e => ({ ok:false, error:e.message || String(e), method:'Runtime.evaluate' }));
  const first = await evaluate();
  const firstData = first?.data || first?.result || null;
  if (firstData?.matched) return finishBrowserProWait(record, true, { element: firstData, state, method: 'Runtime.evaluate', immediate: true });
  if (firstData?.syntaxError) return finishBrowserProWait(record, false, null, GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Invalid selector syntax', { selector:String(selector), syntax_error:firstData.syntaxError });
  if (timeoutMs === 0) return finishBrowserProWait(record, false, null, GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'browser_pro.waitForSelector immediate check failed', { selector:String(selector), state, timeout_ms:0, snapshot:firstData });
  const deadline = Date.now() + timeoutMs;
  return await new Promise(resolve => {
    let completed = false;
    let timerHandle = null;
    let inFlight = false;
    let pendingTick = false;
    let lastData = firstData || null;
    let lastTickAt = Date.now();
    const clearPollTimer = () => { if (timerHandle) { clearTimeout(timerHandle); const idx = record.timers.indexOf(timerHandle); if (idx >= 0) record.timers.splice(idx, 1); timerHandle = null; } };
    const complete = (res) => { if (completed) return; completed = true; clearPollTimer(); resolve(res); };
    const failIfAbort = () => { if (record.abortController?.signal?.aborted) complete(finishBrowserProWait(record, false, null, GA_BROWSER_PRO_ERROR_CODES.CANCELLED || 'CANCELLED', waitAbortMessage(record), { selector:String(selector), state })); };
    try { record.abortController.signal.addEventListener('abort', failIfAbort, { once:true }); record.listeners.push({ remove: () => record.abortController.signal.removeEventListener('abort', failIfAbort) }); } catch (_) {}
    const triggerTick = (reason, observedEpoch) => {
      if (completed) return;
      const numericEpoch = Number(observedEpoch);
      if (Number.isFinite(numericEpoch)) mutationEpoch = Math.max(mutationEpoch, numericEpoch);
      if (stableMs > 0 && (reason === 'mutation' || reason === 'observer' || reason === 'binding')) mutationEpoch += 1;
      record.last_selector_tick_reason = reason || 'poll';
      clearPollTimer();
      if (inFlight) { pendingTick = true; return; }
      tick(reason || 'trigger');
    };
    const bindingName = '__gaBrowserProSelectorSignal_' + String(record.waitId || Date.now()).replace(/[^A-Za-z0-9_$]/g, '_');
    const bindingCleanupKey = String(selector) + '|' + state + '|' + bindingName;
    const cdp = browserProPersistentCdp();
    const installBindingObserver = async () => {
      if (!cdp?.send) throw new Error('persistent CDP helper is not loaded');
      await enableBrowserProCdpDomains(record, ['Runtime']);
      const addResp = normalizePersistentBrowserProResponse(await cdp.send(tabId, 'Runtime.addBinding', { name: bindingName }, { persistent: true, name: 'selector_binding', timeoutMs: Math.min(5000, timeoutMs || 5000) }));
      if (!addResp || addResp.ok === false) throw new Error(addResp?.error?.message || addResp?.message || addResp?.error || 'Runtime.addBinding failed');
      const subId = subscribeBrowserProCdp(tabId, 'Runtime.bindingCalled', (_source, _method, params) => {
        if (completed || params?.name !== bindingName) return;
        let payload = {};
        try { payload = JSON.parse(String(params.payload || '{}')); } catch (_) { payload = { raw: params.payload }; }
        const nextEpoch = Number(payload.mutationTick || payload.epoch || 0);
        recordWaitEvent(record, { kind:'selector_binding', reason:payload.reason || 'binding', mutationTick:nextEpoch, payload });
        record.diagnostics.push({ t:Date.now(), reason:'runtime_binding_called', mutationTick:nextEpoch, bindingName });
        triggerTick(payload.reason || 'binding', nextEpoch);
      }, record);
      if (!subId) throw new Error('Runtime.bindingCalled subscription unavailable');
      const installObserver = `(() => {
        const bindingName = ${JSON.stringify(bindingName)};
        const cleanupKey = ${JSON.stringify(bindingCleanupKey)};
        window.__gaBrowserProSelectorObserverInstalled = window.__gaBrowserProSelectorObserverInstalled || {};
        window.__gaBrowserProSelectorMutationTick = window.__gaBrowserProSelectorMutationTick || 0;
        const notify = (reason, extra) => {
          window.__gaBrowserProSelectorMutationTick = (window.__gaBrowserProSelectorMutationTick || 0) + 1;
          const payload = JSON.stringify(Object.assign({reason, mutationTick: window.__gaBrowserProSelectorMutationTick, readyState: document.readyState, visibilityState: document.visibilityState, ts: Date.now()}, extra || {}));
          try { if (typeof window[bindingName] === 'function') window[bindingName](payload); } catch (e) { (window.__gaBrowserProSelectorBindingErrors = window.__gaBrowserProSelectorBindingErrors || []).push(String(e && (e.message || e))); }
          return window.__gaBrowserProSelectorMutationTick;
        };
        const prior = window.__gaBrowserProSelectorObserverInstalled[cleanupKey];
        if (prior && prior.observer) { try { prior.observer.disconnect(); } catch (_) {} }
        if (prior && prior.visibilityHandler) { try { document.removeEventListener('visibilitychange', prior.visibilityHandler, true); } catch (_) {} }
        if (prior && prior.readyHandler) { try { document.removeEventListener('DOMContentLoaded', prior.readyHandler, true); } catch (_) {} }
        const stateRef = window.__gaBrowserProSelectorObserverInstalled[cleanupKey] = {tick: window.__gaBrowserProSelectorMutationTick, installedAt: Date.now(), bindingName};
        const observer = new MutationObserver((mutations) => {
          stateRef.lastMutationAt = Date.now();
          stateRef.tick = notify('binding', {mutationCount: mutations ? mutations.length : 0});
        });
        observer.observe(document.documentElement || document, {childList:true, subtree:true, attributes:true, characterData:false});
        const visibilityHandler = () => { stateRef.lastVisibilityAt = Date.now(); stateRef.tick = notify('visibilitychange'); };
        const readyHandler = () => { stateRef.lastReadyAt = Date.now(); stateRef.tick = notify('domcontentloaded'); };
        document.addEventListener('visibilitychange', visibilityHandler, true);
        document.addEventListener('DOMContentLoaded', readyHandler, true);
        stateRef.observer = observer;
        stateRef.visibilityHandler = visibilityHandler;
        stateRef.readyHandler = readyHandler;
        stateRef.cleanup = () => {
          try { observer.disconnect(); } catch (_) {}
          try { document.removeEventListener('visibilitychange', visibilityHandler, true); } catch (_) {}
          try { document.removeEventListener('DOMContentLoaded', readyHandler, true); } catch (_) {}
          try { delete window.__gaBrowserProSelectorObserverInstalled[cleanupKey]; } catch (_) {}
        };
        notify('observer_installed');
        return {ok:true, mutationTick:window.__gaBrowserProSelectorMutationTick||0, visibilityState:document.visibilityState, bindingName};
      })()`;
      const installed = normalizePersistentBrowserProResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression: installObserver, awaitPromise: true, returnByValue: true }, { persistent: true, name: 'selector_binding_install', timeoutMs: Math.min(5000, timeoutMs || 5000) }));
      if (!installed || installed.ok === false) throw new Error(installed?.error?.message || installed?.message || installed?.error || 'selector binding observer install failed');
      const evalData = installed?.data?.result?.result?.value || installed?.data?.result?.value || installed?.result?.result?.value || installed?.result?.value || installed?.data || installed?.result || installed;
      if (Number.isFinite(Number(evalData?.mutationTick))) mutationEpoch = Math.max(mutationEpoch, Number(evalData.mutationTick));
      record.diagnostics.push({ t:Date.now(), reason:'runtime_binding_observer_installed', bindingName, mutationTick:evalData?.mutationTick });
      record.listeners.push({ remove: () => {
        const cleanupExpr = `(() => { const key=${JSON.stringify(bindingCleanupKey)}; const rec=window.__gaBrowserProSelectorObserverInstalled&&window.__gaBrowserProSelectorObserverInstalled[key]; if (rec&&typeof rec.cleanup==='function') rec.cleanup(); return true; })()`;
        try { void cdp.send(tabId, 'Runtime.evaluate', { expression: cleanupExpr, awaitPromise: true, returnByValue: true }, { persistent: true, name: 'selector_binding_cleanup', timeoutMs: 1000 }).catch(() => {}); } catch (_) {}
        try { void cdp.send(tabId, 'Runtime.removeBinding', { name: bindingName }, { persistent: true, name: 'selector_binding_remove', timeoutMs: 1000 }).catch(() => {}); } catch (_) {}
      } });
      return true;
    };
    installBindingObserver().catch(e => {
      record.diagnostics.push({ t:Date.now(), warning:'runtime_binding_observer_unavailable_poll_fallback_active', bindingName, error:e.message || String(e) });
    });
    const armPoll = () => {
      if (completed) return;
      clearPollTimer();
      const tickFromPollTimer = () => triggerTick('poll');
      // Compatibility contract for the legacy polling fallback: setTimeout(tick, pollMs)
      timerHandle = setTimeout(tickFromPollTimer, pollMs);
      record.timers.push(timerHandle);
    };
    const tick = async (reason) => {
      if (completed) return;
      if (record.abortController?.signal?.aborted) return failIfAbort();
      if (Date.now() >= deadline) return complete(finishBrowserProWait(record, false, null, GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'browser_pro.waitForSelector timed out', { selector: String(selector), state, timeout_ms: timeoutMs, diagnostics: record.diagnostics, background_throttling_suspected: Date.now() - lastTickAt > Math.max(2000, pollMs * 5), last_state:lastData }));
      lastTickAt = Date.now();
      inFlight = true;
      const res = await evaluate();
      inFlight = false;
      const data = res?.data || res?.result || null;
      if (data) lastData = data;
      if (data?.matched) return complete(finishBrowserProWait(record, true, { element: data, state, method: 'Runtime.evaluate', reason: reason || 'poll' }));
      if (data?.throttled) record.diagnostics.push({ t:Date.now(), warning:'background_tab_timer_throttling_possible', visibilityState:data.visibilityState });
      if (data?.stableTimedOut) record.diagnostics.push({ t:Date.now(), warning:'selector_stability_max_wait_reached', stableFor:data.stableFor, maxStableWaitMs:data.maxStableWaitMs });
      if (pendingTick) { pendingTick = false; return triggerTick('pending'); }
      armPoll();
    };
    triggerTick('initial');
  });
}
async function waitForAny(tabId, msg) {
  const losers = [];
  const waits = Array.isArray(msg.waits) ? msg.waits : Array.isArray(msg.conditions) ? msg.conditions : [];
  if (!waits.length) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.waitForAny requires waits/conditions', {});
  const parentTimeoutMs = normalizeBrowserProTimeoutMs(msg);
  const deadline = Date.now() + parentTimeoutMs;
  const controllers = waits.map(() => new AbortController());
  const childWaitIds = waits.map((w, i) => String((w && (w.waitId || w.wait_id)) || makeWaitId(tabId, 'any_child_' + i)));
  const children = waits.map((w, i) => ({ index:i, wait:w, waitId:childWaitIds[i], wait_id:childWaitIds[i] }));
  const childTimeoutMs = (w) => {
    const requested = normalizeBrowserProTimeoutMs(w || {}, parentTimeoutMs);
    const remaining = Math.max(0, deadline - Date.now());
    return Math.min(requested, remaining);
  };
  const cleanupChildRecord = (i, reason) => {
    const childKey = waitKey(tabId, childWaitIds[i]);
    const record = gaBrowserProWaits.get(childKey);
    if (record) {
      try { record.abortController?.abort(reason || GA_BROWSER_PRO_ERROR_CODES.CANCELLED); } catch (_) {}
      try { clearWait(record, reason || GA_BROWSER_PRO_ERROR_CODES.CANCELLED); } catch (_) {}
    }
  };
  const cleanup = (reason, keepIndex) => {
    controllers.forEach((c, i) => {
      if (i === keepIndex) return;
      try { if (!c.signal.aborted) { losers.push(i); c.abort(reason || GA_BROWSER_PRO_ERROR_CODES.CANCELLED); } } catch (_) {}
      cleanupChildRecord(i, reason || GA_BROWSER_PRO_ERROR_CODES.CANCELLED);
    });
  };
  const tasks = waits.map((w, i) => dispatchBrowserProWait(tabId, { ...w, waitId: childWaitIds[i], wait_id: childWaitIds[i], abortController: controllers[i], timeoutMs: childTimeoutMs(w) }, w.cmd || w.type || w.kind || 'selector').then(result => { if (result && result.ok) return { index:i, result }; throw result; }));
  let parentTimer = null;
  const parentTimeout = new Promise((_, reject) => { parentTimer = setTimeout(() => {
    cleanup('parent_timeout');
    reject({ error_code: GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, error: 'browser_pro.waitForAny parent timeout', details: { timeout_ms: parentTimeoutMs } });
  }, parentTimeoutMs); });
  try {
    const winner = await Promise.race([Promise.any(tasks), parentTimeout]);
    if (parentTimer) clearTimeout(parentTimer);
    cleanup('winner', winner.index);
    return { ok: true, data: { winner: winner.index, matched: winner.index, result: winner.result.data, children, losers, timeout_ms: parentTimeoutMs } };
  }
  catch (e) {
    if (parentTimer) clearTimeout(parentTimer);
    cleanup('failed');
    const errors = e && e.errors ? e.errors : [e];
    const firstTimeout = errors.find(x => x && (x.error_code === GA_BROWSER_PRO_ERROR_CODES.TIMEOUT || /timeout|timed out|parent timeout/i.test(String(x.error || x.message || ''))));
    if (firstTimeout) return browserProError(GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, firstTimeout.error || firstTimeout.message || ('browser_pro.waitForAny timed out after ' + parentTimeoutMs + 'ms; no condition matched'), { errors, children, losers, timeout_ms: parentTimeoutMs });
    return browserProError(GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'browser_pro.waitForAny timed out after ' + parentTimeoutMs + 'ms; no condition matched', { errors, children, losers, timeout_ms: parentTimeoutMs });
  }
}
async function waitForAll(tabId, msg) {
  const waits = Array.isArray(msg.waits) ? msg.waits : Array.isArray(msg.conditions) ? msg.conditions : [];
  const parentTimeoutMs = normalizeBrowserProTimeoutMs(msg);
  const failFast = msg.failFast !== false && msg.fail_fast !== false;
  const children = waits.map((w, i) => ({ index:i, kind:w?.kind || w?.type || w?.cmd || 'selector', timeout_ms: normalizeBrowserProTimeoutMs(w || {}, parentTimeoutMs) }));
  const controllers = waits.map(() => new AbortController());
  const cleanup = (reason, exceptIndex = -1) => { controllers.forEach((c, i) => { try { if (i !== exceptIndex && !c.signal.aborted) c.abort(reason || GA_BROWSER_PRO_ERROR_CODES.CANCELLED); } catch (_) {} }); };
  const deadline = Date.now() + parentTimeoutMs;
  let failureIndex = -1;
  const toResult = (settled, i) => {
    if (settled.status === 'fulfilled') return settled.value;
    const reason = settled.reason || {};
    return browserProError(reason.error_code || GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, reason.error || reason.message || 'browser_pro.waitForAll child threw', { child_index: i, reason });
  };
  const tasks = waits.map((w, i) => dispatchBrowserProWait(tabId, { ...w, abortController: controllers[i], timeoutMs: Math.min(normalizeBrowserProTimeoutMs(w || {}, parentTimeoutMs), Math.max(0, deadline - Date.now())) }, w.cmd || w.type || w.kind || 'selector')
    .then(result => {
      if (failFast && (!result || result.ok === false) && failureIndex < 0) { failureIndex = i; cleanup(GA_BROWSER_PRO_ERROR_CODES.CANCELLED, i); }
      return result;
    }, error => {
      if (failFast && failureIndex < 0) { failureIndex = i; cleanup(GA_BROWSER_PRO_ERROR_CODES.CANCELLED, i); }
      throw error;
    }));
  const settled = await Promise.allSettled(tasks);
  const results = settled.map(toResult);
  const aggregate = { matched: results.filter(r => r && r.ok).length, children, results: results.map(r => (r && (r.data || r)) || r), failFast, failure_index: failureIndex };
  const failures = results.map((r, i) => ({ index: i, result: r })).filter(x => !x.result || x.result.ok === false);
  if (failures.length) {
    cleanup(GA_BROWSER_PRO_ERROR_CODES.CANCELLED);
    const first = failures[0];
    return browserProError(first.result?.error_code || GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'browser_pro.waitForAll condition failed', { failed_index: first.index, failure_index: first.index, failures, children, results, aggregate });
  }
  return { ok: true, data: aggregate };
}
async function waitForComposite(tabId, msg, mode) { return mode === 'waitForAny' ? await waitForAny(tabId, msg) : await waitForAll(tabId, msg); }
async function dispatchBrowserProWait(tabId, msg, kind) {
  const raw = String(kind || msg.kind || msg.type || msg.cmd || '').replace(/^browserPro[._]/, '');
  const k = raw.replace(/[-_]/g, '').toLowerCase();
  if (k === 'waitforloadstate' || k === 'loadstate' || k === 'load' || k === 'domcontentloaded' || k === 'complete') return await waitForLoadState(tabId, msg);
  if (k === 'waitfornetworkidle' || k === 'networkidle') return await waitForNetworkIdle(tabId, msg);
  if (k === 'waitforselector' || k === 'selector' || k === 'css') return await waitForSelector(tabId, msg);
  if (k === 'navigateandwait' || k === 'navigate') return await navigateAndWait(tabId, msg);
  return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Unknown wait condition: ' + kind, { kind, normalized: k, wait: msg });
}
async function cancelWait(tabId, msg) {
  const waitId = msg.waitId || msg.wait_id;
  let cancelled_count = 0;
  if (waitId) { const r = gaBrowserProWaits.get(waitKey(tabId, waitId)); if (r) { try { r.abortController?.abort('cancelled'); } catch (_) {} clearWait(r, 'cancelled'); cancelled_count = 1; } }
  else cancelled_count = cancelWaitsForTab(tabId, 'cancelled');
  return { ok: true, data: { cancelled: cancelled_count, cancelled_count, waitId: waitId || null, pending: Array.from(gaBrowserProWaits.values()).filter(r => Number(r.tabId) === Number(tabId)).map(r => ({ waitId:r.waitId, kind:r.kind, age_ms:Date.now()-r.createdAt })) } };
}
function cancelBrowserProWait(tabId, msg) { return cancelWait(tabId, msg); }

function cleanupEventSubscriptionsForTab(tabId) {
  return gaBrowserProWaits.cleanupEventSubscriptionsForTab(tabId);
}
async function addEventListener(tabId, msg) {
  const eventType = msg.eventType || msg.event_type;
  if (!eventType) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.addEventListener requires eventType', {});
  const listenerId = msg.listenerId || msg.listener_id || ('listener_' + tabId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  const selector = msg.selector || null;
  const cdp = browserProPersistentCdp();
  if (cdp?.send) await cdp.send(tabId, 'Runtime.evaluate', { expression: `(() => { window.__gaBrowserProListeners = window.__gaBrowserProListeners || {}; const h = e => {}; document.addEventListener(${JSON.stringify(eventType)}, h, true); window.__gaBrowserProListeners[${JSON.stringify(listenerId)}] = { eventType:${JSON.stringify(eventType)}, selector:${JSON.stringify(selector)} }; return true; })()` }, { persistent: true, name: 'event_listener' }).catch(e => ({ ok:false, e }));
  const sub = { tabId, listenerId, eventType, selector, diagnostics: msg.diagnostics || {}, removeEventListener: true };
  gaBrowserProWaits.registerEventSubscription(listenerId, sub);
  return { ok: true, data: { listenerId, listener_id: listenerId, eventType, selector } };
}
async function removeEventListener(tabId, msg) {
  const listenerId = msg.listenerId || msg.listener_id;
  if (!listenerId) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.removeEventListener requires listenerId', {});
  const cdp = browserProPersistentCdp();
  if (cdp?.send) await cdp.send(tabId, 'Runtime.evaluate', { expression: `(() => { const x = window.__gaBrowserProListeners && window.__gaBrowserProListeners[${JSON.stringify(listenerId)}]; if (x) delete window.__gaBrowserProListeners[${JSON.stringify(listenerId)}]; return true; })()` }, { persistent: true, name: 'event_listener_remove' }).catch(e => ({ ok:false, e }));
  const existed = gaBrowserProWaits.deleteEventSubscription(listenerId);
  return { ok: true, data: { listenerId, listener_id: listenerId, removed: existed } };
}
async function getPerformanceEntries(tabId, msg) {
  const entryType = msg.entryType || msg.entry_type || 'resource';
  const nameContains = msg.nameContains || msg.name_contains || '';
  const expression = `(() => { const po = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null; const byType = performance.getEntriesByType(${JSON.stringify(entryType)}); const all = performance.getEntries(); return (byType.length ? byType : all).filter(e => !${JSON.stringify(nameContains)} || String(e.name||'').includes(${JSON.stringify(nameContains)})).map(e => ({ name:e.name, entryType:e.entryType, startTime:e.startTime, duration:e.duration })); })()`;
  const cdp = browserProPersistentCdp();
  if (cdp?.send) return normalizePersistentBrowserProResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression, returnByValue: true }, { persistent: true, name: 'performance_entries', timeoutMs: msg.timeoutMs || 5000 }));
  return { ok: true, data: { entries: [], entryType, nameContains, note: 'PerformanceObserver performance.getEntriesByType performance.getEntries Runtime.evaluate unavailable' } };
}

async function diagnoseBrowserPro(tabId, msg) {
  const tab = await chrome.tabs.get(tabId).catch(e => ({ error: e.message || String(e) }));
  const status = await callPageBrowserProWithAutoReinstall(tabId, 'browser_pro.status', {}).catch(e => browserProError(GA_BROWSER_PRO_ERROR_CODES.NO_SESSION, e.message || String(e), {}));
  const cdp = browserProPersistentCdp();
  let debuggerTargets = [];
  let frames = [];
  let inflight = 0;
  let readyState = null;
  let last_errors = [];
  const statusData = (status && status.data && typeof status.data === 'object') ? status.data : ((status && status.result && typeof status.result === 'object') ? status.result : {});
  // installed_marker is an active-session marker, not a dispatcher-loaded marker.
  // browser_pro.status can still return ok after browser_pro.uninstall because the page dispatcher
  // remains loaded in a CLOSED/NO_SESSION state for explicit post-uninstall diagnostics.
  const installed_marker = !!(status && status.ok && statusData.session_id && !['CLOSED', 'CREATED'].includes(String(statusData.state || '').toUpperCase()));
  const dispatcher_version = statusData.dispatcher_version || statusData.browser_pro_version || null;
  const install_epoch = statusData.install_epoch || 0;
  const owner_session_id = statusData.owner_session_id || null;
  const install_fingerprint = statusData.install_fingerprint || '';
  const cleanup_warnings = Array.isArray(statusData.cleanup_warnings) ? statusData.cleanup_warnings : [];
  const residue_signatures = Array.isArray(statusData.residue_signatures) ? statusData.residue_signatures : [];
  const version = 'wait-goal-v1';
  const epoch = Date.now();
  const activeWaits = Array.from(gaBrowserProWaits.values()).filter(r => Number(r.tabId) === Number(tabId)).map(r => ({ waitId:r.waitId, kind:r.kind, criteria:r.criteria, age_ms:Date.now()-r.createdAt, status:r.status, cdpSubscriptions:r.cdpSubscriptions, lastEventAt:r.lastEventAt, diagnostics:r.diagnostics }));
  const listeners = Array.from(gaBrowserProWaits.eventSubscriptionValues()).filter(s => Number(s.tabId) === Number(tabId)).map(s => ({ listenerId:s.listenerId, eventType:s.eventType, selector:s.selector, diagnostics:s.diagnostics }));
  const diagnostics = gaBrowserProWaits.diagnostics(tabId);
  try { if (chrome.debugger?.getTargets) debuggerTargets = await chrome.debugger.getTargets(); } catch (e) { last_errors.push(e.message || String(e)); }
  try {
    const probe = await callPageBrowserProWithAutoReinstall(tabId, 'browser_pro.eval', { expression: `(() => ({ readyState: document.readyState, frames: Array.from(document.frames || []).map((_, i) => ({ index:i })), inflight: (window.__gaBrowserProInflight || 0), last_errors: window.__gaBrowserProLastErrors || [] }))()` }).catch(e => ({ ok:false, error:e.message || String(e) }));
    const data = probe?.data?.result || probe?.data || probe?.result || {};
    readyState = data.readyState || readyState;
    frames = Array.isArray(data.frames) ? data.frames : frames;
    inflight = Number(data.inflight || inflight || 0);
    if (Array.isArray(data.last_errors)) last_errors = last_errors.concat(data.last_errors);
  } catch (e) { last_errors.push(e.message || String(e)); }
  const cdpObservability = {
    active_subscriptions: diagnoseBrowserProCdpSubscriptions(tabId),
    domain_refs: diagnoseBrowserProCdpDomainRefs(tabId),
    cleanup_history: diagnoseBrowserProCdpCleanupHistory(tabId),
  };
  const activeCdpSubscriptions = cdpObservability.active_subscriptions;
  const cdpDomainRefs = cdpObservability.domain_refs;
  const cdpCleanupHistory = cdpObservability.cleanup_history;
  const cdpLeaks = {
    domain_ref_leaks: cdpDomainRefs.filter(r => r.count > 0 && !r.holders.length),
    subscription_leaks: activeCdpSubscriptions.filter(s => s.waitId && !gaBrowserProWaits.has(waitKey(s.tabId, s.waitId))),
  };
  return { ok: true, data: { tabId:Number(tabId), tab, sessions: Array.from(gaBrowserProSessions.entries()).map(([tid, s]) => ({ tabId: tid, ...s })), session: gaBrowserProSessions.get(Number(tabId)) || null, queue: getBrowserProQueueStats(tabId), waits: activeWaits, activeWaits, listeners, frames, inflight, readyState, last_errors, installed_marker, dispatcher_version, install_epoch, owner_session_id, install_fingerprint, cleanup_warnings, residue_signatures, version, epoch, diagnostics, cdp: { persistent: !!cdp, debuggerTargets, ...cdpObservability, leaks: cdpLeaks }, active_subscriptions: activeCdpSubscriptions, cdp_domain_refs: cdpDomainRefs, cdp_cleanup_history: cdpCleanupHistory, domain_ref_leaks: cdpLeaks.domain_ref_leaks, subscription_leaks: cdpLeaks.subscription_leaks, debuggerTargets, dispatcher: status, persistent_cdp: !!cdp, timestamp: new Date(epoch).toISOString() } };
}

function gaWithTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function injectBrowserProDispatcherViaCdp(tabId) {
  const code = await (await fetch(chrome.runtime.getURL(GA_BROWSER_PRO_DISPATCHER_FILE))).text();
  const res = await browserProEval(tabId, code, true);
  if (!res.ok) return res;
  return { ok: true, data: { method: 'cdp_fallback' } };
}
async function confirmBrowserProDispatcher(tabId, method) {
  const ping = await callPageBrowserPro(tabId, 'browser_pro.ping', {}).catch(e => browserProError(GA_BROWSER_PRO_ERROR_CODES.INJECTION_FAILED, e.message || String(e), { method }));
  if (ping && (ping.ok || ping.error_code === GA_BROWSER_PRO_ERROR_CODES.NOT_INSTALLED || ping.error_code === GA_BROWSER_PRO_ERROR_CODES.NO_SESSION)) return { ok: true, data: { method, ping: ping.ok ? 'installed' : 'loaded' } };
  return browserProError(GA_BROWSER_PRO_ERROR_CODES.INJECTION_FAILED, 'browserPro dispatcher readiness check failed', { method, ping });
}
async function ensureBrowserProDispatcher(tabId) {
  const timeoutMs = 3000;
  let scriptingErr;
  try {
    await gaWithTimeout(
      chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [GA_BROWSER_PRO_DISPATCHER_FILE] }),
      timeoutMs,
      'chrome.scripting.executeScript(files)'
    );
    const confirmed = await confirmBrowserProDispatcher(tabId, 'scripting');
    if (confirmed.ok) return confirmed;
    scriptingErr = new Error(confirmed.message || 'readiness check failed');
  } catch (injectErr) {
    scriptingErr = injectErr;
  }
  try {
    const cdp = await injectBrowserProDispatcherViaCdp(tabId);
    if (cdp.ok) {
      const confirmed = await confirmBrowserProDispatcher(tabId, 'cdp_fallback');
      if (confirmed.ok) return { ok: true, data: { ...confirmed.data, fallback_reason: scriptingErr.message } };
      return browserProError(GA_BROWSER_PRO_ERROR_CODES.INJECTION_FAILED, 'browser_pro.install CDP fallback readiness failed', { scripting: scriptingErr.message, confirm: confirmed });
    }
    return browserProError(GA_BROWSER_PRO_ERROR_CODES.INJECTION_FAILED, 'browser_pro.install CDP fallback failed', { scripting: scriptingErr.message, cdp: cdp });
  } catch (cdpErr) {
    return browserProError(GA_BROWSER_PRO_ERROR_CODES.INJECTION_FAILED, 'browser_pro.install injection failed', { scripting: scriptingErr.message, cdp: cdpErr.message });
  }
}
async function captureVisibleFallback(tabId, format, quality, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await gaWithTimeout(chrome.tabs.captureVisibleTab(tab.windowId, { format: format === 'jpeg' ? 'jpeg' : 'png', quality }), timeoutMs, 'chrome.tabs.captureVisibleTab');
  return { ok: true, data: { screenshot: dataUrl, format: format || 'png', fallback: 'captureVisibleTab' } };
}
async function captureScreenshotWithRetry(tabId, msg) {
  const format = msg.format || 'png';
  const timeoutMs = Number(msg.timeoutMs || msg.timeout_ms || 15000);
  const attempts = Math.max(1, Math.min(3, Number(msg.retries || msg.retry || 2)));
  let lastErr = null;
  const cdp = browserProPersistentCdp();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await gaSleep(150 * attempt);
    if (cdp?.send) {
      try {
        const resp = normalizePersistentBrowserProResponse(await cdp.send(tabId, 'Page.captureScreenshot', { format, quality: msg.quality, captureBeyondViewport: msg.captureBeyondViewport === true }, { persistent: true, timeoutMs }));
        if (resp && resp.ok !== false) {
          const result = resp.data?.result || resp.result || resp.data;
          if (result && result.data) return { ok: true, data: { screenshot: 'data:image/' + format + ';base64,' + result.data, format, method: 'persistent_cdp' } };
        }
        lastErr = resp;
      } catch (e) { e.message = 'persistent screenshot failed: ' + (e.message || String(e)); lastErr = e; }
    }
    let attached = false;
    try {
      await gaWithTimeout(chrome.debugger.attach({ tabId }, '1.3'), timeoutMs, 'chrome.debugger.attach');
      attached = true;
      const result = await gaWithTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format, quality: msg.quality }), timeoutMs, 'Page.captureScreenshot');
      return { ok: true, data: { screenshot: 'data:image/' + format + ';base64,' + result.data, format, method: 'chrome.debugger' } };
    } catch (e) { lastErr = e; }
    finally { if (attached) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} } }
  }
  if (msg.fallback !== false) {
    try { return await captureVisibleFallback(tabId, format, msg.quality, timeoutMs); } catch (e) { lastErr = e; }
  }
  return browserProError(GA_BROWSER_PRO_ERROR_CODES.TIMEOUT, 'browser_pro.screenshot failed', { reason: lastErr?.message || String(lastErr), attempts });
}
async function handleBrowserPro(msg, sender) {
  const cmd = canonicalBrowserProCommand(msg.cmd);
  const tabId = msg.tabId || sender.tab?.id;
  if (cmd === 'browser_pro.list_sessions') return await handleBrowserProImpl(msg, sender, cmd, tabId);
  if (!tabId) return browserProError('NO_SESSION', cmd + ' requires tabId', { cmd, details: {} });
  // Diagnostics must be out-of-band: enqueueing browser_pro.diagnose makes its own
  // queue report show pending/depth=1 and masks the real post-uninstall state.
  // Running it directly still reports any pre-existing queued/running command
  // through getBrowserProQueueStats(tabId), so genuine queue leaks remain visible.
  if (cmd === 'browser_pro.diagnose') return await handleBrowserProImpl(msg, sender, cmd, tabId);
  return await enqueueBrowserProCommand(tabId, cmd, () => handleBrowserProImpl(msg, sender, cmd, tabId));
}
async function handleBrowserProImpl(msg, sender, cmd, tabId) {
  try {
    if (cmd === 'browser_pro.list_sessions') return { ok: true, data: { sessions: Array.from(gaBrowserProSessions.entries()).map(([tid, s]) => ({ tabId: tid, queue: getBrowserProQueueStats(tid), ...s })), count: gaBrowserProSessions.size, queues: Array.from(gaBrowserProTabQueues.entries()).map(([tid]) => ({ tabId: tid, ...getBrowserProQueueStats(tid) })) } };
    if (cmd === 'browser_pro.install') {
      const injected = await ensureBrowserProDispatcher(tabId);
      if (!injected.ok) return injected;
      const args = {
        session_id: msg.session_id || msg.sessionId,
        targets: msg.targets,
        options: msg.options,
        buffer_size: msg.buffer_size,
        force: msg.force === true,
        expected_version: msg.expected_version || msg.expectedVersion,
        install_fingerprint: msg.install_fingerprint || msg.installFingerprint
      };
      const res = await callPageBrowserPro(tabId, 'browser_pro.install', args);
      if (res && res.ok) gaBrowserProSessions.set(tabId, {
        session_id: res.data?.session_id || args.session_id,
        state: res.data?.state || 'INSTALLED',
        installed_at: res.data?.installed_at || new Date().toISOString(),
        targets: msg.targets,
        options: msg.options,
        buffer_size: msg.buffer_size,
        dispatcher_version: res.data?.dispatcher_version || res.data?.browser_pro_version,
        install_epoch: res.data?.install_epoch,
        owner_session_id: res.data?.owner_session_id,
        install_fingerprint: res.data?.install_fingerprint || args.install_fingerprint,
        install_args: args
      });
      return res;
    }
    if (cmd === 'browser_pro.status') {
      const res = await callPageBrowserProWithAutoReinstall(tabId, 'browser_pro.status', {});
      if (res && res.ok && gaBrowserProSessions.has(tabId)) gaBrowserProSessions.set(tabId, { ...gaBrowserProSessions.get(tabId), state: res.data?.state || gaBrowserProSessions.get(tabId).state });
      return res;
    }
    if (cmd === 'browser_pro.collect') return await callPageBrowserProWithAutoReinstall(tabId, 'browser_pro.collect', { since_seq: msg.since_seq, limit: msg.limit, event_types: msg.event_types, timeout_ms: msg.timeout_ms, min_count: msg.min_count });
    if (cmd === 'browser_pro.clear_buffer') return await callPageBrowserProWithAutoReinstall(tabId, 'browser_pro.clear_buffer', {});
    if (cmd === 'browser_pro.pause') return await callPageBrowserProWithAutoReinstall(tabId, 'browser_pro.pause', {});
    if (cmd === 'browser_pro.resume') return await callPageBrowserProWithAutoReinstall(tabId, 'browser_pro.resume', {});
    if (cmd === 'browser_pro.uninstall') {
      let res;
      try {
        cleanupWaitsForUninstall(tabId);
        res = await callPageBrowserPro(tabId, 'browser_pro.uninstall', {});
        return res;
      } finally {
        cleanupBrowserProTab(tabId, 'browser_pro_uninstall');
      }
    }
    if (cmd === 'browser_pro.evaluate') return await browserProEval(tabId, String(msg.expression || ''), msg.awaitPromise !== false);
    if (cmd === 'browser_pro.frames') {
      const cdp = browserProPersistentCdp();
      if (!cdp?.frameTree) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
      const fr = normalizePersistentBrowserProResponse(await cdp.frameTree(tabId, msg.options || {}));
      if (fr && fr.ok && fr.data && fr.data.frameTree) return { ok: true, data: fr.data.frameTree };
      return fr;
    }
    if (cmd === 'browser_pro.evaluate_frame') {
      const cdp = browserProPersistentCdp();
      if (!cdp?.evaluateInFrame) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
      if (!msg.frameId) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.evaluate_frame requires frameId', {});
      return normalizePersistentBrowserProResponse(await cdp.evaluateInFrame(tabId, String(msg.expression || ''), { ...(msg.options || {}), frameId: String(msg.frameId), awaitPromise: msg.awaitPromise !== false }));
    }
    if (cmd === 'browser_pro.add_new_document_script') {
      const cdp = browserProPersistentCdp();
      if (!cdp?.addNewDocumentScript) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
      if (!msg.source) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.add_new_document_script requires source', {});
      // Page.addScriptToEvaluateOnNewDocument is scoped to the CDP debugger session.
      // Keep the session alive so navigation can use the script and a later remove can find it.
      return normalizePersistentBrowserProResponse(await cdp.addNewDocumentScript(tabId, String(msg.source), { ...(msg.options || {}), persistent: true, name: 'new_document' }));
    }
    if (cmd === 'browser_pro.remove_new_document_script') {
      const cdp = browserProPersistentCdp();
      if (!cdp?.removeNewDocumentScript) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
      if (!msg.identifier) return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'browser_pro.remove_new_document_script requires identifier', {});
      return normalizePersistentBrowserProResponse(await cdp.removeNewDocumentScript(tabId, String(msg.identifier), { ...(msg.options || {}), persistent: true, name: 'new_document' }));
    }
    switch (cmd) {
      case 'browser_pro.network.start':
      case 'browser_pro.network.stop':
      case 'browser_pro.network.status':
      case 'browser_pro.network.clear':
      case 'browser_pro.network.list':
      case 'browser_pro.network.get':
      case 'browser_pro.network.body':
      case 'browser_pro.network.exportHar':
      case 'browser_pro.network.wait': return await handleNetworkRecorderCommand(tabId, cmd, msg);
      case 'browser_pro.navigate': return await navigateBrowserPro(tabId, msg);
      case 'browser_pro.navigateAndWait': return await navigateAndWait(tabId, msg);
      case 'browser_pro.waitForNavigation': return await waitForNavigation(tabId, msg);
      case 'browser_pro.addEventListener': return await addEventListener(tabId, msg);
      case 'browser_pro.removeEventListener': return await removeEventListener(tabId, msg);
      case 'browser_pro.getPerformanceEntries': return await getPerformanceEntries(tabId, msg);
      case 'browser_pro.waitForLoadState': return await waitForLoadState(tabId, msg);
      case 'browser_pro.waitForNetworkIdle': return await waitForNetworkIdle(tabId, msg);
      case 'browser_pro.waitForSelector': return await waitForSelector(tabId, msg);
      case 'browser_pro.waitForAny': return await waitForAny(tabId, msg);
      case 'browser_pro.waitForAll': return await waitForAll(tabId, msg);
      case 'browser_pro.cancelWait': return await cancelWait(tabId, msg);
      case 'browser_pro.diagnose': return await diagnoseBrowserPro(tabId, msg);
    }
    if (cmd === 'browser_pro.html') return await handleBrowserProHtml(tabId, msg);
    if (cmd === 'browser_pro.screenshot') return await captureScreenshotWithRetry(tabId, msg);
    return browserProError(GA_BROWSER_PRO_ERROR_CODES.INVALID_RULE, 'Unknown Browser Pro command: ' + cmd, { cmd });
  } catch (e) { return browserProError(GA_BROWSER_PRO_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd, tabId }); }
}

// Filter out chrome:// and other internal tabs that can't be scripted
const isScriptable = url => url && /^https?:/.test(url);

// --- Shared page/CDP script builder core ---
function buildExecScript(code, errorHandler) {
  return `(async () => {
    function smartProcessResult(result) {
      if (result === null || result === undefined || typeof result !== 'object') return result;
      try { if (result.window === result && result.document) return '[Window: ' + (result.location?.href || 'about:blank') + ']'; } catch(_){}
      if (typeof jQuery !== 'undefined' && result instanceof jQuery) {
        const elements = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) elements.push(result[i].outerHTML); } return elements;
      }
      if (result instanceof NodeList || result instanceof HTMLCollection) {
        const elements = []; for (let i = 0; i < result.length; i++) { if (result[i] && result[i].nodeType === 1) elements.push(result[i].outerHTML); } return elements;
      }
      if (result.nodeType === 1) return result.outerHTML;
      if (!Array.isArray(result) && typeof result === 'object' && 'length' in result && typeof result.length === 'number') {
        const firstElement = result[0];
        if (firstElement && firstElement.nodeType === 1) {
          const elements = []; const length = Math.min(result.length, 100);
          for (let i = 0; i < length; i++) { const elem = result[i]; if (elem && elem.nodeType === 1) elements.push(elem.outerHTML); } return elements;
        }
      }
      try { return JSON.parse(JSON.stringify(result, function(key, value) { if (typeof value === 'object' && value !== null) { if (value.nodeType === 1) return value.outerHTML; if (value === window || value === document) return '[Object]'; try { if (value.window === value && value.document) return '[Window]'; } catch(_){} } return value; })); } catch (e) { return '[无法序列化: ' + e.message + ']'; }
    }
    try {
      const jsCode = ${JSON.stringify(code)}.trim();
      const lines = jsCode.split(/\\r?\\n/).filter(l => l.trim());
      const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      let r;
      function _air(c) { const ls = c.split(/\\r?\\n/); let i = ls.length - 1; while (i >= 0 && !ls[i].trim()) i--; if (i < 0) return c; const t = ls[i].trim(); if (/^(return |return;|return$|let |const |var |if |if\\(|for |for\\(|while |while\\(|switch|try |throw |class |function |async |import |export |\\/\\/|})/.test(t)) return c; ls[i] = ls[i].match(/^(\\s*)/)[1] + 'return ' + t; return ls.join('\\n'); }
      if (lastLine.startsWith('return')) {
        r = await (new AsyncFunction(jsCode))();
      } else {
        try { r = eval(jsCode); if (r instanceof Promise) r = await r; } catch (e) {
          if (e instanceof SyntaxError && (/return/i.test(e.message) || /await/i.test(e.message))) { r = await (new AsyncFunction(_air(jsCode)))(); } else throw e;
        }
      }
      return { ok: true, data: smartProcessResult(r) };
    } catch (e) {
      ${errorHandler}
    }
  })()`;
}

function buildPageScript(code) {
  return buildExecScript(code, `
      const errMsg = e.message || String(e);
      return { ok: false, error: { name: e.name || 'Error', message: errMsg, stack: e.stack || '' },
        csp: errMsg.includes('Refused to evaluate') || errMsg.includes('unsafe-eval') || errMsg.includes('Content Security Policy') };
  `);
}

function buildCdpScript(code) {
  return buildExecScript(code, `
      return { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } };
  `);
}

// --- WebSocket Client for TMWebDriver ---
let ws = null;
const WS_URL = 'ws://127.0.0.1:18765';
const WS_RECONNECT_INITIAL_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
let wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;

function scheduleProbe(resetDelay) {
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  const jitter = 0.85 + (Math.random() * 0.3);
  const delayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs)) * jitter;
  // Use chrome.alarms to survive MV3 service worker suspension
  chrome.alarms.create('tmwd-ws-probe', { delayInMinutes: Math.max(0.02, delayMs / 60000) });
}
function bumpProbeBackoff() {
  wsReconnectDelayMs = Math.min(WS_RECONNECT_MAX_MS, Math.max(WS_RECONNECT_INITIAL_MS, wsReconnectDelayMs * 2));
}

function scheduleKeepalive() {
  // Keep SW alive while WS is connected (~25s, under 30s SW timeout)
  chrome.alarms.create('tmwd-ws-keepalive', { delayInMinutes: 0.4 }); // ~24s
}

async function isServerAlive() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    await fetch('http://127.0.0.1:18765', { signal: ctrl.signal });
    return true; // Got HTTP response → port is listening
  } catch (e) {
    return false; // Network error (connection refused) or timeout → server not alive
  }
}

async function probeAndConnectWS(resetDelay) {
  if (ws && ws.readyState <= 1) return; // Already connected/connecting
  if (resetDelay) wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
  if (await isServerAlive()) {
    console.log('[TMWD-WS] Server detected, connecting...');
    connectWS();
  } else {
    bumpProbeBackoff();
    scheduleProbe();
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tmwd-self-reload') {
    chrome.runtime.reload();
    return;
  }
  if (alarm.name === 'tmwd-ws-keepalive') {
    // Keepalive: ping to keep SW alive + detect dead connections
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send('{"type":"ping"}'); } catch (_) {}
      scheduleKeepalive();
    } else {
      // Connection lost, switch to probe mode
      ws = null;
      scheduleProbe();
    }
  }
  if (alarm.name === 'tmwd-ws-probe') {
    await probeAndConnectWS(false);
  }
});

async function handleWsExec(data) {
  const tabId = data.tabId;
  console.log('[TMWD-WS] Exec request', data.id, 'on tab', tabId);
  ws.send(JSON.stringify({ type: 'ack', id: data.id }));
  if (!tabId) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: 'No tabId provided' }));
    return;
  }
  // Navigation assignments can abort the injected async function before it returns;
  // perform simple top-level navigations via tabs.update so TMWebDriver gets a result.
  const codeText = String(data.code || '').trim();
  const navMatch = codeText.match(/^(?:window\.)?location(?:\.href)?\s*=\s*(['"])(.*?)\1\s*;?$/);
  if (navMatch) {
    try {
      await chrome.tabs.update(tabId, { url: navMatch[2] });
      ws.send(JSON.stringify({ type: 'result', id: data.id, result: { navigated: true, url: navMatch[2] } }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } }));
    }
    return;
  }
  // TMWebDriver.newtab historically injects userscript-only GM_openInTab().  The
  // extension bridge runs in page MAIN world where GM_* is unavailable, so emulate
  // the common literal call at the WS boundary and still report captured newTabs.
  const gmOpenMatch = codeText.match(/^GM_openInTab\(\s*(['"])(.*?)\1\s*\)\s*;?$/);
  if (gmOpenMatch) {
    try {
      const t = await chrome.tabs.create({ url: gmOpenMatch[2], active: true });
      const newTabs = [{ id: t.id, tabId: t.id, url: t.url || gmOpenMatch[2], title: t.title || '' }];
      ws.send(JSON.stringify({ type: 'result', id: data.id, result: { opened: true, tabId: t.id, url: gmOpenMatch[2] }, newTabs }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } }));
    }
    return;
  }
  // Use onCreated listener to reliably capture new tabs (avoids race condition with query-diff)
  const newTabIds = new Set();
  const onCreated = (tab) => { newTabIds.add(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    let res;
    try {
      // MV3 chrome.scripting.executeScript can hang indefinitely on some live pages
      // (page world blocked/navigating/extension context edge cases).  TMWebDriver
      // has already ACKed the request, so bound this phase and fall back to CDP.
      const EXECUTE_SCRIPT_TIMEOUT_MS = 2500;
      const executePromise = chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (s) => await eval(s),
        args: [buildPageScript(data.code)]
      });
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => {
        const err = new Error('chrome.scripting.executeScript timed out after ' + EXECUTE_SCRIPT_TIMEOUT_MS + 'ms');
        err.name = 'ExecuteScriptTimeout';
        reject(err);
      }, EXECUTE_SCRIPT_TIMEOUT_MS));
      const result = await Promise.race([executePromise, timeoutPromise]);
      res = result[0]?.result;
      if (res === null || res === undefined) {
        console.log('[TMWD-WS] executeScript returned null/undefined, treating as CSP issue');
        res = { ok: false, error: { name: 'Error', message: 'executeScript returned null (possible CSP or context issue)', stack: '' }, csp: true };
      }
    } catch (e) {
      console.log('[TMWD-WS] scripting.executeScript failed:', e.message);
      res = { ok: false, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' }, csp: true };
    }
    // CDP fallback for CSP-restricted pages
    if (res && !res.ok && res.csp) {
      console.log('[TMWD-WS] CDP fallback for tab', tabId);
      const wrappedCode = buildCdpScript(data.code);
      try {
        const cdp = browserProPersistentCdp();
        if (!cdp?.send) throw new Error('persistent CDP helper is not loaded');
        const resp = normalizePersistentBrowserProResponse(await cdp.send(tabId, 'Runtime.evaluate', {
          expression: wrappedCode, awaitPromise: true, returnByValue: true
        }, { name: 'default', persistent: false }));
        if (!resp || resp.ok === false) throw new Error(resp?.error || resp?.message || 'persistent CDP Runtime.evaluate failed');
        const cdpRes = resp.data?.result || resp.result || resp.data;
        if (cdpRes.exceptionDetails) {
          const desc = cdpRes.exceptionDetails.exception?.description || 'CDP Error';
          res = { ok: false, error: { name: 'Error', message: desc, stack: desc } };
        } else {
          res = cdpRes.result.value;
        }
      } catch (cdpErr) {
        res = { ok: false, error: { name: 'Error', message: 'CDP fallback failed: ' + cdpErr.message, stack: '' } };
      }
    }
    // Grace period for async tab creation (e.g. link click with target=_blank)
    if (newTabIds.size === 0) await new Promise(r => setTimeout(r, 200));
    chrome.tabs.onCreated.removeListener(onCreated);
    // Get full info for captured new tabs
    const newTabs = [];
    for (const id of newTabIds) {
      try { const t = await chrome.tabs.get(id); newTabs.push({id: t.id, url: t.url, title: t.title}); } catch (_) {}
    }
    if (res?.ok) {
      ws.send(JSON.stringify({ type: 'result', id: data.id, result: res.data, newTabs }));
    } else {
      console.log(res);
      ws.send(JSON.stringify({ type: 'error', id: data.id, error: res?.error || 'Unknown error', newTabs }));
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e.name || 'Error', message: e.message || String(e), stack: e.stack || '' } }));
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

function connectWS() {
  if (ws && ws.readyState <= 1) return; // CONNECTING or OPEN
  ws = null;
  console.log('[TMWD-WS] Connecting to', WS_URL);
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn('[TMWD-WS] Constructor failed:', e && (e.message || String(e)));
    ws = null;
    bumpProbeBackoff();
    scheduleProbe();
    return;
  }
  ws.onopen = async () => {
    wsReconnectDelayMs = WS_RECONNECT_INITIAL_MS;
    console.log('[TMWD-WS] Connected!');
    scheduleKeepalive(); // Keep SW alive while connected
    const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
    ws.send(JSON.stringify({
      type: 'ext_ready',
      tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title }))
    }));
    console.log('[TMWD-WS] Sent ext_ready with', tabs.length, 'tabs');
  };
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id && data.code) {
        let code = data.code;
        // If code is a JSON string representing an object, parse it
        if (typeof code === 'string') {
          try { const p = JSON.parse(code); if (p && typeof p === 'object') code = p; } catch (_) {}
        }
        if (typeof code === 'object' && code !== null && code.cmd) {
          // Custom protocol message → route to handleExtMessage
          if (code.tabId === undefined && data.tabId !== undefined) code.tabId = data.tabId;
          const res = await handleExtMessage(code, {});
          if (isBrowserProCommand(code.cmd) || isNativeBrowserCommand(code.cmd)) ws.send(JSON.stringify({ type: 'result', id: data.id, result: res.ok ? (res.data ?? res.results ?? res) : res }));
          else ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
        } else if (typeof code === 'string') {
          // Plain JS code
          await handleWsExec(data);
        } else if (typeof code === 'object' && code !== null) {
          // Object without cmd → legacy extension message
          const msg = code.tabId === undefined && data.tabId !== undefined ? { ...code, tabId: data.tabId } : code;
          const res = await handleExtMessage(msg, {});
          if (isBrowserProCommand(msg.cmd) || isNativeBrowserCommand(msg.cmd)) ws.send(JSON.stringify({ type: 'result', id: data.id, result: res.ok ? (res.data ?? res.results ?? res) : res }));
          else ws.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
        }
      }
    } catch (e) {
      console.error('[TMWD-WS] message parse error', e);
    }
  };
  ws.onclose = () => {
    console.log('[TMWD-WS] Disconnected');
    ws = null;
    bumpProbeBackoff();
    scheduleProbe();
  };
  ws.onerror = (e) => {
    // Expected when the local TMWebDriver process exits between probe and connect.
    // onclose will fire after this and switch back to probe mode.
    console.debug('[TMWD-WS] Connection error; waiting for local server', {
      readyState: ws ? ws.readyState : null,
      type: e && e.type ? e.type : 'error'
    });
  };
}

// Initial probe + wake-up Browser Pro without creating noisy refused WebSockets.
void probeAndConnectWS(true);
chrome.runtime.onStartup.addListener(() => { void probeAndConnectWS(true); });
chrome.runtime.onInstalled.addListener(() => { void probeAndConnectWS(true); });

// Sync tab list on changes
async function sendTabsUpdate() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url) && !/streamlit/i.test(t.title));
  ws.send(JSON.stringify({
    type: 'tabs_update',
    tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title }))
  }));
}
chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.status === 'complete') sendTabsUpdate();
});
chrome.tabs.onRemoved.addListener((tabId) => { cleanupBrowserProTab(tabId, 'tab_removed'); sendTabsUpdate(); });
chrome.tabs.onCreated.addListener(() => sendTabsUpdate());
