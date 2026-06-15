// frame.js - Browser Pilot frame commands.

import { BROWSER_PILOT_ERROR_CODES, normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotPersistentCdp } from "./runtime";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";

async function handleBrowserPilotFrameCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  if (cmd === 'frame.list') {
    const cdp = browserPilotPersistentCdp();
    if (!cdp?.frameTree) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    const fr = normalizePersistentBrowserPilotResponse(await cdp.frameTree(tabId, (msg.options && typeof msg.options === 'object') ? msg.options as JsonRecord : {}));
    if (fr && fr.ok && fr.data) { const data = fr.data as JsonRecord; return { ok: true, data: { tabId:Number(tabId), frameTree: data.frameTree || null, frames: Array.isArray(data.frames) ? data.frames : [], count: Array.isArray(data.frames) ? data.frames.length : 0 } }; }
    return fr;
  }
  if (cmd === 'frame.evaluate') {
    const cdp = browserPilotPersistentCdp();
    if (!cdp?.evaluateInFrame) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    if (!msg.frameId) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'frame.evaluate requires frameId', {});
    const options: JsonRecord = { ...((msg.options && typeof msg.options === 'object') ? msg.options as JsonRecord : {}), frameId: String(msg.frameId), awaitPromise: msg.awaitPromise !== false };
    if (msg.grantUniversalAccess !== undefined) options.grantUniversalAccess = Boolean(msg.grantUniversalAccess);
    if (msg.returnByValue !== undefined) options.returnByValue = msg.returnByValue !== false;
    if (msg.userGesture !== undefined) options.userGesture = Boolean(msg.userGesture);
    if (msg.worldName !== undefined) options.worldName = String(msg.worldName || '');
    const evaluated = normalizePersistentBrowserPilotResponse(await cdp.evaluateInFrame(tabId, String(msg.expression || ''), options));
    if (evaluated && evaluated.ok && evaluated.data) return { ok: true, data: { tabId:Number(tabId), frameId:String(msg.frameId), ...evaluated.data } };
    return evaluated;
  }
  if (cmd === 'frame.addNewDocumentScript') {
    const cdp = browserPilotPersistentCdp();
    if (!cdp?.addNewDocumentScript) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    if (!msg.source) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'frame.addNewDocumentScript requires source', {});
    const options: JsonRecord = { ...((msg.options && typeof msg.options === 'object') ? msg.options as JsonRecord : {}), persistent: true, name: 'new_document' };
    if (msg.runImmediately !== undefined) options.runImmediately = Boolean(msg.runImmediately);
    if (msg.worldName !== undefined) options.worldName = String(msg.worldName || '');
    if (msg.includeCommandLineAPI !== undefined) options.includeCommandLineAPI = Boolean(msg.includeCommandLineAPI);
    if (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined) options.timeoutMs = msg.timeoutMs ?? msg.timeout_ms;
    // Page.addScriptToEvaluateOnNewDocument is scoped to the CDP debugger session.
    // Keep the session alive so navigation can use the script and a later remove can find it.
    const added = normalizePersistentBrowserPilotResponse(await cdp.addNewDocumentScript(tabId, String(msg.source), options));
    if (added && added.ok && added.data) return { ok: true, data: { tabId:Number(tabId), ...added.data } };
    return added;
  }
  if (cmd === 'frame.removeNewDocumentScript') {
    const cdp = browserPilotPersistentCdp();
    if (!cdp?.removeNewDocumentScript) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    if (!msg.identifier) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'frame.removeNewDocumentScript requires identifier', {});
    const options: JsonRecord = { ...((msg.options && typeof msg.options === 'object') ? msg.options as JsonRecord : {}), persistent: true, name: 'new_document' };
    if (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined) options.timeoutMs = msg.timeoutMs ?? msg.timeout_ms;
    const removed = normalizePersistentBrowserPilotResponse(await cdp.removeNewDocumentScript(tabId, String(msg.identifier), options));
    if (removed && removed.ok && removed.data) return { ok: true, data: { tabId:Number(tabId), ...removed.data } };
    return removed;
  }
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown Browser Pilot frame command: ' + cmd, { cmd });
}
export { handleBrowserPilotFrameCommand };
// ESM module metadata
export const __browserPilotBridgeModule_frame = { name: "frame", symbols: { handleBrowserPilotFrameCommand } };
