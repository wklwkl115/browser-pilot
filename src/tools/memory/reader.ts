import { readFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactReaderError } from "../artifactReader.js";
import { computeEtag } from "../../utils/fileFreshness.js";
import { createCodedError } from "../../utils/codedError.js";
import { getJsonPath } from "../../utils/jsonPath.js";
import { parseMemoryEntry } from "./frontmatter.js";
import { normalizeMemoryEntryId } from "./ids.js";
import { readMemoryIndex } from "./indexStore.js";
import { memoryEntryDir, resolveMemoryPath } from "./paths.js";
import type { MemoryEntry, MemoryReadMode, MemoryReadResult } from "./types.js";

function parseBrowserMemoryUri(uri: string): { kind: "index" | "sop" | "fact"; id?: string; etag?: string } | undefined {
	const prefix = "browser-memory://";
	if (!uri.startsWith(prefix)) return undefined;
	const [pathPart, queryPart] = uri.slice(prefix.length).split("?");
	const query = new URLSearchParams(queryPart || "");
	if (pathPart === "index") return { kind: "index", etag: query.get("etag") || undefined };
	const [kind, id] = pathPart.split("/");
	if ((kind === "sop" || kind === "fact") && id) return { kind, id: normalizeMemoryEntryId(id), etag: query.get("etag") || undefined };
	return undefined;
}

async function loadEntryById(cwd: string | undefined, id: string, kind?: "sop" | "fact"): Promise<{ entry: MemoryEntry; absPath: string }> {
	const safeId = normalizeMemoryEntryId(id);
	const dirs = kind ? [memoryEntryDir(kind)] : ["sop", "facts"] as const;
	for (const dir of dirs) {
		const abs = resolveMemoryPath(cwd, dir, `${safeId}.md`);
		try {
			const text = await readFile(abs, "utf8");
			const rel = path.relative(resolveMemoryPath(cwd), abs).replace(/\\/g, "/");
			const entry = parseMemoryEntry(text, rel);
			return { entry, absPath: abs };
		} catch { continue; }
	}
	throw createCodedError({ name: "MemoryReadError", code: "MEMORY_ENTRY_NOT_FOUND", message: `browser_memory entry not found: ${safeId}`, details: { id: safeId } });
}

function lineSlice(text: string, offset: number, limit: number): MemoryReadResult {
	const lines = text.split(/\r?\n/);
	const start = Math.max(1, Math.floor(offset || 1));
	const count = Math.max(1, Math.floor(limit || 120));
	const selected = lines.slice(start - 1, start - 1 + count);
	const nextOffset = start - 1 + selected.length < lines.length ? start + selected.length : null;
	return {
		mode: "text",
		summary: { lineCount: lines.length, chars: text.length },
		offset: start,
		limit: count,
		nextOffset,
		snippets: selected.length ? [{ lineStart: start, lineEnd: start + selected.length - 1, text: selected.join("\n"), truncated: false }] : [],
	};
}

function jsonPathReadValue(root: unknown, jsonPath: string | undefined): unknown {
	const selected = getJsonPath(root, jsonPath);
	return selected.exists ? selected.value : { exists: false, notFound: true, jsonPath, value: null };
}

export async function readBrowserMemory(options: {
	cwd?: string;
	id?: string;
	uri?: string;
	mode?: MemoryReadMode;
	offset?: number;
	limit?: number;
	jsonPath?: string;
}): Promise<MemoryReadResult> {
	const target = options.uri ? parseBrowserMemoryUri(options.uri) : undefined;
	const mode = options.mode || (target?.kind === "index" || options.jsonPath ? "json" : "text");
	if (target?.kind === "index") {
		const indexPath = resolveMemoryPath(options.cwd, "index.json");
		const currentEtag = computeEtag(indexPath);
		if (target.etag && currentEtag && target.etag !== currentEtag) throw createCodedError({ name: "MemoryReadError", code: "MEMORY_RESOURCE_STALE", message: "browser_memory index resource is stale", details: { path: indexPath } });
		const index = await readMemoryIndex(options.cwd);
		return { mode: "json", summary: { path: indexPath, etag: currentEtag }, jsonPath: options.jsonPath, value: jsonPathReadValue(index, options.jsonPath) };
	}
	const id = options.id || target?.id;
	if (!id) throw createCodedError({ name: "MemoryReadError", code: "MEMORY_ENTRY_NOT_FOUND", message: "browser_memory read requires id or browser-memory:// URI" });
	const { entry, absPath } = await loadEntryById(options.cwd, id, target?.kind);
	const currentEtag = computeEtag(absPath);
	const expectedEtag = target?.etag || entry.etag;
	if (expectedEtag && currentEtag && expectedEtag !== currentEtag) throw createCodedError({ name: "MemoryReadError", code: "MEMORY_RESOURCE_STALE", message: "browser_memory resource is stale", details: { id, path: absPath } });
	if (mode === "json") {
		const value = {
			frontmatter: {
				schemaVersion: entry.schemaVersion,
				id: entry.id,
				title: entry.title,
				kind: entry.kind,
				triggers: entry.triggers,
				scopeKind: entry.scopeKind,
				scopeKey: entry.scopeKey,
				sensitivity: entry.sensitivity,
				status: entry.status,
				confidence: entry.confidence,
				verifiedAt: entry.verifiedAt,
				updatedAt: entry.updatedAt,
				evidenceRefs: entry.evidenceRefs,
			},
			body: entry.body,
		};
		return { mode: "json", summary: { path: absPath, etag: currentEtag }, jsonPath: options.jsonPath, value: jsonPathReadValue(value, options.jsonPath) };
	}
	return lineSlice(entry.body, options.offset || 1, options.limit || 120);
}

export async function readBrowserMemoryResource(uri: string, cwd?: string): Promise<{ ok: true; content: { uri: string; mimeType?: string; text: string } } | { ok: false; error: string; code: string }> {
	try {
		const target = parseBrowserMemoryUri(uri);
		if (!target) return { ok: false, error: `Unrecognized resource: ${uri}`, code: "MEMORY_ENTRY_NOT_FOUND" };
		const query = Object.fromEntries(new URLSearchParams(uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : ""));
		const jsonPath = query.jsonPath || undefined;
		const requestedMode = String(query.mode || "").trim().toLowerCase();
		const mode = requestedMode === "json" ? "json" : requestedMode === "text" ? "text" : jsonPath ? "json" : "text";
		const result = await readBrowserMemory({ cwd, uri, mode, offset: query.offset ? Number(query.offset) : undefined, limit: query.limit ? Number(query.limit) : undefined, jsonPath });
		const text = result.mode === "json" ? JSON.stringify(result.value, null, 2) : result.snippets.map((item) => item.text).join("\n");
		return { ok: true, content: { uri, mimeType: result.mode === "json" ? "application/json" : "text/plain", text } };
	} catch (error) {
		if (error instanceof ArtifactReaderError) return { ok: false, error: error.message, code: error.code };
		if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
			return { ok: false, error: error instanceof Error ? error.message : String(error), code: String((error as { code?: unknown }).code) };
		}
		return { ok: false, error: String(error), code: "MEMORY_SCHEMA_INVALID" };
	}
}
