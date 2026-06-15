// transfer.js - upload/download commands for the Browser Pilot bridge.

import { chromeApi as chrome } from "./runtimeEnv";
import { BROWSER_PILOT_ERROR_CODES, normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotPersistentCdp } from "./runtime";
import { subscribeBrowserPilotCdp, unsubscribeBrowserPilotCdp } from "./wait_cdp";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotChromeDownloadItem } from "./types";

const BROWSER_PILOT_FILE_ACCESS_MESSAGE = 'To enable file upload, open chrome://extensions, click Details under Browser Pilot Bridge, and enable "Allow access to file URLs".';

type TransferDownloadMode = 'click' | 'media' | 'url';
type TransferDownloadTarget = 'selector' | 'url';
type TransferDownloadSummary = JsonRecord & {
  id?: number;
  url?: string;
  finalUrl?: string;
  filename?: string;
  path?: string;
  mime?: string;
  state?: string;
  bytesReceived?: number;
  totalBytes?: number;
  danger?: string;
  exists?: boolean;
  startTime?: string;
  endTime?: string;
  error?: string;
};
type TransferPageDownloadEvent = JsonRecord & { method?: string; url?: string; suggestedFilename?: string; guid?: string; frameId?: unknown; pageDownloadError?: string };
type TransferDownloadOptions = JsonRecord & { url: string; saveAs: boolean; filename?: string; conflictAction?: string };
type TransferEvalData = JsonRecord & { href?: string; suggestedFilename?: string };

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorRecord(error: unknown): JsonRecord {
  return asRecord(error);
}

function responseData(response: BrowserPilotBridgeResponse | null | undefined): JsonRecord {
  return asRecord(response?.data);
}

function browserPilotTransferTimeoutMs(msg: BrowserPilotBridgeCommand, fallback: number): number {
  const raw = Number(msg.timeoutMs ?? msg.timeout_ms ?? fallback ?? 30000);
  if (!Number.isFinite(raw) || raw <= 0) return fallback || 30000;
  return Math.max(100, Math.min(300000, Math.floor(raw)));
}

function browserPilotTransferIsHttpUrl(url: unknown): boolean {
  try { const u = new URL(String(url || '')); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch (_) { return false; }
}

function browserPilotTransferNormalizeDownloadMode(msg: BrowserPilotBridgeCommand, target: TransferDownloadTarget): ({ ok: true; mode: TransferDownloadMode } | BrowserPilotBridgeResponse) {
  const raw = msg && msg.mode;
  const omitted = raw === undefined || raw === null || raw === '';
  if (omitted) return { ok: true, mode: target === 'url' ? 'url' : 'click' };
  if (typeof raw !== 'string') {
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'browser_download mode must be one of click, media, or url', { mode: raw, target, allowedModes: ['click', 'media', 'url'] });
  }
  const mode = raw.trim().toLowerCase();
  if (!['click', 'media', 'url'].includes(mode)) {
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'browser_download mode must be one of click, media, or url', { mode: raw, target, allowedModes: ['click', 'media', 'url'] });
  }
  if (target === 'url' && mode !== 'url') {
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'browser_download url target only accepts mode:url or omitted mode', { mode, target, allowedModes: ['url'] });
  }
  if (target === 'selector' && mode === 'url') {
    return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'browser_download selector target only accepts mode:click, mode:media, or omitted mode', { mode, target, allowedModes: ['click', 'media'] });
  }
  return { ok: true, mode: mode as TransferDownloadMode };
}

function browserPilotTransferDownloadItem(item: BrowserPilotChromeDownloadItem | null | undefined): TransferDownloadSummary | null {
  if (!item) return null;
  return {
    id: item.id,
    url: item.url,
    finalUrl: item.finalUrl,
    filename: item.filename,
    path: item.filename,
    mime: item.mime,
    state: item.state,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    danger: item.danger,
    exists: item.exists,
    startTime: item.startTime,
    endTime: item.endTime,
    error: item.error,
  };
}

function browserPilotTransferDownload(options: TransferDownloadOptions): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    try {
      chrome.downloads.download(options, (id) => {
        const err = chrome.runtime?.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve(Number(id));
      });
    } catch (error) { reject(error); }
  });
}

function browserPilotTransferSearchDownloads(query: JsonRecord): Promise<TransferDownloadSummary[]> {
  return new Promise<TransferDownloadSummary[]>((resolve) => {
    try { chrome.downloads.search(query || {}, items => resolve((items || []).map(browserPilotTransferDownloadItem).filter((item): item is TransferDownloadSummary => Boolean(item)))); }
    catch (_) { resolve([]); }
  });
}

function browserPilotTransferSearchDownload(id: unknown): Promise<TransferDownloadSummary | null> {
  return browserPilotTransferSearchDownloads({ id: Number(id) }).then(items => items[0] || null);
}

function browserPilotTransferDownloadTimeMs(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function browserPilotTransferDownloadStartedAfter(item: TransferDownloadSummary | null | undefined, startedAt: unknown): boolean {
  const itemStart = browserPilotTransferDownloadTimeMs(item && item.startTime);
  return !itemStart || itemStart >= Math.max(0, Number(startedAt || 0) - 2000);
}

function browserPilotTransferDownloadMatchesPageEvent(item: TransferDownloadSummary | null | undefined, event: TransferPageDownloadEvent | null | undefined, startedAt: unknown): boolean {
  if (!item) return false;
  if (!browserPilotTransferDownloadStartedAfter(item, startedAt)) return false;
  const eventUrl = String(event && event.url || '');
  if (!eventUrl) return false;
  return String(item.url || '') === eventUrl || String(item.finalUrl || '') === eventUrl;
}

async function browserPilotTransferDownloadCandidatesSince(startedAt: unknown): Promise<TransferDownloadSummary[]> {
  const query = { startedAfter: new Date(Math.max(0, Number(startedAt || 0) - 2000)).toISOString() };
  return await browserPilotTransferSearchDownloads(query);
}

async function browserPilotTransferAmbiguousDownload(reason: unknown, details: JsonRecord): Promise<BrowserPilotBridgeResponse> {
  const code = BROWSER_PILOT_ERROR_CODES.AMBIGUOUS_DOWNLOAD || 'AMBIGUOUS_DOWNLOAD';
  return browserPilotError(code, 'Click download could not be matched to a tab-scoped download event: ' + reason, details || {});
}

function browserPilotTransferWaitDownloadComplete(id: unknown, timeoutMs: number): Promise<TransferDownloadSummary> {
  return new Promise<TransferDownloadSummary>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch (_error) {
        /* best-effort download change listener cleanup */
      }
    };
    const finishFromSearch = async () => {
      const item = await browserPilotTransferSearchDownload(id);
      if (item && item.state === 'complete') { cleanup(); resolve(item); return true; }
      if (item && item.state === 'interrupted') { cleanup(); reject(new Error('Download ' + id + ' failed: ' + (item.error || 'interrupted'))); return true; }
      return false;
    };
    const onChanged = (delta: JsonRecord & { id?: number; state?: { current?: string }; filename?: unknown }) => {
      if (!delta || Number(delta.id) !== Number(id)) return;
      if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
        void finishFromSearch();
      } else if (delta.filename) {
        void finishFromSearch();
      }
    };
    const tick = async () => {
      if (await finishFromSearch()) return;
      if (Date.now() >= deadline) { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for download ' + id)); return; }
      timer = setTimeout(() => {
        void tick();
      }, 250);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    tick().catch((error) => { cleanup(); reject(error); });
  });
}

function browserPilotTransferDownloadCreatedWatcher(timeoutMs: number, matcher?: (item: TransferDownloadSummary | null) => boolean) {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise: (value: TransferDownloadSummary | null) => void = () => {};
  let rejectPromise: (reason?: unknown) => void = () => {};
  const cleanup = () => {
    clearTimeout(timer);
    try {
      chrome.downloads.onCreated.removeListener(onCreated);
    } catch (_error) {
      /* best-effort download creation listener cleanup */
    }
  };
  const finishResolve = (value: TransferDownloadSummary | null) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  };
  const finishReject = (value: Error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectPromise(value);
  };
  const onCreated = (item: BrowserPilotChromeDownloadItem) => {
    const normalized = browserPilotTransferDownloadItem(item);
    try {
      if (matcher && !matcher(normalized)) return;
    } catch (_error) {
      return;
    }
    finishResolve(normalized);
  };
  const promise = new Promise<TransferDownloadSummary | null>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    timer = setTimeout(() => {
      finishReject(new Error('Timed out after ' + timeoutMs + 'ms waiting for download start'));
    }, timeoutMs);
    chrome.downloads.onCreated.addListener(onCreated);
  });
  return {
    promise,
    cancel() { finishReject(new Error('Download start watcher cancelled')); },
  };
}

function browserPilotTransferWaitDownloadCreated(timeoutMs: number, matcher?: (item: TransferDownloadSummary | null) => boolean): Promise<TransferDownloadSummary | null> {
  return browserPilotTransferDownloadCreatedWatcher(timeoutMs, matcher).promise;
}

function browserPilotTransferWaitPageDownloadBegin(tabId: number, timeoutMs: number): Promise<TransferPageDownloadEvent> {
  return new Promise<TransferPageDownloadEvent>((resolve, reject) => {
    if (typeof subscribeBrowserPilotCdp !== 'function') { reject(new Error('CDP event subscription is unavailable')); return; }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for tab download event')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (subscriptionId && typeof unsubscribeBrowserPilotCdp === 'function') unsubscribeBrowserPilotCdp(subscriptionId);
    };
    const subscriptionId = subscribeBrowserPilotCdp(tabId, ['Page.downloadWillBegin', 'Browser.downloadWillBegin'], (_source, method, params) => {
      cleanup();
      resolve({ method, url: params.url ? String(params.url) : '', suggestedFilename: params.suggestedFilename ? String(params.suggestedFilename) : '', guid: params.guid ? String(params.guid) : '', frameId: params.frameId });
    }, { waitId: 'transfer-download', kind: 'download', cdpSubscriptions: [] });
    if (!subscriptionId) { cleanup(); reject(new Error('CDP event subscription is unavailable')); }
  });
}

function browserPilotTransferWaitDownloadForPageEvent(event: TransferPageDownloadEvent, startedAt: unknown, timeoutMs: number): Promise<TransferDownloadSummary> {
  return new Promise<TransferDownloadSummary>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => clearTimeout(timer);
    const tick = async () => {
      const query: JsonRecord = { startedAfter: new Date(Math.max(0, Number(startedAt || 0) - 2000)).toISOString() };
      if (event && event.url) query.url = String(event.url);
      const items = (await browserPilotTransferSearchDownloads(query)).filter(item => browserPilotTransferDownloadMatchesPageEvent(item, event, startedAt));
      items.sort((a, b) => browserPilotTransferDownloadTimeMs(b.startTime) - browserPilotTransferDownloadTimeMs(a.startTime));
      const item = items[0];
      if (item && item.state === 'complete') { cleanup(); resolve(item); return; }
      if (item && item.state === 'interrupted') { cleanup(); reject(new Error('Download ' + item.id + ' failed: ' + (item.error || 'interrupted'))); return; }
      if (item && item.id != null) {
        try {
          const completed = await browserPilotTransferWaitDownloadComplete(item.id, Math.max(100, deadline - Date.now()));
          cleanup();
          resolve(completed);
          return;
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
      }
      if (Date.now() >= deadline) { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for tab download ' + (event && event.url || ''))); return; }
      timer = setTimeout(() => {
        void tick();
      }, 250);
    };
    tick().catch((error) => { cleanup(); reject(error); });
  });
}

async function browserPilotTransferEvaluate(tabId: number, expression: string, timeoutMs: number): Promise<BrowserPilotBridgeResponse> {
  const cdp = browserPilotPersistentCdp();
  if (!cdp?.send) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { tabId });
  const resp = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Runtime.evaluate', {
    expression: String(expression || ''),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, { persistent: true, name: 'transfer', timeoutMs }));
  if (!resp || resp.ok === false) return resp;
  const data = asRecord(resp.data);
  const result = asRecord(data.result || resp.result || resp.data);
  const exceptionDetails = asRecord(result.exceptionDetails);
  if (result.exceptionDetails) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, asRecord(exceptionDetails.exception).description || 'Runtime.evaluate failed', exceptionDetails);
  return { ok: true, data: asRecord(asRecord(result.result).value) as TransferEvalData };
}

function browserPilotTransferClickScript(selector: unknown, index: unknown): string {
  const numericIndex = Number.isInteger(Number(index)) ? Number(index) : 0;
  return `(() => {
    const selector = ${JSON.stringify(String(selector || ''))};
    const index = ${numericIndex};
    let nodes;
    try { nodes = Array.from(document.querySelectorAll(selector)); }
    catch (error) { const e = new Error('Invalid selector: ' + selector); e.code = 'INVALID_SELECTOR'; e.details = { selector }; throw e; }
    if (!nodes.length) { const e = new Error('No element matches selector: ' + selector); e.code = 'ELEMENT_NOT_FOUND'; e.details = { selector }; throw e; }
    if (index < 0 || index >= nodes.length) { const e = new Error('Index out of range for selector: ' + selector); e.code = 'ELEMENT_INDEX_OUT_OF_RANGE'; e.details = { selector, index, totalMatches: nodes.length }; throw e; }
    const el = nodes[index];
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (typeof el.click !== 'function') { const e = new Error('Matched element is not clickable'); e.code = 'ELEMENT_NOT_CLICKABLE'; e.details = { selector, index }; throw e; }
    el.click();
    return { clicked: true, tagName: el.tagName, type: el.getAttribute && el.getAttribute('type'), multiple: !!el.multiple, selector, index };
  })()`;
}

function browserPilotTransferClickDownloadUrlScript(selector: unknown, index: unknown, filename: unknown): string {
  const numericIndex = Number.isInteger(Number(index)) ? Number(index) : 0;
  return `(() => {
    const selector = ${JSON.stringify(String(selector || ''))};
    const index = ${numericIndex};
    const filename = ${JSON.stringify(filename || '')};
    let nodes;
    try { nodes = Array.from(document.querySelectorAll(selector)); }
    catch (error) { const e = new Error('Invalid selector: ' + selector); e.code = 'INVALID_SELECTOR'; e.details = { selector }; throw e; }
    if (!nodes.length) { const e = new Error('No element matches selector: ' + selector); e.code = 'ELEMENT_NOT_FOUND'; e.details = { selector }; throw e; }
    if (index < 0 || index >= nodes.length) { const e = new Error('Index out of range for selector: ' + selector); e.code = 'ELEMENT_INDEX_OUT_OF_RANGE'; e.details = { selector, index, totalMatches: nodes.length }; throw e; }
    const el = nodes[index];
    const candidates = [el];
    if (el.closest) candidates.push(el.closest('a[href], area[href]'));
    if (el.querySelector) candidates.push(el.querySelector('a[href], area[href], img[src], video[src], source[src]'));
    const get = (node, name) => typeof node?.[name] === 'string' ? node[name] : null;
    for (const node of candidates) {
      if (!node) continue;
      const rawHref = node.getAttribute?.('href');
      if (rawHref !== null && rawHref !== undefined) {
        const raw = String(rawHref).trim().toLowerCase();
        if (!raw || raw === '#' || raw.startsWith('#') || raw.startsWith('javascript:')) continue;
      }
      const href = get(node, 'href') || get(node, 'currentSrc') || get(node, 'src') || '';
      if (!href) continue;
      const a = document.createElement('a');
      a.href = href;
      return { href: a.href, suggestedFilename: filename || node.getAttribute?.('download') || a.href.split('/').pop().split('?')[0] || 'download', selector, index, sourceTag: node.tagName || null };
    }
    return { href: '', suggestedFilename: filename || 'download', selector, index, sourceTag: null };
  })()`;
}

function browserPilotTransferMediaUrlScript(selector: unknown, index: unknown, filename: unknown): string {
  const numericIndex = Number.isInteger(Number(index)) ? Number(index) : 0;
  return `(() => {
    const selector = ${JSON.stringify(String(selector || ''))};
    const index = ${numericIndex};
    const filename = ${JSON.stringify(filename || '')};
    let nodes;
    try { nodes = Array.from(document.querySelectorAll(selector)); }
    catch (error) { const e = new Error('Invalid selector: ' + selector); e.code = 'INVALID_SELECTOR'; e.details = { selector }; throw e; }
    if (!nodes.length) { const e = new Error('No element matches selector: ' + selector); e.code = 'ELEMENT_NOT_FOUND'; e.details = { selector }; throw e; }
    if (index < 0 || index >= nodes.length) { const e = new Error('Index out of range for selector: ' + selector); e.code = 'ELEMENT_INDEX_OUT_OF_RANGE'; e.details = { selector, index, totalMatches: nodes.length }; throw e; }
    const el = nodes[index];
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const media = (el.closest && el.closest('img, video, source, a[href]')) || (el.querySelector && el.querySelector('img, video, source, a[href]')) || el;
    const get = (node, name) => typeof node?.[name] === 'string' ? node[name] : null;
    const href = get(media, 'currentSrc') || get(media, 'src') || get(media, 'href') || '';
    if (!href) { const e = new Error('Matched element does not expose a downloadable media URL'); e.code = 'MEDIA_URL_NOT_FOUND'; e.details = { selector, index }; throw e; }
    const a = document.createElement('a');
    a.href = href;
    return { href: a.href, suggestedFilename: filename || a.href.split('/').pop().split('?')[0] || 'download', selector, index };
  })()`;
}

async function browserPilotTransferDownloadWithOptions(options: TransferDownloadOptions, timeoutMs: number, mode: TransferDownloadMode, trigger: unknown): Promise<BrowserPilotBridgeResponse> {
  if (!chrome.downloads?.download) return browserPilotError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'chrome.downloads API is unavailable; reload the bridge extension after granting downloads permission', {});
  const id = await browserPilotTransferDownload(options);
  const item = await browserPilotTransferWaitDownloadComplete(id, timeoutMs);
  return { ok: true, data: { mode, trigger: trigger || null, download: item, downloadId: item.id, path: item.path || null } };
}

async function browserPilotTransferDownloadUrl(msg: BrowserPilotBridgeCommand, timeoutMs: number): Promise<BrowserPilotBridgeResponse> {
  const modeCheck = browserPilotTransferNormalizeDownloadMode(msg, 'url');
  if (modeCheck.ok === false) return modeCheck;
  if (!browserPilotTransferIsHttpUrl(msg.url)) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'browser_download url must be http(s)', { url: msg.url });
  const options: TransferDownloadOptions = { url: String(msg.url), saveAs: msg.saveAs === true };
  if (typeof msg.filename === 'string' && msg.filename.trim()) options.filename = msg.filename.trim();
  if (typeof msg.conflictAction === 'string' && ['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
  return await browserPilotTransferDownloadWithOptions(options, timeoutMs, 'url', null);
}

async function browserPilotTransferDownloadFromPage(tabId: number, msg: BrowserPilotBridgeCommand, timeoutMs: number): Promise<BrowserPilotBridgeResponse> {
  if (!chrome.downloads?.onCreated) return browserPilotError(BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET, 'chrome.downloads API is unavailable; reload the bridge extension after granting downloads permission', {});
  const selector = String(msg.selector || '');
  if (!selector) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'browser_download requires selector or url', {});
  const modeCheck = browserPilotTransferNormalizeDownloadMode(msg, 'selector');
  if (modeCheck.ok === false) return modeCheck;
  if (!('mode' in modeCheck)) return modeCheck;
  const mode = modeCheck.mode;
  if (mode === 'media') {
    const extracted = await browserPilotTransferEvaluate(tabId, browserPilotTransferMediaUrlScript(selector, msg.index, msg.filename), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: String(errorRecord(error).code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR), error: errorText(error), details: asRecord(errorRecord(error).details || { selector }) } as BrowserPilotBridgeResponse));
    if (!extracted || extracted.ok === false) return extracted;
    const extractedData = responseData(extracted) as TransferEvalData;
    const href = extractedData.href;
    if (!href) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Matched element does not expose a downloadable media URL', { selector });
    const options: TransferDownloadOptions = { url: String(href), saveAs: msg.saveAs === true };
    const suggested = typeof msg.filename === 'string' && msg.filename.trim() ? msg.filename.trim() : extractedData.suggestedFilename;
    if (typeof suggested === 'string' && suggested.trim()) options.filename = suggested.trim();
    if (typeof msg.conflictAction === 'string' && ['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
    return await browserPilotTransferDownloadWithOptions(options, timeoutMs, 'media', extractedData || null);
  }
  const extracted = await browserPilotTransferEvaluate(tabId, browserPilotTransferClickDownloadUrlScript(selector, msg.index, msg.filename), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: String(errorRecord(error).code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR), error: errorText(error), details: asRecord(errorRecord(error).details || { selector }) } as BrowserPilotBridgeResponse));
  if (!extracted || extracted.ok === false) return extracted;
  const extractedData = responseData(extracted) as TransferEvalData;
  const href = extractedData.href;
  if (href && browserPilotTransferIsHttpUrl(href)) {
    const options: TransferDownloadOptions = { url: String(href), saveAs: msg.saveAs === true };
    const suggested = typeof msg.filename === 'string' && msg.filename.trim() ? msg.filename.trim() : extractedData.suggestedFilename;
    if (typeof suggested === 'string' && suggested.trim()) options.filename = suggested.trim();
    if (typeof msg.conflictAction === 'string' && ['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
    return await browserPilotTransferDownloadWithOptions(options, timeoutMs, 'click', { ...(extractedData || {}), directUrl: true });
  }
  const startedAt = Date.now();
  const cdp = browserPilotPersistentCdp();
  if (cdp?.send) await cdp.send(tabId, 'Page.enable', {}, { persistent: true, name: 'transfer_download', timeoutMs: Math.min(timeoutMs, 10000) }).catch(() => null);
  const pageDownload = browserPilotTransferWaitPageDownloadBegin(tabId, timeoutMs).catch(error => ({ pageDownloadError: errorText(error) } as TransferPageDownloadEvent));
  const triggered = await browserPilotTransferEvaluate(tabId, browserPilotTransferClickScript(selector, msg.index), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: String(errorRecord(error).code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR), error: errorText(error), details: asRecord(errorRecord(error).details || { selector }) } as BrowserPilotBridgeResponse));
  if (!triggered || triggered.ok === false) return triggered;
  const triggeredData = responseData(triggered);
  const begin = await pageDownload;
  if (begin && !begin.pageDownloadError) {
    if (!begin.url) {
      const candidates = await browserPilotTransferDownloadCandidatesSince(startedAt);
      return await browserPilotTransferAmbiguousDownload('tab download event did not include a URL', { selector, mode, trigger: triggeredData || null, downloadEvent: begin, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
    }
    try {
      const item = await browserPilotTransferWaitDownloadForPageEvent(begin, startedAt, timeoutMs);
      return { ok: true, data: { mode, trigger: triggeredData || null, downloadEvent: begin, matchStrategy: 'tab-cdp-download-event', download: item, downloadId: item.id, path: item.path || null } };
    } catch (error) {
      const candidates = await browserPilotTransferDownloadCandidatesSince(startedAt);
      return await browserPilotTransferAmbiguousDownload(errorText(error), { selector, mode, trigger: triggeredData || null, downloadEvent: begin, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
    }
  }
  const candidates = await browserPilotTransferDownloadCandidatesSince(startedAt);
  return await browserPilotTransferAmbiguousDownload(begin?.pageDownloadError || 'tab download event was not observed', { selector, mode, trigger: triggeredData || null, pageDownloadError: begin?.pageDownloadError || null, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
}

async function handleBrowserPilotTransferDownload(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const timeoutMs = browserPilotTransferTimeoutMs(msg, 30000);
  if (msg.url) return await browserPilotTransferDownloadUrl(msg, timeoutMs);
  return await browserPilotTransferDownloadFromPage(tabId, msg, timeoutMs);
}

function browserPilotTransferFiles(msg: BrowserPilotBridgeCommand): string[] {
  const raw = Array.isArray(msg.files) ? msg.files : typeof msg.file === 'string' ? [msg.file] : [];
  return raw.map((file: unknown) => String(file || '')).filter(Boolean);
}

function browserPilotTransferFileChooserEvent(tabId: number, timeoutMs: number): Promise<JsonRecord & { backendNodeId?: number; mode?: string }> {
  return new Promise<JsonRecord & { backendNodeId?: number; mode?: string }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for file chooser')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (subscriptionId) unsubscribeBrowserPilotCdp(subscriptionId);
    };
    const subscriptionId = subscribeBrowserPilotCdp(tabId, 'Page.fileChooserOpened', (_source, _method, params) => {
      cleanup();
      resolve(asRecord(params));
    }, { waitId: 'transfer-upload', kind: 'upload', cdpSubscriptions: [] });
  });
}

async function handleBrowserPilotTransferUpload(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  const files = browserPilotTransferFiles(msg);
  if (!files.length) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'browser_upload requires at least one file', {});
  const selector = String(msg.selector || '');
  if (!selector) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'browser_upload requires selector', {});
  const timeoutMs = browserPilotTransferTimeoutMs(msg, 30000);
  const cdp = browserPilotPersistentCdp();
  if (!cdp?.send) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { tabId });
  const pageEnabled = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Page.enable', {}, { persistent: true, name: 'transfer_upload', timeoutMs: Math.min(timeoutMs, 10000) }));
  if (!pageEnabled || pageEnabled.ok === false) return pageEnabled;
  const intercept = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true }, { persistent: true, name: 'transfer_upload', timeoutMs: Math.min(timeoutMs, 10000) }));
  if (!intercept || intercept.ok === false) return intercept;
  const chooserPromise = browserPilotTransferFileChooserEvent(tabId, timeoutMs);
  try {
    const clicked = await browserPilotTransferEvaluate(tabId, browserPilotTransferClickScript(selector, msg.index), Math.min(timeoutMs, 10000));
    if (!clicked || clicked.ok === false) { chooserPromise.catch(() => {}); return clicked; }
    const chooser = await chooserPromise;
    const backendNodeId = Number(chooser.backendNodeId);
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, 'File chooser event did not include backendNodeId', { chooser });
    const isMultiple = chooser.mode === 'selectMultiple';
    if (!isMultiple && files.length > 1) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'File chooser does not accept multiple files', { selector, files_count: files.length });
    const setFiles = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, 'DOM.setFileInputFiles', { backendNodeId, files }, { persistent: true, name: 'transfer_upload', timeoutMs }));
    if (!setFiles || setFiles.ok === false) {
      const msgText = asRecord(setFiles?.error).message || setFiles?.message || '';
      if (String(msgText).includes('Not allowed')) return browserPilotError(BROWSER_PILOT_ERROR_CODES.SAFETY_BLOCKED, BROWSER_PILOT_FILE_ACCESS_MESSAGE, { selector, files_count: files.length });
      return setFiles;
    }
    return { ok: true, data: { selector, index: Number.isInteger(Number(msg.index)) ? Number(msg.index) : 0, files_count: files.length, isMultiple, mode: chooser.mode || null, uploaded: true, trigger: clicked.data || null } };
  } catch (e) {
    const err = errorRecord(e);
    if (errorText(e).includes('Not allowed')) return browserPilotError(BROWSER_PILOT_ERROR_CODES.SAFETY_BLOCKED, BROWSER_PILOT_FILE_ACCESS_MESSAGE, { selector, files_count: files.length });
    return browserPilotError(String(err.code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR), err.message || errorText(e), asRecord(err.details || { selector, files_count: files.length }));
  } finally {
    await cdp.send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }, { persistent: true, name: 'transfer_upload_cleanup', timeoutMs: 5000 }).catch(() => {});
  }
}

async function handleBrowserPilotTransferCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  if (cmd === 'transfer.download') return await handleBrowserPilotTransferDownload(tabId, msg || {});
  if (cmd === 'transfer.upload') return await handleBrowserPilotTransferUpload(tabId, msg || {});
  return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown transfer command: ' + cmd, { cmd });
}
export { BROWSER_PILOT_FILE_ACCESS_MESSAGE, browserPilotTransferTimeoutMs, browserPilotTransferIsHttpUrl, browserPilotTransferNormalizeDownloadMode, browserPilotTransferDownloadItem, browserPilotTransferDownload, browserPilotTransferSearchDownloads, browserPilotTransferSearchDownload, browserPilotTransferDownloadTimeMs, browserPilotTransferDownloadStartedAfter, browserPilotTransferDownloadMatchesPageEvent, browserPilotTransferDownloadCandidatesSince, browserPilotTransferAmbiguousDownload, browserPilotTransferWaitDownloadComplete, browserPilotTransferDownloadCreatedWatcher, browserPilotTransferWaitDownloadCreated, browserPilotTransferWaitPageDownloadBegin, browserPilotTransferWaitDownloadForPageEvent, browserPilotTransferEvaluate, browserPilotTransferClickScript, browserPilotTransferClickDownloadUrlScript, browserPilotTransferMediaUrlScript, browserPilotTransferDownloadWithOptions, browserPilotTransferDownloadUrl, browserPilotTransferDownloadFromPage, handleBrowserPilotTransferDownload, browserPilotTransferFiles, browserPilotTransferFileChooserEvent, handleBrowserPilotTransferUpload, handleBrowserPilotTransferCommand };
// ESM module metadata
export const __browserPilotBridgeModule_transfer = { name: "transfer", symbols: { BROWSER_PILOT_FILE_ACCESS_MESSAGE, browserPilotTransferTimeoutMs, browserPilotTransferIsHttpUrl, browserPilotTransferNormalizeDownloadMode, browserPilotTransferDownloadItem, browserPilotTransferDownload, browserPilotTransferSearchDownloads, browserPilotTransferSearchDownload, browserPilotTransferDownloadTimeMs, browserPilotTransferDownloadStartedAfter, browserPilotTransferDownloadMatchesPageEvent, browserPilotTransferDownloadCandidatesSince, browserPilotTransferAmbiguousDownload, browserPilotTransferWaitDownloadComplete, browserPilotTransferDownloadCreatedWatcher, browserPilotTransferWaitDownloadCreated, browserPilotTransferWaitPageDownloadBegin, browserPilotTransferWaitDownloadForPageEvent, browserPilotTransferEvaluate, browserPilotTransferClickScript, browserPilotTransferClickDownloadUrlScript, browserPilotTransferMediaUrlScript, browserPilotTransferDownloadWithOptions, browserPilotTransferDownloadUrl, browserPilotTransferDownloadFromPage, handleBrowserPilotTransferDownload, browserPilotTransferFiles, browserPilotTransferFileChooserEvent, handleBrowserPilotTransferUpload, handleBrowserPilotTransferCommand } };
