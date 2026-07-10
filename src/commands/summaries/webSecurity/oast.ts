import { asArray, increment, isRecord, summaryTable, topCounts, type Summary } from "./shared.js";

const OAST_METADATA_FIELDS = [
	"ok", "action", "sessionId", "listenHost", "port", "httpsPort", "dnsPort", "correlationId",
	"callbackUrl", "httpsCallbackUrl", "dnsCallbackHost", "publicCallbackUrl", "publicHttpsCallbackUrl", "publicDnsCallbackHost",
	"listenerActive", "recovered", "stopReason", "maxRuntimeMs", "enabledProtocols", "nextSeq",
] as const;

export function summarizeCallbackOastData(value: unknown): Summary {
	const data = isRecord(value) ? value : {};
	const events = asArray(data.events).filter(isRecord);
	const sessions = asArray(data.sessions).filter(isRecord);
	const methodCounts: Record<string, number> = {};
	const pathCounts: Record<string, number> = {};
	const protocolCounts: Record<string, number> = {};
	for (const event of events) {
		increment(methodCounts, event.method ?? event.protocol ?? "unknown");
		increment(pathCounts, event.path ?? event.queryName ?? event.url ?? "unknown");
		increment(protocolCounts, event.protocol ?? "http");
	}
	return {
		...Object.fromEntries(OAST_METADATA_FIELDS.map((key) => [key, data[key]])),
		eventCount: events.length || data.eventCount,
		sessions: summaryTable(sessions, [
			{ key: "sessionId", value: (item) => item.sessionId },
			{ key: "callbackUrl", value: (item) => item.callbackUrl },
			{ key: "https", value: (item) => item.httpsCallbackUrl ? 1 : 0 },
			{ key: "dns", value: (item) => item.dnsCallbackHost },
			{ key: "active", value: (item) => item.listenerActive },
			{ key: "events", value: (item) => item.eventCount },
			{ key: "startedAt", value: (item) => item.startedAt },
		], 20),
		protocolCounts: topCounts(protocolCounts),
		methodCounts: topCounts(methodCounts),
		pathCounts: topCounts(pathCounts),
		events: summaryTable(events, [
			{ key: "seq", value: (event) => event.seq },
			{ key: "protocol", value: (event) => event.protocol },
			{ key: "method", value: (event) => event.method },
			{ key: "url", value: (event) => event.url ?? event.queryName },
			{ key: "matched", value: (event) => event.matchedCorrelation },
			{ key: "bodyBytes", value: (event) => isRecord(event.body) ? event.body.bytes : event.queryBytes },
			{ key: "remote", value: (event) => event.remoteAddress },
		], 30),
		nextActions: [
			...(data.action === "start" && typeof data.sessionId === "string" && data.sessionId
				? [`thread sessionId="${data.sessionId}" (the oast-* id, NOT correlationId) into status/collect/trigger/stop for this listener`]
				: []),
			"inject the generated callback URL or host through browser_http_replay or browser_execute, then collect bounded callback evidence",
			"read callback artifacts or rerun collect with afterSeq when event details need manual confirmation",
			"stop or clear idle callback sessions after evidence is preserved to keep listener state bounded",
		],
	};
}
