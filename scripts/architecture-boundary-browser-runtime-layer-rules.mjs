export const browserRuntimeLayerRules = [
	{
		key: "browser-command-runtime-to-adapters",
		description: "browser command runtime importing adapters instead of resource/runtime facades",
		fromLayer: "browser-command-runtime",
		toLayer: "adapters",
	},
	{
		key: "browser-command-runtime-to-bridge-other",
		description: "browser command runtime importing bridge runtime helpers instead of neutral utilities or ports",
		fromLayer: "browser-command-runtime",
		toLayer: "bridge/other",
	},
	{
		key: "browser-command-runtime-to-bridge-protocol",
		description: "browser command runtime importing bridge protocol generated helpers instead of shared generated types",
		fromLayer: "browser-command-runtime",
		toLayer: "bridge/protocol",
	},
	{
		key: "browser-page-runtime-to-bridge-other",
		description: "browser page runtime importing bridge runtime helpers instead of neutral utilities or ports",
		fromLayer: "browser-page-runtime",
		toLayer: "bridge/other",
	},
	{
		key: "browser-runtime-to-adapters",
		description: "browser runtime importing adapters instead of resource/runtime facades",
		fromLayer: "browser-runtime",
		toLayer: "adapters",
	},
	{
		key: "browser-runtime-to-bridge-other",
		description: "browser runtime importing bridge runtime helpers instead of neutral utilities or ports",
		fromLayer: "browser-runtime",
		toLayer: "bridge/other",
	},
	{
		key: "browser-runtime-to-browser-command-runtime",
		description: "browser runtime importing command-runtime helpers instead of neutral runtime owners",
		fromLayer: "browser-runtime",
		toLayer: "browser-command-runtime",
	},
];
