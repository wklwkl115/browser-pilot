import { Type } from "typebox";
import { summarizeNucleiBridgeData } from "../../summaries/index";
import { runNucleiBridge } from "../../webSecurityCore";
import { DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, OUTPUT_PATH_DESCRIPTION, TAB_SCOPED_TOOL_GUIDELINE, executeWebSecurityToolShell, optionalTargetTabId, resolveBooleanParam, normalizeWebSecurityToolParams, type NucleiBridgeToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerNucleiBridgeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_nuclei_bridge",
		label: "Browser Nuclei Bridge",
		description: "Run template and fingerprint automation through a nuclei bridge from scoped URL, raw, captured, or HAR request inputs with structured matches and artifacts.",
		promptSnippet: "Run a Pi-native nuclei bridge for deep template, fingerprint, and CVE-style automation with structured matches and artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_nuclei_bridge for deep template and fingerprint sweeps from explicit scope and template selectors; keep bounded target scope explicit and retain request/stdout/stderr artifacts for follow-up evidence."],
		parameters: Type.Object({
			tabId: optionalTargetTabId("Target tab id used when bindBrowserSession needs browser cookies; otherwise omitted is allowed."),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			timeoutMs: Type.Optional(Type.Number({ description: "Process timeout in milliseconds; default 120000." })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
			nucleiPath: Type.Optional(Type.String({ description: "Optional nuclei executable or launcher command. Default auto-detects nuclei in PATH." })),
			nucleiArgs: Type.Optional(Type.Array(Type.String(), { description: "Optional launcher arguments prepended before generated nuclei flags." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional nuclei CLI arguments appended after generated flags." })),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest, request, requests, sequence, or HAR input supplies a target." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of target URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths resolved against each target URL before nuclei replay." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the nuclei request template." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR." })),
			har: Type.Optional(Type.Any({ description: "HAR object; selected entries are replayed as nuclei bridge targets." })),
			harPath: Type.Optional(Type.String({ description: "Local HAR JSON file path; selected entries are replayed as nuclei bridge targets." })),
			harEntryIndex: Type.Optional(Type.Number({ description: "Zero-based HAR entry index to replay." })),
			harUrlPattern: Type.Optional(Type.String({ description: "Bounded safe-regex or substring filter for HAR request URLs; unsafe regex falls back to substring and candidate entries are capped." })),
			harMaxEntries: Type.Optional(Type.Number({ description: "Maximum HAR entries to replay; default 20, hard-capped at 100." })),
			requests: Type.Optional(Type.Array(Type.Any(), { description: "Request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Each selected entry is sent to nuclei as a separate target." })),
			sequence: Type.Optional(Type.Array(Type.Any(), { description: "Alias for requests; each selected entry is sent to nuclei as a separate target." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: Type.Optional(Type.Any({ description: "Headers to merge or override on the template." })),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Any({ description: "Optional base mutation object with url, method, headers, body, or bodyBase64." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			templatePaths: Type.Optional(Type.Array(Type.String(), { description: "Local nuclei template file or directory paths passed via -t." })),
			workflowPaths: Type.Optional(Type.Array(Type.String(), { description: "Local nuclei workflow file or directory paths passed via -w." })),
			templateIds: Type.Optional(Type.Any({ description: "Optional nuclei template ids passed via -id." })),
			tags: Type.Optional(Type.Any({ description: "Optional nuclei tag selector list passed via -tags." })),
			excludeTags: Type.Optional(Type.Any({ description: "Optional nuclei exclude-tag selector list passed via -etags." })),
			severities: Type.Optional(Type.Any({ description: "Optional nuclei severity selector list passed via -severity." })),
			authors: Type.Optional(Type.Any({ description: "Optional nuclei author selector list passed via -author." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "nuclei per-request timeout seconds; default derived from timeoutMs." })),
			retries: Type.Optional(Type.Number({ description: "nuclei retry count; default 1." })),
			rateLimitPerSecond: Type.Optional(Type.Number({ description: "nuclei request rate cap per second via -rl; default unlimited." })),
			concurrency: Type.Optional(Type.Number({ description: "nuclei concurrency via -c; default 10, clamped to 1-100." })),
			bulkSize: Type.Optional(Type.Number({ description: "nuclei bulk size via -bs; default 10, clamped to 1-100." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true; default 3." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Merge browser cookies for request URLs; default false." })),
			cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie binding; default merge." })),
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
