// Write-side salience: keep the store from being diluted by near-duplicate
// memories. Pure, deterministic token-overlap similarity — no embeddings.

// At/above this similarity a new record is treated as the same memory and
// supersedes the existing one (dedup) instead of accumulating a near-copy.
export const DEDUP_SIMILARITY = 0.8;
// At/above this (but below dedup) the existing entry is surfaced as a soft
// "similar to" candidate so the agent can supersede deliberately if intended.
export const SIMILAR_SIMILARITY = 0.5;

export type MemoryTextParts = { title: string; triggers: string[]; body: string };

function tokenize(text: string): Set<string> {
	return new Set((String(text || "").toLowerCase().match(/[a-z0-9]{2,}/g)) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) if (b.has(token)) intersection += 1;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

// Weighted overlap: identity (title/triggers) matters more than prose (body),
// so "login flow" vs "checkout flow" stay distinct even with shared boilerplate,
// while a reworded copy of the same SOP scores high.
export function memorySimilarity(a: MemoryTextParts, b: MemoryTextParts): number {
	const title = jaccard(tokenize(a.title), tokenize(b.title));
	const triggers = jaccard(tokenize(a.triggers.join(" ")), tokenize(b.triggers.join(" ")));
	const body = jaccard(tokenize(a.body), tokenize(b.body));
	return Number((0.5 * title + 0.3 * triggers + 0.2 * body).toFixed(3));
}
