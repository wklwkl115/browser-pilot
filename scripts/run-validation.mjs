import { execFileSync, spawn } from "node:child_process";

const mode = process.argv[2] || "dev";
const requestedScope = process.argv[3] || "all";
const root = process.cwd();
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const lintTargets = {
	all: ["index.ts", "src/apps/cli", "src/artifacts", "src/commands/artifactCommand.ts", "src/commands/webSecurity/shared/jsAst.ts", "src/commands/webSecurity/shared/jsAstArtifact.ts"],
	cli: ["src/apps/cli", "src/apps/daemon", "src/commands"],
	artifacts: ["src/artifacts", "src/commands/artifactCommand.ts"],
	"js-ast": ["src/commands/webSecurity/shared/jsAst.ts", "src/commands/webSecurity/shared/jsAstArtifact.ts"],
	governance: [],
};
const scopeMarkers = [
	["src/apps/cli/", "cli"],
	["src/artifacts/", "artifacts"],
	["src/commands/artifactCommand.ts", "artifacts"],
	["src/commands/webSecurity/shared/jsAst", "js-ast"],
	["tests/cli/", "cli"],
	["tests/artifacts/", "artifacts"],
	["tests/js-ast/", "js-ast"],
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

function run(command, args, label) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: root,
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

async function runTests(scope) {
	await run("node", ["scripts/run-tests.mjs", scope], `test:${scope}`);
}

async function runReachability() {
	await run(npmCommand, ["run", "--silent", "audit:reachability"], "audit:reachability");
	console.log("ok: audit:reachability");
}

async function runBuild() {
	await run(npmCommand, ["run", "--silent", "build"], "build");
	console.log("ok: build");
}

const scope = scopeFor(mode, requestedScope);
if (!lintTargets[scope]) throw new Error(`unknown validation scope: ${scope}`);

if (mode === "dev" || mode === "affected") {
	const checks = scope === "governance" ? [runLint(scope), runTests(scope)] : [runLint(scope), runTypecheck(), runTests(scope)];
	await Promise.all(checks);
	process.exit(0);
}

if (mode === "verify") {
	await Promise.all([runReachability(), runTypecheck(), runTests("all")]);
	await runLint("all");
	await runBuild();
	process.exit(0);
}

throw new Error(`unknown validation mode: ${mode}`);
