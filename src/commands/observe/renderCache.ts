import type { CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";
import type { PageFingerprint } from "../pageSignals.js";
import type { ObserveToolParams } from "./common.js";
import { isPageObservationV3, type PageObservationV3 } from "../../kernels/abml/pageObservation.js";
import { observeIntent, relevanceEnabled } from "./relevanceFusion.js";

type RenderCache = NonNullable<CommandPerceptionLedgerFrame["renderCache"]>;

export function sessionDeltaEnabled(params: ObserveToolParams): boolean {
	return params.fresh !== true && process.env.BROWSER_PILOT_SESSION_DELTA !== "0" && params.baseline === undefined;
}

export function observeCacheTtlMs(): number {
	const raw = process.env.BROWSER_PILOT_OBSERVE_CACHE_TTL_MS;
	if (raw === undefined) return 2_000;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2_000;
}

function standingPerceptionEnabled(): boolean {
	return process.env.BROWSER_PILOT_STANDING_PERCEPTION !== "0";
}

function observeStandingPerceptionCacheMarker(): string {
	return standingPerceptionEnabled() ? "on" : "off";
}

function observeSessionDeltaCacheMarker(params: ObserveToolParams): string {
	return sessionDeltaEnabled(params) ? "on" : "off";
}

function observeRelevanceCacheMarker(): string {
	return relevanceEnabled() ? "on" : "off";
}

export function observeRenderParamsSignature(params: ObserveToolParams): string {
	return JSON.stringify({
		sessionDelta: observeSessionDeltaCacheMarker(params),
		standingPerception: observeStandingPerceptionCacheMarker(),
		relevance: observeRelevanceCacheMarker(),
		...(observeIntent(params) ? { intent: observeIntent(params) } : {}),
		...(typeof params.actionRef === "string" && params.actionRef ? { actionRef: params.actionRef } : {}),
	});
}

function optionalTextMatches(a: string | undefined, b: string | undefined): boolean {
	return (a ?? "") === (b ?? "");
}

function optionalCountMatches(a: number | undefined, b: number | undefined): boolean {
	return (a ?? -1) === (b ?? -1);
}

function pageDocumentFingerprintMatches(a: PageFingerprint, b: PageFingerprint): boolean {
	return optionalTextMatches(a.pageEpoch, b.pageEpoch)
		&& optionalTextMatches(a.documentId, b.documentId)
		&& optionalTextMatches(a.url, b.url)
		&& optionalTextMatches(a.title, b.title);
}

function pageContentFingerprintMatches(a: PageFingerprint, b: PageFingerprint): boolean {
	return optionalTextMatches(a.readyState, b.readyState)
		&& optionalCountMatches(a.visibleCount, b.visibleCount)
		&& optionalCountMatches(a.interactiveCount, b.interactiveCount);
}

function pageFingerprintMatches(a: PageFingerprint, b: PageFingerprint): boolean {
	return a.changeSeq === b.changeSeq
		&& pageDocumentFingerprintMatches(a, b)
		&& pageContentFingerprintMatches(a, b);
}

function dirtyWindowClean(fingerprint: PageFingerprint): boolean {
	const dirty = fingerprint.dirty;
	return !!dirty && dirty.overflow !== true && dirty.roots.length === 0;
}

export function renderCacheMatches(frame: CommandPerceptionLedgerFrame | undefined, paramsSignature: string, fingerprint: PageFingerprint | undefined, now = Date.now(), ttlMs = observeCacheTtlMs()): frame is CommandPerceptionLedgerFrame & { renderCache: RenderCache } {
	if (!frame?.pageFingerprint || !frame.renderCache || !fingerprint) return false;
	if (ttlMs <= 0 || typeof frame.renderCache.renderedAt !== "number") return false;
	const withinTtl = now - frame.renderCache.renderedAt <= ttlMs;
	if (!withinTtl && !(standingPerceptionEnabled() && dirtyWindowClean(fingerprint))) return false;
	return pageFingerprintMatches(frame.pageFingerprint, fingerprint)
		&& frame.renderCache.paramsSignature === paramsSignature;
}

export function cachedEnvelopeFromArtifact(value: unknown): PageObservationV3 | undefined {
	return isPageObservationV3(value) ? value : undefined;
}
