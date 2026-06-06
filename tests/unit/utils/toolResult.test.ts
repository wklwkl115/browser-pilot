import test from "node:test";
import assert from "node:assert/strict";
import { textResult, jsonResult, errorResult } from "../../../src/utils/toolResult.ts";

// ── textResult ───────────────────────────────────────────────────────────────

test("textResult wraps text in content array", () => {
	const result = textResult("hello world");
	assert.deepEqual(result.content, [{ type: "text", text: "hello world" }]);
});

test("textResult truncates long text and sets truncated flag", () => {
	const long = "x".repeat(200);
	const result = textResult(long, {}, 100);
	assert.ok(result.details?.truncated === true);
	assert.ok(result.content[0].text.length < long.length);
});

test("textResult does not truncate short text", () => {
	const result = textResult("short", {}, 100);
	assert.equal(result.details?.truncated, false);
});

test("textResult redacts sensitive details", () => {
	const result = textResult("ok", { password: "secret" });
	assert.equal((result.details as Record<string, unknown>).password, "[redacted]");
});

// ── jsonResult ───────────────────────────────────────────────────────────────

test("jsonResult serializes value to JSON text", () => {
	const result = jsonResult({ key: "val" });
	const text = result.content[0].text;
	assert.ok(text.includes('"key"'));
	assert.ok(text.includes('"val"'));
});

test("jsonResult truncates large JSON and sets truncated flag", () => {
	const value = { data: "x".repeat(200) };
	const result = jsonResult(value, {}, 20);
	assert.equal(result.details?.truncated, true);
});

test("jsonResult merges extra details", () => {
	const result = jsonResult({ a: 1 }, { myExtra: "info" });
	assert.equal((result.details as Record<string, unknown>).myExtra, "info");
});

// ── errorResult ──────────────────────────────────────────────────────────────

test("errorResult wraps Error into text content", () => {
	const err = new Error("something broke");
	const result = errorResult(err);
	assert.ok(result.content[0].text.includes("something broke"));
});

test("errorResult handles non-Error objects", () => {
	const result = errorResult("plain string error");
	assert.ok(result.content[0].text.includes("plain string error"));
});

test("errorResult includes error in details", () => {
	const result = errorResult(new Error("oops"));
	assert.ok((result.details as Record<string, unknown>).error !== undefined);
});

// ── compactDetails limits ─────────────────────────────────────────────────────

test("jsonResult compacts details with long string into preview", () => {
	const longStr = "L".repeat(1000);
	const result = jsonResult("ok", { big: longStr });
	const detail = (result.details as Record<string, unknown>).big as Record<string, unknown>;
	assert.equal(typeof detail, "object");
	assert.ok("preview" in detail);
	assert.ok((detail.truncated as boolean) === true);
});

test("jsonResult compacts deeply nested arrays in details", () => {
	const arr = Array.from({ length: 20 }, (_, i) => i);
	const result = jsonResult("ok", { nums: arr });
	const nums = (result.details as Record<string, unknown>).nums as unknown[];
	// Should be truncated to DETAIL_MAX_ARRAY_ITEMS (12) + 1 truncation marker
	assert.ok(nums.length <= 13);
});
