import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const scope = process.argv[2] || "all";
const root = process.cwd();
const testsDir = path.join(root, "tests");
const coverageDir = path.join(root, "coverage");
const coverageThresholdPercent = 80;
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

try {
	await run(
		"node",
		[
			"--import",
			"tsx",
			"--test",
			"--test-concurrency=1",
			"--experimental-test-coverage",
			`--test-coverage-lines=${coverageThresholdPercent}`,
			`--test-coverage-branches=${coverageThresholdPercent}`,
			`--test-coverage-functions=${coverageThresholdPercent}`,
			"--test-coverage-include=src/**/*.ts",
			"--test-coverage-include=index.ts",
			"--test-coverage-exclude=src/bridge/**",
			"--test-coverage-exclude=src/apps/**",
			"--test-coverage-exclude=src/artifacts/**",
			"--test-coverage-exclude=src/browser-runtime/**",
			"--test-coverage-exclude=src/browser-command-runtime/**",
			"--test-coverage-exclude=src/browser-page-runtime/**",
			"--test-coverage-exclude=src/commands/**",
			"--test-coverage-exclude=src/content/**",
			"--test-coverage-exclude=src/memory/**",
			"--test-coverage-exclude=src/resources/**",
			"--test-coverage-exclude=src/scan/**",
			"--test-coverage-exclude=src/utils/**",
			"--test-coverage-exclude=src/validation/**",
			"--test-coverage-exclude=src/native/**",
			"--test-coverage-exclude=src/kernels/abml/**",
			"--test-coverage-exclude=src/kernels/evidence/**",
			"--test-coverage-exclude=src/kernels/memory/**",
			"--test-coverage-exclude=src/kernels/refs/**",
			"--test-coverage-exclude=src/kernels/security/**",
			"--test-coverage-exclude=src/kernels/session/**",
			"--test-coverage-exclude=src/types/**",
			...selected,
		],
		{ ...process.env, NODE_V8_COVERAGE: coverageDir },
	);
} catch (error) {
	console.error(
		`coverage:${scope} failed: lines, branches, and functions must each be >= ${coverageThresholdPercent}%. See the coverage report above and V8 JSON in ${path.relative(root, coverageDir)}.`,
	);
	throw error;
}

console.log(
	`ok: coverage:${scope}: v8 json written to ${path.relative(root, coverageDir)}; lines/branches/functions >= ${coverageThresholdPercent}%`,
);
