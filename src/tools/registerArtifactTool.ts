import { Type } from "typebox";
import { normalizeArtifactMode } from "../utils/params";
import { errorResult, jsonResult } from "../utils/toolResult";
import { readBrowserArtifact } from "./artifactReader";
import { defaultResultBudget } from "./budgets";
import { asPositiveInt, MAX_CHARS_DESCRIPTION } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

export function registerArtifactTool({ pi }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_artifact",
		label: "Browser Artifact",
		description: "Read, sample, search, or pick local artifact files produced by browser tools without loading the whole file.",
		promptSnippet: "Read/search browser tool artifact files by path, offsets, snippets, or JSON paths.",
		promptGuidelines: [
			"Use browser_artifact after browser tools return saved.path; prefer search/json/text offsets over re-running full browser captures.",
			"Keep maxChars small and request the next offset or a narrower jsonPath/query when more detail is needed.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Artifact path returned by a browser tool, absolute or relative to cwd" }),
			mode: Type.Optional(Type.String({ description: "text | json | search | sample" })),
			offset: Type.Optional(Type.Number({ description: "Line offset for text/search; array offset for json arrays" })),
			limit: Type.Optional(Type.Number({ description: "Line count for text/sample; item/key limit for json" })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
			jsonPath: Type.Optional(Type.String({ description: "Simple dot/bracket path for json mode, e.g. sources.hook_events.data.events[0]" })),
			pick: Type.Optional(Type.Array(Type.String(), { description: "Multiple simple JSON paths to return as an object" })),
			query: Type.Optional(Type.String({ description: "String or regex query for search mode" })),
			regex: Type.Optional(Type.Boolean({ description: "Treat query as a regular expression" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search unless false" })),
			contextLines: Type.Optional(Type.Number({ description: "Context lines around search matches" })),
			maxMatches: Type.Optional(Type.Number({ description: "Maximum search matches" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_artifact"));
				const result = await readBrowserArtifact(params, ctx);
				return jsonResult(result, { mode: normalizeArtifactMode(params.mode), path: params.path }, maxChars);
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
