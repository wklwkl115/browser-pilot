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
		key: "adapters-to-commands",
		description: "adapters importing command-layer helpers, summaries, or readers",
		fromLayer: "adapters",
		toLayer: "commands",
	},
	{
		key: "browser-command-runtime-to-adapters",
		description: "browser command runtime importing adapters instead of resource/runtime facades",
		fromLayer: "browser-command-runtime",
		toLayer: "adapters",
	},
	{
		key: "browser-runtime-to-adapters",
		description: "browser runtime importing adapters instead of resource/runtime facades",
		fromLayer: "browser-runtime",
		toLayer: "adapters",
	},
	{
		key: "scan-to-adapters",
		description: "scan helpers importing adapters instead of resource facades",
		fromLayer: "scan",
		toLayer: "adapters",
	},
];

function focusedFindings(edges) {
	const findings = focusRules.map((rule) => ({
		...rule,
		edges: edges
			.filter((edge) => edge.fromLayer === rule.fromLayer && edge.toLayer === rule.toLayer)
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
