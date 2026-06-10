import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const closureDoc = "docs/jshookmcp-native-absorption.md";
assert(existsSync(path.join(root, closureDoc)), `${closureDoc} must track TODO 241 closure`);

const docs = {
	current: read("CURRENT.md"),
	roadmap: read("ROADMAP.md"),
	toolBoundaries: read("docs/tool-boundaries.md"),
	readme: read("README.md"),
	changelog: read("CHANGELOG.md"),
	closure: read(closureDoc),
};

for (const [name, text] of Object.entries(docs)) {
	assert(text.includes("jshookmcp"), `${name} must mention jshookmcp boundary`);
}

for (const text of [docs.current, docs.roadmap, docs.readme, docs.toolBoundaries, docs.changelog]) {
	assert(text.includes(closureDoc), `public planning docs must reference ${closureDoc}`);
}

for (const required of [
	"TODO 241.1",
	"TODO 241.2",
	"TODO 241.3",
	"TODO 241.4",
	"TODO 241.5",
	"完成定义",
	"非目标",
	"任务账本",
	"能力归属表",
	"新公开工具 RFC 准入",
]) {
	assert(docs.closure.includes(required), `${closureDoc} must include ${required}`);
}

const rejectedPublicTools = [
	"browser_sources",
	"browser_debugger",
	"browser_intercept",
	"browser_storage",
	"browser_canvas",
];
for (const tool of rejectedPublicTools) {
	assert(docs.current.includes(tool), `CURRENT.md must record rejected tool ${tool}`);
	assert(docs.toolBoundaries.includes(tool), `tool boundaries must record rejected tool ${tool}`);
	assert(docs.closure.includes(tool), `${closureDoc} must record rejected tool ${tool}`);
}

const allowedMentions = new Set([
	"CURRENT.md",
	"ROADMAP.md",
	"README.md",
	"CHANGELOG.md",
	"docs/tool-boundaries.md",
	closureDoc,
	"docs/archive/jshookmcp-native-absorption.full.md",
	"evals/browser-workflows/eval-plan.md",
	"evals/browser-workflows/12-jshook-source-map-artifact.md",
	"evals/browser-workflows/13-jshook-storage-evidence.md",
	"evals/browser-workflows/14-jshook-replay-not-intercept.md",
	"evals/browser-workflows/15-jshook-canvas-observation.md",
	"tests/contracts/tools/check-jshookmcp-closure.mjs",
]);

function walk(rel) {
	const dir = path.join(root, rel);
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".pi") continue;
		const child = path.join(rel, entry.name).replace(/\\/g, "/");
		if (entry.isDirectory()) out.push(...walk(child));
		else out.push(child);
	}
	return out;
}

for (const rel of ["src", "bridge_src", "bridge", "config"].filter((dir) => existsSync(path.join(root, dir)))) {
	for (const file of walk(rel)) {
		if (!/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(file)) continue;
		const text = read(file);
		for (const tool of rejectedPublicTools) {
			assert(!text.includes(tool), `${file} must not register or document rejected public tool ${tool}`);
		}
	}
}

for (const file of walk(".")) {
	if (!/\.(md|ts|tsx|js|mjs|cjs|json)$/.test(file)) continue;
	if (file.startsWith(".research/") || file.startsWith("sessions/") || file.startsWith("node_modules/") || file.startsWith(".git/")) continue;
	const text = read(file);
	for (const tool of rejectedPublicTools) {
		if (!text.includes(tool)) continue;
		assert(allowedMentions.has(file), `${file} mentions rejected tool ${tool}; keep TODO 241 references in approved planning/eval docs only`);
	}
}

const packageText = read("package.json");
assert(packageText.includes("check-jshookmcp-closure.mjs"), "package scripts must run jshookmcp closure contract");
assert(statSync(path.join(root, closureDoc)).size > 2000, `${closureDoc} must contain the full closure plan, not a stub`);
console.log("jshookmcp closure contract ok");
