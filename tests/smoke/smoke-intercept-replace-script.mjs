import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-intercept-replace-script-results.json"));
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
function isWindowsChromeExecutable(chromeExe) {
	return process.platform !== "win32" && /\.exe$/i.test(String(chromeExe || "")) && /^\/mnt\/[a-z]\//i.test(String(chromeExe || ""));
}
function windowsPathForChrome(value, chromeExe) {
	if (!isWindowsChromeExecutable(chromeExe)) return value;
	const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(String(value || ""));
	if (!match) return value;
	return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}
function chromePath() {
	for (const candidate of chromeCandidates) if (existsSync(candidate)) return candidate;
	throw new Error(`Chrome/Chromium executable not found; set PI_BROWSER_SMOKE_CHROME. Tried: ${chromeCandidates.join(", ")}`);
}
async function freePort(start, end) {
	for (let port = start; port <= end; port += 1) {
		const server = createNetServer();
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
		.replace(/PI_BROWSER_BRIDGE_PORT\s*=\s*18765/g, `PI_BROWSER_BRIDGE_PORT = ${bridgePort}`)
		.replace(/PI_BROWSER_BRIDGE_PORT_RANGE_END\s*=\s*18784/g, `PI_BROWSER_BRIDGE_PORT_RANGE_END = ${bridgePort}`);
	await writeFile(serviceWorkerPath, source, "utf8");
}
async function waitUntil(predicate, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await delay(250);
	}
	return undefined;
}
const steps = [];
function record(step, ok, data = {}) { steps.push({ step, ok, ...data, t: Date.now() }); }

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `intercept-replace-script-profile-${runId}`);
const extensionDir = path.join(tempRoot, `intercept-replace-script-extension-${runId}`);
let chrome;
let fixture;
let bridge;
let tabId;
let result = { ok: false, resultPath, profileDir, extensionDir, extensionSource, steps };

try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort(18881, 18920);
	const fixturePort = await freePort(8921, 8960);
	const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "intercept-script-loader.html"), "utf8");
	const scriptBody = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "assets.intercept-target.js.txt"), "utf8");
	const fixtureUrl = `http://127.0.0.1:${fixturePort}/intercept-script-loader.html`;
	fixture = createHttpServer((req, res) => {
		if (req.url?.startsWith("/assets/intercept-target.js")) {
			res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": Buffer.byteLength(scriptBody) });
			res.end(scriptBody);
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) });
		res.end(fixtureHtml);
	});
	await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	await patchExtensionPort(extensionDir, bridgePort);
	bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort });
	await bridge.start();
	const chromeExe = chromePath();
	chrome = spawn(chromeExe, [
		`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`,
		`--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`,
		`--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--enable-logging=stderr",
		"--v=0",
		fixtureUrl,
	], { stdio: ["ignore", "pipe", "pipe"], detached: false });
	chrome.stdout.on("data", () => {});
	chrome.stderr.on("data", () => {});

	const connected = await waitUntil(() => {
		const snapshot = bridge.snapshot();
		return snapshot.extensionConnected ? snapshot : undefined;
	}, 20_000);
	if (!connected) throw new Error(`Browser extension did not connect to bridge port ${bridge.port}`);
	record("bridge.connected", true, { bridgePort, fixturePort, connectedClients: connected.connectedClients });

	const targetTab = await waitUntil(async () => {
		await bridge.refreshTabs(5_000).catch(() => undefined);
		return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`));
	}, 20_000);
	if (!targetTab?.tabId) throw new Error(`Fixture tab ${fixtureUrl} not found`);
	tabId = targetTab.tabId;
	await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10_000 }, { tabId, timeoutMs: 12_000 });
	record("fixture.open", true, { tabId, fixtureUrl });

	const install = await bridge.sendCommand({ cmd: "intercept.install", tabId, sessionId: "smoke-script", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.install", install.data?.active === true, { data: install.data });
	const replaceBody = "window.__INTERCEPT_SCRIPT_RESULT__ = 'patched-script';";
	const addRule = await bridge.sendCommand({
		cmd: "intercept.addRule",
		tabId,
		sessionId: "smoke-script",
		action: "replaceScript",
		matcher: { urlContains: "/assets/intercept-target.js", stage: "request", resourceType: "Script" },
		patch: { responseCode: 200, responseHeaders: { "content-type": "application/javascript; charset=utf-8" }, body: replaceBody },
		timeoutMs: 8_000,
	}, { tabId, timeoutMs: 10_000 });
	record("intercept.replaceRule", typeof addRule.data?.rule?.ruleId === "string", { ruleId: addRule.data?.rule?.ruleId });
	await bridge.executeJavaScript(`(() => { document.querySelector('#load-script')?.click(); return { clicked: true }; })()`, { tabId, timeoutMs: 8_000 });
	const pageResult = await waitUntil(async () => {
		const state = await bridge.executeJavaScript(`(() => ({ status: document.querySelector('#status')?.textContent || '', output: document.querySelector('#output')?.textContent || '', marker: window.__INTERCEPT_SCRIPT_RESULT__ || 'unset' }))()`, { tabId, timeoutMs: 6_000 });
		return state.data?.output === "patched-script" ? state : undefined;
	}, 15_000);
	if (!pageResult) throw new Error("auto-applied replaceScript did not change page output");
	record("intercept.pageResult", pageResult.data?.status === "Status: loaded" && pageResult.data?.output === "patched-script" && pageResult.data?.marker === "patched-script", { data: pageResult.data });
	const collect = await bridge.sendCommand({ cmd: "intercept.collect", tabId, sessionId: "smoke-script", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.collect", collect.data?.count >= 2 && collect.data?.events?.some((item) => item.event === "replace_script" && item.diagnostics?.autoApplied === true), { count: collect.data?.count, events: collect.data?.events?.map((item) => ({ event: item.event, autoApplied: item.diagnostics?.autoApplied })) });
	const status = await bridge.sendCommand({ cmd: "intercept.status", tabId, sessionId: "smoke-script", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.status", status.data?.ruleCount >= 1 && status.data?.pausedCount === 0, { data: status.data });
	const uninstall = await bridge.sendCommand({ cmd: "intercept.uninstall", tabId, sessionId: "smoke-script", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.uninstall", uninstall.data?.uninstalled === true, { data: uninstall.data });

	result.ok = steps.every((step) => step.ok !== false);
	if (!result.ok) process.exitCode = 1;
} catch (error) {
	record("error", false, { message: error instanceof Error ? error.message : String(error) });
	result.ok = false;
	process.exitCode = 1;
} finally {
	if (tabId && bridge) await bridge.closeTab(tabId, 2_000).catch(() => {});
	await bridge?.stop().catch(() => {});
	if (chrome?.pid) {
		if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
		else chrome.kill("SIGTERM");
	}
	if (fixture) await new Promise((resolve) => fixture.close(resolve));
	const keepTemp = process.env.PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE === "1" && result.ok === false;
	if (!keepTemp) {
		await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
	}
	await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
	console.log(JSON.stringify(result, null, 2));
}
