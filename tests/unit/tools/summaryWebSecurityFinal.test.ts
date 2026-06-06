import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCallbackOastData } from "../../../src/tools/summaries/webSecurity/oast.ts";
import { summarizeTemplateCheckData } from "../../../src/tools/summaries/webSecurity/template.ts";
import { summarizeSqlmapBridgeData, summarizeNucleiBridgeData } from "../../../src/tools/summaries/webSecurity/bridges.ts";

// ── summarizeCallbackOastData ─────────────────────────────────────────────────

test("summarizeCallbackOastData handles non-record input", () => {
	const result = summarizeCallbackOastData(null);
	// null input → ok=undefined, eventCount=undefined, events table with 0 rows
	assert.equal(result.ok, undefined);
	const events = result.events as { count: number };
	assert.equal(events.count, 0);
});

test("summarizeCallbackOastData extracts session and listener metadata", () => {
	const value = {
		ok: true,
		action: "start",
		sessionId: "sess-abc",
		listenHost: "0.0.0.0",
		port: 8080,
		callbackUrl: "http://callback.example.com:8080/",
		listenerActive: true,
		events: [],
		sessions: [],
	};
	const result = summarizeCallbackOastData(value);
	assert.equal(result.ok, true);
	assert.equal(result.action, "start");
	assert.equal(result.sessionId, "sess-abc");
	assert.equal(result.port, 8080);
	assert.equal(result.listenerActive, true);
	const events = result.events as { count: number };
	assert.equal(events.count, 0);
});

test("summarizeCallbackOastData counts events and computes methodCounts", () => {
	const value = {
		ok: true,
		events: [
			{ protocol: "http", method: "GET", path: "/ping" },
			{ protocol: "http", method: "POST", path: "/callback" },
			{ protocol: "dns", queryName: "ssrf.oast.test" },
		],
		sessions: [],
	};
	const result = summarizeCallbackOastData(value);
	const events = result.events as { count: number };
	assert.equal(events.count, 3);
});

// ── summarizeTemplateCheckData ────────────────────────────────────────────────

test("summarizeTemplateCheckData handles non-record input", () => {
	const result = summarizeTemplateCheckData(null);
	assert.equal(result.matchedCount, 0);
	assert.equal(result.failureCount, 0);
});

test("summarizeTemplateCheckData counts matched templates", () => {
	const value = {
		ok: true,
		matched: [
			{ templateId: "http/exposures/files/sensitive-files.yaml", name: "Sensitive File Exposure", url: "https://example.com/.env", status: 200 },
		],
		results: [
			{ templateId: "http/exposures/files/sensitive-files.yaml", status: 200 },
			{ templateId: "network/generic-ports.yaml", status: "timeout" },
		],
		failures: [],
		targetCount: 2,
		templateCount: 5,
	};
	const result = summarizeTemplateCheckData(value);
	assert.equal(result.ok, true);
	assert.equal(result.matchedCount, 1);
	assert.equal(result.targetCount, 2);
	assert.equal(result.templateCount, 5);
});

test("summarizeTemplateCheckData computes templateCounts", () => {
	const value = {
		results: [
			{ templateId: "tmpl-a", status: 200 },
			{ templateId: "tmpl-a", status: 200 },
			{ templateId: "tmpl-b", status: 404 },
		],
	};
	const result = summarizeTemplateCheckData(value);
	const templateCounts = result.templateCounts as Array<{ key: string; count: number }>;
	const tmplA = templateCounts.find((item) => item.key === "tmpl-a");
	assert.ok(tmplA);
	assert.equal(tmplA!.count, 2);
});

// ── summarizeSqlmapBridgeData ─────────────────────────────────────────────────

test("summarizeSqlmapBridgeData handles non-record input", () => {
	const result = summarizeSqlmapBridgeData(null);
	assert.ok(typeof result === "object");
});

test("summarizeSqlmapBridgeData extracts ok field", () => {
	const result = summarizeSqlmapBridgeData({ ok: true, target: "https://api.example.com/items?id=1" });
	assert.equal(result.ok, true);
});

// ── summarizeNucleiBridgeData ─────────────────────────────────────────────────

test("summarizeNucleiBridgeData handles non-record input", () => {
	const result = summarizeNucleiBridgeData(null);
	assert.ok(typeof result === "object");
});

test("summarizeNucleiBridgeData extracts ok field", () => {
	const result = summarizeNucleiBridgeData({ ok: true });
	assert.equal(result.ok, true);
});
