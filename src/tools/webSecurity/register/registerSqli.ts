import { Type } from "typebox";
import { summarizeSqlmapBridgeData, summarizeSqliProbeData } from "../../summaries/index.js";
import { runSqlmapBridge, runSqliProbe } from "../../webSecurityCore.js";
import { TAB_SCOPED_TOOL_GUIDELINE, boundedExecutionParams, browserCookieBindingParams, executeWebSecurityToolShell, harReplayParams, maxCasesParam, rawRequestParams, rateLimitPerSecondParam, redirectControlParams, requestSequenceParams, resolveBooleanParam, sharedWebSecurityBrowserSessionParams, sharedWebSecurityParams, normalizeWebSecurityToolParams, validateSqliParams, sqliProbeTypesParam, fuzzLocationParam, webSecurityDefaultSchemeParam, enumParam, stringOrStringArrayParam, type WebSecuritySharedToolParams } from "./shared.js";
import type { ToolRegistrarContext } from "../../toolShared.js";
import { strictToolParameters } from "../../toolShared.js";
import type { RawSqlmapBridgeOptions, RawSqliProbeOptions } from "../shared/types.js";
import { validateOptionalParams } from "../../../validation/middleware.js";
import { HttpRequestSchema, FuzzMutationsSchema } from "../../../validation/schemas.js";

type SqliToolParams = WebSecuritySharedToolParams & RawSqliProbeOptions & RawSqlmapBridgeOptions & { engine?: unknown };

export function registerSqliTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_sqli",
		label: "Browser SQLi",
		description: "Probe SQL injection or run bounded sqlmap automation from explicit scoped request templates with boolean/error/time/union evidence, mature-engine findings, and artifacts.",
		promptSnippet: "Probe SQL injection or run bounded sqlmap automation from explicit scoped request templates with structured evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_sqli from a captured or raw request template for SQLi oracle evidence. engine:builtin is the default lightweight probe path; engine:sqlmap is the deeper mature bridge path.", "HTTP target execution uses Node.js fetch directly, not the browser bridge; requests originate from the Node.js process with optional browser-session cookie injection."],
		parameters: strictToolParameters({
			engine: Type.Optional(Type.Union([Type.Literal("builtin"), Type.Literal("sqlmap")], { description: "Detection engine (default: builtin). builtin: lightweight probes; sqlmap: external binary." })),
			...sharedWebSecurityBrowserSessionParams("Process timeout in milliseconds; default 120000 for engine:sqlmap, per-request timeout for engine:builtin."),
			maxBodyBytes: Type.Optional(Type.Number({ description: "Maximum response body bytes stored per request before truncation; default 128000." })),
			allowPrivateTargets: Type.Optional(Type.Boolean({ description: "Allow requests to private, link-local, or cloud-metadata-adjacent targets. Default false; loopback remains allowed for local fixtures." })),
			...rawRequestParams({
				urlDescription: "Absolute URL or host/path target. Required unless rawRequest, request, requests, sequence, or HAR input supplies a target.",
				rawRequestDescription: "Raw HTTP request text used as the SQLi probe or sqlmap request template.",
				requestDescription: "Captured request-like object from browser_network/HAR.",
				headersDescription: "Headers to merge or override on the template.",
				mutationsDescription: "Optional base mutation object with url, method, headers, body, or bodyBase64.",
			}),
			...harReplayParams({
				harDescription: "engine:sqlmap only: HAR object; selected entries are replayed as sqlmap bridge targets.",
				harPathDescription: "engine:sqlmap only: local HAR JSON file path; selected entries are replayed as sqlmap bridge targets.",
			}),
			...requestSequenceParams({
				requestsDescription: "engine:sqlmap only: request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Each selected entry is sent to sqlmap as a separate target.",
				sequenceDescription: "engine:sqlmap only: alias for requests; each selected entry is sent to sqlmap as a separate target.",
			}),
			locations: fuzzLocationParam("engine:builtin only: parameter locations: query, json, form, header, or all. Default inferred from template."),
			paramNames: Type.Optional(Type.Array(Type.String(), { description: "Optional parameter names to probe or pass to sqlmap -p." })),
			probeTypes: sqliProbeTypesParam("engine:builtin only: probe families: boolean, error, time, union, or all. Default all."),
			payloadMode: enumParam(["append", "replace"], "engine:builtin only: append | replace. Default append."),
			dbms: stringOrStringArrayParam("Optional DBMS payload pack or sqlmap --dbms hint: mysql, postgresql, sqlite, mssql, oracle, or combinations."),
			booleanPayloadPairs: Type.Optional(Type.Union([
				Type.String(),
				Type.Array(Type.String()),
				Type.Object({}, { additionalProperties: true }),
				Type.Array(Type.Object({}, { additionalProperties: true })),
			], { description: "engine:builtin only: boolean payload pairs as objects with truePayload/falsePayload or strings separated by ||, =>, or comma." })),
			errorPayloads: Type.Optional(Type.Array(Type.String(), { description: "engine:builtin only: error oracle payloads." })),
			timePayloads: Type.Optional(Type.Array(Type.String(), { description: "engine:builtin only: time oracle payloads." })),
			unionPayloads: Type.Optional(Type.Array(Type.String(), { description: "engine:builtin only: union/order payloads." })),
			unionEcho: Type.Optional(Type.Boolean({ description: "engine:builtin only: enumerate reflected UNION SELECT column positions when hints are available; default true." })),
			orderByMax: Type.Optional(Type.Number({ description: "engine:builtin only: maximum ORDER BY index for generated union probes; default 3, hard-capped at 64." })),
			unionColumnMax: Type.Optional(Type.Number({ description: "engine:builtin only: maximum UNION SELECT column count for generated probes; default 3, hard-capped at 64." })),
			extractExpression: Type.Optional(Type.String({ description: "engine:builtin only: optional SQL expression for boolean-blind character extraction." })),
			extractMaxLength: Type.Optional(Type.Number({ description: "engine:builtin only: maximum extracted characters; default 32, hard-capped at 256." })),
			extractCharset: Type.Optional(Type.String({ description: "engine:builtin only: candidate charset for boolean-blind extraction." })),
			payloads: Type.Optional(Type.Array(Type.String(), { description: "engine:builtin only: additional payloads appended to error probes." })),
			timeThresholdMs: Type.Optional(Type.Number({ description: "engine:builtin only: elapsed-time delta threshold for time oracle matches; default 2000." })),
			baselineRepeats: Type.Optional(Type.Number({ description: "engine:builtin only: baseline request repetitions; default 1, hard-capped at 10." })),
			stopOnFirstMatch: Type.Optional(Type.Boolean({ description: "engine:builtin only: stop probing a confirmed vulnerable parameter after the first oracle match; default false." })),
			...redirectControlParams({
				followRedirectsDescription: "engine:builtin only: follow redirects; default false.",
				maxRedirectsDescription: "engine:builtin only: maximum redirects when followRedirects is true; default 3.",
			}),
			...maxCasesParam("engine:builtin only: maximum probe cases; default 100, hard-capped at 5000."),
			...rateLimitPerSecondParam("engine:builtin only: sequential request rate cap per second; default unlimited sequential."),
			sqlmapPath: Type.Optional(Type.String({ description: "engine:sqlmap only: optional sqlmap executable or launcher command. Default auto-detects sqlmap in PATH or python -m sqlmap." })),
			sqlmapArgs: Type.Optional(Type.Array(Type.String(), { description: "engine:sqlmap only: optional launcher arguments prepended before generated sqlmap flags." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "engine:sqlmap only: additional sqlmap CLI arguments appended after generated flags." })),
			allowLauncherOverride: Type.Optional(Type.Boolean({ description: "engine:sqlmap only: required when sqlmapPath or PI_SQLMAP_PATH overrides the auto-detected launcher. Default false." })),
			technique: Type.Optional(Type.String({ description: "engine:sqlmap only: sqlmap technique letters, e.g. BEUSTQ or B,U." })),
			level: Type.Optional(Type.Number({ description: "engine:sqlmap only: sqlmap --level; default 1, clamped to 1-5." })),
			risk: Type.Optional(Type.Number({ description: "engine:sqlmap only: sqlmap --risk; default 1, clamped to 1-3." })),
			threads: Type.Optional(Type.Number({ description: "engine:sqlmap only: sqlmap --threads; default 1, clamped to 1-10." })),
			...boundedExecutionParams({ timeoutSecondsDescription: "engine:sqlmap only: sqlmap per-request timeout seconds; default derived from timeoutMs." }),
			retries: Type.Optional(Type.Number({ description: "engine:sqlmap only: sqlmap --retries; default 3." })),
			batch: Type.Optional(Type.Boolean({ description: "engine:sqlmap only: run sqlmap in batch mode; default true." })),
			flushSession: Type.Optional(Type.Boolean({ description: "engine:sqlmap only: pass --flush-session before testing; default false." })),
			answers: Type.Optional(Type.String({ description: "engine:sqlmap only: optional sqlmap --answers string for scripted prompts." })),
			currentDb: Type.Optional(Type.Boolean({ description: "engine:sqlmap only: request current database metadata via --current-db." })),
			currentUser: Type.Optional(Type.Boolean({ description: "engine:sqlmap only: request current user metadata via --current-user." })),
			isDba: Type.Optional(Type.Boolean({ description: "engine:sqlmap only: request DBA capability metadata via --is-dba." })),
			banner: Type.Optional(Type.Boolean({ description: "engine:sqlmap only: request DBMS banner metadata via --banner." })),
			tamper: stringOrStringArrayParam("engine:sqlmap only: sqlmap tamper script list or comma string passed to --tamper."),
			...browserCookieBindingParams("Merge browser cookies into outgoing HTTP request headers for request URLs; default false."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = normalizeWebSecurityToolParams<SqliToolParams>(params);
			const engine = String(current.engine || "builtin").toLowerCase() === "sqlmap" ? "sqlmap" : "builtin";
			validateSqliParams(engine, current);
			if (current.request !== undefined) validateOptionalParams(HttpRequestSchema, current.request);
			if (current.mutations !== undefined) validateOptionalParams(FuzzMutationsSchema, current.mutations);
			if (engine === "sqlmap") {
				return executeWebSecurityToolShell(ensureStarted, current, ctx, {
					toolName: "browser_sqli",
					command: "web.sqlmap_bridge",
					fallbackPrefix: "sqlmap-bridge",
					defaultTimeoutMs: 120_000,
					includeCookieProvider: true,
					run: runSqlmapBridge,
					details: (result) => ({ engine: "sqlmap", runCount: result.runCount, findingCount: result.findingCount, vulnerableRunCount: result.vulnerableRunCount }),
					distill: summarizeSqlmapBridgeData,
				}, _onUpdate);
			}
			return executeWebSecurityToolShell(ensureStarted, current, ctx, {
				toolName: "browser_sqli",
				command: "web.sqli_probe",
				fallbackPrefix: "sqli-probe",
				defaultMaxBodyBytes: 128_000,
				includeCookieProvider: true,
				augmentParams: (value) => ({ followRedirects: resolveBooleanParam(value.followRedirects, false) }),
				run: runSqliProbe,
				details: (result) => ({ engine: "builtin", requestCount: result.requestCount, matchedCount: result.matchedCount }),
				distill: summarizeSqliProbeData,
			}, _onUpdate);
		},
	});
}
