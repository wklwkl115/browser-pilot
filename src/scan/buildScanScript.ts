import { ACTIONABLE_ATTRIBUTE_NAMES, ACTIONABLE_HIGH_INTENT_PATTERN, ACTIONABLE_KEYWORD_PATTERN, ACTIONABLE_PRIMARY_INTENT_PATTERN, FRAMEWORK_ACTION_HANDLER_PATTERN, FRAMEWORK_HANDLER_OWNER_PATTERN } from "./actionableRules.ts";
import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, SCAN_EXTENSION_URL_PATTERN, SCAN_IGNORE_IDS, SCAN_IGNORE_SELECTORS, SCAN_IGNORE_TAGS } from "./noiseRules.ts";

export type BrowserScanOptions = {
	textOnly?: boolean;
	maxChars?: number;
	maxNodes?: number;
	includeIframes?: boolean;
};

export function jsonForInlineScript(value: unknown): string {
	const json = JSON.stringify(value);
	return (json === undefined ? "null" : json).replace(/[<>&\u2028\u2029]/g, (char) => {
		if (char === "<") return "\\u003C";
		if (char === ">") return "\\u003E";
		if (char === "&") return "\\u0026";
		if (char === "\u2028") return "\\u2028";
		return "\\u2029";
	});
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	const safe = Number.isFinite(n) ? Math.floor(n) : fallback;
	return Math.max(min, Math.min(max, safe));
}

export function buildScanScript(options: BrowserScanOptions = {}): string {
	const opts = {
		textOnly: options.textOnly === true,
		maxChars: boundedInt(options.maxChars, 35_000, 1_000, 500_000),
		maxNodes: boundedInt(options.maxNodes, 4_000, 100, 20_000),
		includeIframes: options.includeIframes !== false,
	};
	const optionsJson = jsonForInlineScript(opts);
	const ignoreIdsJson = jsonForInlineScript(SCAN_IGNORE_IDS);
	const ignoreTagsJson = jsonForInlineScript(SCAN_IGNORE_TAGS);
	const ignoreSelectorsJson = jsonForInlineScript(SCAN_IGNORE_SELECTORS);
	const noiseAttrNamesJson = jsonForInlineScript(BROWSER_NOISE_ATTRIBUTE_NAMES);
	const noiseAttrPrefixesJson = jsonForInlineScript(BROWSER_NOISE_ATTRIBUTE_PREFIXES);
	const noiseClassPatternsJson = jsonForInlineScript(BROWSER_NOISE_CLASS_PATTERNS);
	const extensionUrlPatternJson = jsonForInlineScript(SCAN_EXTENSION_URL_PATTERN);
	const actionAttrsJson = jsonForInlineScript(ACTIONABLE_ATTRIBUTE_NAMES);
	const actionablePatternJson = jsonForInlineScript(ACTIONABLE_KEYWORD_PATTERN);
	const highIntentPatternJson = jsonForInlineScript(ACTIONABLE_HIGH_INTENT_PATTERN);
	const primaryIntentPatternJson = jsonForInlineScript(ACTIONABLE_PRIMARY_INTENT_PATTERN);
	const frameworkOwnerPatternJson = jsonForInlineScript(FRAMEWORK_HANDLER_OWNER_PATTERN);
	const frameworkActionPatternJson = jsonForInlineScript(FRAMEWORK_ACTION_HANDLER_PATTERN);

	return String.raw`
(async () => {
  const options = ${optionsJson};
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','CANVAS','META','LINK','SOURCE','PICTURE','COLGROUP','COL','PARAM']);
  const IGNORE_IDS = new Set(${ignoreIdsJson});
  const IGNORE_TAGS = new Set(${ignoreTagsJson});
  const IGNORE_SELECTORS = ${ignoreSelectorsJson};
  const NOISE_ATTR_NAMES = new Set(${noiseAttrNamesJson});
  const NOISE_ATTR_PREFIXES = ${noiseAttrPrefixesJson};
  const NOISE_CLASS_PATTERNS = ${noiseClassPatternsJson};
  const EXTENSION_URL_RE = new RegExp(${extensionUrlPatternJson}, 'i');
  const KEEP_EMPTY = new Set(['INPUT','TEXTAREA','SELECT','BUTTON','IMG','IFRAME','VIDEO','A']);
  const ACTION_ATTRS = ${actionAttrsJson};
  const ACTIONABLE_RE = new RegExp(${actionablePatternJson}, 'i');
  const HIGH_INTENT_RE = new RegExp(${highIntentPatternJson}, 'i');
  const PRIMARY_INTENT_RE = new RegExp(${primaryIntentPatternJson}, 'i');
  const FRAMEWORK_OWNER_RE = new RegExp(${frameworkOwnerPatternJson}, 'i');
  const FRAMEWORK_ACTION_RE = new RegExp(${frameworkActionPatternJson});
  const ATTRS = ['id','class','name','type','role','placeholder','href','src','alt','value','data-e2e-state'].concat(ACTION_ATTRS);
  let nodeCount = 0;
  let truncated = false;
  let outputChars = 0;
  const iframeNotes = [];

  function clean(text, max = 400) {
    text = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > max) {
      truncated = true;
      return text.slice(0, max) + '…';
    }
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
    if (el.tagName === 'INPUT' && isAutofilled(el)) {
      parts.push('data-autofilled="true"');
      if (!el.value && !parts.some(part => part.startsWith('value='))) parts.push('value="⚠️protected-autofill"');
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
  function isAutofilled(el) {
    try { return !!(el.matches && el.matches(':-webkit-autofill')); }
    catch (_) { return false; }
  }
  function topLayerRoot(doc) {
    const body = doc.body || doc.documentElement;
    if (!body) return null;
    const vw = Math.max(doc.documentElement.clientWidth || 0, innerWidth || 0);
    const vh = Math.max(doc.documentElement.clientHeight || 0, innerHeight || 0);
    const viewportArea = Math.max(1, vw * vh);
    const candidates = [];
    for (const el of Array.from(body.querySelectorAll('*'))) {
      if (isIgnored(el) || isHidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 120 || r.height < 120) continue;
      const style = getComputedStyle(el);
      const cls = String(el.className && typeof el.className === 'object' ? el.className.baseVal || '' : el.className || '').toLowerCase();
      const cover = (r.width * r.height) / viewportArea;
      const centerDiff = Math.abs((r.left + r.width / 2) - vw / 2) / Math.max(1, vw);
      const hasControls = !!el.querySelector('button,input,textarea,select,a,[role="button"],[contenteditable="true"]');
      const zIndex = style.position !== 'static' ? (parseInt(style.zIndex) || 0) : 0;
      const keywordModalish = cls.includes('modal') || cls.includes('dialog') || cls.includes('mask') || cls.includes('overlay');
      const popupish = cls.includes('popup') && (style.position === 'fixed' || style.position === 'absolute') && zIndex > 0;
      const fixedLayer = style.position === 'fixed' && (zIndex > 10 || cover > 0.3 || cls.includes('fullscreen'));
      const modalish = keywordModalish || popupish || fixedLayer;
      if (!hasControls || !modalish || cover < 0.15 || cover > 1.2 || centerDiff > 0.35) continue;
      candidates.push({ el, cover, zIndex });
    }
    candidates.sort((a, b) => b.zIndex - a.zIndex || b.cover - a.cover);
    return candidates[0]?.el || null;
  }
  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    return null;
  }
  function actionNameOf(el) {
    if (!el.getAttribute) return '';
    for (const name of ACTION_ATTRS) {
      const value = el.getAttribute(name);
      if (value) return clean(value, 120);
    }
    const id = el.id || '';
    if (ACTIONABLE_RE.test(id)) return clean(id, 120);
    const cls = cleanClassValue(el.className && typeof el.className === 'object' ? el.className.baseVal || '' : el.className || '').split(/\s+/).find(part => ACTIONABLE_RE.test(part));
    return clean(cls || '', 120);
  }
  function labelOf(el) {
    const tag = el.tagName;
    const fromAttrs = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('data-e2e') || el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy'));
    if (fromAttrs) return clean(fromAttrs, 160);
    if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.value) return clean(el.value, 160);
    return clean(el.innerText || el.textContent || '', 160);
  }
  function editable(el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !['hidden','button','submit','reset','checkbox','radio','file','image'].includes(String(el.type || '').toLowerCase());
    return el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  }
  function frameworkHandlers(el) {
    const out = [];
    try {
      for (const key of Object.keys(el).slice(0, 40)) {
        if (!FRAMEWORK_OWNER_RE.test(key)) continue;
        const value = el[key];
        if (!value || typeof value !== 'object') continue;
        for (const prop of Object.keys(value).slice(0, 80)) {
          if (/^on[A-Z]/.test(prop) && typeof value[prop] === 'function') out.push(prop);
        }
      }
    } catch (_) {}
    return out;
  }
  function clickable(el, style) {
    const tag = el.tagName;
    const role = String(roleOf(el) || '').toLowerCase();
    if (tag === 'A' || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'LABEL' || tag === 'VIDEO') return true;
    if (['button','link','menuitem','tab','checkbox','radio','switch','option'].includes(role)) return true;
    if (el.onclick || el.getAttribute('onclick') || el.getAttribute('tabindex') !== null) return true;
    if (frameworkHandlers(el).some(name => FRAMEWORK_ACTION_RE.test(name))) return true;
    if (style && style.cursor === 'pointer') return true;
    const cls = String(el.className && typeof el.className === 'object' ? el.className.baseVal || '' : el.className || '').toLowerCase();
    const attrsText = [cls, el.id, el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('title'), el.getAttribute && el.getAttribute('data-e2e'), el.getAttribute && el.getAttribute('data-e2e-state')].join(' ').toLowerCase();
    return ACTIONABLE_RE.test(attrsText);
  }
  function cssEscape(value) {
    try { return CSS && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
    catch (_) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  }
  function selectorFor(el) {
    if (el.id) return '#' + cssEscape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.body && cur !== document.documentElement && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      const cls = cleanClassValue(cur.className && typeof cur.className === 'object' ? cur.className.baseVal || '' : cur.className || '').split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.map(cssEscape).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(x => x.tagName === cur.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }
  function visibleInfo(el) {
    const r = el.getBoundingClientRect();
    const vw = Math.max(document.documentElement.clientWidth || 0, innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, innerHeight || 0);
    const inViewport = !!r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    let hitOk = null;
    let hitTarget = null;
    if (inViewport && document.elementFromPoint) {
      const points = [[0.5,0.5],[0.25,0.5],[0.75,0.5],[0.5,0.25],[0.5,0.75]];
      for (const pair of points) {
        const x = Math.round(Math.max(0, Math.min(vw - 1, r.left + r.width * pair[0])));
        const y = Math.round(Math.max(0, Math.min(vh - 1, r.top + r.height * pair[1])));
        const hit = document.elementFromPoint(x, y);
        const ok = !hit || hit === el || el.contains(hit) || (hit.contains && hit.contains(el));
        if (!hitTarget && hit) hitTarget = { tag: hit.tagName ? hit.tagName.toLowerCase() : '', id: hit.id || '', class: cleanClassValue(hit.className || '').slice(0, 80), text: clean(hit.innerText || hit.textContent || '', 80) };
        if (ok) { hitOk = true; if (hit) hitTarget = { tag: hit.tagName ? hit.tagName.toLowerCase() : '', id: hit.id || '', class: cleanClassValue(hit.className || '').slice(0, 80), text: clean(hit.innerText || hit.textContent || '', 80) }; break; }
        hitOk = false;
      }
    }
    const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    const point = { x: Math.round(Math.max(0, Math.min(vw - 1, r.left + r.width / 2))), y: Math.round(Math.max(0, Math.min(vh - 1, r.top + r.height / 2))) };
    return { inViewport, hitOk, hitTarget, rect, point };
  }
  function scoreActionable(item) {
    let score = 0;
    if (item.editable) score += 1000;
    if (item.clickable && !item.editable) score += 800;
    if (item.hitOk === true) score += 180;
    if (item.hitOk === false) score -= 300;
    if (item.action) score += PRIMARY_INTENT_RE.test(item.action) ? 900 : (HIGH_INTENT_RE.test(item.action) ? 420 : 160);
    if (item.handlers && item.handlers.length) score += 180;
    if (item.role) score += 80;
    if (item.label) score += Math.min(80, item.label.length);
    const area = Math.max(1, item.rect.width * item.rect.height);
    if (area > 0 && area < 80000) score += 80;
    if (area > Math.max(1, (innerWidth || 1) * (innerHeight || 1) * 0.25)) score -= 400;
    return score;
  }
  function collectActionables(root) {
    if (!root) return [];
    const source = root === document.body || root === document.documentElement ? Array.from(root.querySelectorAll('*')) : [root].concat(Array.from(root.querySelectorAll('*')));
    const out = [];
    let scanned = 0;
    for (const el of source) {
      if (++scanned > Math.min(options.maxNodes, 4000)) break;
      if (!el || el.nodeType !== Node.ELEMENT_NODE || SKIP.has(el.tagName) || isIgnored(el) || isHidden(el)) continue;
      const style = getComputedStyle(el);
      const handlers = frameworkHandlers(el);
      const action = actionNameOf(el);
      const isEditable = editable(el);
      const isClickable = clickable(el, style);
      if (!isEditable && !isClickable) continue;
      const visible = visibleInfo(el);
      if (!visible.inViewport) continue;
      const item = { index: out.length, selector: selectorFor(el), tag: el.tagName.toLowerCase(), role: roleOf(el), action, label: labelOf(el), text: clean(el.innerText || el.textContent || '', 120), clickable: isClickable, editable: isEditable, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', handlers: handlers.slice(0, 6), rect: visible.rect, point: visible.point, hitOk: visible.hitOk, hitTarget: visible.hitTarget };
      item.priority = scoreActionable(item);
      out.push(item);
    }
    return out.sort((a, b) => b.priority - a.priority || a.rect.y - b.rect.y || a.rect.x - b.rect.x).slice(0, 80).map((item, index) => ({ ...item, index }));
  }
  function collectListHints(root) {
    if (!root) return [];
    const containers = [root].concat(Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []));
    const hints = [];
    let scanned = 0;
    for (const container of containers) {
      if (++scanned > Math.min(options.maxNodes, 3000)) break;
      if (!container.children || container.children.length < 5 || isIgnored(container) || isHidden(container)) continue;
      const groups = new Map();
      for (const child of Array.from(container.children)) {
        if (!child || child.nodeType !== Node.ELEMENT_NODE || isIgnored(child) || isHidden(child)) continue;
        const cls = cleanClassValue(child.className && typeof child.className === 'object' ? child.className.baseVal || '' : child.className || '').split(/\s+/).filter(Boolean).slice(0, 2).map(cssEscape).join('.');
        const key = child.tagName.toLowerCase() + (cls ? '.' + cls : '');
        const arr = groups.get(key) || [];
        arr.push(child);
        groups.set(key, arr);
      }
      for (const [key, items] of groups.entries()) {
        if (items.length < 5) continue;
        const totalText = items.reduce((sum, item) => sum + clean(item.innerText || item.textContent || '', 500).length, 0);
        const avgText = totalText / Math.max(1, items.length);
        if (avgText < 20 && items.length < 8) continue;
        hints.push({ selector: selectorFor(container) + ' > ' + key, itemCount: items.length, hiddenCount: Math.max(0, items.length - 3), firstItemPreview: clean(items[0].innerText || items[0].textContent || items[0].outerHTML || '', 180), sampleHidden: items.slice(3, 8).map(item => clean(item.innerText || item.textContent || '', 80)).filter(Boolean) });
      }
    }
    return hints.sort((a, b) => b.hiddenCount - a.hiddenCount || b.itemCount - a.itemCount).slice(0, 12);
  }
  function resetOutputBudget() { outputChars = 0; truncated = false; }
  function cleanLineText(text, remaining) {
    const max = Math.max(80, Math.min(4000, remaining));
    return clean(text, max);
  }
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
      const remaining = Math.max(0, options.maxChars - outputChars - depth * 2 - 40);
      const text = cleanLineText(node.nodeValue, remaining);
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
      const remaining = Math.max(0, options.maxChars - outputChars - 40);
      const text = cleanLineText(node.nodeValue, remaining);
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
  function collectText(doc, out, rootOverride) {
    const textParts = [];
    const priorOutputChars = outputChars;
    collectVisibleText(rootOverride || doc.body || doc.documentElement || doc, textParts, 0);
    const traversalTruncated = truncated;
    outputChars = priorOutputChars;
    const text = clean(textParts.join(' '), options.maxChars);
    if (text) {
      truncated = false;
      push(out, text);
      truncated = traversalTruncated || truncated;
    }
    if (truncated) return;
    for (const control of Array.from(doc.querySelectorAll('input:not([type=hidden]),textarea,select'))) {
      if (truncated || nodeCount >= options.maxNodes) { truncated = true; break; }
      if (isIgnored(control) || isHidden(control)) continue;
      const label = [control.tagName.toLowerCase(), control.id && '#' + control.id, control.getAttribute('name') && 'name=' + control.getAttribute('name'), control.getAttribute('placeholder') && JSON.stringify(control.getAttribute('placeholder')), isAutofilled(control) && 'autofilled', control.value && 'value=' + JSON.stringify(clean(control.value, 120)), control.disabled && 'disabled'].filter(Boolean).join(' ');
      if (label) push(out, '[' + label + ']');
    }
    if (truncated || !options.includeIframes) return;
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

  const topRoot = topLayerRoot(document);
  const scanRoot = topRoot || document.body || document.documentElement;
  const actionables = collectActionables(scanRoot);
  const list_hints = collectListHints(scanRoot);
  let content;
  if (options.textOnly) {
    resetOutputBudget();
    const parts = [];
    collectText(document, parts, topRoot);
    content = parts.join('\n\n--- iframe ---\n\n');
    if (content.length > options.maxChars) { content = content.slice(0, options.maxChars) + '\n[scan truncated]'; truncated = true; }
  } else {
    resetOutputBudget();
    const lines = [];
    walk(topRoot || document.body || document.documentElement, lines, 0);
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
    iframe_notes: iframeNotes,
    top_layer: topRoot ? { tag: topRoot.tagName.toLowerCase(), id: topRoot.id || '', class: cleanClassValue(topRoot.className || '').slice(0, 120) } : null,
    actionables,
    list_hints
  };
})()`;
}
