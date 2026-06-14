import { handlePersistentCdpCommand } from "./cdp";
import { PiNativeProtocol } from "./protocol";
import { chromeApi as chrome } from "./runtimeEnv";
import { isScriptable, piBridgeInfo } from "./bridge_info";
import { PI_BROWSER_ERROR_CODES, bridgeError, handlePiNativeBrowserCommand, isPiNativeBrowserCommand, normalizeBridgeResponse, normalizePersistentPiBrowserResponse, piBrowserPersistentCdp } from "./runtime";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse, PiBridgeSender, PiChromeCookie, PiNativeProtocolRuntime } from "./types";

// core_commands.js - non-native bridge commands: tabs, cookies, management, content settings, batch, CDP.

type BridgeWakeProbe = (resetDelay: boolean) => unknown;
type ValidatedBridgeCommand = { ok: true; command: PiBridgeCommand } | { ok: false; error?: string; details?: JsonRecord };
let bridgeWakeProbe: BridgeWakeProbe | null = null;

function coreRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function coreErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function coreErrorDetails(error: unknown): JsonRecord { return error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) }; }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }

async function readContentFingerprintViaScript(tabId: number, drainDirty = false): Promise<JsonRecord> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [drainDirty],
    func: (d: boolean) => {
      type PiBrowserFallbackFingerprintState = { seq: number; at: number; since: number; overflow: boolean; o?: MutationObserver };
      const key = '__piBrowserFingerprintFallbackState__';
      const holder = globalThis as unknown as Record<string, PiBrowserFallbackFingerprintState | undefined>;
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

async function handleBridgeWake(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  if (bridgeWakeProbe) void Promise.resolve(bridgeWakeProbe(true)).catch(() => {});
  return { ok: true, data: { connecting: !!bridgeWakeProbe, bridge: piBridgeInfo(), url: msg.url || sender.tab?.url || null } };
}

function normalizePiBrowserCreateTabUrl(value: unknown): { ok: true; url: string } | { ok: false; error: string; details: JsonRecord } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: true, url: 'about:blank' };
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch (_) { return { ok: false, error: 'tabs.create requires an absolute URL or about:blank', details: { url: value } }; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'javascript:' || protocol === 'data:') return { ok: false, error: 'tabs.create does not accept javascript: or data: URLs; use browser_execute for JavaScript in an existing tab', details: { url: raw, protocol } };
  return { ok: true, url: parsed.href };
}

async function handleTabsCommand(msg: PiBridgeCommand): Promise<PiBridgeResponse> {
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
      return { ok: true };
    }
    if (msg.method === 'create') {
      const normalized = normalizePiBrowserCreateTabUrl(msg.url);
      if (!normalized.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, normalized.error, { cmd: msg.cmd, method: msg.method, ...normalized.details });
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
        if (!allowed) return bridgeError(PI_BROWSER_ERROR_CODES.UNSUPPORTED_TARGET, 'Incognito access is not granted to the Pi bridge extension', { cmd: msg.cmd, method: msg.method, recovery: 'Open chrome://extensions, find "Pi Native Browser Bridge" → Details → enable "Allow in incognito", then retry browser_tabs create with incognito:true' });
        const win = await chrome.windows.create({ url: normalized.url, incognito: true, focused: msg.active !== false });
        const incognitoTab = win && Array.isArray(win.tabs) ? win.tabs[0] : undefined;
        if (!incognitoTab || incognitoTab.id === undefined) return bridgeError(PI_BROWSER_ERROR_CODES.UNSUPPORTED_TARGET, 'Incognito window was created but no tab was returned', { cmd: msg.cmd, method: msg.method });
        return { ok: true, data: { id: incognitoTab.id, tabId: incognitoTab.id, url: incognitoTab.url || normalized.url, title: incognitoTab.title || '', windowId: incognitoTab.windowId, openerTabId: incognitoTab.openerTabId, incognito: true } };
      }
      const tab = await chrome.tabs.create({ url: normalized.url, active: msg.active !== false });
      return { ok: true, data: { id: tab.id, tabId: tab.id, url: tab.url || normalized.url, title: tab.title || '', windowId: tab.windowId, openerTabId: tab.openerTabId, incognito: tab.incognito === true } };
    }
    if (msg.method === 'close') {
      const rawTarget = msg.targetTabId ?? msg.closeTabId ?? msg.tabId;
      const targetTabId = Number(rawTarget);
      if (!Number.isInteger(targetTabId) || targetTabId <= 0) {
        return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'tabs.close requires a valid targetTabId', { cmd: msg.cmd, method: msg.method, targetTabId: rawTarget });
      }
      const tab = await chrome.tabs.get(targetTabId);
      await chrome.tabs.remove(targetTabId);
      return { ok: true, data: { id: targetTabId, tabId: targetTabId, url: tab.url || '', title: tab.title || '', windowId: tab.windowId, openerTabId: tab.openerTabId } };
    }
    return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown tabs method: ' + String(msg.method), { cmd: msg.cmd, method: msg.method });
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, method: msg.method });
  }
}

async function handleManagementCommand(msg: PiBridgeCommand): Promise<PiBridgeResponse> {
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
    return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown management method: ' + String(msg.method), { cmd: msg.cmd, method: msg.method });
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, method: msg.method });
  }
}

async function handleContentSettingsCommand(msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  try {
    const type = String(msg.type || 'automaticDownloads');
    const setting = String(msg.setting || 'allow');
    const pattern = String(msg.pattern || '<all_urls>');
    const settings = chrome.contentSettings || {};
    const target = settings[type];
    if (!target || typeof target.set !== 'function') {
      return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unsupported contentSettings type: ' + type, { cmd: msg.cmd, type });
    }
    await target.set({ primaryPattern: pattern, setting });
    return { ok: true };
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, type: msg.type, setting: msg.setting, pattern: msg.pattern });
  }
}

async function handleContentFingerprintCommand(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  const tabId = Number(msg.tabId || sender.tab?.id || 0);
  if (!tabId) return bridgeError(PI_BROWSER_ERROR_CODES.NO_SESSION, 'content.fingerprint requires a tabId', { cmd: msg.cmd, tabId: msg.tabId });
  let messageError: unknown;
  try {
    const response = coreRecord(await chrome.tabs.sendMessage(tabId, msg.drainDirty === true ? { cmd: 'pi.contentFingerprint', drainDirty: true } : { cmd: 'pi.contentFingerprint' }));
    if (response.ok !== false) return { ok: true, data: coreRecord(response.data ?? response) };
    messageError = new Error('content fingerprint responder returned ok:false');
  } catch (e) {
    messageError = e;
  }
  try {
    return { ok: true, data: await readContentFingerprintViaScript(tabId, msg.drainDirty === true) };
  } catch (scriptError) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'content fingerprint unavailable', { cmd: msg.cmd, tabId, error: coreErrorDetails(messageError), fallbackError: coreErrorDetails(scriptError) });
  }
}

function piBrowserCookiePartitionIdentity(cookie: PiChromeCookie | null | undefined): string {
  const key = cookie && cookie.partitionKey;
  if (!key || typeof key !== 'object') return '';
  return [key.topLevelSite || '', key.hasCrossSiteAncestor === undefined ? '' : String(key.hasCrossSiteAncestor)].join('\u0000');
}

function piBrowserCookieIdentity(cookie: PiChromeCookie | null | undefined): string {
  const item: PiChromeCookie = cookie || {};
  return [item.name || '', item.domain || '', item.path || '', item.storeId || '', piBrowserCookiePartitionIdentity(item)].join('\u0000');
}

function mergePiBrowserCookies(cookieLists: unknown[]): PiChromeCookie[] {
  const merged: PiChromeCookie[] = [];
  const seen = new Set<string>();
  for (const list of cookieLists) {
    for (const cookie of Array.isArray(list) ? list : []) {
      const key = piBrowserCookieIdentity(cookie as PiChromeCookie);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(cookie as PiChromeCookie);
    }
  }
  return merged;
}

function normalizePiBrowserCookieUrl(value: unknown): { ok: true; url: string; origin?: string; protocol: string; unsupported?: boolean } | { ok: false; error: string; details: JsonRecord } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: false, error: 'cookies requires an http(s) URL or a tab with an http(s) URL', details: { url: value } };
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch (_) { return { ok: false, error: 'cookies requires a valid absolute URL', details: { url: value } }; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return { ok: true, url: parsed.href, protocol, unsupported: true };
  return { ok: true, url: parsed.href, origin: parsed.origin, protocol };
}

async function handleCookies(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  try {
    let url: unknown = msg.url || sender.tab?.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(Number(msg.tabId));
      url = tab.url;
    }
    const normalized = normalizePiBrowserCookieUrl(url);
    if (!normalized.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, normalized.error, { cmd: msg.cmd, tabId: msg.tabId, ...normalized.details });
    if (normalized.unsupported) return { ok: true, data: [], details: { reason: 'unsupported_cookie_url_scheme', url: normalized.url, protocol: normalized.protocol } };
    const all = await chrome.cookies.getAll({ url: normalized.url });
    const part = await chrome.cookies.getAll({ url: normalized.url, partitionKey: { topLevelSite: normalized.origin || normalized.url } }).catch((): PiChromeCookie[] => []);
    const merged = mergePiBrowserCookies([all, part]);
    return { ok: true, data: merged };
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, tabId: msg.tabId });
  }
}

async function handleCDP(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  const tabId = Number(msg.tabId || sender.tab?.id || 0);
  if (!tabId) return bridgeError(PI_BROWSER_ERROR_CODES.NO_SESSION, 'no tabId', { cmd: msg.cmd, method: msg.method });
  const cdp = piBrowserPersistentCdp();
  if (!cdp?.send) return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: msg.cmd, method: msg.method, tabId });
  const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, String(msg.method || ''), coreRecord(msg.params), { name: String(msg.name || 'default'), persistent: msg.persistent === true, timeoutMs: msg.timeoutMs || msg.timeout_ms }));
  const data = coreRecord(resp.data);
  if (resp && resp.ok !== false) return { ok: true, data: data.result !== undefined ? data.result : (resp.result || resp.data) };
  return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, resp?.error || resp?.message || 'persistent CDP send failed', { cmd: msg.cmd, method: msg.method, tabId, persistent: resp });
}

async function handlePersistentCDP(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  const resp = await handlePersistentCdpCommand(msg, sender);
  return normalizeBridgeResponse(resp, msg.cmd);
}

function validatePiBridgeProtocolMessage(msg: PiBridgeCommand): ValidatedBridgeCommand {
  const protocol = PiNativeProtocol as PiNativeProtocolRuntime & { validateCommand?: (command: unknown, options?: JsonRecord) => ValidatedBridgeCommand };
  if (!protocol || typeof protocol.validateCommand !== 'function') {
    return { ok: false, error: 'Pi Browser protocol schema is not loaded', details: { cmd: msg && msg.cmd } };
  }
  return protocol.validateCommand(msg, { allowMissingTabId: true });
}

async function dispatchPiBridgeCommand(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  if (msg.cmd === 'bridge_wake') return await handleBridgeWake(msg, sender);
  if (msg.cmd === 'content.fingerprint') return await handleContentFingerprintCommand(msg, sender);
  if (msg.cmd === 'cookies') return await handleCookies(msg, sender);
  if (msg.cmd === 'cdp') return await handleCDP(msg, sender);
  if (msg.cmd === 'persistent_cdp') return await handlePersistentCDP(msg, sender);
  if (isPiNativeBrowserCommand(optionalString(msg.cmd))) return await handlePiNativeBrowserCommand(msg, sender) as PiBridgeResponse;
  if (msg.cmd === 'batch') return await handleBatch(msg, sender);
  if (msg.cmd === 'tabs') return await handleTabsCommand(msg);
  if (msg.cmd === 'management') return await handleManagementCommand(msg);
  if (msg.cmd === 'contentSettings') return await handleContentSettingsCommand(msg);
  return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown cmd: ' + String(msg.cmd), { cmd: msg.cmd });
}

async function handleBatch(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  const R: PiBridgeResponse[] = [];
  const resolve$N = (params: unknown): JsonRecord => JSON.parse(JSON.stringify(params || {}).replace(/"\$(\d+)\.([^"]+)"/g,
    (_: string, i: string, path: string) => { let v: unknown = R[Number(i)]; for (const k of path.split('.')) v = coreRecord(v)[k]; return JSON.stringify(v === undefined ? null : v); }));
  const detachCurrent = async () => {};
  try {
    const commands = Array.isArray(msg.commands) ? msg.commands as PiBridgeCommand[] : [];
    for (const c of commands) {
      try {
        if (!c || typeof c !== 'object') {
          R.push(bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'invalid batch command', { cmd: msg.cmd, raw: c }));
          continue;
        }
        if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
        if (c.cmd === 'cookies') {
          R.push(normalizeBridgeResponse(await handleCookies(c, sender), c.cmd));
        } else if (c.cmd === 'tabs') {
          R.push(normalizeBridgeResponse(await handleTabsCommand(c), c.cmd));
        } else if (c.cmd === 'cdp') {
          const tabId = Number(c.tabId || msg.tabId || sender.tab?.id || 0);
          if (!tabId) {
            R.push(bridgeError(PI_BROWSER_ERROR_CODES.NO_SESSION, 'no tabId for batch cdp command', { cmd: c.cmd, method: c.method }));
            continue;
          }
          const cdp = piBrowserPersistentCdp();
          if (!cdp?.send) {
            R.push(bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: c.cmd, method: c.method, tabId }));
            continue;
          }
          const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, String(c.method || ''), resolve$N(c.params), { name: String(c.name || 'default'), persistent: c.persistent === true, timeoutMs: c.timeoutMs || c.timeout_ms }));
          const data = coreRecord(resp.data);
          if (resp && resp.ok !== false) R.push({ ok: true, data: data.result !== undefined ? data.result : (resp.result || resp.data) });
          else R.push(bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, resp?.error || resp?.message || 'persistent CDP send failed', { cmd: c.cmd, method: c.method, tabId, persistent: resp }));
        } else if (isPiNativeBrowserCommand(optionalString(c.cmd))) {
          const validation = validatePiBridgeProtocolMessage(c);
          if (!validation.ok) R.push(bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, validation.error, validation.details));
          else R.push(normalizeBridgeResponse(await dispatchPiBridgeCommand(validation.command, sender), c.cmd));
        } else {
          R.push(bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'unknown cmd: ' + String(c.cmd), { cmd: c.cmd, raw: c }));
        }
      } catch (e) {
        R.push(bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: c && c.cmd, method: c && c.method, tabId: c && c.tabId, raw: coreErrorDetails(e) }));
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
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, results: R, raw: coreErrorDetails(e) });
  }
}
export { setBridgeWakeProbe, handleBridgeWake, normalizePiBrowserCreateTabUrl, handleTabsCommand, handleManagementCommand, handleContentSettingsCommand, piBrowserCookiePartitionIdentity, piBrowserCookieIdentity, mergePiBrowserCookies, normalizePiBrowserCookieUrl, handleCookies, handleCDP, handlePersistentCDP, validatePiBridgeProtocolMessage, dispatchPiBridgeCommand, handleBatch };
// ESM module metadata
export const __piBridgeModule_core_commands = { name: "core_commands", symbols: { setBridgeWakeProbe, handleBridgeWake, normalizePiBrowserCreateTabUrl, handleTabsCommand, handleManagementCommand, handleContentSettingsCommand, piBrowserCookiePartitionIdentity, piBrowserCookieIdentity, mergePiBrowserCookies, normalizePiBrowserCookieUrl, handleCookies, handleCDP, handlePersistentCDP, validatePiBridgeProtocolMessage, dispatchPiBridgeCommand, handleBatch } };
