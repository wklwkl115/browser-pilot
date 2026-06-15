// transfer.js - upload/download commands for the Browser Pilot bridge.

import { chromeApi as chrome } from "./runtimeEnv";
import { PI_BROWSER_ERROR_CODES, normalizePersistentPiBrowserResponse, piBrowserError, piBrowserPersistentCdp } from "./runtime";
import { subscribePiBrowserCdp, unsubscribePiBrowserCdp } from "./wait_cdp";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse, PiChromeDownloadItem } from "./types";

const PI_BROWSER_FILE_ACCESS_MESSAGE = 'To enable file upload, open chrome://extensions, click Details under Browser Pilot Bridge, and enable "Allow access to file URLs".';

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

function responseData(response: PiBridgeResponse | null | undefined): JsonRecord {
  return asRecord(response?.data);
}

function piTransferTimeoutMs(msg: PiBridgeCommand, fallback: number): number {
  const raw = Number(msg.timeoutMs ?? msg.timeout_ms ?? fallback ?? 30000);
  if (!Number.isFinite(raw) || raw <= 0) return fallback || 30000;
  return Math.max(100, Math.min(300000, Math.floor(raw)));
}

function piTransferIsHttpUrl(url: unknown): boolean {
  try { const u = new URL(String(url || '')); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch (_) { return false; }
}

function piTransferNormalizeDownloadMode(msg: PiBridgeCommand, target: TransferDownloadTarget): ({ ok: true; mode: TransferDownloadMode } | PiBridgeResponse) {
  const raw = msg && msg.mode;
  const omitted = raw === undefined || raw === null || raw === '';
  if (omitted) return { ok: true, mode: target === 'url' ? 'url' : 'click' };
  if (typeof raw !== 'string') {
    return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_download mode must be one of click, media, or url', { mode: raw, target, allowedModes: ['click', 'media', 'url'] });
  }
  const mode = raw.trim().toLowerCase();
  if (!['click', 'media', 'url'].includes(mode)) {
    return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_download mode must be one of click, media, or url', { mode: raw, target, allowedModes: ['click', 'media', 'url'] });
  }
  if (target === 'url' && mode !== 'url') {
    return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_download url target only accepts mode:url or omitted mode', { mode, target, allowedModes: ['url'] });
  }
  if (target === 'selector' && mode === 'url') {
    return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_download selector target only accepts mode:click, mode:media, or omitted mode', { mode, target, allowedModes: ['click', 'media'] });
  }
  return { ok: true, mode: mode as TransferDownloadMode };
}

function piTransferDownloadItem(item: PiChromeDownloadItem | null | undefined): TransferDownloadSummary | null {
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

function piTransferDownload(options: TransferDownloadOptions): Promise<number> {
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

function piTransferSearchDownloads(query: JsonRecord): Promise<TransferDownloadSummary[]> {
  return new Promise<TransferDownloadSummary[]>((resolve) => {
    try { chrome.downloads.search(query || {}, items => resolve((items || []).map(piTransferDownloadItem).filter((item): item is TransferDownloadSummary => Boolean(item)))); }
    catch (_) { resolve([]); }
  });
}

function piTransferSearchDownload(id: unknown): Promise<TransferDownloadSummary | null> {
  return piTransferSearchDownloads({ id: Number(id) }).then(items => items[0] || null);
}

function piTransferDownloadTimeMs(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function piTransferDownloadStartedAfter(item: TransferDownloadSummary | null | undefined, startedAt: unknown): boolean {
  const itemStart = piTransferDownloadTimeMs(item && item.startTime);
  return !itemStart || itemStart >= Math.max(0, Number(startedAt || 0) - 2000);
}

function piTransferDownloadMatchesPageEvent(item: TransferDownloadSummary | null | undefined, event: TransferPageDownloadEvent | null | undefined, startedAt: unknown): boolean {
  if (!item) return false;
  if (!piTransferDownloadStartedAfter(item, startedAt)) return false;
  const eventUrl = String(event && event.url || '');
  if (!eventUrl) return false;
  return String(item.url || '') === eventUrl || String(item.finalUrl || '') === eventUrl;
}

async function piTransferDownloadCandidatesSince(startedAt: unknown): Promise<TransferDownloadSummary[]> {
  const query = { startedAfter: new Date(Math.max(0, Number(startedAt || 0) - 2000)).toISOString() };
  return await piTransferSearchDownloads(query);
}

async function piTransferAmbiguousDownload(reason: unknown, details: JsonRecord): Promise<PiBridgeResponse> {
  const code = PI_BROWSER_ERROR_CODES.AMBIGUOUS_DOWNLOAD || 'AMBIGUOUS_DOWNLOAD';
  return piBrowserError(code, 'Click download could not be matched to a tab-scoped download event: ' + reason, details || {});
}

function piTransferWaitDownloadComplete(id: unknown, timeoutMs: number): Promise<TransferDownloadSummary> {
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
      const item = await piTransferSearchDownload(id);
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

function piTransferDownloadCreatedWatcher(timeoutMs: number, matcher?: (item: TransferDownloadSummary | null) => boolean) {
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
  const onCreated = (item: PiChromeDownloadItem) => {
    const normalized = piTransferDownloadItem(item);
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

function piTransferWaitDownloadCreated(timeoutMs: number, matcher?: (item: TransferDownloadSummary | null) => boolean): Promise<TransferDownloadSummary | null> {
  return piTransferDownloadCreatedWatcher(timeoutMs, matcher).promise;
}

function piTransferWaitPageDownloadBegin(tabId: number, timeoutMs: number): Promise<TransferPageDownloadEvent> {
  return new Promise<TransferPageDownloadEvent>((resolve, reject) => {
    if (typeof subscribePiBrowserCdp !== 'function') { reject(new Error('CDP event subscription is unavailable')); return; }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for tab download event')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (subscriptionId && typeof unsubscribePiBrowserCdp === 'function') unsubscribePiBrowserCdp(subscriptionId);
    };
    const subscriptionId = subscribePiBrowserCdp(tabId, ['Page.downloadWillBegin', 'Browser.downloadWillBegin'], (_source, method, params) => {
      cleanup();
      resolve({ method, url: params.url ? String(params.url) : '', suggestedFilename: params.suggestedFilename ? String(params.suggestedFilename) : '', guid: params.guid ? String(params.guid) : '', frameId: params.frameId });
    }, { waitId: 'transfer-download', kind: 'download', cdpSubscriptions: [] });
    if (!subscriptionId) { cleanup(); reject(new Error('CDP event subscription is unavailable')); }
  });
}

function piTransferWaitDownloadForPageEvent(event: TransferPageDownloadEvent, startedAt: unknown, timeoutMs: number): Promise<TransferDownloadSummary> {
  return new Promise<TransferDownloadSummary>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => clearTimeout(timer);
    const tick = async () => {
      const query: JsonRecord = { startedAfter: new Date(Math.max(0, Number(startedAt || 0) - 2000)).toISOString() };
      if (event && event.url) query.url = String(event.url);
      const items = (await piTransferSearchDownloads(query)).filter(item => piTransferDownloadMatchesPageEvent(item, event, startedAt));
      items.sort((a, b) => piTransferDownloadTimeMs(b.startTime) - piTransferDownloadTimeMs(a.startTime));
      const item = items[0];
      if (item && item.state === 'complete') { cleanup(); resolve(item); return; }
      if (item && item.state === 'interrupted') { cleanup(); reject(new Error('Download ' + item.id + ' failed: ' + (item.error || 'interrupted'))); return; }
      if (item && item.id != null) {
        try {
          const completed = await piTransferWaitDownloadComplete(item.id, Math.max(100, deadline - Date.now()));
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

async function piTransferEvaluate(tabId: number, expression: string, timeoutMs: number): Promise<PiBridgeResponse> {
  const cdp = piBrowserPersistentCdp();
  if (!cdp?.send) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { tabId });
  const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', {
    expression: String(expression || ''),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, { persistent: true, name: 'transfer', timeoutMs }));
  if (!resp || resp.ok === false) return resp;
  const data = asRecord(resp.data);
  const result = asRecord(data.result || resp.result || resp.data);
  const exceptionDetails = asRecord(result.exceptionDetails);
  if (result.exceptionDetails) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, asRecord(exceptionDetails.exception).description || 'Runtime.evaluate failed', exceptionDetails);
  return { ok: true, data: asRecord(asRecord(result.result).value) as TransferEvalData };
}

function piTransferClickScript(selector: unknown, index: unknown): string {
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

function piTransferClickDownloadUrlScript(selector: unknown, index: unknown, filename: unknown): string {
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

function piTransferMediaUrlScript(selector: unknown, index: unknown, filename: unknown): string {
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

async function piTransferDownloadWithOptions(options: TransferDownloadOptions, timeoutMs: number, mode: TransferDownloadMode, trigger: unknown): Promise<PiBridgeResponse> {
  if (!chrome.downloads?.download) return piBrowserError(PI_BROWSER_ERROR_CODES.UNSUPPORTED_TARGET, 'chrome.downloads API is unavailable; reload the bridge extension after granting downloads permission', {});
  const id = await piTransferDownload(options);
  const item = await piTransferWaitDownloadComplete(id, timeoutMs);
  return { ok: true, data: { mode, trigger: trigger || null, download: item, downloadId: item.id, path: item.path || null } };
}

async function piTransferDownloadUrl(msg: PiBridgeCommand, timeoutMs: number): Promise<PiBridgeResponse> {
  const modeCheck = piTransferNormalizeDownloadMode(msg, 'url');
  if (modeCheck.ok === false) return modeCheck;
  if (!piTransferIsHttpUrl(msg.url)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_download url must be http(s)', { url: msg.url });
  const options: TransferDownloadOptions = { url: String(msg.url), saveAs: msg.saveAs === true };
  if (typeof msg.filename === 'string' && msg.filename.trim()) options.filename = msg.filename.trim();
  if (typeof msg.conflictAction === 'string' && ['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
  return await piTransferDownloadWithOptions(options, timeoutMs, 'url', null);
}

async function piTransferDownloadFromPage(tabId: number, msg: PiBridgeCommand, timeoutMs: number): Promise<PiBridgeResponse> {
  if (!chrome.downloads?.onCreated) return piBrowserError(PI_BROWSER_ERROR_CODES.UNSUPPORTED_TARGET, 'chrome.downloads API is unavailable; reload the bridge extension after granting downloads permission', {});
  const selector = String(msg.selector || '');
  if (!selector) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_download requires selector or url', {});
  const modeCheck = piTransferNormalizeDownloadMode(msg, 'selector');
  if (modeCheck.ok === false) return modeCheck;
  if (!('mode' in modeCheck)) return modeCheck;
  const mode = modeCheck.mode;
  if (mode === 'media') {
    const extracted = await piTransferEvaluate(tabId, piTransferMediaUrlScript(selector, msg.index, msg.filename), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: String(errorRecord(error).code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR), error: errorText(error), details: asRecord(errorRecord(error).details || { selector }) } as PiBridgeResponse));
    if (!extracted || extracted.ok === false) return extracted;
    const extractedData = responseData(extracted) as TransferEvalData;
    const href = extractedData.href;
    if (!href) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Matched element does not expose a downloadable media URL', { selector });
    const options: TransferDownloadOptions = { url: String(href), saveAs: msg.saveAs === true };
    const suggested = typeof msg.filename === 'string' && msg.filename.trim() ? msg.filename.trim() : extractedData.suggestedFilename;
    if (typeof suggested === 'string' && suggested.trim()) options.filename = suggested.trim();
    if (typeof msg.conflictAction === 'string' && ['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
    return await piTransferDownloadWithOptions(options, timeoutMs, 'media', extractedData || null);
  }
  const extracted = await piTransferEvaluate(tabId, piTransferClickDownloadUrlScript(selector, msg.index, msg.filename), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: String(errorRecord(error).code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR), error: errorText(error), details: asRecord(errorRecord(error).details || { selector }) } as PiBridgeResponse));
  if (!extracted || extracted.ok === false) return extracted;
  const extractedData = responseData(extracted) as TransferEvalData;
  const href = extractedData.href;
  if (href && piTransferIsHttpUrl(href)) {
    const options: TransferDownloadOptions = { url: String(href), saveAs: msg.saveAs === true };
    const suggested = typeof msg.filename === 'string' && msg.filename.trim() ? msg.filename.trim() : extractedData.suggestedFilename;
    if (typeof suggested === 'string' && suggested.trim()) options.filename = suggested.trim();
    if (typeof msg.conflictAction === 'string' && ['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
    return await piTransferDownloadWithOptions(options, timeoutMs, 'click', { ...(extractedData || {}), directUrl: true });
  }
  const startedAt = Date.now();
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) await cdp.send(tabId, 'Page.enable', {}, { persistent: true, name: 'transfer_download', timeoutMs: Math.min(timeoutMs, 10000) }).catch(() => null);
  const pageDownload = piTransferWaitPageDownloadBegin(tabId, timeoutMs).catch(error => ({ pageDownloadError: errorText(error) } as TransferPageDownloadEvent));
  const triggered = await piTransferEvaluate(tabId, piTransferClickScript(selector, msg.index), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: String(errorRecord(error).code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR), error: errorText(error), details: asRecord(errorRecord(error).details || { selector }) } as PiBridgeResponse));
  if (!triggered || triggered.ok === false) return triggered;
  const triggeredData = responseData(triggered);
  const begin = await pageDownload;
  if (begin && !begin.pageDownloadError) {
    if (!begin.url) {
      const candidates = await piTransferDownloadCandidatesSince(startedAt);
      return await piTransferAmbiguousDownload('tab download event did not include a URL', { selector, mode, trigger: triggeredData || null, downloadEvent: begin, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
    }
    try {
      const item = await piTransferWaitDownloadForPageEvent(begin, startedAt, timeoutMs);
      return { ok: true, data: { mode, trigger: triggeredData || null, downloadEvent: begin, matchStrategy: 'tab-cdp-download-event', download: item, downloadId: item.id, path: item.path || null } };
    } catch (error) {
      const candidates = await piTransferDownloadCandidatesSince(startedAt);
      return await piTransferAmbiguousDownload(errorText(error), { selector, mode, trigger: triggeredData || null, downloadEvent: begin, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
    }
  }
  const candidates = await piTransferDownloadCandidatesSince(startedAt);
  return await piTransferAmbiguousDownload(begin?.pageDownloadError || 'tab download event was not observed', { selector, mode, trigger: triggeredData || null, pageDownloadError: begin?.pageDownloadError || null, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
}

async function handlePiBrowserTransferDownload(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const timeoutMs = piTransferTimeoutMs(msg, 30000);
  if (msg.url) return await piTransferDownloadUrl(msg, timeoutMs);
  return await piTransferDownloadFromPage(tabId, msg, timeoutMs);
}

function piTransferFiles(msg: PiBridgeCommand): string[] {
  const raw = Array.isArray(msg.files) ? msg.files : typeof msg.file === 'string' ? [msg.file] : [];
  return raw.map((file: unknown) => String(file || '')).filter(Boolean);
}

function piTransferFileChooserEvent(tabId: number, timeoutMs: number): Promise<JsonRecord & { backendNodeId?: number; mode?: string }> {
  return new Promise<JsonRecord & { backendNodeId?: number; mode?: string }>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for file chooser')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (subscriptionId) unsubscribePiBrowserCdp(subscriptionId);
    };
    const subscriptionId = subscribePiBrowserCdp(tabId, 'Page.fileChooserOpened', (_source, _method, params) => {
      cleanup();
      resolve(asRecord(params));
    }, { waitId: 'transfer-upload', kind: 'upload', cdpSubscriptions: [] });
  });
}

async function handlePiBrowserTransferUpload(tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  const files = piTransferFiles(msg);
  if (!files.length) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_upload requires at least one file', {});
  const selector = String(msg.selector || '');
  if (!selector) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_upload requires selector', {});
  const timeoutMs = piTransferTimeoutMs(msg, 30000);
  const cdp = piBrowserPersistentCdp();
  if (!cdp?.send) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { tabId });
  const pageEnabled = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Page.enable', {}, { persistent: true, name: 'transfer_upload', timeoutMs: Math.min(timeoutMs, 10000) }));
  if (!pageEnabled || pageEnabled.ok === false) return pageEnabled;
  const intercept = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: true }, { persistent: true, name: 'transfer_upload', timeoutMs: Math.min(timeoutMs, 10000) }));
  if (!intercept || intercept.ok === false) return intercept;
  const chooserPromise = piTransferFileChooserEvent(tabId, timeoutMs);
  try {
    const clicked = await piTransferEvaluate(tabId, piTransferClickScript(selector, msg.index), Math.min(timeoutMs, 10000));
    if (!clicked || clicked.ok === false) { chooserPromise.catch(() => {}); return clicked; }
    const chooser = await chooserPromise;
    const backendNodeId = Number(chooser.backendNodeId);
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'File chooser event did not include backendNodeId', { chooser });
    const isMultiple = chooser.mode === 'selectMultiple';
    if (!isMultiple && files.length > 1) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'File chooser does not accept multiple files', { selector, files_count: files.length });
    const setFiles = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'DOM.setFileInputFiles', { backendNodeId, files }, { persistent: true, name: 'transfer_upload', timeoutMs }));
    if (!setFiles || setFiles.ok === false) {
      const msgText = asRecord(setFiles?.error).message || setFiles?.message || '';
      if (String(msgText).includes('Not allowed')) return piBrowserError(PI_BROWSER_ERROR_CODES.SAFETY_BLOCKED, PI_BROWSER_FILE_ACCESS_MESSAGE, { selector, files_count: files.length });
      return setFiles;
    }
    return { ok: true, data: { selector, index: Number.isInteger(Number(msg.index)) ? Number(msg.index) : 0, files_count: files.length, isMultiple, mode: chooser.mode || null, uploaded: true, trigger: clicked.data || null } };
  } catch (e) {
    const err = errorRecord(e);
    if (errorText(e).includes('Not allowed')) return piBrowserError(PI_BROWSER_ERROR_CODES.SAFETY_BLOCKED, PI_BROWSER_FILE_ACCESS_MESSAGE, { selector, files_count: files.length });
    return piBrowserError(String(err.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR), err.message || errorText(e), asRecord(err.details || { selector, files_count: files.length }));
  } finally {
    await cdp.send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }, { persistent: true, name: 'transfer_upload_cleanup', timeoutMs: 5000 }).catch(() => {});
  }
}

async function handlePiBrowserTransferCommand(cmd: string, tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  if (cmd === 'transfer.download') return await handlePiBrowserTransferDownload(tabId, msg || {});
  if (cmd === 'transfer.upload') return await handlePiBrowserTransferUpload(tabId, msg || {});
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown transfer command: ' + cmd, { cmd });
}
export { PI_BROWSER_FILE_ACCESS_MESSAGE, piTransferTimeoutMs, piTransferIsHttpUrl, piTransferNormalizeDownloadMode, piTransferDownloadItem, piTransferDownload, piTransferSearchDownloads, piTransferSearchDownload, piTransferDownloadTimeMs, piTransferDownloadStartedAfter, piTransferDownloadMatchesPageEvent, piTransferDownloadCandidatesSince, piTransferAmbiguousDownload, piTransferWaitDownloadComplete, piTransferDownloadCreatedWatcher, piTransferWaitDownloadCreated, piTransferWaitPageDownloadBegin, piTransferWaitDownloadForPageEvent, piTransferEvaluate, piTransferClickScript, piTransferClickDownloadUrlScript, piTransferMediaUrlScript, piTransferDownloadWithOptions, piTransferDownloadUrl, piTransferDownloadFromPage, handlePiBrowserTransferDownload, piTransferFiles, piTransferFileChooserEvent, handlePiBrowserTransferUpload, handlePiBrowserTransferCommand };
// ESM module metadata
export const __piBridgeModule_transfer = { name: "transfer", symbols: { PI_BROWSER_FILE_ACCESS_MESSAGE, piTransferTimeoutMs, piTransferIsHttpUrl, piTransferNormalizeDownloadMode, piTransferDownloadItem, piTransferDownload, piTransferSearchDownloads, piTransferSearchDownload, piTransferDownloadTimeMs, piTransferDownloadStartedAfter, piTransferDownloadMatchesPageEvent, piTransferDownloadCandidatesSince, piTransferAmbiguousDownload, piTransferWaitDownloadComplete, piTransferDownloadCreatedWatcher, piTransferWaitDownloadCreated, piTransferWaitPageDownloadBegin, piTransferWaitDownloadForPageEvent, piTransferEvaluate, piTransferClickScript, piTransferClickDownloadUrlScript, piTransferMediaUrlScript, piTransferDownloadWithOptions, piTransferDownloadUrl, piTransferDownloadFromPage, handlePiBrowserTransferDownload, piTransferFiles, piTransferFileChooserEvent, handlePiBrowserTransferUpload, handlePiBrowserTransferCommand } };
