import { Type } from "typebox";
import { summarizeCallbackOastData } from "../../summaries/index";
import { runCallbackOast } from "../../webSecurityCore";
import { executeWebSecurityToolShell, sharedWebSecurityResultParams, normalizeWebSecurityToolParams, type CallbackOastToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerCallbackOastTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_callback_oast",
		label: "Browser Callback OAST",
		description: "Run local HTTP/HTTPS/DNS callback listeners with correlation IDs, trigger helpers, persisted events, and external callback metadata.",
		promptSnippet: "Start, inspect, trigger, collect, clear, or stop callback listener sessions for SSRF, blind injection, and deserialization evidence.",
		promptGuidelines: ["Use browser_callback_oast to create callback URLs/hosts, trigger and collect correlated HTTP/HTTPS/DNS callbacks, keep maxEvents/maxBodyBytes bounded, and archive persisted callback evidence artifacts."],
		parameters: Type.Object({
			action: Type.Optional(Type.String({ description: "start | list | status | collect | clear | trigger | stop. Default start." })),
			sessionId: Type.Optional(Type.String({ description: "Logical callback listener session id. Required for status/collect/clear/trigger/stop." })),
			listenHost: Type.Optional(Type.String({ description: "Local listen host; default 127.0.0.1. Use 0.0.0.0 to listen on all interfaces." })),
			port: Type.Optional(Type.Number({ description: "Local HTTP listen port; default 0 chooses an ephemeral port." })),
			publicBaseUrl: Type.Optional(Type.String({ description: "Optional externally reachable HTTP base URL to combine with the generated callback path." })),
			publicHttpsBaseUrl: Type.Optional(Type.String({ description: "Optional externally reachable HTTPS base URL to combine with the generated callback path." })),
			basePath: Type.Optional(Type.String({ description: "Callback path template. {{correlationId}} is replaced; default /__pi_oast/{{correlationId}}." })),
			correlationId: Type.Optional(Type.String({ description: "Correlation id to embed in generated callback URLs/hosts; default random." })),
			responseStatus: Type.Optional(Type.Number({ description: "HTTP/HTTPS status returned by the callback listener; default 200." })),
			responseBody: Type.Optional(Type.String({ description: "HTTP/HTTPS response body returned by the callback listener; default ok." })),
			responseHeaders: Type.Optional(Type.Any({ description: "HTTP/HTTPS response headers returned by the callback listener." })),
			enableHttps: Type.Optional(Type.Boolean({ description: "Also start a local HTTPS callback listener with a self-signed certificate." })),
			httpsPort: Type.Optional(Type.Number({ description: "Local HTTPS listen port; default 0 chooses an ephemeral port." })),
			enableDns: Type.Optional(Type.Boolean({ description: "Also start a local UDP DNS callback listener." })),
			dnsListenHost: Type.Optional(Type.String({ description: "Local DNS listen host; defaults to listenHost." })),
			dnsPort: Type.Optional(Type.Number({ description: "Local DNS listen port; default 0 chooses an ephemeral port." })),
			dnsBaseDomain: Type.Optional(Type.String({ description: "Generated DNS callback base domain used for dnsCallbackHost, e.g. oast.test." })),
			publicDnsBaseDomain: Type.Optional(Type.String({ description: "Optional externally reachable DNS base domain used for publicDnsCallbackHost." })),
			dnsResponseAddress: Type.Optional(Type.String({ description: "IPv4 address returned for A queries handled by the local DNS listener; default 127.0.0.1." })),
			externalMetadata: Type.Optional(Type.Any({ description: "Optional external tunnel/provider metadata stored with the session and returned in status/list results." })),
			mode: Type.Optional(Type.String({ description: "trigger only: http | https | dns. Default http." })),
			target: Type.Optional(Type.String({ description: "trigger only: explicit target URL or DNS name; otherwise the current session callback URL/host is used." })),
			method: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS method; default POST." })),
			requestHeaders: Type.Optional(Type.Any({ description: "trigger only: HTTP/HTTPS request headers." })),
			body: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS text body." })),
			bodyBase64: Type.Optional(Type.String({ description: "trigger only: HTTP/HTTPS base64 body for binary-ish payloads." })),
			queryName: Type.Optional(Type.String({ description: "trigger only: DNS query name override; aliases target for dns mode." })),
			queryType: Type.Optional(Type.String({ description: "trigger only: DNS query type; default A." })),
			resolverHost: Type.Optional(Type.String({ description: "trigger only: DNS resolver host override; defaults to the current session DNS listener host." })),
			resolverPort: Type.Optional(Type.Number({ description: "trigger only: DNS resolver port override; defaults to the current session DNS listener port." })),
			rejectUnauthorized: Type.Optional(Type.Boolean({ description: "trigger only: HTTPS certificate verification flag. Default false for the local self-signed listener." })),
			maxEvents: Type.Optional(Type.Number({ description: "Maximum persisted callback events per session; default 1000, hard-capped at 100000." })),
			maxBodyBytes: Type.Optional(Type.Number({ description: "Maximum request body bytes stored per callback event; default 64000." })),
			afterSeq: Type.Optional(Type.Number({ description: "collect only: return callback events with seq greater than this value." })),
			timeoutMs: Type.Optional(Type.Number({ description: "trigger only: wait timeout in milliseconds for the triggered callback event to be persisted." })),
			...sharedWebSecurityResultParams(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<CallbackOastToolParams>(params), ctx, {
				toolName: "browser_callback_oast",
				command: "web.callback_oast",
				fallbackPrefix: "callback-oast",
				includeTimeout: true,
				includeCookieProvider: false,
				run: runCallbackOast,
				details: (result) => ({ action: result.action, sessionId: result.sessionId, eventCount: result.eventCount ?? result.count }),
				distill: summarizeCallbackOastData,
			});
		},
	});
}
