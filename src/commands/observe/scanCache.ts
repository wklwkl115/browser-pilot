import { readFile } from "node:fs/promises";
import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame, CommandPerceptionLedgerKey } from "../../ports/BrowserCommandRuntimePort.js";
import type { BrowserTextCommandResult } from "../../utils/toolResult.js";
import { parseJsonOrThrow, stableJson, truncateText } from "../../utils/json.js";
import { isRecord } from "../../utils/params.js";
import { readHookRecorderSeq, readNetworkRecorderSeq, type PageFingerprint } from "../pageSignals.js";
import { withTrackedOperation, type CommandOnUpdate, type CommandResultContext } from "../commandRuntime.js";
import { consumeMemoryProfileDiagnostics } from "./memoryAugmentation.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { currentObserveSnapshotMeta, type ObserveMode, type ObserveToolParams } from "./common.js";
import { cachedEnvelopeFromArtifact, legacyProjectionDetails, legacyProjectionSummary, modeInferredDetails, observeCacheTtlMs, renderCacheMatches } from "./renderCache.js";

export function cachedObserveResultFromEnvelope(envelope: Record<string, unknown>, details: Record<string, unknown>, maxChars: number): BrowserTextCommandResult {
	const rendered = stableJson(envelope);
	const preview = truncateText(rendered, maxChars);
	return {
		content: [{ type: "text", text: preview.text }],
		details: { ...details, truncated: preview.truncated, originalLength: preview.originalLength },
	};
}

export async function tryRenderCacheHit(options: {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	mode: Extract<ObserveMode, "scan" | "text">;
	detailLevel: string;
	maxChars: number;
	paramsSignature: string;
	pageFingerprint: PageFingerprint | undefined;
	ledgerFrame: CommandPerceptionLedgerFrame | undefined;
	plannedLedgerKey: CommandPerceptionLedgerKey | undefined;
	effectiveTabId: number | undefined;
	timeoutMs: number;
	resultParams: ObserveToolParams;
	outputPath: string | undefined;
	browserSessionId: string | undefined;
	ctx: CommandResultContext;
	onUpdate?: CommandOnUpdate;
	observeTimings: ObserveTimingMetrics;
}): Promise<BrowserTextCommandResult | undefined> {
	const { server, params, mode, detailLevel, maxChars, paramsSignature, pageFingerprint, ledgerFrame, plannedLedgerKey, effectiveTabId, timeoutMs, resultParams, outputPath, browserSessionId, ctx, onUpdate, observeTimings } = options;
	if (!ledgerFrame || !pageFingerprint || !renderCacheMatches(ledgerFrame, mode, detailLevel, maxChars, paramsSignature, pageFingerprint) || typeof server.getObservationSnapshot !== "function") return undefined;

	const priorPath = server.getObservationSnapshot(ledgerFrame.snapshotId)?.saved?.path;
	if (!priorPath) return undefined;
	try {
		const cachedArtifact = parseJsonOrThrow(await readFile(priorPath, "utf8"), "browser_observe cached snapshot artifact");
		const cachedEnvelope = cachedEnvelopeFromArtifact(cachedArtifact);
		if (!cachedEnvelope) return undefined;

		const recorderStartedAt = Date.now();
		const [networkState, hookState] = await Promise.all([
			readNetworkRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs }),
			readHookRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId: effectiveTabId, timeoutMs }),
		]);
		observeTimings.recorderMs = elapsedMs(recorderStartedAt);
		addBridgeRoundTrips(observeTimings, 2);
		const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, pageFingerprint.url, networkState.lastSeq, hookState.lastSeq);
		const { result } = await withTrackedOperation(server, {
			commandName: "browser_observe",
			command: mode === "text" ? "scan.text" : "scan",
			browserSessionId,
			tabId: effectiveTabId,
			phase: "running",
			progress: 10,
			queueDepth: server.queueDepth(browserSessionId, effectiveTabId),
			leaseOwnerHash: server.leaseOwnerHash(browserSessionId, effectiveTabId),
			snapshotId: snapshotMeta.snapshotId,
			sourceMode: "scan",
		}, onUpdate, async (handle): Promise<BrowserTextCommandResult> => {
			await handle.update({ progress: 100, details: { fromCache: true, changeSeq: pageFingerprint.changeSeq } });
			const isCanonical = mode === "scan" && !params.modeExplicit;
			const cacheMeta = { reason: "content-fingerprint-unchanged" as const, changeSeq: pageFingerprint.changeSeq, priorSnapshotId: ledgerFrame.snapshotId };
			const memoryProfileWarnings = consumeMemoryProfileDiagnostics(ctx?.cwd);
			const cachedSummary = isRecord(cachedEnvelope.summary) ? { ...cachedEnvelope.summary } as Record<string, unknown> : {};
			const cachedPageObservation = isRecord(cachedSummary.pageObservation) ? { ...cachedSummary.pageObservation } as Record<string, unknown> : undefined;
			if (cachedPageObservation) {
				const diagnostics = isRecord(cachedPageObservation.diagnostics) ? cachedPageObservation.diagnostics as Record<string, unknown> : {};
				cachedPageObservation.snapshot = snapshotMeta;
				cachedPageObservation.diagnostics = { ...diagnostics, cache: cacheMeta, fromCache: true };
			}
			const summary = {
				...cachedSummary,
				...(cachedPageObservation ? { pageObservation: cachedPageObservation } : {}),
				fromCache: true,
				cache: cacheMeta,
				priorSnapshotId: ledgerFrame.snapshotId,
				...(isCanonical ? {} : legacyProjectionSummary(params, mode)),
			};
			const value = {
				...cachedEnvelope,
				fromCache: true,
				cache: cacheMeta,
				delta: "session" as const,
				baselineSnapshotId: ledgerFrame.snapshotId,
				operation: { ...handle.operation, snapshotId: snapshotMeta.snapshotId },
				snapshot: snapshotMeta,
				summary,
			};
			return cachedObserveResultFromEnvelope(value, {
				mode,
				modeInferred: modeInferredDetails(params),
				...(isCanonical ? { model: "PageObservation", canonical: true } : legacyProjectionDetails(params, mode)),
				sourceMode: "scan",
				sourceCommand: "content.fingerprint",
				fromCache: true,
				priorSnapshotId: ledgerFrame.snapshotId,
				renderCache: { hit: true, ttlMs: observeCacheTtlMs(), ...cacheMeta },
				...(memoryProfileWarnings.length ? { memory: { warnings: memoryProfileWarnings } } : {}),
			}, maxChars);
		});

		if (plannedLedgerKey && typeof server.recordPerceptionLedgerFrame === "function") {
			server.recordPerceptionLedgerFrame({
				key: plannedLedgerKey,
				snapshotId: snapshotMeta.snapshotId,
				capturedAt: snapshotMeta.capturedAt,
				facts: ledgerFrame.facts,
				pageFingerprint,
				renderCache: { mode, detailLevel, maxChars, paramsSignature, renderedAt: ledgerFrame.renderCache.renderedAt },
				allocation: ledgerFrame.allocation,
			});
		}
		return result;
	} catch {
		// Cache misses degrade to a normal observe; the fresh path repairs ledger state.
		return undefined;
	}
}
