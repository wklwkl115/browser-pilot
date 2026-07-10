import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { buildCausalEvents, buildCausalSummary, causalUnavailable, type CausalSummary } from "../../kernels/abml/causal.js";
import { queryHookDelta, queryNetworkDelta, readHookRecorderSeq, readNetworkRecorderSeq } from "../pageSignals.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { runAxeDiagnostics } from "./axeDiagnosticsRunner.js";
import { runReadability } from "./readabilityRunner.js";
import type { BaselineResolution } from "./baseline.js";
import type { ObserveToolParams } from "./common.js";

const DEFAULT_AXE_DIAGNOSTICS_TIMEOUT_MS = 4_000;
const DEFAULT_READABILITY_PROVIDER_TIMEOUT_MS = 3_000;

async function buildObserveCausal(server: BrowserCommandRuntimePort, params: ObserveToolParams, recorderState: { active: boolean }, baselineNetworkSeq: number | undefined, tabId: number | undefined, timeoutMs: number): Promise<CausalSummary> {
	if (!recorderState.active) return causalUnavailable("network recorder not active — start via browser_network start");
	if (baselineNetworkSeq === undefined) return causalUnavailable("baseline has no network seq high-water mark — capture a baseline observation after browser_network start");
	try {
		const items = await queryNetworkDelta(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs, sinceSeq: baselineNetworkSeq });
		return buildCausalSummary(items, baselineNetworkSeq);
	} catch {
		return causalUnavailable("network recorder delta query failed");
	}
}

async function readProviderRecorderStates(server: BrowserCommandRuntimePort, params: ObserveToolParams, tabId: number | undefined, timeoutMs: number, timings: ObserveTimingMetrics) {
	const startedAt = Date.now();
	const [recorderState, hookState] = await Promise.all([
		readNetworkRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs }),
		readHookRecorderSeq(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs }),
	]);
	timings.recorderMs = elapsedMs(startedAt);
	addBridgeRoundTrips(timings, 2);
	return { recorderState, hookState };
}

type ObserveProvidersOptions = {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	tabId: number | undefined;
	rawTargetRef: unknown;
	timeoutMs: number;
	baseline: BaselineResolution | undefined;
	axeRequested: boolean;
	readabilityRequested: boolean;
	artifactPath: string | undefined;
	timings: ObserveTimingMetrics;
};

async function runCausalProvider(options: ObserveProvidersOptions, recorderState: { active: boolean }, hookState: { active: boolean }) {
	const { server, params, tabId, timeoutMs, baseline, timings } = options;
	if (!baseline) return undefined;
	const startedAt = Date.now();
	let causal = await buildObserveCausal(server, params, recorderState, baseline.networkSeq, tabId, timeoutMs);
	timings.causalMs = elapsedMs(startedAt);
	addBridgeRoundTrips(timings, 1);
	if ("requests" in causal && hookState.active && baseline.hookSeq !== undefined) {
		try {
			const startedAt = Date.now();
			const events = buildCausalEvents(await queryHookDelta(server, { browserSessionId: params.browserSessionId, tabId, timeoutMs, sinceSeq: baseline.hookSeq }), baseline.hookSeq);
			timings.eventCausalMs = elapsedMs(startedAt);
			addBridgeRoundTrips(timings, 1);
			if (events.events.length) causal = { ...causal, ...events };
		} catch {
			// Event evidence is additive and cannot fail the structural observation.
		}
	}
	return causal;
}

async function runAxeProvider(options: ObserveProvidersOptions, providerTabId: number | string | undefined, nestedParams: Record<string, unknown> | undefined) {
	const { server, params, axeRequested, artifactPath, timings } = options;
	const axeStartedAt = Date.now();
	const axeDiagnostics = await runAxeDiagnostics(server, {
		requested: axeRequested,
		browserSessionId: params.browserSessionId,
		tabId: providerTabId,
		timeoutMs: Math.min(DEFAULT_AXE_DIAGNOSTICS_TIMEOUT_MS, Math.max(500, Math.floor((params.timeoutMs ?? DEFAULT_AXE_DIAGNOSTICS_TIMEOUT_MS) / 2))),
		artifactPath,
		maxResults: typeof nestedParams?.axeMaxResults === "number" ? nestedParams.axeMaxResults : undefined,
	});
	if (axeRequested) {
		timings.axeMs = elapsedMs(axeStartedAt);
		addBridgeRoundTrips(timings, 1);
	}
	return axeDiagnostics;
}

async function runReadabilityProvider(options: ObserveProvidersOptions, providerTabId: number | string | undefined, nestedParams: Record<string, unknown> | undefined) {
	const { server, params, readabilityRequested, artifactPath, timings } = options;
	const readabilityStartedAt = Date.now();
	const readability = await runReadability(server, {
		requested: readabilityRequested,
		browserSessionId: params.browserSessionId,
		tabId: providerTabId,
		timeoutMs: Math.min(DEFAULT_READABILITY_PROVIDER_TIMEOUT_MS, Math.max(500, Math.floor((params.timeoutMs ?? DEFAULT_READABILITY_PROVIDER_TIMEOUT_MS) / 2))),
		artifactPath,
		maxInlineChars: typeof nestedParams?.readabilityMaxInlineChars === "number" ? nestedParams.readabilityMaxInlineChars : undefined,
		maxContentChars: typeof nestedParams?.readabilityMaxContentChars === "number" ? nestedParams.readabilityMaxContentChars : undefined,
		maxElemsToParse: typeof nestedParams?.readabilityMaxElemsToParse === "number" ? nestedParams.readabilityMaxElemsToParse : undefined,
	});
	if (readabilityRequested) {
		timings.readabilityMs = elapsedMs(readabilityStartedAt);
		addBridgeRoundTrips(timings, 1);
	}
	return readability;
}

export async function runObserveProviders(options: ObserveProvidersOptions) {
	const { server, params, tabId, rawTargetRef, timeoutMs, timings } = options;
	const { recorderState, hookState } = await readProviderRecorderStates(server, params, tabId, timeoutMs, timings);
	const causal = await runCausalProvider(options, recorderState, hookState);
	const providerTabId = typeof rawTargetRef === "number" || typeof rawTargetRef === "string" ? rawTargetRef : undefined;
	const nestedParams = params.params && typeof params.params === "object" && !Array.isArray(params.params) ? params.params as Record<string, unknown> : undefined;
	const axeDiagnostics = await runAxeProvider(options, providerTabId, nestedParams);
	const readability = await runReadabilityProvider(options, providerTabId, nestedParams);
	return { causal, axeDiagnostics, readability, recorderState, hookState };
}
