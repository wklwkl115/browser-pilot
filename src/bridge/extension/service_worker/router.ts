import { chromeApi as chrome } from "./runtimeEnv";
import { BROWSER_PILOT_ERROR_CODES, bridgeError, isBrowserPilotNativeCommand } from "./runtime";
import { enableCspBypassForTab } from "./bridge_info";
import { dispatchBrowserPilotBridgeCommand, validateBrowserPilotBridgeProtocolMessage } from "./core_commands";
import { handleWsExec } from "./exec";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeDict, BrowserPilotBridgeResponse, BrowserPilotBridgeWebSocketLike, BrowserPilotBridgeWsEnvelope, BrowserPilotChromeMessageSender } from "./types";

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
    if (msg && typeof msg === 'object' && typeof (msg as BrowserPilotBridgeDict).type === 'string' && String((msg as BrowserPilotBridgeDict).type).startsWith('browser-pilot-offscreen-')) return false;
    const msgType = msg && typeof msg === 'object' ? String((msg as BrowserPilotBridgeDict).type ?? '') : '';
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
      const { pairingId, decision } = msg as BrowserPilotBridgeDict & { pairingId?: string; decision?: string };
      getTransportSocket?.()?.send(JSON.stringify({ type: 'consent-response', pairingId, decision }));
      cachedConsentPending = null;
      void getStorageLocal()?.remove('browser_pilot_consent_pending');
      sendResponse({ ok: true });
      return true;
    }
    if (msgType === 'browser-pilot-consent-revoke') {
      const { pairingId } = msg as BrowserPilotBridgeDict & { pairingId?: string };
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

/** @param {BrowserPilotBridgeWebSocketLike} socket @param {string | number} id @param {string} error @param {BrowserPilotBridgeDict=} details */
function sendBrowserPilotBridgeWsInputError(socket: BrowserPilotBridgeWebSocketLike, id: string | number, error: string, details: BrowserPilotBridgeDict = {}) {
  socket.send(JSON.stringify({ type: 'error', id, error, details: details || {} }));
}

/** @param {BrowserPilotBridgeWsEnvelope} data @param {BrowserPilotBridgeWebSocketLike} socket */
async function handleBrowserPilotBridgeWsMessage(data: BrowserPilotBridgeWsEnvelope, socket: BrowserPilotBridgeWebSocketLike) {
  // Intercept daemon→ext consent/pairing envelopes BEFORE the id/code guard — these carry
  // `type` but no `id` or `code`, so they must be handled here first.
  if (data.type === "consent-request") {
    const pending = data as JsonRecord;
    cachedConsentPending = pending;
    void getStorageLocal()?.set({ browser_pilot_consent_pending: pending });
    void chrome.runtime.sendMessage({ type: "browser-pilot-consent-pending", pending }).catch(() => { /* no popup open */ });
    return;
  }
  if (data.type === "paired-agents") {
    const agents = Array.isArray(data.agents) ? data.agents as JsonRecord[] : [];
    cachedPairedAgents = agents;
    void getStorageLocal()?.set({ browser_pilot_paired_agents: agents });
    void chrome.runtime.sendMessage({ type: "browser-pilot-consent-agents", agents }).catch(() => { /* no popup open */ });
    return;
  }
  if (data.id === undefined || data.id === null || data.code === undefined || data.code === null) return;
  let code: unknown = data.code;
  if (typeof code === 'string') {
    try {
      const p: unknown = JSON.parse(code);
      if (p && typeof p === 'object' && !Array.isArray(p) && typeof (p as BrowserPilotBridgeDict).cmd === 'string') code = p;
    } catch (_error) {
      /* best-effort command envelope parse */
    }
  }
  if (typeof code === 'object' && code !== null) {
    const codeObj = code as BrowserPilotBridgeDict & { cmd?: unknown; tabId?: unknown };
    if (typeof codeObj.cmd !== 'string' || !codeObj.cmd.trim()) {
      sendBrowserPilotBridgeWsInputError(socket, data.id, 'Message object must contain a non-empty "cmd" field', { codeType: 'object' });
      return;
    }
    const msg = (codeObj.tabId === undefined && data.tabId !== undefined ? { ...codeObj, tabId: data.tabId } : codeObj) as BrowserPilotBridgeCommand;
    enableCspBypassForTab(msg.tabId);
    // Acknowledge receipt before running the (possibly slow) native command handler, mirroring
    // the exec path's early ack. Without this, a slow native command (e.g. screenshot grinding
    // through debugger attempts) times out as "no ACK, message may not have been delivered" —
    // a misleading diagnostic, since the message WAS delivered; the handler is just slow.
    socket.send(JSON.stringify({ type: 'ack', id: data.id }));
    const res = await handleBrowserPilotBridgeMessage(msg, {});
    sendBrowserPilotBridgeWsCommandResult(socket, data.id, msg, res);
  } else if (typeof code === 'string') {
    enableCspBypassForTab(data.tabId);
    await handleWsExec(data as BrowserPilotBridgeWsEnvelope & { id: string | number; code: string }, socket);
  } else {
    sendBrowserPilotBridgeWsInputError(socket, data.id, 'Unsupported message code type: ' + typeof code, { codeType: typeof code });
  }
}
export { installBrowserPilotBridgeRouter, handleBrowserPilotBridgeMessage, sendBrowserPilotBridgeWsCommandResult, sendBrowserPilotBridgeWsInputError, handleBrowserPilotBridgeWsMessage, setTransportSocketGetter };
// ESM module metadata
export const __browserPilotBridgeModule_router = { name: "router", symbols: { installBrowserPilotBridgeRouter, setTransportSocketGetter, validateBrowserPilotBridgeProtocolMessage, handleBrowserPilotBridgeMessage, sendBrowserPilotBridgeWsCommandResult, sendBrowserPilotBridgeWsInputError, handleBrowserPilotBridgeWsMessage } };
