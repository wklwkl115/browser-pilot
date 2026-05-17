import { truncateText } from "../../utils/json";
import { isRecord, type Summary } from "./common";

const SAMPLE_LIMIT = 5;
const KEY_LIMIT = 40;
const STRING_PREVIEW_CHARS = 240;

function compactSample(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		const preview = truncateText(value.replace(/\s+/g, " ").trim(), STRING_PREVIEW_CHARS);
		return preview.truncated ? { type: "string", preview: preview.text, originalLength: preview.originalLength, truncated: true } : value;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return String(value);
	if (depth >= 2) return Array.isArray(value) ? { type: "array", count: value.length } : { type: "object", keyCount: Object.keys(value as Record<string, unknown>).length };
	if (Array.isArray(value)) return { type: "array", count: value.length, samples: value.slice(0, SAMPLE_LIMIT).map((item) => compactSample(item, depth + 1)) };
	const entries = Object.entries(value as Record<string, unknown>);
	const out: Record<string, unknown> = { type: "object", keyCount: entries.length, keys: entries.slice(0, KEY_LIMIT).map(([key]) => key) };
	for (const [key, item] of entries.slice(0, SAMPLE_LIMIT)) out[key] = compactSample(item, depth + 1);
	return out;
}

function summarizePlainValue(value: unknown): Summary {
	if (Array.isArray(value)) return { type: "array", count: value.length, samples: value.slice(0, SAMPLE_LIMIT).map((item) => compactSample(item)) };
	if (!isRecord(value)) return { type: typeof value, value: compactSample(value) };
	return compactSample(value) as Summary;
}

export function summarizeGenericValue(value: unknown): Summary {
	if (isRecord(value) && ("ok" in value || "data" in value || "error_code" in value)) {
		const data = value.data;
		return {
			type: "bridgeResult",
			ok: value.ok,
			error_code: value.error_code,
			message: typeof value.message === "string" ? truncateText(value.message, STRING_PREVIEW_CHARS).text : undefined,
			data: summarizePlainValue(data),
			keys: Object.keys(value).slice(0, KEY_LIMIT),
		};
	}
	return summarizePlainValue(value);
}
