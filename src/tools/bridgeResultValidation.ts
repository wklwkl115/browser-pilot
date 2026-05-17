function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function withoutStackDetails(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutStackDetails);
	const record = recordValue(value);
	if (!record) return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		if (key.toLowerCase() === "stack") continue;
		out[key] = withoutStackDetails(item);
	}
	return out;
}

export function assertBridgeCommandSucceeded(result: { data?: unknown }, command: string): void {
	const data = recordValue(result.data);
	if (!data || data.ok !== false) return;
	const nestedError = recordValue(data.error);
	const rawDetails = recordValue(data.details) || {};
	const nestedDetails = recordValue(nestedError?.details) || {};
	const code = typeof data.error_code === "string" && data.error_code ? data.error_code
		: typeof nestedError?.code === "string" && nestedError.code ? nestedError.code
			: "BROWSER_COMMAND_FAILED";
	const message = typeof nestedError?.message === "string" && nestedError.message ? nestedError.message
		: typeof data.error === "string" && data.error ? data.error
			: typeof data.message === "string" && data.message ? data.message
				: `${command} failed`;
	const error = new Error(message) as Error & { code?: string; details?: Record<string, unknown> };
	error.name = "BrowserCommandError";
	error.code = code;
	error.details = withoutStackDetails({ command, ...nestedDetails, ...rawDetails }) as Record<string, unknown>;
	delete error.stack;
	throw error;
}
