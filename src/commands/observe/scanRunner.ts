import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { BrowserBridgeError, compactError } from "../../utils/errors.js";
import { isRecord } from "../../utils/params.js";
import { resolveArtifactPath } from "../../artifacts/artifactFiles.js";
import { artifactFallbackName, bridgeNestedErrorResult, resolveLocalTargetTabId, targetTabId, type CommandResultContext } from "../commandRuntime.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { currentObserveSnapshotMeta, type ObserveToolParams } from "./common.js";
import { runObserveProviders } from "./scanProviders.js";
import { prepareScanAssembly } from "./scanAssembly.js";
import { executeScanCapture } from "./scanCapture.js";
import { finalizeScanObservation, type ObservationProviderFailure } from "./scanOutput.js";
import { prepareScanSession } from "./scanSession.js";
import { materializeVisualObservation } from "../visualEvidence.js";

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

function publicPageFingerprint(fingerprint: import("../pageSignals.js").PageFingerprint | undefined) {
	if (!fingerprint) return undefined;
	const { pageEpoch: _pageEpoch, documentId: _documentId, ...publicFingerprint } = fingerprint;
	return publicFingerprint;
}

async function prepareObservationRequest(
	server: BrowserCommandRuntimePort,
	params: ObserveToolParams,
	ctx: CommandResultContext,
	timings: ObserveTimingMetrics,
	signal?: AbortSignal,
) {
	const providerFailures: ObservationProviderFailure[] = [];
	signal?.throwIfAborted();
	const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
	const rawTargetRef = targetTabId(params);
	let tabs = server.getTabs();
	let tabId: number | undefined;
	let refreshTabs = tabs.length === 0;
	if (rawTargetRef !== undefined) {
		try { tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId); }
		catch { refreshTabs = true; }
	}
	if (refreshTabs) {
		const refreshStartedAt = Date.now();
		tabs = await server.refreshTabs(5_000, { browserSessionId: params.browserSessionId, signal }).catch((error: unknown) => {
			signal?.throwIfAborted();
			providerFailures.push(providerFailureFromError("tabs-refresh", error, "TABS_REFRESH_FAILED"));
			return server.getTabs();
		});
		timings.tabRefreshMs = elapsedMs(refreshStartedAt);
		addBridgeRoundTrips(timings, 1);
		if (rawTargetRef !== undefined) tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
	}
	signal?.throwIfAborted();
	const fallbackName = artifactFallbackName("observe-scan");
	const outputPath = resolveArtifactPath(ctx, undefined, fallbackName);
	return {
		tabs,
		providerFailures,
		browserSessionId,
		rawTargetRef,
		tabId,
		fallbackName,
		outputPath,
	};
}

export async function runScanObservation(server: BrowserCommandRuntimePort, params: ObserveToolParams, ctx: CommandResultContext, signal?: AbortSignal) {
	const startedAt = Date.now();
	const extension = server.snapshot({ browserSessionId: params.browserSessionId }).extension;
	if (extension && extension.captureContractVersion !== 1) {
		throw new BrowserBridgeError("EXTENSION_CONTRACT_MISMATCH", "The connected browser extension does not support capture contract v1", {
			expectedCaptureContractVersion: 1,
			actualCaptureContractVersion: extension.captureContractVersion ?? null,
			recovery: { action: "reload_extension", message: "Rebuild/reload the Browser Pilot extension, then reconnect before observing." },
		});
	}
	const observeTimings: ObserveTimingMetrics = {};
	const request = await prepareObservationRequest(server, params, ctx, observeTimings, signal);
	const { tabs, providerFailures, browserSessionId, rawTargetRef, tabId, fallbackName, outputPath } = request;
	const session = await prepareScanSession({
		server,
		params,
		tabId,
		timings: observeTimings,
		signal,
	});
	const { timeoutMs, effectiveTabId, captureMaxChars, scanScript, ledgerFrame: sessionLedgerFrame, pageFingerprint, pageIdentity, identityBaseline, baseline: sessionBaseline, baselineRequested, baselineResolutionError, reanchorReason: sessionReanchorReason } = session;
	const capture = await executeScanCapture({
		server,
		params,
		rawTargetRef,
		browserSessionId,
		tabId: effectiveTabId,
		timeoutMs,
		captureMaxChars,
		scanScript,
		baseline: sessionBaseline,
		identityBaseline,
		pageFingerprint,
		pageIdentity,
		reanchorReason: sessionReanchorReason,
		timings: observeTimings,
		signal,
	});
	const { observation, fusedPageFingerprint } = capture;
	const baseline = capture.baseline;
	const ledgerFrame = capture.reanchorReason ? undefined : sessionLedgerFrame;
	const data = observation.result.data;
	const scanPageFingerprint = publicPageFingerprint(fusedPageFingerprint);
	const content = data.content.text;
	const scanMeta = { schema: data.schema, page: data.page, stats: data.stats };
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const providers = await runObserveProviders({
		server,
		params,
		tabId: effectiveTabId,
		startedAt,
		deadlineAt: startedAt + timeoutMs,
		baseline,
		timings: observeTimings,
		signal,
	});
	const { causal, recorderState, hookState } = providers;
	const snapshotMeta = currentObserveSnapshotMeta(server, params, outputPath, data.page.url, recorderState.lastSeq, hookState.lastSeq, capture.pageIdentity);
	const renderStartedAt = Date.now();
	const abmlProviderFailure = providerFailureFromAbmlRead(observation.abmlRead);
	if (abmlProviderFailure) providerFailures.push(abmlProviderFailure);
	const { assembly } = prepareScanAssembly({
		server,
		params,
		tabId: effectiveTabId,
		data,
		bridge,
		snapshotMeta,
		observation,
		baseline,
		causal,
		ledgerFrame,
	});
	let visual: Awaited<ReturnType<typeof materializeVisualObservation>> | undefined;
	if (capture.visualCapture && fusedPageFingerprint) {
		try {
			visual = await materializeVisualObservation({
				capture: capture.visualCapture,
				fingerprint: fusedPageFingerprint,
				entities: assembly.envelopeEntities,
				snapshot: snapshotMeta,
				outputPath: outputPath!,
				projectRoot: ctx?.cwd ?? process.cwd(),
				url: data.page.url,
			});
			observeTimings.visualWriteMs = Number(observeTimings.visualWriteMs ?? 0) + visual.writeMs;
		} catch (error) {
			providerFailures.push(providerFailureFromError("visual", error, "VISUAL_MATERIALIZATION_FAILED"));
		}
	} else if (capture.visualRequested) {
		providerFailures.push(providerFailure("visual", "VISUAL_CAPTURE_FAILED", "A coherent actionable screenshot was unavailable"));
	}
	providers.report.visual = capture.visualRequested
		? visual ? { planned: true, status: "executed" } : { planned: true, status: "degraded", reason: "visual-capture-unavailable" }
		: { planned: false, status: "skipped", reason: "not-required" };
	return await finalizeScanObservation({
		server,
		ctx,
		tabs,
		fallbackName,
		outputPath,
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
		providers,
		capture,
		assembly,
		scanPageFingerprint,
		renderStartedAt,
		intent: params.intent,
		visual: visual?.visual,
		visualSaved: visual?.saved,
	});
}

export function observeErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, { command: "browser_observe", defaultMessage: "browser_observe failed", includeCommandInDetails: true });
}
