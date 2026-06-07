import { Type } from "typebox";
import { summarizeFuzzParamsData, summarizeFuzzPathsData, summarizeFuzzVhostsData } from "../../summaries/index.js";
import { runFuzzParams, runFuzzPaths, runFuzzVhosts } from "../../webSecurityCore.js";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, maxCandidatesParam, maxCasesParam, maxDepthParam, rateLimitPerSecondParam, redirectControlParams, resolveBooleanParam, sharedWebSecurityParams, normalizeWebSecurityToolParams, validateFuzzParams, headerRecordParam, stringNumberOrListParam, fuzzLocationParam, enumParam, type WebSecuritySharedToolParams } from "./shared.js";
import type { ToolRegistrarContext } from "../../toolShared.js";
import { strictToolParameters } from "../../toolShared.js";
import type { RawFuzzParamsOptions, RawFuzzPathsOptions, RawFuzzVhostsOptions } from "../shared/types.js";
import { validateOptionalParams } from "../../../validation/middleware.js";
import { HttpRequestSchema, FuzzMutationsSchema, JsonValuesSchema } from "../../../validation/schemas.js";

type FuzzToolParams = WebSecuritySharedToolParams & RawFuzzPathsOptions & RawFuzzVhostsOptions & RawFuzzParamsOptions & { mode?: unknown };

export function registerFuzzTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_fuzz",
		label: "Browser Fuzz",
		description: "Run bounded path, vhost, or parameter fuzzing against explicit scoped HTTP targets with baseline filtering, clustering, response deltas, and evidence artifacts.",
		promptSnippet: "Run bounded path, vhost, or parameter fuzzing against explicit scoped HTTP targets with structured evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_fuzz only with explicit target scope and bounded candidates. Choose mode:path for routes/files, mode:vhost for Host header discovery, or mode:param for query/JSON/form/multipart/header parameters.", "HTTP target execution uses Node.js fetch directly, not the browser bridge; requests originate from the Node.js process with optional browser-session cookie injection."],
		parameters: strictToolParameters({
			mode: Type.Optional(Type.Union([Type.Literal("path"), Type.Literal("vhost"), Type.Literal("param")], { description: "Fuzz dimension (default: path). path: URL segments/files/routes; vhost: Host header candidates; param: request parameters." })),
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Base target URL, request URL, or URL containing FUZZ. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of base target URLs or hosts." })),
			baseUrl: Type.Optional(Type.String({ description: "param mode only: base URL for relative raw request targets." })),
			words: Type.Optional(Type.Array(Type.String(), { description: "Candidate words/values. path mode: appended or substituted into FUZZ; vhost mode: expanded into hosts; param mode: aliases values." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline candidate wordlist; aliases words/values." })),
			wordlistPath: Type.Optional(Type.String({ description: "Optional local wordlist file path; one entry per line." })),
			method: Type.Optional(Type.String({ description: "HTTP method; default GET in path/vhost modes, override request method in param mode." })),
			headers: headerRecordParam("Optional request headers object or overrides."),
			...redirectControlParams({
				followRedirectsDescription: "Follow redirects. path/vhost/param modes default false for stable matching except explicit current-mode overrides.",
				maxRedirectsDescription: "Maximum redirects when followRedirects is true; default 3.",
			}),
			matchStatus: stringNumberOrListParam("Optional status matcher list/string."),
			filterStatus: stringNumberOrListParam("Optional status filter list/string."),
			filterBodyBytes: stringNumberOrListParam("Optional body byte-size filter list/string for noisy baselines."),
			...rateLimitPerSecondParam("Sequential request rate cap per second; default unlimited sequential."),
			...browserCookieBindingParams("Inject browser cookies into outgoing HTTP request headers; default false.", { includeCookieMode: false }),
			paths: Type.Optional(Type.Array(Type.String(), { description: "path mode only: explicit candidate paths/routes to request." })),
			extensions: Type.Optional(Type.Array(Type.String(), { description: "path mode only: optional extensions for extension fuzzing, e.g. php,json,txt." })),
			appendSlash: Type.Optional(Type.Boolean({ description: "path mode only: also test trailing-slash directory variants." })),
			recursive: Type.Optional(Type.Boolean({ description: "path mode only: recursively fuzz discovered directory-like paths; default false." })),
			...maxDepthParam("path mode only: maximum recursive directory depth when recursive is enabled; default 2, hard-capped at 5."),
			filterBaseline: Type.Optional(Type.Boolean({ description: "path/vhost modes only: only return candidates that differ from baseline status/title/body/hash; default false for path, true for vhost." })),
			baselinePath: Type.Optional(Type.String({ description: "path mode only: optional baseline path/word used for automatic baseline comparison." })),
			baselineStrategy: enumParam(["exact", "cluster", "auto"], "path/vhost modes only: baseline comparison mode: exact | cluster | auto. Default auto."),
			...maxCandidatesParam("path/vhost modes only: maximum candidates per base; default 500, hard-capped at 5000."),
			hosts: Type.Optional(Type.Array(Type.String(), { description: "vhost mode only: explicit Host header candidate values." })),
			baseDomain: Type.Optional(Type.String({ description: "vhost mode only: base domain used to expand words as word.baseDomain." })),
			template: Type.Optional(Type.String({ description: "vhost mode only: host template containing FUZZ, e.g. FUZZ.example.test." })),
			baselineHost: Type.Optional(Type.String({ description: "vhost mode only: baseline Host header; default is a generated invalid-looking host." })),
			baselineHosts: Type.Optional(Type.Array(Type.String(), { description: "vhost mode only: additional baseline Host header values for wildcard response clustering." })),
			sniMode: enumParam(["target", "host", "custom", "none"], "vhost mode only: HTTPS SNI mode: target | host | custom | none. Default target."),
			sniName: Type.Optional(Type.String({ description: "vhost mode only: custom HTTPS SNI servername when needed." })),
			rawRequest: Type.Optional(Type.String({ description: "param mode only: raw HTTP request text used as the fuzz template." })),
			request: Type.Optional(Type.Object({}, { additionalProperties: true, description: "param mode only: captured request-like object from browser_network/HAR." })),
			body: Type.Optional(Type.String({ description: "param mode only: text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "param mode only: base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Object({}, { additionalProperties: true, description: "param mode only: base mutation object with url, method, headers, body, bodyBase64, or multipart." })),
			locations: fuzzLocationParam("param mode only: parameter locations: query, json, form, multipart, header, or all."),
			paramNames: Type.Optional(Type.Array(Type.String(), { description: "param mode only: parameter names to fuzz." })),
			values: Type.Optional(Type.Array(Type.String(), { description: "param mode only: candidate values to assign to each parameter." })),
			jsonValues: Type.Optional(Type.Object({}, { additionalProperties: true, description: "param mode only: JSON values for JSON or multipart parameter fuzzing." })),
			operations: Type.Optional(Type.Array(Type.String(), { description: "param mode only: parameter operations: set, add, delete. Default set." })),
			contentTypeVariants: Type.Optional(Type.Array(Type.String(), { description: "param mode only: multipart Content-Type variants: normal, quoted, missing-boundary, mismatch." })),
			...maxCasesParam("param mode only: maximum location*param*operation*value cases; default 500, hard-capped at 5000."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = normalizeWebSecurityToolParams<FuzzToolParams>(params);
			const mode = String(current.mode || "path").toLowerCase() === "vhost" ? "vhost" : String(current.mode || "path").toLowerCase() === "param" ? "param" : "path";
			validateFuzzParams(mode, current);

			// Runtime validation for structured object parameters
			if (current.request !== undefined) {
				validateOptionalParams(HttpRequestSchema, current.request);
			}
			if (current.mutations !== undefined) {
				validateOptionalParams(FuzzMutationsSchema, current.mutations);
			}
			if (current.jsonValues !== undefined) {
				validateOptionalParams(JsonValuesSchema, current.jsonValues);
			}

			if (mode === "vhost") {
				return executeWebSecurityToolShell(ensureStarted, current, ctx, {
					toolName: "browser_fuzz",
					command: "web.fuzz_vhosts",
					fallbackPrefix: "fuzz-vhosts",
					defaultMaxBodyBytes: 128_000,
					includeCookieProvider: true,
					run: runFuzzVhosts,
					details: (result) => ({ mode: "vhost", requestCount: result.requestCount, matchedCount: result.matchedCount }),
					distill: summarizeFuzzVhostsData,
				}, _onUpdate);
			}
			if (mode === "param") {
				return executeWebSecurityToolShell(ensureStarted, current, ctx, {
					toolName: "browser_fuzz",
					command: "web.fuzz_params",
					fallbackPrefix: "fuzz-params",
					defaultMaxBodyBytes: 128_000,
					includeCookieProvider: true,
					augmentParams: (value) => ({ followRedirects: resolveBooleanParam(value.followRedirects, false) }),
					run: runFuzzParams,
					details: (result) => ({ mode: "param", caseCount: result.caseCount, matchedCount: result.matchedCount }),
					distill: summarizeFuzzParamsData,
				}, _onUpdate);
			}
			return executeWebSecurityToolShell(ensureStarted, current, ctx, {
				toolName: "browser_fuzz",
				command: "web.fuzz_paths",
				fallbackPrefix: "fuzz-paths",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				run: runFuzzPaths,
				details: (result) => ({ mode: "path", requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeFuzzPathsData,
			}, _onUpdate);
		},
	});
}
