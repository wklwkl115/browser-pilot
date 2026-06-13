// Single source for ABML pure-core/runtime classification used by drift contracts.
// Adding or removing a file here is an architectural classification change.
export const PURE_CORE = [
	"types.ts",
	"refId.ts",
	"refPolicy.ts",
	"actionabilityModel.ts",
	"entity.ts",
	"ax.ts",
	"relations.ts",
	"inference.ts",
	"diff.ts",
	"stream.ts",
	"causal.ts",
	"grouping.ts",
	"templating.ts",
	"treeDiff.ts",
	"semanticRefAnchor.ts",
	"snapshotProjection.ts",
	"identityGraph.ts",
	"errors.ts",
	"verbs/router.ts",
	"verbs/read.ts",
	"verbs/frame.ts",
	"verbs/pierce.ts",
];

export const RUNTIME = [
	"perceptionLedger.ts",
	"verbs/axRuntime.ts",
	"verbs/frameRuntime.ts",
	"verbs/pierceRuntime.ts",
	"verbs/visionRuntime.ts",
	"verbs/runtime.ts",
	"verbs/integration.ts",
];

export const BARREL = "index.ts";

export const PURE_CROSSCUTTING = [
	"utils/records",
	"utils/errors",
	"utils/redaction",
	"utils/json",
	"protocol/nativeErrorCodes",
];
