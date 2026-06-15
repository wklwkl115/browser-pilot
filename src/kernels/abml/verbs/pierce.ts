import type { Entity } from "../entity.js";
import type { AbmlPierceInput, AbmlVerbResult, AbmlVerbSuccess } from "./router.js";
import { normalizeAbmlError } from "../errors.js";

export type AbmlPierceExecutor = (input: AbmlPierceInput) => Promise<{ entities?: Entity[]; data?: Record<string, unknown> }>;

export async function runAbmlPierce(input: AbmlPierceInput, executor?: AbmlPierceExecutor): Promise<AbmlVerbResult> {
	if (!executor) {
		const error = normalizeAbmlError({ code: "BACKEND_UNAVAILABLE", message: "ABML pierce executor is not installed" });
		return { ok: false, verb: "pierce", error, nextActions: error.recovery.nextActions };
	}
	const executed = await executor(input);
	const result: AbmlVerbSuccess = {
		ok: true,
		verb: "pierce",
		...(executed.entities ? { entities: executed.entities } : {}),
		...(executed.data ? { data: executed.data } : {}),
		meta: { depth: input.depth ?? 1, entityCount: executed.entities?.length ?? 0 },
	};
	return result;
}
