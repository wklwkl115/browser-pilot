import type { AgentCandidate, AgentDecision, AgentOutcome, AgentReadOption } from "./agentTypes.js";

export function decideAfterView(input: {
	candidates: AgentCandidate[];
	reads?: AgentReadOption[];
	blockedReason?: string;
	needsInputRef?: string;
	confirmationRef?: string;
	confirmationReason?: string;
}): AgentDecision {
	if (input.blockedReason) return { kind: "blocked", reason: input.blockedReason };
	if (input.confirmationRef) {
		return {
			kind: "confirm",
			confirmationRef: input.confirmationRef,
			reason: input.confirmationReason ?? "sensitive_action",
		};
	}
	if (input.needsInputRef) {
		return { kind: "provide_input", candidateRef: input.needsInputRef, inputKind: "text" };
	}
	if (input.candidates.length > 0) {
		return {
			kind: "choose_action",
			candidateRefs: input.candidates.slice(0, 8).map((c) => c.ref),
		};
	}
	if (input.reads && input.reads.length > 0) {
		return { kind: "inspect", readRefs: input.reads.map((r) => r.readRef) };
	}
	return { kind: "assess_goal" };
}

export function decideAfterAct(input: {
	outcome: AgentOutcome;
	candidates?: AgentCandidate[];
	reads?: AgentReadOption[];
	blockedReason?: string;
}): AgentDecision {
	if (input.blockedReason) return { kind: "blocked", reason: input.blockedReason };
	if (input.outcome.status === "completed") {
		// Mechanical success is not business done.
		if (input.candidates && input.candidates.length > 0) {
			return {
				kind: "choose_action",
				candidateRefs: input.candidates.slice(0, 8).map((c) => c.ref),
			};
		}
		return { kind: "assess_goal" };
	}
	if (input.outcome.status === "target_lost" || input.outcome.status === "ambiguous") {
		return decideAfterView({ candidates: input.candidates ?? [], reads: input.reads });
	}
	if (input.reads && input.reads.length > 0) {
		return { kind: "inspect", readRefs: input.reads.map((r) => r.readRef) };
	}
	return { kind: "assess_goal" };
}
