import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { createBrowserAbmlIntegration } from "../../src/abml/verbs/integration.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { evaluatePageScriptDirect } from "../../src/tools/pageScriptEvaluation.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-abml-vision-compare-results.json"));
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntil(predicate, timeoutMs = 20000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(250); } return undefined; }
const steps = []; const record = (step, ok, data = {}) => steps.push({ step, ok, ...data, t: Date.now() });
const runId = String(Date.now()); const profileDir = path.join(tempRoot, `abml-vision-profile-${runId}`); const extensionDir = path.join(tempRoot, `abml-vision-extension-${runId}`);
let fixture; let chrome; let bridge; let tabId; let result = { ok: false, resultPath, profileDir, extensionDir, extensionSource, steps };
try {
  await mkdir(outDir, { recursive: true }); await mkdir(tempRoot, { recursive: true });
  const bridgePort = await freePort(); const fixturePort = await freePort();
  const fixtureHtml = await readFile(path.join(root, "tests", "fixtures", "browser-workflows", "abml-vision-floor.html"), "utf8");
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/abml-vision-floor.html`;
  fixture = createHttpServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) }); res.end(fixtureHtml); });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
  await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) }); const extensionPatch = await patchExtensionDistPort(extensionDir, bridgePort); Object.assign(process.env, extensionPatch.env);
  bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort }); await bridge.start();
  const chromeExe = chromePath(); chrome = spawn(chromeExe, [`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`, `--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`, `--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`, "--no-first-run", "--no-default-browser-check", ...browserLaunchHardeningArgs(), "--enable-logging=stderr", "--v=0", fixtureUrl], { stdio: ["ignore", "pipe", "pipe"], detached: false });
  const connected = await waitUntil(() => { const snapshot = bridge.snapshot(); return snapshot.extensionConnected ? snapshot : undefined; }, 20000); if (!connected) throw new Error("Browser extension did not connect");
  const targetTab = await waitUntil(async () => { await bridge.refreshTabs(5000).catch(() => undefined); return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`)); }, 20000); if (!targetTab?.tabId) throw new Error(`Fixture tab ${fixtureUrl} not found`);
  tabId = targetTab.tabId; await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });
  const rawScan = await evaluatePageScriptDirect(bridge, buildScanScript({ maxChars: 100000, maxNodes: 4000, includeIframes: true }), { tabId, timeoutMs: 10000, name: "scan_extract" });
  const runtime = createBrowserAbmlIntegration(bridge, { tabId, timeoutMs: 10000, maxChars: 100000 });
  const observe = await runtime.readStructure({ tabId, timeoutMs: 10000, maxChars: 100000 });
  const legacyCanvasActionables = Array.isArray(rawScan.data?.actionables) ? rawScan.data.actionables.filter((item) => String(item.tag || "").toLowerCase() === "canvas") : [];
  const abmlVisualRegions = observe?.ok ? (observe.entities || []).filter((entity) => entity.kind === "region" && entity.source === "vision") : [];
  const observeSummary = observe?.ok && observe.data && typeof observe.data === "object" ? observe.data.summary : undefined;
  record("vision.compare", legacyCanvasActionables.length >= 1 && abmlVisualRegions.length >= 1, { legacyCanvasActionables: legacyCanvasActionables.length, abmlVisualRegions: abmlVisualRegions.length, observeAbmlEntityCount: observe?.ok ? observe.entities?.length : undefined, observeVisualRegionCount: observeSummary && typeof observeSummary === "object" && observeSummary.focus && typeof observeSummary.focus === "object" ? observeSummary.focus.visual_regions?.length : undefined });
  result.ok = steps.every((step) => step.ok !== false);
} catch (error) { record("error", false, { message: error instanceof Error ? error.message : String(error) }); result.ok = false; process.exitCode = 1; }
finally { if (tabId && bridge) await bridge.closeTab(tabId, 2000).catch(() => {}); await bridge?.stop().catch(() => {}); stopBrowserProcess(chrome); if (fixture) await new Promise((resolve) => fixture.close(resolve)); await rm(profileDir, { recursive: true, force: true }).catch(() => {}); await rm(extensionDir, { recursive: true, force: true }).catch(() => {}); await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8"); console.log(JSON.stringify(result, null, 2)); }
