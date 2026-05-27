import { Type } from "typebox";
import { summarizeFuzzPathsData } from "../../summaries/index";
import { runFuzzPaths } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, maxCandidatesParam, maxDepthParam, rateLimitPerSecondParam, redirectControlParams, sharedWebSecurityParams, normalizeWebSecurityToolParams, type FuzzPathsToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerFuzzPathsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_fuzz_paths",
		label: "Browser Fuzz Paths",
		description: "Fuzz scoped HTTP paths, files, routes, and extensions with recursive depth, baseline-cluster filtering, match/filter/rate controls, response evidence, and artifact output.",
		promptSnippet: "Run bounded path/file/route fuzzing against scoped targets with structured response evidence, recursive depth, and baseline clustering.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_fuzz_paths only with explicit target scope and bounded wordlists; set match/filter/rate controls before increasing breadth."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single base target URL or URL containing FUZZ. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of base target URLs or FUZZ URLs." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Explicit candidate paths/routes to request." })),
			words: Type.Optional(Type.Array(Type.String(), { description: "Candidate words appended to each base URL or substituted into FUZZ. For multiple FUZZ tokens, use word tuples separated by ::." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline wordlist entries; aliases words." })),
			wordlistPath: Type.Optional(Type.String({ description: "Optional local wordlist file path; one entry per line." })),
			extensions: Type.Optional(Type.Array(Type.String(), { description: "Optional extensions to add for extension fuzzing, e.g. php,json,txt." })),
			appendSlash: Type.Optional(Type.Boolean({ description: "Also test trailing-slash directory variants." })),
			recursive: Type.Optional(Type.Boolean({ description: "Recursively fuzz discovered directory-like paths; default false." })),
			...maxDepthParam("Maximum recursive directory depth when recursive is enabled; default 2, hard-capped at 5."),
			method: Type.Optional(Type.String({ description: "HTTP method; default GET." })),
			headers: Type.Optional(Type.Any({ description: "Optional request headers object." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			...redirectControlParams({
				followRedirectsDescription: "Follow redirects; default false for stable status matching.",
				maxRedirectsDescription: "Maximum redirects when followRedirects is true; default 3.",
			}),
			matchStatus: Type.Optional(Type.Any({ description: "Optional status matcher list/string, e.g. [200,204,301,302,403]." })),
			filterStatus: Type.Optional(Type.Any({ description: "Optional status filter list/string, e.g. [404]." })),
			filterBodyBytes: Type.Optional(Type.Any({ description: "Optional body byte-size filter list/string for noisy baselines." })),
			filterBaseline: Type.Optional(Type.Boolean({ description: "Only return candidates that differ from the auto baseline status/title/body/hash; default false." })),
			baselinePath: Type.Optional(Type.String({ description: "Optional baseline path/word used for automatic baseline comparison." })),
			baselineStrategy: Type.Optional(Type.String({ description: "Baseline comparison mode: exact | cluster | auto. Default auto." })),
			...maxCandidatesParam("Maximum candidates per base after extension/slash expansion; default 500, hard-capped at 5000."),
			...rateLimitPerSecondParam("Sequential request rate cap per second; default unlimited sequential."),
			...browserCookieBindingParams("Inject browser cookies for fuzz requests into the outgoing HTTP request headers; default false.", { includeCookieMode: false }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<FuzzPathsToolParams>(params), ctx, {
				toolName: "browser_fuzz_paths",
				command: "web.fuzz_paths",
				fallbackPrefix: "fuzz-paths",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				run: runFuzzPaths,
				details: (result) => ({ requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeFuzzPathsData,
			}, _onUpdate);
		},
	});
}
