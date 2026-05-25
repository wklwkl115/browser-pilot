import { Type } from "typebox";
import { summarizeWebReconProbeData } from "../../summaries/index";
import { runReconProbe } from "../../webSecurityCore";
import { TAB_SCOPED_TOOL_GUIDELINE, browserCookieBindingParams, executeWebSecurityToolShell, redirectControlParams, resolveBooleanParam, sharedWebSecurityParams, normalizeWebSecurityToolParams, type ReconProbeToolParams } from "./shared";
import type { ToolRegistrarContext } from "../../toolShared";

export function registerReconProbeTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_recon_probe",
		label: "Browser Recon Probe",
		description: "Probe scoped HTTP(S) URLs for status, title, headers, technology hints, redirect chains, and response artifacts.",
		promptSnippet: "Run controlled live URL probing for Web recon baselines and store response evidence.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_recon_probe for small scoped URL/path baselines before crawl/fuzz stages; keep urls/paths explicit and bounded."],
		parameters: Type.Object({
			...sharedWebSecurityParams(),
			url: Type.Optional(Type.String({ description: "Single target URL or host. Host-only input uses defaultScheme." })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Bounded list of target URLs or hosts." })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Optional paths to resolve against each target URL, e.g. /robots.txt." })),
			ports: Type.Optional(Type.Array(Type.Number(), { description: "Optional ports to apply to each target URL." })),
			schemes: Type.Optional(Type.Array(Type.String(), { description: "Optional schemes to expand, e.g. [http, https]." })),
			method: Type.Optional(Type.String({ description: "HTTP method for probing; default GET." })),
			headers: Type.Optional(Type.Any({ description: "Optional request headers object." })),
			defaultScheme: Type.Optional(Type.String({ description: "http | https for host-only input; default https." })),
			...redirectControlParams({
				followRedirectsDescription: "Follow redirects and record the chain; default true.",
				maxRedirectsDescription: "Maximum redirects per URL; default 5 when followRedirects is true.",
			}),
			includeFaviconHash: Type.Optional(Type.Boolean({ description: "Fetch /favicon.ico for each final origin and include favicon hash metadata; default false." })),
			includeTlsCertificate: Type.Optional(Type.Boolean({ description: "Inspect HTTPS peer certificate metadata for final URLs; default false." })),
			...browserCookieBindingParams("Attach browser cookies for each probed URL using the connected browser session; default false.", { includeCookieMode: false }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeWebSecurityToolShell(ensureStarted, normalizeWebSecurityToolParams<ReconProbeToolParams>(params), ctx, {
				toolName: "browser_recon_probe",
				command: "web.recon_probe",
				fallbackPrefix: "recon-probe",
				defaultMaxBodyBytes: 256_000,
				includeCookieProvider: true,
				augmentParams: (current) => ({ followRedirects: resolveBooleanParam(current.followRedirects, true) }),
				run: runReconProbe,
				details: (result) => ({ count: result.count }),
				distill: summarizeWebReconProbeData,
			});
		},
	});
}
