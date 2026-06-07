import { Type } from "typebox";
import { summarizeCallbackOastData } from "../../summaries/index.js";
import { runCallbackOast } from "../../webSecurityCore.js";
import { executeWebSecurityToolShell, sharedWebSecurityResultParams, normalizeWebSecurityToolParams, validateOastParams, headerRecordParam, type CallbackOastToolParams } from "./shared.js";
import type { ToolRegistrarContext } from "../../toolShared.js";
import { strictToolParameters } from "../../toolShared.js";

export function registerCallbackOastTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_callback_oast",
		label: "Browser Callback OAST",
		description: "Run local HTTP/HTTPS/DNS callback listeners with correlation IDs, trigger helpers, persisted events, and external callback metadata.",
		promptSnippet: "Start, inspect, trigger, collect, clear, or stop callback listener sessions for SSRF, blind injection, and deserialization evidence.",
		promptGuidelines: ["Use browser_callback_oast to create callback URLs/hosts, trigger and collect correlated HTTP/HTTPS/DNS callbacks, keep maxEvents/maxBodyBytes bounded, and archive persisted callback evidence artifacts.", "HTTP target execution for callback trigger helpers uses Node.js fetch directly, not the browser bridge; requests originate from the Node.js process with optional browser-session cookie injection."],
		parameters: strictToolParameters({
			action: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("status"), Type.Literal("collect"), Type.Literal("clear"), Type.Literal("trigger"), Type.Literal("stop")], { description: "start | list | status | collect | clear | trigger | stop. Default start." })),
			sessionId: Type.Optional(Type.String({ description: "Logical callback listener session id. Required for status/collect/clear/trigger/stop." })),
			listenHost: Type.Optional(Type.String({ description: "Local listen host; default 127.0.0.1. Use 0.0.0.0 to listen on all interfaces." })),
			port: Type.Optional(Type.Number({ description: "Local HTTP listen port; default 0 chooses an ephemeral port." })),
			publicBaseUrl: Type.Optional(Type.String({ description: "Optional externally reachable HTTP base URL to combine with the generated callback path." })),
			publicHttpsBaseUrl: Type.Optional(Type.String({ description: "Optional externally reachable HTTPS base URL to combine with the generated callback path." })),
			basePath: Type.Optional(Type.String({ description: "Callback path template. {{correlationId}} is replaced; default /__pi_oast/{{correlationId}}." })),
			correlationId: Type.Optional(Type.String({ description: "Correlation id to embed in generated callback URLs/hosts; default random." })),
			responseStatus: Type.Optional(Type.Number({ description: "HTTP/HTTPS status returned by the callback listener; default 200." })),
			responseBody: Type.Optional(Type.String({ description: "HTTP/HTTPS response body returned by the callback listener; default ok." })),
			responseHeaders: headerRecordParam("HTTP/HTTPS response headers returned by the callback listener."),
			enableHttps: Type.Optional(Type.Boolean({ description: "Also start a local HTTPS callback listener with a self-signed certificate." })),
			httpsPort: Type.Optional(Type.Number({ description: "Local HTTPS listen port; default 0 chooses an ephemeral port." })),
			enableDns: Type.Optional(Type.Boolean({ description: "Also start a local UDP DNS callback listener." })),
			dnsListenHost: Type.Optional(Type.String({ description: "Local DNS listen host; defaults to listenHost." })),
			dnsPort: Type.Optional(Type.Number({ description: "Local DNS listen port; default 0 chooses an ephemeral port." })),
			dnsBaseDomain: Type.Optional(Type.String({ description: "Generated DNS callback base domain used for dnsCallbackHost, e.g. oast.test." })),
			publicDnsBaseDomain: Type.Optional(Type.String({ description: "Optional externally reachable DNS base domain used for publicDnsCallbackHost." })),
			dnsResponseAddress: Type.Optional(Type.String({ description: "IPv4 address returned for A queries handled by the local DNS listener; default 127.0.0.1." })),
			externalMetadata: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional external tunnel/provider metadata stored with the session and returned in status/list results." })),
			mode: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("https"), Type.Literal("dns")], { description: "trigger only: http | https | dns. Default http." })),
			target: Type.Optional(Type.String({ description: "trigger only: explicit target URL or DNS name; otherwise the current session callback URL/host is used." })),
			method: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS method; default POST." })),
			requestHeaders: headerRecordParam("trigger only: HTTP/HTTPS request headers."),
			body: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS text body." })),
			bodyBase64: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS base64 body for binary-ish payloads." })),
			queryName: Type.Optional(Type.String({ description: "trigger only: DNS query name override; aliases target for dns mode." })),
			queryType: Type.Optional(Type.String({ description: "trigger only: DNS query type; default A." })),
			resolverHost: Type.Optional(Type.String({ description: "trigger only: DNS resolver host override; defaults to the current session DNS listener host." })),
			resolverPort: Type.Optional(Type.Number({ description: "trigger only: DNS resolver port override; defaults to the current session DNS listener port." })),
			rejectUnauthorized: Type.Optional(Type.Boolean({ description: "trigger only: HTTPS certificate verification flag. Default false for the local self-signed listener." })),
			maxEvents: Type.Optional(Type.Number({ description: "Maximum persisted callback events per session; default 1000, hard-capped at 100000." })),
			maxRuntimeMs: Type.Optional(Type.Number({ description: "Maximum worker lifetime in milliseconds before the local callback listener self-stops; default 3600000, hard-capped at 86400000." })),
			afterSeq: Type.Optional(Type.Number({ description: "collect only: return callback events with seq greater than this value." })),
			triggerTimeoutMs: Type.Optional(Type.Number({ description: "trigger only: wait timeout in milliseconds for the triggered callback event to be persisted." })),
			...sharedWebSecurityResultParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = normalizeWebSecurityToolParams<CallbackOastToolParams>(params);
			const action = String(current.action || "start").toLowerCase();
			validateOastParams(action, current);
			return executeWebSecurityToolShell(ensureStarted, current, ctx, {
				toolName: "browser_callback_oast",
				command: "web.callback_oast",
				fallbackPrefix: "callback-oast",
				includeTimeout: false,
				includeCookieProvider: false,
				augmentParams: (input) => ({ timeoutMs: typeof input.triggerTimeoutMs === "number" ? input.triggerTimeoutMs : input.timeoutMs }),
				run: runCallbackOast,
				details: (result) => ({
					action: result.action,
					sessionId: "sessionId" in result ? result.sessionId : undefined,
					eventCount: "eventCount" in result ? result.eventCount : result.count,
				}),
				distill: summarizeCallbackOastData,
			}, _onUpdate);
		},
	});
}
