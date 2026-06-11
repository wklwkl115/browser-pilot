import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { BrowserBridgeError } from "../../driver/errors.js";
import { isRecord } from "../../utils/records.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { jsonForInlineScript, renderCaptureTemplate } from "../../capture/inject.js";
import { ACTIONABILITY_PROBE_TEMPLATE, FOCUS_AND_MAYBE_CLEAR_TEMPLATE, SCROLL_INTO_VIEW_TEMPLATE, SCROLL_PROBE_TEMPLATE, SCROLL_STEP_TEMPLATE, SYNTHETIC_CLICK_TEMPLATE, VERIFICATION_PROBE_TEMPLATE } from "../../capture/generated/probesBundle.js";
import { evaluatePageScriptDirect } from "../../tools/pageScriptEvaluation.js";
import { assertBridgeCommandSucceeded } from "../../tools/bridgeResultValidation.js";
import { scanEntitiesForEnvelope, summarizeScanData } from "../../tools/summaries/scan.js";
import { registerScanEntityRefs } from "../../tools/scanEntityRefs.js";
import { normalizeTabId } from "../../utils/params.js";
import { resolveRefUriDetailed, registerRefDescriptor } from "../../resources/resourceStore.js";
import { diffEntities } from "../diff.js";
import type { Entity } from "../entity.js";
import { createCaptureRef, buildNetworkEntryEntity, buildEventEntity, type CaptureRefContext } from "../stream.js";
import { buildCausalRequest, buildCausalEvent, buildCausalSummary, buildCausalEvents, latestSeq } from "../causal.js";
import { mergeAxIntoDomEntities, readAxEntities, type AxReadResult } from "./axRuntime.js";
import { materializeRelations, deriveStateRelationAnchors } from "../relations.js";
import { actionabilitySpecForVerb, type AbmlActionVerb } from "../actionabilityModel.js";
import { normalizeAbmlError } from "../errors.js";
import { decideRefAccess, defaultRefPolicyForKind } from "../refPolicy.js";
import { deriveSemanticRefAnchors } from "../semanticRefAnchor.js";
import type { ActionabilityBlockerCode, ActionabilityPredicate, ActionabilityReport, CaptureRef, RefDescriptor, VerificationResult } from "../types.js";
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

type ActionDeadline = {
	timeoutMs: number;
	startedAt: number;
	deadlineAt: number;
	elapsedMs: () => number;
	remainingMs: () => number;
	expired: () => boolean;
};

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_SCAN_CAPTURE_MAX_CHARS = 100_000;
const MIN_ACTION_SUBCALL_MS = 50;

function createActionDeadline(timeoutMs: number): ActionDeadline {
	const normalized = Math.max(1, Math.floor(timeoutMs));
	const startedAt = Date.now();
	const deadlineAt = startedAt + normalized;
	return {
		timeoutMs: normalized,
		startedAt,
		deadlineAt,
		elapsedMs: () => Math.max(0, Date.now() - startedAt),
		remainingMs: () => Math.max(0, deadlineAt - Date.now()),
		expired: () => Date.now() >= deadlineAt,
	};
}

function timeoutFor(deadline: ActionDeadline, label: string, minimumMs = MIN_ACTION_SUBCALL_MS): number {
	const remainingMs = Math.floor(deadline.remainingMs());
	if (remainingMs < minimumMs) {
		throw new BrowserBridgeError("TIMEOUT", `ABML action timeout exhausted before ${label}`, {
			label,
			timeoutMs: deadline.timeoutMs,
			elapsedMs: deadline.elapsedMs(),
			remainingMs,
		});
	}
	return remainingMs;
}

async function delayWithin(deadline: ActionDeadline, ms: number): Promise<void> {
	const waitMs = Math.min(Math.max(0, ms), Math.max(0, deadline.remainingMs()));
	if (waitMs > 0) await delay(waitMs);
}

function originOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try { return new URL(url).origin; } catch { return undefined; }
}

function remintSemanticTemplateRefs(entities: Entity[], context: { browserSessionId?: string; tabId?: number; url?: string; observationId: string; capturedAt: number }): Entity[] {
	const anchors = deriveSemanticRefAnchors(entities).anchors.filter((item) => item.anchor.mintingEligible && item.anchor.confidence === "high");
	if (!anchors.length) return entities;
	const anchorByRef = new Map(anchors.map((item) => [item.ref, item.anchor]));
	return entities.map((entity) => {
		const anchor = anchorByRef.get(entity.ref);
		if (!anchor) return entity;
		const refId = registerRefDescriptor({
			descriptor: {
				kind: entity.kind,
				locators: entity.locators || [],
				owner: {
					...(context.browserSessionId ? { browserSessionId: context.browserSessionId } : {}),
					...(typeof context.tabId === "number" ? { tabId: context.tabId } : {}),
					...(originOf(context.url) ? { topLevelOrigin: originOf(context.url) } : {}),
				},
				policy: defaultRefPolicyForKind(entity.kind),
				semantic: {
					role: entity.role,
					...(entity.name ? { name: entity.name } : {}),
					...(entity.value ? { value: entity.value } : {}),
					anchor,
				},
				...(entity.geometry ? { geometry: entity.geometry } : {}),
				observationId: context.observationId,
				documentEpoch: { url: context.url, capturedAt: context.capturedAt },
				createdAt: context.capturedAt,
				ttlMs: 5 * 60 * 1000,
				stabilityScore: 0.9,
			},
			resourceKind: "scan",
			name: entity.name || entity.role,
		});
		return { ...entity, ref: refId };
	});
}

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

async function sendInputPointer(server: AbmlBrowserRuntimeServer, options: { browserSessionId?: string; tabId?: number; timeoutMs: number; gesture: "press"; x: number; y: number; button?: string; count?: number }) {
	const result = await server.sendCommand({
		cmd: "input.pointer",
		tabId: options.tabId,
		gesture: options.gesture,
		x: options.x,
		y: options.y,
		button: options.button,
		count: options.count,
		timeoutMs: options.timeoutMs,
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	assertBridgeCommandSucceeded(result, "input.pointer");
	return result;
}

async function sendInputKeys(server: AbmlBrowserRuntimeServer, options: { browserSessionId?: string; tabId?: number; timeoutMs: number; text: string }) {
	const result = await server.sendCommand({
		cmd: "input.keys",
		tabId: options.tabId,
		text: options.text,
		timeoutMs: options.timeoutMs,
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	assertBridgeCommandSucceeded(result, "input.keys");
	return result;
}

function actionabilityProbeScript(selector: string): string {
	return renderCaptureTemplate(ACTIONABILITY_PROBE_TEMPLATE, { "JSON.stringify(selector)": jsonForInlineScript(selector) });
}

function scrollIntoViewScript(selector: string): string {
	return renderCaptureTemplate(SCROLL_INTO_VIEW_TEMPLATE, { "JSON.stringify(selector)": jsonForInlineScript(selector) });
}

function syntheticClickScript(selector: string): string {
	return renderCaptureTemplate(SYNTHETIC_CLICK_TEMPLATE, { "JSON.stringify(selector)": jsonForInlineScript(selector) });
}

function focusAndMaybeClearScript(selector: string, clear: boolean): string {
	return renderCaptureTemplate(FOCUS_AND_MAYBE_CLEAR_TEMPLATE, {
		"JSON.stringify(selector)": jsonForInlineScript(selector),
		'clear ? "true" : "false"': clear ? "true" : "false",
	});
}

function verificationProbeScript(selector: string): string {
	return renderCaptureTemplate(VERIFICATION_PROBE_TEMPLATE, { "JSON.stringify(selector)": jsonForInlineScript(selector) });
}

function scrollProbeScript(selector?: string): string {
	return renderCaptureTemplate(SCROLL_PROBE_TEMPLATE, { 'JSON.stringify(selector || "")': jsonForInlineScript(selector || "") });
}

function scrollStepScript(selector: string | undefined, to: AbmlScrollInput["to"], steps: number): string {
	return renderCaptureTemplate(SCROLL_STEP_TEMPLATE, {
		'JSON.stringify(selector || "")': jsonForInlineScript(selector || ""),
		'JSON.stringify(to || "next")': jsonForInlineScript(to || "next"),
		"Math.max(1, steps)": String(Math.max(1, steps)),
	});
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

async function ensureActionability(server: AbmlBrowserRuntimeServer, selector: string, verb: AbmlActionVerb, target: { browserSessionId?: string; tabId?: number }, deadline: ActionDeadline): Promise<{ ok: true; report: ActionabilityReport; probe: ActionabilityProbe } | { ok: false; report: ActionabilityReport }> {
	const spec = actionabilitySpecForVerb(verb);
	let attempts = 0;
	let lastProbe: ActionabilityProbe | undefined;
	let stableSince = 0;
	let lastStableKey = "";
	let scrolledIntoView = false;
	while (!deadline.expired()) {
		attempts += 1;
		const probe = await probeActionability(server, target, selector, timeoutFor(deadline, "actionability probe"));
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
			await evaluatePageObject(server, scrollIntoViewScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "actionability scrollIntoView"), name: "abml_scroll_into_view" });
			await delayWithin(deadline, spec.pollMs);
			continue;
		}
		const report = buildActionabilityReport(spec, deadline.elapsedMs(), attempts, checks, probe);
		if (report.ok) return { ok: true, report, probe };
		await delayWithin(deadline, spec.pollMs);
	}
	return { ok: false, report: buildActionabilityReport(spec, deadline.elapsedMs(), attempts, probeToActionability(lastProbe || { selector, count: 0, unique: false, attached: false, visible: false, disabled: false, editable: false, inViewport: false, receivesEvents: false, notOccluded: false, focused: false, scrollable: false }, false, spec.required), lastProbe) };
}

async function clickVerificationProbe(server: AbmlBrowserRuntimeServer, target: { browserSessionId?: string; tabId?: number }, selector: string, timeoutMs: number) {
	return await evaluatePageObject(server, verificationProbeScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, name: "abml_click_verify" });
}

function stateRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function formatChangeValue(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 80)}...` : value;
	return String(value);
}

function targetStateChanges(before: Record<string, unknown>, after: Record<string, unknown>): Array<{ field: string; before: unknown; after: unknown; summary: string }> {
	const fields: Array<{ field: string; before: unknown; after: unknown }> = [
		{ field: "url", before: before.url, after: after.url },
		{ field: "focus", before: before.activeElementMatches, after: after.activeElementMatches },
		{ field: "value", before: before.value, after: after.value },
		{ field: "text", before: before.text, after: after.text },
	];
	const beforeState = stateRecord(before.state);
	const afterState = stateRecord(after.state);
	for (const key of ["expanded", "checked", "selected", "pressed", "current"]) {
		fields.push({ field: key, before: beforeState[key], after: afterState[key] });
	}
	return fields
		.filter((item) => item.before !== item.after)
		.map((item) => ({ ...item, summary: `${item.field}:${formatChangeValue(item.before)}->${formatChangeValue(item.after)}` }));
}

function verifyClick(before: Record<string, unknown>, after: Record<string, unknown>): VerificationResult {
	const urlChanged = before.url !== after.url;
	const focusChanged = before.activeElementMatches !== after.activeElementMatches && after.activeElementMatches === true;
	const mutationChanged = Number(before.mutationTick || 0) !== Number(after.mutationTick || 0);
	const valueChanged = before.value !== after.value || before.text !== after.text;
	const changed = targetStateChanges(before, after);
	const verified = changed.length > 0 || mutationChanged || valueChanged || urlChanged || focusChanged;
	return {
		status: verified ? "verified" : "inconclusive",
		verb: "click",
		observed: { before, after, changed, urlChanged, focusChanged, mutationChanged, valueChanged },
		evidence: [
			{ kind: "probe", summary: `changed=${changed.map((item) => item.summary).join(",") || "none"} mutationChanged=${mutationChanged}` },
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
	const changed = targetStateChanges(before, after);
	return {
		status: verified ? "verified" : after.activeElementMatches === true ? "inconclusive" : "failed",
		verb: "type",
		expected: { clear, text },
		observed: { beforeValue, afterValue, focused: after.activeElementMatches === true, changed },
		evidence: [{ kind: "probe", summary: `before=${beforeValue.length} after=${afterValue.length} focused=${after.activeElementMatches === true} changed=${changed.map((item) => item.summary).join(",") || "none"}` }],
		elapsedMs: 0,
	};
}

// ── R3.x P2-C — causal stream plane (cursor-based drain channel) ──────────────────────────────────
// Activates the previously-stubbed read(plane:"network"|"event") + the stream.ts capture-ref scaffold.
// A long-lived "signal" capture-ref carries the drain cursor (streamState.lastSeq): the model arms once
// (no ref → cursor pinned at the recorder's current high-water, no history replay), then re-reads with the
// returned ref to drain only what fired since its cursor — without a full DOM scan. No new public tool, no
// protocol change: pure internal substrate reached via Pi-native / the ABML runtime. URLs/payloads are
// redacted by reusing the P0/P2-A buildCausal* selectors (a raw stream-entity url never leaves redaction).

type StreamPlane = "network" | "event";
const STREAM_CAPTURE_TTL_MS = 60 * 60 * 1000;
const STREAM_NETWORK_LIMIT = 500;
const STREAM_EVENT_LIMIT = 200;

// Read the drain cursor (+ channel age) carried by an incoming signal capture-ref. A non-signal ref (or
// none) yields an empty cursor → the caller arms a fresh channel.
function captureCursor(descriptor: RefDescriptor | undefined): { lastSeq?: number; startedAt?: number } {
	if (!descriptor || descriptor.kind !== "signal") return {};
	const stream = (descriptor as CaptureRef).streamState;
	return {
		lastSeq: typeof stream?.lastSeq === "number" ? stream.lastSeq : undefined,
		startedAt: typeof stream?.startedAt === "number" ? stream.startedAt : undefined,
	};
}

// Mint a refreshed signal capture-ref at the given cursor. registerRefDescriptor mints the pi-ref://signal/<id>
// URI (locators are empty → no stable-hash reuse); the cursor round-trips in streamState.lastSeq.
function mintStreamCapture(lastSeq: number, startedAt: number, context: CaptureRefContext): string {
	const now = context.capturedAt ?? startedAt;
	const captureRef = createCaptureRef({ refId: "pi-ref://signal/pending", state: "active", startedAt, expiresAt: now + STREAM_CAPTURE_TTL_MS, lastSeq, context });
	const { refId: _drop, ...descriptor } = captureRef;
	return registerRefDescriptor({ descriptor, browserSessionId: context.browserSessionId });
}

// One network record → a redacted network-entry entity. buildNetworkEntryEntity is a RAW builder (raw url in
// stream.url/name/semantic/epoch); we replace every url-bearing field with buildCausalRequest's redacted +
// truncated url and pin the ref to the causal scheme (pi-ref://network/<requestId>) so the entity ref matches
// data.causal.requests[].ref — no separate lookup, and no raw url ever escapes.
function shapeNetworkStreamEntity(record: Record<string, unknown>, context: CaptureRefContext): Entity {
	const causalReq = buildCausalRequest(record);
	const built = buildNetworkEntryEntity(record, context);
	const label = `${causalReq.method || built.entity.stream?.method || "GET"} ${causalReq.url || causalReq.ref}`;
	const stream = causalReq.url && built.entity.stream ? { ...built.entity.stream, url: causalReq.url } : built.entity.stream;
	const descriptor = {
		...built.descriptor,
		refId: causalReq.ref,
		semantic: { ...(built.descriptor.semantic || {}), name: label },
		documentEpoch: { ...built.descriptor.documentEpoch, url: causalReq.url ?? context.url, capturedAt: built.descriptor.documentEpoch?.capturedAt ?? context.capturedAt ?? 0 },
	};
	const refId = registerRefDescriptor({ descriptor, browserSessionId: context.browserSessionId });
	return { ...built.entity, ref: refId, name: label, ...(stream ? { stream } : {}) };
}

// One hook event → a redacted event entity. buildCausalEvent's redacted summary replaces the raw message/value;
// the ref is pinned to pi-ref://event/<seq|id> so it matches data.causal.events[].ref.
function shapeEventStreamEntity(record: Record<string, unknown>, context: CaptureRefContext): Entity {
	const causalEv = buildCausalEvent(record);
	const built = buildEventEntity(record, context);
	const descriptor = {
		...built.descriptor,
		refId: causalEv.ref,
		semantic: { ...(built.descriptor.semantic || {}), value: causalEv.summary },
	};
	const refId = registerRefDescriptor({ descriptor, browserSessionId: context.browserSessionId });
	const { value: _rawValue, ...entityNoValue } = built.entity;
	return { ...entityNoValue, ref: refId, ...(causalEv.summary ? { value: causalEv.summary } : {}) };
}

async function readStreamPlane(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions, plane: StreamPlane): Promise<{ entities?: Entity[]; data?: Record<string, unknown> }> {
	const resolved = input.ref ? resolveRefDescriptor(input.ref) : undefined;
	if (resolved && !resolved.ok) throw resolved.error;
	const descriptor = resolved && resolved.ok ? resolved.descriptor : undefined;
	const target = currentTarget(server, options, descriptor);
	if (!target.tabId) throw new BrowserBridgeError("NO_TAB", `No target browser tab is available for ABML ${plane} stream read`, { browserSessionId: target.browserSessionId });
	const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
	const cursor = captureCursor(descriptor);
	const explicitSince = isRecord(input.filter) && typeof input.filter.sinceSeq === "number" ? input.filter.sinceSeq : undefined;
	const sinceSeq = cursor.lastSeq ?? explicitSince;
	const arming = sinceSeq === undefined;
	const countKey = plane === "network" ? "requestCount" : "eventCount";

	// Recorder/hook liveness + current high-water. Best-effort: any failure degrades to "inactive".
	let active: boolean;
	let highWater: number | undefined;
	try {
		const statusRes = await server.sendCommand({ cmd: plane === "network" ? "network.status" : "hook.status" }, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs });
		const statusData = isRecord(statusRes.data) ? statusRes.data : {};
		if (plane === "network") {
			active = statusData.active !== false;
			highWater = typeof statusData.lastSeq === "number" ? statusData.lastSeq : undefined;
		} else {
			highWater = typeof statusData.last_seq === "number" ? statusData.last_seq : undefined;
			active = highWater !== undefined;
		}
	} catch {
		active = false;
	}
	if (!active) {
		const reason = plane === "network"
			? "network recorder not active — start via browser_network start"
			: "hook session not armed — install via browser_hook installTargets";
		return { entities: [], data: { plane, mode: "stream", unavailable: reason, recorderActive: false } };
	}

	const capturedAt = Date.now();
	const context: CaptureRefContext = {
		browserSessionId: target.browserSessionId,
		tabId: target.tabId,
		observationId: `stream:${plane}:${target.tabId}`,
		capturedAt,
		url: descriptor?.documentEpoch?.url,
	};

	// ARM: pin the cursor at the current high-water (no history replay) and hand back the channel ref.
	if (arming) {
		const startSeq = highWater ?? 0;
		const captureRef = mintStreamCapture(startSeq, capturedAt, context);
		return { entities: [], data: { plane, mode: "stream", armed: true, recorderActive: true, sinceSeq: startSeq, cursor: startSeq, captureRef, [countKey]: 0 } };
	}

	// DRAIN: pull the delta since the cursor, build redacted stream entities, advance the cursor.
	const since = sinceSeq as number;
	let records: Array<Record<string, unknown>>;
	try {
		const listRes = await server.sendCommand(
			plane === "network" ? { cmd: "network.list", sinceSeq: since, limit: STREAM_NETWORK_LIMIT } : { cmd: "hook.collect", since_seq: since, limit: STREAM_EVENT_LIMIT },
			{ browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs },
		);
		const listData = isRecord(listRes.data) ? listRes.data : {};
		const arr = plane === "network" ? listData.items : listData.events;
		records = Array.isArray(arr) ? arr.filter(isRecord) : [];
	} catch {
		records = [];
	}
	const delta = records.filter((record) => { const seq = Number(record.seq); return !Number.isFinite(seq) || seq > since; });
	const newCursor = latestSeq(delta) ?? since;
	const startedAt = cursor.startedAt ?? capturedAt;
	const entities: Entity[] = delta.map((record) => plane === "network" ? shapeNetworkStreamEntity(record, context) : shapeEventStreamEntity(record, context));
	const causal = plane === "network" ? buildCausalSummary(delta, since) : { sinceSeq: since, ...buildCausalEvents(delta, since) };
	const captureRef = mintStreamCapture(newCursor, startedAt, context);
	return {
		entities,
		data: { plane, mode: "stream", armed: false, recorderActive: true, sinceSeq: since, cursor: newCursor, captureRef, [countKey]: entities.length, causal },
	};
}

async function executeBrowserAbmlRead(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions = {}): Promise<AbmlVerbResult> {
	return await runAbmlRead(input, async () => {
		if (input.plane === "network" || input.plane === "event") return await readStreamPlane(server, input, options, input.plane);
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
		const data = input.prefetchedScan ?? (await evaluatePageScriptDirect(server as BrowserBridgeServer, buildScanScript({ textOnly: false, maxChars: Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_SCAN_CAPTURE_MAX_CHARS), includeIframes: true }), {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
			name: "abml_read_scan",
		})).data as Record<string, unknown>;
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
		const entityContext = {
			browserSessionId: bridge.browserSessionId,
			tabId: target.tabId,
			url: typeof data?.url === "string" ? data.url : descriptor?.documentEpoch?.url,
			observationId: snapshot.snapshotId,
			capturedAt: snapshot.capturedAt,
		};
		const axReadPromise = readAxEntities(server, {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			observationId: snapshot.snapshotId,
			url: typeof data?.url === "string" ? data.url : descriptor?.documentEpoch?.url,
			capturedAt: snapshot.capturedAt,
			timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
			cacheKey: input.axCacheKey,
		}).catch((): AxReadResult => ({ entities: [], anchors: [] }));
		const summaryData = registerScanEntityRefs(data, entityContext);
		const summary = summarizeScanData(summaryData, bridge.tabs || [], {
			detailLevel: "summary",
			maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
			entityContext,
		});
		const entities = scanEntitiesForEnvelope(summaryData, { entityContext });
		const axRead = await axReadPromise;
		const mergedEntitiesRaw = axRead.entities.length ? mergeAxIntoDomEntities(entities, axRead.entities) : entities;
		const mergedEntities = remintSemanticTemplateRefs(mergedEntitiesRaw, {
			browserSessionId: bridge.browserSessionId,
			tabId: target.tabId,
			url: typeof data?.url === "string" ? data.url : descriptor?.documentEpoch?.url,
			observationId: snapshot.snapshotId,
			capturedAt: snapshot.capturedAt,
		});
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
		const deadline = createActionDeadline(timeoutMs);
		if (!selector) {
			const fallbackPoint = pointFromRef(descriptor);
			if (!fallbackPoint) return { verification: { status: "failed", verb: "click", observed: { reason: "missing point" }, evidence: [{ kind: "point", summary: "point-backed region ref is missing geometry" }], elapsedMs: 0 } };
			await sendInputPointer(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "visual click input.pointer"), gesture: "press", x: fallbackPoint.x, y: fallbackPoint.y, button: input.button || "left", count: input.count ?? 1 });
			return {
				data: { transport: "cdp", selector: undefined, point: fallbackPoint, visualFloor: true },
				actionability: {
					ok: true,
					spec: actionabilitySpecForVerb("click"),
					elapsedMs: deadline.elapsedMs(),
					attempts: 1,
					checks: { attached: true, visible: true, inViewport: true, receivesEvents: true, notOccluded: true },
					blockers: [],
					hitTest: { x: fallbackPoint.x, y: fallbackPoint.y, matchedTarget: true },
				},
				verification: { status: "verified", verb: "click", observed: { point: fallbackPoint, visualFloor: true }, evidence: [{ kind: "point", summary: `clicked visual region at ${fallbackPoint.x},${fallbackPoint.y}` }], elapsedMs: deadline.elapsedMs() },
			};
		}
		const actionability = await ensureActionability(server, selector, "click", target, deadline);
		if (!actionability.ok) return { actionability: actionability.report };
		let beforeEntities: Entity[] | undefined;
		let diffUnavailable: string | undefined;
		if (input.diff === true) {
			if (deadline.remainingMs() >= MIN_ACTION_SUBCALL_MS) {
				const beforeRead = await executeBrowserAbmlRead(server, { plane: "structure" }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "click before diff read") });
				beforeEntities = beforeRead.ok ? beforeRead.entities : undefined;
			} else {
				diffUnavailable = "deadline_exhausted_before_diff";
			}
		}
		const before = await clickVerificationProbe(server, target, selector, timeoutFor(deadline, "click before verify probe"));
		let domResult: Record<string, unknown> | undefined;
		try {
			domResult = await evaluatePageObject(server, syntheticClickScript(selector), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "synthetic click"), name: "abml_click_dom" });
		} catch {
			domResult = undefined;
		}
		let after = await clickVerificationProbe(server, target, selector, timeoutFor(deadline, "click after verify probe"));
		let verification = verifyClick(before, after);
		let transport: "dom" | "cdp" = "dom";
		if (verification.status !== "verified") {
			const actionPoint = actionability.probe.point || pointFromRef(descriptor);
			if (!actionPoint) return { data: { transport, domResult }, actionability: actionability.report, verification };
			await sendInputPointer(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "trusted click input.pointer"), gesture: "press", x: actionPoint.x, y: actionPoint.y, button: input.button || "left", count: input.count ?? 1 });
			after = await clickVerificationProbe(server, target, selector, timeoutFor(deadline, "trusted click verify probe"));
			verification = verifyClick(before, after);
			transport = "cdp";
		}
		if (beforeEntities && deadline.remainingMs() < MIN_ACTION_SUBCALL_MS) diffUnavailable = "deadline_exhausted_after_action";
		const afterRead = beforeEntities && !diffUnavailable ? await executeBrowserAbmlRead(server, { plane: "structure" }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "click after diff read") }) : undefined;
		const diff = beforeEntities && afterRead?.ok && afterRead.entities ? diffEntities(beforeEntities, afterRead.entities) : undefined;
		return {
			data: { transport, domResult, selector, ...(diff ? { diff } : {}), ...(diffUnavailable ? { diffUnavailable } : {}) },
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
		const deadline = createActionDeadline(timeoutMs);
		const actionability = await ensureActionability(server, selector, "type", target, deadline);
		if (!actionability.ok) return { actionability: actionability.report };
		let beforeEntities: Entity[] | undefined;
		let diffUnavailable: string | undefined;
		if (input.diff === true) {
			if (deadline.remainingMs() >= MIN_ACTION_SUBCALL_MS) {
				const beforeRead = await executeBrowserAbmlRead(server, { plane: "structure" }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "type before diff read") });
				beforeEntities = beforeRead.ok ? beforeRead.entities : undefined;
			} else {
				diffUnavailable = "deadline_exhausted_before_diff";
			}
		}
		const before = await typeVerificationProbe(server, target, selector, timeoutFor(deadline, "type before verify probe"));
		const focusResult = await evaluatePageObject(server, focusAndMaybeClearScript(selector, input.clear === true), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "type focus"), name: "abml_type_focus" });
		if (focusResult.focused !== true) throw { code: "TARGET_NOT_EDITABLE", message: "ABML type could not focus the target", details: { selector } };
		await sendInputKeys(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "type input.keys"), text: input.text });
		const after = await typeVerificationProbe(server, target, selector, timeoutFor(deadline, "type after verify probe"));
		const verification = verifyType(before, after, input.text, input.clear === true);
		if (beforeEntities && deadline.remainingMs() < MIN_ACTION_SUBCALL_MS) diffUnavailable = "deadline_exhausted_after_action";
		const afterRead = beforeEntities && !diffUnavailable ? await executeBrowserAbmlRead(server, { plane: "structure" }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "type after diff read") }) : undefined;
		const diff = beforeEntities && afterRead?.ok && afterRead.entities ? diffEntities(beforeEntities, afterRead.entities) : undefined;
		return {
			data: { transport: "cdp", selector, focusResult, ...(diff ? { diff } : {}), ...(diffUnavailable ? { diffUnavailable } : {}) },
			...(diff ? { diff } : {}),
			actionability: actionability.report,
			verification,
		};
	});
}

function scrollAlreadyAtEdge(before: ScrollProbe, to: AbmlScrollInput["to"]): boolean {
	if (to === "top" || to === "previous") return before.atTop;
	if (to === "bottom" || to === "next" || to === undefined) return before.atBottom;
	return false;
}

function verifyScroll(before: ScrollProbe, after: ScrollProbe, to: AbmlScrollInput["to"]): VerificationResult {
	const changed = before.scrollTop !== after.scrollTop || before.scrollLeft !== after.scrollLeft;
	const alreadyAtEdge = scrollAlreadyAtEdge(before, to);
	const atEdge = after.atTop || after.atBottom;
	return {
		status: changed || alreadyAtEdge || atEdge ? "verified" : "failed",
		verb: "scroll",
		observed: { before, after, changed, alreadyAtEdge, atEdge },
		evidence: [{ kind: "probe", summary: `before=${before.scrollTop} after=${after.scrollTop} changed=${changed} alreadyAtEdge=${alreadyAtEdge} atTop=${after.atTop} atBottom=${after.atBottom}` }],
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
		const deadline = createActionDeadline(timeoutMs);
		const collect = input.collect === true;
		const collected: Entity[] = [];
		const before = await scrollProbe(server, target, selector, timeoutFor(deadline, "scroll before probe"));
		const requestedSteps = Math.max(1, input.steps ?? 1);
		const maxIterations = collect ? Math.max(requestedSteps, requestedSteps + 6) : requestedSteps;
		let lastStep: Record<string, unknown> | undefined;
		let stablePasses = 0;
		let previousScrollHeight = before.scrollHeight;
		let previousEntityCount = 0;
		let iterations = 0;
		let current = before;
		let partialReason: string | undefined;
		for (let attempt = 0; attempt < maxIterations; attempt += 1) {
			if (deadline.remainingMs() < MIN_ACTION_SUBCALL_MS) {
				partialReason = "deadline_exhausted_before_step";
				break;
			}
			lastStep = await evaluatePageObject(server, scrollStepScript(selector, input.to, 1), { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "scroll step"), name: "abml_scroll_step" });
			const probe = await scrollProbe(server, target, selector, timeoutFor(deadline, "scroll step probe"));
			current = probe;
			iterations += 1;
			if (collect) {
				if (deadline.remainingMs() < MIN_ACTION_SUBCALL_MS) {
					partialReason = "deadline_exhausted_before_collect";
					break;
				}
				const readResult = await executeBrowserAbmlRead(server, { plane: "structure", ref: descriptor }, { ...options, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs: timeoutFor(deadline, "scroll collect read") });
				if (readResult.ok && Array.isArray(readResult.entities)) collected.push(...readResult.entities);
				const deduped = dedupeCollectedEntities(collected);
				const unchangedHeight = probe.scrollHeight === previousScrollHeight;
				const unchangedEntities = deduped.length === previousEntityCount;
				const unchangedPosition = probe.atBottom || probe.scrollTop === before.scrollTop || lastStep?.changed === false;
				if (unchangedHeight && unchangedEntities && unchangedPosition) stablePasses += 1;
				else stablePasses = 0;
				previousScrollHeight = probe.scrollHeight;
				previousEntityCount = deduped.length;
				if (iterations >= requestedSteps && stablePasses >= 2) break;
			}
		}
		const after = deadline.remainingMs() >= MIN_ACTION_SUBCALL_MS
			? await scrollProbe(server, target, selector, timeoutFor(deadline, "scroll after probe"))
			: current;
		const alreadyAtEdge = scrollAlreadyAtEdge(before, input.to);
		return {
			data: { selector, before, after, iterations, collect, alreadyAtEdge, ...(partialReason ? { partialReason } : {}), ...(collect ? { stepResult: lastStep, stablePasses, virtualCollectionStop: stablePasses >= 2 || after.atBottom === true } : {}) },
			verification: verifyScroll(before, after, input.to),
			entities: collect ? dedupeCollectedEntities(collected) : [],
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
