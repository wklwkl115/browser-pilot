import { execFileSync, spawn } from "node:child_process";

const mode = process.argv[2] || "dev";
const requestedScope = process.argv[3] || "all";
const root = process.cwd();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const lintTargets = {
	all: ["index.ts", "src/apps/cli", "src/artifacts", "src/commands/artifactCommand.ts", "src/commands/webSecurity", "src/commands/summaries/webSecurity"],
	cli: ["src/apps/cli", "src/apps/daemon", "src/commands"],
	artifacts: ["src/artifacts", "src/commands/artifactCommand.ts"],
	"web-security": ["src/commands/webSecurity", "src/commands/summaries/webSecurity"],
	memory: ["src/commands/observe", "src/commands/memory", "src/kernels/abml", "src/kernels/memory"],
	governance: [],
};
const scopeMarkers = [
	["src/apps/cli/", "cli"],
	["src/artifacts/", "artifacts"],
	["src/commands/artifactCommand.ts", "artifacts"],
	["src/commands/observe/", "memory"],
	["src/commands/memory/", "memory"],
	["src/kernels/abml/", "memory"],
	["src/kernels/memory/", "memory"],
	["src/commands/webSecurity/", "web-security"],
	["src/commands/summaries/webSecurity/", "web-security"],
	["tests/cli/", "cli"],
	["tests/artifacts/", "artifacts"],
	["tests/web-security/", "web-security"],
	["tests/memory/", "memory"],
	["tests/governance/", "governance"],
	["REPO_GOVERNANCE.md", "governance"],
	["README.md", "governance"],
];

function resolveChangedScope() {
	const output = execFileSync("git", ["status", "--short", "--untracked-files=all", "--", "src", "tests", "mise.toml", ".github/workflows", "scripts", "README.md", "REPO_GOVERNANCE.md"], { cwd: root, encoding: "utf8" });
	const scopes = new Set();
	for (const rawLine of output.split(/\r?\n/).filter(Boolean)) {
		const line = rawLine.slice(3).trim();
		for (const [marker, scope] of scopeMarkers) if (line.includes(marker)) scopes.add(scope);
		if (line === "mise.toml" || line.startsWith("scripts/") || line.startsWith(".github/workflows/")) return "all";
	}
	return scopes.size === 1 ? [...scopes][0] : "all";
}

function scopeFor(modeName, scopeName) {
	if (modeName !== "affected") return scopeName;
	const resolved = resolveChangedScope();
	console.log(`affected-scope: requested=${scopeName} resolved=${resolved}`);
	return resolved;
}

function run(command, args, label, env = process.env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: root,
			env,
			stdio: "inherit",
			shell: process.platform === "win32" && command.endsWith(".cmd"),
		});
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with ${code ?? 1}`))));
		child.on("error", reject);
	});
}

async function runLint(scope) {
	const targets = lintTargets[scope] || lintTargets.all;
	if (targets.length === 0) {
		console.log(`ok: lint:${scope}: skipped`);
		return;
	}
	await run(npmCommand, ["exec", "--", "eslint", ...targets], `lint:${scope}`);
	console.log(`ok: lint:${scope}`);
}

async function runTypecheck() {
	await run(npmCommand, ["run", "--silent", "typecheck"], "typecheck");
	console.log("ok: typecheck");
}

async function runTestTypecheck() {
	await run(npmCommand, ["run", "--silent", "typecheck:tests"], "typecheck:tests");
	console.log("ok: typecheck:tests");
}

async function runTests(scope, env = process.env) {
	await run("node", ["scripts/run-tests.mjs", scope], `test:${scope}`, env);
}

async function runReachability() {
	await run(npmCommand, ["run", "--silent", "audit:reachability"], "audit:reachability");
	console.log("ok: audit:reachability");
}

async function runBuild() {
	await run(npmCommand, ["run", "--silent", "build"], "build");
	console.log("ok: build");
}

async function runNativeBuild() {
	await run("node", ["scripts/build-native.mjs", "--required"], "build:native");
	console.log("ok: build:native");
}

async function runCoverage(env = process.env) {
	await run("node", ["scripts/run-coverage.mjs", "all"], "coverage", env);
	console.log("ok: coverage");
}

async function runExtensionTypecheck() {
	// The MV3 extension is excluded from tsconfig.json/tsconfig.build.json, so the normal
	// typecheck/build never sees it. Validate it through its dedicated project so CI catches
	// extension-side type errors instead of silently skipping src/bridge/extension/**.
	await run(npmCommand, ["exec", "--", "tsc", "-p", "tsconfig.bridge-src.json"], "typecheck:extension");
	console.log("ok: typecheck:extension");
}

async function runProtocolCheck() {
	// Fail if the schema-derived protocol files drifted from src/bridge/protocol/native-command.schema.json.
	await run("node", ["scripts/sync-native-protocol.mjs", "--check"], "sync:protocol");
	console.log("ok: sync:protocol");
}

async function runFullLint() {
	// Whole-repo lint (matches `npm run lint`), broader than the scoped dev gate.
	await run(npmCommand, ["exec", "--", "eslint", "."], "lint");
	console.log("ok: lint");
}

const scope = scopeFor(mode, requestedScope);
if (!lintTargets[scope]) throw new Error(`unknown validation scope: ${scope}`);

if (mode === "dev" || mode === "affected") {
	const checks = scope === "governance" ? [runLint(scope), runTests(scope)] : [runLint(scope), runTypecheck(), runTestTypecheck(), runTests(scope)];
	await Promise.all(checks);
	process.exit(0);
}

if (mode === "verify") {
	await runNativeBuild();
	const nativeRequiredEnv = { ...process.env, BROWSER_PILOT_NATIVE_KERNELS_REQUIRED: "1" };
	await Promise.all([runReachability(), runTypecheck(), runTestTypecheck(), runExtensionTypecheck(), runProtocolCheck(), runTests("all", nativeRequiredEnv)]);
	await runCoverage(nativeRequiredEnv);
	await runFullLint();
	await runBuild();
	process.exit(0);
}

throw new Error(`unknown validation mode: ${mode}`);
