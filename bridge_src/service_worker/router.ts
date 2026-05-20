// @ts-nocheck
// router.js - protocol validation and command dispatch for Pi Browser Bridge messages.

/**
 * @param {PiBridgeCommand} msg
 * @returns {{ ok: boolean, command?: PiBridgeCommand, error?: string, details?: PiBridgeDict }}
 */
function validatePiBridgeProtocolMessage(msg) {
  const protocol = self.PiNativeProtocol;
  if (!protocol || typeof protocol.validateCommand !== 'function') {
    return { ok: false, error: 'Pi Browser protocol schema is not loaded', details: { cmd: msg && msg.cmd } };
  }
  return protocol.validateCommand(msg, { allowMissingTabId: true });
}

/** @param {PiBridgeCommand} msg @param {PiChromeMessageSender} sender */
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

/** @param {PiBridgeWebSocketLike} socket @param {string | number} id @param {PiBridgeCommand} msg @param {PiBridgeResponse} res */
function sendPiBridgeWsCommandResult(socket, id, msg, res) {
  const result = res.data ?? res.results ?? res;
  if (isPiNativeBrowserCommand(msg.cmd)) socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id, result, error: res.error ?? res }));
  else socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id, result, error: res.error }));
}

/** @param {PiBridgeWebSocketLike} socket @param {string | number} id @param {string} error @param {PiBridgeDict=} details */
function sendPiBridgeWsInputError(socket, id, error, details) {
  socket.send(JSON.stringify({ type: 'error', id, error, details: details || {} }));
}

/** @param {PiBridgeWsEnvelope} data @param {PiBridgeWebSocketLike} socket */
async function handlePiBridgeWsMessage(data, socket) {
  if (data.id === undefined || data.id === null || data.code === undefined || data.code === null) return;
  let code = data.code;
  if (typeof code === 'string') {
    try {
      const p = JSON.parse(code);
      if (p && typeof p === 'object' && !Array.isArray(p) && typeof p.cmd === 'string') code = p;
    } catch (_) {}
  }
  if (typeof code === 'object' && code !== null) {
    if (typeof code.cmd !== 'string' || !code.cmd.trim()) {
      sendPiBridgeWsInputError(socket, data.id, 'Message object must contain a non-empty "cmd" field', { codeType: 'object' });
      return;
    }
    const msg = /** @type {PiBridgeCommand} */ (code.tabId === undefined && data.tabId !== undefined ? { ...code, tabId: data.tabId } : code);
    const res = await handlePiBridgeMessage(msg, {});
    sendPiBridgeWsCommandResult(socket, data.id, msg, res);
  } else if (typeof code === 'string') {
    await handleWsExec(data, socket);
  } else {
    sendPiBridgeWsInputError(socket, data.id, 'Unsupported message code type: ' + typeof code, { codeType: typeof code });
  }
}
// ESM module boundary marker for TODO 189
export const __piBridgeModule_router = { name: "router", symbols: { validatePiBridgeProtocolMessage, handlePiBridgeMessage, sendPiBridgeWsCommandResult, sendPiBridgeWsInputError, handlePiBridgeWsMessage } };
