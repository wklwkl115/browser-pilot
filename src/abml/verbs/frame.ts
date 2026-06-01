import type { Entity } from "../entity.js";
import type { AbmlFrameInput, AbmlVerbResult, AbmlVerbSuccess } from "./router.js";
import { normalizeAbmlError } from "../errors.js";

export type AbmlFrameExecutor = (input: AbmlFrameInput) => Promise<{ entities?: Entity[]; data?: Record<string, unknown> }>;

export async function runAbmlFrame(input: AbmlFrameInput, executor?: AbmlFrameExecutor): Promise<AbmlVerbResult> {
	if (!executor) {
		const error = normalizeAbmlError({ code: "BACKEND_UNAVAILABLE", message: "ABML frame executor is not installed" });
		return { ok: false, verb: "frame", error, nextActions: error.recovery.nextActions };
	}
	const executed = await executor(input);
	const result: AbmlVerbSuccess = {
		ok: true,
		verb: "frame",
		...(executed.entities ? { entities: executed.entities } : {}),
		...(executed.data ? { data: executed.data } : {}),
		meta: { depth: input.depth ?? 1, entityCount: executed.entities?.length ?? 0, abmlIntegrated: true },
	};
	return result;
}
