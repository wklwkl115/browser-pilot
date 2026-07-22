import { ACTIONABLE_ATTRIBUTE_NAMES, ACTIONABLE_HIGH_INTENT_PATTERN, ACTIONABLE_KEYWORD_PATTERN, ACTIONABLE_PRIMARY_INTENT_PATTERN, FRAMEWORK_ACTION_HANDLER_PATTERN, FRAMEWORK_HANDLER_OWNER_PATTERN } from "./actionableRules.js";
import { DOM_ACCESSIBILITY_API_BUNDLE } from "./domAccessibilityApiBundle.js";
import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, BROWSER_NOISE_IDS, BROWSER_NOISE_SELECTORS, BROWSER_NOISE_TAGS, SCAN_EXTENSION_URL_PATTERN } from "./noiseRules.js";
import { jsonForInlineScript, renderCaptureTemplate } from "../capture/inject.js";
import { SCAN_TEMPLATE } from "../../capture-src/entries/scanTemplate.js";
import { PAGE_WORLD_SCAN_SCHEMA } from "../kernels/abml/pageWorldScan.js";

export type BrowserScanOptions = {
	textOnly?: boolean;
	maxChars?: number;
	maxNodes?: number;
	includeIframes?: boolean;
	/** Growth-probe wait after scrolling, in ms. Default 300; env BROWSER_PILOT_GROWTH_PROBE_WAIT_MS overrides. Clamped to minimum 80. */
	probeWaitMs?: number;
};

function injectAccessibleNameProvider(script: string): string {
	const markerStart = "  const options = ";
	const markerEnd = ";\n";
	const markerIndex = script.indexOf(markerStart);
	if (markerIndex < 0) throw new Error("scan template options marker missing; update accessible-name provider injection");
	const markerEndIndex = script.indexOf(markerEnd, markerIndex);
	if (markerEndIndex < 0) throw new Error("scan template options terminator missing; update accessible-name provider injection");
	const insertionIndex = markerEndIndex + markerEnd.length;
	const injected = `  const BrowserPilotDomAccessibilityApi = (() => {
    try {
      ${DOM_ACCESSIBILITY_API_BUNDLE}
      return typeof BrowserPilotDomAccessibilityApi === 'object' && BrowserPilotDomAccessibilityApi ? BrowserPilotDomAccessibilityApi : null;
    } catch (_) {
      return null;
    }
  })();
`;
	return script.slice(0, insertionIndex) + injected + script.slice(insertionIndex);
}

function injectGrowthProbe(script: string, probeWaitMs: number): string {
	const marker = "  const rows = collectVisibleRows(scanRoot);\n";
	const injected = `${marker}  async function collectGrowthProbe(root, listHints) {
    const startedAt = Date.now();
    const waitMs = ${probeWaitMs};
    const maxDelta = 800;
    const hints = Array.isArray(listHints) ? listHints : [];
    const candidates = [];
    function scrollMetrics(el) {
      const isDocument = !el || el === document.scrollingElement || el === document.documentElement || el === document.body;
      const scrollTop = isDocument ? (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0) : Number(el.scrollTop || 0);
      const scrollHeight = isDocument ? Math.max(document.documentElement.scrollHeight || 0, document.body.scrollHeight || 0) : Number(el.scrollHeight || 0);
      const clientHeight = isDocument ? Math.max(document.documentElement.clientHeight || 0, innerHeight || 0) : Number(el.clientHeight || 0);
      return { scrollTop, scrollHeight, clientHeight, maxScrollTop: Math.max(0, scrollHeight - clientHeight) };
    }
    function setScrollTop(el, value) {
      const isDocument = !el || el === document.scrollingElement || el === document.documentElement || el === document.body;
      if (isDocument) window.scrollTo(window.scrollX || 0, value);
      else el.scrollTop = value;
    }
    function scrollableAncestor(el) {
      let cur = el;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        try {
          const style = getComputedStyle(cur);
          const metrics = scrollMetrics(cur);
          if (metrics.maxScrollTop > 24 && /(auto|scroll|overlay)/.test(String(style.overflowY || style.overflow || ''))) return cur;
        } catch (_) {}
        cur = cur.parentElement;
      }
      const docMetrics = scrollMetrics(document.scrollingElement || document.documentElement);
      return docMetrics.maxScrollTop > 24 ? (document.scrollingElement || document.documentElement) : null;
    }
    function countItems(selector) {
      if (!selector) return undefined;
      try { return document.querySelectorAll(selector).length; } catch (_) { return undefined; }
    }
    function itemSample(selector) {
      if (!selector) return {};
      try {
        const items = Array.from(document.querySelectorAll(selector)).filter(el => !isIgnored(el) && !isHidden(el));
        const text = (el) => clean(el.innerText || el.textContent || '', 80);
        return { firstText: text(items[0]), lastText: text(items[items.length - 1]) };
      } catch (_) { return {}; }
    }
    async function intersectionSample(selector, rootEl) {
      if (!selector || typeof IntersectionObserver !== 'function') return { intersectionSupported: false };
      let items = [];
      try {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          if (items.length >= 24) break;
          if (!isIgnored(el) && !isHidden(el)) items.push(el);
        }
      } catch (_) { items = []; }
      if (!items.length) return { intersectionSupported: true, intersectingCount: 0 };
      return await new Promise(resolve => {
        const seen = new Set();
        let observer = null;
        let settled = false;
        let timer = null;
        const done = () => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          try { if (observer) observer.disconnect(); } catch (_) {}
          resolve({ intersectionSupported: true, intersectingCount: seen.size });
        };
        try {
          observer = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry && entry.isIntersecting) seen.add(entry.target);
            done();
          }, { root: rootEl === document.scrollingElement || rootEl === document.documentElement || rootEl === document.body ? null : rootEl, threshold: 0.01 });
        } catch (_) {
          resolve({ intersectionSupported: false });
          return;
        }
        try { for (const item of items) observer.observe(item); } catch (_) { done(); return; }
        timer = setTimeout(done, 150);
      });
    }
    for (let hintIndex = 0; hintIndex < hints.length && hintIndex < 8; hintIndex++) {
      const hint = hints[hintIndex];
      if (!hint || typeof hint.selector !== 'string') continue;
      let container = null;
      try {
        const containerSelector = hint.containerSelector || String(hint.selector).split(' > ')[0];
        container = document.querySelector(containerSelector);
      } catch (_) { container = null; }
      const scrollPort = scrollableAncestor(container);
      if (!scrollPort) continue;
      const metrics = scrollMetrics(scrollPort);
      if (metrics.maxScrollTop <= metrics.scrollTop + 24) continue;
      candidates.push({ hint, scrollPort, metrics });
      break;
    }
    if (!candidates.length) {
      const metrics = scrollMetrics(document.scrollingElement || document.documentElement);
      if (metrics.maxScrollTop > metrics.scrollTop + 24) candidates.push({ hint: undefined, scrollPort: document.scrollingElement || document.documentElement, metrics });
    }
    const candidate = candidates[0];
    if (!candidate) return { supported: false, candidateCount: 0, reason: 'no-scroll-growth-candidate', elapsedMs: Date.now() - startedAt };
    const selector = typeof candidate.hint?.selector === 'string' ? candidate.hint.selector : undefined;
    const before = { ...candidate.metrics, count: countItems(selector), ...itemSample(selector) };
    const beforeIntersection = await intersectionSample(selector, candidate.scrollPort);
    const delta = Math.max(1, Math.min(maxDelta, Math.floor(candidate.metrics.clientHeight * 0.8) || maxDelta, candidate.metrics.maxScrollTop - candidate.metrics.scrollTop));
    setScrollTop(candidate.scrollPort, candidate.metrics.scrollTop + delta);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    const afterMetrics = scrollMetrics(candidate.scrollPort);
    const after = { ...afterMetrics, count: countItems(selector), ...itemSample(selector) };
    const afterIntersection = await intersectionSample(selector, candidate.scrollPort);
    setScrollTop(candidate.scrollPort, candidate.metrics.scrollTop);
    await new Promise(resolve => setTimeout(resolve, 0));
    const restored = Math.abs(scrollMetrics(candidate.scrollPort).scrollTop - candidate.metrics.scrollTop) <= 2;
    const beforeCount = Number(before.count);
    const afterCount = Number(after.count);
    const countGrew = Number.isFinite(beforeCount) && Number.isFinite(afterCount) && afterCount > beforeCount;
    const heightGrew = after.scrollHeight > before.scrollHeight;
    const windowShifted = Boolean(selector) && (before.firstText !== after.firstText || before.lastText !== after.lastText);
    return {
      supported: true,
      candidateCount: candidates.length,
      target: selector ? 'listHint' : 'document',
      ...(selector ? { selector } : {}),
      beforeCount: Number.isFinite(beforeCount) ? beforeCount : undefined,
      afterCount: Number.isFinite(afterCount) ? afterCount : undefined,
      beforeScrollTop: Math.round(before.scrollTop),
      afterScrollTop: Math.round(after.scrollTop),
      restoredScrollTop: restored,
      beforeScrollHeight: Math.round(before.scrollHeight),
      afterScrollHeight: Math.round(after.scrollHeight),
      beforeFirstText: before.firstText || undefined,
      afterFirstText: after.firstText || undefined,
      intersectionSupported: beforeIntersection.intersectionSupported === true || afterIntersection.intersectionSupported === true,
      beforeIntersectingCount: beforeIntersection.intersectingCount,
      afterIntersectingCount: afterIntersection.intersectingCount,
      countGrew,
      heightGrew,
      windowShifted,
      elapsedMs: Date.now() - startedAt
    };
  }
  const growthProbe = await collectGrowthProbe(scanRoot, listHints);
`;
	if (!script.includes(marker)) throw new Error("scan template growth probe marker missing; update scan growth injection");
	return script.replace(marker, injected);
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	const safe = Number.isFinite(n) ? Math.floor(n) : fallback;
	return Math.max(min, Math.min(max, safe));
}

const DEFAULT_GROWTH_PROBE_WAIT_MS = 300;

function resolveProbeWaitMs(optionValue: number | undefined): number {
	const raw = process.env.BROWSER_PILOT_GROWTH_PROBE_WAIT_MS;
	if (raw !== undefined) {
		const envValue = Number(raw);
		if (Number.isFinite(envValue)) return Math.max(80, Math.floor(envValue));
	}
	if (optionValue !== undefined) {
		const n = Number(optionValue);
		if (Number.isFinite(n)) return Math.max(80, Math.floor(n));
	}
	return DEFAULT_GROWTH_PROBE_WAIT_MS;
}

export function buildScanScript(options: BrowserScanOptions = {}): string {
	const probeWaitMs = resolveProbeWaitMs(options.probeWaitMs);
	const opts = {
		textOnly: options.textOnly === true,
		maxChars: boundedInt(options.maxChars, 35_000, 1_000, 500_000),
		maxNodes: boundedInt(options.maxNodes, 4_000, 100, 20_000),
		includeIframes: options.includeIframes !== false,
	};
	const rendered = renderCaptureTemplate(SCAN_TEMPLATE, {
		optionsJson: jsonForInlineScript(opts),
		ignoreIdsJson: jsonForInlineScript(BROWSER_NOISE_IDS),
		ignoreTagsJson: jsonForInlineScript(BROWSER_NOISE_TAGS),
		ignoreSelectorsJson: jsonForInlineScript(BROWSER_NOISE_SELECTORS),
		noiseAttrNamesJson: jsonForInlineScript(BROWSER_NOISE_ATTRIBUTE_NAMES),
		noiseAttrPrefixesJson: jsonForInlineScript(BROWSER_NOISE_ATTRIBUTE_PREFIXES),
		noiseClassPatternsJson: jsonForInlineScript(BROWSER_NOISE_CLASS_PATTERNS),
		extensionUrlPatternJson: jsonForInlineScript(SCAN_EXTENSION_URL_PATTERN),
		actionAttrsJson: jsonForInlineScript(ACTIONABLE_ATTRIBUTE_NAMES),
		pageWorldScanSchemaJson: jsonForInlineScript(PAGE_WORLD_SCAN_SCHEMA),
		actionablePatternJson: jsonForInlineScript(ACTIONABLE_KEYWORD_PATTERN),
		highIntentPatternJson: jsonForInlineScript(ACTIONABLE_HIGH_INTENT_PATTERN),
		primaryIntentPatternJson: jsonForInlineScript(ACTIONABLE_PRIMARY_INTENT_PATTERN),
		frameworkOwnerPatternJson: jsonForInlineScript(FRAMEWORK_HANDLER_OWNER_PATTERN),
		frameworkActionPatternJson: jsonForInlineScript(FRAMEWORK_ACTION_HANDLER_PATTERN),
	});
	return injectGrowthProbe(injectAccessibleNameProvider(rendered), probeWaitMs);
}
