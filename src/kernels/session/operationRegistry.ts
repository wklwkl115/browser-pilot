import { createHash, randomUUID } from "node:crypto";
import type { BrowserOperationEvent, BrowserOperationLateEffect, BrowserOperationOutcome, BrowserOperationStatus } from "./browserOperation.js";

export type SessionActiveOperationInfo = {
	operationId: string;
	commandName: string;
	command?: string;
	browserSessionId?: string;
	tabId?: number;
	phase: string;
	progress?: number;
	queueDepth?: number;
	leaseOwnerHash?: string;
	conflictReason?: string;
	snapshotId?: string;
	sourceMode?: string;
	details?: Record<string, unknown>;
	state: "active" | "terminal";
	/** Monotonic change counter used by event-driven operation settlement. */
	revision: number;
	ownerHash?: string;
	sequence: number;
	lastProgressAt: number;
	generation?: number;
	events: BrowserOperationEvent[];
	lateEffects: BrowserOperationLateEffect[];
	lateEffectsSurfacedAt?: number;
	lateEffectsSurfacedSequence?: number;
	terminalAt?: number;
	passiveUntil?: number;
	terminalStatus?: BrowserOperationStatus;
	outcome?: BrowserOperationOutcome;
	startedAt: number;
	updatedAt: number;
};

export type SessionOperationBeginInput = Omit<SessionActiveOperationInfo,
	"operationId" | "startedAt" | "updatedAt" | "state" | "revision" | "sequence" | "lastProgressAt" | "events" | "lateEffects" | "ownerHash"
> & { operationId?: string; ownerId?: string };

const DEFAULT_OPERATION_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_OPERATIONS = 256;
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_PASSIVE_WINDOW_MS = 30_000;

function ownerHash(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

export class SessionOperationRegistry {
	private readonly operations = new Map<string, SessionActiveOperationInfo>();
	private readonly ttlMs: number;
	private readonly maxOperations: number;
	private readonly now: () => number;
	private readonly maxEvents: number;
	private readonly passiveWindowMs: number;

	constructor(options: { ttlMs?: number; maxOperations?: number; maxEvents?: number; passiveWindowMs?: number; now?: () => number } = {}) {
		this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_OPERATION_TTL_MS));
		this.maxOperations = Math.max(1, Math.floor(options.maxOperations ?? DEFAULT_MAX_OPERATIONS));
		this.now = options.now ?? Date.now;
		this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_MAX_EVENTS));
		this.passiveWindowMs = Math.max(0, Math.floor(options.passiveWindowMs ?? DEFAULT_PASSIVE_WINDOW_MS));
	}

	begin(operation: SessionOperationBeginInput): SessionActiveOperationInfo {
		this.pruneStale();
		const now = this.now();
		const record: SessionActiveOperationInfo = {
			operationId: operation.operationId || randomUUID(),
			commandName: operation.commandName,
			command: operation.command,
			browserSessionId: operation.browserSessionId,
			tabId: operation.tabId,
			phase: operation.phase,
			progress: operation.progress,
			queueDepth: operation.queueDepth,
			leaseOwnerHash: ownerHash(operation.leaseOwnerHash || operation.browserSessionId),
			ownerHash: ownerHash(operation.ownerId || "local-cli"),
			conflictReason: operation.conflictReason,
			snapshotId: operation.snapshotId,
			sourceMode: operation.sourceMode,
			details: operation.details,
			state: "active",
			revision: 1,
			sequence: 0,
			lastProgressAt: now,
			generation: operation.generation,
			events: [],
			lateEffects: [],
			startedAt: now,
			updatedAt: now,
		};
		this.operations.set(record.operationId, record);
		this.pruneToMaxSize();
		return { ...record };
	}

	update(operationId: string, patch: Partial<Omit<SessionActiveOperationInfo, "operationId" | "startedAt">>): SessionActiveOperationInfo | undefined {
		this.pruneStale();
		const current = this.operations.get(operationId);
		if (!current) return undefined;
		const nextLeaseOwnerHash = Object.prototype.hasOwnProperty.call(patch, "leaseOwnerHash")
			? ownerHash(typeof patch.leaseOwnerHash === "string" ? patch.leaseOwnerHash : undefined)
			: current.leaseOwnerHash;
		const next: SessionActiveOperationInfo = {
			...current,
			...patch,
			revision: current.revision + 1,
			leaseOwnerHash: nextLeaseOwnerHash,
			ownerHash: current.ownerHash,
			events: current.events,
			lateEffects: current.lateEffects,
			updatedAt: this.now(),
		};
		this.operations.set(operationId, next);
		return { ...next };
	}

	get(operationId: string): SessionActiveOperationInfo | undefined {
		this.pruneStale();
		const current = this.operations.get(operationId);
		return current ? this.copy(current) : undefined;
	}

	finish(operationId: string, outcome?: BrowserOperationOutcome): SessionActiveOperationInfo | undefined {
		this.pruneStale();
		const current = this.operations.get(operationId);
		if (!current) return undefined;
		if (current.state === "terminal") return this.copy(current);
		const now = this.now();
		const next: SessionActiveOperationInfo = {
			...current,
			revision: current.revision + 1,
			state: "terminal",
			phase: outcome?.status ?? current.phase,
			progress: 100,
			terminalStatus: outcome?.status,
			outcome,
			terminalAt: now,
			passiveUntil: now + this.passiveWindowMs,
			updatedAt: now,
		};
		this.operations.set(operationId, next);
		return this.copy(next);
	}

	recordEvent(operationId: string, event: Omit<BrowserOperationEvent, "operationId" | "sequence" | "timestamp"> & { sequence?: number; timestamp?: number }): SessionActiveOperationInfo | undefined {
		this.pruneStale();
		const current = this.operations.get(operationId);
		if (!current) return undefined;
		const now = this.now();
		if (current.state === "terminal" && (current.passiveUntil === undefined || now > current.passiveUntil)) return this.copy(current);
		const sequence = Math.max(current.sequence + 1, Math.floor(event.sequence ?? 0));
		const item: BrowserOperationEvent = {
			operationId,
			sequence,
			type: String(event.type || "unknown"),
			timestamp: Math.floor(event.timestamp ?? now),
			...(event.targetRef ? { targetRef: event.targetRef } : {}),
			...(event.tabId !== undefined ? { tabId: event.tabId } : {}),
			...(event.generation !== undefined ? { generation: event.generation } : {}),
			...(event.progress !== undefined ? { progress: event.progress } : {}),
			...(event.data ? { data: this.compactData(event.data) } : {}),
			...(current.state === "terminal" ? { late: true } : {}),
		};
		const events = [...current.events, item].slice(-this.maxEvents);
		const lateEffects = current.state === "terminal"
			? [...current.lateEffects, { type: "late_effect" as const, operationId, commandName: current.commandName, terminalStatus: current.terminalStatus ?? "failed", event: item }].slice(-this.maxEvents)
			: current.lateEffects;
		const next = {
			...current,
			revision: current.revision + 1,
			sequence,
			events,
			lateEffects,
			lastProgressAt: current.state === "active" && event.progress !== false ? now : current.lastProgressAt,
			updatedAt: now,
		};
		this.operations.set(operationId, next);
		return this.copy(next);
	}

	surfaceLateEffects(input: { ownerId?: string; browserSessionId?: string; excludeOperationId?: string }): BrowserOperationLateEffect[] {
		this.pruneStale();
		const expectedOwnerHash = ownerHash(input.ownerId || "local-cli");
		const surfaced: BrowserOperationLateEffect[] = [];
		const now = this.now();
		for (const [operationId, current] of this.operations.entries()) {
			const surfacedSequence = Math.max(0, current.lateEffectsSurfacedSequence ?? 0);
			const unsurfaced = current.lateEffects.filter((effect) => effect.event.sequence > surfacedSequence);
			if (operationId === input.excludeOperationId || current.state !== "terminal" || !unsurfaced.length) continue;
			if (current.ownerHash !== expectedOwnerHash || current.browserSessionId !== input.browserSessionId) continue;
			surfaced.push(...unsurfaced);
			this.operations.set(operationId, { ...current, lateEffectsSurfacedAt: now, lateEffectsSurfacedSequence: Math.max(...unsurfaced.map((effect) => effect.event.sequence)), updatedAt: now });
		}
		return surfaced.slice(-this.maxEvents);
	}

	snapshot(options: { includeTerminal?: boolean } = {}): SessionActiveOperationInfo[] {
		this.pruneStale();
		return Array.from(this.operations.values())
			.filter((item) => options.includeTerminal !== false || item.state === "active")
			.map((item) => this.copy(item))
			.sort((a, b) => a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId));
	}

	clear(): void {
		this.operations.clear();
	}

	private pruneStale(now = this.now()): void {
		for (const [operationId, operation] of this.operations.entries()) {
			if (now - operation.updatedAt > this.ttlMs) this.operations.delete(operationId);
		}
	}

	private pruneToMaxSize(): void {
		if (this.operations.size <= this.maxOperations) return;
		const overflow = this.operations.size - this.maxOperations;
		const oldest = Array.from(this.operations.values())
			.sort((a, b) => Number(a.state === "active") - Number(b.state === "active") || a.updatedAt - b.updatedAt || a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId))
			.slice(0, overflow);
		for (const operation of oldest) this.operations.delete(operation.operationId);
	}

	private compactData(value: Record<string, unknown>): Record<string, unknown> {
		return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) => [key, this.compactValue(key, item, 0)]));
	}

	private compactValue(key: string, value: unknown, depth: number): unknown {
		if (/authorization|cookie|token|secret|password|body|postdata/i.test(key)) return "[redacted]";
		if (typeof value === "string") return value.slice(0, 500).replace(/([?&][^=&#\s]{1,120}=)[^&#\s]*/g, "$1[redacted]");
		if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
		if (depth >= 3) return "[bounded]";
		if (Array.isArray(value)) return value.slice(0, 20).map((item) => this.compactValue(key, item, depth + 1));
		if (!value || typeof value !== "object") return String(value);
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 12).map(([childKey, item]) => [childKey, this.compactValue(childKey, item, depth + 1)]));
	}

	private copy(operation: SessionActiveOperationInfo): SessionActiveOperationInfo {
		return {
			...operation,
			details: operation.details ? { ...operation.details } : undefined,
			events: operation.events.map((event) => ({ ...event, data: event.data ? { ...event.data } : undefined })),
			lateEffects: operation.lateEffects.map((effect) => ({ ...effect, event: { ...effect.event, data: effect.event.data ? { ...effect.event.data } : undefined } })),
			outcome: operation.outcome ? { ...operation.outcome, target: { ...operation.outcome.target }, dispatch: { ...operation.outcome.dispatch }, signals: { ...operation.outcome.signals } } : undefined,
		};
	}
}
