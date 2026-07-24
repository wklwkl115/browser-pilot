import { readBrowserAbmlStructure, type BrowserAbmlStructureResult } from "../../browser-runtime/abml/runtime.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { readPageFingerprint, samePageFingerprint, type PageFingerprint } from "../pageSignals.js";
import { evaluatePageScriptDirect } from "../../browser-page-runtime/pageScriptEvaluation.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import type { BaselineResolution } from "./baseline.js";
import type { ObserveToolParams } from "./common.js";
import type { PageIdentity, PageReanchorReason } from "../../kernels/session/pageIdentity.js";
import { pageReanchorReason, samePageIdentity } from "../../kernels/session/pageIdentity.js";
import { currentPageIdentity, pageIdentityFromUnknown } from "./pageIdentity.js";
import type { PageWorldScanBundleV1 } from "../../kernels/abml/pageWorldScan.js";
import { validatePageWorldScanBundle } from "../../validation/pageContracts.js";
import { invalidateAxRawCache } from "../../browser-runtime/abml/axRuntime.js";
import { BrowserBridgeError, normalizeError } from "../../utils/errors.js";
import { captureVisualScreenshot, shouldCaptureVisual } from "../visualEvidence.js";
import { finiteNumber, isRecord } from "../../utils/records.js";

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

function capturedPageIdentity(options: ScanCaptureOptions, fingerprint: PageFingerprint | undefined, target: unknown) {
	const effectiveFingerprint = fingerprint ?? options.pageFingerprint;
	const targetIdentity = pageIdentityFromUnknown(target);
	const observedIdentity = currentPageIdentity(options.server, { browserSessionId: options.params.browserSessionId, tabId: options.tabId }, effectiveFingerprint);
	const targetMismatch = !!targetIdentity && !!observedIdentity && !samePageIdentity(targetIdentity, observedIdentity);
	const fingerprintMismatch = !!targetIdentity && typeof effectiveFingerprint?.pageEpoch === "string" && effectiveFingerprint.pageEpoch !== targetIdentity.pageEpoch;
	const identity = targetIdentity ?? observedIdentity;
	return {
		identity,
		reanchorReason: targetMismatch || fingerprintMismatch
			? "identity_unproven" as const
			: options.pageIdentity
				? pageReanchorReason(options.pageIdentity, identity)
				: undefined,
	};
}

async function readCaptureFingerprint(options: ScanCaptureOptions): Promise<PageFingerprint | undefined> {
	const startedAt = Date.now();
	const fingerprint = await readPageFingerprint(options.server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, signal: options.signal });
	options.timings.fingerprintMs = Number(options.timings.fingerprintMs ?? 0) + elapsedMs(startedAt);
	addBridgeRoundTrips(options.timings, 1);
	return fingerprint;
}

type ScanEvaluationResult = Omit<Awaited<ReturnType<typeof evaluatePageScriptDirect>>, "data"> & { data: PageWorldScanBundleV1 };

export function axCacheKeyForPage(fingerprint: PageFingerprint | undefined): string | undefined {
	return fingerprint?.pageEpoch
		? JSON.stringify(["content", fingerprint.pageEpoch, fingerprint.documentId ?? "", fingerprint.changeSeq, fingerprint.url ?? "", fingerprint.scrollX ?? 0, fingerprint.scrollY ?? 0, fingerprint.viewportWidth ?? 0, fingerprint.viewportHeight ?? 0])
		: undefined;
}

async function readScanAbml(
	options: ScanCaptureOptions,
	result: ScanEvaluationResult,
	effectiveBaseline: BaselineResolution | undefined,
	fusedPageFingerprint: PageFingerprint | undefined,
) {
	const { browserSessionId, tabId, timeoutMs, captureMaxChars, timings } = options;
	timings.abmlPrefetchedScan = true;
	const cacheKey = axCacheKeyForPage(fusedPageFingerprint);
	const abmlStartedAt = Date.now();
	const abmlRead = await readBrowserAbmlStructure(options.server, {
		baseline: effectiveBaseline?.entities,
		diffOptions: effectiveBaseline?.partialBaseline ? { partialBaseline: true } : undefined,
		prefetchedScan: result.data,
		axCacheKey: cacheKey,
		pageFingerprint: fusedPageFingerprint,
	}, { browserSessionId, tabId, timeoutMs, maxChars: captureMaxChars, signal: options.signal });
	timings.abmlMs = Number(timings.abmlMs ?? 0) + elapsedMs(abmlStartedAt);
	const axDiagnostics = abmlRead.ok && isRecord(abmlRead.data.axDiagnostics) ? abmlRead.data.axDiagnostics : undefined;
	const axCdpCalls = finiteNumber(axDiagnostics?.cdpCalls);
	const axGeometryCdpCalls = finiteNumber(axDiagnostics?.geometryCdpCalls);
	if (axCdpCalls !== undefined) {
		timings.axCdpCalls = Number(timings.axCdpCalls ?? 0) + axCdpCalls;
		addBridgeRoundTrips(timings, axCdpCalls);
	}
	if (axGeometryCdpCalls !== undefined) timings.axGeometryCdpCalls = Number(timings.axGeometryCdpCalls ?? 0) + axGeometryCdpCalls;
	return { abmlRead, cacheKey };
}

function withCoherenceDiagnostics(abmlRead: BrowserAbmlStructureResult, attempts: number): BrowserAbmlStructureResult {
	return abmlRead.ok
		? { ...abmlRead, data: { ...abmlRead.data, observationCoherence: { status: "stable", attempts } } }
		: abmlRead;
}

async function executeScanCaptureAttempt(options: ScanCaptureOptions, seededFingerprint: PageFingerprint | undefined) {
	const { server, params, rawTargetRef, timeoutMs, scanScript, baseline, timings } = options;
	let effectiveBaseline = baseline;
	let reanchorReason = options.reanchorReason;
	const initialFingerprint = seededFingerprint ?? await readCaptureFingerprint(options);
	const pageScriptStartedAt = Date.now();
	const evaluated = await evaluatePageScriptDirect(server, scanScript, { browserSessionId: params.browserSessionId, tabId: rawTargetRef, timeoutMs, name: "scan_extract", signal: options.signal });
	const result = { ...evaluated, data: validatedScanBundle(evaluated.data) };
	timings.pageScriptMs = Number(timings.pageScriptMs ?? 0) + elapsedMs(pageScriptStartedAt);
	addBridgeRoundTrips(timings, 1);
	const capturedIdentity = capturedPageIdentity(options, initialFingerprint, result.target);
	const pageIdentity = capturedIdentity.identity;
	if (capturedIdentity.reanchorReason) {
		reanchorReason = capturedIdentity.reanchorReason;
		effectiveBaseline = undefined;
	}
	const { abmlRead, cacheKey } = await readScanAbml(options, result, effectiveBaseline, initialFingerprint);
	const visualRequested = shouldCaptureVisual(params, result.data);
	const visualStartedAt = Date.now();
	let visualCapture: Awaited<ReturnType<typeof captureVisualScreenshot>> | undefined;
	if (visualRequested) {
		try {
			visualCapture = await captureVisualScreenshot(server, { browserSessionId: options.browserSessionId, tabId: options.tabId ?? rawTargetRef as string | number | undefined, timeoutMs, signal: options.signal });
		} catch {
			options.signal?.throwIfAborted();
		}
	}
	if (visualRequested) {
		timings.visualMs = Number(timings.visualMs ?? 0) + elapsedMs(visualStartedAt);
		addBridgeRoundTrips(timings, 1);
		if (visualCapture) {
			timings.screenshotTransportMs = Number(timings.screenshotTransportMs ?? 0) + visualCapture.transportMs;
			timings.visualDecodeHashMs = Number(timings.visualDecodeHashMs ?? 0) + visualCapture.decodeHashMs;
			timings.screenshotBytes = Number(timings.screenshotBytes ?? 0) + visualCapture.buffer.length;
		}
	}
	const finalFingerprint = await readCaptureFingerprint(options);
	const coherence = initialFingerprint?.pageEpoch && finalFingerprint?.pageEpoch
		? samePageFingerprint(initialFingerprint, finalFingerprint) ? "stable" as const : "unstable" as const
		: "unverified" as const;
	return { result, abmlRead, cacheKey, coherence, stableFingerprint: coherence === "stable" ? finalFingerprint : undefined, pageIdentity, baseline: effectiveBaseline, reanchorReason, visualRequested, visualCapture };
}

export async function executeScanCapture(options: ScanCaptureOptions) {
	let last: Awaited<ReturnType<typeof executeScanCaptureAttempt>> | undefined;
	let seededFingerprint = options.pageFingerprint;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		last = await executeScanCaptureAttempt(options, seededFingerprint);
		seededFingerprint = undefined;
		options.timings.observationAttempts = attempt;
		if (last.coherence === "stable") {
			options.timings.fusedFingerprint = true;
			return {
				observation: { result: last.result, abmlRead: withCoherenceDiagnostics(last.abmlRead, attempt) },
				fusedPageFingerprint: last.stableFingerprint,
				pageIdentity: last.pageIdentity,
				baseline: last.baseline,
				reanchorReason: last.reanchorReason,
				visualRequested: last.visualRequested,
				visualCapture: last.visualCapture,
			};
		}
		if (last.cacheKey && options.tabId) invalidateAxRawCache({ browserSessionId: options.browserSessionId, tabId: options.tabId, cacheKey: last.cacheKey });
		if (attempt < 2) options.timings.abmlCoherenceRetries = attempt;
	}
	const error = normalizeError(new BrowserBridgeError("ABML_OBSERVATION_UNSTABLE", "Page changed or could not be verified during DOM+AX observation", { attempts: 2, coherence: last!.coherence }));
	return {
		observation: { result: last!.result, abmlRead: { ok: false as const, error } },
		fusedPageFingerprint: undefined,
		pageIdentity: last!.pageIdentity,
		baseline: undefined,
		reanchorReason: last!.reanchorReason ?? "identity_unproven" as const,
		visualRequested: last!.visualRequested,
		visualCapture: undefined,
	};
}
