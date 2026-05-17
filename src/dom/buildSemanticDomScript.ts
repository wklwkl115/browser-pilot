import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, BROWSER_NOISE_SELECTORS } from "../scan/noiseRules.ts";

export type SemanticDomSnapshotOptions = {
	maxNodes?: number;
	includeIframes?: boolean;
	textLimit?: number;
};

export type SemanticDomActionOptions = {
	action: "click" | "type";
	nodeId: string;
	selector: string;
	path: string;
	framePath?: string[];
	text?: string;
	clear?: boolean;
	submit?: boolean;
};

function safeInt(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = Math.floor(Number(value));
	return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function buildSemanticDomSnapshotScript(options: SemanticDomSnapshotOptions = {}): string {
	const payload = JSON.stringify({
		maxNodes: safeInt(options.maxNodes, 80, 1, 300),
		includeIframes: options.includeIframes !== false,
		textLimit: safeInt(options.textLimit, 240, 40, 1_000),
		noiseSelectors: BROWSER_NOISE_SELECTORS,
		noiseAttrNames: BROWSER_NOISE_ATTRIBUTE_NAMES,
		noiseAttrPrefixes: BROWSER_NOISE_ATTRIBUTE_PREFIXES,
		noiseClassPatterns: BROWSER_NOISE_CLASS_PATTERNS,
	});
	return String.raw`(() => {
  const options = ${payload};
  const MAX_NODES = options.maxNodes;
  const TEXT_LIMIT = options.textLimit;
  const ROLE_CLICKABLE = new Set(['button','link','menuitem','menuitemcheckbox','menuitemradio','tab','checkbox','radio','switch','option','combobox','textbox','searchbox','spinbutton','slider']);
  const INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','TEXTAREA','SELECT','SUMMARY','LABEL']);
  const SEMANTIC_TAGS = new Set(['H1','H2','H3','H4','H5','H6','P','LI','DT','DD','TH','TD','FIGCAPTION','CAPTION']);
  const NOISE_SELECTORS = options.noiseSelectors || [];
  const NOISE_ATTR_NAMES = new Set((options.noiseAttrNames || []).map((name) => String(name).toLowerCase()));
  const NOISE_ATTR_PREFIXES = options.noiseAttrPrefixes || [];
  const NOISE_CLASS_PATTERNS = options.noiseClassPatterns || [];
  function clean(text, limit) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    const max = Number(limit || TEXT_LIMIT);
    return value.length > max ? value.slice(0, max) + '…' : value;
  }
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  }
  function attrSelector(name, value) { return '[' + name + '="' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]'; }
  function isNoiseAttr(name) {
    const n = String(name || '').toLowerCase();
    return NOISE_ATTR_NAMES.has(n) || NOISE_ATTR_PREFIXES.some((prefix) => { const p = String(prefix).toLowerCase(); return n === p || n.startsWith(p + '-'); });
  }
  function isNoiseClass(cls) { return NOISE_CLASS_PATTERNS.some((pattern) => String(cls || '').toLowerCase().includes(String(pattern).toLowerCase())); }
  function isNoiseNode(el) { try { return NOISE_SELECTORS.some((sel) => el.matches && el.matches(sel)); } catch (_) { return false; } }
  function textWithoutNoise(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
    if (node.nodeType === Node.ELEMENT_NODE && isNoiseNode(node)) return '';
    return Array.from(node.childNodes || []).map(textWithoutNoise).join(' ');
  }
  function isUnique(doc, selector) { try { return doc.querySelectorAll(selector).length === 1; } catch (_) { return false; } }
  function stableSelector(el, doc) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) {
      const byId = '#' + cssEscape(el.id);
      if (isUnique(doc, byId)) return byId;
    }
    for (const name of ['data-testid','data-test','data-cy','aria-label','name','title']) {
      if (isNoiseAttr(name)) continue;
      const value = el.getAttribute(name);
      if (!value) continue;
      const selector = el.tagName.toLowerCase() + attrSelector(name, value);
      if (isUnique(doc, selector)) return selector;
    }
    return cssPath(el, doc);
  }
  function cssPath(el, doc) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== doc.documentElement) {
      let part = current.tagName.toLowerCase();
      if (current.id) part += '#' + cssEscape(current.id);
      else {
        const testId = current.getAttribute('data-testid') || current.getAttribute('data-test') || current.getAttribute('data-cy');
        if (testId) part += attrSelector(current.getAttribute('data-testid') ? 'data-testid' : current.getAttribute('data-test') ? 'data-test' : 'data-cy', testId);
        else {
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          }
        }
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (isUnique(doc, candidate)) return candidate;
      current = current.parentElement;
    }
    return parts.join(' > ');
  }
  function implicitRole(el, tag, type) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (tag === 'A' && el.getAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'INPUT') {
      if (['button','submit','reset','image'].includes(type)) return 'button';
      if (['checkbox'].includes(type)) return 'checkbox';
      if (['radio'].includes(type)) return 'radio';
      if (['range'].includes(type)) return 'slider';
      if (['number'].includes(type)) return 'spinbutton';
      if (['search'].includes(type)) return 'searchbox';
      return 'textbox';
    }
    for (let n = 1; n <= 6; n += 1) if (tag === 'H' + n) return 'heading';
    return null;
  }
  function disabled(el) { return el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.matches('[disabled]'); }
  function editable(el, tag, type) { return !disabled(el) && ((tag === 'INPUT' && !['hidden','button','submit','reset','image','file','checkbox','radio','range','color'].includes(type)) || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true || el.getAttribute('contenteditable') === 'true'); }
  function clickable(el, tag, role) {
    if (disabled(el)) return false;
    const hasInteractiveTag = INTERACTIVE_TAGS.has(tag) && !(tag === 'A' && !el.getAttribute('href'));
    const tabindex = el.getAttribute('tabindex');
    const pointer = (() => { try { const view = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window; return view.getComputedStyle(el).cursor === 'pointer'; } catch (_) { return false; } })();
    return hasInteractiveTag || ROLE_CLICKABLE.has(String(role || '').toLowerCase()) || typeof el.onclick === 'function' || (tabindex !== null && Number(tabindex) >= 0) || pointer;
  }
  function intersectRects(a, b) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  function visibleRect(el, offsetX, offsetY, clipRect) {
    const r = el.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return null;
    const view = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    const out = { x: r.x + offsetX, y: r.y + offsetY, width: r.width, height: r.height };
    if (out.x + out.width <= clipRect.x || out.y + out.height <= clipRect.y || out.x >= clipRect.x + clipRect.width || out.y >= clipRect.y + clipRect.height) return null;
    return { x: Math.round(out.x), y: Math.round(out.y), width: Math.round(out.width), height: Math.round(out.height) };
  }
  function summarizeElement(el, doc, framePath, rect) {
    const tag = el.tagName;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    const role = implicitRole(el, tag, type);
    const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '';
    const text = clean(textWithoutNoise(el), TEXT_LIMIT);
    const isEditable = editable(el, tag, type);
    const isClickable = clickable(el, tag, role);
    const semantic = SEMANTIC_TAGS.has(tag) || !!role || !!ariaLabel;
    if (!isClickable && !isEditable && !semantic) return null;
    if (isNoiseNode(el)) return null;
    return {
      tag: tag.toLowerCase(),
      role,
      text,
      ariaLabel: clean(ariaLabel, 160) || null,
      clickable: isClickable,
      editable: isEditable,
      disabled: disabled(el),
      selector: stableSelector(el, doc),
      path: cssPath(el, doc),
      framePath: framePath.slice(),
      bbox: rect,
      inputType: type || null,
      href: tag === 'A' ? el.href || null : null,
    };
  }
  const rootViewport = { width: Math.max(document.documentElement.clientWidth || 0, innerWidth || 0), height: Math.max(document.documentElement.clientHeight || 0, innerHeight || 0) };
  const rootClip = { x: 0, y: 0, width: rootViewport.width, height: rootViewport.height };
  const nodes = [];
  const frames = [];
  let visited = 0;
  function collect(doc, framePath, offsetX, offsetY, depth, clipRect) {
    if (!doc || !doc.documentElement || nodes.length >= MAX_NODES) return;
    const all = Array.from(doc.querySelectorAll('body *'));
    for (const el of all) {
      if (nodes.length >= MAX_NODES) break;
      visited += 1;
      const rect = visibleRect(el, offsetX, offsetY, clipRect);
      if (!rect) continue;
      const item = summarizeElement(el, doc, framePath, rect);
      if (item) nodes.push(item);
    }
    if (!options.includeIframes || depth >= 2 || nodes.length >= MAX_NODES) return;
    for (const frame of Array.from(doc.querySelectorAll('iframe,frame'))) {
      if (nodes.length >= MAX_NODES) break;
      const rect = visibleRect(frame, offsetX, offsetY, clipRect);
      if (!rect) continue;
      const frameClip = intersectRects(clipRect, rect);
      if (!frameClip) continue;
      const selector = stableSelector(frame, doc);
      try {
        const child = frame.contentDocument;
        if (!child) throw new Error('no contentDocument');
        frames.push({ selector, accessible: true, url: frame.src || 'about:srcdoc', bbox: rect });
        collect(child, framePath.concat(selector), rect.x, rect.y, depth + 1, frameClip);
      } catch (error) {
        frames.push({ selector, accessible: false, url: frame.src || '', bbox: rect, error: error && error.message ? error.message : String(error) });
      }
    }
  }
  collect(document, [], 0, 0, 0, rootClip);
  return { url: location.href, title: document.title || '', viewport: rootViewport, nodes, nodeCount: nodes.length, visited, truncated: nodes.length >= MAX_NODES, frames };
})()`;
}

export function buildSemanticDomActionScript(options: SemanticDomActionOptions): string {
	const payload = JSON.stringify({
		action: options.action,
		nodeId: options.nodeId,
		selector: options.selector,
		path: options.path,
		framePath: options.framePath || [],
		text: options.text || "",
		clear: options.clear !== false,
		submit: options.submit === true,
	});
	return String.raw`(() => {
  const options = ${payload};
  const ROLE_CLICKABLE = new Set(['button','link','menuitem','menuitemcheckbox','menuitemradio','tab','checkbox','radio','switch','option','combobox','textbox','searchbox','spinbutton','slider']);
  const INTERACTIVE_TAGS = new Set(['A','BUTTON','INPUT','TEXTAREA','SELECT','SUMMARY','LABEL']);
  function structuredError(code, message, details) { const error = new Error(message); error.code = code; error.details = details || {}; throw error; }
  function clean(text, limit) { const value = String(text || '').replace(/\s+/g, ' ').trim(); const max = Number(limit || 240); return value.length > max ? value.slice(0, max) + '…' : value; }
  function resolveDocument(framePath) {
    let doc = document;
    for (const selector of framePath || []) {
      let frame;
      try { frame = doc.querySelector(selector); }
      catch (error) { structuredError('DOM_NODE_FRAME_SELECTOR_INVALID', 'Invalid frame selector for semantic DOM node', { selector, nodeId: options.nodeId }); }
      if (!frame) structuredError('DOM_NODE_FRAME_NOT_FOUND', 'Frame for semantic DOM node was not found; refresh browser_dom_snapshot', { selector, nodeId: options.nodeId });
      try { doc = frame.contentDocument; }
      catch (error) { structuredError('DOM_NODE_FRAME_INACCESSIBLE', 'Frame for semantic DOM node is not accessible; refresh browser_dom_snapshot', { selector, nodeId: options.nodeId }); }
      if (!doc) structuredError('DOM_NODE_FRAME_INACCESSIBLE', 'Frame for semantic DOM node is not accessible; refresh browser_dom_snapshot', { selector, nodeId: options.nodeId });
    }
    return doc;
  }
  function findElement(doc) {
    const selectors = [options.selector, options.path].filter(Boolean);
    for (const selector of selectors) {
      try {
        const match = doc.querySelector(selector);
        if (match) return match;
      } catch (error) {
        if (selector === options.selector) structuredError('DOM_NODE_SELECTOR_INVALID', 'Stored selector for semantic DOM node is invalid; refresh browser_dom_snapshot', { selector, nodeId: options.nodeId });
      }
    }
    structuredError('DOM_NODE_NOT_FOUND', 'Semantic DOM node was not found; refresh browser_dom_snapshot', { nodeId: options.nodeId, selector: options.selector, path: options.path });
  }
  function disabled(el) { return el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.matches('[disabled]'); }
  function role(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (tag === 'A' && el.getAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') return ['checkbox','radio'].includes(type) ? type : 'textbox';
    return null;
  }
  function editable(el) {
    const tag = el.tagName;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    return !disabled(el) && ((tag === 'INPUT' && !['hidden','button','submit','reset','image','file','checkbox','radio','range','color'].includes(type)) || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true || el.getAttribute('contenteditable') === 'true');
  }
  function clickable(el) {
    if (disabled(el)) return false;
    const tag = el.tagName;
    const currentRole = role(el);
    const hasInteractiveTag = INTERACTIVE_TAGS.has(tag) && !(tag === 'A' && !el.getAttribute('href'));
    const tabindex = el.getAttribute('tabindex');
    const pointer = (() => { try { const localView = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window; return localView.getComputedStyle(el).cursor === 'pointer'; } catch (_) { return false; } })();
    return hasInteractiveTag || ROLE_CLICKABLE.has(String(currentRole || '').toLowerCase()) || typeof el.onclick === 'function' || (tabindex !== null && Number(tabindex) >= 0) || pointer;
  }
  function dispatchInputEvents(el, inputType, data) {
    const localView = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : view;
    const InputEventCtor = localView.InputEvent || view.InputEvent;
    try {
      if (!InputEventCtor) throw new Error('InputEvent unavailable');
      el.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType: inputType || 'insertText', data: data ?? null }));
    } catch (_) {
      el.dispatchEvent(new localView.Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new localView.Event('change', { bubbles: true }));
  }
  function nativeValueSetter(el) {
    const localView = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : view;
    const proto = el instanceof localView.HTMLInputElement ? localView.HTMLInputElement.prototype : el instanceof localView.HTMLTextAreaElement ? localView.HTMLTextAreaElement.prototype : el instanceof localView.HTMLSelectElement ? localView.HTMLSelectElement.prototype : null;
    return proto ? Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set : null;
  }
  function setNativeValue(el, value) {
    const setter = nativeValueSetter(el);
    if (setter) setter.call(el, value); else el.value = value;
  }
  function rootOffset(framePath) {
    let doc = document;
    let x = 0;
    let y = 0;
    for (const selector of framePath || []) {
      const frame = doc.querySelector(selector);
      if (!frame) break;
      const r = frame.getBoundingClientRect();
      x += r.x;
      y += r.y;
      doc = frame.contentDocument || doc;
    }
    return { x, y };
  }
  function summary(el) {
    const r = el.getBoundingClientRect();
    const offset = rootOffset(options.framePath);
    return { nodeId: options.nodeId, selector: options.selector, tag: el.tagName.toLowerCase(), role: role(el), text: clean(el.innerText || el.textContent || '', 240), ariaLabel: el.getAttribute('aria-label') || null, clickable: clickable(el), editable: editable(el), disabled: disabled(el), framePath: (options.framePath || []).slice(), bbox: { x: Math.round(r.x + offset.x), y: Math.round(r.y + offset.y), width: Math.round(r.width), height: Math.round(r.height) } };
  }
  const doc = resolveDocument(options.framePath);
  const view = doc.defaultView || window;
  const el = findElement(doc);
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (options.action === 'click') {
    if (disabled(el)) structuredError('DOM_NODE_DISABLED', 'Semantic DOM node is disabled', { nodeId: options.nodeId, selector: options.selector });
    if (!clickable(el) || typeof el.click !== 'function') structuredError('DOM_NODE_NOT_CLICKABLE', 'Semantic DOM node is not clickable', { nodeId: options.nodeId, selector: options.selector, tag: el.tagName.toLowerCase(), role: role(el) });
    el.click();
    return { action: 'click', clicked: true, target: summary(el), url: location.href, title: document.title || '' };
  }
  if (options.action === 'type') {
    if (!editable(el)) structuredError('DOM_NODE_NOT_EDITABLE', 'Semantic DOM node is not editable', { nodeId: options.nodeId, selector: options.selector, tag: el.tagName.toLowerCase() });
    const text = String(options.text || '');
    el.focus && el.focus();
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const next = options.clear === false ? String(el.value || '') + text : text;
      setNativeValue(el, next);
      dispatchInputEvents(el, 'insertText', text);
    } else if (tag === 'SELECT') {
      setNativeValue(el, text);
      dispatchInputEvents(el, 'insertReplacementText', text);
    } else {
      if (options.clear !== false) el.textContent = '';
      const localView = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : view;
      const sel = localView.getSelection && localView.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      const ok = doc.execCommand && doc.execCommand('insertText', false, text);
      if (!ok) el.textContent = String(el.textContent || '') + text;
      dispatchInputEvents(el, 'insertText', text);
    }
    if (options.submit) {
      const form = el.form || el.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (form && typeof form.submit === 'function') form.submit();
    }
    const value = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ? el.value : el.textContent;
    return { action: 'type', typed: true, submitted: options.submit === true, valueLength: String(value || '').length, finalValuePreview: clean(value, 300), target: summary(el), url: location.href, title: document.title || '' };
  }
  structuredError('DOM_NODE_ACTION_UNSUPPORTED', 'Unsupported semantic DOM action', { action: options.action, nodeId: options.nodeId });
})()`;
}
