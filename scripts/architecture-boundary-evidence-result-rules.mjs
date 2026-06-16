export const evidenceResultLeakRules = [
	{
		key: "define-command-to-evidence-envelope-types",
		description: "defineCommand leaking evidence envelope DTO aliases instead of command-facing result DTOs",
		fromPath: "src/commands/defineCommand.ts",
		toPathPrefix: "src/kernels/evidence/index.ts",
	},
	{
		key: "result-middleware-to-evidence-envelope-types",
		description: "result middleware leaking evidence envelope DTO aliases instead of command-facing result DTOs",
		fromPath: "src/commands/resultMiddleware.ts",
		toPathPrefix: "src/kernels/evidence/index.ts",
	},
	{
		key: "result-middleware-to-evidence-ladder-types",
		description: "result middleware leaking evidence ladder DTO aliases instead of command-facing result DTOs",
		fromPath: "src/commands/resultMiddleware.ts",
		toPathPrefix: "src/kernels/evidence/distill/ladder.ts",
	},
];
