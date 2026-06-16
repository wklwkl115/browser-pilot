export const evidenceDistillerLeakRules = [
	{
		key: "distiller-registry-to-evidence-fact-types",
		description: "distiller registry leaking evidence fact DTO aliases instead of command-facing result DTOs",
		fromPath: "src/commands/distillerRegistry.ts",
		toPathPrefix: "src/kernels/evidence/distill/fact.ts",
	},
	{
		key: "builtin-distillers-to-evidence-fact-types",
		description: "built-in distillers leaking evidence fact DTO aliases instead of command-facing result DTOs",
		fromPath: "src/commands/summaries/builtinDistillers.ts",
		toPathPrefix: "src/kernels/evidence/distill/fact.ts",
	},
];
