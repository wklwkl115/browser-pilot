import { readFile, writeFile, mkdir, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { readAxEntities, mergeAxIntoDomEntities } from "../../src/abml/verbs/axRuntime.ts";
import { summarizeScanData } from "../../src/tools/summaries/scan.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { evaluatePageScriptDirect } from "../../src/tools/pageScriptEvaluation.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-ax-merge-results.json"));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntil(predicate, timeoutMs = 20000) {
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
const profileDir = path.join(tempRoot, `ax-merge-profile-${runId}`);
const extensionDir = path.join(tempRoot, `ax-merge-extension-${runId}`);
let fixture;
let chrome;
let bridge;
let tabId;
let chromeStdout = "";
let chromeStderr = "";
let chromeSpawnError;
let result = { ok: false, resultPath, profileDir, extensionDir, steps };
try {
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(resultPath), { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
  const bridgePort = await freePort();
  const fixturePort = await freePort();
  const fixtureHtml = await readFile(path.join(root, "tests", "fixtures", "browser-workflows", "abml-ax-canvas-aria.html"), "utf8");
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/abml-ax-canvas-aria.html`;
  fixture = createHttpServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) }); res.end(fixtureHtml); });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
  await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  const extensionPatch = await patchExtensionDistPort(extensionDir, bridgePort); Object.assign(process.env, extensionPatch.env);
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
  chrome.on("error", (error) => { chromeSpawnError = error instanceof Error ? error.message : String(error); });
  chrome.stdout.on("data", (chunk) => { chromeStdout += chunk.toString(); });
  chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });
  const connected = await waitUntil(() => { const snapshot = bridge.snapshot(); return snapshot.extensionConnected ? snapshot : undefined; }, 30000);
  if (!connected) throw new Error(`Browser extension did not connect${chromeSpawnError ? ` (${chromeSpawnError})` : ""}`);
  record("bridge.connected", true, { bridgePort, fixturePort, connectedClients: connected.connectedClients, chrome: chromeExe });
  const targetTab = await waitUntil(async () => { await bridge.refreshTabs(5000).catch(() => undefined); return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`)); }, 20000);
  if (!targetTab?.tabId) throw new Error("AX fixture tab not found");
  tabId = targetTab.tabId;
  await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });
  const rawScan = await evaluatePageScriptDirect(bridge, buildScanScript({ maxChars: 100000, maxNodes: 4000, includeIframes: true }), { tabId, timeoutMs: 10000, name: "scan_extract" });
  const tabs = await bridge.refreshTabs(5000).catch(() => bridge.getTabs());
  const scanSummary = summarizeScanData(rawScan.data, tabs, { detailLevel: "summary", maxChars: 12000, entityContext: { browserSessionId: bridge.snapshot().browserSessionId, tabId, url: fixtureUrl, observationId: "ax-smoke", capturedAt: Date.now() } });
  const domEntities = [
    ...(Array.isArray(scanSummary.focus?.primary_entities) ? scanSummary.focus.primary_entities : []),
    ...(Array.isArray(scanSummary.focus?.list_entities) ? scanSummary.focus.list_entities : []),
  ];
  const { entities: axEntities } = await readAxEntities(bridge, { browserSessionId: bridge.snapshot().browserSessionId, tabId, observationId: "ax-smoke", url: fixtureUrl, capturedAt: Date.now(), timeoutMs: 10000 });
  const merged = mergeAxIntoDomEntities(domEntities, axEntities);
  const debug = {
    domEntities: domEntities.map((entity) => ({ ref: entity.ref, kind: entity.kind, role: entity.role, name: entity.name, selector: entity.hints?.selector, locators: entity.locators })),
    axEntities: axEntities.map((item) => ({ kind: item.entity.kind, role: item.entity.role, name: item.entity.name, locators: item.entity.locators, hints: item.entity.hints })),
    merged: merged.map((entity) => ({ ref: entity.ref, kind: entity.kind, role: entity.role, name: entity.name, locators: entity.locators, hints: entity.hints })),
  };
  const mergedButton = merged.some((entity) => entity.role.toLowerCase() === "button" && entity.locators?.some((locator) => locator.by === "axNodeId"));
  const mergedCanvas = merged.some((entity) => String(entity.hints?.selector || "") === "#scene" && entity.locators?.some((locator) => locator.by === "axNodeId"));
  record("ax.merge", mergedButton && mergedCanvas, { domEntityCount: domEntities.length, axEntityCount: axEntities.length, mergedEntityCount: merged.length, mergedButton, mergedCanvas, debug });
  result.ok = steps.every((step) => step.ok !== false);
} catch (error) {
  record("error", false, {
    message: error instanceof Error ? error.message : String(error),
    chromeSpawnError,
    chromeStdoutTail: chromeStdout.slice(-4000),
    chromeStderrTail: chromeStderr.slice(-4000),
  });
  result.ok = false;
  process.exitCode = 1;
} finally {
  if (tabId && bridge) await bridge.closeTab(tabId, 2000).catch(() => {});
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
