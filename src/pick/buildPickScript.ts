import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, BROWSER_NOISE_SELECTORS } from "../scan/noiseRules.ts";

export type BrowserPickOptions = {
	message: string;
	multiple?: boolean;
	timeoutMs?: number;
	pickId?: string;
};

export function buildPickScript(options: BrowserPickOptions): string {
	const timeoutMs = Math.max(1_000, Math.floor(Number(options.timeoutMs || 120_000)));
	const payload = JSON.stringify({
		message: options.message,
		multiple: options.multiple !== false,
		timeoutMs: Math.max(1_000, timeoutMs - 500),
		pickId: options.pickId || `pick-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		noiseSelectors: BROWSER_NOISE_SELECTORS,
		noiseAttrNames: BROWSER_NOISE_ATTRIBUTE_NAMES,
		noiseAttrPrefixes: BROWSER_NOISE_ATTRIBUTE_PREFIXES,
		noiseClassPatterns: BROWSER_NOISE_CLASS_PATTERNS,
	});
	return String.raw`new Promise((resolve) => {
  const options = ${payload};
  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  };
  const isUnique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch (_) { return false; }
  };
  const attrSelector = (name, value) => value ? '[' + name + '="' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]' : '';
  const NOISE_SELECTORS = options.noiseSelectors || [];
  const NOISE_ATTR_NAMES = new Set((options.noiseAttrNames || []).map((name) => String(name).toLowerCase()));
  const NOISE_ATTR_PREFIXES = options.noiseAttrPrefixes || [];
  const NOISE_CLASS_PATTERNS = options.noiseClassPatterns || [];
  const isNoiseAttr = (name) => {
    const n = String(name || '').toLowerCase();
    return NOISE_ATTR_NAMES.has(n) || NOISE_ATTR_PREFIXES.some((prefix) => { const p = String(prefix).toLowerCase(); return n === p || n.startsWith(p + '-'); });
  };
  const isNoiseClass = (cls) => NOISE_CLASS_PATTERNS.some((pattern) => String(cls || '').toLowerCase().includes(String(pattern).toLowerCase()));
  const cleanClassList = (list) => Array.from(list || []).filter((cls) => cls && !isNoiseClass(cls));
  const isNoiseNode = (el) => {
    try { return NOISE_SELECTORS.some((sel) => el.matches && el.matches(sel)); }
    catch (_) { return false; }
  };
  const normalizePickedElement = (el) => {
    let current = el;
    while (current && current.parentElement && current !== document.body && isNoiseNode(current)) current = current.parentElement;
    return current || el;
  };
  const textWithoutNoise = (node) => {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
    if (node.nodeType === Node.ELEMENT_NODE && isNoiseNode(node)) return '';
    return Array.from(node.childNodes || []).map(textWithoutNoise).join(' ');
  };
  const cleanupClone = (root) => {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return root;
    try { root.querySelectorAll(NOISE_SELECTORS.join(',')).forEach((node) => node.remove()); } catch (_) {}
    const all = [root].concat(Array.from(root.querySelectorAll('*')));
    for (const node of all) {
      for (const attr of Array.from(node.attributes || [])) {
        if (isNoiseAttr(attr.name)) node.removeAttribute(attr.name);
        else if (attr.name === 'class') {
          const next = cleanClassList(String(attr.value || '').split(/\s+/)).join(' ');
          if (next) node.setAttribute('class', next); else node.removeAttribute('class');
        }
      }
    }
    return root;
  };
  const text = (el, max) => String(textWithoutNoise(el) || '').replace(/\s+/g, ' ').trim().slice(0, max || 240);
  const html = (el, max) => String(cleanupClone(el.cloneNode(true))?.outerHTML || '').replace(/\s+/g, ' ').trim().slice(0, max || 1000);
  const buildSelector = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) {
      const byId = '#' + cssEscape(el.id);
      if (isUnique(byId)) return byId;
    }
    for (const name of ['data-testid','data-test','data-cy','aria-label','name','title']) {
      const value = el.getAttribute(name);
      if (!value) continue;
      const selector = el.tagName.toLowerCase() + attrSelector(name, value);
      if (isUnique(selector)) return selector;
    }
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const testId = current.getAttribute('data-testid') || current.getAttribute('data-test') || current.getAttribute('data-cy');
      if (testId) part += attrSelector(testId === current.getAttribute('data-testid') ? 'data-testid' : current.getAttribute('data-test') ? 'data-test' : 'data-cy', testId);
      else if (current.id) part += '#' + cssEscape(current.id);
      else {
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const buildInfo = (el) => {
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const name of ['id','class','role','aria-label','name','type','href','src','alt','title','data-testid','data-test','data-cy']) {
      if (isNoiseAttr(name)) continue;
      const value = el.getAttribute && el.getAttribute(name);
      if (!value) continue;
      attrs[name] = name === 'class' ? cleanClassList(String(value).split(/\s+/)).join(' ').slice(0, 240) : String(value).slice(0, 240);
      if (!attrs[name]) delete attrs[name];
    }
    const selector = buildSelector(el);
    return {
      selector,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? cleanClassList(el.classList || []).join(' ').slice(0, 240) || null : null,
      role: el.getAttribute('role') || null,
      text: text(el, 500) || null,
      html: html(el, 1000),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      attributes: attrs,
    };
  };
  const selections = [];
  const selectedElements = new Set();
  const previousOutlines = new Map();
  const overlay = document.createElement('div');
  overlay.setAttribute('data-pi-browser-pick', 'overlay');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:transparent;';
  const highlight = document.createElement('div');
  highlight.style.cssText = 'position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.12);box-shadow:0 0 0 1px rgba(255,255,255,0.8);transition:all 60ms ease;pointer-events:none;';
  overlay.appendChild(highlight);
  const banner = document.createElement('div');
  banner.setAttribute('data-pi-browser-pick', 'banner');
  banner.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;max-width:min(900px,calc(100vw - 40px));background:#111827;color:white;padding:12px 16px;border-radius:10px;font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:auto;white-space:normal;';
  const updateBanner = () => { banner.textContent = options.message + ' (' + selections.length + ' selected; ' + (options.multiple ? 'Cmd/Ctrl+click to add, Enter to finish, ' : '') + 'click to pick, Esc to cancel)'; };
  updateBanner();
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(banner);
  let finished = false;
  const cleanup = () => {
    try {
      if (window.__piBrowserActivePickers && window.__piBrowserActivePickers[options.pickId]) delete window.__piBrowserActivePickers[options.pickId];
      if (window.__piBrowserPickCleanupId === options.pickId) {
        delete window.__piBrowserPickCleanup;
        delete window.__piBrowserPickCleanupId;
      }
    } catch (_) {}
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pagehide', onPageHide, true);
    window.removeEventListener('beforeunload', onBeforeUnload, true);
    clearTimeout(timer);
    overlay.remove();
    banner.remove();
    for (const [el, outline] of previousOutlines.entries()) { try { el.style.outline = outline; } catch (_) {} }
  };
  const finish = (cancelled, reason) => {
    if (finished) return;
    finished = true;
    cleanup();
    resolve({
      cancelled,
      reason: reason || null,
      message: options.message,
      selectedCount: selections.length,
      selections,
      selectors: selections.map((item) => item.selector).filter(Boolean),
      url: location.href,
      title: document.title || ''
    });
  };
  try {
    window.__piBrowserActivePickers = window.__piBrowserActivePickers || {};
    window.__piBrowserActivePickers[options.pickId] = { cleanup: (reason) => finish(true, reason || 'external_cleanup'), createdAt: Date.now() };
    window.__piBrowserPickCleanup = window.__piBrowserActivePickers[options.pickId].cleanup;
    window.__piBrowserPickCleanupId = options.pickId;
  } catch (_) {}
  const elementFromEvent = (event) => {
    overlay.style.display = 'none';
    banner.style.display = 'none';
    const el = document.elementFromPoint(event.clientX, event.clientY);
    overlay.style.display = '';
    banner.style.display = '';
    if (!el || el === document.documentElement || el === document.body || overlay.contains(el) || banner.contains(el)) return null;
    return normalizePickedElement(el);
  };
  function onMove(event) {
    const el = elementFromEvent(event);
    if (!el) return;
    const r = el.getBoundingClientRect();
    highlight.style.top = r.top + 'px';
    highlight.style.left = r.left + 'px';
    highlight.style.width = r.width + 'px';
    highlight.style.height = r.height + 'px';
  }
  function addSelection(el) {
    if (!el || selectedElements.has(el)) return;
    selectedElements.add(el);
    previousOutlines.set(el, el.style.outline || '');
    el.style.outline = '3px solid #10b981';
    selections.push(buildInfo(el));
    updateBanner();
  }
  function onClick(event) {
    if (banner.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    const el = elementFromEvent(event);
    if (!el) return;
    if (options.multiple && (event.metaKey || event.ctrlKey)) { addSelection(el); return; }
    if (!selections.length) addSelection(el);
    finish(false, 'click');
  }
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); finish(true, 'escape'); return; }
    if (event.key === 'Enter' && selections.length) { event.preventDefault(); finish(false, 'enter'); }
  }
  function onPageHide() { finish(true, 'pagehide'); }
  function onBeforeUnload() { finish(true, 'beforeunload'); }
  const timer = setTimeout(() => finish(true, 'timeout'), options.timeoutMs);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('pagehide', onPageHide, true);
  window.addEventListener('beforeunload', onBeforeUnload, true);
})`;
}

export function buildPickCleanupScript(pickId: string): string {
	const payload = JSON.stringify({ pickId });
	return String.raw`(() => {
  const options = ${payload};
  const out = { cleaned:false, method:null, overlaysRemoved:0, pickId:options.pickId };
  try {
    const active = window.__piBrowserActivePickers && window.__piBrowserActivePickers[options.pickId];
    if (active && typeof active.cleanup === 'function') {
      active.cleanup('timeout');
      out.cleaned = true;
      out.method = 'active_cleanup';
      return out;
    }
    if (window.__piBrowserPickCleanupId === options.pickId && typeof window.__piBrowserPickCleanup === 'function') {
      window.__piBrowserPickCleanup('timeout');
      out.cleaned = true;
      out.method = 'legacy_cleanup';
      return out;
    }
  } catch (error) {
    out.error = error && error.message ? error.message : String(error);
  }
  try {
    const nodes = Array.from(document.querySelectorAll('[data-pi-browser-pick]'));
    out.overlaysRemoved = nodes.length;
    nodes.forEach((node) => { try { node.remove(); } catch (_) {} });
  } catch (_) {}
  return out;
})()`;
}
