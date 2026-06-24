import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemoryAnchors, MemoryOriginProfile } from "../../memory/types.js";
import { readCachedMemoryProfile } from "../../memory/profileService.js";
import { memoryStampSetId, verifyMemoryAnchors } from "../../kernels/memory/staleness.js";
import type { MemoryResultResourceResolver } from "../commandShared.js";
import { checkEvidenceExpiryWarnings, resolveMemoryEvidenceRefs, validateMemoryRecordPayloadShape } from "./evidence.js";
import type { EvidenceExpiryEntry, MemorySnapshotResolver } from "./evidence.js";
import type { MemoryRecordPayload } from "../../memory/types.js";

export type MemoryRecordEnrichment = {
	warnings: string[];
	evidenceExpiry: EvidenceExpiryEntry[];
};

export type ValidatedMemoryRecord = MemoryRecordEnrichment & {
	scopeKey: string;
	entry: Omit<MemoryEntry, "relPath" | "etag">;
};

export function newMemoryId(): string {
	return `fact_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

export function preciseOriginFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function canonicalUrlFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname || "/"}`;
	} catch {
		return undefined;
	}
}

export function anchorsFromProfile(profile: MemoryOriginProfile | undefined, url: string | undefined): MemoryAnchors | undefined {
	if (!profile) return undefined;
	const canonicalUrl = canonicalUrlFromUrl(url);
	const digest = (canonicalUrl ? profile.urls.find((item) => item.canonicalUrl === canonicalUrl) : undefined) ?? profile.urls[0];
	if (!digest) return undefined;
	const stampSetId = memoryStampSetId(digest.factStamps);
	return {
		canonicalUrl: digest.canonicalUrl,
		...(digest.fingerprintSummary ? { fingerprintSummary: digest.fingerprintSummary } : {}),
		...(stampSetId ? { stampSetId } : {}),
	};
}

export function verifyMemoryEntryAgainstProfile(entry: Pick<MemoryEntry, "anchors">, profile: MemoryOriginProfile | undefined, url?: string) {
	return verifyMemoryAnchors(entry.anchors, anchorsFromProfile(profile, url) ?? {});
}

export async function buildMemoryRecordEntry(options: {
	cwd?: string;
	server?: MemorySnapshotResolver;
	resolver?: MemoryResultResourceResolver;
	payload: MemoryRecordPayload;
}): Promise<ValidatedMemoryRecord> {
	const { scopeKey, scopeKind, confidence } = validateMemoryRecordPayloadShape(options.payload);
	const evidenceRefs = await resolveMemoryEvidenceRefs({ cwd: options.cwd, server: options.server, resolver: options.resolver, evidenceRefs: options.payload.evidenceRefs });
	const { warnings, evidenceExpiry } = checkEvidenceExpiryWarnings(evidenceRefs);
	const anchorOrigin = preciseOriginFromUrl(options.payload.url);
	const anchors = anchorOrigin ? anchorsFromProfile(await readCachedMemoryProfile(options.cwd, anchorOrigin), options.payload.url) : undefined;
	const now = new Date().toISOString();
	return {
		scopeKey,
		warnings,
		evidenceExpiry,
		entry: {
			schemaVersion: 1,
			id: newMemoryId(),
			title: options.payload.title.trim(),
			kind: "fact",
			triggers: options.payload.triggers.map((item) => item.trim()).filter(Boolean),
			scopeKind,
			scopeKey,
			sensitivity: "local",
			status: "active",
			confidence,
			verifiedAt: now,
			updatedAt: now,
			evidenceRefs,
			anchors,
			body: options.payload.body.trim(),
		},
	};
}
