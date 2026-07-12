import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";
import type { Entity, ScanEntityContext } from "../../kernels/abml/entity.js";
import { summarizeEntityDiff, type EntityDiff } from "../../kernels/abml/diff.js";
import { addEntityRelations, buildRelationGraph, buildRelationSummary } from "../../kernels/abml/relations.js";
import { buildInferenceSummary, entitiesForInferenceEvidence } from "../../kernels/abml/inference.js";
import { buildTriggeredRelations, eventTriggeredByEntity, resolveActionEntityRef, type CausalSummary } from "../../kernels/abml/causal.js";
import { buildTreeDiff, type TreeDiff } from "../../kernels/abml/treeDiff.js";
import { buildSnapshotProjection } from "../../kernels/abml/snapshotProjection.js";
import { buildCollectionModels } from "../../kernels/abml/collections.js";
import { buildIdentityGraph, identityGraphSummary } from "../../kernels/abml/identityGraph.js";
import { deriveSemanticRefAnchors } from "../../kernels/abml/semanticRefAnchor.js";
import { buildNativeTreeDiff } from "../../native/browserPilotNativeKernels.js";
import { buildScanEntities, scanEntitiesFromGroups, summarizeScanData, type ScanSummaryOptions } from "../../scan/summary.js";
import { registerScanEntityRefs } from "../../scan/entityRefs.js";
import { isRecord } from "../../utils/params.js";
import { buildEntityOutline, buildPageGist, sortEntitiesBySalience } from "./entityViews.js";
import { entityRefs, mergeEntitiesByRef, type BaselineResolution } from "./baseline.js";
import { buildObserveRelevance, type ObserveRelevance } from "./relevanceFusion.js";
import { legacyProjectionSummary, modeInferredSummary } from "./renderCache.js";
import { withObservationMeta, type ObserveMode, type ObserveToolParams } from "./common.js";
import type { executeScanCapture } from "./scanCapture.js";

type BuiltScanEntities = NonNullable<ScanSummaryOptions["scanEntities"]>;
type CaptureObservation = Awaited<ReturnType<typeof executeScanCapture>>["observation"];

function abmlAssemblyInputs(observation: CaptureObservation, ledgerFrame: CommandPerceptionLedgerFrame | undefined, baseline: BaselineResolution | undefined) {
	return {
		abmlEntities: observation.abmlRead?.ok === true ? (observation.abmlRead.entities ?? []) : null,
		abmlDiff: observation.abmlRead?.ok === true ? observation.abmlRead.diff : undefined,
		ledgerDeltaFields: ledgerFrame && baseline?.snapshotId ? { delta: "session", baselineSnapshotId: baseline.snapshotId } : {},
		runtimeRelationGraph: observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.relationGraph) ? observation.abmlRead.data.relationGraph : undefined,
	};
}

function attributedEntitiesForCausal(entities: Entity[] | null, causal: CausalSummary | undefined, actionRef: string | undefined, focusedRef: string | undefined): Entity[] | null {
	if (!entities || !causal || !("requests" in causal)) return entities;
	const actionEntityRef = causal.requests.length ? resolveActionEntityRef(actionRef, focusedRef, entities) : undefined;
	const requestTriggered = actionEntityRef ? buildTriggeredRelations(causal, { hasActionRef: !!actionRef }) : [];
	const eventTriggers = eventTriggeredByEntity("events" in causal && Array.isArray(causal.events) ? causal.events : [], entities);
	if (!actionEntityRef && eventTriggers.size === 0) return entities;
	return entities.map((entity) => {
		let next = entity;
		if (actionEntityRef && entity.ref === actionEntityRef) next = addEntityRelations(next, requestTriggered);
		const eventRelations = eventTriggers.get(entity.ref);
		return eventRelations ? addEntityRelations(next, eventRelations) : next;
	});
}

function registerIntentAnchors(server: BrowserCommandRuntimePort, entities: Entity[], pageUrl: string | undefined, seenAt: number) {
	const registry = typeof server.getIntentRefRegistry === "function" ? server.getIntentRefRegistry() : undefined;
	if (!registry || !pageUrl) return registry;
	let origin: string | undefined;
	try {
		origin = new URL(pageUrl).origin;
	} catch {
		return registry;
	}
	const entries = deriveSemanticRefAnchors(entities).anchors
		.filter((item) => item.anchor.confidence === "high" && item.anchor.mintingEligible)
		.map((item) => {
			const anchor = item.anchor;
			const anchorKey = [anchor.containerRole, anchor.containerName, anchor.normalizedName, anchor.role, anchor.kind].filter(Boolean).join("/");
			return { anchorKey, ref: item.ref, origin, seenAt };
		});
	if (entries.length) registry.register(entries);
	return registry;
}

type ScanAssemblyOptions = {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	mode: Extract<ObserveMode, "scan" | "text">;
	tabs: unknown[];
	maxChars: number;
	summaryData: unknown;
	scanEntityContext: ScanEntityContext;
	summaryScanEntities: BuiltScanEntities | undefined;
	browserSessionId: string | undefined;
	tabId: number | undefined;
	selectionVersion: number;
	pageUrl: string | undefined;
	abmlEntities: Entity[] | null;
	abmlDiff: EntityDiff | undefined;
	baseline: BaselineResolution | undefined;
	causal: CausalSummary | undefined;
	ledgerDeltaFields: Record<string, unknown>;
	runtimeRelationGraph: Record<string, unknown> | undefined;
	snapshotCapturedAt: number;
};

type EnvelopeDiff = EntityDiff & { summary?: ReturnType<typeof summarizeEntityDiff> };
type CausalBlock = { causal?: CausalSummary };

function buildBaseSummary(options: ScanAssemblyOptions, relevance: ObserveRelevance | undefined): Record<string, unknown> {
	const { params, mode, tabs, maxChars, summaryData, scanEntityContext, summaryScanEntities, browserSessionId, tabId, selectionVersion } = options;
	return {
		...withObservationMeta(summarizeScanData(summaryData, tabs, {
			detailLevel: params.detailLevel,
			maxChars,
			entityContext: scanEntityContext,
			scanEntities: summaryScanEntities,
			relevance: relevance?.result,
		}), mode, "scan"),
		...(mode === "scan" && !params.modeExplicit ? { model: "PageObservation", canonical: true } : legacyProjectionSummary(params, mode)),
		browserSessionId,
		tabId,
		selectionVersion,
		selectionVersionAtDispatch: selectionVersion,
		selectionVersionAtResolve: selectionVersion,
	};
}

function buildIntegratedSummary(options: ScanAssemblyOptions, entities: Entity[], envelopeDiff: EnvelopeDiff | undefined, treeDiff: TreeDiff | undefined, causalBlock: CausalBlock): { summary: Record<string, unknown>; artifactRelevance: Record<string, unknown> | undefined } {
	const { server, params, browserSessionId, pageUrl, abmlDiff, summaryData, causal, runtimeRelationGraph, snapshotCapturedAt, ledgerDeltaFields } = options;
	const relations = buildRelationSummary(entities);
	const inference = buildInferenceSummary(entities, relations, abmlDiff);
	const relevance = buildObserveRelevance(server, params, browserSessionId, pageUrl, entities, inference);
	const baseSummary = buildBaseSummary(options, relevance);
	const snapshotProjection = buildSnapshotProjection(entities, { treeDiff });
	const collections = buildCollectionModels({ entities, treeDiff, snapshotProjection, scanEvidence: scanCollectionEvidence(summaryData) });
	const intentRegistry = registerIntentAnchors(server, entities, pageUrl, snapshotCapturedAt);
	const identityGraph = buildIdentityGraph(entities, causal, intentRegistry);
	const relationGraph = runtimeRelationGraph || buildRelationGraph(entities);
	const baseFocus = isRecord(baseSummary.focus) ? baseSummary.focus : {};
	const referencedEntities = mergeEntitiesByRef(entitiesForInferenceEvidence(entities, inference)).slice(0, 12);
	const primaryEntities = sortEntitiesBySalience(entities.filter((entity) => entity.kind !== "region"), relevance?.result).slice(0, 10);
	const listEntities = entities.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).slice(0, 5);
	const visualRegions = entities.filter((entity) => entity.kind === "region" && entity.source === "vision").slice(0, 4);
	const identity = identityGraphSummary(identityGraph);
	return {
		artifactRelevance: relevance?.artifact,
		summary: {
			...baseSummary,
			...ledgerDeltaFields,
			abmlIntegrated: true,
			...(envelopeDiff ? { diff: envelopeDiff } : {}),
			...(treeDiff ? { treeDiff } : {}),
			snapshotProjection,
			...(collections.length ? { collections } : {}),
			...causalBlock,
			...(identity.backendNodeIdCount || identity.anchorCount || identity.triggeredCount ? { identity } : {}),
			...(identityGraph.intentRefs?.length ? { intentRefs: identityGraph.intentRefs } : {}),
			_identityGraph: identityGraph,
			...(isRecord(relationGraph) && Number(relationGraph.edgeCount || 0) > 0 ? { _relationGraph: relationGraph } : {}),
			focus: {
				...baseFocus,
				entityShape: "refs-v1",
				gist: buildPageGist(entities),
				primary_entities: entityRefs(primaryEntities),
				outline: buildEntityOutline(entities),
				...(Object.keys(relations.summary).length || relations.highlights.length ? { relations } : {}),
				referenced_entities: entityRefs(referencedEntities, 12),
				list_entities: entityRefs(listEntities),
				visual_regions: entityRefs(visualRegions),
			},
		},
	};
}

function buildFallbackSummary(options: ScanAssemblyOptions, entities: Entity[], causalBlock: CausalBlock): { summary: Record<string, unknown>; artifactRelevance: Record<string, unknown> | undefined } {
	const { server, params, browserSessionId, pageUrl, ledgerDeltaFields } = options;
	const relevance = buildObserveRelevance(server, params, browserSessionId, pageUrl, entities);
	return { artifactRelevance: relevance?.artifact, summary: { ...buildBaseSummary(options, relevance), ...ledgerDeltaFields, abmlIntegrated: false, ...causalBlock } };
}

export function assembleScanSummary(options: ScanAssemblyOptions) {
	const { params, summaryScanEntities, abmlEntities, abmlDiff, baseline, causal } = options;
	const scanEnvelopeEntities = summaryScanEntities ? scanEntitiesFromGroups(summaryScanEntities) : [];
	const diffSummary = abmlDiff ? summarizeEntityDiff(abmlDiff, baseline?.entities, abmlEntities ?? []) : undefined;
	const envelopeDiff = abmlDiff ? { ...abmlDiff, ...(diffSummary ? { summary: diffSummary } : {}) } : undefined;
	const treeDiff = abmlEntities && baseline
		? buildNativeTreeDiff(baseline.entities, abmlEntities, { partialBaseline: baseline.partialBaseline })
			?? buildTreeDiff(baseline.entities, abmlEntities, { partialBaseline: baseline.partialBaseline })
		: undefined;
	const attributedEntities = attributedEntitiesForCausal(abmlEntities, causal, params.actionRef, abmlDiff?.focusedRef);
	const causalBlock = causal ? { causal } : {};
	const projection = attributedEntities
		? buildIntegratedSummary(options, attributedEntities, envelopeDiff, treeDiff, causalBlock)
		: buildFallbackSummary(options, scanEnvelopeEntities, causalBlock);
	const { summary, artifactRelevance } = projection;
	Object.assign(summary, modeInferredSummary(params));
	return { summary, envelopeEntities: attributedEntities ?? scanEnvelopeEntities, attributedEntities, envelopeDiff, treeDiff, artifactRelevance, causalBlock };
}

export function prepareScanAssembly(options: {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	mode: Extract<ObserveMode, "scan" | "text">;
	tabs: unknown[];
	maxChars: number;
	tabId: number | undefined;
	data: Record<string, unknown> | undefined;
	bridge: ReturnType<BrowserCommandRuntimePort["snapshot"]>;
	snapshotMeta: ReturnType<typeof import("./common.js").currentObserveSnapshotMeta>;
	observation: CaptureObservation;
	baseline: BaselineResolution | undefined;
	causal: CausalSummary | undefined;
	ledgerFrame: CommandPerceptionLedgerFrame | undefined;
}) {
	const { server, params, mode, tabs, maxChars, tabId, data, bridge, snapshotMeta, observation, baseline, causal, ledgerFrame } = options;
	const pageUrl = typeof data?.url === "string" ? data.url : undefined;
	const scanEntityContext = {
		browserSessionId: bridge.browserSessionId,
		tabId,
		url: pageUrl,
		observationId: snapshotMeta.snapshotId,
		capturedAt: snapshotMeta.capturedAt,
	};
	const summaryData = data ? registerScanEntityRefs(data, scanEntityContext) : data;
	const summaryScanEntities = summaryData && isRecord(summaryData) ? buildScanEntities(summaryData, { entityContext: scanEntityContext }) : undefined;
	const { abmlEntities, abmlDiff, ledgerDeltaFields, runtimeRelationGraph } = abmlAssemblyInputs(observation, ledgerFrame, baseline);
	return {
		assembly: assembleScanSummary({
			server,
			params,
			mode,
			tabs,
			maxChars,
			summaryData,
			scanEntityContext,
			summaryScanEntities,
			browserSessionId: bridge.browserSessionId,
			tabId,
			selectionVersion: bridge.selectionVersion,
			pageUrl,
			abmlEntities,
			abmlDiff,
			baseline,
			causal,
			ledgerDeltaFields,
			runtimeRelationGraph,
			snapshotCapturedAt: snapshotMeta.capturedAt,
		}),
	};
}

function recordArray(value: unknown): Array<Record<string, unknown>> | undefined {
	if (!Array.isArray(value)) return undefined;
	const records = value.filter(isRecord) as Array<Record<string, unknown>>;
	return records.length ? records : undefined;
}

function scanCollectionEvidence(data: unknown) {
	const record = isRecord(data) ? data : {};
	return {
		listHints: recordArray(record.list_hints),
		rows: recordArray(record.rows),
		actionables: recordArray(record.actionables),
		...(isRecord(record.growthProbe) ? { growthProbe: record.growthProbe } : {}),
	};
}
