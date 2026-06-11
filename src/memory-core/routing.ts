// L1 insight index: a minimal inverted token index for fast routing and recall.
// Maps each routing token (drawn from active entries' title + triggers) to the
// ids that carry it. routeByTokens scores overlap by an IDF-dominant weight so
// common tokens ("login", "page") do not dominate specific task terms.

const TOKEN_RE = /[a-z0-9]{3,}/g;
const MAX_TOKENS_PER_ENTRY = 24;

export type MemoryRoutingIndex = Record<string, string[]>;

export function memoryRoutingTokens(parts: { title: string; triggers: string[] }): string[] {
	const tokens = new Set<string>();
	const source = `${parts.title} ${parts.triggers.join(" ")}`.toLowerCase();
	for (const token of source.match(TOKEN_RE) ?? []) {
		tokens.add(token);
		if (tokens.size >= MAX_TOKENS_PER_ENTRY) break;
	}
	return [...tokens];
}

export function situationTokens(text: string): string[] {
	return [...new Set((text.toLowerCase().match(TOKEN_RE)) ?? [])];
}

export function buildMemoryRoutingIndex(entries: Array<{ id: string; status: string; title: string; triggers: string[] }>): MemoryRoutingIndex {
	const routing: MemoryRoutingIndex = {};
	for (const entry of entries) {
		if (entry.status !== "active") continue;
		for (const token of memoryRoutingTokens(entry)) (routing[token] ||= []).push(entry.id);
	}
	return routing;
}

function activeEntryCount(routing: MemoryRoutingIndex): number {
	const ids = new Set<string>();
	for (const values of Object.values(routing)) for (const id of values) ids.add(id);
	return Math.max(1, ids.size);
}

export function routeByTokens(routing: MemoryRoutingIndex | undefined, tokens: string[]): Map<string, number> {
	const weightsById = new Map<string, number[]>();
	const overlaps = new Map<string, number>();
	if (!routing) return overlaps;
	const total = activeEntryCount(routing);
	for (const token of tokens) {
		const ids = routing[token] ?? [];
		if (!ids.length) continue;
		const weight = Math.log(1 + total / Math.max(1, ids.length));
		for (const id of ids) {
			let weights = weightsById.get(id);
			if (!weights) {
				weights = [];
				weightsById.set(id, weights);
			}
			weights.push(weight);
		}
	}
	for (const [id, weights] of weightsById.entries()) {
		weights.sort((a, b) => b - a);
		const [top = 0, ...rest] = weights;
		overlaps.set(id, Number((top + rest.reduce((sum, weight) => sum + weight, 0) * 0.1).toFixed(3)));
	}
	return overlaps;
}
