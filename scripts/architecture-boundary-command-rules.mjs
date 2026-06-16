import { browserRuntimeLayerRules } from "./architecture-boundary-browser-runtime-layer-rules.mjs";
import { commandSurfaceRules } from "./architecture-boundary-command-surface-rules.mjs";
import { compositionLayerRules } from "./architecture-boundary-composition-rules.mjs";

export const commandLayerRules = [
	...commandSurfaceRules,
	...compositionLayerRules,
	...browserRuntimeLayerRules,
];
