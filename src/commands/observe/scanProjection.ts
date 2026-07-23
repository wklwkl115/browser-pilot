import type { Entity } from "../../kernels/abml/entity.js";
import type { EntityDiff } from "../../kernels/abml/diff.js";
import type { TreeDiff } from "../../kernels/abml/treeDiff.js";
import type { CausalSummary } from "../../kernels/abml/causal.js";
import { causalFiredHint } from "../../kernels/abml/causal.js";
import { isRecord } from "../../utils/params.js";
import { PAGE_OBSERVATION_SCHEMA_V3, type CollectionSummary, type CompactActionable, type ObservationSnapshot, type PageObservationV3, type PageTarget, type ProviderExecutionReport } from "../../kernels/abml/pageObservation.js";
import type { CollectionModel } from "../../kernels/abml/collections.js";
import type { SnapshotProjection } from "../../kernels/abml/snapshotProjection.js";

type PageObservationInput = {
	summary: Record<string, unknown>;
	entities: Entity[];
	content: string;
	headings?: string[];
	contentComplete?: boolean;
	url?: string;
	activeTabId?: unknown;
	snapshot: Record<string, unknown>;
	diff?: EntityDiff & { summary?: unknown };
	treeDiff?: TreeDiff;
	causal?: CausalSummary;
	abmlIntegrated: boolean;
	providerFailures?: ProviderFailureReason[];
	diagnostics: Record<string, unknown>;
	providerExecution?: ProviderExecutionReport;
};

export type PageObservationBuild = PageObservationV3;

type ProviderFailureReason = {
	provider: string;
	code: string;
	message?: string;
	details?: Record<string, unknown>;
};

function compactActionables(entities: Entity[], focus: Record<string, unknown>): CompactActionable[] {
	const primaryRefs = Array.isArray(focus.primary_entities)
		? focus.primary_entities.flatMap((item) => typeof item === "string" ? [item] : isRecord(item) && typeof item.ref === "string" ? [item.ref] : [])
		: [];
	const byRef = new Map(entities.map((entity) => [entity.ref, entity]));
	return primaryRefs.flatMap((ref) => {
		const entity = byRef.get(ref);
		if (!entity) return [];
		return [{ ref, kind: entity.kind, ...(entity.name ? { name: entity.name } : {}), ...(entity.state && Object.keys(entity.state).length ? { state: entity.state } : {}) }];
	});
}

function collectionSummaries(collections: CollectionModel[]): CollectionSummary[] {
	return collections.map((collection) => {
		const frontierNeeded = collection.completeness !== "complete" || collection.itemRefs.length > 3 || collection.evidence.length > 0 || Boolean(collection.dataSources?.length);
		return {
			ref: collection.containerRef ?? `collection:${collection.collectionId}`,
			kind: collection.kind,
			...(collection.containerName ? { name: collection.containerName } : {}),
			observed: collection.observedCount,
			...(typeof collection.declaredTotal === "number" || typeof collection.estimatedTotal === "number" ? { total: collection.declaredTotal ?? collection.estimatedTotal } : {}),
			completeness: collection.completeness,
			confidence: collection.confidence,
			itemRefs: [...collection.itemRefs],
			...(frontierNeeded ? { frontierRef: `frontier:collection:${collection.collectionId}` } : {}),
			collectionId: collection.collectionId,
			itemRefCount: collection.itemRefCount,
			...(typeof collection.hiddenCount === "number" ? { hiddenCount: collection.hiddenCount } : {}),
			...(collection.containerRole ? { containerRole: collection.containerRole } : {}),
			...(collection.containerNameContext ? { containerNameContext: collection.containerNameContext } : {}),
			...(collection.containerNameSource ? { containerNameSource: collection.containerNameSource } : {}),
			...(collection.itemRole ? { itemRole: collection.itemRole } : {}),
			...(collection.paginationControl ? { paginationControl: collection.paginationControl } : {}),
			...(collection.dataSources?.length ? { dataSources: collection.dataSources } : {}),
			...(collection.evidence.length ? { evidence: collection.evidence.map((item) => ({ source: item.source, summary: item.summary, ...(item.ref ? { ref: item.ref } : {}) })) } : {}),
		};
	});
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function observationSnapshot(value: Record<string, unknown>): ObservationSnapshot {
	const snapshotId = optionalString(value.snapshotId);
	const sourceMode = optionalString(value.sourceMode);
	const capturedAt = typeof value.capturedAt === "number" && Number.isFinite(value.capturedAt) ? value.capturedAt : undefined;
	const ttlMs = typeof value.ttlMs === "number" && Number.isFinite(value.ttlMs) ? value.ttlMs : undefined;
	if (!snapshotId || !sourceMode || capturedAt === undefined || ttlMs === undefined) throw new Error("PAGE_OBSERVATION_SNAPSHOT_INVALID");
	return {
		snapshotId,
		sourceMode,
		capturedAt,
		ttlMs,
		...(optionalString(value.browserSessionId) ? { browserSessionId: optionalString(value.browserSessionId) } : {}),
		...(optionalInteger(value.tabId) !== undefined ? { tabId: optionalInteger(value.tabId) } : {}),
		...(optionalString(value.url) ? { url: optionalString(value.url) } : {}),
		...(optionalInteger(value.targetGeneration) !== undefined ? { targetGeneration: optionalInteger(value.targetGeneration) } : {}),
		...(optionalString(value.pageEpoch) ? { pageEpoch: optionalString(value.pageEpoch) } : {}),
		...(optionalString(value.documentId) ? { documentId: optionalString(value.documentId) } : {}),
		...(optionalString(value.frameScope) ? { frameScope: optionalString(value.frameScope) } : {}),
		...(optionalInteger(value.selectionVersion) !== undefined ? { selectionVersion: optionalInteger(value.selectionVersion) } : {}),
		...(optionalInteger(value.networkSeq) !== undefined ? { networkSeq: optionalInteger(value.networkSeq) } : {}),
		...(optionalInteger(value.hookSeq) !== undefined ? { hookSeq: optionalInteger(value.hookSeq) } : {}),
		...(optionalString(value.invalidatedReason) ? { invalidatedReason: optionalString(value.invalidatedReason) } : {}),
		...(typeof value.expired === "boolean" ? { expired: value.expired } : {}),
	};
}

function pageTarget(snapshot: ObservationSnapshot, url: string | undefined, activeTabId: unknown): PageTarget {
	const tabId = snapshot.tabId ?? optionalInteger(activeTabId);
	return {
		...(snapshot.browserSessionId ? { browserSessionId: snapshot.browserSessionId } : {}),
		...(tabId !== undefined ? { tabId } : {}),
		...(snapshot.targetGeneration !== undefined ? { targetGeneration: snapshot.targetGeneration } : {}),
		...(snapshot.pageEpoch ? { pageEpoch: snapshot.pageEpoch } : {}),
		...(url ? { url } : {}),
	};
}

function reanchorReason(value: unknown): PageObservationV3["reanchorReason"] {
	return typeof value === "string" && ["document_changed", "target_replaced", "session_changed", "identity_unproven", "baseline_missing"].includes(value)
		? value as PageObservationV3["reanchorReason"]
		: undefined;
}

export function buildPageObservation(input: PageObservationInput): PageObservationBuild {
	const focus = isRecord(input.summary.focus) ? input.summary.focus as Record<string, unknown> : {};
	const gist = isRecord(focus.gist) ? focus.gist : undefined;
	const outline = Array.isArray(focus.outline) ? focus.outline : undefined;
	const providerReport: ProviderExecutionReport = {
		scan: { planned: true, status: "executed" },
		structure: { planned: true, status: input.abmlIntegrated ? "executed" : "degraded", ...(!input.abmlIntegrated ? { reason: "abml-read-failed" } : {}) },
		...(input.providerExecution ?? {}),
	};
	const fullSnapshotProjection = isRecord(input.summary.snapshotProjection) ? input.summary.snapshotProjection as unknown as SnapshotProjection : undefined;
	const fullCollections = Array.isArray(input.summary.collections) ? input.summary.collections as CollectionModel[] : [];
	const snapshot = observationSnapshot(input.snapshot);
	const target = pageTarget(snapshot, input.url, input.activeTabId);
	const reason = reanchorReason(input.summary.reanchorReason);
	const actionables = compactActionables(input.entities, focus);
	return {
		schema: PAGE_OBSERVATION_SCHEMA_V3,
		tool: "browser_observe",
		model: "PageObservation",
		canonical: true,
		target,
		snapshot,
		content: { text: input.content, ...(input.headings?.length ? { headings: input.headings } : {}), complete: input.contentComplete !== false },
		...(reason ? { reanchorReason: reason } : {}),
		...(input.summary.delta === "session" ? { delta: "session" as const } : {}),
		...(typeof input.summary.baselineSnapshotId === "string" ? { baselineSnapshotId: input.summary.baselineSnapshotId } : {}),
		...(gist ? { gist } : {}),
		...(outline ? { outline: outline.filter(isRecord) as Array<Record<string, unknown>> } : {}),
		...(input.entities.length ? { entities: input.entities } : {}),
		...(actionables.length ? { actionables } : {}),
		...(isRecord(focus.relations) ? { relations: focus.relations as PageObservationV3["relations"] } : {}),
		...(isRecord(input.summary.identity) ? { identity: input.summary.identity } : {}),
		...(isRecord(input.summary.inference) ? { inference: input.summary.inference as PageObservationV3["inference"] } : {}),
		...(input.diff ? { diff: input.diff } : {}),
		...(input.treeDiff ? { treeDiff: input.treeDiff } : {}),
		...(input.causal ? { causal: input.causal } : {}),
		...(fullSnapshotProjection ? { snapshotProjection: fullSnapshotProjection } : {}),
		...(fullCollections.length ? { collections: collectionSummaries(fullCollections) } : {}),
		providers: providerReport,
		frontier: { items: [] },
		diagnostics: {
			...input.diagnostics,
			abmlIntegrated: input.abmlIntegrated,
			...(input.providerFailures?.length ? { providerFailures: input.providerFailures } : {}),
		},
		...(Array.isArray(input.summary.nextActions) ? { nextActions: input.summary.nextActions.filter((item): item is string => typeof item === "string") } : {}),
	};
}

export function buildScanNextActionHints(input: {
	hasBaseline: boolean;
	snapshotId?: unknown;
	recorderActive: boolean;
	causal?: CausalSummary;
	treeDiff?: TreeDiff;
}): string[] {
	const hints: string[] = [];
	const sid = typeof input.snapshotId === "string" ? input.snapshotId : undefined;
	if (!input.hasBaseline && sid) {
		hints.push(`after acting, use browser_observe diff:true only if the next decision needs fresh state; inspect treeDiff${input.recorderActive ? " and causal.requests" : ""}`);
	}
	if (input.hasBaseline && input.causal) {
		const firedHint = causalFiredHint(input.causal);
		if (firedHint) hints.push(firedHint);
	}
	if (input.hasBaseline && input.treeDiff && input.treeDiff.summary.changedTemplateCount > 0) {
		const s = input.treeDiff.summary;
		const eg = [
			...(s.sample?.appeared?.length ? [`+${s.sample.appeared.slice(0, 3).join(", ")}`] : []),
			...(s.sample?.disappeared?.length ? [`-${s.sample.disappeared.slice(0, 3).join(", ")}`] : []),
			...(s.sample?.changed?.length ? [`~${s.sample.changed.slice(0, 3).join(", ")}`] : []),
		].join("; ");
		hints.push(`treeDiff: +${s.appeared}/-${s.disappeared}/~${s.changed} templates${eg ? ` (${eg})` : ""}; expand treeDiff.templates only if the summary sample is insufficient`);
	}
	return hints;
}

export function buildObserveAbmlDetails(input: {
	abmlRead: { ok?: boolean; entities?: Entity[] } | undefined;
	diagnostics: unknown;
}) {
	return input.abmlRead?.ok === true
		? {
			integrated: true,
			entityCount: input.abmlRead.entities?.length ?? 0,
			primaryEntityCount: input.abmlRead.entities?.filter((entity) => entity.kind !== "region" && entity.kind !== "frame").length ?? 0,
			listEntityCount: input.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).length ?? 0,
			visualRegionCount: input.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.source === "vision").length ?? 0,
			frameEntityCount: input.abmlRead.entities?.filter((entity) => entity.kind === "frame").length ?? 0,
			diagnostics: input.diagnostics,
		}
		: { integrated: false, diagnostics: input.diagnostics };
}
