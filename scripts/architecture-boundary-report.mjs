import { collectImportEdges } from "./import-graph.mjs";

const focusRules = [
	{
		key: "commands-to-bridge-server",
		description: "commands importing bridge/server directly instead of a runtime port",
		fromLayer: "commands",
		toLayer: "bridge/server",
	},
	{
		key: "commands-to-adapters",
		description: "commands importing adapters directly instead of ports/shared pure helpers",
		fromLayer: "commands",
		toLayer: "adapters",
	},
	{
		key: "commands-to-browser-runtime",
		description: "commands importing browser runtime internals instead of browser-command-runtime facades",
		fromLayer: "commands",
		toLayer: "browser-runtime",
	},
	{
		key: "commands-to-bridge-other",
		description: "commands importing bridge runtime helpers instead of neutral utilities, ports, or browser runtime contracts",
		fromLayer: "commands",
		toLayer: "bridge/other",
	},
	{
		key: "commands-to-bridge-protocol",
		description: "commands importing bridge protocol generated helpers instead of shared generated types or command-owned metadata",
		fromLayer: "commands",
		toLayer: "bridge/protocol",
	},
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
	{
		key: "bridge-server-to-memory",
		description: "bridge server importing memory services instead of leaving memory flush/persistence to app or command composition owners",
		fromLayer: "bridge/server",
		toLayer: "memory",
	},
	{
		key: "bridge-server-to-abml-kernel",
		description: "bridge server importing ABML kernels instead of staying transport/session oriented",
		fromLayer: "bridge/server",
		toPathPrefix: "src/kernels/abml/",
	},
	{
		key: "bridge-server-main-to-kernels",
		description: "BrowserBridgeServer importing kernels directly instead of using session/temporal coordinators or runtime port contracts",
		fromPath: "src/bridge/server/BrowserBridgeServer.ts",
		toPathPrefix: "src/kernels/",
	},
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

function focusedFindings(edges) {
	const findings = focusRules.map((rule) => ({
		...rule,
		edges: edges
			.filter((edge) =>
				(!rule.fromLayer || edge.fromLayer === rule.fromLayer)
				&& (!rule.fromPath || edge.from === rule.fromPath)
				&& (!rule.toLayer || edge.toLayer === rule.toLayer)
				&& (!rule.toPathPrefix || edge.to.startsWith(rule.toPathPrefix))
			)
			.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
	}));
	findings.push({
		key: "unclassified-src-other",
		description: "imports involving uncategorized src paths; add an explicit layer owner before relying on reports",
		edges: edges
			.filter((edge) => edge.fromLayer === "src/other" || edge.toLayer === "src/other")
			.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
	});
	return findings;
}

function printText(report, options = {}) {
	console.log(`Architecture boundary report (${options.failOnFindings ? "enforced" : "report-only"})`);
	console.log(`Scanned import edges: ${report.totalEdges}`);
	for (const finding of report.findings) {
		console.log("");
		console.log(`${finding.key}: ${finding.edges.length}`);
		console.log(`  ${finding.description}`);
		for (const edge of finding.edges) {
			console.log(`  - ${edge.from} -> ${edge.to}`);
		}
	}
}

const edges = collectImportEdges();
const report = {
	totalEdges: edges.length,
	findings: focusedFindings(edges),
};
const failOnFindings = process.argv.includes("--fail-on-findings");

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2));
} else {
	printText(report, { failOnFindings });
}

if (failOnFindings) {
	const failingFindings = report.findings.filter((finding) => finding.edges.length > 0);
	if (failingFindings.length) {
		console.error("");
		console.error("Architecture boundary violations found:");
		for (const finding of failingFindings) {
			console.error(`- ${finding.key}: ${finding.edges.length}`);
		}
		process.exit(1);
	}
	console.log("architecture boundary rules ok");
}
