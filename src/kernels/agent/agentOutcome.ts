import {
	classifyBrowserOperationStatus,
	type BrowserOperationStatus,
} from "../session/browserOperation.js";
import type { AgentAutomaticAction, AgentOutcome } from "./agentTypes.js";

/**
 * Pure façade mapper over the canonical operation classifier.
 * Never invents a second success rule: completed alone is success.
 */
export function mapBrowserOperationToAgentOutcome(
	status: BrowserOperationStatus,
	options: {
		completionSource?: string;
		automaticActionsTaken?: AgentAutomaticAction[];
	} = {},
): AgentOutcome {
	const classified = classifyBrowserOperationStatus(status);
	const replay: AgentOutcome["replay"] = status === "completed" ? "not_needed" : "do_not_retry";
	return {
		classification: classified.classification,
		status,
		completionVerified: classified.completionVerified,
		ok: classified.ok,
		...(options.completionSource ? { completionSource: options.completionSource } : {}),
		...(classified.code ? { code: classified.code } : {}),
		replay,
		automaticActionsTaken: options.automaticActionsTaken ?? [],
	};
}

/** Invariant: non-completed statuses never report success/ok. */
export function assertAgentOutcomeInvariants(outcome: AgentOutcome): void {
	const expected = classifyBrowserOperationStatus(outcome.status);
	if (outcome.classification !== expected.classification
		|| outcome.completionVerified !== expected.completionVerified
		|| outcome.ok !== expected.ok
		|| (expected.code === undefined ? outcome.code !== undefined : outcome.code !== expected.code)) {
		throw new Error(`AgentOutcome drifted from browser-operation/v2 for status ${outcome.status}`);
	}
	if (outcome.status !== "completed" && (outcome.ok || outcome.classification === "success" || outcome.completionVerified)) {
		throw new Error("AgentOutcome must not promote non-completed status to success");
	}
	if (outcome.status === "completed" && outcome.replay !== "not_needed") {
		throw new Error("completed outcome must use replay not_needed");
	}
	if (outcome.status !== "completed" && outcome.replay !== "do_not_retry") {
		throw new Error("non-completed outcome must use do_not_retry");
	}
}
