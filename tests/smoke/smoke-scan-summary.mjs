import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { evaluatePageScriptDirect } from "../../src/tools/pageScriptEvaluation.ts";
import { distilledTextResult } from "../../src/tools/resultMiddleware.ts";
import { summarizeScanData } from "../../src/tools/summaries/scan.ts";
import { readBrowserArtifact } from "../../src/tools/artifactReader.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-scan-summary-results.json"));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntil(predicate, timeoutMs = 15_000) {
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
const profileDir = path.join(tempRoot, `scan-summary-profile-${runId}`);
const extensionDir = path.join(tempRoot, `scan-summary-extension-${runId}`);
const savedScanPath = path.join(outDir, `scan-summary-smoke-scan-${runId}.json`);
let chrome;
let fixture;
let bridge;
let tabId;
let result = { ok: false, resultPath, savedScanPath, profileDir, extensionDir, extensionSource, steps };
try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort();
	const fixturePort = await freePort();
	const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "scan-high-entropy.html"), "utf8");
	const fixtureUrl = `http://127.0.0.1:${fixturePort}/scan-high-entropy.html`;
	fixture = createHttpServer((req, res) => {
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

	const maxChars = 12_000;
	const scanScript = buildScanScript({ maxChars: 100_000, maxNodes: 4_000, includeIframes: true, textOnly: false });
	const rawScan = await evaluatePageScriptDirect(bridge, scanScript, { tabId, timeoutMs: 10_000, name: "scan_extract" });
	const tabs = await bridge.refreshTabs(5_000).catch(() => bridge.getTabs());
	const content = typeof rawScan.data?.content === "string" ? rawScan.data.content : JSON.stringify(rawScan.data ?? rawScan, null, 2);
	const summary = summarizeScanData(rawScan.data, tabs, { detailLevel: "summary", maxChars });
	const before = await distilledTextResult(content, {
		toolName: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		maxChars,
		ctx: { cwd: root },
		outputPath: savedScanPath,
		fallbackName: path.basename(savedScanPath),
		summary,
		artifactValue: { ...rawScan, tabs_count: tabs.length, tabs, active_tab: bridge.snapshot().defaultTabId },
	});
	const beforeEnvelope = JSON.parse(before.content[0].text);
	const hasActionablesFollowup = beforeEnvelope.nextActions.some((item) => String(item).includes("jsonPath=data.actionables") || String(item).includes("click(pi-ref://") || String(item).includes("read(pi-ref://"));
	const hasContentFollowup = beforeEnvelope.nextActions.some((item) => String(item).includes("jsonPath=data.content"));
	record("scan.summary", typeof beforeEnvelope.saved?.path === "string"
		&& hasActionablesFollowup
		&& hasContentFollowup, {
			savedPath: beforeEnvelope.saved?.path,
			summaryVersion: beforeEnvelope.summary?.summaryVersion,
			primaryActions: beforeEnvelope.summary?.focus?.primary_actions?.length,
			forms: beforeEnvelope.summary?.focus?.forms?.length,
			lists: beforeEnvelope.summary?.focus?.lists?.length,
			textSignals: beforeEnvelope.summary?.focus?.text_signals?.length,
			hasActionablesFollowup,
			hasContentFollowup,
			nextActions: beforeEnvelope.nextActions,
		});
	const actionablesArtifact = await readBrowserArtifact({ path: savedScanPath, mode: "json", jsonPath: "data.actionables", limit: 20, maxChars: 4_000 }, { cwd: root });
	const actionablesItems = actionablesArtifact.value && typeof actionablesArtifact.value === "object" && Array.isArray(actionablesArtifact.value.items)
		? actionablesArtifact.value.items
		: undefined;
	record("artifact.actionables", Array.isArray(actionablesItems) && actionablesItems.length >= 3, {
		actionablesCount: Array.isArray(actionablesItems) ? actionablesItems.length : 0,
		total: actionablesArtifact.value && typeof actionablesArtifact.value === "object" ? actionablesArtifact.value.count : undefined,
	});
	await bridge.executeJavaScript(`(() => {
		const button = document.querySelector('#pay-now');
		if (!button) return { ok: false, reason: 'missing' };
		button.click();
		return { ok: true, status: document.querySelector('#cart-status')?.textContent || '' };
	})()`, { tabId, timeoutMs: 10_000 });
	const afterRaw = await evaluatePageScriptDirect(bridge, scanScript, { tabId, timeoutMs: 10_000, name: "scan_extract_after" });
	const afterSummary = summarizeScanData(afterRaw.data, tabs, { detailLevel: "summary", maxChars });
	record("scan.afterAction", Array.isArray(afterSummary.focus?.text_signals) && afterSummary.focus.text_signals.some((item) => String(item).includes("action completed for pay-now")), { textSignals: afterSummary.focus?.text_signals });
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
