// @ts-nocheck
// frame.js - Pi browser native frame commands.

async function handlePiBrowserFrameCommand(cmd, tabId, msg) {
  if (cmd === 'frame.list') {
    const cdp = piBrowserPersistentCdp();
    if (!cdp?.frameTree) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    const fr = normalizePersistentPiBrowserResponse(await cdp.frameTree(tabId, msg.options || {}));
    if (fr && fr.ok && fr.data) return { ok: true, data: { tabId:Number(tabId), frameTree: fr.data.frameTree || null, frames: Array.isArray(fr.data.frames) ? fr.data.frames : [], count: Array.isArray(fr.data.frames) ? fr.data.frames.length : 0 } };
    return fr;
  }
  if (cmd === 'frame.evaluate') {
    const cdp = piBrowserPersistentCdp();
    if (!cdp?.evaluateInFrame) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    if (!msg.frameId) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'frame.evaluate requires frameId', {});
    const options = { ...(msg.options || {}), frameId: String(msg.frameId), awaitPromise: msg.awaitPromise !== false };
    if (msg.grantUniversalAccess !== undefined) options.grantUniversalAccess = Boolean(msg.grantUniversalAccess);
    if (msg.returnByValue !== undefined) options.returnByValue = msg.returnByValue !== false;
    if (msg.userGesture !== undefined) options.userGesture = Boolean(msg.userGesture);
    if (msg.worldName !== undefined) options.worldName = String(msg.worldName || '');
    const evaluated = normalizePersistentPiBrowserResponse(await cdp.evaluateInFrame(tabId, String(msg.expression || ''), options));
    if (evaluated && evaluated.ok && evaluated.data) return { ok: true, data: { tabId:Number(tabId), frameId:String(msg.frameId), ...evaluated.data } };
    return evaluated;
  }
  if (cmd === 'frame.addNewDocumentScript') {
    const cdp = piBrowserPersistentCdp();
    if (!cdp?.addNewDocumentScript) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    if (!msg.source) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'frame.addNewDocumentScript requires source', {});
    const options = { ...(msg.options || {}), persistent: true, name: 'new_document' };
    if (msg.runImmediately !== undefined) options.runImmediately = Boolean(msg.runImmediately);
    if (msg.worldName !== undefined) options.worldName = String(msg.worldName || '');
    if (msg.includeCommandLineAPI !== undefined) options.includeCommandLineAPI = Boolean(msg.includeCommandLineAPI);
    if (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined) options.timeoutMs = msg.timeoutMs ?? msg.timeout_ms;
    // Page.addScriptToEvaluateOnNewDocument is scoped to the CDP debugger session.
    // Keep the session alive so navigation can use the script and a later remove can find it.
    const added = normalizePersistentPiBrowserResponse(await cdp.addNewDocumentScript(tabId, String(msg.source), options));
    if (added && added.ok && added.data) return { ok: true, data: { tabId:Number(tabId), ...added.data } };
    return added;
  }
  if (cmd === 'frame.removeNewDocumentScript') {
    const cdp = piBrowserPersistentCdp();
    if (!cdp?.removeNewDocumentScript) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    if (!msg.identifier) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'frame.removeNewDocumentScript requires identifier', {});
    const options = { ...(msg.options || {}), persistent: true, name: 'new_document' };
    if (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined) options.timeoutMs = msg.timeoutMs ?? msg.timeout_ms;
    const removed = normalizePersistentPiBrowserResponse(await cdp.removeNewDocumentScript(tabId, String(msg.identifier), options));
    if (removed && removed.ok && removed.data) return { ok: true, data: { tabId:Number(tabId), ...removed.data } };
    return removed;
  }
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown Pi Browser frame command: ' + cmd, { cmd });
}
