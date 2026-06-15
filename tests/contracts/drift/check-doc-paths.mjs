import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const scripts = pkg.scripts || {};

const DOCS = [
	"docs/agent-development.md",
	"docs/maintainer-map.md",
	"docs/reference/concept-ownership.md",
];

const PATH_PREFIX_RE = /^(src|cli|bridge_src|capture-src|tests|scripts|docs|skills|bridge)\//;
const SCRIPT_PREFIX_RE = /^(?:check|sync|docs|test|bench|eval|smoke|build|verify|release|quality|new|scope):/;

function stripGeneratedBlocks(text) {
	return text.replace(/<!-- BEGIN GENERATED: [\s\S]*?<!-- END GENERATED: [^\n]*-->/g, "");
}

function normalizeBacktickedPath(token) {
	const first = token.trim().split(/\s+/)[0]
		.replace(/[),.;]+$/g, "")
		.replace(/:\d+(?:-\d+)?$/g, "")
		.replace(/^\.?\//, "");
	if (!PATH_PREFIX_RE.test(first)) return undefined;
	if (first.includes("*")) return undefined;
	return first;
}

function normalizeScript(token) {
	const first = token.trim().split(/\s+/)[0].replace(/[),.;]+$/g, "");
	if (!SCRIPT_PREFIX_RE.test(first)) return undefined;
	return first;
}

const pathIssues = [];
const scriptIssues = [];

for (const rel of DOCS) {
	if (!existsSync(path.join(root, rel))) continue;
	const text = stripGeneratedBlocks(read(rel));
	for (const match of text.matchAll(/`([^`\n]+)`/g)) {
		const maybePath = normalizeBacktickedPath(match[1]);
		if (maybePath && !existsSync(path.join(root, maybePath))) pathIssues.push(`${rel}: missing repo path \`${maybePath}\``);
		const maybeScript = normalizeScript(match[1]);
		if (maybeScript && !scripts[maybeScript]) scriptIssues.push(`${rel}: unknown package script \`${maybeScript}\``);
	}
	for (const match of text.matchAll(/\bnpm run ([A-Za-z0-9:._-]+)/g)) {
		const script = match[1];
		if (!scripts[script]) scriptIssues.push(`${rel}: unknown npm script \`${script}\``);
	}
}

assert.deepEqual(pathIssues, [], `doc path liveness failed:\n  - ${pathIssues.join("\n  - ")}`);
assert.deepEqual(scriptIssues, [], `doc package-script liveness failed:\n  - ${scriptIssues.join("\n  - ")}`);

console.log(`doc paths contract ok — ${DOCS.filter((rel) => existsSync(path.join(root, rel))).length} doc(s) scanned`);
