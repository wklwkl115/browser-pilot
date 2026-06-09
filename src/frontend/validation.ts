/**
 * Tool parameter validation (TypeBox-based).
 *
 * Replicates the Pi framework's Value.Convert + Check behavior so that
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

export type ToolValidationResult =
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
 * When a strict object schema rejects because a REQUIRED top-level key is
 * absent, name the missing key(s) and surface each one's description — which
 * for action tools carries the "One of: …" value list — so the caller can
 * supply it instead of decoding the raw "must have required properties action".
 * Computed from the schema/value, independent of the validator's wording.
 */
function describeMissingRequired(schema: TSchema, value: unknown): string | undefined {
	const s = schema as { required?: unknown; properties?: Record<string, unknown> };
	if (!Array.isArray(s.required) || !s.properties || typeof value !== "object" || value === null) return undefined;
	const present = new Set(Object.keys(value as Record<string, unknown>));
	const missing = (s.required as unknown[]).filter((k): k is string => typeof k === "string" && !present.has(k));
	if (!missing.length) return undefined;
	const named = missing
		.map((k) => {
			const prop = (s.properties as Record<string, unknown>)[k] as { description?: unknown } | undefined;
			const desc = typeof prop?.description === "string" ? prop.description : undefined;
			return desc ? `"${k}" (${desc})` : `"${k}"`;
		})
		.join(", ");
	return `missing required parameter${missing.length > 1 ? "s" : ""} ${named}`;
}

/**
 * Validate and coerce tool arguments against a TypeBox schema.
 *
 * Returns {ok:true, args} with coerced values on success, or
 * {ok:false, error} with a human-readable error message on failure.
 */
export function validateToolArgs(
	schema: unknown,
	rawArgs: unknown,
): ToolValidationResult {
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
			const missingNote = describeMissingRequired(tSchema, converted);
			const friendly = unknownNote ? `${unknownNote}. ${detail}` : missingNote ?? detail;
			return { ok: false, error: `Invalid parameters — ${friendly}` };
		}

		return { ok: true, args: converted as Record<string, unknown> };
	} catch (err) {
		return { ok: false, error: `Parameter validation error: ${String(err)}` };
	}
}
