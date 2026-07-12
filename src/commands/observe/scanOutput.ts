import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";
import type { PageFingerprint } from "../pageSignals.js";
import type { CommandFactGranularity } from "../resultTypes.js";
import { textCommandResult, type CommandResultContext } from "../commandRuntime.js";
import { isRecord } from "../../utils/params.js";
import { factsFromObservedEntities, stableRefsFromCommandFrames } from "./perceptionLedgerProjection.js";
import { elapsedMs, finalizedObserveTimings, type ObserveTimingMetrics } from "./timings.js";
import { legacyProjectionDetails, modeInferredDetails, scanCommandName } from "./renderCache.js";
import { buildObserveAbmlDetails, buildObserveArtifactProjection, buildPageObservation, buildScanNextActionHints, attachAbmlArtifactHints, type PageObservationProviderInput } from "./scanProjection.js";
import type { BaselineResolution } from "./baseline.js";
import type { ObserveMode, ObserveToolParams } from "./common.js";
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
type ArtifactProjection = ReturnType<typeof buildObserveArtifactProjection>;
type PageObservation = PageObservationBuild;

function axProviderStatus(abmlRead: CaptureResult["observation"]["abmlRead"]): PageObservationProviderInput["axStatus"] {
	if (abmlRead?.ok !== true) return undefined;
	const fusion = isRecord(abmlRead.data?.axFusion) ? abmlRead.data.axFusion : undefined;
	if (!fusion) return "skipped";
	const diagnostics = isRecord(abmlRead.data?.axDiagnostics) ? abmlRead.data.axDiagnostics : undefined;
	if (diagnostics?.snapshotGeometryUnavailable === true && Number(diagnostics.nodeCount || 0) === 0) return "degraded";
	if (fusion.degraded === true) return "degraded";
	if (Number(fusion.axEnriched || 0) > 0) return "ax-enriched";
	if (Number(fusion.axOnly || 0) > 0) return "ax-only";
	return "scan-backed";
}

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
	mode: Extract<ObserveMode, "scan" | "text">;
	ctx: CommandResultContext;
	tabs: unknown[];
	tabId: number | undefined;
	maxChars: number;
	fallbackName: string;
	outputPath: string | undefined;
	artifactAvailable: boolean;
	hasNavigation: boolean;
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
	axeRequested: boolean;
	readabilityRequested: boolean;
	providers: ProviderResult;
	capture: CaptureResult;
	assembly: AssemblyResult;
	granularityCeiling: Exclude<CommandFactGranularity, "omit"> | undefined;
	scanPageFingerprint: PageFingerprint | undefined;
	effectivePageFingerprint: PageFingerprint | undefined;
	detailLevel: string;
	paramsSignature: string;
	renderStartedAt: number;
};

function buildObserveDiagnostics(options: FinalizeScanObservationOptions, summary: Record<string, unknown>) {
	const { timings, data, providerFailures, axeRequested, readabilityRequested } = options;
	const { observation } = options.capture;
	const { axeDiagnostics, readability } = options.providers;
	const baseline = buildBaselineDiagnostics(options);
	const summaryFocus = isRecord(summary.focus) ? summary.focus : undefined;
	const truncation = isRecord(summaryFocus?.actionablesTruncation) ? summaryFocus.actionablesTruncation : undefined;
	const summaryWarnings = Array.isArray(summary.warnings) ? summary.warnings.filter((warning): warning is string => typeof warning === "string") : [];
	const warnings = [...baseline.warnings, ...summaryWarnings];
	const providerArtifacts = {
		...(axeDiagnostics.artifact ? { axe: axeDiagnostics.artifact } : {}),
		...(readability.artifact ? { readability: readability.artifact } : {}),
	};
	return {
		observeTimings: finalizedObserveTimings(timings, data, observation.abmlRead),
		...(axeRequested ? { axe: axeDiagnostics.summary } : {}),
		...(readabilityRequested ? { readability: readability.summary } : {}),
		...(observation.abmlRead?.ok === true && isRecord(observation.abmlRead.data?.axFusion) ? { axFusion: observation.abmlRead.data.axFusion } : {}),
		...(baseline.diagnostics ? { baseline: baseline.diagnostics } : {}),
		...(truncation?.actionablesTruncated === true ? { actionablesTruncated: true, actionablesScanned: truncation.actionablesScanned, actionablesReturned: truncation.actionablesReturned } : {}),
		...(providerFailures.length ? { providerFailures } : {}),
		...(Object.keys(providerArtifacts).length ? { providerArtifacts } : {}),
		...(warnings.length ? { warnings } : {}),
	};
}

function buildCanonicalPageObservation(
	options: FinalizeScanObservationOptions,
	summary: Record<string, unknown>,
	diagnostics: ReturnType<typeof buildObserveDiagnostics>,
): PageObservation | undefined {
	const { mode, params, content, data, tabs, bridge, snapshotMeta, artifactAvailable, outputPath, tabsRefreshDegraded, providerFailures, axeRequested, readabilityRequested } = options;
	if (mode !== "scan" || params.modeExplicit) return undefined;
	const { observation } = options.capture;
	const { envelopeEntities, attributedEntities, envelopeDiff, treeDiff } = options.assembly;
	const { causal, axeDiagnostics, readability } = options.providers;
	const axStatus = axProviderStatus(observation.abmlRead);
	return buildPageObservation({
		mode,
		canonical: true,
		summary,
		entities: envelopeEntities,
		content,
		url: data.page.url,
		tabs,
		activeTabId: bridge.defaultTabId,
		snapshot: snapshotMeta,
		diff: envelopeDiff,
		treeDiff,
		causal,
		artifactPath: artifactAvailable ? outputPath : undefined,
		abmlIntegrated: attributedEntities !== null,
		tabsRefreshDegraded,
		providerStatuses: {
			structure: observation.abmlRead?.ok === true ? "executed" : "failed",
			content: "scan-backed",
			text: "scan-backed",
			html: artifactAvailable ? "scan-backed" : "failed",
			evidence: artifactAvailable ? "scan-backed" : "failed",
			tabs: tabsRefreshDegraded ? "degraded" : "executed",
			...(axStatus ? { ax: axStatus } : {}),
			...(axeRequested ? { axe: axeDiagnostics.status } : {}),
			...(readabilityRequested ? { readability: readability.status } : {}),
		},
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
	const { mode, params, hasNavigation, tabs, bridge, scanMeta, scanPageFingerprint, reanchorReason } = options;
	const { observation } = options.capture;
	return {
		mode,
		modeInferred: modeInferredDetails(params),
		...(mode === "scan" && !params.modeExplicit ? { model: "PageObservation", canonical: true } : legacyProjectionDetails(params, mode)),
		sourceMode: "scan",
		sourceCommand: "scan_extract",
		...(hasNavigation ? { navigation: observation.navigationData } : {}),
		tabs_count: tabs.length,
		tabs,
		active_tab: bridge.defaultTabId,
		browserSessionId: bridge.browserSessionId,
		scan: scanMeta,
		abml: buildObserveAbmlDetails({ abmlRead: observation.abmlRead, diagnostics: diagnostics.observeTimings }),
		...(scanPageFingerprint ? { signals: { fingerprint: scanPageFingerprint } } : {}),
		...(reanchorReason ? { reanchorReason } : {}),
		diagnostics,
	};
}

function buildArtifactValue(options: FinalizeScanObservationOptions, artifact: ArtifactProjection) {
	const { hasNavigation, tabs, bridge, snapshotMeta } = options;
	const { observation, operation } = options.capture;
	const { envelopeDiff, treeDiff, artifactRelevance, causalBlock } = options.assembly;
	const { axeDiagnostics, readability } = options.providers;
	return {
		...observation.result,
		...(hasNavigation ? { navigation: observation.navigationData } : {}),
		tabs_count: tabs.length,
		tabs,
		active_tab: bridge.defaultTabId,
		browserSessionId: bridge.browserSessionId,
		operation,
		snapshot: snapshotMeta,
		...(envelopeDiff ? { diff: envelopeDiff } : {}),
		...(treeDiff ? { treeDiff } : {}),
		...(artifact.artifactRelations ? { relations: artifact.artifactRelations } : {}),
		...(artifact.artifactRelationGraph ? { relationGraph: artifact.artifactRelationGraph } : {}),
		...(artifact.artifactSnapshotProjection ? { snapshotProjection: artifact.artifactSnapshotProjection } : {}),
		...(artifact.artifactCollections?.length ? { collections: artifact.artifactCollections } : {}),
		...(artifact.artifactIdentityGraph ? { identityGraph: artifact.artifactIdentityGraph } : {}),
		...(artifactRelevance ? { relevance: artifactRelevance } : {}),
		...(axeDiagnostics.artifact ? { axe: axeDiagnostics.artifact } : {}),
		...(readability.artifact ? { readability: readability.artifact } : {}),
		...causalBlock,
		abml: observation.abmlRead?.ok === true ? { ...observation.abmlRead, diff: envelopeDiff, snapshotProjection: artifact.artifactSnapshotProjection, collections: artifact.artifactCollections, relationGraph: artifact.artifactRelationGraph } : observation.abmlRead,
	};
}

function buildLedgerProjection(options: FinalizeScanObservationOptions) {
	const { server, snapshotMeta } = options;
	const { attributedEntities } = options.assembly;
	const key = perceptionLedgerKey(pageIdentityFromUnknown(snapshotMeta));
	const facts = attributedEntities ? factsFromObservedEntities(attributedEntities) : undefined;
	const frame: CommandPerceptionLedgerFrame | undefined = key && facts
		? { key, snapshotId: snapshotMeta.snapshotId, capturedAt: snapshotMeta.capturedAt, facts }
		: undefined;
	const priorFrame = key && typeof server.getRecentPerceptionLedgerFrames === "function" ? server.getRecentPerceptionLedgerFrames(key, 1)[0] : undefined;
	return { frame, stableRefs: frame ? stableRefsFromCommandFrames(frame, priorFrame) : undefined };
}

function recordLedgerProjection(options: FinalizeScanObservationOptions, frame: CommandPerceptionLedgerFrame | undefined, allocation: CommandPerceptionLedgerFrame["allocation"] | undefined) {
	const { server, effectivePageFingerprint, mode, detailLevel, maxChars, paramsSignature, snapshotMeta } = options;
	if (!frame || typeof server.recordPerceptionLedgerFrame !== "function") return;
	server.recordPerceptionLedgerFrame({
		...frame,
		...(effectivePageFingerprint ? { pageFingerprint: effectivePageFingerprint } : {}),
		renderCache: { mode, detailLevel, maxChars, paramsSignature, renderedAt: snapshotMeta.capturedAt },
		...(allocation ? { allocation } : {}),
	});
}

export async function finalizeScanObservation(options: FinalizeScanObservationOptions) {
	const { resultParams, mode, ctx, content, maxChars, fallbackName, outputPath, hasNavigation, snapshotMeta, granularityCeiling } = options;
	const { operation } = options.capture;
	const { summary, envelopeEntities, envelopeDiff, treeDiff, artifactRelevance, causalBlock } = options.assembly;
	const { causal } = options.providers;

	attachAbmlArtifactHints(summary);
	if (options.reanchorReason) summary.reanchorReason = options.reanchorReason;
	const hints = buildScanNextActionHints({ hasBaseline: options.baseline !== undefined, snapshotId: snapshotMeta.snapshotId, recorderActive: options.recorderActive, causal, treeDiff });
	if (hints.length) summary.nextActions = hints;
	const ledger = buildLedgerProjection(options);
	options.timings.renderMs = elapsedMs(options.renderStartedAt);
	const diagnostics = buildObserveDiagnostics(options, summary);
	const pageObservation = buildCanonicalPageObservation(options, summary, diagnostics);
	const details = buildResultDetails(options, diagnostics);
	let allocation: CommandPerceptionLedgerFrame["allocation"] | undefined;
	if (pageObservation) {
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
	const artifact = buildObserveArtifactProjection({ summaryRecord: summary, summary, envelopeEntities, envelopeDiff, abmlTreeDiff: treeDiff, artifactRelevance, causalBlock, mode, hasNavigation });
	const artifactValue = buildArtifactValue(options, artifact);
	const result = await textCommandResult(content, resultParams, ctx, {
		commandName: "browser_observe",
		command: scanCommandName(mode, hasNavigation),
		maxChars,
		fallbackName,
		summary,
		details,
		operation,
		snapshot: snapshotMeta,
		granularityCeiling,
		stableRefs: ledger.stableRefs,
		onAllocation: (value) => { allocation = value; },
		entities: envelopeEntities,
		artifactValue,
	});
	recordLedgerProjection(options, ledger.frame, allocation);
	return result;
}
