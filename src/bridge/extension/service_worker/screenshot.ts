// screenshot.js - Browser Pilot screenshot command.

import { chromeApi as chrome } from "./runtimeEnv";
import { BROWSER_PILOT_ERROR_CODES, normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotPersistentCdp, browserPilotSleep, browserPilotWithTimeout } from "./runtimeSupport.js";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotChromeTab } from "./types";

function isScreenshotMissingTabError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as JsonRecord : {};
  const message = String(record.message || record.error || error || '');
  return /no tab with id|no target with given id|target closed|tab[^a-z0-9]+not[^a-z0-9]+found/i.test(message);
}

function screenshotErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

function screenshotTabNotFound(tabId: number, error: unknown): BrowserPilotBridgeResponse {
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.TAB_NOT_FOUND, 'screenshot.capture target tab not found', { tabId, reason: screenshotErrorMessage(error) });
}

async function detachScreenshotDebugger(tabId: number): Promise<BrowserPilotBridgeResponse | null> {
  try {
    await chrome.debugger.detach({ tabId });
    return null;
  } catch (error) {
    const warning = { ok: false, tabId, error: screenshotErrorMessage(error) };
    console.warn('[BROWSER-PILOT] screenshot debugger detach failed', warning);
    return warning;
  }
}

async function getScreenshotTargetTab(tabId: number): Promise<{ ok: true; tab: BrowserPilotChromeTab } | { ok: false; error: unknown }> {
  try { return { ok: true, tab: await chrome.tabs.get(tabId) }; }
  catch (error) { return { ok: false, error }; }
}

async function captureVisibleFallback(tabId: number, format: string, quality: unknown, timeoutMs: number): Promise<BrowserPilotBridgeResponse> {
  const target = await getScreenshotTargetTab(tabId);
  if (!target.ok) {
    if (isScreenshotMissingTabError(target.error)) return screenshotTabNotFound(tabId, target.error);
    throw target.error;
  }
  if (target.tab.active !== true) return browserPilotError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'captureVisibleTab fallback requires the target tab to be active', { tabId, windowId: target.tab.windowId });
  const actualFormat = format === 'jpeg' ? 'jpeg' : 'png';
  const mime = 'image/' + actualFormat;
  const dataUrl = await browserPilotWithTimeout(chrome.tabs.captureVisibleTab(Number(target.tab.windowId || 0), { format: actualFormat, quality }), timeoutMs, 'chrome.tabs.captureVisibleTab');
  return { ok: true, data: { screenshot: dataUrl, format: actualFormat, mime, method: 'captureVisibleTab', fallback: 'captureVisibleTab' } };
}

async function captureScreenshotWithRetry(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const target = await getScreenshotTargetTab(tabId);
  if (!target.ok) {
    if (isScreenshotMissingTabError(target.error)) return screenshotTabNotFound(tabId, target.error);
    throw target.error;
  }
  const format = String(msg.format || 'png');
  const timeoutMs = Number(msg.timeoutMs || msg.timeout_ms || 15000);
  const attempts = Math.max(1, Math.min(3, Number(msg.retries || msg.retry || 2)));
  let lastErr = null;
  const cdp = browserPilotPersistentCdp();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await browserPilotSleep(150 * attempt);
    if (cdp?.send) {
      try {
        const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Page.captureScreenshot', { format, quality: msg.quality, captureBeyondViewport: msg.captureBeyondViewport === true }, { persistent: true, timeoutMs }));
        if (resp && resp.ok !== false) {
          const data = resp.data && typeof resp.data === 'object' ? resp.data as JsonRecord : {};
          const result = data.result || resp.result || resp.data;
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
    let captureResult: BrowserPilotBridgeResponse | null = null;
    let detachWarning: BrowserPilotBridgeResponse | null = null;
    try {
      await browserPilotWithTimeout(chrome.debugger.attach({ tabId }, '1.3'), timeoutMs, 'chrome.debugger.attach');
      attached = true;
      const result = await browserPilotWithTimeout(chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format, quality: msg.quality }), timeoutMs, 'Page.captureScreenshot');
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
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.TIMEOUT, 'screenshot.capture failed', { reason: screenshotErrorMessage(lastErr), attempts });
}
export { isScreenshotMissingTabError, screenshotErrorMessage, screenshotTabNotFound, detachScreenshotDebugger, getScreenshotTargetTab, captureVisibleFallback, captureScreenshotWithRetry };
