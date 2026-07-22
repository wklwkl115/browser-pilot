import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { BrowserBridgeError } from "../../utils/errors.js";
import { isRecord } from "../../utils/records.js";
import { assertBridgeCommandSucceeded } from "../../utils/bridgeResultValidation.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { evaluatePageScriptDirect } from "../../browser-page-runtime/pageScriptEvaluation.js";
import { registerScanEntityRefs } from "../../scan/entityRefs.js";
import { scanEntitiesForEnvelope, summarizeScanData } from "../../scan/summary.js";
import { normalizeTabId } from "../../utils/params.js";
import { resolveRefUriDetailed, registerRefDescriptor, type ResourceRefDescriptor as RefDescriptor } from "../../resources/resourceRefs.js";
import type { Entity } from "../../kernels/abml/entity.js";
import { createCaptureRef, buildNetworkEntryEntity, buildEventEntity, type CaptureRefContext } from "../../kernels/abml/stream.js";
import { buildCausalRequest, buildCausalEvent, buildCausalSummary, buildCausalEvents, latestSeq } from "../../kernels/abml/causal.js";
import { mergeAxIntoDomEntities, readAxEntities, readPartialAxTree, type AxReadResult, type PartialAxDiagnostics } from "./axRuntime.js";
import { bootstrapScanBackendNodeIds } from "../../kernels/abml/identityBootstrap.js";
import { materializeRelationGraph, derivePaintOrderRelationAnchors, deriveStateRelationAnchors } from "../../kernels/abml/relations.js";
import type { AxFusionDiagnostics } from "../../kernels/abml/ax.js";
import { normalizeAbmlError } from "../../kernels/abml/errors.js";
import { decideRefAccess, defaultRefPolicyForKind } from "../../kernels/refs/refPolicy.js";
import { deriveSemanticRefAnchors } from "../../kernels/abml/semanticRefAnchor.js";
import type { ActionabilityReport, VerificationResult } from "../../kernels/abml/types.js";
import type { AbmlFrameInput, AbmlPierceInput, AbmlReadInput, AbmlRuntimeContext, AbmlVerbFailure, AbmlVerbResult } from "../../kernels/abml/verbs/router.js";
import { runAbmlRead } from "../../kernels/abml/verbs/read.js";
import { runAbmlPierce } from "../../kernels/abml/verbs/pierce.js";
import { runAbmlFrame } from "../../kernels/abml/verbs/frame.js";
import { inspectVisionRegion } from "./visionRuntime.js";
import { readFrameEntities, frameIdFromRef, probeFrameReachability } from "./frameRuntime.js";
import { pierceRefEntities } from "./pierceRuntime.js";
import { validatePageWorldScanBundle } from "../../kernels/abml/pageWorldScan.js";

// Live ABML execution engine reached through integration.ts. Pure verb decisions stay in
// the pure kernel; browser I/O, refs, scans, and verification happen here.
export type AbmlBrowserRuntimeServer = Pick<BrowserCommandRuntimePort, "sendCommand" | "snapshot" | "createObservationSnapshot">;

export type BrowserAbmlRuntimeOptions = {
	browserSessionId?: string;
	tabId?: number | string;
	timeoutMs?: number;
	maxChars?: number;
	/** Internal low-latency profile used only for fenced post-action settlement. */
	captureProfile?: "canonical" | "settlement";
	signal?: AbortSignal;
};

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_SCAN_CAPTURE_MAX_CHARS = 100_000;
const LISTENER_PROBE_MAX_CANDIDATES = 8;
const LISTENER_PROBE_MAX_PER_NODE = 4;

type ListenerHint = {
	type?: string;
	useCapture?: boolean;
	passive?: boolean;
	once?: boolean;
	backendNodeId?: number;
	scriptId?: string;
	lineNumber?: number;
	columnNumber?: number;
};

type ListenerProbeStats = {
	candidateCount: number;
	probedCount: number;
	nodeWithListenersCount: number;
	listenerCount: number;
	truncated: boolean;
	failureCount: number;
	elapsedMs: number;
	maxCandidates: number;
	maxListenersPerNode: number;
};

function originOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try { return new URL(url).origin; } catch { return undefined; }
}

function numberValue(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function tabPageIdentity(tabs: Array<Record<string, unknown>>, tabId: number): { targetGeneration?: number; pageEpoch?: string } {
	const tab = tabs.find((item) => normalizeTabId(item.tabId ?? item.id) === tabId);
	return {
		targetGeneration: numberValue(tab?.targetGeneration ?? tab?.generation),
		pageEpoch: stringValue(tab?.pageEpoch),
	};
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function entityBackendNodeId(entity: Entity): number | undefined {
	const hinted = numberValue(entity.hints?.backendNodeId);
	if (hinted !== undefined && hinted > 0) return hinted;
	for (const locator of entity.locators || []) {
		if (locator.by !== "backendNodeId") continue;
		const value = numberValue(locator.value);
		if (value !== undefined && value > 0) return value;
	}
	return undefined;
}

function descriptorBackendNodeId(descriptor: RefDescriptor | undefined): number | undefined {
	for (const locator of descriptor?.locators || []) {
		if (locator.by !== "backendNodeId") continue;
		const value = numberValue(locator.value);
		if (value !== undefined && value > 0) return value;
	}
	return undefined;
}

async function readLocalPartialAxDiagnostics(server: AbmlBrowserRuntimeServer, descriptor: RefDescriptor | undefined, options: { browserSessionId?: string; tabId: number; timeoutMs: number }): Promise<PartialAxDiagnostics | undefined> {
	const backendNodeId = descriptorBackendNodeId(descriptor);
	if (backendNodeId === undefined) return undefined;
	return (await readPartialAxTree(server, { ...options, backendNodeId, timeoutMs: Math.min(options.timeoutMs, 1_500), maxNodes: 8, fetchRelatives: false })).diagnostics;
}

function listenerProbeCandidates(entities: Entity[]): Array<{ entity: Entity; backendNodeId: number }> {
	const out: Array<{ entity: Entity; backendNodeId: number }> = [];
	const seen = new Set<number>();
	for (const entity of entities) {
		const jsonPath = typeof entity.hints?.jsonPath === "string" ? entity.hints.jsonPath : "";
		if (!jsonPath.startsWith("data.actionables[")) continue;
		const backendNodeId = entityBackendNodeId(entity);
		if (backendNodeId === undefined || seen.has(backendNodeId)) continue;
		seen.add(backendNodeId);
		out.push({ entity, backendNodeId });
		if (out.length >= LISTENER_PROBE_MAX_CANDIDATES) break;
	}
	return out;
}

async function sendRuntimeCdp(server: AbmlBrowserRuntimeServer, options: { browserSessionId?: string; tabId: number; timeoutMs: number; cdpMethod: string; params?: Record<string, unknown> }): Promise<Record<string, unknown>> {
	const result = await server.sendCommand({
		cmd: "persistent_cdp",
		action: "send",
		tabId: options.tabId,
		cdpMethod: options.cdpMethod,
		params: options.params || {},
		persistent: true,
		timeoutMs: options.timeoutMs,
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	assertBridgeCommandSucceeded(result, `persistent_cdp:${options.cdpMethod}`);
	const data = isRecord(result.data) ? result.data : {};
	return isRecord(data.result) ? data.result : data;
}

function listenerHintsFromCdp(value: unknown): { listeners: ListenerHint[]; truncated: boolean } {
	const root = isRecord(value) ? value : {};
	const raw = Array.isArray(root.listeners) ? root.listeners : [];
	const listeners = raw.slice(0, LISTENER_PROBE_MAX_PER_NODE).filter(isRecord).map((listener): ListenerHint => ({
		...(stringValue(listener.type) ? { type: stringValue(listener.type) } : {}),
		...(booleanValue(listener.useCapture) !== undefined ? { useCapture: booleanValue(listener.useCapture) } : {}),
		...(booleanValue(listener.passive) !== undefined ? { passive: booleanValue(listener.passive) } : {}),
		...(booleanValue(listener.once) !== undefined ? { once: booleanValue(listener.once) } : {}),
		...(numberValue(listener.backendNodeId) ? { backendNodeId: numberValue(listener.backendNodeId) } : {}),
		...(stringValue(listener.scriptId) ? { scriptId: stringValue(listener.scriptId) } : {}),
		...(numberValue(listener.lineNumber) !== undefined ? { lineNumber: numberValue(listener.lineNumber) } : {}),
		...(numberValue(listener.columnNumber) !== undefined ? { columnNumber: numberValue(listener.columnNumber) } : {}),
	}));
	return { listeners, truncated: raw.length > listeners.length };
}

async function annotateListenerHints(server: AbmlBrowserRuntimeServer, entities: Entity[], options: { browserSessionId?: string; tabId: number; timeoutMs: number }): Promise<{ entities: Entity[]; stats: ListenerProbeStats }> {
	const startedAt = Date.now();
	const candidates = listenerProbeCandidates(entities);
	const byRef = new Map<string, ListenerHint[]>();
	let listenerCount = 0;
	let truncated = false;
	let failureCount = 0;
	let probedCount = 0;
	const timeoutMs = Math.max(500, Math.min(options.timeoutMs, 3_000));
	for (const candidate of candidates) {
		try {
			const resolved = await sendRuntimeCdp(server, { ...options, timeoutMs, cdpMethod: "DOM.resolveNode", params: { backendNodeId: candidate.backendNodeId } });
			const objectId = stringValue(isRecord(resolved.object) ? resolved.object.objectId : undefined);
			if (!objectId) {
				failureCount += 1;
				continue;
			}
			const listenerResult = await sendRuntimeCdp(server, { ...options, timeoutMs, cdpMethod: "DOMDebugger.getEventListeners", params: { objectId, depth: 1, pierce: true } });
			probedCount += 1;
			const hints = listenerHintsFromCdp(listenerResult);
			truncated = truncated || hints.truncated;
			if (hints.listeners.length) {
				byRef.set(candidate.entity.ref, hints.listeners);
				listenerCount += hints.listeners.length;
			}
		} catch {
			failureCount += 1;
		}
	}
	const next = byRef.size
		? entities.map((entity) => {
			const listeners = byRef.get(entity.ref);
			return listeners ? { ...entity, hints: { ...(entity.hints || {}), listeners } } : entity;
		})
		: entities;
	return {
		entities: next,
		stats: {
			candidateCount: candidates.length,
			probedCount,
			nodeWithListenersCount: byRef.size,
			listenerCount,
			truncated,
			failureCount,
			elapsedMs: Date.now() - startedAt,
			maxCandidates: LISTENER_PROBE_MAX_CANDIDATES,
			maxListenersPerNode: LISTENER_PROBE_MAX_PER_NODE,
		},
	};
}

function remintSemanticTemplateRefs(entities: Entity[], context: { browserSessionId?: string; tabId?: number; targetGeneration?: number; pageEpoch?: string; url?: string; observationId: string; capturedAt: number }): Entity[] {
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
					documentEpoch: {
						...(context.targetGeneration ? { targetGeneration: context.targetGeneration } : {}),
						...(context.pageEpoch ? { pageEpoch: context.pageEpoch } : {}),
						url: context.url,
						capturedAt: context.capturedAt,
					},
				createdAt: context.capturedAt,
				ttlMs: 5 * 60 * 1000,
				stabilityScore: 0.9,
				},
		});
		return { ...entity, ref: refId };
	});
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

function resolveOptionalRefDescriptor(ref: RefDescriptor | string | undefined): RefDescriptor | undefined {
	if (!ref) return undefined;
	const resolved = resolveRefDescriptor(ref);
	if (!resolved.ok) throw resolved.error;
	return resolved.descriptor;
}

function selectorFromRef(descriptor: RefDescriptor): string | undefined {
	for (const locator of descriptor.locators) if (locator.by === "css" && locator.value.trim()) return locator.value;
	return undefined;
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

// Causal stream plane (cursor-based drain channel).
// Implements read(plane:"network"|"event") with the stream.ts capture-ref scaffold.
// A long-lived "signal" capture-ref carries the drain cursor (streamState.lastSeq): the model arms once
// (no ref → cursor pinned at the recorder's current high-water, no history replay), then re-reads with the
// returned ref to drain only what fired since its cursor — without a full DOM scan. No new public tool, no
// protocol change: pure internal substrate reached via the ABML runtime. URLs/payloads are
// redacted by reusing the buildCausal* selectors (a raw stream-entity URL never leaves redaction).

type StreamPlane = "network" | "event";
const STREAM_CAPTURE_TTL_MS = 60 * 60 * 1000;
const STREAM_NETWORK_LIMIT = 500;
const STREAM_EVENT_LIMIT = 200;
type RuntimeCaptureRef = RefDescriptor & {
	streamState?: {
		startedAt?: number;
		lastSeq?: number;
	};
};

// Read the drain cursor (+ channel age) carried by an incoming signal capture-ref. A non-signal ref (or
// none) yields an empty cursor → the caller arms a fresh channel.
function captureCursor(descriptor: RefDescriptor | undefined): { lastSeq?: number; startedAt?: number } {
	if (!descriptor || descriptor.kind !== "signal") return {};
	const stream = (descriptor as RuntimeCaptureRef).streamState;
	return {
		lastSeq: typeof stream?.lastSeq === "number" ? stream.lastSeq : undefined,
		startedAt: typeof stream?.startedAt === "number" ? stream.startedAt : undefined,
	};
}

// Mint a refreshed signal capture-ref at the given cursor. registerRefDescriptor mints the bp-ref://signal/<id>
// URI (locators are empty → no stable-hash reuse); the cursor round-trips in streamState.lastSeq.
function mintStreamCapture(lastSeq: number, startedAt: number, context: CaptureRefContext): string {
	const now = context.capturedAt;
	const captureRef = createCaptureRef({ refId: "bp-ref://signal/pending", state: "active", startedAt, expiresAt: now + STREAM_CAPTURE_TTL_MS, lastSeq, context });
	const { refId: _drop, ...descriptor } = captureRef;
	return registerRefDescriptor({ descriptor });
}

// One network record → a redacted network-entry entity. buildNetworkEntryEntity is a RAW builder (raw url in
// stream.url/name/semantic/epoch); we replace every url-bearing field with buildCausalRequest's redacted +
// truncated url and pin the ref to the causal scheme (bp-ref://network/<requestId>) so the entity ref matches
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
		documentEpoch: { ...built.descriptor.documentEpoch, url: causalReq.url ?? context.url, capturedAt: built.descriptor.documentEpoch?.capturedAt ?? context.capturedAt },
	};
	const refId = registerRefDescriptor({ descriptor });
	return { ...built.entity, ref: refId, name: label, ...(stream ? { stream } : {}) };
}

// One hook event → a redacted event entity. buildCausalEvent's redacted summary replaces the raw message/value;
// the ref is pinned to bp-ref://event/<seq|id> so it matches data.causal.events[].ref.
function shapeEventStreamEntity(record: Record<string, unknown>, context: CaptureRefContext, fallbackIndex?: number): Entity {
	const causalEv = buildCausalEvent(record, fallbackIndex);
	const built = buildEventEntity(record, context);
	const descriptor = {
		...built.descriptor,
		refId: causalEv.ref,
		semantic: { ...(built.descriptor.semantic || {}), value: causalEv.summary },
	};
	const refId = registerRefDescriptor({ descriptor });
	const { value: _rawValue, ...entityNoValue } = built.entity;
	return { ...entityNoValue, ref: refId, ...(causalEv.summary ? { value: causalEv.summary } : {}) };
}

async function readStreamStatus(server: AbmlBrowserRuntimeServer, plane: StreamPlane, target: { browserSessionId?: string; tabId: number }, timeoutMs: number): Promise<{ active: boolean; highWater?: number }> {
	try {
		const command = plane === "network" ? "network.status" : "hook.status";
		const statusRes = await server.sendCommand({ cmd: command }, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs });
		const statusData = isRecord(statusRes.data) ? statusRes.data : {};
		if (plane === "network") return { active: statusData.active !== false, highWater: typeof statusData.lastSeq === "number" ? statusData.lastSeq : undefined };
		const highWater = typeof statusData.last_seq === "number" ? statusData.last_seq : undefined;
		return { active: highWater !== undefined, highWater };
	} catch {
		return { active: false };
	}
}

async function readStreamRecords(server: AbmlBrowserRuntimeServer, plane: StreamPlane, sinceSeq: number, target: { browserSessionId?: string; tabId: number }, timeoutMs: number): Promise<Array<Record<string, unknown>>> {
	try {
		const command = plane === "network" ? { cmd: "network.list", sinceSeq, limit: STREAM_NETWORK_LIMIT } : { cmd: "hook.collect", since_seq: sinceSeq, limit: STREAM_EVENT_LIMIT };
		const listRes = await server.sendCommand(command, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs });
		const listData = isRecord(listRes.data) ? listRes.data : {};
		const records = plane === "network" ? listData.items : listData.events;
		return Array.isArray(records) ? records.filter(isRecord) : [];
	} catch {
		return [];
	}
}

async function readStreamPlane(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions, plane: StreamPlane): Promise<{ entities?: Entity[]; data?: Record<string, unknown> }> {
	const descriptor = resolveOptionalRefDescriptor(input.ref);
	const target = currentTarget(server, options, descriptor);
	if (!target.tabId) throw new BrowserBridgeError("NO_TAB", `No target browser tab is available for ABML ${plane} stream read`, { browserSessionId: target.browserSessionId });
	const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
	const cursor = captureCursor(descriptor);
	const explicitSince = isRecord(input.filter) && typeof input.filter.sinceSeq === "number" ? input.filter.sinceSeq : undefined;
	const sinceSeq = cursor.lastSeq ?? explicitSince;
	const arming = sinceSeq === undefined;
	const countKey = plane === "network" ? "requestCount" : "eventCount";

	const status = await readStreamStatus(server, plane, { ...target, tabId: target.tabId }, timeoutMs);
	if (!status.active) {
		const reason = plane === "network"
			? "network recorder not active; use browser_command network.start"
			: "hook session not armed; use browser_command hook.installTargets";
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
		const startSeq = status.highWater ?? 0;
		const captureRef = mintStreamCapture(startSeq, capturedAt, context);
		return { entities: [], data: { plane, mode: "stream", armed: true, recorderActive: true, sinceSeq: startSeq, cursor: startSeq, captureRef, [countKey]: 0 } };
	}

	// DRAIN: pull the delta since the cursor, build redacted stream entities, advance the cursor.
	const since = sinceSeq as number;
	const records = await readStreamRecords(server, plane, since, { ...target, tabId: target.tabId }, timeoutMs);
	const delta = records.filter((record) => { const seq = Number(record.seq); return !Number.isFinite(seq) || seq > since; });
	const newCursor = latestSeq(delta) ?? since;
	const startedAt = cursor.startedAt ?? capturedAt;
	const entities: Entity[] = delta.map((record, index) => plane === "network" ? shapeNetworkStreamEntity(record, context) : shapeEventStreamEntity(record, context, index));
	const causal = plane === "network" ? buildCausalSummary(delta, since) : { sinceSeq: since, ...buildCausalEvents(delta, since) };
	const captureRef = mintStreamCapture(newCursor, startedAt, context);
	return {
		entities,
		data: { plane, mode: "stream", armed: false, recorderActive: true, sinceSeq: since, cursor: newCursor, captureRef, [countKey]: entities.length, causal },
	};
}

async function readSpecialStructureRef(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions, descriptor: RefDescriptor | undefined, target: { browserSessionId?: string; tabId: number }): Promise<{ entities?: Entity[]; data?: Record<string, unknown> } | undefined> {
	if (!descriptor) return undefined;
	const access = accessForLiveVerb(descriptor, target, true);
	if (!access.ok) throw access.error;
	if (descriptor.kind === "region" && isPointOnlyRegionRef(descriptor)) {
		const inspected = await inspectVisionRegion(server, descriptor, { ...target, timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS });
		if (!inspected.ok) throw inspected.error;
		return { entities: [inspected.entity], data: { ...inspected.data, source: "vision-floor", observationId: descriptor.observationId } };
	}
	if (descriptor.kind !== "frame") return undefined;
	const frameRead = await readFrameEntities(server, { ...target, observationId: descriptor.observationId, capturedAt: descriptor.createdAt, depth: input.depth });
	const frameId = frameLocatorFromRef(descriptor);
	const entities = frameId ? frameRead.entities.filter((entity) => entity.hints?.frameId === frameId || entity.value === frameId) : frameRead.entities;
	return { entities, data: { frameTree: frameRead.frameTree, frameCount: frameRead.frames.length, frameId, source: "frame.list", observationId: descriptor.observationId, tabId: target.tabId } };
}

function materializeStructureRelations(entities: Entity[], axRead: AxReadResult, descriptor: RefDescriptor | undefined) {
	const paintOrderEntries = axRead.paintOrderEntries ?? [];
	const anchors = [
		...axRead.anchors,
		...deriveStateRelationAnchors(entities),
		...derivePaintOrderRelationAnchors(entities, paintOrderEntries),
	];
	const materialized = anchors.length ? materializeRelationGraph(entities, anchors) : undefined;
	const relatedEntities = materialized?.entities ?? entities;
	const filteredEntities = descriptor ? filterEntitiesForRef(relatedEntities, descriptor) : relatedEntities;
	const relationCount = relatedEntities.reduce((sum, entity) => sum + (entity.relations?.length ?? 0), 0);
	const paintOrderEvidence = paintOrderEntries.length ? {
		entryCount: paintOrderEntries.length,
		ownerBackendNodeIdCount: new Set(paintOrderEntries.map((entry) => entry.backendNodeId)).size,
		entries: paintOrderEntries,
	} : undefined;
	return { entities: filteredEntities, relationCount, relationGraph: materialized?.graph, paintOrderEvidence };
}

function structureAxFusionDiagnostics(fusion: { diagnostics: AxFusionDiagnostics } | undefined, scanBacked: number, axEntityCount: number): AxFusionDiagnostics {
	if (fusion) return fusion.diagnostics;
	return {
		scanBacked,
		axEnriched: 0,
		axOnly: 0,
		degraded: axEntityCount > 0,
		skipped: { ambiguousBackend: 0, ambiguousGeometry: 0, ambiguousSemantic: 0, unsafeSemantic: 0 },
	};
}

async function settlementPartialAxDiagnostics(server: AbmlBrowserRuntimeServer, descriptor: RefDescriptor | undefined, options: { browserSessionId?: string; tabId: number; timeoutMs: number }, settlementCapture: boolean) {
	if (settlementCapture) return undefined;
	return await readLocalPartialAxDiagnostics(server, descriptor, options).catch(() => undefined);
}

async function settlementAxRead(server: AbmlBrowserRuntimeServer, options: Parameters<typeof readAxEntities>[1], settlementCapture: boolean): Promise<AxReadResult> {
	if (settlementCapture) return { entities: [], anchors: [] };
	return await readAxEntities(server, options).catch((): AxReadResult => ({ entities: [], anchors: [], diagnostics: { axMs: 0, cdpCalls: 0, geometryCdpCalls: 0, snapshotGeometryUnavailable: true, nodeCount: 0, interestingNodeCount: 0, cacheHit: false, bounded: { maxGeometryCdpCalls: 64, geometryFallbackTruncated: false } } }));
}

async function settlementListenerHints(server: AbmlBrowserRuntimeServer, entities: Entity[], options: { browserSessionId?: string; tabId: number; timeoutMs: number }, settlementCapture: boolean) {
	if (!settlementCapture) return await annotateListenerHints(server, entities, options);
	return {
		entities,
		stats: { candidateCount: 0, probedCount: 0, nodeWithListenersCount: 0, listenerCount: 0, truncated: false, failureCount: 0, elapsedMs: 0, maxCandidates: 0, maxListenersPerNode: 0 },
	};
}

async function resolveBrowserAbmlRead(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions) {
		if (input.plane === "network" || input.plane === "event") return await readStreamPlane(server, input, options, input.plane);
		if (input.plane && input.plane !== "structure") throw { code: "BACKEND_UNAVAILABLE", message: `ABML read plane is not implemented yet: ${input.plane}`, details: { plane: input.plane } };
		const descriptor = resolveOptionalRefDescriptor(input.ref);
		const target = currentTarget(server, options, descriptor);
		if (!target.tabId) throw new BrowserBridgeError("NO_TAB", "No target browser tab is available for ABML read", { browserSessionId: target.browserSessionId });
		const special = await readSpecialStructureRef(server, input, options, descriptor, { ...target, tabId: target.tabId });
		if (special) return special;
		return await readStandardStructurePlane(server, input, options, descriptor, { ...target, tabId: target.tabId });
	}

async function readStandardStructurePlane(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions, descriptor: RefDescriptor | undefined, target: { browserSessionId?: string; tabId: number }) {
		const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
		const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
		const settlementCapture = options.captureProfile === "settlement";
		const descriptorUrl = descriptor?.documentEpoch?.url;
		const rawData = input.prefetchedScan ?? (await evaluatePageScriptDirect(server, buildScanScript({ textOnly: false, maxChars: Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_SCAN_CAPTURE_MAX_CHARS), includeIframes: true }), {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			timeoutMs,
			name: "abml_read_scan",
			signal: options.signal,
		})).data;
		const bundle = validatePageWorldScanBundle(rawData);
		if (!bundle.ok) throw new BrowserBridgeError("SCAN_BUNDLE_INVALID", "ABML structure read received an invalid browser-page-scan/v1 bundle", { issues: bundle.issues.slice(0, 20) });
			const data = bundle.value;
			const url = data.page.url || descriptorUrl;
			const bridge = server.snapshot({ browserSessionId: target.browserSessionId });
			const { targetGeneration, pageEpoch } = tabPageIdentity(bridge.tabs, target.tabId);
			const snapshot = server.createObservationSnapshot({
				browserSessionId: bridge.browserSessionId,
				tabId: target.tabId,
				url,
				targetGeneration,
				pageEpoch,
			frameScope: "tab",
			selectionVersion: bridge.selectionVersion,
			sourceMode: "scan",
			capturedAt: Date.now(),
		});
			const entityContext = {
				browserSessionId: bridge.browserSessionId,
				tabId: target.tabId,
				targetGeneration,
				pageEpoch,
			url,
			observationId: snapshot.snapshotId,
			capturedAt: snapshot.capturedAt,
		};
		const partialAxDiagnostics = await settlementPartialAxDiagnostics(server, descriptor, {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			timeoutMs,
		}, settlementCapture);
			const axRead = await settlementAxRead(server, {
				browserSessionId: target.browserSessionId,
				tabId: target.tabId,
				targetGeneration,
				pageEpoch,
			observationId: snapshot.snapshotId,
			url,
			capturedAt: snapshot.capturedAt,
			timeoutMs,
			cacheKey: input.axCacheKey,
		}, settlementCapture);
		const bootstrapped = bootstrapScanBackendNodeIds(data, axRead.snapshotGeometryEntries ?? [], {
			scanCapturedAt: snapshot.capturedAt,
			scanCapturedAtIso: new Date(snapshot.capturedAt).toISOString(),
			snapshotStartedAt: axRead.diagnostics?.snapshotStartedAt,
			snapshotEndedAt: axRead.diagnostics?.snapshotEndedAt,
		});
		const summaryData = registerScanEntityRefs(bootstrapped.data, entityContext);
		const summary = summarizeScanData(summaryData, bridge.tabs ?? [], {
			detailLevel: "summary",
			maxChars,
			entityContext,
		});
		const entities = scanEntitiesForEnvelope(summaryData, { entityContext });
		const fusion = axRead.entities.length ? mergeAxIntoDomEntities(entities, axRead.entities) : undefined;
		const mergedEntitiesRaw = fusion ? fusion.entities : entities;
			const mergedEntities = remintSemanticTemplateRefs(mergedEntitiesRaw, {
				browserSessionId: bridge.browserSessionId,
				tabId: target.tabId,
				targetGeneration,
				pageEpoch,
			url,
			observationId: snapshot.snapshotId,
			capturedAt: snapshot.capturedAt,
		});
		const listenerProbe = await settlementListenerHints(server, mergedEntities, {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			timeoutMs,
		}, settlementCapture);
		const entitiesWithListenerHints = listenerProbe.entities;
		const relations = materializeStructureRelations(entitiesWithListenerHints, axRead, descriptor);
		return {
			entities: relations.entities,
			data: {
				summary,
				snapshotId: snapshot.snapshotId,
				observationId: snapshot.snapshotId,
				tabId: target.tabId,
				url: data.page.url,
				axEntityCount: axRead.entities.length,
				mergedEntityCount: mergedEntities.length,
				relationCount: relations.relationCount,
				...(relations.relationGraph?.edgeCount ? { relationGraph: relations.relationGraph } : {}),
				backendNodeIdBootstrap: bootstrapped.stats,
				listenerOracle: listenerProbe.stats,
				captureProfile: settlementCapture ? "settlement" : "canonical",
				axDiagnostics: axRead.diagnostics,
				...(partialAxDiagnostics ? { partialAx: partialAxDiagnostics } : {}),
				axFusion: structureAxFusionDiagnostics(fusion, entities.length, axRead.entities.length),
				...(relations.paintOrderEvidence ? { paintOrderEvidence: relations.paintOrderEvidence } : {}),
			},
		};
	}

async function executeBrowserAbmlRead(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions = {}): Promise<AbmlVerbResult> {
	return await runAbmlRead(input, async () => await resolveBrowserAbmlRead(server, input, options));
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
	executeBrowserAbmlPierce,
	executeBrowserAbmlFrame,
	inspectVisionRegion,
};
