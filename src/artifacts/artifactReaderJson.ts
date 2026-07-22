import { stableJson, tryJson } from "../utils/json.js";
import { getJsonPath, parseJsonPath, type JsonPathToken } from "../utils/jsonPath.js";
import { projectJsonValue } from "../kernels/evidence/distill/projection.js";
import { ArtifactReaderError, type BrowserArtifactParams } from "./artifactReaderShared.js";
import { positiveIntParam } from "./artifactReaderLineUtils.js";

const JSON_INLINE_STRING_CHARS = 800;
const JSON_STRING_WINDOW_MAX_CHARS = 100_000;
const JSON_READ_MAX_CHARS = 8_000;

function jsonStringWindow(value: string, params: BrowserArtifactParams): unknown {
	if (params.offset === undefined && params.limit === undefined && value.length <= JSON_INLINE_STRING_CHARS) return value;
	const offset = Math.max(0, Math.min(value.length, Math.floor(Number(params.offset || 0))));
	const limit = positiveIntParam(params.limit, JSON_READ_MAX_CHARS, 1, JSON_STRING_WINDOW_MAX_CHARS);
	const end = Math.max(offset, Math.min(value.length, offset + limit));
	return { type: "string", text: value.slice(offset, end), offset, limit, nextOffset: end < value.length ? end : null, originalLength: value.length, truncated: end < value.length || offset > 0, truncatedBefore: offset > 0, truncatedAfter: end < value.length };
}

function compactJsonValue(value: unknown, params: BrowserArtifactParams, depth = 0): unknown {
	const limit = Math.max(1, Math.floor(Number(params.limit || 40)));
	const offset = Math.max(0, Math.floor(Number(params.offset || 0)));
	if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "string") return value.length > JSON_INLINE_STRING_CHARS ? { preview: value.slice(0, JSON_INLINE_STRING_CHARS), originalLength: value.length, truncated: true } : value;
	if (typeof value !== "object") return String(value);
	if (depth >= 5) return "[MaxDepth]";
	if (Array.isArray(value)) return value.length === 0 ? [] : { type: "array", count: value.length, offset, limit, nextOffset: offset + limit < value.length ? offset + limit : null, items: value.slice(offset, offset + limit).map((item) => compactJsonValue(item, params, depth + 1)) };
	const entries = Object.entries(value as Record<string, unknown>);
	const out: Record<string, unknown> = {};
	for (const [key, item] of entries.slice(0, limit)) out[key] = compactJsonValue(item, params, depth + 1);
	if (entries.length > limit) out.truncatedKeys = entries.length - limit;
	return out;
}

function compactJsonValueForArtifact(value: unknown, params: BrowserArtifactParams, jsonPath?: string): unknown {
	const compact = compactJsonValue(value, params);
	if (typeof value === "string") return compact;
	const projection = projectJsonValue(value, { jsonPath, offset: params.offset, limit: params.limit, maxChars: JSON_READ_MAX_CHARS });
	if (!projection) return compact;
	const offset = Math.max(0, Math.floor(Number(params.offset || 0)));
	const limit = Math.max(1, Math.floor(Number(params.limit ?? (Array.isArray(value) ? Math.max(1, value.length - offset) : 40))));
	const baseline = Array.isArray(value) ? stableJson({ type: "array", count: value.length, offset, limit, nextOffset: offset + limit < value.length ? offset + limit : null, items: value.slice(offset, offset + limit) }).length : Number.POSITIVE_INFINITY;
	return stableJson(projection).length < baseline ? projection : compact;
}

function formatJsonPath(tokens: JsonPathToken[]): string {
	if (!tokens.length) return "$";
	return tokens.map((token, index) => typeof token === "number" ? `[${token}]` : /^[A-Za-z_$][\w$]*$/.test(token) ? (index === 0 ? token : `.${token}`) : `['${token.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`).join("");
}

function jsonValueType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}

function nearestJsonPathInfo(root: unknown, jsonPath: string): Record<string, unknown> {
	const tokens = parseJsonPath(jsonPath);
	for (let length = tokens.length; length >= 0; length -= 1) {
		const path = formatJsonPath(tokens.slice(0, length));
		const selected = getJsonPath(root, path);
		if (!selected.exists) continue;
		const nearestKeys = selected.value && typeof selected.value === "object" ? Object.keys(selected.value).slice(0, 40) : undefined;
		return { nearestPath: path, nearestType: jsonValueType(selected.value), ...(nearestKeys ? { nearestKeys } : {}) };
	}
	return {};
}

function missingJsonPathValue(root: unknown, jsonPath: string): Record<string, unknown> {
	return { exists: false, notFound: true, jsonPath, ...nearestJsonPathInfo(root, jsonPath), value: null };
}

function extractArtifactCorrelation(value: unknown): { correlation?: Record<string, unknown>; correlationPaths?: Record<string, string> } {
	if (!value || typeof value !== "object") return {};
	const pathCandidates: Record<string, string[]> = { operationId: ["operation.operationId", "correlation.operationId", "operationId"], snapshotId: ["snapshot.snapshotId", "correlation.snapshotId", "snapshotId"], browserSessionId: ["target.browserSessionId", "browserSessionId", "data.browserSessionId"], sessionId: ["data.sessionId", "sessionId", "data.session_id", "session_id"], requestId: ["data.requestId", "requestId", "data.request_id", "request_id"], waitId: ["data.waitId", "waitId", "data.wait_id", "wait_id"], listenerId: ["data.listenerId", "listenerId", "data.listener_id", "listener_id"], selectionVersionAtDispatch: ["target.selectionVersionAtDispatch", "selectionVersionAtDispatch"], selectionVersionAtResolve: ["target.selectionVersionAtResolve", "selectionVersionAtResolve"], sourceMode: ["data.sourceMode", "sourceMode"], targetSource: ["target.source", "targetSource"], targetImplicit: ["target.implicit", "targetImplicit"] };
	const correlation: Record<string, unknown> = {};
	const correlationPaths: Record<string, string> = {};
	for (const [key, candidates] of Object.entries(pathCandidates)) for (const jsonPath of candidates) {
		const selected = getJsonPath(value, jsonPath);
		if (!selected.exists || selected.value === undefined || selected.value === null || selected.value === "") continue;
		correlation[key] = selected.value;
		correlationPaths[key] = jsonPath;
		break;
	}
	return Object.keys(correlation).length ? { correlation, correlationPaths } : {};
}

function summarizeJsonValue(value: unknown, absPath: string, fileSize: number): Record<string, unknown> {
	const correlation = extractArtifactCorrelation(value);
	if (Array.isArray(value)) return { path: absPath, bytes: fileSize, type: "array", count: value.length, ...correlation };
	if (value && typeof value === "object") return { path: absPath, bytes: fileSize, type: "object", keyCount: Object.keys(value).length, keys: Object.keys(value).slice(0, 40), ...correlation };
	return { path: absPath, bytes: fileSize, type: typeof value, ...correlation };
}

export function readJson(text: string, fileSize: number, absPath: string, params: BrowserArtifactParams) {
	const parsed = tryJson(text);
	if (parsed === undefined) throw new ArtifactReaderError("ARTIFACT_JSON_INVALID", "Artifact JSON content is invalid", { path: absPath, bytes: fileSize });
	if (Array.isArray(params.pick) && params.pick.length) return readPickedJson(parsed, fileSize, absPath, params);
	const jsonPath = params.jsonPath || "$";
	const selected = getJsonPath(parsed, jsonPath);
	if (!selected.exists) return missingJsonRead(parsed, fileSize, absPath, jsonPath);
	const value = typeof selected.value === "string" ? jsonStringWindow(selected.value, params) : compactJsonValueForArtifact(selected.value, params, jsonPath);
	return { mode: "json" as const, summary: { ...summarizeJsonValue(selected.value, absPath, fileSize), exists: true, jsonPath }, jsonPath, value };
}

function readPickedJson(parsed: unknown, fileSize: number, absPath: string, params: BrowserArtifactParams) {
	const entries = params.pick!.map((item) => {
		const selected = getJsonPath(parsed, item);
		return [item, selected.exists ? { exists: true, jsonPath: item, value: compactJsonValueForArtifact(selected.value, params, item) } : missingJsonPathValue(parsed, item)];
	});
	const value = Object.fromEntries(entries);
	const missingCount = Object.values(value).filter((item) => (item as { exists?: boolean }).exists === false).length;
	return { mode: "json" as const, summary: { path: absPath, bytes: fileSize, type: "object", keyCount: Object.keys(value).length, keys: Object.keys(value).slice(0, 40), picked: true, missingCount }, pick: params.pick, value };
}

function missingJsonRead(parsed: unknown, fileSize: number, absPath: string, jsonPath: string) {
	const value = missingJsonPathValue(parsed, jsonPath);
	return { mode: "json" as const, summary: { path: absPath, bytes: fileSize, type: "missing", exists: false, notFound: true, jsonPath, ...(typeof value.nearestPath === "string" ? { nearestPath: value.nearestPath } : {}), ...(typeof value.nearestType === "string" ? { nearestType: value.nearestType } : {}), ...(Array.isArray(value.nearestKeys) ? { nearestKeys: value.nearestKeys } : {}) }, jsonPath, value };
}
