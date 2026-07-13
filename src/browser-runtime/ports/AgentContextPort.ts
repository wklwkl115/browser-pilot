import type {
	AgentCandidateBinding,
	AgentContextRecord,
	AgentContextState,
	AgentReadBinding,
	AgentTargetBinding,
} from "../../kernels/agent/agentTypes.js";
import type { PageIdentity, PageReanchorReason } from "../../kernels/session/pageIdentity.js";

export interface AgentContextPort {
	create(owner: string): AgentContextRecord;
	get(contextRef: string, owner: string): AgentContextRecord | { error: "CONTEXT_EXPIRED" | "CONTEXT_OWNER_MISMATCH" };
	touch(record: AgentContextRecord): void;
	setState(record: AgentContextRecord, state: AgentContextState): void;
	beginMutation(record: AgentContextRecord, operationId: string): { ok: true } | { error: "CONTEXT_BUSY" };
	endMutation(record: AgentContextRecord, nextState?: AgentContextState): void;
	applyIdentity(
		record: AgentContextRecord,
		currentIdentity: PageIdentity | undefined,
		reanchorDecision?: PageReanchorReason,
	): { reanchorReason?: PageReanchorReason; cleared: boolean };
	replaceCandidateBindings(
		record: AgentContextRecord,
		bindings: Array<{ resourceRef: string; role: string; label?: string; actions: AgentCandidateBinding["allowedActions"] }>,
	): Map<string, AgentCandidateBinding>;
	replaceTargetBindings(
		record: AgentContextRecord,
		targets: Array<{ targetLineageRef: string; tabId?: number; title?: string; url?: string }>,
	): Map<string, AgentTargetBinding>;
	bindRead(
		record: AgentContextRecord,
		binding: Omit<AgentReadBinding, "readRef" | "createdAt" | "expiresAt" | "contextRevision"> & { readRef?: string },
	): AgentReadBinding;
	resolveCandidate(record: AgentContextRecord, ref: string): AgentCandidateBinding | { error: "REF_STALE" };
	resolveRead(record: AgentContextRecord, readRef: string): AgentReadBinding | { error: "READ_UNAVAILABLE" };
	resolveTarget(record: AgentContextRecord, tabRef: string): AgentTargetBinding | { error: "REF_STALE" };
	expireAll(): void;
}
