import { truncateText, tryJson } from "../../utils/json.js";
import { isRecord, type Summary } from "./common.js";

const SAMPLE_LIMIT = 5;
const KEY_LIMIT = 40;
const STRING_PREVIEW_CHARS = 240;
// When the WHOLE returned value serializes within this, it is shown VERBATIM in the model-facing
// summary instead of being collapsed to {type,count/keyCount} shape placeholders. This is what lets an
// agent read the small structured value it just returned from browser_execute (and browser_command)
// without a second browser_artifact round-trip — the dominant real-agent friction (F1, n=3 incl. a
// skill-guided run). Larger payloads still collapse to a compact shape (samples stay small) and the
// full value is mirrored to the saved artifact; the downstream summary budget (fitSummaryBudget, ~8k)
// remains the hard size guard, so inlining up to a few KB here is safe.
const INLINE_VALUE_CHARS = 4_000;

// Size-check + JSON round-trip clone in one pass: if `value` serializes within `limit`, return a
// detached clone (never the live bridge-result reference, so downstream redaction can't alias it, and
// any non-JSON members are dropped exactly as JSON.stringify would). Otherwise signal "too big".
function inlineIfSmall(value: unknown, limit: number): { inline: true; value: unknown } | { inline: false } {
	try {
		const json = JSON.stringify(value);
		// tryJson (shared helper, the reviewed JSON.parse root) detaches the clone — never the live
		// bridge-result reference, so downstream redaction can't alias it.
		if (typeof json === "string" && json.length <= limit) return { inline: true, value: tryJson(json) };
	} catch {
		// unserializable (circular/function members) → fall through and summarize as a shape
	}
	return { inline: false };
}

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

function summarizePlainValue(value: unknown): unknown {
	// Whole value small → return it verbatim so the caller sees exactly what it produced. Only genuinely
	// large payloads fall through to the compact, sample-limited shape (with the full value in the artifact).
	const inlined = inlineIfSmall(value, INLINE_VALUE_CHARS);
	if (inlined.inline) return inlined.value;
	if (Array.isArray(value)) return { type: "array", count: value.length, samples: value.slice(0, SAMPLE_LIMIT).map((item) => compactSample(item)) };
	if (!isRecord(value)) return { type: typeof value, value: compactSample(value) };
	return compactSample(value);
}

function bridgeResultMetadata(value: Record<string, unknown>, data: unknown): Summary {
	const payload = isRecord(data) ? data : {};
	const target = isRecord(value.target) ? value.target : {};
	const out: Summary = {};
	for (const key of ["tabId", "frameId", "sessionId", "requestId", "waitId", "listenerId", "count", "total", "nextOffset", "frameCount", "entityCount", "abmlIntegrated"] as const) {
		const item = payload[key] ?? value[key];
		if (item !== undefined) out[key] = item;
	}
	for (const key of ["browserSessionId", "selectionVersionAtDispatch", "selectionVersionAtResolve"] as const) {
		const item = target[key] ?? payload[key] ?? value[key];
		if (item !== undefined) out[key] = item;
	}
	if (target.source !== undefined) out.targetSource = target.source;
	if (target.implicit !== undefined) out.targetImplicit = target.implicit;
	return out;
}

export function summarizeGenericValue(value: unknown): Summary {
	if (isRecord(value) && ("ok" in value || "data" in value || "error_code" in value)) {
		const data = value.data;
		return {
			type: "bridgeResult",
			ok: value.ok,
			error_code: value.error_code,
			message: typeof value.message === "string" ? truncateText(value.message, STRING_PREVIEW_CHARS).text : undefined,
			...bridgeResultMetadata(value, data),
			data: summarizePlainValue(data),
			keys: Object.keys(value).slice(0, KEY_LIMIT),
		};
	}
	// Top-level generic summary must stay a record; carry a verbatim small array/scalar under `value`.
	const top = summarizePlainValue(value);
	return isRecord(top) ? top : { type: Array.isArray(value) ? "array" : typeof value, value: top };
}
