import type { AllocationOptions, Fact, FactGranularity, PlaneFloor, RenderPlan } from "./fact.js";
import { FACT_GRANULARITY_ORDER, salienceValue } from "./fact.js";
import { tokenEstimate } from "./cost.js";
import { stableJson } from "../../../utils/json.js";
import { isRecord } from "../../../utils/records.js";

function allowedByCeiling(granularity: Exclude<FactGranularity, "omit">, ceiling?: Exclude<FactGranularity, "omit">): boolean {
	if (!ceiling) return true;
	return FACT_GRANULARITY_ORDER.indexOf(granularity) >= FACT_GRANULARITY_ORDER.indexOf(ceiling);
}

function cheapestAvailable(fact: Fact): Exclude<FactGranularity, "omit"> | undefined {
	for (const granularity of [...FACT_GRANULARITY_ORDER].reverse()) if (fact.renderings[granularity]) return granularity;
	return undefined;
}

function bestAvailableWithin(fact: Fact, remaining: number, ceiling?: Exclude<FactGranularity, "omit">): Exclude<FactGranularity, "omit"> | undefined {
	for (const granularity of FACT_GRANULARITY_ORDER) {
		if (!allowedByCeiling(granularity, ceiling)) continue;
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

function renderingRecord(fact: Fact): Record<string, unknown> | undefined {
	for (const granularity of FACT_GRANULARITY_ORDER) {
		const value = fact.renderings[granularity]?.value;
		if (isRecord(value)) return value;
	}
	return undefined;
}

function compareCodepoint(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function redundancyBucketKey(fact: Fact): string {
	const value = renderingRecord(fact);
	return [
		fact.plane,
		typeof value?.kind === "string" ? value.kind : "",
		typeof value?.role === "string" ? value.role : "",
		typeof value?.containerName === "string" ? value.containerName : "",
	].join("\u0000");
}

function redundancyFactors(facts: Fact[]): Map<string, number> {
	const factors = new Map<string, number>();
	const seen = new Map<string, number>();
	for (const fact of facts) {
		if ((fact.salience.relevance ?? 0) > 0) {
			factors.set(fact.ref, 1);
			continue;
		}
		const key = redundancyBucketKey(fact);
		const ordinal = (seen.get(key) ?? 0) + 1;
		seen.set(key, ordinal);
		factors.set(fact.ref, 1 / Math.sqrt(ordinal));
	}
	return factors;
}

export function allocateFacts(facts: Fact[], budget: number, floors: PlaneFloor[] = [], options: AllocationOptions = {}): RenderPlan {
	const plan: RenderPlan = new Map();
	let spent = 0;
	const floorByPlane = new Map(floors.map((floor) => [floor.plane, floor]));
	const usedByPlane = new Map<string, number>();
	const redundancyByRef = redundancyFactors(facts);
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
			.sort((a, b) => salienceValue(b.salience) - salienceValue(a.salience) || compareCodepoint(a.ref, b.ref));
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
			const best = bestAvailableWithin(fact, Math.max(0, budget - spent), options.granularityCeiling);
			const cost = best ? renderingDensityCost(fact, best, options) : Number.POSITIVE_INFINITY;
			const continuity = options.stableRefs?.has(fact.ref) ? 1.2 : 1;
			const salience = salienceValue(fact.salience) * (redundancyByRef.get(fact.ref) ?? 1) * continuity;
			return { fact, best, salience, density: cost > 0 && Number.isFinite(cost) ? salience / cost : 0 };
		})
		.sort((a, b) => b.density - a.density || b.salience - a.salience || compareCodepoint(a.fact.ref, b.fact.ref));

	for (const item of ranked) {
		if (plan.get(item.fact.ref) !== "omit") continue;
		const floor = floorByPlane.get(item.fact.plane);
		if (floor?.maxFacts !== undefined) {
			const used = usedByPlane.get(item.fact.plane) ?? 0;
			if (used >= floor.maxFacts) continue;
		}
		const granularity = bestAvailableWithin(item.fact, budget - spent, options.granularityCeiling);
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
			const granularity = bestAvailableWithin(item.fact, budget - spent, options.granularityCeiling);
			if (!granularity) continue;
			assign(item.fact, granularity, renderingCost(item.fact, granularity));
			if (budget - spent <= budget * 0.12) break;
		}
	}
	return plan;
}
