import { readFile } from "node:fs/promises";
import { executeBrowserWaitWithSupervisor } from "../../driver/BrowserWaitSupervisor.js";
import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { summarizeEntityDiff, type EntityDiff } from "../../abml/diff.js";
import { buildRelationSummary, addEntityRelations } from "../../abml/relations.js";
import { buildInferenceSummary, entitiesForInferenceEvidence } from "../../abml/inference.js";
import { buildCausalSummary, causalUnavailable, buildTriggeredRelations, resolveActionEntityRef, buildCausalEvents, eventTriggeredByEntity, causalFiredHint, type CausalSummary } from "../../abml/causal.js";
import { buildTreeDiff, type TreeDiff } from "../../abml/treeDiff.js";
import { buildSnapshotProjection } from "../../abml/snapshotProjection.js";
import { buildIdentityGraph, identityGraphSummary } from "../../abml/identityGraph.js";
import { factsFromEntities, stableRefsFromFrames, type PerceptionLedgerFrame, type PerceptionLedgerKey } from "../../abml/perceptionLedger.js";
import type { FactGranularity } from "../../distill-core/fact.js";
import { createBrowserAbmlIntegration } from "../../abml/verbs/integration.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { parseJsonOrThrow } from "../../utils/json.js";
import { isRecord } from "../../utils/params.js";
import { resolveArtifactPath } from "../artifacts.js";
import { assertBridgeCommandSucceeded } from "../bridgeResultValidation.js";
import { normalizePageFingerprint, queryHookDelta, queryNetworkDelta, readHookRecorderSeq, readNetworkRecorderSeq, readPageFingerprint } from "../pageSignals.js";
import { evaluatePageScriptDirect } from "../pageScriptEvaluation.js";
import { registerScanEntityRefs } from "../scanEntityRefs.js";
import { buildScanEntities, scanEntitiesFromGroups, summarizeScanData } from "../summaries/index.js";
import { artifactFallbackName, bridgeNestedErrorResult, jsonToolResult, resolveLocalTargetTabId, targetTabId, textToolResult, toolMaxChars, toolTimeoutMs, withTrackedOperation, type ToolOnUpdate, type ToolResultContext } from "../toolAdapter.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../toolShared.js";
import { buildEntityOutline, buildPageGist, sortEntitiesBySalience } from "./entityViews.js";
import { cachedEnvelopeFromArtifact, modeInferredDetails, modeInferredSummary, observeRenderParamsSignature, renderCacheMatches, scanCommandName, sessionDeltaEnabled } from "./renderCache.js";
import { entityRefs, mergeEntitiesByRef, resolveBaselineEntities, type BaselineResolution } from "./baseline.js";
import { buildMemoryAugmentationPlan, consumeMemoryProfileDiagnostics, memoryWarmStartTerms, recordMemoryProfileFrame } from "./memoryAugmentation.js";
import { buildObserveRelevance, observeIntent, relevanceEnabled, type ObserveRelevance } from "./relevanceFusion.js";
import { addBridgeRoundTrips, elapsedMs, finalizedObserveTimings, type ObserveTimingMetrics } from "./timings.js";
import { currentObserveSnapshotMeta, withObservationMeta, type ObserveMode, type ObserveToolParams } from "./common.js";

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

function scanResultFingerprint(value: unknown) {
	const record = isRecord(value) ? value : {};
	const signals = isRecord(record.signals) ? record.signals : {};
	return normalizePageFingerprint(signals.fingerprint);
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
	const observeTimings: ObserveTimingMetrics = {};
	const tabRefreshStartedAt = Date.now();
	const tabs = await server.refreshTabs(5_000, { browserSessionId: params.browserSessionId }).catch(() => server.getTabs());
	observeTimings.tabRefreshMs = elapsedMs(tabRefreshStartedAt);
	const maxChars = toolMaxChars(params, "browser_observe");
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const rawTargetRef = targetTabId(params);
	const tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
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
		}, onUpdate, async (handle): Promise<import("../../utils/toolResult.js").PiTextToolResult> => {
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
	let pageFingerprint = undefined as ReturnType<typeof normalizePageFingerprint>;
	if (!hasNavigation && sessionDeltaEnabled(params)) {
		const fingerprintStartedAt = Date.now();
		pageFingerprint = await readPageFingerprint(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs });
		observeTimings.fingerprintMs = elapsedMs(fingerprintStartedAt);
		addBridgeRoundTrips(observeTimings, 1);
	}
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
					}, onUpdate, async (handle): Promise<import("../../utils/toolResult.js").PiTextToolResult> => {
						await handle.update({ progress: 100, details: { fromCache: true, changeSeq: cacheFingerprint.changeSeq } });
						const value = { ...cachedEnvelope, fromCache: true, cache: { reason: "content-fingerprint-unchanged", changeSeq: cacheFingerprint.changeSeq, priorSnapshotId: ledgerFrame.snapshotId } };
						const memoryProfileWarnings = consumeMemoryProfileDiagnostics(ctx?.cwd);
						return await jsonToolResult(value, resultParams, ctx, {
							toolName: "browser_observe",
							command: mode === "text" ? "scan.text" : "scan",
							maxChars,
							fallbackName,
							details: { mode, modeInferred: modeInferredDetails(params), sourceMode: "scan", sourceCommand: "content.fingerprint", fromCache: true, priorSnapshotId: ledgerFrame.snapshotId, ...(memoryProfileWarnings.length ? { memory: { warnings: memoryProfileWarnings } } : {}) },
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
	let fusedPageFingerprint = undefined as ReturnType<typeof normalizePageFingerprint>;
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
			const navigationStartedAt = Date.now();
			const navigation = await executeBrowserWaitWithSupervisor(server, { cmd: "wait.navigateAndWait", url: params.url!, state: "complete", timeoutMs }, { browserSessionId: params.browserSessionId, tabId: rawTargetRef as number | string | undefined, timeoutMs });
			observeTimings.navigationMs = elapsedMs(navigationStartedAt);
			addBridgeRoundTrips(observeTimings, 1);
			assertBridgeCommandSucceeded(navigation, "wait.navigateAndWait");
			navigationData = navigation.data;
		}
		await handle.update({ progress: hasNavigation ? 50 : 40 });
		const pageScriptStartedAt = Date.now();
		const result = await evaluatePageScriptDirect(server, scanScript, { browserSessionId: params.browserSessionId, tabId: rawTargetRef, timeoutMs, name: "scan_extract" });
		observeTimings.pageScriptMs = elapsedMs(pageScriptStartedAt);
		addBridgeRoundTrips(observeTimings, 1);
		fusedPageFingerprint = scanResultFingerprint(result.data);
		if (fusedPageFingerprint) observeTimings.fusedFingerprint = true;
		await handle.update({ progress: 70, details: { acknowledged: result.acknowledged, target: result.target } });
		const canReuseScanForAbml = mode !== "text" && params.includeIframes !== false && params.maxNodes === undefined && isRecord(result.data);
		observeTimings.abmlPrefetchedScan = canReuseScanForAbml;
		const abmlStartedAt = Date.now();
		const abmlRead = await abml.readStructure({
			browserSessionId,
			tabId,
			timeoutMs,
			maxChars: captureMaxChars,
			baseline: baseline?.entities,
			diffOptions: baseline?.partialBaseline ? { partialBaseline: true } : undefined,
			prefetchedScan: canReuseScanForAbml ? result.data as Record<string, unknown> : undefined,
			axCacheKey: (pageFingerprint ?? fusedPageFingerprint) ? `content:${(pageFingerprint ?? fusedPageFingerprint)!.changeSeq}:${(pageFingerprint ?? fusedPageFingerprint)!.url || ""}` : undefined,
		});
		observeTimings.abmlMs = elapsedMs(abmlStartedAt);
		if (!canReuseScanForAbml) addBridgeRoundTrips(observeTimings, 1);
		await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target, abml: abmlRead?.ok === true ? { entityCount: abmlRead.entities?.length ?? 0 } : { ok: false } } });
		return { result, abmlRead, navigationData };
	});
	const data = observation.result.data as Record<string, unknown> | undefined;
	const scanPageFingerprint = fusedPageFingerprint ?? scanResultFingerprint(data);
	const effectivePageFingerprint = pageFingerprint ?? scanPageFingerprint;
	const content = typeof data?.content === "string" ? data.content : JSON.stringify(data ?? observation.result.data, null, 2);
	const scanMeta = data ? { ...data, content: `[${content.length} chars]` } : undefined;
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	// ABML R3.x causal plane: capture this observation's network + hook seq high-water marks (so it can
	// anchor a future baseline) and, when a baseline was supplied, the network-delta + event-delta since it.
	const recorderStartedAt = Date.now();
	const [recorderState, hookState] = await Promise.all([
		readNetworkRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs }),
		readHookRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs }),
	]);
	observeTimings.recorderMs = elapsedMs(recorderStartedAt);
	addBridgeRoundTrips(observeTimings, 2);
	const hasBaseline = baseline !== undefined;
	let causal: CausalSummary | undefined;
	if (hasBaseline) {
		const causalStartedAt = Date.now();
		causal = await buildObserveCausal(server, params, recorderState, baseline?.networkSeq, tabId, timeoutMs);
		observeTimings.causalMs = elapsedMs(causalStartedAt);
		addBridgeRoundTrips(observeTimings, 1);
	}
	// P2: attach the hook event-delta to the (requests-variant) causal block when hooks are armed and the
	// baseline carries a hook seq. Best-effort — a failed event read never fails the observe.
	if (causal && "requests" in causal && hasBaseline && hookState.active && baseline?.hookSeq !== undefined) {
		try {
			const eventStartedAt = Date.now();
			const ev = buildCausalEvents(await queryHookDelta(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs, sinceSeq: baseline.hookSeq }), baseline.hookSeq);
			observeTimings.eventCausalMs = elapsedMs(eventStartedAt);
			addBridgeRoundTrips(observeTimings, 1);
			if (ev.events.length) causal = { ...causal, ...ev };
		} catch { /* event delta is additive; never fail the observe on it */ }
	}
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, typeof data?.url === "string" ? data.url : undefined, recorderState.lastSeq, hookState.lastSeq);
	const renderStartedAt = Date.now();
	const scanEntityContext = {
		browserSessionId: bridge.browserSessionId,
		tabId,
		url: typeof data?.url === "string" ? data.url : undefined,
		observationId: snapshotMeta.snapshotId,
		capturedAt: snapshotMeta.capturedAt,
	};
	const summaryData = data ? registerScanEntityRefs(data, scanEntityContext) : data;
	const summaryScanEntities = summaryData && isRecord(summaryData) ? buildScanEntities(summaryData, { entityContext: scanEntityContext }) : undefined;
	const scanEnvelopeEntities = summaryScanEntities ? scanEntitiesFromGroups(summaryScanEntities) : [];
	const pageUrl = typeof data?.url === "string" ? data.url : undefined;
	const currentTrace = typeof server.perceptionTraceSnapshot === "function" ? server.perceptionTraceSnapshot(bridge.browserSessionId) : undefined;
	const memoryTerms = relevanceEnabled(params) ? await memoryWarmStartTerms(ctx?.cwd, pageUrl, currentTrace) : [];
	const memoryAugmentationPlan = String(params.detailLevel || "summary") === "full" ? undefined : await buildMemoryAugmentationPlan(ctx?.cwd, pageUrl, observeIntent(params));
	let artifactRelevance: Record<string, unknown> | undefined;
	const baseSummaryFor = (relevance?: ObserveRelevance): Record<string, unknown> => ({
		...withObservationMeta(summarizeScanData(summaryData, tabs, {
			detailLevel: params.detailLevel,
			maxChars,
			entityContext: scanEntityContext,
			scanEntities: summaryScanEntities,
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
			const relevance = buildObserveRelevance(server, params, bridge.browserSessionId, pageUrl, attributedEntities, inference, memoryTerms);
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
			const relevance = buildObserveRelevance(server, params, bridge.browserSessionId, pageUrl, scanEnvelopeEntities, undefined, memoryTerms);
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
	const memoryProfileWarnings = consumeMemoryProfileDiagnostics(ctx?.cwd);
	observeTimings.renderMs = elapsedMs(renderStartedAt);
	const observeDiagnostics = { observeTimings: finalizedObserveTimings(observeTimings, data, observation.abmlRead) };
	const abmlDetails = observation.abmlRead?.ok === true
		? {
			integrated: true,
			entityCount: observation.abmlRead.entities?.length ?? 0,
			primaryEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind !== "region" && entity.kind !== "frame").length ?? 0,
			listEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.hints?.listContainer === true).length ?? 0,
			visualRegionCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "region" && entity.source === "vision").length ?? 0,
			frameEntityCount: observation.abmlRead.entities?.filter((entity) => entity.kind === "frame").length ?? 0,
			diagnostics: observeDiagnostics.observeTimings,
		}
		: { integrated: false, diagnostics: observeDiagnostics.observeTimings };
	const resultDetails = {
		mode,
		modeInferred: modeInferredDetails(params),
		sourceMode: "scan",
		sourceCommand: "scan_extract",
		...(hasNavigation ? { navigation: observation.navigationData } : {}),
		tabs_count: tabs.length,
		tabs,
		active_tab: bridge.defaultTabId,
		browserSessionId: bridge.browserSessionId,
		scan: scanMeta,
		abml: abmlDetails,
		...(scanPageFingerprint ? { signals: { fingerprint: scanPageFingerprint } } : {}),
		diagnostics: observeDiagnostics,
		...(memoryProfileWarnings.length ? { memory: { warnings: memoryProfileWarnings } } : {}),
	};
	const artifactValue = {
		...observation.result,
		...(hasNavigation ? { navigation: observation.navigationData } : {}),
		tabs_count: tabs.length,
		tabs,
		active_tab: bridge.defaultTabId,
		browserSessionId: bridge.browserSessionId,
		operation,
		snapshot: snapshotMeta,
		envelope: artifactEnvelopeMirror,
		...(envelopeDiff ? { diff: envelopeDiff } : {}),
		...(abmlTreeDiff ? { treeDiff: abmlTreeDiff } : {}),
		...(artifactRelations ? { relations: artifactRelations } : {}),
		...(artifactSnapshotProjection ? { snapshotProjection: artifactSnapshotProjection } : {}),
		...(artifactIdentityGraph ? { identityGraph: artifactIdentityGraph } : {}),
		...(artifactRelevance ? { relevance: artifactRelevance } : {}),
		...causalBlock,
		abml: observation.abmlRead?.ok === true ? { ...observation.abmlRead, diff: envelopeDiff, snapshotProjection: artifactSnapshotProjection } : observation.abmlRead,
	};
	const toolResult = await textToolResult(content, resultParams, ctx, {
		toolName: "browser_observe",
		command: scanCommandName(mode, hasNavigation),
		maxChars,
		fallbackName,
		summary,
		details: resultDetails,
		operation,
		snapshot: snapshotMeta,
		granularityCeiling,
		stableRefs,
		memoryAugmentationPlan,
		onAllocation: (value) => {
			allocation = value;
		},
		entities: envelopeEntities,
		artifactValue,
	});
	if (ledgerFrameForRecord && typeof server.recordPerceptionLedgerFrame === "function") {
		const recordedFrame = server.recordPerceptionLedgerFrame({
			...ledgerFrameForRecord,
			...(effectivePageFingerprint ? { pageFingerprint: effectivePageFingerprint } : {}),
			renderCache: { mode, detailLevel, maxChars, paramsSignature, renderedAt: snapshotMeta.capturedAt },
			...(allocation ? { allocation } : {}),
		});
		void recordMemoryProfileFrame({ cwd: ctx?.cwd, browserSessionId: bridge.browserSessionId, frame: recordedFrame, trace: typeof server.perceptionTraceSnapshot === "function" ? server.perceptionTraceSnapshot(bridge.browserSessionId) : undefined });
	}
	return toolResult;
}

export function observeErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { command: "browser_observe", defaultMessage: "browser_observe failed", includeCommandInDetails: true });
}
