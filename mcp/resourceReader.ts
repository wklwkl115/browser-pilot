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
 *   search  — search query for search mode
 */
import { resolveRefUriDetailed, resolveResourceUri, isResourceFresh } from "./resourceStore.js";
import { readBrowserArtifact, ArtifactReaderError } from "../src/tools/artifactReader.js";

export type McpResourceContent = {
	uri: string;
	mimeType?: string;
	text: string;
};

export type McpResourceReadResult =
	| { ok: true; content: McpResourceContent }
	| { ok: false; error: string; code: string };

/**
 * Read a browser-result:// resource by URI.
 * Accepts optional query parameters to control mode, offset, limit, jsonPath, search.
 */
export async function readBrowserResultResource(uri: string): Promise<McpResourceReadResult> {
	let resource = resolveResourceUri(uri);
	if (!resource && uri.startsWith("pi-ref://")) {
		const resolved = resolveRefUriDetailed(uri);
		if (resolved.ok && resolved.ref.resourceUri) resource = resolveResourceUri(resolved.ref.resourceUri);
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
	if (!isResourceFresh(resource)) {
		return {
			ok: false,
			error: `Resource is stale (artifact changed since it was captured): ${uri}`,
			code: "RESOURCE_STALE",
		};
	}

	// Parse query params from the URI for mode/offset/limit/jsonPath/search
	const queryStart = uri.indexOf("?");
	const queryStr = queryStart >= 0 ? uri.slice(queryStart + 1) : "";
	const query = Object.fromEntries(new URLSearchParams(queryStr));

	try {
		const result = await readBrowserArtifact(
			{
				path: resource.artifactPath,
				// A section resource (stored jsonPath) defaults to json so it returns its slice;
				// a whole-artifact resource defaults to text.
				mode: (query.mode as string) || (resource.jsonPath ? "json" : "text"),
				offset: query.offset != null ? Number(query.offset) : undefined,
				limit: query.limit != null ? Number(query.limit) : undefined,
				jsonPath: query.jsonPath || resource.jsonPath,
				query: query.search,
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
			return { ok: false, error: err.message, code: err.code };
		}
		return { ok: false, error: String(err), code: "RESOURCE_READ_ERROR" };
	}
}
