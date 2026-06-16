import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectImportEdges, projectRoot, statExists } from "./import-graph.mjs";
import { focusRules, sourceRules } from "./architecture-boundary-rules.mjs";

function sourceFindings() {
	return sourceRules.map((rule) => {
		const absolutePath = join(projectRoot, rule.path);
		const source = statExists(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
		return {
			key: rule.key,
			description: rule.description,
			edges: rule.pattern.test(source) ? [{ from: rule.path, to: rule.to, fromLayer: "commands", toLayer: "kernels", specifier: "source-pattern" }] : [],
		};
	});
}

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
	findings.push(...sourceFindings());
	findings.push({
		key: "unclassified-src-other",
		description: "imports involving uncategorized src paths; add an explicit layer owner before relying on reports",
		edges: edges
			.filter((edge) => edge.fromLayer === "src/other" || edge.toLayer === "src/other")
			.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
	});
	return findings;
}

export function buildArchitectureBoundaryReport() {
	const edges = collectImportEdges();
	return {
		totalEdges: edges.length,
		findings: focusedFindings(edges),
	};
}
