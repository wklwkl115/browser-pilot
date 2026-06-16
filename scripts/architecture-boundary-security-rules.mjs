export const securityLeakRules = [
	{
		key: "web-security-http-to-security-replay-diff",
		description: "web security HTTP helpers leaking replay diff kernel DTOs or algorithms instead of using the web-security baseline facade",
		fromPath: "src/commands/webSecurity/shared/http.ts",
		toPathPrefix: "src/kernels/security/replayDiff.ts",
	},
];
