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
 * When a strict (additionalProperties:false) object schema rejects an unknown
 * top-level key, name the offending key(s) and list the accepted params so the
 * caller can self-correct instead of guessing what "must not have additional
 * properties" means. Computed directly from the schema/value so it does not
 * depend on the validator's error-message wording.
 */
function describeUnknownProperties(schema: TSchema, value: unknown): string | undefined {
	const s = schema as { additionalProperties?: unknown; properties?: Record<string, unknown> };
	if (s.additionalProperties !== false || !s.properties || typeof value !== "object" || value === null) return undefined;
	const accepted = Object.keys(s.properties);
	const acceptedSet = new Set(accepted);
	const unknown = Object.keys(value as Record<string, unknown>).filter((k) => !acceptedSet.has(k));
	if (!unknown.length) return undefined;
	return `unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}; accepted: ${accepted.join(", ")}`;
}

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
			const detail = errors
				.slice(0, 5)
				.map((e) => {
					const loc = (e as unknown as Record<string, unknown>).instancePath || "/";
					return `${String(loc)}: ${e.message}`;
				})
				.join("; ");
			const unknownNote = describeUnknownProperties(tSchema, converted);
			return { ok: false, error: unknownNote ? `Invalid parameters — ${unknownNote}. ${detail}` : `Invalid parameters — ${detail}` };
		}

		return { ok: true, args: converted as Record<string, unknown> };
	} catch (err) {
		return { ok: false, error: `Parameter validation error: ${String(err)}` };
	}
}
