// core_commands.js - non-native bridge commands: tabs, cookies, management, content settings, batch, CDP.

async function handleBridgeWake(msg, sender) {
  void probeAndConnectWS(true);
  return { ok: true, data: { connecting: true, bridge: piBridgeInfo(), url: msg.url || sender.tab?.url || null } };
}

function normalizePiBrowserCreateTabUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: true, url: 'about:blank' };
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { return { ok: false, error: 'tabs.create requires an absolute URL or about:blank', details: { url: value } }; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'javascript:') return { ok: false, error: 'tabs.create does not accept javascript: URLs; use browser_execute for JavaScript in an existing tab', details: { url: raw, protocol } };
  return { ok: true, url: parsed.href };
}

async function handleTabsCommand(msg) {
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
      const normalized = normalizePiBrowserCreateTabUrl(msg.url);
      if (!normalized.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, normalized.error, { cmd: msg.cmd, method: msg.method, ...normalized.details });
      const tab = await chrome.tabs.create({ url: normalized.url, active: msg.active !== false });
      return { ok: true, data: { id: tab.id, tabId: tab.id, url: tab.url || normalized.url, title: tab.title || '', windowId: tab.windowId } };
    }
    if (msg.method === 'close') {
      const rawTarget = msg.targetTabId ?? msg.closeTabId ?? msg.tabId;
      const targetTabId = Number(rawTarget);
      if (!Number.isInteger(targetTabId) || targetTabId <= 0) {
        return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'tabs.close requires a valid targetTabId', { cmd: msg.cmd, method: msg.method, targetTabId: rawTarget });
      }
      const tab = await chrome.tabs.get(targetTabId);
      await chrome.tabs.remove(targetTabId);
      return { ok: true, data: { id: targetTabId, tabId: targetTabId, url: tab.url || '', title: tab.title || '', windowId: tab.windowId } };
    }
    return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown tabs method: ' + msg.method, { cmd: msg.cmd, method: msg.method });
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, method: msg.method });
  }
}

async function handleManagementCommand(msg) {
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
      await chrome.management.setEnabled(msg.extId, false);
      return { ok: true };
    }
    if (msg.method === 'enable') {
      await chrome.management.setEnabled(msg.extId, true);
      return { ok: true };
    }
    return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown management method: ' + msg.method, { cmd: msg.cmd, method: msg.method });
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, method: msg.method });
  }
}

async function handleContentSettingsCommand(msg) {
  try {
    const type = msg.type || 'automaticDownloads';
    const setting = msg.setting || 'allow';
    const pattern = msg.pattern || '<all_urls>';
    if (!chrome.contentSettings || !chrome.contentSettings[type] || typeof chrome.contentSettings[type].set !== 'function') {
      return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unsupported contentSettings type: ' + type, { cmd: msg.cmd, type });
    }
    await chrome.contentSettings[type].set({ primaryPattern: pattern, setting });
    return { ok: true };
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, type: msg.type, setting: msg.setting, pattern: msg.pattern });
  }
}

function piBrowserCookiePartitionIdentity(cookie) {
  const key = cookie && cookie.partitionKey;
  if (!key || typeof key !== 'object') return '';
  return [key.topLevelSite || '', key.hasCrossSiteAncestor === undefined ? '' : String(key.hasCrossSiteAncestor)].join('\u0000');
}

function piBrowserCookieIdentity(cookie) {
  const item = cookie || {};
  return [item.name || '', item.domain || '', item.path || '', item.storeId || '', piBrowserCookiePartitionIdentity(item)].join('\u0000');
}

function mergePiBrowserCookies(cookieLists) {
  const merged = [];
  const seen = new Set();
  for (const list of cookieLists) {
    for (const cookie of Array.isArray(list) ? list : []) {
      const key = piBrowserCookieIdentity(cookie);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(cookie);
    }
  }
  return merged;
}

function normalizePiBrowserCookieUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { ok: false, error: 'cookies requires an http(s) URL or a tab with an http(s) URL', details: { url: value } };
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { return { ok: false, error: 'cookies requires a valid absolute URL', details: { url: value } }; }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return { ok: true, url: parsed.href, protocol, unsupported: true };
  return { ok: true, url: parsed.href, origin: parsed.origin, protocol };
}

async function handleCookies(msg, sender) {
  try {
    let url = msg.url || sender.tab?.url;
    if (!url && msg.tabId) {
      const tab = await chrome.tabs.get(msg.tabId);
      url = tab.url;
    }
    const normalized = normalizePiBrowserCookieUrl(url);
    if (!normalized.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, normalized.error, { cmd: msg.cmd, tabId: msg.tabId, ...normalized.details });
    if (normalized.unsupported) return { ok: true, data: [], details: { reason: 'unsupported_cookie_url_scheme', url: normalized.url, protocol: normalized.protocol } };
    const all = await chrome.cookies.getAll({ url: normalized.url });
    const part = await chrome.cookies.getAll({ url: normalized.url, partitionKey: { topLevelSite: normalized.origin } }).catch(() => []);
    const merged = mergePiBrowserCookies([all, part]);
    return { ok: true, data: merged };
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, tabId: msg.tabId });
  }
}

async function handleCDP(msg, sender) {
  const tabId = msg.tabId || sender.tab?.id;
  if (!tabId) return bridgeError(PI_BROWSER_ERROR_CODES.NO_SESSION, 'no tabId', { cmd: msg.cmd, method: msg.method });
  const cdp = piBrowserPersistentCdp();
  if (!cdp?.send) return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: msg.cmd, method: msg.method, tabId });
  const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, msg.method, msg.params || {}, { name: msg.name || 'default', persistent: msg.persistent === true, timeoutMs: msg.timeoutMs || msg.timeout_ms }));
  if (resp && resp.ok !== false) return { ok: true, data: (resp.data && resp.data.result !== undefined) ? resp.data.result : (resp.result || resp.data) };
  return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, resp?.error || resp?.message || 'persistent CDP send failed', { cmd: msg.cmd, method: msg.method, tabId, persistent: resp });
}

async function handlePersistentCDP(msg, sender) {
  if (!self.PiPersistentCdp || typeof self.PiPersistentCdp.handleCommand !== 'function') {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: msg.cmd, code: 'PERSISTENT_CDP_UNAVAILABLE' });
  }
  const resp = await self.PiPersistentCdp.handleCommand(msg, sender);
  return normalizeBridgeResponse(resp, msg.cmd);
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
          R.push(bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'invalid batch command', { cmd: msg.cmd, raw: c }));
          continue;
        }
        if (c.tabId === undefined && msg.tabId !== undefined) c.tabId = msg.tabId;
        if (c.cmd === 'cookies') {
          R.push(normalizeBridgeResponse(await handleCookies(c, sender), c.cmd));
        } else if (c.cmd === 'tabs') {
          R.push(normalizeBridgeResponse(await handleTabsCommand(c), c.cmd));
        } else if (c.cmd === 'cdp') {
          const tabId = c.tabId || msg.tabId || sender.tab?.id;
          if (!tabId) {
            R.push(bridgeError(PI_BROWSER_ERROR_CODES.NO_SESSION, 'no tabId for batch cdp command', { cmd: c.cmd, method: c.method }));
            continue;
          }
          const cdp = piBrowserPersistentCdp();
          if (!cdp?.send) {
            R.push(bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { cmd: c.cmd, method: c.method, tabId }));
            continue;
          }
          const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, c.method, resolve$N(c.params), { name: c.name || 'default', persistent: c.persistent === true, timeoutMs: c.timeoutMs || c.timeout_ms }));
          if (resp && resp.ok !== false) R.push({ ok: true, data: (resp.data && resp.data.result !== undefined) ? resp.data.result : (resp.result || resp.data) });
          else R.push(bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, resp?.error || resp?.message || 'persistent CDP send failed', { cmd: c.cmd, method: c.method, tabId, persistent: resp }));
        } else if (isPiNativeBrowserCommand(c.cmd)) {
          R.push(normalizeBridgeResponse(await handlePiBridgeMessage(c, sender), c.cmd));
        } else {
          R.push(bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'unknown cmd: ' + c.cmd, { cmd: c.cmd, raw: c }));
        }
      } catch (e) {
        R.push(bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: c && c.cmd, method: c && c.method, tabId: c && c.tabId, raw: { name: e && e.name, message: e && e.message, stack: e && e.stack } }));
        try { await detachCurrent(); } catch (_) {}
      }
    }
    await detachCurrent();
    return { ok: true, results: R };
  } catch (e) {
    return bridgeError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, e.message || String(e), { cmd: msg.cmd, results: R, raw: { name: e && e.name, message: e && e.message, stack: e && e.stack } });
  }
}
