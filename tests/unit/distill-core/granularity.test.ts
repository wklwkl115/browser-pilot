import test from "node:test";
import assert from "node:assert/strict";
import { compactSummaryValue } from "../../../src/distill-core/granularity.ts";
import { stableJson } from "../../../src/utils/json.ts";

function buggyCompactSummaryValueReference(value: unknown, limits: { stringChars: number; arrayItems: number; tableRows: number }, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return value.length > limits.stringChars ? `${value.slice(0, limits.stringChars)}…` : value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value !== "object") return String(value);
	if (Array.isArray(value)) return value.slice(0, limits.arrayItems).map((item) => buggyCompactSummaryValueReference(item, limits, depth + 1));
	if (depth >= 5) return { type: "object", keyCount: Object.keys(value as Record<string, unknown>).length };
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.columns) && Array.isArray(record.rows)) {
		const rows = record.rows.slice(0, limits.tableRows).map((row) => Array.isArray(row) ? row.map((cell) => buggyCompactSummaryValueReference(cell, limits, depth + 1)) : row);
		return { ...record, rows, truncated: Number(record.count || rows.length) > rows.length ? Number(record.count || rows.length) - rows.length : record.truncated };
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) out[key] = buggyCompactSummaryValueReference(item, limits, depth + 1);
	return out;
}

function makeDeepArray(depth: number): unknown {
	let value: unknown = 1;
	for (let i = 0; i < depth; i += 1) value = [value];
	return value;
}

function makeDeepObject(depth: number): Record<string, unknown> {
	let value: Record<string, unknown> = { leaf: 1 };
	for (let i = 0; i < depth; i += 1) value = { child: value };
	return value;
}

function unwrapNestedArray(value: unknown): { depth: number; tail: unknown } {
	let depth = 0;
	let current = value;
	while (Array.isArray(current)) {
		depth += 1;
		current = current[0];
	}
	return { depth, tail: current };
}

function unwrapNestedObject(value: unknown): { depth: number; tail: unknown } {
	let depth = 0;
	let current = value;
	while (current && typeof current === "object" && !Array.isArray(current) && Object.hasOwn(current, "child")) {
		depth += 1;
		current = (current as { child: unknown }).child;
	}
	return { depth, tail: current };
}

test("compactSummaryValue replaces objects beyond depth five with a stub", () => {
	const compacted = compactSummaryValue({ a: { b: { c: { d: { e: { f: 1, g: 2 } } } } } }, { stringChars: 20, arrayItems: 5, tableRows: 5 });
	assert.deepEqual(compacted, { a: { b: { c: { d: { e: { type: "object", keyCount: 2 } } } } } });
});

test("compactSummaryValue marks truncated strings with an ellipsis", () => {
	assert.equal(compactSummaryValue("abcdef", { stringChars: 3, arrayItems: 5, tableRows: 5 }), "abc…");
});

test("compactSummaryValue reports table truncated counts", () => {
	const compacted = compactSummaryValue({ columns: ["name"], rows: [["a"], ["b"], ["c"]], count: 3 }, { stringChars: 20, arrayItems: 5, tableRows: 2 });
	assert.deepEqual(compacted, { columns: ["name"], rows: [["a"], ["b"]], count: 3, truncated: 1 });
});

test("compactSummaryValue slices arrays silently as a presentation cap", () => {
	assert.deepEqual(compactSummaryValue([1, 2, 3], { stringChars: 20, arrayItems: 2, tableRows: 5 }), [1, 2]);
});

test("compactSummaryValue keeps shallow structures identical to the legacy recursion order", () => {
	const fixture = {
		title: "Interactive Fixture",
		rows: [["alpha", { nested: [1, { kind: "button", label: "Launch workflow", flags: [true, false] }] }]],
		metadata: {
			tags: ["search", "pay", "ax"],
			count: 3,
		},
	};
	const limits = { stringChars: 32, arrayItems: 3, tableRows: 2 };
	assert.deepEqual(compactSummaryValue(fixture, limits), buggyCompactSummaryValueReference(fixture, limits));
});

test("compactSummaryValue bounds deep arrays that previously overflowed", () => {
	const deepArray = makeDeepArray(10_000);
	const limits = { stringChars: 20, arrayItems: 2, tableRows: 2 };
	assert.throws(() => buggyCompactSummaryValueReference(deepArray, limits), RangeError);
	const compacted = compactSummaryValue(deepArray, limits);
	const unwrapped = unwrapNestedArray(compacted);
	assert.equal(unwrapped.depth, 64);
	assert.deepEqual(unwrapped.tail, { type: "array", length: 1 });
	assert.doesNotThrow(() => stableJson(compacted));
});

test("compactSummaryValue keeps deep objects on the existing object stub path", () => {
	const compacted = compactSummaryValue(makeDeepObject(10_000), { stringChars: 20, arrayItems: 2, tableRows: 2 });
	const unwrapped = unwrapNestedObject(compacted);
	assert.equal(unwrapped.depth, 5);
	assert.deepEqual(unwrapped.tail, { type: "object", keyCount: 1 });
	assert.doesNotThrow(() => stableJson(compacted));
});
