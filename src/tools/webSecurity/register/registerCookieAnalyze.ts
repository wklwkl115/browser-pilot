import { Type } from "typebox";
import { summarizeCookieAnalyzeData } from "../../summaries/index";
import { runCookieAnalyze } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, executeWebSecurityToolShell, sharedWebSecurityBrowserSessionParams, normalizeWebSecurityToolParams, type CookieAnalyzeToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerCookieAnalyzeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_cookie_analyze",
		label: "Browser Cookie Analyze",
		description: "Analyze Cookie, Set-Cookie, JWT, JWE, PASETO, and signed or encrypted session values with decoding, signature/decryption checks, claim mutation generation, claim replay validation, browser-session cookie binding, and Rails AES-GCM/AES-CBC/direct-key evidence.",
		promptSnippet: "Analyze cookies/JWT/session values, verify signing or decryption candidates, generate claim-mutation tokens, validate claim replays, and store structured evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_cookie_analyze for cookie/JWT/JWE/PASETO/session decoding, signature or decryption candidate checks, Rails AES-GCM/AES-CBC/direct-key evidence, claim mutation generation, browser-session cookie collection, bounded claim replay validation, and outputPath artifacts for follow-up evidence."],
		parameters: Type.Object({
			...sharedWebSecurityBrowserSessionParams("Timeout in milliseconds for browser-session cookie collection."),
			url: Type.Optional(Type.String({ description: "URL used when bindBrowserSession collects browser cookies." })),
			cookie: Type.Optional(Type.String({ description: "Single Cookie header, Set-Cookie line, or name=value string." })),
			cookies: Type.Optional(Type.Any({ description: "Cookie header string, array of strings, or browser-cookie-like objects with name/value." })),
			setCookie: Type.Optional(Type.String({ description: "Single Set-Cookie header line." })),
			setCookies: Type.Optional(Type.Any({ description: "Set-Cookie header string or array of Set-Cookie lines." })),
			jwt: Type.Optional(Type.String({ description: "Single JWT value." })),
			jwts: Type.Optional(Type.Array(Type.String(), { description: "JWT values." })),
			values: Type.Optional(Type.Array(Type.String(), { description: "Raw cookie/session values to analyze." })),
			secretCandidates: Type.Optional(Type.Array(Type.String(), { description: "HMAC secret candidates for HS256/HS384/HS512 verification." })),
			secrets: Type.Optional(Type.Array(Type.String(), { description: "Alias for secretCandidates." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline HMAC secret candidate wordlist." })),
			wordlistPath: Type.Optional(Type.String({ description: "Local HMAC secret candidate wordlist file path; one entry per line." })),
			maxSecretCandidates: Type.Optional(Type.Number({ description: "Maximum HMAC secret candidates to test; default 10000, hard-capped at 100000." })),
			claimMutations: Type.Optional(Type.Any({ description: "Claims to merge into decoded JWT/JWE/session payloads when generating a mutated token." })),
			claimReplay: Type.Optional(Type.Any({ description: "Optional bounded replay check for generated claim mutations. Supports url, method, headers, body/bodyBase64, cookieName, matchStatus, maxCases, followRedirects, timeoutMs, and maxBodyBytes." })),
			bindBrowserSession: Type.Optional(Type.Boolean({ description: "Collect browser cookies for url using the connected browser session; default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<CookieAnalyzeToolParams>(params), ctx, {
				toolName: "browser_cookie_analyze",
				command: "web.cookie_analyze",
				fallbackPrefix: "cookie-analyze",
				includeCookieProvider: true,
				run: runCookieAnalyze,
				details: (result) => ({ inputCount: result.inputCount, tokenCount: result.tokenCount, claimReplayCount: result.claimReplayCount }),
				distill: summarizeCookieAnalyzeData,
			});
		},
	});
}
