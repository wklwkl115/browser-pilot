import test from "node:test";
import assert from "node:assert/strict";
import { extractToolRelevanceTerms } from "../../../src/tools/relevanceTaps.ts";
import { extractStringLiteralTerms, extractUrlTerms } from "../../../src/distill-core/relevanceTaps.ts";

test("extractStringLiteralTerms prefers selector-shaped literals and caps output", () => {
	const terms = extractStringLiteralTerms("document.querySelector('#pay-now'); console.log('ignored message'); const x = 'checkout';");
	assert.ok(terms.some((term) => term.term === "#pay-now" && (term.weight ?? 1) > 1));
	assert.ok(terms.some((term) => term.term === "checkout"));
	assert.ok(terms.length <= 8);
});

test("extractUrlTerms reads path and query values without network access", () => {
	const terms = extractUrlTerms("https://example.test/login?q=checkout");
	assert.ok(terms.some((term) => term.term === "login"));
	assert.ok(terms.some((term) => term.term === "checkout"));
});

test("extractToolRelevanceTerms uses the declarative tool table", () => {
	const execute = extractToolRelevanceTerms("browser_execute", { script: "document.querySelector('#search').click()" });
	assert.ok(execute.some((term) => term.term === "#search"));
	const artifact = extractToolRelevanceTerms("browser_artifact", { jsonPath: "data.actionables", query: "login" });
	assert.ok(artifact.some((term) => term.kind === "jsonPath"));
	assert.ok(artifact.some((term) => term.term === "login"));
});

test("extractToolRelevanceTerms returns no terms for tools without tap rows", () => {
	assert.deepEqual(extractToolRelevanceTerms("browser_screenshot", { filename: "x" }), []);
});
