import { Type } from "typebox";
import { summarizeCookieAnalyzeData } from "../../summaries/index.js";
import { runCookieAnalyze } from "../browserNative/cookieAnalyze.js";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, sharedWebSecurityBrowserSessionParams, normalizeWebSecurityToolParams, type CookieAnalyzeToolParams } from "./shared.js";
import type { CommandRegistrarContext } from "../../commandShared.js";
import { strictCommandParameters } from "../../commandShared.js";
import { validateOptionalParams } from "../../validationMiddleware.js";
import { CookiesInputSchema, ClaimMutationsSchema } from "../../../validation/schemas.js";

export function defineCookieAnalyzeCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	commands.define({
		name: "browser_cookie_analyze",
		label: "Browser Cookie Analyze",
		description: "Analyze Cookie, Set-Cookie, JWT, JWE, PASETO, and signed or encrypted session values with decoding, signature/decryption checks, claim mutation generation, claim replay validation, browser-session cookie binding, and Rails AES-GCM/AES-CBC/direct-key evidence.",
		promptSnippet: "Analyze cookies/JWT/session values, verify signing or decryption candidates, generate claim-mutation tokens, validate claim replays, and store structured evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_cookie_analyze for cookie/JWT/JWE/PASETO/session decoding, signature or decryption candidate checks, Rails AES-GCM/AES-CBC/direct-key evidence, claim mutation generation, browser-session cookie collection, bounded claim replay validation, and returned saved.path artifacts for follow-up evidence.", "HTTP target execution for optional claim replay uses Node.js fetch directly, not the browser bridge; requests originate from the Node.js process with optional browser-session cookie injection."],
		parameters: strictCommandParameters({
			...sharedWebSecurityBrowserSessionParams("Timeout in milliseconds for browser-session cookie collection."),
			url: Type.Optional(Type.String({ description: "URL used when bindBrowserSession collects browser cookies for HTTP request injection." })),
			cookie: Type.Optional(Type.String({ description: "Single Cookie header, Set-Cookie line, or name=value string." })),
			cookies: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String()), Type.Array(Type.Object({}, { additionalProperties: true })), Type.Record(Type.String(), Type.String())], { description: "Cookie header string, array of strings, or browser-cookie-like objects with name/value." })),
			setCookie: Type.Optional(Type.String({ description: "Single Set-Cookie header line." })),
			setCookies: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Set-Cookie header string or array of Set-Cookie lines." })),
			jwt: Type.Optional(Type.String({ description: "Single JWT value." })),
			jwts: Type.Optional(Type.Array(Type.String(), { description: "JWT values." })),
			values: Type.Optional(Type.Array(Type.String(), { description: "Raw cookie/session values to analyze." })),
			secretCandidates: Type.Optional(Type.Array(Type.String(), { description: "HMAC secret candidates for HS256/HS384/HS512 verification." })),
			secrets: Type.Optional(Type.Array(Type.String(), { description: "Alias for secretCandidates." })),
			wordlist: Type.Optional(Type.Array(Type.String(), { description: "Inline HMAC secret candidate wordlist." })),
			wordlistPath: Type.Optional(Type.String({ description: "Local HMAC secret candidate wordlist file path; one entry per line." })),
			maxSecretCandidates: Type.Optional(Type.Number({ description: "Maximum HMAC secret candidates to test; default 10000, hard-capped at 100000." })),
			claimMutations: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Claims to merge into decoded JWT/JWE/session payloads when generating a mutated token." })),
			claimReplay: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional bounded replay check for generated claim mutations. Supports url, method, headers, body/bodyBase64, cookieName, matchStatus, maxCases, followRedirects, timeoutMs, maxBodyBytes, and allowPrivateTargets." })),
			allowPrivateTargets: Type.Optional(Type.Boolean({ description: "Allow claimReplay requests to private, link-local, or cloud-metadata-adjacent targets. Default false; loopback remains allowed for local fixtures." })),
			...browserCookieBindingParams("Collect browser cookies for URL-scoped HTTP request injection using the connected browser session; default false.", { includeCookieMode: false }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = normalizeWebSecurityToolParams<CookieAnalyzeToolParams>(params);

			// Runtime validation for structured object parameters
			if (current.cookies !== undefined) {
				validateOptionalParams(CookiesInputSchema, current.cookies);
			}
			if (current.setCookies !== undefined) {
				validateOptionalParams(CookiesInputSchema, current.setCookies);
			}
			if (current.claimMutations !== undefined) {
				validateOptionalParams(ClaimMutationsSchema, current.claimMutations);
			}
			if (current.claimReplay !== undefined) {
				// claimReplay is a complex object with many optional fields, validate as generic object
				validateOptionalParams(ClaimMutationsSchema, current.claimReplay);
			}

			return executeWebSecurityToolShell(ensureStarted, current, ctx, {
				commandName: "browser_cookie_analyze",
				command: "web.cookie_analyze",
				fallbackPrefix: "cookie-analyze",
				includeCookieProvider: true,
				run: runCookieAnalyze,
				details: (result) => ({ inputCount: result.inputCount, tokenCount: result.tokenCount, claimReplayCount: result.claimReplayCount }),
				distill: summarizeCookieAnalyzeData,
			}, _onUpdate);
		},
	});
}
