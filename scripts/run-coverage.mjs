import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const scope = process.argv[2] || "all";
const root = process.cwd();
const testsDir = path.join(root, "tests");
const coverageDir = path.join(root, "coverage");
const scopeDirs = {
	all: ["bootstrap", "cli", "artifacts", "js-ast", "memory", "governance"],
	cli: ["bootstrap", "cli"],
	artifacts: ["bootstrap", "artifacts"],
	"js-ast": ["bootstrap", "js-ast"],
	memory: ["bootstrap", "memory"],
	governance: ["bootstrap", "governance"],
};

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(filePath, out);
		else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(filePath);
	}
	return out;
}

function selectTests(name) {
	const dirs = scopeDirs[name];
	if (!dirs) throw new Error(`unknown coverage scope: ${name}`);
	if (!fs.existsSync(testsDir)) return [];
	return walk(testsDir)
		.filter((filePath) => dirs.some((dir) => filePath.includes(`${path.sep}${dir}${path.sep}`)))
		.sort();
}

function run(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? 1}`))));
		child.on("error", reject);
	});
}

const selected = selectTests(scope);
if (selected.length === 0) {
	console.log(`ok: no tests registered for coverage scope=${scope}`);
	process.exit(0);
}

fs.rmSync(coverageDir, { force: true, recursive: true });
fs.mkdirSync(coverageDir, { recursive: true });

await run(
	"node",
	[
		"--import",
		"tsx",
		"--test",
		"--test-concurrency=1",
		"--experimental-test-coverage",
		"--test-coverage-include=src/**/*.ts",
		"--test-coverage-include=index.ts",
		"--test-coverage-exclude=src/bridge/extension/**",
		"--test-coverage-exclude=src/types/**",
		...selected,
	],
	{ ...process.env, NODE_V8_COVERAGE: coverageDir },
);

console.log(`ok: coverage:${scope}: v8 json written to ${path.relative(root, coverageDir)}`);
