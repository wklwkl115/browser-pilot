import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { BrowserBridgeError, normalizeError, type NormalizedError } from "../../utils/errors.js";
import { finiteNumber as numberValue } from "../../utils/records.js";
import { urlOrigin } from "../../utils/url.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { evaluatePageScriptDirect } from "../../browser-page-runtime/pageScriptEvaluation.js";
import { registerScanEntityRefs } from "../../scan/entityRefs.js";
import { scanEntitiesForEnvelope } from "../../scan/summary.js";
import { normalizeTabId } from "../../utils/params.js";
import { registerRefDescriptor } from "../../resources/resourceRefs.js";
import type { Entity } from "../../kernels/abml/entity.js";
import { diffEntities, type EntityDiff, type EntityDiffOptions } from "../../kernels/abml/diff.js";
import { mergeAxIntoDomEntities, readAxEntities, type AxReadResult } from "./axRuntime.js";
import { bootstrapScanBackendNodeIds } from "../../kernels/abml/identityBootstrap.js";
import { materializeRelationGraph, derivePaintOrderRelationAnchors, deriveStateRelationAnchors } from "../../kernels/abml/relations.js";
import type { AxFusionDiagnostics } from "../../kernels/abml/ax.js";
import { defaultRefPolicyForKind } from "../../kernels/refs/refPolicy.js";
import { deriveSemanticRefAnchors } from "../../kernels/abml/semanticRefAnchor.js";
import type { PageWorldScanBundleV1, ScanPageFingerprint } from "../../kernels/abml/pageWorldScan.js";
import { validatePageWorldScanBundle } from "../../validation/pageContracts.js";

export type AbmlBrowserRuntimeServer = Pick<BrowserCommandRuntimePort, "sendCommand" | "snapshot" | "createObservationSnapshot">;

export type BrowserAbmlRuntimeOptions = {
	browserSessionId?: string;
	tabId?: number | string;
	timeoutMs?: number;
	maxChars?: number;
	signal?: AbortSignal;
};

export type BrowserAbmlStructureInput = {
	baseline?: Entity[];
	diffOptions?: EntityDiffOptions;
	prefetchedScan?: PageWorldScanBundleV1;
	axCacheKey?: string;
	pageFingerprint?: ScanPageFingerprint;
};

export type BrowserAbmlStructureResult =
	| { ok: true; entities: Entity[]; diff?: EntityDiff; data: Record<string, unknown> }
	| { ok: false; error: NormalizedError };

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_SCAN_CAPTURE_MAX_CHARS = 100_000;

function tabPageIdentity(tabs: Array<Record<string, unknown>>, tabId: number): { targetGeneration?: number; pageEpoch?: string } {
	const tab = tabs.find((item) => normalizeTabId(item.tabId ?? item.id) === tabId);
	return {
		targetGeneration: numberValue(tab?.targetGeneration ?? tab?.generation),
		pageEpoch: typeof tab?.pageEpoch === "string" && tab.pageEpoch ? tab.pageEpoch : undefined,
	};
}

function remintSemanticTemplateRefs(entities: Entity[], context: { browserSessionId?: string; tabId?: number; targetGeneration?: number; pageEpoch?: string; documentId?: string; changeSeq?: number; url?: string; observationId: string; capturedAt: number }): Entity[] {
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
					...(urlOrigin(context.url) ? { topLevelOrigin: urlOrigin(context.url) } : {}),
				},
				policy: defaultRefPolicyForKind(entity.kind),
				semantic: { role: entity.role, ...(entity.name ? { name: entity.name } : {}), ...(entity.value ? { value: entity.value } : {}), anchor },
				...(entity.geometry ? { geometry: entity.geometry } : {}),
				observationId: context.observationId,
				documentEpoch: {
					...(context.targetGeneration !== undefined ? { targetGeneration: context.targetGeneration } : {}),
					...(context.pageEpoch ? { pageEpoch: context.pageEpoch } : {}),
					...(context.documentId ? { documentId: context.documentId } : {}),
					...(context.changeSeq !== undefined ? { changeSeq: context.changeSeq, mutationEpoch: context.changeSeq } : {}),
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

function materializeStructureRelations(entities: Entity[], axRead: AxReadResult) {
	const paintOrderEntries = axRead.paintOrderEntries ?? [];
	const anchors = [...axRead.anchors, ...deriveStateRelationAnchors(entities), ...derivePaintOrderRelationAnchors(entities, paintOrderEntries)];
	const materialized = anchors.length ? materializeRelationGraph(entities, anchors) : undefined;
	const relatedEntities = materialized?.entities ?? entities;
	const relationCount = relatedEntities.reduce((sum, entity) => sum + (entity.relations?.length ?? 0), 0);
	const paintOrderEvidence = paintOrderEntries.length ? {
		entryCount: paintOrderEntries.length,
		ownerBackendNodeIdCount: new Set(paintOrderEntries.map((entry) => entry.backendNodeId)).size,
		entries: paintOrderEntries,
	} : undefined;
	return { entities: relatedEntities, relationCount, relationGraph: materialized?.graph, paintOrderEvidence };
}

function structureAxFusionDiagnostics(fusion: { diagnostics: AxFusionDiagnostics } | undefined, scanBacked: number, axEntityCount: number): AxFusionDiagnostics {
	return fusion?.diagnostics ?? {
		scanBacked,
		axEnriched: 0,
		axOnly: 0,
		matched: { backend: 0, geometry: 0, semantic: 0 },
		degraded: axEntityCount > 0,
		skipped: { ambiguousBackend: 0, ambiguousGeometry: 0, ambiguousSemantic: 0, targetScopeMismatch: 0, unsafeSemantic: 0 },
	};
}

async function structureAxRead(server: AbmlBrowserRuntimeServer, options: Parameters<typeof readAxEntities>[1]): Promise<AxReadResult> {
	return await readAxEntities(server, options).catch((): AxReadResult => {
		options.signal?.throwIfAborted();
		return { entities: [], anchors: [], diagnostics: { axMs: 0, cdpCalls: 0, geometryCdpCalls: 0, snapshotGeometryUnavailable: true, nodeCount: 0, interestingNodeCount: 0, cacheHit: false, bounded: { maxGeometryCdpCalls: 64, geometryFallbackTruncated: false } } };
	});
}

async function readStructure(server: AbmlBrowserRuntimeServer, input: BrowserAbmlStructureInput, options: BrowserAbmlRuntimeOptions) {
	options.signal?.throwIfAborted();
	const bridge = server.snapshot({ browserSessionId: options.browserSessionId });
	const browserSessionId = options.browserSessionId ?? bridge.browserSessionId;
	const tabId = normalizeTabId(options.tabId) ?? bridge.defaultTabId;
	if (!tabId) throw new BrowserBridgeError("NO_TAB", "No target browser tab is available for ABML read", { browserSessionId });
	const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
	const rawData = input.prefetchedScan ?? (await evaluatePageScriptDirect(server, buildScanScript({ maxChars: Math.max(options.maxChars ?? DEFAULT_SCAN_CAPTURE_MAX_CHARS, DEFAULT_SCAN_CAPTURE_MAX_CHARS) }), {
		browserSessionId,
		tabId,
		timeoutMs,
		name: "abml_read_scan",
		signal: options.signal,
	})).data;
	const bundle = validatePageWorldScanBundle(rawData);
	if (!bundle.ok) throw new BrowserBridgeError("SCAN_BUNDLE_INVALID", "ABML structure read received an invalid browser-page-scan/v1 bundle", { issues: bundle.issues.slice(0, 20) });
	const data = bundle.value;
	const pageFingerprint = input.pageFingerprint ?? data.signals.fingerprint;
	const { targetGeneration, pageEpoch } = tabPageIdentity(bridge.tabs, tabId);
	const scanCapturedAt = numberValue(data.signals.fingerprint.capturedAt) ?? Date.now();
	const snapshot = server.createObservationSnapshot({
		browserSessionId: bridge.browserSessionId,
		tabId,
		url: data.page.url,
		targetGeneration,
		pageEpoch,
		documentId: pageFingerprint.documentId,
		frameScope: "tab",
		selectionVersion: bridge.selectionVersion,
		sourceMode: "scan",
		capturedAt: scanCapturedAt,
	});
	const entityContext = { browserSessionId: bridge.browserSessionId, tabId, targetGeneration, pageEpoch, documentId: pageFingerprint.documentId, changeSeq: pageFingerprint.changeSeq, url: data.page.url, observationId: snapshot.snapshotId, capturedAt: snapshot.capturedAt };
	const axRead = await structureAxRead(server, {
		...entityContext,
		timeoutMs,
		cacheKey: input.axCacheKey,
		scrollX: data.signals.fingerprint.scrollX,
		scrollY: data.signals.fingerprint.scrollY,
		viewportWidth: data.signals.fingerprint.viewportWidth,
		viewportHeight: data.signals.fingerprint.viewportHeight,
		signal: options.signal,
	});
	const bootstrapped = bootstrapScanBackendNodeIds(data, axRead.snapshotGeometryEntries ?? [], {
		scanCapturedAt,
		scanCapturedAtIso: new Date(scanCapturedAt).toISOString(),
		snapshotStartedAt: axRead.diagnostics?.snapshotStartedAt,
		snapshotEndedAt: axRead.diagnostics?.snapshotEndedAt,
	});
	const summaryData = registerScanEntityRefs(bootstrapped.data, entityContext);
	const entities = scanEntitiesForEnvelope(summaryData, { entityContext });
	const fusion = axRead.entities.length ? mergeAxIntoDomEntities(entities, axRead.entities) : undefined;
	const mergedEntities = remintSemanticTemplateRefs(fusion?.entities ?? entities, entityContext);
	const relations = materializeStructureRelations(mergedEntities, axRead);
	return {
		entities: relations.entities,
		data: {
			snapshotId: snapshot.snapshotId,
			observationId: snapshot.snapshotId,
			tabId,
			url: data.page.url,
			axEntityCount: axRead.entities.length,
			mergedEntityCount: mergedEntities.length,
			relationCount: relations.relationCount,
			...(relations.relationGraph?.edgeCount ? { relationGraph: relations.relationGraph } : {}),
			backendNodeIdBootstrap: bootstrapped.stats,
			axDiagnostics: axRead.diagnostics,
			axFusion: structureAxFusionDiagnostics(fusion, entities.length, axRead.entities.length),
			...(relations.paintOrderEvidence ? { paintOrderEvidence: relations.paintOrderEvidence } : {}),
		},
	};
}

export async function readBrowserAbmlStructure(server: AbmlBrowserRuntimeServer, input: BrowserAbmlStructureInput, options: BrowserAbmlRuntimeOptions = {}): Promise<BrowserAbmlStructureResult> {
	try {
		const result = await readStructure(server, input, options);
		const diff = input.baseline ? diffEntities(input.baseline, result.entities, input.diffOptions) : undefined;
		return { ok: true, ...result, ...(diff ? { diff } : {}) };
	} catch (error) {
		options.signal?.throwIfAborted();
		return { ok: false, error: normalizeError(error) };
	}
}
