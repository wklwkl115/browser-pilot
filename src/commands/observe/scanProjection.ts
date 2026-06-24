import type { Entity } from "../../kernels/abml/entity.js";
import type { EntityDiff } from "../../kernels/abml/diff.js";
import type { TreeDiff } from "../../kernels/abml/treeDiff.js";
import type { CausalSummary } from "../../kernels/abml/causal.js";
import { causalFiredHint } from "../../kernels/abml/causal.js";
import { isRecord } from "../../utils/params.js";
import type { ObserveMode } from "./common.js";
import { scanCommandName } from "./renderCache.js";

export type ObserveCausalBlock = { causal?: CausalSummary };

type ArtifactHintRead = { label: string; jsonPath: string; kind?: string };

function addArtifactHint(summary: Record<string, unknown>, key: string, read: ArtifactHintRead, position: "front" | "back" = "back"): void {
	const hints = isRecord(summary.artifact_hints) ? summary.artifact_hints as Record<string, unknown> : undefined;
	if (!hints) return;
	const jsonPaths = isRecord(hints.jsonPaths) ? { ...hints.jsonPaths } : {};
	jsonPaths[key] = read.jsonPath;
	const preferredReads = Array.isArray(hints.preferredReads) ? [...hints.preferredReads] : [];
	if (!preferredReads.some((item) => isRecord(item) && item.jsonPath === read.jsonPath)) {
		if (position === "front") preferredReads.unshift(read);
		else preferredReads.push(read);
	}
	hints.jsonPaths = jsonPaths;
	hints.preferredReads = preferredReads;
}

export function attachAbmlArtifactHints(summary: Record<string, unknown>): void {
	if (Array.isArray(summary.collections) && summary.collections.length) {
		addArtifactHint(summary, "collections", { label: "collection completeness + continuation", jsonPath: "envelope.collections", kind: "abml-collections" }, "front");
	}
	if (isRecord(summary.snapshotProjection)) {
		addArtifactHint(summary, "snapshotProjection", { label: "living snapshot projection", jsonPath: "envelope.snapshotProjection", kind: "abml-structure" });
	}
	const focus = isRecord(summary.focus) ? summary.focus : undefined;
	if (isRecord(focus?.relations)) {
		addArtifactHint(summary, "relations", { label: "relationship graph summary", jsonPath: "envelope.relations", kind: "abml-relations" });
		addArtifactHint(summary, "relationGraph", { label: "full ABML relation graph", jsonPath: "envelope.relationGraph", kind: "abml-relations" });
	}
	if (isRecord(summary.identity)) {
		addArtifactHint(summary, "identityGraph", { label: "identity lattice graph", jsonPath: "envelope.identityGraph", kind: "abml-identity" });
	}
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
		hints.push(`to see what CHANGES after you act here: re-run browser_observe mode=scan baseline:"${sid}" → envelope.treeDiff (template-level appeared/disappeared, cleaner than re-extracting before/after)${input.recorderActive ? "; + envelope.causal.requests = which requests your action fired" : ""}`);
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
		hints.push(`structure changed (${s.appeared} appeared / ${s.disappeared} disappeared / ${s.changed} changed, template-level)${eg ? ` — e.g. ${eg}` : ""} → envelope.treeDiff.summary.sample names the items; .templates[].instances has the rest (no need to re-extract)`);
	}
	return hints;
}

export function buildObserveArtifactProjection(input: {
	summaryRecord: Record<string, unknown>;
	summary: Record<string, unknown>;
	envelopeEntities: Entity[];
	envelopeDiff?: EntityDiff & { summary?: unknown };
	abmlTreeDiff?: TreeDiff;
	artifactRelevance?: Record<string, unknown>;
	causalBlock: ObserveCausalBlock;
	mode: Extract<ObserveMode, "scan" | "text">;
	hasNavigation: boolean;
}) {
	const artifactSnapshotProjection = isRecord(input.summaryRecord.snapshotProjection) ? input.summaryRecord.snapshotProjection : undefined;
	const artifactCollections = Array.isArray(input.summaryRecord.collections) ? input.summaryRecord.collections.filter(isRecord) as Array<Record<string, unknown>> : undefined;
	const artifactIdentityGraph = isRecord(input.summaryRecord._identityGraph) ? input.summaryRecord._identityGraph : undefined;
	const artifactRelationGraph = isRecord(input.summaryRecord._relationGraph) ? input.summaryRecord._relationGraph : undefined;
	delete input.summaryRecord._identityGraph;
	delete input.summaryRecord._relationGraph;
	const artifactFocus = isRecord(input.summaryRecord.focus) ? input.summaryRecord.focus as Record<string, unknown> : undefined;
	const artifactRelations = isRecord(artifactFocus?.relations) ? artifactFocus!.relations : undefined;
	const artifactEnvelopeMirror = {
		tool: "browser_observe",
		command: scanCommandName(input.mode, input.hasNavigation),
		summary: input.summary,
		...(input.envelopeEntities.length ? { entities: input.envelopeEntities.slice(0, 12) } : {}),
		...(input.envelopeDiff ? { diff: input.envelopeDiff } : {}),
		...(input.abmlTreeDiff ? { treeDiff: input.abmlTreeDiff } : {}),
		...(artifactRelations ? { relations: artifactRelations } : {}),
		...(artifactRelationGraph ? { relationGraph: artifactRelationGraph } : {}),
		...(artifactSnapshotProjection ? { snapshotProjection: artifactSnapshotProjection } : {}),
		...(artifactCollections?.length ? { collections: artifactCollections } : {}),
		...(artifactIdentityGraph ? { identityGraph: artifactIdentityGraph } : {}),
		...(input.artifactRelevance ? { relevance: input.artifactRelevance } : {}),
		...input.causalBlock,
	};
	return {
		artifactSnapshotProjection,
		artifactCollections,
		artifactIdentityGraph,
		artifactRelationGraph,
		artifactRelations,
		artifactEnvelopeMirror,
	};
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
