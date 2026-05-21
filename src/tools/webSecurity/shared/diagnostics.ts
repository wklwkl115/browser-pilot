import { normalizeError, suppressErrorStack } from "../../../utils/errors";

export type WebSecurityErrorEnvelopeConfig = {
	toolName: string;
	command: string;
};

export function redactWebSecurityDiagnosticText(text: string): string {
	return text
		.replace(/((?:^|[\r\n])\s*(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
		.replace(/("(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"")
		.replace(/((?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*=\s*)[^;\s,"'}]+/gi, "$1[redacted]");
}

export function redactWebSecurityDiagnosticValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redactWebSecurityDiagnosticText(value);
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => redactWebSecurityDiagnosticValue(item, seen));
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const lower = key.toLowerCase();
		out[key] = /cookie|authorization|token|secret|password|api[-_]?key/.test(lower) ? "[redacted]" : redactWebSecurityDiagnosticValue(item, seen);
	}
	return out;
}

export function webSecurityToolError(error: unknown, config: WebSecurityErrorEnvelopeConfig): Error {
	const normalized = normalizeError(error);
	const wrapped = new Error(redactWebSecurityDiagnosticText(normalized.message)) as Error & { code?: string; details?: Record<string, unknown> };
	wrapped.name = "WebSecurityToolError";
	wrapped.code = normalized.code;
	wrapped.details = {
		domain: "webSecurity",
		toolName: config.toolName,
		command: config.command,
		cause: {
			code: normalized.code,
			message: redactWebSecurityDiagnosticText(normalized.message),
			name: normalized.name,
			details: redactWebSecurityDiagnosticValue(normalized.details),
		},
	};
	return suppressErrorStack(wrapped);
}
