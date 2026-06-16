export const evidenceFactLeakRules = [
	{
		key: "command-runtime-to-evidence-fact-types",
		description: "command runtime leaking evidence fact DTO aliases instead of command-facing result DTOs",
		fromPath: "src/commands/commandRuntime.ts",
		toPathPrefix: "src/kernels/evidence/distill/fact.ts",
	},
	{
		key: "result-middleware-to-evidence-fact-types",
		description: "result middleware leaking evidence fact DTO aliases instead of command-facing result DTOs",
		fromPath: "src/commands/resultMiddleware.ts",
		toPathPrefix: "src/kernels/evidence/distill/fact.ts",
	},
	{
		key: "observe-scan-runner-to-evidence-fact-types",
		description: "observe scan runner leaking evidence fact DTO aliases instead of command-facing result DTOs",
		fromPath: "src/commands/observe/scanRunner.ts",
		toPathPrefix: "src/kernels/evidence/distill/fact.ts",
	},
];
