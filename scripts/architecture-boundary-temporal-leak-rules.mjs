export const temporalLeakRules = [
	{
		key: "execution-journal-to-temporal-types",
		description: "execution journal leaking temporal kernel DTO aliases instead of command-facing temporal DTOs",
		fromPath: "src/commands/executionJournal.ts",
		toPathPrefix: "src/kernels/temporal/types.ts",
	},
	{
		key: "wait-supervisor-to-temporal-types",
		description: "wait supervisor leaking temporal kernel DTO aliases instead of command-facing temporal DTOs",
		fromPath: "src/browser-command-runtime/waitSupervisor.ts",
		toPathPrefix: "src/kernels/temporal/types.ts",
	},
];
