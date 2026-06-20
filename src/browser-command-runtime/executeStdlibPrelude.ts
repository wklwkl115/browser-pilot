export const BROWSER_PILOT_STDLIB_NAMES = ["resolve", "box", "setValue", "settled"] as const;

export function stdlibPrelude(registry: Record<string, unknown>): string {
	return `
const browserPilot = (() => {
  const __registry = ${JSON.stringify(registry)};
  const __names = ${JSON.stringify(BROWSER_PILOT_STDLIB_NAMES)};
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
  function __rect(el) {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    try { return el.getBoundingClientRect(); } catch (_) { return null; }
  }
  function __samplePoints(rect) {
    const viewportW = Math.max(document.documentElement && document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const viewportH = Math.max(document.documentElement && document.documentElement.clientHeight || 0, window.innerHeight || 0);
    if (!rect || !viewportW || !viewportH) return [];
    const samples = [[0.5,0.5],[0.25,0.5],[0.75,0.5],[0.5,0.25],[0.5,0.75]];
    return samples.map(pair => ({
      x: Math.round(Math.max(0, Math.min(viewportW - 1, rect.left + rect.width * pair[0]))),
      y: Math.round(Math.max(0, Math.min(viewportH - 1, rect.top + rect.height * pair[1])))
    }));
  }
  function __actionablePoint(el) {
    if (!el || el.nodeType !== 1) return undefined;
    const rect = __rect(el);
    if (!rect) return undefined;
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    const viewportW = Math.max(document.documentElement && document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const viewportH = Math.max(document.documentElement && document.documentElement.clientHeight || 0, window.innerHeight || 0);
    const cssVisible = !!(rect.width || rect.height) && (!cs || (cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0" && cs.pointerEvents !== "none"));
    const rectVisible = cssVisible && rect.bottom > 0 && rect.right > 0 && rect.top < viewportH && rect.left < viewportW;
    if (!rectVisible) return undefined;
    if (typeof document.elementFromPoint !== "function") return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    for (const point of __samplePoints(rect)) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || hit === el || el.contains(hit) || (hit.contains && hit.contains(el))) return point;
    }
    return undefined;
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
    if (!entry || entry.ok !== true || !entry.descriptor) {
      console.warn("[browser-pilot] ref resolution miss:", ref, "tried:", ["registry"].join(","));
      return { el: null, freshness: "miss", tried: ["registry"], warning: "element not found for ref - script will receive null" };
    }
    const descriptor = entry.descriptor;
    let fallback = null;
    for (const locator of Array.isArray(descriptor.locators) ? descriptor.locators : []) {
      tried.push(locator.by || "unknown");
      const el = __resolveLocator(locator);
      if (!fallback && el) fallback = el;
      if (__actionablePoint(el)) return { el, freshness: entry.fresh === false ? "stale" : "fresh", tried };
    }
    if (fallback) return { el: fallback, freshness: entry.fresh === false ? "stale" : "fresh", tried, warning: "resolved element is present but not visibly hittable" };
    console.warn("[browser-pilot] ref resolution miss:", ref, "tried:", tried.join(","));
    return { el: null, freshness: "miss", tried, geometry: __geometryBox(descriptor), warning: "element not found for ref - script will receive null" };
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
