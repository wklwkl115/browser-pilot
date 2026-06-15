import { chromeApi as chrome } from "./runtimeEnv";
import { PI_BROWSER_ERROR_CODES, bridgeError, isPiNativeBrowserCommand } from "./runtime";
import { enableCspBypassForTab } from "./bridge_info";
import { dispatchPiBridgeCommand, validatePiBridgeProtocolMessage } from "./core_commands";
import { handleWsExec } from "./exec";
import type { JsonRecord, PiBridgeCommand, PiBridgeDict, PiBridgeResponse, PiBridgeWebSocketLike, PiBridgeWsEnvelope, PiChromeMessageSender } from "./types";

// router.js - protocol validation and command dispatch for Pi Browser Bridge messages.

type StorageLocalArea = { get(keys: string[]): Promise<JsonRecord>; set(items: JsonRecord): Promise<void>; remove(keys: string | string[]): Promise<void> };

function getStorageLocal(): StorageLocalArea | null {
  const s = chrome.storage as unknown as Record<string, StorageLocalArea> | undefined;
  return s?.local ?? null;
}

// Injected by transport.ts to avoid circular import: transport→router→transport.
let getTransportSocket: (() => PiBridgeWebSocketLike | null) | null = null;
function setTransportSocketGetter(getter: () => PiBridgeWebSocketLike | null): void { getTransportSocket = getter; }

// Module-level consent state cache (in-memory, mirrors chrome.storage.local)
let cachedConsentPending: JsonRecord | null = null;
let cachedPairedAgents: JsonRecord[] = [];

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
    // Pass-through guard: let transport.ts handle offscreen-prefixed messages.
    if (msg && typeof msg === 'object' && typeof (msg as PiBridgeDict).type === 'string' && String((msg as PiBridgeDict).type).startsWith('browser-pilot-offscreen-')) return false;
    const msgType = msg && typeof msg === 'object' ? String((msg as PiBridgeDict).type ?? '') : '';
    // Popup→SW consent messages
    if (msgType === 'browser-pilot-consent-poll') {
      const storage = getStorageLocal();
      if (cachedConsentPending !== null || cachedPairedAgents.length > 0 || !storage) {
        sendResponse({ pending: cachedConsentPending, agents: cachedPairedAgents });
      } else {
        void storage.get(['pi_consent_pending', 'pi_paired_agents']).then((stored) => {
          const pending = (stored.pi_consent_pending as JsonRecord | undefined) ?? null;
          const agents = (stored.pi_paired_agents as JsonRecord[] | undefined) ?? [];
          if (cachedConsentPending === null && pending !== null) cachedConsentPending = pending;
          if (cachedPairedAgents.length === 0 && agents.length > 0) cachedPairedAgents = agents;
          sendResponse({ pending: cachedConsentPending, agents: cachedPairedAgents });
        });
      }
      return true;
    }
    if (msgType === 'browser-pilot-consent-decide') {
      const { pairingId, decision } = msg as PiBridgeDict & { pairingId?: string; decision?: string };
      getTransportSocket?.()?.send(JSON.stringify({ type: 'consent-response', pairingId, decision }));
      cachedConsentPending = null;
      void getStorageLocal()?.remove('pi_consent_pending');
      sendResponse({ ok: true });
      return true;
    }
    if (msgType === 'browser-pilot-consent-revoke') {
      const { pairingId } = msg as PiBridgeDict & { pairingId?: string };
      getTransportSocket?.()?.send(JSON.stringify({ type: 'revoke-request', pairingId }));
      sendResponse({ ok: true });
      return true;
    }
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
  // Intercept daemon→ext consent/pairing envelopes BEFORE the id/code guard — these carry
  // `type` but no `id` or `code`, so they must be handled here first.
  if (data.type === "consent-request") {
    const pending = data as JsonRecord;
    cachedConsentPending = pending;
    void getStorageLocal()?.set({ pi_consent_pending: pending });
    void chrome.runtime.sendMessage({ type: "browser-pilot-consent-pending", pending }).catch(() => { /* no popup open */ });
    return;
  }
  if (data.type === "paired-agents") {
    const agents = Array.isArray(data.agents) ? data.agents as JsonRecord[] : [];
    cachedPairedAgents = agents;
    void getStorageLocal()?.set({ pi_paired_agents: agents });
    void chrome.runtime.sendMessage({ type: "browser-pilot-consent-agents", agents }).catch(() => { /* no popup open */ });
    return;
  }
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
    // Acknowledge receipt before running the (possibly slow) native command handler, mirroring
    // the exec path's early ack. Without this, a slow native command (e.g. screenshot grinding
    // through debugger attempts) times out as "no ACK, message may not have been delivered" —
    // a misleading diagnostic, since the message WAS delivered; the handler is just slow.
    socket.send(JSON.stringify({ type: 'ack', id: data.id }));
    const res = await handlePiBridgeMessage(msg, {});
    sendPiBridgeWsCommandResult(socket, data.id, msg, res);
  } else if (typeof code === 'string') {
    enableCspBypassForTab(data.tabId);
    await handleWsExec(data as PiBridgeWsEnvelope & { id: string | number; code: string }, socket);
  } else {
    sendPiBridgeWsInputError(socket, data.id, 'Unsupported message code type: ' + typeof code, { codeType: typeof code });
  }
}
export { installPiBridgeRouter, handlePiBridgeMessage, sendPiBridgeWsCommandResult, sendPiBridgeWsInputError, handlePiBridgeWsMessage, setTransportSocketGetter };
// ESM module metadata
export const __piBridgeModule_router = { name: "router", symbols: { installPiBridgeRouter, setTransportSocketGetter, validatePiBridgeProtocolMessage, handlePiBridgeMessage, sendPiBridgeWsCommandResult, sendPiBridgeWsInputError, handlePiBridgeWsMessage } };
