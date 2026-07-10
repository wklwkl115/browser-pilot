import { readFile } from "node:fs/promises";
import { asPositiveInt, normalizeArtifactMode } from "../utils/params.js";
import { MAX_ARTIFACT_READ_BYTES, ArtifactReaderError, type BrowserArtifactContext, type BrowserArtifactParams, type BrowserArtifactReadResult, type ArtifactReaderErrorCode, MAX_ARTIFACT_SEARCH_REGEX_CHARS, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, MAX_MULTI_ARTIFACT_FILES, MAX_MULTI_ARTIFACT_BYTES, MAX_MULTI_ARTIFACT_MATCHES_PER_FILE, MAX_MULTI_ARTIFACT_TOTAL_MATCHES } from "./artifactReaderShared.js";
import { resolveInputPath, statArtifact } from "./artifactReaderPaths.js";
import { redactArtifactResult } from "./artifactReaderRedaction.js";
import { readTextRange, sampleText } from "./artifactReaderTextModes.js";
import { readJson } from "./artifactReaderJson.js";
import { searchMultipleArtifacts, searchText } from "./artifactReaderSearch.js";
import { getJsonPath, hasJsonPathValue } from "../utils/jsonPath.js";
import { isRecord, pickDefined } from "../utils/records.js";

export { MAX_ARTIFACT_READ_BYTES, MAX_ARTIFACT_SEARCH_REGEX_CHARS, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, MAX_MULTI_ARTIFACT_FILES, MAX_MULTI_ARTIFACT_BYTES, MAX_MULTI_ARTIFACT_MATCHES_PER_FILE, MAX_MULTI_ARTIFACT_TOTAL_MATCHES, ArtifactReaderError };
export type { BrowserArtifactContext, BrowserArtifactParams, BrowserArtifactReadResult, ArtifactReaderErrorCode };

// Keep the public browser_artifact contract in one facade: infer mode, enforce guards, then delegate to the extracted mode readers.
export async function readBrowserArtifact(params: BrowserArtifactParams, ctx?: BrowserArtifactContext): Promise<BrowserArtifactReadResult> {
	const wantsJson = !!(params.jsonPath || (Array.isArray(params.pick) && params.pick.length));
	const hasQuery = typeof params.query === "string" && params.query.trim() !== "";
	const mode = normalizeArtifactMode(params.mode ?? (wantsJson ? "json" : hasQuery ? "search" : undefined));
	if (mode === "inspect" || mode === "paths") return await inspectArtifact(params, ctx, mode);
	if (hasQuery && mode !== "search") throw queryModeError(mode, params.jsonPath);
	const maxChars = asPositiveInt(params.maxChars, 8_000);
	const targetedJsonRaw = mode === "json" && (Boolean(Array.isArray(params.pick) && params.pick.length) || (typeof params.jsonPath === "string" && params.jsonPath.trim() !== "" && params.jsonPath.trim() !== "$"));
	const redact = params.redact !== false && !targetedJsonRaw;
	if (mode !== "search" && (Array.isArray(params.paths) || params.root !== undefined || params.glob !== undefined)) throw multiSearchModeError(mode, params);
	if (mode === "search" && ((Array.isArray(params.paths) && params.paths.length) || params.root !== undefined || params.glob !== undefined)) return redactArtifactResult(await searchMultipleArtifacts(params, ctx), redact);
	const absPath = resolveInputPath(ctx, params.path);
	const info = await statArtifact(absPath, params.path);
	if (mode === "json") return readJsonMode(absPath, info.size, params, redact, targetedJsonRaw);
	const result = mode === "search" ? await searchText(absPath, info.size, params, maxChars) : mode === "sample" ? await sampleText(absPath, info.size, params, maxChars) : await readTextRange(absPath, info.size, params, maxChars);
	return redactArtifactResult(result, redact);
}

function queryModeError(mode: string, jsonPath?: string): ArtifactReaderError {
	return new ArtifactReaderError("ARTIFACT_QUERY_REQUIRES_SEARCH_MODE", "browser_artifact query is only used in mode=search; it is ignored in mode=" + mode, { mode, ...(jsonPath ? { jsonPath } : {}), remediation: "To find text across the artifact run mode=search (a plain, non-regex query windows even a single very long line via contextChars). To window a known value instead, read it with jsonPath + columnOffset/columnLimit." });
}

function compactDescriptor(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const out = pickDefined(value, ["path", "bytes", "chars", "mime"]);
	return Object.keys(out).length ? out : undefined;
}

function compactValueShape(value: unknown): Record<string, unknown> {
	if (Array.isArray(value)) return { type: "array", count: value.length };
	if (isRecord(value)) return { type: "object", keys: Object.keys(value).slice(0, 20), keyCount: Object.keys(value).length };
	return { type: value === null ? "null" : typeof value };
}

function compactSummaryFromArtifact(value: unknown): Record<string, unknown> | undefined {
	const envelope = isRecord(value) && isRecord(value.envelope) ? value.envelope : undefined;
	const summary = isRecord(envelope?.summary) ? envelope.summary : isRecord(value) && isRecord(value.summary) ? value.summary : undefined;
	if (!summary) return undefined;
	const out: Record<string, unknown> = {};
	for (const key of ["type", "ok", "mode", "command", "action", "count", "total", "itemCount", "entryCount", "requestCount", "url", "title", "operationId", "sourceMode"]) if (summary[key] !== undefined) out[key] = summary[key];
	return Object.keys(out).length ? out : compactValueShape(summary);
}

function defaultArtifactHints(value: unknown): { jsonPaths: Record<string, string>; preferredReads: Array<Record<string, unknown>> } {
	const jsonPaths: Record<string, string> = {};
	const preferredReads: Array<Record<string, unknown>> = [];
	const add = (label: string, jsonPath: string, kind?: string) => {
		if (!hasJsonPathValue(value, jsonPath)) return;
		jsonPaths[label] = jsonPath;
		preferredReads.push({ label, jsonPath, ...(kind ? { kind } : {}) });
	};
	for (const [label, jsonPath, kind] of [
		["summary", "summary", "summary"],
		["data", "data", "primary-data"],
		["items", "items", "primary-items"],
		["pages", "pages", "primary-items"],
		["result", "result", "execute-result"],
		["body", "body", "body"],
		["envelope summary", "envelope.summary", "summary"],
		["envelope artifact hints", "envelope.artifact_hints", "artifact-hints"],
	] as Array<[string, string, string]>) add(label, jsonPath, kind);
	return { jsonPaths, preferredReads };
}

function inspectHints(value: unknown, absPath: string): { kind?: string; schemaVersion?: number; saved?: Record<string, unknown>; jsonPaths: Record<string, string>; preferredReads: Array<Record<string, unknown>> } {
	const envelopeHints = isRecord(value) && isRecord(value.envelope) && isRecord(value.envelope.artifact_hints) ? value.envelope.artifact_hints : undefined;
	const directHints = isRecord(value) && isRecord(value.artifact_hints) ? value.artifact_hints : undefined;
	const hints = envelopeHints ?? directHints;
	const defaults = defaultArtifactHints(value);
	const jsonPaths = { ...defaults.jsonPaths };
	const hintedPaths = isRecord(hints?.jsonPaths) ? hints.jsonPaths : {};
	for (const [label, jsonPath] of Object.entries(hintedPaths)) if (typeof jsonPath === "string" && hasJsonPathValue(value, jsonPath)) jsonPaths[label] = jsonPath;
	const preferredReads = [...defaults.preferredReads];
	for (const read of Array.isArray(hints?.preferredReads) ? hints.preferredReads : []) {
		if (!isRecord(read) || typeof read.jsonPath !== "string" || !hasJsonPathValue(value, read.jsonPath) || preferredReads.some((item) => item.jsonPath === read.jsonPath)) continue;
		preferredReads.push({ ...read });
	}
	const saved = compactDescriptor(isRecord(hints?.saved) ? hints.saved : isRecord(value) && isRecord(value.saved) ? value.saved : undefined) ?? { path: absPath };
	return {
		kind: typeof hints?.kind === "string" ? hints.kind : undefined,
		schemaVersion: typeof hints?.schemaVersion === "number" ? hints.schemaVersion : undefined,
		saved,
		jsonPaths,
		preferredReads,
	};
}

function describePath(value: unknown, label: string, jsonPath: string): Record<string, unknown> {
	const target = getJsonPath(value, jsonPath).value;
	return { label, jsonPath, exists: target !== undefined, ...compactValueShape(target) };
}

async function inspectArtifact(params: BrowserArtifactParams, ctx: BrowserArtifactContext, mode: "inspect" | "paths"): Promise<BrowserArtifactReadResult> {
	const absPath = resolveInputPath(ctx, params.path);
	const info = await statArtifact(absPath, params.path);
	if (info.size > MAX_ARTIFACT_READ_BYTES) throw new ArtifactReaderError("ARTIFACT_TOO_LARGE", `Artifact exceeds byte limit (${info.size} bytes, max ${MAX_ARTIFACT_READ_BYTES})`, { path: absPath, bytes: info.size, maxBytes: MAX_ARTIFACT_READ_BYTES });
	const text = await readFile(absPath, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { mode, summary: { path: absPath, bytes: info.size, chars: text.length, json: false }, saved: { path: absPath, bytes: info.size }, jsonPaths: {}, preferredReads: [], pathDescriptions: [], compactSummary: { type: "text", chars: text.length }, malformed: true };
	}
	const hints = inspectHints(value, absPath);
	const pathDescriptions = Object.entries(hints.jsonPaths).map(([label, jsonPath]) => describePath(value, label, jsonPath));
	return { mode, summary: { path: absPath, bytes: info.size, chars: text.length, json: true, pathCount: pathDescriptions.length }, ...hints, pathDescriptions, compactSummary: compactSummaryFromArtifact(value) ?? compactValueShape(value) };
}

function multiSearchModeError(mode: string, params: BrowserArtifactParams): ArtifactReaderError {
	return new ArtifactReaderError("ARTIFACT_MULTI_SEARCH_MODE_INVALID", "browser_artifact paths/root/glob are only valid for mode=search", { mode, root: params.root, glob: params.glob, pathCount: Array.isArray(params.paths) ? params.paths.length : 0 });
}

async function readJsonMode(absPath: string, fileSize: number, params: BrowserArtifactParams, redact: boolean, targetedJsonRaw: boolean) {
	if (fileSize > MAX_ARTIFACT_READ_BYTES) throw new ArtifactReaderError("ARTIFACT_TOO_LARGE", `Artifact exceeds byte limit (${fileSize} bytes, max ${MAX_ARTIFACT_READ_BYTES})`, { path: absPath, bytes: fileSize, maxBytes: MAX_ARTIFACT_READ_BYTES });
	const result = readJson(await readFile(absPath, "utf8"), fileSize, absPath, params);
	return redactArtifactResult(result, redact, targetedJsonRaw);
}
