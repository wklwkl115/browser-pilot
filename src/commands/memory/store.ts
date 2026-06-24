import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "../../utils/fsAtomic.js";
import { memoryEntryDir, resolveMemoryPath } from "../../memory/paths.js";
import { parseMemoryEntry, serializeMemoryEntry } from "../../memory/frontmatter.js";
import { browserMemoryUriForEntry, loadMemoryEntries, readMemoryIndex, withMemoryLock, writeDerivedMemoryIndex } from "../../memory/indexStore.js";
import type { MemoryEntry, MemoryIndexEntry, MemoryRecordPayload, MemoryRecallCard, MemoryTombstone } from "../../memory/types.js";
import { validateMemoryRecordPayloadShape, resolveMemoryEvidenceRefs, checkEvidenceExpiryWarnings } from "./evidence.js";
import type { EvidenceExpiryEntry, MemorySnapshotResolver } from "./evidence.js";
import { normalizeMemoryEntryId } from "../../memory/ids.js";
import { memorySimilarity, DEDUP_SIMILARITY, SIMILAR_SIMILARITY } from "./salience.js";
import { routeByTokens, situationTokens } from "../../memory/routing.js";
import { normalizeOriginKeyFromUrl } from "./origin.js";
import type { MemoryResultResourceResolver } from "../commandShared.js";
import { stableJson } from "../../utils/json.js";
import { readCachedMemoryProfile } from "../../memory/profileService.js";
import { memoryStampSetId, verifyMemoryAnchors } from "../../kernels/memory/staleness.js";
import type { MemoryAnchors, MemoryOriginProfile } from "../../memory/types.js";

function newMemoryId(): string {
	return `fact_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

export type MemoryDuplicateCandidate = { id: string; title: string; similarity: number };

async function writeTombstone(cwd: string | undefined, value: MemoryTombstone): Promise<string> {
	const rel = path.join("tombstones", `${value.createdAt.replace(/[:.]/g, "-")}-${value.id}.json`);
	const abs = resolveMemoryPath(cwd, rel);
	await atomicWriteText(abs, `${stableJson(value)}\n`);
	return abs;
}

function preciseOriginFromUrl(url: string | undefined): string | undefined {
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

function anchorsFromProfile(profile: MemoryOriginProfile | undefined, url: string | undefined): MemoryAnchors | undefined {
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

export async function validateMemoryRecord(options: {
	cwd?: string;
	server?: MemorySnapshotResolver;
	resolver?: MemoryResultResourceResolver;
	payload: MemoryRecordPayload;
}): Promise<{ scopeKey: string; entry: Omit<MemoryEntry, "relPath" | "etag">; existingIds: string[]; duplicateCandidates: MemoryDuplicateCandidate[]; warnings: string[]; evidenceExpiry: EvidenceExpiryEntry[] }> {
	const { scopeKey, scopeKind, confidence } = validateMemoryRecordPayloadShape(options.payload);
	const evidenceRefs = await resolveMemoryEvidenceRefs({ cwd: options.cwd, server: options.server, resolver: options.resolver, evidenceRefs: options.payload.evidenceRefs });
	const { warnings, evidenceExpiry } = checkEvidenceExpiryWarnings(evidenceRefs);
	const anchorOrigin = preciseOriginFromUrl(options.payload.url);
	const anchors = anchorOrigin ? anchorsFromProfile(await readCachedMemoryProfile(options.cwd, anchorOrigin), options.payload.url) : undefined;
	const now = new Date().toISOString();
	const entry: Omit<MemoryEntry, "relPath" | "etag"> = {
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
	};
	// Salience/dedup: compare against active same-scope, same-kind memory. An exact
	// title or a near-identical entry (>= DEDUP_SIMILARITY) is superseded so the
	// store does not accumulate near-copies; merely-similar entries are returned as
	// soft candidates for the agent to supersede deliberately if intended.
	const payloadTitle = options.payload.title.trim().toLowerCase();
	const scored = (await loadMemoryEntries(options.cwd))
		.filter((current) => current.status === "active" && current.scopeKind === scopeKind && current.scopeKey === scopeKey)
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
	return { scopeKey, entry, existingIds, duplicateCandidates, warnings, evidenceExpiry };
}

export async function recordMemoryEntry(options: {
	cwd?: string;
	server?: MemorySnapshotResolver;
	resolver?: MemoryResultResourceResolver;
	payload: MemoryRecordPayload;
}): Promise<{ entry: MemoryEntry; supersededIds: string[]; duplicateCandidates: MemoryDuplicateCandidate[]; index: Awaited<ReturnType<typeof readMemoryIndex>>; warnings: string[]; evidenceExpiry: EvidenceExpiryEntry[] }> {
	return await withMemoryLock(options.cwd, async () => {
		const validated = await validateMemoryRecord(options);
		const relPath = path.join(memoryEntryDir(), `${validated.entry.id}.md`);
		const absPath = resolveMemoryPath(options.cwd, relPath);
		await atomicWriteText(absPath, serializeMemoryEntry(validated.entry));
		for (const existingId of validated.existingIds) {
			await writeTombstone(options.cwd, {
				schemaVersion: 1,
				id: existingId,
				replacedById: validated.entry.id,
				status: "deprecated",
				createdAt: validated.entry.updatedAt,
				reason: "superseded",
			});
		}
		const index = await writeDerivedMemoryIndex(options.cwd);
		return { entry: { ...validated.entry, relPath }, supersededIds: validated.existingIds, duplicateCandidates: validated.duplicateCandidates, index, warnings: validated.warnings, evidenceExpiry: validated.evidenceExpiry };
	});
}

function scoreCard(entry: Awaited<ReturnType<typeof readMemoryIndex>>["entries"][number], query: string | undefined, scopeKind: MemoryEntry["scopeKind"] | undefined, scopeKey: string | undefined, routeOverlap: number): { score: number; matchReason: string } | undefined {
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
		// L1 routing: token overlap between the query and the entry's routing
		// tokens — ranks and also catches multi-keyword matches substring misses.
		if (routeOverlap > 0) {
			score += routeOverlap * 15;
			reasons.push(`route×${routeOverlap}`);
		}
	}
	if (!score) return undefined;
	return { score, matchReason: reasons.join("+") };
}

export type MemoryRecallResult = { cards: MemoryRecallCard[]; totalMatches: number };

export async function recallMemory(options: { cwd?: string; scopeKind?: MemoryEntry["scopeKind"]; scopeKey?: string; query?: string; url?: string; offset?: number; limit?: number; freshOnly?: boolean }): Promise<MemoryRecallResult> {
	// Default to origin scope whenever any scope identifier is given: an exact
	// match needs both scopeKind and scopeKey, so a bare scopeKey (e.g. copied
	// from an auto-surface hint) must still resolve instead of silently missing.
	const scopeKind = options.scopeKind ?? ((options.url || options.scopeKey?.trim()) ? "origin" : undefined);
	const scopeKey = scopeKind === "origin" ? (options.scopeKey?.trim() || (options.url ? normalizeOriginKeyFromUrl(options.url) : undefined)) : options.scopeKey?.trim();
	const index = await readMemoryIndex(options.cwd);

	// freshOnly pre-filter: when enabled, compute verification status for each
	// active entry and exclude stale/unverified entries BEFORE ranking. Requires
	// loading full entries (for anchors) and the origin profile (for live state).
	let excludedIds: Set<string> | undefined;
	if (options.freshOnly) {
		const allEntries = await loadMemoryEntries(options.cwd);
		const anchorsByEntryId = new Map<string, MemoryAnchors | undefined>();
		for (const entry of allEntries) {
			if (entry.status === "active") anchorsByEntryId.set(entry.id, entry.anchors);
		}
		const preciseOrigin = options.url ? preciseOriginFromUrl(options.url) : undefined;
		const profile = preciseOrigin ? await readCachedMemoryProfile(options.cwd, preciseOrigin) : undefined;
		const liveAnchors = anchorsFromProfile(profile, options.url);
		excludedIds = new Set<string>();
		for (const [id, anchors] of anchorsByEntryId) {
			const verification = verifyMemoryAnchors(anchors, liveAnchors ?? {});
			if (verification.status !== "fresh") excludedIds.add(id);
		}
	}

	const routed = options.query ? routeByTokens(index.routing, situationTokens(options.query)) : undefined;
	const ranked = index.entries
		.filter((entry) => entry.status === "active" && (!excludedIds || !excludedIds.has(entry.id)))
		.map((entry) => {
			const score = scoreCard(entry, options.query, scopeKind, scopeKey, routed?.get(entry.id) ?? 0);
			return score ? { card: indexEntryToCard(entry, score.matchReason), score: score.score } : undefined;
		})
		.filter((item): item is { card: MemoryRecallCard; score: number } => !!item)
		.sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id));
	const totalMatches = ranked.length;
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
	const paged = ranked.slice(offset, offset + limit);
	const cards = paged.map((item) => item.card);
	// When one card clearly dominates (sole match, or ≥2× the runner-up) inline its
	// bounded body so the agent skips a follow-up read for the common case.
	if (cards.length && (paged.length === 1 || paged[0].score >= 2 * (paged[1]?.score ?? 0))) {
		const body = await topBody(options.cwd, cards[0].id);
		if (body) cards[0].body = body;
	}
	return { cards, totalMatches };
}

const INLINE_BODY_MAX_LINES = 60;
const INLINE_BODY_MAX_CHARS = 4_000;

async function topBody(cwd: string | undefined, id: string): Promise<string | undefined> {
	const safeId = normalizeMemoryEntryId(id);
	const rel = path.join(memoryEntryDir(), `${safeId}.md`);
	const text = await readFile(resolveMemoryPath(cwd, rel), "utf8").catch(() => undefined);
	if (!text) return undefined;
	const lines = parseMemoryEntry(text, rel).body.split(/\r?\n/);
	let body = lines.slice(0, INLINE_BODY_MAX_LINES).join("\n");
	if (body.length > INLINE_BODY_MAX_CHARS) body = `${body.slice(0, INLINE_BODY_MAX_CHARS)}…`;
	else if (lines.length > INLINE_BODY_MAX_LINES) body = `${body}\n…`;
	return body;
}

function indexEntryToCard(entry: MemoryIndexEntry, matchReason: string): MemoryRecallCard {
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
