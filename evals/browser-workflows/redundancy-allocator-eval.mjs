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

function summaryFact(ref, role, name, score) {
	const value = { ref, kind: "summary", role, name };
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

function selectedRefs(plan) {
	return new Set(Array.from(plan.entries()).filter(([, granularity]) => granularity !== "omit").map(([ref]) => ref));
}

function runProductionAllocation({ facts, budget, minDensity }) {
	const plan = allocateFacts(facts, budget, [], minDensity === undefined ? {} : { minDensity });
	const refs = selectedRefs(plan);
	const rendered = renderFacts(facts, plan);
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
	summaryFact("pi-ref://summary/status", "status", "Status: payment required", 220),
	summaryFact("pi-ref://summary/filter", "filter", "Filter controls available", 200),
	summaryFact("pi-ref://summary/cart", "cart", "Cart total and checkout visible", 180),
];

const completeListCase = {
	name: "complete-list-recall",
	budget: 5_000,
	minDensity: undefined,
	facts: productFacts,
	requiredRefs: requiredCompleteList,
	bar: "complete",
};

const tailTargetCase = {
	name: "targeted-tail-relevance",
	budget: 900,
	minDensity: 2.0,
	facts: productFacts.map((fact) => fact.ref.endsWith("/product-23") ? productFact(23, { relevance: 700 }) : fact),
	requiredRefs: ["pi-ref://entity/product-23"],
	bar: "complete",
};

const representativeCase = {
	name: "representative-summary",
	budget: 1_400,
	minDensity: 1.0,
	facts: [...productFacts, ...summaryFacts],
	requiredRefs: summaryFacts.map((fact) => fact.ref),
	bar: "at-least-2-of-3",
};

const cases = [completeListCase, tailTargetCase, representativeCase].map((item) => {
	const production = runProductionAllocation({ facts: item.facts, budget: item.budget, minDensity: item.minDensity });
	const productionCoverage = coverage(production, item.requiredRefs);
	const passed = item.bar === "at-least-2-of-3" ? productionCoverage.includedCount >= 2 : productionCoverage.complete;
	return {
		name: item.name,
		budget: item.budget,
		minDensity: item.minDensity,
		bar: item.bar,
		productionRelevanceProtected: { ...production, coverage: productionCoverage },
		passed,
	};
});

const decision = {
	relevanceProtectedRedundancySupported: cases.every((item) => item.passed),
	reason: "Production allocator applies redundancy only to facts with salience.relevance <= 0; explicit relevance is a hard exemption.",
	gates: [
		"complete-list-recall production coverage must remain 24/24",
		"targeted-tail-relevance production coverage must remain 1/1",
		"representative-summary production coverage must be at least 2/3",
	],
};

const summary = {
	schemaVersion: 1,
	evalId: "p3b-redundancy-allocator-evidence",
	candidatePolicy: "relevance-protected 1/sqrt(N) penalty by plane/kind/role/containerName bucket inside allocateFacts density scoring",
	status: cases.every((item) => item.passed) ? "passed" : "failed-candidate",
	cases,
	decision,
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, summaryPath: path.relative(root, outPath).replace(/\\/g, "/"), status: summary.status, decision }, null, 2));
if (summary.status !== "passed") process.exitCode = 1;
