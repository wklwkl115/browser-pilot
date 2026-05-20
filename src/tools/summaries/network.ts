import { asArray, increment, isRecord, summaryTable, topCounts, type Summary } from "./common";

function safeUrlHost(url: unknown): string {
	try { return new URL(String(url || "")).host; }
	catch { return ""; }
}

function normalizeEntries(data: Record<string, unknown>): unknown[] {
	const log = isRecord(data.log) ? data.log : undefined;
	const request = isRecord(data.request) ? data.request : undefined;
	if (asArray(data.items).length) return asArray(data.items);
	if (asArray(data.entries).length) return asArray(data.entries);
	if (asArray(data.requests).length) return asArray(data.requests);
	if (asArray(log?.entries).length) return asArray(log?.entries);
	if (request && (isRecord(data.response) || data.type !== undefined || data.bodyRef !== undefined || data._requestId !== undefined)) return [data];
	if (request) return [request];
	return [];
}

function networkRows(items: unknown[]) {
	const records = items.filter(isRecord);
	return summaryTable(records, [
		{ key: "requestId", value: (item) => item.requestId },
		{ key: "method", value: (item) => item.method },
		{ key: "status", value: (item) => item.status },
		{ key: "type", value: (item) => item.type },
		{ key: "host", value: (item) => safeUrlHost(item.url) },
		{ key: "url", value: (item) => item.url },
		{ key: "bodyRef", value: (item) => item.bodyRef },
		{ key: "bodyAvailability", value: (item) => item.bodyAvailability ?? item._bodyAvailability },
		{ key: "error", value: (item) => item.errorText },
	], 20);
}

export function summarizeNetworkData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const diagnostics = isRecord(data.diagnostics) ? data.diagnostics : undefined;
	const recorderSource = isRecord(data.recorder) ? data.recorder : diagnostics;
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
		const sample = { requestId: raw.requestId ?? raw._requestId ?? raw.id, url, method, status, type, bodyRef: raw.bodyRef ?? raw._bodyRef, bodyAvailability: raw.bodyAvailability ?? raw._bodyAvailability, errorText: raw.errorText ?? raw._error };
		if (samples.length < 20) samples.push(sample);
		if (raw.failed || raw.errorText || raw._error || Number(status) >= 400) failed.push(sample);
	}
	const total = data.total ?? (typeof data.entries === "number" ? data.entries : entries.length);
	const entryCount = entries.length || (typeof data.entries === "number" ? data.entries : 0);
	return {
		tabId: data.tabId ?? diagnostics?.tabId,
		sessionId: data.sessionId ?? diagnostics?.sessionId,
		active: data.active ?? diagnostics?.active,
		total,
		entryCount,
		statusCounts: topCounts(statusCounts),
		methodCounts: topCounts(methodCounts),
		typeCounts: topCounts(typeCounts),
		hostCounts: topCounts(hostCounts),
		failed: networkRows(failed),
		samples: networkRows(samples),
		condition: data.condition,
		event: data.event,
		waitId: data.waitId ?? data.wait_id,
		recorder: recorderSource ? {
			tabId: recorderSource.tabId,
			sessionId: recorderSource.sessionId,
			recorderId: recorderSource.recorderId,
			active: recorderSource.active,
			entries: recorderSource.entries,
			bodyCount: recorderSource.bodyCount,
			activeWaitCount: recorderSource.activeWaitCount,
		} : undefined,
		bodyRef: data.bodyRef,
		bodyBytes: data.bytes,
		bodyTruncated: data.bodyTruncated,
		bodyAvailability: data.bodyAvailability ?? data._bodyAvailability,
		bodyUnavailableReason: data.bodyUnavailableReason ?? data._bodyUnavailableReason,
		...(data.bodyRef ? { url: data.url, status: data.status, mimeType: data.mimeType } : {}),
	};
}
