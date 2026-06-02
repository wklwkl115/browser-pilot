import type { VerificationResult } from "../types.js";
import type { AbmlScrollInput, AbmlVerbResult, AbmlVerbSuccess } from "./router.js";
import { verificationFailure } from "./router.js";
import { normalizeAbmlError } from "../errors.js";

export type AbmlScrollExecutor = (input: AbmlScrollInput) => Promise<{ data?: Record<string, unknown>; verification?: VerificationResult; entities?: Array<Record<string, unknown>> }>;

export async function runAbmlScroll(input: AbmlScrollInput, executor?: AbmlScrollExecutor): Promise<AbmlVerbResult> {
	if (!executor) {
		const error = normalizeAbmlError({ code: "BACKEND_UNAVAILABLE", message: "ABML scroll executor is not installed" });
		return { ok: false, verb: "scroll", error, nextActions: error.recovery.nextActions };
	}
	const executed = await executor(input);
	if (executed.verification && executed.verification.status !== "verified") return verificationFailure("scroll", executed.verification);
	const result: AbmlVerbSuccess = {
		ok: true,
		verb: "scroll",
		data: executed.data,
		verification: executed.verification,
		meta: { to: input.to || "next", steps: input.steps ?? 1, entityCount: executed.entities?.length ?? 0 },
	};
	return result;
}
