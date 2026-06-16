export const memoryFacadeLeakRules = [
	{
		key: "memory-profile-service-to-memory-kernel-types",
		description: "memory profile service leaking memory kernel DTO aliases instead of memory-facing DTOs",
		fromPath: "src/memory/profileService.ts",
		toPathPrefix: "src/kernels/memory/types.ts",
	},
	{
		key: "memory-types-to-memory-kernel-types",
		description: "memory public type surface leaking memory kernel DTO aliases instead of owning memory-facing DTOs",
		fromPath: "src/memory/types.ts",
		toPathPrefix: "src/kernels/memory/types.ts",
	},
	{
		key: "memory-frontmatter-to-memory-kernel-types",
		description: "memory frontmatter parser leaking memory kernel DTO aliases instead of memory-facing DTOs",
		fromPath: "src/memory/frontmatter.ts",
		toPathPrefix: "src/kernels/memory/types.ts",
	},
	{
		key: "memory-profile-store-to-memory-kernel-types",
		description: "memory profile persistence leaking memory kernel DTO aliases instead of memory-facing DTOs",
		fromPath: "src/memory/profileStore.ts",
		toPathPrefix: "src/kernels/memory/types.ts",
	},
	{
		key: "commands-memory-store-to-memory-kernel-types",
		description: "memory command store leaking memory kernel DTO aliases instead of memory-facing DTOs",
		fromPath: "src/commands/memory/store.ts",
		toPathPrefix: "src/kernels/memory/types.ts",
	},
	{
		key: "observe-memory-augmentation-to-memory-kernel-types",
		description: "observe memory augmentation leaking memory kernel DTO aliases instead of command or memory-facing DTOs",
		fromPath: "src/commands/observe/memoryAugmentation.ts",
		toPathPrefix: "src/kernels/memory/types.ts",
	},
	{
		key: "observe-memory-augmentation-to-memory-routing-kernel",
		description: "observe memory augmentation importing memory routing kernel directly instead of the memory routing facade",
		fromPath: "src/commands/observe/memoryAugmentation.ts",
		toPathPrefix: "src/kernels/memory/routing.ts",
	},
	{
		key: "observe-memory-augmentation-to-memory-recall-kernel",
		description: "observe memory augmentation importing memory recall kernel directly instead of the memory recall facade",
		fromPath: "src/commands/observe/memoryAugmentation.ts",
		toPathPrefix: "src/kernels/memory/recall.ts",
	},
];
