import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(root, "bridge", "pi_browser_bridge");
const chromeCandidates = [
	process.env.PI_BROWSER_SMOKE_CHROME,
	process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
	process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
	process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function chromePath() {
	for (const candidate of chromeCandidates) if (existsSync(candidate)) return candidate;
	throw new Error(`Chrome/Chromium executable not found; set PI_BROWSER_SMOKE_CHROME. Tried: ${chromeCandidates.join(", ")}`);
}
async function freePort(start, end) {
	for (let port = start; port <= end; port += 1) {
		const server = createServer();
		try {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
			await new Promise((resolve) => server.close(resolve));
			return port;
		} catch {
			await new Promise((resolve) => server.close(resolve));
		}
	}
	throw new Error(`No free port in range ${start}-${end}`);
}
async function patchExtensionPort(extensionDir, bridgePort) {
	const serviceWorkerPath = path.join(extensionDir, "dist", "service-worker.js");
	let source = await readFile(serviceWorkerPath, "utf8");
	source = source
		.replaceAll("127.0.0.1:18765", `127.0.0.1:${bridgePort}`)
		.replace(/PI_BROWSER_BRIDGE_PORT\s*=\s*18765/g, `PI_BROWSER_BRIDGE_PORT = ${bridgePort}`);
	await writeFile(serviceWorkerPath, source, "utf8");
}
function startNodeSmoke(env) {
	const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", "--import", "./scripts/register-ts-extension-loader.mjs", "tests/smoke/smoke-browser.mjs"], {
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
let result = { ok: false, profileDir, extensionDir };
try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	const bridgePort = await freePort(18766, 18800);
	const fixturePort = await freePort(8766, 8800);
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	await patchExtensionPort(extensionDir, bridgePort);
	const chromeExe = chromePath();
	const smokeRun = startNodeSmoke({ PI_BROWSER_BRIDGE_PORT: String(bridgePort), PI_BROWSER_SMOKE_PORT: String(fixturePort), PI_BROWSER_SMOKE_REUSE_EXISTING: "1" });
	smokeChild = smokeRun.child;
	await delay(1000);
	chrome = spawn(chromeExe, [
		`--user-data-dir=${profileDir}`,
		`--disable-extensions-except=${extensionDir}`,
		`--load-extension=${extensionDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--enable-logging=stderr",
		"--v=0",
		`http://127.0.0.1:${fixturePort}/`,
	], { stdio: ["ignore", "pipe", "pipe"], detached: false });
	chrome.stdout.on("data", (chunk) => { chromeStdout += chunk.toString(); });
	chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });
	const smoke = await smokeRun.done;
	result = { ok: smoke.code === 0, bridgePort, fixturePort, chrome: chromeExe, profileDir, extensionDir, smokeCode: smoke.code, smokeSignal: smoke.signal, stdoutTail: smoke.stdout.slice(-4000), stderrTail: smoke.stderr.slice(-4000), chromeStdoutTail: chromeStdout.slice(-4000), chromeStderrTail: chromeStderr.slice(-4000) };
	process.exitCode = smoke.code === 0 ? 0 : 1;
} catch (error) {
	result = { ...result, ok: false, error: error instanceof Error ? error.message : String(error) };
	process.exitCode = 1;
} finally {
	if (chrome?.pid) {
		if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
		else chrome.kill("SIGTERM");
	}
	if (smokeChild && smokeChild.exitCode === null) smokeChild.kill("SIGTERM");
	await rm(profileDir, { recursive: true, force: true }).catch(() => {});
	await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
	await writeFile(path.join(outDir, "smoke-browser-isolated-results.json"), JSON.stringify(result, null, 2), "utf8");
	console.log(JSON.stringify(result, null, 2));
}
