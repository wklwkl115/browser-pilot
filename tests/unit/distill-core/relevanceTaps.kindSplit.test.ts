import test from "node:test";
import assert from "node:assert/strict";
import { computeRelevanceMap } from "../../../src/distill-core/relevance.ts";
import { extractScalarTerm, extractUrlTerms } from "../../../src/distill-core/relevanceTaps.ts";
import { toPersistableMemoryTerm } from "../../../src/memory-core/types.ts";
import { extractToolRelevanceTerms } from "../../../src/tools/relevanceTaps.ts";

test("extractUrlTerms separates path tokens from query tokens", () => {
	const terms = extractUrlTerms("https://example.test/shop/checkout?q=alice@example.com&token=secret");
	assert(terms.some((term) => term.kind === "urlPathToken" && term.term === "shop"), "path tokens must be typed separately");
	assert(terms.some((term) => term.kind === "urlQueryToken" && term.term.includes("alice")), "query values must be typed as non-persistable urlQueryToken");
});

test("path and query URL tokens still feed live relevance scoring", () => {
	const path = computeRelevanceMap([{ ref: "pi-ref://control/checkout", fields: { name: "Checkout" } }], [{ term: "checkout", kind: "urlPathToken", source: "D" }]);
	const query = computeRelevanceMap([{ ref: "pi-ref://control/checkout", fields: { name: "Checkout" } }], [{ term: "checkout", kind: "urlQueryToken", source: "D" }]);
	assert.equal(path.boosted, 1);
	assert.equal(query.boosted, 1);
	assert.equal(path.byRef.get("pi-ref://control/checkout")?.score, query.byRef.get("pi-ref://control/checkout")?.score, "split URL kinds must preserve live url scoring");
});

test("explicit selector params use selectorLiteral, while prose scalars remain non-persistable", () => {
	const terms = extractToolRelevanceTerms("browser_observe", { selector: "#checkout", intent: "find Alice order" });
	assert(terms.some((term) => term.kind === "selectorLiteral" && term.term === "#checkout"));
	assert(terms.some((term) => term.kind === "literal" && term.term.includes("Alice")));
});

test("PersistableMemoryTerm admits only structural whitelist kinds", () => {
	assert.deepEqual(toPersistableMemoryTerm({ term: "#checkout", kind: "selectorLiteral", weight: 1.2 }), { term: "#checkout", kind: "selectorLiteral", weight: 1.2 });
	assert.deepEqual(toPersistableMemoryTerm({ term: "pi-ref://control/1", kind: "ref" }), { term: "pi-ref://control/1", kind: "ref" });
	assert.deepEqual(toPersistableMemoryTerm({ term: "checkout", kind: "urlPathToken" }), { term: "checkout", kind: "urlPathToken" });
	for (const blocked of [
		...extractScalarTerm("alice@example.com", "urlQueryToken"),
		...extractScalarTerm("find Alice order", "intent"),
		...extractScalarTerm("medical search", "query"),
		...extractScalarTerm("#from-script", "literal"),
	]) {
		assert.equal(toPersistableMemoryTerm(blocked), undefined, `${blocked.kind} must not be persistable`);
	}
});
