import test from "node:test";
import assert from "node:assert/strict";
import {
	isRecord,
	asArray,
	increment,
	topCounts,
	textPreview,
	summaryTable,
	artifactHints,
} from "../../../src/tools/summaries/common.ts";

// ── isRecord ─────────────────────────────────────────────────────────────────

test("summaries/common isRecord returns true for plain objects", () => {
	assert.equal(isRecord({ a: 1 }), true);
	assert.equal(isRecord({}), true);
});

test("summaries/common isRecord returns false for arrays and primitives", () => {
	assert.equal(isRecord([]), false);
	assert.equal(isRecord(null), false);
	assert.equal(isRecord("x"), false);
});

// ── asArray ───────────────────────────────────────────────────────────────────

test("asArray returns array unchanged", () => {
	assert.deepEqual(asArray([1, 2, 3]), [1, 2, 3]);
});

test("asArray returns empty array for non-arrays", () => {
	assert.deepEqual(asArray(null), []);
	assert.deepEqual(asArray("string"), []);
	assert.deepEqual(asArray(42), []);
	assert.deepEqual(asArray({}), []);
});

// ── increment ─────────────────────────────────────────────────────────────────

test("increment creates and increments key in map", () => {
	const map: Record<string, number> = {};
	increment(map, "a");
	assert.equal(map.a, 1);
	increment(map, "a");
	assert.equal(map.a, 2);
});

test("increment normalizes falsy keys to 'unknown'", () => {
	const map: Record<string, number> = {};
	increment(map, null);
	increment(map, undefined);
	assert.equal(map.unknown, 2);
});

// ── topCounts ─────────────────────────────────────────────────────────────────

test("topCounts returns sorted entries by count descending", () => {
	const map = { a: 1, b: 5, c: 3 };
	const result = topCounts(map);
	assert.equal(result[0].key, "b");
	assert.equal(result[1].key, "c");
	assert.equal(result[2].key, "a");
});

test("topCounts respects limit", () => {
	const map: Record<string, number> = {};
	for (let i = 0; i < 20; i++) map[`key${i}`] = i;
	const result = topCounts(map, 5);
	assert.equal(result.length, 5);
});

test("topCounts defaults to limit 10", () => {
	const map: Record<string, number> = {};
	for (let i = 0; i < 20; i++) map[`key${i}`] = i;
	const result = topCounts(map);
	assert.equal(result.length, 10);
});

// ── textPreview ───────────────────────────────────────────────────────────────

test("textPreview returns text unchanged when under limit", () => {
	const result = textPreview("hello world", 50);
	assert.ok(result.includes("hello world"));
});

test("textPreview collapses whitespace", () => {
	const result = textPreview("hello  \n  world", 50);
	assert.equal(result, "hello world");
});

test("textPreview truncates when over limit", () => {
	const result = textPreview("a".repeat(100), 10);
	assert.ok(result.length < 100);
});

// ── summaryTable ──────────────────────────────────────────────────────────────

test("summaryTable builds rows from items and columns", () => {
	const items = [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }];
	const columns = [
		{ key: "name", value: (item: typeof items[0]) => item.name },
		{ key: "age", value: (item: typeof items[0]) => item.age },
	];
	const table = summaryTable(items, columns);
	assert.deepEqual(table.columns, ["name", "age"]);
	assert.equal(table.rows.length, 2);
	assert.equal(table.count, 2);
	assert.equal(table.truncated, undefined);
});

test("summaryTable truncates at limit and reports truncated count", () => {
	const items = Array.from({ length: 30 }, (_, i) => ({ id: i }));
	const columns = [{ key: "id", value: (item: { id: number }) => item.id }];
	const table = summaryTable(items, columns, 10);
	assert.equal(table.rows.length, 10);
	assert.equal(table.count, 30);
	assert.equal(table.truncated, 20);
});

// ── artifactHints ─────────────────────────────────────────────────────────────

test("artifactHints returns empty object for empty reads", () => {
	const result = artifactHints([]);
	assert.deepEqual(result, {});
});

test("artifactHints returns empty object when all reads lack jsonPath", () => {
	const result = artifactHints([{ label: "test", jsonPath: "" }]);
	assert.deepEqual(result, {});
});

test("artifactHints builds jsonPaths and preferredReads for valid reads", () => {
	const reads = [
		{ label: "requests", jsonPath: "$.requests", kind: "array", count: 10 },
		{ label: "errors", jsonPath: "$.errors" },
	];
	const result = artifactHints(reads);
	assert.ok("artifact_hints" in result);
	const hints = (result as { artifact_hints: { jsonPaths: Record<string, string>; preferredReads: unknown[] } }).artifact_hints;
	assert.equal(hints.jsonPaths.requests, "$.requests");
	assert.equal(hints.jsonPaths.errors, "$.errors");
	assert.equal(hints.preferredReads.length, 2);
});
