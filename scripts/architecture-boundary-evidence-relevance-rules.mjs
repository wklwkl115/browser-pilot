export const evidenceRelevanceLeakRules = [
	{
		key: "observe-entity-views-to-evidence-relevance-types",
		description: "observe entity views leaking evidence relevance DTO aliases instead of observe-facing relevance DTOs",
		fromPath: "src/commands/observe/entityViews.ts",
		toPathPrefix: "src/kernels/evidence/distill/relevance.ts",
	},
	{
		key: "observe-memory-augmentation-to-evidence-relevance-types",
		description: "observe memory augmentation leaking evidence relevance DTO aliases instead of observe-facing relevance DTOs",
		fromPath: "src/commands/observe/memoryAugmentation.ts",
		toPathPrefix: "src/kernels/evidence/distill/relevance.ts",
	},
	{
		key: "observe-relevance-fusion-to-evidence-relevance-types",
		description: "observe relevance fusion leaking evidence relevance DTO aliases instead of observe-facing relevance DTOs",
		fromPath: "src/commands/observe/relevanceFusion.ts",
		toPathPrefix: "src/kernels/evidence/distill/relevance.ts",
	},
];
