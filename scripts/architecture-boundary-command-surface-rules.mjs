export const commandSurfaceRules = [
	{
		key: "commands-to-bridge-server",
		description: "commands importing bridge/server directly instead of a runtime port",
		fromLayer: "commands",
		toLayer: "bridge/server",
	},
	{
		key: "commands-to-adapters",
		description: "commands importing adapters directly instead of ports/shared pure helpers",
		fromLayer: "commands",
		toLayer: "adapters",
	},
	{
		key: "commands-to-browser-runtime",
		description: "commands importing browser runtime internals instead of browser-command-runtime facades",
		fromLayer: "commands",
		toLayer: "browser-runtime",
	},
	{
		key: "commands-to-bridge-other",
		description: "commands importing bridge runtime helpers instead of neutral utilities, ports, or browser runtime contracts",
		fromLayer: "commands",
		toLayer: "bridge/other",
	},
	{
		key: "commands-to-bridge-protocol",
		description: "commands importing bridge protocol generated helpers instead of shared generated types or command-owned metadata",
		fromLayer: "commands",
		toLayer: "bridge/protocol",
	},
	{
		key: "command-runtime-to-session-dto-kernel",
		description: "command runtime importing session DTOs from kernels instead of BrowserCommandRuntimePort",
		fromPath: "src/commands/commandRuntime.ts",
		toPathPrefix: "src/kernels/session/index.ts",
	},
	{
		key: "tabs-command-to-session-dto-kernel",
		description: "tabs command importing session DTOs from kernels instead of BrowserCommandRuntimePort",
		fromPath: "src/commands/tabsCommand.ts",
		toPathPrefix: "src/kernels/session/index.ts",
	},
	{
		key: "tabs-projection-to-session-dto-kernel",
		description: "tabs projection importing session DTOs from kernels instead of BrowserCommandRuntimePort",
		fromPath: "src/commands/tabsProjection.ts",
		toPathPrefix: "src/kernels/session/index.ts",
	},
];
