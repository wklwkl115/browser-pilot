// Page-world source. buildScanScript serializes this function and passes a JSON-only config.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Keep serialized page-world source as plain JavaScript.
// @ts-nocheck

export function scanPage(config: any) {
  const options = config.options;
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','CANVAS','META','LINK','SOURCE','PICTURE','COLGROUP','COL','PARAM']);
  const IGNORE_IDS = new Set(config.ignoreIds);
  const IGNORE_TAGS = new Set(config.ignoreTags);
  const IGNORE_SELECTORS = config.ignoreSelectors;
  const NOISE_CLASS_PATTERNS = config.noiseClassPatterns;
  const EXTENSION_URL_RE = new RegExp(config.extensionUrlPattern, 'i');
  const KEEP_EMPTY = new Set(['INPUT','TEXTAREA','SELECT','BUTTON','IMG','IFRAME','VIDEO','A']);
  const ACTION_ATTRS = config.actionAttrs;
  const ACTIONABLE_RE = new RegExp(config.actionablePattern, 'i');
  const HIGH_INTENT_RE = new RegExp(config.highIntentPattern, 'i');
  const PRIMARY_INTENT_RE = new RegExp(config.primaryIntentPattern, 'i');
  const FRAMEWORK_OWNER_RE = new RegExp(config.frameworkOwnerPattern, 'i');
  const FRAMEWORK_ACTION_RE = new RegExp(config.frameworkActionPattern);
  let truncated = false;
  const STYLE_CACHE = new WeakMap();
  const HIDDEN_CACHE = new WeakMap();
  const IGNORED_CACHE = new WeakMap();
  const HANDLER_CACHE = new WeakMap();
  function styleOf(el) {
    let style = STYLE_CACHE.get(el);
    if (!style) { style = getComputedStyle(el); STYLE_CACHE.set(el, style); }
    return style;
  }

  function clean(text, max = 400) {
    text = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > max) {
      return text.slice(0, max) + '…';
    }
    return text;
  }
  function safeSemanticLabel(text, max = 160) {
    const value = clean(text, max);
    if (!value) return '';
    if (/[<>]|<\/?(?:svg|path|script|style)\b/i.test(value)) return '';
    if (/\b(?:viewbox|xmlns|fill-rule|clip-rule)\b/i.test(value)) return '';
    if (/^\s*(?:[#.]?[a-z][\w-]*|[a-z][\w-]*(?:\[[^\]]+\])?)(?:\s*[>+~]\s*[#.\w\-:[\]="']+){1,}\s*$/i.test(value)) return '';
    const separators = (value.match(/[|•·,;:：，；、]/g) || []).length;
    const lower = value.toLowerCase();
    const moneyTokens = (value.match(/(?:[$€£¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:usd|eur|gbp|cny|rmb|元|美元|人民币)|(?:input|output|cache|token|price|billing|per\s+1m|pricing|计费|价格|输入|输出|缓存|倍率))/gi) || []).length;
    const fieldWords = (lower.match(/\b(?:input|output|cache|cached|context|price|rate|billing|plan|model|request|token|usage|free|pro|enterprise)\b/g) || []).length + (value.match(/(?:输入|输出|缓存|价格|计费|模型|倍率|上下文|请求|额度|套餐)/g) || []).length;
    if (moneyTokens >= 2 || (moneyTokens && (fieldWords >= 2 || separators >= 2)) || (fieldWords >= 4 && separators >= 2)) return '';
    return value;
  }
  const ACCESSIBLE_NAME_LIMIT = 240;
  let accessibleNameCount = 0;
  function computedAccessibleName(el, max = 160) {
    if (!el || accessibleNameCount >= ACCESSIBLE_NAME_LIMIT) return '';
    const provider = BrowserPilotDomAccessibilityApi && BrowserPilotDomAccessibilityApi.computeAccessibleName;
    if (typeof provider !== 'function') return '';
    accessibleNameCount++;
    try { return safeSemanticLabel(provider(el, { computedStyleSupportsPseudoElements: false }), max); }
    catch (_) { return ''; }
  }
  const LOW_VALUE_PROVIDER_ROLES = new Set(['generic','presentation','none']);
  function roleProviderRole(el) {
    if (!el || !el.getAttribute) return null;
    if (el.getAttribute('role')) return null;
    const provider = BrowserPilotDomAccessibilityApi && BrowserPilotDomAccessibilityApi.getRole;
    if (typeof provider !== 'function') return null;
    try {
      const role = clean(provider(el), 80).toLowerCase();
      return role && !LOW_VALUE_PROVIDER_ROLES.has(role) ? role : null;
    } catch (_) { return null; }
  }
  function explicitRoleOf(el) {
    const explicit = el && el.getAttribute && el.getAttribute('role');
    if (!explicit) return null;
    const role = clean(String(explicit).trim().split(/\s+/)[0], 80).toLowerCase();
    return role || null;
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
  function isExtensionUrl(value) {
    return typeof value === 'string' && EXTENSION_URL_RE.test(value);
  }
  function matchesIgnoredSelector(el) {
    try { return IGNORE_SELECTORS.some(sel => (el.matches && el.matches(sel)) || (el.closest && el.closest(sel))); }
    catch (_) { return false; }
  }
  function isIgnored(el) {
    if (IGNORED_CACHE.has(el)) return IGNORED_CACHE.get(el);
    const ignored = IGNORE_IDS.has(el.id || '') || IGNORE_TAGS.has(el.tagName) || matchesIgnoredSelector(el) || el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'hidden' || (el.tagName === 'IFRAME' || el.tagName === 'IMG') && isExtensionUrl(attrValue(el, 'src'));
    IGNORED_CACHE.set(el, ignored);
    return ignored;
  }
  function isHidden(el) {
    if (HIDDEN_CACHE.has(el)) return HIDDEN_CACHE.get(el);
    let hidden = false;
    try {
      const style = styleOf(el);
      hidden = el.hidden || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 && !KEEP_EMPTY.has(el.tagName);
    } catch (_) { /* Style access failed; keep the visible fallback. */ }
    HIDDEN_CACHE.set(el, hidden);
    return hidden;
  }
  function isSvgInteractive(el) {
    if (el.tagName !== 'svg' && el.tagName !== 'SVG' && !(el instanceof SVGElement)) return false;
    if (el.getAttribute('onclick') || el.getAttribute('tabindex') != null || el.getAttribute('role')) return true;
    try {
      if (el.querySelector('a,a[href],[onclick],[tabindex],[role="button"],[role="link"]')) return true;
    } catch (_) { return false; }
    return false;
  }
  function topLayerRoot(doc, elements) {
    try { const modal = doc.querySelector(':modal'); if (modal && !isIgnored(modal) && !isHidden(modal)) return modal; } catch (_) { /* Unsupported selector. */ }
    const body = doc.body || doc.documentElement;
    if (!body) return null;
    const vw = Math.max(doc.documentElement.clientWidth || 0, innerWidth || 0);
    const vh = Math.max(doc.documentElement.clientHeight || 0, innerHeight || 0);
    const viewportArea = Math.max(1, vw * vh);
    const candidates = [];
    for (const el of elements) {
      if (isIgnored(el) || isHidden(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 120 || r.height < 120) continue;
      const style = styleOf(el);
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
  function nativeRoleOf(el) {
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute && el.hasAttribute('href') ? 'link' : null;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const t = String(el.type || '').toLowerCase();
      if (t === 'radio') return 'radio';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return el.hasAttribute && el.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (['email','tel','text','url'].includes(t)) return el.hasAttribute && el.hasAttribute('list') ? 'combobox' : 'textbox';
      return 'textbox';
    }
    if (tag === 'SELECT') return el.multiple || Number(el.size || 0) > 1 ? 'listbox' : 'combobox';
    return null;
  }
  function roleOf(el) {
    return explicitRoleOf(el) || roleProviderRole(el) || nativeRoleOf(el);
  }
  function actionNameOf(el) {
    if (!el.getAttribute) return '';
    for (const name of ACTION_ATTRS) {
      const value = el.getAttribute(name);
      if (value) return clean(value, 120);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return ''; // form controls take their name from the associated label, never id/class
    const id = el.id || '';
    if (ACTIONABLE_RE.test(id)) return clean(id, 120);
    const cls = cleanClassValue(el.className && typeof el.className === 'object' ? el.className.baseVal || '' : el.className || '').split(/\s+/).find(part => ACTIONABLE_RE.test(part));
    return clean(cls || '', 120);
  }
  function labelOf(el) {
    const computedName = computedAccessibleName(el, 160);
    if (computedName) return computedName;
    const tag = el.tagName;
    const fromAttrs = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('data-e2e') || el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy'));
    if (fromAttrs) return safeSemanticLabel(fromAttrs, 160) || clean(fromAttrs, 160);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      try {
        const labels = el.labels;
        if (labels && labels.length) {
          const labelText = labels[0].innerText || labels[0].textContent || '';
          if (labelText.trim()) return safeSemanticLabel(labelText, 160) || clean(labelText, 160);
        }
      } catch (_) { /* Ignore inaccessible labels and use the value fallback. */ }
      if ((tag === 'INPUT' || tag === 'TEXTAREA') && el.value) return clean(el.value, 160);
    }
    return safeSemanticLabel(el.innerText || el.textContent || '', 160) || clean(el.innerText || el.textContent || '', 160);
  }
  function safePreviewOf(el) {
    return clean(el && (el.innerText || el.textContent || el.outerHTML) || '', 180);
  }
  function conciseContainerLabel(text) {
    return safeSemanticLabel(text, 120);
  }
  function headingLabelNear(el) {
    try {
      let cur = el;
      for (let depth = 0; cur && depth < 3; depth++, cur = cur.parentElement) {
        const heading = cur.querySelector && cur.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],legend,caption,.sr-only,.visually-hidden,.screen-reader-text');
        const label = heading && conciseContainerLabel(heading.innerText || heading.textContent || '');
        if (label) return label;
      }
    } catch (_) { return ''; }
    return '';
  }
  function containerLabelOf(el) {
    const computedName = computedAccessibleName(el, 120);
    if (computedName) return computedName;
    if (el && el.getAttribute) {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const parts = [];
        for (const id of String(labelledBy).split(/\s+/).filter(Boolean).slice(0, 4)) {
          const ref = document.getElementById(id);
          if (ref) parts.push(ref.innerText || ref.textContent || '');
        }
        const byRef = conciseContainerLabel(parts.join(' '));
        if (byRef) return byRef;
      }
      const fromAttrs = el.getAttribute('aria-label') || el.getAttribute('title');
      const attrLabel = conciseContainerLabel(fromAttrs);
      if (attrLabel) return attrLabel;
    }
    return headingLabelNear(el);
  }
  function pseudoText(el) {
    try {
      const before = getComputedStyle(el, '::before').content;
      const after = getComputedStyle(el, '::after').content;
      let bText = '';
      let aText = '';
      if (before && before !== 'none' && before !== 'normal' && before !== '""' && before !== "''") {
        bText = before.replace(/^["']|["']$/g, '').trim();
      }
      if (after && after !== 'none' && after !== 'normal' && after !== '""' && after !== "''") {
        aText = after.replace(/^["']|["']$/g, '').trim();
      }
      return { before: bText, after: aText };
    } catch (_) { return { before: '', after: '' }; }
  }
  let pseudoCheckCount = 0;
  const PSEUDO_CHECK_LIMIT = 200;
  function editable(el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !['hidden','button','submit','reset','checkbox','radio','file','image'].includes(String(el.type || '').toLowerCase());
    return el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  }
  function frameworkHandlers(el) {
    const cached = HANDLER_CACHE.get(el);
    if (cached) return cached;
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
    } catch (_) { /* Ignore inaccessible framework internals. */ }
    HANDLER_CACHE.set(el, out);
    return out;
  }
  function clickable(el, style) {
    const tag = el.tagName;
    const role = String(roleOf(el) || '').toLowerCase();
    if ((tag === 'A' && el.hasAttribute && el.hasAttribute('href')) || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'LABEL' || tag === 'VIDEO') return true;
    if (tag === 'CANVAS' && (el.onclick || el.getAttribute('onclick') || el.getAttribute('aria-label') || el.getAttribute('title') || (style && style.cursor === 'pointer'))) return true;
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
  const SIBLING_SELECTOR_CACHE = new WeakMap();
  function siblingSelectorInfo(parent, el) {
    let cache = SIBLING_SELECTOR_CACHE.get(parent);
    if (!cache) {
      const counts = new Map();
      const order = new WeakMap();
      for (const child of Array.from(parent.children)) {
        const tag = child.tagName;
        const next = (counts.get(tag) || 0) + 1;
        counts.set(tag, next);
        order.set(child, next);
      }
      cache = { counts, order };
      SIBLING_SELECTOR_CACHE.set(parent, cache);
    }
    const tag = el.tagName;
    return { index: cache.order.get(el) || 1, total: cache.counts.get(tag) || 1 };
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
        const siblingInfo = siblingSelectorInfo(parent, cur);
        if (siblingInfo.total > 1) part += ':nth-of-type(' + siblingInfo.index + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }
  // Resolve an aria-controls/aria-owns idref list to target selectors, recording each target (even
  // hidden/collapsed — e.g. a closed combobox listbox or accordion panel) so it can be emitted as a
  // minimal entity and the controls/owns/expandedTarget relation can resolve. The AX tree omits
  // ignored/collapsed targets, so the DOM scan is the reliable source for these.
  function refTargets(el, attr, refElements) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (!v) return [];
    const out = [];
    for (const id of String(v).split(/\s+/).filter(Boolean)) {
      const target = document.getElementById(id);
      if (!target) continue;
      const sel = selectorFor(target);
      out.push(sel);
      if (refElements && !refElements.has(sel)) refElements.set(sel, { selector: sel, role: roleOf(target), name: labelOf(target) || clean(target.innerText || target.textContent || '', 80) || '', hidden: isHidden(target) });
    }
    return out;
  }
  function hitTargetInfo(hit, owner) {
    const tag = hit.tagName ? hit.tagName.toLowerCase() : '';
    const differs = hit && hit !== owner;
    const inputLabel = differs && (tag === 'input' || tag === 'textarea' || tag === 'select') && hit.getAttribute ? clean(hit.getAttribute('aria-label') || hit.getAttribute('placeholder') || hit.getAttribute('name') || '', 120) : '';
    return { tag, id: hit.id || '', class: cleanClassValue(hit.className && typeof hit.className === 'object' ? hit.className.baseVal || '' : hit.className || '').slice(0, 80), text: clean(hit.innerText || hit.textContent || '', 80), ...(inputLabel ? { inputLabel } : {}) };
  }
  function borrowedHitTargetLabel(visible) {
    return visible && visible.hitTarget ? clean(visible.hitTarget.inputLabel || '', 160) : '';
  }
  let hitTestIndex = 0;
  function visibleInfo(el) {
    const r = el.getBoundingClientRect();
    const vw = Math.max(document.documentElement.clientWidth || 0, innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, innerHeight || 0);
    const inViewport = !!r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    let hitOk = null;
    let hitTarget = null;
    let occluderSelector = null;
    if (inViewport && document.elementFromPoint) {
      const elIdx = hitTestIndex++;
      const cx = Math.round(Math.max(0, Math.min(vw - 1, r.left + r.width * 0.5)));
      const cy = Math.round(Math.max(0, Math.min(vh - 1, r.top + r.height * 0.5)));
      const centerHit = document.elementFromPoint(cx, cy);
      const centerOk = !centerHit || centerHit === el || el.contains(centerHit) || (centerHit.contains && centerHit.contains(el));
      if (centerHit) hitTarget = hitTargetInfo(centerHit, el);
      if (centerOk) {
        hitOk = true;
      } else {
        if (centerHit && !occluderSelector) occluderSelector = selectorFor(centerHit);
        if (elIdx < 200) {
          const tlx = Math.round(Math.max(0, Math.min(vw - 1, r.left + r.width * 0.25)));
          const tly = Math.round(Math.max(0, Math.min(vh - 1, r.top + r.height * 0.25)));
          const cornerHit = document.elementFromPoint(tlx, tly);
          const cornerOk = !cornerHit || cornerHit === el || el.contains(cornerHit) || (cornerHit.contains && cornerHit.contains(el));
          if (cornerOk) { hitOk = true; if (cornerHit) hitTarget = hitTargetInfo(cornerHit, el); }
          else { hitOk = false; if (cornerHit && !occluderSelector) occluderSelector = selectorFor(cornerHit); }
        } else {
          hitOk = false;
        }
      }
    }
    const rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    const documentRect = { x: Math.round(r.x + (window.scrollX || 0)), y: Math.round(r.y + (window.scrollY || 0)), width: Math.round(r.width), height: Math.round(r.height) };
    const point = { x: Math.round(Math.max(0, Math.min(vw - 1, r.left + r.width / 2))), y: Math.round(Math.max(0, Math.min(vh - 1, r.top + r.height / 2))) };
    return { inViewport, hitOk, hitTarget, occluderSelector, rect, documentRect, point };
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
  function edgeUtilityHint(visible, style) {
    const r = visible && visible.rect ? visible.rect : {};
    const vw = Math.max(document.documentElement.clientWidth || 0, innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, innerHeight || 0);
    const pos = String(style && style.position || '');
    const small = Number(r.width || 0) > 0 && Number(r.height || 0) > 0 && Number(r.width || 0) <= 180 && Number(r.height || 0) <= 180;
    const nearEdge = Number(r.x || 0) <= 32 || Number(r.y || 0) <= 32 || Number(r.x || 0) + Number(r.width || 0) >= vw - 32 || Number(r.y || 0) + Number(r.height || 0) >= vh - 32;
    return { position: pos, edgeUtility: (pos === 'fixed' || pos === 'sticky') && small && nearEdge };
  }
  function collectActionables(root, refElements, elements) {
    if (!root) return [];
    const source = elements;
    const out = [];
    let scanned = 0;
    for (const el of source) {
      if (++scanned > Math.min(options.maxNodes, 4000)) break;
      if (!el || el.nodeType !== Node.ELEMENT_NODE || (SKIP.has(el.tagName) && el.tagName !== 'CANVAS') || isIgnored(el) || isHidden(el)) continue;
      if ((el.tagName === 'svg' || el.tagName === 'SVG') && !isSvgInteractive(el)) continue;
      const style = styleOf(el);
      const handlers = frameworkHandlers(el);
      const action = actionNameOf(el);
      const isEditable = editable(el);
      const isClickable = clickable(el, style);
      if (!isEditable && !isClickable) continue;
      const visible = visibleInfo(el);
      if (!visible.inViewport) continue;
      const checkedAttr = el.getAttribute && el.getAttribute('aria-checked');
      const checkedState = (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) ? !!el.checked : checkedAttr === 'true' ? true : checkedAttr === 'false' ? false : undefined;
      const selectedAttr = el.getAttribute && el.getAttribute('aria-selected');
      const selectedState = typeof el.selected === 'boolean' ? el.selected : selectedAttr === 'true' ? true : selectedAttr === 'false' ? false : undefined;
      const pressedAttr = el.getAttribute && el.getAttribute('aria-pressed');
      const currentAttr = el.getAttribute && el.getAttribute('aria-current');
      const controlsSelectors = refTargets(el, 'aria-controls', refElements);
      const ownsSelectors = refTargets(el, 'aria-owns', refElements);
      const expandedAttr = el.getAttribute && el.getAttribute('aria-expanded');
      const edgeHint = edgeUtilityHint(visible, style);
      let label = labelOf(el);
      let elText = clean(el.innerText || el.textContent || '', 120);
      if (pseudoCheckCount < PSEUDO_CHECK_LIMIT) {
        pseudoCheckCount++;
        const ps = pseudoText(el);
        if (ps.before || ps.after) {
          if (!label) label = [ps.before, clean(el.innerText || el.textContent || '', 140), ps.after].filter(Boolean).join(' ').trim();
          elText = [ps.before, elText, ps.after].filter(Boolean).join(' ').trim();
        }
      }
      const displayLabel = !label ? borrowedHitTargetLabel(visible) : '';
      const item = { index: out.length, selector: selectorFor(el), tag: el.tagName.toLowerCase(), role: roleOf(el), action, label, ...(displayLabel ? { displayLabel } : {}), text: elText, clickable: isClickable, editable: isEditable, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', focused: document.activeElement === el, ...(checkedState === undefined ? {} : { checked: checkedState }), ...(selectedState === undefined ? {} : { selected: selectedState }), ...((pressedAttr === 'true' || pressedAttr === 'false') ? { pressed: pressedAttr === 'true' } : {}), ...((expandedAttr === 'true' || expandedAttr === 'false') ? { expanded: expandedAttr === 'true' } : {}), ...(currentAttr ? { current: currentAttr } : {}), ...(el.tagName === 'INPUT' && el.type ? { inputKind: String(el.type).toLowerCase() } : {}), ...(controlsSelectors.length ? { controlsSelectors } : {}), ...(ownsSelectors.length ? { ownsSelectors } : {}), ...((expandedAttr === 'true' || expandedAttr === 'false') && controlsSelectors.length ? { expandedTargetSelectors: controlsSelectors } : {}), ...(edgeHint.position ? { position: edgeHint.position } : {}), ...(edgeHint.edgeUtility ? { edgeUtility: true } : {}), handlers: handlers.slice(0, 6), rect: visible.rect, documentRect: visible.documentRect, point: visible.point, hitOk: visible.hitOk, hitTarget: visible.hitTarget, ...((el.tagName === 'A' || el.tagName === 'AREA') && el.href ? { href: String(el.href) } : {}), ...(visible.hitOk === false && visible.occluderSelector ? { occluderSelector: visible.occluderSelector } : {}) };
      item.priority = scoreActionable(item);
      out.push(item);
    }
    return out.sort((a, b) => b.priority - a.priority || a.rect.y - b.rect.y || a.rect.x - b.rect.x).slice(0, 80).map((item, index) => ({ ...item, index }));
  }
  function collectListHints(root, elements) {
    if (!root) return [];
    const containers = elements;
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
        const containerLabel = containerLabelOf(container);
        hints.push({ selector: selectorFor(container) + ' > ' + key, ...(containerLabel ? { containerLabel } : {}), itemCount: items.length, hiddenCount: Math.max(0, items.length - 3), firstItemPreview: safePreviewOf(items[0]), sampleHidden: items.slice(3, 8).map(item => clean(item.innerText || item.textContent || '', 80)).filter(Boolean) });
      }
    }
    return hints.sort((a, b) => b.hiddenCount - a.hiddenCount || b.itemCount - a.itemCount).slice(0, 12);
  }
  function collectCanvasRegions(root) {
    if (!root || !root.querySelectorAll) return [];
    const canvases = Array.from(root.querySelectorAll('canvas'));
    const out = [];
    for (const el of canvases) {
      if (!el || isIgnored(el) || isHidden(el)) continue;
      const visible = visibleInfo(el);
      if (!visible.inViewport) continue;
      const label = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.id || 'canvas region', 120);
      out.push({ index: out.length, tag: 'canvas', role: el.getAttribute('role') || 'img', action: label, label, selector: selectorFor(el), point: visible.point, rect: visible.rect, hitOk: visible.hitOk, clickable: clickable(el, styleOf(el)) });
    }
    return out.slice(0, 12);
  }
  const documentRoot = document.body || document.documentElement;
  const documentNodes = documentRoot && documentRoot.querySelectorAll ? documentRoot.querySelectorAll('*') : [];
  const nodeLimit = Math.max(1, options.maxNodes);
  const documentElements = Array.prototype.slice.call(documentNodes, 0, nodeLimit);
  // ponytail: custom overlays are sampled from the DOM tail; widen only if traces show early-DOM overlays are missed.
  const topLayerElements = documentNodes.length > nodeLimit ? Array.prototype.slice.call(documentNodes, -nodeLimit) : documentElements;
  const topRoot = topLayerRoot(document, topLayerElements);
  const scanRoot = topRoot || documentRoot;
  const scanNodes = topRoot && topRoot.querySelectorAll ? topRoot.querySelectorAll('*') : documentNodes;
  const scanElements = scanRoot ? [scanRoot].concat(Array.prototype.slice.call(scanNodes, 0, Math.max(0, nodeLimit - 1))) : [];
  const nodeCount = scanElements.length;
  if (scanNodes.length > Math.max(0, nodeLimit - 1)) truncated = true;
  // Collect aria-controls/aria-owns/aria-expanded pairings page-wide so the relation resolves even
  // when the source element is scrolled off-screen and never made the actionable list. We record
  // both the target (for entity building) AND a sourceSelector→targetSelectors map so the relation
  // can be emitted without needing the source in primary_entities. Capped at 100 pairs.
  function collectControlsPairs(root) {
    if (!root) return { targets: [], pairs: [] };
    const targetMap = new Map();
    const pairs = [];
    const all = Array.from((root === document.body || root === document.documentElement ? root : document).querySelectorAll('[aria-controls],[aria-owns]'));
    for (const el of all) {
      if (pairs.length >= 100) break;
      const ctlSelectors = refTargets(el, 'aria-controls', targetMap);
      const ownsSelectors = refTargets(el, 'aria-owns', targetMap);
      const expandedAttr = el.getAttribute && el.getAttribute('aria-expanded');
      if (!ctlSelectors.length && !ownsSelectors.length) continue;
      pairs.push({
        sourceSelector: selectorFor(el),
        sourceRole: roleOf(el),
        sourceName: labelOf(el) || clean(el.innerText || el.textContent || '', 60) || '',
        ...(ctlSelectors.length ? { controlsSelectors: ctlSelectors } : {}),
        ...(ownsSelectors.length ? { ownsSelectors } : {}),
        ...((expandedAttr === 'true' || expandedAttr === 'false') && ctlSelectors.length ? { expandedTargetSelectors: ctlSelectors } : {}),
      });
    }
    return { targets: Array.from(targetMap.values()), pairs };
  }
  const refElements = new Map();
  hitTestIndex = 0;
  pseudoCheckCount = 0;
  const actionables = collectActionables(scanRoot, refElements, scanElements);
  const { targets: refTargetsList, pairs: controlsPairs } = collectControlsPairs(scanRoot);
  const references = refTargetsList;
  const listHints = collectListHints(scanRoot, scanElements);
  const canvasRegions = collectCanvasRegions(scanRoot);
  const rawPageText = String(document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
  const pageText = rawPageText.slice(0, options.maxChars);
  if (rawPageText.length > pageText.length) truncated = true;
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
    .slice(0, 100)
    .map(node => String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter(Boolean);
  const scanFingerprint = {
    changeSeq: Number((globalThis.__browserPilotScanFingerprintSeq = Number(globalThis.__browserPilotScanFingerprintSeq || 0) + 1)),
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibleCount: actionables.length,
    interactiveCount: document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[tabindex]").length,
    capturedAt: Date.now()
  };
  return {
    schema: config.pageWorldScanSchema,
    page: {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      ...(navigator.language ? { language: String(navigator.language) } : {})
    },
    content: {
      text: pageText,
      headings
    },
    structure: {
      actionables: [
        ...actionables,
        ...references.map(item => ({ ...item, referenceOnly: true })),
        ...controlsPairs.map(item => ({ ...item, relationOnly: true }))
      ],
      listHints,
      canvasRegions
    },
    signals: {
      fingerprint: scanFingerprint
    },
    stats: {
      nodeCount,
      outputChars: pageText.length,
      truncated
    }
  };
}
