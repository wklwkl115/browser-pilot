/** Shared public result contract, also included in daemon compatibility identity. */
export const OPERATION_RESULT_PROPERTIES = {
	operationId: {
		type: "string",
		description: "Correlation ID for status/continued observation; not a website idempotency key.",
	},
	execution: {
		type: "object",
		properties: {
			status: { type: "string", enum: ["not_dispatched", "dispatched_unknown", "returned"] },
			response: { type: "string", enum: ["success", "error"] },
			acknowledged: { type: "boolean" },
			dispatchedAt: { type: "number" },
			returnedAt: { type: "number" },
		},
		required: ["status"],
		additionalProperties: false,
		description:
			"Browser execution receipt. returned is not business success; missing ACK never proves non-delivery.",
	},
	verification: {
		type: "object",
		additionalProperties: true,
		description:
			"The caller's assertion only: verified/unmet/inconclusive. A failure UI can correctly produce verified.",
	},
	business: {
		type: "object",
		properties: {
			status: { type: "string", enum: ["succeeded", "failed", "unknown"] },
			reason: { type: "string" },
			reasonCode: {
				type: "string",
				enum: ["not_declared", "unproven", "conflicting_conditions", "success_observed", "failure_observed"],
			},
			checkedAt: { type: "number" },
			success: { type: "object", additionalProperties: true },
			failure: { type: "object", additionalProperties: true },
		},
		required: ["status", "reason", "reasonCode", "checkedAt"],
		additionalProperties: true,
		description:
			"succeeded/failed only from explicit declared evidence, otherwise unknown. Limited to the declared conditions and observation time.",
	},
	recovery: {
		type: "object",
		additionalProperties: true,
		description: "No automatic write replay; uncertain execution requires observation.",
	},
	evidence: { type: "object", additionalProperties: true },
	continuation: {
		type: "object",
		additionalProperties: true,
		description: "Whether stored declarative conditions can be observed again without executing the write.",
	},
};

export const OPERATION_OUTPUT_SCHEMA = {
	type: "object" as const,
	properties: {
		...OPERATION_RESULT_PROPERTIES,
		verb: { type: "string" },
		createdAt: { type: "number" },
		expiresAt: { type: "number" },
		active: { type: "boolean" },
	},
	required: ["operationId", "execution", "business", "verb", "createdAt", "expiresAt", "active", "recovery"],
	additionalProperties: false,
};
