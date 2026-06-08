// exec.js - plain JavaScript execution and CDP fallback for WebSocket requests.

import { chromeApi as chrome } from "./runtimeEnv";
import { normalizePersistentPiBrowserResponse, piBrowserPersistentCdp } from "./runtime";
import type { JsonRecord, PiChromeTab, PiWebSocketLike } from "./types";

const NEW_TAB_OBSERVE_WAIT_MS = 50;

function mayOpenNewTab(code: unknown): boolean {
  if (typeof code !== "string") return false;
  return /\bwindow\s*\.\s*open\s*\(|\bopen\s*\(|target\s*=\s*['"]_blank['"]|\.target\s*=\s*['"]_blank['"]|rel\s*=\s*['"][^'"]*\bnoopener\b/i.test(code);
}

function buildExecScript(code: unknown, errorHandler: string): string {
  return `(async () => {
    function smartProcessResult(result) {
      const seen = new WeakSet();
      const MAX_DEPTH = 8;
      const MAX_ARRAY = 100;
      const MAX_KEYS = 100;
      const MAX_TEXT = 1000;
      const MAX_HTML = 2000;
      const MAX_NODES = 2000;
      const MAX_CHARS = 200000;
      let nodesUsed = 0;
      let charsUsed = 0;
      function charge(value, limit) {
        const text = String(value || '');
        const remaining = Math.max(0, MAX_CHARS - charsUsed);
        if (remaining <= 0) return '[MaxChars]';
        const max = Math.min(Number(limit || MAX_TEXT), remaining);
        const out = text.length > max ? text.slice(0, max) + '…' : text;
        charsUsed += out.length;
        return out;
      }
      function trim(value, limit) {
        return charge(String(value || ''), limit);
      }
      function isDomNode(value) {
        return value && typeof value === 'object' && typeof value.nodeType === 'number';
      }
      function serializeElement(el) {
        const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
        const attrs = {};
        try { for (const attr of Array.from(el.attributes || [])) attrs[attr.name] = trim(attr.value, 240); } catch (_) {}
        return {
          __type: 'Element',
          tagName: String(el.tagName || '').toLowerCase(),
          id: el.id || null,
          classes: el.classList ? Array.from(el.classList).slice(0, 20) : [],
          role: el.getAttribute ? el.getAttribute('role') : null,
          text: trim(el.textContent || '', MAX_TEXT),
          attrs,
          rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
          outerHTML: trim(el.outerHTML || '', MAX_HTML)
        };
      }
      function serialize(value, depth) {
        if (value === null) return null;
        if (value === undefined) return '[undefined]';
        const t = typeof value;
        if (t === 'string') return trim(value, depth === 0 ? MAX_CHARS : MAX_TEXT);
        if (t === 'number' || t === 'boolean') return value;
        if (t === 'bigint') return trim(value.toString() + 'n', 200);
        if (t === 'symbol') return trim(value.toString(), 200);
        if (t === 'function') return trim('[Function ' + (value.name || 'anonymous') + ']', 200);
        if (t !== 'object') return trim(String(value), MAX_TEXT);
        if (++nodesUsed > MAX_NODES) return '[MaxNodes]';
        try { if (value.window === value && value.document) return '[Window: ' + (value.location && value.location.href || 'about:blank') + ']'; } catch (_) {}
        try { if (value === document) return '[Document: ' + (document.location && document.location.href || 'about:blank') + ']'; } catch (_) {}
        if (seen.has(value)) return '[Circular]';
        if (depth >= MAX_DEPTH) return '[MaxDepth]';
        seen.add(value);
        if (value instanceof Error) return { __type: 'Error', name: value.name, code: value.code || undefined, message: trim(value.message, MAX_TEXT), details: serialize(value.details || {}, depth + 1) };
        if (value instanceof Date) return { __type: 'Date', iso: value.toISOString() };
        if (value instanceof RegExp) return { __type: 'RegExp', source: value.source, flags: value.flags, text: value.toString() };
        if (value instanceof Map) return { __type: 'Map', size: value.size, entries: Array.from(value.entries()).slice(0, 50).map(function(entry) { return [serialize(entry[0], depth + 1), serialize(entry[1], depth + 1)]; }) };
        if (value instanceof Set) return { __type: 'Set', size: value.size, values: Array.from(value.values()).slice(0, 50).map(function(item) { return serialize(item, depth + 1); }) };
        if (typeof jQuery !== 'undefined' && value instanceof jQuery) return { __type: 'jQuery', length: value.length, items: Array.from(value).slice(0, MAX_ARRAY).map(function(item) { return serialize(item, depth + 1); }) };
        if (typeof NodeList !== 'undefined' && value instanceof NodeList) return { __type: 'NodeList', length: value.length, items: Array.from(value).slice(0, MAX_ARRAY).map(function(item) { return serialize(item, depth + 1); }) };
        if (typeof HTMLCollection !== 'undefined' && value instanceof HTMLCollection) return { __type: 'HTMLCollection', length: value.length, items: Array.from(value).slice(0, MAX_ARRAY).map(function(item) { return serialize(item, depth + 1); }) };
        if (isDomNode(value)) {
          if (value.nodeType === 1) return serializeElement(value);
          return { __type: 'Node', nodeType: value.nodeType, nodeName: value.nodeName || '', text: trim(value.textContent || '', MAX_TEXT) };
        }
        if (Array.isArray(value)) {
          const items = value.slice(0, MAX_ARRAY).map(function(item) { return serialize(item, depth + 1); });
          if (value.length > MAX_ARRAY) items.push({ __truncatedItems: value.length - MAX_ARRAY });
          return items;
        }
        if (!Array.isArray(value) && 'length' in value && typeof value.length === 'number' && value[0] && isDomNode(value[0])) {
          return { __type: 'ArrayLike', length: value.length, items: Array.from(value).slice(0, MAX_ARRAY).map(function(item) { return serialize(item, depth + 1); }) };
        }
        const proto = Object.getPrototypeOf(value);
        const typeName = proto && proto.constructor && proto.constructor.name && proto.constructor.name !== 'Object' ? proto.constructor.name : undefined;
        const out = typeName ? { __type: typeName } : {};
        const keys = Object.keys(value);
        const LARGE_TEXT_KEYS = new Set(['content', 'markdown', 'html']);
        for (const key of keys.slice(0, MAX_KEYS)) {
          try {
            const child = value[key];
            out[key] = typeof child === 'string' && LARGE_TEXT_KEYS.has(key) ? trim(child, MAX_CHARS) : serialize(child, depth + 1);
          }
          catch (e) { out[key] = '[GetterError: ' + (e && e.message ? e.message : String(e)) + ']'; }
        }
        if (keys.length > MAX_KEYS) out.__truncatedKeys = keys.length - MAX_KEYS;
        return out;
      }
      try { return serialize(result, 0); } catch (e) { return '[无法序列化: ' + (e && e.message ? e.message : String(e)) + ']'; }
    }
    try {
      const jsCode = ${JSON.stringify(code)}.trim();
      const lines = jsCode.split(/\\r?\\n/).filter(l => l.trim());
      const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : '';
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      let r;
      function _air(c) { const ls = c.split(/\\r?\\n/); let i = ls.length - 1; while (i >= 0 && !ls[i].trim()) i--; if (i < 0) return c; const t = ls[i].trim(); if (/^(return |return;|return$|let |const |var |if |if\\(|for |for\\(|while |while\\(|switch|try |throw |class |function |async |import |export |\\/\\/|})/.test(t)) return c; ls[i] = ls[i].match(/^(\\s*)/)[1] + 'return ' + t; return ls.join('\\n'); }
      if (lastLine.startsWith('return')) {
        r = await (new AsyncFunction(jsCode))();
      } else {
        try { r = eval(jsCode); if (r instanceof Promise) r = await r; } catch (e) {
          if (e instanceof SyntaxError && (/return/i.test(e.message) || /await/i.test(e.message))) { r = await (new AsyncFunction(_air(jsCode)))(); } else throw e;
        }
      }
      return { ok: true, data: smartProcessResult(r) };
    } catch (e) {
      ${errorHandler}
    }
  })()`;
}

function buildPageScript(code: unknown): string {
  return buildExecScript(code, `
      const errMsg = e.message || String(e);
      return { ok: false, error: { name: e.name || 'Error', code: e.code || undefined, message: errMsg, details: e.details || {} },
        csp: errMsg.includes('Refused to evaluate') || errMsg.includes('unsafe-eval') || errMsg.includes('Content Security Policy') };
  `);
}

function buildCdpScript(code: unknown): string {
  return buildExecScript(code, `
      return { ok: false, error: { name: e.name || 'Error', code: e.code || undefined, message: e.message || String(e), details: e.details || {} } };
  `);
}

function normalizeExecNavigationUrl(rawUrl: unknown): string {
  const raw = String(rawUrl || '').trim();
  if (!raw) throw new Error('Navigation URL is required');
  const parsed = new URL(raw, 'https://example.invalid');
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'javascript:' || protocol === 'data:') throw new Error(`Blocked navigation protocol: ${protocol}`);
  return raw;
}

async function handleWsExec(data: JsonRecord & { id?: string | number; tabId?: number; code?: unknown; timeoutMs?: number; timeout_ms?: number }, socket: PiWebSocketLike): Promise<void> {
  const tabId = data.tabId;
  socket.send(JSON.stringify({ type: 'ack', id: data.id }));
  if (!tabId) {
    socket.send(JSON.stringify({ type: 'error', id: data.id, error: 'No tabId provided' }));
    return;
  }
  const codeText = String(data.code || '').trim();
  const navMatch = codeText.match(/^(?:window\.)?location(?:\.href)?\s*=\s*(['"])(.*?)\1\s*;?$/);
  if (navMatch) {
    try {
      const targetUrl = normalizeExecNavigationUrl(navMatch[2]);
      await chrome.tabs.update(tabId, { url: targetUrl });
      socket.send(JSON.stringify({ type: 'result', id: data.id, result: { navigated: true, url: targetUrl } }));
    } catch (e) {
      socket.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) } }));
    }
    return;
  }
  const gmOpenMatch = codeText.match(/^GM_openInTab\(\s*(['"])(.*?)\1\s*\)\s*;?$/);
  if (gmOpenMatch) {
    try {
      const targetUrl = normalizeExecNavigationUrl(gmOpenMatch[2]);
      const t = await chrome.tabs.create({ url: targetUrl, active: true });
      const newTabs = [{ id: t.id, tabId: t.id, url: t.url || targetUrl, title: t.title || '' }];
      socket.send(JSON.stringify({ type: 'result', id: data.id, result: { opened: true, tabId: t.id, url: targetUrl }, newTabs }));
    } catch (e) {
      socket.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) } }));
    }
    return;
  }
  const newTabIds = new Set<number>();
  const onCreated = (tab: PiChromeTab) => { if (tab.id !== undefined) newTabIds.add(tab.id); };
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    let res: unknown;
    // The caller-supplied timeout is the TOTAL budget for this exec (it is also the outer client
    // pending-request timeout). chrome.scripting.executeScript (MAIN world) is the fast primary path,
    // but it can HANG when the debugger is attached / the renderer never acks the MAIN-world injection
    // on some pages — exactly the case the persistent-CDP Runtime.evaluate fallback below was added for
    // (browser_observe drives the same CDP eval successfully on those pages). So executeScript must FAIL
    // FAST and reserve the bulk of the budget for the fallback: cap it to ≤1/3 of the budget and ≤2500ms.
    // Reusing the full timeoutMs here (the prior bug) let a hung executeScript consume the entire budget
    // so the fallback never ran and the client only ever saw BRIDGE_TIMEOUT with no result. [F2]
    const TOTAL_EXEC_TIMEOUT_MS = Math.max(100, Math.min(120000, Number(data.timeoutMs ?? data.timeout_ms ?? 30000) || 30000));
    try {
      const EXECUTE_SCRIPT_TIMEOUT_MS = Math.max(100, Math.min(2500, Math.floor(TOTAL_EXEC_TIMEOUT_MS / 3)));
      const executePromise = chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (s: string) => await (0, eval)(s),
        args: [buildPageScript(data.code)]
      });
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => {
        const err = new Error('chrome.scripting.executeScript timed out after ' + EXECUTE_SCRIPT_TIMEOUT_MS + 'ms');
        err.name = 'ExecuteScriptTimeout';
        reject(err);
      }, EXECUTE_SCRIPT_TIMEOUT_MS));
      const result = await Promise.race([executePromise, timeoutPromise]);
      const scriptResults = Array.isArray(result) ? result as Array<{ result?: unknown }> : [];
      res = scriptResults[0]?.result;
      if (res === null || res === undefined) {
        res = { ok: false, error: { name: 'Error', message: 'executeScript returned null (possible CSP or context issue)' }, csp: true };
      }
    } catch (e) {
      res = { ok: false, error: { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) }, csp: true };
    }
    const firstRes = res && typeof res === 'object' ? res as JsonRecord : {};
    if (res && firstRes.ok === false && firstRes.csp) {
      const wrappedCode = buildCdpScript(data.code);
      try {
        const cdp = piBrowserPersistentCdp();
        if (!cdp?.send) throw new Error('persistent CDP helper is not loaded');
        const resp = normalizePersistentPiBrowserResponse(await cdp.send(tabId, 'Runtime.evaluate', {
          expression: wrappedCode, awaitPromise: true, returnByValue: true
        }, { name: 'default', persistent: false, timeoutMs: TOTAL_EXEC_TIMEOUT_MS }));
        if (!resp || resp.ok === false) throw new Error(String(resp?.error || resp?.message || 'persistent CDP Runtime.evaluate failed'));
        const cdpRes = (((resp.data && typeof resp.data === 'object') ? resp.data as JsonRecord : {}).result || resp.result || resp.data) as JsonRecord;
        const exceptionDetails = cdpRes.exceptionDetails && typeof cdpRes.exceptionDetails === 'object' ? cdpRes.exceptionDetails as JsonRecord : undefined;
        if (exceptionDetails) {
          const exception = exceptionDetails.exception && typeof exceptionDetails.exception === 'object' ? exceptionDetails.exception as JsonRecord : {};
          const desc = String(exception.description || 'CDP Error');
          res = { ok: false, error: { name: 'Error', message: desc } };
        } else {
          const result = cdpRes.result && typeof cdpRes.result === 'object' ? cdpRes.result as JsonRecord : {};
          res = result.value;
        }
      } catch (cdpErr) {
        res = { ok: false, error: { name: 'Error', message: 'CDP fallback failed: ' + (cdpErr instanceof Error ? cdpErr.message : String(cdpErr)) } };
      }
    }
    if (newTabIds.size === 0 && mayOpenNewTab(data.code)) await new Promise(r => setTimeout(r, NEW_TAB_OBSERVE_WAIT_MS));
    chrome.tabs.onCreated.removeListener(onCreated);
    const newTabs: JsonRecord[] = [];
    for (const id of newTabIds) {
      try {
        const t = await chrome.tabs.get(id);
        newTabs.push({ id: t.id, url: t.url, title: t.title });
      } catch (_error) {
        /* best-effort new tab metadata read */
      }
    }
    const finalRes = res && typeof res === 'object' ? res as JsonRecord : {};
    if (finalRes.ok) {
      socket.send(JSON.stringify({ type: 'result', id: data.id, result: finalRes.data, newTabs }));
    } else {
      socket.send(JSON.stringify({ type: 'error', id: data.id, error: finalRes.error || 'Unknown error', newTabs }));
    }
  } catch (e) {
    socket.send(JSON.stringify({ type: 'error', id: data.id, error: { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) } }));
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}
export { buildExecScript, buildPageScript, buildCdpScript, handleWsExec };
// ESM module metadata
export const __piBridgeModule_exec = { name: "exec", symbols: { buildExecScript, buildPageScript, buildCdpScript, handleWsExec } };
