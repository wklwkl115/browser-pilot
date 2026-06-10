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
import { buildSnapshotProjection, type SnapshotProjection } from "../abml/snapshotProjection.js";
import { buildIdentityGraph, identityGraphSummary } from "../abml/identityGraph.js";
import { factsFromEntities, type PerceptionLedgerFrame, type PerceptionLedgerKey } from "../abml/perceptionLedger.js";
import { createBrowserAbmlIntegration } from "../abml/verbs/integration.js";
import { nativeCommandToolMetadata } from "../protocol/nativeActionMetadata.js";
import { normalizeNativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { buildScanScript } from "../scan/buildScanScript.js";
import { createCodedError } from "../utils/codedError.js";
import { parseJsonOrThrow } from "../utils/json.js";
import { isRecord, normalizeTabId } from "../utils/params.js";
import { resolveArtifactPath } from "./artifacts.js";
import { assertBridgeCommandSucceeded } from "./bridgeResultValidation.js";
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
	baseline?: unknown;
	actionRef?: string;
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

export function sortEntitiesBySalience(entities: Entity[]): Entity[] {
	return entities
		.map((entity, index) => ({ entity, index }))
		.sort((a, b) => entitySalienceRank(a.entity) - entitySalienceRank(b.entity) || a.index - b.index)
		.map((item) => item.entity);
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

// ABML R3.x causal plane — read the network recorder's current seq high-water mark (and whether a
// recorder is active) for the default network session on the observed tab. Best-effort: any failure
// degrades to "no recorder" so observe never fails because of the causal read. `network.status`
// returns the recorder summary (active + lastSeq) when running, or `{ active: false }` otherwise.
async function readNetworkRecorderSeq(server: BrowserBridgeServer, params: ObserveToolParams, tabId: number | undefined, timeoutMs: number): Promise<{ active: boolean; lastSeq?: number }> {
	try {
		const res = await server.sendCommand({ cmd: "network.status" }, { browserSessionId: params.browserSessionId, tabId, timeoutMs });
		const data = isRecord(res.data) ? res.data : {};
		if (data.active === false) return { active: false };
		return { active: true, lastSeq: typeof data.lastSeq === "number" ? data.lastSeq : undefined };
	} catch {
		return { active: false };
	}
}

// Query the network-delta window (entries with seq > sinceSeq) via the existing recorder command.
// Returns the raw record summaries; the pure-core buildCausalSummary shapes/redacts/caps them.
async function queryNetworkDelta(server: BrowserBridgeServer, params: ObserveToolParams, sinceSeq: number, tabId: number | undefined, timeoutMs: number): Promise<Array<Record<string, unknown>>> {
	const res = await server.sendCommand({ cmd: "network.list", sinceSeq, limit: 500 }, { browserSessionId: params.browserSessionId, tabId, timeoutMs });
	const data = isRecord(res.data) ? res.data : {};
	return Array.isArray(data.items) ? data.items.filter(isRecord) : [];
}

// Build the envelope `causal` block when a baseline is supplied. Passive (no control attribution):
// "requests fired since the baseline observation". Emits `unavailable` when no recorder is active
// or the baseline carries no seq high-water mark (e.g. a raw entity-list baseline).
async function buildObserveCausal(server: BrowserBridgeServer, params: ObserveToolParams, recorderState: { active: boolean }, baselineNetworkSeq: number | undefined, tabId: number | undefined, timeoutMs: number): Promise<CausalSummary> {
	if (!recorderState.active) return causalUnavailable("network recorder not active — start via browser_network start");
	if (baselineNetworkSeq === undefined) return causalUnavailable("baseline has no network seq high-water mark — capture a baseline observation after browser_network start");
	try {
		const items = await queryNetworkDelta(server, params, baselineNetworkSeq, tabId, timeoutMs);
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

// ABML R3.x P2 — read the hook event-buffer seq high-water mark (+ whether a hook session is armed)
// for the observed tab. Best-effort like the network read: `hook.status` returns `last_seq` only when
// a session is installed; its absence (no session / page injection failed) means hooks are inactive.
async function readHookRecorderSeq(server: BrowserBridgeServer, params: ObserveToolParams, tabId: number | undefined, timeoutMs: number): Promise<{ active: boolean; lastSeq?: number }> {
	try {
		const res = await server.sendCommand({ cmd: "hook.status" }, { browserSessionId: params.browserSessionId, tabId, timeoutMs });
		const data = isRecord(res.data) ? res.data : {};
		const lastSeq = typeof data.last_seq === "number" ? data.last_seq : undefined;
		return { active: lastSeq !== undefined, lastSeq };
	} catch {
		return { active: false };
	}
}

// Query the hook event-delta window (events with seq > sinceSeq) via the existing recorder command.
// Returns the raw HookEvent records; pure-core buildCausalEvents shapes/redacts/caps them.
async function queryHookDelta(server: BrowserBridgeServer, params: ObserveToolParams, sinceSeq: number, tabId: number | undefined, timeoutMs: number): Promise<Array<Record<string, unknown>>> {
	const res = await server.sendCommand({ cmd: "hook.collect", since_seq: sinceSeq, limit: 200 }, { browserSessionId: params.browserSessionId, tabId, timeoutMs });
	const data = isRecord(res.data) ? res.data : {};
	return Array.isArray(data.events) ? data.events.filter(isRecord) : [];
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

function tabUrlForLedger(tabs: unknown[], tabId: number | undefined, fallbackTabId: number | undefined): string | undefined {
	const wanted = tabId ?? fallbackTabId;
	const tab = tabs.find((item) => isRecord(item) && Number(item.tabId ?? item.id) === wanted);
	return isRecord(tab) && typeof tab.url === "string" ? tab.url : undefined;
}

function sessionDeltaEnabled(params: ObserveToolParams): boolean {
	return process.env.PI_BROWSER_SESSION_DELTA !== "0" && String(params.detailLevel || "summary") !== "full" && params.baseline === undefined;
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
				details: { mode: "tabs", sourceMode: "scan", sourceCommand: "tabs.list" },
				operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId },
				snapshot: snapshotMeta,
				distill: (value) => summarizeObserveTabsData(value),
				artifactValue: { ...tabsOnlyData, operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId }, snapshot: snapshotMeta },
			});
		});
		return toolResult;
	}
	const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 100_000);
	const scanScript = buildScanScript({ textOnly: mode === "text", maxChars: captureMaxChars, maxNodes: params.maxNodes, includeIframes: params.includeIframes });
	const preBridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const plannedLedgerKey = ledgerKey(preBridge.browserSessionId, tabId, tabUrlForLedger(tabs, tabId, preBridge.defaultTabId));
	const ledgerFrame = sessionDeltaEnabled(params) && plannedLedgerKey && typeof server.getPerceptionLedgerFrame === "function" ? server.getPerceptionLedgerFrame(plannedLedgerKey) : undefined;
	const effectiveBaseline: unknown = params.baseline ?? (ledgerFrame ? { snapshotId: ledgerFrame.snapshotId } : undefined);
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
		command: mode === "text" ? "scan.text" : "scan",
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "scan",
	}, onUpdate, async (handle) => {
		await handle.update({ progress: 40 });
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
		});
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target, abml: abmlRead?.ok === true ? { entityCount: abmlRead.entities?.length ?? 0 } : { ok: false } } });
		return { result, abmlRead };
	});
	const data = observation.result.data as Record<string, unknown> | undefined;
	const content = typeof data?.content === "string" ? data.content : JSON.stringify(data ?? observation.result.data, null, 2);
	const scanMeta = data ? { ...data, content: `[${content.length} chars]` } : undefined;
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	// ABML R3.x causal plane: capture this observation's network + hook seq high-water marks (so it can
	// anchor a future baseline) and, when a baseline was supplied, the network-delta + event-delta since it.
	const [recorderState, hookState] = await Promise.all([
		readNetworkRecorderSeq(server, params, tabId, timeoutMs),
		readHookRecorderSeq(server, params, tabId, timeoutMs),
	]);
	const hasBaseline = baseline !== undefined;
	let causal = hasBaseline
		? await buildObserveCausal(server, params, recorderState, baseline?.networkSeq, tabId, timeoutMs)
		: undefined;
	// P2: attach the hook event-delta to the (requests-variant) causal block when hooks are armed and the
	// baseline carries a hook seq. Best-effort — a failed event read never fails the observe.
	if (causal && "requests" in causal && hasBaseline && hookState.active && baseline?.hookSeq !== undefined) {
		try {
			const ev = buildCausalEvents(await queryHookDelta(server, params, baseline.hookSeq, tabId, timeoutMs), baseline.hookSeq);
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
	const baseSummary: Record<string, unknown> = {
		...withObservationMeta(summarizeScanData(summaryData, tabs, {
			detailLevel: params.detailLevel,
			maxChars,
			entityContext: scanEntityContext,
		}), mode, "scan"),
		browserSessionId: bridge.browserSessionId,
		tabId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	};
	const abmlEntities = observation.abmlRead?.ok === true ? (observation.abmlRead.entities ?? []) : null;
	const abmlDiff: EntityDiff | undefined = observation.abmlRead?.ok === true ? observation.abmlRead.diff : undefined;
	const abmlDiffSummary = abmlDiff ? summarizeEntityDiff(abmlDiff, baseline?.entities, observation.abmlRead?.ok === true ? observation.abmlRead.entities ?? [] : []) : undefined;
	const envelopeDiff = abmlDiff ? { ...abmlDiff, ...(abmlDiffSummary ? { summary: abmlDiffSummary } : {}) } : undefined;
	const abmlTreeDiff: TreeDiff | undefined = observation.abmlRead?.ok === true && baseline
		? buildTreeDiff(baseline.entities, observation.abmlRead.entities ?? [], { partialBaseline: baseline.partialBaseline })
		: undefined;
	const abmlSnapshotProjection: SnapshotProjection | undefined = observation.abmlRead?.ok === true
		? buildSnapshotProjection(observation.abmlRead.entities ?? [], { treeDiff: abmlTreeDiff })
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
			const snapshotProjection = buildSnapshotProjection(attributedEntities, { treeDiff: abmlTreeDiff });
			const idGraph = buildIdentityGraph(attributedEntities, causal);
			const baseFocus = typeof baseSummary.focus === "object" && baseSummary.focus ? baseSummary.focus as Record<string, unknown> : {};
			const referencedEntities = mergeEntitiesByRef(
				entitiesForInferenceEvidence(attributedEntities, inference),
			).slice(0, 12);
			const primaryEntities = sortEntitiesBySalience(attributedEntities.filter((entity) => entity.kind !== "region")).slice(0, 10);
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
		: { ...baseSummary, ...ledgerDeltaFields, abmlIntegrated: false, ...causalBlock };
	const summaryRecord = summary as Record<string, unknown>;
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
	const artifactSnapshotProjection = isRecord(summaryRecord.snapshotProjection) ? summaryRecord.snapshotProjection : abmlSnapshotProjection;
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
		command: mode === "text" ? "scan.text" : "scan",
		summary,
		...(envelopeEntities.length ? { entities: envelopeEntities.slice(0, 12) } : {}),
		...(envelopeDiff ? { diff: envelopeDiff } : {}),
		...(abmlTreeDiff ? { treeDiff: abmlTreeDiff } : {}),
		...(artifactRelations ? { relations: artifactRelations } : {}),
		...(artifactSnapshotProjection ? { snapshotProjection: artifactSnapshotProjection } : {}),
		...(artifactIdentityGraph ? { identityGraph: artifactIdentityGraph } : {}),
		...causalBlock,
	};
	const finalLedgerKey = ledgerKey(bridge.browserSessionId, tabId, typeof data?.url === "string" ? data.url : undefined);
	if (finalLedgerKey && attributedEntities && typeof server.recordPerceptionLedgerFrame === "function") {
		const frame: PerceptionLedgerFrame = { key: finalLedgerKey, snapshotId: snapshotMeta.snapshotId, capturedAt: snapshotMeta.capturedAt, facts: factsFromEntities(attributedEntities) };
		server.recordPerceptionLedgerFrame(frame);
	}
	return await textToolResult(content, resultParams, ctx, {
		toolName: "browser_observe",
		command: mode === "text" ? "scan.text" : "scan",
		maxChars,
		fallbackName,
		summary,
		details: { mode, sourceMode: "scan", sourceCommand: "scan_extract", tabs_count: tabs.length, tabs, active_tab: bridge.defaultTabId, browserSessionId: bridge.browserSessionId, scan: scanMeta, abml: observation.abmlRead?.ok === true ? { integrated: true, entityCount: observation.abmlRead.entities?.length ?? 0, primaryEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind !== "region" && entity.kind !== "frame").length ?? 0, listEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).length ?? 0, visualRegionCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.source === "vision").length ?? 0, frameEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "frame").length ?? 0 } : { integrated: false } },
		operation,
		snapshot: snapshotMeta,
		entities: envelopeEntities,
		artifactValue: { ...observation.result, tabs_count: tabs.length, tabs, active_tab: bridge.defaultTabId, browserSessionId: bridge.browserSessionId, operation, snapshot: snapshotMeta, envelope: artifactEnvelopeMirror, ...(envelopeDiff ? { diff: envelopeDiff } : {}), ...(abmlTreeDiff ? { treeDiff: abmlTreeDiff } : {}), ...(artifactRelations ? { relations: artifactRelations } : {}), ...(artifactSnapshotProjection ? { snapshotProjection: artifactSnapshotProjection } : {}), ...(artifactIdentityGraph ? { identityGraph: artifactIdentityGraph } : {}), ...causalBlock, abml: observation.abmlRead?.ok === true ? { ...observation.abmlRead, diff: envelopeDiff, snapshotProjection: artifactSnapshotProjection } : observation.abmlRead },
	});
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
		details: { mode: "content", sourceMode: "content", sourceCommand: "content_extract", url: params.url, selector: params.selector, navigation: result.navigationData, content: meta },
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
	const textFallbackName = artifactFallbackName(nativeCommandToolMetadata.browser_observe_html.artifactPrefix);
	const resultFallbackName = artifactFallbackName(`${nativeCommandToolMetadata.browser_observe_html.artifactPrefix}-result`);
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, textFallbackName);
	const resultParams = { ...params, outputPath };
	const { result, operation } = await withTrackedOperation(server, {
		toolName: "browser_observe",
		command: commandName,
		browserSessionId,
		tabId,
		phase: "running",
		progress: 10,
		queueDepth: server.queueDepth(browserSessionId, tabId),
		leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
		sourceMode: "html",
	}, onUpdate, async (handle) => {
		await handle.update({ progress: 45 });
		const result = await server.sendCommand({ ...body, cmd: commandName }, { browserSessionId: params.browserSessionId, tabId: targetTabId(params, body) as number | string | undefined, timeoutMs });
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
		return result;
	});
	const data = result.data as Record<string, unknown> | undefined;
	const html = typeof data?.html === "string" ? data.html : undefined;
	const resultMeta = data ? { ...result, data: { ...data, html: html === undefined ? undefined : `[${html.length} chars]` } } : result;
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "html", outputPath, typeof data?.url === "string" ? data.url : undefined);
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	if (html !== undefined) {
		const summary = {
			...withObservationMeta(summarizeHtmlSnapshot(html, data), "html", "html"),
			browserSessionId: bridge.browserSessionId,
			tabId,
			selectionVersion: bridge.selectionVersion,
			selectionVersionAtDispatch: bridge.selectionVersion,
			selectionVersionAtResolve: bridge.selectionVersion,
		};
		return await textToolResult(html, resultParams, ctx, {
			toolName: "browser_observe",
			command: commandName,
			maxChars,
			fallbackName: textFallbackName,
			summary,
			details: { mode: "html", sourceMode: "html", sourceCommand: commandName, command: commandName, result: resultMeta },
			operation,
			snapshot: snapshotMeta,
			artifactValue: { ...result, operation, snapshot: snapshotMeta },
		});
	}
	return await jsonToolResult(result, resultParams, ctx, {
		toolName: "browser_observe",
		command: commandName,
		defaultDetailLevel: "preview",
		maxChars,
		fallbackName: resultFallbackName,
		details: { mode: "html", sourceMode: "html", sourceCommand: commandName, command: commandName },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...result, operation, snapshot: snapshotMeta },
	});
}
