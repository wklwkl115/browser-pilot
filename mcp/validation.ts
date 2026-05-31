/**
 * MCP-layer TypeBox parameter validation.
 *
 * Replicates the Pi framework's Value.Convert + Check behavior so that MCP
 * callers get the same coercion and rejection semantics without going through
 * the Pi plugin host.
 *
 * Behavior contract (must match check-mcp-parameter-contract):
 * - String-encoded scalars ("true" → boolean, "30" → number) are coerced.
 * - Unknown top-level keys are rejected when additionalProperties:false.
 * - Invalid literal-union (enum) values are rejected.
 * - No schema → args pass through as-is.
 */
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

export type McpValidationResult =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; error: string };

/**
 * Validate and coerce MCP tool arguments against a TypeBox schema.
 *
 * Returns {ok:true, args} with coerced values on success, or
 * {ok:false, error} with a human-readable error message on failure.
 */
export function validateMcpToolArgs(
	schema: unknown,
	rawArgs: unknown,
): McpValidationResult {
	if (!schema || typeof schema !== "object") {
		return { ok: true, args: (rawArgs as Record<string, unknown>) ?? {} };
	}

	const tSchema = schema as TSchema;
	const base = rawArgs != null && typeof rawArgs === "object" ? rawArgs : {};

	try {
		const converted = Value.Convert(tSchema, structuredClone(base));

		if (!Value.Check(tSchema, converted)) {
			const errors = [...Value.Errors(tSchema, converted)];
			const message = errors
				.slice(0, 5)
				.map((e) => {
					const loc = (e as unknown as Record<string, unknown>).instancePath || "/";
					return `${String(loc)}: ${e.message}`;
				})
				.join("; ");
			return { ok: false, error: `Invalid parameters — ${message}` };
		}

		return { ok: true, args: converted as Record<string, unknown> };
	} catch (err) {
		return { ok: false, error: `Parameter validation error: ${String(err)}` };
	}
}
