import { PAGE_REF_RUNTIME_SOURCE } from "../browser-runtime/pageRefRuntimeSource.js";

export const BROWSER_PILOT_STDLIB_NAMES = ["refs", "resolve", "box", "setValue", "settled"] as const;

export function stdlibPrelude(registry: Record<string, unknown>, bindings: Record<string, string> = {}): string {
	return `
const browserPilot = (() => {
  const __registry = ${JSON.stringify(registry)};
  const __bindings = ${JSON.stringify(bindings)};
  const __refRuntime = ${PAGE_REF_RUNTIME_SOURCE};
  const __names = ${JSON.stringify(BROWSER_PILOT_STDLIB_NAMES)};
  function __entry(ref) {
    if (typeof ref === "string") return __registry[ref] || null;
    if (ref && typeof ref === "object" && ref.descriptor) return { ok: true, fresh: true, descriptor: ref.descriptor };
    if (ref && typeof ref === "object" && ref.refId && ref.locators) return { ok: true, fresh: true, descriptor: ref };
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
    if (!entry || entry.ok !== true || !entry.descriptor) {
      console.warn("[browser-pilot] ref resolution miss:", ref, "tried:", ["registry"].join(","));
      return { el: null, freshness: "miss", tried: ["registry"], warning: "element not found for ref - script will receive null" };
    }
    const descriptor = entry.descriptor;
    const resolved = __refRuntime.resolve(descriptor);
    tried.push(...resolved.tried);
    if (resolved.ok) return { el: resolved.el, freshness: entry.fresh === false ? "stale" : "fresh", tried, ...(resolved.warning ? { warning: resolved.warning } : {}) };
    console.warn("[browser-pilot] ref resolution miss:", ref, "tried:", tried.join(","));
    return { el: null, freshness: "miss", tried, geometry: __geometryBox(descriptor), reason: resolved.reason, warning: "element not found for ref - script will receive null" };
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
  const __resolvedBindings = new Map();
  const refs = {};
  for (const [name, ref] of Object.entries(__bindings)) Object.defineProperty(refs, name, {
    enumerable: true,
    get() {
      if (!__resolvedBindings.has(name)) __resolvedBindings.set(name, resolve(ref).el);
      return __resolvedBindings.get(name);
    }
  });
  Object.freeze(refs);
  return Object.freeze({ refs, resolve, box, setValue, settled, __namespace: Object.freeze(__names) });
})();
`;
}
