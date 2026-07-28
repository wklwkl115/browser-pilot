import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";
import type { PageFingerprint } from "../pageSignals.js";
import type { CommandResultContext } from "../commandRuntime.js";
import { isRecord } from "../../utils/params.js";
import { factsFromObservedEntities } from "./perceptionLedgerProjection.js";
import { elapsedMs, finalizedObserveTimings, type ObserveTimingMetrics } from "./timings.js";
import { buildObserveAbmlDetails, buildPageObservation, buildScanNextActionHints } from "./scanProjection.js";
import type { BaselineResolution } from "./baseline.js";
import type { executeScanCapture } from "./scanCapture.js";
import type { assembleScanSummary } from "./scanAssembly.js";
import type { runObserveProviders } from "./scanProviders.js";
import type { PageReanchorReason } from "../../kernels/session/pageIdentity.js";
import { pageIdentityFromUnknown, perceptionLedgerKey } from "./pageIdentity.js";
import type { PageWorldScanBundleV1 } from "../../kernels/abml/pageWorldScan.js";
import { pageObservationResult } from "../resultMiddleware.js";
import type { PageObservationBuild } from "./scanProjection.js";
import type { VisualObservation } from "../../kernels/abml/pageObservation.js";

export type ObservationProviderFailure = {
	provider: string;
	code: string;
	message?: string;
	details?: Record<string, unknown>;
};

type CaptureResult = Awaited<ReturnType<typeof executeScanCapture>>;
type AssemblyResult = ReturnType<typeof assembleScanSummary>;
type ProviderResult = Awaited<ReturnType<typeof runObserveProviders>>;
type PageObservation = PageObservationBuild;

function allSnapshotDocumentsCovered(observation: CaptureResult["observation"]): boolean {
	const axDiagnostics = observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.axDiagnostics) ? observation.abmlRead.data.axDiagnostics : undefined;
	return Number(axDiagnostics?.snapshotDocumentCount ?? 0) === 1 && Number(axDiagnostics?.snapshotDocumentsSkipped ?? 0) === 0;
}

function buildBaselineDiagnostics(options: FinalizeScanObservationOptions) {
	const { baselineRequested, baseline, baselineResolutionError, reanchorReason } = options;
	if (!baselineRequested && !reanchorReason) return { diagnostics: undefined, warnings: [] as string[] };
	return {
		diagnostics: { baselineRequested, baselineApplied: baseline !== undefined, ...(reanchorReason ? { reanchorReason } : {}), ...(baselineResolutionError ? { baselineResolutionError } : {}) },
		warnings: !baseline && baselineResolutionError
			? ["Prior page state was unavailable; returned a full observation instead of a diff."]
			: [],
	};
}

type FinalizeScanObservationOptions = {
	server: BrowserCommandRuntimePort;
	ctx: CommandResultContext;
	tabs: unknown[];
	fallbackName: string;
	outputPath: string | undefined;
	data: PageWorldScanBundleV1;
	content: string;
	scanMeta: Record<string, unknown> | undefined;
	bridge: ReturnType<BrowserCommandRuntimePort["snapshot"]>;
	baseline: BaselineResolution | undefined;
	baselineRequested: boolean;
	baselineResolutionError: string | undefined;
	reanchorReason: PageReanchorReason | undefined;
	snapshotMeta: ReturnType<typeof import("./common.js").currentObserveSnapshotMeta>;
	timings: ObserveTimingMetrics;
	providerFailures: ObservationProviderFailure[];
	providers: ProviderResult;
	capture: CaptureResult;
	assembly: AssemblyResult;
	scanPageFingerprint: PageFingerprint | undefined;
	renderStartedAt: number;
	visual?: VisualObservation;
	visualSaved?: { path: string; bytes: number; mime: string };
};

function buildObserveDiagnostics(options: FinalizeScanObservationOptions, summary: AssemblyResult["summary"]) {
	const { timings, data, providerFailures } = options;
	const { observation } = options.capture;
	const baseline = buildBaselineDiagnostics(options);
	const summaryWarnings = Array.isArray(summary.warnings) ? summary.warnings.filter((warning): warning is string => typeof warning === "string") : [];
	const warnings = [...baseline.warnings, ...summaryWarnings, ...(!allSnapshotDocumentsCovered(observation) ? ["Full document semantic coverage was incomplete."] : [])];
	const abmlFailure = observation.abmlRead?.ok === false
		? { code: observation.abmlRead.error.code, message: observation.abmlRead.error.message }
		: undefined;
	return {
		observeTimings: finalizedObserveTimings(timings, data, observation.abmlRead),
		...(observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.axFusion) ? { axFusion: observation.abmlRead.data.axFusion } : {}),
		...(observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.identityReconciliation) ? { identityReconciliation: observation.abmlRead.data.identityReconciliation } : {}),
		...(baseline.diagnostics ? { baseline: baseline.diagnostics } : {}),
		...(providerFailures.length ? { providerFailures } : {}),
		...(abmlFailure ? { abmlFailure } : {}),
		...(warnings.length ? { warnings } : {}),
	};
}

function captureCompleteness(options: FinalizeScanObservationOptions): { content: boolean; actions: boolean } {
	const { data } = options;
	const allDocuments = allSnapshotDocumentsCovered(options.capture.observation);
	return {
		content: data.stats.truncated !== true && allDocuments,
		actions: (data.stats.actionablesComplete ?? data.stats.truncated !== true) && allDocuments,
	};
}

function buildCanonicalPageObservation(
	options: FinalizeScanObservationOptions,
	summary: AssemblyResult["summary"],
	diagnostics: ReturnType<typeof buildObserveDiagnostics>,
): PageObservation {
	const { content, data, bridge, snapshotMeta, providerFailures } = options;
	const { envelopeEntities, attributedEntities, envelopeDiff, treeDiff } = options.assembly;
	const { causal } = options.providers;
	const completeness = captureCompleteness(options);
	return buildPageObservation({
		summary,
		entities: envelopeEntities,
		content,
		headings: data.content.headings,
		contentComplete: completeness.content,
		actionCaptureComplete: completeness.actions,
		url: data.page.url,
		activeTabId: bridge.defaultTabId,
		snapshot: snapshotMeta,
		diff: envelopeDiff,
		treeDiff,
		causal,
		abmlIntegrated: attributedEntities !== null,
		providerFailures,
		diagnostics,
		providerExecution: options.providers.report,
		visual: options.visual,
	});
}

function buildResultDetails(
	options: FinalizeScanObservationOptions,
	diagnostics: ReturnType<typeof buildObserveDiagnostics>,
) {
	const { tabs, bridge, scanMeta, scanPageFingerprint, reanchorReason } = options;
	const { observation } = options.capture;
	return {
		model: "PageObservation",
		canonical: true,
		sourceMode: "scan",
		sourceCommand: "scan_extract",
		tabs_count: tabs.length,
		active_tab: bridge.defaultTabId,
		browserSessionId: bridge.browserSessionId,
		scan: scanMeta,
		abml: buildObserveAbmlDetails({ abmlRead: observation.abmlRead, diagnostics: diagnostics.observeTimings }),
		...(scanPageFingerprint ? { signals: { fingerprint: scanPageFingerprint } } : {}),
		...(reanchorReason ? { reanchorReason } : {}),
		diagnostics,
		...(options.visualSaved ? { visualSaved: options.visualSaved } : {}),
	};
}

function buildLedgerProjection(options: FinalizeScanObservationOptions) {
	const { snapshotMeta } = options;
	const { attributedEntities } = options.assembly;
	const key = perceptionLedgerKey(pageIdentityFromUnknown(snapshotMeta));
	const facts = attributedEntities ? factsFromObservedEntities(attributedEntities) : undefined;
	const frame: CommandPerceptionLedgerFrame | undefined = key && facts
		? { key, snapshotId: snapshotMeta.snapshotId, capturedAt: snapshotMeta.capturedAt, facts }
		: undefined;
	return { frame };
}

function recordLedgerProjection(options: FinalizeScanObservationOptions, frame: CommandPerceptionLedgerFrame | undefined) {
	const { server } = options;
	if (!frame || typeof server.recordPerceptionLedgerFrame !== "function") return;
	server.recordPerceptionLedgerFrame(frame);
}

export async function finalizeScanObservation(options: FinalizeScanObservationOptions) {
	const { ctx, fallbackName, outputPath } = options;
	const { summary, treeDiff } = options.assembly;
	const { causal } = options.providers;

	if (options.reanchorReason) summary.reanchorReason = options.reanchorReason;
	const hints = buildScanNextActionHints({ hasBaseline: options.baseline !== undefined, causal, treeDiff });
	if (hints.length) summary.nextActions = hints;
	const ledger = buildLedgerProjection(options);
	options.timings.renderMs = elapsedMs(options.renderStartedAt);
	const diagnostics = buildObserveDiagnostics(options, summary);
	const pageObservation = buildCanonicalPageObservation(options, summary, diagnostics);
	const details = buildResultDetails(options, diagnostics);
	const result = await pageObservationResult({
		observation: pageObservation,
		artifactPath: outputPath,
		fallbackName,
		ctx,
		details,
	});
	recordLedgerProjection(options, ledger.frame);
	return result;
}
