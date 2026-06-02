import type { CandidateSummary, Locator, RefDescriptor, ResolveResult } from "./types.js";

export const LOCATOR_WEIGHTS: Record<Locator["by"], number> = {
	backendNodeId: 100,
	axNodeId: 95,
	attrSignature: 90,
	css: 80,
	xpath: 70,
	textAnchor: 60,
	point: 40,
};

export const RESOLVE_MIN_SCORE = 60;
export const RESOLVE_UNIQUE_GAP = 10;

export type ScoreCandidateInput = {
	locatorHits: Array<{ by: Locator["by"]; weight?: number }>;
	semantic?: { roleMatches?: boolean; nameMatches?: boolean; textAnchorFuzzyMatches?: boolean };
	geometry?: { pointDistancePx?: number; boxIou?: number };
	owner?: { frameMatches?: boolean };
};

export function locatorWeight(by: Locator["by"]): number {
	return LOCATOR_WEIGHTS[by];
}

export function scoreCandidate(input: ScoreCandidateInput): number {
	const locatorKinds = new Set<Locator["by"]>();
	let score = 0;
	for (const hit of input.locatorHits) {
		if (locatorKinds.has(hit.by)) continue;
		locatorKinds.add(hit.by);
		score += hit.weight ?? locatorWeight(hit.by);
	}
	if (input.semantic?.roleMatches) score += 10;
	if (input.semantic?.nameMatches) score += 10;
	if (input.semantic?.textAnchorFuzzyMatches) score += 4;
	if (typeof input.geometry?.pointDistancePx === "number" && input.geometry.pointDistancePx <= 8) score += 8;
	if (typeof input.geometry?.boxIou === "number" && input.geometry.boxIou >= 0.8) score += 8;
	if (input.owner?.frameMatches) score += 15;
	return score;
}

function hasOnlyPointLocator(candidate: CandidateSummary): boolean {
	return candidate.locatorHits.length > 0 && candidate.locatorHits.every((hit) => hit.by === "point");
}

function hasSemanticConflict(ref: RefDescriptor, candidate: CandidateSummary): boolean {
	const refRole = ref.semantic?.role;
	const refName = ref.semantic?.name;
	if (refRole && candidate.role && refRole !== candidate.role) return true;
	if (refName && candidate.name && refName !== candidate.name) return true;
	return false;
}

export function classifyResolveResult(ref: RefDescriptor, candidates: CandidateSummary[], options: { backend?: string; backendUnavailable?: boolean } = {}): ResolveResult {
	if (options.backendUnavailable) {
		return { status: "backendUnavailable", ref, backend: options.backend || "unknown", reason: "resolution backend unavailable" };
	}
	if (!candidates.length) return { status: "stale", ref, reason: "no candidate matched the ref locators" };
	const ranked = [...candidates].sort((a, b) => b.score - a.score || (a.documentOrder ?? Number.MAX_SAFE_INTEGER) - (b.documentOrder ?? Number.MAX_SAFE_INTEGER));
	const top = ranked[0];
	const second = ranked[1];
	if (ref.kind === "region" && hasOnlyPointLocator(top)) {
		return { status: "unique", ref, candidate: { ...top, source: top.source || "region" } };
	}
	if (top.score < RESOLVE_MIN_SCORE) return { status: "stale", ref, reason: `top candidate score ${top.score} is below min score ${RESOLVE_MIN_SCORE}` };
	if (hasSemanticConflict(ref, top)) {
		return { status: "ambiguous", ref, candidates: ranked, reason: "top candidate conflicts with cached semantic role/name" };
	}
	if (second && top.score - second.score < RESOLVE_UNIQUE_GAP) {
		return { status: "ambiguous", ref, candidates: ranked, reason: `top two candidates are within unique gap ${RESOLVE_UNIQUE_GAP}` };
	}
	return { status: "unique", ref, candidate: top };
}
