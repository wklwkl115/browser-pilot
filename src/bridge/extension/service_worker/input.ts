import { persistentCdpSend } from "./cdp";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";
import { PAGE_REF_RUNTIME_SOURCE } from "../../../browser-runtime/pageRefRuntimeSource";

const INPUT_CDP_SESSION_NAME = "browser-pilot-input";
const TIMEOUT_MS = 15000;
type Sent = { method: string; type?: string };
type RefPoint = { x: number; y: number; to?: { x: number; y: number }; grounded?: JsonRecord; cdpRoute?: JsonRecord };
type BackendTarget = { backendNodeId: number; targetId?: string };
type LiveNode = { backendNodeId: number; objectId: string; targetId?: string };
type CdpSender = (
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	method: string,
	params: JsonRecord,
	targetId?: string,
) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;

/** Actions a screenshot-grounded (visual) ref accepts: pure pointer gestures plus text insertion at the point. */
const VISUAL_REF_ACTIONS = new Set(["click", "hover", "wheel", "drag", "type"]);
/** Actions a DOM/AX-grounded ref accepts: the click family plus form-control verbs that need a live node. */
const LIVE_REF_ACTIONS = new Set(["click", "hover", "type", "focus", "check", "select"]);
const REF_ACTIONS = [...new Set([...VISUAL_REF_ACTIONS, ...LIVE_REF_ACTIONS])];
const CTRL_MODIFIER = 2;

function rec(v: unknown): JsonRecord {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : {};
}
function err(error_code: string, error: string, details: JsonRecord = {}): BrowserPilotBridgeResponse {
	return { ok: false, error_code, error, details };
}
function ok(data: JsonRecord): BrowserPilotBridgeResponse<JsonRecord> {
	return { ok: true, data };
}
function timeout(msg: BrowserPilotBridgeCommand): number {
	const n = Number(msg.timeoutMs ?? msg.timeout_ms ?? TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : TIMEOUT_MS;
}
function num(v: unknown, k: string): number {
	const n = Number(v);
	if (!Number.isFinite(n)) throw new Error(`${k} must be a finite number`);
	return n;
}
function opt(v: unknown): number | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}
function button(v: unknown): string {
	const s = String(v || "left").toLowerCase();
	return ["left", "middle", "right", "back", "forward", "none"].includes(s) ? s : "left";
}
function modBit(k: string): number {
	k = k.toLowerCase();
	return k === "alt" || k === "option"
		? 1
		: k === "ctrl" || k === "control"
			? 2
			: k === "meta" || k === "cmd" || k === "command" || k === "win"
				? 4
				: k === "shift"
					? 8
					: 0;
}
function mods(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
	if (Array.isArray(v)) return v.reduce((m, item) => m | modBit(String(item || "")), 0);
	let m = 0;
	for (const [k, enabled] of Object.entries(rec(v))) if (enabled) m |= modBit(k);
	return m;
}
function points(v: unknown): Array<{ x: number; y: number }> {
	if (!Array.isArray(v)) return [];
	const out: Array<{ x: number; y: number }> = [];
	for (const item of v) {
		const r = rec(item),
			x = opt(r.x),
			y = opt(r.y);
		if (x !== undefined && y !== undefined) out.push({ x, y });
	}
	return out;
}
function line(
	from: { x: number; y: number },
	to: { x: number; y: number },
	steps = 8,
): Array<{ x: number; y: number }> {
	const out: Array<{ x: number; y: number }> = [];
	const n = Math.max(2, Math.min(40, Math.trunc(steps)));
	for (let i = 1; i < n; i += 1) {
		const t = i / n;
		out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
	}
	out.push(to);
	return out;
}
const defaultCdpSender: CdpSender = async (tabId, msg, method, params, targetId) =>
	await persistentCdpSend(tabId, method, params, {
		name: INPUT_CDP_SESSION_NAME,
		persistent: true,
		timeoutMs: timeout(msg),
		...(targetId ? { targetId } : {}),
	});
let cdpSender: CdpSender = defaultCdpSender;

/** Test seam: swap the CDP transport so input sequencing can be verified without a browser. */
function setInputCdpSenderForTests(sender?: CdpSender): void {
	cdpSender = sender ?? defaultCdpSender;
}

async function cdp(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	method: string,
	params: JsonRecord,
	targetId?: string,
): Promise<BrowserPilotBridgeResponse<JsonRecord>> {
	return await cdpSender(tabId, msg, method, params, targetId);
}
async function focus(tabId: number, msg: BrowserPilotBridgeCommand): Promise<JsonRecord> {
	const r = await cdp(
		tabId,
		msg,
		"Emulation.setFocusEmulationEnabled",
		{ enabled: true },
		targetIdFor(rec(msg.target)),
	);
	return r.ok
		? { attempted: true, ok: true }
		: {
				attempted: true,
				ok: false,
				error_code: r.error_code || "SEND_FAILED",
				error: typeof r.error === "string" ? r.error : String(rec(r.error).message || r.error_code || "failed"),
			};
}
async function emit(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	method: string,
	params: JsonRecord,
	sent: Sent[],
	targetId?: string,
): Promise<BrowserPilotBridgeResponse<JsonRecord> | undefined> {
	const r = await cdp(tabId, msg, method, params, targetId);
	sent.push({ method, type: typeof params.type === "string" ? params.type : undefined });
	return r.ok ? undefined : r;
}
function done(
	command: string,
	startedAt: number,
	sent: Sent[],
	focusEmulation: JsonRecord,
	extra: JsonRecord,
): BrowserPilotBridgeResponse<JsonRecord> {
	return ok({
		input: {
			command,
			...extra,
			events: sent.map((e) => e.type).filter(Boolean),
			dispatched: sent.length,
			focusEmulation,
			cdpSessionName: INPUT_CDP_SESSION_NAME,
			elapsedMs: Date.now() - startedAt,
		},
	});
}
function cdpErrorText(resp: BrowserPilotBridgeResponse | undefined): string {
	const e = rec(resp?.error);
	return String(e.message || resp?.message || resp?.error || resp?.error_code || "CDP command failed");
}
function backendFailure(
	resp: BrowserPilotBridgeResponse | undefined,
): "BACKEND_NODE_STALE" | "OOPIF_SESSION_UNSUPPORTED" {
	return /target|session|frame|oopif|isolated|cross/i.test(cdpErrorText(resp))
		? "OOPIF_SESSION_UNSUPPORTED"
		: "BACKEND_NODE_STALE";
}
function cleanString(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const text = v.trim();
	return text ? text : undefined;
}
function targetIdFor(target: JsonRecord): string | undefined {
	const direct = cleanString(target.targetId);
	if (direct) return direct;
	const ownerTarget = cleanString(rec(target.owner).targetId);
	if (ownerTarget) return ownerTarget;
	for (const locator of Array.isArray(target.locators) ? target.locators : []) {
		const r = rec(locator);
		if (r.by !== "backendNodeId") continue;
		const locatorTarget = cleanString(r.targetId);
		if (locatorTarget) return locatorTarget;
	}
	return undefined;
}
function refTargetSummary(target: JsonRecord, backendNodeId?: number): JsonRecord {
	const refId = typeof target.refId === "string" ? target.refId : undefined;
	const targetId = targetIdFor(target);
	return {
		...(refId ? { refId } : {}),
		...(backendNodeId !== undefined ? { backendNodeId } : {}),
		...(targetId ? { targetId } : {}),
	};
}
function failRef(
	code: string,
	message: string,
	startedAt: number,
	target: JsonRecord,
	backendNodeId?: number,
	extra: JsonRecord = {},
): BrowserPilotBridgeResponse {
	const action = cleanString(extra.action) ?? "click";
	return err(code, message, {
		input: {
			command: "input.ref",
			dispatchOnly: true,
			dispatched: 0,
			events: [],
			cdpSessionName: INPUT_CDP_SESSION_NAME,
			target: refTargetSummary(target, backendNodeId),
			elapsedMs: Date.now() - startedAt,
			...extra,
			action,
		},
	});
}
function backendTarget(target: JsonRecord): BackendTarget | undefined {
	const targetId = targetIdFor(target);
	const direct = opt(target.backendNodeId);
	if (direct !== undefined) return { backendNodeId: direct, ...(targetId ? { targetId } : {}) };
	for (const locator of Array.isArray(target.locators) ? target.locators : []) {
		const r = rec(locator),
			value = opt(r.value);
		if (r.by === "backendNodeId" && value !== undefined) {
			const locatorTarget = cleanString(r.targetId) ?? targetId;
			return { backendNodeId: value, ...(locatorTarget ? { targetId: locatorTarget } : {}) };
		}
	}
	return undefined;
}
function refPoint(target: JsonRecord): RefPoint | undefined {
	for (const source of [rec(target.point), rec(rec(target.geometry).point)]) {
		const x = opt(source.x),
			y = opt(source.y);
		if (x !== undefined && y !== undefined) return { x, y };
	}
	for (const locator of Array.isArray(target.locators) ? target.locators : []) {
		const r = rec(locator),
			x = opt(r.x),
			y = opt(r.y);
		if (r.by === "point" && x !== undefined && y !== undefined) return { x, y };
	}
	return undefined;
}
function runtimeValue(response: BrowserPilotBridgeResponse): JsonRecord {
	return rec(rec(rec(rec(response.data).result).result).value);
}

const REF_POINT_FUNCTION = `function(input) { return (${PAGE_REF_RUNTIME_SOURCE}).point(this, { semantic: input }, true); }`;

/** Read checked/pressed state from the nearest toggle control (native or ARIA) around `this`. */
const CHECK_STATE_FUNCTION = `function() {
	const selector = 'input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitemcheckbox"],[role="menuitemradio"],[aria-pressed]';
	const control = (this.closest && this.closest(selector)) || this;
	const attr = name => (control.getAttribute ? control.getAttribute(name) : null);
	const tag = String(control.tagName || "").toLowerCase();
	const type = tag === "input" ? String(control.type || "").toLowerCase() : "";
	const role = String(attr("role") || "").toLowerCase();
	const disabled = control.disabled === true || attr("aria-disabled") === "true";
	const tri = value => (value === "mixed" ? "mixed" : value === "true");
	if (tag === "input" && (type === "checkbox" || type === "radio")) return { ok: true, kind: type, checked: control.indeterminate ? "mixed" : !!control.checked, disabled };
	const ariaChecked = attr("aria-checked");
	if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role) || ariaChecked !== null) return { ok: true, kind: role || "aria-checked", checked: tri(ariaChecked), disabled };
	const ariaPressed = attr("aria-pressed");
	if (ariaPressed !== null) return { ok: true, kind: "aria-pressed", checked: tri(ariaPressed), disabled };
	return { ok: false, reason: "unsupported", tag, role };
}`;

/** Select an option on the nearest <select> around `this` by value, label, or index, then notify the page. */
const SELECT_OPTION_FUNCTION = `function(input) {
	const el = (this.closest && this.closest("select")) || this;
	if (String(el.tagName || "").toLowerCase() !== "select") return { ok: false, reason: "not_select", tag: String(this.tagName || "").toLowerCase() };
	if (el.disabled) return { ok: false, reason: "disabled" };
	const normalize = value => String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
	const labelOf = option => normalize(option.label || option.textContent);
	const options = Array.from(el.options || []);
	const describe = (option, index) => ({ index, value: option.value, label: labelOf(option), disabled: !!option.disabled });
	const wantValue = input.value == null ? undefined : String(input.value);
	const wantLabel = input.label == null ? undefined : normalize(input.label).toLowerCase();
	const wantIndex = Number.isInteger(input.index) ? input.index : undefined;
	let index = -1;
	if (wantIndex !== undefined) index = wantIndex >= 0 && wantIndex < options.length ? wantIndex : -1;
	else if (wantValue !== undefined) index = options.findIndex(option => option.value === wantValue);
	if (index < 0 && wantLabel !== undefined) index = options.findIndex(option => labelOf(option).toLowerCase() === wantLabel);
	if (index < 0 && wantValue !== undefined) index = options.findIndex(option => labelOf(option).toLowerCase() === wantValue.toLowerCase());
	if (index < 0) return { ok: false, reason: "option_not_found", options: options.slice(0, 50).map(describe) };
	const option = options[index];
	if (option.disabled) return { ok: false, reason: "option_disabled", option: describe(option, index) };
	const before = el.multiple ? options.filter(item => item.selected).map(item => item.value) : [el.value];
	if (el.multiple) for (const item of options) item.selected = item === option;
	else el.selectedIndex = index;
	el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
	return { ok: true, selected: describe(option, index), before, multiple: !!el.multiple };
}`;

/** Inspect the deepest focused element (through open shadow roots) and decide whether text can be typed into it. */
const ACTIVE_EDITABLE_EXPRESSION = `(() => {
	let el = document.activeElement;
	while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
	if (!el || el === document.body || el === document.documentElement) return { ok: false, reason: "no_focus" };
	const tag = String(el.tagName || "").toLowerCase();
	const type = tag === "input" ? String(el.type || "text").toLowerCase() : "";
	const nonText = ["button", "submit", "reset", "checkbox", "radio", "file", "image", "range", "color", "hidden"];
	const textInput = tag === "textarea" || (tag === "input" && !nonText.includes(type));
	if (!textInput && el.isContentEditable !== true) return { ok: false, reason: "not_editable", tag, type };
	if (el.disabled) return { ok: false, reason: "disabled", tag, type };
	if (el.readOnly) return { ok: false, reason: "readonly", tag, type };
	const valueLength = typeof el.value === "string" ? el.value.length : String(el.textContent || "").length;
	return { ok: true, tag, type, valueLength };
})()`;

const VISUAL_POINT_FUNCTION = `function(input) {
	const basis = input.basis || {};
	const anchor = input.anchor || {};
	const point = anchor.point || {};
	const to = anchor.to || null;
	const vw = Math.max(document.documentElement.clientWidth || 0, innerWidth || 0);
	const vh = Math.max(document.documentElement.clientHeight || 0, innerHeight || 0);
	const close = (a, b) => Math.abs(Number(a) - Number(b)) < 0.5;
	if (!vw || !vh || !close(vw, basis.viewportWidth) || !close(vh, basis.viewportHeight)) return { ok: false, reason: "viewport_changed", vw, vh };
	if (!close(scrollX || 0, basis.scrollX) || !close(scrollY || 0, basis.scrollY)) return { ok: false, reason: "scroll_changed" };
	if (!close(devicePixelRatio || 1, basis.devicePixelRatio)) return { ok: false, reason: "device_scale_changed" };
	if (basis.url && location.href !== basis.url) return { ok: false, reason: "url_changed" };
	if (![point.x, point.y].every(value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1)) return { ok: false, reason: "invalid_point" };
	const map = value => ({ x: Math.max(0, Math.min(vw - 1, Math.round(Number(value.x) * vw))), y: Math.max(0, Math.min(vh - 1, Math.round(Number(value.y) * vh))) });
	const mapped = map(point);
	const hit = document.elementFromPoint(mapped.x, mapped.y);
	if (!hit) return { ok: false, reason: "not_found" };
	const style = getComputedStyle(hit);
	if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none") return { ok: false, reason: "not_hittable" };
	const normalized = value => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
	const role = normalized(hit.getAttribute && hit.getAttribute("role") || hit.tagName || "");
	const name = normalized(hit.getAttribute && (hit.getAttribute("aria-label") || hit.getAttribute("title") || hit.getAttribute("alt")) || hit.textContent || "").slice(0, 160);
	const rect = hit.getBoundingClientRect();
	return { ok: true, x: mapped.x, y: mapped.y, ...(to ? { to: map(to) } : {}), grounded: { tag: String(hit.tagName || "").toLowerCase(), role, name, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } };
}`;

async function visualRefPoint(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	target: JsonRecord,
	startedAt: number,
): Promise<RefPoint | BrowserPilotBridgeResponse> {
	const visual = rec(target.visual),
		anchor = rec(visual.anchor),
		basis = rec(visual.fingerprint);
	const action = String(msg.action || "click").toLowerCase();
	if (!visual.actionableGrounding || !Object.keys(anchor).length)
		return failRef(
			"INVALID_REF_TARGET",
			"Visual input.ref requires an actionable observation-bound anchor",
			startedAt,
			target,
			undefined,
			{ action },
		);
	const response = await cdp(
		tabId,
		msg,
		"Runtime.evaluate",
		{
			expression: `(${VISUAL_POINT_FUNCTION})(${JSON.stringify({ basis, anchor })})`,
			returnByValue: true,
			awaitPromise: true,
		},
		targetIdFor(target),
	);
	if (!response.ok)
		return failRef(backendFailure(response), cdpErrorText(response), startedAt, target, undefined, {
			action,
			resolution: "visualPoint",
			phase: "resolve",
		});
	const value = runtimeValue(response),
		x = opt(value.x),
		y = opt(value.y),
		toValue = rec(value.to);
	if (value.ok !== true || x === undefined || y === undefined)
		return failRef(
			"BACKEND_NODE_STALE",
			`input.ref visual target failed: ${String(value.reason || "not_found")}`,
			startedAt,
			target,
			undefined,
			{ action, resolution: "visualPoint", phase: "resolve" },
		);
	const located = await cdp(
		tabId,
		msg,
		"DOM.getNodeForLocation",
		{ x, y, includeUserAgentShadowDOM: true },
		targetIdFor(target),
	);
	if (!located.ok)
		return failRef(backendFailure(located), cdpErrorText(located), startedAt, target, undefined, {
			action,
			resolution: "visualPoint",
			phase: "ground",
		});
	const locatedValue = rec(rec(located.data).result),
		backendNodeId = opt(locatedValue.backendNodeId);
	if (backendNodeId === undefined)
		return failRef(
			"BACKEND_NODE_STALE",
			"input.ref visual target could not be grounded to a live browser node",
			startedAt,
			target,
			undefined,
			{ action, resolution: "visualPoint", phase: "ground" },
		);
	const toX = opt(toValue.x),
		toY = opt(toValue.y);
	return {
		x,
		y,
		...(toX !== undefined && toY !== undefined ? { to: { x: toX, y: toY } } : {}),
		grounded: {
			...rec(value.grounded),
			backendNodeId,
			...(typeof locatedValue.frameId === "string" ? { frameId: locatedValue.frameId } : {}),
		},
	};
}

async function liveRefPoint(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	target: JsonRecord,
	startedAt: number,
): Promise<RefPoint | BrowserPilotBridgeResponse> {
	const fallback = refPoint(target);
	const kind = cleanString(target.kind);
	const semantic = rec(target.semantic);
	const role = cleanString(semantic.role);
	const name = cleanString(semantic.name);
	const locators = Array.isArray(target.locators) ? target.locators : [];
	const hasLiveLocator = locators.some((item) =>
		["css", "xpath", "attrSignature", "textAnchor"].includes(String(rec(item).by || "")),
	);
	if (!hasLiveLocator && (!fallback || !["region", "media"].includes(kind || "") || (!role && !name)))
		return failRef(
			"INVALID_REF_TARGET",
			"Point-only input.ref targets require region/media semantic identity",
			startedAt,
			target,
		);
	const expression = `(() => {
	  const input = ${JSON.stringify({ locators, point: fallback, semantic: { role, name }, kind })};
	  const runtime = ${PAGE_REF_RUNTIME_SOURCE};
	  const resolved = runtime.resolve(input);
	  let el = resolved.ok ? resolved.el : null;
	  if (!el && input.point && ["region", "media"].includes(input.kind)) el = document.elementFromPoint(Number(input.point.x), Number(input.point.y));
	  if (!el) return { ok: false, reason: resolved.reason || "not_found", tried: resolved.tried };
	  return runtime.point(el, input, true);
	})()`;
	const response = await cdp(
		tabId,
		msg,
		"Runtime.evaluate",
		{ expression, returnByValue: true, awaitPromise: true },
		targetIdFor(target),
	);
	if (!response.ok)
		return failRef(backendFailure(response), cdpErrorText(response), startedAt, target, undefined, {
			resolution: "liveLocator",
			phase: "resolve",
		});
	const value = runtimeValue(response);
	const x = opt(value.x),
		y = opt(value.y);
	if (value.ok !== true || x === undefined || y === undefined)
		return failRef(
			"BACKEND_NODE_STALE",
			`input.ref live locator failed: ${String(value.reason || "not_found")}`,
			startedAt,
			target,
			undefined,
			{ resolution: "liveLocator", phase: "resolve" },
		);
	return { x, y };
}
async function backendPoint(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	target: JsonRecord,
	backend: BackendTarget,
	startedAt: number,
): Promise<RefPoint | BrowserPilotBridgeResponse> {
	const id = backend.backendNodeId;
	const route = backend.targetId ? { targetId: backend.targetId, targetScoped: true } : { targetScoped: false };
	const resolved = await cdp(tabId, msg, "DOM.resolveNode", { backendNodeId: id }, backend.targetId);
	if (!resolved.ok)
		return failRef(backendFailure(resolved), cdpErrorText(resolved), startedAt, target, id, {
			resolution: "backendNodeId",
			phase: "resolveNode",
			...route,
		});
	const objectId = cleanString(rec(rec(rec(resolved.data).result).object).objectId);
	if (!objectId)
		return failRef("BACKEND_NODE_STALE", "DOM.resolveNode returned no live object", startedAt, target, id, {
			resolution: "backendNodeId",
			phase: "resolveNode",
			...route,
		});
	const semantic = rec(target.semantic);
	const inspected = await cdp(
		tabId,
		msg,
		"Runtime.callFunctionOn",
		{
			objectId,
			functionDeclaration: REF_POINT_FUNCTION,
			arguments: [{ value: { role: cleanString(semantic.role), name: cleanString(semantic.name) } }],
			returnByValue: true,
			awaitPromise: true,
		},
		backend.targetId,
	);
	if (!inspected.ok)
		return failRef(backendFailure(inspected), cdpErrorText(inspected), startedAt, target, id, {
			resolution: "backendNodeId",
			phase: "validate",
			...route,
		});
	const value = runtimeValue(inspected);
	const x = opt(value.x),
		y = opt(value.y);
	if (value.ok !== true || x === undefined || y === undefined)
		return failRef(
			"BACKEND_NODE_STALE",
			`input.ref live backend validation failed: ${String(value.reason || "not_found")}`,
			startedAt,
			target,
			id,
			{ resolution: "backendNodeId", phase: "validate", ...route },
		);
	const cdpRoute = rec(rec(inspected.data).cdpRoute);
	return { x, y, ...(Object.keys(cdpRoute).length ? { cdpRoute } : {}) };
}

type RefResolution = "visualPoint" | "backendNodeId" | "liveLocator";
type ResolvedRef = { point: RefPoint; resolution: RefResolution };
type RefDispatch = {
	tabId: number;
	msg: BrowserPilotBridgeCommand;
	startedAt: number;
	action: string;
	target: JsonRecord;
	backend?: BackendTarget;
	resolved: ResolvedRef;
	sent: Sent[];
};

/** Bridge errors carry `error_code`; page-side runtime values never do, even when they report `ok: false`. */
function isBridgeError(value: JsonRecord | BrowserPilotBridgeResponse): value is BrowserPilotBridgeResponse {
	return typeof (value as JsonRecord).error_code === "string";
}

function refFailure(
	ctx: RefDispatch,
	code: string,
	message: string,
	extra: JsonRecord = {},
): BrowserPilotBridgeResponse {
	return failRef(code, message, ctx.startedAt, ctx.target, ctx.backend?.backendNodeId, {
		action: ctx.action,
		resolution: ctx.resolved.resolution,
		...(ctx.backend?.targetId ? { targetId: ctx.backend.targetId, targetScoped: true } : {}),
		...extra,
	});
}

async function resolveRefPoint(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	target: JsonRecord,
	backend: BackendTarget | undefined,
	visual: boolean,
	startedAt: number,
): Promise<ResolvedRef | BrowserPilotBridgeResponse> {
	if (visual) {
		const point = await visualRefPoint(tabId, msg, target, startedAt);
		return "ok" in point ? point : { point, resolution: "visualPoint" };
	}
	if (backend) {
		const direct = await backendPoint(tabId, msg, target, backend, startedAt);
		if (!("ok" in direct)) return { point: direct, resolution: "backendNodeId" };
		const rebound = await liveRefPoint(tabId, msg, target, startedAt);
		if ("ok" in rebound) return rebound.error_code === "INVALID_REF_TARGET" ? direct : rebound;
		return { point: rebound, resolution: "liveLocator" };
	}
	const point = await liveRefPoint(tabId, msg, target, startedAt);
	return "ok" in point ? point : { point, resolution: "liveLocator" };
}

/** Ground the dispatch target to a live DOM node: reuse the backend identity or hit-test the resolved point. */
async function liveNode(ctx: RefDispatch, phase: string): Promise<LiveNode | BrowserPilotBridgeResponse> {
	const targetId = ctx.backend?.targetId ?? targetIdFor(ctx.target);
	let backendNodeId = ctx.backend?.backendNodeId;
	if (backendNodeId === undefined) {
		const located = await cdp(
			ctx.tabId,
			ctx.msg,
			"DOM.getNodeForLocation",
			{
				x: Math.round(ctx.resolved.point.x),
				y: Math.round(ctx.resolved.point.y),
				includeUserAgentShadowDOM: true,
			},
			targetId,
		);
		if (!located.ok) return refFailure(ctx, backendFailure(located), cdpErrorText(located), { phase });
		backendNodeId = opt(rec(rec(located.data).result).backendNodeId);
		if (backendNodeId === undefined)
			return refFailure(ctx, "BACKEND_NODE_STALE", "input.ref target could not be grounded to a live node", {
				phase,
			});
	}
	const resolved = await cdp(ctx.tabId, ctx.msg, "DOM.resolveNode", { backendNodeId }, targetId);
	if (!resolved.ok)
		return refFailure(ctx, backendFailure(resolved), cdpErrorText(resolved), { phase, backendNodeId });
	const objectId = cleanString(rec(rec(rec(resolved.data).result).object).objectId);
	if (!objectId)
		return refFailure(ctx, "BACKEND_NODE_STALE", "DOM.resolveNode returned no live object", {
			phase,
			backendNodeId,
		});
	return { backendNodeId, objectId, ...(targetId ? { targetId } : {}) };
}

async function callOnNode(
	ctx: RefDispatch,
	node: LiveNode,
	functionDeclaration: string,
	args: unknown[],
	phase: string,
): Promise<JsonRecord | BrowserPilotBridgeResponse> {
	const response = await cdp(
		ctx.tabId,
		ctx.msg,
		"Runtime.callFunctionOn",
		{
			objectId: node.objectId,
			functionDeclaration,
			arguments: args.map((value) => ({ value })),
			returnByValue: true,
			awaitPromise: true,
		},
		node.targetId,
	);
	if (!response.ok) return refFailure(ctx, backendFailure(response), cdpErrorText(response), { phase });
	return runtimeValue(response);
}

function mouseEvents(ctx: RefDispatch): JsonRecord[] {
	const { msg, action } = ctx;
	const point = ctx.resolved.point;
	const modifiers = mods(msg.modifiers);
	const b = button(msg.button);
	const clickCount = Math.max(1, Math.trunc(Number(msg.count || 1)));
	const base = { x: point.x, y: point.y, modifiers };
	const press = [
		{ ...base, type: "mouseMoved", button: "none" },
		{ ...base, type: "mousePressed", button: b, clickCount },
		{ ...base, type: "mouseReleased", button: b, clickCount },
	];
	if (action === "hover") return [{ ...base, type: "mouseMoved", button: "none" }];
	if (action === "wheel")
		return [
			{ ...base, type: "mouseWheel", button: "none", deltaX: opt(msg.deltaX) ?? 0, deltaY: opt(msg.deltaY) ?? 0 },
		];
	if (action === "drag") {
		if (!point.to) return [];
		return [
			press[0]!,
			press[1]!,
			...line({ x: point.x, y: point.y }, point.to).map((p) => ({
				type: "mouseMoved",
				x: p.x,
				y: p.y,
				button: b,
				modifiers,
			})),
			{ type: "mouseReleased", x: point.to.x, y: point.to.y, button: b, clickCount, modifiers },
		];
	}
	return press;
}

async function dispatchMouse(ctx: RefDispatch, events: JsonRecord[]): Promise<BrowserPilotBridgeResponse | undefined> {
	for (const params of events) {
		const failed = await emit(
			ctx.tabId,
			ctx.msg,
			"Input.dispatchMouseEvent",
			params,
			ctx.sent,
			ctx.backend?.targetId,
		);
		if (failed)
			return refFailure(ctx, "BACKEND_NODE_STALE", cdpErrorText(failed), {
				phase: "dispatchMouseEvent",
				attemptedEvents: ctx.sent.map((item) => item.type).filter(Boolean),
			});
	}
	return undefined;
}

async function dispatchKey(
	ctx: RefDispatch,
	params: JsonRecord,
	phase: string,
): Promise<BrowserPilotBridgeResponse | undefined> {
	const failed = await emit(ctx.tabId, ctx.msg, "Input.dispatchKeyEvent", params, ctx.sent, ctx.backend?.targetId);
	return failed ? refFailure(ctx, "BACKEND_NODE_STALE", cdpErrorText(failed), { phase }) : undefined;
}

/** Replace the focused field's content through trusted editing commands: select-all, then Backspace. */
async function clearFocusedField(ctx: RefDispatch): Promise<BrowserPilotBridgeResponse | undefined> {
	const selectAll = {
		type: "rawKeyDown",
		key: "a",
		code: "KeyA",
		windowsVirtualKeyCode: 65,
		nativeVirtualKeyCode: 65,
		modifiers: CTRL_MODIFIER,
		commands: ["selectAll"],
	};
	const { commands: _commands, ...selectAllUp } = selectAll;
	const steps: JsonRecord[] = [
		selectAll,
		{ ...selectAllUp, type: "keyUp" },
		keyParams("Backspace", "keyDown", 0),
		keyParams("Backspace", "keyUp", 0),
	];
	for (const params of steps) {
		const failed = await dispatchKey(ctx, params, "clear");
		if (failed) return failed;
	}
	return undefined;
}

async function typeIntoRef(ctx: RefDispatch): Promise<BrowserPilotBridgeResponse | JsonRecord> {
	const text = ctx.msg.text;
	if (typeof text !== "string") return err("INVALID_RULE", "input.ref type requires text", { action: ctx.action });
	const clicked = await dispatchMouse(ctx, mouseEvents({ ...ctx, action: "click" }));
	if (clicked) return clicked;
	const targetId = ctx.backend?.targetId ?? targetIdFor(ctx.target);
	if (ctx.resolved.resolution !== "visualPoint") {
		const active = await cdp(
			ctx.tabId,
			ctx.msg,
			"Runtime.evaluate",
			{ expression: ACTIVE_EDITABLE_EXPRESSION, returnByValue: true },
			targetId,
		);
		if (!active.ok) return refFailure(ctx, backendFailure(active), cdpErrorText(active), { phase: "inspectFocus" });
		const state = runtimeValue(active);
		if (state.ok !== true) {
			const reason = String(state.reason || "not_editable");
			const code = reason === "disabled" ? "TARGET_DISABLED" : "TARGET_NOT_EDITABLE";
			return refFailure(ctx, code, `input.ref type target is not editable (${reason})`, {
				phase: "inspectFocus",
				focused: state,
			});
		}
	}
	if (ctx.msg.clear === true) {
		const cleared = await clearFocusedField(ctx);
		if (cleared) return cleared;
	}
	const failed = await emit(ctx.tabId, ctx.msg, "Input.insertText", { text }, ctx.sent, ctx.backend?.targetId);
	if (failed) return refFailure(ctx, "BACKEND_NODE_STALE", cdpErrorText(failed), { phase: "insertText" });
	return { text: { redacted: true, charCount: text.length, cleared: ctx.msg.clear === true } };
}

async function focusRef(ctx: RefDispatch): Promise<BrowserPilotBridgeResponse | JsonRecord> {
	const node = await liveNode(ctx, "focus");
	if ("ok" in node) return node;
	const focused = await cdp(ctx.tabId, ctx.msg, "DOM.focus", { backendNodeId: node.backendNodeId }, node.targetId);
	ctx.sent.push({ method: "DOM.focus", type: "focus" });
	if (focused.ok) return { focus: { method: "DOM.focus", backendNodeId: node.backendNodeId } };
	// Non-focusable wrappers (e.g. a div hosting a custom control) still take focus from a trusted click.
	const clicked = await dispatchMouse(ctx, mouseEvents({ ...ctx, action: "click" }));
	if (clicked) return clicked;
	return { focus: { method: "click", backendNodeId: node.backendNodeId, domFocusError: cdpErrorText(focused) } };
}

async function checkRef(ctx: RefDispatch): Promise<BrowserPilotBridgeResponse | JsonRecord> {
	const desired = ctx.msg.checked !== false;
	const node = await liveNode(ctx, "check");
	if ("ok" in node) return node;
	const beforeState = await callOnNode(ctx, node, CHECK_STATE_FUNCTION, [], "readState");
	if (isBridgeError(beforeState)) return beforeState;
	if (beforeState.ok !== true)
		return refFailure(
			ctx,
			"INVALID_REF_TARGET",
			"input.ref check requires a checkbox, radio, switch, or toggle button",
			{
				phase: "readState",
				control: beforeState,
			},
		);
	if (beforeState.disabled === true)
		return refFailure(ctx, "TARGET_DISABLED", "input.ref check target is disabled", {
			phase: "readState",
			control: beforeState,
		});
	if (beforeState.checked === desired)
		return {
			check: {
				kind: beforeState.kind,
				desired,
				before: beforeState.checked,
				after: beforeState.checked,
				toggled: false,
				applied: true,
			},
		};
	const clicked = await dispatchMouse(ctx, mouseEvents({ ...ctx, action: "click" }));
	if (clicked) return clicked;
	const afterState = await callOnNode(ctx, node, CHECK_STATE_FUNCTION, [], "verifyState");
	const afterChecked = !isBridgeError(afterState) && afterState.ok === true ? afterState.checked : undefined;
	return {
		check: {
			kind: beforeState.kind,
			desired,
			before: beforeState.checked,
			after: afterChecked ?? null,
			toggled: true,
			applied: afterChecked === desired,
		},
	};
}

async function selectRef(ctx: RefDispatch): Promise<BrowserPilotBridgeResponse | JsonRecord> {
	const { msg } = ctx;
	const choice = {
		...(msg.value !== undefined ? { value: msg.value } : {}),
		...(msg.label !== undefined ? { label: msg.label } : {}),
		...(msg.index !== undefined ? { index: msg.index } : {}),
	};
	if (!Object.keys(choice).length)
		return err("INVALID_RULE", "input.ref select requires value, label, or index", { action: ctx.action });
	const node = await liveNode(ctx, "select");
	if ("ok" in node) return node;
	// Best-effort focus so the page sees a coherent focus → change sequence; a native <select> popup must not open.
	const focused = await cdp(ctx.tabId, ctx.msg, "DOM.focus", { backendNodeId: node.backendNodeId }, node.targetId);
	if (focused.ok) ctx.sent.push({ method: "DOM.focus", type: "focus" });
	const result = await callOnNode(ctx, node, SELECT_OPTION_FUNCTION, [choice], "selectOption");
	if (isBridgeError(result)) return result;
	ctx.sent.push({ method: "Runtime.callFunctionOn", type: "selectOption" });
	if (result.ok === true) return { select: { ...result, dispatch: "synthetic" } };
	const reason = String(result.reason || "option_not_found");
	const code =
		reason === "not_select"
			? "INVALID_REF_TARGET"
			: reason === "disabled" || reason === "option_disabled"
				? "TARGET_DISABLED"
				: "INVALID_INPUT";
	return refFailure(ctx, code, `input.ref select failed: ${reason}`, { phase: "selectOption", ...result });
}

async function dispatchRefAction(ctx: RefDispatch): Promise<BrowserPilotBridgeResponse | JsonRecord> {
	switch (ctx.action) {
		case "type":
			return await typeIntoRef(ctx);
		case "focus":
			return await focusRef(ctx);
		case "check":
			return await checkRef(ctx);
		case "select":
			return await selectRef(ctx);
		default: {
			const events = mouseEvents(ctx);
			if (ctx.action === "drag" && !events.length)
				return refFailure(ctx, "INVALID_REF_TARGET", "input.ref drag requires a visual destination");
			return (await dispatchMouse(ctx, events)) ?? {};
		}
	}
}

async function handleBrowserPilotRefInputCommand(
	cmd: string,
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	startedAt = Date.now(),
): Promise<BrowserPilotBridgeResponse> {
	if (cmd !== "input.ref") return err("INVALID_RULE", "Unknown ref input command: " + cmd, { cmd });
	const action = String(msg.action || "").toLowerCase();
	if (!REF_ACTIONS.includes(action))
		return err("INVALID_RULE", `input.ref action must be one of ${REF_ACTIONS.join(", ")}`, { action });
	const target = rec(msg.target),
		backend = backendTarget(target);
	const visual = Object.keys(rec(target.visual)).length > 0;
	const allowed = visual ? VISUAL_REF_ACTIONS : LIVE_REF_ACTIONS;
	if (!allowed.has(action))
		return err(
			"INVALID_RULE",
			`${visual ? "Visual" : "Non-visual"} input.ref targets support ${[...allowed].join(", ")}`,
			{ action, visual },
		);
	const resolved = await resolveRefPoint(tabId, msg, target, backend, visual, startedAt);
	if ("ok" in resolved) return resolved;
	const ctx: RefDispatch = { tabId, msg, startedAt, action, target, backend, resolved, sent: [] };
	const focusEmulation = await focus(tabId, msg);
	const outcome = await dispatchRefAction(ctx);
	if (isBridgeError(outcome)) return outcome;
	const point = resolved.point;
	const pointRoute = "cdpRoute" in point ? point.cdpRoute : undefined;
	return done("input.ref", startedAt, ctx.sent, focusEmulation, {
		action,
		resolution: resolved.resolution,
		dispatchOnly: true,
		target: {
			...refTargetSummary(target, backend?.backendNodeId),
			...(point.grounded ? { grounded: point.grounded } : {}),
		},
		...(backend?.targetId
			? {
					targetId: backend.targetId,
					targetScoped: true,
					attachRouteUsed: pointRoute?.attachRouteUsed === true,
					...(pointRoute ? { cdpRoute: pointRoute } : {}),
				}
			: {}),
		coordinates: {
			x: Math.round(point.x),
			y: Math.round(point.y),
			...(point.to ? { to: { x: Math.round(point.to.x), y: Math.round(point.to.y) } } : {}),
		},
		...outcome,
	});
}

async function pointer(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	startedAt: number,
): Promise<BrowserPilotBridgeResponse> {
	const gesture = String(msg.gesture || "").toLowerCase(),
		x = num(msg.x, "x"),
		y = num(msg.y, "y");
	const b = button(msg.button),
		clickCount = Math.max(1, Math.trunc(Number(msg.count || 1))),
		modifiers = mods(msg.modifiers);
	const sent: Sent[] = [],
		focusEmulation = await focus(tabId, msg),
		base = { x, y, modifiers };
	const mouse = async (params: JsonRecord) => await emit(tabId, msg, "Input.dispatchMouseEvent", params, sent);
	if (gesture === "hover" || gesture === "moveonly") {
		const failed = await mouse({ ...base, type: "mouseMoved", button: "none" });
		if (failed) return failed;
	} else if (gesture === "press" || gesture === "pressonly") {
		const pressOnly = gesture === "pressonly";
		const events = pressOnly
			? [{ ...base, type: "mousePressed", button: b, clickCount }]
			: [
					{ ...base, type: "mouseMoved", button: "none" },
					{ ...base, type: "mousePressed", button: b, clickCount },
					{ ...base, type: "mouseReleased", button: b, clickCount },
				];
		for (const p of events) {
			const failed = await mouse(p);
			if (failed) return failed;
		}
	} else if (gesture === "releaseonly") {
		const failed = await mouse({ ...base, type: "mouseReleased", button: b, clickCount });
		if (failed) return failed;
	} else if (gesture === "wheel") {
		const failed = await mouse({
			...base,
			type: "mouseWheel",
			button: "none",
			deltaX: opt(msg.deltaX) ?? 0,
			deltaY: opt(msg.deltaY) ?? 0,
		});
		if (failed) return failed;
	} else if (gesture === "drag") {
		const explicit = points(msg.path),
			end = explicit.at(-1) || { x: opt(msg.toX) ?? x, y: opt(msg.toY) ?? y },
			path = explicit.length ? explicit : line({ x, y }, end);
		for (const p of [
			{ ...base, type: "mouseMoved", button: "none" },
			{ ...base, type: "mousePressed", button: b, clickCount },
			...path.map((p) => ({ type: "mouseMoved", x: p.x, y: p.y, button: b, modifiers })),
			{ type: "mouseReleased", x: end.x, y: end.y, button: b, clickCount, modifiers },
		]) {
			const failed = await mouse(p);
			if (failed) return failed;
		}
	} else
		return err(
			"INVALID_RULE",
			"input.pointer gesture must be press, drag, wheel, hover, moveonly, pressonly, or releaseonly",
			{ gesture },
		);
	return done("input.pointer", startedAt, sent, focusEmulation, { gesture, coordinates: { x, y } });
}

// Modifier KeyboardEvent.code → [KeyboardEvent.key, virtualKeyCode]
const MODIFIER_CODES: Record<string, [string, number]> = {
	ShiftLeft: ["Shift", 16],
	ShiftRight: ["Shift", 16],
	ControlLeft: ["Control", 17],
	ControlRight: ["Control", 17],
	AltLeft: ["Alt", 18],
	AltRight: ["Alt", 18],
	MetaLeft: ["Meta", 91],
	MetaRight: ["Meta", 91],
};
function keyParams(key: string, type: string, modifiers: number): JsonRecord {
	const named: Record<string, [string, number]> = {
		Enter: ["Enter", 13],
		Escape: ["Escape", 27],
		Tab: ["Tab", 9],
		Backspace: ["Backspace", 8],
		Delete: ["Delete", 46],
		ArrowLeft: ["ArrowLeft", 37],
		ArrowUp: ["ArrowUp", 38],
		ArrowRight: ["ArrowRight", 39],
		ArrowDown: ["ArrowDown", 40],
		Home: ["Home", 36],
		End: ["End", 35],
		PageUp: ["PageUp", 33],
		PageDown: ["PageDown", 34],
	};
	// Accept KeyboardEvent.code values, a single character, or a named key. Detect codes first.
	const letterCode = /^Key([A-Z])$/.exec(key);
	if (letterCode) {
		const ch = letterCode[1]!;
		return {
			type,
			key: ch.toLowerCase(),
			code: key,
			windowsVirtualKeyCode: ch.charCodeAt(0),
			nativeVirtualKeyCode: ch.charCodeAt(0),
			modifiers,
		};
	}
	const digitCode = /^Digit([0-9])$/.exec(key);
	if (digitCode) {
		const d = digitCode[1]!;
		return {
			type,
			key: d,
			code: key,
			windowsVirtualKeyCode: d.charCodeAt(0),
			nativeVirtualKeyCode: d.charCodeAt(0),
			modifiers,
		};
	}
	const mod = MODIFIER_CODES[key];
	if (mod)
		return { type, key: mod[0], code: key, windowsVirtualKeyCode: mod[1], nativeVirtualKeyCode: mod[1], modifiers };
	const upper = key.length === 1 ? key.toUpperCase() : key,
		code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : named[key]?.[0];
	const vk = named[key]?.[1] ?? (key.length === 1 ? upper.charCodeAt(0) : undefined);
	return { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
}
async function keys(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	startedAt: number,
): Promise<BrowserPilotBridgeResponse> {
	const sent: Sent[] = [],
		focusEmulation = await focus(tabId, msg);
	if (typeof msg.text === "string") {
		const failed = await emit(tabId, msg, "Input.insertText", { text: msg.text }, sent);
		if (failed) return failed;
		return done("input.keys", startedAt, sent, focusEmulation, {
			text: { redacted: true, charCount: msg.text.length },
		});
	}
	const items = Array.isArray(msg.keys) ? msg.keys : [];
	if (!items.length) return err("INVALID_RULE", "input.keys requires text or keys");
	const keyNames: string[] = [];
	for (const item of items) {
		const r = rec(item),
			key = String(r.key || "");
		if (!key) return err("INVALID_RULE", "input.keys key entries require key");
		keyNames.push(key);
		// Support optional `type` field for single-phase key events (keyDown or keyUp).
		// An omitted event represents a complete key press.
		const itemType = typeof r.type === "string" ? r.type.toLowerCase() : undefined;
		if (itemType === "keydown") {
			const failed = await emit(
				tabId,
				msg,
				"Input.dispatchKeyEvent",
				keyParams(key, "keyDown", mods(r.modifiers)),
				sent,
			);
			if (failed) return failed;
		} else if (itemType === "keyup") {
			const failed = await emit(
				tabId,
				msg,
				"Input.dispatchKeyEvent",
				keyParams(key, "keyUp", mods(r.modifiers)),
				sent,
			);
			if (failed) return failed;
		} else {
			for (const type of ["keyDown", "keyUp"]) {
				const failed = await emit(
					tabId,
					msg,
					"Input.dispatchKeyEvent",
					keyParams(key, type, mods(r.modifiers)),
					sent,
				);
				if (failed) return failed;
			}
		}
	}
	return done("input.keys", startedAt, sent, focusEmulation, { keys: keyNames });
}

async function touch(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	startedAt: number,
): Promise<BrowserPilotBridgeResponse> {
	const gesture = String(msg.gesture || "").toLowerCase(),
		x = num(msg.x, "x"),
		y = num(msg.y, "y");
	const sent: Sent[] = [],
		focusEmulation = await focus(tabId, msg),
		tp = (p: { x: number; y: number }) => [{ x: p.x, y: p.y }];
	const send = async (params: JsonRecord) => await emit(tabId, msg, "Input.dispatchTouchEvent", params, sent);
	if (gesture === "tap") {
		for (const p of [
			{ type: "touchStart", touchPoints: tp({ x, y }) },
			{ type: "touchEnd", touchPoints: [] },
		]) {
			const failed = await send(p);
			if (failed) return failed;
		}
	} else if (gesture === "swipe") {
		const explicit = points(msg.path),
			end = explicit.at(-1) || { x: opt(msg.toX) ?? x, y: opt(msg.toY) ?? y },
			path = explicit.length ? explicit : line({ x, y }, end);
		const start = await send({ type: "touchStart", touchPoints: tp({ x, y }) });
		if (start) return start;
		for (const p of path) {
			const failed = await send({ type: "touchMove", touchPoints: tp(p) });
			if (failed) return failed;
		}
		const endFailed = await send({ type: "touchEnd", touchPoints: [] });
		if (endFailed) return endFailed;
	} else return err("INVALID_RULE", "input.touch gesture must be tap or swipe", { gesture });
	return done("input.touch", startedAt, sent, focusEmulation, { gesture, coordinates: { x, y } });
}

async function handleBrowserPilotInputCommand(
	cmd: string,
	tabId: number,
	msg: BrowserPilotBridgeCommand,
): Promise<BrowserPilotBridgeResponse> {
	const startedAt = Date.now();
	try {
		if (cmd === "input.pointer") return await pointer(tabId, msg, startedAt);
		if (cmd === "input.keys") return await keys(tabId, msg, startedAt);
		if (cmd === "input.touch") return await touch(tabId, msg, startedAt);
		if (cmd === "input.ref") return await handleBrowserPilotRefInputCommand(cmd, tabId, msg, startedAt);
		return err("INVALID_RULE", "Unknown input command: " + cmd, { cmd });
	} catch (e) {
		return err("INVALID_RULE", e instanceof Error ? e.message : String(e), { cmd, tabId });
	}
}

export {
	INPUT_CDP_SESSION_NAME,
	handleBrowserPilotInputCommand,
	handleBrowserPilotRefInputCommand,
	setInputCdpSenderForTests,
};
