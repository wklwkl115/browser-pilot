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
