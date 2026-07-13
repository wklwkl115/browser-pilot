import { randomBytes } from "node:crypto";
import {
	type AgentTraceRecord,
	redactTraceRequestSummary,
	traceDescriptorFromRecord,
} from "../../kernels/agent/agentTrace.js";
import type { AgentAutomaticAction } from "../../kernels/agent/agentTypes.js";

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_TRACES = 256;
const MAX_PER_OWNER = 64;

/**
 * Daemon-owned bounded in-memory agent trace store (fail-open consumers).
 */
export class AgentTraceStore {
	private readonly traces = new Map<string, AgentTraceRecord>();
	private nowFn: () => number;
	private forceFailReason: string | undefined;

	constructor(options: { now?: () => number } = {}) {
		this.nowFn = options.now ?? (() => Date.now());
	}

	/** Test/diagnostics: next record() fails open without throwing. */
	forceNextRecordFailure(reason = "trace_store_forced_failure"): void {
		this.forceFailReason = reason;
	}

	record(input: {
		contextRef: string;
		owner: string;
		contextRevisionBefore: number;
		contextRevisionAfter: number;
		requestSummary: Record<string, unknown>;
		compiledPlanSummary?: Record<string, unknown>;
		rawOperationRef?: string;
		rawObservationRef?: string;
		automaticActionsTaken?: AgentAutomaticAction[];
		projectionReport?: AgentTraceRecord["projectionReport"];
		ttlMs?: number;
	}): { ok: true; record: AgentTraceRecord } | { ok: false; reason: string } {
		if (this.forceFailReason) {
			const reason = this.forceFailReason;
			this.forceFailReason = undefined;
			return { ok: false, reason };
		}
		try {
			this.evict();
			const ownerCount = [...this.traces.values()].filter((t) => t.owner === input.owner).length;
			if (ownerCount >= MAX_PER_OWNER || this.traces.size >= MAX_TRACES) {
				this.evictOldest(input.owner);
			}
			const now = this.nowFn();
			const record: AgentTraceRecord = {
				traceRef: `tr_${randomBytes(12).toString("hex")}`,
				contextRef: input.contextRef,
				owner: input.owner,
				contextRevisionBefore: input.contextRevisionBefore,
				contextRevisionAfter: input.contextRevisionAfter,
				requestSummary: redactTraceRequestSummary(input.requestSummary),
				compiledPlanSummary: input.compiledPlanSummary
					? redactTraceRequestSummary(input.compiledPlanSummary)
					: undefined,
				rawOperationRef: input.rawOperationRef,
				rawObservationRef: input.rawObservationRef,
				automaticActionsTaken: input.automaticActionsTaken ?? [],
				projectionReport: input.projectionReport ?? {
					candidatesConsidered: 0,
					candidatesReturned: 0,
					readsBound: 0,
					chars: 0,
					bytes: 0,
					estimatedTokens: 0,
				},
				redaction: { secrets: "stripped", paths: "stripped" },
				createdAt: now,
				expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
			};
			this.traces.set(record.traceRef, record);
			return { ok: true, record };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : "trace_store_failed" };
		}
	}

	get(traceRef: string, owner: string): AgentTraceRecord | undefined {
		this.evict();
		const record = this.traces.get(traceRef);
		if (!record || record.owner !== owner) return undefined;
		if (this.nowFn() > record.expiresAt) {
			this.traces.delete(traceRef);
			return undefined;
		}
		return record;
	}

	descriptor(traceRef: string | undefined, owner: string) {
		if (!traceRef) return traceDescriptorFromRecord(undefined, "trace_not_recorded");
		const record = this.get(traceRef, owner);
		return traceDescriptorFromRecord(record, record ? undefined : "trace_unavailable");
	}

	expireAll(): void {
		this.traces.clear();
	}

	private evict(): void {
		const now = this.nowFn();
		for (const [id, record] of this.traces) {
			if (now > record.expiresAt) this.traces.delete(id);
		}
	}

	private evictOldest(owner: string): void {
		const owned = [...this.traces.entries()]
			.filter(([, t]) => t.owner === owner)
			.sort((a, b) => a[1].createdAt - b[1].createdAt);
		if (owned[0]) this.traces.delete(owned[0][0]);
		else {
			const first = this.traces.keys().next().value;
			if (first) this.traces.delete(first);
		}
	}
}

let activeTrace: AgentTraceStore | undefined;

export function installAgentTraceStore(store: AgentTraceStore): AgentTraceStore {
	activeTrace = store;
	return store;
}

export function getAgentTraceStore(): AgentTraceStore {
	if (!activeTrace) activeTrace = new AgentTraceStore();
	return activeTrace;
}

export function resetAgentTraceStoreForTests(): void {
	activeTrace = undefined;
}
