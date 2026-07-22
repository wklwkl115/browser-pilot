import { compactError } from "./errors.js";
import { stableJson } from "./json.js";
import { redactSensitiveValue } from "./redaction.js";

export type BrowserTextCommandResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
};

function normalizeDetails(details: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(stableJson(redactSensitiveValue(details))) as Record<string, unknown>;
}

export function jsonResult(value: unknown, details: Record<string, unknown> = {}): BrowserTextCommandResult {
	return {
		content: [{ type: "text", text: stableJson(value) }],
		details: normalizeDetails(details),
	};
}

export function errorResult(error: unknown): BrowserTextCommandResult {
	const normalized = compactError(error);
	return {
		content: [{ type: "text", text: stableJson(normalized) }],
		details: normalizeDetails({ error: normalized }),
		isError: true,
	};
}
