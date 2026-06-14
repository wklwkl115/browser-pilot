import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNpmSync, throwIfNpmFailed } from "../support/npm-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactsDir = path.join(root, ".pi", "browser-artifacts", "portable-acceptance");
const publicTreeDir = path.join(artifactsDir, "public-tree");
const tarballDir = path.join(artifactsDir, "tarball");
const consumerDir = path.join(artifactsDir, "consumer");
const summaryPath = path.join(artifactsDir, "portable-acceptance-summary.json");
const forbiddenPublicPathRe = /^(?:AGENTS|TODO|CURRENT|ARCHIVE|ROADMAP|WORKSTREAMS_A_E_SUMMARY)\.md$|^(?:docs\/archive|agent-audits|\.plan|\.claude|skills\/browser-pilot-audit-fix|skills\/browser-pilot-blind-eval|skills\/pi-kernel-audit)(?:\/|$)|^evals\/browser-workflows\/blind-/;

function run(command, argv, options = {}) {
	const result = spawnSync(command, argv, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
	if (result.status !== 0) {
		const error = new Error(`${command} ${argv.join(" ")} failed with exit ${result.status ?? result.error?.code ?? "unknown"}`);
		error.details = {
			command,
			argv,
			cwd: options.cwd || root,
			status: result.status,
			signal: result.signal,
			errorCode: result.error?.code,
			errorMessage: result.error?.message,
			stdoutTail: String(result.stdout || "").slice(-4000),
			stderrTail: String(result.stderr || "").slice(-4000),
		};
		throw error;
	}
	return result;
}

function runNpm(args, options = {}) {
	return throwIfNpmFailed(runNpmSync(args, options), `npm ${args.join(" ")}`);
}

function parseNpmPackJson(stdout) {
	const text = String(stdout || "");
	const start = text.indexOf("[");
	assert(start >= 0, "npm pack must emit a JSON array");
	return JSON.parse(text.slice(start))[0];
}

function publicFiles() {
	const output = run("git", ["ls-files", "-co", "--exclude-standard", "-z"]).stdout;
	return output.split("\0")
		.filter(Boolean)
		.map((file) => file.replace(/\\/g, "/"))
		.filter((file) => existsSync(path.join(root, file)) && statSync(path.join(root, file)).isFile())
		.sort();
}

async function copyPublicTree(files) {
	await rm(publicTreeDir, { recursive: true, force: true });
	await mkdir(publicTreeDir, { recursive: true });
	for (const rel of files) {
		assert(!forbiddenPublicPathRe.test(rel), `public source tree must not include internal-only path: ${rel}`);
		const target = path.join(publicTreeDir, rel);
		await mkdir(path.dirname(target), { recursive: true });
		await copyFile(path.join(root, rel), target);
	}
}

function binPath() {
	return path.join(consumerDir, "node_modules", ".bin", process.platform === "win32" ? "browser-pilot.cmd" : "browser-pilot");
}

function runConsumerBin(args) {
	const env = {
		...process.env,
		PI_BROWSER_DAEMON_STATE_DIR: path.join(consumerDir, ".pi-daemon-state"),
	};
	return run(binPath(), args, { cwd: consumerDir, shell: process.platform === "win32", env });
}

function parseJsonOutput(result, label) {
	try {
		return JSON.parse(String(result.stdout || ""));
	} catch (error) {
		const wrapped = new Error(`${label} did not emit valid JSON`);
		wrapped.details = { stdoutTail: String(result.stdout || "").slice(-4000), stderrTail: String(result.stderr || "").slice(-4000), cause: error instanceof Error ? error.message : String(error) };
		throw wrapped;
	}
}

async function verifyConsumerCli(tarball) {
	await rm(consumerDir, { recursive: true, force: true });
	await mkdir(consumerDir, { recursive: true });
	await writeFile(path.join(consumerDir, "package.json"), JSON.stringify({ private: true, name: "browser-pilot-portable-consumer", version: "0.0.0" }, null, 2), "utf8");
	runNpm(["install", "--ignore-scripts", tarball], { cwd: consumerDir });
	assert(existsSync(binPath()), "consumer install must expose browser-pilot bin");

	const help = runConsumerBin(["--help"]);
	const helpText = String(help.stdout || "");
	assert(helpText.includes("browser-pilot — drive a live browser"), "consumer CLI help must use the browser-pilot command name");
	assert(!helpText.includes("pi-browser "), "consumer CLI help must not tell users to run the old pi-browser command");

	const commands = parseJsonOutput(runConsumerBin(["commands", "--json"]), "browser-pilot commands --json");
	assert.equal(commands.ok, true, "commands --json must return ok:true");
	assert(Array.isArray(commands.commands) && commands.commands.length === 22, "commands --json must list all 22 browser commands");
	assert(String(commands.commands[0]?.artifactBehavior?.readCommand || "").startsWith("browser-pilot "), "artifact read commands must use browser-pilot");

	const schema = parseJsonOutput(runConsumerBin(["schema", "observe", "--json"]), "browser-pilot schema observe --json");
	assert.equal(schema.ok, true, "schema observe --json must return ok:true");
	assert.equal(schema.name, "observe", "schema observe must describe the observe command");

	const status = parseJsonOutput(runConsumerBin(["status", "--json"]), "browser-pilot status --json");
	assert.equal(status.ok, true, "status --json must return ok:true even without a connected extension");
	assert.equal(status.ready, false, "fresh consumer status should report not-ready without starting a browser");
	for (const item of status.recovery?.commands || []) {
		assert(String(item.command || "").startsWith("browser-pilot "), `status recovery command must use browser-pilot: ${item.command}`);
	}

	return {
		helpFirstLine: helpText.split(/\r?\n/)[0],
		commandCount: commands.commands.length,
		statusReady: status.ready,
		bin: binPath(),
	};
}

async function main() {
	await mkdir(artifactsDir, { recursive: true });
	const summary = {
		ok: false,
		createdAt: new Date().toISOString(),
		artifactsDir,
		publicTreeDir,
		consumerDir,
		summaryPath,
	};
	try {
		const files = publicFiles();
		summary.publicTree = { fileCount: files.length };
		await copyPublicTree(files);

		runNpm(["ci"], { cwd: publicTreeDir });
		runNpm(["run", "build"], { cwd: publicTreeDir });
		runNpm(["run", "build:bridge"], { cwd: publicTreeDir });
		runNpm(["run", "docs:sync"], { cwd: publicTreeDir });
		runNpm(["run", "check:all:package"], { cwd: publicTreeDir });

		await rm(tarballDir, { recursive: true, force: true });
		await mkdir(tarballDir, { recursive: true });
		const pack = parseNpmPackJson(runNpm(["pack", "--pack-destination", tarballDir, "--json"], { cwd: publicTreeDir }).stdout);
		const tarball = path.resolve(tarballDir, path.basename(pack.filename));
		assert(existsSync(tarball), `npm pack tarball must exist: ${tarball}`);
		summary.pack = { filename: pack.filename, entryCount: pack.entryCount, size: pack.size, unpackedSize: pack.unpackedSize, tarball };
		summary.consumer = await verifyConsumerCli(tarball);
		summary.ok = true;
	} catch (error) {
		summary.ok = false;
		summary.error = error instanceof Error ? error.message : String(error);
		if (error && typeof error === "object" && "details" in error) summary.errorDetails = error.details;
		process.exitCode = 1;
	} finally {
		await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
		console.log(JSON.stringify(summary, null, 2));
	}
}

await main();
