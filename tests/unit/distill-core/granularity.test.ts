import test from "node:test";
import assert from "node:assert/strict";
import { compactSummaryValue } from "../../../src/distill-core/granularity.ts";

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
