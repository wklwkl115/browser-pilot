export const runtimePortLeakRules = [
	{
		key: "browser-command-runtime-port-to-session-index",
		description: "BrowserCommandRuntimePort leaking session kernel DTO aliases instead of owning command-facing runtime DTOs",
		fromPath: "src/ports/BrowserCommandRuntimePort.ts",
		toPathPrefix: "src/kernels/session/index.ts",
	},
	{
		key: "browser-command-runtime-port-to-perception-ledger",
		description: "BrowserCommandRuntimePort leaking perception ledger DTO aliases instead of owning command-facing perception DTOs",
		fromPath: "src/ports/BrowserCommandRuntimePort.ts",
		toPathPrefix: "src/kernels/session/perceptionLedger.ts",
	},
	{
		key: "browser-command-runtime-port-to-temporal-types",
		description: "BrowserCommandRuntimePort leaking temporal kernel DTO aliases instead of owning command-facing temporal DTOs",
		fromPath: "src/ports/BrowserCommandRuntimePort.ts",
		toPathPrefix: "src/kernels/temporal/types.ts",
	},
];
