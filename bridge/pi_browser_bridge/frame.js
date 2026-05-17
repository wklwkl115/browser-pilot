// frame.js - Pi browser native frame commands.

async function handlePiBrowserFrameCommand(cmd, tabId, msg) {
  if (cmd === 'frame.list') {
    const cdp = piBrowserPersistentCdp();
    if (!cdp?.frameTree) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    const fr = normalizePersistentPiBrowserResponse(await cdp.frameTree(tabId, msg.options || {}));
    if (fr && fr.ok && fr.data && fr.data.frameTree) return { ok: true, data: fr.data.frameTree };
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
    return normalizePersistentPiBrowserResponse(await cdp.evaluateInFrame(tabId, String(msg.expression || ''), options));
  }
  if (cmd === 'frame.addNewDocumentScript') {
    const cdp = piBrowserPersistentCdp();
    if (!cdp?.addNewDocumentScript) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    if (!msg.source) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'frame.addNewDocumentScript requires source', {});
    // Page.addScriptToEvaluateOnNewDocument is scoped to the CDP debugger session.
    // Keep the session alive so navigation can use the script and a later remove can find it.
    return normalizePersistentPiBrowserResponse(await cdp.addNewDocumentScript(tabId, String(msg.source), { ...(msg.options || {}), persistent: true, name: 'new_document' }));
  }
  if (cmd === 'frame.removeNewDocumentScript') {
    const cdp = piBrowserPersistentCdp();
    if (!cdp?.removeNewDocumentScript) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'Persistent CDP bridge is not loaded', { cmd });
    if (!msg.identifier) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'frame.removeNewDocumentScript requires identifier', {});
    return normalizePersistentPiBrowserResponse(await cdp.removeNewDocumentScript(tabId, String(msg.identifier), { ...(msg.options || {}), persistent: true, name: 'new_document' }));
  }
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown Pi Browser frame command: ' + cmd, { cmd });
}
