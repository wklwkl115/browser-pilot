import { Type } from "typebox";
import { normalizeArtifactMode } from "../utils/params.js";
import { readBrowserArtifact } from "../artifacts/artifactReader.js";
import { defineBrowserCommand, inlineJsonCommandResult, runCommandHandler } from "./commandRuntime.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { strictCommandParameters } from "./commandShared.js";
import type { ValidationIssue } from "./commandDefinition.js";

function nonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function validateArtifactSearch(hasQuery: boolean, mode: string | undefined): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (mode === "search" && !hasQuery) issues.push({ code: "ARTIFACT_SEARCH_QUERY_REQUIRED", path: "/query", message: "browser_artifact search requires a non-empty query" });
	if (hasQuery && mode !== undefined && mode !== "search") issues.push({ code: "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE", path: "/query", message: `browser_artifact query is only valid for mode=search, not mode=${mode}` });
	return issues;
}

function validateArtifactJson(hasJsonPath: boolean, hasPick: boolean, mode: string | undefined): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (hasJsonPath && hasPick) issues.push({ code: "ARTIFACT_JSON_TARGET_CONFLICT", path: "/", message: "browser_artifact accepts jsonPath or pick, not both" });
	if ((hasJsonPath || hasPick) && mode !== undefined && mode !== "json") issues.push({ code: "ARTIFACT_JSON_MODE_REQUIRED", path: "/mode", message: "browser_artifact jsonPath/pick requires mode=json or omitted mode" });
	return issues;
}

export function validateArtifactArguments(args: Record<string, unknown>): ValidationIssue[] {
	const hasPath = nonEmptyString(args.path);
	const hasQuery = nonEmptyString(args.query);
	const mode = typeof args.mode === "string" ? args.mode : undefined;
	const hasJsonPath = nonEmptyString(args.jsonPath);
	const hasPick = Array.isArray(args.pick) && args.pick.length > 0;
	return [
		...(!hasPath ? [{ code: "ARTIFACT_TARGET_REQUIRED", path: "/", message: "browser_artifact requires path" }] : []),
		...validateArtifactSearch(hasQuery, mode),
		...validateArtifactJson(hasJsonPath, hasPick, mode),
	];
}

export function defineArtifactCommand({ commands }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_artifact",
		label: "Browser Artifact",
		description: "Read, inspect, search, or pick one artifact file produced by a browser tool without loading the whole file.",
		promptSnippet: "Read, search, or inspect one browser tool artifact by path, offsets, snippets, or JSON paths.",
		promptGuidelines: [
			"Use browser_artifact after browser tools return saved.path; prefer search/json/text offsets over re-running full browser captures.",
			"Default text/search/whole-json output redacts cookie/token/authorization/body/postData/websocket payload values; explicit jsonPath/pick reads return the named local raw value.",
			"JSON path misses return explicit exists:false/notFound:true; pick results stay aligned one entry per requested path.",
			"Large homogeneous JSON arrays may render as projection:\"folded-v1\" with template constants, source-ordered item tuples, and value.frontier.retrieve for exact offset/jsonPath expansion.",
			"For minified JS or long single-line artifacts, use search contextChars or text columnOffset/columnLimit instead of loading the whole file.",
			"Request the next offset, column window, or a narrower jsonPath/query when more detail is needed.",
			"When a previous tool returns correlation metadata, prefer browser_artifact mode=json with jsonPath like operation.operationId, snapshot.snapshotId, or data.requestId/data.waitId/data.listenerId before reading the whole artifact.",
		],
		parameters: strictCommandParameters({
			path: Type.Optional(Type.String({ description: "Artifact path returned by a browser tool, inside .browser-pilot/artifacts." })),
			mode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json"), Type.Literal("search"), Type.Literal("inspect")], { description: "text | json | search | inspect" })),
			offset: Type.Optional(Type.Number({ description: "Line offset for text/search; item offset for json arrays; character offset for json scalar strings" })),
			limit: Type.Optional(Type.Number({ description: "Line count for text; item/key limit for json arrays/objects; character limit for json scalar strings" })),
			jsonPath: Type.Optional(Type.String({ description: "Simple dot/bracket path for json mode; when provided without mode, read defaults to json. Missing paths return exists:false/notFound:true. Browser tool artifacts usually keep primary results under data, e.g. data, data.items, data.links." })),
			pick: Type.Optional(Type.Array(Type.String(), { description: "Multiple simple JSON paths. Results stay aligned one entry per requested path." })),
			query: Type.Optional(Type.String({ description: "String or bounded safe-regex query for search mode; when provided without mode and without jsonPath/pick, read defaults to search." })),
			regex: Type.Optional(Type.Boolean({ description: "Treat query as a bounded regular expression; unsafe patterns are rejected" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search unless false" })),
			contextLines: Type.Optional(Type.Number({ description: "Context lines around search matches" })),
			contextChars: Type.Optional(Type.Number({ description: "Character window around long-line search matches; bounded internally." })),
			columnOffset: Type.Optional(Type.Number({ description: "text mode only: zero-based character offset within each selected line for long single-line artifacts." })),
			columnLimit: Type.Optional(Type.Number({ description: "text mode only: maximum characters to return from columnOffset within each selected line." })),
			maxMatches: Type.Optional(Type.Number({ description: "Maximum search matches" })),
		}),
		validateArguments: validateArtifactArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const result = await readBrowserArtifact(params, ctx);
				return inlineJsonCommandResult(result, { mode: result.mode || normalizeArtifactMode(params.mode), path: params.path }, {}, "browser_artifact");
			});
		},
	});
}
