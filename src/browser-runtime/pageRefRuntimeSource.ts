export const PAGE_REF_RUNTIME_SOURCE = String.raw`(() => {
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const candidateSelector = "button,input,textarea,select,a[href],img[alt],summary,[role],[aria-label],[aria-labelledby],[tabindex],[contenteditable]:not([contenteditable=\"false\"]),[data-testid],[data-test],[data-e2e]";

  function roleOf(el) {
    const explicit = normalize(el && el.getAttribute && el.getAttribute("role")).split(" ")[0];
    if (explicit) return explicit;
    const tag = String(el && el.tagName || "").toUpperCase();
    if (tag === "INPUT") {
      const type = normalize(el.type || el.getAttribute("type") || "text");
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "search") return el.hasAttribute && el.hasAttribute("list") ? "combobox" : "searchbox";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (["email", "tel", "text", "url"].includes(type)) return el.hasAttribute && el.hasAttribute("list") ? "combobox" : "textbox";
      return "textbox";
    }
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return el.multiple || Number(el.size || 0) > 1 ? "listbox" : "combobox";
    if (tag === "A" && el.getAttribute("href")) return "link";
    if (tag === "CANVAS") return "region";
    if (tag === "IMG") return "img";
    if (el && el.isContentEditable) return "textbox";
    return normalize(tag);
  }

  // Accessible-name rule for <label>Country <select>…</select></label>: the label's text minus the labelled
  // control's own content, so the heuristic agrees with the AX name the observation reported.
  function labelTextExcluding(label, control) {
    if (typeof document.createTreeWalker !== "function" || !control || typeof control.contains !== "function") return label.textContent || "";
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    let out = "";
    let node;
    while ((node = walker.nextNode())) if (!control.contains(node)) out += node.textContent + " ";
    return out;
  }

  function nameOf(el) {
    if (!el) return "";
    const labelledBy = String(el.getAttribute && el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map(id => typeof document.getElementById === "function" ? document.getElementById(id)?.textContent || "" : "").join(" ");
    const labels = el.labels ? Array.from(el.labels).map(label => labelTextExcluding(label, el)).join(" ") : "";
    const type = normalize(el.type || el.getAttribute && el.getAttribute("type"));
    const buttonValue = String(el.tagName || "").toUpperCase() === "INPUT" && ["button", "submit", "reset", "image"].includes(type) ? el.value : "";
    return normalize(el.getAttribute && el.getAttribute("aria-label") || labelledBy || labels || el.getAttribute && el.getAttribute("placeholder") || el.getAttribute && el.getAttribute("alt") || buttonValue || el.innerText || el.textContent || el.getAttribute && el.getAttribute("title") || "");
  }

  function expectedFor(input, locator) {
    const semantic = input && input.semantic || {};
    const rawName = String(semantic.name || "");
    // Observation names are bounded at 160 chars and end with an ellipsis when cut; match them as a prefix.
    const truncated = rawName.endsWith("\u2026");
    const semanticName = normalize(truncated ? rawName.slice(0, -1) : rawName);
    return {
      role: normalize(semantic.role || locator && locator.role),
      name: semanticName || normalize(locator && locator.by === "textAnchor" ? locator.value : ""),
      exact: semanticName ? !truncated : locator && locator.by === "textAnchor" ? locator.exact !== false : true,
      truncated
    };
  }

  function roleMatches(el, expected) {
    if (!expected.role) return true;
    const actualRole = roleOf(el);
    return actualRole === expected.role || ([actualRole, expected.role].includes("img") && [actualRole, expected.role].includes("image"));
  }

  function nameMatches(el, expected) {
    if (!expected.name) return true;
    const actualName = nameOf(el);
    if (expected.truncated) return actualName.startsWith(expected.name);
    return expected.exact ? actualName === expected.name : actualName.includes(expected.name);
  }

  // "Inbox (3)" vs "Inbox (4)": a live counter, not a different control.
  function nameLooselyMatches(el, expected) {
    if (!expected.name) return true;
    const counter = value => {
      const match = String(value).match(/^(.*?)\s*(\(\d+\)|\[\d+\])$/);
      return match ? { label: normalize(match[1]), style: match[2][0] } : null;
    };
    const actual = counter(nameOf(el));
    const wanted = counter(expected.name);
    return !!actual && !!wanted && actual.label === wanted.label && actual.style === wanted.style;
  }

  // Actions (input.strictSemantic) must not fire on a control whose label changed meaning since it was
  // observed ("Follow" -> "Unfollow"); reads may proceed with a warning so scripts can inspect it.
  function nameAcceptable(el, expected, input) {
    if (nameMatches(el, expected)) return { ok: true };
    if (nameLooselyMatches(el, expected)) return { ok: true, warning: "name_counter_changed" };
    if (input && input.strictSemantic) return { ok: false };
    return { ok: true, warning: "name_mismatch" };
  }

  function matches(el, expected) {
    return roleMatches(el, expected) && nameMatches(el, expected);
  }

  function geometryBox(input) {
    const geometry = input && input.geometry || {};
    const box = geometry.box;
    if (box) return { x: Number(box.x), y: Number(box.y), width: Number(box.w ?? box.width), height: Number(box.h ?? box.height) };
    const point = geometry.point || input && input.point;
    return point ? { x: Number(point.x), y: Number(point.y), width: 0, height: 0 } : null;
  }

  function choose(nodes, input, locator) {
    const expected = expectedFor(input, locator);
    const elements = Array.from(new Set(nodes)).filter(el => el && el.nodeType === 1);
    const candidates = elements.filter(el => matches(el, expected));
    if (candidates.length === 1) return { el: candidates[0] };
    if (!candidates.length) {
      // An identity locator (css/xpath/attributes) that lands on exactly one element of the right role is
      // the element we observed; whether a changed accessible name is acceptable depends on the caller.
      const identityLocator = locator && ["css", "xpath", "attrSignature"].includes(locator.by);
      const sameRole = identityLocator ? elements.filter(el => roleMatches(el, expected)) : [];
      if (sameRole.length === 1) {
        const verdict = nameAcceptable(sameRole[0], expected, input);
        if (verdict.ok) return verdict.warning ? { el: sameRole[0], warning: verdict.warning } : { el: sameRole[0] };
      }
      return { reason: nodes.length ? "semantic_mismatch" : "not_found" };
    }
    const target = geometryBox(input);
    if (!target || ![target.x, target.y, target.width, target.height].every(Number.isFinite)) return { reason: "ambiguous", candidateCount: candidates.length };
    const tx = target.x + target.width / 2;
    const ty = target.y + target.height / 2;
    const targetSpan = Math.max(32, Math.hypot(target.width, target.height));
    const nearby = candidates.filter(el => {
      const rect = el.getBoundingClientRect();
      const distance = Math.hypot(rect.left + rect.width / 2 - tx, rect.top + rect.height / 2 - ty);
      return distance <= Math.min(240, Math.max(targetSpan, Math.hypot(rect.width, rect.height)) * 2);
    });
    return nearby.length === 1 ? { el: nearby[0] } : { reason: "ambiguous", candidateCount: candidates.length };
  }

  function nodesFor(locator) {
    try {
      if (locator.by === "css" && locator.value) return Array.from(document.querySelectorAll(String(locator.value)));
      if (locator.by === "xpath" && locator.value) {
        if (typeof XPathResult.ORDERED_NODE_SNAPSHOT_TYPE === "number") {
          const result = document.evaluate(String(locator.value), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          return Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index)).filter(Boolean);
        }
        const result = document.evaluate(String(locator.value), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue ? [result.singleNodeValue] : [];
      }
      if (locator.by === "attrSignature" && locator.value && typeof locator.value === "object") {
        return Array.from(document.querySelectorAll("iframe,frame,[id],[name],[role]")).filter(el => Object.entries(locator.value).every(([key, value]) => String(el.getAttribute(key) || "") === String(value)));
      }
      if (locator.by === "textAnchor" && locator.value) {
        const expected = expectedFor({}, locator);
        return Array.from(document.querySelectorAll(candidateSelector)).filter(el => matches(el, expected));
      }
    } catch (_) {
      return [];
    }
    return [];
  }

  function point(el, input, scroll) {
    if (!el || el.nodeType !== 1) return { ok: false, reason: "not_found" };
    const expected = expectedFor(input || {}, null);
    // el is already the identified node (backend id or unique locator): a role change always means a
    // different control; a name change is judged by nameAcceptable according to the caller's strictness.
    if (!roleMatches(el, expected)) return { ok: false, reason: "semantic_mismatch", actualRole: roleOf(el) };
    const verdict = nameAcceptable(el, expected, input);
    if (!verdict.ok) return { ok: false, reason: "semantic_mismatch", actualName: nameOf(el) };
    const warning = verdict.warning;
    if (scroll && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    const viewportW = Math.max(document.documentElement && document.documentElement.clientWidth || 0, innerWidth || 0);
    const viewportH = Math.max(document.documentElement && document.documentElement.clientHeight || 0, innerHeight || 0);
    if ((!rect.width && !rect.height) || style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none")) return { ok: false, reason: "not_hittable" };
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= viewportH || rect.left >= viewportW) return { ok: false, reason: "outside_viewport" };
    const samples = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
    const found = (x, y) => (warning ? { ok: true, x, y, warning } : { ok: true, x, y });
    if (typeof document.elementFromPoint !== "function") return found(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
    for (const pair of samples) {
      const x = Math.round(Math.max(0, Math.min(viewportW - 1, rect.left + rect.width * pair[0])));
      const y = Math.round(Math.max(0, Math.min(viewportH - 1, rect.top + rect.height * pair[1])));
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return found(x, y);
    }
    return { ok: false, reason: "occluded" };
  }

  // "we found the identified element but its semantics changed" beats "a weaker locator found nothing".
  const REASON_RANK = { not_found: 0, ambiguous: 1, semantic_mismatch: 2 };
  function strongerReason(current, next) {
    return (REASON_RANK[next] || 0) >= (REASON_RANK[current] || 0) ? next : current;
  }

  function resolve(input) {
    const tried = [];
    let fallback = null;
    let fallbackWarning;
    let reason = "not_found";
    for (const locator of Array.isArray(input && input.locators) ? input.locators : []) {
      if (!["css", "xpath", "attrSignature", "textAnchor"].includes(locator && locator.by)) continue;
      tried.push(locator.by);
      const selected = choose(nodesFor(locator), input, locator);
      if (!selected.el) { reason = strongerReason(reason, selected.reason || "not_found"); continue; }
      if (!fallback) { fallback = selected.el; fallbackWarning = selected.warning; }
      if (point(selected.el, input, false).ok) return { ok: true, el: selected.el, tried, actionable: true, ...(selected.warning ? { warning: selected.warning } : {}) };
    }
    if (fallback) return { ok: true, el: fallback, tried, actionable: false, warning: fallbackWarning ? fallbackWarning + "; resolved element is present but not visibly hittable" : "resolved element is present but not visibly hittable" };
    return { ok: false, reason, tried };
  }

  return { point, resolve };
})()`;
