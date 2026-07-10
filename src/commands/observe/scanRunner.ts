import { readFile } from "node:fs/promises";
import { executeBrowserWaitWithSupervisor } from "../../browser-command-runtime/waitSupervisor.js";
import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame, CommandPerceptionLedgerKey } from "../../ports/BrowserCommandRuntimePort.js";
import { summarizeEntityDiff, type EntityDiff } from "../../kernels/abml/diff.js";
import { buildRelationSummary, addEntityRelations, buildRelationGraph } from "../../kernels/abml/relations.js";
import { buildInferenceSummary, entitiesForInferenceEvidence } from "../../kernels/abml/inference.js";
import { buildCausalSummary, causalUnavailable, buildTriggeredRelations, resolveActionEntityRef, buildCausalEvents, eventTriggeredByEntity, type CausalSummary } from "../../kernels/abml/causal.js";
import { buildTreeDiff, type TreeDiff } from "../../kernels/abml/treeDiff.js";
import { buildSnapshotProjection } from "../../kernels/abml/snapshotProjection.js";
import { buildCollectionModels } from "../../kernels/abml/collections.js";
import { buildIdentityGraph, identityGraphSummary } from "../../kernels/abml/identityGraph.js";
import { deriveSemanticRefAnchors } from "../../kernels/abml/semanticRefAnchor.js";
import { createBrowserAbmlIntegration } from "../../browser-command-runtime/abml/integration.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { parseJsonOrThrow, stableJson, truncateText } from "../../utils/json.js";
import { compactError } from "../../utils/errors.js";
import { isRecord } from "../../utils/params.js";
import { resolveArtifactPath } from "../../artifacts/artifactFiles.js";
import { assertBridgeCommandSucceeded } from "../../utils/bridgeResultValidation.js";
import { normalizePageFingerprint, queryHookDelta, queryNetworkDelta, readHookRecorderSeq, readNetworkRecorderSeq, readPageFingerprint } from "../pageSignals.js";
import { evaluatePageScriptDirect } from "../../browser-page-runtime/pageScriptEvaluation.js";
import { registerScanEntityRefs } from "../../scan/entityRefs.js";
import { buildScanEntities, scanEntitiesFromGroups, summarizeScanData } from "../../scan/summary.js";
import { artifactFallbackName, bridgeNestedErrorResult, jsonCommandResult, resolveLocalTargetTabId, targetTabId, textCommandResult, commandMaxChars, commandTimeoutMs, withTrackedOperation, type CommandOnUpdate, type CommandResultContext } from "../commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../commandShared.js";
import { buildEntityOutline, buildPageGist, sortEntitiesBySalience } from "./entityViews.js";
import { cachedEnvelopeFromArtifact, legacyProjectionDetails, legacyProjectionSummary, modeInferredDetails, modeInferredSummary, observeCacheTtlMs, observeRenderParamsSignature, renderCacheMatches, scanCommandName, sessionDeltaEnabled } from "./renderCache.js";
import { entityRefs, mergeEntitiesByRef, resolveBaselineEntities, type BaselineResolution } from "./baseline.js";
import { buildMemoryAugmentationPlan, consumeMemoryProfileDiagnostics, memoryWarmStartTerms, recordMemoryProfileFrame } from "./memoryAugmentation.js";
import { factsFromObservedEntities, stableRefsFromCommandFrames } from "./perceptionLedgerProjection.js";
import { buildObserveRelevance, observeIntent, relevanceEnabled, type ObserveRelevance } from "./relevanceFusion.js";
import { addBridgeRoundTrips, elapsedMs, finalizedObserveTimings, type ObserveTimingMetrics } from "./timings.js";
import { currentObserveSnapshotMeta, withObservationMeta, type ObserveMode, type ObserveToolParams } from "./common.js";
import { runAxeDiagnostics, shouldRunAxeDiagnostics } from "./axeDiagnosticsRunner.js";
import { runReadability, shouldRunReadability } from "./readabilityRunner.js";
import type { CommandFactGranularity } from "../resultTypes.js";
import { buildNativeTreeDiff } from "../../native/browserPilotNativeKernels.js";
import { attachAbmlArtifactHints, buildObserveAbmlDetails, buildObserveArtifactProjection, buildPageObservation, buildScanNextActionHints } from "./scanProjection.js";

// Build the envelope `causal` block when a baseline is supplied. Passive (no control attribution):
// "requests fired since the baseline observation". Emits `unavailable` when no recorder is active
// or the baseline carries no seq high-water mark (e.g. a raw entity-list baseline).
async function buildObserveCausal(server: BrowserCommandRuntimePort, params: ObserveToolParams, recorderState: { active: boolean }, baselineNetworkSeq: number | undefined, tabId: number | undefined, timeoutMs: number): Promise<CausalSummary> {
	if (!recorderState.active) return causalUnavailable("network recorder not active — start via browser_network start");
	if (baselineNetworkSeq === undefined) return causalUnavailable("baseline has no network seq high-water mark — capture a baseline observation after browser_network start");
	try {
		const items = await queryNetworkDelta(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs, sinceSeq: baselineNetworkSeq });
		return buildCausalSummary(items, baselineNetworkSeq);
	} catch {
		return causalUnavailable("network recorder delta query failed");
	}
}

const DEFAULT_AXE_DIAGNOSTICS_TIMEOUT_MS = 4_000;
const DEFAULT_READABILITY_PROVIDER_TIMEOUT_MS = 3_000;

function ledgerKey(browserSessionId: string | undefined, tabId: number | undefined, url: string | undefined): CommandPerceptionLedgerKey | undefined {
	if (!url) return undefined;
	return { browserSessionId, tabId, navigationEpoch: url };
}

function granularityCeilingFromLedger(server: BrowserCommandRuntimePort, key: CommandPerceptionLedgerKey | undefined): Exclude<CommandFactGranularity, "omit"> | undefined {
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

export function cachedObserveResultFromEnvelope(envelope: Record<string, unknown>, details: Record<string, unknown>, maxChars: number): import("../../utils/toolResult.js").BrowserTextCommandResult {
	const rendered = stableJson(envelope);
	const preview = truncateText(rendered, maxChars);
	return {
		content: [{ type: "text", text: preview.text }],
		details: {
			...details,
			truncated: preview.truncated,
			originalLength: preview.originalLength,
		},
	};
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

type ObservationProviderFailure = {
	provider: string;
	code: string;
	message?: string;
	details?: Record<string, unknown>;
};

function providerFailure(provider: string, code: string, message?: string, details?: Record<string, unknown>): ObservationProviderFailure {
	return {
		provider,
		code,
		...(message ? { message } : {}),
		...(details && Object.keys(details).length ? { details } : {}),
	};
}

function providerFailureFromError(provider: string, error: unknown, fallbackCode: string): ObservationProviderFailure {
	const compact = compactError(error, fallbackCode);
	return providerFailure(
		provider,
		typeof compact.code === "string" ? compact.code : fallbackCode,
		typeof compact.message === "string" ? compact.message : undefined,
		isRecord(compact.details) ? compact.details : undefined,
	);
}

function providerFailureFromAbmlRead(abmlRead: unknown): ObservationProviderFailure | undefined {
	if (!isRecord(abmlRead) || abmlRead.ok === true) return undefined;
	const error = isRecord(abmlRead.error) ? abmlRead.error : abmlRead;
	const code = typeof error.code === "string" ? error.code : "ABML_READ_FAILED";
	const message = typeof error.message === "string" ? error.message : undefined;
	const details = isRecord(error.details) ? error.details : undefined;
	return providerFailure("abml-read", code, message, details);
}

function hasArtifactPath(path: unknown): path is string {
	return typeof path === "string" && path.trim().length > 0;
}

export async function runScanObservation(server: BrowserCommandRuntimePort, params: ObserveToolParams, ctx: CommandResultContext, mode: Extract<ObserveMode, "scan" | "text" | "tabs">, onUpdate?: CommandOnUpdate) {
	const observeTimings: ObserveTimingMetrics = {};
	const providerFailures: ObservationProviderFailure[] = [];
	const tabRefreshStartedAt = Date.now();
	let tabsRefreshDegraded = false;
	const tabs = await server.refreshTabs(5_000, { browserSessionId: params.browserSessionId }).catch((error: unknown) => {
		tabsRefreshDegraded = true;
		providerFailures.push(providerFailureFromError("tabs-refresh", error, "TABS_REFRESH_FAILED"));
		return server.getTabs();
	});
	observeTimings.tabRefreshMs = elapsedMs(tabRefreshStartedAt);
	const maxChars = commandMaxChars(params, "browser_observe");
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const rawTargetRef = targetTabId(params);
	const tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
	const fallbackName = artifactFallbackName(mode === "tabs" ? "observe-tabs" : mode === "text" ? "observe-text" : "observe-scan");
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, fallbackName);
	const artifactAvailable = hasArtifactPath(outputPath);
	if (!artifactAvailable) providerFailures.push(providerFailure("artifact", "ARTIFACT_UNAVAILABLE", "PageObservation artifact path is unavailable"));
	const resultParams = { ...params, outputPath };
	const axeDiagnosticsRequested = mode === "scan" && params.modeExplicit !== true && shouldRunAxeDiagnostics(params);
	const readabilityRequested = mode === "scan" && params.modeExplicit !== true && shouldRunReadability(params);
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
			commandName: "browser_observe",
			command: "scan.tabs",
			browserSessionId,
			tabId: trackedTabId,
			phase: "running",
			progress: 10,
			queueDepth: server.queueDepth(browserSessionId, trackedTabId),
			leaseOwnerHash: server.leaseOwnerHash(browserSessionId, trackedTabId),
			snapshotId: snapshotMeta.snapshotId,
			sourceMode: "scan",
		}, onUpdate, async (handle): Promise<import("../../utils/toolResult.js").BrowserTextCommandResult> => {
			await handle.update({ progress: 80, details: { tabs_count: tabs.length } });
			return await jsonCommandResult(tabsOnlyData, resultParams, ctx, {
				commandName: "browser_observe",
				command: "scan.tabs",
				maxChars,
				fallbackName,
				details: { mode: "tabs", modeInferred: modeInferredDetails(params), ...legacyProjectionDetails(params, "tabs"), sourceMode: "scan", sourceCommand: "tabs.list" },
				operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId },
				snapshot: snapshotMeta,
				distill: (value) => ({ ...summarizeObserveTabsData(value), ...legacyProjectionSummary(params, "tabs") }),
				artifactValue: { ...tabsOnlyData, operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId }, snapshot: snapshotMeta },
			});
		});
		return toolResult;
	}
	const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
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
					const cachedRecorderStartedAt = Date.now();
					const [cachedNetworkState, cachedHookState] = await Promise.all([
						readNetworkRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs }),
						readHookRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs }),
					]);
					observeTimings.recorderMs = elapsedMs(cachedRecorderStartedAt);
					addBridgeRoundTrips(observeTimings, 2);
					const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, cacheFingerprint.url, cachedNetworkState.lastSeq, cachedHookState.lastSeq);
					const { result: cachedResult } = await withTrackedOperation(server, {
						commandName: "browser_observe",
						command: mode === "text" ? "scan.text" : "scan",
						browserSessionId,
						tabId: effectiveTabId,
						phase: "running",
						progress: 10,
						queueDepth: server.queueDepth(browserSessionId, effectiveTabId),
						leaseOwnerHash: server.leaseOwnerHash(browserSessionId, effectiveTabId),
						snapshotId: snapshotMeta.snapshotId,
						sourceMode: "scan",
					}, onUpdate, async (handle): Promise<import("../../utils/toolResult.js").BrowserTextCommandResult> => {
						await handle.update({ progress: 100, details: { fromCache: true, changeSeq: cacheFingerprint.changeSeq } });
						const isCanonical = mode === "scan" && !params.modeExplicit;
						const cacheMeta = { reason: "content-fingerprint-unchanged" as const, changeSeq: cacheFingerprint.changeSeq, priorSnapshotId: ledgerFrame.snapshotId };
						const memoryProfileWarnings = consumeMemoryProfileDiagnostics(ctx?.cwd);
						const cachedSummary = isRecord(cachedEnvelope.summary) ? { ...cachedEnvelope.summary } as Record<string, unknown> : {};
						const cachedPageObservation = isRecord(cachedSummary.pageObservation) ? { ...cachedSummary.pageObservation } as Record<string, unknown> : undefined;
						if (cachedPageObservation) {
							const cachedPageDiagnostics = isRecord(cachedPageObservation.diagnostics) ? cachedPageObservation.diagnostics as Record<string, unknown> : {};
							cachedPageObservation.snapshot = snapshotMeta;
							cachedPageObservation.diagnostics = {
								...cachedPageDiagnostics,
								cache: cacheMeta,
								fromCache: true,
							};
						}
						const cachedSummaryWithCache = {
							...cachedSummary,
							...(cachedPageObservation ? { pageObservation: cachedPageObservation } : {}),
							fromCache: true,
							cache: cacheMeta,
							priorSnapshotId: ledgerFrame.snapshotId,
							...(isCanonical ? {} : legacyProjectionSummary(params, mode)),
						};
						const value = {
							...cachedEnvelope,
							fromCache: true,
							cache: cacheMeta,
							delta: "session" as const,
							baselineSnapshotId: ledgerFrame.snapshotId,
							operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId },
							snapshot: snapshotMeta,
							summary: cachedSummaryWithCache,
						};
						return cachedObserveResultFromEnvelope(value, {
							mode,
							modeInferred: modeInferredDetails(params),
							...(isCanonical ? { model: "PageObservation", canonical: true } : legacyProjectionDetails(params, mode)),
							sourceMode: "scan",
							sourceCommand: "content.fingerprint",
							fromCache: true,
							priorSnapshotId: ledgerFrame.snapshotId,
							renderCache: { hit: true, ttlMs: observeCacheTtlMs(), ...cacheMeta },
							...(memoryProfileWarnings.length ? { memory: { warnings: memoryProfileWarnings } } : {}),
						}, maxChars);
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
	const baselineRequested = effectiveBaseline !== undefined && effectiveBaseline !== null;
	let baseline: BaselineResolution | undefined;
	let baselineResolutionError: string | undefined;
	try {
		baseline = await resolveBaselineEntities(server, effectiveBaseline);
	} catch (error) {
		if (!ledgerFrame || params.baseline !== undefined) throw error;
		baselineResolutionError = error instanceof Error ? error.message : String(error);
		baseline = undefined;
	}
	const abml = createBrowserAbmlIntegration(server, { browserSessionId, tabId, timeoutMs, maxChars: captureMaxChars });
	let fusedPageFingerprint = undefined as ReturnType<typeof normalizePageFingerprint>;
	const { result: observation, operation } = await withTrackedOperation(server, {
		commandName: "browser_observe",
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
	// Capture this observation's network + hook seq high-water marks (so it can
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
	// Attach the hook event delta to the requests-based causal block when hooks are armed and the
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
	const axeDiagnosticsStartedAt = Date.now();
	const axeDiagnostics = await runAxeDiagnostics(server, {
		requested: axeDiagnosticsRequested,
		browserSessionId: params.browserSessionId,
		tabId: typeof rawTargetRef === "number" || typeof rawTargetRef === "string" ? rawTargetRef : undefined,
		timeoutMs: Math.min(DEFAULT_AXE_DIAGNOSTICS_TIMEOUT_MS, Math.max(500, Math.floor((params.timeoutMs ?? DEFAULT_AXE_DIAGNOSTICS_TIMEOUT_MS) / 2))),
		artifactPath: artifactAvailable ? outputPath : undefined,
		maxResults: (() => {
			const nested = isRecord(params.params) ? params.params : undefined;
			return typeof nested?.axeMaxResults === "number" ? nested.axeMaxResults : undefined;
		})(),
	});
	if (axeDiagnosticsRequested) observeTimings.axeMs = elapsedMs(axeDiagnosticsStartedAt);
	if (axeDiagnosticsRequested) addBridgeRoundTrips(observeTimings, 1);
	if (axeDiagnostics.failure) providerFailures.push(axeDiagnostics.failure);
	const readabilityStartedAt = Date.now();
	const nestedParams = isRecord(params.params) ? params.params : undefined;
	const readability = await runReadability(server, {
		requested: readabilityRequested,
		browserSessionId: params.browserSessionId,
		tabId: typeof rawTargetRef === "number" || typeof rawTargetRef === "string" ? rawTargetRef : undefined,
		timeoutMs: Math.min(DEFAULT_READABILITY_PROVIDER_TIMEOUT_MS, Math.max(500, Math.floor((params.timeoutMs ?? DEFAULT_READABILITY_PROVIDER_TIMEOUT_MS) / 2))),
		artifactPath: artifactAvailable ? outputPath : undefined,
		maxInlineChars: typeof nestedParams?.readabilityMaxInlineChars === "number" ? nestedParams.readabilityMaxInlineChars : undefined,
		maxContentChars: typeof nestedParams?.readabilityMaxContentChars === "number" ? nestedParams.readabilityMaxContentChars : undefined,
		maxElemsToParse: typeof nestedParams?.readabilityMaxElemsToParse === "number" ? nestedParams.readabilityMaxElemsToParse : undefined,
	});
	if (readabilityRequested) observeTimings.readabilityMs = elapsedMs(readabilityStartedAt);
	if (readabilityRequested) addBridgeRoundTrips(observeTimings, 1);
	if (readability.failure) providerFailures.push(readability.failure);
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
		...(mode === "scan" && !params.modeExplicit ? { model: "PageObservation", canonical: true } : legacyProjectionSummary(params, mode)),
		browserSessionId: bridge.browserSessionId,
		tabId,
		selectionVersion: bridge.selectionVersion,
		selectionVersionAtDispatch: bridge.selectionVersion,
		selectionVersionAtResolve: bridge.selectionVersion,
	});
	const abmlEntities = observation.abmlRead?.ok === true ? (observation.abmlRead.entities ?? []) : null;
	const abmlProviderFailure = providerFailureFromAbmlRead(observation.abmlRead);
	if (abmlProviderFailure) providerFailures.push(abmlProviderFailure);
	const abmlDiff: EntityDiff | undefined = observation.abmlRead?.ok === true ? observation.abmlRead.diff : undefined;
	const abmlDiffSummary = abmlDiff ? summarizeEntityDiff(abmlDiff, baseline?.entities, observation.abmlRead?.ok === true ? observation.abmlRead.entities ?? [] : []) : undefined;
	const envelopeDiff = abmlDiff ? { ...abmlDiff, ...(abmlDiffSummary ? { summary: abmlDiffSummary } : {}) } : undefined;
	const abmlTreeDiff: TreeDiff | undefined = observation.abmlRead?.ok === true && baseline
		? buildNativeTreeDiff(baseline.entities, observation.abmlRead.entities ?? [], { partialBaseline: baseline.partialBaseline })
			?? buildTreeDiff(baseline.entities, observation.abmlRead.entities ?? [], { partialBaseline: baseline.partialBaseline })
		: undefined;
	// Attach causal `triggered` edges before the relation summary so they surface in
	// relations.summary + the controls' inline relations. Two sources, both additive (the delta stays
	// fully inline in envelope.causal regardless):
	//   - network delta to the activated control (explicit `actionRef`, else the focus-normalized
	//     `diff.focusedRef`; a frame/region focus is rejected), source:"timing", low confidence;
	//   - each event that names its own target element (DOM-sink `selector`) to that element,
	//     source:"event", medium confidence (stronger than timing because the event records its element).
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
			const collections = buildCollectionModels({
				entities: attributedEntities,
				treeDiff: abmlTreeDiff,
				snapshotProjection,
				scanEvidence: scanCollectionEvidence(summaryData),
			});
			// Intent ref registry: register high-confidence semantic anchors so agents can
			// re-find elements after SPA navigations or full page loads.
			const intentRegistry = typeof server.getIntentRefRegistry === "function" ? server.getIntentRefRegistry() : undefined;
			if (intentRegistry && pageUrl) {
				const pageOrigin = (() => { try { return new URL(pageUrl).origin; } catch { return undefined; } })();
				if (pageOrigin) {
					const anchorSummary = deriveSemanticRefAnchors(attributedEntities);
					const highConfidenceEntries = anchorSummary.anchors
						.filter((item) => item.anchor.confidence === "high" && item.anchor.mintingEligible)
						.map((item) => {
							const a = item.anchor;
							const anchorKey = [a.containerRole, a.containerName, a.normalizedName, a.role, a.kind].filter(Boolean).join("/");
							return { anchorKey, ref: item.ref, origin: pageOrigin, seenAt: snapshotMeta.capturedAt };
						});
					if (highConfidenceEntries.length) intentRegistry.register(highConfidenceEntries);
				}
			}
			const idGraph = buildIdentityGraph(attributedEntities, causal, intentRegistry);
			const runtimeRelationGraph = observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.relationGraph) ? observation.abmlRead.data.relationGraph : undefined;
			const relationGraph = runtimeRelationGraph || buildRelationGraph(attributedEntities);
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
				...(collections.length ? { collections } : {}),
				...causalBlock,
				...(idSummary.backendNodeIdCount || idSummary.anchorCount || idSummary.triggeredCount ? { identity: idSummary } : {}),
				...(idGraph.intentRefs?.length ? { intentRefs: idGraph.intentRefs } : {}),
				_identityGraph: idGraph,
				...(isRecord(relationGraph) && Number(relationGraph.edgeCount || 0) > 0 ? { _relationGraph: relationGraph } : {}),
				focus: {
					...baseFocus,
					entityShape: "refs-v1",
					gist: buildPageGist(attributedEntities),
					primary_entities: entityRefs(primaryEntities),
					outline: buildEntityOutline(attributedEntities),
					// Emit the relationship graph only when it carries real edges. The in-memory summary still
					// feeds inference and causal attribution; templating and inference remain internal inputs for
					// treeDiff/snapshotProjection and referenced_entities.
					...(Object.keys(relSummary.summary).length || relSummary.highlights.length ? { relations: relSummary } : {}),
					// diff/treeDiff/snapshotProjection live ONLY at summary top-level (above) and are lifted to
					// envelope.* by responseEnvelope. Duplicating them here referenced the SAME object, so
					// redactSensitiveValue collapses the second occurrence to "[Circular]" and duplicates bytes.
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
	attachAbmlArtifactHints(summaryRecord);
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
	const scanHints = buildScanNextActionHints({
		hasBaseline,
		snapshotId: snapshotMeta.snapshotId,
		recorderActive: recorderState.active,
		causal,
		treeDiff: abmlTreeDiff,
	});
	if (scanHints.length) summaryRecord.nextActions = scanHints;
	const {
		artifactSnapshotProjection,
		artifactCollections,
		artifactIdentityGraph,
		artifactRelationGraph,
		artifactRelations,
	} = buildObserveArtifactProjection({
		summaryRecord,
		summary: summaryRecord,
		envelopeEntities,
		envelopeDiff,
		abmlTreeDiff,
		artifactRelevance,
		causalBlock,
		mode,
		hasNavigation,
	});
	const finalLedgerKey = ledgerKey(bridge.browserSessionId, tabId, typeof data?.url === "string" ? data.url : undefined);
	let allocation: CommandPerceptionLedgerFrame["allocation"] | undefined;
	const ledgerFacts = attributedEntities ? factsFromObservedEntities(attributedEntities) : undefined;
	const ledgerFrameForRecord: CommandPerceptionLedgerFrame | undefined = finalLedgerKey && ledgerFacts
		? { key: finalLedgerKey, snapshotId: snapshotMeta.snapshotId, capturedAt: snapshotMeta.capturedAt, facts: ledgerFacts }
		: undefined;
	const priorLedgerFrame = finalLedgerKey && typeof server.getRecentPerceptionLedgerFrames === "function" ? server.getRecentPerceptionLedgerFrames(finalLedgerKey, 1)[0] : undefined;
	const stableRefs = ledgerFrameForRecord ? stableRefsFromCommandFrames(ledgerFrameForRecord, priorLedgerFrame) : undefined;
	const memoryProfileWarnings = consumeMemoryProfileDiagnostics(ctx?.cwd);
	observeTimings.renderMs = elapsedMs(renderStartedAt);
	const baselineDiagnostics = baselineRequested
		? { baselineRequested: true as const, baselineApplied: baseline !== undefined, ...(baselineResolutionError ? { baselineResolutionError } : {}) }
		: undefined;
	const baselineWarnings: string[] = [];
	if (baselineRequested && baseline === undefined && baselineResolutionError) {
		baselineWarnings.push(`baseline resolution failed — returning full observation instead of diff: ${baselineResolutionError}`);
	}
	const summaryFocus = isRecord(summaryRecord.focus) ? summaryRecord.focus as Record<string, unknown> : undefined;
	const summaryTruncation = isRecord(summaryFocus?.actionablesTruncation) ? summaryFocus!.actionablesTruncation as Record<string, unknown> : undefined;
	const summaryWarnings = Array.isArray(summaryRecord.warnings) ? summaryRecord.warnings.filter((w): w is string => typeof w === "string") : [];
	const allWarnings = [...baselineWarnings, ...summaryWarnings];
	const axFusionDiagnostics = observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.axFusion) ? observation.abmlRead.data.axFusion : undefined;
	const axDiagnostics = observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.axDiagnostics) ? observation.abmlRead.data.axDiagnostics : undefined;
	const axReadUnavailable = axDiagnostics?.snapshotGeometryUnavailable === true && Number(axDiagnostics?.nodeCount || 0) === 0;
	const axProviderStatus = observation.abmlRead?.ok === true
		? axFusionDiagnostics
			? axReadUnavailable
				? "degraded"
				: axFusionDiagnostics.degraded === true
					? "degraded"
					: Number(axFusionDiagnostics.axEnriched || 0) > 0
						? "ax-enriched"
						: Number(axFusionDiagnostics.axOnly || 0) > 0
							? "ax-only"
							: "scan-backed"
			: "skipped"
		: undefined;
	const observeDiagnostics = {
		observeTimings: finalizedObserveTimings(observeTimings, data, observation.abmlRead),
		...(axeDiagnosticsRequested ? { axe: axeDiagnostics.summary } : {}),
		...(readabilityRequested ? { readability: readability.summary } : {}),
		...(observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.axFusion) ? { axFusion: observation.abmlRead.data.axFusion } : {}),
		...(baselineDiagnostics ? { baseline: baselineDiagnostics } : {}),
		...(summaryTruncation?.actionablesTruncated === true ? { actionablesTruncated: true, actionablesScanned: summaryTruncation.actionablesScanned, actionablesReturned: summaryTruncation.actionablesReturned } : {}),
		...(providerFailures.length ? { providerFailures } : {}),
		...(allWarnings.length ? { warnings: allWarnings } : {}),
	};
	const isCanonicalPageObservation = mode === "scan" && !params.modeExplicit;
	const pageObservation = isCanonicalPageObservation ? buildPageObservation({
		mode,
		canonical: true,
		summary: summaryRecord,
		entities: envelopeEntities,
		content,
		url: pageUrl,
		tabs,
		activeTabId: bridge.defaultTabId,
		snapshot: snapshotMeta,
		diff: envelopeDiff,
		treeDiff: abmlTreeDiff,
		causal,
		artifactPath: artifactAvailable ? outputPath : undefined,
		abmlIntegrated: attributedEntities !== null,
		tabsRefreshDegraded,
		providerStatuses: {
			structure: observation.abmlRead?.ok === true ? "executed" : "failed",
			content: "scan-backed",
			text: "scan-backed",
			html: artifactAvailable ? "scan-backed" : "failed",
			evidence: artifactAvailable ? "scan-backed" : "failed",
			tabs: tabsRefreshDegraded ? "degraded" : "executed",
			...(axProviderStatus ? { ax: axProviderStatus } : {}),
			...(axeDiagnosticsRequested ? { axe: axeDiagnostics.status } : {}),
			...(readabilityRequested ? { readability: readability.status } : {}),
		},
		providerFailures,
		diagnostics: observeDiagnostics,
	}) : undefined;
	if (pageObservation) summaryRecord.pageObservation = pageObservation;
	const abmlDetails = buildObserveAbmlDetails({
		abmlRead: observation.abmlRead,
		diagnostics: observeDiagnostics.observeTimings,
	});
	const resultDetails = {
		mode,
		modeInferred: modeInferredDetails(params),
		...(mode === "scan" && !params.modeExplicit ? { model: "PageObservation", canonical: true } : legacyProjectionDetails(params, mode)),
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
		...(pageObservation ? { pageObservation } : {}),
		tabs_count: tabs.length,
		tabs,
		active_tab: bridge.defaultTabId,
		browserSessionId: bridge.browserSessionId,
		operation,
		snapshot: snapshotMeta,
		...(envelopeDiff ? { diff: envelopeDiff } : {}),
		...(abmlTreeDiff ? { treeDiff: abmlTreeDiff } : {}),
		...(artifactRelations ? { relations: artifactRelations } : {}),
		...(artifactRelationGraph ? { relationGraph: artifactRelationGraph } : {}),
		...(artifactSnapshotProjection ? { snapshotProjection: artifactSnapshotProjection } : {}),
		...(artifactCollections?.length ? { collections: artifactCollections } : {}),
		...(artifactIdentityGraph ? { identityGraph: artifactIdentityGraph } : {}),
		...(artifactRelevance ? { relevance: artifactRelevance } : {}),
		...(axeDiagnostics.artifact ? { axe: axeDiagnostics.artifact } : {}),
		...(readability.artifact ? { readability: readability.artifact } : {}),
		...causalBlock,
		abml: observation.abmlRead?.ok === true ? { ...observation.abmlRead, diff: envelopeDiff, snapshotProjection: artifactSnapshotProjection, collections: artifactCollections, relationGraph: artifactRelationGraph } : observation.abmlRead,
	};
	const toolResult = await textCommandResult(content, resultParams, ctx, {
		commandName: "browser_observe",
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
