import type { Fact, FactGranularity, PlaneFloor, RenderPlan } from "./fact.js";
import { salienceValue } from "./fact.js";

const GRANULARITY_ORDER: Array<Exclude<FactGranularity, "omit">> = ["full", "compact", "line", "ref"];

function cheapestAvailable(fact: Fact): Exclude<FactGranularity, "omit"> | undefined {
	for (const granularity of [...GRANULARITY_ORDER].reverse()) if (fact.renderings[granularity]) return granularity;
	return undefined;
}

function bestAvailableWithin(fact: Fact, remaining: number): Exclude<FactGranularity, "omit"> | undefined {
	for (const granularity of GRANULARITY_ORDER) {
		const rendering = fact.renderings[granularity];
		if (rendering && rendering.cost <= remaining) return granularity;
	}
	return undefined;
}

function renderingCost(fact: Fact, granularity: Exclude<FactGranularity, "omit">): number {
	return fact.renderings[granularity]?.cost ?? Number.POSITIVE_INFINITY;
}

export function allocateFacts(facts: Fact[], budget: number, floors: PlaneFloor[] = []): RenderPlan {
	const plan: RenderPlan = new Map();
	let spent = 0;
	const byRef = new Map(facts.map((fact) => [fact.ref, fact]));
	const floorByPlane = new Map(floors.map((floor) => [floor.plane, floor]));
	for (const fact of facts) plan.set(fact.ref, "omit");

	for (const floor of floors) {
		if (!floor.minFacts) continue;
		const candidates = facts
			.filter((fact) => fact.plane === floor.plane)
			.sort((a, b) => salienceValue(b.salience) - salienceValue(a.salience));
		for (const fact of candidates.slice(0, floor.minFacts)) {
			const wanted = floor.minGranularity && fact.renderings[floor.minGranularity] ? floor.minGranularity : cheapestAvailable(fact);
			if (!wanted) continue;
			const cost = renderingCost(fact, wanted);
			if (spent + cost > budget) continue;
			plan.set(fact.ref, wanted);
			spent += cost;
		}
	}

	const ranked = facts
		.map((fact) => {
			const best = bestAvailableWithin(fact, Math.max(0, budget - spent));
			const cost = best ? renderingCost(fact, best) : Number.POSITIVE_INFINITY;
			return { fact, best, density: cost > 0 && Number.isFinite(cost) ? salienceValue(fact.salience) / cost : 0 };
		})
		.sort((a, b) => b.density - a.density || salienceValue(b.fact.salience) - salienceValue(a.fact.salience));

	for (const item of ranked) {
		if (plan.get(item.fact.ref) !== "omit") continue;
		const floor = floorByPlane.get(item.fact.plane);
		if (floor?.maxFacts !== undefined) {
			const used = [...plan.entries()].filter(([ref, granularity]) => granularity !== "omit" && byRef.get(ref)?.plane === item.fact.plane).length;
			if (used >= floor.maxFacts) continue;
		}
		const granularity = bestAvailableWithin(item.fact, budget - spent);
		if (!granularity) continue;
		spent += renderingCost(item.fact, granularity);
		plan.set(item.fact.ref, granularity);
	}
	return plan;
}
