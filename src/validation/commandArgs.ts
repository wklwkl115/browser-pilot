/**
 * Command parameter validation (TypeBox-based).
 *
 * Replicates the host framework's Value.Convert + Check behavior so callers get
 * the same coercion and rejection semantics without going through CLI/daemon
 * transport.
 */
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

export type CommandValidationResult =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; error: string };

function describeUnknownProperties(schema: TSchema, value: unknown): string | undefined {
	const s = schema as { additionalProperties?: unknown; properties?: Record<string, unknown> };
	if (s.additionalProperties !== false || !s.properties || typeof value !== "object" || value === null) return undefined;
	const accepted = Object.keys(s.properties);
	const acceptedSet = new Set(accepted);
	const unknown = Object.keys(value as Record<string, unknown>).filter((k) => !acceptedSet.has(k));
	if (!unknown.length) return undefined;
	return `unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}; accepted: ${accepted.join(", ")}`;
}

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

export function validateCommandArgs(
	schema: unknown,
	rawArgs: unknown,
): CommandValidationResult {
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
