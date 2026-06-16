import { readFile } from "node:fs/promises";
import { extractUrlTerms } from "../../kernels/evidence/distill/relevanceTaps.js";
import { RELEVANCE_TUNING } from "../../kernels/evidence/distill/relevanceTuning.js";
import { recallByTokens } from "../../memory/recall.js";
import { situationTokens } from "../../memory/routing.js";
import { consumeMemoryProfileDiagnostics, readCachedMemoryProfile, recordMemoryProfileFrame, recordMemoryProfileStrike } from "../../memory/profileService.js";
import { memoryKernelEnabled } from "../../memory/secret.js";
import { containsSensitiveEvidence } from "../../utils/redaction.js";
import { browserMemoryUriForEntry, readMemoryIndexNoRepair } from "../../memory/indexStore.js";
import { parseMemoryEntry } from "../../memory/frontmatter.js";
import { memoryEntryDir, resolveMemoryPath } from "../../memory/paths.js";
import { normalizeMemoryEntryId } from "../../memory/ids.js";
import type { MemoryVerificationStatus } from "../../memory/types.js";
import type { CommandMemoryAugmentationPlan } from "../memoryAugmentationTypes.js";
import type { CommandPerceptionTraceSnapshot } from "../../ports/BrowserCommandRuntimePort.js";
import { verifyMemoryEntryAgainstProfile } from "../memory/store.js";
import { normalizeOriginKeyFromUrl } from "../memory/origin.js";
import type { ObserveRelevanceTerm } from "./relevanceTypes.js";

const PROCESS_MEMORY_CONVERSATION_ID = `${process.pid}:${Date.now()}`;
const memoryFullShown = new Set<string>();

type CommandMemoryRecallEntry = {
	id: string;
	title: string;
	triggers: string[];
	scopeKind: "origin" | "task" | "project";
	scopeKey: string;
	kind: "sop" | "fact";
	status: string;
	updatedAt: string;
};

function urlTerms(url: string | undefined): ObserveRelevanceTerm[] {
	return extractUrlTerms(url).map((term) => ({ ...term, source: "D" }));
}

function traceTerms(snapshot: CommandPerceptionTraceSnapshot | undefined): ObserveRelevanceTerm[] {
	return (snapshot?.terms ?? []).map((term, age) => ({ term: term.term, kind: term.kind as ObserveRelevanceTerm["kind"], weight: term.weight, age, source: "A" }));
}

function memoryAgreementToken(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
}

function memoryOrigin(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function isSensitiveWarmStartTerm(term: string): boolean {
	if (containsSensitiveEvidence(term)) return true;
	if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(term)) return true;
	if (/\b(?:token|secret|password|passwd|pwd|auth|session|cookie|api[_-]?key)\b\s*[:=]/i.test(term)) return true;
	return false;
}

export async function memoryWarmStartTerms(cwd: string | undefined, url: string | undefined, trace: CommandPerceptionTraceSnapshot | undefined): Promise<ObserveRelevanceTerm[]> {
	if (!memoryKernelEnabled()) return [];
	const origin = memoryOrigin(url);
	if (!origin) return [];
	const profile = await readCachedMemoryProfile(cwd, origin);
	if (!profile) return [];
	const candidates = Object.values(profile.termStats)
		.filter((term) => term.sessionCount >= 2 && !isSensitiveWarmStartTerm(term.term))
		.sort((a, b) => b.sessionCount - a.sessionCount || b.lastSeenAt - a.lastSeenAt || a.term.localeCompare(b.term));
	if (!candidates.length) return [];
	const liveTokens = new Set([
		...urlTerms(url).map((term) => memoryAgreementToken(term.term)),
		...traceTerms(trace).map((term) => memoryAgreementToken(term.term)),
	].filter(Boolean));
	if (!candidates.some((term) => liveTokens.has(memoryAgreementToken(term.term)))) return [];
	const ageOffset = (trace?.terms.length ?? 0) + 1;
	return candidates.slice(0, RELEVANCE_TUNING.maxMemoryTerms).map((term, index) => ({
		term: term.term,
		kind: term.kind,
		source: "F" as const,
		weight: Math.max(0.1, (term.weight ?? 1) * 0.5),
		age: ageOffset + index,
	}));
}

function normalizedMemoryScope(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return normalizeOriginKeyFromUrl(url);
	} catch {
		return undefined;
	}
}

function memoryRecallTokens(url: string | undefined, query: string | undefined): string[] {
	return situationTokens([
		...urlTerms(url).map((term) => term.term),
		query,
	].join(" "));
}

async function loadMemoryEntryForRecall(cwd: string | undefined, entry: CommandMemoryRecallEntry) {
	const id = normalizeMemoryEntryId(entry.id);
	const relPath = `${memoryEntryDir(entry.kind)}/${id}.md`;
	const text = await readFile(resolveMemoryPath(cwd, relPath), "utf8").catch(() => undefined);
	return text ? parseMemoryEntry(text, relPath) : undefined;
}

function boundedMemoryBody(body: string): string | undefined {
	const lines = body.split(/\r?\n/);
	let text = lines.slice(0, 60).join("\n").trim();
	if (!text) return undefined;
	if (text.length > 4000) text = `${text.slice(0, 4000)}...`;
	else if (lines.length > 60) text = `${text}\n...`;
	return text;
}

function nextStrikeCount(current: number, status: MemoryVerificationStatus): number {
	if (status === "fresh") return 0;
	if (status === "stale") return current + 1;
	return current;
}

export async function buildMemoryAugmentationPlan(cwd: string | undefined, url: string | undefined, query: string | undefined): Promise<CommandMemoryAugmentationPlan | undefined> {
	if (!memoryKernelEnabled()) return undefined;
	const origin = memoryOrigin(url);
	const scopeKey = normalizedMemoryScope(url);
	if (!origin || !scopeKey) return undefined;
	const loaded = await readMemoryIndexNoRepair(cwd);
	const tokens = memoryRecallTokens(url, query);
	if (!loaded.index.entries.length || !tokens.length) return undefined;
	const recalled = recallByTokens(loaded.index.entries.map((entry): CommandMemoryRecallEntry => ({
		id: entry.id,
		title: entry.title,
		triggers: entry.triggers,
		scopeKind: entry.scopeKind,
		scopeKey: entry.scopeKey,
		kind: entry.kind,
		status: entry.status,
		updatedAt: entry.updatedAt,
	})), { origin: scopeKey, tokens, limit: 10 }).filter((item) => item.matchReason.includes("idf")).slice(0, 2);
	if (!recalled.length) return undefined;
	const profile = await readCachedMemoryProfile(cwd, origin);
	const cards: Array<Record<string, unknown> & { body?: string }> = [];
	for (const item of recalled) {
		const entry = await loadMemoryEntryForRecall(cwd, item.entry);
		if (!entry) continue;
		const verification = verifyMemoryEntryAgainstProfile(entry, profile, url);
		if (verification.status !== "unverified") {
			void recordMemoryProfileStrike({ cwd, origin, entryId: entry.id, status: verification.status });
		}
		const strikeCount = nextStrikeCount(profile?.strikes[entry.id] ?? 0, verification.status);
		const handle = browserMemoryUriForEntry(entry);
		const card: Record<string, unknown> & { body?: string } = {
			id: entry.id,
			title: entry.title,
			kind: entry.kind,
			confidence: entry.confidence,
			verification: verification.status,
			reasons: verification.reasons,
			matchReason: item.matchReason,
			handle,
			updatedAt: entry.updatedAt,
		};
		if (!(verification.status === "stale" && strikeCount >= 3)) {
			const body = boundedMemoryBody(entry.body);
			if (body) card.body = body;
		}
		cards.push(card);
	}
	if (!cards.length) return undefined;
	const conversationKey = PROCESS_MEMORY_CONVERSATION_ID;
	const seenKey = `${conversationKey}\u0000${origin}`;
	const showInline = !memoryFullShown.has(seenKey);
	memoryFullShown.add(seenKey);
	const handleOnly = { status: "matched", origin, collapsed: true, cards: cards.map(({ body: _body, ...card }) => card) };
	return {
		...(showInline ? { inline: { status: "matched", origin, cards } } : {}),
		handleOnly,
	};
}

export function __resetMemoryAugmentationStateForTests(): void {
	memoryFullShown.clear();
}

export { consumeMemoryProfileDiagnostics, recordMemoryProfileFrame };
