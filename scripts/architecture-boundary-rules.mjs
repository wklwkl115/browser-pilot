import { bridgeServerRules } from "./architecture-boundary-bridge-rules.mjs";
import { kernelLeakRules } from "./architecture-boundary-kernel-leak-rules.mjs";
import { commandLayerRules, protocolLayerRules, resourceLayerRules } from "./architecture-boundary-layer-rules.mjs";

export const enforcedKernelImportFragments = [
	"/apps/",
	"/commands/",
	"/adapters/",
	"/bridge/server/",
	"/bridge/extension/",
	"/cli/",
	"/daemon/",
	"/driver/",
	"/frontend/",
	"/tools/",
	"/resources/",
];

export const enforcedKernelSpecifiers = [
	"node:fs",
	"node:fs/promises",
	"node:http",
	"node:https",
	"node:net",
	"node:child_process",
	"node:process",
	"ws",
];

export const enforcedLayerRules = [
	{
		name: "kernels",
		from: "src/kernels/",
		forbidden: ["src/apps/", "src/commands/", "src/adapters/", "src/bridge/server/", "src/bridge/extension/", "cli/"],
	},
	{
		name: "commands",
		from: "src/commands/",
		forbidden: ["src/apps/", "cli/"],
	},
	{
		name: "adapters",
		from: "src/adapters/",
		forbidden: ["src/apps/", "cli/"],
	},
	{
		name: "bridge server",
		from: "src/bridge/server/",
		forbidden: ["src/apps/", "cli/"],
	},
	{
		name: "apps",
		from: "src/apps/",
		forbidden: ["src/kernels/evidence/distill/", "src/bridge/extension/", "cli/localCommands.ts", "cli/daemon.ts", "cli/index.ts"],
	},
];

export const enforcedAppEntryRules = [
	{
		from: "cli/bin.ts",
		forbiddenResolved: ["cli/index.ts", "cli/localCommands.ts", "cli/daemon.ts"],
		message: (rel, specifier) => `${rel}: CLI bin entry must route through src/apps, not ${specifier}`,
	},
];

export const enforcedKernelSourceRules = [
	{
		pattern: /\bprocess\s*\.|\bprocess\s*\[\s*["']env["']\s*\]/u,
		message: (rel) => `${rel}: kernel must not read process/env`,
	},
	{
		pattern: /\bsetTimeout\s*\(|\bsetInterval\s*\(/u,
		message: (rel) => `${rel}: kernel must not own timers or polling`,
	},
];

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
