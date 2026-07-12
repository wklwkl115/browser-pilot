import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { buildCausalEvents, buildCausalSummary, causalUnavailable, type CausalSummary } from "../../kernels/abml/causal.js";
import { queryHookDelta, queryNetworkDelta } from "../pageSignals.js";
import { addBridgeRoundTrips, elapsedMs, type ObserveTimingMetrics } from "./timings.js";
import { runAxeDiagnostics } from "./axeDiagnosticsRunner.js";
import { runReadability } from "./readabilityRunner.js";
import type { BaselineResolution } from "./baseline.js";
import type { ObserveToolParams } from "./common.js";
import { buildObserveProviderPlan } from "../../kernels/abml/observeProviderPlan.js";
import type { ObserveProviderPlan, RecorderKnowledge } from "../../kernels/abml/observeProviderPlan.js";
import type { ProviderExecutionItem, ProviderExecutionReport, ProviderExecutionStatus } from "../../kernels/abml/pageObservation.js";
import { jsonCost } from "../../kernels/evidence/cost.js";
import type { BrowserBridgeExecutionResult } from "../../ports/BrowserRuntimeTypes.js";
import { isRecord } from "../../utils/records.js";

type ObserveProvidersOptions = {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	tabId: number | undefined;
	rawTargetRef: unknown;
	timeoutMs: number;
	startedAt: number;
	deadlineAt: number;
	baseline: BaselineResolution | undefined;
	axeRequested: boolean;
	readabilityRequested: boolean;
	outputBudgetChars: number;
	artifactPath: string | undefined;
	timings: ObserveTimingMetrics;
};

type RecorderState = { active: boolean; lastSeq?: number };

function recorderKnowledge(state: RecorderState | undefined): RecorderKnowledge {
	return state ? state.active ? "active" : "inactive" : "unknown";
}

function recorderHighWater(value: Record<string, unknown>): number | undefined {
	const candidate = value.lastSeq ?? value.last_seq ?? value.seq ?? value.eventSeq ?? value.event_seq;
	const number = Number(candidate);
	return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function recorderStatus(value: unknown, kind: "network" | "hook"): RecorderState | undefined {
	const response = isRecord(value) ? value : undefined;
	if (!response) return undefined;
	const code = String(response.error_code ?? response.code ?? "");
	if (response.ok === false) return /NO_SESSION|NOT_INSTALLED|INACTIVE|STOPPED/.test(code) ? { active: false } : undefined;
	const data = isRecord(response.data) ? response.data : response;
	const lastSeq = recorderHighWater(data);
	const state = typeof data.state === "string" ? data.state : undefined;
	const active = typeof data.active === "boolean"
		? data.active
		: state ? !/uninstalled|stopped|inactive/i.test(state)
			: kind === "hook" ? lastSeq !== undefined : true;
	return { active, ...(lastSeq !== undefined ? { lastSeq } : {}) };
}

function batchResults(result: BrowserBridgeExecutionResult): unknown[] {
	const root = result as unknown as Record<string, unknown>;
	if (Array.isArray(root.results)) return root.results;
	const data = isRecord(result.data) ? result.data : undefined;
	return Array.isArray(data?.results) ? data.results : [];
}

async function probeRecorderStates(options: ObserveProvidersOptions, timeoutMs: number, network: RecorderState | undefined, hook: RecorderState | undefined): Promise<{ network?: RecorderState; hook?: RecorderState; bridgeRoundTrips: number }> {
	const commands: Array<{ cmd: "network.status" | "hook.status" }> = [];
	const indexes: Array<"network" | "hook"> = [];
	if (options.baseline?.networkSeq !== undefined && !network) { commands.push({ cmd: "network.status" }); indexes.push("network"); }
	if (options.baseline?.hookSeq !== undefined && !hook) { commands.push({ cmd: "hook.status" }); indexes.push("hook"); }
	if (!commands.length || timeoutMs <= 0) return { network, hook, bridgeRoundTrips: 0 };
	try {
		const result = await options.server.sendCommand({ cmd: "batch", commands }, { browserSessionId: options.params.browserSessionId, tabId: options.tabId, timeoutMs });
		const results = batchResults(result);
		let nextNetwork = network;
		let nextHook = hook;
		for (let index = 0; index < indexes.length; index += 1) {
			const kind = indexes[index];
			const state = recorderStatus(results[index], kind);
			if (!state) continue;
			options.server.recordKnownRecorderState?.(kind, options.params.browserSessionId, options.tabId, state);
			if (kind === "network") nextNetwork = state;
			else nextHook = state;
		}
		return { network: nextNetwork, hook: nextHook, bridgeRoundTrips: 1 };
	} catch {
		return { network, hook, bridgeRoundTrips: 1 };
	}
}

function providerReportItem(input: {
	planned: boolean;
	status: ProviderExecutionStatus;
	reason?: string;
	reservedMs: number;
	actualMs: number;
	bridgeRoundTrips: number;
	value: unknown;
}): ProviderExecutionItem {
	return {
		planned: input.planned,
		status: input.status,
		...(input.reason ? { reason: input.reason } : {}),
		reservedMs: input.reservedMs,
		actualMs: input.actualMs,
		bridgeRoundTrips: input.bridgeRoundTrips,
		cost: jsonCost(input.value),
	};
}

function causalNetworkPreflight(network: RecorderState | undefined, baselineNetworkSeq: number | undefined, remainingMs: number): CausalSummary | undefined {
	if (network?.active === false) return causalUnavailable("network recorder is known inactive");
	if (baselineNetworkSeq === undefined) return causalUnavailable("baseline has no network recorder high-water mark");
	if (!network) return causalUnavailable("network recorder status is unavailable");
	if (remainingMs <= 0) return causalUnavailable("causal provider deadline exhausted");
	return undefined;
}

async function queryCausalNetworkDelta(
	options: ObserveProvidersOptions,
	baselineNetworkSeq: number | undefined,
	knownNetwork: RecorderState | undefined,
	remainingMs: () => number,
): Promise<{ causal: CausalSummary; network?: RecorderState; bridgeRoundTrips: number }> {
	const preflight = causalNetworkPreflight(knownNetwork, baselineNetworkSeq, remainingMs());
	if (preflight || baselineNetworkSeq === undefined || !knownNetwork) {
		return { causal: preflight ?? causalUnavailable("causal provider preflight failed"), network: knownNetwork, bridgeRoundTrips: 0 };
	}
	try {
		const delta = await queryNetworkDelta(options.server, { browserSessionId: options.params.browserSessionId, tabId: options.tabId, timeoutMs: remainingMs(), sinceSeq: baselineNetworkSeq });
		const network = { active: delta.active, ...(delta.lastSeq !== undefined ? { lastSeq: delta.lastSeq } : knownNetwork.lastSeq !== undefined ? { lastSeq: knownNetwork.lastSeq } : {}) };
		options.server.recordKnownRecorderState?.("network", options.params.browserSessionId, options.tabId, network);
		return {
			causal: delta.active ? buildCausalSummary(delta.items, baselineNetworkSeq) : causalUnavailable("network recorder became inactive"),
			network,
			bridgeRoundTrips: 1,
		};
	} catch {
		return { causal: causalUnavailable("network recorder delta query failed"), network: knownNetwork, bridgeRoundTrips: 1 };
	}
}

async function appendCausalHookEvents(
	options: ObserveProvidersOptions,
	causal: CausalSummary,
	knownHook: RecorderState | undefined,
	remainingMs: () => number,
): Promise<{ causal: CausalSummary; hook?: RecorderState; bridgeRoundTrips: number }> {
	const hookSeq = options.baseline?.hookSeq;
	if (!("requests" in causal) || hookSeq === undefined || knownHook?.active !== true || remainingMs() <= 0) {
		return { causal, hook: knownHook, bridgeRoundTrips: 0 };
	}
	try {
		const delta = await queryHookDelta(options.server, { browserSessionId: options.params.browserSessionId, tabId: options.tabId, timeoutMs: remainingMs(), sinceSeq: hookSeq });
		const hook = { active: delta.active, ...(delta.lastSeq !== undefined ? { lastSeq: delta.lastSeq } : knownHook.lastSeq !== undefined ? { lastSeq: knownHook.lastSeq } : {}) };
		options.server.recordKnownRecorderState?.("hook", options.params.browserSessionId, options.tabId, hook);
		const events = buildCausalEvents(delta.items, hookSeq);
		return { causal: events.events.length ? { ...causal, ...events } : causal, hook, bridgeRoundTrips: 1 };
	} catch {
		return { causal, hook: knownHook, bridgeRoundTrips: 1 };
	}
}

async function runCausalProvider(options: ObserveProvidersOptions, plan: ObserveProviderPlan, initialNetwork: RecorderState | undefined, initialHook: RecorderState | undefined): Promise<{ value?: CausalSummary; report: ProviderExecutionItem; network?: RecorderState; hook?: RecorderState }> {
	const item = plan.items.causal;
	if (!item.planned) {
		return { network: initialNetwork, hook: initialHook, report: providerReportItem({ planned: false, status: "skipped", reason: item.reason, reservedMs: item.reservedMs, actualMs: 0, bridgeRoundTrips: 0, value: {} }) };
	}
	const startedAt = Date.now();
	const providerDeadline = Math.min(options.deadlineAt, startedAt + item.reservedMs);
	const remainingMs = () => Math.max(0, providerDeadline - Date.now());
	let bridgeRoundTrips = 0;
	let knownNetwork = initialNetwork;
	let knownHook = initialHook;
	if (plan.statusProbe.planned) {
		const probed = await probeRecorderStates(options, Math.min(plan.statusProbe.reservedMs, remainingMs()), knownNetwork, knownHook);
		knownNetwork = probed.network;
		knownHook = probed.hook;
		bridgeRoundTrips += probed.bridgeRoundTrips;
	}
	const networkResult = await queryCausalNetworkDelta(options, options.baseline?.networkSeq, knownNetwork, remainingMs);
	knownNetwork = networkResult.network;
	bridgeRoundTrips += networkResult.bridgeRoundTrips;
	const hookResult = await appendCausalHookEvents(options, networkResult.causal, knownHook, remainingMs);
	const causal = hookResult.causal;
	knownHook = hookResult.hook;
	bridgeRoundTrips += hookResult.bridgeRoundTrips;
	const actualMs = elapsedMs(startedAt);
	options.timings.causalMs = actualMs;
	addBridgeRoundTrips(options.timings, bridgeRoundTrips);
	return {
		value: causal,
		network: knownNetwork,
		hook: knownHook,
		report: providerReportItem({ planned: true, status: "unavailable" in causal ? "degraded" : "executed", ...( "unavailable" in causal ? { reason: causal.unavailable } : {}), reservedMs: item.reservedMs, actualMs, bridgeRoundTrips, value: causal }),
	};
}

async function runAxeProvider(options: ObserveProvidersOptions, providerTabId: number | string | undefined, reservedMs: number, planned: boolean, reason: string) {
	const startedAt = Date.now();
	const nested = options.params.params && typeof options.params.params === "object" && !Array.isArray(options.params.params) ? options.params.params as Record<string, unknown> : undefined;
	const value = await runAxeDiagnostics(options.server, {
		requested: planned,
		browserSessionId: options.params.browserSessionId,
		tabId: providerTabId,
		timeoutMs: Math.max(500, reservedMs),
		artifactPath: options.artifactPath,
		maxResults: typeof nested?.axeMaxResults === "number" ? nested.axeMaxResults : undefined,
	});
	const actualMs = planned ? elapsedMs(startedAt) : 0;
	if (planned) {
		options.timings.axeMs = actualMs;
		addBridgeRoundTrips(options.timings, 1);
	}
	return { value, report: providerReportItem({ planned, status: planned ? value.status : "skipped", reason: planned ? value.summary?.error?.code as string | undefined : reason, reservedMs, actualMs, bridgeRoundTrips: planned ? 1 : 0, value: value.summary }) };
}

async function runReadabilityProvider(options: ObserveProvidersOptions, providerTabId: number | string | undefined, reservedMs: number, planned: boolean, reason: string) {
	const startedAt = Date.now();
	const nested = options.params.params && typeof options.params.params === "object" && !Array.isArray(options.params.params) ? options.params.params as Record<string, unknown> : undefined;
	const value = await runReadability(options.server, {
		requested: planned,
		browserSessionId: options.params.browserSessionId,
		tabId: providerTabId,
		timeoutMs: Math.max(500, reservedMs),
		artifactPath: options.artifactPath,
		maxInlineChars: typeof nested?.readabilityMaxInlineChars === "number" ? nested.readabilityMaxInlineChars : undefined,
		maxContentChars: typeof nested?.readabilityMaxContentChars === "number" ? nested.readabilityMaxContentChars : undefined,
		maxElemsToParse: typeof nested?.readabilityMaxElemsToParse === "number" ? nested.readabilityMaxElemsToParse : undefined,
	});
	const actualMs = planned ? elapsedMs(startedAt) : 0;
	if (planned) {
		options.timings.readabilityMs = actualMs;
		addBridgeRoundTrips(options.timings, 1);
	}
	return { value, report: providerReportItem({ planned, status: planned ? value.status : "skipped", reason: planned ? value.summary?.error?.code as string | undefined : reason, reservedMs, actualMs, bridgeRoundTrips: planned ? 1 : 0, value: value.summary }) };
}

export async function runObserveProviders(options: ObserveProvidersOptions) {
	const knownNetwork = options.server.getKnownRecorderState?.("network", options.params.browserSessionId, options.tabId);
	const knownHook = options.server.getKnownRecorderState?.("hook", options.params.browserSessionId, options.tabId);
	const plan = buildObserveProviderPlan({
		now: Date.now(),
		startedAt: options.startedAt,
		deadlineAt: options.deadlineAt,
		mode: "scan",
		cacheHit: false,
		outputBudgetChars: options.outputBudgetChars,
		hasBaseline: options.baseline !== undefined,
		baselineHasNetworkSeq: options.baseline?.networkSeq !== undefined,
		baselineHasHookSeq: options.baseline?.hookSeq !== undefined,
		networkState: recorderKnowledge(knownNetwork),
		hookState: recorderKnowledge(knownHook),
		axeRequested: options.axeRequested,
		readabilityRequested: options.readabilityRequested,
	});
	const providerTabId = typeof options.rawTargetRef === "number" || typeof options.rawTargetRef === "string" ? options.rawTargetRef : undefined;
	const [causalResult, axeResult, readabilityResult] = await Promise.all([
		runCausalProvider(options, plan, knownNetwork, knownHook),
		runAxeProvider(options, providerTabId, plan.items.axe.reservedMs, plan.items.axe.planned, plan.items.axe.reason),
		runReadabilityProvider(options, providerTabId, plan.items.readability.reservedMs, plan.items.readability.planned, plan.items.readability.reason),
	]);
	const report: ProviderExecutionReport = {
		causal: causalResult.report,
		axe: axeResult.report,
		readability: readabilityResult.report,
	};
	return {
		causal: causalResult.value,
		axeDiagnostics: axeResult.value,
		readability: readabilityResult.value,
		recorderState: causalResult.network ?? { active: false, ...(options.baseline?.networkSeq !== undefined ? { lastSeq: options.baseline.networkSeq } : {}) },
		hookState: causalResult.hook ?? { active: false, ...(options.baseline?.hookSeq !== undefined ? { lastSeq: options.baseline.hookSeq } : {}) },
		plan,
		report,
	};
}
