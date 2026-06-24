import type { MemoryEntry, MemoryIndexEntry, MemoryRecallCard } from "../../memory/types.js";
import { normalizeMemoryEntryId } from "../../memory/ids.js";
import { browserMemoryUriForEntry } from "../../memory/indexStore.js";
import { routeByTokens, situationTokens } from "../../memory/routing.js";
import { DEDUP_SIMILARITY, memorySimilarity, SIMILAR_SIMILARITY } from "./salience.js";

export type MemoryDuplicateCandidate = { id: string; title: string; similarity: number };

export function findMemoryDuplicateCandidates(entry: Pick<MemoryEntry, "title" | "triggers" | "body" | "scopeKind" | "scopeKey">, existingEntries: MemoryEntry[]): { existingIds: string[]; duplicateCandidates: MemoryDuplicateCandidate[] } {
	const payloadTitle = entry.title.trim().toLowerCase();
	const scored = existingEntries
		.filter((current) => current.status === "active" && current.scopeKind === entry.scopeKind && current.scopeKey === entry.scopeKey)
		.map((current) => ({
			current,
			exact: current.title.trim().toLowerCase() === payloadTitle,
			similarity: memorySimilarity({ title: entry.title, triggers: entry.triggers, body: entry.body }, { title: current.title, triggers: current.triggers, body: current.body }),
		}));
	const existingIds = scored.filter((item) => item.exact || item.similarity >= DEDUP_SIMILARITY).map((item) => item.current.id);
	const duplicateCandidates = scored
		.filter((item) => !item.exact && item.similarity < DEDUP_SIMILARITY && item.similarity >= SIMILAR_SIMILARITY)
		.map((item) => ({ id: item.current.id, title: item.current.title, similarity: item.similarity }))
		.sort((a, b) => b.similarity - a.similarity);
	return { existingIds, duplicateCandidates };
}

function scoreCard(entry: MemoryIndexEntry, query: string | undefined, scopeKind: MemoryEntry["scopeKind"] | undefined, scopeKey: string | undefined, routeOverlap: number): { score: number; matchReason: string } | undefined {
	let score = 0;
	const reasons: string[] = [];
	if (scopeKey && scopeKind && entry.scopeKind === scopeKind && entry.scopeKey === scopeKey) {
		score += 100;
		reasons.push(`exact-${scopeKind}`);
	}
	if (query) {
		const needle = query.toLowerCase();
		if (entry.title.toLowerCase().includes(needle)) {
			score += 30;
			reasons.push("title");
		}
		if (entry.triggers.some((item) => item.toLowerCase().includes(needle))) {
			score += 20;
			reasons.push("trigger");
		}
		if (routeOverlap > 0) {
			score += routeOverlap * 15;
			reasons.push(`route×${routeOverlap}`);
		}
	}
	if (!score) return undefined;
	return { score, matchReason: reasons.join("+") };
}

export function indexEntryToCard(entry: MemoryIndexEntry, matchReason: string): MemoryRecallCard {
	const id = normalizeMemoryEntryId(entry.id);
	const handlePrefix = `browser-memory://${entry.kind}/${id}`;
	const handles = entry.handles.filter((handle) => handle === handlePrefix || handle.startsWith(`${handlePrefix}?`));
	return {
		id,
		title: entry.title,
		triggers: entry.triggers,
		scopeKind: entry.scopeKind,
		scopeKey: entry.scopeKey,
		kind: entry.kind,
		status: entry.status,
		confidence: entry.confidence,
		matchReason,
		handles: handles.length ? handles : [browserMemoryUriForEntry({ kind: entry.kind, id })],
		updatedAt: entry.updatedAt,
	};
}

export function rankMemoryRecallEntries(options: {
	entries: MemoryIndexEntry[];
	routing: Record<string, string[]>;
	query?: string;
	scopeKind?: MemoryEntry["scopeKind"];
	scopeKey?: string;
	excludedIds?: Set<string>;
}): Array<{ card: MemoryRecallCard; score: number }> {
	const routed = options.query ? routeByTokens(options.routing, situationTokens(options.query)) : undefined;
	return options.entries
		.filter((entry) => entry.status === "active" && (!options.excludedIds || !options.excludedIds.has(entry.id)))
		.map((entry) => {
			const score = scoreCard(entry, options.query, options.scopeKind, options.scopeKey, routed?.get(entry.id) ?? 0);
			return score ? { card: indexEntryToCard(entry, score.matchReason), score: score.score } : undefined;
		})
		.filter((item): item is { card: MemoryRecallCard; score: number } => !!item)
		.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
}
