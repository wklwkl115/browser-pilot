import test from "node:test";
import assert from "node:assert/strict";
import { allocateFacts } from "../../../src/distill-core/allocate.ts";
import { renderFacts } from "../../../src/distill-core/render.ts";
import type { Fact } from "../../../src/distill-core/fact.ts";

function fact(ref: string, plane: Fact["plane"], score: number, costs: { full?: number; compact?: number; ref?: number }): Fact {
	return {
		ref,
		plane,
		salience: { actionability: score },
		renderings: {
			...(costs.full ? { full: { value: { ref, full: true }, cost: costs.full } } : {}),
			...(costs.compact ? { compact: { value: { ref }, cost: costs.compact } } : {}),
			...(costs.ref ? { ref: { text: ref, cost: costs.ref } } : {}),
		},
	};
}

test("allocateFacts keeps plane floors before density fill", () => {
	const facts = [
		fact("a", "entity", 10, { compact: 20, ref: 5 }),
		fact("b", "causal", 1, { compact: 20, ref: 5 }),
		fact("c", "entity", 100, { compact: 30, ref: 5 }),
	];
	const plan = allocateFacts(facts, 25, [{ plane: "causal", minFacts: 1, minGranularity: "compact" }]);
	assert.equal(plan.get("b"), "compact");
	assert.equal(plan.get("c"), "ref");
});

test("allocateFacts stops below the configured marginal density", () => {
	const facts = [
		fact("a", "entity", 100, { compact: 10 }),
		fact("b", "entity", 1, { compact: 100 }),
	];
	const plan = allocateFacts(facts, 200, [], { minDensity: 0.05 });
	assert.equal(plan.get("a"), "compact");
	assert.equal(plan.get("b"), "omit");
});

test("renderFacts groups selected renderings by plane and reports omissions", () => {
	const facts = [fact("a", "entity", 10, { compact: 10 }), fact("b", "diff", 1, { ref: 5 })];
	const plan = new Map([["a", "compact" as const], ["b", "omit" as const]]);
	const rendered = renderFacts(facts, plan);
	assert.deepEqual(rendered.entity, [{ ref: "a" }]);
	assert.deepEqual(rendered.omitted, [{ ref: "b", plane: "diff", reason: "budget" }]);
	assert.deepEqual(rendered.stats, { factsRendered: 1, factsOmitted: 1, truncationMarkers: 1 });
});
