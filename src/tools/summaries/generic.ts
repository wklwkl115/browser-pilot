import { projectJsonValue } from "../../distill-core/projection.js";
import { truncateText, tryJson } from "../../utils/json.js";
import { isRecord, type Summary } from "./common.js";

const KEY_LIMIT = 40;
const STRING_PREVIEW_CHARS = 240;
const MIN_PROJECTED_ARRAY_ITEMS = 10;
const GENERIC_PROJECTION_WINDOW = 5;
const GENERIC_IDENTITY_FIELDS = new Set(["title", "name", "label", "href", "url", "uploader", "author", "owner", "value", "item"]);
// When the WHOLE returned value serializes within this, it is shown VERBATIM in the model-facing
// summary instead of being collapsed to {type,count/keyCount} shape placeholders. This is what lets an
// agent read the small structured value it just returned from browser_execute (and browser_command)
// without a second browser_artifact round-trip — the dominant real-agent friction (F1, n=3 incl. a
// skill-guided run). Larger payloads collapse to projection/shape summaries and the full value is
// mirrored to the saved artifact; the downstream summary budget (fitSummaryBudget, ~8k)
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

function projectionEnabled(): boolean {
	return process.env.PI_BROWSER_JSON_PROJECTION !== "0";
}

function firstItems<T>(items: T[], limit: number): T[] {
	const out: T[] = [];
	for (const item of items) {
		if (out.length >= limit) break;
		out.push(item);
	}
	return out;
}

function appendJsonPath(base: string | undefined, key: string): string | undefined {
	if (!base) return undefined;
	if (/^[A-Za-z_$][\w$]*$/.test(key)) return base === "$" ? key : `${base}.${key}`;
	return `${base}['${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

function valueKind(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

function arrayShape(value: unknown[]): Record<string, unknown> {
	const elementTypes: Record<string, number> = {};
	const objectKeys = new Set<string>();
	for (const item of value) {
		const kind = valueKind(item);
		elementTypes[kind] = (elementTypes[kind] ?? 0) + 1;
		if (isRecord(item) && objectKeys.size < KEY_LIMIT) {
			for (const key of Object.keys(item)) {
				if (objectKeys.size >= KEY_LIMIT) break;
				objectKeys.add(key);
			}
		}
	}
	return {
		type: "array",
		count: value.length,
		elementTypes,
		...(objectKeys.size ? { keys: Array.from(objectKeys) } : {}),
	};
}

function projectionCarriesGenericValue(value: Record<string, unknown>[], fields: string[]): boolean {
	if (fields.length === 0) return false;
	const fieldSet = new Set(fields);
	const hasSelector = value.some((item) => Object.hasOwn(item, "selector"));
	const hasIdentityField = fields.some((field) => GENERIC_IDENTITY_FIELDS.has(field));
	if (hasSelector && !hasIdentityField) return false;
	return fieldSet.size > 0;
}

function compactProjectionRecord(value: Record<string, unknown>, depth: number, jsonPath?: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = compactSample(item, depth, appendJsonPath(jsonPath, key));
	return out;
}

function compactArray(value: unknown[], depth: number, jsonPath?: string): unknown {
	if (value.length === 0) return [];
	if (value.length >= MIN_PROJECTED_ARRAY_ITEMS && projectionEnabled() && value.every(isRecord)) {
		const compacted = value.map((item) => compactProjectionRecord(item, depth + 1, jsonPath));
		const projection = projectJsonValue(compacted, { jsonPath, limit: Math.min(value.length, GENERIC_PROJECTION_WINDOW), maxChars: INLINE_VALUE_CHARS });
		const hasValueBearingFold = projection && (projectionCarriesGenericValue(compacted, projection.fields) || Object.keys(projection.template.exceptions ?? {}).length > 0);
		if (hasValueBearingFold) return projection;
	}
	return arrayShape(value);
}

function compactSample(value: unknown, depth = 0, jsonPath?: string): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") {
		const preview = truncateText(value.replace(/\s+/g, " ").trim(), STRING_PREVIEW_CHARS);
		return preview.truncated ? { type: "string", preview: preview.text, originalLength: preview.originalLength, truncated: true } : value;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "object") return String(value);
	if (depth >= 2) return Array.isArray(value) ? { type: "array", count: value.length } : { type: "object", keyCount: Object.keys(value as Record<string, unknown>).length };
	if (Array.isArray(value)) return compactArray(value, depth, jsonPath);
	const entries = Object.entries(value as Record<string, unknown>);
	const selected = firstItems(entries, KEY_LIMIT);
	const out: Record<string, unknown> = { type: "object", keyCount: entries.length, keys: selected.map(([key]) => key) };
	for (const [key, item] of selected) out[key] = compactSample(item, depth + 1, appendJsonPath(jsonPath, key));
	return out;
}

function summarizePlainValue(value: unknown, jsonPath?: string): unknown {
	// Whole value small → return it verbatim so the caller sees exactly what it produced. Only genuinely
	// large payloads fall through to projection/shape summaries (with the full value in the artifact).
	const inlined = inlineIfSmall(value, INLINE_VALUE_CHARS);
	if (inlined.inline) return inlined.value;
	if (Array.isArray(value)) return compactArray(value, 0, jsonPath);
	if (!isRecord(value)) return { type: typeof value, value: compactSample(value, 0, jsonPath) };
	return compactSample(value, 0, jsonPath);
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
			data: summarizePlainValue(data, "data"),
			keys: firstItems(Object.keys(value), KEY_LIMIT),
		};
	}
	// Top-level generic summary must stay a record; carry a verbatim small array/scalar under `value`.
	const top = summarizePlainValue(value, "$");
	return isRecord(top) ? top : { type: Array.isArray(value) ? "array" : typeof value, value: top };
}
