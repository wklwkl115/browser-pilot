import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = path.join(root, ".pi", "browser-artifacts", "public-package");
const tarballDir = path.join(artifactsDir, "tarball");
const consumerDir = path.join(artifactsDir, "consumer");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: process.platform === "win32" && command.endsWith(".cmd"),
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed\n${String(result.stdout || "").slice(-2000)}\n${String(result.stderr || "").slice(-2000)}`);
	}
	return result;
}

function npm(args, options = {}) {
	const command = process.platform === "win32" ? "npm.cmd" : "npm";
	return run(command, args, options);
}

function parsePack(stdout) {
	const text = String(stdout || "");
	const start = text.indexOf("[");
	assert(start >= 0, "npm pack must emit JSON");
	return JSON.parse(text.slice(start))[0];
}

function packageFiles() {
	return parsePack(npm(["pack", "--dry-run", "--ignore-scripts", "--json"]).stdout).files.map((file) => file.path);
}

function assertCleanPackage(files) {
	const forbidden = files.filter((file) =>
		file.startsWith("tests/") ||
		file.startsWith("evals/") ||
		file.startsWith("agent-audits/") ||
		file.startsWith("docs/archive/") ||
		file.startsWith(".vscode/") ||
		/^(AI_INSTALL\.md|AGENTS\.md|TODO\.md|CURRENT\.md|ROADMAP\.md|ARCHIVE\.md|WORKSTREAMS_A_E_SUMMARY\.md|lefthook\.yml|\.aceignore)$/.test(file)
	);
	assert.deepEqual(forbidden, [], `package contains development-only files:\n${forbidden.join("\n")}`);
	for (const required of [
		"dist/index.js",
		"dist/cli/bin.js",
		"bridge/pi_browser_bridge/manifest.json",
		"bridge/pi_browser_bridge/dist/service-worker.js",
		"docs/browser-usage.md",
		"README.md",
		"LICENSE",
	]) {
		assert(files.includes(required), `package missing required user/runtime file: ${required}`);
	}
}

function binPath() {
	return path.join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "browser-pilot.cmd" : "browser-pilot");
}

function runConsumerBin(args) {
	return run(binPath(), args, { cwd: consumerDir });
}

rmSync(artifactsDir, { recursive: true, force: true });
mkdirSync(tarballDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

const dryRunFiles = packageFiles();
assertCleanPackage(dryRunFiles);
const pack = parsePack(npm(["pack", "--pack-destination", tarballDir, "--json"]).stdout);
const tarball = path.join(tarballDir, path.basename(pack.filename));
assert(existsSync(tarball), `tarball was not created: ${tarball}`);

writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ private: true, name: "browser-pilot-consumer-smoke", version: "0.0.0" }, null, 2), "utf8");
npm(["install", "--ignore-scripts", tarball], { cwd: consumerDir });
assert(existsSync(binPath()), "consumer install must expose browser-pilot bin");

const help = runConsumerBin(["--help"]).stdout;
assert(help.includes("browser-pilot"), "CLI help must mention browser-pilot");
const commands = JSON.parse(runConsumerBin(["commands", "--json"]).stdout);
assert.equal(commands.ok, true, "commands --json must return ok:true");
assert(Array.isArray(commands.commands) && commands.commands.length === 22, "commands --json must list all browser commands");
const schema = JSON.parse(runConsumerBin(["schema", "observe", "--json"]).stdout);
assert.equal(schema.ok, true, "schema observe --json must return ok:true");
const status = JSON.parse(runConsumerBin(["status", "--json"]).stdout);
assert.equal(status.ok, true, "status --json must return ok:true without a connected extension");

console.log(JSON.stringify({
	ok: true,
	packageEntryCount: dryRunFiles.length,
	tarball,
	consumerBin: binPath(),
	commandCount: commands.commands.length,
	statusReady: status.ready,
}, null, 2));
