import { readFileSync } from "node:fs";
import path from "node:path";
import {
	CHECK_IMPACT_MAP_PATH,
	ROOT,
	readImpactMap,
} from "./check-graph.mjs";
import {
	inputMatchesChangedFile,
	normalizeRel,
	walkFiles,
} from "./lib/repo-introspection.mjs";

const args = process.argv.slice(2);
const needle = valueAfter("--needle");
const file = valueAfter("--file");

if ((!needle && !file) || (needle && file)) {
	console.error("Usage: npm run query:markers -- --needle <string> OR npm run query:markers -- --file <repo/path>");
	process.exit(2);
}

if (needle) queryNeedle(needle);
else queryFile(file);

function valueAfter(flag) {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	return args[index + 1];
}

function queryNeedle(value) {
	const files = [
		...walkFiles("tests/contracts", (name) => name.endsWith(".mjs"), ROOT),
		...walkFiles("scripts", (name) => name.endsWith(".mjs"), ROOT),
	].sort();
	const rows = [];
	for (const rel of files) {
		const text = readFileSync(path.join(ROOT, rel), "utf8");
		const targets = readTargetMap(text);
		const lines = text.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (!line.includes(value)) continue;
			if (!line.includes(".includes(") && !line.includes("RegExp") && !/\/.+\//.test(line)) continue;
			const receiver = /([A-Za-z0-9_]+)\.includes\s*\(/.exec(line)?.[1];
			const target = receiver ? targets.get(receiver) : directReadTarget(line);
			rows.push({ file: rel, line: index + 1, target, text: line.trim() });
		}
	}
	if (!rows.length) {
		console.log(`no marker pins found for needle: ${value}`);
		return;
	}
	for (const row of rows) console.log(`${row.file}:${row.line}${row.target ? ` target=${row.target}` : ""} ${row.text}`);
}

function queryFile(repoPath) {
	const rel = normalizeRel(repoPath);
	const map = readImpactMap(ROOT);
	const rows = [];
	for (const node of Object.values(map.nodes || {})) {
		const matches = (node.inputs || []).filter((input) => inputMatchesChangedFile(input, rel));
		if (matches.length) rows.push({ script: node.script, scope: node.scope, matches });
	}
	if (!rows.length) {
		console.log(`no precise impact-map entries contain ${rel}; inspect global-scope nodes in ${path.relative(ROOT, CHECK_IMPACT_MAP_PATH).replace(/\\/g, "/")}`);
		return;
	}
	for (const row of rows) console.log(`${row.script}${row.scope === "global" ? " scope=global" : ""}: ${row.matches.join(", ")}`);
}

function readTargetMap(text) {
	const map = new Map();
	const pattern = /\bconst\s+([A-Za-z0-9_]+)\s*=\s*(?:JSON\.parse\()?read[A-Za-z0-9_]*\(\s*["']([^"']+)["']/g;
	let match;
	while ((match = pattern.exec(text))) map.set(match[1], match[2]);
	return map;
}

function directReadTarget(line) {
	return /\bread[A-Za-z0-9_]*\(\s*["']([^"']+)["']/.exec(line)?.[1];
}
