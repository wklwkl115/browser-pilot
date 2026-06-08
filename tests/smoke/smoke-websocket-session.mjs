import { spawn } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-websocket-session-results.json"));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
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

async function startWsFixture() {
	const transcript = [];
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	server.on("connection", (ws) => {
		transcript.push({ event: "open", t: Date.now() });
		ws.on("message", (data) => {
			const text = data.toString();
			transcript.push({ event: "message", direction: "inbound", text, t: Date.now() });
			if (text === "ping") ws.send('{"type":"pong","ok":true}');
			else if (text === "alpha") ws.send("echo:alpha");
			else if (text === "beta") ws.send("echo:beta");
			else ws.send(`echo:${text}`);
		});
	});
	await new Promise((resolve) => server.once("listening", resolve));
	const address = server.address();
	return {
		server,
		port: address.port,
		url: `ws://127.0.0.1:${address.port}`,
		transcript,
	};
}

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `websocket-session-profile-${runId}`);
const extensionDir = path.join(tempRoot, `websocket-session-extension-${runId}`);
let chrome;
let bridge;
let wsFixture;
let result = { ok: false, resultPath, profileDir, extensionDir, extensionSource, steps };

try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort();
	wsFixture = await startWsFixture();
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	await patchExtensionDistPort(extensionDir, bridgePort);
	bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort });
	await bridge.start();
	const chromeExe = chromePath();
	chrome = spawn(chromeExe, [
		`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`,
		`--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`,
		`--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`,
		"--no-first-run",
		"--no-default-browser-check",
		...browserLaunchHardeningArgs(),
		"--enable-logging=stderr",
		"--v=0",
		"about:blank",
	], { stdio: ["ignore", "pipe", "pipe"], detached: false });
	chrome.stdout.on("data", () => {});
	chrome.stderr.on("data", () => {});

	const connected = await waitUntil(() => {
		const snapshot = bridge.snapshot();
		return snapshot.extensionConnected ? snapshot : undefined;
	}, 20_000);
	if (!connected) throw new Error(`Browser extension did not connect to bridge port ${bridge.port}`);
	record("bridge.connected", true, { bridgePort, wsPort: wsFixture.port, connectedClients: connected.connectedClients });

	const created = await bridge.createTab("about:blank", true, 5_000);
	const tabId = created.data?.tabId || created.data?.id;
	if (!tabId) throw new Error("WS smoke target tab was not created");
	const syncedTab = await waitUntil(async () => {
		await bridge.refreshTabs(5_000).catch(() => undefined);
		return bridge.getTabs().find((tab) => tab.tabId === tabId && !tab.disconnectedAt);
	}, 10_000);
	if (!syncedTab) throw new Error(`WS smoke tab ${tabId} did not appear in tab sync`);
	await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10_000 }, { tabId, timeoutMs: 12_000 });
	record("tabs.create", true, { tabId });

	const open = await bridge.sendCommand({ cmd: "ws.open", tabId, sessionId: "smoke-ws", url: wsFixture.url, timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("ws.open", open.data?.session?.state === "open", { session: open.data?.session });

	const send = await bridge.sendCommand({ cmd: "ws.send", tabId, sessionId: "smoke-ws", text: "ping", timeoutMs: 5_000 }, { tabId, timeoutMs: 8_000 });
	record("ws.send", send.data?.sent?.preview === "ping", { sent: send.data?.sent });

	const wait = await bridge.sendCommand({ cmd: "ws.wait", tabId, sessionId: "smoke-ws", contains: "pong", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("ws.wait", wait.data?.entry?.event === "message" && String(wait.data?.entry?.text || "").includes("pong"), { matcher: wait.data?.matcher, entry: wait.data?.entry });

	const replay = await bridge.sendCommand({ cmd: "ws.replay", tabId, sessionId: "smoke-ws", steps: [{ text: "alpha", contains: "echo:alpha", timeoutMs: 5_000 }, { text: "beta", contains: "echo:beta", timeoutMs: 5_000 }], timeoutMs: 10_000 }, { tabId, timeoutMs: 12_000 });
	record("ws.replay", Array.isArray(replay.data?.steps) && replay.data.steps.length === 2, { steps: replay.data?.steps });

	const replayFail = await bridge.sendCommand({ cmd: "ws.replay", tabId, sessionId: "smoke-ws", steps: [{ text: "gamma", contains: "never-match", timeoutMs: 200 }], timeoutMs: 2_000 }, { tabId, timeoutMs: 3_000 }).then((value) => value, (error) => error?.details?.result || error);
	record("ws.replay.failure", replayFail?.ok === false && replayFail?.details?.stepIndex === 0 && Array.isArray(replayFail?.details?.partialTranscript), { error_code: replayFail?.error_code, details: replayFail?.details });

	const collect = await bridge.sendCommand({ cmd: "ws.collect", tabId, sessionId: "smoke-ws", timeoutMs: 5_000 }, { tabId, timeoutMs: 8_000 });
	record("ws.collect", collect.data?.count >= 4 && Array.isArray(collect.data?.events), { count: collect.data?.count, events: collect.data?.events?.slice?.(0, 6) });

	const close = await bridge.sendCommand({ cmd: "ws.close", tabId, sessionId: "smoke-ws", timeoutMs: 5_000 }, { tabId, timeoutMs: 8_000 });
	record("ws.close", ["closed", "error"].includes(String(close.data?.session?.state)), { session: close.data?.session });

	await bridge.closeTab(tabId, 2_000).catch(() => {});
	record("tabs.close", true, { tabId });

	result.ok = steps.every((step) => step.ok !== false);
	if (!result.ok) process.exitCode = 1;
} catch (error) {
	record("error", false, { message: errorMessage(error), code: error && typeof error === "object" ? error.code : undefined, details: error && typeof error === "object" ? error.details : undefined });
	result.ok = false;
	process.exitCode = 1;
} finally {
	await bridge?.stop().catch(() => {});
	stopBrowserProcess(chrome);
	if (wsFixture?.server) await new Promise((resolve) => wsFixture.server.close(resolve));
	const keepTemp = process.env.PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE === "1" && result.ok === false;
	if (!keepTemp) {
		await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
	}
	await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
	console.log(JSON.stringify(result, null, 2));
}
