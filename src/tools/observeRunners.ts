import { readFile } from "node:fs/promises";
import { buildContentScript } from "../content/buildContentScript.js";
import { BrowserBridgeError } from "../driver/errors.js";
import { executeBrowserWaitWithSupervisor } from "../driver/BrowserWaitSupervisor.js";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import type { Entity } from "../abml/entity.js";
import { summarizeEntityDiff, type EntityDiff } from "../abml/diff.js";
import { buildRelationSummary, addEntityRelations } from "../abml/relations.js";
import { buildInferenceSummary, entitiesForInferenceEvidence } from "../abml/inference.js";
import { buildCausalSummary, causalUnavailable, buildTriggeredRelations, resolveActionEntityRef, buildCausalEvents, eventTriggeredByEntity, causalFiredHint, type CausalSummary } from "../abml/causal.js";
import { buildTreeDiff, type TreeDiff } from "../abml/treeDiff.js";
import { buildSnapshotProjection } from "../abml/snapshotProjection.js";
import { buildIdentityGraph, identityGraphSummary } from "../abml/identityGraph.js";
import { factsFromEntities, stableRefsFromFrames, type PerceptionLedgerFrame, type PerceptionLedgerKey, type PerceptionTraceSnapshot } from "../abml/perceptionLedger.js";
import type { FactGranularity } from "../distill-core/fact.js";
import { computeRelevanceMap, type RelevanceInput, type RelevanceResult, type RelevanceTerm } from "../distill-core/relevance.js";
import { extractScalarTerm, extractUrlTerms } from "../distill-core/relevanceTaps.js";
import { createBrowserAbmlIntegration } from "../abml/verbs/integration.js";
import { nativeCommandToolMetadata } from "../protocol/nativeActionMetadata.js";
import { normalizeNativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { buildScanScript } from "../scan/buildScanScript.js";
import { createCodedError } from "../utils/codedError.js";
import { parseJsonOrThrow } from "../utils/json.js";
import { isRecord, normalizeTabId } from "../utils/params.js";
import { resolveArtifactPath } from "./artifacts.js";
import { assertBridgeCommandSucceeded } from "./bridgeResultValidation.js";
import { queryHookDelta, queryNetworkDelta, readHookRecorderSeq, readNetworkRecorderSeq, readPageFingerprint, type PageFingerprint } from "./pageSignals.js";
import { evaluatePageScriptDirect } from "./pageScriptEvaluation.js";
import { registerScanEntityRefs } from "./scanEntityRefs.js";
import { scanEntitiesForEnvelope, summarizeContentData, summarizeHtmlSnapshot, summarizeScanData } from "./summaries/index.js";
import { artifactFallbackName, bridgeNestedErrorResult, jsonToolResult, targetTabId, textToolResult, toolMaxChars, toolTimeoutMs, withTrackedOperation, type ToolOnUpdate, type ToolResultContext } from "./toolAdapter.js";
import { DEFAULT_TOOL_TIMEOUT_MS, objectParam } from "./toolShared.js";

export const DEFAULT_CONTENT_TIMEOUT_MS = 35_000;
export const MIN_CONTENT_TIMEOUT_MS = 100;

export type ObserveMode = "scan" | "content" | "html" | "text" | "tabs";

export type ObserveToolParams = {
	mode?: string;
	browserSessionId?: string;
	tabId?: number | string;
	detailLevel?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
	selector?: string;
	url?: string;
	includeLinks?: boolean;
	maxNodes?: number;
	includeIframes?: boolean;
	htmlMode?: string;
	params?: unknown;
	intent?: string;
	baseline?: unknown;
	actionRef?: string;
	modeInferred?: { mode: ObserveMode; reason: string } | null;
};

type ObserveRunnerError = Error & { code: "INVALID_TIMEOUT"; details: Record<string, unknown> };

function contentTimeoutError(message: string, value: unknown): ObserveRunnerError {
	return createCodedError({
		name: "ObserveRunnerError",
		code: "INVALID_TIMEOUT",
		message,
		details: { timeoutMs: value, minTimeoutMs: MIN_CONTENT_TIMEOUT_MS },
	}) as ObserveRunnerError;
}

export function normalizeContentTimeoutMs(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_CONTENT_TIMEOUT_MS;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw contentTimeoutError("browser_observe content timeoutMs must be a positive number", value);
	const timeoutMs = Math.ceil(n);
	if (timeoutMs < MIN_CONTENT_TIMEOUT_MS) throw contentTimeoutError(`browser_observe content timeoutMs must be at least ${MIN_CONTENT_TIMEOUT_MS}ms`, value);
	return timeoutMs;
}

function withObservationMeta(summary: Record<string, unknown>, mode: ObserveMode, sourceMode: "scan" | "content" | "html"): Record<string, unknown> {
	return { mode, sourceMode, ...summary };
}

// Entity-level focus salience. The scan-side scoreAction (summaries/scan.ts) only ranks DOM
// actionables; AX-only entities (appended after the DOM↔AX merge for nodes with no DOM match
// — e.g. ARIA controls the scan never surfaced) bypass it and would otherwise sink to the
// tail. This re-ranks the merged set so active/stateful controls lead primary_entities
// regardless of source. Lower rank = higher priority; stable within a rank.
export function entitySalienceRank(entity: Entity): number {
	const s = entity.state;
	if (s.checked === true || s.selected === true || s.pressed === true || (s.current !== undefined && s.current !== false)) return 0;
	if (s.checked !== undefined || s.selected !== undefined || s.pressed !== undefined) return 1;
	if (entity.kind === "control") return 2;
	if (s.inViewport === true) return 3;
	return 4;
}

export function sortEntitiesBySalience(entities: Entity[], relevance?: RelevanceResult): Entity[] {
	return entities
		.map((entity, index) => ({ entity, index, relevance: relevance?.byRef.get(entity.ref)?.score ?? 0 }))
		.sort((a, b) => entitySalienceRank(a.entity) - entitySalienceRank(b.entity) || b.relevance - a.relevance || a.index - b.index)
		.map((item) => item.entity);
}

function relevanceEnabled(params: ObserveToolParams): boolean {
	return process.env.PI_BROWSER_RELEVANCE !== "0" && String(params.detailLevel || "summary") !== "full";
}

function observeIntent(params: ObserveToolParams): string | undefined {
	if (typeof params.intent === "string" && params.intent.trim()) return params.intent.trim();
	const nested = isRecord(params.params) ? params.params : undefined;
	return typeof nested?.intent === "string" && nested.intent.trim() ? nested.intent.trim() : undefined;
}

function traceTerms(snapshot: PerceptionTraceSnapshot | undefined): RelevanceTerm[] {
	return (snapshot?.terms ?? []).map((term, age) => ({ term: term.term, kind: term.kind as RelevanceTerm["kind"], weight: term.weight, age, source: "A" }));
}

function urlTerms(url: string | undefined): RelevanceTerm[] {
	return extractUrlTerms(url).map((term) => ({ ...term, source: "D" }));
}

function intentTerms(intent: string | undefined): RelevanceTerm[] {
	return extractScalarTerm(intent, "intent", 1.35).map((term) => ({ ...term, source: "E" }));
}

function archetypeTerms(inference: ReturnType<typeof buildInferenceSummary> | undefined): RelevanceTerm[] {
	return (inference?.intents ?? []).flatMap((item) => extractScalarTerm(item.intent, "intent", item.confidence === "high" ? 1.25 : 0.9).map((term) => ({ ...term, source: "C" as const })));
}

function entityRelevanceInputs(entities: Entity[]): RelevanceInput[] {
	const labelConsumers = new Map<string, string[]>();
	for (const entity of entities) {
		for (const rel of entity.relations ?? []) {
			if (rel.type !== "labelledBy") continue;
			const list = labelConsumers.get(rel.targetRef) ?? [];
			list.push(entity.ref);
			labelConsumers.set(rel.targetRef, list);
		}
	}
	return entities.map((entity) => {
		const selector = typeof entity.hints?.selector === "string" ? entity.hints.selector : undefined;
		const containerRole = typeof entity.hints?.containerRole === "string" ? entity.hints.containerRole : undefined;
		const containerName = typeof entity.hints?.containerName === "string" ? entity.hints.containerName : undefined;
		const container = [containerRole, containerName].filter(Boolean).join(" ") || undefined;
		return {
			ref: entity.ref,
			fields: {
				name: entity.name,
				role: entity.role,
				container,
				landmark: entity.structure?.landmark,
				value: entity.value,
				selector,
			},
			neighbors: {
				containerKey: container,
				labelledBySources: labelConsumers.get(entity.ref),
			},
		};
	});
}

type ObserveRelevance = {
	result: RelevanceResult;
	artifact: Record<string, unknown>;
};

function buildObserveRelevance(server: BrowserBridgeServer, params: ObserveToolParams, browserSessionId: string | undefined, url: string | undefined, entities: Entity[], inference?: ReturnType<typeof buildInferenceSummary>): ObserveRelevance | undefined {
	if (!relevanceEnabled(params)) return undefined;
	const trace = typeof server.perceptionTraceSnapshot === "function" ? server.perceptionTraceSnapshot(browserSessionId) : undefined;
	const terms = [
		...traceTerms(trace),
		...urlTerms(url),
		...archetypeTerms(inference),
		...intentTerms(observeIntent(params)),
	];
	if (!terms.length) return undefined;
	const result = computeRelevanceMap(entityRelevanceInputs(entities), terms);
	if (result.boosted <= 0) return undefined;
	const boostedRefs = Array.from(result.byRef.entries()).filter(([, match]) => match.score > 0).sort((a, b) => b[1].score - a[1].score).slice(0, 20).map(([ref, match]) => ({ ref, score: match.score, sources: match.sources }));
	return {
		result,
		artifact: {
			boosted: result.boosted,
			signals: result.signals,
			boostedRefs,
			...(process.env.PI_BROWSER_RELEVANCE_DEBUG === "1" ? { debugTerms: terms.map((term) => ({ term: term.term, kind: term.kind, source: term.source, age: term.age })).slice(0, 32) } : {}),
		},
	};
}

// Disclosure-tree skeleton (L1): fold entities by their AX container (P3 relationship arm)
// into a compact "container → members" outline. The agent reads the page structure cheaply,
// then expands a container's members by ref. Largest groups first; members beyond the cap
// stay reachable via the listed refs.
export function buildEntityOutline(entities: Entity[]): Array<Record<string, unknown>> {
	const groups = new Map<string, { container: string; name?: string; members: Array<{ ref: string; control: boolean }> }>();
	for (const entity of entities) {
		const role = typeof entity.hints?.containerRole === "string" ? entity.hints.containerRole : undefined;
		if (!role) continue;
		const name = typeof entity.hints?.containerName === "string" ? entity.hints.containerName : undefined;
		const key = `${role}\u0000${name ?? ""}`;
		let group = groups.get(key);
		if (!group) {
			group = { container: role, name, members: [] };
			groups.set(key, group);
		}
		group.members.push({ ref: entity.ref, control: entity.kind === "control" });
	}
	return Array.from(groups.values())
		.sort((a, b) => b.members.length - a.members.length)
		.slice(0, 12)
		.map((group) => {
			const controlCount = group.members.filter((member) => member.control).length;
			// Controls first so actionable members lead memberRefs; labels/text follow.
			const orderedRefs = [...group.members.filter((m) => m.control), ...group.members.filter((m) => !m.control)].map((m) => m.ref);
			return {
				container: group.container,
				...(group.name ? { name: group.name } : {}),
				memberCount: group.members.length,
				...(controlCount ? { controlCount } : {}),
				memberRefs: orderedRefs.slice(0, 12),
			};
		});
}

// Disclosure-tree L0 (gist): a compact page-level overview — which ARIA landmarks are
// present, how many controls and how many carry/are in an active state, how many distinct
// containers. The agent reads "what kind of page is this" before drilling into outline (L1)
// or the entities. Objective counts only — no page-shape guessing (would overfit).
export function buildPageGist(entities: Entity[]): Record<string, unknown> {
	const landmarks = new Set<string>();
	const containers = new Set<string>();
	let controlCount = 0;
	let statefulControlCount = 0;
	let activeControlCount = 0;
	for (const entity of entities) {
		const landmark = entity.structure?.landmark;
		if (typeof landmark === "string") landmarks.add(landmark);
		const containerRole = entity.hints?.containerRole;
		if (typeof containerRole === "string") containers.add(`${containerRole} ${typeof entity.hints?.containerName === "string" ? entity.hints.containerName : ""}`);
		if (entity.kind === "control") {
			controlCount += 1;
			const s = entity.state;
			if (s.checked !== undefined || s.selected !== undefined || s.pressed !== undefined) statefulControlCount += 1;
			if (s.checked === true || s.selected === true || s.pressed === true) activeControlCount += 1;
		}
	}
	return {
		landmarks: Array.from(landmarks),
		controlCount,
		...(statefulControlCount ? { statefulControlCount } : {}),
		...(activeControlCount ? { activeControlCount } : {}),
		containerCount: containers.size,
	};
}

function currentObserveSnapshotMeta(server: BrowserBridgeServer, params: ObserveToolParams, sourceMode: "scan" | "content" | "html", savedPath: string | undefined, url: string | undefined, networkSeq?: number, hookSeq?: number) {
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	return server.createObservationSnapshot({
		browserSessionId: bridge.browserSessionId,
		tabId: normalizeTabId(params.tabId) ?? bridge.defaultTabId,
		url,
		frameScope: "tab",
		selectionVersion: bridge.selectionVersion,
		sourceMode,
		capturedAt: Date.now(),
		networkSeq,
		hookSeq,
		saved: savedPath ? { path: savedPath } : undefined,
	});
}

// Build the envelope `causal` block when a baseline is supplied. Passive (no control attribution):
// "requests fired since the baseline observation". Emits `unavailable` when no recorder is active
// or the baseline carries no seq high-water mark (e.g. a raw entity-list baseline).
async function buildObserveCausal(server: BrowserBridgeServer, params: ObserveToolParams, recorderState: { active: boolean }, baselineNetworkSeq: number | undefined, tabId: number | undefined, timeoutMs: number): Promise<CausalSummary> {
	if (!recorderState.active) return causalUnavailable("network recorder not active — start via browser_network start");
	if (baselineNetworkSeq === undefined) return causalUnavailable("baseline has no network seq high-water mark — capture a baseline observation after browser_network start");
	try {
		const items = await queryNetworkDelta(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs, sinceSeq: baselineNetworkSeq });
		return buildCausalSummary(items, baselineNetworkSeq);
	} catch {
		return causalUnavailable("network recorder delta query failed");
	}
}

// Recover a baseline's network seq high-water mark from an inline baseline (a prior observe
// envelope/summary carries it under snapshot/correlation/top-level networkSeq).
function networkSeqFromBaseline(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.networkSeq === "number") return value.networkSeq;
	const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
	if (typeof snapshot?.networkSeq === "number") return snapshot.networkSeq;
	const correlation = isRecord(value.correlation) ? value.correlation : undefined;
	if (typeof correlation?.networkSeq === "number") return correlation.networkSeq;
	return undefined;
}

// Recover a baseline's hook seq high-water mark from an inline baseline (prior envelope/summary
// carries it under snapshot/correlation/top-level hookSeq), mirroring networkSeqFromBaseline.
function hookSeqFromBaseline(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.hookSeq === "number") return value.hookSeq;
	const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
	if (typeof snapshot?.hookSeq === "number") return snapshot.hookSeq;
	const correlation = isRecord(value.correlation) ? value.correlation : undefined;
	if (typeof correlation?.hookSeq === "number") return correlation.hookSeq;
	return undefined;
}

function entityArrayFromUnknown(value: unknown): Entity[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entities = value.filter((item): item is Entity => isRecord(item) && typeof item.ref === "string" && isRecord(item.state));
	return entities.length ? entities : undefined;
}

function mergeEntitiesByRef(...groups: unknown[][]): Entity[] {
	const seen = new Set<string>();
	const out: Entity[] = [];
	for (const group of groups) {
		for (const item of group) {
			if (!isRecord(item) || typeof item.ref !== "string" || !isRecord(item.state) || seen.has(item.ref)) continue;
			seen.add(item.ref);
			out.push(item as Entity);
		}
	}
	return out;
}

function entityRefs(entities: Entity[], limit = Number.MAX_SAFE_INTEGER): string[] {
	return entities.map((entity) => entity.ref).filter((ref): ref is string => typeof ref === "string" && !!ref).slice(0, limit);
}

function baselineEntitiesFromParam(value: unknown): Entity[] | undefined {
	const direct = entityArrayFromUnknown(value);
	if (direct) return direct;
	if (!isRecord(value)) return undefined;
	for (const key of ["entities", "primary_entities", "list_entities", "visual_regions", "referenced_entities"]) {
		const entities = entityArrayFromUnknown(value[key]);
		if (entities) return entities;
	}
	for (const key of ["summary", "focus", "abml", "abmlRead", "data"]) {
		const nested = baselineEntitiesFromParam(value[key]);
		if (nested) return nested;
	}
	const focus = isRecord(value.focus) ? value.focus : undefined;
	const collected = [
		...(Array.isArray(focus?.primary_entities) ? focus.primary_entities : []),
		...(Array.isArray(focus?.list_entities) ? focus.list_entities : []),
		...(Array.isArray(focus?.visual_regions) ? focus.visual_regions : []),
		...(Array.isArray(focus?.referenced_entities) ? focus.referenced_entities : []),
	];
	return entityArrayFromUnknown(collected);
}

function baselineSnapshotId(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (!isRecord(value)) return undefined;
	for (const key of ["snapshotId", "baselineSnapshotId"]) {
		if (typeof value[key] === "string" && value[key]) return value[key].trim();
	}
	const snapshot = isRecord(value.snapshot) ? value.snapshot : undefined;
	return typeof snapshot?.snapshotId === "string" && snapshot.snapshotId ? snapshot.snapshotId.trim() : undefined;
}

function savedArtifactPathFromBaseline(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const saved = isRecord(value.saved) ? value.saved : undefined;
	return typeof saved?.path === "string" && saved.path.trim() ? saved.path.trim() : undefined;
}

type BaselineResolution = { entities: Entity[]; partialBaseline: boolean; networkSeq?: number; hookSeq?: number; snapshotId?: string };

function baselineRecovery(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...extra,
		recovery: {
			retryable: true,
			hint: "Re-capture the baseline with browser_observe mode=scan, then pass the fresh snapshotId or saved observe artifact as baseline.",
			nextActions: ["browser_observe mode=scan", "use the new snapshotId or saved artifact as baseline"],
		},
	};
}

function baselinePartialHint(value: unknown, entities: Entity[]): boolean {
	if (Array.isArray(value)) return entities.length < 10;
	if (!isRecord(value)) return false;
	if (entityArrayFromUnknown(value.entities)) return false;
	if (value.partialBaseline === true || value.partial === true) return true;
	const diffOptions = isRecord(value.diffOptions) ? value.diffOptions : undefined;
	if (diffOptions?.partialBaseline === true) return true;
	if (["primary_entities", "list_entities", "visual_regions", "referenced_entities"].some((key) => Array.isArray(value[key]))) return true;
	const focus = isRecord(value.focus) ? value.focus : undefined;
	return !!focus && ["primary_entities", "list_entities", "visual_regions", "referenced_entities"].some((key) => Array.isArray(focus[key]));
}

async function resolveBaselineEntities(server: BrowserBridgeServer, baseline: unknown): Promise<BaselineResolution | undefined> {
	if (baseline === undefined || baseline === null) return undefined;
	const savedPath = savedArtifactPathFromBaseline(baseline);
	if (savedPath) {
		let parsedSaved: unknown;
		try {
			parsedSaved = parseJsonOrThrow(await readFile(savedPath, "utf8"), "browser_observe baseline saved artifact");
		} catch (error) {
			throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline saved artifact could not be read as JSON", baselineRecovery({ path: savedPath, error: error instanceof Error ? error.message : String(error) }));
		}
		const fromSaved = baselineEntitiesFromParam(parsedSaved);
		if (!fromSaved) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline saved artifact does not contain ABML entities", baselineRecovery({ path: savedPath }));
		return { entities: fromSaved, partialBaseline: false, networkSeq: networkSeqFromBaseline(baseline) ?? networkSeqFromBaseline(parsedSaved), hookSeq: hookSeqFromBaseline(baseline) ?? hookSeqFromBaseline(parsedSaved), snapshotId: baselineSnapshotId(baseline) };
	}
	const inline = baselineEntitiesFromParam(baseline);
	if (inline) return { entities: inline, partialBaseline: baselinePartialHint(baseline, inline), networkSeq: networkSeqFromBaseline(baseline), hookSeq: hookSeqFromBaseline(baseline), snapshotId: baselineSnapshotId(baseline) };
	const snapshotId = baselineSnapshotId(baseline);
	if (!snapshotId) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline must be an entity list, prior scan summary/envelope, or snapshotId", baselineRecovery({ baselineType: typeof baseline }));
	const snapshot = server.getObservationSnapshot(snapshotId);
	if (!snapshot || snapshot.expired) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot is unavailable or expired", baselineRecovery({ snapshotId, expired: snapshot?.expired, invalidatedReason: snapshot?.invalidatedReason }));
	if (!snapshot.saved?.path) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot has no saved artifact path", baselineRecovery({ snapshotId }));
	let parsed: unknown;
	try {
		parsed = parseJsonOrThrow(await readFile(snapshot.saved.path, "utf8"), "browser_observe baseline snapshot artifact");
	} catch (error) {
		throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot artifact could not be read as JSON", baselineRecovery({ snapshotId, path: snapshot.saved.path, error: error instanceof Error ? error.message : String(error) }));
	}
	const fromArtifact = baselineEntitiesFromParam(parsed);
	if (!fromArtifact) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot artifact does not contain ABML entities", baselineRecovery({ snapshotId, path: snapshot.saved.path }));
	return { entities: fromArtifact, partialBaseline: false, networkSeq: typeof snapshot.networkSeq === "number" ? snapshot.networkSeq : networkSeqFromBaseline(parsed), hookSeq: typeof snapshot.hookSeq === "number" ? snapshot.hookSeq : hookSeqFromBaseline(parsed), snapshotId };
}

function ledgerKey(browserSessionId: string | undefined, tabId: number | undefined, url: string | undefined): PerceptionLedgerKey | undefined {
	if (!url) return undefined;
	return { browserSessionId, tabId, navigationEpoch: url };
}

function granularityCeilingFromLedger(server: BrowserBridgeServer, key: PerceptionLedgerKey | undefined): Exclude<FactGranularity, "omit"> | undefined {
	if (!key || typeof server.getRecentPerceptionLedgerFrames !== "function") return undefined;
	const recent = server.getRecentPerceptionLedgerFrames(key, 3);
	const pressured = recent.filter((frame) => (frame.allocation?.budgetUsedRatio ?? 0) > 0.92).length;
	return pressured >= 2 ? "compact" : undefined;
}

function tabUrlForLedger(tabs: unknown[], tabId: number | undefined, fallbackTabId: number | undefined): string | undefined {
	const wanted = tabId ?? fallbackTabId;
	const tab = tabs.find((item) => isRecord(item) && Number(item.tabId ?? item.id) === wanted);
	return isRecord(tab) && typeof tab.url === "string" ? tab.url : undefined;
}

function sessionDeltaEnabled(params: ObserveToolParams): boolean {
	return process.env.PI_BROWSER_SESSION_DELTA !== "0" && String(params.detailLevel || "summary") !== "full" && params.baseline === undefined;
}

type RenderCache = NonNullable<PerceptionLedgerFrame["renderCache"]>;

function modeInferredDetails(params: ObserveToolParams): ObserveToolParams["modeInferred"] {
	return params.modeInferred ?? null;
}

function modeInferredSummary(params: ObserveToolParams): Record<string, unknown> {
	return params.modeInferred ? { modeInferred: params.modeInferred.mode } : {};
}

function scanCommandName(mode: Extract<ObserveMode, "scan" | "text">, hasNavigation: boolean): string {
	if (hasNavigation) return mode === "text" ? "navigate+text" : "navigate+scan";
	return mode === "text" ? "scan.text" : "scan";
}

function observeCacheTtlMs(): number {
	const raw = process.env.PI_BROWSER_OBSERVE_CACHE_TTL_MS;
	if (raw === undefined) return 2_000;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2_000;
}

function observeRenderParamsSignature(params: ObserveToolParams, mode: ObserveMode, detailLevel: string, maxChars: number, captureMaxChars: number): string {
	const maxNodes = Number(params.maxNodes);
	return JSON.stringify({
		mode,
		detailLevel,
		maxChars,
		captureMaxChars,
		includeIframes: params.includeIframes !== false,
		...(Number.isFinite(maxNodes) ? { maxNodes } : {}),
		...(observeIntent(params) ? { intent: observeIntent(params) } : {}),
		...(typeof params.actionRef === "string" && params.actionRef ? { actionRef: params.actionRef } : {}),
	});
}

function pageFingerprintMatches(a: PageFingerprint, b: PageFingerprint): boolean {
	return a.changeSeq === b.changeSeq
		&& (a.url ?? "") === (b.url ?? "")
		&& (a.title ?? "") === (b.title ?? "")
		&& (a.readyState ?? "") === (b.readyState ?? "")
		&& (a.visibleCount ?? -1) === (b.visibleCount ?? -1)
		&& (a.interactiveCount ?? -1) === (b.interactiveCount ?? -1);
}

function renderCacheMatches(frame: PerceptionLedgerFrame | undefined, mode: ObserveMode, detailLevel: string, maxChars: number, paramsSignature: string, fingerprint: PageFingerprint | undefined, now = Date.now(), ttlMs = observeCacheTtlMs()): frame is PerceptionLedgerFrame & { renderCache: RenderCache } {
	if (!frame?.pageFingerprint || !frame.renderCache || !fingerprint) return false;
	if (ttlMs <= 0 || typeof frame.renderCache.renderedAt !== "number" || now - frame.renderCache.renderedAt > ttlMs) return false;
	return pageFingerprintMatches(frame.pageFingerprint, fingerprint)
		&& frame.renderCache.mode === mode
		&& frame.renderCache.detailLevel === detailLevel
		&& frame.renderCache.maxChars === maxChars
		&& frame.renderCache.paramsSignature === paramsSignature;
}

function stripCachedObserveMeta(record: Record<string, unknown>): Record<string, unknown> {
	const { operation: _operation, snapshot: _snapshot, cache: _cache, fromCache: _fromCache, saved: _saved, ...rest } = record;
	return rest;
}

function cachedEnvelopeFromArtifact(value: unknown): Record<string, unknown> | undefined {
	const record = isRecord(value) ? value : undefined;
	if (!record) return undefined;
	if (isRecord(record.envelope)) return stripCachedObserveMeta(record.envelope as Record<string, unknown>);
	if (record.tool === "browser_observe") return stripCachedObserveMeta(record);
	return undefined;
}

function summarizeObserveTabsData(value: unknown): Record<string, unknown> {
	const record = isRecord(value) ? value : {};
	const tabs = Array.isArray(record.tabs) ? record.tabs : [];
	return {
		mode: "tabs",
		sourceMode: "scan",
		tabs_count: Number(record.tabs_count || tabs.length || 0),
		active_tab: record.active_tab,
		browserSessionId: record.browserSessionId,
		selectionVersion: record.selectionVersion,
		selectionVersionAtDispatch: record.selectionVersionAtDispatch,
		selectionVersionAtResolve: record.selectionVersionAtResolve,
		tabs: tabs.slice(0, 20).map((tab) => isRecord(tab)
			? {
				tabId: tab.tabId ?? tab.id,
				title: tab.title,
				url: tab.url,
				active: tab.active,
				browserId: tab.browserId,
			}
			: tab),
	};
}

export async function runScanObservation(server: BrowserBridgeServer, params: ObserveToolParams, ctx: ToolResultContext, mode: Extract<ObserveMode, "scan" | "text" | "tabs">, onUpdate?: ToolOnUpdate) {
	const tabs = await server.refreshTabs(5_000, { browserSessionId: params.browserSessionId }).catch(() => server.getTabs());
	const maxChars = toolMaxChars(params, "browser_observe");
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const tabId = normalizeTabId(params.tabId);
	const fallbackName = artifactFallbackName(mode === "tabs" ? "observe-tabs" : mode === "text" ? "observe-text" : "observe-scan");
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, fallbackName);
	const resultParams = { ...params, outputPath };
	if (mode === "tabs") {
		const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
		const tabsOnlyData = {
			tabs_count: tabs.length,
			tabs,
			active_tab: bridge.defaultTabId,
			browserSessionId: bridge.browserSessionId,
			selectionVersion: bridge.selectionVersion,
			selectionVersionAtDispatch: bridge.selectionVersion,
			selectionVersionAtResolve: bridge.selectionVersion,
		};
		const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, undefined);
		const trackedTabId = typeof tabId === "number" ? tabId : undefined;
		const { result: toolResult } = await withTrackedOperation(server, {
			toolName: "browser_observe",
			command: "scan.tabs",
			browserSessionId,
			tabId: trackedTabId,
			phase: "running",
			progress: 10,
			queueDepth: server.queueDepth(browserSessionId, trackedTabId),
			leaseOwnerHash: server.leaseOwnerHash(browserSessionId, trackedTabId),
			snapshotId: snapshotMeta.snapshotId,
			sourceMode: "scan",
		}, onUpdate, async (handle): Promise<import("../utils/toolResult.js").PiTextToolResult> => {
			await handle.update({ progress: 80, details: { tabs_count: tabs.length } });
			return await jsonToolResult(tabsOnlyData, resultParams, ctx, {
				toolName: "browser_observe",
				command: "scan.tabs",
				maxChars,
				fallbackName,
				details: { mode: "tabs", modeInferred: modeInferredDetails(params), sourceMode: "scan", sourceCommand: "tabs.list" },
				operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId },
				snapshot: snapshotMeta,
				distill: (value) => summarizeObserveTabsData(value),
				artifactValue: { ...tabsOnlyData, operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId }, snapshot: snapshotMeta },
			});
		});
		return toolResult;
	}
	const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const hasNavigation = typeof params.url === "string" && params.url.trim().length > 0;
	const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 100_000);
	const scanScript = buildScanScript({ textOnly: mode === "text", maxChars: captureMaxChars, maxNodes: params.maxNodes, includeIframes: params.includeIframes });
	const preBridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const plannedLedgerKey = hasNavigation ? undefined : ledgerKey(preBridge.browserSessionId, tabId, tabUrlForLedger(tabs, tabId, preBridge.defaultTabId));
	const ledgerFrame = !hasNavigation && sessionDeltaEnabled(params) && plannedLedgerKey && typeof server.getPerceptionLedgerFrame === "function" ? server.getPerceptionLedgerFrame(plannedLedgerKey) : undefined;
	const effectiveTabId = tabId ?? preBridge.defaultTabId;
	const detailLevel = String(params.detailLevel || "summary");
	const paramsSignature = observeRenderParamsSignature(params, mode, detailLevel, maxChars, captureMaxChars);
	const pageFingerprint = !hasNavigation && sessionDeltaEnabled(params) ? await readPageFingerprint(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs }) : undefined;
	if (renderCacheMatches(ledgerFrame, mode, detailLevel, maxChars, paramsSignature, pageFingerprint) && typeof server.getObservationSnapshot === "function") {
		const cacheFingerprint = pageFingerprint!;
		const priorSnapshot = server.getObservationSnapshot(ledgerFrame.snapshotId);
		const priorPath = priorSnapshot?.saved?.path;
		if (priorPath) {
			try {
				const cachedArtifact = parseJsonOrThrow(await readFile(priorPath, "utf8"), "browser_observe cached snapshot artifact");
				const cachedEnvelope = cachedEnvelopeFromArtifact(cachedArtifact);
				if (cachedEnvelope) {
					const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, cacheFingerprint.url);
					const { result: cachedResult } = await withTrackedOperation(server, {
						toolName: "browser_observe",
						command: mode === "text" ? "scan.text" : "scan",
						browserSessionId,
						tabId: effectiveTabId,
						phase: "running",
						progress: 10,
						queueDepth: server.queueDepth(browserSessionId, effectiveTabId),
						leaseOwnerHash: server.leaseOwnerHash(browserSessionId, effectiveTabId),
						snapshotId: snapshotMeta.snapshotId,
						sourceMode: "scan",
					}, onUpdate, async (handle): Promise<import("../utils/toolResult.js").PiTextToolResult> => {
						await handle.update({ progress: 100, details: { fromCache: true, changeSeq: cacheFingerprint.changeSeq } });
						const value = { ...cachedEnvelope, fromCache: true, cache: { reason: "content-fingerprint-unchanged", changeSeq: cacheFingerprint.changeSeq, priorSnapshotId: ledgerFrame.snapshotId } };
						return await jsonToolResult(value, resultParams, ctx, {
							toolName: "browser_observe",
							command: mode === "text" ? "scan.text" : "scan",
							maxChars,
							fallbackName,
							details: { mode, modeInferred: modeInferredDetails(params), sourceMode: "scan", sourceCommand: "content.fingerprint", fromCache: true, priorSnapshotId: ledgerFrame.snapshotId },
							operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId },
							snapshot: snapshotMeta,
							distill: () => ({ mode, sourceMode: "scan", fromCache: true, cache: value.cache, priorSnapshotId: ledgerFrame.snapshotId }),
							artifactValue: { ...value, operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId }, snapshot: snapshotMeta },
						});
					});
					if (plannedLedgerKey && typeof server.recordPerceptionLedgerFrame === "function") {
						server.recordPerceptionLedgerFrame({
							key: plannedLedgerKey,
							snapshotId: snapshotMeta.snapshotId,
							capturedAt: snapshotMeta.capturedAt,
							facts: ledgerFrame.facts,
							pageFingerprint: cacheFingerprint,
							renderCache: { mode, detailLevel, maxChars, paramsSignature, renderedAt: ledgerFrame.renderCache.renderedAt },
							allocation: ledgerFrame.allocation,
						});
					}
					return cachedResult;
				}
			} catch {
				// Cache misses must degrade to a normal observe; the fresh path repairs ledger state.
			}
		}
	}
	const granularityCeiling = granularityCeilingFromLedger(server, plannedLedgerKey);
	const effectiveBaseline: unknown = params.baseline ?? (!hasNavigation && ledgerFrame ? { snapshotId: ledgerFrame.snapshotId } : undefined);
	let baseline: BaselineResolution | undefined;
	try {
		baseline = await resolveBaselineEntities(server, effectiveBaseline);
	} catch (error) {
		if (!ledgerFrame || params.baseline !== undefined) throw error;
		baseline = undefined;
	}
	const abml = createBrowserAbmlIntegration(server, { browserSessionId, tabId, timeoutMs, maxChars: captureMaxChars });
	const { result: observation, operation } = await withTrackedOperation(server, {
		toolName: "browser_observe",
		command: scanCommandName(mode, hasNavigation),
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "scan",
	}, onUpdate, async (handle) => {
		let navigationData: unknown;
		if (hasNavigation) {
			await handle.update({ progress: 20, phase: "navigating" });
			const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url!, state: "complete", timeoutMs }, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs });
			assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
			navigationData = navigation.data;
		}
		await handle.update({ progress: hasNavigation ? 50 : 40 });
		const result = await evaluatePageScriptDirect(server, scanScript, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs, name: "scan_extract" });
		await handle.update({ progress: 70, details: { acknowledged: result.acknowledged, target: result.target } });
		const canReuseScanForAbml = mode !== "text" && params.includeIframes !== false && params.maxNodes === undefined && isRecord(result.data);
		const abmlRead = await abml.readStructure({
			browserSessionId,
			tabId,
			timeoutMs,
			maxChars: captureMaxChars,
			baseline: baseline?.entities,
			diffOptions: baseline?.partialBaseline ? { partialBaseline: true } : undefined,
			prefetchedScan: canReuseScanForAbml ? result.data as Record<string, unknown> : undefined,
			axCacheKey: pageFingerprint ? `content:${pageFingerprint.changeSeq}:${pageFingerprint.url || ""}` : undefined,
		});
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target, abml: abmlRead?.ok === true ? { entityCount: abmlRead.entities?.length ?? 0 } : { ok: false } } });
		return { result, abmlRead, navigationData };
	});
	const data = observation.result.data as Record<string, unknown> | undefined;
	const content = typeof data?.content === "string" ? data.content : JSON.stringify(data ?? observation.result.data, null, 2);
	const scanMeta = data ? { ...data, content: `[${content.length} chars]` } : undefined;
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	// ABML R3.x causal plane: capture this observation's network + hook seq high-water marks (so it can
	// anchor a future baseline) and, when a baseline was supplied, the network-delta + event-delta since it.
	const [recorderState, hookState] = await Promise.all([
		readNetworkRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs }),
		readHookRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs }),
	]);
	const hasBaseline = baseline !== undefined;
	let causal = hasBaseline
		? await buildObserveCausal(server, params, recorderState, baseline?.networkSeq, tabId, timeoutMs)
		: undefined;
	// P2: attach the hook event-delta to the (requests-variant) causal block when hooks are armed and the
	// baseline carries a hook seq. Best-effort — a failed event read never fails the observe.
	if (causal && "requests" in causal && hasBaseline && hookState.active && baseline?.hookSeq !== undefined) {
		try {
			const ev = buildCausalEvents(await queryHookDelta(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs, sinceSeq: baseline.hookSeq }), baseline.hookSeq);
			if (ev.events.length) causal = { ...causal, ...ev };
		} catch { /* event delta is additive; never fail the observe on it */ }
	}
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, typeof data?.url === "string" ? data.url : undefined, recorderState.lastSeq, hookState.lastSeq);
	const scanEntityContext = {
		browserSessionId: bridge.browserSessionId,
		tabId,
		url: typeof data?.url === "string" ? data.url : undefined,
		observationId: snapshotMeta.snapshotId,
		capturedAt: snapshotMeta.capturedAt,
	};
	const summaryData = data ? registerScanEntityRefs(data, scanEntityContext) : data;
	const scanEnvelopeEntities = summaryData ? scanEntitiesForEnvelope(summaryData, { entityContext: scanEntityContext }) : [];
	const pageUrl = typeof data?.url === "string" ? data.url : undefined;
	let artifactRelevance: Record<string, unknown> | undefined;
	const baseSummaryFor = (relevance?: ObserveRelevance): Record<string, unknown> => ({
		...withObservationMeta(summarizeScanData(summaryData, tabs, {
			detailLevel: params.detailLevel,
			maxChars,
			entityContext: scanEntityContext,
			relevance: relevance?.result,
		}), mode, "scan"),
		browserSessionId: bridge.browserSessionId,
		tabId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	});
	const abmlEntities = observation.abmlRead?.ok === true ? (observation.abmlRead.entities ?? []) : null;
	const abmlDiff: EntityDiff | undefined = observation.abmlRead?.ok === true ? observation.abmlRead.diff : undefined;
	const abmlDiffSummary = abmlDiff ? summarizeEntityDiff(abmlDiff, baseline?.entities, observation.abmlRead?.ok === true ? observation.abmlRead.entities ?? [] : []) : undefined;
	const envelopeDiff = abmlDiff ? { ...abmlDiff, ...(abmlDiffSummary ? { summary: abmlDiffSummary } : {}) } : undefined;
	const abmlTreeDiff: TreeDiff | undefined = observation.abmlRead?.ok === true && baseline
		? buildTreeDiff(baseline.entities, observation.abmlRead.entities ?? [], { partialBaseline: baseline.partialBaseline })
		: undefined;
	// R3.x causal attribution — attach `triggered` edges BEFORE the relation summary so they surface in
	// relations.summary + the controls' inline relations. Two sources, both additive (the delta stays
	// fully inline in envelope.causal regardless — passive P0 behavior preserved):
	//   P1  — the network-delta → the activated control (explicit `actionRef`, else the focus-normalized
	//         R3 `diff.focusedRef`; a frame/region focus is rejected). source:"timing", low confidence.
	//   P2-B — each event that names its own target element (DOM-sink `selector`) → that element.
	//         source:"event", medium confidence (stronger than timing — the event records its element).
	const attributedEntities = (() => {
		if (!abmlEntities || !causal || !("requests" in causal)) return abmlEntities;
		const actionEntityRef = causal.requests.length ? resolveActionEntityRef(params.actionRef, abmlDiff?.focusedRef, abmlEntities) : undefined;
		const requestTriggered = actionEntityRef ? buildTriggeredRelations(causal, { hasActionRef: !!params.actionRef }) : [];
		const eventTriggers = eventTriggeredByEntity("events" in causal && Array.isArray(causal.events) ? causal.events : [], abmlEntities);
		if (!actionEntityRef && eventTriggers.size === 0) return abmlEntities;
		return abmlEntities.map((entity) => {
			let next = entity;
			if (actionEntityRef && entity.ref === actionEntityRef) next = addEntityRelations(next, requestTriggered);
			const eventRels = eventTriggers.get(entity.ref);
			if (eventRels) next = addEntityRelations(next, eventRels);
			return next;
		});
	})();
	// Top-level `causal` block (budget-immune, lifted to envelope alongside diff/relations/inference).
	// Present only when a baseline was supplied; independent of ABML entity integration.
	const causalBlock = causal ? { causal } : {};
	const ledgerDeltaFields = ledgerFrame && baseline?.snapshotId ? { delta: "session", baselineSnapshotId: baseline.snapshotId } : {};
	const summary = attributedEntities !== null
		? (() => {
			const relSummary = buildRelationSummary(attributedEntities);
			const inference = buildInferenceSummary(attributedEntities, relSummary, abmlDiff);
			const relevance = buildObserveRelevance(server, params, bridge.browserSessionId, pageUrl, attributedEntities, inference);
			artifactRelevance = relevance?.artifact;
			const baseSummary = baseSummaryFor(relevance);
			const snapshotProjection = buildSnapshotProjection(attributedEntities, { treeDiff: abmlTreeDiff });
			const idGraph = buildIdentityGraph(attributedEntities, causal);
			const baseFocus = typeof baseSummary.focus === "object" && baseSummary.focus ? baseSummary.focus as Record<string, unknown> : {};
			const referencedEntities = mergeEntitiesByRef(
				entitiesForInferenceEvidence(attributedEntities, inference),
			).slice(0, 12);
			const primaryEntities = sortEntitiesBySalience(attributedEntities.filter((entity) => entity.kind !== "region"), relevance?.result).slice(0, 10);
			const listEntities = attributedEntities.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).slice(0, 5);
			const visualRegions = attributedEntities.filter((entity) => entity.kind === "region" && entity.source === "vision").slice(0, 4);
			const idSummary = identityGraphSummary(idGraph);
			return {
				...baseSummary,
				...ledgerDeltaFields,
				abmlIntegrated: true,
				...(envelopeDiff ? { diff: envelopeDiff } : {}),
				...(abmlTreeDiff ? { treeDiff: abmlTreeDiff } : {}),
				snapshotProjection,
				...causalBlock,
				...(idSummary.anchorCount || idSummary.triggeredCount ? { identity: idSummary } : {}),
				_identityGraph: idGraph,
				focus: {
					...baseFocus,
					entityShape: "refs-v1",
					gist: buildPageGist(attributedEntities),
					primary_entities: entityRefs(primaryEntities),
					outline: buildEntityOutline(attributedEntities),
					// R1 relationship graph — emitted ONLY when it carries real edges (triggered / table /
					// controls / labelledBy / ...). The always-present empty summary was unread token cost; the
					// in-memory relSummary still feeds inference + causal attribution regardless. (envelope.templates
					// and envelope.inference were removed as agent-facing fields — a real-agent eval showed them
					// unread; their ENGINES keep running internally: treeDiff/snapshotProjection use templating,
					// referenced_entities uses inference.)
					...(Object.keys(relSummary.summary).length || relSummary.highlights.length ? { relations: relSummary } : {}),
					// diff/treeDiff/snapshotProjection live ONLY at summary top-level (above) and are lifted to
					// envelope.* by responseEnvelope. Duplicating them here referenced the SAME object, so
					// redactSensitiveValue collapsed the second occurrence to "[Circular]" and doubled bytes
					// (blind-eval F2). The envelope lift reads summary top-level first, so focus needs neither.
					referenced_entities: entityRefs(referencedEntities, 12),
					list_entities: entityRefs(listEntities),
					visual_regions: entityRefs(visualRegions),
				},
			};
		})()
		: (() => {
			const relevance = buildObserveRelevance(server, params, bridge.browserSessionId, pageUrl, scanEnvelopeEntities);
			artifactRelevance = relevance?.artifact;
			return { ...baseSummaryFor(relevance), ...ledgerDeltaFields, abmlIntegrated: false, ...causalBlock };
		})();
	const summaryRecord = summary as Record<string, unknown>;
	Object.assign(summaryRecord, modeInferredSummary(params));
	const envelopeEntities = attributedEntities ?? scanEnvelopeEntities;
	// Narrow active capability hints — causal + treeDiff ONLY. A three-round real-agent eval (2026-06-05)
	// showed these two are valuable when used but agents never reach for them unprompted, and passive skill
	// docs did NOT move adoption (the new skill was loaded and still skipped 4/4). So push from the result:
	//   • upstream — on a plain scan, plant the baseline→treeDiff/causal path BEFORE the agent defaults to
	//     execute-before/after (the moment it actually decides how to detect change).
	//   • downstream — when a baseline scan actually produced causal requests or a template-level change,
	//     point straight at it.
	// NOT templates/relations: the eval showed they only give structure (agents still need JS for per-item
	// VALUES), so pushing them is marginal. Hints fire only when there's something real to point at → low noise.
	const scanHints: string[] = (() => {
		const hints: string[] = [];
		const sid = typeof snapshotMeta.snapshotId === "string" ? snapshotMeta.snapshotId : undefined;
		if (!hasBaseline && sid) {
			hints.push(`to see what CHANGES after you act here: re-run browser_observe mode=scan baseline:"${sid}" → envelope.treeDiff (template-level appeared/disappeared, cleaner than re-extracting before/after)${recorderState.active ? "; + envelope.causal.requests = which requests your action fired" : ""}`);
		}
		if (hasBaseline && causal) {
			// Use the TRUE fired count (requestCount), not the capped requests.length, or the hint
			// under-reports 30×+ when >12 requests fired since baseline (blind-eval R-G5 F2/G10).
			const firedHint = causalFiredHint(causal);
			if (firedHint) hints.push(firedHint);
		}
		if (hasBaseline && abmlTreeDiff && abmlTreeDiff.summary.changedTemplateCount > 0) {
			const s = abmlTreeDiff.summary;
			const eg = [
				...(s.sample?.appeared?.length ? [`+${s.sample.appeared.slice(0, 3).join(", ")}`] : []),
				...(s.sample?.disappeared?.length ? [`-${s.sample.disappeared.slice(0, 3).join(", ")}`] : []),
				...(s.sample?.changed?.length ? [`~${s.sample.changed.slice(0, 3).join(", ")}`] : []),
			].join("; ");
			hints.push(`structure changed (${s.appeared} appeared / ${s.disappeared} disappeared / ${s.changed} changed, template-level)${eg ? ` — e.g. ${eg}` : ""} → envelope.treeDiff.summary.sample names the items; .templates[].instances has the rest (no need to re-extract)`);
		}
		return hints;
	})();
	if (scanHints.length) summaryRecord.nextActions = scanHints;
	const artifactSnapshotProjection = isRecord(summaryRecord.snapshotProjection) ? summaryRecord.snapshotProjection : undefined;
	const artifactIdentityGraph = isRecord(summaryRecord._identityGraph) ? summaryRecord._identityGraph : undefined;
	// Mirror the ABML envelope products into the saved artifact's top-level `envelope` block so an agent
	// reading via browser_artifact finds them at a flat path (not buried in summary.focus). relations +
	// inference were previously only inside summary.focus — a real-agent eval (2026-06-05, task3) showed
	// agents hunting `data.relations`/`data.tables` and missing the buried table relations, while
	// top-level-mirrored causal/templates/diff were found and used. Lift them to match.
	const artifactFocus = isRecord(summaryRecord.focus) ? (summaryRecord.focus as Record<string, unknown>) : undefined;
	// relations is conditional (focus only carries it when it has edges); templates/inference are no longer
	// agent-facing output, so they are not mirrored. diff/treeDiff/snapshotProjection/causal stay.
	const artifactRelations = isRecord(artifactFocus?.relations) ? artifactFocus!.relations : undefined;
	const artifactEnvelopeMirror = {
		tool: "browser_observe",
		command: scanCommandName(mode, hasNavigation),
		summary,
		...(envelopeEntities.length ? { entities: envelopeEntities.slice(0, 12) } : {}),
		...(envelopeDiff ? { diff: envelopeDiff } : {}),
		...(abmlTreeDiff ? { treeDiff: abmlTreeDiff } : {}),
		...(artifactRelations ? { relations: artifactRelations } : {}),
		...(artifactSnapshotProjection ? { snapshotProjection: artifactSnapshotProjection } : {}),
		...(artifactIdentityGraph ? { identityGraph: artifactIdentityGraph } : {}),
		...(artifactRelevance ? { relevance: artifactRelevance } : {}),
		...causalBlock,
	};
	const finalLedgerKey = ledgerKey(bridge.browserSessionId, tabId, typeof data?.url === "string" ? data.url : undefined);
	let allocation: PerceptionLedgerFrame["allocation"] | undefined;
	const ledgerFacts = attributedEntities ? factsFromEntities(attributedEntities) : undefined;
	const ledgerFrameForRecord: PerceptionLedgerFrame | undefined = finalLedgerKey && ledgerFacts
		? { key: finalLedgerKey, snapshotId: snapshotMeta.snapshotId, capturedAt: snapshotMeta.capturedAt, facts: ledgerFacts }
		: undefined;
	const priorLedgerFrame = finalLedgerKey && typeof server.getRecentPerceptionLedgerFrames === "function" ? server.getRecentPerceptionLedgerFrames(finalLedgerKey, 1)[0] : undefined;
	const stableRefs = ledgerFrameForRecord ? stableRefsFromFrames(ledgerFrameForRecord, priorLedgerFrame) : undefined;
	const toolResult = await textToolResult(content, resultParams, ctx, {
		toolName: "browser_observe",
		command: scanCommandName(mode, hasNavigation),
		maxChars,
		fallbackName,
		summary,
		details: { mode, modeInferred: modeInferredDetails(params), sourceMode: "scan", sourceCommand: "scan_extract", ...(hasNavigation ? { navigation: observation.navigationData } : {}), tabs_count: tabs.length, tabs, active_tab: bridge.defaultTabId, browserSessionId: bridge.browserSessionId, scan: scanMeta, abml: observation.abmlRead?.ok === true ? { integrated: true, entityCount: observation.abmlRead.entities?.length ?? 0, primaryEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind !== "region" && entity.kind !== "frame").length ?? 0, listEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).length ?? 0, visualRegionCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.source === "vision").length ?? 0, frameEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "frame").length ?? 0 } : { integrated: false } },
		operation,
		snapshot: snapshotMeta,
		granularityCeiling,
		stableRefs,
		onAllocation: (value) => {
			allocation = value;
		},
		entities: envelopeEntities,
		artifactValue: { ...observation.result, ...(hasNavigation ? { navigation: observation.navigationData } : {}), tabs_count: tabs.length, tabs, active_tab: bridge.defaultTabId, browserSessionId: bridge.browserSessionId, operation, snapshot: snapshotMeta, envelope: artifactEnvelopeMirror, ...(envelopeDiff ? { diff: envelopeDiff } : {}), ...(abmlTreeDiff ? { treeDiff: abmlTreeDiff } : {}), ...(artifactRelations ? { relations: artifactRelations } : {}), ...(artifactSnapshotProjection ? { snapshotProjection: artifactSnapshotProjection } : {}), ...(artifactIdentityGraph ? { identityGraph: artifactIdentityGraph } : {}), ...(artifactRelevance ? { relevance: artifactRelevance } : {}), ...causalBlock, abml: observation.abmlRead?.ok === true ? { ...observation.abmlRead, diff: envelopeDiff, snapshotProjection: artifactSnapshotProjection } : observation.abmlRead },
	});
	if (ledgerFrameForRecord && typeof server.recordPerceptionLedgerFrame === "function") {
		server.recordPerceptionLedgerFrame({
			...ledgerFrameForRecord,
			...(pageFingerprint ? { pageFingerprint } : {}),
			renderCache: { mode, detailLevel, maxChars, paramsSignature, renderedAt: snapshotMeta.capturedAt },
			...(allocation ? { allocation } : {}),
		});
	}
	return toolResult;
}

export async function runContentObservation(server: BrowserBridgeServer, params: ObserveToolParams, ctx: ToolResultContext, onUpdate?: ToolOnUpdate) {
	const timeoutMs = normalizeContentTimeoutMs(params.timeoutMs);
	const maxChars = toolMaxChars(params, "browser_observe");
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const tabId = normalizeTabId(params.tabId);
	const fallbackName = artifactFallbackName("observe-content");
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, fallbackName);
	const resultParams = { ...params, outputPath };
	const { result, operation } = await withTrackedOperation(server, {
		toolName: "browser_observe",
		command: params.url ? "navigate+content" : "content",
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "content",
	}, onUpdate, async (handle) => {
		let navigationData: unknown;
		if (params.url) {
			await handle.update({ progress: 20, phase: "navigating" });
			const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url, state: "complete", timeoutMs }, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs });
			assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
			navigationData = navigation.data;
		}
		await handle.update({ progress: 55, phase: "extracting" });
		const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 120_000);
		const script = buildContentScript({ selector: params.selector, includeLinks: params.includeLinks, maxChars: captureMaxChars });
		const result = await evaluatePageScriptDirect(server, script, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs, name: "content_extract" });
		return { result, navigationData };
	});
	const data = result.result.data as Record<string, unknown> | undefined;
	if (data?.ok === false) {
		const code = normalizeNativeErrorCode(data.error_code, "CONTENT_EXTRACTION_FAILED");
		const message = typeof data.error === "string" ? data.error : "content extraction failed";
		const details = isRecord(data.details) ? data.details : {};
		throw new BrowserBridgeError(code, message, { command: "browser_observe", mode: "content", ...details });
	}
	const markdown = typeof data?.markdown === "string" ? data.markdown : "";
	const meta = data ? { ...data, markdown: `[${markdown.length} chars]` } : undefined;
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "content", outputPath, typeof data?.url === "string" ? data.url : params.url);
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const summary = {
		...withObservationMeta(summarizeContentData(data), "content", "content"),
		...modeInferredSummary(params),
		browserSessionId: bridge.browserSessionId,
		tabId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	};
	return await textToolResult(markdown, resultParams, ctx, {
		toolName: "browser_observe",
		command: params.url ? "navigate+content" : "content",
		maxChars,
		fallbackName,
		summary,
		details: { mode: "content", modeInferred: modeInferredDetails(params), sourceMode: "content", sourceCommand: "content_extract", url: params.url, selector: params.selector, navigation: result.navigationData, content: meta },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...result.result, navigation: result.navigationData, operation, snapshot: snapshotMeta },
	});
}

export function observeErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { command: "browser_observe", defaultMessage: "browser_observe failed", includeCommandInDetails: true });
}

export async function runHtmlObservation(server: BrowserBridgeServer, params: ObserveToolParams, ctx: ToolResultContext, onUpdate?: ToolOnUpdate) {
	const body = objectParam(params.params);
	if (params.selector !== undefined) body.selector = params.selector;
	if (params.htmlMode !== undefined) body.mode = params.htmlMode;
	const maxChars = toolMaxChars(params, "browser_observe");
	const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const tabId = normalizeTabId(targetTabId(params, body));
	const commandName = nativeCommandToolMetadata.browser_observe_html.command;
	const hasNavigation = typeof params.url === "string" && params.url.trim().length > 0;
	const observeCommandName = hasNavigation ? "navigate+html" : commandName;
	const textFallbackName = artifactFallbackName(nativeCommandToolMetadata.browser_observe_html.artifactPrefix);
	const resultFallbackName = artifactFallbackName(`${nativeCommandToolMetadata.browser_observe_html.artifactPrefix}-result`);
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, textFallbackName);
	const resultParams = { ...params, outputPath };
	const { result, operation } = await withTrackedOperation(server, {
		toolName: "browser_observe",
		command: observeCommandName,
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "html",
	}, onUpdate, async (handle) => {
		let navigationData: unknown;
		if (hasNavigation) {
			await handle.update({ progress: 20, phase: "navigating" });
			const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url!, state: "complete", timeoutMs }, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs });
			assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
			navigationData = navigation.data;
		}
		await handle.update({ progress: 45 });
		const result = await server.sendCommand({ ...body, cmd: commandName }, { browserSessionId: params.browserSessionId, tabId: targetTabId(params, body) as number | string | undefined, timeoutMs });
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
		return { result, navigationData };
	});
	const data = result.result.data as Record<string, unknown> | undefined;
	const html = typeof data?.html === "string" ? data.html : undefined;
	const resultMeta = data ? { ...result.result, data: { ...data, html: html === undefined ? undefined : `[${html.length} chars]` } } : result.result;
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "html", outputPath, typeof data?.url === "string" ? data.url : params.url);
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	if (html !== undefined) {
		const summary = {
			...withObservationMeta(summarizeHtmlSnapshot(html, data), "html", "html"),
			...modeInferredSummary(params),
			browserSessionId: bridge.browserSessionId,
			tabId,
			selectionVersion: bridge.selectionVersion,
			selectionVersionAtDispatch: bridge.selectionVersion,
			selectionVersionAtResolve: bridge.selectionVersion,
		};
		return await textToolResult(html, resultParams, ctx, {
			toolName: "browser_observe",
			command: observeCommandName,
			maxChars,
			fallbackName: textFallbackName,
			summary,
			details: { mode: "html", modeInferred: modeInferredDetails(params), sourceMode: "html", sourceCommand: commandName, command: commandName, navigation: result.navigationData, result: resultMeta },
			operation,
			snapshot: snapshotMeta,
			artifactValue: { ...result.result, navigation: result.navigationData, operation, snapshot: snapshotMeta },
		});
	}
	return await jsonToolResult(result.result, resultParams, ctx, {
		toolName: "browser_observe",
		command: observeCommandName,
		defaultDetailLevel: "preview",
		maxChars,
		fallbackName: resultFallbackName,
		details: { mode: "html", modeInferred: modeInferredDetails(params), sourceMode: "html", sourceCommand: commandName, command: commandName, navigation: result.navigationData },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...result.result, navigation: result.navigationData, operation, snapshot: snapshotMeta },
	});
}
