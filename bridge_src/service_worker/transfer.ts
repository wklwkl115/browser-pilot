// @ts-nocheck
// transfer.js - upload/download commands for Pi browser native bridge.

const PI_BROWSER_FILE_ACCESS_MESSAGE = 'To enable file upload, open chrome://extensions, click Details under Pi Native Browser Bridge, and enable "Allow access to file URLs".';

function piTransferTimeoutMs(msg, fallback) {
  const raw = Number(msg.timeoutMs ?? msg.timeout_ms ?? fallback ?? 30000);
  if (!Number.isFinite(raw) || raw <= 0) return fallback || 30000;
  return Math.max(100, Math.min(300000, Math.floor(raw)));
}

function piTransferIsHttpUrl(url) {
  try { const u = new URL(String(url || '')); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch (_) { return false; }
}

function piTransferNormalizeDownloadMode(msg, target) {
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
  return { ok: true, mode };
}

function piTransferDownloadItem(item) {
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

function piTransferDownload(options) {
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.download(options, (id) => {
        const err = chrome.runtime?.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve(id);
      });
    } catch (error) { reject(error); }
  });
}

function piTransferSearchDownloads(query) {
  return new Promise((resolve) => {
    try { chrome.downloads.search(query || {}, items => resolve((items || []).map(piTransferDownloadItem).filter(Boolean))); }
    catch (_) { resolve([]); }
  });
}

function piTransferSearchDownload(id) {
  return piTransferSearchDownloads({ id: Number(id) }).then(items => items[0] || null);
}

function piTransferDownloadTimeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function piTransferDownloadStartedAfter(item, startedAt) {
  const itemStart = piTransferDownloadTimeMs(item && item.startTime);
  return !itemStart || itemStart >= Math.max(0, Number(startedAt || 0) - 2000);
}

function piTransferDownloadMatchesPageEvent(item, event, startedAt) {
  if (!item) return false;
  if (!piTransferDownloadStartedAfter(item, startedAt)) return false;
  const eventUrl = String(event && event.url || '');
  if (!eventUrl) return false;
  return String(item.url || '') === eventUrl || String(item.finalUrl || '') === eventUrl;
}

async function piTransferDownloadCandidatesSince(startedAt) {
  const query = { startedAfter: new Date(Math.max(0, Number(startedAt || 0) - 2000)).toISOString() };
  return await piTransferSearchDownloads(query);
}

async function piTransferAmbiguousDownload(reason, details) {
  const code = PI_BROWSER_ERROR_CODES.AMBIGUOUS_DOWNLOAD || 'AMBIGUOUS_DOWNLOAD';
  return piBrowserError(code, 'Click download could not be matched to a tab-scoped download event: ' + reason, details || {});
}

function piTransferWaitDownloadComplete(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch (_) {}
    };
    const finishFromSearch = async () => {
      const item = await piTransferSearchDownload(id);
      if (item && item.state === 'complete') { cleanup(); resolve(item); return true; }
      if (item && item.state === 'interrupted') { cleanup(); reject(new Error('Download ' + id + ' failed: ' + (item.error || 'interrupted'))); return true; }
      return false;
    };
    const onChanged = async (delta) => {
      if (!delta || Number(delta.id) !== Number(id)) return;
      if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) await finishFromSearch();
      else if (delta.filename) await finishFromSearch();
    };
    const tick = async () => {
      if (await finishFromSearch()) return;
      if (Date.now() >= deadline) { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for download ' + id)); return; }
      timer = setTimeout(tick, 250);
    };
    chrome.downloads.onChanged.addListener(onChanged);
    tick().catch((error) => { cleanup(); reject(error); });
  });
}

function piTransferDownloadCreatedWatcher(timeoutMs, matcher) {
  let settled = false;
  let timer;
  let rejectPromise;
  const cleanup = () => {
    clearTimeout(timer);
    try { chrome.downloads.onCreated.removeListener(onCreated); } catch (_) {}
  };
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    cleanup();
    fn(value);
  };
  const onCreated = (item) => {
    const normalized = piTransferDownloadItem(item);
    try { if (matcher && !matcher(normalized)) return; }
    catch (_) { return; }
    finish(resolvePromise, normalized);
  };
  let resolvePromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    timer = setTimeout(() => finish(reject, new Error('Timed out after ' + timeoutMs + 'ms waiting for download start')), timeoutMs);
    chrome.downloads.onCreated.addListener(onCreated);
  });
  return {
    promise,
    cancel() { finish(rejectPromise, new Error('Download start watcher cancelled')); },
  };
}

function piTransferWaitDownloadCreated(timeoutMs, matcher) {
  return piTransferDownloadCreatedWatcher(timeoutMs, matcher).promise;
}

function piTransferWaitPageDownloadBegin(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof subscribePiBrowserCdp !== 'function') { reject(new Error('CDP event subscription is unavailable')); return; }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for tab download event')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (subscriptionId && typeof unsubscribePiBrowserCdp === 'function') unsubscribePiBrowserCdp(subscriptionId);
    };
    const subscriptionId = subscribePiBrowserCdp(tabId, ['Page.downloadWillBegin', 'Browser.downloadWillBegin'], (_source, method, params) => {
      cleanup();
      resolve({ method, url: params && params.url, suggestedFilename: params && params.suggestedFilename, guid: params && params.guid, frameId: params && params.frameId });
    }, { waitId: 'transfer-download', kind: 'download', cdpSubscriptions: [] });
    if (!subscriptionId) { cleanup(); reject(new Error('CDP event subscription is unavailable')); }
  });
}

function piTransferWaitDownloadForPageEvent(event, startedAt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer;
    const cleanup = () => clearTimeout(timer);
    const tick = async () => {
      const query = { startedAfter: new Date(Math.max(0, Number(startedAt || 0) - 2000)).toISOString() };
      if (event && event.url) query.url = String(event.url);
      const items = (await piTransferSearchDownloads(query)).filter(item => piTransferDownloadMatchesPageEvent(item, event, startedAt));
      items.sort((a, b) => piTransferDownloadTimeMs(b.startTime) - piTransferDownloadTimeMs(a.startTime));
      const item = items[0];
      if (item && item.state === 'complete') { cleanup(); resolve(item); return; }
      if (item && item.state === 'interrupted') { cleanup(); reject(new Error('Download ' + item.id + ' failed: ' + (item.error || 'interrupted'))); return; }
      if (item && item.id != null) {
        try { const completed = await piTransferWaitDownloadComplete(item.id, Math.max(100, deadline - Date.now())); cleanup(); resolve(completed); return; }
        catch (error) { cleanup(); reject(error); return; }
      }
      if (Date.now() >= deadline) { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for tab download ' + (event && event.url || ''))); return; }
      timer = setTimeout(tick, 250);
    };
    tick().catch((error) => { cleanup(); reject(error); });
  });
}

async function piTransferEvaluate(tabId, expression, timeoutMs) {
  const cdp = piBrowserPersistentCdp();
  if (!cdp?.send) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'persistent CDP helper is not loaded', { tabId });
  const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', {
    expression: String(expression || ''),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, { persistent: true, name: 'transfer', timeoutMs }));
  if (!resp || resp.ok === false) return resp;
  const result = resp.data?.result || resp.result || resp.data;
  if (result?.exceptionDetails) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, result.exceptionDetails.exception?.description || 'Runtime.evaluate failed', result.exceptionDetails);
  return { ok: true, data: result?.result?.value };
}

function piTransferClickScript(selector, index) {
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

function piTransferClickDownloadUrlScript(selector, index, filename) {
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

function piTransferMediaUrlScript(selector, index, filename) {
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

async function piTransferDownloadWithOptions(options, timeoutMs, mode, trigger) {
  if (!chrome.downloads?.download) return piBrowserError(PI_BROWSER_ERROR_CODES.UNSUPPORTED_TARGET, 'chrome.downloads API is unavailable; reload the bridge extension after granting downloads permission', {});
  const id = await piTransferDownload(options);
  const item = await piTransferWaitDownloadComplete(id, timeoutMs);
  return { ok: true, data: { mode, trigger: trigger || null, download: item, downloadId: item.id, path: item.path || null } };
}

async function piTransferDownloadUrl(msg, timeoutMs) {
  const modeCheck = piTransferNormalizeDownloadMode(msg, 'url');
  if (modeCheck.ok === false) return modeCheck;
  if (!piTransferIsHttpUrl(msg.url)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_download url must be http(s)', { url: msg.url });
  const options = { url: String(msg.url), saveAs: msg.saveAs === true };
  if (typeof msg.filename === 'string' && msg.filename.trim()) options.filename = msg.filename.trim();
  if (['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
  return await piTransferDownloadWithOptions(options, timeoutMs, 'url', null);
}

async function piTransferDownloadFromPage(tabId, msg, timeoutMs) {
  if (!chrome.downloads?.onCreated) return piBrowserError(PI_BROWSER_ERROR_CODES.UNSUPPORTED_TARGET, 'chrome.downloads API is unavailable; reload the bridge extension after granting downloads permission', {});
  const selector = String(msg.selector || '');
  if (!selector) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'browser_download requires selector or url', {});
  const modeCheck = piTransferNormalizeDownloadMode(msg, 'selector');
  if (modeCheck.ok === false) return modeCheck;
  const mode = modeCheck.mode;
  if (mode === 'media') {
    const extracted = await piTransferEvaluate(tabId, piTransferMediaUrlScript(selector, msg.index, msg.filename), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: error.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, error: error.message || String(error), details: error.details || { selector } }));
    if (!extracted || extracted.ok === false) return extracted;
    const href = extracted.data && extracted.data.href;
    if (!href) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Matched element does not expose a downloadable media URL', { selector });
    const options = { url: String(href), saveAs: msg.saveAs === true };
    const suggested = typeof msg.filename === 'string' && msg.filename.trim() ? msg.filename.trim() : extracted.data.suggestedFilename;
    if (typeof suggested === 'string' && suggested.trim()) options.filename = suggested.trim();
    if (['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
    return await piTransferDownloadWithOptions(options, timeoutMs, 'media', extracted.data || null);
  }
  const extracted = await piTransferEvaluate(tabId, piTransferClickDownloadUrlScript(selector, msg.index, msg.filename), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: error.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, error: error.message || String(error), details: error.details || { selector } }));
  if (!extracted || extracted.ok === false) return extracted;
  const href = extracted.data && extracted.data.href;
  if (href && piTransferIsHttpUrl(href)) {
    const options = { url: String(href), saveAs: msg.saveAs === true };
    const suggested = typeof msg.filename === 'string' && msg.filename.trim() ? msg.filename.trim() : extracted.data.suggestedFilename;
    if (typeof suggested === 'string' && suggested.trim()) options.filename = suggested.trim();
    if (['uniquify', 'overwrite', 'prompt'].includes(msg.conflictAction)) options.conflictAction = msg.conflictAction;
    return await piTransferDownloadWithOptions(options, timeoutMs, 'click', { ...(extracted.data || {}), directUrl: true });
  }
  const startedAt = Date.now();
  const cdp = piBrowserPersistentCdp();
  if (cdp?.send) await cdp.send(tabId, 'Page.enable', {}, { persistent: true, name: 'transfer_download', timeoutMs: Math.min(timeoutMs, 10000) }).catch(() => null);
  const pageDownload = piTransferWaitPageDownloadBegin(tabId, timeoutMs).catch(error => ({ pageDownloadError: error.message || String(error) }));
  const triggered = await piTransferEvaluate(tabId, piTransferClickScript(selector, msg.index), Math.min(timeoutMs, 10000)).catch(error => ({ ok: false, error_code: error.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, error: error.message || String(error), details: error.details || { selector } }));
  if (!triggered || triggered.ok === false) return triggered;
  const begin = await pageDownload;
  if (begin && !begin.pageDownloadError) {
    if (!begin.url) {
      const candidates = await piTransferDownloadCandidatesSince(startedAt);
      return await piTransferAmbiguousDownload('tab download event did not include a URL', { selector, mode, trigger: triggered.data || null, downloadEvent: begin, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
    }
    try {
      const item = await piTransferWaitDownloadForPageEvent(begin, startedAt, timeoutMs);
      return { ok: true, data: { mode, trigger: triggered.data || null, downloadEvent: begin, matchStrategy: 'tab-cdp-download-event', download: item, downloadId: item.id, path: item.path || null } };
    } catch (error) {
      const candidates = await piTransferDownloadCandidatesSince(startedAt);
      return await piTransferAmbiguousDownload(error.message || String(error), { selector, mode, trigger: triggered.data || null, downloadEvent: begin, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
    }
  }
  const candidates = await piTransferDownloadCandidatesSince(startedAt);
  return await piTransferAmbiguousDownload(begin?.pageDownloadError || 'tab download event was not observed', { selector, mode, trigger: triggered.data || null, pageDownloadError: begin?.pageDownloadError || null, candidate_count: candidates.length, candidate_ids: candidates.slice(0, 10).map(item => item.id) });
}

async function handlePiBrowserTransferDownload(tabId, msg) {
  const timeoutMs = piTransferTimeoutMs(msg, 30000);
  if (msg.url) return await piTransferDownloadUrl(msg, timeoutMs);
  return await piTransferDownloadFromPage(tabId, msg, timeoutMs);
}

function piTransferFiles(msg) {
  const raw = Array.isArray(msg.files) ? msg.files : typeof msg.file === 'string' ? [msg.file] : [];
  return raw.map(file => String(file || '')).filter(Boolean);
}

function piTransferFileChooserEvent(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out after ' + timeoutMs + 'ms waiting for file chooser')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (subscriptionId) unsubscribePiBrowserCdp(subscriptionId);
    };
    let subscriptionId = subscribePiBrowserCdp(tabId, 'Page.fileChooserOpened', (_source, _method, params) => {
      cleanup();
      resolve(params || {});
    }, { waitId: 'transfer-upload', kind: 'upload', cdpSubscriptions: [] });
  });
}

async function handlePiBrowserTransferUpload(tabId, msg) {
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
    if (!Number.isInteger(chooser.backendNodeId) || chooser.backendNodeId <= 0) return piBrowserError(PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, 'File chooser event did not include backendNodeId', { chooser });
    const isMultiple = chooser.mode === 'selectMultiple';
    if (!isMultiple && files.length > 1) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'File chooser does not accept multiple files', { selector, files_count: files.length });
    const setFiles = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files }, { persistent: true, name: 'transfer_upload', timeoutMs }));
    if (!setFiles || setFiles.ok === false) {
      const msgText = setFiles?.error?.message || setFiles?.message || '';
      if (String(msgText).includes('Not allowed')) return piBrowserError(PI_BROWSER_ERROR_CODES.SAFETY_BLOCKED, PI_BROWSER_FILE_ACCESS_MESSAGE, { selector, files_count: files.length });
      return setFiles;
    }
    return { ok: true, data: { selector, index: Number.isInteger(Number(msg.index)) ? Number(msg.index) : 0, files_count: files.length, isMultiple, mode: chooser.mode || null, uploaded: true, trigger: clicked.data || null } };
  } catch (e) {
    if (String(e?.message || e).includes('Not allowed')) return piBrowserError(PI_BROWSER_ERROR_CODES.SAFETY_BLOCKED, PI_BROWSER_FILE_ACCESS_MESSAGE, { selector, files_count: files.length });
    return piBrowserError(e?.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, e?.message || String(e), e?.details || { selector, files_count: files.length });
  } finally {
    await cdp.send(tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }, { persistent: true, name: 'transfer_upload_cleanup', timeoutMs: 5000 }).catch(() => {});
  }
}

async function handlePiBrowserTransferCommand(cmd, tabId, msg) {
  if (cmd === 'transfer.download') return await handlePiBrowserTransferDownload(tabId, msg || {});
  if (cmd === 'transfer.upload') return await handlePiBrowserTransferUpload(tabId, msg || {});
  return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown transfer command: ' + cmd, { cmd });
}
// ESM module boundary marker for TODO 189
export const __piBridgeModule_transfer = { name: "transfer", symbols: { PI_BROWSER_FILE_ACCESS_MESSAGE, piTransferTimeoutMs, piTransferIsHttpUrl, piTransferNormalizeDownloadMode, piTransferDownloadItem, piTransferDownload, piTransferSearchDownloads, piTransferSearchDownload, piTransferDownloadTimeMs, piTransferDownloadStartedAfter, piTransferDownloadMatchesPageEvent, piTransferDownloadCandidatesSince, piTransferAmbiguousDownload, piTransferWaitDownloadComplete, piTransferDownloadCreatedWatcher, piTransferWaitDownloadCreated, piTransferWaitPageDownloadBegin, piTransferWaitDownloadForPageEvent, piTransferEvaluate, piTransferClickScript, piTransferClickDownloadUrlScript, piTransferMediaUrlScript, piTransferDownloadWithOptions, piTransferDownloadUrl, piTransferDownloadFromPage, handlePiBrowserTransferDownload, piTransferFiles, piTransferFileChooserEvent, handlePiBrowserTransferUpload, handlePiBrowserTransferCommand } };
