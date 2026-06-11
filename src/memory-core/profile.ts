import type { MemoryFrameView, MemoryOriginProfile, MemorySessionDigest, MemoryTermStat, MemoryTraceView, MemoryUrlDigest, PersistableMemoryTerm } from "./types.js";

const MAX_SESSIONS = 8;
const MAX_TERMS = 48;
const MAX_URLS = 8;

export function memoryTermKey(term: Pick<PersistableMemoryTerm, "kind" | "term">): string {
	return `${term.kind}\u0000${term.term.toLocaleLowerCase()}`;
}

export function emptyMemoryOriginProfile(origin: string): MemoryOriginProfile {
	return { schemaVersion: 1, origin, sessions: [], termStats: {}, urls: [], strikes: {} };
}

function cloneProfile(profile: MemoryOriginProfile): MemoryOriginProfile {
	return {
		schemaVersion: 1,
		origin: profile.origin,
		sessions: profile.sessions.map((session) => ({ ...session, termKeys: [...session.termKeys] })),
		termStats: Object.fromEntries(Object.entries(profile.termStats).map(([key, value]) => [key, { ...value }])),
		urls: profile.urls.map((url) => ({ ...url, factStamps: url.factStamps ? { ...url.factStamps } : undefined, fingerprintSummary: url.fingerprintSummary ? { ...url.fingerprintSummary } : undefined })),
		strikes: { ...profile.strikes },
	};
}

function mergeSession(existing: MemorySessionDigest | undefined, next: MemorySessionDigest): MemorySessionDigest {
	return {
		sessionId: next.sessionId,
		capturedAt: Math.max(existing?.capturedAt ?? 0, next.capturedAt),
		termKeys: Array.from(new Set([...(existing?.termKeys ?? []), ...next.termKeys])).sort(),
	};
}

function capSessions(sessions: MemorySessionDigest[]): MemorySessionDigest[] {
	return [...sessions].sort((a, b) => b.capturedAt - a.capturedAt || a.sessionId.localeCompare(b.sessionId)).slice(0, MAX_SESSIONS);
}

function capUrls(urls: MemoryUrlDigest[]): MemoryUrlDigest[] {
	return [...urls].sort((a, b) => b.capturedAt - a.capturedAt || a.canonicalUrl.localeCompare(b.canonicalUrl)).slice(0, MAX_URLS);
}

function recomputeTermStats(sessions: MemorySessionDigest[], sourceTerms: Map<string, PersistableMemoryTerm>, prior: Record<string, MemoryTermStat> = {}): Record<string, MemoryTermStat> {
	const stats = new Map<string, MemoryTermStat>();
	for (const session of sessions) {
		for (const key of session.termKeys) {
			const source = sourceTerms.get(key) ?? prior[key];
			if (!source) continue;
			const current = stats.get(key);
			stats.set(key, {
				term: source.term,
				kind: source.kind,
				weight: source.weight,
				sessionCount: (current?.sessionCount ?? 0) + 1,
				lastSeenAt: Math.max(current?.lastSeenAt ?? 0, session.capturedAt),
			});
		}
	}
	for (const [key, value] of Object.entries(prior)) {
		const current = stats.get(key);
		if (!current || value.sessionCount > current.sessionCount || value.lastSeenAt > current.lastSeenAt) {
			stats.set(key, { ...value, sessionCount: Math.max(value.sessionCount, current?.sessionCount ?? 0), lastSeenAt: Math.max(value.lastSeenAt, current?.lastSeenAt ?? 0) });
		}
	}
	return Object.fromEntries([...stats.entries()]
		.sort((a, b) => b[1].sessionCount - a[1].sessionCount || b[1].lastSeenAt - a[1].lastSeenAt || a[0].localeCompare(b[0]))
		.slice(0, MAX_TERMS));
}

function sourceTermsFrom(profile: MemoryOriginProfile, terms: PersistableMemoryTerm[] = []): Map<string, PersistableMemoryTerm> {
	const out = new Map<string, PersistableMemoryTerm>();
	for (const stat of Object.values(profile.termStats)) out.set(memoryTermKey(stat), stat);
	for (const term of terms) out.set(memoryTermKey(term), term);
	return out;
}

export function distillFrameIntoProfile(profile: MemoryOriginProfile | undefined, frame: MemoryFrameView, trace: MemoryTraceView): MemoryOriginProfile {
	const base = cloneProfile(profile ?? emptyMemoryOriginProfile(frame.origin));
	const capturedAt = trace.capturedAt ?? frame.capturedAt;
	const sessionId = trace.sessionId || frame.sessionId || `frame:${capturedAt}`;
	const termKeys = Array.from(new Set(trace.terms.map(memoryTermKey))).sort();
	const sessionsById = new Map(base.sessions.map((session) => [session.sessionId, session]));
	sessionsById.set(sessionId, mergeSession(sessionsById.get(sessionId), { sessionId, capturedAt, termKeys }));
	const sessions = capSessions([...sessionsById.values()]);

	const urlsByKey = new Map(base.urls.map((url) => [url.canonicalUrl, url]));
	if (frame.canonicalUrl) {
		const current = urlsByKey.get(frame.canonicalUrl);
		urlsByKey.set(frame.canonicalUrl, {
			canonicalUrl: frame.canonicalUrl,
			capturedAt: Math.max(current?.capturedAt ?? 0, frame.capturedAt),
			factStamps: frame.factStamps ? { ...(current?.factStamps ?? {}), ...frame.factStamps } : current?.factStamps,
			fingerprintSummary: frame.fingerprintSummary ? { ...frame.fingerprintSummary } : current?.fingerprintSummary,
		});
	}

	const sourceTerms = sourceTermsFrom(base, trace.terms);
	return {
		...base,
		sessions,
		termStats: recomputeTermStats(sessions, sourceTerms, base.termStats),
		urls: capUrls([...urlsByKey.values()]),
	};
}

export function mergeProfiles(disk: MemoryOriginProfile | undefined, pending: MemoryOriginProfile | undefined): MemoryOriginProfile | undefined {
	if (!disk && !pending) return undefined;
	if (!disk) return cloneProfile(pending!);
	if (!pending) return cloneProfile(disk);
	const origin = disk.origin || pending.origin;
	const sessionMap = new Map<string, MemorySessionDigest>();
	for (const session of [...disk.sessions, ...pending.sessions]) sessionMap.set(session.sessionId, mergeSession(sessionMap.get(session.sessionId), session));
	const urlMap = new Map<string, MemoryUrlDigest>();
	for (const url of [...disk.urls, ...pending.urls]) {
		const current = urlMap.get(url.canonicalUrl);
		if (!current || url.capturedAt >= current.capturedAt) urlMap.set(url.canonicalUrl, { ...url, factStamps: url.factStamps ? { ...url.factStamps } : undefined, fingerprintSummary: url.fingerprintSummary ? { ...url.fingerprintSummary } : undefined });
	}
	const strikes: Record<string, number> = { ...disk.strikes };
	for (const [entryId, count] of Object.entries(pending.strikes)) strikes[entryId] = Math.max(strikes[entryId] ?? 0, count);
	const sessions = capSessions([...sessionMap.values()]);
	const sourceTerms = sourceTermsFrom(disk);
	for (const [key, stat] of Object.entries(pending.termStats)) sourceTerms.set(key, stat);
	return {
		schemaVersion: 1,
		origin,
		sessions,
		termStats: recomputeTermStats(sessions, sourceTerms, { ...disk.termStats, ...pending.termStats }),
		urls: capUrls([...urlMap.values()]),
		strikes,
	};
}
