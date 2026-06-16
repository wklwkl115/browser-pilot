export const compositionLayerRules = [
	{
		key: "cli-to-bridge-server",
		description: "root CLI importing bridge/server directly instead of src/apps composition owners",
		fromLayer: "cli",
		toLayer: "bridge/server",
	},
	{
		key: "cli-to-commands",
		description: "root CLI importing command internals directly instead of src/apps/cli owners",
		fromLayer: "cli",
		toLayer: "commands",
	},
	{
		key: "adapters-to-commands",
		description: "adapters importing command-layer helpers, summaries, or readers",
		fromLayer: "adapters",
		toLayer: "commands",
	},
	{
		key: "apps-to-adapters",
		description: "apps importing adapters directly instead of composition ports or resource facades",
		fromLayer: "apps",
		toLayer: "adapters",
	},
];
