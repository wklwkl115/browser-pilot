import type { CommandPerceptionLedgerFrame } from "../../ports/BrowserCommandRuntimePort.js";
import { isRecord } from "../../utils/records.js";
import type { PageFingerprint } from "../pageSignals.js";
import type { ObserveMode, ObserveToolParams } from "./common.js";

type RenderCache = NonNullable<CommandPerceptionLedgerFrame["renderCache"]>;

export function sessionDeltaEnabled(params: ObserveToolParams): boolean {
	return params.fresh !== true && process.env.BROWSER_PILOT_SESSION_DELTA !== "0" && String(params.detailLevel || "summary") !== "full" && params.baseline === undefined;
}

export function modeInferredDetails(params: ObserveToolParams): ObserveToolParams["modeInferred"] {
	return params.modeInferred ?? null;
}

export function modeInferredSummary(params: ObserveToolParams): Record<string, unknown> {
	return params.modeInferred ? { modeInferred: params.modeInferred.mode } : {};
}

export function legacyProjectionDetails(params: ObserveToolParams, _mode: ObserveMode): Record<string, unknown> {
	return params.modeExplicit ? { projection: "legacy", canonical: false, modeExplicit: true, semantics: ["legacy", "debug", "projection"] } : {};
}

export function legacyProjectionSummary(params: ObserveToolParams, _mode: ObserveMode): Record<string, unknown> {
	return params.modeExplicit ? { projection: "legacy", canonical: false, modeExplicit: true, semantics: ["legacy", "debug", "projection"] } : {};
}

export function scanCommandName(mode: Extract<ObserveMode, "scan" | "text">, hasNavigation: boolean): string {
	if (hasNavigation) return mode === "text" ? "navigate+text" : "navigate+scan";
	return mode === "text" ? "scan.text" : "scan";
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

function observeRendererCacheMarker(): string {
	return process.env.BROWSER_PILOT_RENDERER === "ladder" ? "ladder" : "salience-v1";
}

function observeCostModelCacheMarker(): string {
	return process.env.BROWSER_PILOT_TOKEN_COST === "1" ? "token" : "byte";
}

function observeSessionDeltaCacheMarker(params: ObserveToolParams): string {
	return sessionDeltaEnabled(params) ? "on" : "off";
}

function relevanceEnabled(params: ObserveToolParams): boolean {
	return process.env.BROWSER_PILOT_RELEVANCE !== "0" && String(params.detailLevel || "summary") !== "full";
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
	return process.env.BROWSER_PILOT_RELEVANCE_DEBUG === "1" ? "on" : "off";
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
		standingPerception: observeStandingPerceptionCacheMarker(),
		relevance: observeRelevanceCacheMarker(params),
		relevanceDebug: observeRelevanceDebugCacheMarker(),
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

function dirtyWindowClean(fingerprint: PageFingerprint): boolean {
	const dirty = fingerprint.dirty;
	return !!dirty && dirty.overflow !== true && dirty.roots.length === 0;
}

export function renderCacheMatches(frame: CommandPerceptionLedgerFrame | undefined, mode: ObserveMode, detailLevel: string, maxChars: number, paramsSignature: string, fingerprint: PageFingerprint | undefined, now = Date.now(), ttlMs = observeCacheTtlMs()): frame is CommandPerceptionLedgerFrame & { renderCache: RenderCache } {
	if (!frame?.pageFingerprint || !frame.renderCache || !fingerprint) return false;
	if (ttlMs <= 0 || typeof frame.renderCache.renderedAt !== "number") return false;
	const withinTtl = now - frame.renderCache.renderedAt <= ttlMs;
	if (!withinTtl && !(standingPerceptionEnabled() && dirtyWindowClean(fingerprint))) return false;
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

function canonicalCachedEnvelope(record: Record<string, unknown>): Record<string, unknown> | undefined {
	const envelope = isRecord(record.envelope) ? record.envelope as Record<string, unknown> : undefined;
	if (!envelope) return undefined;
	return stripCachedObserveMeta(envelope);
}

export function cachedEnvelopeFromArtifact(value: unknown): Record<string, unknown> | undefined {
	const record = isRecord(value) ? value : undefined;
	if (!record) return undefined;
	return canonicalCachedEnvelope(record);
}
