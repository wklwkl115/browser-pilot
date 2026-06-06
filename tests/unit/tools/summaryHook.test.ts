import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHookPerformance, summarizeHookCollectData } from "../../../src/tools/summaries/hook.ts";

// ── summarizeHookPerformance ──────────────────────────────────────────────────

test("summarizeHookPerformance returns type for non-record input", () => {
	const result = summarizeHookPerformance(null);
	assert.ok("type" in result);
});

test("summarizeHookPerformance computes initiatorType counts", () => {
	const data = {
		ok: true,
		entries: [
			{ name: "https://cdn.example.com/app.js", initiatorType: "script", duration: 120 },
			{ name: "https://cdn.example.com/app.css", initiatorType: "link", duration: 80 },
			{ name: "https://cdn.example.com/icon.png", initiatorType: "img", duration: 30 },
			{ name: "https://api.example.com/data", initiatorType: "xmlhttprequest", duration: 200 },
		],
	};
	const result = summarizeHookPerformance(data);
	assert.equal(result.ok, true);
	assert.equal(result.total, 4);
	assert.ok(Array.isArray(result.initiatorTypes));
	assert.ok((result.initiatorTypes as unknown[]).length > 0);
});

test("summarizeHookPerformance includes samples table", () => {
	const data = {
		entries: [
			{ name: "https://example.com/a.js", initiatorType: "script", duration: 100 },
		],
	};
	const result = summarizeHookPerformance(data);
	const samples = result.samples as { rows: unknown[][] };
	assert.ok(samples.rows.length === 1);
});

test("summarizeHookPerformance adds artifact hints when entries exist", () => {
	const data = { entries: [{ name: "https://x.com/y.js", initiatorType: "script", duration: 50 }] };
	const result = summarizeHookPerformance(data);
	assert.ok("artifact_hints" in result);
});

test("summarizeHookPerformance handles empty entries", () => {
	const result = summarizeHookPerformance({ ok: true, entries: [] });
	assert.equal(result.total, 0);
	assert.equal(result.returned, undefined);
	assert.ok(!("artifact_hints" in result));
});

// ── summarizeHookCollectData ──────────────────────────────────────────────────

test("summarizeHookCollectData returns type for non-record input", () => {
	const result = summarizeHookCollectData(null);
	assert.ok("type" in result);
});

test("summarizeHookCollectData computes eventTypes counts", () => {
	const data = {
		ok: true,
		sessionId: "sess-1",
		events: [
			{ seq: 1, type: "click", selector: "#btn" },
			{ seq: 2, type: "input", key: "hello" },
			{ seq: 3, type: "click", selector: "#submit" },
		],
	};
	const result = summarizeHookCollectData(data);
	assert.equal(result.ok, true);
	assert.equal(result.sessionId, "sess-1");
	assert.equal(result.total, 3);
	assert.ok(Array.isArray(result.eventTypes));
	const clickCount = (result.eventTypes as Array<{ key: string; count: number }>).find((item) => item.key === "click");
	assert.ok(clickCount);
	assert.equal(clickCount!.count, 2);
});

test("summarizeHookCollectData adds artifact hints when events exist", () => {
	const data = { events: [{ seq: 1, type: "click" }] };
	const result = summarizeHookCollectData(data);
	assert.ok("artifact_hints" in result);
});

test("summarizeHookCollectData includes samples table with seq/type/detail", () => {
	const data = {
		events: [
			{ seq: 5, type: "storage", key: "myKey" },
		],
	};
	const result = summarizeHookCollectData(data);
	const samples = result.samples as { rows: unknown[][] };
	const row = samples.rows[0];
	assert.equal(row[0], 5);   // seq
	assert.equal(row[1], "storage");  // type
	assert.equal(row[2], "myKey");    // detail from .key
});

test("summarizeHookCollectData handles empty events", () => {
	const result = summarizeHookCollectData({ ok: true, events: [] });
	assert.ok(!("artifact_hints" in result));
});
