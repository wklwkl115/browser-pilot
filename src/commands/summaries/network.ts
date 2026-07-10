import { artifactHints, asArray, increment, isRecord, summaryTable, topCounts, type Summary } from "./common.js";

function safeUrlHost(url: unknown): string {
	try { return new URL(String(url || "")).host; }
	catch { return ""; }
}

function networkEntries(data: Record<string, unknown>): { entries: unknown[]; entriesPath?: string } {
	const log = isRecord(data.log) ? data.log : undefined;
	const containers: Array<[unknown, string]> = [
		[data.items, "data.items"],
		[data.entries, "data.entries"],
		[data.requests, "data.requests"],
		[log?.entries, "data.log.entries"],
	];
	for (const [value, entriesPath] of containers) {
		const entries = asArray(value);
		if (entries.length) return { entries, entriesPath };
	}
	const request = isRecord(data.request) ? data.request : undefined;
	if (!request) return { entries: [] };
	const isWrappedEntry = isRecord(data.response) || data.type !== undefined || data.bodyRef !== undefined || data._requestId !== undefined;
	return { entries: [isWrappedEntry ? data : request] };
}

function networkSample(raw: Record<string, unknown>): Summary {
	const request = isRecord(raw.request) ? raw.request : {};
	const response = isRecord(raw.response) ? raw.response : {};
	return {
		requestId: raw.requestId ?? raw._requestId ?? raw.id,
		url: raw.url ?? request.url,
		method: raw.method ?? request.method,
		status: raw.status ?? response.status,
		type: raw.type ?? raw._type,
		bodyRef: raw.bodyRef ?? raw._bodyRef,
		bodyAvailability: raw.bodyAvailability ?? raw._bodyAvailability,
		errorText: raw.errorText ?? raw._error,
	};
}

function networkRows(items: Summary[]) {
	return summaryTable(items, [
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

function summarizeEntries(entries: unknown[]): Summary {
	const statusCounts: Record<string, number> = {};
	const methodCounts: Record<string, number> = {};
	const hostCounts: Record<string, number> = {};
	const typeCounts: Record<string, number> = {};
	const failed: Summary[] = [];
	const samples: Summary[] = [];
	for (const raw of entries) {
		if (!isRecord(raw)) continue;
		const sample = networkSample(raw);
		increment(statusCounts, sample.status);
		increment(methodCounts, sample.method);
		increment(hostCounts, safeUrlHost(sample.url));
		increment(typeCounts, sample.type);
		if (samples.length < 20) samples.push(sample);
		if (raw.failed || raw.errorText || raw._error || Number(sample.status) >= 400) failed.push(sample);
	}
	return {
		statusCounts: topCounts(statusCounts), methodCounts: topCounts(methodCounts), typeCounts: topCounts(typeCounts), hostCounts: topCounts(hostCounts),
		failed: networkRows(failed), samples: networkRows(samples),
	};
}

const MAX_HTTP_REQUEST_HINTS = 10;

function requestEntryHints(entries: unknown[], entriesPath: string | undefined) {
	if (!entriesPath) return [];
	const reads: Array<{ label: string; jsonPath: string; kind: string; count: number }> = [];
	for (let index = 0; index < entries.length && reads.length < MAX_HTTP_REQUEST_HINTS; index += 1) {
		const raw = entries[index];
		if (!isRecord(raw)) continue;
		const request = isRecord(raw.request) ? raw.request : raw;
		if (request.url === undefined && request.method === undefined) continue;
		const requestId = raw.requestId ?? raw._requestId ?? raw.id ?? index;
		reads.push({
			label: `request ${String(requestId)}`,
			jsonPath: isRecord(raw.request) ? `${entriesPath}[${index}].request` : `${entriesPath}[${index}]`,
			kind: "http-request",
			count: 1,
		});
	}
	return reads;
}

export function summarizeNetworkData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const diagnostics = isRecord(data.diagnostics) ? data.diagnostics : undefined;
	const recorderSource = isRecord(data.recorder) ? data.recorder : diagnostics;
	const { entries, entriesPath } = networkEntries(data);
	const total = data.total ?? (typeof data.entries === "number" ? data.entries : entries.length);
	const entryCount = entries.length || (typeof data.entries === "number" ? data.entries : 0);
	return {
		tabId: data.tabId ?? diagnostics?.tabId,
		sessionId: data.sessionId ?? diagnostics?.sessionId,
		active: data.active ?? diagnostics?.active,
		total,
		entryCount,
		...summarizeEntries(entries),
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
		...(entriesPath ? artifactHints([
			{ label: "all network entries", jsonPath: entriesPath, kind: "network-entry", count: entries.length },
			...requestEntryHints(entries, entriesPath),
		]) : {}),
	};
}
