import { bridgeServerRules } from "./architecture-boundary-bridge-rules.mjs";
import { kernelLeakRules } from "./architecture-boundary-kernel-leak-rules.mjs";
import { commandLayerRules, protocolLayerRules, resourceLayerRules } from "./architecture-boundary-layer-rules.mjs";

export const focusRules = [
	...commandLayerRules,
	...bridgeServerRules,
	{
		key: "temporal-profile-artifacts-to-temporal-types",
		description: "temporal profile artifact writer leaking temporal kernel DTO aliases instead of command-facing profile DTOs",
		fromPath: "src/bridge/server/temporalProfileArtifacts.ts",
		toPathPrefix: "src/kernels/temporal/types.ts",
	},
	...resourceLayerRules,
	...kernelLeakRules,
	...protocolLayerRules,
];

export { sourceRules } from "./architecture-boundary-source-rules.mjs";
