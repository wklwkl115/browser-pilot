import type { PageIdentity } from "./pageIdentity.js";

export type PerceptionLedgerKey = Pick<PageIdentity, "browserSessionId" | "tabId" | "targetGeneration" | "pageEpoch">;

export type PerceptionLedgerFactState = {
	versionStamp: string;
	stableStamp?: string;
};

export type PerceptionLedgerFrame = {
	key: PerceptionLedgerKey;
	snapshotId: string;
	capturedAt: number;
	facts: Record<string, PerceptionLedgerFactState>;
};

export type PerceptionTraceTerm = {
	term: string;
	kind: string;
	weight?: number;
	at: number;
	seq: number;
};

export type PerceptionTraceSnapshot = {
	terms: PerceptionTraceTerm[];
	latestSeq: number;
};

const MAX_TRACE_TERMS_PER_SESSION = 32;
const MAX_LEDGER_FRAMES = 128;
const MAX_TRACE_SESSIONS = 64;

function keyString(key: PerceptionLedgerKey): string {
	return [key.browserSessionId, key.tabId, key.targetGeneration, key.pageEpoch].join("\u0000");
}

function traceKey(browserSessionId?: string): string {
	return browserSessionId || "default";
}

export class PerceptionLedger {
	private readonly frames = new Map<string, PerceptionLedgerFrame>();
	private readonly traces = new Map<string, PerceptionTraceTerm[]>();
	private traceSeq = 0;

	get(key: PerceptionLedgerKey): PerceptionLedgerFrame | undefined {
		return this.frames.get(keyString(key));
	}

	record(frame: PerceptionLedgerFrame): PerceptionLedgerFrame {
		const key = keyString(frame.key);
		for (const [existingKey, existing] of this.frames) {
			if (existingKey !== key && existing.key.browserSessionId === frame.key.browserSessionId && existing.key.tabId === frame.key.tabId) this.frames.delete(existingKey);
		}
		this.frames.delete(key);
		this.frames.set(key, frame);
		while (this.frames.size > MAX_LEDGER_FRAMES) this.frames.delete(this.frames.keys().next().value!);
		return frame;
	}

	migrateTabId(fromTabId: number, toTabId: number, options: { browserSessionIds?: Iterable<string | undefined> } = {}): number {
		if (!Number.isInteger(fromTabId) || !Number.isInteger(toTabId) || fromTabId === toTabId) return 0;
		const scopedSessionIds = options.browserSessionIds ? new Set(Array.from(options.browserSessionIds).map((id) => id || "default")) : undefined;
		const frames = Array.from(this.frames.entries())
			.filter(([, frame]) => frame.key.tabId === fromTabId && (!scopedSessionIds || scopedSessionIds.has(frame.key.browserSessionId || "default")))
			.map(([key, frame]) => ({ key, frame }));
		for (const { key } of frames) this.frames.delete(key);
		for (const { frame } of frames.sort((a, b) => a.frame.capturedAt - b.frame.capturedAt)) {
			this.record({ ...frame, key: { ...frame.key, tabId: toTabId } });
		}
		return frames.length;
	}

	recordTraceTerms(browserSessionId: string | undefined, terms: Array<{ term: string; kind: string; weight?: number }>, at = Date.now()): PerceptionTraceSnapshot {
		const key = traceKey(browserSessionId);
		const existing = this.traces.get(key) ?? [];
		const seen = new Set(existing.map((item) => `${item.kind}\u0000${item.term.toLocaleLowerCase()}`));
		const next = [...existing];
		for (const term of terms) {
			const text = term.term.trim();
			if (!text) continue;
			const dedupeKey = `${term.kind}\u0000${text.toLocaleLowerCase()}`;
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
			this.traceSeq += 1;
			next.push({ term: text, kind: term.kind, weight: term.weight, at, seq: this.traceSeq });
		}
		const retained = next.slice(-MAX_TRACE_TERMS_PER_SESSION);
		this.traces.delete(key);
		this.traces.set(key, retained);
		while (this.traces.size > MAX_TRACE_SESSIONS) this.traces.delete(this.traces.keys().next().value!);
		return { terms: [...retained].reverse(), latestSeq: this.traceSeq };
	}

	traceSnapshot(browserSessionId?: string): PerceptionTraceSnapshot {
		const terms = this.traces.get(traceKey(browserSessionId)) ?? [];
		return { terms: [...terms].reverse(), latestSeq: this.traceSeq };
	}

	clear(): void {
		this.frames.clear();
		this.traces.clear();
		this.traceSeq = 0;
	}
}
