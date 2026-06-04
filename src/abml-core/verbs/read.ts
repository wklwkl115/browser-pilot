import { diffEntities } from "../diff.js";
import type { Entity } from "../entity.js";
import type { RefDescriptor } from "../types.js";
import type { AbmlReadInput, AbmlVerbResult, AbmlVerbSuccess } from "./router.js";
import { normalizeAbmlError } from "../errors.js";

export type AbmlReadResolver = (input: AbmlReadInput) => Promise<{ entities?: Entity[]; data?: Record<string, unknown>; ref?: RefDescriptor | string }>;

export async function runAbmlRead(input: AbmlReadInput, resolver?: AbmlReadResolver): Promise<AbmlVerbResult> {
	if (!resolver) {
		const error = normalizeAbmlError({ code: "BACKEND_UNAVAILABLE", message: "ABML read resolver is not installed" });
		return { ok: false, verb: "read", error, nextActions: error.recovery.nextActions };
	}
	const resolved = await resolver(input);
	const diff = input.baseline && resolved.entities ? diffEntities(input.baseline, resolved.entities) : undefined;
	const result: AbmlVerbSuccess = {
		ok: true,
		verb: "read",
		...(resolved.entities ? { entities: resolved.entities } : {}),
		...(diff ? { diff } : {}),
		...(resolved.data ? { data: resolved.data } : {}),
		meta: {
			plane: input.plane || "structure",
			depth: input.depth,
			entityCount: resolved.entities?.length ?? 0,
		},
	};
	return result;
}
