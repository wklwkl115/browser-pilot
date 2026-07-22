import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { readPageFingerprint, type PageFingerprint } from "../pageSignals.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../commandShared.js";
import { commandTimeoutMs } from "../commandRuntime.js";
import { resolveBaselineEntities } from "./baseline.js";
import type { ObserveToolParams } from "./common.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { baselineReanchorReason, currentPageIdentity, perceptionLedgerKey } from "./pageIdentity.js";
import type { PageIdentity, PageReanchorReason } from "../../kernels/session/pageIdentity.js";

async function resolveScanBaseline(
	server: BrowserCommandRuntimePort,
	params: ObserveToolParams,
	ledgerFrame: ReturnType<NonNullable<BrowserCommandRuntimePort["getPerceptionLedgerFrame"]>> | undefined,
	pageIdentity: PageIdentity | undefined,
	signal?: AbortSignal,
) {
	const requested = params.baseline ?? ledgerFrame?.snapshotId;
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
		const baseline = await resolveBaselineEntities(server, requested, signal);
		const reanchorReason = baselineReanchorReason(baseline?.pageIdentity, pageIdentity);
		return {
			baseline: reanchorReason ? undefined : baseline,
			baselineRequested: true,
			baselineResolutionError: undefined,
			reanchorReason,
		};
	} catch (error) {
		signal?.throwIfAborted();
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
	signal?: AbortSignal;
}): Promise<PageFingerprint | undefined> {
	const { server, params, effectiveTabId, timeoutMs, timings, signal } = options;
	if (!sessionDeltaEnabled(params)) return undefined;
	const startedAt = Date.now();
	const fingerprint = await readPageFingerprint(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs, signal });
	timings.fingerprintMs = elapsedMs(startedAt);
	addBridgeRoundTrips(timings, 1);
	return fingerprint;
}

function sessionDeltaEnabled(params: ObserveToolParams): boolean {
	return params.fresh !== true && params.baseline === undefined;
}

export async function prepareScanSession(options: {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	tabId: number | undefined;
	timings: ObserveTimingMetrics;
	signal?: AbortSignal;
}) {
	const { server, params, tabId, timings, signal } = options;
	const timeoutMs = commandTimeoutMs(undefined, DEFAULT_TOOL_TIMEOUT_MS);
	const captureMaxChars = 500_000;
	const scanScript = buildScanScript({ textOnly: false, maxChars: captureMaxChars });
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const effectiveTabId = tabId ?? bridge.defaultTabId;
	const pageFingerprint = await readScanFingerprint({ server, params, effectiveTabId, timeoutMs, timings, signal });
	const pageIdentity = currentPageIdentity(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId }, pageFingerprint);
	const plannedLedgerKey = perceptionLedgerKey(pageIdentity);
	const ledgerFrame = sessionDeltaEnabled(params) && plannedLedgerKey && typeof server.getPerceptionLedgerFrame === "function"
		? server.getPerceptionLedgerFrame(plannedLedgerKey)
		: undefined;
	const baselineState = await resolveScanBaseline(server, params, ledgerFrame, pageIdentity, signal);
	return {
		timeoutMs,
		effectiveTabId,
		captureMaxChars,
		scanScript,
		ledgerFrame,
		pageFingerprint,
		pageIdentity,
		...baselineState,
	};
}
