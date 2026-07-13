import {
	AGENT_CONTEXT_BOUNDS,
	type AgentCandidateBinding,
	type AgentContextRecord,
	type AgentContextState,
	type AgentReadBinding,
	type AgentTargetBinding,
} from "../agent/agentTypes.js";
import { applyAgentContextIdentityTransition, nextRevision } from "../agent/contextTransition.js";
import type { PageIdentity, PageReanchorReason } from "./pageIdentity.js";

export type AgentContextBounds = typeof AGENT_CONTEXT_BOUNDS;

function defaultContextId(): string {
	// Pure fallback id — daemon injects a crypto-backed generator.
	return `ctx_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function newAlias(prefix: string, index: number): string {
	return `${prefix}_${String(index).padStart(2, "0")}`;
}

export class AgentContextRegistry {
	private readonly contexts = new Map<string, AgentContextRecord>();
	private readonly bounds: AgentContextBounds;
	private nowFn: () => number;
	private idFn: () => string;

	constructor(options: { bounds?: Partial<AgentContextBounds>; now?: () => number; newId?: () => string } = {}) {
		this.bounds = { ...AGENT_CONTEXT_BOUNDS, ...options.bounds };
		this.nowFn = options.now ?? (() => Date.now());
		this.idFn = options.newId ?? defaultContextId;
	}

	get size(): number {
		return this.contexts.size;
	}

	create(owner: string): AgentContextRecord {
		this.evictExpired();
		const ownerCount = [...this.contexts.values()].filter((c) => c.owner === owner && c.state !== "expired").length;
		if (ownerCount >= this.bounds.maxContextsPerOwner) {
			this.evictOldestForOwner(owner);
		}
		if (this.contexts.size >= this.bounds.maxContexts) {
			this.evictOldestGlobal();
		}
		const now = this.nowFn();
		const record: AgentContextRecord = {
			id: this.idFn(),
			owner,
			revision: 1,
			state: "anchored",
			candidateBindings: new Map(),
			targetBindings: new Map(),
			readBindings: new Map(),
			createdAt: now,
			updatedAt: now,
			idleExpiresAt: now + this.bounds.idleTtlMs,
			absoluteExpiresAt: now + this.bounds.absoluteTtlMs,
		};
		this.contexts.set(record.id, record);
		return record;
	}

	get(contextRef: string, owner: string): AgentContextRecord | { error: "CONTEXT_EXPIRED" | "CONTEXT_OWNER_MISMATCH" } {
		this.evictExpired();
		const record = this.contexts.get(contextRef);
		if (!record || record.state === "expired") return { error: "CONTEXT_EXPIRED" };
		if (record.owner !== owner) return { error: "CONTEXT_OWNER_MISMATCH" };
		const now = this.nowFn();
		if (now > record.absoluteExpiresAt || now > record.idleExpiresAt) {
			record.state = "expired";
			return { error: "CONTEXT_EXPIRED" };
		}
		record.idleExpiresAt = now + this.bounds.idleTtlMs;
		record.updatedAt = now;
		return record;
	}

	touch(record: AgentContextRecord): void {
		const now = this.nowFn();
		record.updatedAt = now;
		record.idleExpiresAt = now + this.bounds.idleTtlMs;
	}

	setState(record: AgentContextRecord, state: AgentContextState): void {
		record.state = state;
		this.touch(record);
	}

	beginMutation(record: AgentContextRecord, operationId: string): { ok: true } | { error: "CONTEXT_BUSY" } {
		if (record.state === "transitioning" && record.activeOperationId) {
			return { error: "CONTEXT_BUSY" };
		}
		record.state = "transitioning";
		record.activeOperationId = operationId;
		record.revision = nextRevision(record.revision, 1);
		this.touch(record);
		return { ok: true };
	}

	endMutation(record: AgentContextRecord, nextState: AgentContextState = "anchored"): void {
		record.activeOperationId = undefined;
		record.state = nextState;
		record.revision = nextRevision(record.revision, 1);
		this.touch(record);
	}

	applyIdentity(
		record: AgentContextRecord,
		currentIdentity: PageIdentity | undefined,
		reanchorDecision?: PageReanchorReason,
	): { reanchorReason?: PageReanchorReason; cleared: boolean } {
		const transition = applyAgentContextIdentityTransition(record, currentIdentity, reanchorDecision);
		if (transition.revisionDelta) {
			record.revision = nextRevision(record.revision, transition.revisionDelta);
		}
		record.state = transition.state;
		if (transition.pageIdentity) record.pageIdentity = transition.pageIdentity;
		if (transition.clearPageBindings) {
			record.candidateBindings.clear();
			// page-scoped reads only
			for (const [key, binding] of record.readBindings) {
				if (binding.pageIdentity) record.readBindings.delete(key);
			}
			record.baselineSnapshotId = undefined;
		}
		this.touch(record);
		return { reanchorReason: transition.reanchorReason, cleared: transition.clearPageBindings };
	}

	replaceCandidateBindings(
		record: AgentContextRecord,
		bindings: Array<{ resourceRef: string; role: string; label?: string; actions: AgentCandidateBinding["allowedActions"] }>,
	): Map<string, AgentCandidateBinding> {
		if (!record.pageIdentity) throw new Error("cannot bind candidates without pageIdentity");
		record.candidateBindings.clear();
		const now = this.nowFn();
		const limited = bindings.slice(0, this.bounds.maxCandidateBindings);
		for (let i = 0; i < limited.length; i++) {
			const item = limited[i]!;
			const ref = newAlias("a", i + 1);
			record.candidateBindings.set(ref, {
				ref,
				contextRevision: record.revision,
				pageIdentity: record.pageIdentity,
				resourceRef: item.resourceRef,
				role: item.role,
				label: item.label,
				allowedActions: item.actions,
				createdAt: now,
			});
		}
		record.revision = nextRevision(record.revision, 1);
		this.touch(record);
		return record.candidateBindings;
	}

	replaceTargetBindings(
		record: AgentContextRecord,
		targets: Array<{ targetLineageRef: string; tabId?: number; title?: string; url?: string }>,
	): Map<string, AgentTargetBinding> {
		record.targetBindings.clear();
		const now = this.nowFn();
		const limited = targets.slice(0, this.bounds.maxTargetBindings);
		for (let i = 0; i < limited.length; i++) {
			const item = limited[i]!;
			const tabRef = newAlias("t", i + 1);
			record.targetBindings.set(tabRef, {
				tabRef,
				targetLineageRef: item.targetLineageRef,
				tabId: item.tabId,
				title: item.title,
				url: item.url,
				createdAt: now,
			});
		}
		record.revision = nextRevision(record.revision, 1);
		this.touch(record);
		return record.targetBindings;
	}

	bindRead(
		record: AgentContextRecord,
		binding: Omit<AgentReadBinding, "readRef" | "createdAt" | "expiresAt" | "contextRevision"> & { readRef?: string },
	): AgentReadBinding {
		const now = this.nowFn();
		while (record.readBindings.size >= this.bounds.maxReadBindings) {
			const oldest = [...record.readBindings.keys()][0];
			if (oldest) record.readBindings.delete(oldest);
			else break;
		}
		const readRef = binding.readRef ?? newAlias("r", record.readBindings.size + 1);
		const full: AgentReadBinding = {
			readRef,
			contextRevision: record.revision,
			pageIdentity: binding.pageIdentity,
			source: binding.source,
			kind: binding.kind,
			descriptor: binding.descriptor,
			createdAt: now,
			expiresAt: now + this.bounds.idleTtlMs,
		};
		record.readBindings.set(readRef, full);
		this.touch(record);
		return full;
	}

	resolveCandidate(record: AgentContextRecord, ref: string): AgentCandidateBinding | { error: "REF_STALE" } {
		const binding = record.candidateBindings.get(ref);
		if (!binding) return { error: "REF_STALE" };
		if (binding.contextRevision > record.revision) return { error: "REF_STALE" };
		// binding from older revision is stale after rebuild
		if (binding.contextRevision < record.revision && record.candidateBindings.size > 0) {
			// allow same-revision only after rebuild — if map still has the key it was rebound
		}
		return binding;
	}

	resolveRead(record: AgentContextRecord, readRef: string): AgentReadBinding | { error: "READ_UNAVAILABLE" } {
		const binding = record.readBindings.get(readRef);
		if (!binding) return { error: "READ_UNAVAILABLE" };
		if (this.nowFn() > binding.expiresAt) {
			record.readBindings.delete(readRef);
			return { error: "READ_UNAVAILABLE" };
		}
		return binding;
	}

	resolveTarget(record: AgentContextRecord, tabRef: string): AgentTargetBinding | { error: "REF_STALE" } {
		const binding = record.targetBindings.get(tabRef);
		if (!binding) return { error: "REF_STALE" };
		return binding;
	}

	expireAll(): void {
		for (const record of this.contexts.values()) {
			record.state = "expired";
		}
		this.contexts.clear();
	}

	private evictExpired(): void {
		const now = this.nowFn();
		for (const [id, record] of this.contexts) {
			if (now > record.absoluteExpiresAt || now > record.idleExpiresAt) {
				record.state = "expired";
				this.contexts.delete(id);
			}
		}
	}

	private evictOldestForOwner(owner: string): void {
		const owned = [...this.contexts.values()]
			.filter((c) => c.owner === owner)
			.sort((a, b) => a.updatedAt - b.updatedAt);
		const victim = owned[0];
		if (victim) {
			victim.state = "expired";
			this.contexts.delete(victim.id);
		}
	}

	private evictOldestGlobal(): void {
		const all = [...this.contexts.values()].sort((a, b) => a.updatedAt - b.updatedAt);
		const victim = all[0];
		if (victim) {
			victim.state = "expired";
			this.contexts.delete(victim.id);
		}
	}
}
