import { artifactHints, asArray, increment, isRecord, summaryTable, topCounts, type Summary } from "./common.js";

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

/**
 * The jsonPath of the array container normalizeEntries() drew from, so the
 * Layer-1 section hint points at the exact same place in the raw artifact.
 * Returns undefined for single-request / empty shapes (no stable array root).
 */
function entriesContainerPath(data: Record<string, unknown>): string | undefined {
	const log = isRecord(data.log) ? data.log : undefined;
	// These paths are emitted as `read_saved_artifact jsonPath=…` hints and resolved against the SAVED
	// ARTIFACT, whose root is the bridge result `{id,tabId,data,…}` — so they must be data-rooted, just
	// like scan's `data.content`. Without the `data.` prefix the hint resolved to notFound (blind-eval N1).
	if (asArray(data.items).length) return "data.items";
	if (asArray(data.entries).length) return "data.entries";
	if (asArray(data.requests).length) return "data.requests";
	if (asArray(log?.entries).length) return "data.log.entries";
	return undefined;
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
	const entriesPath = entriesContainerPath(data);
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
		// Layer-1 hints: full entries array plus bounded per-entry request handles.
		// Per-entry http-request handles let MCP callers pass captured requests directly
		// into browser_sqli/browser_http_replay/browser_fuzz without hand-copying JSON.
		...(entriesPath ? artifactHints([
			{ label: "all network entries", jsonPath: entriesPath, kind: "network-entry", count: entries.length },
			...requestEntryHints(entries, entriesPath),
		]) : {}),
	};
}
