import { actionabilitySpecForVerb } from "../actionabilityModel.js";
import type { ActionabilityReport, VerificationResult } from "../types.js";
import type { AbmlClickInput, AbmlVerbResult, AbmlVerbSuccess } from "./router.js";
import { actionabilityFailure, verificationFailure } from "./router.js";
import { normalizeAbmlError } from "../errors.js";

export type AbmlClickExecutor = (input: AbmlClickInput) => Promise<{ data?: Record<string, unknown>; actionability?: ActionabilityReport; verification?: VerificationResult }>;

export async function runAbmlClick(input: AbmlClickInput, executor?: AbmlClickExecutor): Promise<AbmlVerbResult> {
	if (!executor) {
		const error = normalizeAbmlError({ code: "BACKEND_UNAVAILABLE", message: "ABML click executor is not installed" });
		return { ok: false, verb: "click", error, nextActions: error.recovery.nextActions };
	}
	const actionability = input.actionability;
	if (actionability && !actionability.ok) return actionabilityFailure("click", actionability);
	const executed = await executor(input);
	if (executed.actionability && !executed.actionability.ok) return actionabilityFailure("click", executed.actionability);
	if (executed.verification && executed.verification.status !== "verified") return verificationFailure("click", executed.verification);
	const result: AbmlVerbSuccess = {
		ok: true,
		verb: "click",
		data: executed.data,
		actionability: executed.actionability || actionability || {
			ok: true,
			spec: actionabilitySpecForVerb("click"),
			elapsedMs: 0,
			attempts: 0,
			checks: {},
			blockers: [],
		},
		verification: executed.verification,
		meta: { button: input.button || "left", count: input.count ?? 1 },
	};
	return result;
}
