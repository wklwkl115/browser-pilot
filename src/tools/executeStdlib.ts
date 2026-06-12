import { resolveRefUriDetailed } from "../resources/resourceStore.js";
import type { RefDescriptor } from "../abml/types.js";

const PI_REF_PATTERN = /pi-ref:\/\/[A-Za-z0-9_-]+\/[^\s"'`<>{}\])]+/g;
const PI_STDLIB_NAMES = ["resolve", "box", "setValue", "settled"] as const;

export type ExecuteStdlibInfo = {
	used: boolean;
	refsEmbedded: number;
	resolveMisses: string[];
	namespace: readonly string[];
	targetRefs?: ExecuteStdlibTargetRef[];
};

export type PreparedExecuteScript = {
	script: string;
	stdlib?: ExecuteStdlibInfo;
};

export type ExecuteStdlibTargetRef = {
	refId: string;
	observedAt?: number;
	observationId?: string;
	url?: string;
	mutationEpoch?: number;
	cssRoots: string[];
};

function shouldInjectStdlib(script: string): boolean {
	PI_REF_PATTERN.lastIndex = 0;
	return /\bpi\s*\./.test(script) || PI_REF_PATTERN.test(script);
}

function collectRefUris(script: string): string[] {
	PI_REF_PATTERN.lastIndex = 0;
	return Array.from(new Set(Array.from(script.matchAll(PI_REF_PATTERN), (match) => match[0])));
}

function safeDescriptor(descriptor: RefDescriptor): RefDescriptor {
	return {
		refId: descriptor.refId,
		kind: descriptor.kind,
		locators: descriptor.locators || [],
		owner: descriptor.owner || {},
		policy: descriptor.policy,
		snapshot: descriptor.snapshot,
		semantic: descriptor.semantic,
		geometry: descriptor.geometry,
		observationId: descriptor.observationId,
		documentEpoch: descriptor.documentEpoch,
		createdAt: descriptor.createdAt,
		ttlMs: descriptor.ttlMs,
		stabilityScore: descriptor.stabilityScore,
	};
}

function boundedCssRoots(descriptor: RefDescriptor): string[] {
	const roots: string[] = [];
	for (const locator of descriptor.locators) {
		if (locator.by !== "css" || !locator.value.trim()) continue;
		roots.push(locator.value.trim());
		if (roots.length >= 8) break;
	}
	return roots;
}

function targetRefFromDescriptor(descriptor: RefDescriptor): ExecuteStdlibTargetRef {
	return {
		refId: descriptor.refId,
		observedAt: descriptor.documentEpoch?.capturedAt ?? descriptor.createdAt,
		observationId: descriptor.observationId,
		url: descriptor.documentEpoch?.url,
		mutationEpoch: descriptor.documentEpoch?.mutationEpoch,
		cssRoots: boundedCssRoots(descriptor),
	};
}

function buildRefRegistry(refUris: string[]): { registry: Record<string, unknown>; embedded: number; misses: string[]; targetRefs: ExecuteStdlibTargetRef[] } {
	const registry: Record<string, unknown> = {};
	const misses: string[] = [];
	const targetRefs: ExecuteStdlibTargetRef[] = [];
	for (const uri of refUris) {
		const resolved = resolveRefUriDetailed(uri);
		if (!resolved.ok) {
			misses.push(uri);
			registry[uri] = { ok: false, code: resolved.code, error: resolved.error };
			continue;
		}
		targetRefs.push(targetRefFromDescriptor(resolved.ref.descriptor));
		registry[uri] = {
			ok: true,
			fresh: resolved.ref.fresh !== false,
			descriptor: safeDescriptor(resolved.ref.descriptor),
		};
	}
	return { registry, embedded: refUris.length - misses.length, misses, targetRefs };
}

function stdlibPrelude(registry: Record<string, unknown>): string {
	return `
const pi = (() => {
  const __registry = ${JSON.stringify(registry)};
  const __names = ["resolve","box","setValue","settled"];
  function __entry(ref) {
    if (typeof ref === "string") return __registry[ref] || null;
    if (ref && typeof ref === "object" && ref.descriptor) return { ok: true, fresh: true, descriptor: ref.descriptor };
    if (ref && typeof ref === "object" && ref.refId && ref.locators) return { ok: true, fresh: true, descriptor: ref };
    return null;
  }
  function __textMatch(el, text, exact) {
    const value = String((el && (el.innerText || el.textContent)) || "").replace(/\\s+/g, " ").trim();
    const target = String(text || "").replace(/\\s+/g, " ").trim();
    return exact ? value === target : value.includes(target);
  }
  function __resolveLocator(locator) {
    if (!locator || typeof locator !== "object") return null;
    try {
      if (locator.by === "css" && locator.value) return document.querySelector(String(locator.value));
      if (locator.by === "xpath" && locator.value) return document.evaluate(String(locator.value), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (locator.by === "point") return document.elementFromPoint(Number(locator.x), Number(locator.y));
      if (locator.by === "textAnchor" && locator.value) {
        const role = locator.role ? String(locator.role) : "";
        const candidates = Array.from(document.querySelectorAll(role ? '[role="' + CSS.escape(role) + '"]' : "body *"));
        return candidates.find(el => __textMatch(el, locator.value, locator.exact === true)) || null;
      }
      if (locator.by === "attrSignature" && locator.value && typeof locator.value === "object") {
        const attrs = locator.value;
        const candidates = Array.from(document.querySelectorAll("iframe,frame,[id],[name],[role]"));
        return candidates.find(el => Object.entries(attrs).every(([key, value]) => String(el.getAttribute(key) || "") === String(value))) || null;
      }
    } catch (_) {
      return null;
    }
    return null;
  }
  function __geometryBox(descriptor) {
    const box = descriptor && descriptor.geometry && descriptor.geometry.box;
    if (box) return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h) };
    const point = descriptor && descriptor.geometry && descriptor.geometry.point;
    if (point) return { x: Math.round(point.x), y: Math.round(point.y), width: 0, height: 0 };
    return null;
  }
  function resolve(ref) {
    const tried = [];
    const entry = __entry(ref);
    if (!entry || entry.ok !== true || !entry.descriptor) return { el: null, freshness: "miss", tried: ["registry"] };
    const descriptor = entry.descriptor;
    for (const locator of Array.isArray(descriptor.locators) ? descriptor.locators : []) {
      tried.push(locator.by || "unknown");
      const el = __resolveLocator(locator);
      if (el) return { el, freshness: entry.fresh === false ? "stale" : "fresh", tried };
    }
    return { el: null, freshness: "miss", tried, geometry: __geometryBox(descriptor) };
  }
  function box(ref) {
    const resolved = resolve(ref);
    if (resolved.el && typeof resolved.el.getBoundingClientRect === "function") {
      const rect = resolved.el.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), freshness: resolved.freshness };
    }
    return resolved.geometry ? { ...resolved.geometry, freshness: resolved.freshness } : null;
  }
  function __setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement ? HTMLInputElement.prototype
      : HTMLSelectElement && el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : null;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set : null;
    if (setter) setter.call(el, value);
    else el.value = value;
  }
  function setValue(target, value) {
    const resolved = target && target.nodeType === 1 ? { el: target, freshness: "direct", tried: [] } : (target && target.el ? target : resolve(target));
    const el = resolved && resolved.el;
    if (!el) return { ok: false, reason: "not_resolved", freshness: resolved && resolved.freshness };
    __setNativeValue(el, String(value ?? ""));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: String(value ?? "") }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { ok: true, freshness: resolved.freshness, tagName: String(el.tagName || "").toLowerCase(), charCount: String(value ?? "").length };
  }
  function settled(quietMs = 150, timeoutMs = 2000) {
    const quiet = Math.max(0, Math.min(1000, Number(quietMs) || 150));
    const timeout = Math.max(quiet, Math.min(10000, Number(timeoutMs) || 2000));
    return new Promise(resolveDone => {
      let mutations = 0;
      let quietTimer;
      const started = Date.now();
      const done = (settled) => {
        clearTimeout(quietTimer);
        observer.disconnect();
        resolveDone({ settled, mutations, elapsedMs: Date.now() - started });
      };
      const observer = new MutationObserver(() => {
        mutations += 1;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => done(true), quiet);
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
      quietTimer = setTimeout(() => done(true), quiet);
      setTimeout(() => done(false), timeout);
    });
  }
  return Object.freeze({ resolve, box, setValue, settled, __namespace: Object.freeze(__names) });
})();
`;
}

export function prepareExecuteStdlib(script: string, options: { enabled?: boolean } = {}): PreparedExecuteScript {
	const enabled = options.enabled ?? process.env.PI_BROWSER_STDLIB !== "0";
	if (!enabled || !shouldInjectStdlib(script)) return { script };
	const refUris = collectRefUris(script);
	const registry = buildRefRegistry(refUris);
	return {
		script: `${stdlibPrelude(registry.registry)}\n${script}`,
		stdlib: {
			used: true,
			refsEmbedded: registry.embedded,
			resolveMisses: registry.misses,
			namespace: PI_STDLIB_NAMES,
			...(registry.targetRefs.length ? { targetRefs: registry.targetRefs } : {}),
		},
	};
}
