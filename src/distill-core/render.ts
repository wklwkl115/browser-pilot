import type { Fact, FactGranularity, RenderPlan } from "./fact.js";

export type RenderedFacts = Partial<Record<string, unknown[]>> & { omitted?: Array<{ ref: string; plane: string; reason: string }>; stats?: { factsRendered: number; factsOmitted: number; truncationMarkers: number } };

const TRUNCATION_MARKER_PATTERN = /truncated|omitted|…|\.\.\./gi;

function countTextTruncationMarkers(text: string): number {
	return text.match(TRUNCATION_MARKER_PATTERN)?.length ?? 0;
}

function isJsonOmittedValue(value: unknown): boolean {
	return value === undefined || typeof value === "function" || typeof value === "symbol";
}

export function countRenderedTruncationMarkers(value: unknown): number {
	if (typeof value === "string") return countTextTruncationMarkers(value);
	if (Array.isArray(value)) return value.reduce((count, item) => count + countRenderedTruncationMarkers(item), 0);
	if (value && typeof value === "object") {
		let count = 0;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (isJsonOmittedValue(item)) continue;
			count += countTextTruncationMarkers(key) + countRenderedTruncationMarkers(item);
		}
		return count;
	}
	return 0;
}

export function renderFacts(facts: Fact[], plan: RenderPlan): RenderedFacts {
	const out: RenderedFacts = {};
	const omitted: Array<{ ref: string; plane: string; reason: string }> = [];
	let factsRendered = 0;
	let truncationMarkers = 0;
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
		truncationMarkers += countRenderedTruncationMarkers(value);
		out[fact.plane] = bucket;
	}
	if (omitted.length) {
		out.omitted = omitted;
		truncationMarkers += countTextTruncationMarkers("omitted");
	}
	out.stats = { factsRendered, factsOmitted: omitted.length, truncationMarkers };
	return out;
}
