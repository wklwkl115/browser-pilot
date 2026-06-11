import { buildMemoryRoutingIndex, routeByTokens } from "./routing.js";
import type { MemoryRecallEntry, MemoryRecallQuery, MemoryScoredRecall, MemoryVerificationStatus } from "./types.js";

const VERIFICATION_RANK: Record<MemoryVerificationStatus | "none", number> = {
	fresh: 30,
	unverified: 10,
	stale: -30,
	none: 0,
};

export function recallByTokens(entries: MemoryRecallEntry[], query: MemoryRecallQuery): MemoryScoredRecall[] {
	const active = entries.filter((entry) => entry.status === "active");
	const routing = buildMemoryRoutingIndex(active);
	const routed = routeByTokens(routing, query.tokens);
	const out: MemoryScoredRecall[] = [];
	for (const entry of active) {
		let score = 0;
		const reasons: string[] = [];
		if (query.origin && entry.scopeKind === "origin" && entry.scopeKey === query.origin) {
			score += 100;
			reasons.push("origin");
		}
		const routedScore = routed.get(entry.id) ?? 0;
		if (routedScore > 0) {
			score += routedScore * 15;
			reasons.push(`idf×${routedScore}`);
		}
		if (!score) continue;
		score += VERIFICATION_RANK[entry.verification ?? "none"];
		out.push({ entry, score: Number(score.toFixed(3)), matchReason: reasons.join("+") });
	}
	return out
		.sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt) || a.entry.id.localeCompare(b.entry.id))
		.slice(0, query.limit ?? 10);
}
