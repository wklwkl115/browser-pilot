// router.js - protocol validation and command dispatch for Pi Browser Bridge messages.

function validatePiBridgeProtocolMessage(msg) {
  const protocol = self.PiNativeProtocol;
  if (!protocol || typeof protocol.validateCommand !== 'function') {
    return { ok: false, error: 'Pi Browser protocol schema is not loaded', details: { cmd: msg && msg.cmd } };
  }
  return protocol.validateCommand(msg, { allowMissingTabId: true });
}

async function handlePiBridgeMessage(msg, sender) {
  const validation = validatePiBridgeProtocolMessage(msg);
  if (!validation.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, validation.error, validation.details);
  msg = validation.command;
  if (msg.cmd === 'bridge_wake') return await handleBridgeWake(msg, sender);
  if (msg.cmd === 'cookies') return await handleCookies(msg, sender);
  if (msg.cmd === 'cdp') return await handleCDP(msg, sender);
  if (msg.cmd === 'persistent_cdp') return await handlePersistentCDP(msg, sender);
  if (isPiNativeBrowserCommand(msg.cmd)) return await handlePiNativeBrowserCommand(msg, sender);
  if (msg.cmd === 'batch') return await handleBatch(msg, sender);
  if (msg.cmd === 'tabs') return await handleTabsCommand(msg);
  if (msg.cmd === 'management') return await handleManagementCommand(msg);
  if (msg.cmd === 'contentSettings') return await handleContentSettingsCommand(msg);
  return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown cmd: ' + msg.cmd, { cmd: msg.cmd });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handlePiBridgeMessage(msg, sender).then(sendResponse);
  return true;
});

async function handlePiBridgeWsMessage(data, socket) {
  if (!data.id || !data.code) return;
  let code = data.code;
  if (typeof code === 'string') {
    try { const p = JSON.parse(code); if (p && typeof p === 'object') code = p; } catch (_) {}
  }
  if (typeof code === 'object' && code !== null && code.cmd) {
    if (code.tabId === undefined && data.tabId !== undefined) code.tabId = data.tabId;
    const res = await handlePiBridgeMessage(code, {});
    if (isPiNativeBrowserCommand(code.cmd)) socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error ?? res }));
    else socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
  } else if (typeof code === 'string') {
    await handleWsExec(data, socket);
  } else if (typeof code === 'object' && code !== null) {
    const msg = code.tabId === undefined && data.tabId !== undefined ? { ...code, tabId: data.tabId } : code;
    const res = await handlePiBridgeMessage(msg, {});
    if (isPiNativeBrowserCommand(msg.cmd)) socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error ?? res }));
    else socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id: data.id, result: res.data ?? res.results ?? res, error: res.error }));
  }
}
