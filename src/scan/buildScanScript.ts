import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, SCAN_EXTENSION_URL_PATTERN, SCAN_IGNORE_IDS, SCAN_IGNORE_SELECTORS, SCAN_IGNORE_TAGS } from "./noiseRules.ts";

export type BrowserScanOptions = {
	textOnly?: boolean;
	maxChars?: number;
	maxNodes?: number;
	includeIframes?: boolean;
};

export function buildScanScript(options: BrowserScanOptions): string {
	const opts = {
		textOnly: options.textOnly === true,
		maxChars: Math.max(1_000, Math.min(500_000, Math.floor(options.maxChars ?? 35_000))),
		maxNodes: Math.max(100, Math.min(20_000, Math.floor(options.maxNodes ?? 4_000))),
		includeIframes: options.includeIframes !== false,
	};

	return String.raw`
(async () => {
  const options = ${JSON.stringify(opts)};
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','CANVAS','META','LINK','SOURCE','PICTURE','COLGROUP','COL','PARAM']);
  const IGNORE_IDS = new Set(${JSON.stringify(SCAN_IGNORE_IDS)});
  const IGNORE_TAGS = new Set(${JSON.stringify(SCAN_IGNORE_TAGS)});
  const IGNORE_SELECTORS = ${JSON.stringify(SCAN_IGNORE_SELECTORS)};
  const NOISE_ATTR_NAMES = new Set(${JSON.stringify(BROWSER_NOISE_ATTRIBUTE_NAMES)});
  const NOISE_ATTR_PREFIXES = ${JSON.stringify(BROWSER_NOISE_ATTRIBUTE_PREFIXES)};
  const NOISE_CLASS_PATTERNS = ${JSON.stringify(BROWSER_NOISE_CLASS_PATTERNS)};
  const EXTENSION_URL_RE = new RegExp(${JSON.stringify(SCAN_EXTENSION_URL_PATTERN)}, 'i');
  const KEEP_EMPTY = new Set(['INPUT','TEXTAREA','SELECT','BUTTON','IMG','IFRAME','VIDEO','A']);
  const ATTRS = ['id','class','name','type','role','aria-label','placeholder','title','href','src','alt','value','data-testid','data-test','data-cy'];
  let nodeCount = 0;
  let truncated = false;
  let outputChars = 0;
  const iframeNotes = [];

  function clean(text, max = 400) {
    text = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > max) return text.slice(0, max) + '…';
    return text;
  }
  function isNoiseAttr(name) {
    const n = String(name || '').toLowerCase();
    return NOISE_ATTR_NAMES.has(n) || NOISE_ATTR_PREFIXES.some(prefix => n === prefix || n.startsWith(prefix + '-'));
  }
  function cleanClassValue(value) {
    return String(value || '').split(/\s+/).filter(cls => cls && !NOISE_CLASS_PATTERNS.some(pattern => cls.toLowerCase().includes(String(pattern).toLowerCase()))).join(' ');
  }
  function attrValue(el, name) {
    if (name === 'value' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el.value;
    const value = el.getAttribute && el.getAttribute(name);
    if (!value) return '';
    if (name === 'class') return cleanClassValue(value);
    if ((name === 'href' || name === 'src') && el[name]) {
      try { return String(el[name]); } catch (_) { return value; }
    }
    return value;
  }
  function attrs(el) {
    const parts = [];
    for (const name of ATTRS) {
      if (isNoiseAttr(name)) continue;
      const value = clean(attrValue(el, name), 180);
      if (!value) continue;
      parts.push(name + '=' + JSON.stringify(value));
    }
    if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox') && el.checked) parts.push('checked');
    if (el.tagName === 'SELECT' && el.value) parts.push('value=' + JSON.stringify(clean(el.value, 180)));
    if (el.disabled) parts.push('disabled');
    return parts.length ? ' ' + parts.join(' ') : '';
  }
  function isExtensionUrl(value) {
    return typeof value === 'string' && EXTENSION_URL_RE.test(value);
  }
  function matchesIgnoredSelector(el) {
    try { return IGNORE_SELECTORS.some(sel => (el.matches && el.matches(sel)) || (el.closest && el.closest(sel))); }
    catch (_) { return false; }
  }
  function isIgnored(el) {
    if (IGNORE_IDS.has(el.id || '')) return true;
    if (IGNORE_TAGS.has(el.tagName)) return true;
    if (matchesIgnoredSelector(el)) return true;
    if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'hidden') return true;
    if ((el.tagName === 'IFRAME' || el.tagName === 'IMG') && isExtensionUrl(attrValue(el, 'src'))) return true;
    return false;
  }
  function isHidden(el) {
    try {
      if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (Number(style.opacity) === 0 && !KEEP_EMPTY.has(el.tagName)) return true;
    } catch (_) {}
    return false;
  }
  function resetOutputBudget() { outputChars = 0; truncated = false; }
  function push(lines, value) {
    if (truncated || !value) return;
    const next = String(value);
    if (outputChars + next.length + 1 > options.maxChars) {
      truncated = true;
      const room = Math.max(0, options.maxChars - outputChars - 40);
      if (room > 0) { lines.push(next.slice(0, room)); outputChars += room + 1; }
      lines.push('[scan truncated]');
      outputChars += '[scan truncated]'.length + 1;
      return;
    }
    lines.push(next);
    outputChars += next.length + 1;
  }
  function walk(node, lines, depth) {
    if (truncated || nodeCount >= options.maxNodes || depth > 20) { truncated = true; return; }
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.nodeValue, 800);
      if (text) push(lines, '  '.repeat(depth) + text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    if (SKIP.has(el.tagName) || isIgnored(el) || isHidden(el)) return;
    nodeCount += 1;
    const tag = el.tagName.toLowerCase();
    const line = '<' + tag + attrs(el) + '>';
    const startLen = lines.length;
    push(lines, '  '.repeat(depth) + line);
    if (tag === 'iframe' && options.includeIframes) {
      try {
        const doc = el.contentDocument;
        if (doc && doc.documentElement) {
          iframeNotes.push({ src: el.src || el.getAttribute('src') || '', accessible: true, title: doc.title || '' });
          push(lines, '  '.repeat(depth + 1) + '<!-- same-origin iframe -->');
          walk(doc.body || doc.documentElement, lines, depth + 1);
        } else iframeNotes.push({ src: el.src || el.getAttribute('src') || '', accessible: false });
      } catch (e) {
        iframeNotes.push({ src: el.src || el.getAttribute('src') || '', accessible: false, error: e.message || String(e) });
      }
    } else {
      for (const child of Array.from(el.childNodes)) walk(child, lines, depth + 1);
      if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.childNodes)) walk(child, lines, depth + 1);
    }
    if (lines.length === startLen + 1 && !KEEP_EMPTY.has(el.tagName)) lines.pop();
  }
  function collectVisibleText(node, out, depth) {
    if (truncated || !node || depth > 20) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.nodeValue, 800);
      if (text) push(out, text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : null;
    if (el && (SKIP.has(el.tagName) || isIgnored(el) || isHidden(el))) return;
    if (el) {
      if (nodeCount >= options.maxNodes) { truncated = true; return; }
      nodeCount += 1;
    }
    for (const child of Array.from(node.childNodes || [])) {
      collectVisibleText(child, out, depth + 1);
      if (truncated) break;
    }
    if (!truncated && el && el.shadowRoot) for (const child of Array.from(el.shadowRoot.childNodes)) {
      collectVisibleText(child, out, depth + 1);
      if (truncated) break;
    }
  }
  function collectText(doc, out) {
    const textParts = [];
    const priorOutputChars = outputChars;
    collectVisibleText(doc.body || doc.documentElement || doc, textParts, 0);
    const traversalTruncated = truncated;
    outputChars = priorOutputChars;
    const text = clean(textParts.join(' '), options.maxChars);
    if (text) {
      truncated = false;
      push(out, text);
      truncated = traversalTruncated || truncated;
    }
    if (truncated || !options.includeIframes) return;
    for (const control of Array.from(doc.querySelectorAll('input:not([type=hidden]),textarea,select'))) {
      if (truncated || nodeCount >= options.maxNodes) { truncated = true; break; }
      if (isIgnored(control) || isHidden(control)) continue;
      const label = [control.tagName.toLowerCase(), control.id && '#' + control.id, control.getAttribute('name') && 'name=' + control.getAttribute('name'), control.getAttribute('placeholder') && JSON.stringify(control.getAttribute('placeholder')), control.value && 'value=' + JSON.stringify(clean(control.value, 120)), control.disabled && 'disabled'].filter(Boolean).join(' ');
      if (label) push(out, '[' + label + ']');
    }
    if (truncated) return;
    for (const frame of Array.from(doc.querySelectorAll('iframe'))) {
      if (truncated || nodeCount >= options.maxNodes) { truncated = true; break; }
      if (isIgnored(frame)) continue;
      try {
        const fdoc = frame.contentDocument;
        if (fdoc) {
          iframeNotes.push({ src: frame.src || frame.getAttribute('src') || '', accessible: true, title: fdoc.title || '' });
          collectText(fdoc, out);
        } else iframeNotes.push({ src: frame.src || frame.getAttribute('src') || '', accessible: false });
      } catch (e) { iframeNotes.push({ src: frame.src || frame.getAttribute('src') || '', accessible: false, error: e.message || String(e) }); }
    }
  }

  let content;
  if (options.textOnly) {
    resetOutputBudget();
    const parts = [];
    collectText(document, parts);
    content = parts.join('\n\n--- iframe ---\n\n');
    if (content.length > options.maxChars) { content = content.slice(0, options.maxChars) + '\n[scan truncated]'; truncated = true; }
  } else {
    resetOutputBudget();
    const lines = [];
    walk(document.body || document.documentElement, lines, 0);
    content = lines.join('\n');
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    text_only: options.textOnly,
    content,
    truncated,
    node_count: nodeCount,
    iframe_notes: iframeNotes
  };
})()`;
}
