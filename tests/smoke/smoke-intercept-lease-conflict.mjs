import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-intercept-lease-conflict-results.json"));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
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
const profileDir = path.join(tempRoot, `intercept-lease-conflict-profile-${runId}`);
const extensionDir = path.join(tempRoot, `intercept-lease-conflict-extension-${runId}`);
let chrome;
let fixture;
let bridge;
let tabId;
let result = { ok: false, resultPath, profileDir, extensionDir, extensionSource, steps };

try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort();
	const fixturePort = await freePort();
	const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "intercept-response.html"), "utf8");
	const fixtureUrl = `http://127.0.0.1:${fixturePort}/intercept-response.html`;
	fixture = createHttpServer((req, res) => {
		if (req.url?.startsWith("/api/intercept-data")) {
			const body = JSON.stringify({ ok: true, source: "server-original", value: "original-body" });
			res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
			res.end(body);
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) });
		res.end(fixtureHtml);
	});
	await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
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

	const ownerSession = bridge.createBrowserSession("intercept-owner");
	bridge.attachTabToBrowserSession(tabId, { browserSessionId: ownerSession.id });
	const lease = bridge.leaseTab(tabId, { browserSessionId: ownerSession.id });
	record("lease.acquire", !!lease?.id, { leaseId: lease?.id, browserSessionId: ownerSession.id, tabId });
	const contenderSession = bridge.createBrowserSession("intercept-contender");
	bridge.attachTabToBrowserSession(tabId, { browserSessionId: contenderSession.id });
	const conflict = await bridge.sendCommand({ cmd: "intercept.install", tabId, sessionId: "smoke-lease-contender", timeoutMs: 5_000 }, { browserSessionId: contenderSession.id, tabId, timeoutMs: 5_000 }).then(() => undefined, (error) => error);
	record("intercept.leaseConflict", conflict?.code === "TAB_LEASE_CONFLICT", { errorCode: conflict?.code, message: conflict?.message });
	bridge.releaseTab(tabId, { browserSessionId: ownerSession.id });
	const installAfterRelease = await bridge.sendCommand({ cmd: "intercept.install", tabId, sessionId: "smoke-lease-contender", timeoutMs: 8_000 }, { browserSessionId: contenderSession.id, tabId, timeoutMs: 10_000 });
	record("intercept.installAfterRelease", installAfterRelease.data?.active === true, { data: installAfterRelease.data });
	const uninstall = await bridge.sendCommand({ cmd: "intercept.uninstall", tabId, sessionId: "smoke-lease-contender", timeoutMs: 8_000 }, { browserSessionId: contenderSession.id, tabId, timeoutMs: 10_000 });
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
	stopBrowserProcess(chrome);
	if (fixture) await new Promise((resolve) => fixture.close(resolve));
	const keepTemp = process.env.PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE === "1" && result.ok === false;
	if (!keepTemp) {
		await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
	}
	await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
	console.log(JSON.stringify(result, null, 2));
}
