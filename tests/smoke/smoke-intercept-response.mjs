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
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-intercept-response-results.json"));

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
const profileDir = path.join(tempRoot, `intercept-response-profile-${runId}`);
const extensionDir = path.join(tempRoot, `intercept-response-extension-${runId}`);
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
	const fixtureHtml = await readFile(path.join(root, "tests", "fixtures", "browser-workflows", "intercept-response.html"), "utf8");
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
	const extensionPatch = await patchExtensionDistPort(extensionDir, bridgePort);
	Object.assign(process.env, extensionPatch.env);
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

	const install = await bridge.sendCommand({ cmd: "intercept.install", tabId, sessionId: "smoke-int", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.install", install.data?.active === true, { data: install.data });
	const addRule = await bridge.sendCommand({ cmd: "intercept.addRule", tabId, sessionId: "smoke-int", action: "fulfill", matcher: { urlContains: "/api/intercept-data", stage: "response" }, patch: { note: "fixture-response" }, timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.addRule", typeof addRule.data?.rule?.ruleId === "string", { ruleId: addRule.data?.rule?.ruleId });
	const fulfillBody = JSON.stringify({ ok: true, source: "intercept-fulfilled", value: "patched-body" });
	const autoRule = await bridge.sendCommand({ cmd: "intercept.addRule", tabId, sessionId: "smoke-int", action: "fulfill", matcher: { urlContains: "/api/intercept-data", stage: "request" }, patch: { responseCode: 200, responseHeaders: { "content-type": "application/json; charset=utf-8" }, body: fulfillBody }, timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.autoRule", typeof autoRule.data?.rule?.ruleId === "string", { ruleId: autoRule.data?.rule?.ruleId });
	await bridge.executeJavaScript(`(() => { document.querySelector('#load-data')?.click(); return { clicked: true }; })()`, { tabId, timeoutMs: 8_000 });
	const pageResult = await waitUntil(async () => {
		const state = await bridge.executeJavaScript(`(() => ({ status: document.querySelector('#status')?.textContent || '', output: document.querySelector('#output')?.textContent || '' }))()`, { tabId, timeoutMs: 6_000 });
		return typeof state.data?.output === "string" && state.data.output.includes("intercept-fulfilled") ? state : undefined;
	}, 15_000);
	if (!pageResult) {
		const failedCollect = await bridge.sendCommand({ cmd: "intercept.collect", tabId, sessionId: "smoke-int", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 }).catch((error) => ({ ok: false, error: String(error) }));
		const failedStatus = await bridge.sendCommand({ cmd: "intercept.status", tabId, sessionId: "smoke-int", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 }).catch((error) => ({ ok: false, error: String(error) }));
		record("intercept.autoFailureDiagnostics", false, { collect: failedCollect.data || failedCollect, status: failedStatus.data || failedStatus });
		throw new Error("auto-applied fulfilled response did not reach page output");
	}
	record("intercept.pageResult", pageResult.data?.status === "Status: loaded" && pageResult.data?.output.includes("patched-body"), { data: pageResult.data });
	const collect = await bridge.sendCommand({ cmd: "intercept.collect", tabId, sessionId: "smoke-int", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.collect", collect.data?.count >= 2 && collect.data?.events?.some((item) => item.event === "paused") && collect.data?.events?.some((item) => item.event === "fulfill" && item.diagnostics?.autoApplied === true), { count: collect.data?.count, events: collect.data?.events?.map((item) => ({ event: item.event, autoApplied: item.diagnostics?.autoApplied })) });
	const status = await bridge.sendCommand({ cmd: "intercept.status", tabId, sessionId: "smoke-int", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("intercept.status", status.data?.ruleCount >= 2 && status.data?.pausedCount === 0, { data: status.data });
	const uninstall = await bridge.sendCommand({ cmd: "intercept.uninstall", tabId, sessionId: "smoke-int", timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
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
