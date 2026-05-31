import { Type } from "typebox";
import { normalizeArtifactMode } from "../utils/params.js";
import { readBrowserArtifact } from "./artifactReader.js";
import { defineBrowserTool, inlineJsonToolResult, maxCharsParam, runTool } from "./toolAdapter.js";
import type { ToolRegistrarContext } from "./toolShared.js";
import { strictToolParameters } from "./toolShared.js";

export function registerArtifactTool({ pi }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_artifact",
		label: "Browser Artifact",
		description: "Read, sample, search, or pick local artifact files produced by browser tools without loading the whole file, including bounded multi-artifact search.",
		promptSnippet: "Read/search browser tool artifact files by path, offsets, snippets, JSON paths, or bounded multi-artifact search.",
		promptGuidelines: [
			"Use browser_artifact after browser tools return saved.path; prefer search/json/text offsets over re-running full browser captures.",
			"Default output redacts cookie/token/authorization/body/postData/websocket payload values; use redact:false only when the user explicitly needs local raw evidence.",
			"JSON path misses return explicit exists:false/notFound:true; pick results stay aligned one entry per requested path.",
			"Use paths or bounded root/glob plus maxFiles/maxBytes/maxMatchesPerFile/maxTotalMatches for multi-artifact search; do not run unbounded search.",
			"Keep maxChars small and request the next offset or a narrower jsonPath/query when more detail is needed.",
			"When a previous tool returns correlation metadata, prefer browser_artifact mode=json with jsonPath like operation.operationId, snapshot.snapshotId, or data.requestId/data.waitId/data.listenerId before reading the whole artifact.",
		],
		parameters: strictToolParameters({
			path: Type.Optional(Type.String({ description: "Artifact path returned by a browser tool, absolute or relative to cwd" })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Explicit artifact paths for bounded multi-artifact search mode." })),
			root: Type.Optional(Type.String({ description: "Optional relative root under .pi/browser-artifacts for bounded multi-artifact search." })),
			glob: Type.Optional(Type.String({ description: "Optional bounded glob for multi-artifact search, e.g. **/*.json" })),
			mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json"), Type.Literal("search"), Type.Literal("sample")], { description: "text | json | search | sample" })),
			offset: Type.Optional(Type.Number({ description: "Line offset for text/search; array offset for json arrays" })),
			limit: Type.Optional(Type.Number({ description: "Line count for text/sample; item/key limit for json" })),
			maxChars: maxCharsParam(),
			jsonPath: Type.Optional(Type.String({ description: "Simple dot/bracket path for json mode; missing paths return exists:false/notFound:true" })),
			pick: Type.Optional(Type.Array(Type.String(), { description: "Multiple simple JSON paths; each requested path returns an aligned exists/value or notFound entry" })),
			query: Type.Optional(Type.String({ description: "String or bounded safe-regex query for search mode" })),
			regex: Type.Optional(Type.Boolean({ description: "Treat query as a bounded regular expression; unsafe patterns are rejected" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search unless false" })),
			contextLines: Type.Optional(Type.Number({ description: "Context lines around search matches" })),
			maxMatches: Type.Optional(Type.Number({ description: "Maximum search matches" })),
			maxFiles: Type.Optional(Type.Number({ description: "Maximum files scanned for bounded multi-artifact search." })),
			maxBytes: Type.Optional(Type.Number({ description: "Maximum total bytes scanned for bounded multi-artifact search." })),
			maxMatchesPerFile: Type.Optional(Type.Number({ description: "Maximum search matches retained per file in bounded multi-artifact search." })),
			maxTotalMatches: Type.Optional(Type.Number({ description: "Maximum total matches retained across all files in bounded multi-artifact search." })),
			redact: Type.Optional(Type.Boolean({ description: "Redact cookie/token/authorization/body/postData/websocket payload values from browser_artifact output; default true. Raw local artifact file is unchanged." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const result = await readBrowserArtifact(params, ctx);
				return inlineJsonToolResult(result, { mode: result.mode || normalizeArtifactMode(params.mode), path: params.path, paths: params.paths, root: params.root, glob: params.glob }, params, "browser_artifact");
			});
		},
	});
}
