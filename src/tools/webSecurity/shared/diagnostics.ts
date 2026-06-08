import { createCodedError } from "../../../utils/codedError.js";
import { normalizeError, suppressErrorStack } from "../../../utils/errors.js";
import { redactSensitiveText, redactSensitiveValue } from "../../../utils/redaction.js";

export type WebSecurityErrorEnvelopeConfig = {
	toolName: string;
	command: string;
};

export function redactWebSecurityDiagnosticText(text: string): string {
	return redactSensitiveText(text);
}

export function redactWebSecurityDiagnosticValue(value: unknown): unknown {
	return redactSensitiveValue(value);
}

type WebSecurityToolErrorRecord = Error & { code: string; details: Record<string, unknown> };

export function webSecurityToolError(error: unknown, config: WebSecurityErrorEnvelopeConfig): Error {
	const normalized = normalizeError(error);
	const recovery = normalized.recovery ? redactWebSecurityDiagnosticValue(normalized.recovery) as Record<string, unknown> : undefined;
	return suppressErrorStack(createCodedError({
		name: "WebSecurityToolError",
		code: normalized.code,
		message: redactWebSecurityDiagnosticText(normalized.message),
		details: {
			domain: "webSecurity",
			toolName: config.toolName,
			command: config.command,
			...(recovery ? { recovery } : {}),
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
