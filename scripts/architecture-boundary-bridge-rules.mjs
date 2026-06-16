export const bridgeServerRules = [
	{
		key: "bridge-server-to-memory",
		description: "bridge server importing memory services instead of leaving memory flush/persistence to app or command composition owners",
		fromLayer: "bridge/server",
		toLayer: "memory",
	},
	{
		key: "bridge-server-to-abml-kernel",
		description: "bridge server importing ABML kernels instead of staying transport/session oriented",
		fromLayer: "bridge/server",
		toPathPrefix: "src/kernels/abml/",
	},
	{
		key: "bridge-server-main-to-kernels",
		description: "BrowserBridgeServer importing kernels directly instead of using session/temporal coordinators or runtime port contracts",
		fromPath: "src/bridge/server/BrowserBridgeServer.ts",
		toPathPrefix: "src/kernels/",
	},
	{
		key: "bridge-command-service-to-session-kernel",
		description: "bridge command service depending on session kernel classes instead of bridge-local dependency ports",
		fromPath: "src/bridge/server/BrowserBridgeCommandService.ts",
		toPathPrefix: "src/kernels/session/",
	},
	{
		key: "bridge-client-message-service-to-session-kernel",
		description: "bridge client message service depending on session kernel classes instead of bridge-local dependency ports",
		fromPath: "src/bridge/server/BrowserBridgeClientMessageService.ts",
		toPathPrefix: "src/kernels/session/",
	},
	{
		key: "bridge-server-types-to-session-kernel",
		description: "bridge server type surface leaking session kernel DTO aliases instead of owning bridge-facing DTOs",
		fromPath: "src/bridge/server/types.ts",
		toPathPrefix: "src/kernels/session/",
	},
];
