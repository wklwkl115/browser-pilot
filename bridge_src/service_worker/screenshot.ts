// screenshot.js - Pi browser native screenshot command.

import { chromeApi as chrome } from "./runtimeEnv";
import { PI_BROWSER_ERROR_CODES, normalizePersistentPiBrowserResponse, piBrowserError, piBrowserPersistentCdp, piSleep, piWithTimeout } from "./runtime";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse, PiChromeTab } from "./types";

function isScreenshotMissingTabError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as JsonRecord : {};
  const message = String(record.message || record.error || error || '');
  return /no tab with id|no target with given id|target closed|tab[^a-z0-9]+not[^a-z0-9]+found/i.test(message);
}

function screenshotErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

function screenshotTabNotFound(tabId: number, error: unknown): PiBridgeResponse {
  return piBrowserError(PI_BROWSER_ERROR_CODES.TAB_NOT_FOUND, 'screenshot.capture target tab not found', { tabId, reason: screenshotErrorMessage(error) });
}

async function detachScreenshotDebugger(tabId: number): Promise<PiBridgeResponse | null> {
  try {
    await chrome.debugger.detach({ tabId });
    return null;
  } catch (error) {
    const warning = { ok: false, tabId, error: screenshotErrorMessage(error) };
    console.warn('[PI-BROWSER] screenshot debugger detach failed', warning);
    return warning;
  }
}

async function getScreenshotTargetTab(tabId: number): Promise<{ ok: true; tab: PiChromeTab } | { ok: false; error: unknown }> {
  try { return { ok: true, tab: await chrome.tabs.get(tabId) }; }
  catch (error) { return { ok: false, error }; }
}

async function captureVisibleFallback(tabId: number, format: string, quality: unknown, timeoutMs: number): Promise<PiBridgeResponse> {
  const target = await getScreenshotTargetTab(tabId);
  if (!target.ok) {
    if (isScreenshotMissingTabError(target.error)) return screenshotTabNotFound(tabId, target.error);
    throw target.error;
  }
  const actualFormat = format === 'jpeg' ? 'jpeg' : 'png';
  const mime = 'image/' + actualFormat;
  const dataUrl = await piWithTimeout(chrome.tabs.captureVisibleTab(Number(target.tab.windowId || 0), { format: actualFormat, quality }), timeoutMs, 'chrome.tabs.captureVisibleTab');
  return { ok: true, data: { screenshot: dataUrl, format: actualFormat, mime, fallback: 'captureVisibleTab' } };
}

async function captureScreenshotWithRetry(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const target = await getScreenshotTargetTab(tabId);
  if (!target.ok) {
    if (isScreenshotMissingTabError(target.error)) return screenshotTabNotFound(tabId, target.error);
    throw target.error;
  }
  const format = String(msg.format || 'png');
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
          const result = ((resp.data && typeof resp.data === 'object') ? resp.data as JsonRecord : {}).result || resp.result || resp.data;
          const resultRecord = result && typeof result === 'object' ? result as JsonRecord : {};
          if (resultRecord.data) return { ok: true, data: { screenshot: 'data:image/' + format + ';base64,' + resultRecord.data, format, method: 'persistent_cdp' } };
        }
        lastErr = resp;
      } catch (e) {
        if (isScreenshotMissingTabError(e)) return screenshotTabNotFound(tabId, e);
        lastErr = new Error('persistent screenshot failed: ' + screenshotErrorMessage(e));
      }
    }
    let attached = false;
    let captureResult: PiBridgeResponse | null = null;
    let detachWarning: PiBridgeResponse | null = null;
    try {
      await piWithTimeout(chrome.debugger.attach({ tabId }, '1.3'), timeoutMs, 'chrome.debugger.attach');
      attached = true;
      const result = await piWithTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format, quality: msg.quality }), timeoutMs, 'Page.captureScreenshot');
      const resultRecord = result && typeof result === 'object' ? result as JsonRecord : {};
      captureResult = { ok: true, data: { screenshot: 'data:image/' + format + ';base64,' + resultRecord.data, format, method: 'chrome.debugger' } };
    } catch (e) {
      if (isScreenshotMissingTabError(e)) return screenshotTabNotFound(tabId, e);
      lastErr = e;
    }
    finally { if (attached) detachWarning = await detachScreenshotDebugger(tabId); }
    if (captureResult) {
      if (detachWarning && captureResult.data && typeof captureResult.data === 'object') (captureResult.data as JsonRecord).cleanup = { debuggerDetach: detachWarning };
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
  return piBrowserError(PI_BROWSER_ERROR_CODES.TIMEOUT, 'screenshot.capture failed', { reason: screenshotErrorMessage(lastErr), attempts });
}
export { isScreenshotMissingTabError, screenshotErrorMessage, screenshotTabNotFound, detachScreenshotDebugger, getScreenshotTargetTab, captureVisibleFallback, captureScreenshotWithRetry };
// ESM module metadata
export const __piBridgeModule_screenshot = { name: "screenshot", symbols: { isScreenshotMissingTabError, screenshotErrorMessage, screenshotTabNotFound, detachScreenshotDebugger, getScreenshotTargetTab, captureVisibleFallback, captureScreenshotWithRetry } };
