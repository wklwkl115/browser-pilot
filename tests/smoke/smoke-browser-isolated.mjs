import { spawn } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, stopProcessTree, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-isolated-results.json"));
const ciBrowserSmoke = process.env.PI_BROWSER_CI_BROWSER_SMOKE === "1";
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorDetails(error) {
	if (!error || typeof error !== "object") return { message: String(error) };
	return {
		name: error.name,
		message: error.message,
		code: error.code,
		errno: error.errno,
		syscall: error.syscall,
		path: error.path,
		spawnargs: error.spawnargs,
		spawnContext: error.spawnContext,
	};
}
function spawnWithContext(label, command, args, options) {
	try {
		return spawn(command, args, options);
	} catch (error) {
		error.spawnContext = { label, command, args, platform: process.platform, node: process.version };
		throw error;
	}
}
function startNodeSmoke(env) {
	const command = process.execPath;
	const args = [tsxCli, "tests/smoke/smoke-browser.mjs"];
	const child = spawnWithContext("node-smoke", command, args, {
			cwd: root,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); process.stdout.write(chunk); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk); });
	return {
		child,
		command,
		args,
		done: new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }))),
	};
}

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `smoke-profile-${runId}`);
const extensionDir = path.join(tempRoot, `smoke-extension-${runId}`);
let chrome;
let smokeChild;
let chromeStdout = "";
let chromeStderr = "";
let result = { ok: false, profileDir, extensionDir, extensionSource, resultPath };
try {
	await mkdir(outDir, { recursive: true });
	await mkdir(path.dirname(resultPath), { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort();
	const fixturePort = await freePort();
	result = { ...result, bridgePort, fixturePort };
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	await patchExtensionDistPort(extensionDir, bridgePort);
	const chromeExe = chromePath();
	const chromeProfileDir = windowsPathForChrome(profileDir, chromeExe);
	const chromeExtensionDir = windowsPathForChrome(extensionDir, chromeExe);
	result = { ...result, chrome: chromeExe, chromeProfileDir, chromeExtensionDir, ciBrowserSmoke, nodeSmokeCommand: process.execPath, nodeSmokeArgs: [tsxCli, "tests/smoke/smoke-browser.mjs"] };
	const smokeRun = startNodeSmoke({ PI_BROWSER_BRIDGE_PORT: String(bridgePort), PI_BROWSER_SMOKE_PORT: String(fixturePort), PI_BROWSER_SMOKE_REUSE_EXISTING: "1" });
	smokeChild = smokeRun.child;
	await delay(1000);
	const chromeArgs = [
		`--user-data-dir=${chromeProfileDir}`,
		`--disable-extensions-except=${chromeExtensionDir}`,
		`--load-extension=${chromeExtensionDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		...browserLaunchHardeningArgs(),
		"--enable-logging=stderr",
		"--v=0",
		`http://127.0.0.1:${fixturePort}/`,
	];
	chrome = spawnWithContext("browser", chromeExe, chromeArgs, { stdio: ["ignore", "pipe", "pipe"], detached: false });
	chrome.stdout.on("data", (chunk) => { chromeStdout += chunk.toString(); });
	chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });
	const smoke = await smokeRun.done;
	result = { ok: smoke.code === 0, bridgePort, fixturePort, chrome: chromeExe, profileDir, extensionDir, extensionSource, resultPath, chromeProfileDir, chromeExtensionDir, ciBrowserSmoke, nodeSmokeCommand: smokeRun.command, nodeSmokeArgs: smokeRun.args, smokeCode: smoke.code, smokeSignal: smoke.signal, stdoutTail: smoke.stdout.slice(-4000), stderrTail: smoke.stderr.slice(-4000), chromeStdoutTail: chromeStdout.slice(-4000), chromeStderrTail: chromeStderr.slice(-4000) };
	process.exitCode = smoke.code === 0 ? 0 : 1;
} catch (error) {
	result = { ...result, ok: false, error: error instanceof Error ? error.message : String(error), errorDetails: errorDetails(error) };
	process.exitCode = 1;
} finally {
	stopBrowserProcess(chrome);
	stopProcessTree(smokeChild);
	const keepTemp = process.env.PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE === "1" && result.ok === false;
	if (keepTemp) result.tempPreserved = { profileDir, extensionDir };
	else {
		await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
	}
	await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
	console.log(JSON.stringify(result, null, 2));
}
