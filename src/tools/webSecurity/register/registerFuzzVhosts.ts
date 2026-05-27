import { Type } from "typebox";
import { summarizeFuzzVhostsData } from "../../summaries/index";
import { runFuzzVhosts } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, maxCandidatesParam, rateLimitPerSecondParam, redirectControlParams, sharedWebSecurityParams, normalizeWebSecurityToolParams, type FuzzVhostsToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerFuzzVhostsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_fuzz_vhosts",
		label: "Browser Fuzz Vhosts",
		description: "Fuzz virtual hosts with Host header candidates, HTTPS SNI/certificate summaries, baseline-cluster filtering, response evidence, and artifact output.",
		promptSnippet: "Run bounded Host-header virtual-host discovery with baseline clustering, SNI, certificate summaries, and evidence artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_fuzz_vhosts only with explicit target scope and bounded host candidates; keep baseline filtering enabled unless diagnosing."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single base target URL to connect to." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of base target URLs to connect to." })),
			hosts: Type.Optional(Type.Array(Type.String(), { description: "Explicit Host header candidate values." })),
			words: Type.Optional(Type.Array(Type.String(), { description: "Candidate words; combined with baseDomain/template when provided." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline wordlist entries; aliases words." })),
			wordlistPath: Type.Optional(Type.String({ description: "Optional local wordlist file path; one entry per line." })),
			baseDomain: Type.Optional(Type.String({ description: "Base domain used to expand words as word.baseDomain." })),
			template: Type.Optional(Type.String({ description: "Host template containing FUZZ, e.g. FUZZ.example.test." })),
			baselineHost: Type.Optional(Type.String({ description: "Baseline Host header; default is a generated invalid-looking host." })),
			baselineHosts: Type.Optional(Type.Array(Type.String(), { description: "Additional baseline Host header values used for wildcard response clustering." })),
			sniMode: Type.Optional(Type.String({ description: "HTTPS SNI mode: target | host | custom | none. Default target." })),
			sniName: Type.Optional(Type.String({ description: "Custom HTTPS SNI servername when sniMode/custom behavior is needed." })),
			method: Type.Optional(Type.String({ description: "HTTP method; default GET." })),
			headers: Type.Optional(Type.Any({ description: "Optional request headers except Host; Host is controlled by candidates." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only base targets; default https." })),
			...redirectControlParams({
				followRedirectsDescription: "Follow redirects; default false.",
				maxRedirectsDescription: "Maximum redirects when followRedirects is true; default 3.",
			}),
			matchStatus: Type.Optional(Type.Any({ description: "Optional status matcher list/string, e.g. [200,301,302,403]." })),
			filterStatus: Type.Optional(Type.Any({ description: "Optional status filter list/string, e.g. [404]." })),
			filterBodyBytes: Type.Optional(Type.Any({ description: "Optional body byte-size filter list/string for noisy baselines." })),
			filterBaseline: Type.Optional(Type.Boolean({ description: "Only return candidates that differ from baseline status/title/body length; default true." })),
			baselineStrategy: Type.Optional(Type.String({ description: "Baseline comparison mode: exact | cluster | auto. Default auto." })),
			...maxCandidatesParam("Maximum host candidates per base; default 500, hard-capped at 5000."),
			...rateLimitPerSecondParam("Sequential request rate cap per second; default unlimited sequential."),
			...browserCookieBindingParams("Inject browser cookies for fuzz requests into the outgoing HTTP request headers; default false.", { includeCookieMode: false }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<FuzzVhostsToolParams>(params), ctx, {
				toolName: "browser_fuzz_vhosts",
				command: "web.fuzz_vhosts",
				fallbackPrefix: "fuzz-vhosts",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				run: runFuzzVhosts,
				details: (result) => ({ requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeFuzzVhostsData,
			}, _onUpdate);
		},
	});
}
