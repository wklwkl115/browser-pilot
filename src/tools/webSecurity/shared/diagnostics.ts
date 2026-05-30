import { createCodedError } from "../../../utils/codedError";
import { normalizeError, suppressErrorStack } from "../../../utils/errors";

export type WebSecurityErrorEnvelopeConfig = {
	toolName: string;
	command: string;
};

export function redactWebSecurityDiagnosticText(text: string): string {
	return text
		.replace(/((?:^|[\r\n])\s*(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-aws-ec2-metadata-token)\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
		.replace(/("(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-aws-ec2-metadata-token|private[_-]?key|token|secret|password|otp|totp)"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"")
		.replace(/((?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-aws-ec2-metadata-token|private[_-]?key|token|secret|password|otp|totp)\s*=\s*)[^;\s,"'}]+/gi, "$1[redacted]")
		.replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [redacted]")
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]");
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
		out[key] = /cookie|authorization|token|secret|password|api[-_]?key|private[_-]?key|otp|totp/.test(lower) ? "[redacted]" : redactWebSecurityDiagnosticValue(item, seen);
	}
	return out;
}

type WebSecurityToolErrorRecord = Error & { code: string; details: Record<string, unknown> };

export function webSecurityToolError(error: unknown, config: WebSecurityErrorEnvelopeConfig): Error {
	const normalized = normalizeError(error);
	return suppressErrorStack(createCodedError({
		name: "WebSecurityToolError",
		code: normalized.code,
		message: redactWebSecurityDiagnosticText(normalized.message),
		details: {
			domain: "webSecurity",
			toolName: config.toolName,
			command: config.command,
			...(normalized.recovery ? { recovery: normalized.recovery } : {}),
			cause: {
				code: normalized.code,
				message: redactWebSecurityDiagnosticText(normalized.message),
				name: normalized.name,
				details: redactWebSecurityDiagnosticValue(normalized.details),
			},
		},
		suppressStack: false,
	}) as WebSecurityToolErrorRecord);
}
