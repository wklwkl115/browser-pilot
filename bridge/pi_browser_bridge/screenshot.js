// screenshot.js - Pi browser native screenshot command.

async function captureVisibleFallback(tabId, format, quality, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
  const dataUrl = await piWithTimeout(chrome.tabs.captureVisibleTab(tab.windowId, { format: format === 'jpeg' ? 'jpeg' : 'png', quality }), timeoutMs, 'chrome.tabs.captureVisibleTab');
  return { ok: true, data: { screenshot: dataUrl, format: format || 'png', fallback: 'captureVisibleTab' } };
}

async function captureScreenshotWithRetry(tabId, msg) {
  const format = msg.format || 'png';
  const timeoutMs = Number(msg.timeoutMs || msg.timeout_ms || 15000);
  const attempts = Math.max(1, Math.min(3, Number(msg.retries || msg.retry || 2)));
  let lastErr = null;
  const cdp = piBrowserPersistentCdp();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await piSleep(150 * attempt);
    if (cdp?.send) {
      try {
        const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Page.captureScreenshot', { format, quality: msg.quality, captureBeyondViewport: msg.captureBeyondViewport === true }, { persistent: true, timeoutMs }));
        if (resp && resp.ok !== false) {
          const result = resp.data?.result || resp.result || resp.data;
          if (result && result.data) return { ok: true, data: { screenshot: 'data:image/' + format + ';base64,' + result.data, format, method: 'persistent_cdp' } };
        }
        lastErr = resp;
      } catch (e) { e.message = 'persistent screenshot failed: ' + (e.message || String(e)); lastErr = e; }
    }
    let attached = false;
    try {
      await piWithTimeout(chrome.debugger.attach({ tabId }, '1.3'), timeoutMs, 'chrome.debugger.attach');
      attached = true;
      const result = await piWithTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format, quality: msg.quality }), timeoutMs, 'Page.captureScreenshot');
      return { ok: true, data: { screenshot: 'data:image/' + format + ';base64,' + result.data, format, method: 'chrome.debugger' } };
    } catch (e) { lastErr = e; }
    finally { if (attached) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} } }
  }
  if (msg.fallback !== false) {
    try { return await captureVisibleFallback(tabId, format, msg.quality, timeoutMs); } catch (e) { lastErr = e; }
  }
  return piBrowserError(PI_BROWSER_ERROR_CODES.TIMEOUT, 'screenshot.capture failed', { reason: lastErr?.message || String(lastErr), attempts });
}
