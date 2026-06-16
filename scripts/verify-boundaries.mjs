import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { collectImportEdges, normalizePath, projectRoot, walkTypescriptFiles } from "./import-graph.mjs";
import {
	enforcedAppEntryRules,
	enforcedKernelImportFragments,
	enforcedKernelSourceRules,
	enforcedKernelSpecifiers,
	enforcedLayerRules,
} from "./architecture-boundary-rules.mjs";

const root = projectRoot;
const srcRoot = join(root, "src");

function checkLayerRule(rel, resolved, specifier) {
	for (const rule of enforcedLayerRules) {
		if (!rel.startsWith(rule.from)) continue;
		for (const forbidden of rule.forbidden) {
			if (resolved.startsWith(forbidden)) {
				errors.push(`${rel}: ${rule.name} layer imports forbidden dependency ${specifier} -> ${resolved}`);
			}
		}
	}
}

function checkKernelRule(rel, resolved, specifier) {
	if (!rel.startsWith("src/kernels/")) return;
	if (enforcedKernelSpecifiers.includes(specifier)) {
		errors.push(`${rel}: kernel imports forbidden side-effect module ${specifier}`);
	}
	if (enforcedKernelImportFragments.some((fragment) => `/${resolved}`.includes(fragment))) {
		errors.push(`${rel}: kernel imports outer layer ${specifier}`);
	}
}

function checkAppsEntryRule(rel, resolved, specifier) {
	for (const rule of enforcedAppEntryRules) {
		if (rel !== rule.from) continue;
		if (rule.forbiddenResolved.includes(resolved)) {
			errors.push(rule.message(rel, specifier));
		}
	}
}

const errors = [];
for (const edge of collectImportEdges()) {
	checkKernelRule(edge.from, edge.to, edge.specifier);
	checkLayerRule(edge.from, edge.to, edge.specifier);
	checkAppsEntryRule(edge.from, edge.to, edge.specifier);
}

for (const file of walkTypescriptFiles(srcRoot)) {
	const source = readFileSync(file, "utf8");
	const rel = normalizePath(relative(root, file));
	if (!rel.startsWith("src/kernels/")) continue;
	for (const rule of enforcedKernelSourceRules) {
		if (rule.pattern.test(source)) errors.push(rule.message(rel));
	}
}

if (errors.length) {
	console.error(errors.join("\n"));
	process.exit(1);
}
execFileSync(process.execPath, [join(root, "scripts", "architecture-boundary-report.mjs"), "--fail-on-findings"], { stdio: "inherit" });
console.log("kernel boundary rules ok");
