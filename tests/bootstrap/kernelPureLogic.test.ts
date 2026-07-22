import test from "node:test";
import assert from "node:assert/strict";
import { mintRef, parseRef, isBrowserPilotRef, normalizeRef } from "../../src/kernels/refs/core.ts";
import { computeRelevanceMap } from "../../src/kernels/evidence/distill/relevance.ts";

test("refs kernel parses scoped refs and rejects malformed boundary values", () => {
	const scoped = mintRef("control", "login/button:1", { scope: "https://example.test/app path" });
	assert.equal(scoped, "bp-ref://control/https%3A%2F%2Fexample.test%2Fapp%20path/login/button:1");
	assert.deepEqual(parseRef(scoped), {
		scheme: "bp-ref",
		kind: "control",
		id: "login/button:1",
		scope: "https://example.test/app path",
	});
	assert.equal(isBrowserPilotRef(scoped), true);
	assert.equal(isBrowserPilotRef("bp-ref://control/"), false);
	assert.throws(() => parseRef("control/login"), /must start/);
	assert.throws(() => normalizeRef({ scheme: "bp-ref", kind: "control", id: "bad id" }), /Invalid Browser Pilot ref id/);
	assert.throws(() => normalizeRef({ scheme: "bp-ref", kind: "control", id: "ok", scope: "  " }), /scope cannot be empty/);
});

test("evidence relevance scores low, high, propagated, aged, and CJK signal edges", () => {
	const relevance = computeRelevanceMap([
		{ ref: "bp-ref://control/pay", fields: { name: "Pay invoice", role: "button", selector: "#pay-now" }, neighbors: { containerKey: "checkout", labelledBySources: ["bp-ref://label/pay"] } },
		{ ref: "bp-ref://control/cancel", fields: { name: "Cancel order", role: "button" }, neighbors: { containerKey: "checkout" } },
		{ ref: "bp-ref://control/profile", fields: { name: "个人中心", container: "账户" } },
	], [
		{ term: "pay", kind: "literal", source: "C", weight: 2 },
		{ term: "#pay-now", kind: "selectorLiteral", source: "A", weight: 1 },
		{ term: "个人中心", kind: "literal", source: "E", weight: 1 },
		{ term: "x", kind: "literal", source: "B", weight: 10 },
	]);
	const pay = relevance.byRef.get("bp-ref://control/pay");
	const cancel = relevance.byRef.get("bp-ref://control/cancel");
	const label = relevance.byRef.get("bp-ref://label/pay");
	const profile = relevance.byRef.get("bp-ref://control/profile");
	assert.ok(pay);
	assert.ok(cancel);
	assert.ok(label);
	assert.ok(profile);
	assert.ok(pay.score > cancel.score);
	assert.ok(cancel.score > 0);
	assert.ok(label.score < pay.score);
	assert.deepEqual(profile.sources, ["E"]);
	assert.deepEqual(relevance.signals, ["A", "C", "E"]);
	assert.equal(relevance.scoreFields({ name: "totally unrelated" }), 0);
});
