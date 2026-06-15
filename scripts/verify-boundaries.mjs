import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { collectImportEdges, normalizePath, projectRoot, walkTypescriptFiles } from "./import-graph.mjs";

const root = projectRoot;
const srcRoot = join(root, "src");

const forbiddenKernelImportFragments = [
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

const forbiddenKernelSpecifiers = [
	"node:fs",
	"node:fs/promises",
	"node:http",
	"node:https",
	"node:net",
	"node:child_process",
	"node:process",
	"ws",
];

const layerRules = [
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

function checkLayerRule(rel, resolved, specifier) {
	for (const rule of layerRules) {
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
	if (forbiddenKernelSpecifiers.includes(specifier)) {
		errors.push(`${rel}: kernel imports forbidden side-effect module ${specifier}`);
	}
	if (forbiddenKernelImportFragments.some((fragment) => `/${resolved}`.includes(fragment))) {
		errors.push(`${rel}: kernel imports outer layer ${specifier}`);
	}
}

function checkAppsEntryRule(rel, resolved, specifier) {
	if (rel !== "cli/bin.ts") return;
	if (resolved === "cli/index.ts" || resolved === "cli/localCommands.ts" || resolved === "cli/daemon.ts") {
		errors.push(`${rel}: CLI bin entry must route through src/apps, not ${specifier}`);
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
	if (rel.startsWith("src/kernels/") && (/\bprocess\s*\./.test(source) || /\bprocess\s*\[\s*["']env["']\s*\]/.test(source))) {
		errors.push(`${rel}: kernel must not read process/env`);
	}
	if (rel.startsWith("src/kernels/") && /\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(source)) {
		errors.push(`${rel}: kernel must not own timers or polling`);
	}
}

if (errors.length) {
	console.error(errors.join("\n"));
	process.exit(1);
}
execFileSync(process.execPath, [join(root, "scripts", "architecture-boundary-report.mjs"), "--fail-on-findings"], { stdio: "inherit" });
console.log("kernel boundary rules ok");
