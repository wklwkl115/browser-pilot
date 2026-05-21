import { handlePersistentCdpCommand } from "./cdp";
import { PiNativeProtocol } from "./protocol";
import { chromeApi as chrome } from "./runtimeEnv";
import { isScriptable, piBridgeInfo } from "./bridge_info";
import { PI_BROWSER_ERROR_CODES, bridgeError, handlePiNativeBrowserCommand, isPiNativeBrowserCommand, normalizeBridgeResponse, normalizePersistentPiBrowserResponse, piBrowserPersistentCdp } from "./runtime";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse, PiBridgeSender, PiChromeCookie, PiChromeCookieDetails, PiChromeTab, PiChromeTabGroup, PiChromeWindow, PiNativeProtocolRuntime } from "./types";

// core_commands.js - non-native bridge commands: tabs, cookies, management, content settings, batch, CDP.

type BridgeWakeProbe = (resetDelay: boolean) => unknown;
type ValidatedBridgeCommand = { ok: true; command: PiBridgeCommand } | { ok: false; error?: string; details?: JsonRecord };
let bridgeWakeProbe: BridgeWakeProbe | null = null;

function coreRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function coreErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function coreErrorDetails(error: unknown): JsonRecord { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }; }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function positiveInteger(value: unknown): number | undefined { const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN; return Number.isInteger(n) && n > 0 ? n : undefined; }
function optionalBoolean(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function optionalNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function tabSummary(tab: PiChromeTab | undefined, fallbackUrl?: string): JsonRecord {
  return { id: tab?.id, tabId: tab?.id, url: tab?.url || fallbackUrl || '', title: tab?.title || '', active: tab?.active, windowId: tab?.windowId, groupId: tab?.groupId };
}
function windowSummary(win: PiChromeWindow | undefined): JsonRecord {
  return { id: win?.id, windowId: win?.id, focused: win?.focused, incognito: win?.incognito, type: win?.type, state: win?.state, left: win?.left, top: win?.top, width: win?.width, height: win?.height, tabs: Array.isArray(win?.tabs) ? win.tabs.map((tab) => tabSummary(tab)) : undefined };
}
function tabGroupSummary(group: PiChromeTabGroup | undefined): JsonRecord {
  return { id: group?.id, groupId: group?.id, windowId: group?.windowId, title: group?.title, color: group?.color, collapsed: group?.collapsed };
}
function tabIdsArray(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return raw.map(positiveInteger).filter((item): item is number => item !== undefined);
}

function setBridgeWakeProbe(probe: unknown): void {
  bridgeWakeProbe = typeof probe === 'function' ? probe as BridgeWakeProbe : null;
}

async function handleBridgeWake(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  if (bridgeWakeProbe) void bridgeWakeProbe(true);
  return { ok: true, data: { connecting: !!bridgeWakeProbe, bridge: piBridgeInfo(), url: msg.url || sender.tab?.url || null } };
}

function normalizePiBrowserCreateTabUrl(value: unknown): { ok: true; url: string } | { ok: false; error: string; details: JsonRecord } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: true, url: 'about:blank' };
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch (_) { return { ok: false, error: 'tabs.create requires an absolute URL or about:blank', details: { url: value } }; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'javascript:') return { ok: false, error: 'tabs.create does not accept javascript: URLs; use browser_execute for JavaScript in an existing tab', details: { url: raw, protocol } };
  return { ok: true, url: parsed.href };
}

async function handleTabsCommand(msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  try {
    if (!msg.method || msg.method === 'list') {
      const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
      const data = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId, groupId: t.groupId }));
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
      const createProperties: JsonRecord = { url: normalized.url, active: msg.active !== false };
      const windowId = positiveInteger(msg.windowId);
      if (windowId !== undefined) createProperties.windowId = windowId;
      const tab = await chrome.tabs.create(createProperties);
      return { ok: true, data: { id: tab.id, tabId: tab.id, url: tab.url || normalized.url, title: tab.title || '', windowId: tab.windowId, groupId: tab.groupId } };
    }
    if (msg.method === 'close') {
      const rawTarget = msg.targetTabId ?? msg.closeTabId ?? msg.tabId;
      const targetTabId = Number(rawTarget);
      if (!Number.isInteger(targetTabId) || targetTabId <= 0) {
        return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'tabs.close requires a valid targetTabId', { cmd: msg.cmd, method: msg.method, targetTabId: rawTarget });
      }
      const tab = await chrome.tabs.get(targetTabId);
      await chrome.tabs.remove(targetTabId);
      return { ok: true, data: { id: targetTabId, tabId: targetTabId, url: tab.url || '', title: tab.title || '', windowId: tab.windowId, groupId: tab.groupId } };
    }
    return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown tabs method: ' + String(msg.method), { cmd: msg.cmd, method: msg.method });
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, method: msg.method });
  }
}

function windowIdFromMessage(msg: PiBridgeCommand): number | undefined {
  return positiveInteger(msg.windowId ?? msg.id);
}

function normalizeWindowUpdateInfo(msg: PiBridgeCommand, options: { forceFocus?: boolean } = {}): JsonRecord {
  const updateInfo: JsonRecord = {};
  const focused = options.forceFocus ? true : optionalBoolean(msg.focused);
  if (focused !== undefined) updateInfo.focused = focused;
  const state = optionalString(msg.state);
  if (state) updateInfo.state = state;
  for (const key of ['left', 'top', 'width', 'height']) {
    const n = optionalNumber(msg[key]);
    if (n !== undefined) updateInfo[key] = Math.floor(n);
  }
  return updateInfo;
}

function normalizeWindowCreateData(msg: PiBridgeCommand): { ok: true; createData: JsonRecord; normalizedUrl?: string } | { ok: false; error: string; details: JsonRecord } {
  if (msg.incognito === true) return { ok: false, error: 'windows.create incognito is not supported by orchestration window isolation', details: { incognito: true } };
  const createData: JsonRecord = {};
  let normalizedUrl: string | undefined;
  if (msg.url !== undefined && msg.url !== null && msg.url !== '') {
    const normalized = normalizePiBrowserCreateTabUrl(msg.url);
    if (!normalized.ok) return normalized;
    createData.url = normalized.url;
    normalizedUrl = normalized.url;
  }
  const tabId = positiveInteger(msg.tabId);
  if (tabId !== undefined) createData.tabId = tabId;
  const focused = optionalBoolean(msg.focused);
  if (focused !== undefined) createData.focused = focused;
  const type = optionalString(msg.type);
  if (type) createData.type = type;
  const state = optionalString(msg.state);
  if (state) createData.state = state;
  for (const key of ['left', 'top', 'width', 'height']) {
    const n = optionalNumber(msg[key]);
    if (n !== undefined) createData[key] = Math.floor(n);
  }
  return { ok: true, createData, normalizedUrl };
}

async function handleWindowsCommand(msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const method = String(msg.method || 'list');
  try {
    if (method === 'list') {
      const queryInfo: JsonRecord = { populate: msg.populate !== false };
      if (Array.isArray(msg.windowTypes)) queryInfo.windowTypes = msg.windowTypes;
      const windows = await chrome.windows.getAll(queryInfo);
      return { ok: true, data: windows.map(windowSummary) };
    }
    if (method === 'get') {
      const windowId = windowIdFromMessage(msg);
      if (!windowId) return bridgeError(PI_BROWSER_ERROR_CODES.WINDOW_ID_REQUIRED, 'windows.get requires a valid windowId', { cmd: msg.cmd, method, windowId: msg.windowId });
      const win = await chrome.windows.get(windowId, { populate: msg.populate !== false });
      return { ok: true, data: windowSummary(win) };
    }
    if (method === 'create') {
      const normalized = normalizeWindowCreateData(msg);
      if (!normalized.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, normalized.error, { cmd: msg.cmd, method, ...normalized.details });
      const win = await chrome.windows.create(normalized.createData);
      return { ok: true, data: { ...windowSummary(win), created: true } };
    }
    if (method === 'update' || method === 'focus') {
      const windowId = windowIdFromMessage(msg);
      if (!windowId) return bridgeError(PI_BROWSER_ERROR_CODES.WINDOW_ID_REQUIRED, `windows.${method} requires a valid windowId`, { cmd: msg.cmd, method, windowId: msg.windowId });
      const win = await chrome.windows.update(windowId, normalizeWindowUpdateInfo(msg, { forceFocus: method === 'focus' }));
      return { ok: true, data: windowSummary(win) };
    }
    if (method === 'close') {
      const windowId = windowIdFromMessage(msg);
      if (!windowId) return bridgeError(PI_BROWSER_ERROR_CODES.WINDOW_ID_REQUIRED, 'windows.close requires a valid windowId', { cmd: msg.cmd, method, windowId: msg.windowId });
      await chrome.windows.remove(windowId);
      return { ok: true, data: { windowId, closed: true } };
    }
    return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown windows method: ' + method, { cmd: msg.cmd, method });
  } catch (e) {
    const message = coreErrorMessage(e);
    const code = /No window|not found|Invalid window/i.test(message) ? PI_BROWSER_ERROR_CODES.WINDOW_NOT_FOUND : PI_BROWSER_ERROR_CODES.WINDOW_OPERATION_FAILED;
    return bridgeError(code, message, { cmd: msg.cmd, method, windowId: msg.windowId, raw: coreErrorDetails(e) });
  }
}

function tabGroupsUnsupported(reason: string, details: JsonRecord = {}): PiBridgeResponse {
  return { ok: true, data: { tabGroupsStatus: 'degraded_not_supported', supported: false, reason, ...details } };
}

function tabGroupsAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!chrome.tabGroups || typeof chrome.tabGroups.query !== 'function' || typeof chrome.tabGroups.update !== 'function') return { ok: false, reason: 'chrome.tabGroups_unavailable' };
  return { ok: true };
}

function tabGroupIdFromMessage(msg: PiBridgeCommand): number | undefined {
  return positiveInteger(msg.tabGroupId ?? msg.groupId ?? msg.id);
}

function normalizeTabGroupUpdate(msg: PiBridgeCommand): JsonRecord {
  const update: JsonRecord = {};
  const title = optionalString(msg.title);
  if (title !== undefined) update.title = title;
  const color = optionalString(msg.color);
  if (color !== undefined) update.color = color;
  const collapsed = optionalBoolean(msg.collapsed);
  if (collapsed !== undefined) update.collapsed = collapsed;
  return update;
}

async function handleTabGroupsCommand(msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const method = String(msg.method || 'status');
  const availability = tabGroupsAvailable();
  if (method === 'status') return availability.ok ? { ok: true, data: { tabGroupsStatus: 'available', supported: true } } : tabGroupsUnsupported(availability.reason);
  if (!availability.ok) return tabGroupsUnsupported(availability.reason, { method });
  try {
    if (method === 'query') {
      const queryInfo: JsonRecord = {};
      const windowId = positiveInteger(msg.windowId);
      if (windowId !== undefined) queryInfo.windowId = windowId;
      const title = optionalString(msg.title);
      if (title !== undefined) queryInfo.title = title;
      const color = optionalString(msg.color);
      if (color !== undefined) queryInfo.color = color;
      const groups = await chrome.tabGroups!.query(queryInfo);
      const tabGroupId = tabGroupIdFromMessage(msg);
      const filtered = tabGroupId === undefined ? groups : groups.filter((group) => group.id === tabGroupId);
      return { ok: true, data: { tabGroupsStatus: 'available', supported: true, groups: filtered.map(tabGroupSummary) } };
    }
    if (method === 'group') {
      const tabIds = tabIdsArray(msg.tabIds ?? msg.tabId);
      if (!tabIds.length) return bridgeError(PI_BROWSER_ERROR_CODES.TAB_GROUP_TAB_IDS_REQUIRED, 'tabGroups.group requires non-empty tabIds', { cmd: msg.cmd, method, tabIds: msg.tabIds });
      if (typeof chrome.tabs.group !== 'function') return tabGroupsUnsupported('chrome.tabs.group_unavailable', { method, tabIds });
      const options: JsonRecord = { tabIds };
      const tabGroupId = tabGroupIdFromMessage(msg);
      if (tabGroupId !== undefined) options.groupId = tabGroupId;
      const windowId = positiveInteger(msg.windowId);
      if (windowId !== undefined) options.createProperties = { windowId };
      const groupId = await chrome.tabs.group(options);
      return { ok: true, data: { tabGroupsStatus: 'available', supported: true, groupId, tabIds } };
    }
    if (method === 'update') {
      const tabGroupId = tabGroupIdFromMessage(msg);
      if (!tabGroupId) return bridgeError(PI_BROWSER_ERROR_CODES.TAB_GROUP_ID_REQUIRED, 'tabGroups.update requires a valid tabGroupId', { cmd: msg.cmd, method, tabGroupId: msg.tabGroupId });
      const group = await chrome.tabGroups!.update(tabGroupId, normalizeTabGroupUpdate(msg));
      return { ok: true, data: { tabGroupsStatus: 'available', supported: true, group: tabGroupSummary(group) } };
    }
    if (method === 'ungroup') {
      const tabIds = tabIdsArray(msg.tabIds ?? msg.tabId);
      if (!tabIds.length) return bridgeError(PI_BROWSER_ERROR_CODES.TAB_GROUP_TAB_IDS_REQUIRED, 'tabGroups.ungroup requires non-empty tabIds', { cmd: msg.cmd, method, tabIds: msg.tabIds });
      if (typeof chrome.tabs.ungroup !== 'function') return tabGroupsUnsupported('chrome.tabs.ungroup_unavailable', { method, tabIds });
      await chrome.tabs.ungroup(tabIds);
      return { ok: true, data: { tabGroupsStatus: 'available', supported: true, ungrouped: tabIds } };
    }
    return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown tabGroups method: ' + method, { cmd: msg.cmd, method });
  } catch (e) {
    return { ok: true, data: { tabGroupsStatus: 'degraded_operation_failed', supported: true, method, error: coreErrorMessage(e), details: coreErrorDetails(e) } };
  }
}

async function handleManagementCommand(msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  try {
    if (msg.method === 'list') {
      const all = await chrome.management.getAll();
      return { ok: true, data: all.map(e => ({ id: e.id, name: e.name, enabled: e.enabled, type: e.type, version: e.version })) };
    }
    if (msg.method === 'reload') {
      chrome.alarms.create('pi-browser-self-reload', { when: Date.now() + 200 });
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

function piBrowserCookieMethod(value: unknown): string {
  return String(value || 'list').trim() || 'list';
}

function requiredPiBrowserCookieName(value: unknown): { ok: true; name: string } | { ok: false; error: string; details: JsonRecord } {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { ok: false, error: 'cookies requires a non-empty cookie name', details: { name: value } };
  return { ok: true, name };
}

function optionalCookieString(details: PiChromeCookieDetails, field: keyof PiChromeCookieDetails, value: unknown): void {
  if (typeof value === 'string' && value.trim()) details[field] = value.trim() as never;
}

function optionalCookieBoolean(details: PiChromeCookieDetails, field: keyof PiChromeCookieDetails, value: unknown): { ok: true } | { ok: false; error: string; details: JsonRecord } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'boolean') return { ok: false, error: `cookies ${String(field)} must be boolean`, details: { field, value } };
  details[field] = value as never;
  return { ok: true };
}

function optionalCookieExpiration(details: PiChromeCookieDetails, value: unknown): { ok: true } | { ok: false; error: string; details: JsonRecord } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { ok: false, error: 'cookies expirationDate must be a positive finite number', details: { field: 'expirationDate' } };
  details.expirationDate = value;
  return { ok: true };
}

function optionalCookieSameSite(details: PiChromeCookieDetails, value: unknown): { ok: true } | { ok: false; error: string; details: JsonRecord } {
  if (value === undefined) return { ok: true };
  const sameSite = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!['no_restriction', 'lax', 'strict', 'unspecified'].includes(sameSite)) return { ok: false, error: 'cookies sameSite must be one of no_restriction, lax, strict, unspecified', details: { field: 'sameSite' } };
  details.sameSite = sameSite;
  return { ok: true };
}

function optionalCookiePartitionKey(details: PiChromeCookieDetails, value: unknown): { ok: true } | { ok: false; error: string; details: JsonRecord } {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'cookies partitionKey must be an object', details: { field: 'partitionKey' } };
  const raw = value as Record<string, unknown>;
  const key: { topLevelSite?: string; hasCrossSiteAncestor?: boolean } = {};
  if (typeof raw.topLevelSite === 'string' && raw.topLevelSite.trim()) key.topLevelSite = raw.topLevelSite.trim();
  if (raw.hasCrossSiteAncestor !== undefined) {
    if (typeof raw.hasCrossSiteAncestor !== 'boolean') return { ok: false, error: 'cookies partitionKey.hasCrossSiteAncestor must be boolean', details: { field: 'partitionKey.hasCrossSiteAncestor' } };
    key.hasCrossSiteAncestor = raw.hasCrossSiteAncestor;
  }
  if (!Object.keys(key).length) return { ok: false, error: 'cookies partitionKey requires topLevelSite or hasCrossSiteAncestor', details: { field: 'partitionKey' } };
  details.partitionKey = key;
  return { ok: true };
}

function normalizePiBrowserCookieDetails(msg: PiBridgeCommand, normalizedUrl: { url: string }, options: { includeValue: boolean }): { ok: true; details: PiChromeCookieDetails } | { ok: false; error: string; details: JsonRecord } {
  const named = requiredPiBrowserCookieName(msg.name);
  if (!named.ok) return named;
  const details: PiChromeCookieDetails = { url: normalizedUrl.url, name: named.name };
  if (options.includeValue) {
    if (typeof msg.value !== 'string') return { ok: false, error: 'cookies set requires string value', details: { field: 'value' } };
    details.value = msg.value;
  }
  optionalCookieString(details, 'domain', msg.domain);
  optionalCookieString(details, 'path', msg.path);
  optionalCookieString(details, 'storeId', msg.storeId);
  for (const check of [
    optionalCookieBoolean(details, 'secure', msg.secure),
    optionalCookieBoolean(details, 'httpOnly', msg.httpOnly),
    optionalCookieSameSite(details, msg.sameSite),
    optionalCookieExpiration(details, msg.expirationDate),
    optionalCookiePartitionKey(details, msg.partitionKey),
  ]) {
    if (!check.ok) return check;
  }
  return { ok: true, details };
}

function safePiBrowserCookieMutationDetails(details: PiChromeCookieDetails): JsonRecord {
  const { value: _value, ...safe } = details;
  return safe;
}

function piBrowserCookieMutationSummary(cookie: PiChromeCookie | undefined): JsonRecord | null {
  if (!cookie) return null;
  const { value, ...safe } = cookie;
  return { ...safe, valuePresent: value !== undefined, valueLength: typeof value === 'string' ? value.length : undefined };
}

async function handleCookies(msg: PiBridgeCommand, sender: PiBridgeSender): Promise<PiBridgeResponse> {
  try {
    const method = piBrowserCookieMethod(msg.method);
    let url: unknown = msg.url || sender.tab?.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(Number(msg.tabId));
      url = tab.url;
    }
    const normalized = normalizePiBrowserCookieUrl(url);
    if (!normalized.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, normalized.error, { cmd: msg.cmd, method, tabId: msg.tabId, ...normalized.details });
    if (normalized.unsupported) {
      if (method === 'list') return { ok: true, data: [], details: { reason: 'unsupported_cookie_url_scheme', url: normalized.url, protocol: normalized.protocol } };
      if (method === 'get') return { ok: true, data: null, details: { reason: 'unsupported_cookie_url_scheme', url: normalized.url, protocol: normalized.protocol } };
      return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'cookies ' + method + ' requires an http(s) URL', { cmd: msg.cmd, method, reason: 'unsupported_cookie_url_scheme', url: normalized.url, protocol: normalized.protocol });
    }
    if (method === 'list') {
      const all = await chrome.cookies.getAll({ url: normalized.url });
      const part = await chrome.cookies.getAll({ url: normalized.url, partitionKey: { topLevelSite: normalized.origin || normalized.url } }).catch((): PiChromeCookie[] => []);
      const merged = mergePiBrowserCookies([all, part]);
      return { ok: true, data: merged };
    }
    if (method === 'get') {
      const details = normalizePiBrowserCookieDetails(msg, normalized, { includeValue: false });
      if (!details.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, details.error, { cmd: msg.cmd, method, ...details.details });
      const cookie = typeof chrome.cookies.get === 'function'
        ? await chrome.cookies.get(details.details)
        : (await chrome.cookies.getAll(details.details))[0];
      return { ok: true, data: cookie || null };
    }
    if (method === 'set') {
      const details = normalizePiBrowserCookieDetails(msg, normalized, { includeValue: true });
      if (!details.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, details.error, { cmd: msg.cmd, method, ...details.details });
      try {
        const cookie = await chrome.cookies.set(details.details);
        return { ok: true, data: { set: true, cookie: piBrowserCookieMutationSummary(cookie), details: safePiBrowserCookieMutationDetails(details.details) } };
      } catch (e) {
        return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'cookies set failed', { cmd: msg.cmd, method, errorName: e instanceof Error ? e.name : typeof e, details: safePiBrowserCookieMutationDetails(details.details) });
      }
    }
    if (method === 'remove') {
      const details = normalizePiBrowserCookieDetails(msg, normalized, { includeValue: false });
      if (!details.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, details.error, { cmd: msg.cmd, method, ...details.details });
      try {
        const removed = await chrome.cookies.remove(details.details);
        return { ok: true, data: { removed: !!removed, details: removed || safePiBrowserCookieMutationDetails(details.details) } };
      } catch (e) {
        return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'cookies remove failed', { cmd: msg.cmd, method, errorName: e instanceof Error ? e.name : typeof e, details: safePiBrowserCookieMutationDetails(details.details) });
      }
    }
    return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown cookies method: ' + method, { cmd: msg.cmd, method });
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, method: msg.method, tabId: msg.tabId });
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
  if (msg.cmd === 'cookies') return await handleCookies(msg, sender);
  if (msg.cmd === 'windows') return await handleWindowsCommand(msg);
  if (msg.cmd === 'tabGroups') return await handleTabGroupsCommand(msg);
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
    (_: string, i: string, path: string) => { let v: unknown = R[Number(i)]; for (const k of path.split('.')) v = coreRecord(v)[k]; return JSON.stringify(v); }));
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
        } else if (c.cmd === 'windows') {
          R.push(normalizeBridgeResponse(await handleWindowsCommand(c), c.cmd));
        } else if (c.cmd === 'tabGroups') {
          R.push(normalizeBridgeResponse(await handleTabGroupsCommand(c), c.cmd));
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
        try { await detachCurrent(); } catch (_) {}
      }
    }
    await detachCurrent();
    return { ok: true, results: R };
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, coreErrorMessage(e), { cmd: msg.cmd, results: R, raw: coreErrorDetails(e) });
  }
}
export { setBridgeWakeProbe, handleBridgeWake, normalizePiBrowserCreateTabUrl, handleTabsCommand, handleWindowsCommand, handleTabGroupsCommand, handleManagementCommand, handleContentSettingsCommand, piBrowserCookiePartitionIdentity, piBrowserCookieIdentity, mergePiBrowserCookies, normalizePiBrowserCookieUrl, handleCookies, handleCDP, handlePersistentCDP, validatePiBridgeProtocolMessage, dispatchPiBridgeCommand, handleBatch };
// ESM module boundary marker for TODO 189
export const __piBridgeModule_core_commands = { name: "core_commands", symbols: { setBridgeWakeProbe, handleBridgeWake, normalizePiBrowserCreateTabUrl, handleTabsCommand, handleWindowsCommand, handleTabGroupsCommand, handleManagementCommand, handleContentSettingsCommand, piBrowserCookiePartitionIdentity, piBrowserCookieIdentity, mergePiBrowserCookies, normalizePiBrowserCookieUrl, handleCookies, handleCDP, handlePersistentCDP, validatePiBridgeProtocolMessage, dispatchPiBridgeCommand, handleBatch } };
