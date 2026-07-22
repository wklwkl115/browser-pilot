import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { readPageFingerprint, type PageFingerprint } from "../pageSignals.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../commandShared.js";
import { commandTimeoutMs, type CommandOnUpdate } from "../commandRuntime.js";
import { resolveBaselineEntities } from "./baseline.js";
import type { ObserveToolParams } from "./common.js";
import { observeRenderParamsSignature, sessionDeltaEnabled } from "./renderCache.js";
import { tryRenderCacheHit } from "./scanCache.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { baselineReanchorReason, currentPageIdentity, perceptionLedgerKey } from "./pageIdentity.js";
import type { PageIdentity, PageReanchorReason } from "../../kernels/session/pageIdentity.js";

async function resolveScanBaseline(
	server: BrowserCommandRuntimePort,
	params: ObserveToolParams,
	ledgerFrame: ReturnType<NonNullable<BrowserCommandRuntimePort["getPerceptionLedgerFrame"]>> | undefined,
	pageIdentity: PageIdentity | undefined,
) {
	const requested: unknown = params.baseline ?? (ledgerFrame ? { snapshotId: ledgerFrame.snapshotId } : undefined);
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
	effectiveTabId: number | undefined;
	timeoutMs: number;
	timings: ObserveTimingMetrics;
}): Promise<PageFingerprint | undefined> {
	const { server, params, effectiveTabId, timeoutMs, timings } = options;
	if (!sessionDeltaEnabled(params)) return undefined;
	const startedAt = Date.now();
	const fingerprint = await readPageFingerprint(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs });
	timings.fingerprintMs = elapsedMs(startedAt);
	addBridgeRoundTrips(timings, 1);
	return fingerprint;
}

export async function prepareScanSession(options: {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	tabId: number | undefined;
	outputPath: string | undefined;
	browserSessionId: string | undefined;
	onUpdate?: CommandOnUpdate;
	timings: ObserveTimingMetrics;
}) {
	const { server, params, tabId, outputPath, browserSessionId, onUpdate, timings } = options;
	const timeoutMs = commandTimeoutMs(undefined, DEFAULT_TOOL_TIMEOUT_MS);
	const captureMaxChars = 500_000;
	const scanScript = buildScanScript({ textOnly: false, maxChars: captureMaxChars });
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const effectiveTabId = tabId ?? bridge.defaultTabId;
	const paramsSignature = observeRenderParamsSignature(params);
	const pageFingerprint = await readScanFingerprint({ server, params, effectiveTabId, timeoutMs, timings });
	const pageIdentity = currentPageIdentity(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId }, pageFingerprint);
	const plannedLedgerKey = perceptionLedgerKey(pageIdentity);
	const ledgerFrame = sessionDeltaEnabled(params) && plannedLedgerKey && typeof server.getPerceptionLedgerFrame === "function"
		? server.getPerceptionLedgerFrame(plannedLedgerKey)
		: undefined;
	const cachedResult = await tryRenderCacheHit({
		server,
		params,
		paramsSignature,
		pageFingerprint,
		ledgerFrame,
		plannedLedgerKey,
		effectiveTabId,
		timeoutMs,
		outputPath,
		browserSessionId,
		onUpdate,
		observeTimings: timings,
	});
	if (cachedResult) return { cacheHit: true as const, result: cachedResult };
	const baselineState = await resolveScanBaseline(server, params, ledgerFrame, pageIdentity);
	return {
		cacheHit: false as const,
		timeoutMs,
		effectiveTabId,
		captureMaxChars,
		scanScript,
		ledgerFrame,
		paramsSignature,
		pageFingerprint,
		pageIdentity,
		...baselineState,
	};
}
