import { actionabilitySpecForVerb } from "../actionabilityModel.js";
import type { EntityDiff } from "../diff.js";
import type { ActionabilityReport, VerificationResult } from "../types.js";
import type { AbmlTypeInput, AbmlVerbResult, AbmlVerbSuccess } from "./router.js";
import { actionabilityFailure, verificationFailure } from "./router.js";
import { normalizeAbmlError } from "../errors.js";

export type AbmlTypeExecutor = (input: AbmlTypeInput) => Promise<{ data?: Record<string, unknown>; actionability?: ActionabilityReport; verification?: VerificationResult; diff?: EntityDiff }>;

export async function runAbmlType(input: AbmlTypeInput, executor?: AbmlTypeExecutor): Promise<AbmlVerbResult> {
	if (!executor) {
		const error = normalizeAbmlError({ code: "BACKEND_UNAVAILABLE", message: "ABML type executor is not installed" });
		return { ok: false, verb: "type", error, nextActions: error.recovery.nextActions };
	}
	const actionability = input.actionability;
	if (actionability && !actionability.ok) return actionabilityFailure("type", actionability);
	const executed = await executor(input);
	if (executed.actionability && !executed.actionability.ok) return actionabilityFailure("type", executed.actionability);
	if (executed.verification && executed.verification.status !== "verified") return verificationFailure("type", executed.verification);
	const result: AbmlVerbSuccess = {
		ok: true,
		verb: "type",
		data: executed.data,
		...(executed.diff ? { diff: executed.diff } : {}),
		actionability: executed.actionability || actionability || {
			ok: true,
			spec: actionabilitySpecForVerb("type"),
			elapsedMs: 0,
			attempts: 0,
			checks: {},
			blockers: [],
		},
		verification: executed.verification,
		meta: { textLength: input.text.length, clear: input.clear === true },
	};
	return result;
}
