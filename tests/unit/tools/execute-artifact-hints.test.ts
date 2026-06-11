import test from "node:test";
import assert from "node:assert/strict";
import { executeArtifactHints, executeResultNeedsArtifact, executeSummaryDataInline, executeSummaryPageUrl } from "../../../src/tools/registerExecuteTool.ts";

test("B3: execute artifact hints point agents at data and top-level result fields", () => {
	const hints = executeArtifactHints({ links: [{ title: "a" }], count: 1, meta: { ok: true }, extra: "ignored" }) as { preferredReads: Array<{ label: string; jsonPath: string }> };
	assert.ok(hints);
	assert.deepEqual(hints.preferredReads.map((item) => item.jsonPath), ["data", "data.links", "data.count", "data.meta"]);
});

test("B3: execute artifact hints handle array and scalar results", () => {
	assert.deepEqual((executeArtifactHints([1, 2]) as { preferredReads: Array<{ jsonPath: string }> }).preferredReads.map((item) => item.jsonPath), ["data"]);
	assert.deepEqual((executeArtifactHints("value") as { preferredReads: Array<{ jsonPath: string }> }).preferredReads.map((item) => item.jsonPath), ["data"]);
	assert.equal(executeArtifactHints(undefined), undefined);
});

test("P4.1: execute non-inline result summaries force a readable artifact", () => {
	assert.equal(executeSummaryDataInline({ ok: true }), true);
	assert.equal(executeSummaryDataInline({ type: "object", keyCount: 2 }), false);
	assert.equal(executeResultNeedsArtifact({ data: { ok: true } }), false);
	const rows = Array.from({ length: 80 }, (_, i) => ({ i, title: `title-${i}-${"x".repeat(80)}`, href: `https://example.test/${i}` }));
	assert.equal(executeResultNeedsArtifact({ data: { rows } }), true);
});

test("G12: execute summary page url prefers target tab url over effect frame url", () => {
	assert.equal(executeSummaryPageUrl({
		target: { url: "https://example.test/top" },
		effect: { url: "https://example.test/effect" },
		monitor: { url: "https://example.test/monitor" },
	}), "https://example.test/top");
});

test("G12: execute summary page url falls back to monitor urls before effect url", () => {
	assert.equal(executeSummaryPageUrl({ monitor: { url: "https://example.test/current" } }), "https://example.test/current");
	assert.equal(executeSummaryPageUrl({ monitor: { urlAfter: "https://example.test/after", urlBefore: "https://example.test/before" } }), "https://example.test/after");
	assert.equal(executeSummaryPageUrl({ monitor: { urlBefore: "https://example.test/before" } }), "https://example.test/before");
	assert.equal(executeSummaryPageUrl({ monitor: { url: "https://example.test/monitor" }, effect: { url: "https://example.test/effect" } }), "https://example.test/monitor");
});

test("G12: execute summary page url falls back to effect url", () => {
	assert.equal(executeSummaryPageUrl({
		effect: { url: "https://example.test/effect" },
	}), "https://example.test/effect");
});

test("G12: execute summary page url is absent without effect or monitor url", () => {
	assert.equal(executeSummaryPageUrl({ effect: { mutations: 0 }, monitor: { changed: 0 } }), undefined);
	assert.equal(executeSummaryPageUrl(null), undefined);
});
