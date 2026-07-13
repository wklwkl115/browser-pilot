import { createHash, randomUUID } from "node:crypto";
import type { BrowserOperationEvent, BrowserOperationLateEffect, BrowserOperationOutcome, BrowserOperationStatus } from "./browserOperation.js";

export type SessionActiveOperationInfo = {
	operationId: string;
	commandName: string;
	command?: string;
	browserSessionId?: string;
	tabId?: number;
	targetRef?: string;
	phase: string;
	progress?: number;
	queueDepth?: number;
	leaseOwnerHash?: string;
	conflictReason?: string;
	snapshotId?: string;
	sourceMode?: string;
	details?: Record<string, unknown>;
	mutation?: boolean;
	state: "active" | "terminal";
	/** Monotonic change counter used by event-driven operation settlement. */
	revision: number;
	ownerHash?: string;
	intentHash?: string;
	intentPayloadHash?: string;
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
	verificationRequired?: boolean;
	verifiedAt?: number;
	outcome?: BrowserOperationOutcome;
	startedAt: number;
	updatedAt: number;
};

export type SessionOperationBeginInput = Omit<SessionActiveOperationInfo,
	"operationId" | "startedAt" | "updatedAt" | "state" | "revision" | "sequence" | "lastProgressAt" | "events" | "lateEffects" | "ownerHash" | "intentHash" | "intentPayloadHash" | "verificationRequired" | "verifiedAt"
> & { operationId?: string; ownerId?: string; intentId?: string; intentPayload?: unknown };

export type SessionMutationReplayGuard = {
	kind: "intent_replay" | "intent_conflict" | "mutation_in_progress" | "observation_required" | "ledger_capacity";
	operationId: string;
	commandName: string;
	state: SessionActiveOperationInfo["state"];
	terminalStatus?: BrowserOperationStatus;
	outcome?: BrowserOperationOutcome;
};

export type SessionMutationGuardInput = {
	ownerId?: string;
	browserSessionId?: string;
	tabId?: number;
	targetRef?: string;
	generation?: number;
	commandName: string;
	intentId?: string;
	intentPayload?: unknown;
	observationStartedAt?: number;
};

const DEFAULT_OPERATION_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_OPERATIONS = 256;
const DEFAULT_MAX_PROTECTED_MUTATIONS = 4_096;
const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_PASSIVE_WINDOW_MS = 30_000;

function ownerHash(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

function intentHash(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	if (!normalized) return undefined;
	return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 20);
}

function stablePayload(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return `[${value.map(stablePayload).join(",")}]`;
	if (typeof value !== "object") return JSON.stringify(String(value));
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stablePayload(record[key])}`).join(",")}}`;
}

function intentPayloadHash(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return createHash("sha256").update(stablePayload(value), "utf8").digest("hex").slice(0, 20);
}

function stableTargetRef(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized.replace(/_g\d+$/i, "") : undefined;
}

function sameMutationScope(operation: SessionActiveOperationInfo, input: SessionMutationGuardInput, expectedOwnerHash: string | undefined): boolean {
	if (operation.ownerHash !== expectedOwnerHash) return false;
	if (operation.browserSessionId !== input.browserSessionId) return false;
	const operationTargetRef = stableTargetRef(operation.targetRef);
	const inputTargetRef = stableTargetRef(input.targetRef);
	if (operationTargetRef && inputTargetRef) return operationTargetRef === inputTargetRef;
	return operation.tabId === input.tabId;
}

function sameObservationScope(operation: SessionActiveOperationInfo, input: SessionMutationGuardInput, expectedOwnerHash: string | undefined): boolean {
	if (!sameMutationScope(operation, input, expectedOwnerHash)) return false;
	return input.generation === undefined || operation.generation === undefined || operation.generation === input.generation;
}

function protectsMutationEvidence(operation: SessionActiveOperationInfo): boolean {
	return (operation.state === "active" && operation.mutation === true)
		|| operation.intentHash !== undefined
		|| (operation.mutation === true && operation.verificationRequired === true && operation.verifiedAt === undefined);
}

export class SessionOperationRegistry {
	private readonly operations = new Map<string, SessionActiveOperationInfo>();
	private readonly ttlMs: number;
	private readonly maxOperations: number;
	private readonly maxProtectedMutations: number;
	private readonly now: () => number;
	private readonly maxEvents: number;
	private readonly passiveWindowMs: number;

	constructor(options: { ttlMs?: number; maxOperations?: number; maxProtectedMutations?: number; maxEvents?: number; passiveWindowMs?: number; now?: () => number } = {}) {
		this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_OPERATION_TTL_MS));
		this.maxOperations = Math.max(1, Math.floor(options.maxOperations ?? DEFAULT_MAX_OPERATIONS));
		this.maxProtectedMutations = Math.max(1, Math.floor(options.maxProtectedMutations ?? DEFAULT_MAX_PROTECTED_MUTATIONS));
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
			targetRef: operation.targetRef,
			phase: operation.phase,
			progress: operation.progress,
			queueDepth: operation.queueDepth,
			leaseOwnerHash: ownerHash(operation.leaseOwnerHash || operation.browserSessionId),
			ownerHash: ownerHash(operation.ownerId || "local-cli"),
			intentHash: intentHash(operation.intentId),
			intentPayloadHash: intentPayloadHash(operation.intentPayload),
			mutation: operation.mutation === true,
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
			intentHash: current.intentHash,
			intentPayloadHash: current.intentPayloadHash,
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
			mutation: current.mutation === true || outcome !== undefined,
			intentHash: outcome && !outcome.dispatch.started ? undefined : current.intentHash,
			intentPayloadHash: outcome && !outcome.dispatch.started ? undefined : current.intentPayloadHash,
			verificationRequired: outcome !== undefined
				&& outcome.status !== "completed"
				&& outcome.dispatch.started
				&& outcome.dispatch.acknowledged,
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

	mutationReplayGuard(input: SessionMutationGuardInput): SessionMutationReplayGuard | undefined {
		this.pruneStale();
		const expectedOwnerHash = ownerHash(input.ownerId || "local-cli");
		const matching = Array.from(this.operations.values())
			.filter((operation) => operation.mutation === true && sameMutationScope(operation, input, expectedOwnerHash))
			.sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || b.operationId.localeCompare(a.operationId));
		const expectedIntentHash = intentHash(input.intentId);
		const expectedIntentPayloadHash = intentPayloadHash(input.intentPayload);
		if (expectedIntentHash) {
			const priorIntent = matching.find((operation) => operation.intentHash === expectedIntentHash);
			if (priorIntent) return {
				kind: priorIntent.intentPayloadHash !== undefined && expectedIntentPayloadHash !== undefined && priorIntent.intentPayloadHash !== expectedIntentPayloadHash ? "intent_conflict" : "intent_replay",
				operationId: priorIntent.operationId,
				commandName: priorIntent.commandName,
				state: priorIntent.state,
				terminalStatus: priorIntent.terminalStatus,
				outcome: priorIntent.outcome ? this.copy(priorIntent).outcome : undefined,
			};
		}
		const active = matching.find((operation) => operation.state === "active");
		if (active) return {
			kind: "mutation_in_progress",
			operationId: active.operationId,
			commandName: active.commandName,
			state: active.state,
		};
		const unverified = matching.find((operation) => operation.state === "terminal" && operation.verificationRequired === true && operation.verifiedAt === undefined);
		if (unverified) return {
			kind: "observation_required",
			operationId: unverified.operationId,
			commandName: unverified.commandName,
			state: unverified.state,
			terminalStatus: unverified.terminalStatus,
			outcome: unverified.outcome ? this.copy(unverified).outcome : undefined,
		};
		const protectedMutations = Array.from(this.operations.values()).filter((operation) => operation.mutation === true && protectsMutationEvidence(operation));
		const capacityRecord = expectedIntentHash && protectedMutations.length >= this.maxProtectedMutations
			? protectedMutations.sort((a, b) => a.updatedAt - b.updatedAt || a.operationId.localeCompare(b.operationId))[0]
			: undefined;
		return capacityRecord ? {
			kind: "ledger_capacity",
			operationId: capacityRecord.operationId,
			commandName: capacityRecord.commandName,
			state: capacityRecord.state,
			terminalStatus: capacityRecord.terminalStatus,
		} : undefined;
	}

	markMutationObserved(input: Omit<SessionMutationGuardInput, "intentId">): number {
		this.pruneStale();
		const expectedOwnerHash = ownerHash(input.ownerId || "local-cli");
		const now = this.now();
		let marked = 0;
		for (const [operationId, operation] of this.operations.entries()) {
			if (operation.mutation !== true || !sameObservationScope(operation, input, expectedOwnerHash) || operation.state !== "terminal" || operation.verificationRequired !== true || operation.verifiedAt !== undefined) continue;
			if (input.observationStartedAt !== undefined && (operation.terminalAt === undefined || operation.terminalAt > input.observationStartedAt)) continue;
			this.operations.set(operationId, { ...operation, verifiedAt: now, revision: operation.revision + 1, updatedAt: now });
			marked += 1;
		}
		return marked;
	}

	snapshot(options: { includeTerminal?: boolean } = {}): SessionActiveOperationInfo[] {
		this.pruneStale();
		return Array.from(this.operations.values())
			.filter((item) => options.includeTerminal !== false || item.state === "active")
			.map((item) => this.copy(item))
			.sort((a, b) => a.startedAt - b.startedAt || a.operationId.localeCompare(b.operationId));
	}

	clear(options: { preserveMutationEvidence?: boolean } = {}): void {
		if (!options.preserveMutationEvidence) {
			this.operations.clear();
			return;
		}
		const now = this.now();
		for (const [operationId, operation] of this.operations.entries()) {
			if (operation.mutation !== true || !protectsMutationEvidence(operation)) {
				this.operations.delete(operationId);
				continue;
			}
			if (operation.state === "active" && operation.mutation === true) {
				this.operations.set(operationId, {
					...operation,
					state: "terminal",
					phase: "ambiguous",
					terminalStatus: "ambiguous",
					verificationRequired: true,
					terminalAt: now,
					passiveUntil: now + this.passiveWindowMs,
					revision: operation.revision + 1,
					updatedAt: now,
				});
			}
		}
	}

	private pruneStale(now = this.now()): void {
		for (const [operationId, operation] of this.operations.entries()) {
			if (!protectsMutationEvidence(operation) && now - operation.updatedAt > this.ttlMs) this.operations.delete(operationId);
		}
	}

	private pruneToMaxSize(): void {
		if (this.operations.size <= this.maxOperations) return;
		const overflow = this.operations.size - this.maxOperations;
		const oldest = Array.from(this.operations.values())
			.filter((operation) => !protectsMutationEvidence(operation))
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
