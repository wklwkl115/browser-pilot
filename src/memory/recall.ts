import { recallByTokens as kernelRecallByTokens } from "../kernels/memory/recall.js";

export type MemoryRecallEntry = {
	id: string;
	title: string;
	triggers: string[];
	scopeKind: "origin" | "task" | "project";
	scopeKey: string;
	kind: "fact";
	status: string;
	updatedAt: string;
	verification?: "fresh" | "stale" | "unverified";
};

export type MemoryRecallQuery = {
	origin?: string;
	tokens: string[];
	limit?: number;
};

export type MemoryScoredRecall<TEntry extends MemoryRecallEntry = MemoryRecallEntry> = {
	entry: TEntry;
	score: number;
	matchReason: string;
};

export function recallByTokens<TEntry extends MemoryRecallEntry>(entries: TEntry[], query: MemoryRecallQuery): MemoryScoredRecall<TEntry>[] {
	return kernelRecallByTokens(entries, query) as MemoryScoredRecall<TEntry>[];
}
