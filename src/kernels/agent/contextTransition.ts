import { pageReanchorReason, type PageIdentity, type PageReanchorReason } from "../session/pageIdentity.js";
import type { AgentContextRecord, AgentContextState } from "./agentTypes.js";

export type AgentContextTransition = {
	state: AgentContextState;
	revisionDelta: number;
	clearPageBindings: boolean;
	reanchorReason?: PageReanchorReason;
	pageIdentity?: PageIdentity;
};

/**
 * Consume the existing pageReanchorReason decision; do not re-compare URL/tabId/epoch.
 */
export function applyAgentContextIdentityTransition(
	existingContext: Pick<AgentContextRecord, "state" | "pageIdentity" | "revision">,
	currentPageIdentity: PageIdentity | undefined,
	existingReanchorDecision?: PageReanchorReason,
): AgentContextTransition {
	const reason = existingReanchorDecision ?? pageReanchorReason(existingContext.pageIdentity, currentPageIdentity);
	if (!reason) {
		return {
			state: "anchored",
			revisionDelta: 0,
			clearPageBindings: false,
			pageIdentity: currentPageIdentity,
		};
	}
	if (reason === "identity_unproven" || reason === "baseline_missing") {
		return {
			state: currentPageIdentity ? "needs_reanchor" : "expired",
			revisionDelta: 1,
			clearPageBindings: true,
			reanchorReason: reason,
			pageIdentity: currentPageIdentity,
		};
	}
	if (reason === "target_replaced") {
		// Unique replacement is decided by the target lineage owner; ambiguous stays ambiguous.
		return {
			state: "needs_reanchor",
			revisionDelta: 1,
			clearPageBindings: true,
			reanchorReason: reason,
			pageIdentity: currentPageIdentity,
		};
	}
	return {
		state: "needs_reanchor",
		revisionDelta: 1,
		clearPageBindings: true,
		reanchorReason: reason,
		pageIdentity: currentPageIdentity,
	};
}

/** Ghost-state invariant: anchored requires proven matching PageIdentity. */
export function assertAnchoredIdentityInvariant(
	state: AgentContextState,
	contextIdentity: PageIdentity | undefined,
	currentIdentity: PageIdentity | undefined,
): void {
	if (state !== "anchored") return;
	const reason = pageReanchorReason(contextIdentity, currentIdentity);
	if (reason) {
		throw new Error(`ghost state: anchored context has reanchor reason ${reason}`);
	}
}

export function nextRevision(current: number, delta: number): number {
	return current + Math.max(0, delta);
}
