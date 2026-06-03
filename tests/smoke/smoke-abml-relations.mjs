// ABML R1 relationship-graph live smoke (scan-only). Drives a real browser against the
// abml-relations.html fixture and runs the genuine runtime path — readAxEntities (Chrome's
// Accessibility.getFullAXTree) → mergeAxIntoDomEntities (mints refs) → materializeRelations →
// buildRelationSummary — to prove the batch-1 relation families (labelledBy, controls/
// expandedTarget, table cellOf/rowOf/columnOf/headerFor, currentIn) materialize from a real AX
// tree with pi-ref:// targets. Exit 0 PASS · 3 NEEDS BROWSER · 1 FAIL.
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { readAxEntities, mergeAxIntoDomEntities } from "../../src/abml/verbs/axRuntime.ts";
import { materializeRelations, buildRelationSummary } from "../../src/abml/relations.ts";
import { summarizeScanData } from "../../src/tools/summaries/scan.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { evaluatePageScriptDirect } from "../../src/tools/pageScriptEvaluation.ts";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-abml-relations-results.json"));
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
function chromePath() { for (const c of chromeCandidates) if (existsSync(c)) return c; return undefined; }
function isWindowsChromeExecutable(chromeExe) { return process.platform !== "win32" && /\.exe$/i.test(String(chromeExe || "")) && /^\/mnt\/[a-z]\//i.test(String(chromeExe || "")); }
function windowsPathForChrome(value, chromeExe) { if (!isWindowsChromeExecutable(chromeExe)) return value; const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(String(value || "")); if (!match) return value; return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`; }
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
const profileDir = path.join(tempRoot, `abml-relations-profile-${runId}`);
const extensionDir = path.join(tempRoot, `abml-relations-extension-${runId}`);
let fixture;
let chrome;
let bridge;
let result = { ok: false, needsBrowser: false, resultPath, steps };
try {
  await mkdir(outDir, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  const chromeExe = chromePath();
  if (!chromeExe) { result.needsBrowser = true; throw new Error("NEEDS_BROWSER: no Chrome/Edge found (set PI_BROWSER_SMOKE_CHROME)"); }
  if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source missing manifest.json: ${extensionSource}`);
  const bridgePort = await freePort(18810, 18840);
  const fixturePort = await freePort(8810, 8840);
  const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "abml-relations.html"), "utf8");
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/abml-relations.html`;
  fixture = createHttpServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) }); res.end(fixtureHtml); });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
  await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  await patchExtensionPort(extensionDir, bridgePort);
  bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort });
  await bridge.start();
  chrome = spawn(chromeExe, [
    `--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`,
    `--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`,
    `--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    fixtureUrl,
  ], { stdio: ["ignore", "pipe", "pipe"], detached: false });
  const connected = await waitUntil(() => { const snapshot = bridge.snapshot(); return snapshot.extensionConnected ? snapshot : undefined; }, 30000);
  if (!connected) { result.needsBrowser = true; throw new Error("NEEDS_BROWSER: extension did not connect"); }
  record("bridge.connected", true, { bridgePort, fixturePort, chrome: chromeExe });
  const targetTab = await waitUntil(async () => { await bridge.refreshTabs(5000).catch(() => undefined); return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`)); }, 20000);
  if (!targetTab?.tabId) throw new Error("relations fixture tab not found");
  const tabId = targetTab.tabId;
  await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });

  // Real runtime path: scan → DOM entities, AX read → entities + anchors, merge, materialize.
  const rawScan = await evaluatePageScriptDirect(bridge, buildScanScript({ maxChars: 100000, maxNodes: 4000, includeIframes: true }), { tabId, timeoutMs: 10000, name: "scan_extract" });
  const tabs = await bridge.refreshTabs(5000).catch(() => bridge.getTabs());
  const scanSummary = summarizeScanData(rawScan.data, tabs, { detailLevel: "summary", maxChars: 12000, entityContext: { browserSessionId: bridge.snapshot().browserSessionId, tabId, url: fixtureUrl, observationId: "rel-smoke", capturedAt: Date.now() } });
  const domEntities = [
    ...(Array.isArray(scanSummary.focus?.primary_entities) ? scanSummary.focus.primary_entities : []),
    ...(Array.isArray(scanSummary.focus?.list_entities) ? scanSummary.focus.list_entities : []),
  ];
  const { entities: axEntities, anchors } = await readAxEntities(bridge, { browserSessionId: bridge.snapshot().browserSessionId, tabId, observationId: "rel-smoke", url: fixtureUrl, capturedAt: Date.now(), timeoutMs: 10000 });
  const merged = mergeAxIntoDomEntities(domEntities, axEntities);
  const related = materializeRelations(merged, anchors);
  const relations = buildRelationSummary(related);

  const summary = relations.summary;
  const familiesPresent = {
    labelledBy: (summary.labelledBy ?? 0) > 0,
    describedBy: (summary.describedBy ?? 0) > 0,
    controls: (summary.controls ?? 0) > 0,
    expandedTarget: (summary.expandedTarget ?? 0) > 0,
    table: (summary.cellOf ?? 0) > 0 && (summary.headerFor ?? 0) > 0,
    columnOf: (summary.columnOf ?? 0) > 0,
    // currentIn is NOT in the pass gate: Chrome's Accessibility.getFullAXTree does not expose
    // aria-current in node properties, so currentIn requires a DOM-sourced fallback (batch 2).
    currentIn: (summary.currentIn ?? 0) > 0,
  };
  const allTargetsAreRefs = related.every((entity) => (entity.relations ?? []).every((relation) => /^pi-ref:\/\//.test(String(relation.targetRef || ""))));
  // Pass gate = the relation families a real Chrome AX tree reliably exposes for this fixture.
  const corePass = familiesPresent.labelledBy && familiesPresent.describedBy && familiesPresent.controls && familiesPresent.expandedTarget && familiesPresent.table && familiesPresent.columnOf && allTargetsAreRefs;
  record("relations.summary", corePass, { anchorCount: anchors.length, summary, familiesPresent, allTargetsAreRefs, knownGap: { currentIn: "aria-current absent from getFullAXTree — DOM-sourced fallback deferred to batch 2" }, sampleHighlights: relations.highlights.slice(0, 5) });
  result.ok = corePass;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  record("error", false, { message });
  if (/NEEDS_BROWSER/.test(message)) result.needsBrowser = true;
} finally {
  try { if (chrome && !chrome.killed) chrome.kill(); } catch {}
  try { if (bridge) await bridge.stop?.(); } catch {}
  try { if (fixture) await new Promise((resolve) => fixture.close(resolve)); } catch {}
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8").catch(() => {});
}
if (result.needsBrowser && !result.ok) { console.log(`NEEDS BROWSER — ${resultPath}`); process.exit(3); }
console.log(`${result.ok ? "PASS" : "FAIL"} abml relations smoke — ${resultPath}`);
process.exit(result.ok ? 0 : 1);
