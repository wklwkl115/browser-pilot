import type { AllocationOptions, Fact, FactGranularity, PlaneFloor, RenderPlan } from "./fact.js";
import { salienceValue } from "./fact.js";
import { tokenEstimate } from "./cost.js";
import { stableJson } from "../utils/json.js";

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

function renderingDensityCost(fact: Fact, granularity: Exclude<FactGranularity, "omit">, options: AllocationOptions): number {
	const rendering = fact.renderings[granularity];
	if (!rendering) return Number.POSITIVE_INFINITY;
	if (options.costModel !== "token") return rendering.cost;
	const text = rendering.text ?? (rendering.value !== undefined ? stableJson(rendering.value) : "");
	return Math.max(1, tokenEstimate(text));
}

export function allocateFacts(facts: Fact[], budget: number, floors: PlaneFloor[] = [], options: AllocationOptions = {}): RenderPlan {
	const plan: RenderPlan = new Map();
	let spent = 0;
	const floorByPlane = new Map(floors.map((floor) => [floor.plane, floor]));
	const usedByPlane = new Map<string, number>();
	for (const fact of facts) plan.set(fact.ref, "omit");

	const assign = (fact: Fact, granularity: Exclude<FactGranularity, "omit">, cost: number): void => {
		spent += cost;
		plan.set(fact.ref, granularity);
		usedByPlane.set(fact.plane, (usedByPlane.get(fact.plane) ?? 0) + 1);
	};

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
			assign(fact, wanted, cost);
		}
	}

	const ranked = facts
		.map((fact) => {
			const best = bestAvailableWithin(fact, Math.max(0, budget - spent));
			const cost = best ? renderingDensityCost(fact, best, options) : Number.POSITIVE_INFINITY;
			return { fact, best, density: cost > 0 && Number.isFinite(cost) ? salienceValue(fact.salience) / cost : 0 };
		})
		.sort((a, b) => b.density - a.density || salienceValue(b.fact.salience) - salienceValue(a.fact.salience));

	for (const item of ranked) {
		if (plan.get(item.fact.ref) !== "omit") continue;
		const floor = floorByPlane.get(item.fact.plane);
		if (floor?.maxFacts !== undefined) {
			const used = usedByPlane.get(item.fact.plane) ?? 0;
			if (used >= floor.maxFacts) continue;
		}
		const granularity = bestAvailableWithin(item.fact, budget - spent);
		if (!granularity) continue;
		const cost = renderingCost(item.fact, granularity);
		if (options.minDensity !== undefined && item.density < options.minDensity) break;
		assign(item.fact, granularity, cost);
	}

	if (budget - spent > budget * 0.12) {
		for (const item of ranked) {
			if (plan.get(item.fact.ref) !== "omit") continue;
			if (options.minDensity !== undefined && item.density < options.minDensity) continue;
			const floor = floorByPlane.get(item.fact.plane);
			if (floor?.maxFacts === undefined || (usedByPlane.get(item.fact.plane) ?? 0) < floor.maxFacts) continue;
			const granularity = bestAvailableWithin(item.fact, budget - spent);
			if (!granularity) continue;
			assign(item.fact, granularity, renderingCost(item.fact, granularity));
			if (budget - spent <= budget * 0.12) break;
		}
	}
	return plan;
}
