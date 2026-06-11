import test from "node:test";
import assert from "node:assert/strict";
import { allocateFacts } from "../../../src/distill-core/allocate.ts";
import { tokenEstimate } from "../../../src/distill-core/cost.ts";
import { renderFacts } from "../../../src/distill-core/render.ts";
import { fitSalienceEnvelopeBudget } from "../../../src/distill-core/salienceEnvelope.ts";
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

test("allocateFacts tie-breaks floor candidates by ref", () => {
	const facts = [
		fact("b", "entity", 10, { compact: 10 }),
		fact("a", "entity", 10, { compact: 10 }),
	];
	const plan = allocateFacts(facts, 10, [{ plane: "entity", minFacts: 1, minGranularity: "compact" }]);
	assert.equal(plan.get("a"), "compact");
	assert.equal(plan.get("b"), "omit");
});

test("allocateFacts tie-breaks density candidates by ref", () => {
	const facts: Fact[] = [
		{ ref: "b", plane: "entity", salience: { actionability: 10 }, renderings: { compact: { value: { ref: "b", kind: "b" }, cost: 10 } } },
		{ ref: "a", plane: "entity", salience: { actionability: 10 }, renderings: { compact: { value: { ref: "a", kind: "a" }, cost: 10 } } },
	];
	const plan = allocateFacts(facts, 10);
	assert.equal(plan.get("a"), "compact");
	assert.equal(plan.get("b"), "omit");
});

test("allocateFacts can rank density by estimated token cost without changing byte budget", () => {
	assert.ok(tokenEstimate("页面") > tokenEstimate("go"));
	const facts: Fact[] = [
		{ ref: "cjk", plane: "summary", salience: { actionability: 12 }, renderings: { compact: { text: "项目".repeat(30), cost: 60 } } },
		{ ref: "latin", plane: "summary", salience: { actionability: 11 }, renderings: { compact: { text: "a".repeat(60), cost: 60 } } },
	];
	const bytePlan = allocateFacts(facts, 60);
	const tokenPlan = allocateFacts(facts, 60, [], { costModel: "token" });
	assert.equal(bytePlan.get("cjk"), "compact");
	assert.equal(bytePlan.get("latin"), "omit");
	assert.equal(tokenPlan.get("cjk"), "omit");
	assert.equal(tokenPlan.get("latin"), "compact");
});

test("allocateFacts redistributes surplus budget past plane maxFacts", () => {
	const facts = [
		fact("a", "entity", 100, { compact: 10 }),
		fact("b", "entity", 90, { compact: 10 }),
		fact("c", "entity", 80, { compact: 10 }),
	];
	const plan = allocateFacts(facts, 30, [{ plane: "entity", maxFacts: 1 }]);
	assert.equal(plan.get("a"), "compact");
	assert.equal(plan.get("b"), "compact");
	assert.equal(plan.get("c"), "compact");
});

test("allocateFacts honors a granularity ceiling", () => {
	const facts = [
		fact("a", "entity", 100, { full: 10, compact: 10, ref: 1 }),
	];
	const plan = allocateFacts(facts, 10, [], { granularityCeiling: "compact" });
	assert.equal(plan.get("a"), "compact");
});

test("allocateFacts keeps existing behavior when granularity ceiling is omitted", () => {
	const facts = [
		fact("a", "entity", 100, { full: 10, compact: 10, ref: 1 }),
	];
	const plan = allocateFacts(facts, 10);
	assert.equal(plan.get("a"), "full");
});

test("allocateFacts gives stable refs a continuity bonus without locking them", () => {
	const facts = [
		fact("stable", "entity", 10, { compact: 10 }),
		fact("fresh", "entity", 11, { compact: 10 }),
		fact("winner", "entity", 20, { compact: 10 }),
	];
	const plan = allocateFacts(facts, 20, [], { stableRefs: new Set(["stable"]) });
	assert.equal(plan.get("stable"), "compact");
	assert.equal(plan.get("winner"), "compact");
	assert.equal(plan.get("fresh"), "omit");
});

test("allocateFacts exempts relevant tail facts from redundancy penalty", () => {
	const facts: Fact[] = Array.from({ length: 5 }, (_, index) => {
		const n = index + 1;
		return {
			ref: `p${n}`,
			plane: "entity",
			salience: n === 5 ? { actionability: 1, relevance: 100 } : { actionability: 100 },
			renderings: {
				compact: {
					value: { ref: `p${n}`, kind: "item", role: "article", containerName: "Products" },
					cost: 10,
				},
			},
		};
	});
	const plan = allocateFacts(facts, 10);
	assert.equal(plan.get("p5"), "compact");
	assert.equal(plan.get("p1"), "omit");
});

test("renderFacts groups selected renderings by plane and reports omissions", () => {
	const facts = [fact("a", "entity", 10, { compact: 10 }), fact("b", "diff", 1, { ref: 5 })];
	const plan = new Map([["a", "compact" as const], ["b", "omit" as const]]);
	const rendered = renderFacts(facts, plan);
	assert.deepEqual(rendered.entity, [{ ref: "a" }]);
	assert.deepEqual(rendered.omitted, [{ ref: "b", plane: "diff", reason: "budget" }]);
	assert.deepEqual(rendered.stats, { factsRendered: 1, factsOmitted: 1, truncationMarkers: 1 });
});

test("fitSalienceEnvelopeBudget preserves entities referenced by nextActions", () => {
	const envelope = {
		tool: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		renderer: "salience-v1" as const,
		summary: { abmlIntegrated: true, summaryTruncatedToBudget: true, summaryOmitted: ["focus"] },
		entities: [
			...Array.from({ length: 20 }, (_, i) => ({ ref: `pi-ref://control/noise-${i}`, kind: "control", role: "button", name: `noise ${i} ${"pad ".repeat(40)}` })),
			{ ref: "pi-ref://control/submit-hidden", kind: "control", role: "button", name: "Sign in" },
		],
		nextActions: ["read(pi-ref://control/submit-hidden)", "click(pi-ref://control/submit-hidden)"],
	};
	const fitted = fitSalienceEnvelopeBudget(envelope, 2_500);
	assert.equal(fitted.entities?.[0]?.ref, "pi-ref://control/submit-hidden");
});

test("fitSalienceEnvelopeBudget compacts entities to allocator-priced fields", () => {
	const envelope = {
		tool: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		renderer: "salience-v1" as const,
		summary: { abmlIntegrated: true },
		entities: [
			{
				ref: "pi-ref://control/pay",
				kind: "control",
				role: "button",
				name: "Pay now",
				label: "Pay immediately",
				hints: { selector: "#pay", listContainer: true, itemCount: 24 },
				state: { disabled: false, description: "checkout ".repeat(220) },
				locators: [{ by: "css", value: "#pay" }],
				geometry: { box: { x: 1, y: 2, w: 3, h: 4 } },
			},
		],
	};
	const fitted = fitSalienceEnvelopeBudget(envelope, 1_000, { granularityCeiling: "compact" });
	assert.deepEqual(fitted.entities?.[0], {
		ref: "pi-ref://control/pay",
		kind: "control",
		role: "button",
		name: "Pay now",
		hints: { selector: "#pay" },
	});
});
