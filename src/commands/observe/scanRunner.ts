import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { BrowserBridgeError, compactError } from "../../utils/errors.js";
import { isRecord } from "../../utils/params.js";
import { artifactFallbackName, resolveArtifactPath } from "../../artifacts/artifactFiles.js";
import {
	bridgeNestedErrorResult,
	resolveLocalTargetTabId,
	targetTabId,
	type CommandResultContext,
} from "../commandRuntime.js";
import { elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { currentObserveSnapshotMeta, type ObserveToolParams } from "./common.js";
import { runObserveProviders } from "./scanProviders.js";
import { prepareScanAssembly } from "./scanAssembly.js";
import { executeScanCapture } from "./scanCapture.js";
import { finalizeScanObservation, type ObservationProviderFailure } from "./scanOutput.js";
import { prepareScanSession } from "./scanSession.js";
import { materializeVisualObservation } from "../visualEvidence.js";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../commandShared.js";
import { withBrowserOperation } from "../browserOperation.js";

function providerFailure(
	provider: string,
	code: string,
	message?: string,
	details?: Record<string, unknown>,
): ObservationProviderFailure {
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
		try {
			tabId = resolveLocalTargetTabId(server, rawTargetRef, browserSessionId);
		} catch {
			refreshTabs = true;
		}
	}
	if (refreshTabs) {
		const refreshStartedAt = Date.now();
		tabs = await server
			.refreshTabs(5_000, { browserSessionId: params.browserSessionId, signal })
			.catch((error: unknown) => {
				signal?.throwIfAborted();
				providerFailures.push(providerFailureFromError("tabs-refresh", error, "TABS_REFRESH_FAILED"));
				return server.getTabs();
			});
		timings.tabRefreshMs = elapsedMs(refreshStartedAt);
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

function assertCaptureContract(server: BrowserCommandRuntimePort, params: ObserveToolParams): void {
	const extension = server.snapshot({ browserSessionId: params.browserSessionId }).extension;
	if (!extension || extension.captureContractVersion === 1) return;
	throw new BrowserBridgeError(
		"EXTENSION_CONTRACT_MISMATCH",
		"The connected browser extension does not support capture contract v1",
		{
			expectedCaptureContractVersion: 1,
			actualCaptureContractVersion: extension.captureContractVersion ?? null,
			recovery: {
				action: "reload_extension",
				message: "Rebuild/reload the Browser Pilot extension, then reconnect before observing.",
			},
		},
	);
}

type VisualMaterialization = Awaited<ReturnType<typeof materializeVisualObservation>>;

type VisualStageInput = {
	capture: Awaited<ReturnType<typeof executeScanCapture>>;
	entities: Parameters<typeof materializeVisualObservation>[0]["entities"];
	snapshot: Parameters<typeof materializeVisualObservation>[0]["snapshot"];
	outputPath: string;
	projectRoot: string;
	url: string;
	timings: ObserveTimingMetrics;
	providerFailures: ObservationProviderFailure[];
};

/** Bind the bracketed screenshot to the observation, or record why no coherent visual was produced. */
async function materializeVisualStage(input: VisualStageInput): Promise<VisualMaterialization | undefined> {
	const { capture, timings, providerFailures } = input;
	if (!capture.visualCapture || !capture.fusedPageFingerprint) {
		if (capture.visualRequested) {
			providerFailures.push(
				providerFailure("visual", "VISUAL_CAPTURE_FAILED", "A coherent actionable screenshot was unavailable"),
			);
		}
		return undefined;
	}
	try {
		const visual = await materializeVisualObservation({
			capture: capture.visualCapture,
			fingerprint: capture.fusedPageFingerprint,
			entities: input.entities,
			snapshot: input.snapshot,
			outputPath: input.outputPath,
			projectRoot: input.projectRoot,
			url: input.url,
		});
		timings.visualWriteMs = Number(timings.visualWriteMs ?? 0) + visual.writeMs;
		return visual;
	} catch (error) {
		providerFailures.push(providerFailureFromError("visual", error, "VISUAL_MATERIALIZATION_FAILED"));
		return undefined;
	}
}

export async function runScanObservation(
	server: BrowserCommandRuntimePort,
	params: ObserveToolParams,
	ctx: CommandResultContext,
	signal?: AbortSignal,
) {
	const startedAt = Date.now();
	assertCaptureContract(server, params);
	const observeTimings: ObserveTimingMetrics = {};
	const request = await prepareObservationRequest(server, params, ctx, observeTimings, signal);
	const { tabs, providerFailures, browserSessionId, rawTargetRef, tabId, fallbackName, outputPath } = request;
	const operationTabId = tabId ?? server.snapshot({ browserSessionId: params.browserSessionId }).defaultTabId;
	const operationStartedAt = Date.now();
	const browserStage = await withBrowserOperation(
		{
			server,
			browserSessionId,
			tabId: operationTabId,
			targetRef: rawTargetRef as string | number | undefined,
			timeoutMs: Math.max(1, DEFAULT_TOOL_TIMEOUT_MS - elapsedMs(startedAt)),
			signal,
		},
		async ({ signal: operationSignal, deadlineAt }) => {
			const session = await prepareScanSession({
				server,
				params,
				tabId,
				timings: observeTimings,
				signal: operationSignal,
			});
			const capture = await executeScanCapture({
				server,
				params,
				rawTargetRef,
				browserSessionId,
				tabId: session.effectiveTabId,
				timeoutMs: session.timeoutMs,
				captureMaxChars: session.captureMaxChars,
				scanScript: session.scanScript,
				baseline: session.baseline,
				identityBaseline: session.identityBaseline,
				pageFingerprint: session.pageFingerprint,
				pageIdentity: session.pageIdentity,
				reanchorReason: session.reanchorReason,
				timings: observeTimings,
				signal: operationSignal,
			});
			const providers = await runObserveProviders({
				server,
				params,
				tabId: session.effectiveTabId,
				startedAt: operationStartedAt,
				deadlineAt,
				baseline: capture.baseline,
				timings: observeTimings,
				signal: operationSignal,
			});
			return { session, capture, providers };
		},
	);
	const { session, capture, providers } = browserStage;
	const { observation } = capture;
	const data = observation.result.data;
	const snapshotMeta = currentObserveSnapshotMeta(
		server,
		params,
		outputPath,
		data.page.url,
		providers.recorderState.lastSeq,
		providers.hookState.lastSeq,
		capture.pageIdentity,
	);
	const renderStartedAt = Date.now();
	const abmlProviderFailure = providerFailureFromAbmlRead(observation.abmlRead);
	if (abmlProviderFailure) providerFailures.push(abmlProviderFailure);
	const { assembly } = prepareScanAssembly({
		tabId: session.effectiveTabId,
		data,
		bridge: server.snapshot({ browserSessionId: params.browserSessionId }),
		snapshotMeta,
		observation,
		baseline: capture.baseline,
		causal: providers.causal,
		// A re-anchored page starts a new identity; the previous ledger frame must not attribute into it.
		ledgerFrame: capture.reanchorReason ? undefined : session.ledgerFrame,
	});
	const visual = await materializeVisualStage({
		capture,
		entities: assembly.envelopeEntities,
		snapshot: snapshotMeta,
		outputPath: outputPath!,
		projectRoot: ctx?.cwd ?? process.cwd(),
		url: data.page.url,
		timings: observeTimings,
		providerFailures,
	});
	providers.report.visual = capture.visualRequested
		? visual
			? { planned: true, status: "executed" }
			: { planned: true, status: "degraded", reason: "visual-capture-unavailable" }
		: { planned: false, status: "skipped", reason: "not-required" };
	return await finalizeScanObservation({
		server,
		ctx,
		params,
		request: { tabs, fallbackName, outputPath },
		session,
		capture,
		providers,
		assembly,
		snapshotMeta,
		timings: observeTimings,
		providerFailures,
		renderStartedAt,
		...(visual ? { visual } : {}),
	});
}

export function observeErrorResult(error: unknown) {
	return bridgeNestedErrorResult(error, {
		command: "browser_observe",
		defaultMessage: "browser_observe failed",
		includeCommandInDetails: true,
	});
}
