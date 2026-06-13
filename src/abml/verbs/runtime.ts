import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { BrowserBridgeError } from "../../driver/errors.js";
import { isRecord } from "../../utils/records.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { evaluatePageScriptDirect } from "../../tools/pageScriptEvaluation.js";
import { scanEntitiesForEnvelope, summarizeScanData } from "../../tools/summaries/scan.js";
import { registerScanEntityRefs } from "../../tools/scanEntityRefs.js";
import { normalizeTabId } from "../../utils/params.js";
import { resolveRefUriDetailed, registerRefDescriptor } from "../../resources/resourceStore.js";
import type { Entity } from "../entity.js";
import { createCaptureRef, buildNetworkEntryEntity, buildEventEntity, type CaptureRefContext } from "../stream.js";
import { buildCausalRequest, buildCausalEvent, buildCausalSummary, buildCausalEvents, latestSeq } from "../causal.js";
import { mergeAxIntoDomEntities, readAxEntities, type AxReadResult } from "./axRuntime.js";
import { materializeRelations, deriveStateRelationAnchors } from "../relations.js";
import { normalizeAbmlError } from "../errors.js";
import { decideRefAccess, defaultRefPolicyForKind } from "../refPolicy.js";
import { deriveSemanticRefAnchors } from "../semanticRefAnchor.js";
import type { ActionabilityReport, CaptureRef, RefDescriptor, VerificationResult } from "../types.js";
import type { AbmlFrameInput, AbmlPierceInput, AbmlReadInput, AbmlRuntimeContext, AbmlVerbFailure, AbmlVerbResult } from "./router.js";
import { runAbmlRead } from "./read.js";
import { runAbmlPierce } from "./pierce.js";
import { runAbmlFrame } from "./frame.js";
import { inspectVisionRegion } from "./visionRuntime.js";
import { readFrameEntities, frameIdFromRef, probeFrameReachability } from "./frameRuntime.js";
import { pierceRefEntities } from "./pierceRuntime.js";

// Live ABML execution engine reached through integration.ts. Pure verb decisions stay in
// the pure kernel; browser I/O, refs, scans, and verification happen here.
export type AbmlBrowserRuntimeServer = Pick<BrowserBridgeServer, "sendCommand" | "snapshot" | "createObservationSnapshot">;

export type BrowserAbmlRuntimeOptions = {
	browserSessionId?: string;
	tabId?: number | string;
	timeoutMs?: number;
	maxChars?: number;
};

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_SCAN_CAPTURE_MAX_CHARS = 100_000;

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
	const now = context.capturedAt;
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
		documentEpoch: { ...built.descriptor.documentEpoch, url: causalReq.url ?? context.url, capturedAt: built.descriptor.documentEpoch?.capturedAt ?? context.capturedAt },
	};
	const refId = registerRefDescriptor({ descriptor, browserSessionId: context.browserSessionId });
	return { ...built.entity, ref: refId, name: label, ...(stream ? { stream } : {}) };
}

// One hook event → a redacted event entity. buildCausalEvent's redacted summary replaces the raw message/value;
// the ref is pinned to pi-ref://event/<seq|id> so it matches data.causal.events[].ref.
function shapeEventStreamEntity(record: Record<string, unknown>, context: CaptureRefContext, fallbackIndex?: number): Entity {
	const causalEv = buildCausalEvent(record, fallbackIndex);
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
	const entities: Entity[] = delta.map((record, index) => plane === "network" ? shapeNetworkStreamEntity(record, context) : shapeEventStreamEntity(record, context, index));
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
		}).catch((): AxReadResult => ({ entities: [], anchors: [], diagnostics: { axMs: 0, cdpCalls: 0, geometryCdpCalls: 0, nodeCount: 0, interestingNodeCount: 0, cacheHit: false } }));
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
			data: { summary, snapshotId: snapshot.snapshotId, observationId: snapshot.snapshotId, tabId: target.tabId, url: data?.url, axEntityCount: axRead.entities.length, mergedEntityCount: mergedEntities.length, relationCount, axDiagnostics: axRead.diagnostics },
		};
	});
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
