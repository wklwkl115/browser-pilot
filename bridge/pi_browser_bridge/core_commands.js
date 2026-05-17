// core_commands.js - non-native bridge commands: tabs, cookies, management, content settings, batch, CDP.

async function handleBridgeWake(msg, sender) {
  void probeAndConnectWS(true);
  return { ok: true, data: { connecting: true, bridge: piBridgeInfo(), url: msg.url || sender.tab?.url || null } };
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
      const tab = await chrome.tabs.create({ url: msg.url || 'about:blank', active: msg.active !== false });
      return { ok: true, data: { id: tab.id, tabId: tab.id, url: tab.url || msg.url || 'about:blank', title: tab.title || '', windowId: tab.windowId } };
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
          const tabs = (await chrome.tabs.query({})).filter(t => isScriptable(t.url));
          R.push({ ok: true, data: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId })) });
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
