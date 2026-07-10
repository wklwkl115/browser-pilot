import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCallbackOastData } from "../../src/commands/summaries/webSecurity/oast.ts";

type Summary = Record<string, unknown>;

test("callback OAST summary characterizes start metadata, sessions, events, and counts", () => {
	const summary = summarizeCallbackOastData({
		ok: true,
		action: "start",
		sessionId: "oast-1",
		listenHost: "127.0.0.1",
		port: 18080,
		httpsPort: 18443,
		dnsPort: 15353,
		correlationId: "corr-1",
		callbackUrl: "http://127.0.0.1:18080/corr-1",
		httpsCallbackUrl: "https://127.0.0.1:18443/corr-1",
		dnsCallbackHost: "corr-1.oast.test",
		publicCallbackUrl: "https://public.test/corr-1",
		publicHttpsCallbackUrl: "https://secure.test/corr-1",
		publicDnsCallbackHost: "corr-1.public.test",
		listenerActive: true,
		recovered: false,
		stopReason: undefined,
		maxRuntimeMs: 60_000,
		enabledProtocols: ["http", "https", "dns"],
		nextSeq: 5,
		sessions: [
			{ sessionId: "oast-1", callbackUrl: "http://one", httpsCallbackUrl: "https://one", dnsCallbackHost: "one.test", listenerActive: true, eventCount: 4, startedAt: "2026-01-01" },
			{ sessionId: "oast-2", callbackUrl: "http://two", listenerActive: false, eventCount: 0, startedAt: "2026-01-02" },
			"malformed",
		],
		events: [
			{ seq: 1, protocol: "http", method: "POST", path: "/cb", url: "http://one/cb", matchedCorrelation: true, body: { bytes: 12 }, remoteAddress: "127.0.0.1" },
			{ seq: 2, protocol: "dns", queryName: "corr-1.oast.test", matchedCorrelation: false, queryBytes: 8 },
			{ seq: 3, url: "https://fallback.test/hit", queryBytes: 0 },
			{},
			"malformed",
		],
	});

	assert.deepEqual({ ok: summary.ok, action: summary.action, sessionId: summary.sessionId, listenHost: summary.listenHost, port: summary.port, httpsPort: summary.httpsPort, dnsPort: summary.dnsPort, correlationId: summary.correlationId, listenerActive: summary.listenerActive, recovered: summary.recovered, maxRuntimeMs: summary.maxRuntimeMs, nextSeq: summary.nextSeq }, {
		ok: true, action: "start", sessionId: "oast-1", listenHost: "127.0.0.1", port: 18080, httpsPort: 18443, dnsPort: 15353, correlationId: "corr-1", listenerActive: true, recovered: false, maxRuntimeMs: 60_000, nextSeq: 5,
	});
	assert.equal(summary.eventCount, 4);
	assert.deepEqual(summary.protocolCounts, [{ key: "http", count: 3 }, { key: "dns", count: 1 }]);
	assert.deepEqual(summary.methodCounts, [{ key: "unknown", count: 2 }, { key: "POST", count: 1 }, { key: "dns", count: 1 }]);
	assert.deepEqual(summary.pathCounts, [{ key: "/cb", count: 1 }, { key: "corr-1.oast.test", count: 1 }, { key: "https://fallback.test/hit", count: 1 }, { key: "unknown", count: 1 }]);
	assert.equal((summary.sessions as Summary).count, 2);
	assert.deepEqual((summary.sessions as Summary).rows, [
		["oast-1", "http://one", 1, "one.test", true, 4, "2026-01-01"],
		["oast-2", "http://two", 0, undefined, false, 0, "2026-01-02"],
	]);
	assert.equal((summary.events as Summary).count, 4);
	assert.deepEqual((summary.events as Summary).rows, [
		[1, "http", "POST", "http://one/cb", true, 12, "127.0.0.1"],
		[2, "dns", undefined, "corr-1.oast.test", false, 8, undefined],
		[3, undefined, undefined, "https://fallback.test/hit", undefined, 0, undefined],
		[undefined, undefined, undefined, undefined, undefined, undefined, undefined],
	]);
	const actions = summary.nextActions as string[];
	assert.equal(actions.length, 4);
	assert.match(actions[0]!, /sessionId="oast-1"/);
});

test("callback OAST summary characterizes empty collect fallback and malformed input", () => {
	const collect = summarizeCallbackOastData({ action: "collect", eventCount: 9, events: [], sessions: [] });
	assert.equal(collect.eventCount, 9);
	assert.deepEqual(collect.protocolCounts, []);
	assert.equal((collect.events as Summary).count, 0);
	assert.equal((collect.sessions as Summary).count, 0);
	assert.equal((collect.nextActions as string[]).length, 3);

	const malformed = summarizeCallbackOastData(null);
	assert.equal(malformed.eventCount, undefined);
	assert.deepEqual(malformed.methodCounts, []);
	assert.equal((malformed.events as Summary).count, 0);
	assert.equal((malformed.nextActions as string[]).length, 3);
});

test("callback OAST summary keeps session and event tables bounded", () => {
	const summary = summarizeCallbackOastData({
		sessions: Array.from({ length: 25 }, (_, index) => ({ sessionId: `oast-${index}`, eventCount: index })),
		events: Array.from({ length: 35 }, (_, index) => ({ seq: index, protocol: "http", method: "GET", path: `/callback/${index}` })),
	});
	assert.deepEqual({ count: (summary.sessions as Summary).count, truncated: (summary.sessions as Summary).truncated }, { count: 25, truncated: 5 });
	assert.deepEqual({ count: (summary.events as Summary).count, truncated: (summary.events as Summary).truncated }, { count: 35, truncated: 5 });
	assert.deepEqual(summary.protocolCounts, [{ key: "http", count: 35 }]);
	assert.deepEqual(summary.methodCounts, [{ key: "GET", count: 35 }]);
});
