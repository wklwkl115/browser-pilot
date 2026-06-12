import type { PerceptionLedgerFrame } from "../../abml/perceptionLedger.js";
import { isRecord } from "../../utils/records.js";
import type { PageFingerprint } from "../pageSignals.js";
import type { ObserveMode, ObserveToolParams } from "./scanRunner.js";

type RenderCache = NonNullable<PerceptionLedgerFrame["renderCache"]>;

export function sessionDeltaEnabled(params: ObserveToolParams): boolean {
	return params.fresh !== true && process.env.PI_BROWSER_SESSION_DELTA !== "0" && String(params.detailLevel || "summary") !== "full" && params.baseline === undefined;
}

export function modeInferredDetails(params: ObserveToolParams): ObserveToolParams["modeInferred"] {
	return params.modeInferred ?? null;
}

export function modeInferredSummary(params: ObserveToolParams): Record<string, unknown> {
	return params.modeInferred ? { modeInferred: params.modeInferred.mode } : {};
}

export function scanCommandName(mode: Extract<ObserveMode, "scan" | "text">, hasNavigation: boolean): string {
	if (hasNavigation) return mode === "text" ? "navigate+text" : "navigate+scan";
	return mode === "text" ? "scan.text" : "scan";
}

function observeCacheTtlMs(): number {
	const raw = process.env.PI_BROWSER_OBSERVE_CACHE_TTL_MS;
	if (raw === undefined) return 2_000;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2_000;
}

function observeRendererCacheMarker(): string {
	return process.env.PI_BROWSER_RENDERER === "ladder" ? "ladder" : "salience-v1";
}

function observeCostModelCacheMarker(): string {
	return process.env.PI_BROWSER_TOKEN_COST === "1" ? "token" : "byte";
}

function observeSessionDeltaCacheMarker(params: ObserveToolParams): string {
	return sessionDeltaEnabled(params) ? "on" : "off";
}

function relevanceEnabled(params: ObserveToolParams): boolean {
	return process.env.PI_BROWSER_RELEVANCE !== "0" && String(params.detailLevel || "summary") !== "full";
}

function observeIntent(params: ObserveToolParams): string | undefined {
	if (typeof params.intent === "string" && params.intent.trim()) return params.intent.trim();
	const nested = isRecord(params.params) ? params.params : undefined;
	return typeof nested?.intent === "string" && nested.intent.trim() ? nested.intent.trim() : undefined;
}

function observeRelevanceCacheMarker(params: ObserveToolParams): string {
	return relevanceEnabled(params) ? "on" : "off";
}

function observeRelevanceDebugCacheMarker(): string {
	return process.env.PI_BROWSER_RELEVANCE_DEBUG === "1" ? "on" : "off";
}

function observeMemoryCacheMarker(): string {
	return process.env.PI_BROWSER_MEMORY === "0" ? "off" : "on";
}

function observeMemoryAutoSurfaceCacheMarker(): string {
	return process.env["PI_BROWSER_MEMORY_AUTOSURFACE"] === "0" ? "off" : "on";
}

export function observeRenderParamsSignature(params: ObserveToolParams, mode: ObserveMode, detailLevel: string, maxChars: number, captureMaxChars: number): string {
	const maxNodes = Number(params.maxNodes);
	return JSON.stringify({
		mode,
		detailLevel,
		maxChars,
		captureMaxChars,
		renderer: observeRendererCacheMarker(),
		costModel: observeCostModelCacheMarker(),
		sessionDelta: observeSessionDeltaCacheMarker(params),
		relevance: observeRelevanceCacheMarker(params),
		relevanceDebug: observeRelevanceDebugCacheMarker(),
		memory: observeMemoryCacheMarker(),
		memoryAutoSurface: observeMemoryAutoSurfaceCacheMarker(),
		includeIframes: params.includeIframes !== false,
		...(Number.isFinite(maxNodes) ? { maxNodes } : {}),
		...(observeIntent(params) ? { intent: observeIntent(params) } : {}),
		...(typeof params.actionRef === "string" && params.actionRef ? { actionRef: params.actionRef } : {}),
	});
}

function pageFingerprintMatches(a: PageFingerprint, b: PageFingerprint): boolean {
	return a.changeSeq === b.changeSeq
		&& (a.url ?? "") === (b.url ?? "")
		&& (a.title ?? "") === (b.title ?? "")
		&& (a.readyState ?? "") === (b.readyState ?? "")
		&& (a.visibleCount ?? -1) === (b.visibleCount ?? -1)
		&& (a.interactiveCount ?? -1) === (b.interactiveCount ?? -1);
}

export function renderCacheMatches(frame: PerceptionLedgerFrame | undefined, mode: ObserveMode, detailLevel: string, maxChars: number, paramsSignature: string, fingerprint: PageFingerprint | undefined, now = Date.now(), ttlMs = observeCacheTtlMs()): frame is PerceptionLedgerFrame & { renderCache: RenderCache } {
	if (!frame?.pageFingerprint || !frame.renderCache || !fingerprint) return false;
	if (ttlMs <= 0 || typeof frame.renderCache.renderedAt !== "number" || now - frame.renderCache.renderedAt > ttlMs) return false;
	return pageFingerprintMatches(frame.pageFingerprint, fingerprint)
		&& frame.renderCache.mode === mode
		&& frame.renderCache.detailLevel === detailLevel
		&& frame.renderCache.maxChars === maxChars
		&& frame.renderCache.paramsSignature === paramsSignature;
}

export function stripCachedObserveMeta(record: Record<string, unknown>): Record<string, unknown> {
	const { operation: _operation, snapshot: _snapshot, cache: _cache, fromCache: _fromCache, saved: _saved, ...rest } = record;
	return rest;
}

export function cachedEnvelopeFromArtifact(value: unknown): Record<string, unknown> | undefined {
	const record = isRecord(value) ? value : undefined;
	if (!record) return undefined;
	if (isRecord(record.envelope)) return stripCachedObserveMeta(record.envelope as Record<string, unknown>);
	if (record.tool === "browser_observe") return stripCachedObserveMeta(record);
	return undefined;
}
