import type { MemoryEntry, MemoryAnchors, MemoryRecordPayload, MemoryRecallCard } from "../../memory/types.js";
import type { MemoryResultResourceResolver } from "../commandShared.js";
import { readCachedMemoryProfile } from "../../memory/profileService.js";
import { normalizeOriginKeyFromUrl } from "./origin.js";
import type { EvidenceExpiryEntry, MemorySnapshotResolver } from "./evidence.js";
import { buildMemoryRecordEntry, preciseOriginFromUrl, verifyMemoryEntryAgainstProfile } from "./validation.js";
import { findMemoryDuplicateCandidates } from "./ranking.js";
import type { MemoryDuplicateCandidate } from "./ranking.js";
import { loadMemoryRepositoryEntries, readBoundedMemoryBody, readMemoryRepositoryIndex, saveMemoryRecord, withMemoryRepositoryLock } from "./repository.js";
import { rankMemoryRecallEntries } from "./ranking.js";

export type { MemoryDuplicateCandidate } from "./ranking.js";
export { verifyMemoryEntryAgainstProfile } from "./validation.js";

export async function validateMemoryRecord(options: {
	cwd?: string;
	server?: MemorySnapshotResolver;
	resolver?: MemoryResultResourceResolver;
	payload: MemoryRecordPayload;
}): Promise<{ scopeKey: string; entry: Omit<MemoryEntry, "relPath" | "etag">; existingIds: string[]; duplicateCandidates: MemoryDuplicateCandidate[]; warnings: string[]; evidenceExpiry: EvidenceExpiryEntry[] }> {
	const validated = await buildMemoryRecordEntry(options);
	const { existingIds, duplicateCandidates } = findMemoryDuplicateCandidates(validated.entry, await loadMemoryRepositoryEntries(options.cwd));
	return { ...validated, existingIds, duplicateCandidates };
}

export async function recordMemoryEntry(options: {
	cwd?: string;
	server?: MemorySnapshotResolver;
	resolver?: MemoryResultResourceResolver;
	payload: MemoryRecordPayload;
}): Promise<{ entry: MemoryEntry; supersededIds: string[]; duplicateCandidates: MemoryDuplicateCandidate[]; index: Awaited<ReturnType<typeof readMemoryRepositoryIndex>>; warnings: string[]; evidenceExpiry: EvidenceExpiryEntry[] }> {
	return await withMemoryRepositoryLock(options.cwd, async () => {
		const validated = await validateMemoryRecord(options);
		const saved = await saveMemoryRecord({ cwd: options.cwd, entry: validated.entry, supersededIds: validated.existingIds });
		return { entry: saved.entry, supersededIds: validated.existingIds, duplicateCandidates: validated.duplicateCandidates, index: saved.index, warnings: validated.warnings, evidenceExpiry: validated.evidenceExpiry };
	});
}

async function staleRecallIds(options: { cwd?: string; url?: string }): Promise<Set<string>> {
	const allEntries = await loadMemoryRepositoryEntries(options.cwd);
	const anchorsByEntryId = new Map<string, MemoryAnchors | undefined>();
	for (const entry of allEntries) {
		if (entry.status === "active") anchorsByEntryId.set(entry.id, entry.anchors);
	}
	const preciseOrigin = options.url ? preciseOriginFromUrl(options.url) : undefined;
	const profile = preciseOrigin ? await readCachedMemoryProfile(options.cwd, preciseOrigin) : undefined;
	const excludedIds = new Set<string>();
	for (const [id, anchors] of anchorsByEntryId) {
		const verification = verifyMemoryEntryAgainstProfile({ anchors }, profile, options.url);
		if (verification.status !== "fresh") excludedIds.add(id);
	}
	return excludedIds;
}

export type MemoryRecallResult = { cards: MemoryRecallCard[]; totalMatches: number };

export async function recallMemory(options: { cwd?: string; scopeKind?: MemoryEntry["scopeKind"]; scopeKey?: string; query?: string; url?: string; offset?: number; limit?: number; freshOnly?: boolean }): Promise<MemoryRecallResult> {
	const scopeKind = options.scopeKind ?? ((options.url || options.scopeKey?.trim()) ? "origin" : undefined);
	const scopeKey = scopeKind === "origin" ? (options.scopeKey?.trim() || (options.url ? normalizeOriginKeyFromUrl(options.url) : undefined)) : options.scopeKey?.trim();
	const index = await readMemoryRepositoryIndex(options.cwd);
	const excludedIds = options.freshOnly ? await staleRecallIds({ cwd: options.cwd, url: options.url }) : undefined;
	const ranked = rankMemoryRecallEntries({ entries: index.entries, routing: index.routing, query: options.query, scopeKind, scopeKey, excludedIds });
	const totalMatches = ranked.length;
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
	const paged = ranked.slice(offset, offset + limit);
	const cards = paged.map((item) => item.card);
	if (cards.length && (paged.length === 1 || paged[0].score >= 2 * (paged[1]?.score ?? 0))) {
		const body = await readBoundedMemoryBody(options.cwd, cards[0].id, { maxLines: 60, maxChars: 4_000 });
		if (body) cards[0].body = body;
	}
	return { cards, totalMatches };
}
