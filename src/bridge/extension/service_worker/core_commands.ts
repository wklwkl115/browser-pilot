import { handlePersistentCdpCommand } from "./cdp";
import { BrowserPilotNativeProtocol } from "./protocol";
import { chromeApi as chrome } from "./runtimeEnv";
import { isScriptable, browserPilotBridgeInfo } from "./bridge_info";
import { handleBrowserPilotNativeCommand, isBrowserPilotNativeCommand } from "./runtime.js";
import { BROWSER_PILOT_ERROR_CODES, bridgeError, normalizeBridgeResponse, normalizePersistentBrowserPilotResponse, browserPilotPersistentCdp } from "./runtimeSupport.js";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotBridgeSender, BrowserPilotChromeCookie, BrowserPilotNativeProtocolRuntime } from "./types";

// core_commands.js - non-native bridge commands: tabs, cookies, management, content settings, batch, CDP.

type BridgeWakeProbe = (resetDelay: boolean) => unknown;
type ValidatedBridgeCommand = { ok: true; command: BrowserPilotBridgeCommand } | { ok: false; error?: string; details?: JsonRecord };
type BrowserPilotCoreDispatchContext = { resolveParams?: (params: unknown) => JsonRecord };
type BrowserPilotCoreCommandHandler = (msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender, context: BrowserPilotCoreDispatchContext) => Promise<BrowserPilotBridgeResponse>;
let bridgeWakeProbe: BridgeWakeProbe | null = null;

function coreRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function coreErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function coreErrorDetails(error: unknown): JsonRecord { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

async function probeTabCapabilities(tabId: number, tab: { url?: string; status?: string }, timeoutMs: number): Promise<BrowserPilotBridgeResponse> {
  if (!isScriptable(tab.url)) return bridgeError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'Target tab is not scriptable', { tabId, url: tab.url, scriptable: false });
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => true });
  } catch (error) {
    return bridgeError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'Target tab failed the scriptability probe', { tabId, url: tab.url, scriptable: false, error: coreErrorDetails(error) });
  }
  const cdp = browserPilotPersistentCdp();
  if (!cdp?.send) return bridgeError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'Target tab has no persistent CDP capability', { tabId, url: tab.url, scriptable: true, cdpAvailable: false });
  const response = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Runtime.evaluate', { expression: '1', returnByValue: true }, { name: 'operation-tab-readiness', persistent: true, timeoutMs }));
  if (response?.ok === false) return bridgeError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'Target tab CDP capability probe failed', { tabId, url: tab.url, scriptable: true, cdpAvailable: false, cdp: response });
  return { ok: true, data: { tabId, url: tab.url, status: tab.status, scriptable: true, cdpAvailable: true } };
}

async function waitForCreatedTabReady(tabId: number, timeoutMs: number): Promise<BrowserPilotBridgeResponse> {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  let tab = await chrome.tabs.get(tabId);
  while (tab.status !== 'complete' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    tab = await chrome.tabs.get(tabId);
  }
  if (tab.status !== 'complete') return bridgeError(BROWSER_PILOT_ERROR_CODES.TIMEOUT, 'Created tab did not reach ready state before the command deadline', { tabId, url: tab.url, status: tab.status, timeoutMs });
  return await probeTabCapabilities(tabId, tab, Math.max(100, deadline - Date.now()));
}

async function readContentFingerprintViaScript(tabId: number, drainDirty = false): Promise<JsonRecord> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [drainDirty],
    func: (d: boolean) => {
      type BrowserPilotFallbackFingerprintState = { seq: number; at: number; since: number; overflow: boolean; o?: MutationObserver };
      const key = '__browserPilotFingerprintFallbackState__';
      const holder = globalThis as unknown as Record<string, BrowserPilotFallbackFingerprintState | undefined>;
      let state = holder[key];
      if (!state) {
        state = { seq: 1, at: Date.now(), since: 1, overflow: false };
        holder[key] = state;
      }
      if (!state.o && document.documentElement) {
        state.o = new MutationObserver((m = []) => {
          const p = state!.seq;
          state.seq += 1;
          state.at = Date.now();
          if (!state.overflow) state.since = p;
          if (m.length) state.overflow = true;
        });
        state.o.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      const els = Array.from(document.body?.querySelectorAll('*') ?? []).slice(0, 500);
      let vc = 0;
      for (const element of els) {
        try {
          const rect = element.getBoundingClientRect();
          if ((rect.width > 0 || rect.height > 0) && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth) vc += 1;
        } catch {
          /* ignore per-node geometry errors */
        }
      }
      const ic = document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[tabindex]").length;
      const data = {
        changeSeq: state.seq,
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        visibleCount: vc,
        interactiveCount: ic,
        capturedAt: state.at,
        dirty: {
          roots: [],
          overflow: state.overflow,
          sinceSeq: state.since,
        },
      };
      if (d) {
        state.overflow = false;
        state.since = state.seq;
      }
      return data;
    },
  });
  const first = Array.isArray(results) ? results[0] as { result?: unknown } | undefined : undefined;
  return coreRecord(first?.result);
}

function setBridgeWakeProbe(probe: unknown): void {
  bridgeWakeProbe = typeof probe === 'function' ? probe as BridgeWakeProbe : null;
}

async function handleBridgeWake(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  if (bridgeWakeProbe) void Promise.resolve(bridgeWakeProbe(true)).catch(() => {});
  return { ok: true, data: { connecting: !!bridgeWakeProbe, bridge: browserPilotBridgeInfo(), url: msg.url || sender.tab?.url || null } };
}

function normalizeBrowserPilotCreateTabUrl(value: unknown): { ok: true; url: string } | { ok: false; error: string; details: JsonRecord } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: true, url: 'about:blank' };
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch (_) { return { ok: false, error: 'tabs.create requires an absolute URL or about:blank', details: { url: value } }; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'javascript:' || protocol === 'data:') return { ok: false, error: 'tabs.create does not accept javascript: or data: URLs; use browser_execute for JavaScript in an existing tab', details: { url: raw, protocol } };
  return { ok: true, url: parsed.href };
}

async function handleTabsCommand(msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  try {
    if (!msg.method || msg.method === 'list') {
      const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
      const data = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId, openerTabId: t.openerTabId, incognito: t.incognito === true }));
      return { ok: true, data };
    }
    if (msg.method === 'switch') {
      const tabId = Number(msg.tabId || 0);
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab.windowId !== undefined) await chrome.windows.update(Number(tab.windowId), { focused: true });
      const current = await chrome.tabs.get(tabId);
      const capability = await probeTabCapabilities(tabId, current, Math.max(100, Number(msg.timeoutMs ?? msg.timeout_ms ?? 5000)));
      return capability.ok === false ? capability : { ok: true, data: { active: true, ...coreRecord(capability.data) } };
    }
    if (msg.method === 'create') {
      const normalized = normalizeBrowserPilotCreateTabUrl(msg.url);
      if (!normalized.ok) return bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, normalized.error, { cmd: msg.cmd, method: msg.method, ...normalized.details });
      if (msg.incognito) {
        // Isolated (logged-out) browsing context = a fresh incognito window with its own cookie jar.
        // Requires the user to have enabled "Allow in incognito" for this extension; we can detect that
        // but not toggle it, so on denial return a clear, actionable recovery instead of a raw failure.
        const allowed = await new Promise<boolean>((resolve) => {
          try {
            if (chrome.extension && typeof chrome.extension.isAllowedIncognitoAccess === 'function') chrome.extension.isAllowedIncognitoAccess((a: boolean) => resolve(!!a));
            else resolve(true); // can't pre-check on this build — let windows.create surface the real error
          } catch { resolve(true); }
        });
        if (!allowed) return bridgeError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'Incognito access is not granted to the Browser Pilot Bridge extension', { cmd: msg.cmd, method: msg.method, recovery: 'Open chrome://extensions, find "Browser Pilot Bridge" -> Details -> enable "Allow in incognito", then retry browser_tabs create with incognito:true' });
        const win = await chrome.windows.create({ url: normalized.url, incognito: true, focused: msg.active !== false });
        const incognitoTab = win && Array.isArray(win.tabs) ? win.tabs[0] : undefined;
        if (!incognitoTab || incognitoTab.id === undefined) return bridgeError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'Incognito window was created but no tab was returned', { cmd: msg.cmd, method: msg.method });
        const ready = await waitForCreatedTabReady(incognitoTab.id, Math.max(100, Number(msg.timeoutMs ?? msg.timeout_ms ?? 5000)));
        if (ready.ok === false) return ready;
        return { ok: true, data: { id: incognitoTab.id, tabId: incognitoTab.id, url: incognitoTab.url || normalized.url, title: incognitoTab.title || '', windowId: incognitoTab.windowId, openerTabId: incognitoTab.openerTabId, incognito: true, ...coreRecord(ready.data) } };
      }
      const tab = await chrome.tabs.create({ url: normalized.url, active: msg.active !== false });
      if (tab.id === undefined) return bridgeError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'Created tab did not return a tab id', { cmd: msg.cmd, method: msg.method });
      const ready = await waitForCreatedTabReady(tab.id, Math.max(100, Number(msg.timeoutMs ?? msg.timeout_ms ?? 5000)));
      if (ready.ok === false) return ready;
      return { ok: true, data: { id: tab.id, tabId: tab.id, url: tab.url || normalized.url, title: tab.title || '', windowId: tab.windowId, openerTabId: tab.openerTabId, incognito: tab.incognito === true, ...coreRecord(ready.data) } };
    }
    if (msg.method === 'close') {
      const rawTarget = msg.targetTabId ?? msg.closeTabId ?? msg.tabId;
      const targetTabId = Number(rawTarget);
      if (!Number.isInteger(targetTabId) || targetTabId <= 0) {
        return bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'tabs.close requires a valid targetTabId', { cmd: msg.cmd, method: msg.method, targetTabId: rawTarget });
      }
      const tab = await chrome.tabs.get(targetTabId);
      await chrome.tabs.remove(targetTabId);
      return { ok: true, data: { id: targetTabId, tabId: targetTabId, url: tab.url || '', title: tab.title || '', windowId: tab.windowId, openerTabId: tab.openerTabId } };
    }
    return bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown tabs method: ' + String(msg.method), { cmd: msg.cmd, method: msg.method });
  } catch (e) {
    return bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, method: msg.method });
  }
}

async function handleManagementCommand(msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  try {
    if (msg.method === 'list') {
      const all = await chrome.management.getAll();
      return { ok: true, data: all.map(e => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type, version: e.version })) };
    }
    if (msg.method === 'reload') {
      chrome.alarms.create('browser-pilot-self-reload', { when: Date.now() + 200 });
      return { ok: true };
    }
    if (msg.method === 'disable') {
      await chrome.management.setEnabled(String(msg.extId || ''), false);
      return { ok: true };
    }
    if (msg.method === 'enable') {
      await chrome.management.setEnabled(String(msg.extId || ''), true);
      return { ok: true };
    }
    return bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown management method: ' + String(msg.method), { cmd: msg.cmd, method: msg.method });
  } catch (e) {
    return bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, method: msg.method });
  }
}

async function handleContentSettingsCommand(msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  try {
    const type = String(msg.type || 'automaticDownloads');
    const setting = String(msg.setting || 'allow');
    const pattern = String(msg.pattern || '<all_urls>');
    const settings = chrome.contentSettings || {};
    const target = settings[type];
    if (!target || typeof target.set !== 'function') {
      return bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unsupported contentSettings type: ' + type, { cmd: msg.cmd, type });
    }
    await target.set({ primaryPattern: pattern, setting });
    return { ok: true };
  } catch (e) {
    return bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, type: msg.type, setting: msg.setting, pattern: msg.pattern });
  }
}

async function handleContentFingerprintCommand(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  const tabId = Number(msg.tabId || sender.tab?.id || 0);
  if (!tabId) return bridgeError(BROWSER_PILOT_ERROR_CODES.NO_SESSION, 'content.fingerprint requires a tabId', { cmd: msg.cmd, tabId: msg.tabId });
  let messageError: unknown;
  try {
    const response = coreRecord(await chrome.tabs.sendMessage(tabId, msg.drainDirty === true ? { cmd: 'browserPilot.contentFingerprint', drainDirty: true } : { cmd: 'browserPilot.contentFingerprint' }));
    if (response.ok !== false) return { ok: true, data: coreRecord(response.data ?? response) };
    messageError = new Error('content fingerprint responder returned ok:false');
  } catch (e) {
    messageError = e;
  }
  try {
    return { ok: true, data: await readContentFingerprintViaScript(tabId, msg.drainDirty === true) };
  } catch (scriptError) {
    return bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'content fingerprint unavailable', { cmd: msg.cmd, tabId, error: coreErrorDetails(messageError), fallbackError: coreErrorDetails(scriptError) });
  }
}

function browserPilotCookiePartitionIdentity(cookie: BrowserPilotChromeCookie | null | undefined): string {
  const key = cookie && cookie.partitionKey;
  if (!key || typeof key !== 'object') return '';
  return [key.topLevelSite || '', key.hasCrossSiteAncestor === undefined ? '' : String(key.hasCrossSiteAncestor)].join('\u0000');
}

function browserPilotCookieIdentity(cookie: BrowserPilotChromeCookie | null | undefined): string {
  const item: BrowserPilotChromeCookie = cookie || {};
  return [item.name || '', item.domain || '', item.path || '', item.storeId || '', browserPilotCookiePartitionIdentity(item)].join('\u0000');
}

function mergeBrowserPilotCookies(cookieLists: unknown[]): BrowserPilotChromeCookie[] {
  const merged: BrowserPilotChromeCookie[] = [];
  const seen = new Set<string>();
  for (const list of cookieLists) {
    for (const cookie of Array.isArray(list) ? list : []) {
      const key = browserPilotCookieIdentity(cookie as BrowserPilotChromeCookie);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(cookie as BrowserPilotChromeCookie);
    }
  }
  return merged;
}

function normalizeBrowserPilotCookieUrl(value: unknown): { ok: true; url: string; origin?: string; protocol: string; unsupported?: boolean } | { ok: false; error: string; details: JsonRecord } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: false, error: 'cookies requires an http(s) URL or a tab with an http(s) URL', details: { url: value } };
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch (_) { return { ok: false, error: 'cookies requires a valid absolute URL', details: { url: value } }; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return { ok: true, url: parsed.href, protocol, unsupported: true };
  return { ok: true, url: parsed.href, origin: parsed.origin, protocol };
}

async function handleCookies(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  try {
    let url: unknown = msg.url || sender.tab?.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(Number(msg.tabId));
      url = tab.url;
    }
    const normalized = normalizeBrowserPilotCookieUrl(url);
    if (!normalized.ok) return bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, normalized.error, { cmd: msg.cmd, tabId: msg.tabId, ...normalized.details });
    if (normalized.unsupported) return { ok: true, data: [], details: { reason: 'unsupported_cookie_url_scheme', url: normalized.url, protocol: normalized.protocol } };
    const all = await chrome.cookies.getAll({ url: normalized.url });
    const part = await chrome.cookies.getAll({ url: normalized.url, partitionKey: { topLevelSite: normalized.origin || normalized.url } }).catch((): BrowserPilotChromeCookie[] => []);
    const merged = mergeBrowserPilotCookies([all, part]);
    return { ok: true, data: merged };
  } catch (e) {
    return bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, tabId: msg.tabId });
  }
}

async function handleCDP(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender, context: BrowserPilotCoreDispatchContext = {}): Promise<BrowserPilotBridgeResponse> {
  const tabId = Number(msg.tabId || sender.tab?.id || 0);
  if (!tabId) return bridgeError(BROWSER_PILOT_ERROR_CODES.NO_SESSION, context.resolveParams ? 'no tabId for batch cdp command' : 'no tabId', { cmd: msg.cmd, method: msg.method });
  const cdp = browserPilotPersistentCdp();
  if (!cdp?.send) return bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: msg.cmd, method: msg.method, tabId });
  const params = context.resolveParams ? context.resolveParams(msg.params) : coreRecord(msg.params);
  const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, String(msg.method || ''), params, { name: String(msg.name || 'default'), persistent: msg.persistent === true, timeoutMs: msg.timeoutMs || msg.timeout_ms }));
  const data = coreRecord(resp.data);
  if (resp && resp.ok !== false) return { ok: true, data: data.result !== undefined ? data.result : (resp.result || resp.data) };
  return bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, resp?.error || resp?.message || 'persistent CDP send failed', { cmd: msg.cmd, method: msg.method, tabId, persistent: resp });
}

async function handlePersistentCDP(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  const resp = await handlePersistentCdpCommand(msg, sender);
  return normalizeBridgeResponse(resp, msg.cmd);
}

function validateBrowserPilotBridgeProtocolMessage(msg: BrowserPilotBridgeCommand): ValidatedBridgeCommand {
  const protocol = BrowserPilotNativeProtocol as BrowserPilotNativeProtocolRuntime & { validateCommand?: (command: unknown, options?: JsonRecord) => ValidatedBridgeCommand };
  if (!protocol || typeof protocol.validateCommand !== 'function') {
    return { ok: false, error: 'Browser Pilot protocol schema is not loaded', details: { cmd: msg && msg.cmd } };
  }
  return protocol.validateCommand(msg, { allowMissingTabId: true });
}

const BROWSER_PILOT_CORE_COMMAND_HANDLERS: Record<string, BrowserPilotCoreCommandHandler> = {
  bridge_wake: (msg, sender) => handleBridgeWake(msg, sender),
  'content.fingerprint': (msg, sender) => handleContentFingerprintCommand(msg, sender),
  cookies: (msg, sender) => handleCookies(msg, sender),
  cdp: (msg, sender, context) => handleCDP(msg, sender, context),
  persistent_cdp: (msg, sender) => handlePersistentCDP(msg, sender),
  tabs: (msg) => handleTabsCommand(msg),
  management: (msg) => handleManagementCommand(msg),
  contentSettings: (msg) => handleContentSettingsCommand(msg),
};

function resolveBrowserPilotCoreCommandHandler(cmd: unknown): BrowserPilotCoreCommandHandler | undefined {
  return typeof cmd === 'string' ? BROWSER_PILOT_CORE_COMMAND_HANDLERS[cmd] : undefined;
}

async function dispatchBrowserPilotBridgeCommand(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender, context: BrowserPilotCoreDispatchContext = {}): Promise<BrowserPilotBridgeResponse> {
  const handler = resolveBrowserPilotCoreCommandHandler(msg.cmd);
  if (handler) return await handler(msg, sender, context);
  if (isBrowserPilotNativeCommand(optionalString(msg.cmd))) return await handleBrowserPilotNativeCommand(msg, sender) as BrowserPilotBridgeResponse;
  if (msg.cmd === 'batch') return await handleBatch(msg, sender);
  return bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown cmd: ' + String(msg.cmd), { cmd: msg.cmd });
}

async function handleBatch(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  const R: BrowserPilotBridgeResponse[] = [];
  const resolve$N = (params: unknown): JsonRecord => JSON.parse(JSON.stringify(params || {}).replace(/"\$(\d+)\.([^"]+)"/g,
    (_: string, i: string, path: string) => { let v: unknown = R[Number(i)]; for (const k of path.split('.')) v = coreRecord(v)[k]; return JSON.stringify(v === undefined ? null : v); }));
  const detachCurrent = async () => {};
  try {
    const commands = Array.isArray(msg.commands) ? msg.commands as BrowserPilotBridgeCommand[] : [];
    for (const c of commands) {
      try {
        if (!c || typeof c !== 'object') {
          R.push(bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'invalid batch command', { cmd: msg.cmd, raw: c }));
          continue;
        }
        if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
        const handler = resolveBrowserPilotCoreCommandHandler(c.cmd);
        if (handler) {
          R.push(normalizeBridgeResponse(await dispatchBrowserPilotBridgeCommand(c, sender, { resolveParams: resolve$N }), c.cmd));
        } else if (isBrowserPilotNativeCommand(optionalString(c.cmd))) {
          const validation = validateBrowserPilotBridgeProtocolMessage(c);
          if (!validation.ok) R.push(bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, validation.error, validation.details));
          else R.push(normalizeBridgeResponse(await dispatchBrowserPilotBridgeCommand(validation.command, sender), c.cmd));
        } else {
          R.push(bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'unknown cmd: ' + String(c.cmd), { cmd: c.cmd, raw: c }));
        }
      } catch (e) {
        R.push(bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: c && c.cmd, method: c && c.method, tabId: c && c.tabId, raw: coreErrorDetails(e) }));
        try {
          await detachCurrent();
        } catch (_error) {
          /* best-effort detach after batch command failure */
        }
      }
    }
    await detachCurrent();
    return { ok: true, results: R };
  } catch (e) {
    return bridgeError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, results: R, raw: coreErrorDetails(e) });
  }
}
export { setBridgeWakeProbe, handleBridgeWake, normalizeBrowserPilotCreateTabUrl, handleTabsCommand, handleManagementCommand, handleContentSettingsCommand, browserPilotCookiePartitionIdentity, browserPilotCookieIdentity, mergeBrowserPilotCookies, normalizeBrowserPilotCookieUrl, handleCookies, handleCDP, handlePersistentCDP, validateBrowserPilotBridgeProtocolMessage, resolveBrowserPilotCoreCommandHandler, dispatchBrowserPilotBridgeCommand, handleBatch };
// ESM module metadata
export const __browserPilotBridgeModule_core_commands = { name: "core_commands", symbols: { setBridgeWakeProbe, handleBridgeWake, normalizeBrowserPilotCreateTabUrl, handleTabsCommand, handleManagementCommand, handleContentSettingsCommand, browserPilotCookiePartitionIdentity, browserPilotCookieIdentity, mergeBrowserPilotCookies, normalizeBrowserPilotCookieUrl, handleCookies, handleCDP, handlePersistentCDP, validateBrowserPilotBridgeProtocolMessage, resolveBrowserPilotCoreCommandHandler, dispatchBrowserPilotBridgeCommand, handleBatch } };
