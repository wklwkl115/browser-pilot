import type { MemoryAnchors, MemoryOriginProfile, MemoryVerification, MemoryVerificationStatus } from "./types.js";

function stableString(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableString(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function verifyMemoryAnchors(anchors: MemoryAnchors | undefined, live: MemoryAnchors): MemoryVerification {
	if (!anchors || (!anchors.canonicalUrl && !anchors.fingerprintSummary && !anchors.stampSetId)) return { status: "unverified", reasons: ["no-anchors"] };
	const stale: string[] = [];
	if (anchors.canonicalUrl && live.canonicalUrl && anchors.canonicalUrl !== live.canonicalUrl) stale.push("canonicalUrl");
	if (anchors.stampSetId && live.stampSetId && anchors.stampSetId !== live.stampSetId) stale.push("stampSetId");
	if (anchors.fingerprintSummary && live.fingerprintSummary && stableString(anchors.fingerprintSummary) !== stableString(live.fingerprintSummary)) stale.push("fingerprintSummary");
	if (stale.length) return { status: "stale", reasons: stale };
	return { status: "fresh", reasons: ["anchors-match"] };
}

export function memoryStampSetId(factStamps: Record<string, string> | undefined): string | undefined {
	if (!factStamps) return undefined;
	const entries = Object.entries(factStamps).filter(([, stamp]) => !!stamp).sort(([a], [b]) => a.localeCompare(b));
	if (!entries.length) return undefined;
	return entries.map(([ref, stamp]) => `${ref}:${stamp}`).join("|");
}

export function transitionStrikeCount(current: number | undefined, status: MemoryVerificationStatus): number | undefined {
	if (status === "fresh") return undefined;
	if (status === "stale") return Math.max(1, (current ?? 0) + 1);
	return current;
}

export function applyVerificationStrike(profile: MemoryOriginProfile, entryId: string, status: MemoryVerificationStatus): MemoryOriginProfile {
	const strikes = { ...profile.strikes };
	const next = transitionStrikeCount(strikes[entryId], status);
	if (next === undefined) delete strikes[entryId];
	else strikes[entryId] = next;
	return { ...profile, strikes };
}
