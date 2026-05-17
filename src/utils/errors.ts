export type NormalizedError = {
	code: string;
	message: string;
	details: Record<string, unknown>;
	name?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripStackFields(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => stripStackFields(item, seen));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (key.toLowerCase() === "stack") continue;
		out[key] = stripStackFields(item, seen);
	}
	return out;
}

function cleanDetails(value: unknown): Record<string, unknown> {
	return isRecord(value) ? stripStackFields(value) as Record<string, unknown> : {};
}

export function normalizeError(error: unknown, fallbackCode = "INTERNAL_ERROR"): NormalizedError {
	if (error instanceof Error) {
		const extra = error as Error & { code?: unknown; details?: unknown };
		const code = typeof extra.code === "string" && extra.code.trim() ? extra.code : fallbackCode;
		return {
			code,
			message: error.message || code,
			details: cleanDetails(extra.details),
			name: error.name || "Error",
		};
	}
	if (isRecord(error)) {
		const code = typeof error.code === "string" && error.code.trim() ? error.code : fallbackCode;
		const message = typeof error.message === "string" ? error.message : typeof error.error === "string" ? error.error : String(code);
		return { code, message, details: cleanDetails(error.details), name: typeof error.name === "string" ? error.name : undefined };
	}
	return { code: fallbackCode, message: String(error), details: {}, name: "Error" };
}

export function compactError(error: unknown, fallbackCode = "INTERNAL_ERROR"): Record<string, unknown> {
	const normalized = normalizeError(error, fallbackCode);
	return {
		code: normalized.code,
		message: normalized.message,
		details: normalized.details,
		name: normalized.name,
	};
}
