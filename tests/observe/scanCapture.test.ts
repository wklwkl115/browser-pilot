import assert from "node:assert/strict";
import test from "node:test";
import { axCacheKeyForPage } from "../../src/commands/observe/scanCapture.ts";

test("AX cache identity requires page epoch and includes every change discriminator", () => {
	assert.equal(axCacheKeyForPage({ changeSeq: 1, url: "https://example.test" }), undefined);
	const base = { changeSeq: 1, pageEpoch: "page-1", documentId: "doc-1", url: "https://example.test" };
	const key = axCacheKeyForPage(base);
	for (const changed of [
		{ ...base, pageEpoch: "page-2" },
		{ ...base, documentId: "doc-2" },
		{ ...base, changeSeq: 2 },
		{ ...base, url: "https://example.test/next" },
	]) assert.notEqual(key, axCacheKeyForPage(changed));
});
