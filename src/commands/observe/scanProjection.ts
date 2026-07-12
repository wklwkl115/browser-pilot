import { artifactHints } from "../summaries/common.js";
import type { Entity } from "../../kernels/abml/entity.js";
import type { EntityDiff } from "../../kernels/abml/diff.js";
import type { TreeDiff } from "../../kernels/abml/treeDiff.js";
import type { CausalSummary } from "../../kernels/abml/causal.js";
import { causalFiredHint } from "../../kernels/abml/causal.js";
import { isRecord } from "../../utils/params.js";
import type { ObserveMode } from "./common.js";
import { scanCommandName } from "./renderCache.js";

export type ObserveCausalBlock = { causal?: CausalSummary };

type PageObservationInput = {
	mode: Extract<ObserveMode, "scan" | "text">;
	canonical: boolean;
	summary: Record<string, unknown>;
	entities: Entity[];
	content: string;
	url?: string;
	tabs: unknown[];
	activeTabId?: unknown;
	snapshot: Record<string, unknown>;
	diff?: EntityDiff & { summary?: unknown };
	treeDiff?: TreeDiff;
	causal?: CausalSummary;
	artifactPath?: string;
	abmlIntegrated: boolean;
	tabsRefreshDegraded?: boolean;
	structFailed?: boolean;
	providerStatuses?: Partial<ProviderDiagnostics>;
	providerFailures?: ProviderFailureReason[];
	diagnostics: Record<string, unknown>;
};

type ArtifactHintRead = { label: string; jsonPath: string; kind?: string };

type ProviderStatus = "executed" | "scan-backed" | "ax-enriched" | "ax-only" | "skipped" | "failed" | "degraded";

type ProviderBudgetTelemetryStatus = Extract<ProviderStatus, "executed" | "scan-backed" | "skipped" | "failed" | "degraded">;

type ProviderBudgetTelemetryItem = {
	provider: string;
	status: ProviderBudgetTelemetryStatus;
	requested?: boolean;
	durationMs?: number;
	counts?: Record<string, number>;
	budget?: Record<string, number | boolean>;
	truncated?: boolean;
	degraded?: boolean;
	reason?: string;
	errorCode?: string;
	artifact?: Record<string, unknown>;
};

type ProviderBudgetTelemetryInput = {
	providers: Partial<ProviderDiagnostics>;
	diagnostics: Record<string, unknown>;
	contentLength: number;
	tabCount: number;
	artifactPath?: string;
};

type ProviderFailureReason = {
	provider: string;
	code: string;
	message?: string;
	details?: Record<string, unknown>;
};

type ProviderDiagnostics = {
	structure: ProviderStatus;
	content: ProviderStatus;
	text: ProviderStatus;
	html: ProviderStatus;
	evidence: ProviderStatus;
	tabs: ProviderStatus;
	ax?: ProviderStatus;
	axe?: ProviderStatus;
	readability?: ProviderStatus;
};

export type PageObservationProviderInput = {
	tabCount: number;
	tabRefreshAttempted?: boolean;
	tabsRefreshDegraded?: boolean;
	tabFallbackUsed?: boolean;
	tabListAvailable?: boolean;
	tabCountAvailable?: boolean;
	abmlIntegrated?: boolean;
	contentLength?: number;
	artifactPath?: string;
	structFailed?: boolean;
	structureStatus?: ProviderStatus;
	contentStatus?: ProviderStatus;
	textStatus?: ProviderStatus;
	htmlStatus?: ProviderStatus;
	evidenceStatus?: ProviderStatus;
	tabsStatus?: ProviderStatus;
	axStatus?: ProviderStatus;
	axeStatus?: ProviderStatus;
	readabilityStatus?: ProviderStatus;
};

export function buildPageObservationProviders(input: PageObservationProviderInput): ProviderDiagnostics {
	const structureStatus: ProviderStatus = input.structureStatus
		?? (input.structFailed ? "failed" : input.abmlIntegrated === true ? "executed" : input.abmlIntegrated === false ? "degraded" : "scan-backed");
	const contentStatus: ProviderStatus = input.contentStatus ?? (typeof input.contentLength === "number" ? input.contentLength > 0 ? "scan-backed" : "skipped" : "scan-backed");
	const textStatus: ProviderStatus = input.textStatus ?? (typeof input.contentLength === "number" ? input.contentLength > 0 ? "scan-backed" : "skipped" : "scan-backed");
	const htmlStatus: ProviderStatus = input.htmlStatus ?? (typeof input.artifactPath === "string" ? input.artifactPath ? "scan-backed" : "skipped" : input.contentLength === 0 ? "skipped" : "scan-backed");
	const evidenceStatus: ProviderStatus = input.evidenceStatus ?? (typeof input.artifactPath === "string" ? input.artifactPath ? "scan-backed" : "skipped" : input.contentLength === 0 ? "skipped" : "scan-backed");
	const tabsStatus: ProviderStatus = input.tabsStatus
		?? (input.tabListAvailable === false || input.tabCountAvailable === false
			? "failed"
			: input.tabCount <= 0 || input.tabFallbackUsed || input.tabsRefreshDegraded
				? "degraded"
				: input.tabRefreshAttempted === false
					? "skipped"
					: "executed");
	return {
		structure: structureStatus,
		content: contentStatus,
		text: textStatus,
		html: htmlStatus,
		evidence: evidenceStatus,
		tabs: tabsStatus,
		...(input.axStatus ? { ax: input.axStatus } : {}),
		...(input.axeStatus ? { axe: input.axeStatus } : {}),
		...(input.readabilityStatus ? { readability: input.readabilityStatus } : {}),
	};
}

function normalizeTelemetryStatus(status: ProviderStatus): ProviderBudgetTelemetryStatus {
	if (status === "ax-enriched" || status === "ax-only") return "executed";
	return status;
}

function numberFrom(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactNumberRecord(record: Record<string, unknown> | undefined, keys: string[]): Record<string, number> | undefined {
	const entries = keys.flatMap((key) => {
		const value = numberFrom(record, key);
		return value === undefined ? [] : [[key, value] as const];
	});
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function compactBudgetRecord(record: Record<string, unknown> | undefined, keys: string[]): Record<string, number | boolean> | undefined {
	const entries = keys.flatMap((key) => {
		const value = record?.[key];
		return typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" ? [[key, value] as const] : [];
	});
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function errorCode(record: Record<string, unknown> | undefined): string | undefined {
	const error = isRecord(record?.error) ? record.error : undefined;
	return typeof error?.code === "string" ? error.code : undefined;
}

function artifactRef(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	const artifact = isRecord(record?.artifact) ? record.artifact : undefined;
	if (!artifact) return undefined;
	const path = typeof artifact.path === "string" ? artifact.path : undefined;
	const jsonPath = typeof artifact.jsonPath === "string" ? artifact.jsonPath : undefined;
	const kind = typeof artifact.kind === "string" ? artifact.kind : undefined;
	return { ...(path ? { path } : {}), ...(jsonPath ? { jsonPath } : {}), ...(kind ? { kind } : {}) };
}

function telemetryReason(provider: string, status: ProviderStatus, record: Record<string, unknown> | undefined): string | undefined {
	const code = errorCode(record);
	if (code) return code;
	if (record?.timedOut === true) return "timeout";
	if (provider === "readability" && record?.truncated === true) return "truncated";
	if (provider === "axe" && numberFrom(isRecord(record?.counts) ? record.counts : undefined, "incomplete")) return "incomplete-results";
	if (status === "skipped") return "not-requested";
	return undefined;
}

export function buildProviderBudgetTelemetry(input: ProviderBudgetTelemetryInput): ProviderBudgetTelemetryItem[] {
	const timings = isRecord(input.diagnostics.observeTimings) ? input.diagnostics.observeTimings : undefined;
	const axFusion = isRecord(input.diagnostics.axFusion) ? input.diagnostics.axFusion : undefined;
	const axe = isRecord(input.diagnostics.axe) ? input.diagnostics.axe : undefined;
	const readability = isRecord(input.diagnostics.readability) ? input.diagnostics.readability : undefined;
	const add = (items: ProviderBudgetTelemetryItem[], provider: string, status: ProviderStatus | undefined, extra: Omit<ProviderBudgetTelemetryItem, "provider" | "status"> = {}) => {
		if (!status) return;
		const item: ProviderBudgetTelemetryItem = { provider, status: normalizeTelemetryStatus(status), ...extra };
		items.push(item);
	};
	const items: ProviderBudgetTelemetryItem[] = [];
	add(items, "structure", input.providers.structure, {
		durationMs: numberFrom(timings, "abmlMs"),
		counts: compactNumberRecord(timings, ["nodeCount", "axNodeCount", "axCdpCalls", "axGeometryCdpCalls"]),
	});
	add(items, "content", input.providers.content, { counts: { chars: input.contentLength } });
	add(items, "text", input.providers.text, { counts: { chars: input.contentLength } });
	add(items, "html", input.providers.html, { artifact: input.artifactPath ? { path: input.artifactPath, jsonPath: "data.html" } : undefined });
	add(items, "evidence", input.providers.evidence, { artifact: input.artifactPath ? { path: input.artifactPath, jsonPath: "envelope" } : undefined });
	add(items, "tabs", input.providers.tabs, { durationMs: numberFrom(timings, "tabRefreshMs"), counts: { tabs: input.tabCount } });
	add(items, "ax", input.providers.ax, {
		durationMs: numberFrom(timings, "axMs"),
		counts: compactNumberRecord({ ...timings, ...axFusion }, ["axNodeCount", "axCdpCalls", "axGeometryCdpCalls", "scanBacked", "axEnriched", "axOnly"]),
		budget: compactBudgetRecord(timings, ["axCacheHit", "geometryFallbackTruncated"]),
		degraded: axFusion?.degraded === true,
		reason: axFusion?.degraded === true ? "ax-fusion-degraded" : undefined,
	});
	add(items, "axe", input.providers.axe, {
		requested: axe?.requested === true,
		durationMs: numberFrom(axe, "ms") ?? numberFrom(timings, "axeMs"),
		counts: isRecord(axe?.counts) ? compactNumberRecord(axe.counts, ["violations", "incomplete", "passes", "inapplicable"]) : undefined,
		budget: isRecord(axe?.bounded) ? compactBudgetRecord(axe.bounded, ["maxInlineResults"]) : undefined,
		degraded: axe?.degraded === true,
		reason: input.providers.axe ? telemetryReason("axe", input.providers.axe, axe) : undefined,
		errorCode: errorCode(axe),
		artifact: artifactRef(axe),
	});
	add(items, "readability", input.providers.readability, {
		requested: readability?.requested === true,
		durationMs: numberFrom(readability, "ms") ?? numberFrom(timings, "readabilityMs"),
		counts: compactNumberRecord(readability, ["textLength", "contentLength"]),
		budget: isRecord(readability?.bounded) ? compactBudgetRecord(readability.bounded, ["maxInlineChars"]) : undefined,
		truncated: readability?.truncated === true,
		degraded: readability?.degraded === true,
		reason: input.providers.readability ? telemetryReason("readability", input.providers.readability, readability) : undefined,
		errorCode: errorCode(readability),
		artifact: artifactRef(readability),
	});
	return items;
}

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

export function buildPageObservation(input: PageObservationInput): Record<string, unknown> {
	const focus = isRecord(input.summary.focus) ? input.summary.focus as Record<string, unknown> : {};
	const gist = isRecord(focus.gist) ? focus.gist : undefined;
	const outline = Array.isArray(focus.outline) ? focus.outline : undefined;
	const contentPreview = input.content.replace(/\s+/g, " ").trim().slice(0, 1_000);
	const context = {
		url: input.url,
		activeTabId: input.activeTabId,
		tabCount: input.tabs.length,
	};
	const evidenceReads = [
		{ label: "response envelope", jsonPath: "envelope", kind: "browser-observe-envelope" },
		{ label: "saved observation artifact", jsonPath: "pageObservation", kind: "abml-page-observation" },
		{ label: "raw scan evidence", jsonPath: "data", kind: "scan-evidence" },
		{ label: "saved observation content", jsonPath: "pageObservation.content", kind: "content-digest" },
		{ label: "saved observation text", jsonPath: "pageObservation.text", kind: "text-index" },
		...(input.providerStatuses?.readability ? [{ label: "Readability article", jsonPath: "readability", kind: "readability-content" }] : []),
	];
	const providers = buildPageObservationProviders({
		abmlIntegrated: input.abmlIntegrated,
		contentLength: input.content.length,
		artifactPath: input.artifactPath,
		tabCount: input.tabs.length,
		tabsRefreshDegraded: input.tabsRefreshDegraded,
		structFailed: input.structFailed,
		structureStatus: input.providerStatuses?.structure,
		contentStatus: input.providerStatuses?.content,
		textStatus: input.providerStatuses?.text,
		htmlStatus: input.providerStatuses?.html,
		evidenceStatus: input.providerStatuses?.evidence,
		tabsStatus: input.providerStatuses?.tabs,
		axStatus: input.providerStatuses?.ax,
		axeStatus: input.providerStatuses?.axe,
		readabilityStatus: input.providerStatuses?.readability,
	});
	const providerBudgetTelemetry = buildProviderBudgetTelemetry({
		providers,
		diagnostics: input.diagnostics,
		contentLength: input.content.length,
		tabCount: input.tabs.length,
		artifactPath: input.artifactPath,
	});
	return {
		model: "PageObservation",
		canonical: input.canonical,
		mode: input.mode,
		sourceMode: "scan",
		context,
		...(gist ? { gist } : {}),
		...(outline ? { outline } : {}),
		entities: input.entities.slice(0, 12),
		actionables: Array.isArray(focus.primary_entities) ? focus.primary_entities : [],
		refs: input.entities.map((entity) => entity.ref).filter((ref): ref is string => typeof ref === "string").slice(0, 50),
		...(isRecord(focus.relations) ? { relations: focus.relations } : {}),
		...(Array.isArray(input.summary.collections) ? { collections: input.summary.collections } : {}),
		content: {
			chars: input.content.length,
			preview: contentPreview,
			artifact: input.artifactPath ? { path: input.artifactPath, jsonPath: "pageObservation.content" } : undefined,
		},
		text: {
			chars: input.content.length,
			preview: contentPreview,
			artifact: input.artifactPath ? { path: input.artifactPath, jsonPath: "pageObservation.text" } : undefined,
		},
		evidence: {
			artifact: input.artifactPath ? { path: input.artifactPath, jsonPath: "envelope" } : undefined,
		},
		snapshot: input.snapshot,
		...(input.diff ? { diff: input.diff } : {}),
		...(input.treeDiff ? { treeDiff: input.treeDiff } : {}),
		...(input.causal ? { causal: input.causal } : {}),
		...(isRecord(input.summary.memory) ? { memory: input.summary.memory } : {}),
		diagnostics: {
			...input.diagnostics,
			abmlIntegrated: input.abmlIntegrated,
			providers,
			providerBudgetTelemetry,
			...(input.providerFailures?.length ? { providerFailures: input.providerFailures } : {}),
		},
		...artifactHints(evidenceReads),
	};
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
