import path from "node:path";
import type { PerceptionLedgerFrame, PerceptionTraceSnapshot } from "../kernels/abml/perceptionLedger.js";
import { distillFrameIntoProfile, emptyMemoryOriginProfile, mergeProfiles } from "../kernels/memory/profile.js";
import { applyVerificationStrike } from "../kernels/memory/staleness.js";
import { toPersistableMemoryTerm, type MemoryFrameView, type MemoryOriginProfile, type MemoryTraceView, type MemoryVerificationStatus } from "../kernels/memory/types.js";
import { containsSensitiveEvidence } from "../utils/redaction.js";
import { readMemoryProfile, writeMemoryProfile } from "./profileStore.js";
import { hmacMemoryStamp } from "./hashStamp.js";
import { memoryKernelEnabled } from "./secret.js";

const FLUSH_DELAY_MS = 25;
const FLUSH_FRAME_THRESHOLD = 2;
const DIAGNOSTIC_CAP = 2000;

type ProfileState = {
	cwd?: string;
	origin: string;
	pending?: MemoryOriginProfile;
	chain: Promise<void>;
	timer?: NodeJS.Timeout;
	frameCount: number;
	lastNavigationEpoch?: string;
};

const states = new Map<string, ProfileState>();
const diagnostics = new Map<string, Set<string>>();

function cwdKey(cwd?: string): string {
	return path.resolve(cwd || process.cwd());
}

function stateKey(cwd: string | undefined, origin: string): string {
	return `${cwdKey(cwd)}\u0000${origin}`;
}

function rememberDiagnostic(cwd: string | undefined, warning: string | undefined): void {
	if (!warning) return;
	const key = cwdKey(cwd);
	if (diagnostics.size >= DIAGNOSTIC_CAP && !diagnostics.has(key)) diagnostics.clear();
	const set = diagnostics.get(key) ?? new Set<string>();
	set.add(warning);
	diagnostics.set(key, set);
}

export function consumeMemoryProfileDiagnostics(cwd?: string): string[] {
	const key = cwdKey(cwd);
	const set = diagnostics.get(key);
	if (!set) return [];
	diagnostics.delete(key);
	return [...set].sort();
}

function canonicalPageUrl(url: string | undefined): { origin: string; canonicalUrl: string } | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		return { origin: parsed.origin, canonicalUrl: `${parsed.origin}${parsed.pathname || "/"}` };
	} catch {
		return undefined;
	}
}

function fingerprintSummary(frame: PerceptionLedgerFrame): Record<string, unknown> | undefined {
	const fingerprint = frame.pageFingerprint;
	if (!fingerprint) return undefined;
	return {
		changeSeq: fingerprint.changeSeq,
		...(fingerprint.readyState ? { readyState: fingerprint.readyState } : {}),
		...(typeof fingerprint.visibleCount === "number" ? { visibleCount: fingerprint.visibleCount } : {}),
		...(typeof fingerprint.interactiveCount === "number" ? { interactiveCount: fingerprint.interactiveCount } : {}),
	};
}

async function hashedFactStamps(cwd: string | undefined, origin: string, facts: PerceptionLedgerFrame["facts"]): Promise<Record<string, string> | undefined> {
	const out: Record<string, string> = {};
	for (const [ref, fact] of Object.entries(facts)) {
		const stamp = fact.stableStamp ?? fact.versionStamp;
		const hashed = await hmacMemoryStamp(cwd, origin, stamp);
		if (hashed) out[ref] = hashed;
	}
	return Object.keys(out).length ? out : undefined;
}

function traceViewFromSnapshot(browserSessionId: string | undefined, frame: PerceptionLedgerFrame, trace: PerceptionTraceSnapshot | undefined): MemoryTraceView {
	const terms = (trace?.terms ?? [])
		.map((term) => toPersistableMemoryTerm({ term: term.term, kind: term.kind, weight: term.weight }))
		.filter((term): term is NonNullable<typeof term> => !!term && !isSensitiveMemoryTerm(term.term));
	return { sessionId: browserSessionId ?? frame.key.browserSessionId, capturedAt: frame.capturedAt, terms };
}

function isSensitiveMemoryTerm(term: string): boolean {
	if (containsSensitiveEvidence(term)) return true;
	if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(term)) return true;
	if (/\b(?:token|secret|password|passwd|pwd|auth|session|cookie|api[_-]?key)\b\s*[:=]/i.test(term)) return true;
	return false;
}

async function frameViewFromLedger(cwd: string | undefined, frame: PerceptionLedgerFrame): Promise<MemoryFrameView | undefined> {
	const page = canonicalPageUrl(frame.pageFingerprint?.url);
	if (!page) return undefined;
	return {
		origin: page.origin,
		sessionId: frame.key.browserSessionId,
		canonicalUrl: page.canonicalUrl,
		capturedAt: frame.capturedAt,
		factStamps: await hashedFactStamps(cwd, page.origin, frame.facts),
		fingerprintSummary: fingerprintSummary(frame),
	};
}

function stateFor(cwd: string | undefined, origin: string): ProfileState {
	const key = stateKey(cwd, origin);
	const existing = states.get(key);
	if (existing) return existing;
	const state: ProfileState = { cwd, origin, chain: Promise.resolve(), frameCount: 0 };
	states.set(key, state);
	return state;
}

function mergePending(state: ProfileState, delta: MemoryOriginProfile): void {
	state.pending = mergeProfiles(state.pending, delta);
}

async function flushState(state: ProfileState): Promise<void> {
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = undefined;
	}
	const pending = state.pending;
	state.pending = undefined;
	state.frameCount = 0;
	if (!pending) return;
	state.chain = state.chain.then(async () => {
		const disk = await readMemoryProfile(state.cwd, state.origin);
		rememberDiagnostic(state.cwd, disk.warning);
		const merged = mergeProfiles(disk.profile, pending);
		if (merged) await writeMemoryProfile(state.cwd, merged);
	}).catch((error) => {
		rememberDiagnostic(state.cwd, "memory_profile_persist_failed");
		if (process.env.BROWSER_PILOT_MEMORY_DEBUG === "1") console.warn("[browser-pilot-memory] profile flush failed", error);
	});
	await state.chain;
}

function scheduleFlush(state: ProfileState, immediate: boolean): void {
	if (immediate) {
		void flushState(state);
		return;
	}
	if (state.timer) return;
	state.timer = setTimeout(() => { void flushState(state); }, FLUSH_DELAY_MS);
}

export async function recordMemoryProfileFrame(options: { cwd?: string; browserSessionId?: string; frame: PerceptionLedgerFrame; trace?: PerceptionTraceSnapshot; fromCache?: boolean }): Promise<void> {
	if (!memoryKernelEnabled() || options.fromCache) return;
	const frameView = await frameViewFromLedger(options.cwd, options.frame).catch((error) => {
		rememberDiagnostic(options.cwd, "memory_profile_persist_failed");
		if (process.env.BROWSER_PILOT_MEMORY_DEBUG === "1") console.warn("[browser-pilot-memory] frame view failed", error);
		return undefined;
	});
	if (!frameView) return;
	const traceView = traceViewFromSnapshot(options.browserSessionId, options.frame, options.trace);
	const delta = distillFrameIntoProfile(undefined, frameView, traceView);
	const state = stateFor(options.cwd, frameView.origin);
	const navigationEpoch = options.frame.key.navigationEpoch;
	const navigationChanged = !!state.lastNavigationEpoch && !!navigationEpoch && state.lastNavigationEpoch !== navigationEpoch;
	state.lastNavigationEpoch = navigationEpoch ?? state.lastNavigationEpoch;
	mergePending(state, delta);
	state.frameCount += 1;
	scheduleFlush(state, navigationChanged || state.frameCount >= FLUSH_FRAME_THRESHOLD);
}

export async function recordMemoryProfileStrike(options: { cwd?: string; origin: string; entryId: string; status: MemoryVerificationStatus }): Promise<void> {
	if (!memoryKernelEnabled()) return;
	const state = stateFor(options.cwd, options.origin);
	const base = state.pending ?? emptyMemoryOriginProfile(options.origin);
	state.pending = applyVerificationStrike(base, options.entryId, options.status);
	scheduleFlush(state, true);
}

export async function readCachedMemoryProfile(cwd: string | undefined, origin: string): Promise<MemoryOriginProfile | undefined> {
	if (!memoryKernelEnabled()) return undefined;
	const state = states.get(stateKey(cwd, origin));
	const disk = await readMemoryProfile(cwd, origin);
	rememberDiagnostic(cwd, disk.warning);
	return mergeProfiles(disk.profile, state?.pending);
}

export async function drainMemoryProfileFlushes(): Promise<void> {
	for (const state of states.values()) await flushState(state);
	await Promise.all([...states.values()].map((state) => state.chain));
}

export function __resetMemoryProfileServiceForTests(): void {
	for (const state of states.values()) if (state.timer) clearTimeout(state.timer);
	states.clear();
	diagnostics.clear();
}
