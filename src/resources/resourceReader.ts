/**
 * MCP resource reader.
 *
 * Bridges browser-result:// URIs to the underlying artifactReader.
 * The local artifact path is resolved via the resource store — never
 * returned to the MCP caller; only text/JSON content is returned.
 *
 * Supported read parameters via URI query string:
 *   mode    — text|json|search|sample (default: text)
 *   offset  — line/byte offset
 *   limit   — max lines
 *   jsonPath — JSON path for json mode
 *   query   — search query for search mode
 *   search  — legacy alias for query
 *   contextLines/contextChars/maxChars/columnOffset/columnLimit/maxMatches — artifact window controls
 */
import { resolveRefUriDetailed, resolveResourceUri, isResourceFresh } from "./resourceStore.js";
import { readBrowserArtifact, ArtifactReaderError } from "../tools/artifactReader.js";

export type McpResourceContent = {
	uri: string;
	mimeType?: string;
	text: string;
};

export type McpResourceReadResult =
	| { ok: true; content: McpResourceContent }
	| { ok: false; error: string; code: string };

type ReadableResource = {
	artifactPath: string;
	jsonPath?: string;
	mime?: string;
	redaction: "default" | "disabled";
	fresh: boolean;
};

function numberQuery(query: Record<string, string>, key: string): number | undefined {
	const raw = query[key];
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function booleanQuery(query: Record<string, string>, key: string): boolean | undefined {
	const raw = query[key];
	if (raw === undefined || raw.trim() === "") return undefined;
	if (/^(1|true|yes)$/i.test(raw)) return true;
	if (/^(0|false|no)$/i.test(raw)) return false;
	return undefined;
}

function sanitizedReadError(err: unknown): string {
	const code = typeof (err as NodeJS.ErrnoException)?.code === "string" ? (err as NodeJS.ErrnoException).code : undefined;
	if (code === "ENOENT") return "Resource artifact could not be read because it no longer exists.";
	if (code === "EACCES" || code === "EPERM") return "Resource artifact could not be read because access was denied.";
	return "Resource artifact could not be read.";
}

/**
 * Read a browser-result:// resource by URI.
 * Accepts optional query parameters to control mode, offset, limit, jsonPath, query/search.
 */
export async function readBrowserResultResource(uri: string): Promise<McpResourceReadResult> {
	const storedResource = resolveResourceUri(uri);
	let resource: ReadableResource | undefined = storedResource
		? {
			artifactPath: storedResource.artifactPath,
			jsonPath: storedResource.jsonPath,
			mime: storedResource.mime,
			redaction: storedResource.redaction,
			fresh: isResourceFresh(storedResource),
		}
		: undefined;
	if (!resource && uri.startsWith("pi-ref://")) {
		const resolved = resolveRefUriDetailed(uri);
		if (resolved.ok && resolved.ref.artifactPath) {
			resource = {
				artifactPath: resolved.ref.artifactPath,
				jsonPath: resolved.ref.jsonPath ?? resolved.ref.descriptor.snapshot?.jsonPath,
				mime: resolved.ref.mime,
				redaction: resolved.ref.redaction,
				fresh: resolved.ref.fresh !== false,
			};
		}
	}
	if (!resource) {
		return {
			ok: false,
			error: `Resource not found or expired: ${uri}`,
			code: "RESOURCE_NOT_FOUND",
		};
	}

	// Staleness: the artifact under this handle was rewritten/replaced since
	// registration (e.g. a later same-tool call reused the fallback path).
	if (!resource.fresh) {
		return {
			ok: false,
			error: `Resource is stale (artifact changed since it was captured): ${uri}`,
			code: "RESOURCE_STALE",
		};
	}

	// Parse query params from the URI for mode/offset/limit/jsonPath/query.
	const queryStart = uri.indexOf("?");
	const queryStr = queryStart >= 0 ? uri.slice(queryStart + 1) : "";
	const query = Object.fromEntries(new URLSearchParams(queryStr));
	const searchQuery = query.query ?? query.search;
	const mode = query.mode || (query.jsonPath || resource.jsonPath ? "json" : searchQuery ? "search" : "text");

	try {
		const result = await readBrowserArtifact(
			{
				path: resource.artifactPath,
				// A section resource (stored jsonPath) defaults to json; whole-artifact
				// resources default to text unless a query/search needle implies search.
				mode,
				offset: numberQuery(query, "offset"),
				limit: numberQuery(query, "limit"),
				maxChars: numberQuery(query, "maxChars"),
				jsonPath: query.jsonPath || resource.jsonPath,
				query: searchQuery,
				regex: booleanQuery(query, "regex"),
				ignoreCase: booleanQuery(query, "ignoreCase"),
				contextLines: numberQuery(query, "contextLines"),
				contextChars: numberQuery(query, "contextChars"),
				columnOffset: numberQuery(query, "columnOffset"),
				columnLimit: numberQuery(query, "columnLimit"),
				maxMatches: numberQuery(query, "maxMatches"),
				redact: resource.redaction !== "disabled",
			},
			// ctx is not needed when path is absolute
			undefined,
		);

		let text: string;
		if (result.mode === "json") {
			text = JSON.stringify(result.value, null, 2);
		} else {
			// text, search, sample: concatenate snippet text blocks
			text = result.snippets.map((s) => s.text).join("\n");
		}

		return {
			ok: true,
			content: {
				uri,
				mimeType: result.mode === "json" ? "application/json" : (resource.mime ?? "text/plain"),
				text,
			},
		};
	} catch (err) {
		if (err instanceof ArtifactReaderError) {
			return { ok: false, error: sanitizedReadError(err), code: "RESOURCE_READ_ERROR" };
		}
		return { ok: false, error: sanitizedReadError(err), code: "RESOURCE_READ_ERROR" };
	}
}
