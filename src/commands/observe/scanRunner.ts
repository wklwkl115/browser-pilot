import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { compactError } from "../../utils/errors.js";
import { isRecord } from "../../utils/params.js";
import { resolveArtifactPath } from "../../artifacts/artifactFiles.js";
import { artifactFallbackName, bridgeNestedErrorResult, resolveLocalTargetTabId, targetTabId, commandMaxChars, type CommandOnUpdate, type CommandResultContext } from "../commandRuntime.js";
import { elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { currentObserveSnapshotMeta, type ObserveMode, type ObserveToolParams } from "./common.js";
import { shouldRunAxeDiagnostics } from "./axeDiagnosticsRunner.js";
import { shouldRunReadability } from "./readabilityRunner.js";
import { runTabsObservation } from "./scanTabs.js";
import { runObserveProviders } from "./scanProviders.js";
import { prepareScanAssembly } from "./scanAssembly.js";
import { executeScanCapture } from "./scanCapture.js";
import { finalizeScanObservation, type ObservationProviderFailure } from "./scanOutput.js";
import { prepareScanSession } from "./scanSession.js";

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

function publicPageFingerprint(fingerprint: import("../pageSignals.js").PageFingerprint | undefined) {
	if (!fingerprint) return undefined;
	const { pageEpoch: _pageEpoch, documentId: _documentId, ...publicFingerprint } = fingerprint;
	return publicFingerprint;
}

async function prepareObservationRequest(
	server: BrowserCommandRuntimePort,
	params: ObserveToolParams,
	ctx: CommandResultContext,
	mode: Extract<ObserveMode, "scan" | "text" | "tabs">,
	timings: ObserveTimingMetrics,
) {
	const providerFailures: ObservationProviderFailure[] = [];
	const startedAt = Date.now();
	let tabsRefreshDegraded = false;
	const tabs = await server.refreshTabs(5_000, { browserSessionId: params.browserSessionId }).catch((error: unknown) => {
		tabsRefreshDegraded = true;
		providerFailures.push(providerFailureFromError("tabs-refresh", error, "TABS_REFRESH_FAILED"));
		return server.getTabs();
	});
	timings.tabRefreshMs = elapsedMs(startedAt);
	const maxChars = commandMaxChars(params, "browser_observe");
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const rawTargetRef = targetTabId(params);
	const tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
	const fallbackName = artifactFallbackName(mode === "tabs" ? "observe-tabs" : mode === "text" ? "observe-text" : "observe-scan");
	const outputPath = params.outputPath ?? resolveArtifactPath(ctx, undefined, fallbackName);
	const artifactAvailable = hasArtifactPath(outputPath);
	if (!artifactAvailable) providerFailures.push(providerFailure("artifact", "ARTIFACT_UNAVAILABLE", "PageObservation artifact path is unavailable"));
	return {
		tabs,
		tabsRefreshDegraded,
		providerFailures,
		maxChars,
		browserSessionId,
		rawTargetRef,
		tabId,
		fallbackName,
		outputPath,
		artifactAvailable,
		resultParams: { ...params, outputPath },
		axeDiagnosticsRequested: mode === "scan" && params.modeExplicit !== true && shouldRunAxeDiagnostics(params),
		readabilityRequested: mode === "scan" && params.modeExplicit !== true && shouldRunReadability(params),
	};
}

export async function runScanObservation(server: BrowserCommandRuntimePort, params: ObserveToolParams, ctx: CommandResultContext, mode: Extract<ObserveMode, "scan" | "text" | "tabs">, onUpdate?: CommandOnUpdate) {
	const observeTimings: ObserveTimingMetrics = {};
	const request = await prepareObservationRequest(server, params, ctx, mode, observeTimings);
	const { tabs, tabsRefreshDegraded, providerFailures, maxChars, browserSessionId, rawTargetRef, tabId, fallbackName, outputPath, artifactAvailable, resultParams, axeDiagnosticsRequested, readabilityRequested } = request;
	if (mode === "tabs") {
		return await runTabsObservation({
			server,
			params,
			resultParams,
			tabs,
			tabId: typeof tabId === "number" ? tabId : undefined,
			browserSessionId,
			outputPath,
			maxChars,
			fallbackName,
			ctx,
			onUpdate,
		});
	}
	const session = await prepareScanSession({
		server,
		params,
		mode,
		tabs,
		tabId,
		maxChars,
		resultParams,
		outputPath,
		browserSessionId,
		onUpdate,
		timings: observeTimings,
	});
	if (session.cacheHit) return session.result;
	const { timeoutMs, effectiveTabId, hasNavigation, captureMaxChars, scanScript, ledgerFrame: sessionLedgerFrame, detailLevel, paramsSignature, pageFingerprint, pageIdentity, granularityCeiling, baseline: sessionBaseline, baselineRequested, baselineResolutionError, reanchorReason: sessionReanchorReason } = session;
	const capture = await executeScanCapture({
		server,
		params,
		mode,
		hasNavigation,
		rawTargetRef,
		browserSessionId,
		tabId: effectiveTabId,
		timeoutMs,
		captureMaxChars,
		scanScript,
		baseline: sessionBaseline,
		pageFingerprint,
		pageIdentity,
		reanchorReason: sessionReanchorReason,
		timings: observeTimings,
		onUpdate,
	});
	const { observation, fusedPageFingerprint } = capture;
	const baseline = capture.baseline;
	const ledgerFrame = capture.reanchorReason ? undefined : sessionLedgerFrame;
	const data = observation.result.data as Record<string, unknown> | undefined;
	const scanPageFingerprint = publicPageFingerprint(fusedPageFingerprint);
	const effectivePageFingerprint = fusedPageFingerprint ?? pageFingerprint;
	const content = typeof data?.content === "string" ? data.content : JSON.stringify(data ?? observation.result.data, null, 2);
	const scanMeta = data ? { ...data, content: `[${content.length} chars]` } : undefined;
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const providers = await runObserveProviders({
		server,
		params,
		tabId: effectiveTabId,
		rawTargetRef,
		timeoutMs,
		baseline,
		axeRequested: axeDiagnosticsRequested,
		readabilityRequested,
		artifactPath: artifactAvailable ? outputPath : undefined,
		timings: observeTimings,
	});
	const { causal, axeDiagnostics, readability, recorderState, hookState } = providers;
	if (axeDiagnostics.failure) providerFailures.push(axeDiagnostics.failure);
	if (readability.failure) providerFailures.push(readability.failure);
	const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, typeof data?.url === "string" ? data.url : undefined, recorderState.lastSeq, hookState.lastSeq, capture.pageIdentity);
	const renderStartedAt = Date.now();
	const abmlProviderFailure = providerFailureFromAbmlRead(observation.abmlRead);
	if (abmlProviderFailure) providerFailures.push(abmlProviderFailure);
	const { assembly } = prepareScanAssembly({
		server,
		params,
		mode,
		tabs,
		maxChars,
		tabId: effectiveTabId,
		data,
		bridge,
		snapshotMeta,
		observation,
		baseline,
		causal,
		ledgerFrame,
	});
	return await finalizeScanObservation({
		server,
		params,
		resultParams,
		mode,
		ctx,
		tabs,
		tabId: effectiveTabId,
		maxChars,
		fallbackName,
		outputPath,
		artifactAvailable,
		hasNavigation,
		tabsRefreshDegraded,
		data,
		content,
		scanMeta,
		bridge,
		recorderActive: recorderState.active,
		baseline,
		baselineRequested,
		baselineResolutionError,
		reanchorReason: capture.reanchorReason,
		snapshotMeta,
		timings: observeTimings,
		providerFailures,
		axeRequested: axeDiagnosticsRequested,
		readabilityRequested,
		providers,
		capture,
		assembly,
		granularityCeiling,
		scanPageFingerprint,
		effectivePageFingerprint,
		detailLevel,
		paramsSignature,
		renderStartedAt,
	});
}

export function observeErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { command: "browser_observe", defaultMessage: "browser_observe failed", includeCommandInDetails: true });
}
