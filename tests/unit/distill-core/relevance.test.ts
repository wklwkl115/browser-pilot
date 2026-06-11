import test from "node:test";
import assert from "node:assert/strict";
import { computeRelevanceMap } from "../../../src/distill-core/relevance.ts";
import { assertRelevanceTuningBounds } from "../../../src/distill-core/relevanceTuning.ts";

test("computeRelevanceMap returns no boosts for empty terms", () => {
	const result = computeRelevanceMap([{ ref: "pi-ref://control/pay", fields: { name: "Pay now" } }], []);
	assert.equal(result.boosted, 0);
	assert.equal(result.byRef.size, 0);
	assert.equal(result.scoreFields({ name: "Pay now" }), 0);
});

test("computeRelevanceMap matches CJK and mixed literals", () => {
	const result = computeRelevanceMap([
		{ ref: "pi-ref://control/search", fields: { name: "搜索 商品", role: "searchbox" } },
		{ ref: "pi-ref://control/login", fields: { name: "登录", role: "button" } },
	], [{ term: "搜索", kind: "literal", source: "A" }]);
	assert.equal(result.boosted, 1);
	assert.ok((result.byRef.get("pi-ref://control/search")?.score ?? 0) > 0);
	assert.deepEqual(result.sourcesForRef("pi-ref://control/search"), ["A"]);
});

test("computeRelevanceMap propagates through container neighbors conservatively", () => {
	const result = computeRelevanceMap([
		{ ref: "pi-ref://text/billing", fields: { name: "Billing address" }, neighbors: { containerKey: "form checkout" } },
		{ ref: "pi-ref://control/postcode", fields: { name: "Postcode" }, neighbors: { containerKey: "form checkout" } },
	], [{ term: "billing", kind: "literal", source: "A" }]);
	const direct = result.byRef.get("pi-ref://text/billing")?.score ?? 0;
	const propagated = result.byRef.get("pi-ref://control/postcode")?.score ?? 0;
	assert.ok(direct > propagated && propagated > 0);
});

test("computeRelevanceMap supports URL and intent source tags", () => {
	const result = computeRelevanceMap([
		{ ref: "pi-ref://control/login", fields: { name: "Sign in", role: "button", selector: "#login" } },
	], [
		{ term: "login", kind: "urlPathToken", source: "D" },
		{ term: "login", kind: "intent", source: "E" },
	]);
	assert.equal(result.boosted, 1);
	assert.deepEqual(result.sourcesForRef("pi-ref://control/login"), ["D", "E"]);
});

test("computeRelevanceMap supports memory source F below direct live signals", () => {
	const memory = computeRelevanceMap([
		{ ref: "pi-ref://control/checkout", fields: { name: "Checkout" } },
	], [{ term: "checkout", kind: "urlPathToken", source: "F" }]);
	const live = computeRelevanceMap([
		{ ref: "pi-ref://control/checkout", fields: { name: "Checkout" } },
	], [{ term: "checkout", kind: "urlPathToken", source: "D" }]);
	assert.deepEqual(memory.sourcesForRef("pi-ref://control/checkout"), ["F"]);
	assert((memory.byRef.get("pi-ref://control/checkout")?.score ?? 0) < (live.byRef.get("pi-ref://control/checkout")?.score ?? 0));
});

test("computeRelevanceMap keeps memory F from displacing a full live term ring", () => {
	const inputs = [
		{ ref: "pi-ref://control/live", fields: { name: "live31" } },
		{ ref: "pi-ref://control/memory", fields: { name: "memorytarget" } },
	];
	const liveTerms = Array.from({ length: 32 }, (_, index) => ({ term: `live${index}`, kind: "literal" as const, source: "A" as const }));
	const baseline = computeRelevanceMap(inputs, liveTerms);
	const withMemory = computeRelevanceMap(inputs, [...liveTerms, { term: "memorytarget", kind: "urlPathToken", source: "F" }]);
	assert.deepEqual(withMemory.byRef, baseline.byRef);
	assert(!withMemory.signals.includes("F"));
});

test("relevance tuning bounds stay conservative", () => {
	assert.equal(assertRelevanceTuningBounds(), true);
});
