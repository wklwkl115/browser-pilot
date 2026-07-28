import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";
import type { Entity } from "../../kernels/abml/entity.js";
import { summarizeEntityDiff, type EntityDiff } from "../../kernels/abml/diff.js";
import { addEntityRelations, buildRelationSummary, type RelationSummary } from "../../kernels/abml/relations.js";
import { buildTriggeredRelations, eventTriggeredByEntity, resolveActionEntityRef, type CausalSummary } from "../../kernels/abml/causal.js";
import { buildTreeDiff, type TreeDiff } from "../../kernels/abml/treeDiff.js";
import { buildSnapshotProjection, type SnapshotProjection } from "../../kernels/abml/snapshotProjection.js";
import { buildCollectionModels, type CollectionModel } from "../../kernels/abml/collections.js";
import { buildScanEntities, scanEntitiesFromGroups } from "../../scan/summary.js";
import { registerScanEntityRefs } from "../../scan/entityRefs.js";
import { buildEntityOutline, buildPageGist, sortEntitiesBySalience } from "./entityViews.js";
import { entityRefs, type BaselineResolution } from "./baseline.js";
import type { executeScanCapture } from "./scanCapture.js";
import type { PageWorldScanBundleV1 } from "../../kernels/abml/pageWorldScan.js";
import type { PageReanchorReason } from "../../kernels/session/pageIdentity.js";

type BuiltScanEntities = ReturnType<typeof buildScanEntities>;
type CaptureObservation = Awaited<ReturnType<typeof executeScanCapture>>["observation"];

export type ScanSummary = {
	warnings?: string[];
	delta?: "session";
	baselineSnapshotId?: string;
	snapshotProjection?: SnapshotProjection;
	collections?: CollectionModel[];
	focus: {
		entityShape?: "refs-v1";
		gist: ReturnType<typeof buildPageGist>;
		primary_entities: string[];
		outline: ReturnType<typeof buildEntityOutline>;
		relations?: RelationSummary;
		list_entities?: string[];
		visual_regions?: string[];
	};
	reanchorReason?: PageReanchorReason;
	nextActions?: string[];
};

type LedgerDeltaFields = Pick<ScanSummary, "delta" | "baselineSnapshotId">;

function abmlAssemblyInputs(observation: CaptureObservation, ledgerFrame: CommandPerceptionLedgerFrame | undefined, baseline: BaselineResolution | undefined) {
	const ledgerDeltaFields: LedgerDeltaFields = ledgerFrame && baseline?.snapshotId ? { delta: "session", baselineSnapshotId: baseline.snapshotId } : {};
	return {
		abmlEntities: observation.abmlRead?.ok === true ? (observation.abmlRead.entities ?? []) : null,
		abmlDiff: observation.abmlRead?.ok === true && baseline ? observation.abmlRead.diff : undefined,
		ledgerDeltaFields,
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
	summaryData: PageWorldScanBundleV1;
	scanEntityGroups?: BuiltScanEntities;
	abmlEntities: Entity[] | null;
	abmlDiff: EntityDiff | undefined;
	baseline: BaselineResolution | undefined;
	causal: CausalSummary | undefined;
	action?: CommandPerceptionLedgerFrame["lastAction"];
	ledgerDeltaFields: LedgerDeltaFields;
};

function buildBaseSummary(summaryData: PageWorldScanBundleV1): Pick<ScanSummary, "warnings"> {
	return summaryData.stats.truncated ? { warnings: ["page capture reached the internal safety ceiling"] } : {};
}

function buildIntegratedSummary(options: ScanAssemblyOptions, entities: Entity[], treeDiff: TreeDiff | undefined): ScanSummary {
	const { summaryData, ledgerDeltaFields } = options;
	const relations = buildRelationSummary(entities);
	const snapshotProjection = buildSnapshotProjection(entities, { treeDiff });
	const collections = buildCollectionModels({ entities, snapshotProjection, scanEvidence: scanCollectionEvidence(summaryData) });
	const primaryEntities = sortEntitiesBySalience(entities.filter((entity) => entity.kind !== "region")).slice(0, 10);
	const listEntities = entities.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).slice(0, 5);
	const visualRegions = entities.filter((entity) => entity.kind === "region" && (entity.source === "vision" || entity.hints?.visualSurface === true)).slice(0, 4);
	return {
		...buildBaseSummary(summaryData),
		...ledgerDeltaFields,
		snapshotProjection,
		...(collections.length ? { collections } : {}),
		focus: {
			entityShape: "refs-v1",
			gist: buildPageGist(entities),
			primary_entities: entityRefs(primaryEntities),
			outline: buildEntityOutline(entities),
			...(Object.keys(relations.summary).length || relations.highlights.length ? { relations } : {}),
			list_entities: entityRefs(listEntities),
			visual_regions: entityRefs(visualRegions),
		},
	};
}

function buildFallbackSummary(options: ScanAssemblyOptions, entities: Entity[]): ScanSummary {
	const { summaryData, ledgerDeltaFields } = options;
	const primaryEntities = sortEntitiesBySalience(entities.filter((entity) => entity.kind !== "region")).slice(0, 10);
	return { ...buildBaseSummary(summaryData), ...ledgerDeltaFields, focus: { gist: buildPageGist(entities), outline: buildEntityOutline(entities), primary_entities: entityRefs(primaryEntities) } };
}

export function assembleScanSummary(options: ScanAssemblyOptions) {
	const { scanEntityGroups, abmlEntities, abmlDiff, baseline, causal, action } = options;
	const diffSummary = abmlDiff ? summarizeEntityDiff(abmlDiff, baseline?.entities, abmlEntities ?? []) : undefined;
	const envelopeDiff = abmlDiff ? { ...abmlDiff, ...(diffSummary ? { summary: diffSummary } : {}) } : undefined;
	const treeDiff = abmlEntities && baseline
		? buildTreeDiff(baseline.entities, abmlEntities, { partialBaseline: baseline.partialBaseline })
		: undefined;
	const attributedEntities = attributedEntitiesForCausal(abmlEntities, causal, abmlDiff?.focusedRef, action);
	if (attributedEntities) {
		const summary = buildIntegratedSummary(options, attributedEntities, treeDiff);
		return { summary, envelopeEntities: attributedEntities, attributedEntities, envelopeDiff, treeDiff };
	}
	if (!scanEntityGroups) throw new Error("scan fallback entities missing");
	const scanEnvelopeEntities = scanEntitiesFromGroups(scanEntityGroups);
	const summary = buildFallbackSummary(options, scanEnvelopeEntities);
	return { summary, envelopeEntities: scanEnvelopeEntities, attributedEntities, envelopeDiff, treeDiff };
}

export function prepareScanAssembly(options: {
	tabId: number | undefined;
	data: PageWorldScanBundleV1;
	bridge: ReturnType<BrowserCommandRuntimePort["snapshot"]>;
	snapshotMeta: ReturnType<typeof import("./common.js").currentObserveSnapshotMeta>;
	observation: CaptureObservation;
	baseline: BaselineResolution | undefined;
	causal: CausalSummary | undefined;
	ledgerFrame: CommandPerceptionLedgerFrame | undefined;
}) {
	const { tabId, data, bridge, snapshotMeta, observation, baseline, causal, ledgerFrame } = options;
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
			summaryData,
			scanEntityGroups,
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
