export const perceptionLedgerLeakRules = [
	{
		key: "observe-memory-augmentation-to-session-ledger",
		description: "observe memory augmentation leaking session perception DTO aliases instead of command-facing perception DTOs",
		fromPath: "src/commands/observe/memoryAugmentation.ts",
		toPathPrefix: "src/kernels/session/perceptionLedger.ts",
	},
	{
		key: "observe-relevance-fusion-to-session-ledger",
		description: "observe relevance fusion leaking session perception DTO aliases instead of command-facing perception DTOs",
		fromPath: "src/commands/observe/relevanceFusion.ts",
		toPathPrefix: "src/kernels/session/perceptionLedger.ts",
	},
	{
		key: "observe-render-cache-to-session-ledger",
		description: "observe render cache leaking session perception DTO aliases instead of command-facing perception DTOs",
		fromPath: "src/commands/observe/renderCache.ts",
		toPathPrefix: "src/kernels/session/perceptionLedger.ts",
	},
	{
		key: "observe-scan-runner-to-session-ledger",
		description: "observe scan runner leaking session perception projection helpers or DTO aliases instead of command-facing perception DTOs",
		fromPath: "src/commands/observe/scanRunner.ts",
		toPathPrefix: "src/kernels/session/perceptionLedger.ts",
	},
	{
		key: "memory-profile-service-to-session-ledger",
		description: "memory profile service leaking session perception DTO aliases instead of memory-facing input DTOs",
		fromPath: "src/memory/profileService.ts",
		toPathPrefix: "src/kernels/session/perceptionLedger.ts",
	},
];
