import { isRecord } from "../../utils/records.js";

export type ObserveTimingMetrics = Record<string, number | boolean | undefined>;

export function elapsedMs(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

export function addBridgeRoundTrips(metrics: ObserveTimingMetrics, count: number): void {
	metrics.bridgeRoundTrips = Math.max(0, Math.floor(Number(metrics.bridgeRoundTrips || 0) + count));
}

function numericMetric(value: unknown): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

export function finalizedObserveTimings(metrics: ObserveTimingMetrics, data: unknown, abmlRead: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = { ...metrics };
	const dataRecord = isRecord(data) ? data : undefined;
	const abmlData = isRecord(abmlRead) && abmlRead.ok === true && isRecord(abmlRead.data) ? abmlRead.data : undefined;
	const axDiagnostics = isRecord(abmlData?.axDiagnostics) ? abmlData.axDiagnostics : undefined;
	const axFusion = isRecord(abmlData?.axFusion) ? abmlData.axFusion : undefined;
	const nodeCount = numericMetric(dataRecord?.node_count ?? dataRecord?.nodeCount);
	const axNodeCount = numericMetric(axDiagnostics?.nodeCount);
	const axMs = numericMetric(axDiagnostics?.axMs);
	const axCdpCalls = numericMetric(axDiagnostics?.cdpCalls);
	const axGeometryCdpCalls = numericMetric(axDiagnostics?.geometryCdpCalls);
	if (nodeCount !== undefined) out.nodeCount = nodeCount;
	if (axNodeCount !== undefined) out.axNodeCount = axNodeCount;
	if (axMs !== undefined) out.axMs = axMs;
	if (axCdpCalls !== undefined) {
		out.axCdpCalls = axCdpCalls;
		addBridgeRoundTrips(out as ObserveTimingMetrics, axCdpCalls);
	}
	if (axGeometryCdpCalls !== undefined) out.axGeometryCdpCalls = axGeometryCdpCalls;
	if (typeof axDiagnostics?.cacheHit === "boolean") out.axCacheHit = axDiagnostics.cacheHit;
	const axEnriched = numericMetric(axFusion?.axEnriched);
	const axOnly = numericMetric(axFusion?.axOnly);
	if (axEnriched !== undefined) out.axEnriched = axEnriched;
	if (axOnly !== undefined) out.axOnly = axOnly;
	if (typeof axFusion?.degraded === "boolean") out.axFusionDegraded = axFusion.degraded;
	const transportMs = ["navigationMs", "pageScriptMs", "abmlMs", "recorderMs", "causalMs", "eventCausalMs"]
		.reduce((sum, key) => sum + (numericMetric(out[key]) ?? 0), 0);
	if (transportMs > 0) out.transportMs = transportMs;
	return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
}
