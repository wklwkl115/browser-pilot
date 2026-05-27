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
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-debugger-evidence-results.json"));
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
function persistentCdpPayload(response) {
	return response?.data?.result?.value ?? response?.data?.result?.result?.value;
}
function persistentCdpException(response) {
	return response?.data?.exceptionDetails ?? response?.data?.result?.exceptionDetails ?? response?.data?.result?.result?.exceptionDetails;
}
async function sendPersistentCdp(bridge, tabId, cdpMethod, params = {}, timeoutMs = 10_000) {
	return await bridge.sendCommand({
		cmd: "persistent_cdp",
		action: "send",
		tabId,
		cdpMethod,
		params,
		persistent: true,
		timeoutMs,
	}, { tabId, timeoutMs: timeoutMs + 2_000 });
}

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `debugger-evidence-profile-${runId}`);
const extensionDir = path.join(tempRoot, `debugger-evidence-extension-${runId}`);
const evidencePath = path.join(outDir, `debugger-evidence-smoke-artifact-${runId}.json`);
let fixture;
let chrome;
let bridge;
let tabId;
let result = { ok: false, resultPath, evidencePath, profileDir, extensionDir, extensionSource, steps };
try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort(18766, 18800);
	const fixturePort = await freePort(8801, 8840);
	const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "debugger-evidence.html"), "utf8");
	const fixtureUrl = `http://127.0.0.1:${fixturePort}/debugger-evidence.html`;
	fixture = createHttpServer((req, res) => {
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
	});
	if (!connected) throw new Error(`Browser extension did not connect to bridge port ${bridge.port}`);
	record("bridge.connected", true, { bridgePort, fixturePort, connectedClients: connected.connectedClients });
	const targetTab = await waitUntil(async () => {
		await bridge.refreshTabs(5_000).catch(() => undefined);
		return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`));
	});
	if (!targetTab?.tabId) throw new Error(`Fixture tab ${fixtureUrl} not found`);
	tabId = targetTab.tabId;
	await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10_000 }, { tabId, timeoutMs: 12_000 });
	record("fixture.open", true, { tabId, fixtureUrl });

	const debuggerEnabled = await sendPersistentCdp(bridge, tabId, "Debugger.enable", {});
	record("debugger.enable", debuggerEnabled?.data?.debuggerId !== undefined || debuggerEnabled?.data !== undefined, { data: debuggerEnabled.data });

	const clicked = await sendPersistentCdp(bridge, tabId, "Runtime.evaluate", {
		expression: `(() => { document.querySelector('#run-workflow')?.click(); return window.__DEBUGGER_FIXTURE_LAST__ || null; })()`,
		awaitPromise: true,
		returnByValue: true,
	});
	const clickedValue = persistentCdpPayload(clicked);
	record("runtime.evaluate.payload", clickedValue?.nested?.branch === "alpha" && typeof clickedValue?.nested?.token === "string", {
		branch: clickedValue?.nested?.branch,
		tokenLength: typeof clickedValue?.nested?.token === "string" ? clickedValue.nested.token.length : undefined,
		rawKeys: Object.keys(clicked?.data || {}),
	});

	const thrown = await sendPersistentCdp(bridge, tabId, "Runtime.evaluate", {
		expression: `(() => { throw new Error('debugger-evidence-marker'); })()`,
		awaitPromise: true,
		returnByValue: true,
	});
	const exception = persistentCdpException(thrown);
	const frames = Array.isArray(exception?.stackTrace?.callFrames) ? exception.stackTrace.callFrames : [];
	const topFrame = frames.find((frame) => String(frame.url || "").includes(`/debugger-evidence.html`));
	const scriptId = topFrame?.scriptId || exception?.scriptId;
	const exceptionObserved = typeof exception?.text === "string";
	const exceptionGap = !exceptionObserved || frames.length < 1;
	record("runtime.evaluate.exception", true, {
		exceptionObserved,
		frameCount: frames.length,
		topFrame,
		scriptId,
		expectedGap: exceptionGap,
		gap: exceptionGap ? "one-shot Runtime.evaluate does not currently expose stable exception details/call frames through this workflow" : undefined,
	});

	let scriptSource;
	if (scriptId) {
		const source = await sendPersistentCdp(bridge, tabId, "Debugger.getScriptSource", { scriptId });
		scriptSource = source?.data?.scriptSource ?? source?.data?.result?.scriptSource ?? source?.data?.result?.result?.scriptSource;
		record("debugger.getScriptSource", typeof scriptSource === "string" && scriptSource.includes("debugger-evidence-marker"), {
			scriptId,
			sourceLength: typeof scriptSource === "string" ? scriptSource.length : 0,
		});
		record("debugger.pageSourceGap", true, {
			expectedGap: true,
			gap: "current recipe can recover thrown eval source by scriptId, but cannot yet correlate page-authored script source such as buildPayload without debugger event stream or stronger provenance fields",
			scriptId,
		});
	} else {
		record("debugger.getScriptSource", true, {
			reason: "missing-scriptId",
			topFrame,
			expectedGap: true,
			gap: "without pause/event-stream evidence the current recipe cannot reliably recover scriptId for follow-up source reads",
		});
	}

	const disabled = await sendPersistentCdp(bridge, tabId, "Debugger.disable", {});
	record("debugger.disable", disabled?.data !== undefined, { data: disabled.data });
	const detached = await bridge.sendCommand({ cmd: "persistent_cdp", action: "detach", tabId, timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("persistent_cdp.detach", detached?.data !== undefined || detached?.ok === true, { data: detached.data });

	await writeFile(evidencePath, JSON.stringify({
		debuggerEnabled: debuggerEnabled.data,
		clicked: clicked.data,
		clickedValue,
		thrown: thrown.data,
		exceptionDetails: exception,
		topFrame,
		scriptSource,
		disabled: disabled.data,
		detached: detached.data,
	}, null, 2), "utf8");
	result.evidencePath = evidencePath;
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
