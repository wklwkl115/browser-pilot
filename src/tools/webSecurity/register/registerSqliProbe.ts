import { Type } from "typebox";
import { summarizeSqliProbeData } from "../../summaries/index";
import { runSqliProbe } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, executeWebSecurityToolShell, resolveBooleanParam, sharedWebSecurityParams, normalizeWebSecurityToolParams, type SqliProbeToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerSqliProbeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_sqli_probe",
		label: "Browser SQLi Probe",
		description: "Run SQL injection oracle probes from URL/raw/captured request templates with boolean, error, time, and union evidence.",
		promptSnippet: "Probe SQLi boolean/error/time/union oracles from scoped HTTP request templates with structured evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_sqli_probe from a captured or raw request template for SQLi oracle evidence; keep param names, probe types, and maxCases bounded, and retain outputPath/artifact evidence for follow-up judgment."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Absolute URL or host/path target. Required unless rawRequest or request supplies a URL." })),
			baseUrl: Type.Optional(Type.String({ description: "Base URL for relative raw request targets." })),
			rawRequest: Type.Optional(Type.String({ description: "Raw HTTP request text used as the probe template." })),
			request: Type.Optional(Type.Any({ description: "Captured request-like object from browser_network/HAR." })),
			method: Type.Optional(Type.String({ description: "Override HTTP method." })),
			headers: Type.Optional(Type.Any({ description: "Headers to merge or override on the template." })),
			body: Type.Optional(Type.String({ description: "Text request body override." })),
			bodyBase64: Type.Optional(Type.String({ description: "Base64 request body override for binary-ish payloads." })),
			mutations: Type.Optional(Type.Any({ description: "Optional base mutation object with url, method, headers, body, or bodyBase64." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			locations: Type.Optional(Type.Any({ description: "Parameter locations: query, json, form, header, or all. Default inferred from template." })),
			paramNames: Type.Optional(Type.Array(Type.String(), { description: "Parameter names to probe. If omitted, existing template params are used." })),
			probeTypes: Type.Optional(Type.Any({ description: "Probe families: boolean, error, time, union, or all. Default all." })),
			payloadMode: Type.Optional(Type.String({ description: "append | replace. Default append." })),
			dbms: Type.Optional(Type.Any({ description: "Optional DBMS payload pack: mysql, postgresql, sqlite, mssql, oracle, or comma/array combination." })),
			booleanPayloadPairs: Type.Optional(Type.Any({ description: "Boolean payload pairs as objects with truePayload/falsePayload or strings separated by ||, =>, or comma." })),
			errorPayloads: Type.Optional(Type.Array(Type.String(), { description: "Error oracle payloads." })),
			timePayloads: Type.Optional(Type.Array(Type.String(), { description: "Time oracle payloads." })),
			unionPayloads: Type.Optional(Type.Array(Type.String(), { description: "Union/order payloads. If omitted, ORDER BY and UNION SELECT payloads are generated." })),
			unionEcho: Type.Optional(Type.Boolean({ description: "Enumerate reflected UNION SELECT column positions when column count hints are available; default true." })),
			orderByMax: Type.Optional(Type.Number({ description: "Maximum ORDER BY index for generated union probes; default 3, hard-capped at 64." })),
			unionColumnMax: Type.Optional(Type.Number({ description: "Maximum UNION SELECT column count for generated probes; default 3, hard-capped at 64." })),
			extractExpression: Type.Optional(Type.String({ description: "Optional SQL expression for boolean-blind character extraction." })),
			extractMaxLength: Type.Optional(Type.Number({ description: "Maximum extracted characters; default 32, hard-capped at 256." })),
			extractCharset: Type.Optional(Type.String({ description: "Candidate charset for boolean-blind extraction." })),
			payloads: Type.Optional(Type.Array(Type.String(), { description: "Additional payloads appended to error probes." })),
			timeThresholdMs: Type.Optional(Type.Number({ description: "Elapsed-time delta threshold for time oracle matches; default 2000." })),
			baselineRepeats: Type.Optional(Type.Number({ description: "Baseline request repetitions; default 1, hard-capped at 10." })),
			stopOnFirstMatch: Type.Optional(Type.Boolean({ description: "Stop probing a confirmed vulnerable parameter after the first oracle match; default false." })),
			followRedirects: Type.Optional(Type.Boolean({ description: "Follow redirects; default false." })),
			maxRedirects: Type.Optional(Type.Number({ description: "Maximum redirects when followRedirects is true; default 3." })),
			maxCases: Type.Optional(Type.Number({ description: "Maximum probe cases; default 100, hard-capped at 5000." })),
			rateLimitPerSecond: Type.Optional(Type.Number({ description: "Sequential request rate cap per second; default unlimited sequential." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Merge browser cookies for request URLs; default false." })),
			cookieMode: Type.Optional(Type.String({ description: "merge | replace | preserve for browser cookie binding; default merge." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<SqliProbeToolParams>(params), ctx, {
				toolName: "browser_sqli_probe",
				command: "web.sqli_probe",
				fallbackPrefix: "sqli-probe",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, false) }),
				run: runSqliProbe,
				details: (result) => ({ requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeSqliProbeData,
			});
		},
	});
}
