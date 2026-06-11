// browser_observe navigation + omitted-mode inference live smoke.
// Drives a real browser through the registered public tool surface and verifies
// url-backed observe requests navigate before scan/html extraction.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { ToolCollectingAdapter } from "../../src/frontend/toolCollector.ts";
import { registerBrowserTools } from "../../src/tools/registerTools.ts";
import { browserLaunchHardeningArgs, findChromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-observe-navigation-results.json"));

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

function parseEnvelope(toolResult) {
	const text = Array.isArray(toolResult.content)
		? toolResult.content.map((item) => (item && typeof item.text === "string" ? item.text : "")).join("\n")
		: "";
	return JSON.parse(text);
}

const pages = {
	"/start.html": `<!doctype html><meta charset="utf-8"><title>Start</title><main><h1>Start Page</h1><a href="/scan.html">scan</a></main>`,
	"/scan.html": `<!doctype html><meta charset="utf-8"><title>Scan Target</title><main><h1>Scan Target</h1><button id="checkout">Checkout</button><p>Visible scan text for navigation smoke.</p></main>`,
	"/html.html": `<!doctype html><meta charset="utf-8"><title>HTML Target</title><main id="target"><h1>HTML Target</h1><p data-testid="html-smoke">Exact HTML navigation smoke.</p></main>`,
};

const steps = [];
function record(step, ok, data = {}) { steps.push({ step, ok, ...data, t: Date.now() }); }

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `observe-navigation-profile-${runId}`);
const extensionDir = path.join(tempRoot, `observe-navigation-extension-${runId}`);
let fixture;
let chrome;
let bridge;
let tabId;
const result = { ok: false, needsBrowser: false, resultPath, steps };

try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	const chromeExe = findChromePath();
	if (!chromeExe) {
		result.needsBrowser = true;
		throw new Error("NEEDS_BROWSER: no Chrome/Edge found (set PI_BROWSER_SMOKE_CHROME)");
	}
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort();
	const fixturePort = await freePort();
	const fixtureBase = `http://127.0.0.1:${fixturePort}`;
	fixture = createHttpServer((req, res) => {
		const url = req.url && pages[req.url] ? req.url : "/start.html";
		const body = pages[url];
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
		res.end(body);
	});
	await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	await patchExtensionDistPort(extensionDir, bridgePort);
	bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort });
	await bridge.start();
	chrome = spawn(chromeExe, [
		`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`,
		`--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`,
		`--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`,
		"--no-first-run",
		"--no-default-browser-check",
		...browserLaunchHardeningArgs(),
		`${fixtureBase}/start.html`,
	], { stdio: ["ignore", "pipe", "pipe"], detached: false });
	chrome.stdout.on("data", () => {});
	chrome.stderr.on("data", () => {});
	const connected = await waitUntil(() => {
		const snapshot = bridge.snapshot();
		return snapshot.extensionConnected ? snapshot : undefined;
	}, 30_000);
	if (!connected) {
		result.needsBrowser = true;
		throw new Error("NEEDS_BROWSER: extension did not connect");
	}
	record("bridge.connected", true, { bridgePort, fixturePort, chrome: chromeExe });
	const targetTab = await waitUntil(async () => {
		await bridge.refreshTabs(5_000).catch(() => undefined);
		return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`${fixtureBase}/`));
	}, 20_000);
	if (!targetTab?.tabId) throw new Error("fixture tab not found");
	tabId = targetTab.tabId;
	await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10_000 }, { tabId, timeoutMs: 12_000 });
	record("fixture.open", true, { tabId, url: targetTab.url });

	const adapter = new ToolCollectingAdapter();
	registerBrowserTools(adapter, bridge, async () => bridge);
	const observe = adapter.getTool("browser_observe");
	if (!observe) throw new Error("browser_observe not registered");
	const browserSessionId = bridge.snapshot().browserSessionId;

	const scanResult = await observe.execute("observe-nav-scan", {
		tabId,
		browserSessionId,
		url: `${fixtureBase}/scan.html`,
		detailLevel: "summary",
		maxChars: 16_000,
	}, undefined, undefined, { cwd: root, hasUI: false });
	const scanEnvelope = parseEnvelope(scanResult);
	record("observe.navigate.scan", scanEnvelope.command === "navigate+scan"
		&& scanEnvelope.summary?.mode === "scan"
		&& scanEnvelope.summary?.modeInferred === undefined
		&& String(scanEnvelope.snapshot?.url || "").endsWith("/scan.html")
		&& String(scanEnvelope.gist?.title || scanEnvelope.summary?.title || "").includes("Scan Target"), {
			command: scanEnvelope.command,
			error: scanEnvelope.error,
			errorCode: scanEnvelope.error_code,
			mode: scanEnvelope.summary?.mode,
			modeInferred: scanEnvelope.summary?.modeInferred,
			details: scanResult.details,
			snapshotUrl: scanEnvelope.snapshot?.url,
			title: scanEnvelope.gist?.title || scanEnvelope.summary?.title,
			keys: Object.keys(scanEnvelope).slice(0, 12),
		});

	const htmlResult = await observe.execute("observe-nav-html", {
		tabId,
		browserSessionId,
		url: `${fixtureBase}/html.html`,
		selector: "main#target",
		htmlMode: "outer",
		detailLevel: "summary",
		maxChars: 16_000,
	}, undefined, undefined, { cwd: root, hasUI: false });
	const htmlEnvelope = parseEnvelope(htmlResult);
	record("observe.navigate.html.inferred", htmlEnvelope.command === "navigate+html"
		&& htmlEnvelope.summary?.sourceMode === "html"
		&& htmlEnvelope.summary?.modeInferred === "html"
		&& htmlResult.details?.modeInferred?.mode === "html"
		&& String(htmlEnvelope.snapshot?.url || "").endsWith("/html.html")
		&& String(htmlEnvelope.summary?.sample || htmlEnvelope.summary?.preview || htmlEnvelope.summary?.textPreview || "").includes("HTML Target"), {
			command: htmlEnvelope.command,
			mode: htmlEnvelope.summary?.mode,
			sourceMode: htmlEnvelope.summary?.sourceMode,
			modeInferred: htmlEnvelope.summary?.modeInferred,
			detailsModeInferred: htmlResult.details?.modeInferred,
			snapshotUrl: htmlEnvelope.snapshot?.url,
		});

	result.ok = steps.every((step) => step.ok !== false);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	record("error", false, { message });
	if (/NEEDS_BROWSER/.test(message)) result.needsBrowser = true;
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
	await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8").catch(() => {});
}

if (result.needsBrowser && !result.ok) {
	console.log(`NEEDS BROWSER - ${resultPath}`);
	process.exit(3);
}
console.log(`${result.ok ? "PASS" : "FAIL"} observe navigation smoke - ${resultPath}`);
process.exit(result.ok ? 0 : 1);
