import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";
import type { PageFingerprint } from "../pageSignals.js";
import type { CommandResultContext } from "../commandRuntime.js";
import { isRecord } from "../../utils/params.js";
import { factsFromObservedEntities } from "./perceptionLedgerProjection.js";
import { elapsedMs, finalizedObserveTimings, type ObserveTimingMetrics } from "./timings.js";
import { buildObserveAbmlDetails, buildPageObservation, buildScanNextActionHints } from "./scanProjection.js";
import type { BaselineResolution } from "./baseline.js";
import type { ObserveToolParams } from "./common.js";
import type { executeScanCapture } from "./scanCapture.js";
import type { assembleScanSummary } from "./scanAssembly.js";
import type { runObserveProviders } from "./scanProviders.js";
import type { PageReanchorReason } from "../../kernels/session/pageIdentity.js";
import { pageIdentityFromUnknown, perceptionLedgerKey } from "./pageIdentity.js";
import type { PageWorldScanBundleV1 } from "../../kernels/abml/pageWorldScan.js";
import { pageObservationResult } from "../resultMiddleware.js";
import type { PageObservationBuild } from "./scanProjection.js";

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

function buildBaselineDiagnostics(options: FinalizeScanObservationOptions) {
	const { baselineRequested, baseline, baselineResolutionError, reanchorReason } = options;
	if (!baselineRequested && !reanchorReason) return { diagnostics: undefined, warnings: [] as string[] };
	return {
		diagnostics: { baselineRequested, baselineApplied: baseline !== undefined, ...(reanchorReason ? { reanchorReason } : {}), ...(baselineResolutionError ? { baselineResolutionError } : {}) },
		warnings: !baseline && baselineResolutionError
			? [`baseline resolution failed — returning full observation instead of diff: ${baselineResolutionError}`]
			: [],
	};
}

type FinalizeScanObservationOptions = {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	resultParams: ObserveToolParams;
	ctx: CommandResultContext;
	tabs: unknown[];
	tabId: number | undefined;
	maxChars: number;
	fallbackName: string;
	outputPath: string | undefined;
	artifactAvailable: boolean;
	tabsRefreshDegraded: boolean;
	data: PageWorldScanBundleV1;
	content: string;
	scanMeta: Record<string, unknown> | undefined;
	bridge: ReturnType<BrowserCommandRuntimePort["snapshot"]>;
	recorderActive: boolean;
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
	effectivePageFingerprint: PageFingerprint | undefined;
	paramsSignature: string;
	renderStartedAt: number;
};

function buildObserveDiagnostics(options: FinalizeScanObservationOptions, summary: Record<string, unknown>) {
	const { timings, data, providerFailures } = options;
	const { observation } = options.capture;
	const baseline = buildBaselineDiagnostics(options);
	const summaryFocus = isRecord(summary.focus) ? summary.focus : undefined;
	const truncation = isRecord(summaryFocus?.actionablesTruncation) ? summaryFocus.actionablesTruncation : undefined;
	const summaryWarnings = Array.isArray(summary.warnings) ? summary.warnings.filter((warning): warning is string => typeof warning === "string") : [];
	const warnings = [...baseline.warnings, ...summaryWarnings];
	return {
		observeTimings: finalizedObserveTimings(timings, data, observation.abmlRead),
		...(observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.axFusion) ? { axFusion: observation.abmlRead.data.axFusion } : {}),
		...(baseline.diagnostics ? { baseline: baseline.diagnostics } : {}),
		...(truncation?.actionablesTruncated === true ? { actionablesTruncated: true, actionablesScanned: truncation.actionablesScanned, actionablesReturned: truncation.actionablesReturned } : {}),
		...(providerFailures.length ? { providerFailures } : {}),
		...(warnings.length ? { warnings } : {}),
	};
}

function buildCanonicalPageObservation(
	options: FinalizeScanObservationOptions,
	summary: Record<string, unknown>,
	diagnostics: ReturnType<typeof buildObserveDiagnostics>,
): PageObservation {
	const { content, data, bridge, snapshotMeta, artifactAvailable, outputPath, providerFailures } = options;
	const { envelopeEntities, attributedEntities, envelopeDiff, treeDiff } = options.assembly;
	const { causal } = options.providers;
	return buildPageObservation({
		summary,
		entities: envelopeEntities,
		content,
		url: data.page.url,
		activeTabId: bridge.defaultTabId,
		snapshot: snapshotMeta,
		diff: envelopeDiff,
		treeDiff,
		causal,
		artifactPath: artifactAvailable ? outputPath : undefined,
		abmlIntegrated: attributedEntities !== null,
		providerFailures,
		diagnostics,
		budgetChars: options.maxChars,
		providerExecution: options.providers.report,
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

function recordLedgerProjection(options: FinalizeScanObservationOptions, frame: CommandPerceptionLedgerFrame | undefined, allocation: CommandPerceptionLedgerFrame["allocation"] | undefined) {
	const { server, effectivePageFingerprint, paramsSignature, snapshotMeta } = options;
	if (!frame || typeof server.recordPerceptionLedgerFrame !== "function") return;
	server.recordPerceptionLedgerFrame({
		...frame,
		...(effectivePageFingerprint ? { pageFingerprint: effectivePageFingerprint } : {}),
		renderCache: { paramsSignature, renderedAt: snapshotMeta.capturedAt },
		...(allocation ? { allocation } : {}),
	});
}

export async function finalizeScanObservation(options: FinalizeScanObservationOptions) {
	const { ctx, maxChars, fallbackName, outputPath, snapshotMeta } = options;
	const { summary, treeDiff } = options.assembly;
	const { causal } = options.providers;

	if (options.reanchorReason) summary.reanchorReason = options.reanchorReason;
	const hints = buildScanNextActionHints({ hasBaseline: options.baseline !== undefined, snapshotId: snapshotMeta.snapshotId, recorderActive: options.recorderActive, causal, treeDiff });
	if (hints.length) summary.nextActions = hints;
	const ledger = buildLedgerProjection(options);
	options.timings.renderMs = elapsedMs(options.renderStartedAt);
	const diagnostics = buildObserveDiagnostics(options, summary);
	const pageObservation = buildCanonicalPageObservation(options, summary, diagnostics);
	const details = buildResultDetails(options, diagnostics);
	let allocation: CommandPerceptionLedgerFrame["allocation"] | undefined;
	if (options.reanchorReason) {
		pageObservation.inline.reanchorReason = options.reanchorReason;
		pageObservation.artifact.reanchorReason = options.reanchorReason;
	}
	const result = await pageObservationResult({
		inline: pageObservation.inline,
		artifact: pageObservation.artifact,
		maxChars,
		outputPath,
		fallbackName,
		ctx,
		details,
		onAllocation: (value) => { allocation = value; },
	});
	recordLedgerProjection(options, ledger.frame, allocation);
	return result;
}
