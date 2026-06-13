export const SPEC_CLAIMS = [
	{
		doc: "docs/abml-p1-spec.md",
		claims: [
			{
				anchor: "### 1.1 Locator",
				symbol: "export type Locator",
				status: "implemented",
				sourceGlob: ["src/abml-core/types.ts"],
			},
			{
				anchor: "identity minting: semanticAnchor > css > backendNodeId > axNodeId > textAnchor > first locator",
				symbol: "Ref identity prioritizes persistent page-authored anchors",
				status: "implemented",
				sourceGlob: ["src/abml-core/refId.ts"],
			},
			{
				anchor: "### 2.2 候选评分（保留，未实现）",
				symbol: "Candidate scoring engine",
				status: "reserved",
				sourceGlob: [],
			},
			{
				anchor: "refId: string;             // pi-ref://...",
				symbol: "export function makePiRefUri",
				status: "implemented",
				sourceGlob: ["src/abml-core/refId.ts"],
			},
		],
	},
	{
		doc: "docs/abml-kernel-manifest.md",
		claims: [
			{
				anchor: "## Pure core (23 — zero browser/Node deps)",
				symbol: "export const PURE_CORE = [",
				status: "implemented",
				sourceGlob: ["tests/contracts/drift/abml-core-manifest.js"],
			},
			{
				anchor: "## Runtime (7 — talk to the live browser)",
				symbol: "export const RUNTIME = [",
				status: "implemented",
				sourceGlob: ["tests/contracts/drift/abml-core-manifest.js"],
			},
			{
				anchor: "## Whitelisted cross-cutting modules (5 — a pure-core file MAY import these)",
				symbol: "export const PURE_CROSSCUTTING = [",
				status: "implemented",
				sourceGlob: ["tests/contracts/drift/abml-core-manifest.js"],
			},
		],
	},
	{
		doc: "docs/agent-native-architecture.md",
		claims: [
			{
				anchor: "**CLI wiring — fixed (2026-06-07):**",
				symbol: "def.prepareArguments ? def.prepareArguments(params)",
				status: "implemented",
				sourceGlob: ["cli/daemon.ts"],
			},
			{
				anchor: "**CLI wiring — fixed (2026-06-07):**",
				symbol: "cmd.def.prepareArguments ? cmd.def.prepareArguments(resolved.params)",
				status: "implemented",
				sourceGlob: ["cli/localCommands.ts"],
			},
		],
	},
];
