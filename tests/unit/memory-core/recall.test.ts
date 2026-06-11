import test from "node:test";
import assert from "node:assert/strict";
import { recallByTokens } from "../../../src/memory-core/recall.ts";
import type { MemoryRecallEntry } from "../../../src/memory-core/types.ts";

function entry(over: Partial<MemoryRecallEntry>): MemoryRecallEntry {
	return {
		id: "id",
		title: "page",
		triggers: ["page"],
		scopeKind: "task",
		scopeKey: "task",
		kind: "sop",
		status: "active",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

test("recallByTokens uses IDF so specific entries beat common-token entries", () => {
	const entries = [
		entry({ id: "common", title: "login page", triggers: ["page"], updatedAt: "2026-01-01T00:00:00.000Z" }),
		entry({ id: "specific", title: "login checkout", triggers: ["checkout"], updatedAt: "2026-01-02T00:00:00.000Z" }),
		entry({ id: "other", title: "login page", triggers: ["page"], updatedAt: "2026-01-03T00:00:00.000Z" }),
	];
	const recalled = recallByTokens(entries, { tokens: ["login", "checkout", "page"] });
	assert.equal(recalled[0].entry.id, "specific", "rare checkout token must beat page/common-token matches");
});

test("recallByTokens ranks verification status then recency as tie breakers", () => {
	const entries = [
		entry({ id: "old", title: "checkout", triggers: ["checkout"], verification: "unverified", updatedAt: "2026-01-01T00:00:00.000Z" }),
		entry({ id: "fresh", title: "checkout", triggers: ["checkout"], verification: "fresh", updatedAt: "2025-01-01T00:00:00.000Z" }),
		entry({ id: "new", title: "checkout", triggers: ["checkout"], verification: "unverified", updatedAt: "2026-01-02T00:00:00.000Z" }),
	];
	const recalled = recallByTokens(entries, { tokens: ["checkout"] });
	assert.equal(recalled[0].entry.id, "fresh", "fresh verification outranks recency");
	assert.equal(recalled[1].entry.id, "new", "recency breaks ties within the same verification status");
});
