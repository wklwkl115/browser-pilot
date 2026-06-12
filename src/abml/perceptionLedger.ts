import type { Entity } from "./entity.js";

export type PerceptionLedgerKey = {
	browserSessionId?: string;
	tabId?: number;
	navigationEpoch?: string;
};

export type PerceptionObjectiveKey = {
	tabId?: number;
	navigationEpoch?: string;
};

export type PerceptionLedgerFactState = {
	versionStamp: string;
	stableStamp?: string;
	lastShownGranularity: "full" | "compact" | "line" | "ref";
};

export type PerceptionLedgerFrame = {
	key: PerceptionLedgerKey;
	snapshotId: string;
	capturedAt: number;
	facts: Record<string, PerceptionLedgerFactState>;
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
	renderCache?: {
		mode: string;
		detailLevel: string;
		maxChars: number;
		paramsSignature: string;
		renderedAt: number;
	};
	allocation?: {
		budgetUsedRatio: number;
		omittedCount: number;
	};
	objective?: {
		key: PerceptionObjectiveKey;
		snapshotId: string;
		shared: boolean;
	};
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

const MAX_FRAMES_PER_SESSION_TAB = 8;
const MAX_TRACE_TERMS_PER_SESSION = 32;

function frameScopeKey(key: PerceptionLedgerKey): string {
	return [key.browserSessionId || "default", key.tabId ?? "tab"].join("\u0000");
}

function keyString(key: PerceptionLedgerKey): string {
	return [frameScopeKey(key), key.navigationEpoch || "unknown"].join("\u0000");
}

function traceKey(browserSessionId?: string): string {
	return browserSessionId || "default";
}

function objectiveKey(key: PerceptionLedgerKey): PerceptionObjectiveKey {
	return { tabId: key.tabId, navigationEpoch: key.navigationEpoch };
}

function objectiveKeyString(key: PerceptionObjectiveKey): string {
	return [key.tabId ?? "tab", key.navigationEpoch || "unknown"].join("\u0000");
}

function objectiveFingerprint(frame: PerceptionLedgerFrame): string {
	return JSON.stringify({
		facts: frame.facts,
		pageFingerprint: frame.pageFingerprint,
	});
}

function objectiveEquivalent(a: PerceptionLedgerFrame | undefined, b: PerceptionLedgerFrame): boolean {
	return !!a && objectiveFingerprint(a) === objectiveFingerprint(b);
}

function entityVersionStamp(entity: Entity): string {
	return JSON.stringify({
		kind: entity.kind,
		role: entity.role,
		name: entity.name,
		value: entity.value,
		state: entity.state,
		structure: entity.structure,
		relations: entity.relations?.map((rel) => ({ type: rel.type, targetRef: rel.targetRef, source: rel.source, confidence: rel.confidence })),
	});
}

function entityStableStamp(entity: Entity): string {
	return JSON.stringify({
		kind: entity.kind,
		role: entity.role,
		name: entity.name,
		value: entity.value,
		state: entity.state,
		structure: entity.structure,
	});
}

export function factsFromEntities(entities: Entity[], granularity: PerceptionLedgerFactState["lastShownGranularity"] = "compact"): Record<string, PerceptionLedgerFactState> {
	const facts: Record<string, PerceptionLedgerFactState> = {};
	for (const entity of entities) facts[entity.ref] = { versionStamp: entityVersionStamp(entity), stableStamp: entityStableStamp(entity), lastShownGranularity: granularity };
	return facts;
}

export function stableRefsFromFrames(current: PerceptionLedgerFrame, prior: PerceptionLedgerFrame | undefined): Set<string> {
	const out = new Set<string>();
	if (!prior) return out;
	for (const [ref, state] of Object.entries(current.facts)) {
		const previous = prior.facts[ref];
		if (!previous) continue;
		if ((state.stableStamp ?? state.versionStamp) === (previous.stableStamp ?? previous.versionStamp)) out.add(ref);
	}
	return out;
}

export class PerceptionLedger {
	private readonly frames = new Map<string, PerceptionLedgerFrame>();
	private readonly frameOrder = new Map<string, string[]>();
	private readonly objectiveFrames = new Map<string, PerceptionLedgerFrame>();
	private readonly objectiveOrder: string[] = [];
	private readonly traces = new Map<string, PerceptionTraceTerm[]>();
	private traceSeq = 0;

	get(key: PerceptionLedgerKey): PerceptionLedgerFrame | undefined {
		return this.frames.get(keyString(key));
	}

	recent(key: PerceptionLedgerKey, limit = 3): PerceptionLedgerFrame[] {
		const scope = frameScopeKey(key);
		const order = this.frameOrder.get(scope) ?? [];
		const out: PerceptionLedgerFrame[] = [];
		for (let index = order.length - 1; index >= 0 && out.length < limit; index--) {
			const frame = this.frames.get(order[index]!);
			if (frame) out.push(frame);
		}
		return out;
	}

	record(frame: PerceptionLedgerFrame): PerceptionLedgerFrame {
		const key = keyString(frame.key);
		const objective = objectiveKey(frame.key);
		const objectiveMapKey = objectiveKeyString(objective);
		const priorObjective = this.objectiveFrames.get(objectiveMapKey);
		const objectiveSnapshotId = objectiveEquivalent(priorObjective, frame) ? priorObjective!.snapshotId : frame.snapshotId;
		const recorded = {
			...frame,
			objective: {
				key: objective,
				snapshotId: objectiveSnapshotId,
				shared: !!priorObjective,
			},
		};
		if (!priorObjective || !objectiveEquivalent(priorObjective, frame)) {
			this.objectiveFrames.set(objectiveMapKey, { ...recorded, key: { tabId: objective.tabId, navigationEpoch: objective.navigationEpoch } });
			const existing = this.objectiveOrder.indexOf(objectiveMapKey);
			if (existing >= 0) this.objectiveOrder.splice(existing, 1);
			this.objectiveOrder.push(objectiveMapKey);
			while (this.objectiveOrder.length > MAX_FRAMES_PER_SESSION_TAB) {
				const stale = this.objectiveOrder.shift();
				if (stale) this.objectiveFrames.delete(stale);
			}
		}
		this.frames.set(key, recorded);
		const scope = frameScopeKey(frame.key);
		const order = (this.frameOrder.get(scope) ?? []).filter((item) => item !== key);
		order.push(key);
		while (order.length > MAX_FRAMES_PER_SESSION_TAB) {
			const stale = order.shift();
			if (stale) this.frames.delete(stale);
		}
		this.frameOrder.set(scope, order);
		return recorded;
	}

	objective(key: PerceptionObjectiveKey): PerceptionLedgerFrame | undefined {
		return this.objectiveFrames.get(objectiveKeyString(key));
	}

	objectiveFrameCount(): number {
		return this.objectiveFrames.size;
	}

	migrateTabId(fromTabId: number, toTabId: number, options: { browserSessionIds?: Iterable<string | undefined> } = {}): number {
		if (!Number.isInteger(fromTabId) || !Number.isInteger(toTabId) || fromTabId === toTabId) return 0;
		const scopedSessionIds = options.browserSessionIds ? new Set(Array.from(options.browserSessionIds).map((id) => id || "default")) : undefined;
		const frames = Array.from(this.frames.entries())
			.filter(([, frame]) => frame.key.tabId === fromTabId && (!scopedSessionIds || scopedSessionIds.has(frame.key.browserSessionId || "default")))
			.map(([key, frame]) => ({ key, frame }));
		for (const { key } of frames) this.frames.delete(key);
		for (const orderKey of Array.from(this.frameOrder.keys())) {
			this.frameOrder.set(orderKey, (this.frameOrder.get(orderKey) ?? []).filter((item) => !frames.some((frame) => frame.key === item)));
		}
		for (const { frame } of frames.sort((a, b) => a.frame.capturedAt - b.frame.capturedAt)) {
			this.record({ ...frame, key: { ...frame.key, tabId: toTabId } });
		}
		for (const [key, frame] of Array.from(this.objectiveFrames.entries())) {
			if (frame.key.tabId !== fromTabId) continue;
			this.objectiveFrames.delete(key);
			const moved = { ...frame, key: { ...frame.key, tabId: toTabId }, objective: undefined };
			const nextKey = objectiveKeyString(objectiveKey(moved.key));
			this.objectiveFrames.set(nextKey, { ...moved, objective: { key: objectiveKey(moved.key), snapshotId: moved.snapshotId, shared: false } });
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
		this.traces.set(key, retained);
		return { terms: [...retained].reverse(), latestSeq: this.traceSeq };
	}

	traceSnapshot(browserSessionId?: string): PerceptionTraceSnapshot {
		const terms = this.traces.get(traceKey(browserSessionId)) ?? [];
		return { terms: [...terms].reverse(), latestSeq: this.traceSeq };
	}

	clear(): void {
		this.frames.clear();
		this.frameOrder.clear();
		this.objectiveFrames.clear();
		this.objectiveOrder.splice(0, this.objectiveOrder.length);
		this.traces.clear();
		this.traceSeq = 0;
	}
}
