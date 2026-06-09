import test from "node:test";
import assert from "node:assert/strict";
import { fitInlineJsonToBudget, inlineJsonToolResult } from "../../../src/tools/toolAdapter.ts";

function arrayReadResult(n: number, blobChars = 200) {
	const items = Array.from({ length: n }, (_, i) => ({ id: i, blob: "x".repeat(blobChars) }));
	return { mode: "json", jsonPath: "data.items", summary: { type: "array", count: n }, value: { type: "array", count: n, offset: 0, limit: n, items, nextOffset: null } } as Record<string, unknown>;
}

test("inlineJsonToolResult emits PARSEABLE JSON for an over-budget array read (no mid-token truncation)", () => {
	const out = inlineJsonToolResult(arrayReadResult(25), { mode: "json" }, { maxChars: 800 }, "browser_artifact");
	const text = out.content[0].text;
	assert.doesNotMatch(text, /\[truncated/, "must not emit the text head/tail truncation marker for json reads");
	const parsed = JSON.parse(text) as { value: { type: string; count: number; items: unknown[]; nextOffset: number | null; budgetTrimmed?: boolean } };
	assert.equal(parsed.value.type, "array");
	assert.ok(parsed.value.items.length >= 1 && parsed.value.items.length < 25, `items windowed to fit, got ${parsed.value.items.length}`);
	assert.equal(parsed.value.count, 25, "total count preserved so the agent can page");
	assert.equal(parsed.value.budgetTrimmed, true);
	assert.equal(parsed.value.nextOffset, parsed.value.items.length, "nextOffset points past the returned window");
});

test("inlineJsonToolResult picks the LARGEST fitting window (binary search, not a coarse step)", () => {
	// blob small enough that several items fit; assert it returns the max prefix, not an over-shrunk 1.
	const out = inlineJsonToolResult(arrayReadResult(25, 40), { mode: "json" }, { maxChars: 1200 }, "browser_artifact");
	const parsed = JSON.parse(out.content[0].text) as { value: { items: unknown[] } };
	assert.ok(parsed.value.items.length >= 4, `expected a multi-item window, got ${parsed.value.items.length}`);
});

test("fitInlineJsonToBudget leaves within-budget values untouched", () => {
	const small = { mode: "json", value: { type: "array", count: 2, offset: 0, limit: 2, items: [{ a: 1 }, { b: 2 }], nextOffset: null } } as Record<string, unknown>;
	const out = fitInlineJsonToBudget(small, 10_000) as typeof small;
	assert.equal(out, small);
	assert.equal((out.value as { items: unknown[] }).items.length, 2);
	assert.equal((out.value as { budgetTrimmed?: boolean }).budgetTrimmed, undefined);
});

test("fitInlineJsonToBudget windows an over-budget object by keys and stays valid JSON", () => {
	const obj = { mode: "json", value: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "x".repeat(80)])) } as Record<string, unknown>;
	const out = fitInlineJsonToBudget(obj, 500) as { value: Record<string, unknown> };
	JSON.parse(JSON.stringify(out)); // must be serializable/valid
	const keys = Object.keys(out.value).filter((k) => k !== "truncatedKeys");
	assert.ok(keys.length < 20, "object keys reduced to fit");
	assert.equal(out.value.truncatedKeys, 20 - keys.length);
});
