import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { createBrowserAbmlIntegration } from "../../src/abml/verbs/integration.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-abml-frame-compare-results.json"));
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntil(predicate, timeoutMs = 20000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(250); } return undefined; }
const steps = []; const record = (step, ok, data = {}) => steps.push({ step, ok, ...data, t: Date.now() });
const runId = String(Date.now()); const profileDir = path.join(tempRoot, `abml-frame-profile-${runId}`); const extensionDir = path.join(tempRoot, `abml-frame-extension-${runId}`);
let fixture; let chrome; let bridge; let tabId; let result = { ok: false, resultPath, profileDir, extensionDir, extensionSource, steps };
try {
  await mkdir(outDir, { recursive: true }); await mkdir(tempRoot, { recursive: true });
  const bridgePort = await freePort(); const fixturePort = await freePort();
  const parentHtml = await readFile(path.join(root, "tests", "fixtures", "browser-workflows", "abml-frame-same-origin.html"), "utf8");
  const childHtml = await readFile(path.join(root, "tests", "fixtures", "browser-workflows", "abml-frame-child.html"), "utf8");
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/abml-frame-same-origin.html`;
  fixture = createHttpServer((req, res) => {
    if (req.url?.includes("abml-frame-child.html")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(childHtml) }); res.end(childHtml); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(parentHtml) }); res.end(parentHtml);
  });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
  await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) }); const extensionPatch = await patchExtensionDistPort(extensionDir, bridgePort); Object.assign(process.env, extensionPatch.env);
  bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort }); await bridge.start();
  const chromeExe = chromePath(); chrome = spawn(chromeExe, [`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`, `--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`, `--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`, "--no-first-run", "--no-default-browser-check", ...browserLaunchHardeningArgs(), "--enable-logging=stderr", "--v=0", fixtureUrl], { stdio: ["ignore", "pipe", "pipe"], detached: false });
  const connected = await waitUntil(() => { const snapshot = bridge.snapshot(); return snapshot.extensionConnected ? snapshot : undefined; }, 20000); if (!connected) throw new Error("Browser extension did not connect");
  const targetTab = await waitUntil(async () => { await bridge.refreshTabs(5000).catch(() => undefined); return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`)); }, 20000); if (!targetTab?.tabId) throw new Error(`Fixture tab ${fixtureUrl} not found`);
  tabId = targetTab.tabId; await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });
  const frameList = await bridge.sendCommand({ cmd: "frame.list", tabId, timeoutMs: 8000 }, { tabId, timeoutMs: 10000 });
  const runtime = createBrowserAbmlIntegration(bridge, { tabId, timeoutMs: 10000, maxChars: 50000 });
  const abmlRead = await runtime.readStructure({ tabId, timeoutMs: 10000, maxChars: 50000 });
  const frameEntityCount = abmlRead?.ok ? (abmlRead.entities || []).filter((entity) => entity.kind === "frame").length : 0;
  record("frame.compare", Array.isArray(frameList.data?.frames) && frameList.data.frames.length >= 2 && frameEntityCount >= 1, { frameListCount: frameList.data?.count, frameToolEntityCount: frameList.data?.entityCount, frameToolAbmlIntegrated: frameList.data?.abmlIntegrated, abmlEntityCount: abmlRead?.ok ? abmlRead.entities?.length : undefined, abmlFrameEntityCount: frameEntityCount });
  result.ok = steps.every((step) => step.ok !== false);
} catch (error) { record("error", false, { message: error instanceof Error ? error.message : String(error) }); result.ok = false; process.exitCode = 1; }
finally { if (tabId && bridge) await bridge.closeTab(tabId, 2000).catch(() => {}); await bridge?.stop().catch(() => {}); stopBrowserProcess(chrome); if (fixture) await new Promise((resolve) => fixture.close(resolve)); await rm(profileDir, { recursive: true, force: true }).catch(() => {}); await rm(extensionDir, { recursive: true, force: true }).catch(() => {}); await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8"); console.log(JSON.stringify(result, null, 2)); }
