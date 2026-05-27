import test from "node:test";
import assert from "node:assert/strict";
import { jsonPreview, stableJson, truncateText } from "../../../src/utils/json.ts";

test("stableJson stringifies bigint and circular references", () => {
	const value: Record<string, unknown> = { big: 1n };
	value.self = value;
	const text = stableJson(value);
	assert.ok(text.includes('"big": "1"'));
	assert.ok(text.includes('"self": "[Circular]"'));
});

test("truncateText leaves short text untouched", () => {
	const result = truncateText("hello", 10);
	assert.equal(result.text, "hello");
	assert.equal(result.truncated, false);
	assert.equal(result.originalLength, 5);
});

test("truncateText truncates long text with marker", () => {
	const result = truncateText("abcdefghij", 6);
	assert.equal(result.truncated, true);
	assert.ok(result.text.includes("[truncated"));
	assert.equal(result.originalLength, 10);
});

test("jsonPreview wraps stableJson + truncateText", () => {
	const preview = jsonPreview({ a: "x".repeat(40) }, 20);
	assert.equal(preview.truncated, true);
	assert.ok(preview.text.includes("[truncated"));
});
