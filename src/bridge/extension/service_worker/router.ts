import { chromeApi as chrome } from "./runtimeEnv";
import { isBrowserPilotNativeCommand } from "./runtime.js";
import { BROWSER_PILOT_ERROR_CODES, bridgeError } from "./runtimeSupport.js";
import { dispatchBrowserPilotBridgeCommand, validateBrowserPilotBridgeProtocolMessage } from "./core_commands";
import { handleWsExec } from "./exec";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotBridgeWebSocketLike, BrowserPilotBridgeWsEnvelope, BrowserPilotChromeMessageSender } from "./types";
import { recordBrowserPilotPrerenderActivation } from "./tab_sync";

// router.js - protocol validation and command dispatch for Browser Pilot Bridge messages.

let browserPilotBridgeRouterInstalled = false;
const BROWSER_PILOT_BRIDGE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function handleBrowserPilotRuntimeEventMessage(msgType: string, sender: BrowserPilotChromeMessageSender, sendResponse: (response: unknown) => void): boolean {
	if (msgType === "browser-pilot-prerender-activated") {
		const tabId = Number(sender.tab?.id ?? 0);
		const activated = recordBrowserPilotPrerenderActivation(tabId);
		sendResponse({ ok: activated, tabId });
		return true;
	}
	return false;
}

/** @param {BrowserPilotBridgeCommand} msg @param {BrowserPilotChromeMessageSender} sender */
async function handleBrowserPilotBridgeMessage(msg: BrowserPilotBridgeCommand, sender: BrowserPilotChromeMessageSender) {
  const validation = validateBrowserPilotBridgeProtocolMessage(msg);
  if (!validation.ok) return bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, validation.error, validation.details);
  return await dispatchBrowserPilotBridgeCommand(validation.command, sender);
}

function installBrowserPilotBridgeRouter() {
  if (browserPilotBridgeRouterInstalled) return false;
	const local = chrome.storage?.local;
	if (local) void local.remove(["browser_pilot_consent_pending", "browser_pilot_paired_agents"]).catch(() => {});
  chrome.runtime.onMessage.addListener((msg: unknown, sender: BrowserPilotChromeMessageSender, sendResponse: (response: unknown) => void) => {
    // Pass-through guard: let transport.ts handle offscreen-prefixed messages.
	if (msg && typeof msg === 'object' && typeof (msg as JsonRecord).type === 'string' && String((msg as JsonRecord).type).startsWith('browser-pilot-offscreen-')) return false;
	const msgType = msg && typeof msg === 'object' ? String((msg as JsonRecord).type ?? '') : '';
	if (handleBrowserPilotRuntimeEventMessage(msgType, sender, sendResponse)) return false;
	void handleBrowserPilotBridgeMessage(msg as BrowserPilotBridgeCommand, sender).then(sendResponse);
    return true;
  });
  browserPilotBridgeRouterInstalled = true;
  return true;
}

/** @param {BrowserPilotBridgeWebSocketLike} socket @param {string | number} id @param {BrowserPilotBridgeCommand} msg @param {BrowserPilotBridgeResponse} res */
function sendBrowserPilotBridgeWsCommandResult(socket: BrowserPilotBridgeWebSocketLike, id: string | number, msg: BrowserPilotBridgeCommand, res: BrowserPilotBridgeResponse) {
  const result = res.data ?? res.results ?? res;
  const envelope = isBrowserPilotNativeCommand(msg.cmd)
    ? { type: res.ok ? 'result' : 'error', id, result, error: res.error ?? res }
    : { type: res.ok ? 'result' : 'error', id, result, error: res.error ?? res.message };
  const payload = JSON.stringify(envelope);
  const responseBytes = payload.length > BROWSER_PILOT_BRIDGE_MAX_RESPONSE_BYTES ? payload.length : new TextEncoder().encode(payload).length;
  if (responseBytes <= BROWSER_PILOT_BRIDGE_MAX_RESPONSE_BYTES) {
    socket.send(payload);
    return;
  }
  socket.send(JSON.stringify({
    type:'error',
    id,
    error:{
      code:BROWSER_PILOT_ERROR_CODES.BUFFER_OVERFLOW,
      message:'browser response exceeds the bridge response budget; narrow the command filters or lower its maxBytes/limit',
      details:{ cmd:msg.cmd, responseBytesAtLeast:responseBytes, maxBytes:BROWSER_PILOT_BRIDGE_MAX_RESPONSE_BYTES },
    },
  }));
}

/** @param {BrowserPilotBridgeWebSocketLike} socket @param {string | number} id @param {string} error @param {JsonRecord=} details */
function sendBrowserPilotBridgeWsInputError(socket: BrowserPilotBridgeWebSocketLike, id: string | number, error: string, details: JsonRecord = {}) {
  socket.send(JSON.stringify({ type: 'error', id, error, details: { ...(details || {}), dispatchStarted: false, acked: false } }));
}

type RoutedBrowserPilotBridgeWsEnvelope = BrowserPilotBridgeWsEnvelope & { id: string | number; code: unknown };

function isRoutedBrowserPilotBridgeWsEnvelope(data: BrowserPilotBridgeWsEnvelope): data is RoutedBrowserPilotBridgeWsEnvelope {
	return data.id !== undefined && data.id !== null && data.code !== undefined && data.code !== null;
}

function parseBrowserPilotBridgeWsCode(rawCode: unknown): unknown {
	if (typeof rawCode !== "string") return rawCode;
	try {
		const parsed: unknown = JSON.parse(rawCode);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as JsonRecord).cmd === "string") return parsed;
	} catch (_error) {
		/* best-effort command envelope parse */
	}
	return rawCode;
}

async function dispatchValidatedBrowserPilotBridgeWsCommand(data: RoutedBrowserPilotBridgeWsEnvelope, msg: BrowserPilotBridgeCommand, socket: BrowserPilotBridgeWebSocketLike): Promise<void> {
	// From this point an ACK means the exact operation/action boundary is established and the
	// validated handler is about to run, rather than merely that the envelope was received.
	socket.send(JSON.stringify({ type: "ack", id: data.id }));
	const res = await dispatchBrowserPilotBridgeCommand(msg, {});
	sendBrowserPilotBridgeWsCommandResult(socket, data.id, msg, res);
}

async function handleBrowserPilotBridgeWsCommand(data: RoutedBrowserPilotBridgeWsEnvelope, code: object, socket: BrowserPilotBridgeWebSocketLike): Promise<void> {
	const codeObj = code as JsonRecord & { cmd?: unknown; tabId?: unknown };
	if (typeof codeObj.cmd !== "string" || !codeObj.cmd.trim()) {
		sendBrowserPilotBridgeWsInputError(socket, data.id, 'Message object must contain a non-empty "cmd" field', { codeType: "object" });
		return;
	}
	const candidate = {
		...codeObj,
		...(codeObj.tabId === undefined && data.tabId !== undefined ? { tabId: data.tabId } : {}),
		...(codeObj.timeoutMs === undefined && data.timeoutMs !== undefined ? { timeoutMs: data.timeoutMs } : {}),
	} as BrowserPilotBridgeCommand;
	const validation = validateBrowserPilotBridgeProtocolMessage(candidate);
	if (!validation.ok) {
		sendBrowserPilotBridgeWsCommandResult(socket, data.id, candidate, bridgeError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, validation.error, { ...(validation.details || {}), dispatchStarted: false, acked: false }));
		return;
	}
	const msg = validation.command;
	await dispatchValidatedBrowserPilotBridgeWsCommand(data, msg, socket);
}

/** @param {BrowserPilotBridgeWsEnvelope} data @param {BrowserPilotBridgeWebSocketLike} socket */
async function handleBrowserPilotBridgeWsMessage(data: BrowserPilotBridgeWsEnvelope, socket: BrowserPilotBridgeWebSocketLike) {
	if (!isRoutedBrowserPilotBridgeWsEnvelope(data)) return;
	const code = parseBrowserPilotBridgeWsCode(data.code);
	if (typeof code === "object" && code !== null) return await handleBrowserPilotBridgeWsCommand(data, code, socket);
	if (typeof code === "string") return await handleWsExec({ ...data, code }, socket);
	sendBrowserPilotBridgeWsInputError(socket, data.id, `Unsupported message code type: ${typeof code}`, { codeType: typeof code });
}
export { BROWSER_PILOT_BRIDGE_MAX_RESPONSE_BYTES, installBrowserPilotBridgeRouter, handleBrowserPilotBridgeMessage, sendBrowserPilotBridgeWsCommandResult, sendBrowserPilotBridgeWsInputError, handleBrowserPilotBridgeWsMessage };
