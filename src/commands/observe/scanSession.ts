import type { BrowserCommandRuntimePort, CommandPerceptionLedgerKey } from "../../ports/BrowserCommandRuntimePort.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { readPageFingerprint, type PageFingerprint } from "../pageSignals.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../commandShared.js";
import { commandTimeoutMs, type CommandOnUpdate } from "../commandRuntime.js";
import type { CommandFactGranularity } from "../resultTypes.js";
import { resolveBaselineEntities } from "./baseline.js";
import type { ObserveMode, ObserveToolParams } from "./common.js";
import { observeRenderParamsSignature, sessionDeltaEnabled } from "./renderCache.js";
import { tryRenderCacheHit } from "./scanCache.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { baselineReanchorReason, currentPageIdentity, perceptionLedgerKey } from "./pageIdentity.js";
import type { PageIdentity, PageReanchorReason } from "../../kernels/session/pageIdentity.js";

function granularityCeilingFromLedger(server: BrowserCommandRuntimePort, key: CommandPerceptionLedgerKey | undefined): Exclude<CommandFactGranularity, "omit"> | undefined {
	if (!key || typeof server.getRecentPerceptionLedgerFrames !== "function") return undefined;
	const pressured = server.getRecentPerceptionLedgerFrames(key, 3).filter((frame) => (frame.allocation?.budgetUsedRatio ?? 0) > 0.92).length;
	return pressured >= 2 ? "compact" : undefined;
}

async function resolveScanBaseline(
	server: BrowserCommandRuntimePort,
	params: ObserveToolParams,
	hasNavigation: boolean,
	ledgerFrame: ReturnType<NonNullable<BrowserCommandRuntimePort["getPerceptionLedgerFrame"]>> | undefined,
	pageIdentity: PageIdentity | undefined,
) {
	if (hasNavigation) {
		return {
			baseline: undefined,
			baselineRequested: params.baseline !== undefined || params.diff === true,
			baselineResolutionError: undefined,
			reanchorReason: "document_changed" as PageReanchorReason,
		};
	}
	const requested: unknown = params.baseline ?? (!hasNavigation && ledgerFrame ? { snapshotId: ledgerFrame.snapshotId } : undefined);
	const baselineRequested = requested !== undefined && requested !== null;
	if (!baselineRequested) {
		const reanchorReason = params.diff === true ? (pageIdentity ? "baseline_missing" : "identity_unproven") as PageReanchorReason : undefined;
		return {
			baseline: undefined,
			baselineRequested: params.diff === true,
			baselineResolutionError: undefined,
			reanchorReason,
		};
	}
	try {
		const baseline = await resolveBaselineEntities(server, requested);
		const reanchorReason = baselineReanchorReason(baseline?.pageIdentity, pageIdentity);
		return {
			baseline: reanchorReason ? undefined : baseline,
			baselineRequested: true,
			baselineResolutionError: undefined,
			reanchorReason,
		};
	} catch (error) {
		if (!ledgerFrame || params.baseline !== undefined) throw error;
		return { baseline: undefined, baselineRequested: true, baselineResolutionError: error instanceof Error ? error.message : String(error), reanchorReason: "baseline_missing" as PageReanchorReason };
	}
}

async function readScanFingerprint(options: {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	hasNavigation: boolean;
	effectiveTabId: number | undefined;
	timeoutMs: number;
	timings: ObserveTimingMetrics;
}): Promise<PageFingerprint | undefined> {
	const { server, params, hasNavigation, effectiveTabId, timeoutMs, timings } = options;
	if (hasNavigation || !sessionDeltaEnabled(params)) return undefined;
	const startedAt = Date.now();
	const fingerprint = await readPageFingerprint(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs });
	timings.fingerprintMs = elapsedMs(startedAt);
	addBridgeRoundTrips(timings, 1);
	return fingerprint;
}

export async function prepareScanSession(options: {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	mode: Extract<ObserveMode, "scan" | "text">;
	tabs: unknown[];
	tabId: number | undefined;
	maxChars: number;
	resultParams: ObserveToolParams;
	outputPath: string | undefined;
	browserSessionId: string | undefined;
	onUpdate?: CommandOnUpdate;
	timings: ObserveTimingMetrics;
}) {
	const { server, params, mode, tabId, maxChars, resultParams, outputPath, browserSessionId, onUpdate, timings } = options;
	const timeoutMs = commandTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
	const hasNavigation = typeof params.url === "string" && params.url.trim().length > 0;
	const captureMaxChars = params.outputPath ? 500_000 : Math.max(maxChars, 100_000);
	const scanScript = buildScanScript({ textOnly: mode === "text", maxChars: captureMaxChars, maxNodes: params.maxNodes, includeIframes: params.includeIframes });
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const effectiveTabId = tabId ?? bridge.defaultTabId;
	const detailLevel = String(params.detailLevel || "summary");
	const paramsSignature = observeRenderParamsSignature(params, mode, detailLevel, maxChars, captureMaxChars);
	const pageFingerprint = await readScanFingerprint({ server, params, hasNavigation, effectiveTabId, timeoutMs, timings });
	const pageIdentity = hasNavigation ? undefined : currentPageIdentity(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId }, pageFingerprint);
	const plannedLedgerKey = hasNavigation ? undefined : perceptionLedgerKey(pageIdentity);
	const ledgerFrame = !hasNavigation && sessionDeltaEnabled(params) && plannedLedgerKey && typeof server.getPerceptionLedgerFrame === "function"
		? server.getPerceptionLedgerFrame(plannedLedgerKey)
		: undefined;
	const cachedResult = await tryRenderCacheHit({
		server,
		params,
		mode,
		detailLevel,
		maxChars,
		paramsSignature,
		pageFingerprint,
		ledgerFrame,
		plannedLedgerKey,
		effectiveTabId,
		timeoutMs,
		resultParams,
		outputPath,
		browserSessionId,
		onUpdate,
		observeTimings: timings,
	});
	if (cachedResult) return { cacheHit: true as const, result: cachedResult };
	const baselineState = await resolveScanBaseline(server, params, hasNavigation, ledgerFrame, pageIdentity);
	return {
		cacheHit: false as const,
		timeoutMs,
		effectiveTabId,
		hasNavigation,
		captureMaxChars,
		scanScript,
		ledgerFrame,
		detailLevel,
		paramsSignature,
		pageFingerprint,
		pageIdentity,
		granularityCeiling: granularityCeilingFromLedger(server, plannedLedgerKey),
		...baselineState,
	};
}
