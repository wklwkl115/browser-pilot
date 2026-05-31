import { chromeApi as chrome } from "./runtimeEnv";
import { PI_BROWSER_ERROR_CODES, bridgeError, isPiNativeBrowserCommand } from "./runtime";
import { enableCspBypassForTab } from "./bridge_info";
import { dispatchPiBridgeCommand, validatePiBridgeProtocolMessage } from "./core_commands";
import { handleWsExec } from "./exec";
import type { PiBridgeCommand, PiBridgeDict, PiBridgeResponse, PiBridgeWebSocketLike, PiBridgeWsEnvelope, PiChromeMessageSender } from "./types";

// router.js - protocol validation and command dispatch for Pi Browser Bridge messages.

let piBridgeRouterInstalled = false;

/** @param {PiBridgeCommand} msg @param {PiChromeMessageSender} sender */
async function handlePiBridgeMessage(msg: PiBridgeCommand, sender: PiChromeMessageSender) {
  const validation = validatePiBridgeProtocolMessage(msg);
  if (!validation.ok) return bridgeError(PI_BROWSER_ERROR_CODES.INVALID_RULE, validation.error, validation.details);
  return await dispatchPiBridgeCommand(validation.command, sender);
}

function installPiBridgeRouter() {
  if (piBridgeRouterInstalled) return false;
  chrome.runtime.onMessage.addListener((msg: unknown, sender: PiChromeMessageSender, sendResponse: (response: unknown) => void) => {
    void handlePiBridgeMessage(msg as PiBridgeCommand, sender).then(sendResponse);
    return true;
  });
  piBridgeRouterInstalled = true;
  return true;
}

/** @param {PiBridgeWebSocketLike} socket @param {string | number} id @param {PiBridgeCommand} msg @param {PiBridgeResponse} res */
function sendPiBridgeWsCommandResult(socket: PiBridgeWebSocketLike, id: string | number, msg: PiBridgeCommand, res: PiBridgeResponse) {
  const result = res.data ?? res.results ?? res;
  if (isPiNativeBrowserCommand(msg.cmd)) socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id, result, error: res.error ?? res }));
  else socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id, result, error: res.error ?? res.message }));
}

/** @param {PiBridgeWebSocketLike} socket @param {string | number} id @param {string} error @param {PiBridgeDict=} details */
function sendPiBridgeWsInputError(socket: PiBridgeWebSocketLike, id: string | number, error: string, details: PiBridgeDict = {}) {
  socket.send(JSON.stringify({ type: 'error', id, error, details: details || {} }));
}

/** @param {PiBridgeWsEnvelope} data @param {PiBridgeWebSocketLike} socket */
async function handlePiBridgeWsMessage(data: PiBridgeWsEnvelope, socket: PiBridgeWebSocketLike) {
  if (data.id === undefined || data.id === null || data.code === undefined || data.code === null) return;
  let code: unknown = data.code;
  if (typeof code === 'string') {
    try {
      const p: unknown = JSON.parse(code);
      if (p && typeof p === 'object' && !Array.isArray(p) && typeof (p as PiBridgeDict).cmd === 'string') code = p;
    } catch (_error) {
      /* best-effort command envelope parse */
    }
  }
  if (typeof code === 'object' && code !== null) {
    const codeObj = code as PiBridgeDict & { cmd?: unknown; tabId?: unknown };
    if (typeof codeObj.cmd !== 'string' || !codeObj.cmd.trim()) {
      sendPiBridgeWsInputError(socket, data.id, 'Message object must contain a non-empty "cmd" field', { codeType: 'object' });
      return;
    }
    const msg = (codeObj.tabId === undefined && data.tabId !== undefined ? { ...codeObj, tabId: data.tabId } : codeObj) as PiBridgeCommand;
    enableCspBypassForTab(msg.tabId);
    const res = await handlePiBridgeMessage(msg, {});
    sendPiBridgeWsCommandResult(socket, data.id, msg, res);
  } else if (typeof code === 'string') {
    enableCspBypassForTab(data.tabId);
    await handleWsExec(data as PiBridgeWsEnvelope & { id: string | number; code: string }, socket);
  } else {
    sendPiBridgeWsInputError(socket, data.id, 'Unsupported message code type: ' + typeof code, { codeType: typeof code });
  }
}
export { installPiBridgeRouter, handlePiBridgeMessage, sendPiBridgeWsCommandResult, sendPiBridgeWsInputError, handlePiBridgeWsMessage };
// ESM module metadata
export const __piBridgeModule_router = { name: "router", symbols: { installPiBridgeRouter, validatePiBridgeProtocolMessage, handlePiBridgeMessage, sendPiBridgeWsCommandResult, sendPiBridgeWsInputError, handlePiBridgeWsMessage } };
