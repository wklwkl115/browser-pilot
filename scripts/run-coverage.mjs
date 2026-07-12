import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scope = process.argv[2] || "all";
const root = process.cwd();
const testsDir = path.join(root, "tests");
const coverageDir = path.join(root, "coverage");
const coverageThresholds = {
	lines: 70,
	branches: 65,
	functions: 60,
};
const minimumCoveredSourceModuleRatio = 0.9;
const generatedCoverageExclusions = [
	"/src/types/nativeProtocol.ts",
	"/src/types/nativeErrorCodes.ts",
	"/src/commands/nativeActionMetadata.ts",
	"/src/bridge/extension/service_worker/protocol.ts",
];
const scopeDirs = {
	all: ["bootstrap", "cli", "artifacts", "web-security", "observe", "governance"],
	cli: ["bootstrap", "cli"],
	artifacts: ["bootstrap", "artifacts"],
	"web-security": ["bootstrap", "web-security"],
	observe: ["bootstrap", "observe"],
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

function normalizedFilePath(filePath) {
	return path.resolve(filePath).replaceAll("\\", "/").toLowerCase();
}

function coveredSourceModuleCount(eligibleSourceModules) {
	const sourcePaths = new Set();
	for (const name of fs.readdirSync(coverageDir)) {
		if (!name.endsWith(".json")) continue;
		const report = JSON.parse(fs.readFileSync(path.join(coverageDir, name), "utf8"));
		for (const entry of report.result || []) {
			const url = String(entry.url || "");
			if (!url.startsWith("file:")) continue;
			let sourcePath;
			try {
				sourcePath = normalizedFilePath(fileURLToPath(url));
			} catch {
				continue;
			}
			if (eligibleSourceModules.has(sourcePath)) sourcePaths.add(sourcePath);
		}
	}
	return sourcePaths.size;
}

function sourceModulePaths(dir = path.join(root, "src"), modules = new Set()) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			sourceModulePaths(filePath, modules);
			continue;
		}
		const normalized = filePath.replaceAll("\\", "/");
		if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts") || generatedCoverageExclusions.some((suffix) => normalized.endsWith(suffix))) continue;
		modules.add(normalizedFilePath(filePath));
	}
	return modules;
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
			`--test-coverage-lines=${coverageThresholds.lines}`,
			`--test-coverage-branches=${coverageThresholds.branches}`,
			`--test-coverage-functions=${coverageThresholds.functions}`,
			"--test-coverage-include=src/**/*.ts",
			"--test-coverage-include=index.ts",
			"--test-coverage-exclude=src/types/nativeProtocol.ts",
			"--test-coverage-exclude=src/types/nativeErrorCodes.ts",
			"--test-coverage-exclude=src/commands/nativeActionMetadata.ts",
			"--test-coverage-exclude=src/bridge/extension/service_worker/protocol.ts",
			...selected,
		],
		{ ...process.env, BROWSER_PILOT_COVERAGE: "1", NODE_V8_COVERAGE: coverageDir },
	);
} catch (error) {
	console.error(
		`coverage:${scope} failed: required coverage is lines>=${coverageThresholds.lines}%, branches>=${coverageThresholds.branches}%, functions>=${coverageThresholds.functions}%. See the executed-source report above and V8 JSON in ${path.relative(root, coverageDir)}.`,
	);
	throw error;
}

const eligibleSourceModules = sourceModulePaths();
const coveredSourceModules = coveredSourceModuleCount(eligibleSourceModules);
const sourceModules = eligibleSourceModules.size;
const minimumCoveredSourceModules = Math.ceil(sourceModules * minimumCoveredSourceModuleRatio);
if (coveredSourceModules < minimumCoveredSourceModules) {
	throw new Error(`coverage:${scope} loaded ${coveredSourceModules}/${sourceModules} source modules; expected at least ${(minimumCoveredSourceModuleRatio * 100).toFixed(0)}%`);
}

console.log(
	`ok: coverage:${scope}: ${coveredSourceModules}/${sourceModules} source modules loaded; coverage met lines>=${coverageThresholds.lines}%, branches>=${coverageThresholds.branches}%, functions>=${coverageThresholds.functions}%; v8 json written to ${path.relative(root, coverageDir)}`,
);
