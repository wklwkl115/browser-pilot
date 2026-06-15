export type PersistableMemoryTermKind = "selectorLiteral" | "ref" | "urlPathToken";

export type PersistableMemoryTerm = {
	term: string;
	kind: PersistableMemoryTermKind;
	weight?: number;
};

export type MemoryTermCandidate = {
	term?: unknown;
	kind?: unknown;
	weight?: unknown;
};

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

export type MemoryTermStat = PersistableMemoryTerm & {
	sessionCount: number;
	lastSeenAt: number;
};

export type MemorySessionDigest = {
	sessionId: string;
	capturedAt: number;
	termKeys: string[];
};

export type MemoryUrlDigest = {
	canonicalUrl: string;
	capturedAt: number;
	factStamps?: Record<string, string>;
	fingerprintSummary?: Record<string, unknown>;
};

export type MemoryOriginProfile = {
	schemaVersion: 1;
	origin: string;
	sessions: MemorySessionDigest[];
	termStats: Record<string, MemoryTermStat>;
	urls: MemoryUrlDigest[];
	strikes: Record<string, number>;
};

export type MemoryFrameView = {
	origin: string;
	sessionId?: string;
	canonicalUrl?: string;
	capturedAt: number;
	factStamps?: Record<string, string>;
	fingerprintSummary?: Record<string, unknown>;
	fromCache?: boolean;
};

export type MemoryTraceView = {
	sessionId?: string;
	capturedAt?: number;
	terms: PersistableMemoryTerm[];
};

export type MemoryAnchors = {
	canonicalUrl?: string;
	fingerprintSummary?: Record<string, unknown>;
	stampSetId?: string;
};

export type MemoryVerificationStatus = "fresh" | "unverified" | "stale";

export type MemoryVerification = {
	status: MemoryVerificationStatus;
	reasons: string[];
};

export type MemoryRecallEntry = {
	id: string;
	title: string;
	triggers: string[];
	scopeKind: "origin" | "task" | "project";
	scopeKey: string;
	kind: "sop" | "fact";
	status: string;
	updatedAt: string;
	verification?: MemoryVerificationStatus;
};

export type MemoryRecallQuery = {
	origin?: string;
	tokens: string[];
	limit?: number;
};

export type MemoryScoredRecall = {
	entry: MemoryRecallEntry;
	score: number;
	matchReason: string;
};

export type MemoryAugmentationPlan = {
	inline?: Record<string, unknown>;
	handleOnly?: Record<string, unknown>;
};
