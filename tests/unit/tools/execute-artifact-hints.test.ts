import test from "node:test";
import assert from "node:assert/strict";
import { executeArtifactHints } from "../../../src/tools/registerExecuteTool.ts";

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
