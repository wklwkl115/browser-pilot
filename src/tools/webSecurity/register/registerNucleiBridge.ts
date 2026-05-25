import { Type } from "typebox";
import { summarizeNucleiBridgeData } from "../../summaries/index";
import { runNucleiBridge } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, boundedExecutionParams, browserCookieBindingParams, executeWebSecurityToolShell, harReplayParams, rawRequestParams, rateLimitPerSecondParam, redirectControlParams, requestSequenceParams, sharedWebSecurityBrowserSessionParams, resolveBooleanParam, normalizeWebSecurityToolParams, type NucleiBridgeToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerNucleiBridgeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_nuclei_bridge",
		label: "Browser Nuclei Bridge",
		description: "Run template and fingerprint automation through a nuclei bridge from scoped URL, raw, captured, or HAR request inputs with structured matches and artifacts.",
		promptSnippet: "Run a Pi-native nuclei bridge for deep template, fingerprint, and CVE-style automation with structured matches and artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_nuclei_bridge for deep template and fingerprint sweeps from explicit scope and template selectors; keep bounded target scope explicit and retain request/stdout/stderr artifacts for follow-up evidence."],
		parameters: Type.Object({
			...sharedWebSecurityBrowserSessionParams("Process timeout in milliseconds; default 120000."),
			nucleiPath: Type.Optional(Type.String({ description: "Optional nuclei executable or launcher command. Default auto-detects nuclei in PATH." })),
			nucleiArgs: Type.Optional(Type.Array(Type.String(), { description: "Optional launcher arguments prepended before generated nuclei flags." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional nuclei CLI arguments appended after generated flags." })),
			...rawRequestParams({
				urlDescription: "Absolute URL or host/path target. Required unless rawRequest, request, requests, sequence, or HAR input supplies a target.",
				rawRequestDescription: "Raw HTTP request text used as the nuclei request template.",
				requestDescription: "Captured request-like object from browser_network/HAR.",
				headersDescription: "Headers to merge or override on the template.",
				mutationsDescription: "Optional base mutation object with url, method, headers, body, or bodyBase64.",
			}, { section: "target" }),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of target URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths resolved against each target URL before nuclei replay." })),
			...harReplayParams({
				harDescription: "HAR object; selected entries are replayed as nuclei bridge targets.",
				harPathDescription: "Local HAR JSON file path; selected entries are replayed as nuclei bridge targets.",
			}),
			...requestSequenceParams({
				requestsDescription: "Request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Each selected entry is sent to nuclei as a separate target.",
				sequenceDescription: "Alias for requests; each selected entry is sent to nuclei as a separate target.",
			}),
			...rawRequestParams({
				urlDescription: "Absolute URL or host/path target. Required unless rawRequest, request, requests, sequence, or HAR input supplies a target.",
				rawRequestDescription: "Raw HTTP request text used as the nuclei request template.",
				requestDescription: "Captured request-like object from browser_network/HAR.",
				headersDescription: "Headers to merge or override on the template.",
				mutationsDescription: "Optional base mutation object with url, method, headers, body, or bodyBase64.",
			}, { section: "overrides" }),
			templatePaths: Type.Optional(Type.Array(Type.String(), { description: "Local nuclei template file or directory paths passed via -t." })),
			workflowPaths: Type.Optional(Type.Array(Type.String(), { description: "Local nuclei workflow file or directory paths passed via -w." })),
			templateIds: Type.Optional(Type.Any({ description: "Optional nuclei template ids passed via -id." })),
			tags: Type.Optional(Type.Any({ description: "Optional nuclei tag selector list passed via -tags." })),
			excludeTags: Type.Optional(Type.Any({ description: "Optional nuclei exclude-tag selector list passed via -etags." })),
			severities: Type.Optional(Type.Any({ description: "Optional nuclei severity selector list passed via -severity." })),
			authors: Type.Optional(Type.Any({ description: "Optional nuclei author selector list passed via -author." })),
			...boundedExecutionParams({ timeoutSecondsDescription: "nuclei per-request timeout seconds; default derived from timeoutMs." }),
			retries: Type.Optional(Type.Number({ description: "nuclei retry count; default 1." })),
			...rateLimitPerSecondParam("nuclei request rate cap per second via -rl; default unlimited."),
			concurrency: Type.Optional(Type.Number({ description: "nuclei concurrency via -c; default 10, clamped to 1-100." })),
			bulkSize: Type.Optional(Type.Number({ description: "nuclei bulk size via -bs; default 10, clamped to 1-100." })),
			...redirectControlParams({
				followRedirectsDescription: "Follow redirects; default false.",
				maxRedirectsDescription: "Maximum redirects when followRedirects is true; default 3.",
			}),
			...browserCookieBindingParams("Merge browser cookies for request URLs; default false."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<NucleiBridgeToolParams>(params), ctx, {
				toolName: "browser_nuclei_bridge",
				command: "web.nuclei_bridge",
				fallbackPrefix: "nuclei-bridge",
				defaultTimeoutMs: 120_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, false) }),
				run: runNucleiBridge,
				details: (result) => ({ runCount: result.runCount, matchCount: result.matchCount, matchedRunCount: result.matchedRunCount }),
				distill: summarizeNucleiBridgeData,
			});
		},
	});
}
