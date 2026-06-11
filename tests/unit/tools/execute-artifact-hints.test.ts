import test from "node:test";
import assert from "node:assert/strict";
import { executeArtifactHints, executeSummaryPageUrl } from "../../../src/tools/registerExecuteTool.ts";

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

test("G12: execute summary page url prefers effect url", () => {
	assert.equal(executeSummaryPageUrl({
		effect: { url: "https://example.test/effect" },
		monitor: { url: "https://example.test/monitor" },
	}), "https://example.test/effect");
});

test("G12: execute summary page url falls back to monitor urls", () => {
	assert.equal(executeSummaryPageUrl({ monitor: { url: "https://example.test/current" } }), "https://example.test/current");
	assert.equal(executeSummaryPageUrl({ monitor: { urlAfter: "https://example.test/after", urlBefore: "https://example.test/before" } }), "https://example.test/after");
	assert.equal(executeSummaryPageUrl({ monitor: { urlBefore: "https://example.test/before" } }), "https://example.test/before");
});

test("G12: execute summary page url is absent without effect or monitor url", () => {
	assert.equal(executeSummaryPageUrl({ effect: { mutations: 0 }, monitor: { changed: 0 } }), undefined);
	assert.equal(executeSummaryPageUrl(null), undefined);
});
