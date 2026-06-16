export const memoryCommandLeakRules = [
	{
		key: "command-runtime-to-memory-types",
		description: "command runtime leaking memory kernel DTO aliases instead of command-owned memory augmentation DTOs",
		fromPath: "src/commands/commandRuntime.ts",
		toPathPrefix: "src/kernels/memory/types.ts",
	},
	{
		key: "result-middleware-to-memory-types",
		description: "result middleware leaking memory kernel DTO aliases instead of command-owned memory augmentation DTOs",
		fromPath: "src/commands/resultMiddleware.ts",
		toPathPrefix: "src/kernels/memory/types.ts",
	},
];
