export type MemoryScopeKind = "origin" | "task" | "project";
export type MemoryEntryKind = "fact";
export type MemoryEntryStatus = "active" | "deprecated";
export type MemoryConfidence = "verified" | "high" | "medium" | "low";
export type MemorySensitivity = "local";

export type PersistableMemoryTermKind = "selectorLiteral" | "ref" | "urlPathToken";

export type PersistableMemoryTerm = {
	term: string;
	kind: PersistableMemoryTermKind;
	weight?: number;
};

export type MemoryTermStat = {
	term: string;
	kind: PersistableMemoryTermKind;
	weight?: number;
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

export type MemoryAnchors = {
	canonicalUrl?: string;
	fingerprintSummary?: Record<string, unknown>;
	stampSetId?: string;
};

export type MemoryVerificationStatus = "fresh" | "unverified" | "stale";

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

export type MemoryPerceptionLedgerKey = {
	browserSessionId?: string;
	tabId?: number;
	navigationEpoch?: string;
};

export type MemoryPerceptionLedgerFactState = {
	versionStamp: string;
	stableStamp?: string;
	lastShownGranularity: "full" | "compact" | "line" | "ref";
};

export type MemoryPerceptionLedgerFrame = {
	key: MemoryPerceptionLedgerKey;
	snapshotId: string;
	capturedAt: number;
	facts: Record<string, MemoryPerceptionLedgerFactState>;
	pageFingerprint?: {
		changeSeq: number;
		url?: string;
		title?: string;
		readyState?: string;
		visibleCount?: number;
		interactiveCount?: number;
		capturedAt?: number;
		dirty?: {
			roots: string[];
			overflow: boolean;
			sinceSeq?: number;
		};
	};
};

export type MemoryPerceptionTraceTerm = {
	term: string;
	kind: string;
	weight?: number;
	at: number;
	seq: number;
};

export type MemoryPerceptionTraceSnapshot = {
	terms: MemoryPerceptionTraceTerm[];
	latestSeq: number;
};

export type MemoryEvidenceRef =
	| { kind: "artifact"; path: string; etag?: string; bytes?: number }
	| { kind: "browser-result"; uri: string; path?: string; etag?: string; bytes?: number }
	| { kind: "snapshot"; snapshotId: string; path?: string; etag?: string; bytes?: number }
	| { kind: "operation"; operationId: string; path?: string; etag?: string; bytes?: number };

export type MemoryFrontmatter = {
	schemaVersion: 1;
	id: string;
	title: string;
	kind: MemoryEntryKind;
	triggers: string[];
	scopeKind: MemoryScopeKind;
	scopeKey: string;
	sensitivity: MemorySensitivity;
	status: MemoryEntryStatus;
	confidence: MemoryConfidence;
	verifiedAt: string;
	updatedAt: string;
	evidenceRefs: MemoryEvidenceRef[];
	anchors?: MemoryAnchors;
};

export type MemoryEntry = MemoryFrontmatter & {
	body: string;
	relPath: string;
	etag?: string;
};

export type MemoryTombstone = {
	schemaVersion: 1;
	id: string;
	replacedById?: string;
	status: "deprecated";
	createdAt: string;
	reason: "superseded" | "manual";
};

export type MemoryIndexEntry = Pick<MemoryFrontmatter, "id" | "kind" | "title" | "triggers" | "scopeKind" | "scopeKey" | "status" | "confidence" | "updatedAt"> & {
	handles: string[];
};

export type MemoryIndex = {
	schemaVersion: 1;
	generatedAt: string;
	entries: MemoryIndexEntry[];
	byScope: Record<string, string[]>;
	// L1 insight index: routing token -> active entry ids (see routing.ts).
	routing: Record<string, string[]>;
};

export type MemoryRecallCard = {
	id: string;
	title: string;
	triggers: string[];
	scopeKind: MemoryScopeKind;
	scopeKey: string;
	kind: MemoryEntryKind;
	status: MemoryEntryStatus;
	confidence: MemoryConfidence;
	matchReason: string;
	handles: string[];
	updatedAt: string;
	verification?: MemoryVerificationStatus;
	// Inlined bounded body, present only on the top card when it clearly dominates
	// — saves a follow-up read for the common single-relevant-memory case.
	body?: string;
};

export type MemoryRecordPayload = {
	kind: MemoryEntryKind;
	scopeKind?: MemoryScopeKind;
	scopeKey?: string;
	url?: string;
	title: string;
	triggers: string[];
	body: string;
	evidenceRefs: Array<string | MemoryEvidenceRef>;
	sensitivity?: MemorySensitivity;
	confidence?: MemoryConfidence;
};

export type MemoryReadMode = "text" | "json";

export type MemoryReadResult =
	| { mode: "text"; summary: Record<string, unknown>; offset: number; limit: number; nextOffset: number | null; snippets: Array<{ lineStart: number; lineEnd: number; text: string; truncated: boolean }> }
	| { mode: "json"; summary: Record<string, unknown>; jsonPath?: string; value: unknown };
