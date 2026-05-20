// @ts-nocheck
// screenshot.js - Pi browser native screenshot command.

function isScreenshotMissingTabError(error) {
  const message = String(error?.message || error?.error || error || '');
  return /no tab with id|no target with given id|target closed|tab[^a-z0-9]+not[^a-z0-9]+found/i.test(message);
}

function screenshotErrorMessage(error) {
  return error?.message || String(error || '');
}

function screenshotTabNotFound(tabId, error) {
  return piBrowserError(PI_BROWSER_ERROR_CODES.TAB_NOT_FOUND, 'screenshot.capture target tab not found', { tabId, reason: screenshotErrorMessage(error) });
}

async function detachScreenshotDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
    return null;
  } catch (error) {
    const warning = { ok: false, tabId, error: screenshotErrorMessage(error) };
    console.warn('[PI-BROWSER] screenshot debugger detach failed', warning);
    return warning;
  }
}

async function getScreenshotTargetTab(tabId) {
  try { return { ok: true, tab: await chrome.tabs.get(tabId) }; }
  catch (error) { return { ok: false, error }; }
}

async function captureVisibleFallback(tabId, format, quality, timeoutMs) {
  const target = await getScreenshotTargetTab(tabId);
  if (!target.ok) {
    if (isScreenshotMissingTabError(target.error)) return screenshotTabNotFound(tabId, target.error);
    throw target.error;
  }
  const actualFormat = format === 'jpeg' ? 'jpeg' : 'png';
  const mime = 'image/' + actualFormat;
  const dataUrl = await piWithTimeout(chrome.tabs.captureVisibleTab(target.tab.windowId, { format: actualFormat, quality }), timeoutMs, 'chrome.tabs.captureVisibleTab');
  return { ok: true, data: { screenshot: dataUrl, format: actualFormat, mime, fallback: 'captureVisibleTab' } };
}

async function captureScreenshotWithRetry(tabId, msg) {
  const target = await getScreenshotTargetTab(tabId);
  if (!target.ok) {
    if (isScreenshotMissingTabError(target.error)) return screenshotTabNotFound(tabId, target.error);
    throw target.error;
  }
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
      } catch (e) {
        if (isScreenshotMissingTabError(e)) return screenshotTabNotFound(tabId, e);
        e.message = 'persistent screenshot failed: ' + (e.message || String(e));
        lastErr = e;
      }
    }
    let attached = false;
    let captureResult = null;
    let detachWarning = null;
    try {
      await piWithTimeout(chrome.debugger.attach({ tabId }, '1.3'), timeoutMs, 'chrome.debugger.attach');
      attached = true;
      const result = await piWithTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format, quality: msg.quality }), timeoutMs, 'Page.captureScreenshot');
      captureResult = { ok: true, data: { screenshot: 'data:image/' + format + ';base64,' + result.data, format, method: 'chrome.debugger' } };
    } catch (e) {
      if (isScreenshotMissingTabError(e)) return screenshotTabNotFound(tabId, e);
      lastErr = e;
    }
    finally { if (attached) detachWarning = await detachScreenshotDebugger(tabId); }
    if (captureResult) {
      if (detachWarning) captureResult.data.cleanup = { debuggerDetach: detachWarning };
      return captureResult;
    }
  }
  if (msg.fallback !== false) {
    try { return await captureVisibleFallback(tabId, format, msg.quality, timeoutMs); }
    catch (e) {
      if (isScreenshotMissingTabError(e)) return screenshotTabNotFound(tabId, e);
      lastErr = e;
    }
  }
  return piBrowserError(PI_BROWSER_ERROR_CODES.TIMEOUT, 'screenshot.capture failed', { reason: lastErr?.message || String(lastErr), attempts });
}
