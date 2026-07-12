import { readFile } from "node:fs/promises";
import type { BrowserCommandRuntimePort, CommandPerceptionLedgerFrame, CommandPerceptionLedgerKey } from "../../ports/BrowserCommandRuntimePort.js";
import type { BrowserTextCommandResult } from "../../utils/toolResult.js";
import { parseJsonOrThrow } from "../../utils/json.js";
import { isRecord } from "../../utils/params.js";
import type { PageFingerprint } from "../pageSignals.js";
import { withTrackedOperation, type CommandOnUpdate } from "../commandRuntime.js";
import type { ObserveTimingMetrics } from "./timings.js";
import { currentObserveSnapshotMeta, type ObserveMode, type ObserveToolParams } from "./common.js";
import { cachedEnvelopeFromArtifact, modeInferredDetails, observeCacheTtlMs, renderCacheMatches } from "./renderCache.js";
import { PAGE_OBSERVATION_SCHEMA_V3, type PageObservationV3 } from "../../kernels/abml/pageObservation.js";
import { renderWithExactCost } from "../../kernels/evidence/cost.js";
import { pageObservationResult } from "../resultMiddleware.js";

export function cachedObserveResultFromEnvelope(envelope: Record<string, unknown>, details: Record<string, unknown>, maxChars: number): BrowserTextCommandResult {
	const observation = envelope as unknown as PageObservationV3;
	const exact = renderWithExactCost(observation, (current, cost) => ({ ...current, limits: { ...current.limits, cost } }));
	return {
		content: [{ type: "text", text: exact.rendered }],
		details: { ...details, truncated: exact.rendered.length > maxChars, originalLength: exact.rendered.length },
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
	onUpdate?: CommandOnUpdate;
	observeTimings: ObserveTimingMetrics;
}): Promise<BrowserTextCommandResult | undefined> {
	const { server, params, mode, detailLevel, maxChars, paramsSignature, pageFingerprint, ledgerFrame, plannedLedgerKey, effectiveTabId, resultParams, outputPath, browserSessionId, onUpdate } = options;
	if (mode !== "scan" || params.modeExplicit) return undefined;
	if (!ledgerFrame || !pageFingerprint || !renderCacheMatches(ledgerFrame, mode, detailLevel, maxChars, paramsSignature, pageFingerprint) || typeof server.getObservationSnapshot !== "function") return undefined;

	const priorPath = server.getObservationSnapshot(ledgerFrame.snapshotId)?.saved?.path;
	if (!priorPath) return undefined;
	try {
		const cachedArtifact = parseJsonOrThrow(await readFile(priorPath, "utf8"), "browser_observe cached snapshot artifact");
		const cachedEnvelope = cachedEnvelopeFromArtifact(cachedArtifact);
		if (!cachedEnvelope) return undefined;

		const networkState = server.getKnownRecorderState?.("network", params.browserSessionId, effectiveTabId) ?? { active: false };
		const hookState = server.getKnownRecorderState?.("hook", params.browserSessionId, effectiveTabId) ?? { active: false };
		const snapshotMeta = currentObserveSnapshotMeta(server, resultParams, "scan", outputPath, pageFingerprint.url, networkState.lastSeq, hookState.lastSeq);
		const { result } = await withTrackedOperation(server, {
			commandName: "browser_observe",
			command: "scan",
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
			const cacheMeta = { reason: "content-fingerprint-unchanged" as const, changeSeq: pageFingerprint.changeSeq, priorSnapshotId: ledgerFrame.snapshotId };
			const prior = cachedEnvelope as unknown as PageObservationV3;
			if (prior.schema !== PAGE_OBSERVATION_SCHEMA_V3) throw new Error("cached observation contract mismatch");
			const diagnostics = isRecord(prior.diagnostics) ? prior.diagnostics : {};
			const { saved: _saved, artifact_hints: _hints, ...rest } = prior;
			const value: PageObservationV3 = {
				...rest,
				target: { ...prior.target, browserSessionId: snapshotMeta.browserSessionId, tabId: snapshotMeta.tabId, targetGeneration: snapshotMeta.targetGeneration, pageEpoch: snapshotMeta.pageEpoch, url: pageFingerprint.url },
				snapshot: snapshotMeta,
				delta: "session",
				baselineSnapshotId: ledgerFrame.snapshotId,
				providers: { ...prior.providers, cache: { planned: true, status: "executed", reason: cacheMeta.reason } },
				diagnostics: { ...diagnostics, cache: cacheMeta, fromCache: true },
				limits: { ...prior.limits, budgetChars: maxChars, cost: { chars: 0, bytes: 0, estimatedTokens: 0 } },
			};
			return await pageObservationResult({ inline: value, artifact: value, maxChars, outputPath, fallbackName: `observe-cache-${snapshotMeta.snapshotId}.json`, details: {
				mode,
				modeInferred: modeInferredDetails(params),
				model: "PageObservation",
				canonical: true,
				sourceMode: "scan",
				sourceCommand: "content.fingerprint",
				fromCache: true,
				priorSnapshotId: ledgerFrame.snapshotId,
				renderCache: { hit: true, ttlMs: observeCacheTtlMs(), ...cacheMeta },
			} });
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
