import { stableJson } from "../utils/json.js";
import type { Fact, FactGranularity, RenderPlan } from "./fact.js";

export type RenderedFacts = Partial<Record<string, unknown[]>> & { omitted?: Array<{ ref: string; plane: string; reason: string }>; stats?: { factsRendered: number; factsOmitted: number; truncationMarkers: number } };

export function countRenderedTruncationMarkers(value: unknown): number {
	return (stableJson(value).match(/truncated|omitted|…|\.\.\./gi) || []).length;
}

export function renderFacts(facts: Fact[], plan: RenderPlan): RenderedFacts {
	const out: RenderedFacts = {};
	const omitted: Array<{ ref: string; plane: string; reason: string }> = [];
	let factsRendered = 0;
	for (const fact of facts) {
		const granularity = plan.get(fact.ref) || "omit";
		if (granularity === "omit") {
			omitted.push({ ref: fact.ref, plane: fact.plane, reason: "budget" });
			continue;
		}
		const rendering = fact.renderings[granularity as Exclude<FactGranularity, "omit">];
		if (!rendering) {
			omitted.push({ ref: fact.ref, plane: fact.plane, reason: `missing-${granularity}` });
			continue;
		}
		const value = rendering.value !== undefined ? rendering.value : rendering.text;
		const bucket = out[fact.plane] || [];
		bucket.push(value);
		factsRendered++;
		out[fact.plane] = bucket;
	}
	if (omitted.length) out.omitted = omitted;
	out.stats = { factsRendered, factsOmitted: omitted.length, truncationMarkers: countRenderedTruncationMarkers(out) };
	return out;
}
