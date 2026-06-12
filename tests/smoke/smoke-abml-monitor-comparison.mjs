import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { evaluatePageScriptDirect } from "../../src/tools/pageScriptEvaluation.ts";
import { createBrowserAbmlIntegration } from "../../src/abml/verbs/integration.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-abml-monitor-comparison-results.json"));

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
function textLines(value) {
	return String(value || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}
function diffScanContent(before, after) {
	const beforeSet = new Set(textLines(before));
	const added = textLines(after).filter((line) => !beforeSet.has(line));
	return { changed: added.length, top_change: added[0] };
}
const steps = [];
function record(step, ok, data = {}) { steps.push({ step, ok, ...data, t: Date.now() }); }

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `abml-monitor-profile-${runId}`);
const extensionDir = path.join(tempRoot, `abml-monitor-extension-${runId}`);
let chrome;
let fixture;
let bridge;
let tabId;
let result = { ok: false, resultPath, profileDir, extensionDir, extensionSource, steps };
try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	const bridgePort = await freePort();
	const fixturePort = await freePort();
	const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "interactive.html"), "utf8");
	const fixtureUrl = `http://127.0.0.1:${fixturePort}/interactive.html`;
	fixture = createHttpServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) }); res.end(fixtureHtml); });
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
	const connected = await waitUntil(() => { const snapshot = bridge.snapshot(); return snapshot.extensionConnected ? snapshot : undefined; }, 20_000);
	if (!connected) throw new Error("Browser extension did not connect");
	record("bridge.connected", true, { bridgePort, fixturePort, connectedClients: connected.connectedClients });
	const targetTab = await waitUntil(async () => { await bridge.refreshTabs(5_000).catch(() => undefined); return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`)); }, 20_000);
	if (!targetTab?.tabId) throw new Error(`Fixture tab ${fixtureUrl} not found`);
	tabId = targetTab.tabId;
	await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10_000 }, { tabId, timeoutMs: 12_000 });
	const scanScript = buildScanScript({ maxChars: 80_000, maxNodes: 4_000, includeIframes: true, textOnly: false });
	const beforeLegacy = await evaluatePageScriptDirect(bridge, scanScript, { tabId, timeoutMs: 10_000, name: "scan_extract_before" });
	const runtime = createBrowserAbmlIntegration(bridge, { tabId, timeoutMs: 10_000, maxChars: 80_000 });
	const beforeAbml = await runtime.readStructure({ tabId, timeoutMs: 10_000, maxChars: 80_000 });
	await bridge.executeJavaScript(`(() => {
		const status = document.querySelector('#status');
		if (!status) return { ok: false, reason: 'missing-status' };
		status.textContent = 'Status: monitor route changed';
		status.setAttribute('data-state', 'monitor');
		return { ok: true, status: status.textContent };
	})()`, { tabId, timeoutMs: 10_000 });
	const afterLegacy = await evaluatePageScriptDirect(bridge, scanScript, { tabId, timeoutMs: 10_000, name: "scan_extract_after" });
	const afterAbml = await runtime.readStructure({ tabId, timeoutMs: 10_000, maxChars: 80_000 });
	const legacyDiff = diffScanContent(beforeLegacy.data?.content, afterLegacy.data?.content);
	const beforeAbmlText = beforeAbml?.ok ? JSON.stringify(beforeAbml.entities ?? [], null, 2) : "";
	const afterAbmlText = afterAbml?.ok ? JSON.stringify(afterAbml.entities ?? [], null, 2) : "";
	const abmlDiff = diffScanContent(beforeAbmlText, afterAbmlText);
	const beforeSummary = beforeAbml?.ok && beforeAbml.data && typeof beforeAbml.data === "object" ? beforeAbml.data.summary : undefined;
	const afterSummary = afterAbml?.ok && afterAbml.data && typeof afterAbml.data === "object" ? afterAbml.data.summary : undefined;
	record("monitor.comparison", beforeAbml?.ok === true && afterAbml?.ok === true && abmlDiff.changed >= 0 && legacyDiff.changed >= 0, {
		legacy: legacyDiff,
		abml: abmlDiff,
		abmlBeforeEntities: beforeAbml?.ok ? beforeAbml.entities?.length : undefined,
		abmlAfterEntities: afterAbml?.ok ? afterAbml.entities?.length : undefined,
		abmlBeforeSummary: beforeSummary && typeof beforeSummary === "object" && beforeSummary.focus && typeof beforeSummary.focus === "object" ? beforeSummary.focus.primary_entities?.length : undefined,
		abmlAfterSummary: afterSummary && typeof afterSummary === "object" && afterSummary.focus && typeof afterSummary.focus === "object" ? afterSummary.focus.primary_entities?.length : undefined,
	});
	result.ok = steps.every((step) => step.ok !== false);
} catch (error) {
	record("error", false, { message: error instanceof Error ? error.message : String(error) });
	result.ok = false;
	process.exitCode = 1;
} finally {
	if (tabId && bridge) await bridge.closeTab(tabId, 2_000).catch(() => {});
	await bridge?.stop().catch(() => {});
	stopBrowserProcess(chrome);
	if (fixture) await new Promise((resolve) => fixture.close(resolve));
	await rm(profileDir, { recursive: true, force: true }).catch(() => {});
	await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
	await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
	console.log(JSON.stringify(result, null, 2));
}
