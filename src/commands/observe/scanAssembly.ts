import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";
import type { Entity } from "../../kernels/abml/entity.js";
import { summarizeEntityDiff, type EntityDiff } from "../../kernels/abml/diff.js";
import { addEntityRelations, buildRelationSummary } from "../../kernels/abml/relations.js";
import { buildInferenceSummary, entitiesForInferenceEvidence } from "../../kernels/abml/inference.js";
import { buildTriggeredRelations, eventTriggeredByEntity, resolveActionEntityRef, type CausalSummary } from "../../kernels/abml/causal.js";
import { buildTreeDiff, type TreeDiff } from "../../kernels/abml/treeDiff.js";
import { buildSnapshotProjection } from "../../kernels/abml/snapshotProjection.js";
import { buildCollectionModels } from "../../kernels/abml/collections.js";
import { buildIdentityGraph, identityGraphSummary } from "../../kernels/abml/identityGraph.js";
import { buildScanEntities, scanEntitiesFromGroups } from "../../scan/summary.js";
import { registerScanEntityRefs } from "../../scan/entityRefs.js";
import { buildEntityOutline, buildPageGist, sortEntitiesBySalience } from "./entityViews.js";
import { entityRefs, mergeEntitiesByRef, type BaselineResolution } from "./baseline.js";
import { buildObserveRelevance } from "./relevanceFusion.js";
import type { ObserveToolParams } from "./common.js";
import type { executeScanCapture } from "./scanCapture.js";
import type { PageWorldScanBundleV1 } from "../../kernels/abml/pageWorldScan.js";

type BuiltScanEntities = ReturnType<typeof buildScanEntities>;
type CaptureObservation = Awaited<ReturnType<typeof executeScanCapture>>["observation"];

function abmlAssemblyInputs(observation: CaptureObservation, ledgerFrame: CommandPerceptionLedgerFrame | undefined, baseline: BaselineResolution | undefined) {
	return {
		abmlEntities: observation.abmlRead?.ok === true ? (observation.abmlRead.entities ?? []) : null,
		abmlDiff: observation.abmlRead?.ok === true && baseline ? observation.abmlRead.diff : undefined,
		ledgerDeltaFields: ledgerFrame && baseline?.snapshotId ? { delta: "session", baselineSnapshotId: baseline.snapshotId } : {},
		action: ledgerFrame?.lastAction,
	};
}

function attributedEntitiesForCausal(entities: Entity[] | null, causal: CausalSummary | undefined, focusedRef: string | undefined, action?: CommandPerceptionLedgerFrame["lastAction"]): Entity[] | null {
	if (!entities || !causal) return entities;
	const requests = "requests" in causal ? causal.requests : [];
	const actionEntityRef = requests.length
		? action ? resolveActionEntityRef(action.ref, undefined, entities) : resolveActionEntityRef(undefined, focusedRef, entities)
		: undefined;
	const requestTriggered = actionEntityRef ? buildTriggeredRelations(causal, { hasActionRef: action !== undefined, actionAt: action?.at }) : [];
	const eventTriggers = eventTriggeredByEntity("events" in causal && Array.isArray(causal.events) ? causal.events : [], entities);
	if (!actionEntityRef && eventTriggers.size === 0) return entities;
	return entities.map((entity) => {
		let next = entity;
		if (actionEntityRef && entity.ref === actionEntityRef) next = addEntityRelations(next, requestTriggered);
		const eventRelations = eventTriggers.get(entity.ref);
		return eventRelations ? addEntityRelations(next, eventRelations) : next;
	});
}

type ScanAssemblyOptions = {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	summaryData: PageWorldScanBundleV1;
	scanEntityGroups?: BuiltScanEntities;
	browserSessionId: string | undefined;
	abmlEntities: Entity[] | null;
	abmlDiff: EntityDiff | undefined;
	baseline: BaselineResolution | undefined;
	causal: CausalSummary | undefined;
	action?: CommandPerceptionLedgerFrame["lastAction"];
	ledgerDeltaFields: Record<string, unknown>;
};

type EnvelopeDiff = EntityDiff & { summary?: ReturnType<typeof summarizeEntityDiff> };
type CausalBlock = { causal?: CausalSummary };

function buildBaseSummary(summaryData: PageWorldScanBundleV1): Record<string, unknown> {
	return summaryData.stats.truncated ? { warnings: ["page capture reached the internal safety ceiling"] } : {};
}

function buildIntegratedSummary(options: ScanAssemblyOptions, entities: Entity[], envelopeDiff: EnvelopeDiff | undefined, treeDiff: TreeDiff | undefined, causalBlock: CausalBlock): { summary: Record<string, unknown> } {
	const { server, params, browserSessionId, abmlDiff, summaryData, ledgerDeltaFields } = options;
	const pageUrl = summaryData.page.url;
	const relations = buildRelationSummary(entities);
	const inference = buildInferenceSummary(entities, relations, abmlDiff);
	const relevance = buildObserveRelevance(server, params, browserSessionId, pageUrl, entities, inference);
	const snapshotProjection = buildSnapshotProjection(entities, { treeDiff });
	const collections = buildCollectionModels({ entities, snapshotProjection, scanEvidence: scanCollectionEvidence(summaryData) });
	const identityGraph = buildIdentityGraph(entities);
	const referencedEntities = mergeEntitiesByRef(entitiesForInferenceEvidence(entities, inference)).slice(0, 12);
	const primaryEntities = sortEntitiesBySalience(entities.filter((entity) => entity.kind !== "region"), relevance).slice(0, 10);
	const listEntities = entities.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).slice(0, 5);
	const visualRegions = entities.filter((entity) => entity.kind === "region" && (entity.source === "vision" || entity.hints?.visualSurface === true)).slice(0, 4);
	const identity = identityGraphSummary(identityGraph);
	return {
		summary: {
			...buildBaseSummary(summaryData),
			...ledgerDeltaFields,
			abmlIntegrated: true,
			...(envelopeDiff ? { diff: envelopeDiff } : {}),
			...(treeDiff ? { treeDiff } : {}),
			snapshotProjection,
			...(collections.length ? { collections } : {}),
			...causalBlock,
			...(identity.backendNodeIdCount || identity.anchorCount || identity.triggeredCount ? { identity } : {}),
			...(inference.intents.length ? { inference } : {}),
			focus: {
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

function buildFallbackSummary(options: ScanAssemblyOptions, entities: Entity[], causalBlock: CausalBlock): { summary: Record<string, unknown> } {
	const { server, params, browserSessionId, summaryData, ledgerDeltaFields } = options;
	const pageUrl = summaryData.page.url;
	const relevance = buildObserveRelevance(server, params, browserSessionId, pageUrl, entities);
	const primaryEntities = sortEntitiesBySalience(entities.filter((entity) => entity.kind !== "region"), relevance).slice(0, 10);
	return { summary: { ...buildBaseSummary(summaryData), ...ledgerDeltaFields, abmlIntegrated: false, ...causalBlock, focus: { gist: buildPageGist(entities), outline: buildEntityOutline(entities), primary_entities: entityRefs(primaryEntities) } } };
}

export function assembleScanSummary(options: ScanAssemblyOptions) {
	const { scanEntityGroups, abmlEntities, abmlDiff, baseline, causal, action } = options;
	const diffSummary = abmlDiff ? summarizeEntityDiff(abmlDiff, baseline?.entities, abmlEntities ?? []) : undefined;
	const envelopeDiff = abmlDiff ? { ...abmlDiff, ...(diffSummary ? { summary: diffSummary } : {}) } : undefined;
	const treeDiff = abmlEntities && baseline
		? buildTreeDiff(baseline.entities, abmlEntities, { partialBaseline: baseline.partialBaseline })
		: undefined;
	const attributedEntities = attributedEntitiesForCausal(abmlEntities, causal, abmlDiff?.focusedRef, action);
	const causalBlock = causal ? { causal } : {};
	if (attributedEntities) {
		const projection = buildIntegratedSummary(options, attributedEntities, envelopeDiff, treeDiff, causalBlock);
		return { summary: projection.summary, envelopeEntities: attributedEntities, attributedEntities, envelopeDiff, treeDiff };
	}
	if (!scanEntityGroups) throw new Error("scan fallback entities missing");
	const scanEnvelopeEntities = scanEntitiesFromGroups(scanEntityGroups);
	const projection = buildFallbackSummary(options, scanEnvelopeEntities, causalBlock);
	return { summary: projection.summary, envelopeEntities: scanEnvelopeEntities, attributedEntities, envelopeDiff, treeDiff };
}

export function prepareScanAssembly(options: {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	tabId: number | undefined;
	data: PageWorldScanBundleV1;
	bridge: ReturnType<BrowserCommandRuntimePort["snapshot"]>;
	snapshotMeta: ReturnType<typeof import("./common.js").currentObserveSnapshotMeta>;
	observation: CaptureObservation;
	baseline: BaselineResolution | undefined;
	causal: CausalSummary | undefined;
	ledgerFrame: CommandPerceptionLedgerFrame | undefined;
}) {
	const { server, params, tabId, data, bridge, snapshotMeta, observation, baseline, causal, ledgerFrame } = options;
	const pageUrl = data.page.url;
	const scanEntityContext = {
		browserSessionId: bridge.browserSessionId,
		tabId,
		targetGeneration: snapshotMeta.targetGeneration,
			pageEpoch: snapshotMeta.pageEpoch,
			documentId: snapshotMeta.documentId,
			changeSeq: data.signals.fingerprint.changeSeq,
		url: pageUrl,
		observationId: snapshotMeta.snapshotId,
		capturedAt: snapshotMeta.capturedAt,
	};
	const { abmlEntities, abmlDiff, ledgerDeltaFields, action } = abmlAssemblyInputs(observation, ledgerFrame, baseline);
	const summaryData = abmlEntities === null ? registerScanEntityRefs(data, scanEntityContext) : data;
	const scanEntityGroups = abmlEntities === null ? buildScanEntities(summaryData, { entityContext: scanEntityContext }) : undefined;
	return {
		assembly: assembleScanSummary({
			server,
			params,
			summaryData,
			scanEntityGroups,
			browserSessionId: bridge.browserSessionId,
			abmlEntities,
			abmlDiff,
			baseline,
			causal,
			action,
			ledgerDeltaFields,
		}),
	};
}

function scanCollectionEvidence(data: PageWorldScanBundleV1) {
	return {
		listHints: data.structure.listHints,
		actionables: data.structure.actionables,
	};
}
