// html.js - Pi browser native HTML/text snapshot command.

async function handlePiBrowserHtml(tabId, msg) {
  const opts = (msg && msg.options && typeof msg.options === 'object') ? msg.options : {};
  const pick = (...names) => {
    for (const name of names) {
      if (msg && msg[name] !== undefined) return msg[name];
      if (opts && opts[name] !== undefined) return opts[name];
    }
    return undefined;
  };
  const selector = pick('selector');
  const rawMode = pick('mode') ?? 'outer';
  const normalizedMode = String(rawMode).replace(/[-_]/g, '').toLowerCase();
  const modeAliases = { raw: 'outer', fragment: 'inner', textcontent: 'text' };
  const mode = modeAliases[normalizedMode] || normalizedMode;
  const maxBytesRaw = pick('max_bytes', 'maxBytes');
  const maxCharsRaw = pick('max_chars', 'maxChars');
  const maxBytes = maxBytesRaw === undefined || maxBytesRaw === null || maxBytesRaw === '' ? null : Number(maxBytesRaw);
  const maxChars = maxCharsRaw === undefined || maxCharsRaw === null || maxCharsRaw === '' ? null : Number(maxCharsRaw);
  if (!['outer', 'inner', 'text'].includes(mode)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'html.get mode must be outer, inner, text, raw, or fragment', { cmd: msg.cmd, mode: rawMode });
  if (maxBytes !== null && (!Number.isFinite(maxBytes) || maxBytes < 0)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'html.get max_bytes/maxBytes must be a non-negative number', { cmd: msg.cmd, maxBytes: maxBytesRaw });
  if (maxChars !== null && (!Number.isFinite(maxChars) || maxChars < 0)) return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'html.get max_chars/maxChars must be a non-negative number', { cmd: msg.cmd, maxChars: maxCharsRaw });
  const expression = `(async () => {
    const selector = ${JSON.stringify(selector === undefined || selector === null || selector === '' ? null : String(selector))};
    const mode = ${JSON.stringify(mode)};
    const maxBytes = ${maxBytes === null ? 'null' : JSON.stringify(Math.floor(maxBytes))};
    const maxChars = ${maxChars === null ? 'null' : JSON.stringify(Math.floor(maxChars))};
    const encoder = new TextEncoder();
    function sliceUtf8(str, limit) {
      if (limit === null || limit === undefined) return str;
      if (limit <= 0) return '';
      let lo = 0, hi = str.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (encoder.encode(str.slice(0, mid)).length <= limit) lo = mid;
        else hi = mid - 1;
      }
      return str.slice(0, lo);
    }
    let node = selector ? document.querySelector(selector) : document.documentElement;
    if (!node) return { ok: false, error_code: 'SELECTOR_TIMEOUT', error: 'selector not found: ' + selector, details: { selector, mode } };
    let html;
    if (mode === 'inner') html = node.innerHTML ?? '';
    else if (mode === 'text') html = node.textContent ?? '';
    else html = node.outerHTML ?? '';
    html = String(html);
    const original_length = html.length;
    const original_bytes = encoder.encode(html).length;
    let truncated = false;
    if (maxChars !== null && html.length > maxChars) { html = html.slice(0, maxChars); truncated = true; }
    if (maxBytes !== null && encoder.encode(html).length > maxBytes) { html = sliceUtf8(html, maxBytes); truncated = true; }
    return { ok: true, data: { html, truncated, original_length, bytes: encoder.encode(html).length, original_bytes, selector, mode } };
  })()`;
  const res = await piBrowserEval(tabId, expression, true);
  if (!res || res.ok === false) return res;
  if (res.data && res.data.ok === false) return piBrowserError(res.data.error_code || PI_BROWSER_ERROR_CODES.SELECTOR_TIMEOUT, res.data.error || 'html.get failed', res.data.details || { selector, mode: rawMode });
  return res.data && res.data.ok === true ? res.data : { ok: true, data: res.data };
}
