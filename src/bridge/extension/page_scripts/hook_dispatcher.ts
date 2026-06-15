type BrowserPilotHookPageCallable = (...args: unknown[]) => unknown;
type BrowserPilotHookPageApi = Record<string, unknown> & { version?: string; dispatch?: BrowserPilotHookPageCallable; uninstall?: BrowserPilotHookPageCallable };
declare global {
  interface Window { __BROWSER_PILOT_HOOKS__?: BrowserPilotHookPageApi; }
}

/* ============================================================
 * hook_dispatcher.js — Browser Pilot page-side hook dispatcher.
 * ============================================================ */
;(function BrowserPilotHookDispatcher() {
  'use strict';

  type HookRecord = Record<string, unknown>;
  type HookResponse = { ok: boolean; data?: HookRecord; error_code?: string; error?: unknown; details?: HookRecord };
  type HookEvent = { seq: number; type: string; timestamp: string; data: unknown };
  type HookCallable = (...args: unknown[]) => unknown;
  type HookFunctionRecord = Record<string, HookCallable>;
  type HookTargets = HookRecord & {
    network: boolean; dom: boolean; console: boolean; error: boolean; xpath: string[]; cookies: boolean; storage: boolean;
    websocket: boolean; crypto: boolean; dom_sinks: boolean;
  };
  type HookOptions = HookRecord & { redact_patterns?: unknown[]; batch_post_message?: unknown; max_value_length?: unknown; buffer_size?: unknown; xpath_poll_ms?: unknown };
  type HookStats = HookRecord & Record<
    'network_events' | 'dom_events' | 'console_events' | 'error_events' | 'storage_events' | 'websocket_events' | 'crypto_events' | 'cookie_events' | 'sink_events' | 'overflow',
    number
  >;
  type PerfBucket = { count: number; total_ms: number; last_ms: number; max_ms: number; samples: number[]; avg_ms?: number };
  type XhrOriginal = { open: typeof XMLHttpRequest.prototype.open; send: typeof XMLHttpRequest.prototype.send };
  type StorageOriginal = { setItem: typeof Storage.prototype.setItem; getItem: typeof Storage.prototype.getItem; removeItem: typeof Storage.prototype.removeItem; clear: typeof Storage.prototype.clear; key: typeof Storage.prototype.key };
  type CookieDescriptor = { proto: Document; desc: PropertyDescriptor };
  type DomSinkDescriptor = { proto: Element | Document; prop: string; desc: PropertyDescriptor };
  type RedactMatcher = { pattern: string; mode: 'regex' | 'literal'; regex: RegExp };
  type HookApi = HookRecord & { version?: string; dispatch?: HookCallable; uninstall?: HookCallable };
  type XhrMeta = { method: string; url: string; t0: number };
  type XhrWithMeta = XMLHttpRequest & { __browser_pilot_meta?: XhrMeta };
  type MutationSample = HookRecord & { type?: string; added_count?: number; removed_count?: number };

  function asRecord(value: unknown): HookRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as HookRecord : {}; }
  function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  function errorName(error: unknown): string { return error instanceof Error ? error.name : 'Error'; }

  const VERSION = 'browser-pilot-hook.0.3.2';
  const existingBrowserPilot = window.__BROWSER_PILOT_HOOKS__ as HookApi | undefined;
  if (existingBrowserPilot && existingBrowserPilot.dispatch) {
    if (existingBrowserPilot.version === VERSION) return;
    try {
      if (typeof existingBrowserPilot.uninstall === 'function') {
        existingBrowserPilot.uninstall({ force: true, reason: 'dispatcher_upgrade', next_version: VERSION });
      }
    } catch (_error) {
      /* best-effort dispatcher upgrade uninstall */
    }
  }
  const DEFAULT_BUFFER_SIZE = 1000;
  const ERROR_CODES = {
    NO_SESSION: 'NO_SESSION', ALREADY_INSTALLED: 'ALREADY_INSTALLED', NOT_INSTALLED: 'NOT_INSTALLED',
    SESSION_NOT_FOUND: 'SESSION_NOT_FOUND', INVALID_SESSION: 'INVALID_SESSION',
    INVALID_RULE: 'INVALID_RULE', UNSUPPORTED_TARGET: 'UNSUPPORTED_TARGET', INJECTION_FAILED: 'INJECTION_FAILED',
    SAFETY_BLOCKED: 'SAFETY_BLOCKED', TIMEOUT: 'TIMEOUT', BUFFER_OVERFLOW: 'BUFFER_OVERFLOW', INTERNAL_ERROR: 'INTERNAL_ERROR'
  };
  const COMMAND_CANONICAL = {
    'hook.status': 'hook.status'
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
  const DEFAULT_REDACT_PATTERNS = [
    'fixture-secret',
    'fixture-password',
    'bearer\\s+fixture-secret',
    'authorization:\\s*bearer\\s+[^\\s,;\\x29]+'
  ];
  const BROWSER_PILOT_HOOK_MAX_REDACT_PATTERNS = 32;
  const BROWSER_PILOT_HOOK_REDACT_MAX_PATTERN_CHARS = 512;
  const BROWSER_PILOT_HOOK_REDACT_MAX_TEXT_CHARS = 65536;

  function canonicalCommand(cmd: unknown): string { const key = String(cmd || ''); return COMMAND_CANONICAL[key as keyof typeof COMMAND_CANONICAL] || key; }
  function structuredError(error_code: string, message: unknown, details?: unknown): HookResponse { return { ok: false, error_code, error: message, details: asRecord(details || {}) }; }
  function now(): string { return new Date().toISOString(); }
  function stableStringify(value: unknown): string {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const record = asRecord(value);
    return '{' + Object.keys(record).sort().map(k => JSON.stringify(k) + ':' + stableStringify(record[k])).join(',') + '}';
  }
  function buildInstallFingerprint(sessionId: unknown, nextTargets: unknown, nextOptions: unknown, nextBufferSize: unknown, explicit: unknown): string {
    if (explicit != null && explicit !== '') return String(explicit);
    return stableStringify({
      session_id: sessionId || null,
      targets: nextTargets || {},
      options: nextOptions || {},
      buffer_size: nextBufferSize || DEFAULT_BUFFER_SIZE
    });
  }
  function numericOption(name: string, fallback: number, min?: number | null, max?: number | null): number {
    const raw = options && options[name] != null ? Number(options[name]) : fallback;
    let n = Number.isFinite(raw) ? raw : fallback;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
  }
  function isSafeHookRedactRegexPattern(pattern: unknown): boolean {
    const text = String(pattern || '');
    if (!text || text.length > BROWSER_PILOT_HOOK_REDACT_MAX_PATTERN_CHARS) return false;
    if (/\\(?:[1-9]|k[<'])/.test(text)) return false;
    if (/\(\?[^:]/.test(text)) return false;
    if (/\([^)]*(?:[*+]|\{\d)[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return false;
    if (/\([^)]*\|[^)]*\)\s*(?:[*+?]|\{\d)/.test(text)) return false;
    if ((text.match(/\.\*/g) || []).length > 6) return false;
    return true;
  }
  function escapeRegExpLiteral(value: unknown): string {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function compileHookRedactPattern(raw: unknown): RedactMatcher | null {
    const pattern = String(raw == null ? '' : raw);
    if (!pattern || pattern.length > BROWSER_PILOT_HOOK_REDACT_MAX_PATTERN_CHARS) return null;
    if (isSafeHookRedactRegexPattern(pattern)) {
      try {
        return { pattern, mode: 'regex', regex: new RegExp(pattern, 'gi') };
      } catch (_error) {
        /* fall through to literal redaction pattern */
      }
    }
    try { return { pattern, mode: 'literal', regex: new RegExp(escapeRegExpLiteral(pattern), 'gi') }; } catch (_) { return null; }
  }
  function currentHookRedactors(): RedactMatcher[] {
    if (redactMatchers) return redactMatchers;
    const custom = options && Array.isArray(options.redact_patterns) ? options.redact_patterns.slice(0, BROWSER_PILOT_HOOK_MAX_REDACT_PATTERNS).map(String) : [];
    redactMatchers = DEFAULT_REDACT_PATTERNS.concat(custom).map(compileHookRedactPattern).filter((item): item is RedactMatcher => Boolean(item));
    return redactMatchers;
  }
  function clone(v: unknown): unknown { return safeString(v); }
  function redactText(text: unknown): string {
    let out = String(text);
    const truncated = out.length > BROWSER_PILOT_HOOK_REDACT_MAX_TEXT_CHARS;
    if (truncated) out = out.slice(0, BROWSER_PILOT_HOOK_REDACT_MAX_TEXT_CHARS);
    currentHookRedactors().forEach((item: RedactMatcher) => { out = out.replace(item.regex, '[REDACTED]'); });
    return truncated ? out + '…[redaction input truncated]' : out;
  }
  function redactClone(v: unknown, depth = 0, seen?: WeakSet<object> | null): unknown {
    if (v == null) return v;
    const t = typeof v;
    if (t === 'string') return redactText(v);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return v;
    if (t === 'undefined') return undefined;
    if (t === 'function') {
      const functionLike = v as { name?: string };
      return '[Function' + (functionLike.name ? ':' + functionLike.name : '') + ']';
    }
    const maxDepth = numericOption('max_clone_depth', 10, 1, 50);
    if ((depth || 0) >= maxDepth) return '[MaxDepth]';
    seen = seen || (typeof WeakSet !== 'undefined' ? new WeakSet() : null);
    if (typeof v !== 'object' || v === null) return String(v);
    if (seen) {
      if (seen.has(v)) return '[Circular]';
      try {
        seen.add(v);
      } catch (_error) {
        /* best-effort circular tracking */
      }
    }
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return { kind: 'ArrayBuffer', byteLength: v.byteLength };
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v)) { const view = v as ArrayBufferView & { length?: number }; return { kind: view.constructor && view.constructor.name || 'TypedArray', byteLength: view.byteLength, length: view.length }; }
    if (typeof Blob !== 'undefined' && v instanceof Blob) return { kind: 'Blob', size: v.size, type: v.type };
    if (typeof FormData !== 'undefined' && v instanceof FormData) {
      const keys: string[] = [];
      try {
        v.forEach((_, k) => keys.push(String(k)));
      } catch (_error) {
        /* best-effort FormData key enumeration */
      }
      return { kind: 'FormData', keys };
    }
    if (v instanceof Error) return redactClone(serializeError(v), (depth || 0) + 1, seen);
    const maxItems = numericOption('max_array_items', 100, 1, 10000);
    const maxKeys = numericOption('max_object_keys', 100, 1, 10000);
    if (Array.isArray(v)) {
      const out: unknown[] = v.slice(0, maxItems).map(x => redactClone(x, (depth || 0) + 1, seen));
      if (v.length > maxItems) out.push('…[' + (v.length - maxItems) + ' more items]');
      return out;
    }
    const out: HookRecord = {};
    const record = asRecord(v);
    const keys = Object.keys(record);
    keys.slice(0, maxKeys).forEach(k => { out[redactText(k)] = redactClone(record[k], (depth || 0) + 1, seen); });
    if (keys.length > maxKeys) out.__truncated_keys__ = keys.length - maxKeys;
    return out;
  }
  function safeString(v: unknown, maxLen?: unknown): unknown {
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
  function describeBody(v: unknown): unknown {
    if (v == null) return null;
    if (typeof v === 'string') return { kind: 'string', length: v.length, sample: safeString(v, 512) };
    return safeString(v);
  }
  function describeAlgorithm(algorithm: unknown): unknown {
    if (algorithm == null) return null;
    if (typeof algorithm === 'string') return algorithm;
    const out: HookRecord = {};
    const algorithmRecord = asRecord(algorithm);
    ['name','hash','modulusLength','namedCurve','length','tagLength','publicExponent'].forEach(k => {
      if (algorithmRecord[k] == null) return;
      out[k] = (k === 'publicExponent') ? safeString(algorithmRecord[k]) : safeString(algorithmRecord[k], 256);
    });
    const hash = asRecord(algorithmRecord.hash);
    if (algorithmRecord.hash && typeof algorithmRecord.hash === 'object') out.hash = hash.name || safeString(algorithmRecord.hash, 256);
    return out;
  }
  function describeKey(key: unknown): unknown {
    if (!key) return null;
    const keyRecord = asRecord(key);
    return { type: keyRecord.type, extractable: keyRecord.extractable, algorithm: describeAlgorithm(keyRecord.algorithm), usages: Array.prototype.slice.call(keyRecord.usages || []) };
  }
  function stackForEvent(): string { try { return (new Error()).stack || ''; } catch (_) { return ''; } }
  function redactCookieValue(cookieString: unknown): string {
    return String(cookieString || '').split(';').map(part => {
      const idx = part.indexOf('=');
      const name = (idx >= 0 ? part.slice(0, idx) : part).trim();
      return name ? name + '=<redacted>' : '';
    }).filter(Boolean).join('; ');
  }
  function cookieNames(cookieString: unknown): string[] {
    return String(cookieString || '').split(';').map(part => (part.split('=')[0] || '').trim()).filter(Boolean);
  }
  function storageKeys(storage: Storage | null | undefined): string[] {
    const keys: string[] = [];
    if (!storage) return keys;
    try {
      for (let i = 0; i < storage.length; i += 1) keys.push(String(storage.key(i)));
    } catch (_error) {
      /* best-effort storage key enumeration */
    }
    return keys;
  }
  function elementRef(node: unknown): HookRecord | null {
    if (!node) return null;
    const el = node as Element & { id?: string; className?: unknown; nodeName?: string };
    return {
      nodeName: el.nodeName || '',
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      name: el.getAttribute ? (el.getAttribute('name') || '') : '',
      selector: el.id ? ('#' + el.id) : ''
    };
  }

  let state: string = 'CREATED';
  let session_id: string | null = null;
  let installed_at: string | null = null;
  let install_epoch = 0;
  let install_fingerprint = '';
  let owner_session_id: string | null = null;
  let cleanup_warnings: string[] = [];
  let residue_signatures: string[] = [];
  let paused = false;
  let seq = 0;
  let overflow = 0;
  let buffer: HookEvent[] = [];
  let buffer_start = 0;
  let buffer_count = 0;
  let buffer_size = DEFAULT_BUFFER_SIZE;
  let targets: HookTargets = Object.assign({}, DEFAULT_TARGETS) as HookTargets;
  let options: HookOptions = {};
  let stats: HookStats = Object.assign({}, DEFAULT_STATS) as HookStats;
  let observer: MutationObserver | null = null;
  let mutationQueue: MutationSample[] = [];
  let mutationTimer: ReturnType<typeof setTimeout> | null = null;
  let origXHR: XhrOriginal | null = null;
  let origFetch: typeof window.fetch | null = null;
  let origConsole: HookFunctionRecord = {};
  let origWebSocket: typeof window.WebSocket | null = null;
  let origStorage: StorageOriginal | null = null;
  let origCookieDescriptor: CookieDescriptor | null = null;
  const origCrypto: { subtle: HookFunctionRecord; getRandomValues: Crypto['getRandomValues'] | null } = { subtle: {}, getRandomValues: null };
  let origDomSinks: HookRecord = {};
  let xpathTimer: ReturnType<typeof setTimeout> | null = null;
  let xpathPollMs = 0;
  let xpathIdleTicks = 0;
  let xpathCache: Record<string, number | string> = {};
  let xpathLargeResultTicks: Record<string, number> = {};
  let eventNotifyQueue: HookEvent[] = [];
  let eventNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  let errorHandlers: Array<[keyof WindowEventMap, EventListener]> = [];
  const hookWrappers: { xhr: HookFunctionRecord; fetch: typeof window.fetch | null; websocket: typeof window.WebSocket | null; console: HookFunctionRecord; storage: HookFunctionRecord; cookie: unknown; crypto: HookFunctionRecord; domSinks: HookRecord } = { xhr: {}, fetch: null, websocket: null, console: {}, storage: {}, cookie: null, crypto: {}, domSinks: {} };
  let perfStats: Record<string, PerfBucket> = {};
  let redactMatchers: RedactMatcher[] | null = null;
  function resetDiagnostics(): void { cleanup_warnings = []; residue_signatures = []; }
  function addCleanupWarning(msg: unknown): void { if (msg) cleanup_warnings.push(String(msg)); }
  function addResidueSignature(sig: unknown): void { if (!sig) return; const s = String(sig); if (residue_signatures.indexOf(s) < 0) residue_signatures.push(s); }
  function isBrowserPilotWrapperSource(text: unknown): boolean { return /__browser_pilot_hooks|BrowserPilotHookDispatcher|__BROWSER_PILOT_HOOKS__|network\.request|websocket\.open|storage\.set|crypto\.getRandomValues|dom\.sink|cookies\.read|console\./i.test(String(text || '')); }
  function detectResidue() {
    residue_signatures = [];
    try {
      if (typeof window.fetch === 'function' && isBrowserPilotWrapperSource(Function.prototype.toString.call(window.fetch))) addResidueSignature('fetch');
    } catch (_error) {
      /* best-effort fetch residue detection */
    }
    try {
      if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype && typeof XMLHttpRequest.prototype.open === 'function') {
        const s1 = Function.prototype.toString.call(XMLHttpRequest.prototype.open);
        const s2 = Function.prototype.toString.call(XMLHttpRequest.prototype.send);
        if (isBrowserPilotWrapperSource(s1)) addResidueSignature('xhr.open');
        if (isBrowserPilotWrapperSource(s2)) addResidueSignature('xhr.send');
      }
    } catch (_error) {
      /* best-effort XHR residue detection */
    }
    try {
      if (typeof window.WebSocket === 'function' && /WrappedWebSocket|websocket\.open|__BROWSER_PILOT_HOOKS__/i.test(Function.prototype.toString.call(window.WebSocket))) addResidueSignature('WebSocket');
    } catch (_error) {
      /* best-effort websocket residue detection */
    }
    try {
      if (typeof Storage !== 'undefined' && Storage.prototype && typeof Storage.prototype.setItem === 'function') {
        const s = Function.prototype.toString.call(Storage.prototype.setItem);
        if (isBrowserPilotWrapperSource(s)) addResidueSignature('storage.setItem');
      }
    } catch (_error) {
      /* best-effort storage residue detection */
    }
    try {
      const consoleRecord = console as unknown as Record<string, unknown>;
      ['log','warn','error','info','debug'].forEach(level => {
        try {
          if (typeof consoleRecord[level] === 'function' && isBrowserPilotWrapperSource(Function.prototype.toString.call(consoleRecord[level]))) addResidueSignature('console.' + level);
        } catch (_error) {
          /* best-effort console residue detection */
        }
      });
    } catch (_error) {
      /* best-effort console residue bootstrap */
    }
  }

  function perfBucket(name: string): PerfBucket {
    if (!perfStats[name]) perfStats[name] = { count: 0, total_ms: 0, last_ms: 0, max_ms: 0, samples: [] };
    return perfStats[name];
  }
  function recordPerf(name: string, t0: number): number {
    const dt = Math.max(0, Date.now() - t0);
    const b = perfBucket(name);
    b.count += 1; b.total_ms += dt; b.last_ms = dt; b.max_ms = Math.max(b.max_ms, dt);
    b.samples.push(dt);
    const limit = numericOption('perf_sample_limit', DEFAULT_LIMITS.perf_sample_limit, 8, 4096);
    if (b.samples.length > limit) b.samples.splice(0, b.samples.length - limit);
    b.avg_ms = b.count ? b.total_ms / b.count : 0;
    return dt;
  }
  function perfSnapshot(): HookRecord {
    const out: HookRecord = {};
    Object.keys(perfStats).forEach(k => {
      const b = perfStats[k];
      const samples = b.samples.slice().sort((a, z) => a - z);
      const pct = (p: number) => samples.length ? samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))] : 0;
      out[k] = { count: b.count, last_ms: b.last_ms, max_ms: b.max_ms, avg_ms: b.avg_ms || 0, sample_count: b.samples.length, p50_ms: pct(0.50), p95_ms: pct(0.95) };
    });
    return out;
  }
  function bufferMetrics(): HookRecord {
    const used = buffer_count;
    const capacity = buffer_size || DEFAULT_BUFFER_SIZE;
    return { buffer_capacity: capacity, buffer_used: used, buffer_utilization: capacity ? used / capacity : 0, dropped_events: overflow };
  }
  function notifyOverflow(event: HookEvent): void {
    try {
      window.postMessage({ __browser_pilot_overflow__: true, dropped_events: overflow, buffer_capacity: buffer_size, buffer_used: buffer_count, event_type: event && event.type, seq: event && event.seq }, '*');
    } catch (_error) {
      /* best-effort overflow notification */
    }
  }
  function bufferSnapshot(): HookEvent[] {
    const out: HookEvent[] = [];
    for (let i = 0; i < buffer_count; i += 1) out.push(buffer[(buffer_start + i) % buffer_size]);
    return out;
  }
  function scheduleTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    try {
      const timer = t as unknown as { unref?: () => void };
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch (_error) {
      /* best-effort timer unref */
    }
    return t;
  }
  function clearEventNotifyTimer(): void { if (eventNotifyTimer) { clearTimeout(eventNotifyTimer); eventNotifyTimer = null; } }
  function flushEventNotifications(): void {
    clearEventNotifyTimer();
    if (!eventNotifyQueue.length) return;
    const batch = eventNotifyQueue.splice(0, eventNotifyQueue.length);
    try {
      if (options && options.batch_post_message) window.postMessage({ __browser_pilot_event__: true, event_batch: batch, count: batch.length }, '*');
      else batch.forEach(event => window.postMessage({ __browser_pilot_event__: true, event }, '*'));
    } catch (_error) {
      /* best-effort batched event notification */
    }
  }
  function notifyEvent(event: HookEvent): void {
    if (!(options && options.batch_post_message)) {
      try {
        window.postMessage({ __browser_pilot_event__: true, event }, '*');
      } catch (_error) {
        /* best-effort single event notification */
      }
      return;
    }
    eventNotifyQueue.push(event);
    const maxEvents = numericOption('batch_max_events', 50, 1, 10000);
    const flushMs = numericOption('batch_flush_ms', 25, 0, 60000);
    if (eventNotifyQueue.length >= maxEvents || flushMs === 0) flushEventNotifications();
    else if (!eventNotifyTimer) eventNotifyTimer = scheduleTimer(flushEventNotifications, flushMs);
  }
  function storeEvent(event: HookEvent): boolean {
    if (buffer_count < buffer_size) { buffer[(buffer_start + buffer_count) % buffer_size] = event; buffer_count += 1; return false; }
    buffer[buffer_start] = event;
    buffer_start = (buffer_start + 1) % buffer_size;
    overflow += 1; stats.overflow = overflow;
    notifyOverflow(event);
    return true;
  }
  function push(type: string, data: unknown): HookEvent | null {
    const t0 = Date.now();
    if (paused && type !== 'hook.lifecycle') return null;
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
  function setState(next: string, reason?: unknown): void { const prev = state; state = next; push('hook.lifecycle', { from: prev, to: next, reason: reason || 'command' }); }
  function validateTargets(nextTargets: unknown): string | null {
    if (!nextTargets) return null;
    const allowed = new Set(['network','dom','console','error','xpath','cookies','storage','websocket','crypto','dom_sinks','rules']);
    for (const k of Object.keys(asRecord(nextTargets))) if (!allowed.has(k)) return k;
    return null;
  }
  function serializeError(err: unknown): HookRecord | null { const e = asRecord(err); return err ? { name: e.name || errorName(err), message: e.message || errorMessage(err), stack: e.stack || '' } : null; }

  function hookXHR() {
    if (!targets.network || origXHR || typeof XMLHttpRequest === 'undefined') return;
    origXHR = { open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send };
    const originalXhr = origXHR;
    const openWrapper = function(this: XhrWithMeta, method: string, url: string | URL, ...rest: [boolean?, string?, string?]): void {
      this.__browser_pilot_meta = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), t0: Date.now() };
      (originalXhr.open as unknown as HookCallable).apply(this, [method, url, ...rest]);
    };
    hookWrappers.xhr.open = openWrapper as HookCallable;
    XMLHttpRequest.prototype.open = openWrapper as typeof XMLHttpRequest.prototype.open;
    const sendWrapper = function(this: XhrWithMeta, body?: XMLHttpRequestBodyInit | null): void {
      const meta = this.__browser_pilot_meta || { method: 'GET', url: '', t0: Date.now() };
      push('network.request', { transport: 'xhr', method: meta.method, url: meta.url, body: describeBody(body), stack: stackForEvent() });
      this.addEventListener('load', () => push('network.response', {
        transport: 'xhr', method: meta.method, url: meta.url, status: this.status, duration_ms: Date.now() - meta.t0,
        response_type: this.responseType || '', response_url: this.responseURL || meta.url
      }));
      this.addEventListener('error', () => push('network.error', { transport: 'xhr', url: meta.url, error: 'XHR failed' }));
      (originalXhr.send as typeof XMLHttpRequest.prototype.send).call(this, body);
    };
    hookWrappers.xhr.send = sendWrapper as HookCallable;
    XMLHttpRequest.prototype.send = sendWrapper as typeof XMLHttpRequest.prototype.send;
  }
  function hookFetch() {
    if (!targets.network || origFetch || typeof window.fetch !== 'function') return;
    origFetch = window.fetch;
    const originalFetch = origFetch;
    const fetchWrapper = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const requestInput = input instanceof Request ? input : null;
      const method = String((init && init.method) || requestInput?.method || 'GET').toUpperCase();
      const url = String((typeof input === 'string') ? input : (input instanceof URL ? input.href : (requestInput?.url || '')));
      const t0 = Date.now();
      push('network.request', { transport: 'fetch', method, url, body: init && init.body != null ? describeBody(init.body) : null, stack: stackForEvent() });
      return originalFetch.call(window, input, init).then((resp: Response) => {
        push('network.response', { transport: 'fetch', method, url, status: resp.status, ok: resp.ok, type: resp.type, duration_ms: Date.now() - t0 });
        return resp;
      }).catch((err: unknown) => { push('network.error', { transport: 'fetch', url, error: errorMessage(err) }); throw err; });
    };
    hookWrappers.fetch = fetchWrapper;
    window.fetch = fetchWrapper;
  }
  function hookWebSocket() {
    if (!targets.websocket || origWebSocket || typeof window.WebSocket !== 'function') return;
    origWebSocket = window.WebSocket;
    const NativeWebSocket = origWebSocket;
    function WrappedWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
      const ws = arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      const wsid = 'ws-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      push('websocket.open', { id: wsid, url: String(url || ''), protocols: protocols == null ? null : safeString(protocols), stack: stackForEvent() });
      ws.addEventListener('open', () => push('websocket.ready', { id: wsid, url: String(url || '') }));
      ws.addEventListener('message', e => push('websocket.message', { id: wsid, url: String(url || ''), data: describeBody(e.data) }));
      ws.addEventListener('close', e => push('websocket.close', { id: wsid, url: String(url || ''), code: e.code, reason: e.reason, wasClean: e.wasClean }));
      ws.addEventListener('error', () => push('websocket.error', { id: wsid, url: String(url || '') }));
      const nativeSend = ws.send;
      ws.send = function(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        push('websocket.send', { id: wsid, url: String(url || ''), data: describeBody(data), stack: stackForEvent() });
        nativeSend.call(ws, data as string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>);
      };
      return ws;
    }
    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    const nativeWebSocketRecord = NativeWebSocket as unknown as Record<string, unknown>;
    ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => {
      try {
        Object.defineProperty(WrappedWebSocket, k, { value: nativeWebSocketRecord[k], enumerable: true });
      } catch (_error) {
        /* best-effort websocket static constant mirror */
      }
    });
    const wrappedCtor = WrappedWebSocket as unknown as typeof window.WebSocket;
    hookWrappers.websocket = wrappedCtor;
    window.WebSocket = wrappedCtor;
  }
  function hookConsole() {
    if ((!targets.console && !targets.error) || Object.keys(origConsole).length) return;
    const consoleRecord = console as unknown as Record<string, HookCallable>;
    ['log','warn','error','info','debug'].forEach(level => {
      if (typeof consoleRecord[level] !== 'function') return;
      origConsole[level] = consoleRecord[level];
      hookWrappers.console[level] = function(...args: unknown[]) {
        push('console.' + level, { args: args.map(x => safeString(x, 1024)), stack: stackForEvent() });
        return origConsole[level].apply(console, args);
      };
      consoleRecord[level] = hookWrappers.console[level];
    });
  }
  function browserPilotErrors() {
    if (!targets.error || errorHandlers.length) return;
    const onError: EventListener = (event) => { const e = event as ErrorEvent; push('error.uncaught', { message: e.message, source: e.filename, lineno: e.lineno, colno: e.colno, error: serializeError(e.error) }); };
    const onRejection: EventListener = (event) => { const e = event as PromiseRejectionEvent; push('error.promise', { reason: safeString(e.reason), stack: asRecord(e.reason).stack }); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    errorHandlers = [['error', onError], ['unhandledrejection', onRejection]];
  }
  function flushMutations(): void {
    const t0 = Date.now();
    if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
    if (!mutationQueue.length) return;
    const maxFlush = numericOption('mutation_flush_sample_limit', DEFAULT_LIMITS.mutation_flush_sample_limit, 1, 1000);
    const batch = mutationQueue.splice(0, Math.min(mutationQueue.length, maxFlush));
    const remaining = mutationQueue.length;
    const maxSamples = numericOption('mutation_sample_limit', 20, 0, 200);
    const summary: HookRecord & { childList: number; attributes: number; characterData: number; added_count: number; removed_count: number; samples: MutationSample[] } = { count: batch.length + remaining, childList: 0, attributes: 0, characterData: 0, added_count: 0, removed_count: 0, samples: [], overflow: remaining > 0, truncated_count: remaining };
    batch.forEach(m => {
      if (m.type === 'childList') summary.childList += 1;
      else if (m.type === 'attributes') summary.attributes += 1;
      else if (m.type === 'characterData') summary.characterData += 1;
      summary.added_count += Number(m.added_count || 0);
      summary.removed_count += Number(m.removed_count || 0);
      if (summary.samples.length < maxSamples) summary.samples.push(m);
    });
    if (remaining > 0) push('dom.mutation.overflow', { queued_count: remaining, emitted_count: batch.length, hard_limit: numericOption('mutation_queue_hard_limit', DEFAULT_LIMITS.mutation_queue_hard_limit, 1, 100000) });
    push('dom.mutation', summary);
    recordPerf('mutationFlush', t0);
    if (mutationQueue.length && !mutationTimer) mutationTimer = scheduleTimer(flushMutations, numericOption('mutation_batch_ms', 100, 0, 5000));
  }
  function hookDOM(): void {
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
  function hookDomSinks(): void {
    if (!targets.dom_sinks || Object.keys(origDomSinks).length) return;
    function wrapDescriptor(proto: Element | Document | null | undefined, prop: string, label: string): void {
      if (!proto) return;
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || typeof desc.set !== 'function') return;
      origDomSinks[label] = { proto, prop, desc };
      const getter = desc.get;
      const setter = desc.set;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: getter ? function(this: unknown) { return getter.call(this); } : undefined,
        set: function(this: unknown, value: unknown) {
          push('dom.sink.write', { sink: label, target: elementRef(this), value: safeString(String(value), 1024), stack: stackForEvent() });
          return setter.call(this, value);
        }
      });
    }
    wrapDescriptor(Element.prototype, 'innerHTML', 'Element.innerHTML');
    wrapDescriptor(Element.prototype, 'outerHTML', 'Element.outerHTML');
    wrapDescriptor(HTMLScriptElement && HTMLScriptElement.prototype, 'text', 'HTMLScriptElement.text');
    const nativeInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    if (typeof nativeInsertAdjacentHTML === 'function') {
      origDomSinks.insertAdjacentHTML = nativeInsertAdjacentHTML;
      Element.prototype.insertAdjacentHTML = function(position: InsertPosition, text: string): void {
        push('dom.sink.call', { sink: 'Element.insertAdjacentHTML', target: elementRef(this), position: String(position || ''), value: safeString(String(text), 1024), stack: stackForEvent() });
        return nativeInsertAdjacentHTML.call(this, position, text);
      };
    }
    const nativeWrite = document.write;
    if (typeof nativeWrite === 'function') {
      origDomSinks.documentWrite = nativeWrite;
      document.write = function(...text: string[]): void {
        push('dom.sink.call', { sink: 'document.write', value: text.map(x => safeString(String(x), 1024)), stack: stackForEvent() });
        return nativeWrite.apply(document, text);
      };
    }
  }
  function hookCookies(): void {
    if (!targets.cookies || origCookieDescriptor) return;
    let proto = Document.prototype;
    let desc = Object.getOwnPropertyDescriptor(proto, 'cookie');
    if (!desc) { proto = HTMLDocument && HTMLDocument.prototype; desc = proto && Object.getOwnPropertyDescriptor(proto, 'cookie'); }
    if (!desc || typeof desc.get !== 'function') return;
    origCookieDescriptor = { proto, desc };
    const getter = desc.get;
    const setter = desc.set;
    Object.defineProperty(proto, 'cookie', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function(this: Document) {
        const value = getter.call(this);
        push('cookies.read', { names: cookieNames(value), count: cookieNames(value).length, value: redactCookieValue(value), stack: stackForEvent() });
        return value;
      },
      set: function(this: Document, value: string) {
        const text = String(value || '');
        push('cookies.write', { name: (text.split('=')[0] || '').trim(), value: redactCookieValue(text), stack: stackForEvent() });
        return setter?.call(this, value);
      }
    });
    try {
      const snapshot = getter.call(document);
      push('cookies.snapshot', { names: cookieNames(snapshot), count: cookieNames(snapshot).length, value: redactCookieValue(snapshot) });
    } catch (_error) {
      /* best-effort cookie snapshot */
    }
  }
  function hookStorage(): void {
    if (!targets.storage || origStorage || typeof Storage === 'undefined') return;
    const proto = Storage.prototype;
    origStorage = {
      setItem: proto.setItem, getItem: proto.getItem, removeItem: proto.removeItem, clear: proto.clear, key: proto.key
    };
    const originalStorage = origStorage;
    function storageKind(self: unknown): string {
      try {
        if (self === window.localStorage) return 'localStorage';
      } catch (_error) {
        /* best-effort localStorage identity check */
      }
      try {
        if (self === window.sessionStorage) return 'sessionStorage';
      } catch (_error) {
        /* best-effort sessionStorage identity check */
      }
      return 'Storage';
    }
    const setItemWrapper = function(this: Storage, key: string, value: string): void {
      push('storage.set', { storage: storageKind(this), key: String(key), value: safeString(String(value), 1024), stack: stackForEvent() });
      return originalStorage.setItem.call(this, key, value);
    };
    hookWrappers.storage.setItem = setItemWrapper as HookCallable;
    proto.setItem = setItemWrapper;
    const getItemWrapper = function(this: Storage, key: string): string | null {
      const value = originalStorage.getItem.call(this, key);
      push('storage.get', { storage: storageKind(this), key: String(key), hit: value != null, stack: stackForEvent() });
      return value;
    };
    hookWrappers.storage.getItem = getItemWrapper as HookCallable;
    proto.getItem = getItemWrapper;
    const removeItemWrapper = function(this: Storage, key: string): void {
      push('storage.remove', { storage: storageKind(this), key: String(key), stack: stackForEvent() });
      return originalStorage.removeItem.call(this, key);
    };
    hookWrappers.storage.removeItem = removeItemWrapper as HookCallable;
    proto.removeItem = removeItemWrapper;
    const clearWrapper = function(this: Storage): void {
      push('storage.clear', { storage: storageKind(this), keys_before: storageKeys(this), stack: stackForEvent() });
      return originalStorage.clear.call(this);
    };
    hookWrappers.storage.clear = clearWrapper as HookCallable;
    proto.clear = clearWrapper;
    try {
      push('storage.snapshot', { storage: 'localStorage', keys: storageKeys(window.localStorage) });
    } catch (_error) {
      /* best-effort localStorage snapshot */
    }
    try {
      push('storage.snapshot', { storage: 'sessionStorage', keys: storageKeys(window.sessionStorage) });
    } catch (_error) {
      /* best-effort sessionStorage snapshot */
    }
  }
  function hookCrypto(): void {
    if (!targets.crypto || !window.crypto) return;
    if (!origCrypto.getRandomValues && typeof window.crypto.getRandomValues === 'function') {
      origCrypto.getRandomValues = window.crypto.getRandomValues.bind(window.crypto);
      try {
        window.crypto.getRandomValues = function<T extends ArrayBufferView | null>(array: T): T {
          push('crypto.getRandomValues', { array: safeString(array), stack: stackForEvent() });
          if (!origCrypto.getRandomValues || array === null) return array;
          return origCrypto.getRandomValues(array as ArrayBufferView<ArrayBuffer>) as T;
        };
      } catch (_error) {
        /* best-effort getRandomValues hook install */
      }
    }
    const subtle = window.crypto.subtle;
    if (!subtle) return;
    const subtleRecord = subtle as unknown as HookFunctionRecord;
    ['encrypt','decrypt','digest','sign','verify','deriveBits','deriveKey','importKey','exportKey','wrapKey','unwrapKey','generateKey'].forEach(name => {
      if (origCrypto.subtle[name] || typeof subtleRecord[name] !== 'function') return;
      origCrypto.subtle[name] = subtleRecord[name].bind(subtle) as HookCallable;
      try {
        subtleRecord[name] = function(...args: unknown[]) {
          push('crypto.subtle.' + name, {
            algorithm: describeAlgorithm(args[0]),
            key: describeKey(args[1]),
            format: typeof args[0] === 'string' && ['raw','pkcs8','spki','jwk'].indexOf(args[0]) >= 0 ? args[0] : undefined,
            data: args.length ? safeString(args[args.length - 1]) : null,
            stack: stackForEvent()
          });
          return origCrypto.subtle[name].apply(subtle, args);
        };
      } catch (_error) {
        /* best-effort subtle crypto hook install */
      }
    });
  }
  function checkXPaths(): void {
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
        const err = errorMessage(e);
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

  function install(optsInput?: unknown): HookResponse {
    const opts = asRecord(optsInput);
    if (opts.expected_version && String(opts.expected_version) !== VERSION) {
      return structuredError(ERROR_CODES.INJECTION_FAILED, 'Browser Pilot dispatcher version mismatch', { expected_version: String(opts.expected_version), dispatcher_version: VERSION });
    }
    const badTarget = validateTargets(opts.targets);
    if (badTarget) return structuredError(ERROR_CODES.UNSUPPORTED_TARGET, 'Unsupported Browser Pilot target: ' + badTarget, { target: badTarget });
    const requestedSessionId = String(opts.session_id || ('browser-pilot-hook-' + Date.now() + '-' + Math.random().toString(16).slice(2)));
    const requestedTargets = Object.assign({}, DEFAULT_TARGETS, asRecord(opts.targets)) as HookTargets;
    const requestedOptions = Object.assign({}, asRecord(opts.options)) as HookOptions;
    const requestedBufferSize = Math.max(1, Number(opts.buffer_size || requestedOptions.buffer_size || DEFAULT_BUFFER_SIZE));
    const requestedFingerprint = buildInstallFingerprint(requestedSessionId, requestedTargets, requestedOptions, requestedBufferSize, opts.install_fingerprint);
    const sameSession = session_id === requestedSessionId;
    const sameFingerprint = install_fingerprint === requestedFingerprint;
    if (state !== 'CREATED' && state !== 'CLOSED') {
      if (opts.force !== true && sameSession && sameFingerprint) {
        return { ok: true, data: {
          session_id, state, installed_at, targets: clone(targets), browser_pilot_version: VERSION,
          dispatcher_version: VERSION, install_epoch, owner_session_id, install_fingerprint,
          already_installed: true, idempotent: true, same_session: true, same_fingerprint: true,
          page_compatible: true, cleanup_warnings: cleanup_warnings.slice(), residue_signatures: residue_signatures.slice()
        } };
      }
      if (opts.force !== true) {
        return structuredError(ERROR_CODES.ALREADY_INSTALLED, 'Browser Pilot dispatcher is already installed with a different session or fingerprint', {
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
    redactMatchers = null;
    buffer_size = requestedBufferSize;
    buffer = new Array(buffer_size); buffer_start = 0; buffer_count = 0; seq = 0; overflow = 0; stats = Object.assign({}, DEFAULT_STATS);
    mutationQueue = []; if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
    eventNotifyQueue = []; clearEventNotifyTimer();
    xpathPollMs = Number(options.xpath_poll_ms || 5000); xpathIdleTicks = 0; xpathCache = {}; xpathLargeResultTicks = {}; perfStats = {};
    install_epoch = Date.now();
    setState('PREPARED', 'install');
    hookXHR(); hookFetch(); hookWebSocket(); hookConsole(); browserPilotErrors(); hookDOM(); hookDomSinks(); hookCookies(); hookStorage(); hookCrypto();
    if (targets.xpath && targets.xpath.length) xpathTimer = scheduleTimer(checkXPaths, Math.max(1, xpathPollMs || 5000));
    installed_at = now(); setState('INSTALLED', 'install');
    return { ok: true, data: {
      session_id, state, installed_at, targets: clone(targets), browser_pilot_version: VERSION, dispatcher_version: VERSION,
      install_epoch, owner_session_id, install_fingerprint, already_installed: false, idempotent: false,
      same_session: false, same_fingerprint: false, page_compatible: true,
      cleanup_warnings: cleanup_warnings.slice(), residue_signatures: residue_signatures.slice()
    } };
  }
  function expectedSessionIdFrom(optsInput?: unknown): string | null {
    const opts = asRecord(optsInput);
    if (!opts) return null;
    const raw = opts.session_id !== undefined ? opts.session_id : opts.sessionId;
    return raw === undefined || raw === null || raw === '' ? null : String(raw);
  }
  function requireSession(op: string, expectedSessionId?: unknown, allowMissing = false): HookResponse | null {
    expectedSessionId = expectedSessionId == null || expectedSessionId === '' ? null : String(expectedSessionId);
    if (!session_id) {
      if (expectedSessionId) return structuredError(ERROR_CODES.SESSION_NOT_FOUND, op + ' sessionId was not found', { state, requested_session_id: expectedSessionId });
      return allowMissing ? null : structuredError(ERROR_CODES.NO_SESSION, op + ' requires an installed Browser Pilot session', { state });
    }
    if (expectedSessionId && expectedSessionId !== String(session_id)) {
      return structuredError(ERROR_CODES.INVALID_SESSION, op + ' sessionId does not match the installed Browser Pilot session', { state, requested_session_id: expectedSessionId, current_session_id: session_id });
    }
    return null;
  }
  function collect(optsInput?: unknown): HookResponse {
    const t0 = Date.now();
    const opts = asRecord(optsInput);
    const miss = requireSession('hook.collect', expectedSessionIdFrom(opts)); if (miss) return miss;
    const since = Number(opts.since_seq || 0);
    const limit = Math.max(0, Number(opts.limit || 100));
    flushMutations();
    flushEventNotifications();
    let events = bufferSnapshot().filter(e => e && e.seq > since);
    const eventTypes = Array.isArray(opts.event_types) ? opts.event_types.map(String) : [];
    if (eventTypes.length) events = events.filter(e => eventTypes.some((t: string) => e.type.indexOf(t) === 0));
    const page = events.slice(0, limit);
    recordPerf('collect', t0);
    return { ok: true, data: Object.assign({ session_id, events: page, next_seq: page.length ? page[page.length - 1].seq : since, total_available: events.length, overflow }, bufferMetrics()) };
  }
  function status(optsInput?: unknown): HookResponse {
    const opts = asRecord(optsInput);
    const miss = requireSession('hook.status', expectedSessionIdFrom(opts), true); if (miss) return miss;
    return { ok: true, data: {
      session_id, state, installed_at, uptime_ms: installed_at ? Date.now() - Date.parse(installed_at) : 0,
      last_seq: seq, // event seq high-water mark — ABML R3.x P2 baseline anchor (see causal.ts)
      stats: Object.assign({}, stats, { buffer_count, buffer_size, buffer_usage: buffer_count / buffer_size }, bufferMetrics()),
      buffer_capacity: bufferMetrics().buffer_capacity, buffer_used: bufferMetrics().buffer_used, buffer_utilization: bufferMetrics().buffer_utilization, dropped_events: overflow, perf: perfSnapshot(),
      targets: clone(targets), options: clone(options), browser_pilot_version: VERSION, dispatcher_version: VERSION,
      install_epoch, owner_session_id, install_fingerprint,
      installed_marker: !!(session_id && state !== 'CLOSED' && state !== 'CREATED'),
      cleanup_warnings: cleanup_warnings.slice(), residue_signatures: residue_signatures.slice()
    } };
  }
  function pause(opts?: unknown): HookResponse { const miss = requireSession('hook.pause', expectedSessionIdFrom(opts)); if (miss) return miss; paused = true; setState('PAUSED', 'pause'); return { ok: true, data: { session_id, state } }; }
  function resume(opts?: unknown): HookResponse { const miss = requireSession('hook.resume', expectedSessionIdFrom(opts)); if (miss) return miss; paused = false; setState('ACTIVE', 'resume'); return { ok: true, data: { session_id, state } }; }
  function evaluate(opts?: unknown): HookResponse {
    const optsRecord = asRecord(opts);
    const expr = typeof opts === 'string' ? opts : optsRecord.expression;
    if (!expr) return structuredError(ERROR_CODES.INVALID_RULE, 'hook.evaluate requires expression', {});
    try {
      const result = (0, eval)(String(expr));
      const type = result === null ? 'null' : typeof result;
      return { ok: true, data: { result: optsRecord.return_by_value === false ? type : clone(result), type } };
    } catch (e) { return structuredError(ERROR_CODES.INTERNAL_ERROR, errorMessage(e), serializeError(e)); }
  }
  function clearBuffer(optsInput?: unknown): HookResponse {
    const opts = asRecord(optsInput);
    const miss = requireSession('hook.clear_buffer', expectedSessionIdFrom(opts)); if (miss) return miss;
    buffer = new Array(buffer_size); buffer_start = 0; buffer_count = 0; overflow = 0; stats.overflow = 0; perfStats = {};
    return { ok: true, data: { session_id, cleared: true, last_seq: seq } };
  }
  function uninstall(optsInput?: unknown): HookResponse {
    const opts = asRecord(optsInput);
    if (opts.force !== true) { const miss = requireSession('hook.uninstall', expectedSessionIdFrom(opts)); if (miss) return miss; }
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
    const consoleRecord = console as unknown as Record<string, HookCallable>;
    Object.keys(origConsole).forEach(k => { if (consoleRecord[k] === hookWrappers.console[k]) consoleRecord[k] = origConsole[k]; else addCleanupWarning('console.' + k + ' wrapper identity changed before uninstall'); }); origConsole = {}; hookWrappers.console = {};
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
    Object.keys(origCrypto.subtle).forEach(k => {
      try {
        if (window.crypto && window.crypto.subtle) (window.crypto.subtle as unknown as HookFunctionRecord)[k] = origCrypto.subtle[k];
      } catch (_error) {
        /* best-effort subtle crypto restore */
      }
    });
    origCrypto.subtle = {};
    if (origCrypto.getRandomValues) {
      try {
        window.crypto.getRandomValues = origCrypto.getRandomValues;
      } catch (_error) {
        /* best-effort getRandomValues restore */
      }
      origCrypto.getRandomValues = null;
    }
    Object.keys(origDomSinks).forEach(k => {
      const item = origDomSinks[k] as DomSinkDescriptor | undefined;
      if (item && item.proto && item.prop && item.desc) Object.defineProperty(item.proto, item.prop, item.desc);
    });
    if (origDomSinks.insertAdjacentHTML) Element.prototype.insertAdjacentHTML = origDomSinks.insertAdjacentHTML as typeof Element.prototype.insertAdjacentHTML;
    if (origDomSinks.documentWrite) document.write = origDomSinks.documentWrite as typeof document.write;
    origDomSinks = {};
    errorHandlers.forEach(item => window.removeEventListener(item[0], item[1])); errorHandlers = [];
    if (observer) { observer.disconnect(); observer = null; }
    if (mutationTimer) { clearTimeout(mutationTimer); mutationTimer = null; }
    mutationQueue = [];
    if (xpathTimer) { clearTimeout(xpathTimer); xpathTimer = null; }
    xpathCache = {}; xpathLargeResultTicks = {}; xpathIdleTicks = 0;
    flushEventNotifications(); clearEventNotifyTimer(); eventNotifyQueue = [];
    detectResidue();
    if (residue_signatures.length) addCleanupWarning('Browser Pilot hook residue detected after uninstall: ' + residue_signatures.join(','));
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
  function dispatch(cmdInput: unknown, args?: unknown): HookResponse {
    const cmd = canonicalCommand(cmdInput);
    switch (cmd) {
      case 'hook.install': return install(args);
      case 'hook.collect': return collect(args);
      case 'hook.status': return status(args);
      case 'hook.uninstall': return uninstall(args);
      case 'hook.clear_buffer': return clearBuffer(args);
      case 'hook.pause': return pause(args);
      case 'hook.resume': return resume(args);
      case 'hook.evaluate': return evaluate(args);
      default: return structuredError(ERROR_CODES.INVALID_RULE, 'Unknown Browser Pilot command: ' + cmd, { cmd });
    }
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    const msg = asRecord(e.data);
    if (!msg || !msg.__browser_pilot_hook_cmd__) return;
    const id = msg.id;
    const resp = dispatch(msg.cmd, msg.args || {});
    window.postMessage({ __browser_pilot_hook_response__: true, id, resp }, '*');
  });
  window.__BROWSER_PILOT_HOOKS__ = {
    version: VERSION, dispatcher_version: VERSION, ERROR_CODES, COMMAND_CANONICAL, install, collect, status, uninstall, clearBuffer, pause, resume, evaluate, dispatch,
    getState: () => state, getSessionId: () => session_id, getBuffer: () => bufferSnapshot(), getStats: () => Object.assign({}, stats),
    getInstallFingerprint: () => install_fingerprint, getOwnerSessionId: () => owner_session_id, getInstallEpoch: () => install_epoch,
    getCleanupWarnings: () => cleanup_warnings.slice(), getResidueSignatures: () => residue_signatures.slice(),
    getBufferStats: () => Object.assign({ count: buffer_count, size: buffer_size, usage: buffer_count / buffer_size, overflow }, bufferMetrics()), getPerfStats: () => perfSnapshot()
  };
  setState('CREATED', 'bootstrap');
})();

export {};
