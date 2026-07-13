/**
 * Safe recovery classification: deny-by-default for mutation replay.
 */

export type DispatchSafetyBoundary =
	| "not_started"
	| "prepared"
	| "sent_unacked"
	| "acked"
	| "terminal";

export type RecoveryAction =
	| "ensure_runtime"
	| "reattach_cdp"
	| "rebind_target"
	| "reanchor_page"
	| "relocate_ref"
	| "retry_read"
	| "expand_verified_evidence"
	| "stop_return_view"
	| "stop_blocked"
	| "observe_only";

export type RecoveryDecision = {
	allow: boolean;
	action: RecoveryAction;
	mutationReplay: boolean;
	reason: string;
};

export function classifyRecovery(input: {
	condition:
		| "daemon_not_started_pre_dispatch"
		| "extension_not_ready_pre_dispatch"
		| "cdp_setup_failure_pre_dispatch"
		| "idempotent_read_transient"
		| "stale_ref_same_identity"
		| "page_identity_changed_pre_dispatch"
		| "unique_target_replacement_pre_dispatch"
		| "target_lineage_ambiguous"
		| "mutation_acked_connection_lost"
		| "completed"
		| "effect_observed"
		| "no_effect"
		| "stalled"
		| "ambiguous"
		| "target_lost"
		| "deadline"
		| "artifact_unavailable";
	dispatchBoundary: DispatchSafetyBoundary;
	notDeliveredProven?: boolean;
}): RecoveryDecision {
	const { condition, dispatchBoundary, notDeliveredProven } = input;

	if (condition === "mutation_acked_connection_lost" || dispatchBoundary === "acked" || dispatchBoundary === "terminal") {
		if (condition === "completed") {
			return { allow: true, action: "observe_only", mutationReplay: false, reason: "post_action_view" };
		}
		return { allow: true, action: "observe_only", mutationReplay: false, reason: "no_mutation_replay_after_ack" };
	}

	if (dispatchBoundary === "sent_unacked" && !notDeliveredProven) {
		return { allow: false, action: "stop_blocked", mutationReplay: false, reason: "delivery_unknown" };
	}

	switch (condition) {
		case "daemon_not_started_pre_dispatch":
		case "extension_not_ready_pre_dispatch":
			return { allow: true, action: "ensure_runtime", mutationReplay: false, reason: condition };
		case "cdp_setup_failure_pre_dispatch":
			return { allow: true, action: "reattach_cdp", mutationReplay: false, reason: condition };
		case "idempotent_read_transient":
			return { allow: true, action: "retry_read", mutationReplay: false, reason: condition };
		case "stale_ref_same_identity":
			return { allow: true, action: "relocate_ref", mutationReplay: false, reason: condition };
		case "page_identity_changed_pre_dispatch":
			return { allow: true, action: "reanchor_page", mutationReplay: false, reason: condition };
		case "unique_target_replacement_pre_dispatch":
			return { allow: true, action: "rebind_target", mutationReplay: false, reason: condition };
		case "target_lineage_ambiguous":
			return { allow: false, action: "stop_blocked", mutationReplay: false, reason: condition };
		case "completed":
		case "effect_observed":
		case "no_effect":
		case "stalled":
		case "ambiguous":
		case "target_lost":
		case "deadline":
			return { allow: true, action: "observe_only", mutationReplay: false, reason: condition };
		case "artifact_unavailable":
			return { allow: true, action: "stop_return_view", mutationReplay: false, reason: condition };
		default:
			return { allow: false, action: "stop_blocked", mutationReplay: false, reason: "unknown_condition" };
	}
}

/** Hard rule: never auto-replay mutations once ACK or delivery is unknown. */
export function mayAutoReplayMutation(boundary: DispatchSafetyBoundary, notDeliveredProven = false): boolean {
	if (boundary === "not_started" || boundary === "prepared") return true;
	if (boundary === "sent_unacked" && notDeliveredProven) return true;
	return false;
}
