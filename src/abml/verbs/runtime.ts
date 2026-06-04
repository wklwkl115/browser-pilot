import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { BrowserBridgeError } from "../../driver/errors.js";
import { isRecord } from "../../utils/records.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { evaluatePageScriptDirect } from "../../tools/pageScriptEvaluation.js";
import { assertBridgeCommandSucceeded } from "../../tools/bridgeResultValidation.js";
import { summarizeScanData } from "../../tools/summaries/scan.js";
import { normalizeTabId } from "../../utils/params.js";
import { resolveRefUriDetailed } from "../../resources/resourceStore.js";
import { diffEntities } from "../diff.js";
import type { Entity } from "../entity.js";
import { mergeAxIntoDomEntities, readAxEntities, type AxReadResult } from "./axRuntime.js";
import { materializeRelations, deriveStateRelationAnchors } from "../relations.js";
import { actionabilitySpecForVerb, type AbmlActionVerb } from "../actionabilityModel.js";
import { normalizeAbmlError } from "../errors.js";
import { decideRefAccess } from "../refPolicy.js";
import type { ActionabilityBlockerCode, ActionabilityPredicate, ActionabilityReport, RefDescriptor, VerificationResult } from "../types.js";
import type { AbmlClickInput, AbmlFrameInput, AbmlPierceInput, AbmlReadInput, AbmlRuntimeContext, AbmlScrollInput, AbmlTypeInput, AbmlVerbFailure, AbmlVerbResult } from "./router.js";
import { runAbmlClick } from "./click.js";
import { runAbmlRead } from "./read.js";
import { runAbmlScroll } from "./scroll.js";
import { runAbmlType } from "./type.js";
import { runAbmlPierce } from "./pierce.js";
import { runAbmlFrame } from "./frame.js";
import { inspectVisionRegion } from "./visionRuntime.js";
import { readFrameEntities, frameIdFromRef, probeFrameReachability } from "./frameRuntime.js";
import { pierceRefEntities } from "./pierceRuntime.js";

export type AbmlBrowserRuntimeServer = Pick<BrowserBridgeServer, "sendCommand" | "snapshot" | "createObservationSnapshot">;

export type BrowserAbmlRuntimeOptions = {
	browserSessionId?: string;
	tabId?: number | string;
	timeoutMs?: number;
	maxChars?: number;
};

type ActionabilityProbe = {
	selector: string;
	count: number;
	unique: boolean;
	attached: boolean;
	visible: boolean;
	disabled: boolean;
	editable: boolean;
	inViewport: boolean;
	receivesEvents: boolean;
	notOccluded: boolean;
	focused: boolean;
	scrollable: boolean;
	point?: { x: number; y: number };
	rect?: { x: number; y: number; width: number; height: number };
	url?: string;
	text?: string;
	value?: string;
	mutationTick?: number;
	activeElementMatches?: boolean;
	topNode?: string;
};

type ScrollProbe = {
	selector?: string;
	target: "window" | "element";
	scrollTop: number;
	scrollLeft: number;
	scrollHeight: number;
	clientHeight: number;
	atTop: boolean;
	atBottom: boolean;
};

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_SCAN_CAPTURE_MAX_CHARS = 100_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function failure(verb: string, error: unknown, extras: { actionability?: ActionabilityReport; verification?: VerificationResult } = {}): AbmlVerbFailure {
	const normalized = normalizeAbmlError(error, extras);
	return { ok: false, verb, error: normalized, nextActions: normalized.recovery.nextActions };
}

function currentTarget(server: AbmlBrowserRuntimeServer, options: BrowserAbmlRuntimeOptions, descriptor?: RefDescriptor): { browserSessionId?: string; tabId?: number } {
	const preferredBrowserSessionId = typeof options.browserSessionId === "string" ? options.browserSessionId : descriptor?.owner.browserSessionId;
	const snapshot = server.snapshot({ browserSessionId: preferredBrowserSessionId });
	return {
		browserSessionId: preferredBrowserSessionId ?? snapshot.browserSessionId,
		tabId: normalizeTabId(options.tabId) ?? descriptor?.owner.tabId ?? snapshot.defaultTabId,
	};
}

function resolveRefDescriptor(ref: RefDescriptor | string): { ok: true; descriptor: RefDescriptor } | { ok: false; error: unknown } {
	if (typeof ref !== "string") return { ok: true, descriptor: ref };
	const resolved = resolveRefUriDetailed(ref);
	if (!resolved.ok) return { ok: false, error: { code: resolved.code, message: resolved.error } };
	return { ok: true, descriptor: resolved.ref.descriptor };
}

function selectorFromRef(descriptor: RefDescriptor): string | undefined {
	for (const locator of descriptor.locators) if (locator.by === "css" && locator.value.trim()) return locator.value;
	return undefined;
}

function pointFromRef(descriptor: RefDescriptor): { x: number; y: number } | undefined {
	for (const locator of descriptor.locators) if (locator.by === "point") return { x: locator.x, y: locator.y };
	return descriptor.geometry?.point;
}

function frameLocatorFromRef(descriptor: RefDescriptor): string | undefined {
	for (const locator of descriptor.locators) {
		if (locator.by !== "attrSignature") continue;
		const frameId = typeof locator.value.frameId === "string" ? locator.value.frameId.trim() : "";
		if (frameId) return frameId;
	}
	return descriptor.owner.frameRef;
}

function isPointOnlyRegionRef(descriptor: RefDescriptor): boolean {
	return descriptor.kind === "region"
		&& descriptor.locators.length > 0
		&& descriptor.locators.every((locator) => locator.by === "point")
		&& descriptor.locators.some((locator) => locator.by === "point");
}

function accessForLiveVerb(descriptor: RefDescriptor, target: { browserSessionId?: string; tabId?: number }, allowReadOnly = false): { ok: true } | { ok: false; error: unknown } {
	if (!allowReadOnly && descriptor.policy.liveActionsAllowed !== true && !isPointOnlyRegionRef(descriptor)) {
		return { ok: false, error: { code: "INVALID_INPUT", message: "ABML ref does not allow live actions" } };
	}
	const access = decideRefAccess(descriptor, {
		browserSessionId: target.browserSessionId,
		tabId: target.tabId,
		topLevelOrigin: descriptor.owner.topLevelOrigin,
		now: Date.now(),
		requestedRedaction: "default",
		explicitSensitiveAccess: false,
	}, { resourceFound: true, resourceExpired: false, etagMatches: true, sensitive: descriptor.policy.redaction === "disabled" });
	if (!access.ok) return { ok: false, error: { code: access.code, message: access.reason } };
	return { ok: true };
}

function stableRectKey(rect: ActionabilityProbe["rect"]): string {
	if (!rect) return "none";
	return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)].join(":");
}

function blockerCodeForPredicate(predicate: ActionabilityPredicate): ActionabilityBlockerCode {
	switch (predicate) {
		case "unique": return "not_unique";
		case "attached": return "detached";
		case "visible": return "not_visible";
		case "stable": return "not_stable";
		case "enabled": return "disabled";
		case "editable": return "not_editable";
		case "inViewport": return "outside_viewport";
		case "scrollable": return "not_scrollable";
		case "receivesEvents": return "not_receiving_events";
		case "notOccluded": return "occluded";
	}
}

function messageForPredicate(predicate: ActionabilityPredicate): string {
	switch (predicate) {
		case "unique": return "selector matched zero or multiple live targets";
		case "attached": return "target is detached from the live DOM";
		case "visible": return "target is not visible";
		case "stable": return "target geometry is still moving";
		case "enabled": return "target is disabled";
		case "editable": return "target is not editable";
		case "inViewport": return "target is outside the viewport";
		case "scrollable": return "target is not scrollable";
		case "receivesEvents": return "target is not receiving pointer events";
		case "notOccluded": return "target is occluded by another element";
	}
}

async function evaluatePageObject(server: AbmlBrowserRuntimeServer, script: string, options: { browserSessionId?: string; tabId?: number; timeoutMs: number; name: string }): Promise<Record<string, unknown>> {
	const result = await evaluatePageScriptDirect(server as BrowserBridgeServer, script, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, name: options.name });
	if (isRecord(result.data)) return result.data;
	return { value: result.data };
}

async function sendPersistentCdp(server: AbmlBrowserRuntimeServer, options: { browserSessionId?: string; tabId?: number; timeoutMs: number; cdpMethod: string; params?: Record<string, unknown> }) {
	const result = await server.sendCommand({
		cmd: "persistent_cdp",
		action: "send",
		tabId: options.tabId,
		cdpMethod: options.cdpMethod,
		params: options.params || {},
		persistent: false,
		timeoutMs: options.timeoutMs,
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	assertBridgeCommandSucceeded(result, `persistent_cdp:${options.cdpMethod}`);
	return result;
}

function actionabilityProbeScript(selector: string): string {
	return `(() => {
		window.__PI_ABML_MUTATION_TICK__ = window.__PI_ABML_MUTATION_TICK__ || 0;
		if (!window.__PI_ABML_MUTATION_OBSERVER__) {
			try {
				window.__PI_ABML_MUTATION_OBSERVER__ = new MutationObserver(() => { window.__PI_ABML_MUTATION_TICK__ += 1; });
				window.__PI_ABML_MUTATION_OBSERVER__.observe(document.documentElement || document.body || document, { childList: true, subtree: true, attributes: true, characterData: true });
			} catch (_) {}
		}
		const selector = ${JSON.stringify(selector)};
		let nodes;
		try { nodes = Array.from(document.querySelectorAll(selector)); }
		catch (error) { return { syntaxError: String(error && error.message ? error.message : error), selector }; }
		const node = nodes[0] || null;
		const count = nodes.length;
		const editable = (el) => {
			if (!el) return false;
			const tag = String(el.tagName || '').toLowerCase();
			if (tag === 'textarea' || tag === 'select') return true;
			if (tag === 'input') return !['hidden','button','submit','reset','checkbox','radio','file','image'].includes(String(el.type || '').toLowerCase());
			return !!el.isContentEditable || el.getAttribute('contenteditable') === 'true';
		};
		const disabled = (el) => !!(el && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')));
		const scrollable = (el) => {
			let cur = el;
			while (cur) {
				try {
					const cs = getComputedStyle(cur);
					if ((/(auto|scroll|overlay)/.test(cs.overflowY || '') || /(auto|scroll|overlay)/.test(cs.overflow || '')) && cur.scrollHeight > cur.clientHeight + 1) return true;
				} catch (_) {}
				cur = cur.parentElement;
			}
			return (document.scrollingElement?.scrollHeight || 0) > (document.scrollingElement?.clientHeight || 0) + 1;
		};
		if (!node) return { selector, count, unique: count === 1, attached: false, visible: false, disabled: false, editable: false, inViewport: false, receivesEvents: false, notOccluded: false, focused: false, scrollable: false, mutationTick: window.__PI_ABML_MUTATION_TICK__ || 0, url: location.href };
		const rect = node.getBoundingClientRect();
		const cs = getComputedStyle(node);
		const viewportW = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
		const viewportH = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
		const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < viewportH && rect.left < viewportW;
		const visible = !!(rect.width || rect.height) && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
		const point = { x: Math.round(Math.max(0, Math.min(viewportW - 1, rect.left + rect.width / 2))), y: Math.round(Math.max(0, Math.min(viewportH - 1, rect.top + rect.height / 2))) };
		const hit = visible && inViewport && document.elementFromPoint ? document.elementFromPoint(point.x, point.y) : null;
		const receivesEvents = !!hit && (hit === node || node.contains(hit) || (typeof hit.contains === 'function' && hit.contains(node)));
		const notOccluded = receivesEvents;
		const tag = String(node.tagName || '').toLowerCase();
		const role = node.getAttribute && node.getAttribute('role');
		const value = tag === 'input' || tag === 'textarea' || tag === 'select' ? String(node.value || '') : (editable(node) ? String(node.textContent || '') : (node.getAttribute && node.getAttribute('value')) || '');
		return {
			selector,
			count,
			unique: count === 1,
			attached: true,
			visible,
			disabled: disabled(node),
			editable: editable(node),
			inViewport,
			receivesEvents,
			notOccluded,
			focused: document.activeElement === node,
			scrollable: scrollable(node),
			point,
			rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			url: location.href,
			text: String(node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
			value,
			mutationTick: window.__PI_ABML_MUTATION_TICK__ || 0,
			activeElementMatches: document.activeElement === node,
			topNode: hit && hit.tagName ? String(hit.tagName).toLowerCase() : undefined,
			role,
			tag,
		};
	})()`;
}

function scrollIntoViewScript(selector: string): string {
	return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { scrolled: false, missing: true }; if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' }); return { scrolled: true, selector: ${JSON.stringify(selector)} }; })()`;
}

function syntheticClickScript(selector: string): string {
	return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { clicked: false, missing: true }; if (typeof el.click !== 'function') return { clicked: false, clickable: false }; el.click(); return { clicked: true }; })()`;
}

function focusAndMaybeClearScript(selector: string, clear: boolean): string {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) return { focused: false, missing: true };
		if (typeof el.focus === 'function') el.focus();
		const tag = String(el.tagName || '').toLowerCase();
		const isEditable = !!el.isContentEditable || el.getAttribute('contenteditable') === 'true' || tag === 'textarea' || tag === 'select' || (tag === 'input' && !['hidden','button','submit','reset','checkbox','radio','file','image'].includes(String(el.type || '').toLowerCase()));
		let before = tag === 'input' || tag === 'textarea' || tag === 'select' ? String(el.value || '') : String(el.textContent || '');
		if (${clear ? "true" : "false"}) {
			if (tag === 'input' || tag === 'textarea' || tag === 'select') el.value = '';
			else if (isEditable) el.textContent = '';
			try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); }
			catch (_) { try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} }
		}
		return { focused: document.activeElement === el, editable: isEditable, valueBefore: before, valueAfterClear: tag === 'input' || tag === 'textarea' || tag === 'select' ? String(el.value || '') : String(el.textContent || '') };
	})()`;
}

function verificationProbeScript(selector: string): string {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		const tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
		const value = !el ? undefined : (tag === 'input' || tag === 'textarea' || tag === 'select' ? String(el.value || '') : String(el.textContent || ''));
		return { url: location.href, activeElementMatches: !!el && document.activeElement === el, value, text: !el ? undefined : String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500), mutationTick: window.__PI_ABML_MUTATION_TICK__ || 0 };
	})()`;
}

function scrollProbeScript(selector?: string): string {
	return `(() => {
		const selector = ${JSON.stringify(selector || "")};
		const pickScrollable = (node) => {
			let cur = node;
			while (cur) {
				try {
					const cs = getComputedStyle(cur);
					if ((/(auto|scroll|overlay)/.test(cs.overflowY || '') || /(auto|scroll|overlay)/.test(cs.overflow || '')) && cur.scrollHeight > cur.clientHeight + 1) return cur;
				} catch (_) {}
				cur = cur.parentElement;
			}
			return document.scrollingElement || document.documentElement || document.body;
		};
		const source = selector ? document.querySelector(selector) : null;
		const target = pickScrollable(source);
		const top = Number(target === document.scrollingElement || target === document.documentElement || target === document.body ? (window.scrollY || document.scrollingElement?.scrollTop || 0) : target.scrollTop || 0);
		const left = Number(target === document.scrollingElement || target === document.documentElement || target === document.body ? (window.scrollX || document.scrollingElement?.scrollLeft || 0) : target.scrollLeft || 0);
		const scrollHeight = Number(target.scrollHeight || 0);
		const clientHeight = Number(target.clientHeight || 0);
		return { selector: selector || undefined, target: target === document.scrollingElement || target === document.documentElement || target === document.body ? 'window' : 'element', scrollTop: top, scrollLeft: left, scrollHeight, clientHeight, atTop: top <= 0, atBottom: top + clientHeight >= scrollHeight - 1 };
	})()`;
}

function scrollStepScript(selector: string | undefined, to: AbmlScrollInput["to"], steps: number): string {
	return `(() => {
		const selector = ${JSON.stringify(selector || "")};
		const to = ${JSON.stringify(to || "next")};
		const steps = ${Math.max(1, steps)};
		const pickScrollable = (node) => {
			let cur = node;
			while (cur) {
				try {
					const cs = getComputedStyle(cur);
					if ((/(auto|scroll|overlay)/.test(cs.overflowY || '') || /(auto|scroll|overlay)/.test(cs.overflow || '')) && cur.scrollHeight > cur.clientHeight + 1) return cur;
				} catch (_) {}
				cur = cur.parentElement;
			}
			return document.scrollingElement || document.documentElement || document.body;
		};
		const source = selector ? document.querySelector(selector) : null;
		const target = pickScrollable(source);
		const isWindow = target === document.scrollingElement || target === document.documentElement || target === document.body;
		const getTop = () => Number(isWindow ? (window.scrollY || document.scrollingElement?.scrollTop || 0) : target.scrollTop || 0);
		const viewport = Number(isWindow ? (window.innerHeight || document.documentElement?.clientHeight || 0) : target.clientHeight || 0);
		const beforeTop = getTop();
		const delta = Math.max(40, Math.round(viewport * 0.8) * steps);
		const api = isWindow ? window : target;
		if (to === 'top') api.scrollTo ? api.scrollTo({ top: 0, behavior: 'instant' }) : (target.scrollTop = 0);
		else if (to === 'bottom') api.scrollTo ? api.scrollTo({ top: target.scrollHeight, behavior: 'instant' }) : (target.scrollTop = target.scrollHeight);
		else if (to === 'previous') api.scrollBy ? api.scrollBy({ top: -delta, behavior: 'instant' }) : (target.scrollTop = beforeTop - delta);
		else if (typeof to === 'object' && to !== null) api.scrollTo ? api.scrollTo({ top: Number(to.y || 0), left: Number(to.x || 0), behavior: 'instant' }) : (target.scrollTop = Number(to.y || 0));
		else api.scrollBy ? api.scrollBy({ top: delta, behavior: 'instant' }) : (target.scrollTop = beforeTop + delta);
		const afterTop = getTop();
		return { selector: selector || undefined, target: isWindow ? 'window' : 'element', beforeTop, afterTop, changed: afterTop !== beforeTop };
	})()`;
}

function probeToActionability(probe: ActionabilityProbe, stable: boolean, _specRequired: ActionabilityPredicate[]): Partial<Record<ActionabilityPredicate, boolean>> {
	return {
		unique: probe.unique,
		attached: probe.attached,
		visible: probe.visible,
		stable,
		enabled: !probe.disabled,
		editable: probe.editable,
		inViewport: probe.inViewport,
		scrollable: probe.scrollable,
		receivesEvents: probe.receivesEvents,
		notOccluded: probe.notOccluded,
	};
}

function buildActionabilityReport(spec: ReturnType<typeof actionabilitySpecForVerb>, elapsedMs: number, attempts: number, checks: Partial<Record<ActionabilityPredicate, boolean>>, probe?: ActionabilityProbe): ActionabilityReport {
	const blockers = spec.required.filter((predicate) => checks[predicate] !== true).map((predicate) => ({
		code: blockerCodeForPredicate(predicate),
		message: messageForPredicate(predicate),
		evidence: probe ? { selector: probe.selector, count: probe.count, visible: probe.visible, disabled: probe.disabled, editable: probe.editable, inViewport: probe.inViewport, topNode: probe.topNode } : undefined,
	}));
	return {
		ok: blockers.length === 0,
		spec,
		elapsedMs,
		attempts,
		checks,
		blockers,
		...(probe?.point ? { hitTest: { x: probe.point.x, y: probe.point.y, topNode: probe.topNode, matchedTarget: probe.receivesEvents } } : {}),
	};
}

async function probeActionability(server: AbmlBrowserRuntimeServer, target: { browserSessionId?: string; tabId?: number }, selector: string, timeoutMs: number): Promise<ActionabilityProbe> {
	const value = await evaluatePageObject(server, actionabilityProbeScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_actionability_probe" });
	if (typeof value.syntaxError === "string") throw new BrowserBridgeError("INVALID_SELECTOR", value.syntaxError, { selector });
	return {
		selector,
		count: Number(value.count || 0),
		unique: value.unique === true,
		attached: value.attached === true,
		visible: value.visible === true,
		disabled: value.disabled === true,
		editable: value.editable === true,
		inViewport: value.inViewport === true,
		receivesEvents: value.receivesEvents === true,
		notOccluded: value.notOccluded === true,
		focused: value.focused === true,
		scrollable: value.scrollable === true,
		...(value.point && typeof value.point === "object" ? { point: { x: Number((value.point as Record<string, unknown>).x || 0), y: Number((value.point as Record<string, unknown>).y || 0) } } : {}),
		...(value.rect && typeof value.rect === "object" ? { rect: { x: Number((value.rect as Record<string, unknown>).x || 0), y: Number((value.rect as Record<string, unknown>).y || 0), width: Number((value.rect as Record<string, unknown>).width || 0), height: Number((value.rect as Record<string, unknown>).height || 0) } } : {}),
		url: typeof value.url === "string" ? value.url : undefined,
		text: typeof value.text === "string" ? value.text : undefined,
		value: typeof value.value === "string" ? value.value : undefined,
		mutationTick: Number(value.mutationTick || 0),
		activeElementMatches: value.activeElementMatches === true,
		topNode: typeof value.topNode === "string" ? value.topNode : undefined,
	};
}

async function ensureActionability(server: AbmlBrowserRuntimeServer, selector: string, verb: AbmlActionVerb, target: { browserSessionId?: string; tabId?: number }, timeoutMs: number): Promise<{ ok: true; report: ActionabilityReport; probe: ActionabilityProbe } | { ok: false; report: ActionabilityReport }> {
	const spec = actionabilitySpecForVerb(verb);
	const startedAt = Date.now();
	let attempts = 0;
	let lastProbe: ActionabilityProbe | undefined;
	let stableSince = 0;
	let lastStableKey = "";
	let scrolledIntoView = false;
	while (Date.now() - startedAt <= timeoutMs) {
		attempts += 1;
		const probe = await probeActionability(server, target, selector, timeoutMs);
		lastProbe = probe;
		const rectKey = stableRectKey(probe.rect);
		if (rectKey !== lastStableKey) {
			lastStableKey = rectKey;
			stableSince = Date.now();
		}
		const stable = probe.attached && probe.visible && (Date.now() - stableSince >= spec.stableWindowMs || attempts === 1 && spec.stableWindowMs === 0);
		const checks = probeToActionability(probe, stable, spec.required);
		if (checks.inViewport === false && spec.required.includes("inViewport") && !scrolledIntoView) {
			scrolledIntoView = true;
			await evaluatePageObject(server, scrollIntoViewScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_scroll_into_view" });
			await delay(spec.pollMs);
			continue;
		}
		const report = buildActionabilityReport(spec, Date.now() - startedAt, attempts, checks, probe);
		if (report.ok) return { ok: true, report, probe };
		await delay(spec.pollMs);
	}
	return { ok: false, report: buildActionabilityReport(spec, Date.now() - startedAt, attempts, probeToActionability(lastProbe || { selector, count: 0, unique: false, attached: false, visible: false, disabled: false, editable: false, inViewport: false, receivesEvents: false, notOccluded: false, focused: false, scrollable: false }, false, spec.required), lastProbe) };
}

async function clickVerificationProbe(server: AbmlBrowserRuntimeServer, target: { browserSessionId?: string; tabId?: number }, selector: string, timeoutMs: number) {
	return await evaluatePageObject(server, verificationProbeScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_click_verify" });
}

function verifyClick(before: Record<string, unknown>, after: Record<string, unknown>): VerificationResult {
	const urlChanged = before.url !== after.url;
	const focusChanged = before.activeElementMatches !== after.activeElementMatches && after.activeElementMatches === true;
	const mutationChanged = Number(before.mutationTick || 0) !== Number(after.mutationTick || 0);
	const valueChanged = before.value !== after.value || before.text !== after.text;
	const verified = urlChanged || focusChanged || mutationChanged || valueChanged;
	return {
		status: verified ? "verified" : "inconclusive",
		verb: "click",
		observed: { before, after, urlChanged, focusChanged, mutationChanged, valueChanged },
		evidence: [
			{ kind: "probe", summary: `urlChanged=${urlChanged} focusChanged=${focusChanged} mutationChanged=${mutationChanged} valueChanged=${valueChanged}` },
		],
		elapsedMs: 0,
	};
}

async function typeVerificationProbe(server: AbmlBrowserRuntimeServer, target: { browserSessionId?: string; tabId?: number }, selector: string, timeoutMs: number) {
	return await evaluatePageObject(server, verificationProbeScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_type_verify" });
}

function verifyType(before: Record<string, unknown>, after: Record<string, unknown>, text: string, clear: boolean): VerificationResult {
	const beforeValue = String(before.value ?? before.text ?? "");
	const afterValue = String(after.value ?? after.text ?? "");
	const verified = clear ? afterValue === text : afterValue.includes(text) || afterValue === `${beforeValue}${text}`;
	return {
		status: verified ? "verified" : after.activeElementMatches === true ? "inconclusive" : "failed",
		verb: "type",
		expected: { clear, text },
		observed: { beforeValue, afterValue, focused: after.activeElementMatches === true },
		evidence: [{ kind: "probe", summary: `before=${beforeValue.length} after=${afterValue.length} focused=${after.activeElementMatches === true}` }],
		elapsedMs: 0,
	};
}

async function executeBrowserAbmlRead(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions = {}): Promise<AbmlVerbResult> {
	return await runAbmlRead(input, async () => {
		if (input.plane && input.plane !== "structure") throw { code: "BACKEND_UNAVAILABLE", message: `ABML read plane is not implemented yet: ${input.plane}`, details: { plane: input.plane } };
		const resolved = input.ref ? resolveRefDescriptor(input.ref) : undefined;
		if (resolved && !resolved.ok) throw resolved.error;
		const descriptor = resolved && resolved.ok ? resolved.descriptor : undefined;
		const target = currentTarget(server, options, descriptor);
		if (!target.tabId) throw new BrowserBridgeError("NO_TAB", "No target browser tab is available for ABML read", { browserSessionId: target.browserSessionId });
		if (descriptor) {
			const access = accessForLiveVerb(descriptor, target, true);
			if (!access.ok) throw access.error;
		}
		if (descriptor?.kind === "region" && isPointOnlyRegionRef(descriptor)) {
			const inspected = await inspectVisionRegion(server, descriptor, {
				browserSessionId: target.browserSessionId,
				tabId: target.tabId,
				timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
			});
			if (!inspected.ok) throw inspected.error;
			return {
				entities: [inspected.entity],
				data: { ...inspected.data, source: "vision-floor", observationId: descriptor.observationId },
			};
		}
		if (descriptor?.kind === "frame") {
			const frameRead = await readFrameEntities(server, {
				browserSessionId: target.browserSessionId,
				tabId: target.tabId,
				observationId: descriptor.observationId,
				capturedAt: descriptor.createdAt,
				depth: input.depth,
			});
			const frameId = frameLocatorFromRef(descriptor);
			const filteredFrames = frameId ? frameRead.entities.filter((entity) => entity.hints?.frameId === frameId || entity.value === frameId) : frameRead.entities;
			return {
				entities: filteredFrames,
				data: { frameTree: frameRead.frameTree, frameCount: frameRead.frames.length, frameId, source: "frame.list", observationId: descriptor.observationId, tabId: target.tabId },
			};
		}
		const scan = await evaluatePageScriptDirect(server as BrowserBridgeServer, buildScanScript({ textOnly: false, maxChars: Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_SCAN_CAPTURE_MAX_CHARS), includeIframes: true }), {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
			name: "abml_read_scan",
		});
		const data = scan.data as Record<string, unknown>;
		const bridge = server.snapshot({ browserSessionId: target.browserSessionId });
		const snapshot = server.createObservationSnapshot({
			browserSessionId: bridge.browserSessionId,
			tabId: target.tabId,
			url: typeof data?.url === "string" ? data.url : descriptor?.documentEpoch?.url,
			frameScope: "tab",
			selectionVersion: bridge.selectionVersion,
			sourceMode: "scan",
			capturedAt: Date.now(),
		});
		const summary = summarizeScanData(data, bridge.tabs || [], {
			detailLevel: "summary",
			maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
			entityContext: {
				browserSessionId: bridge.browserSessionId,
				tabId: target.tabId,
				url: typeof data?.url === "string" ? data.url : descriptor?.documentEpoch?.url,
				observationId: snapshot.snapshotId,
				capturedAt: snapshot.capturedAt,
			},
		});
		const focus = summary.focus && typeof summary.focus === "object" ? summary.focus as Record<string, unknown> : {};
		const entities = [
			...(Array.isArray(focus.primary_entities) ? focus.primary_entities : []),
			...(Array.isArray(focus.list_entities) ? focus.list_entities : []),
			...(Array.isArray(focus.visual_regions) ? focus.visual_regions : []),
			...(Array.isArray(focus.referenced_entities) ? focus.referenced_entities : []),
		].filter((item): item is Entity => isRecord(item));
		const axRead = await readAxEntities(server, {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			observationId: snapshot.snapshotId,
			url: typeof data?.url === "string" ? data.url : descriptor?.documentEpoch?.url,
			capturedAt: snapshot.capturedAt,
			timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
		}).catch((): AxReadResult => ({ entities: [], anchors: [] }));
		const mergedEntities = axRead.entities.length ? mergeAxIntoDomEntities(entities, axRead.entities) : entities;
		// AX anchors (property/table) + DOM-sourced anchors derived from the merged entities'
		// own state (currentIn from aria-current, occludes/coveredBy from the hit-test). Materialize
		// to typed pi-ref edges only after the merge mints final refs.
		const allAnchors = [...axRead.anchors, ...deriveStateRelationAnchors(mergedEntities)];
		const relatedEntities = allAnchors.length ? materializeRelations(mergedEntities, allAnchors) : mergedEntities;
		const relationCount = relatedEntities.reduce((sum, entity) => sum + (entity.relations?.length ?? 0), 0);
		const filtered = descriptor ? filterEntitiesForRef(relatedEntities, descriptor) : relatedEntities;
		return {
			entities: filtered,
			data: { summary, snapshotId: snapshot.snapshotId, observationId: snapshot.snapshotId, tabId: target.tabId, url: data?.url, axEntityCount: axRead.entities.length, mergedEntityCount: mergedEntities.length, relationCount },
		};
	});
}

function entityKey(entity: Entity): string {
	const selector = typeof entity.hints?.selector === "string" ? entity.hints.selector : undefined;
	const jsonPath = typeof entity.hints?.jsonPath === "string" ? entity.hints.jsonPath : undefined;
	const frameId = typeof entity.hints?.frameId === "string" ? entity.hints.frameId : undefined;
	const locators = Array.isArray(entity.locators) ? JSON.stringify(entity.locators) : undefined;
	return selector || jsonPath || frameId || locators || entity.ref;
}

function filterEntitiesForRef(entities: Entity[], descriptor: RefDescriptor): Entity[] {
	const selector = selectorFromRef(descriptor);
	if (descriptor.kind === "frame") {
		const frameId = frameLocatorFromRef(descriptor);
		return frameId ? entities.filter((entity) => entity.hints?.frameId === frameId || entity.value === frameId) : entities;
	}
	if (!selector) return entities;
	return entities.filter((entity) => entity.hints?.selector === selector || entity.locators?.some((locator) => locator.by === "css" && locator.value === selector));
}

async function executeBrowserAbmlClick(server: AbmlBrowserRuntimeServer, input: AbmlClickInput, options: BrowserAbmlRuntimeOptions = {}): Promise<AbmlVerbResult> {
	const resolved = resolveRefDescriptor(input.ref);
	if (!resolved.ok) return failure("click", resolved.error);
	const descriptor = resolved.descriptor;
	const target = currentTarget(server, options, descriptor);
	if (!target.tabId) return failure("click", { code: "NO_TAB", message: "No target browser tab is available for ABML click" });
	const access = accessForLiveVerb(descriptor, target);
	if (!access.ok) return failure("click", access.error);
	const selector = selectorFromRef(descriptor);
	const point = pointFromRef(descriptor);
	if (!selector && !point) return failure("click", { code: "INVALID_INPUT", message: "ABML click requires a css locator or point-backed region ref" });
	return await runAbmlClick(input, async () => {
		const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
		if (!selector) {
			const fallbackPoint = pointFromRef(descriptor);
			if (!fallbackPoint) return { verification: { status: "failed", verb: "click", observed: { reason: "missing point" }, evidence: [{ kind: "point", summary: "point-backed region ref is missing geometry" }], elapsedMs: 0 } };
			await sendPersistentCdp(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, cdpMethod: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: fallbackPoint.x, y: fallbackPoint.y, button: input.button || "left", clickCount: input.count ?? 1 } });
			await sendPersistentCdp(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, cdpMethod: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: fallbackPoint.x, y: fallbackPoint.y, button: input.button || "left", clickCount: input.count ?? 1 } });
			return {
				data: { transport: "cdp", selector: undefined, point: fallbackPoint, visualFloor: true },
				actionability: {
					ok: true,
					spec: actionabilitySpecForVerb("click"),
					elapsedMs: 0,
					attempts: 1,
					checks: { attached: true, visible: true, inViewport: true, receivesEvents: true, notOccluded: true },
					blockers: [],
					hitTest: { x: fallbackPoint.x, y: fallbackPoint.y, matchedTarget: true },
				},
				verification: { status: "verified", verb: "click", observed: { point: fallbackPoint, visualFloor: true }, evidence: [{ kind: "point", summary: `clicked visual region at ${fallbackPoint.x},${fallbackPoint.y}` }], elapsedMs: 0 },
			};
		}
		const actionability = await ensureActionability(server, selector, "click", target, timeoutMs);
		if (!actionability.ok) return { actionability: actionability.report };
		const beforeRead = await executeBrowserAbmlRead(server, { plane: "structure" }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs });
		const beforeEntities = beforeRead.ok ? beforeRead.entities : undefined;
		const before = await clickVerificationProbe(server, target, selector, timeoutMs);
		let domResult: Record<string, unknown> | undefined;
		try {
			domResult = await evaluatePageObject(server, syntheticClickScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_click_dom" });
		} catch {
			domResult = undefined;
		}
		let after = await clickVerificationProbe(server, target, selector, timeoutMs);
		let verification = verifyClick(before, after);
		let transport: "dom" | "cdp" = "dom";
		if (verification.status !== "verified") {
			const actionPoint = actionability.probe.point || pointFromRef(descriptor);
			if (!actionPoint) return { data: { transport, domResult }, actionability: actionability.report, verification };
			await sendPersistentCdp(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, cdpMethod: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: actionPoint.x, y: actionPoint.y, button: input.button || "left", clickCount: input.count ?? 1 } });
			await sendPersistentCdp(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, cdpMethod: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: actionPoint.x, y: actionPoint.y, button: input.button || "left", clickCount: input.count ?? 1 } });
			after = await clickVerificationProbe(server, target, selector, timeoutMs);
			verification = verifyClick(before, after);
			transport = "cdp";
		}
		const afterRead = beforeEntities ? await executeBrowserAbmlRead(server, { plane: "structure" }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs }) : undefined;
		const diff = beforeEntities && afterRead?.ok && afterRead.entities ? diffEntities(beforeEntities, afterRead.entities) : undefined;
		return {
			data: { transport, domResult, selector, ...(diff ? { diff } : {}) },
			...(diff ? { diff } : {}),
			actionability: actionability.report,
			verification,
		};
	});
}

async function executeBrowserAbmlType(server: AbmlBrowserRuntimeServer, input: AbmlTypeInput, options: BrowserAbmlRuntimeOptions = {}): Promise<AbmlVerbResult> {
	const resolved = resolveRefDescriptor(input.ref);
	if (!resolved.ok) return failure("type", resolved.error);
	const descriptor = resolved.descriptor;
	const target = currentTarget(server, options, descriptor);
	if (!target.tabId) return failure("type", { code: "NO_TAB", message: "No target browser tab is available for ABML type" });
	const access = accessForLiveVerb(descriptor, target);
	if (!access.ok) return failure("type", access.error);
	const selector = selectorFromRef(descriptor);
	if (!selector) return failure("type", { code: "INVALID_INPUT", message: "ABML type currently requires a css locator" });
	return await runAbmlType(input, async () => {
		const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
		const actionability = await ensureActionability(server, selector, "type", target, timeoutMs);
		if (!actionability.ok) return { actionability: actionability.report };
		const beforeRead = await executeBrowserAbmlRead(server, { plane: "structure" }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs });
		const beforeEntities = beforeRead.ok ? beforeRead.entities : undefined;
		const before = await typeVerificationProbe(server, target, selector, timeoutMs);
		const focusResult = await evaluatePageObject(server, focusAndMaybeClearScript(selector, input.clear === true), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_type_focus" });
		if (focusResult.focused !== true) throw { code: "TARGET_NOT_EDITABLE", message: "ABML type could not focus the target", details: { selector } };
		await sendPersistentCdp(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, cdpMethod: "Input.insertText", params: { text: input.text } });
		const after = await typeVerificationProbe(server, target, selector, timeoutMs);
		const verification = verifyType(before, after, input.text, input.clear === true);
		const afterRead = beforeEntities ? await executeBrowserAbmlRead(server, { plane: "structure" }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs }) : undefined;
		const diff = beforeEntities && afterRead?.ok && afterRead.entities ? diffEntities(beforeEntities, afterRead.entities) : undefined;
		return {
			data: { transport: "cdp", selector, focusResult, ...(diff ? { diff } : {}) },
			...(diff ? { diff } : {}),
			actionability: actionability.report,
			verification,
		};
	});
}

function verifyScroll(before: ScrollProbe, after: ScrollProbe): VerificationResult {
	const changed = before.scrollTop !== after.scrollTop || before.scrollLeft !== after.scrollLeft;
	const atEdge = after.atTop || after.atBottom;
	return {
		status: changed || atEdge ? "verified" : "failed",
		verb: "scroll",
		observed: { before, after, changed, atEdge },
		evidence: [{ kind: "probe", summary: `before=${before.scrollTop} after=${after.scrollTop} atTop=${after.atTop} atBottom=${after.atBottom}` }],
		elapsedMs: 0,
	};
}

function dedupeCollectedEntities(entities: Entity[]): Entity[] {
	const seen = new Set<string>();
	const out: Entity[] = [];
	for (const entity of entities) {
		const key = entityKey(entity);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entity);
	}
	return out;
}

async function scrollProbe(server: AbmlBrowserRuntimeServer, target: { browserSessionId?: string; tabId?: number }, selector: string | undefined, timeoutMs: number): Promise<ScrollProbe> {
	const value = await evaluatePageObject(server, scrollProbeScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_scroll_probe" });
	return {
		selector: typeof value.selector === "string" ? value.selector : undefined,
		target: value.target === "element" ? "element" : "window",
		scrollTop: Number(value.scrollTop || 0),
		scrollLeft: Number(value.scrollLeft || 0),
		scrollHeight: Number(value.scrollHeight || 0),
		clientHeight: Number(value.clientHeight || 0),
		atTop: value.atTop === true,
		atBottom: value.atBottom === true,
	};
}

async function executeBrowserAbmlScroll(server: AbmlBrowserRuntimeServer, input: AbmlScrollInput, options: BrowserAbmlRuntimeOptions = {}): Promise<AbmlVerbResult> {
	const resolved = input.ref ? resolveRefDescriptor(input.ref) : undefined;
	if (resolved && !resolved.ok) return failure("scroll", resolved.error);
	const descriptor = resolved && resolved.ok ? resolved.descriptor : undefined;
	const target = currentTarget(server, options, descriptor);
	if (!target.tabId) return failure("scroll", { code: "NO_TAB", message: "No target browser tab is available for ABML scroll" });
	if (descriptor) {
		const access = accessForLiveVerb(descriptor, target);
		if (!access.ok) return failure("scroll", access.error);
	}
	const selector = descriptor ? selectorFromRef(descriptor) : undefined;
	return await runAbmlScroll(input, async () => {
		const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
		const collected: Entity[] = [];
		const before = await scrollProbe(server, target, selector, timeoutMs);
		const requestedSteps = Math.max(1, input.steps ?? 1);
		const maxIterations = Math.max(requestedSteps, requestedSteps + 6);
		let lastStep: Record<string, unknown> | undefined;
		let stablePasses = 0;
		let previousScrollHeight = before.scrollHeight;
		let previousEntityCount = 0;
		let iterations = 0;
		for (; iterations < maxIterations; iterations += 1) {
			lastStep = await evaluatePageObject(server, scrollStepScript(selector, input.to, 1), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_scroll_step" });
			const readResult = await executeBrowserAbmlRead(server, { plane: "structure", ref: descriptor }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs });
			if (readResult.ok && Array.isArray(readResult.entities)) collected.push(...readResult.entities);
			const deduped = dedupeCollectedEntities(collected);
			const probe = await scrollProbe(server, target, selector, timeoutMs);
			const unchangedHeight = probe.scrollHeight === previousScrollHeight;
			const unchangedEntities = deduped.length === previousEntityCount;
			const unchangedPosition = probe.atBottom || probe.scrollTop === before.scrollTop || lastStep?.changed === false;
			if (unchangedHeight && unchangedEntities && unchangedPosition) stablePasses += 1;
			else stablePasses = 0;
			previousScrollHeight = probe.scrollHeight;
			previousEntityCount = deduped.length;
			if (iterations + 1 >= requestedSteps && stablePasses >= 2) break;
		}
		const after = await scrollProbe(server, target, selector, timeoutMs);
		return {
			data: { selector, stepResult: lastStep, before, after, iterations, stablePasses, virtualCollectionStop: stablePasses >= 2 || after.atBottom === true },
			verification: verifyScroll(before, after),
			entities: dedupeCollectedEntities(collected),
		};
	});
}

async function executeBrowserAbmlPierce(server: AbmlBrowserRuntimeServer, input: AbmlPierceInput, options: BrowserAbmlRuntimeOptions = {}): Promise<AbmlVerbResult> {
	const resolved = resolveRefDescriptor(input.ref);
	if (!resolved.ok) return failure("pierce", resolved.error);
	const descriptor = resolved.descriptor;
	const target = currentTarget(server, options, descriptor);
	if (!target.tabId) return failure("pierce", { code: "NO_TAB", message: "No target browser tab is available for ABML pierce" });
	const access = accessForLiveVerb(descriptor, target, true);
	if (!access.ok) return failure("pierce", access.error);
	return await runAbmlPierce(input, async () => {
		const pierced = await pierceRefEntities(server, descriptor, {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId!,
			observationId: descriptor.observationId,
			capturedAt: descriptor.createdAt,
			timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
		});
		if (!pierced.ok) throw pierced.error;
		return { entities: pierced.entities, data: pierced.data };
	});
}

async function executeBrowserAbmlFrame(server: AbmlBrowserRuntimeServer, input: AbmlFrameInput, options: BrowserAbmlRuntimeOptions = {}): Promise<AbmlVerbResult> {
	const resolved = input.ref ? resolveRefDescriptor(input.ref) : undefined;
	if (resolved && !resolved.ok) return failure("frame", resolved.error);
	const descriptor = resolved && resolved.ok ? resolved.descriptor : undefined;
	const target = currentTarget(server, options, descriptor);
	if (!target.tabId) return failure("frame", { code: "NO_TAB", message: "No target browser tab is available for ABML frame" });
	if (descriptor) {
		const access = accessForLiveVerb(descriptor, target, true);
		if (!access.ok) return failure("frame", access.error);
	}
	return await runAbmlFrame(input, async () => {
		const observationId = descriptor?.observationId || `frame:${target.tabId}`;
		const frameRead = await readFrameEntities(server, {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId!,
			observationId,
			capturedAt: descriptor?.createdAt,
			depth: input.depth,
		});
		const frameId = descriptor ? (frameIdFromRef(descriptor) || frameLocatorFromRef(descriptor)) : undefined;
		if (frameId) {
			const reachability = await probeFrameReachability(server, { browserSessionId: target.browserSessionId, tabId: target.tabId!, frameId, timeoutMs: options.timeoutMs ?? 8_000 });
			if (!reachability.ok) throw reachability.error;
		}
		return {
			entities: frameId ? frameRead.entities.filter((entity) => entity.hints?.frameId === frameId || entity.value === frameId) : frameRead.entities,
			data: { frameTree: frameRead.frameTree, frameCount: frameRead.frames.length, frameId, source: "frame.list", oopifBoundaryExplicit: true, abmlIntegrated: true },
		};
	});
}

export function createBrowserAbmlRuntime(server: AbmlBrowserRuntimeServer, options: BrowserAbmlRuntimeOptions = {}): AbmlRuntimeContext {
	return {
		read: async (input) => {
			try {
				return await executeBrowserAbmlRead(server, input, options);
			} catch (error) {
				return failure("read", error);
			}
		},
		click: async (input) => {
			try {
				return await executeBrowserAbmlClick(server, input, options);
			} catch (error) {
				return failure("click", error);
			}
		},
		type: async (input) => {
			try {
				return await executeBrowserAbmlType(server, input, options);
			} catch (error) {
				return failure("type", error);
			}
		},
		scroll: async (input) => {
			try {
				return await executeBrowserAbmlScroll(server, input, options);
			} catch (error) {
				return failure("scroll", error);
			}
		},
		pierce: async (input) => {
			try {
				return await executeBrowserAbmlPierce(server, input, options);
			} catch (error) {
				return failure("pierce", error);
			}
		},
		frame: async (input) => {
			try {
				return await executeBrowserAbmlFrame(server, input, options);
			} catch (error) {
				return failure("frame", error);
			}
		},
	};
}

export {
	executeBrowserAbmlRead,
	executeBrowserAbmlClick,
	executeBrowserAbmlType,
	executeBrowserAbmlScroll,
	executeBrowserAbmlPierce,
	executeBrowserAbmlFrame,
	inspectVisionRegion,
};
