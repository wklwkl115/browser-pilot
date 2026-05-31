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
import { resolveResourceUri } from "./resourceStore.js";
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
	const resource = resolveResourceUri(uri);
	if (!resource) {
		return {
			ok: false,
			error: `Resource not found or expired: ${uri}`,
			code: "RESOURCE_NOT_FOUND",
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
				mode: (query.mode as string) || "text",
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
