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
				symbol: "semanticAnchor ? undefined : descriptor.locators.find((item) => item.by === \"css\")",
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
				symbol: "return `pi-ref://${kind}/${id}`;",
				status: "implemented",
				sourceGlob: ["src/abml-core/refId.ts"],
			},
		],
	},
	{
		doc: "docs/abml-kernel-manifest.md",
		claims: [
			{
				anchor: "## Pure core (25 — zero browser/Node deps)",
				symbol: "const PURE_CORE = [",
				status: "implemented",
				sourceGlob: ["tests/contracts/drift/check-abml-core-boundary.mjs"],
			},
			{
				anchor: "## Runtime (7 — talk to the live browser)",
				symbol: "const RUNTIME = [",
				status: "implemented",
				sourceGlob: ["tests/contracts/drift/check-abml-core-boundary.mjs"],
			},
			{
				anchor: "## Whitelisted cross-cutting modules (5 — a pure-core file MAY import these)",
				symbol: "const PURE_CROSSCUTTING = new Set([",
				status: "implemented",
				sourceGlob: ["tests/contracts/drift/check-abml-core-boundary.mjs"],
			},
		],
	},
];
