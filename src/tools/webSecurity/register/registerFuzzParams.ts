import { Type } from "typebox";
import { summarizeFuzzParamsData } from "../../summaries/index";
import { runFuzzParams } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, maxCasesParam, rateLimitPerSecondParam, redirectControlParams, resolveBooleanParam, sharedWebSecurityParams, normalizeWebSecurityToolParams, type FuzzParamsToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerFuzzParamsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_fuzz_params",
		label: "Browser Fuzz Params",
		description: "Fuzz query, JSON, form, multipart, and header parameters from raw/captured HTTP request templates with delta evidence and artifact output.",
		promptSnippet: "Run bounded parameter fuzzing from URL/raw/captured requests with matcher/filter controls and response evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_fuzz_params from a captured or raw request template; keep param names, values, and maxCases bounded, and preserve artifact evidence for response deltas."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest or request supplies a URL." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the fuzz template." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: Type.Optional(Type.Any({ description: "Headers to merge or override on the template." })),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Any({ description: "Optional base mutation object with url, method, headers, body, bodyBase64, or multipart." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			locations: Type.Optional(Type.Any({ description: "Parameter locations: query, json, form, multipart, header, or all. Default inferred from template." })),
			paramNames: Type.Optional(Type.Array(Type.String(), { description: "Parameter names to fuzz. If omitted, existing template params are used." })),
			values: Type.Optional(Type.Array(Type.String(), { description: "Candidate values to assign to each parameter." })),
			jsonValues: Type.Optional(Type.Any({ description: "JSON values for JSON or multipart parameter fuzzing; multipart values may use arrays for repeated same-name parts, nested {multipart:{...}} descriptors, or file objects like {filename, contentType, content, bodyBase64}." })),
			words: Type.Optional(Type.Array(Type.String(), { description: "Alias for values." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline wordlist entries; aliases values." })),
			wordlistPath: Type.Optional(Type.String({ description: "Optional local wordlist file path; one entry per line." })),
			operations: Type.Optional(Type.Array(Type.String(), { description: "Parameter operations: set, add, delete. Default set." })),
			contentTypeVariants: Type.Optional(Type.Array(Type.String(), { description: "Multipart Content-Type variants: normal, quoted, missing-boundary, mismatch." })),
			...redirectControlParams({
				followRedirectsDescription: "Follow redirects; default false for stable matching.",
				maxRedirectsDescription: "Maximum redirects when followRedirects is true; default 3.",
			}),
			matchStatus: Type.Optional(Type.Any({ description: "Optional status matcher list/string, e.g. [200,201,302]." })),
			filterStatus: Type.Optional(Type.Any({ description: "Optional status filter list/string, e.g. [403,404]." })),
			filterBodyBytes: Type.Optional(Type.Any({ description: "Optional body byte-size filter list/string for noisy baselines." })),
			...maxCasesParam("Maximum location*param*operation*value cases; default 500, hard-capped at 5000."),
			...rateLimitPerSecondParam("Sequential request rate cap per second; default unlimited sequential."),
			...browserCookieBindingParams("Merge browser cookies for request URLs; default false."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<FuzzParamsToolParams>(params), ctx, {
				toolName: "browser_fuzz_params",
				command: "web.fuzz_params",
				fallbackPrefix: "fuzz-params",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, false) }),
				run: runFuzzParams,
				details: (result) => ({ caseCount: result.caseCount, matchedCount: result.matchedCount }),
				distill: summarizeFuzzParamsData,
			});
		},
	});
}
