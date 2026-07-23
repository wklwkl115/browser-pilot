import { chromeApi as chrome } from "./runtimeEnv";
import { isBrowserPilotNativeCommand } from "./runtime.js";
import { BROWSER_PILOT_ERROR_CODES, bridgeError } from "./runtimeSupport.js";
import { dispatchBrowserPilotBridgeCommand, validateBrowserPilotBridgeProtocolMessage } from "./core_commands";
import { handleWsExec } from "./exec";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotBridgeWebSocketLike, BrowserPilotBridgeWsEnvelope, BrowserPilotChromeMessageSender } from "./types";
import { recordBrowserPilotPrerenderActivation } from "./tab_sync";

// router.js - protocol validation and command dispatch for Browser Pilot Bridge messages.

type StorageLocalArea = { get(keys: string[]): Promise<JsonRecord>; set(items: JsonRecord): Promise<void>; remove(keys: string | string[]): Promise<void> };

function getStorageLocal(): StorageLocalArea | null {
  const s = chrome.storage as unknown as Record<string, StorageLocalArea> | undefined;
  return s?.local ?? null;
}

// Injected by transport.ts to avoid circular import: transport→router→transport.
let getTransportSocket: (() => BrowserPilotBridgeWebSocketLike | null) | null = null;
function setTransportSocketGetter(getter: () => BrowserPilotBridgeWebSocketLike | null): void { getTransportSocket = getter; }

// Module-level consent state cache (in-memory, mirrors chrome.storage.local)
let cachedConsentPending: JsonRecord | null = null;
let cachedPairedAgents: JsonRecord[] = [];

let browserPilotBridgeRouterInstalled = false;

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
  chrome.runtime.onMessage.addListener((msg: unknown, sender: BrowserPilotChromeMessageSender, sendResponse: (response: unknown) => void) => {
    // Pass-through guard: let transport.ts handle offscreen-prefixed messages.
		if (msg && typeof msg === 'object' && typeof (msg as JsonRecord).type === 'string' && String((msg as JsonRecord).type).startsWith('browser-pilot-offscreen-')) return false;
		const msgType = msg && typeof msg === 'object' ? String((msg as JsonRecord).type ?? '') : '';
			if (handleBrowserPilotRuntimeEventMessage(msgType, sender, sendResponse)) return false;
    // Popup→SW consent messages
    if (msgType === 'browser-pilot-consent-poll') {
      const storage = getStorageLocal();
      if (cachedConsentPending !== null || cachedPairedAgents.length > 0 || !storage) {
        sendResponse({ pending: cachedConsentPending, agents: cachedPairedAgents });
      } else {
        void storage.get(['browser_pilot_consent_pending', 'browser_pilot_paired_agents']).then((stored) => {
          const pending = (stored.browser_pilot_consent_pending as JsonRecord | undefined) ?? null;
          const agents = (stored.browser_pilot_paired_agents as JsonRecord[] | undefined) ?? [];
          if (cachedConsentPending === null && pending !== null) cachedConsentPending = pending;
          if (cachedPairedAgents.length === 0 && agents.length > 0) cachedPairedAgents = agents;
          sendResponse({ pending: cachedConsentPending, agents: cachedPairedAgents });
        });
      }
      return true;
    }
    if (msgType === 'browser-pilot-consent-decide') {
      const { pairingId, decision } = msg as JsonRecord & { pairingId?: string; decision?: string };
      getTransportSocket?.()?.send(JSON.stringify({ type: 'consent-response', pairingId, decision }));
      cachedConsentPending = null;
      void getStorageLocal()?.remove('browser_pilot_consent_pending');
      sendResponse({ ok: true });
      return true;
    }
    if (msgType === 'browser-pilot-consent-revoke') {
      const { pairingId } = msg as JsonRecord & { pairingId?: string };
      getTransportSocket?.()?.send(JSON.stringify({ type: 'revoke-request', pairingId }));
      sendResponse({ ok: true });
      return true;
    }
    void handleBrowserPilotBridgeMessage(msg as BrowserPilotBridgeCommand, sender).then(sendResponse);
    return true;
  });
  browserPilotBridgeRouterInstalled = true;
  return true;
}

/** @param {BrowserPilotBridgeWebSocketLike} socket @param {string | number} id @param {BrowserPilotBridgeCommand} msg @param {BrowserPilotBridgeResponse} res */
function sendBrowserPilotBridgeWsCommandResult(socket: BrowserPilotBridgeWebSocketLike, id: string | number, msg: BrowserPilotBridgeCommand, res: BrowserPilotBridgeResponse) {
  const result = res.data ?? res.results ?? res;
  if (isBrowserPilotNativeCommand(msg.cmd)) socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id, result, error: res.error ?? res }));
  else socket.send(JSON.stringify({ type: res.ok ? 'result' : 'error', id, result, error: res.error ?? res.message }));
}

/** @param {BrowserPilotBridgeWebSocketLike} socket @param {string | number} id @param {string} error @param {JsonRecord=} details */
function sendBrowserPilotBridgeWsInputError(socket: BrowserPilotBridgeWebSocketLike, id: string | number, error: string, details: JsonRecord = {}) {
  socket.send(JSON.stringify({ type: 'error', id, error, details: { ...(details || {}), dispatchStarted: false, acked: false } }));
}

type RoutedBrowserPilotBridgeWsEnvelope = BrowserPilotBridgeWsEnvelope & { id: string | number; code: unknown };

function handleBrowserPilotBridgeWsControlEnvelope(data: BrowserPilotBridgeWsEnvelope): boolean {
	if (data.type === "consent-request") {
		const pending = data as JsonRecord;
		cachedConsentPending = pending;
		void getStorageLocal()?.set({ browser_pilot_consent_pending: pending });
		void chrome.runtime.sendMessage({ type: "browser-pilot-consent-pending", pending }).catch(() => { /* no popup open */ });
		return true;
	}
	if (data.type !== "paired-agents") return false;
	const agents = Array.isArray(data.agents) ? data.agents as JsonRecord[] : [];
	cachedPairedAgents = agents;
	void getStorageLocal()?.set({ browser_pilot_paired_agents: agents });
	void chrome.runtime.sendMessage({ type: "browser-pilot-consent-agents", agents }).catch(() => { /* no popup open */ });
	return true;
}

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
  // Intercept daemon→ext consent/pairing envelopes BEFORE the id/code guard — these carry
  // `type` but no `id` or `code`, so they must be handled here first.
	if (handleBrowserPilotBridgeWsControlEnvelope(data) || !isRoutedBrowserPilotBridgeWsEnvelope(data)) return;
	const code = parseBrowserPilotBridgeWsCode(data.code);
	if (typeof code === "object" && code !== null) return await handleBrowserPilotBridgeWsCommand(data, code, socket);
	if (typeof code === "string") return await handleWsExec({ ...data, code }, socket);
	sendBrowserPilotBridgeWsInputError(socket, data.id, `Unsupported message code type: ${typeof code}`, { codeType: typeof code });
}
export { installBrowserPilotBridgeRouter, handleBrowserPilotBridgeMessage, sendBrowserPilotBridgeWsCommandResult, sendBrowserPilotBridgeWsInputError, handleBrowserPilotBridgeWsMessage, setTransportSocketGetter };
