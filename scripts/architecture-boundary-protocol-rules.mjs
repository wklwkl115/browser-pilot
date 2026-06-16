export const protocolLayerRules = [
	{
		key: "bridge-protocol-to-utils",
		description: "bridge protocol importing runtime utility helpers instead of staying schema/contract-owned with thin re-export exits",
		fromLayer: "bridge/protocol",
		toLayer: "utils",
	},
	{
		key: "bridge-protocol-to-bridge-other",
		description: "bridge protocol retaining runtime-owned bridge facades instead of protocol schema/contract sources",
		fromLayer: "bridge/protocol",
		toLayer: "bridge/other",
	},
	{
		key: "bridge-protocol-to-types",
		description: "bridge protocol re-exporting shared runtime type catalogs instead of owning schema/contract sources only",
		fromLayer: "bridge/protocol",
		toLayer: "types",
	},
	{
		key: "utils-to-bridge-protocol",
		description: "neutral utils importing bridge protocol contracts instead of shared generated catalogs or caller-owned wrappers",
		fromLayer: "utils",
		toLayer: "bridge/protocol",
	},
];
