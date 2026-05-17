import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, BROWSER_NOISE_SELECTORS } from "../scan/noiseRules.ts";

export type ElementActionOptions =
	| { action: "query"; selector: string; all?: boolean; limit?: number; visibleOnly?: boolean }
	| { action: "click"; selector: string; index?: number }
	| { action: "type"; selector: string; index?: number; text: string; clear?: boolean; submit?: boolean };

export function buildElementActionScript(options: ElementActionOptions): string {
	const payload = JSON.stringify({
		...options,
		noiseSelectors: BROWSER_NOISE_SELECTORS,
		noiseAttrNames: BROWSER_NOISE_ATTRIBUTE_NAMES,
		noiseAttrPrefixes: BROWSER_NOISE_ATTRIBUTE_PREFIXES,
		noiseClassPatterns: BROWSER_NOISE_CLASS_PATTERNS,
	});
	return String.raw`(() => {
  const options = ${payload};
  const HTML_SNIPPET_LIMIT = 500;
  const TEXT_SNIPPET_LIMIT = 300;
  const ATTR_VALUE_LIMIT = 240;
  function trim(text, limit) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    const max = Number(limit || TEXT_SNIPPET_LIMIT);
    return value.length > max ? value.slice(0, max) + '…' : value;
  }
  function structuredError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details || {};
    throw error;
  }
  function safeQueryAll(selector) {
    try { return Array.from(document.querySelectorAll(String(selector || ''))); }
    catch (error) { structuredError('INVALID_SELECTOR', 'Invalid selector "' + selector + '": ' + (error && error.message ? error.message : String(error)), { selector: selector }); }
  }
  function isVisible(el, rect) {
    if (!rect || (rect.width === 0 && rect.height === 0)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function(ch) { return '\\' + ch; });
  }
  const NOISE_SELECTORS = options.noiseSelectors || [];
  const NOISE_ATTR_NAMES = new Set((options.noiseAttrNames || []).map(function(name) { return String(name).toLowerCase(); }));
  const NOISE_ATTR_PREFIXES = options.noiseAttrPrefixes || [];
  const NOISE_CLASS_PATTERNS = options.noiseClassPatterns || [];
  function attrSelector(name, value) {
    return '[' + name + '="' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
  }
  function isNoiseAttr(name) {
    const n = String(name || '').toLowerCase();
    return NOISE_ATTR_NAMES.has(n) || NOISE_ATTR_PREFIXES.some(function(prefix) { const p = String(prefix).toLowerCase(); return n === p || n.startsWith(p + '-'); });
  }
  function isNoiseClass(cls) {
    const value = String(cls || '').toLowerCase();
    return NOISE_CLASS_PATTERNS.some(function(pattern) { return value.includes(String(pattern).toLowerCase()); });
  }
  function isNoiseNode(el) {
    try { return NOISE_SELECTORS.some(function(sel) { return el.matches && el.matches(sel); }); }
    catch (_) { return false; }
  }
  function cleanClassList(list) { return Array.from(list || []).filter(function(cls) { return cls && !isNoiseClass(cls); }); }
  function isUnique(selector) {
    try { return document.querySelectorAll(selector).length === 1; } catch (_) { return false; }
  }
  function stableSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) {
      const byId = '#' + cssEscape(el.id);
      if (isUnique(byId)) return byId;
    }
    const stableAttrs = ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'title'];
    for (const name of stableAttrs) {
      const value = el.getAttribute(name);
      if (!value) continue;
      const candidate = el.tagName.toLowerCase() + attrSelector(name, value);
      if (isUnique(candidate)) return candidate;
    }
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const testId = current.getAttribute('data-testid') || current.getAttribute('data-test') || current.getAttribute('data-cy');
      if (testId) {
        const attrName = current.getAttribute('data-testid') ? 'data-testid' : current.getAttribute('data-test') ? 'data-test' : 'data-cy';
        part += attrSelector(attrName, testId);
      } else if (current.id) {
        part += '#' + cssEscape(current.id);
      } else {
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(function(child) { return child.tagName === current.tagName; });
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      current = current.parentElement;
    }
    return parts.join(' > ');
  }
  function textWithoutNoise(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return '';
    if (node.nodeType === Node.ELEMENT_NODE && isNoiseNode(node)) return '';
    return Array.from(node.childNodes || []).map(textWithoutNoise).join(' ');
  }
  function cleanupClone(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return root;
    try { root.querySelectorAll(NOISE_SELECTORS.join(',')).forEach(function(node) { node.remove(); }); } catch (_) {}
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
  }
  function sanitizedOuterHtml(el) {
    const clone = cleanupClone(el.cloneNode(true));
    return trim(clone && clone.outerHTML || '', HTML_SNIPPET_LIMIT);
  }
  function summarize(el, index) {
    const rect = el.getBoundingClientRect();
    const attrs = {};
    const passwordField = el instanceof HTMLInputElement && el.type === 'password';
    for (const attr of Array.from(el.attributes || [])) {
      if (isNoiseAttr(attr.name)) continue;
      if (attr.name === 'class') {
        const classes = cleanClassList(String(attr.value || '').split(/\s+/)).join(' ');
        if (classes) attrs[attr.name] = trim(classes, ATTR_VALUE_LIMIT);
        continue;
      }
      attrs[attr.name] = passwordField && attr.name.toLowerCase() === 'value' ? '[redacted]' : trim(attr.value, ATTR_VALUE_LIMIT);
    }
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.matches('[disabled]');
    return {
      index: index,
      selector: stableSelector(el),
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: cleanClassList(el.classList || []).slice(0, 20),
      role: el.getAttribute('role'),
      text: trim(textWithoutNoise(el), TEXT_SNIPPET_LIMIT),
      attrs: attrs,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible: isVisible(el, rect),
      disabled: disabled,
      type: el.getAttribute('type') || null,
      valueLength: typeof el.value === 'string' ? el.value.length : undefined,
      outerHtmlSnippet: sanitizedOuterHtml(el)
    };
  }
  function scrollIntoCenter(el) {
    try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); }
    catch (_) { try { el.scrollIntoView(); } catch (__) {} }
  }
  function pickMatch(nodes, index) {
    const idx = Number.isInteger(Number(index)) ? Number(index) : 0;
    if (!nodes.length) structuredError('ELEMENT_NOT_FOUND', 'No element matches selector: ' + options.selector, { selector: options.selector });
    if (idx < 0 || idx >= nodes.length) structuredError('ELEMENT_INDEX_OUT_OF_RANGE', 'Index ' + idx + ' out of range for ' + nodes.length + ' matches', { selector: options.selector, index: idx, totalMatches: nodes.length });
    return { el: nodes[idx], index: idx };
  }
  function valuePreview(value) {
    const text = String(value || '');
    return text.length > 1000 ? text.slice(0, 1000) + '…' : text;
  }
  function dispatchInputEvents(el) {
    try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null })); }
    catch (_) { el.dispatchEvent(new Event('input', { bubbles: true })); }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, value); else el.value = value;
    dispatchInputEvents(el);
  }
  function typeInto(el, text, clear) {
    const value = String(text || '');
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      const next = clear === false ? String(el.value || '') + value : value;
      setNativeValue(el, next);
      return { finalValue: el.type === 'password' ? '[redacted password field]' : valuePreview(el.value), valueLength: String(el.value || '').length, redacted: el.type === 'password' };
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      el.focus();
      if (clear !== false) el.textContent = '';
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      const ok = document.execCommand && document.execCommand('insertText', false, value);
      if (!ok) el.textContent = (clear === false ? String(el.textContent || '') : '') + value;
      dispatchInputEvents(el);
      return { finalValue: valuePreview(el.textContent), valueLength: String(el.textContent || '').length, redacted: false };
    }
    structuredError('ELEMENT_NOT_TYPEABLE', 'Element is not typeable: <' + el.tagName.toLowerCase() + '>', { selector: options.selector, tagName: el.tagName.toLowerCase() });
  }
  function submitFrom(el) {
    const form = el.form || (el.closest && el.closest('form'));
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
      return true;
    }
    const eventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    return false;
  }
  const nodes = safeQueryAll(options.selector);
  if (options.action === 'query') {
    const visibleOnly = options.visibleOnly === true;
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit || 10))));
    const summaries = visibleOnly ? nodes.map(function(el, index) { return summarize(el, index); }) : null;
    const filteredSummaries = visibleOnly ? summaries.filter(function(summary) { return summary.visible; }) : null;
    const filtered = visibleOnly ? filteredSummaries : nodes;
    const sliced = options.all === false ? filtered.slice(0, 1) : filtered.slice(0, limit);
    return {
      action: 'query',
      url: location.href,
      title: document.title || '',
      selector: options.selector,
      visibleOnly: visibleOnly,
      totalMatches: nodes.length,
      filteredMatches: filtered.length,
      returnedMatches: sliced.length,
      matches: visibleOnly ? sliced : sliced.map(function(el) { return summarize(el, nodes.indexOf(el)); })
    };
  }
  if (options.action === 'click') {
    const picked = pickMatch(nodes, options.index);
    scrollIntoCenter(picked.el);
    if (typeof picked.el.click !== 'function') structuredError('ELEMENT_NOT_CLICKABLE', 'Element at index ' + picked.index + ' is not clickable: <' + picked.el.tagName.toLowerCase() + '>', { selector: options.selector, index: picked.index, tagName: picked.el.tagName.toLowerCase() });
    const beforeUrl = location.href;
    const beforeTitle = document.title || '';
    picked.el.click();
    return { action: 'click', url: beforeUrl, title: beforeTitle, selector: options.selector, index: picked.index, clicked: true, target: summarize(picked.el, picked.index) };
  }
  if (options.action === 'type') {
    const picked = pickMatch(nodes, options.index);
    scrollIntoCenter(picked.el);
    const typed = typeInto(picked.el, options.text, options.clear);
    const submitted = options.submit === true ? submitFrom(picked.el) : false;
    return { action: 'type', url: location.href, title: document.title || '', selector: options.selector, index: picked.index, submitted: submitted, target: summarize(picked.el, picked.index), finalValue: typed.finalValue, valueLength: typed.valueLength, redacted: typed.redacted };
  }
  structuredError('UNSUPPORTED_ELEMENT_ACTION', 'Unsupported element action: ' + options.action, { action: options.action });
})()`;
}
