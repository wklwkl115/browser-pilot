import { compactError } from "./errors.js";
import { jsonPreview, stableJson, truncateText } from "./json.js";
import { redactSensitiveValue } from "./redaction.js";

export type PiTextToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

const DETAIL_MAX_STRING_CHARS = 800;
const DETAIL_STRING_PREVIEW_CHARS = 240;
const DETAIL_MAX_ARRAY_ITEMS = 12;
const DETAIL_MAX_OBJECT_KEYS = 80;
const DETAIL_MAX_DEPTH = 6;

function compactDetailsValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		if (value.length <= DETAIL_MAX_STRING_CHARS) return value;
		return {
			preview: truncateText(value, DETAIL_STRING_PREVIEW_CHARS).text,
			originalLength: value.length,
			omittedChars: value.length - DETAIL_STRING_PREVIEW_CHARS,
			truncated: true,
		};
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value !== "object") return String(value);
	if (value instanceof Error) return {
		name: value.name,
		message: compactDetailsValue(value.message, depth + 1, seen),
	};
	if (seen.has(value)) return "[Circular]";
	if (depth >= DETAIL_MAX_DEPTH) return "[MaxDepth]";
	seen.add(value);
	if (Array.isArray(value)) {
		const items = value.slice(0, DETAIL_MAX_ARRAY_ITEMS).map((item) => compactDetailsValue(item, depth + 1, seen));
		if (value.length > DETAIL_MAX_ARRAY_ITEMS) items.push({ truncatedItems: value.length - DETAIL_MAX_ARRAY_ITEMS });
		return items;
	}
	const out: Record<string, unknown> = {};
	const entries = Object.entries(value as Record<string, unknown>);
	for (const [key, item] of entries.slice(0, DETAIL_MAX_OBJECT_KEYS)) out[key] = compactDetailsValue(item, depth + 1, seen);
	if (entries.length > DETAIL_MAX_OBJECT_KEYS) out.truncatedKeys = entries.length - DETAIL_MAX_OBJECT_KEYS;
	return out;
}

function compactDetails(details: Record<string, unknown>): Record<string, unknown> {
	return compactDetailsValue(redactSensitiveValue(details), 0, new WeakSet()) as Record<string, unknown>;
}

export function textResult(text: string, details: Record<string, unknown> = {}, maxChars = 50_000): PiTextToolResult {
	const preview = truncateText(text, maxChars);
	return {
		content: [{ type: "text", text: preview.text }],
		details: compactDetails({ ...details, truncated: preview.truncated, originalLength: preview.originalLength }),
	};
}

export function jsonResult(value: unknown, details: Record<string, unknown> = {}, maxChars = 50_000): PiTextToolResult {
	const preview = jsonPreview(value, maxChars);
	return {
		content: [{ type: "text", text: preview.text }],
		details: compactDetails({ ...details, truncated: preview.truncated, originalLength: preview.originalLength }),
	};
}

export function errorResult(error: unknown): PiTextToolResult {
	const normalized = compactError(error);
	return {
		content: [{ type: "text", text: stableJson(normalized) }],
		details: compactDetails({ error: normalized }),
	};
}
