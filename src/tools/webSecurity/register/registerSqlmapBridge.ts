import { Type } from "typebox";
import { summarizeSqlmapBridgeData } from "../../summaries/index";
import { runSqlmapBridge } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, boundedExecutionParams, browserCookieBindingParams, executeWebSecurityToolShell, harReplayParams, rawRequestParams, requestSequenceParams, sharedWebSecurityBrowserSessionParams, normalizeWebSecurityToolParams, type SqlmapBridgeToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerSqlmapBridgeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_sqlmap_bridge",
		label: "Browser SQLMap Bridge",
		description: "Run deep SQL injection automation through a sqlmap bridge from URL, raw, captured, or HAR request inputs with structured findings and artifacts.",
		promptSnippet: "Run a Pi-native sqlmap bridge for deep SQLi automation with structured findings and artifacts.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_sqlmap_bridge for deep SQLi automation from explicit scoped request templates; keep bounded target scope explicit and retain request/stdout/stderr artifacts for follow-up evidence."],
		parameters: Type.Object({
			...sharedWebSecurityBrowserSessionParams("Process timeout in milliseconds; default 120000."),
			sqlmapPath: Type.Optional(Type.String({ description: "Optional sqlmap executable or launcher command. Default auto-detects sqlmap in PATH or python -m sqlmap." })),
			sqlmapArgs: Type.Optional(Type.Array(Type.String(), { description: "Optional launcher arguments prepended before generated sqlmap flags, e.g. [-m, sqlmap]." })),
			extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Additional sqlmap CLI arguments appended after generated flags." })),
			...rawRequestParams({
				urlDescription: "Absolute URL or host/path target. Required unless rawRequest, request, requests, sequence, or HAR input supplies a target.",
				rawRequestDescription: "Raw HTTP request text used as the sqlmap request template.",
				requestDescription: "Captured request-like object from browser_network/HAR.",
				headersDescription: "Headers to merge or override on the template.",
				mutationsDescription: "Optional base mutation object with url, method, headers, body, or bodyBase64.",
			}),
			...harReplayParams({
				harDescription: "HAR object; selected entries are replayed as sqlmap bridge targets.",
				harPathDescription: "Local HAR JSON file path; selected entries are replayed as sqlmap bridge targets.",
			}),
			...requestSequenceParams({
				requestsDescription: "Request sequence entries: raw request strings, captured requests, HAR entries, or replay option objects. Each selected entry is sent to sqlmap as a separate target.",
				sequenceDescription: "Alias for requests; each selected entry is sent to sqlmap as a separate target.",
			}),
			paramNames: Type.Optional(Type.Array(Type.String(), { description: "Optional parameter names passed to sqlmap -p." })),
			technique: Type.Optional(Type.String({ description: "Optional sqlmap technique letters, e.g. BEUSTQ or B,U." })),
			dbms: Type.Optional(Type.String({ description: "Optional backend DBMS hint passed to sqlmap --dbms." })),
			level: Type.Optional(Type.Number({ description: "sqlmap --level; default 1, clamped to 1-5." })),
			risk: Type.Optional(Type.Number({ description: "sqlmap --risk; default 1, clamped to 1-3." })),
			threads: Type.Optional(Type.Number({ description: "sqlmap --threads; default 1, clamped to 1-10." })),
			...boundedExecutionParams({ timeoutSecondsDescription: "sqlmap per-request timeout seconds; default derived from timeoutMs." }),
			retries: Type.Optional(Type.Number({ description: "sqlmap --retries; default 3." })),
			batch: Type.Optional(Type.Boolean({ description: "Run sqlmap in batch mode; default true." })),
			flushSession: Type.Optional(Type.Boolean({ description: "Pass --flush-session before testing; default false." })),
			answers: Type.Optional(Type.String({ description: "Optional sqlmap --answers string for scripted prompts." })),
			currentDb: Type.Optional(Type.Boolean({ description: "Request current database metadata via --current-db." })),
			currentUser: Type.Optional(Type.Boolean({ description: "Request current user metadata via --current-user." })),
			isDba: Type.Optional(Type.Boolean({ description: "Request DBA capability metadata via --is-dba." })),
			banner: Type.Optional(Type.Boolean({ description: "Request DBMS banner metadata via --banner." })),
			tamper: Type.Optional(Type.Any({ description: "Optional sqlmap tamper script list or comma string passed to --tamper." })),
			...browserCookieBindingParams("Merge browser cookies for request URLs; default false."),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<SqlmapBridgeToolParams>(params), ctx, {
				toolName: "browser_sqlmap_bridge",
				command: "web.sqlmap_bridge",
				fallbackPrefix: "sqlmap-bridge",
				defaultTimeoutMs: 120_000,
				includeCookieProvider: true,
				run: runSqlmapBridge,
				details: (result) => ({ runCount: result.runCount, findingCount: result.findingCount, vulnerableRunCount: result.vulnerableRunCount }),
				distill: summarizeSqlmapBridgeData,
			});
		},
	});
}
