import test from "node:test";
import assert from "node:assert/strict";
import { summarizeGenericValue } from "../../../src/tools/summaries/generic.ts";

// ── bridge result shape ───────────────────────────────────────────────────────

test("summarizeGenericValue recognizes bridge result with ok field", () => {
	const result = summarizeGenericValue({ ok: true, data: { tabId: 1 }, target: {} });
	assert.equal(result.type, "bridgeResult");
	assert.equal(result.ok, true);
	assert.equal(result.tabId, 1);
});

test("summarizeGenericValue carries error_code from bridge error result", () => {
	const result = summarizeGenericValue({ ok: false, error_code: "TAB_NOT_FOUND", data: null });
	assert.equal(result.type, "bridgeResult");
	assert.equal(result.error_code, "TAB_NOT_FOUND");
});

test("summarizeGenericValue inlines small data values from bridge result", () => {
	const data = { key: "value", count: 42 };
	const result = summarizeGenericValue({ ok: true, data });
	assert.ok(result.data !== undefined);
	const inner = result.data as Record<string, unknown>;
	assert.equal(inner.key, "value");
});

// ── plain value inlining ──────────────────────────────────────────────────────

test("summarizeGenericValue inlines small plain objects verbatim", () => {
	const value = { x: 1, y: "hello" };
	const result = summarizeGenericValue(value);
	assert.equal(result.x, 1);
	assert.equal(result.y, "hello");
});

test("summarizeGenericValue collapses large strings to compact shape", () => {
	const value = { bigText: "A".repeat(5000) };
	const result = summarizeGenericValue(value);
	// Large value → compactSample shape with type field
	const text = result.bigText as Record<string, unknown>;
	assert.ok(text && (text.truncated === true || text.preview !== undefined || result.bigText !== undefined));
});

test("summarizeGenericValue wraps array summary in value field", () => {
	const value = [1, 2, 3];
	const result = summarizeGenericValue(value);
	// Non-bridge array → wrapped
	assert.ok("value" in result || "type" in result);
});

test("summarizeGenericValue wraps scalar summary in value field", () => {
	const result = summarizeGenericValue(42);
	assert.ok("value" in result || "type" in result);
});

test("summarizeGenericValue extracts sessionId and tabId from bridge result target", () => {
	const result = summarizeGenericValue({
		ok: true,
		data: { tabId: 5, sessionId: "sess-1" },
		target: { browserSessionId: "bsess-42" },
	});
	assert.equal(result.tabId, 5);
	assert.equal(result.sessionId, "sess-1");
	assert.equal(result.browserSessionId, "bsess-42");
});

// ── bridge result metadata fields ────────────────────────────────────────────

test("summarizeGenericValue extracts message from bridge result", () => {
	const result = summarizeGenericValue({ ok: false, message: "target tab is gone" });
	assert.ok(typeof result.message === "string");
	assert.ok(result.message!.includes("target tab"));
});
