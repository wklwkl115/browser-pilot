// L1 insight index: a minimal inverted token index for fast routing and recall.
// Maps each routing token (drawn from active entries' title + triggers) to the
// ids that carry it, so a situation (query / page context) routes to relevant
// memory by token OVERLAP — token-boundary correct and rankable, unlike naive
// substring matching. Pure and deterministic; no embeddings (semantic routing
// stays deferred).

const TOKEN_RE = /[a-z0-9]{3,}/g;
const MAX_TOKENS_PER_ENTRY = 24;

// Tokens that identify a memory for routing (its title + trigger keywords).
export function memoryRoutingTokens(parts: { title: string; triggers: string[] }): string[] {
	const tokens = new Set<string>();
	const source = `${parts.title} ${parts.triggers.join(" ")}`.toLowerCase();
	for (const token of source.match(TOKEN_RE) ?? []) {
		tokens.add(token);
		if (tokens.size >= MAX_TOKENS_PER_ENTRY) break;
	}
	return [...tokens];
}

// Tokens of a routing situation (a recall query or a page's url+title).
export function situationTokens(text: string): string[] {
	return [...new Set((text.toLowerCase().match(TOKEN_RE)) ?? [])];
}

// Build token -> active entry ids. Deprecated entries never route.
export function buildMemoryRoutingIndex(entries: Array<{ id: string; status: string; title: string; triggers: string[] }>): Record<string, string[]> {
	const routing: Record<string, string[]> = {};
	for (const entry of entries) {
		if (entry.status !== "active") continue;
		for (const token of memoryRoutingTokens(entry)) (routing[token] ||= []).push(entry.id);
	}
	return routing;
}

// Route a situation to candidate ids, scored by how many of its tokens overlap
// each entry's routing tokens. Higher overlap = more relevant.
export function routeByTokens(routing: Record<string, string[]> | undefined, tokens: string[]): Map<string, number> {
	const overlaps = new Map<string, number>();
	if (!routing) return overlaps;
	for (const token of tokens) {
		for (const id of routing[token] ?? []) overlaps.set(id, (overlaps.get(id) ?? 0) + 1);
	}
	return overlaps;
}
