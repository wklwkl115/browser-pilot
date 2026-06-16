import { buildArchitectureBoundaryReport } from "./architecture-boundary-findings.mjs";

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

const report = buildArchitectureBoundaryReport();
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
