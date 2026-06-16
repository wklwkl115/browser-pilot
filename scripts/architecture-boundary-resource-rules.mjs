export const resourceLayerRules = [
	{
		key: "scan-to-adapters",
		description: "scan helpers importing adapters instead of resource facades",
		fromLayer: "scan",
		toLayer: "adapters",
	},
	{
		key: "resources-to-adapters",
		description: "resource facades importing adapters instead of owning resource contracts or being wired by composition roots",
		fromLayer: "resources",
		toLayer: "adapters",
	},
	{
		key: "resources-to-abml-kernel",
		description: "resource facades importing ABML kernel helpers instead of neutral refs/resource contracts",
		fromLayer: "resources",
		toPathPrefix: "src/kernels/abml/",
	},
	{
		key: "validation-to-bridge-protocol",
		description: "neutral validation helpers importing bridge protocol errors instead of returning validation-owned errors/results",
		fromLayer: "validation",
		toLayer: "bridge/protocol",
	},
	{
		key: "ports-to-bridge-protocol",
		description: "ports exposing bridge protocol contracts instead of port-owned runtime abstractions",
		fromLayer: "ports",
		toLayer: "bridge/protocol",
	},
];
