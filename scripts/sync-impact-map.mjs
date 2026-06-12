import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	CHECK_GROUPS,
	CHECK_IMPACT_MAP_PATH,
	DAG_EXTRA_NODE_IDS,
	DEFAULT_GROUP_SEQUENCE,
	ROOT,
	groupScriptSequence,
	packageScripts,
	resolveScriptSteps,
	writeJsonFile,
} from "./check-graph.mjs";
import {
	extractLiteralRepoPaths,
	normalizeInputPath,
	normalizeRel,
	pathKind,
	readText,
	unresolvedInputSites,
	walkEsmImportGraph,
} from "./lib/repo-introspection.mjs";

const checkMode = process.argv.includes("--check");
const scripts = packageScripts(ROOT);

function entryFromStep(step) {
	if (step.command === "node" || step.command === "tsx") {
		return step.args.find((arg) => /\.(?:mjs|js|ts|tsx)$/.test(arg) && pathKind(normalizeRel(arg), ROOT) === "file");
	}
	return undefined;
}

function commandUnresolvedReason(step) {
	if (step.command === "tsc") return "TypeScript project command has compiler-managed input expansion";
	if (step.command === "eslint") return "ESLint command has config-managed input expansion";
	if (!["node", "tsx"].includes(step.command)) return `unsupported command ${step.command}`;
	if (!entryFromStep(step)) return "script command has no literal JS/TS entry file";
	return undefined;
}

function addInput(inputs, rel) {
	if (!rel) return;
	inputs.add(normalizeInputPath(rel, ROOT));
}

function analyzeEntry(entryRel) {
	const inputs = new Set();
	const unresolved = [];
	const graph = walkEsmImportGraph(entryRel, { root: ROOT });
	for (const item of graph.unresolvedImports) unresolved.push({ ...item, reason: "unresolved relative import" });
	for (const file of graph.files) {
		addInput(inputs, file);
		if (pathKind(file, ROOT) !== "file") continue;
		const text = readText(file, ROOT);
		for (const rel of extractLiteralRepoPaths(text, file, ROOT)) addInput(inputs, rel);
		unresolved.push(...unresolvedInputSites(text, file));
	}
	return { inputs, unresolved };
}

function analyzeScript(script) {
	const inputs = new Set();
	const unresolvedInputs = [];
	const steps = resolveScriptSteps(script, { scripts, root: ROOT });
	for (const step of steps) {
		const reason = commandUnresolvedReason(step);
		if (reason) unresolvedInputs.push({ script, nodeId: step.id, commandLine: step.commandLine, reason });
		const entry = entryFromStep(step);
		if (!entry) continue;
		const analysis = analyzeEntry(normalizeRel(entry));
		for (const input of analysis.inputs) addInput(inputs, input);
		for (const unresolved of analysis.unresolved) unresolvedInputs.push({ script, nodeId: step.id, ...unresolved });
	}
	return {
		script,
		scope: unresolvedInputs.length ? "global" : "paths",
		inputs: [...inputs].sort(),
		unresolvedInputs: unresolvedInputs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		commandSteps: steps.map((step) => ({ nodeId: step.id, commandLine: step.commandLine })),
	};
}

function generateImpactMap() {
	const scriptIds = [...new Set([...DAG_EXTRA_NODE_IDS, ...groupScriptSequence(DEFAULT_GROUP_SEQUENCE)])];
	const nodes = {};
	for (const script of scriptIds) nodes[script] = analyzeScript(script);
	for (const [script, node] of Object.entries(nodes)) {
		assert(node.scope === "global" || node.unresolvedInputs.length === 0, `${script} has unresolved inputs but non-global scope`);
	}
	return {
		schemaVersion: 1,
		source: "scripts/sync-impact-map.mjs",
		groups: Object.fromEntries(Object.entries(CHECK_GROUPS).map(([group, items]) => [group, [...items]])),
		nodes,
	};
}

const next = generateImpactMap();
const text = `${JSON.stringify(next, null, 2)}\n`;
if (checkMode) {
	const current = existsSync(CHECK_IMPACT_MAP_PATH) ? readFileSync(CHECK_IMPACT_MAP_PATH, "utf8") : "";
	if (current !== text) {
		console.error(`check-impact-map drift: run npm run sync:impact-map to update ${path.relative(ROOT, CHECK_IMPACT_MAP_PATH).replace(/\\/g, "/")}`);
		process.exit(1);
	}
	console.log("check impact map ok");
} else {
	writeJsonFile(CHECK_IMPACT_MAP_PATH, next);
	console.log(`wrote ${path.relative(ROOT, CHECK_IMPACT_MAP_PATH).replace(/\\/g, "/")}`);
}
