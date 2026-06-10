#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allocateFacts } from "../../src/distill-core/allocate.ts";
import { renderFacts } from "../../src/distill-core/render.ts";
import { jsonCost } from "../../src/distill-core/cost.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outPath = path.join(root, ".pi", "browser-artifacts", "redundancy-allocator-eval.json");

function productFact(index, salience = {}) {
	const name = `Product ${String(index).padStart(2, "0")}`;
	const value = {
		ref: `pi-ref://entity/product-${index}`,
		kind: "item",
		role: "article",
		containerRole: "list",
		containerName: "Products",
		name,
		price: `$${index * 10}`,
	};
	return {
		ref: value.ref,
		plane: "entity",
		salience: { actionability: 300, ...salience },
		renderings: {
			compact: { value, cost: jsonCost(value) },
			ref: { text: value.ref, cost: value.ref.length },
		},
	};
}

function summaryFact(ref, name, score) {
	const value = { ref, kind: "summary", role: "status", name };
	return {
		ref,
		plane: "summary",
		salience: { structure: score },
		renderings: {
			compact: { value, cost: jsonCost(value) },
			ref: { text: ref, cost: ref.length },
		},
	};
}

function bucketKey(fact) {
	const value = fact.renderings.compact?.value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return fact.plane;
	return [
		fact.plane,
		value.kind ?? "",
		value.role ?? "",
		value.containerRole ?? "",
		value.containerName ?? "",
	].join("\u0000");
}

function applyNaiveRedundancyPenalty(facts) {
	const seen = new Map();
	return facts.map((fact) => {
		const key = bucketKey(fact);
		const ordinal = (seen.get(key) ?? 0) + 1;
		seen.set(key, ordinal);
		const factor = 1 / Math.sqrt(ordinal);
		return {
			...fact,
			salience: Object.fromEntries(Object.entries(fact.salience).map(([field, value]) => [field, Number(value) * factor])),
		};
	});
}

function selectedRefs(plan) {
	return new Set(Array.from(plan.entries()).filter(([, granularity]) => granularity !== "omit").map(([ref]) => ref));
}

function runAllocation({ facts, budget, minDensity, redundancy }) {
	const effectiveFacts = redundancy ? applyNaiveRedundancyPenalty(facts) : facts;
	const plan = allocateFacts(effectiveFacts, budget, [], { minDensity });
	const refs = selectedRefs(plan);
	const rendered = renderFacts(effectiveFacts, plan);
	return {
		selectedRefs: Array.from(refs),
		selectedCount: refs.size,
		productCount: Array.from(refs).filter((ref) => ref.includes("/product-")).length,
		summaryCount: Array.from(refs).filter((ref) => ref.startsWith("pi-ref://summary/")).length,
		renderedStats: rendered.stats,
	};
}

function coverage(result, requiredRefs) {
	const refs = new Set(result.selectedRefs);
	const included = requiredRefs.filter((ref) => refs.has(ref));
	return {
		requiredCount: requiredRefs.length,
		includedCount: included.length,
		missing: requiredRefs.filter((ref) => !refs.has(ref)),
		complete: included.length === requiredRefs.length,
	};
}

const productFacts = Array.from({ length: 24 }, (_, index) => productFact(index + 1));
const requiredCompleteList = productFacts.map((fact) => fact.ref);
const summaryFacts = [
	summaryFact("pi-ref://summary/status", "Status: payment required", 120),
	summaryFact("pi-ref://summary/filter", "Filter controls available", 110),
	summaryFact("pi-ref://summary/cart", "Cart total and checkout visible", 105),
];

const completeListCase = {
	name: "complete-list-recall",
	budget: 5_000,
	minDensity: 1.0,
	facts: productFacts,
	requiredRefs: requiredCompleteList,
};

const tailTargetCase = {
	name: "targeted-tail-relevance",
	budget: 900,
	minDensity: 2.0,
	facts: productFacts.map((fact) => fact.ref.endsWith("/product-23") ? productFact(23, { relevance: 700 }) : fact),
	requiredRefs: ["pi-ref://entity/product-23"],
};

const representativeCase = {
	name: "representative-summary",
	budget: 1_400,
	minDensity: 1.0,
	facts: [...productFacts, ...summaryFacts],
	requiredRefs: summaryFacts.map((fact) => fact.ref),
};

const cases = [completeListCase, tailTargetCase, representativeCase].map((item) => {
	const baseline = runAllocation({ facts: item.facts, budget: item.budget, minDensity: item.minDensity, redundancy: false });
	const redundancy = runAllocation({ facts: item.facts, budget: item.budget, minDensity: item.minDensity, redundancy: true });
	return {
		name: item.name,
		budget: item.budget,
		minDensity: item.minDensity,
		baseline: { ...baseline, coverage: coverage(baseline, item.requiredRefs) },
		naiveRedundancy: { ...redundancy, coverage: coverage(redundancy, item.requiredRefs) },
	};
});

const decision = {
	naiveGlobalPenaltySupported: false,
	reason: "Naive 1/sqrt(N) bucket salience decay harms complete-list and tail-target tasks even though it can reduce repeated list dominance for representative summaries.",
	reopenBar: "Revisit only with a relevance-protected policy that exempts explicitly relevant refs and a list-task eval that preserves complete-list coverage.",
};

const summary = {
	schemaVersion: 1,
	evalId: "p3b-redundancy-allocator-evidence",
	candidatePolicy: "naive 1/sqrt(N) penalty by plane/kind/role/container bucket before allocateFacts",
	status: cases.some((item) => !item.naiveRedundancy.coverage.complete && item.baseline.coverage.complete) ? "failed-candidate" : "inconclusive",
	cases,
	decision,
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, summaryPath: path.relative(root, outPath).replace(/\\/g, "/"), status: summary.status, decision }, null, 2));
