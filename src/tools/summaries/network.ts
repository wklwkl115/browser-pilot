import { asArray, increment, isRecord, topCounts, type Summary } from "./common";

function safeUrlHost(url: unknown): string {
	try { return new URL(String(url || "")).host; }
	catch { return ""; }
}

function normalizeEntries(data: Record<string, unknown>): unknown[] {
	const log = isRecord(data.log) ? data.log : undefined;
	const request = isRecord(data.request) ? data.request : undefined;
	if (asArray(data.items).length) return asArray(data.items);
	if (asArray(data.entries).length) return asArray(data.entries);
	if (asArray(log?.entries).length) return asArray(log?.entries);
	if (request) return [request];
	return [];
}

export function summarizeNetworkData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const entries = normalizeEntries(data);
	const statusCounts: Record<string, number> = {};
	const methodCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	const typeCounts: Record<string, number> = {};
	const failed: unknown[] = [];
	const samples: unknown[] = [];
	for (const raw of entries) {
		if (!isRecord(raw)) continue;
		const request = isRecord(raw.request) ? raw.request : {};
		const response = isRecord(raw.response) ? raw.response : {};
		const url = raw.url ?? request.url;
		const status = raw.status ?? response.status;
		const method = raw.method ?? request.method;
		const type = raw.type ?? raw._type;
		increment(statusCounts, status);
		increment(methodCounts, method);
		increment(hostCounts, safeUrlHost(url));
		increment(typeCounts, type);
		const sample = { requestId: raw.requestId ?? raw._requestId ?? raw.id, url, method, status, type, bodyRef: raw.bodyRef ?? raw._bodyRef, errorText: raw.errorText ?? raw._error };
		if (samples.length < 20) samples.push(sample);
		if (raw.failed || raw.errorText || raw._error || Number(status) >= 400) failed.push(sample);
	}
	return {
		tabId: data.tabId,
		sessionId: data.sessionId,
		active: data.active,
		total: data.total ?? entries.length,
		entryCount: entries.length,
		statusCounts: topCounts(statusCounts),
		methodCounts: topCounts(methodCounts),
		typeCounts: topCounts(typeCounts),
		hostCounts: topCounts(hostCounts),
		failed: failed.slice(0, 20),
		samples,
		condition: data.condition,
		event: data.event,
		waitId: data.waitId ?? data.wait_id,
		recorder: isRecord(data.recorder) ? {
			recorderId: data.recorder.recorderId,
			active: data.recorder.active,
			entries: data.recorder.entries,
			bodyCount: data.recorder.bodyCount,
			activeWaitCount: data.recorder.activeWaitCount,
		} : undefined,
		bodyRef: data.bodyRef,
		bodyBytes: data.bytes,
		bodyTruncated: data.bodyTruncated,
	};
}
