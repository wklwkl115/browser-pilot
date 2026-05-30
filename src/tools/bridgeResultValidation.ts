import { createCodedError } from "../utils/codedError";
import { suppressErrorStack } from "../utils/errors";
import { recordValue } from "../utils/records";

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
	const error = createCodedError({
		name: "BrowserCommandError",
		code,
		message,
		details: withoutStackDetails({ command, ...nestedDetails, ...rawDetails }) as Record<string, unknown>,
		suppressStack: false,
	});
	suppressErrorStack(error);
	throw error;
}
