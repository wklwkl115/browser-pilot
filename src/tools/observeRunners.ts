import { readFile } from "node:fs/promises";
import { buildContentScript } from "../content/buildContentScript.js";
import { BrowserBridgeError } from "../driver/errors.js";
import { executeBrowserWaitWithSupervisor } from "../driver/BrowserWaitSupervisor.js";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import type { Entity } from "../abml/entity.js";
import type { EntityDiff } from "../abml/diff.js";
import { buildRelationSummary } from "../abml/relations.js";
import { buildInferenceSummary } from "../abml/inference.js";
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
import { summarizeContentData, summarizeHtmlSnapshot, summarizeScanData } from "./summaries/index.js";
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

function currentObserveSnapshotMeta(server: BrowserBridgeServer, params: ObserveToolParams, sourceMode: "scan" | "content" | "html", savedPath: string | undefined, url: string | undefined) {
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	return server.createObservationSnapshot({
		browserSessionId: bridge.browserSessionId,
		tabId: normalizeTabId(params.tabId) ?? bridge.defaultTabId,
		url,
		frameScope: "tab",
		selectionVersion: bridge.selectionVersion,
		sourceMode,
		capturedAt: Date.now(),
		saved: savedPath ? { path: savedPath } : undefined,
	});
}

function entityArrayFromUnknown(value: unknown): Entity[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entities = value.filter((item): item is Entity => isRecord(item) && typeof item.ref === "string" && isRecord(item.state));
	return entities.length ? entities : undefined;
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

type BaselineResolution = { entities: Entity[]; partialBaseline: boolean };

function baselinePartialHint(value: unknown, entities: Entity[]): boolean {
	if (Array.isArray(value)) return entities.length < 10;
	if (!isRecord(value)) return false;
	if (value.partialBaseline === true || value.partial === true) return true;
	const diffOptions = isRecord(value.diffOptions) ? value.diffOptions : undefined;
	if (diffOptions?.partialBaseline === true) return true;
	if (["primary_entities", "list_entities", "visual_regions", "referenced_entities"].some((key) => Array.isArray(value[key]))) return true;
	const focus = isRecord(value.focus) ? value.focus : undefined;
	return !!focus && ["primary_entities", "list_entities", "visual_regions", "referenced_entities"].some((key) => Array.isArray(focus[key]));
}

async function resolveBaselineEntities(server: BrowserBridgeServer, baseline: unknown): Promise<BaselineResolution | undefined> {
	if (baseline === undefined || baseline === null) return undefined;
	const inline = baselineEntitiesFromParam(baseline);
	if (inline) return { entities: inline, partialBaseline: baselinePartialHint(baseline, inline) };
	const snapshotId = baselineSnapshotId(baseline);
	if (!snapshotId) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline must be an entity list, prior scan summary/envelope, or snapshotId", { baselineType: typeof baseline });
	const snapshot = server.getObservationSnapshot(snapshotId);
	if (!snapshot || snapshot.expired) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot is unavailable or expired", { snapshotId, expired: snapshot?.expired, invalidatedReason: snapshot?.invalidatedReason });
	if (!snapshot.saved?.path) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot has no saved artifact path", { snapshotId });
	let parsed: unknown;
	try {
		parsed = parseJsonOrThrow(await readFile(snapshot.saved.path, "utf8"), "browser_observe baseline snapshot artifact");
	} catch (error) {
		throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot artifact could not be read as JSON", { snapshotId, path: snapshot.saved.path, error: error instanceof Error ? error.message : String(error) });
	}
	const fromArtifact = baselineEntitiesFromParam(parsed);
	if (!fromArtifact) throw new BrowserBridgeError("INVALID_RULE", "browser_observe baseline snapshot artifact does not contain ABML entities", { snapshotId, path: snapshot.saved.path });
	return { entities: fromArtifact, partialBaseline: false };
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
		const { result: toolResult, operation } = await withTrackedOperation(server, {
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
				operation: { ...operation, snapshotId: snapshotMeta.snapshotId },
				snapshot: snapshotMeta,
				distill: (value) => summarizeObserveTabsData(value),
				artifactValue: { ...tabsOnlyData, operation: { ...operation, snapshotId: snapshotMeta.snapshotId }, snapshot: snapshotMeta },
			});
		});
		return toolResult;
	}
	const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 100_000);
	const scanScript = buildScanScript({ textOnly: mode === "text", maxChars: captureMaxChars, maxNodes: params.maxNodes, includeIframes: params.includeIframes });
	const baseline = await resolveBaselineEntities(server, params.baseline);
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
		const abmlRead = await abml.readStructure({ browserSessionId, tabId, timeoutMs, maxChars: captureMaxChars, baseline: baseline?.entities, diffOptions: baseline?.partialBaseline ? { partialBaseline: true } : undefined });
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target, abml: abmlRead?.ok === true ? { entityCount: abmlRead.entities?.length ?? 0 } : { ok: false } } });
		return { result, abmlRead };
	});
	const data = observation.result.data as Record<string, unknown> | undefined;
	const content = typeof data?.content === "string" ? data.content : JSON.stringify(data ?? observation.result.data, null, 2);
	const scanMeta = data ? { ...data, content: `[${content.length} chars]` } : undefined;
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, typeof data?.url === "string" ? data.url : undefined);
	const baseSummary: Record<string, unknown> = {
		...withObservationMeta(summarizeScanData(data, tabs, {
			detailLevel: params.detailLevel,
			maxChars,
			entityContext: {
				browserSessionId: bridge.browserSessionId,
				tabId,
				url: typeof data?.url === "string" ? data.url : undefined,
				observationId: snapshotMeta.snapshotId,
				capturedAt: snapshotMeta.capturedAt,
			},
		}), mode, "scan"),
		browserSessionId: bridge.browserSessionId,
		tabId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	};
	const abmlEntities = observation.abmlRead?.ok === true ? (observation.abmlRead.entities ?? []) : null;
	const abmlDiff: EntityDiff | undefined = observation.abmlRead?.ok === true ? observation.abmlRead.diff : undefined;
	const summary = abmlEntities !== null
		? (() => {
			const relSummary = buildRelationSummary(abmlEntities);
			return {
				...baseSummary,
				abmlIntegrated: true,
				...(abmlDiff ? { diff: abmlDiff } : {}),
				focus: {
					...(typeof baseSummary.focus === "object" && baseSummary.focus ? baseSummary.focus : {}),
					gist: buildPageGist(abmlEntities),
					primary_entities: sortEntitiesBySalience(abmlEntities.filter((entity) => entity.kind !== "region")).slice(0, 10),
					outline: buildEntityOutline(abmlEntities),
					// R1 relationship graph — always present when ABML is integrated (even when empty), so
					// agents can rely on it surviving the summary-budget squeeze (lifted to envelope top-level).
					relations: relSummary,
					// R2 inference layer — generic ARIA semantic patterns detected over the entity list +
					// relation graph. Budget-immune (lifted to envelope top-level alongside relations).
					inference: buildInferenceSummary(abmlEntities, relSummary, abmlDiff),
					...(abmlDiff ? { diff: abmlDiff } : {}),
					list_entities: abmlEntities.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).slice(0, 5),
					visual_regions: abmlEntities.filter((entity) => entity.kind === "region" && entity.source === "vision").slice(0, 4),
				},
			};
		})()
		: { ...baseSummary, abmlIntegrated: false };
	return await textToolResult(content, resultParams, ctx, {
		toolName: "browser_observe",
		command: mode === "text" ? "scan.text" : "scan",
		maxChars,
		fallbackName,
		summary,
		details: { mode, sourceMode: "scan", sourceCommand: "scan_extract", tabs_count: tabs.length, tabs, active_tab: bridge.defaultTabId, browserSessionId: bridge.browserSessionId, scan: scanMeta, abml: observation.abmlRead?.ok === true ? { integrated: true, entityCount: observation.abmlRead.entities?.length ?? 0, primaryEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind !== "region" && entity.kind !== "frame").length ?? 0, listEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).length ?? 0, visualRegionCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.source === "vision").length ?? 0, frameEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "frame").length ?? 0 } : { integrated: false } },
		operation,
		snapshot: snapshotMeta,
		artifactValue: { ...observation.result, tabs_count: tabs.length, tabs, active_tab: bridge.defaultTabId, browserSessionId: bridge.browserSessionId, operation, snapshot: snapshotMeta, abml: observation.abmlRead },
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
