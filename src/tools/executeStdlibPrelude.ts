export const PI_STDLIB_NAMES = ["resolve", "box", "setValue", "settled", "click"] as const;

const PI_CLICK_BINDING_PLACEHOLDER = "__PI_BROWSER_STDLIB_CLICK_BINDING__";

export function scriptReferencesClick(script: string): boolean {
	return /\bpi\s*\.\s*click\b/.test(script);
}

export function stdlibPrelude(registry: Record<string, unknown>, options: { click: boolean }): string {
	return `
const pi = (() => {
  const __registry = ${JSON.stringify(registry)};
  const __names = ${JSON.stringify(options.click ? PI_STDLIB_NAMES : PI_STDLIB_NAMES.filter((name) => name !== "click"))};
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
${options.click ? `
  function __backendTarget(descriptor) {
    const ownerTargetId = descriptor && descriptor.owner && typeof descriptor.owner.targetId === "string" && descriptor.owner.targetId.trim() ? descriptor.owner.targetId.trim() : undefined;
    for (const locator of Array.isArray(descriptor && descriptor.locators) ? descriptor.locators : []) {
      if (locator && locator.by === "backendNodeId" && Number.isFinite(Number(locator.value))) {
        const targetId = typeof locator.targetId === "string" && locator.targetId.trim() ? locator.targetId.trim() : ownerTargetId;
        return { backendNodeId: Number(locator.value), ...(targetId ? { targetId } : {}) };
      }
    }
    return ownerTargetId ? { targetId: ownerTargetId } : {};
  }
  function __point(descriptor) {
    const point = descriptor && descriptor.geometry && descriptor.geometry.point;
    if (point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) return { x: Number(point.x), y: Number(point.y) };
    for (const locator of Array.isArray(descriptor && descriptor.locators) ? descriptor.locators : []) {
      if (locator && locator.by === "point" && Number.isFinite(Number(locator.x)) && Number.isFinite(Number(locator.y))) return { x: Number(locator.x), y: Number(locator.y) };
    }
    return undefined;
  }
  function __safeTarget(descriptor) {
    const backendTarget = __backendTarget(descriptor);
    const point = __point(descriptor);
    return { refId: descriptor.refId, ...backendTarget, ...(point ? { point } : {}) };
  }
` : ""}
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
${options.click ? `
  const __clickBindingName = ${JSON.stringify(PI_CLICK_BINDING_PLACEHOLDER)};
  let __clickSeq = 0;
  const __clickPending = new Map();
  function click(ref, options = {}) {
    if (!__clickBindingName || typeof window[__clickBindingName] !== "function") return Promise.reject(Object.assign(new Error("pi.click binding unavailable"), { code: "PI_CLICK_BINDING_UNAVAILABLE" }));
    const entry = __entry(ref);
    if (!entry || entry.ok !== true || !entry.descriptor) return Promise.reject(Object.assign(new Error("pi.click ref not resolved"), { code: "PI_CLICK_REF_NOT_RESOLVED" }));
    const requestId = "click-" + Date.now().toString(36) + "-" + (++__clickSeq).toString(36);
    const timeoutMs = Math.max(100, Math.min(30000, Number(options && options.timeoutMs) || 10000));
    const payload = { requestId, action: "click", target: __safeTarget(entry.descriptor) };
    return new Promise((resolveClick, rejectClick) => {
      const timer = setTimeout(() => {
        __clickPending.delete(requestId);
        rejectClick(Object.assign(new Error("pi.click timed out"), { code: "PI_CLICK_TIMEOUT" }));
      }, timeoutMs);
      __clickPending.set(requestId, { resolve: resolveClick, reject: rejectClick, timer });
      try { window[__clickBindingName](JSON.stringify(payload)); }
      catch (error) {
        clearTimeout(timer);
        __clickPending.delete(requestId);
        rejectClick(error);
      }
    });
  }
  window.__piBrowserStdlibResolve = function(requestId, payload) {
    const pending = __clickPending.get(String(requestId || ""));
    if (!pending) return false;
    __clickPending.delete(String(requestId || ""));
    clearTimeout(pending.timer);
    if (payload && payload.ok === false) {
      const err = new Error(String(payload.error || payload.error_code || "pi.click failed"));
      err.code = payload.error_code;
      err.details = payload.details;
      pending.reject(err);
    } else {
      pending.resolve(payload && payload.data !== undefined ? payload.data : payload);
    }
    return true;
  };
  window.__piBrowserStdlibRejectAll = function(reason) {
    for (const [requestId, pending] of Array.from(__clickPending.entries())) {
      __clickPending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(String(reason || "pi.click cancelled")), { code: "PI_CLICK_CANCELLED" }));
    }
    return true;
  };
` : ""}
  return Object.freeze({ resolve, box, setValue, settled${options.click ? ", click" : ""}, __namespace: Object.freeze(__names) });
})();
`;
}
