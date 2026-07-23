import { createBrowserAbmlIntegration } from "../../browser-command-runtime/abml/integration.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { normalizePageFingerprint, readPageFingerprint, type PageFingerprint } from "../pageSignals.js";
import { evaluatePageScriptDirect } from "../../browser-page-runtime/pageScriptEvaluation.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import type { BaselineResolution } from "./baseline.js";
import type { ObserveToolParams } from "./common.js";
import type { PageIdentity, PageReanchorReason } from "../../kernels/session/pageIdentity.js";
import { pageReanchorReason, samePageIdentity } from "../../kernels/session/pageIdentity.js";
import { currentPageIdentity, pageIdentityFromUnknown } from "./pageIdentity.js";
import { validatePageWorldScanBundle, type PageWorldScanBundleV1 } from "../../kernels/abml/pageWorldScan.js";
import { BrowserBridgeError } from "../../utils/errors.js";

function scanResultFingerprint(value: PageWorldScanBundleV1): PageFingerprint | undefined {
	return normalizePageFingerprint(value.signals.fingerprint);
}

function validatedScanBundle(value: unknown): PageWorldScanBundleV1 {
	const validation = validatePageWorldScanBundle(value);
	if (validation.ok) return validation.value;
	throw new BrowserBridgeError("SCAN_BUNDLE_INVALID", "Page-world scan returned an invalid browser-page-scan/v1 bundle", { issues: validation.issues.slice(0, 20) });
}

type ScanCaptureOptions = {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	rawTargetRef: unknown;
	browserSessionId: string | undefined;
	tabId: number | undefined;
	timeoutMs: number;
	captureMaxChars: number;
	scanScript: string;
	baseline: BaselineResolution | undefined;
	pageFingerprint: PageFingerprint | undefined;
	pageIdentity: PageIdentity | undefined;
	reanchorReason: PageReanchorReason | undefined;
	timings: ObserveTimingMetrics;
	signal?: AbortSignal;
};

async function readCapturedPageIdentity(options: ScanCaptureOptions, fingerprint: PageFingerprint | undefined, target: unknown) {
	const startedAt = Date.now();
	const liveFingerprint = await readPageFingerprint(options.server, { browserSessionId: options.params.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, signal: options.signal });
	options.timings.fingerprintMs = Number(options.timings.fingerprintMs ?? 0) + elapsedMs(startedAt);
	addBridgeRoundTrips(options.timings, 1);
	const effectiveFingerprint = liveFingerprint ?? fingerprint;
	const targetIdentity = pageIdentityFromUnknown(target);
	const observedIdentity = currentPageIdentity(options.server, { browserSessionId: options.params.browserSessionId, tabId: options.tabId }, effectiveFingerprint);
	const targetMismatch = !!targetIdentity && !!observedIdentity && !samePageIdentity(targetIdentity, observedIdentity);
	const fingerprintMismatch = !!targetIdentity && typeof effectiveFingerprint?.pageEpoch === "string" && effectiveFingerprint.pageEpoch !== targetIdentity.pageEpoch;
	const identity = targetIdentity ?? observedIdentity;
	return {
		fingerprint: effectiveFingerprint,
		identity,
		reanchorReason: targetMismatch || fingerprintMismatch
			? "identity_unproven" as const
			: options.pageIdentity
				? pageReanchorReason(options.pageIdentity, identity)
				: undefined,
	};
}

type ScanAbmlIntegration = ReturnType<typeof createBrowserAbmlIntegration>;
type ScanEvaluationResult = Omit<Awaited<ReturnType<typeof evaluatePageScriptDirect>>, "data"> & { data: PageWorldScanBundleV1 };

async function readScanAbml(
	options: ScanCaptureOptions,
	abml: ScanAbmlIntegration,
	result: ScanEvaluationResult,
	effectiveBaseline: BaselineResolution | undefined,
	fusedPageFingerprint: PageFingerprint | undefined,
) {
	const { browserSessionId, tabId, timeoutMs, captureMaxChars, pageFingerprint, timings } = options;
	const canReuseScanForAbml = true;
	timings.abmlPrefetchedScan = canReuseScanForAbml;
	const cacheFingerprint = fusedPageFingerprint ?? pageFingerprint;
	const abmlStartedAt = Date.now();
	const abmlRead = await abml.readStructure({
		browserSessionId,
		tabId,
		timeoutMs,
		maxChars: captureMaxChars,
		baseline: effectiveBaseline?.entities,
		diffOptions: effectiveBaseline?.partialBaseline ? { partialBaseline: true } : undefined,
		prefetchedScan: canReuseScanForAbml ? result.data : undefined,
		axCacheKey: cacheFingerprint ? `content:${cacheFingerprint.changeSeq}:${cacheFingerprint.url || ""}` : undefined,
	});
	timings.abmlMs = elapsedMs(abmlStartedAt);
	if (!canReuseScanForAbml) addBridgeRoundTrips(timings, 1);
	return abmlRead;
}

export async function executeScanCapture(options: ScanCaptureOptions) {
	const { server, params, rawTargetRef, browserSessionId, tabId, timeoutMs, captureMaxChars, scanScript, baseline, timings } = options;
	const abml = createBrowserAbmlIntegration(server, { browserSessionId, tabId, timeoutMs, maxChars: captureMaxChars, signal: options.signal });
	let fusedPageFingerprint: PageFingerprint | undefined;
	let effectiveBaseline = baseline;
	let reanchorReason = options.reanchorReason;
	const pageScriptStartedAt = Date.now();
	const evaluated = await evaluatePageScriptDirect(server, scanScript, { browserSessionId: params.browserSessionId, tabId: rawTargetRef, timeoutMs, name: "scan_extract", signal: options.signal });
	const result = { ...evaluated, data: validatedScanBundle(evaluated.data) };
	timings.pageScriptMs = elapsedMs(pageScriptStartedAt);
	addBridgeRoundTrips(timings, 1);
	fusedPageFingerprint = scanResultFingerprint(result.data);
	if (fusedPageFingerprint) timings.fusedFingerprint = true;
	const capturedIdentity = await readCapturedPageIdentity(options, fusedPageFingerprint, result.target);
	fusedPageFingerprint = capturedIdentity.fingerprint;
	const capturedPageIdentity = capturedIdentity.identity;
	if (capturedIdentity.reanchorReason) {
		reanchorReason = capturedIdentity.reanchorReason;
		effectiveBaseline = undefined;
	}
	const abmlRead = await readScanAbml(options, abml, result, effectiveBaseline, fusedPageFingerprint);
	return { observation: { result, abmlRead }, fusedPageFingerprint, pageIdentity: capturedPageIdentity, baseline: effectiveBaseline, reanchorReason };
}
