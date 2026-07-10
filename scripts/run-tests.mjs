import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const scope = process.argv[2] || "all";
const root = process.cwd();
const testsDir = path.join(root, "tests");
const scopeDirs = {
	all: ["bootstrap", "cli", "artifacts", "web-security", "memory", "governance"],
	cli: ["bootstrap", "cli"],
	artifacts: ["bootstrap", "artifacts"],
	"web-security": ["bootstrap", "web-security"],
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
	if (!dirs) throw new Error(`unknown test scope: ${name}`);
	if (!fs.existsSync(testsDir)) return [];
	return walk(testsDir)
		.filter((filePath) => dirs.some((dir) => filePath.includes(`${path.sep}${dir}${path.sep}`)))
		.sort();
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: "inherit" });
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? 1}`))));
		child.on("error", reject);
	});
}

const selected = selectTests(scope);
if (selected.length === 0) {
	console.log(`ok: no tests registered for scope=${scope}`);
	process.exit(0);
}

await run("node", ["--import", "tsx", "--test", "--test-concurrency=1", ...selected]);
