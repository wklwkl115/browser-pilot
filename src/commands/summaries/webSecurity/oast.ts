import { asArray, increment, isRecord, summaryTable, topCounts, type Summary } from "./shared.js";

export function summarizeCallbackOastData(value: unknown): Summary {
	const events = isRecord(value) ? asArray(value.events).filter(isRecord) : [];
	const sessions = isRecord(value) ? asArray(value.sessions).filter(isRecord) : [];
	const methodCounts: Record<string, number> = {};
	const pathCounts: Record<string, number> = {};
	const protocolCounts: Record<string, number> = {};
	for (const event of events) {
		increment(methodCounts, event.method ?? event.protocol ?? "unknown");
		increment(pathCounts, event.path ?? event.queryName ?? event.url ?? "unknown");
		increment(protocolCounts, event.protocol ?? "http");
	}
	return {
		ok: isRecord(value) ? value.ok : undefined,
		action: isRecord(value) ? value.action : undefined,
		sessionId: isRecord(value) ? value.sessionId : undefined,
		listenHost: isRecord(value) ? value.listenHost : undefined,
		port: isRecord(value) ? value.port : undefined,
		httpsPort: isRecord(value) ? value.httpsPort : undefined,
		dnsPort: isRecord(value) ? value.dnsPort : undefined,
		correlationId: isRecord(value) ? value.correlationId : undefined,
		callbackUrl: isRecord(value) ? value.callbackUrl : undefined,
		httpsCallbackUrl: isRecord(value) ? value.httpsCallbackUrl : undefined,
		dnsCallbackHost: isRecord(value) ? value.dnsCallbackHost : undefined,
		publicCallbackUrl: isRecord(value) ? value.publicCallbackUrl : undefined,
		publicHttpsCallbackUrl: isRecord(value) ? value.publicHttpsCallbackUrl : undefined,
		publicDnsCallbackHost: isRecord(value) ? value.publicDnsCallbackHost : undefined,
		listenerActive: isRecord(value) ? value.listenerActive : undefined,
		recovered: isRecord(value) ? value.recovered : undefined,
		stopReason: isRecord(value) ? value.stopReason : undefined,
		maxRuntimeMs: isRecord(value) ? value.maxRuntimeMs : undefined,
		enabledProtocols: isRecord(value) ? value.enabledProtocols : undefined,
		eventCount: events.length || (isRecord(value) ? value.eventCount : undefined),
		nextSeq: isRecord(value) ? value.nextSeq : undefined,
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
			...(isRecord(value) && value.action === "start" && typeof value.sessionId === "string" && value.sessionId
				? [`thread sessionId="${value.sessionId}" (the oast-* id, NOT correlationId) into status/collect/trigger/stop for this listener`]
				: []),
			"inject the generated callback URL or host through browser_http_replay or browser_execute, then collect bounded callback evidence",
			"read callback artifacts or rerun collect with afterSeq when event details need manual confirmation",
			"stop or clear idle callback sessions after evidence is preserved to keep listener state bounded",
		],
	};
}
