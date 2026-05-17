/* ============================================================
 * browser_pro_dispatcher.js — GA/TMWD browser_pro P2 page dispatcher
 * Generated package only; injected by assets/tmwd_cdp_bridge/background.js.
 * Contract: D2_bridge_api_contract.md / D2_bridge_command_schema.json
 * ============================================================ */
;(function GABrowserProDispatcher() {
  'use strict';

  const VERSION = 'p2.1.0';
  const existingBrowserPro = window.__GA_BROWSER_PRO__;
  if (existingBrowserPro && existingBrowserPro.dispatch) {
    if (existingBrowserPro.version === VERSION) return;
    try {
      if (typeof existingBrowserPro.uninstall === 'function') {
        existingBrowserPro.uninstall({ force: true, reason: 'dispatcher_upgrade', next_version: VERSION });
      }
    } catch (_) {}
  }
  const DEFAULT_BUFFER_SIZE = 1000;
  const ERROR_CODES = {
    NO_SESSION: 'NO_SESSION', ALREADY_INSTALLED: 'ALREADY_INSTALLED', NOT_INSTALLED: 'NOT_INSTALLED',
    INVALID_RULE: 'INVALID_RULE', UNSUPPORTED_TARGET: 'UNSUPPORTED_TARGET', INJECTION_FAILED: 'INJECTION_FAILED',
    SAFETY_BLOCKED: 'SAFETY_BLOCKED', TIMEOUT: 'TIMEOUT', BUFFER_OVERFLOW: 'BUFFER_OVERFLOW', INTERNAL_ERROR: 'INTERNAL_ERROR'
  };
  const COMMAND_CANONICAL = {
    'browser_pro.ping': 'browser_pro.status'
  };
  const DEFAULT_TARGETS = {
    network: false, dom: false, console: false, error: false, xpath: [], cookies: false, storage: false,
    websocket: false, crypto: false, dom_sinks: false
  };
  const DEFAULT_STATS = {
    network_events: 0, dom_events: 0, console_events: 0, error_events: 0, storage_events: 0,
    websocket_events: 0, crypto_events: 0, cookie_events: 0, sink_events: 0, overflow: 0
  };
  const DEFAULT_LIMITS = {
    perf_sample_limit: 256,
    mutation_queue_hard_limit: 2000,
    mutation_flush_sample_limit: 50,
    xpath_max_per_tick: 50,
    xpath_large_result_threshold: 500,
    xpath_large_result_repeat_ticks: 12
  };

  function canonicalCommand(cmd) { return COMMAND_CANONICAL[cmd] || cmd; }
  function structuredError(error_code, message, details) { return { ok: false, error_code, error: message, details: details || {} }; }
  function now() { return new Date().toISOString(); }
  function stableStringify(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  function buildInstallFingerprint(sessionId, nextTargets, nextOptions, nextBufferSize, explicit) {
    if (explicit != null && explicit !== '') return String(explicit);
    return stableStringify({
      session_id: sessionId || null,
      targets: nextTargets || {},
      options: nextOptions || {},
      buffer_size: nextBufferSize || DEFAULT_BUFFER_SIZE
    });
  }
  function numericOption(name, fallback, min, max) {
    const raw = options && options[name] != null ? Number(options[name]) : fallback;
    let n = Number.isFinite(raw) ? raw : fallback;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
  }
  function clone(v) { return safeString(v); }
  function redactText(text) {
    let out = String(text);
    const defaults = [
      'fixture-secret',
      'fixture-password',
      'bearer\\s+fixture-secret',
      'authorization:\\s*bearer\\s+[^\\s,;\\x29]+'
    ];
    const custom = options && Array.isArray(options.redact_patterns) ? options.redact_patterns : [];
    defaults.concat(custom).forEach(p => {
      try { out = out.replace(new RegExp(String(p), 'gi'), '[REDACTED]'); } catch (_) {}
    });
    return out;
  }
  function redactClone(v, depth, seen) {
    if (v == null) return v;
    const t = typeof v;
    if (t === 'string') return redactText(v);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return v;
    if (t === 'undefined') return undefined;
    if (t === 'function') return '[Function' + (v.name ? ':' + v.name : '') + ']';
    const maxDepth = numericOption('max_clone_depth', 10, 1, 50);
    if ((depth || 0) >= maxDepth) return '[MaxDepth]';
    seen = seen || (typeof WeakSet !== 'undefined' ? new WeakSet() : null);
    if (seen) { if (seen.has(v)) return '[Circular]'; try { seen.add(v); } catch (_) {} }
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return { kind: 'ArrayBuffer', byteLength: v.byteLength };
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v)) return { kind: v.constructor && v.constructor.name || 'TypedArray', byteLength: v.byteLength, length: v.length };
    if (typeof Blob !== 'undefined' && v instanceof Blob) return { kind: 'Blob', size: v.size, type: v.type };
    if (typeof FormData !== 'undefined' && v instanceof FormData) { const keys = []; try { v.forEach((_, k) => keys.push(String(k))); } catch (_) {} return { kind: 'FormData', keys }; }
    if (v instanceof Error) return redactClone(serializeError(v), (depth || 0) + 1, seen);
    const maxItems = numericOption('max_array_items', 100, 1, 10000);
    const maxKeys = numericOption('max_object_keys', 100, 1, 10000);
    if (Array.isArray(v)) {
      const out = v.slice(0, maxItems).map(x => redactClone(x, (depth || 0) + 1, seen));
      if (v.length > maxItems) out.push('…[' + (v.length - maxItems) + ' more items]');
      return out;
    }
    const out = {};
    const keys = Object.keys(v);
    keys.slice(0, maxKeys).forEach(k => { out[redactText(k)] = redactClone(v[k], (depth || 0) + 1, seen); });
    if (keys.length > maxKeys) out.__truncated_keys__ = keys.length - maxKeys;
    return out;
  }
  function safeString(v, maxLen) {
    if (v == null) return v;
    const limit = Number(maxLen || (options && options.max_value_length) || 4096);
    const t = typeof v;
    if (t === 'string') {
      const s = redactText(v);
      return s.length > limit ? s.slice(0, limit) + '…[truncated]' : s;
    }
    if (t === 'number' || t === 'boolean' || t === 'undefined') return v;
    if (t === 'bigint') return String(v);
    return redactClone(v, 0);
  }
  function describeBody(v) {
    if (v == null) return null;
    if (typeof v === 'string') return { kind: 'string', length: v.length, sample: safeString(v, 512) };
    return safeString(v);
  }
  function describeAlgorithm(algorithm) {
    if (algorithm == null) return null;
    if (typeof algorithm === 'string') return algorithm;
    const out = {};
    ['name','hash','modulusLength','namedCurve','length','tagLength','publicExponent'].forEach(k => {
      if (algorithm[k] == null) return;
      out[k] = (k === 'publicExponent') ? safeString(algorithm[k]) : safeString(algorithm[k], 256);
    });
    if (algorithm.hash && typeof algorithm.hash === 'object') out.hash = algorithm.hash.name || safeString(algorithm.hash, 256);
    return out;
  }
  function describeKey(key) {
    if (!key) return null;
    return { type: key.type, extractable: key.extractable, algorithm: describeAlgorithm(key.algorithm), usages: Array.prototype.slice.call(key.usages || []) };
  }
  function stackForEvent() { try { return (new Error()).stack || ''; } catch (_) { return ''; } }
  function redactCookieValue(cookieString) {
    return String(cookieString || '').split(';').map(part => {
      const idx = part.indexOf('=');
      const name = (idx >= 0 ? part.slice(0, idx) : part).trim();
      return name ? name + '=<redacted>' : '';
    }).filter(Boolean).join('; ');
  }
  function cookieNames(cookieString) {
    return String(cookieString || '').split(';').map(part => (part.split('=')[0] || '').trim()).filter(Boolean);
  }
  function storageKeys(storage) {
    const keys = [];
    if (!storage) return keys;
    try { for (let i = 0; i < storage.length; i += 1) keys.push(String(storage.key(i))); } catch (_) {}
    return keys;
  }
  function elementRef(node) {
    if (!node) return null;
    return {
      nodeName: node.nodeName || '',
      id: node.id || '',
      className: typeof node.className === 'string' ? node.className : '',
      name: node.getAttribute ? (node.getAttribute('name') || '') : '',
      selector: node.id ? ('#' + node.id) : ''
    };
  }

  let state = 'CREATED';
  let session_id = null;
  let installed_at = null;
  let install_epoch = 0;
  let install_fingerprint = '';
  let owner_session_id = null;
  let cleanup_warnings = [];
  let residue_signatures = [];
  let paused = false;
  let seq = 0;
  let overflow = 0;
  let buffer = [];
  let buffer_start = 0;
  let buffer_count = 0;
  let buffer_size = DEFAULT_BUFFER_SIZE;
  let targets = Object.assign({}, DEFAULT_TARGETS);
  let options = {};
  let stats = Object.assign({}, DEFAULT_STATS);
  let observer = null;
  let mutationQueue = [];
  let mutationTimer = null;
  let origXHR = null, origFetch = null, origConsole = {};
  let origWebSocket = null;
  let origStorage = null;
  let origCookieDescriptor = null;
  let origCrypto = { subtle: {}, getRandomValues: null };
  let origDomSinks = {};
  let xpathTimer = null;
  let xpathPollMs = 0;
  let xpathIdleTicks = 0;
  let xpathCache = {};
  let xpathLargeResultTicks = {};
  let eventNotifyQueue = [];
  let eventNotifyTimer = null;
  let errorHandlers = [];
  let hookWrappers = { xhr: {}, fetch: null, websocket: null, console: {}, storage: {}, cookie: null, crypto: {}, domSinks: {} };
  let perfStats = {};
  function resetDiagnostics() { cleanup_warnings = []; residue_signatures = []; }
  function addCleanupWarning(msg) { if (msg) cleanup_warnings.push(String(msg)); }
  function addResidueSignature(sig) { if (!sig) return; const s = String(sig); if (residue_signatures.indexOf(s) < 0) residue_signatures.push(s); }
  function isGaWrapperSource(text) { return /__ga_browser_pro|GABrowserProDispatcher|__GA_BROWSER_PRO__|network\.request|websocket\.open|storage\.set|crypto\.getRandomValues|dom\.sink|cookies\.read|console\./i.test(String(text || '')); }
  function detectResidue() {
    residue_signatures = [];
    try {
      if (typeof window.fetch === 'function' && isGaWrapperSource(Function.prototype.toString.call(window.fetch))) addResidueSignature('fetch');
    } catch (_) {}
    try {
      if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype && typeof XMLHttpRequest.prototype.open === 'function') {
        const s1 = Function.prototype.toString.call(XMLHttpRequest.prototype.open);
        const s2 = Function.prototype.toString.call(XMLHttpRequest.prototype.send);
        if (isGaWrapperSource(s1)) addResidueSignature('xhr.open');
        if (isGaWrapperSource(s2)) addResidueSignature('xhr.send');
      }
    } catch (_) {}
    try {
      if (typeof window.WebSocket === 'function' && /WrappedWebSocket|websocket\.open|__GA_BROWSER_PRO__/i.test(Function.prototype.toString.call(window.WebSocket))) addResidueSignature('WebSocket');
    } catch (_) {}
    try {
      if (typeof Storage !== 'undefined' && Storage.prototype && typeof Storage.prototype.setItem === 'function') {
        const s = Function.prototype.toString.call(Storage.prototype.setItem);
        if (isGaWrapperSource(s)) addResidueSignature('storage.setItem');
      }
    } catch (_) {}
    try {
      ['log','warn','error','info','debug'].forEach(level => {
        try {
          if (typeof console[level] === 'function' && isGaWrapperSource(Function.prototype.toString.call(console[level]))) addResidueSignature('console.' + level);
        } catch (_) {}
      });
    } catch (_) {}
  }

  function perfBucket(name) {
    if (!perfStats[name]) perfStats[name] = { count: 0, total_ms: 0, last_ms: 0, max_ms: 0, samples: [] };
    return perfStats[name];
  }
  function recordPerf(name, t0) {
    const dt = Math.max(0, Date.now() - t0);
    const b = perfBucket(name);
    b.count += 1; b.total_ms += dt; b.last_ms = dt; b.max_ms = Math.max(b.max_ms, dt);
    b.samples.push(dt);
    const limit = numericOption('perf_sample_limit', DEFAULT_LIMITS.perf_sample_limit, 8, 4096);
    if (b.samples.length > limit) b.samples.splice(0, b.samples.length - limit);
    b.avg_ms = b.count ? b.total_ms / b.count : 0;
    return dt;
  }
  function perfSnapshot() {
    const out = {};
    Object.keys(perfStats).forEach(k => {
      const b = perfStats[k];
      const samples = b.samples.slice().sort((a, z) => a - z);
      const pct = p => samples.length ? samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))] : 0;
      out[k] = { count: b.count, last_ms: b.last_ms, max_ms: b.max_ms, avg_ms: b.avg_ms || 0, sample_count: b.samples.length, p50_ms: pct(0.50), p95_ms: pct(0.95) };
    });
    return out;
  }
  function bufferMetrics() {
    const used = buffer_count;
    const capacity = buffer_size || DEFAULT_BUFFER_SIZE;
    return { buffer_capacity: capacity, buffer_used: used, buffer_utilization: capacity ? used / capacity : 0, dropped_events: overflow };
  }
  function notifyOverflow(event) {
    try {
      window.postMessage({ __ga_browser_pro_overflow__: true, dropped_events: overflow, buffer_capacity: buffer_size, buffer_used: buffer_count, event_type: event && event.type, seq: event && event.seq }, '*');
    } catch (_) {}
  }
  function bufferSnapshot() {
    const out = [];
    for (let i = 0; i < buffer_count; i += 1) out.push(buffer[(buffer_start + i) % buffer_size]);
    return out;
  }
  function scheduleTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    try { if (t && typeof t.unref === 'function') t.unref(); } catch (_) {}
    return t;
  }
  function clearEventNotifyTimer() { if (eventNotifyTimer) { clearTimeout(eventNotifyTimer); eventNotifyTimer = null; } }
  function flushEventNotifications() {
    clearEventNotifyTimer();
    if (!eventNotifyQueue.length) return;
    const batch = eventNotifyQueue.splice(0, eventNotifyQueue.length);
    try {
      if (options && options.batch_post_message) window.postMessage({ __ga_browser_pro_event__: true, event_batch: batch, count: batch.length }, '*');
      else batch.forEach(event => window.postMessage({ __ga_browser_pro_event__: true, event }, '*'));
    } catch (_) {}
  }
  function notifyEvent(event) {
    if (!(options && options.batch_post_message)) { try { window.postMessage({ __ga_browser_pro_event__: true, event }, '*'); } catch (_) {} return; }
    eventNotifyQueue.push(event);
    const maxEvents = numericOption('batch_max_events', 50, 1, 10000);
    const flushMs = numericOption('batch_flush_ms', 25, 0, 60000);
    if (eventNotifyQueue.length >= maxEvents || flushMs === 0) flushEventNotifications();
    else if (!eventNotifyTimer) eventNotifyTimer = scheduleTimer(flushEventNotifications, flushMs);
  }
  function storeEvent(event) {
    if (buffer_count < buffer_size) { buffer[(buffer_start + buffer_count) % buffer_size] = event; buffer_count += 1; return false; }
    buffer[buffer_start] = event;
    buffer_start = (buffer_start + 1) % buffer_size;
    overflow += 1; stats.overflow = overflow;
    notifyOverflow(event);
    return true;
  }
  function push(type, data) {
    const t0 = Date.now();
    if (paused && type !== 'browser_pro.lifecycle') return null;
    seq += 1;
    const event = { seq, type, timestamp: now(), data: safeString(data) };
    storeEvent(event);
    if (type.indexOf('network.') === 0) stats.network_events += 1;
    else if (type.indexOf('dom.sink') === 0) stats.sink_events += 1;
    else if (type.indexOf('dom.') === 0) stats.dom_events += 1;
    else if (type.indexOf('console.') === 0) stats.console_events += 1;
    else if (type.indexOf('error.') === 0) stats.error_events += 1;
    else if (type.indexOf('storage.') === 0) stats.storage_events += 1;
    else if (type.indexOf('websocket.') === 0) stats.websocket_events += 1;
    else if (type.indexOf('crypto.') === 0) stats.crypto_events += 1;
    else if (type.indexOf('cookies.') === 0) stats.cookie_events += 1;
    notifyEvent(event);
    recordPerf('push', t0);
    return event;
  }
  function setState(next, reason) { const prev = state; state = next; push('browser_pro.lifecycle', { from: prev, to: next, reason: reason || 'command' }); }
  function validateTargets(nextTargets) {
    if (!nextTargets) return null;
    const allowed = new Set(['network','dom','console','error','xpath','cookies','storage','websocket','crypto','dom_sinks','rules']);
    for (const k of Object.keys(nextTargets)) if (!allowed.has(k)) return k;
    return null;
  }
  function serializeError(err) { return err ? { name: err.name || 'Error', message: err.message || String(err), stack: err.stack || '' } : null; }

  function hookXHR() {
    if (!targets.network || origXHR || typeof XMLHttpRequest === 'undefined') return;
    origXHR = { open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send };
    hookWrappers.xhr.open = function(method, url) {
      this.__ga_browser_pro_meta = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), t0: Date.now() };
      return origXHR.open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = hookWrappers.xhr.open;
    hookWrappers.xhr.send = function(body) {
      const meta = this.__ga_browser_pro_meta || { method: 'GET', url: '', t0: Date.now() };
      push('network.request', { transport: 'xhr', method: meta.method, url: meta.url, body: describeBody(body), stack: stackForEvent() });
      this.addEventListener('load', () => push('network.response', {
        transport: 'xhr', method: meta.method, url: meta.url, status: this.status, duration_ms: Date.now() - meta.t0,
        response_type: this.responseType || '', response_url: this.responseURL || meta.url
      }));
      this.addEventListener('error', () => push('network.error', { transport: 'xhr', url: meta.url, error: 'XHR failed' }));
      return origXHR.send.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = hookWrappers.xhr.send;
  }
  function hookFetch() {
    if (!targets.network || origFetch || typeof window.fetch !== 'function') return;
    origFetch = window.fetch;
    hookWrappers.fetch = function(input, init) {
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const url = String((typeof input === 'string') ? input : ((input && input.url) || ''));
      const t0 = Date.now();
      push('network.request', { transport: 'fetch', method, url, body: init && init.body != null ? describeBody(init.body) : null, stack: stackForEvent() });
      return origFetch.apply(this, arguments).then(resp => {
        push('network.response', { transport: 'fetch', method, url, status: resp.status, ok: resp.ok, type: resp.type, duration_ms: Date.now() - t0 });
        return resp;
      }).catch(err => { push('network.error', { transport: 'fetch', url, error: err.message || String(err) }); throw err; });
    };
    window.fetch = hookWrappers.fetch;
  }
  function hookWebSocket() {
    if (!targets.websocket || origWebSocket || typeof window.WebSocket !== 'function') return;
    origWebSocket = window.WebSocket;
    const NativeWebSocket = origWebSocket;
    function WrappedWebSocket(url, protocols) {
      const ws = arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      const wsid = 'ws-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      push('websocket.open', { id: wsid, url: String(url || ''), protocols: protocols == null ? null : safeString(protocols), stack: stackForEvent() });
      ws.addEventListener('open', () => push('websocket.ready', { id: wsid, url: String(url || '') }));
      ws.addEventListener('message', e => push('websocket.message', { id: wsid, url: String(url || ''), data: describeBody(e.data) }));
      ws.addEventListener('close', e => push('websocket.close', { id: wsid, url: String(url || ''), code: e.code, reason: e.reason, wasClean: e.wasClean }));
      ws.addEventListener('error', () => push('websocket.error', { id: wsid, url: String(url || '') }));
      const nativeSend = ws.send;
      ws.send = function(data) {
        push('websocket.send', { id: wsid, url: String(url || ''), data: describeBody(data), stack: stackForEvent() });
        return nativeSend.apply(ws, arguments);
      };
      return ws;
    }
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => { try { Object.defineProperty(WrappedWebSocket, k, { value: NativeWebSocket[k], enumerable: true }); } catch (_) {} });
    hookWrappers.websocket = WrappedWebSocket;
    window.WebSocket = WrappedWebSocket;
  }
  function hookConsole() {
    if ((!targets.console && !targets.error) || Object.keys(origConsole).length) return;
    ['log','warn','error','info','debug'].forEach(level => {
      if (typeof console[level] !== 'function') return;
      origConsole[level] = console[level];
      hookWrappers.console[level] = function() {
        push('console.' + level, { args: Array.from(arguments).map(x => safeString(x, 1024)), stack: stackForEvent() });
        return origConsole[level].apply(console, arguments);
      };
      console[level] = hookWrappers.console[level];
    });
  }
  function browserProErrors() {
    if (!targets.error || errorHandlers.length) return;
    const onError = e => push('error.uncaught', { message: e.message, source: e.filename, lineno: e.lineno, colno: e.colno, error: serializeError(e.error) });
    const onRejection = e => push('error.promise', { reason: safeString(e.reason), stack: e.reason && e.reason.stack });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    errorHandlers = [['error', onError], ['unhandledrejection', onRejection]];
  }
  function flushMutations() {
    const t0 = Date.now();
    if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
    if (!mutationQueue.length) return;
    const maxFlush = numericOption('mutation_flush_sample_limit', DEFAULT_LIMITS.mutation_flush_sample_limit, 1, 1000);
    const batch = mutationQueue.splice(0, Math.min(mutationQueue.length, maxFlush));
    const remaining = mutationQueue.length;
    const maxSamples = numericOption('mutation_sample_limit', 20, 0, 200);
    const summary = { count: batch.length + remaining, childList: 0, attributes: 0, characterData: 0, added_count: 0, removed_count: 0, samples: [], overflow: remaining > 0, truncated_count: remaining };
    batch.forEach(m => {
      if (m.type === 'childList') summary.childList += 1;
      else if (m.type === 'attributes') summary.attributes += 1;
      else if (m.type === 'characterData') summary.characterData += 1;
      summary.added_count += m.added_count || 0;
      summary.removed_count += m.removed_count || 0;
      if (summary.samples.length < maxSamples) summary.samples.push(m);
    });
    if (remaining > 0) push('dom.mutation.overflow', { queued_count: remaining, emitted_count: batch.length, hard_limit: numericOption('mutation_queue_hard_limit', DEFAULT_LIMITS.mutation_queue_hard_limit, 1, 100000) });
    push('dom.mutation', summary);
    recordPerf('mutationFlush', t0);
    if (mutationQueue.length && !mutationTimer) mutationTimer = scheduleTimer(flushMutations, numericOption('mutation_batch_ms', 100, 0, 5000));
  }
  function hookDOM() {
    if (!targets.dom || observer) return;
    const root = document.body || document.documentElement;
    if (!root || typeof MutationObserver === 'undefined') return;
    const batchMax = numericOption('mutation_batch_max', 200, 1, 5000);
    const batchMs = numericOption('mutation_batch_ms', 100, 0, 5000);
    observer = new MutationObserver(muts => {
      const hardLimit = numericOption('mutation_queue_hard_limit', DEFAULT_LIMITS.mutation_queue_hard_limit, 1, 100000);
      muts.forEach(m => {
        if (mutationQueue.length >= hardLimit) return;
        mutationQueue.push({
          type: m.type, target: elementRef(m.target),
          attribute_name: m.attributeName || '', added_count: m.addedNodes ? m.addedNodes.length : 0, removed_count: m.removedNodes ? m.removedNodes.length : 0
        });
      });
      if (muts.length && mutationQueue.length >= hardLimit) push('dom.mutation.queue_overflow', { incoming_count: muts.length, queued_count: mutationQueue.length, hard_limit: hardLimit });
      if (mutationQueue.length >= batchMax) flushMutations();
      else if (!mutationTimer) mutationTimer = scheduleTimer(flushMutations, batchMs);
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  function hookDomSinks() {
    if (!targets.dom_sinks || Object.keys(origDomSinks).length) return;
    function wrapDescriptor(proto, prop, label) {
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.set !== 'function') return;
      origDomSinks[label] = { proto, prop, desc };
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get ? function() { return desc.get.call(this); } : undefined,
        set: function(value) {
          push('dom.sink.write', { sink: label, target: elementRef(this), value: safeString(String(value), 1024), stack: stackForEvent() });
          return desc.set.call(this, value);
        }
      });
    }
    wrapDescriptor(Element.prototype, 'innerHTML', 'Element.innerHTML');
    wrapDescriptor(Element.prototype, 'outerHTML', 'Element.outerHTML');
    wrapDescriptor(HTMLScriptElement && HTMLScriptElement.prototype, 'text', 'HTMLScriptElement.text');
    const nativeInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    if (typeof nativeInsertAdjacentHTML === 'function') {
      origDomSinks.insertAdjacentHTML = nativeInsertAdjacentHTML;
      Element.prototype.insertAdjacentHTML = function(position, text) {
        push('dom.sink.call', { sink: 'Element.insertAdjacentHTML', target: elementRef(this), position: String(position || ''), value: safeString(String(text), 1024), stack: stackForEvent() });
        return nativeInsertAdjacentHTML.apply(this, arguments);
      };
    }
    const nativeWrite = document.write;
    if (typeof nativeWrite === 'function') {
      origDomSinks.documentWrite = nativeWrite;
      document.write = function() {
        push('dom.sink.call', { sink: 'document.write', value: Array.from(arguments).map(x => safeString(String(x), 1024)), stack: stackForEvent() });
        return nativeWrite.apply(document, arguments);
      };
    }
  }
  function hookCookies() {
    if (!targets.cookies || origCookieDescriptor) return;
    let proto = Document.prototype;
    let desc = Object.getOwnPropertyDescriptor(proto, 'cookie');
    if (!desc) { proto = HTMLDocument && HTMLDocument.prototype; desc = proto && Object.getOwnPropertyDescriptor(proto, 'cookie'); }
    if (!desc || typeof desc.get !== 'function') return;
    origCookieDescriptor = { proto, desc };
    Object.defineProperty(proto, 'cookie', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function() {
        const value = desc.get.call(this);
        push('cookies.read', { names: cookieNames(value), count: cookieNames(value).length, value: redactCookieValue(value), stack: stackForEvent() });
        return value;
      },
      set: function(value) {
        const text = String(value || '');
        push('cookies.write', { name: (text.split('=')[0] || '').trim(), value: redactCookieValue(text), stack: stackForEvent() });
        return desc.set.call(this, value);
      }
    });
    try {
      const snapshot = desc.get.call(document);
      push('cookies.snapshot', { names: cookieNames(snapshot), count: cookieNames(snapshot).length, value: redactCookieValue(snapshot) });
    } catch (_) {}
  }
  function hookStorage() {
    if (!targets.storage || origStorage || typeof Storage === 'undefined') return;
    const proto = Storage.prototype;
    origStorage = {
      setItem: proto.setItem, getItem: proto.getItem, removeItem: proto.removeItem, clear: proto.clear, key: proto.key
    };
    function storageKind(self) {
      try { if (self === window.localStorage) return 'localStorage'; } catch (_) {}
      try { if (self === window.sessionStorage) return 'sessionStorage'; } catch (_) {}
      return 'Storage';
    }
    hookWrappers.storage.setItem = function(key, value) {
      push('storage.set', { storage: storageKind(this), key: String(key), value: safeString(String(value), 1024), stack: stackForEvent() });
      return origStorage.setItem.apply(this, arguments);
    };
    proto.setItem = hookWrappers.storage.setItem;
    hookWrappers.storage.getItem = function(key) {
      const value = origStorage.getItem.apply(this, arguments);
      push('storage.get', { storage: storageKind(this), key: String(key), hit: value != null, stack: stackForEvent() });
      return value;
    };
    proto.getItem = hookWrappers.storage.getItem;
    hookWrappers.storage.removeItem = function(key) {
      push('storage.remove', { storage: storageKind(this), key: String(key), stack: stackForEvent() });
      return origStorage.removeItem.apply(this, arguments);
    };
    proto.removeItem = hookWrappers.storage.removeItem;
    hookWrappers.storage.clear = function() {
      push('storage.clear', { storage: storageKind(this), keys_before: storageKeys(this), stack: stackForEvent() });
      return origStorage.clear.apply(this, arguments);
    };
    proto.clear = hookWrappers.storage.clear;
    try { push('storage.snapshot', { storage: 'localStorage', keys: storageKeys(window.localStorage) }); } catch (_) {}
    try { push('storage.snapshot', { storage: 'sessionStorage', keys: storageKeys(window.sessionStorage) }); } catch (_) {}
  }
  function hookCrypto() {
    if (!targets.crypto || !window.crypto) return;
    if (!origCrypto.getRandomValues && typeof window.crypto.getRandomValues === 'function') {
      origCrypto.getRandomValues = window.crypto.getRandomValues.bind(window.crypto);
      try {
        window.crypto.getRandomValues = function(array) {
          push('crypto.getRandomValues', { array: safeString(array), stack: stackForEvent() });
          return origCrypto.getRandomValues(array);
        };
      } catch (_) {}
    }
    const subtle = window.crypto.subtle;
    if (!subtle) return;
    ['encrypt','decrypt','digest','sign','verify','deriveBits','deriveKey','importKey','exportKey','wrapKey','unwrapKey','generateKey'].forEach(name => {
      if (origCrypto.subtle[name] || typeof subtle[name] !== 'function') return;
      origCrypto.subtle[name] = subtle[name].bind(subtle);
      try {
        subtle[name] = function() {
          const args = Array.from(arguments);
          push('crypto.subtle.' + name, {
            algorithm: describeAlgorithm(args[0]),
            key: describeKey(args[1]),
            format: typeof args[0] === 'string' && ['raw','pkcs8','spki','jwk'].indexOf(args[0]) >= 0 ? args[0] : undefined,
            data: args.length ? safeString(args[args.length - 1]) : null,
            stack: stackForEvent()
          });
          return origCrypto.subtle[name].apply(subtle, arguments);
        };
      } catch (_) {}
    });
  }
  function checkXPaths() {
    const t0 = Date.now();
    let changed = false;
    const all = targets.xpath || [];
    const maxPerTick = numericOption('xpath_max_per_tick', DEFAULT_LIMITS.xpath_max_per_tick, 1, 1000);
    const largeThreshold = numericOption('xpath_large_result_threshold', DEFAULT_LIMITS.xpath_large_result_threshold, 1, 1000000);
    const repeatTicks = numericOption('xpath_large_result_repeat_ticks', DEFAULT_LIMITS.xpath_large_result_repeat_ticks, 1, 10000);
    all.slice(0, maxPerTick).forEach(xpath => {
      try {
        const r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const prev = xpathCache[xpath];
        const large = r.snapshotLength >= largeThreshold;
        xpathCache[xpath] = r.snapshotLength;
        xpathLargeResultTicks[xpath] = (xpathLargeResultTicks[xpath] || 0) + 1;
        if (prev !== r.snapshotLength || (!large) || xpathLargeResultTicks[xpath] >= repeatTicks) {
          changed = changed || prev !== r.snapshotLength;
          xpathLargeResultTicks[xpath] = 0;
          push('dom.xpath', { xpath, matched_nodes: r.snapshotLength, large_result: large, suppressed_repeats: large ? repeatTicks : 0 });
        }
      } catch (e) {
        const err = e.message || String(e);
        if (xpathCache[xpath] !== err) { changed = true; xpathCache[xpath] = err; push('dom.xpath', { xpath, error: err }); }
      }
    });
    if (all.length > maxPerTick) push('dom.xpath.truncated', { configured: all.length, checked: maxPerTick });
    recordPerf('xpathCheck', t0);
    if (!xpathTimer || !targets.xpath || !targets.xpath.length) return;
    xpathIdleTicks = changed ? 0 : xpathIdleTicks + 1;
    const idleAfter = numericOption('xpath_idle_after_ticks', 6, 1, 1000);
    const maxMs = numericOption('xpath_poll_max_ms', 30000, xpathPollMs || 1, 300000);
    const nextMs = Math.min(maxMs, Math.max(1, xpathPollMs || 5000) * (xpathIdleTicks >= idleAfter ? 4 : 1));
    xpathTimer = scheduleTimer(checkXPaths, nextMs);
  }

  function install(opts) {
    opts = opts || {};
    if (opts.expected_version && String(opts.expected_version) !== VERSION) {
      return structuredError(ERROR_CODES.INJECTION_FAILED, 'Browser Pro dispatcher version mismatch', { expected_version: String(opts.expected_version), dispatcher_version: VERSION });
    }
    const badTarget = validateTargets(opts.targets);
    if (badTarget) return structuredError(ERROR_CODES.UNSUPPORTED_TARGET, 'Unsupported Browser Pro target: ' + badTarget, { target: badTarget });
    const requestedSessionId = opts.session_id || ('ga-browser-pro-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    const requestedTargets = Object.assign({}, DEFAULT_TARGETS, opts.targets || {});
    const requestedOptions = Object.assign({}, opts.options || {});
    const requestedBufferSize = Math.max(1, Number(opts.buffer_size || requestedOptions.buffer_size || DEFAULT_BUFFER_SIZE));
    const requestedFingerprint = buildInstallFingerprint(requestedSessionId, requestedTargets, requestedOptions, requestedBufferSize, opts.install_fingerprint);
    const sameSession = session_id === requestedSessionId;
    const sameFingerprint = install_fingerprint === requestedFingerprint;
    if (state !== 'CREATED' && state !== 'CLOSED') {
      if (!opts.force && sameSession && sameFingerprint) {
        return { ok: true, data: {
          session_id, state, installed_at, targets: clone(targets), browser_pro_version: VERSION,
          dispatcher_version: VERSION, install_epoch, owner_session_id, install_fingerprint,
          already_installed: true, idempotent: true, same_session: true, same_fingerprint: true,
          page_compatible: true, cleanup_warnings: cleanup_warnings.slice(), residue_signatures: residue_signatures.slice()
        } };
      }
      if (!opts.force) {
        return structuredError(ERROR_CODES.ALREADY_INSTALLED, 'Browser Pro dispatcher is already installed with a different session or fingerprint', {
          state, session_id, owner_session_id, install_fingerprint, dispatcher_version: VERSION,
          requested_session_id: requestedSessionId, requested_fingerprint: requestedFingerprint,
          same_session: sameSession, same_fingerprint: sameFingerprint
        });
      }
      uninstall({ force: true, reason: 'force_reinstall' });
    }
    resetDiagnostics();
    session_id = requestedSessionId;
    owner_session_id = requestedSessionId;
    install_fingerprint = requestedFingerprint;
    targets = requestedTargets;
    options = requestedOptions;
    buffer_size = requestedBufferSize;
    buffer = new Array(buffer_size); buffer_start = 0; buffer_count = 0; seq = 0; overflow = 0; stats = Object.assign({}, DEFAULT_STATS);
    mutationQueue = []; if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
    eventNotifyQueue = []; clearEventNotifyTimer();
    xpathPollMs = Number(options.xpath_poll_ms || 5000); xpathIdleTicks = 0; xpathCache = {}; xpathLargeResultTicks = {}; perfStats = {};
    install_epoch = Date.now();
    setState('PREPARED', 'install');
    hookXHR(); hookFetch(); hookWebSocket(); hookConsole(); browserProErrors(); hookDOM(); hookDomSinks(); hookCookies(); hookStorage(); hookCrypto();
    if (targets.xpath && targets.xpath.length) xpathTimer = scheduleTimer(checkXPaths, Math.max(1, xpathPollMs || 5000));
    installed_at = now(); setState('INSTALLED', 'install');
    return { ok: true, data: {
      session_id, state, installed_at, targets: clone(targets), browser_pro_version: VERSION, dispatcher_version: VERSION,
      install_epoch, owner_session_id, install_fingerprint, already_installed: false, idempotent: false,
      same_session: false, same_fingerprint: false, page_compatible: true,
      cleanup_warnings: cleanup_warnings.slice(), residue_signatures: residue_signatures.slice()
    } };
  }
  function requireSession(op) { return session_id ? null : structuredError(ERROR_CODES.NO_SESSION, op + ' requires an installed Browser Pro session', { state }); }
  function collect(opts) {
    const t0 = Date.now();
    const miss = requireSession('browser_pro.collect'); if (miss) return miss;
    opts = opts || {};
    if (state === 'INSTALLED') setState('ACTIVE', 'collect');
    setState('COLLECTING', 'collect');
    const since = Number(opts.since_seq || 0);
    const limit = Math.max(0, Number(opts.limit || 100));
    flushMutations();
    flushEventNotifications();
    let events = bufferSnapshot().filter(e => e && e.seq > since);
    if (opts.event_types && opts.event_types.length) events = events.filter(e => opts.event_types.some(t => e.type.indexOf(t) === 0));
    const page = events.slice(0, limit);
    setState('ACTIVE', 'collect_done');
    recordPerf('collect', t0);
    return { ok: true, data: Object.assign({ session_id, events: page, next_seq: page.length ? page[page.length - 1].seq : since, total_available: events.length, overflow }, bufferMetrics()) };
  }
  function status() {
    return { ok: true, data: {
      session_id, state, installed_at, uptime_ms: installed_at ? Date.now() - Date.parse(installed_at) : 0,
      stats: Object.assign({}, stats, { buffer_count, buffer_size, buffer_usage: buffer_count / buffer_size }, bufferMetrics()),
      buffer_capacity: bufferMetrics().buffer_capacity, buffer_used: bufferMetrics().buffer_used, buffer_utilization: bufferMetrics().buffer_utilization, dropped_events: overflow, perf: perfSnapshot(),
      targets: clone(targets), options: clone(options), browser_pro_version: VERSION, dispatcher_version: VERSION,
      install_epoch, owner_session_id, install_fingerprint,
      installed_marker: !!(session_id && state !== 'CLOSED' && state !== 'CREATED'),
      cleanup_warnings: cleanup_warnings.slice(), residue_signatures: residue_signatures.slice()
    } };
  }
  function pause() { const miss = requireSession('browser_pro.pause'); if (miss) return miss; paused = true; setState('PAUSED', 'pause'); return { ok: true, data: { session_id, state } }; }
  function resume() { const miss = requireSession('browser_pro.resume'); if (miss) return miss; paused = false; setState('ACTIVE', 'resume'); return { ok: true, data: { session_id, state } }; }
  function evaluate(opts) {
    const expr = typeof opts === 'string' ? opts : opts && opts.expression;
    if (!expr) return structuredError(ERROR_CODES.INVALID_RULE, 'browser_pro.evaluate requires expression', {});
    try {
      const result = (0, eval)(expr);
      const type = result === null ? 'null' : typeof result;
      return { ok: true, data: { result: opts && opts.return_by_value === false ? type : clone(result), type } };
    } catch (e) { return structuredError(ERROR_CODES.INTERNAL_ERROR, e.message || String(e), serializeError(e)); }
  }
  function clearBuffer() {
    const miss = requireSession('browser_pro.clear_buffer'); if (miss) return miss;
    buffer = new Array(buffer_size); buffer_start = 0; buffer_count = 0; seq = 0; overflow = 0; stats.overflow = 0; perfStats = {};
    return { ok: true, data: { session_id, cleared: true } };
  }
  function uninstall(opts) {
    opts = opts || {};
    cleanup_warnings = [];
    if (origXHR) {
      if (XMLHttpRequest.prototype.open === hookWrappers.xhr.open) XMLHttpRequest.prototype.open = origXHR.open;
      else addCleanupWarning('xhr.open wrapper identity changed before uninstall');
      if (XMLHttpRequest.prototype.send === hookWrappers.xhr.send) XMLHttpRequest.prototype.send = origXHR.send;
      else addCleanupWarning('xhr.send wrapper identity changed before uninstall');
      origXHR = null; hookWrappers.xhr = {};
    }
    if (origFetch) { if (window.fetch === hookWrappers.fetch) window.fetch = origFetch; else addCleanupWarning('fetch wrapper identity changed before uninstall'); origFetch = null; hookWrappers.fetch = null; }
    if (origWebSocket) { if (window.WebSocket === hookWrappers.websocket) window.WebSocket = origWebSocket; else addCleanupWarning('WebSocket wrapper identity changed before uninstall'); origWebSocket = null; hookWrappers.websocket = null; }
    Object.keys(origConsole).forEach(k => { if (console[k] === hookWrappers.console[k]) console[k] = origConsole[k]; else addCleanupWarning('console.' + k + ' wrapper identity changed before uninstall'); }); origConsole = {}; hookWrappers.console = {};
    if (origStorage && typeof Storage !== 'undefined') {
      if (Storage.prototype.setItem === hookWrappers.storage.setItem) Storage.prototype.setItem = origStorage.setItem;
      else addCleanupWarning('storage.setItem wrapper identity changed before uninstall');
      if (Storage.prototype.getItem === hookWrappers.storage.getItem) Storage.prototype.getItem = origStorage.getItem;
      else addCleanupWarning('storage.getItem wrapper identity changed before uninstall');
      if (Storage.prototype.removeItem === hookWrappers.storage.removeItem) Storage.prototype.removeItem = origStorage.removeItem;
      else addCleanupWarning('storage.removeItem wrapper identity changed before uninstall');
      if (Storage.prototype.clear === hookWrappers.storage.clear) Storage.prototype.clear = origStorage.clear;
      else addCleanupWarning('storage.clear wrapper identity changed before uninstall');
      Storage.prototype.key = origStorage.key; origStorage = null; hookWrappers.storage = {};
    }
    if (origCookieDescriptor) { Object.defineProperty(origCookieDescriptor.proto, 'cookie', origCookieDescriptor.desc); origCookieDescriptor = null; }
    Object.keys(origCrypto.subtle).forEach(k => { try { if (window.crypto && window.crypto.subtle) window.crypto.subtle[k] = origCrypto.subtle[k]; } catch (_) {} });
    origCrypto.subtle = {};
    if (origCrypto.getRandomValues) { try { window.crypto.getRandomValues = origCrypto.getRandomValues; } catch (_) {} origCrypto.getRandomValues = null; }
    Object.keys(origDomSinks).forEach(k => {
      const item = origDomSinks[k];
      if (item && item.proto && item.prop && item.desc) Object.defineProperty(item.proto, item.prop, item.desc);
    });
    if (origDomSinks.insertAdjacentHTML) Element.prototype.insertAdjacentHTML = origDomSinks.insertAdjacentHTML;
    if (origDomSinks.documentWrite) document.write = origDomSinks.documentWrite;
    origDomSinks = {};
    errorHandlers.forEach(item => window.removeEventListener(item[0], item[1])); errorHandlers = [];
    if (observer) { observer.disconnect(); observer = null; }
    if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
    mutationQueue = [];
    if (xpathTimer) { clearTimeout(xpathTimer); xpathTimer = null; }
    xpathCache = {}; xpathLargeResultTicks = {}; xpathIdleTicks = 0;
    flushEventNotifications(); clearEventNotifyTimer(); eventNotifyQueue = [];
    detectResidue();
    if (residue_signatures.length) addCleanupWarning('GA wrapper residue detected after uninstall: ' + residue_signatures.join(','));
    const old = session_id;
    const oldOwner = owner_session_id;
    const oldFingerprint = install_fingerprint;
    const oldEpoch = install_epoch;
    setState('CLOSED', opts.reason || 'uninstall');
    session_id = null; owner_session_id = null; install_fingerprint = ''; install_epoch = 0; paused = false;
    return { ok: true, data: {
      session_id: old, state, events_collected: seq, overflow, dispatcher_version: VERSION,
      owner_session_id: oldOwner, install_fingerprint: oldFingerprint, install_epoch: oldEpoch,
      installed_marker: false, cleanup_warnings: cleanup_warnings.slice(), residue_signatures: residue_signatures.slice()
    } };
  }
  function dispatch(cmd, args) {
    cmd = canonicalCommand(cmd);
    switch (cmd) {
      case 'browser_pro.install': return install(args);
      case 'browser_pro.collect': return collect(args);
      case 'browser_pro.status': return status();
      case 'browser_pro.uninstall': return uninstall(args);
      case 'browser_pro.clear_buffer': return clearBuffer();
      case 'browser_pro.pause': return pause();
      case 'browser_pro.resume': return resume();
      case 'browser_pro.evaluate': return evaluate(args);
      default: return structuredError(ERROR_CODES.INVALID_RULE, 'Unknown Browser Pro command: ' + cmd, { cmd });
    }
  }

  window.addEventListener('message', e => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || !msg.__ga_browser_pro_cmd__) return;
    const id = msg.id;
    const resp = dispatch(msg.cmd, msg.args || {});
    window.postMessage({ __ga_browser_pro_response__: true, id, resp }, '*');
  });
  window.__GA_BROWSER_PRO__ = {
    version: VERSION, dispatcher_version: VERSION, ERROR_CODES, COMMAND_CANONICAL, install, collect, status, uninstall, clearBuffer, pause, resume, evaluate, dispatch,
    getState: () => state, getSessionId: () => session_id, getBuffer: () => bufferSnapshot(), getStats: () => Object.assign({}, stats),
    getInstallFingerprint: () => install_fingerprint, getOwnerSessionId: () => owner_session_id, getInstallEpoch: () => install_epoch,
    getCleanupWarnings: () => cleanup_warnings.slice(), getResidueSignatures: () => residue_signatures.slice(),
    getBufferStats: () => Object.assign({ count: buffer_count, size: buffer_size, usage: buffer_count / buffer_size, overflow }, bufferMetrics()), getPerfStats: () => perfSnapshot()
  };
  setState('CREATED', 'bootstrap');
})();
