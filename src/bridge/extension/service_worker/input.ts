import { browserPilotPersistentCdpSend } from "./cdp";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";

const INPUT_CDP_SESSION_NAME = "browser-pilot-input";
const TIMEOUT_MS = 15000;
type Sent = { method: string; type?: string };
type RefPoint = { x: number; y: number; cdpRoute?: JsonRecord };
type BackendTarget = { backendNodeId: number; targetId?: string };

function rec(v: unknown): JsonRecord { return v && typeof v === "object" && !Array.isArray(v) ? v as JsonRecord : {}; }
function err(error_code: string, error: string, details: JsonRecord = {}): BrowserPilotBridgeResponse { return { ok: false, error_code, error, details }; }
function ok(data: JsonRecord): BrowserPilotBridgeResponse<JsonRecord> { return { ok: true, data }; }
function timeout(msg: BrowserPilotBridgeCommand): number { const n = Number(msg.timeoutMs ?? msg.timeout_ms ?? TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : TIMEOUT_MS; }
function num(v: unknown, k: string): number { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${k} must be a finite number`); return n; }
function opt(v: unknown): number | undefined { if (v === undefined || v === null || v === "") return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; }
function button(v: unknown): string { const s = String(v || "left").toLowerCase(); return ["left", "middle", "right", "back", "forward", "none"].includes(s) ? s : "left"; }
function modBit(k: string): number { k = k.toLowerCase(); return k === "alt" || k === "option" ? 1 : k === "ctrl" || k === "control" ? 2 : k === "meta" || k === "cmd" || k === "command" || k === "win" ? 4 : k === "shift" ? 8 : 0; }
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
		const r = rec(item), x = opt(r.x), y = opt(r.y);
		if (x !== undefined && y !== undefined) out.push({ x, y });
	}
	return out;
}
function line(from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Array<{ x: number; y: number }> {
	const out: Array<{ x: number; y: number }> = [];
	const n = Math.max(2, Math.min(40, Math.trunc(steps)));
	for (let i = 1; i < n; i += 1) { const t = i / n; out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }); }
	out.push(to);
	return out;
}
async function cdp(tabId: number, msg: BrowserPilotBridgeCommand, method: string, params: JsonRecord, targetId?: string): Promise<BrowserPilotBridgeResponse<JsonRecord>> {
	return await browserPilotPersistentCdpSend(tabId, method, params, { name: INPUT_CDP_SESSION_NAME, persistent: true, timeoutMs: timeout(msg), ...(targetId ? { targetId } : {}) });
}
async function focus(tabId: number, msg: BrowserPilotBridgeCommand): Promise<JsonRecord> {
	const r = await cdp(tabId, msg, "Emulation.setFocusEmulationEnabled", { enabled: true }, targetIdFor(rec(msg.target)));
	return r.ok ? { attempted: true, ok: true } : { attempted: true, ok: false, error_code: r.error_code || "SEND_FAILED", error: typeof r.error === "string" ? r.error : String(rec(r.error).message || r.error_code || "failed") };
}
async function emit(tabId: number, msg: BrowserPilotBridgeCommand, method: string, params: JsonRecord, sent: Sent[], targetId?: string): Promise<BrowserPilotBridgeResponse<JsonRecord> | undefined> {
	const r = await cdp(tabId, msg, method, params, targetId);
	sent.push({ method, type: typeof params.type === "string" ? params.type : undefined });
	return r.ok ? undefined : r;
}
function done(command: string, startedAt: number, sent: Sent[], focusEmulation: JsonRecord, extra: JsonRecord): BrowserPilotBridgeResponse<JsonRecord> {
	return ok({ input: { command, ...extra, events: sent.map(e => e.type).filter(Boolean), dispatched: sent.length, focusEmulation, cdpSessionName: INPUT_CDP_SESSION_NAME, elapsedMs: Date.now() - startedAt } });
}
function cdpErrorText(resp: BrowserPilotBridgeResponse | undefined): string { const e = rec(resp?.error); return String(e.message || resp?.message || resp?.error || resp?.error_code || "CDP command failed"); }
function backendFailure(resp: BrowserPilotBridgeResponse | undefined): "BACKEND_NODE_STALE" | "OOPIF_SESSION_UNSUPPORTED" { return /target|session|frame|oopif|isolated|cross/i.test(cdpErrorText(resp)) ? "OOPIF_SESSION_UNSUPPORTED" : "BACKEND_NODE_STALE"; }
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
	return { ...(refId ? { refId } : {}), ...(backendNodeId !== undefined ? { backendNodeId } : {}), ...(targetId ? { targetId } : {}) };
}
function failRef(code: "BACKEND_NODE_STALE" | "OOPIF_SESSION_UNSUPPORTED" | "INVALID_REF_TARGET", message: string, startedAt: number, target: JsonRecord, backendNodeId?: number, extra: JsonRecord = {}): BrowserPilotBridgeResponse {
	return err(code, message, { input: { command: "input.ref", action: "click", dispatchOnly: true, dispatched: 0, events: [], cdpSessionName: INPUT_CDP_SESSION_NAME, target: refTargetSummary(target, backendNodeId), elapsedMs: Date.now() - startedAt, ...extra } });
}
function backendTarget(target: JsonRecord): BackendTarget | undefined {
	const targetId = targetIdFor(target);
	const direct = opt(target.backendNodeId);
	if (direct !== undefined) return { backendNodeId: direct, ...(targetId ? { targetId } : {}) };
	for (const locator of Array.isArray(target.locators) ? target.locators : []) {
		const r = rec(locator), value = opt(r.value);
		if (r.by === "backendNodeId" && value !== undefined) {
			const locatorTarget = cleanString(r.targetId) ?? targetId;
			return { backendNodeId: value, ...(locatorTarget ? { targetId: locatorTarget } : {}) };
		}
	}
	return undefined;
}
function refPoint(target: JsonRecord): RefPoint | undefined {
	for (const source of [rec(target.point), rec(rec(target.geometry).point)]) { const x = opt(source.x), y = opt(source.y); if (x !== undefined && y !== undefined) return { x, y }; }
	for (const locator of Array.isArray(target.locators) ? target.locators : []) { const r = rec(locator), x = opt(r.x), y = opt(r.y); if (r.by === "point" && x !== undefined && y !== undefined) return { x, y }; }
	return undefined;
}
function centerFromBoxModel(data: JsonRecord): RefPoint | undefined {
	const result = rec(data.result);
	const rawBorder = result.border ?? rec(result.model).border;
	const border = Array.isArray(rawBorder) ? rawBorder.map(opt) : [];
	if (border.length < 8 || border.some((n) => n === undefined)) return undefined;
	const xs = [border[0], border[2], border[4], border[6]] as number[], ys = [border[1], border[3], border[5], border[7]] as number[];
	return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}
async function backendPoint(tabId: number, msg: BrowserPilotBridgeCommand, target: JsonRecord, backend: BackendTarget, startedAt: number): Promise<RefPoint | BrowserPilotBridgeResponse> {
	const id = backend.backendNodeId;
	const route = backend.targetId ? { targetId: backend.targetId, targetScoped: true } : { targetScoped: false };
	const scroll = await cdp(tabId, msg, "DOM.scrollIntoViewIfNeeded", { backendNodeId: id }, backend.targetId);
	if (!scroll.ok) return failRef(backendFailure(scroll), cdpErrorText(scroll), startedAt, target, id, { resolution: "backendNodeId", phase: "scrollIntoViewIfNeeded", ...route });
	const box = await cdp(tabId, msg, "DOM.getBoxModel", { backendNodeId: id }, backend.targetId);
	if (!box.ok) return failRef(backendFailure(box), cdpErrorText(box), startedAt, target, id, { resolution: "backendNodeId", phase: "getBoxModel", ...route });
	const cdpRoute = rec(rec(box.data).cdpRoute);
	const point = centerFromBoxModel(rec(box.data));
	if (!point) return failRef("BACKEND_NODE_STALE", "DOM.getBoxModel returned no usable border box", startedAt, target, id, { resolution: "backendNodeId", phase: "getBoxModel", ...route, ...(Object.keys(cdpRoute).length ? { cdpRoute } : {}) });
	return { ...point, ...(Object.keys(cdpRoute).length ? { cdpRoute } : {}) };
}
async function handleBrowserPilotRefInputCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand, startedAt = Date.now()): Promise<BrowserPilotBridgeResponse> {
	if (cmd !== "input.ref") return err("INVALID_RULE", "Unknown ref input command: " + cmd, { cmd });
	const action = String(msg.action || "").toLowerCase();
	if (action !== "click") return err("INVALID_RULE", "input.ref action must be click", { action });
	const target = rec(msg.target), backend = backendTarget(target);
	const point = backend ? await backendPoint(tabId, msg, target, backend, startedAt) : refPoint(target);
	if (!point) return failRef("INVALID_REF_TARGET", "input.ref target requires backendNodeId or point", startedAt, target, backend?.backendNodeId);
	if ("ok" in point) return point;
	const sent: Sent[] = [], focusEmulation = await focus(tabId, msg), base = { x: point.x, y: point.y, modifiers: 0 };
	for (const p of [{ ...base, type: "mouseMoved", button: "none" }, { ...base, type: "mousePressed", button: "left", clickCount: 1 }, { ...base, type: "mouseReleased", button: "left", clickCount: 1 }]) {
		const failed = await emit(tabId, msg, "Input.dispatchMouseEvent", p, sent, backend?.targetId);
		if (failed) return failRef("BACKEND_NODE_STALE", cdpErrorText(failed), startedAt, target, backend?.backendNodeId, { resolution: backend ? "backendNodeId" : "point", phase: "dispatchMouseEvent", attemptedEvents: sent.map((item) => item.type).filter(Boolean), ...(backend?.targetId ? { targetId: backend.targetId, targetScoped: true } : {}) });
	}
	const pointRoute = point.cdpRoute;
	return done("input.ref", startedAt, sent, focusEmulation, { action: "click", resolution: backend ? "backendNodeId" : "point", dispatchOnly: true, target: refTargetSummary(target, backend?.backendNodeId), ...(backend?.targetId ? { targetId: backend.targetId, targetScoped: true, attachRouteUsed: pointRoute?.attachRouteUsed === true, ...(pointRoute ? { cdpRoute: pointRoute } : {}) } : {}), coordinates: { x: Math.round(point.x), y: Math.round(point.y) } });
}

async function pointer(tabId: number, msg: BrowserPilotBridgeCommand, startedAt: number): Promise<BrowserPilotBridgeResponse> {
	const gesture = String(msg.gesture || "").toLowerCase(), x = num(msg.x, "x"), y = num(msg.y, "y");
	const b = button(msg.button), clickCount = Math.max(1, Math.trunc(Number(msg.count || 1))), modifiers = mods(msg.modifiers);
	const sent: Sent[] = [], focusEmulation = await focus(tabId, msg), base = { x, y, modifiers };
	const mouse = async (params: JsonRecord) => await emit(tabId, msg, "Input.dispatchMouseEvent", params, sent);
	if (gesture === "hover" || gesture === "moveonly") {
		const failed = await mouse({ ...base, type: "mouseMoved", button: "none" }); if (failed) return failed;
	} else if (gesture === "press" || gesture === "pressonly") {
		const pressOnly = gesture === "pressonly";
		const events = pressOnly
			? [{ ...base, type: "mousePressed", button: b, clickCount }]
			: [{ ...base, type: "mouseMoved", button: "none" }, { ...base, type: "mousePressed", button: b, clickCount }, { ...base, type: "mouseReleased", button: b, clickCount }];
		for (const p of events) { const failed = await mouse(p); if (failed) return failed; }
	} else if (gesture === "releaseonly") {
		const failed = await mouse({ ...base, type: "mouseReleased", button: b, clickCount }); if (failed) return failed;
	} else if (gesture === "wheel") {
		const failed = await mouse({ ...base, type: "mouseWheel", button: "none", deltaX: opt(msg.deltaX) ?? 0, deltaY: opt(msg.deltaY) ?? 0 }); if (failed) return failed;
	} else if (gesture === "drag") {
		const explicit = points(msg.path), end = explicit.at(-1) || { x: opt(msg.toX) ?? x, y: opt(msg.toY) ?? y }, path = explicit.length ? explicit : line({ x, y }, end);
		for (const p of [{ ...base, type: "mouseMoved", button: "none" }, { ...base, type: "mousePressed", button: b, clickCount }, ...path.map(p => ({ type: "mouseMoved", x: p.x, y: p.y, button: b, modifiers })), { type: "mouseReleased", x: end.x, y: end.y, button: b, clickCount, modifiers }]) { const failed = await mouse(p); if (failed) return failed; }
	} else return err("INVALID_RULE", "input.pointer gesture must be press, drag, wheel, hover, moveonly, pressonly, or releaseonly", { gesture });
	return done("input.pointer", startedAt, sent, focusEmulation, { gesture, coordinates: { x, y } });
}

// Modifier KeyboardEvent.code → [KeyboardEvent.key, virtualKeyCode]
const MODIFIER_CODES: Record<string, [string, number]> = { ShiftLeft: ["Shift", 16], ShiftRight: ["Shift", 16], ControlLeft: ["Control", 17], ControlRight: ["Control", 17], AltLeft: ["Alt", 18], AltRight: ["Alt", 18], MetaLeft: ["Meta", 91], MetaRight: ["Meta", 91] };
function keyParams(key: string, type: string, modifiers: number): JsonRecord {
	const named: Record<string, [string, number]> = { Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], Backspace: ["Backspace", 8], Delete: ["Delete", 46], ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40], Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34] };
	// browser_execute program frames pass KeyboardEvent.code values (KeyC, Digit5, ShiftLeft, …); browser_command
	// passes a single character ("a") or a named key ("Enter"). Detect the code form first.
	const letterCode = /^Key([A-Z])$/.exec(key);
	if (letterCode) { const ch = letterCode[1]!; return { type, key: ch.toLowerCase(), code: key, windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0), modifiers }; }
	const digitCode = /^Digit([0-9])$/.exec(key);
	if (digitCode) { const d = digitCode[1]!; return { type, key: d, code: key, windowsVirtualKeyCode: d.charCodeAt(0), nativeVirtualKeyCode: d.charCodeAt(0), modifiers }; }
	const mod = MODIFIER_CODES[key];
	if (mod) return { type, key: mod[0], code: key, windowsVirtualKeyCode: mod[1], nativeVirtualKeyCode: mod[1], modifiers };
	const upper = key.length === 1 ? key.toUpperCase() : key, code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(key) ? `Digit${key}` : named[key]?.[0];
	const vk = named[key]?.[1] ?? (key.length === 1 ? upper.charCodeAt(0) : undefined);
	return { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
}
async function keys(tabId: number, msg: BrowserPilotBridgeCommand, startedAt: number): Promise<BrowserPilotBridgeResponse> {
	const sent: Sent[] = [], focusEmulation = await focus(tabId, msg);
	if (typeof msg.text === "string") {
		const failed = await emit(tabId, msg, "Input.insertText", { text: msg.text }, sent); if (failed) return failed;
		return done("input.keys", startedAt, sent, focusEmulation, { text: { redacted: true, charCount: msg.text.length } });
	}
	const items = Array.isArray(msg.keys) ? msg.keys : [];
	if (!items.length) return err("INVALID_RULE", "input.keys requires text or keys");
	const keyNames: string[] = [];
	for (const item of items) {
		const r = rec(item), key = String(r.key || "");
		if (!key) return err("INVALID_RULE", "input.keys key entries require key");
		keyNames.push(key);
		// Support optional `type` field for single-phase key events (keyDown or keyUp).
		// When omitted, emit both keyDown and keyUp (legacy behavior).
		const itemType = typeof r.type === "string" ? r.type.toLowerCase() : undefined;
		if (itemType === "keydown") {
			const failed = await emit(tabId, msg, "Input.dispatchKeyEvent", keyParams(key, "keyDown", mods(r.modifiers)), sent); if (failed) return failed;
		} else if (itemType === "keyup") {
			const failed = await emit(tabId, msg, "Input.dispatchKeyEvent", keyParams(key, "keyUp", mods(r.modifiers)), sent); if (failed) return failed;
		} else {
			for (const type of ["keyDown", "keyUp"]) { const failed = await emit(tabId, msg, "Input.dispatchKeyEvent", keyParams(key, type, mods(r.modifiers)), sent); if (failed) return failed; }
		}
	}
	return done("input.keys", startedAt, sent, focusEmulation, { keys: keyNames });
}

async function touch(tabId: number, msg: BrowserPilotBridgeCommand, startedAt: number): Promise<BrowserPilotBridgeResponse> {
	const gesture = String(msg.gesture || "").toLowerCase(), x = num(msg.x, "x"), y = num(msg.y, "y");
	const sent: Sent[] = [], focusEmulation = await focus(tabId, msg), tp = (p: { x: number; y: number }) => [{ x: p.x, y: p.y }];
	const send = async (params: JsonRecord) => await emit(tabId, msg, "Input.dispatchTouchEvent", params, sent);
	if (gesture === "tap") {
		for (const p of [{ type: "touchStart", touchPoints: tp({ x, y }) }, { type: "touchEnd", touchPoints: [] }]) { const failed = await send(p); if (failed) return failed; }
	} else if (gesture === "swipe") {
		const explicit = points(msg.path), end = explicit.at(-1) || { x: opt(msg.toX) ?? x, y: opt(msg.toY) ?? y }, path = explicit.length ? explicit : line({ x, y }, end);
		const start = await send({ type: "touchStart", touchPoints: tp({ x, y }) }); if (start) return start;
		for (const p of path) { const failed = await send({ type: "touchMove", touchPoints: tp(p) }); if (failed) return failed; }
		const endFailed = await send({ type: "touchEnd", touchPoints: [] }); if (endFailed) return endFailed;
	} else return err("INVALID_RULE", "input.touch gesture must be tap or swipe", { gesture });
	return done("input.touch", startedAt, sent, focusEmulation, { gesture, coordinates: { x, y } });
}

async function handleBrowserPilotInputCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
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

export { INPUT_CDP_SESSION_NAME, handleBrowserPilotInputCommand, handleBrowserPilotRefInputCommand };
export const __browserPilotBridgeModule_input = { name: "input", symbols: { INPUT_CDP_SESSION_NAME, handleBrowserPilotInputCommand, handleBrowserPilotRefInputCommand } };
