import { readFile } from "node:fs/promises";
import { asPositiveInt, normalizeArtifactMode } from "../utils/params.js";
import { MAX_ARTIFACT_READ_BYTES, ArtifactReaderError, type BrowserArtifactContext, type BrowserArtifactParams, type BrowserArtifactReadResult, type ArtifactReaderErrorCode, MAX_ARTIFACT_SEARCH_REGEX_CHARS, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, MAX_MULTI_ARTIFACT_FILES, MAX_MULTI_ARTIFACT_BYTES, MAX_MULTI_ARTIFACT_MATCHES_PER_FILE, MAX_MULTI_ARTIFACT_TOTAL_MATCHES } from "./artifactReaderShared.js";
import { resolveInputPath, statArtifact } from "./artifactReaderPaths.js";
import { redactArtifactResult } from "./artifactReaderRedaction.js";
import { readTextRange, sampleText } from "./artifactReaderTextModes.js";
import { readJson } from "./artifactReaderJson.js";
import { searchMultipleArtifacts, searchText } from "./artifactReaderSearch.js";

export { MAX_ARTIFACT_READ_BYTES, MAX_ARTIFACT_SEARCH_REGEX_CHARS, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, MAX_MULTI_ARTIFACT_FILES, MAX_MULTI_ARTIFACT_BYTES, MAX_MULTI_ARTIFACT_MATCHES_PER_FILE, MAX_MULTI_ARTIFACT_TOTAL_MATCHES, ArtifactReaderError };
export type { BrowserArtifactContext, BrowserArtifactParams, BrowserArtifactReadResult, ArtifactReaderErrorCode };

// Keep the public browser_artifact contract in one facade: infer mode, enforce guards, then delegate to the extracted mode readers.
export async function readBrowserArtifact(params: BrowserArtifactParams, ctx?: BrowserArtifactContext): Promise<BrowserArtifactReadResult> {
	const wantsJson = !!(params.jsonPath || (Array.isArray(params.pick) && params.pick.length));
	const hasQuery = typeof params.query === "string" && params.query.trim() !== "";
	const mode = normalizeArtifactMode(params.mode ?? (wantsJson ? "json" : hasQuery ? "search" : undefined));
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

function multiSearchModeError(mode: string, params: BrowserArtifactParams): ArtifactReaderError {
	return new ArtifactReaderError("ARTIFACT_MULTI_SEARCH_MODE_INVALID", "browser_artifact paths/root/glob are only valid for mode=search", { mode, root: params.root, glob: params.glob, pathCount: Array.isArray(params.paths) ? params.paths.length : 0 });
}

async function readJsonMode(absPath: string, fileSize: number, params: BrowserArtifactParams, redact: boolean, targetedJsonRaw: boolean) {
	if (fileSize > MAX_ARTIFACT_READ_BYTES) throw new ArtifactReaderError("ARTIFACT_TOO_LARGE", `Artifact exceeds byte limit (${fileSize} bytes, max ${MAX_ARTIFACT_READ_BYTES})`, { path: absPath, bytes: fileSize, maxBytes: MAX_ARTIFACT_READ_BYTES });
	const result = readJson(await readFile(absPath, "utf8"), fileSize, absPath, params);
	return redactArtifactResult(result, redact, targetedJsonRaw);
}
