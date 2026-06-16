import type { MemoryTermCandidate, PersistableMemoryTerm } from "./types.js";

function cleanPersistableTerm(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length < 2 || text.length > 128) return undefined;
	return text;
}

export function toPersistableMemoryTerm(candidate: MemoryTermCandidate): PersistableMemoryTerm | undefined {
	const term = cleanPersistableTerm(candidate.term);
	if (!term) return undefined;
	if (candidate.kind !== "selectorLiteral" && candidate.kind !== "ref" && candidate.kind !== "urlPathToken") return undefined;
	const weight = typeof candidate.weight === "number" && Number.isFinite(candidate.weight) ? candidate.weight : undefined;
	return { term, kind: candidate.kind, ...(weight !== undefined ? { weight } : {}) };
}
