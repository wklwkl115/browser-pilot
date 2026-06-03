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
import { ToolCollectingAdapter } from "../../src/frontend/toolCollector.ts";
import { registerBrowserTools } from "../../src/tools/registerTools.ts";
import { resolveBrowserToolCapabilityProfile } from "../../src/tools/capabilityProfile.ts";

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

  // TRUE end-to-end: drive the registered browser_observe tool (the exact def.execute seam Pi-native
  // and the CLI both call) and read the CONSUMER-FACING envelope — not the internal functions. This
  // proves relations actually surface in the tool output an agent receives.
  const profile = resolveBrowserToolCapabilityProfile();
  bridge.setCapabilityProfile?.(profile);
  const ensureStarted = async () => bridge; // already started above
  const adapter = new ToolCollectingAdapter();
  registerBrowserTools(adapter, bridge, ensureStarted, { securityToolsEnabled: profile.securityToolsEnabled });
  const observe = adapter.getTool("browser_observe");
  if (!observe) throw new Error("browser_observe not registered");
  const browserSessionId = bridge.snapshot().browserSessionId;
  const toolResult = await observe.execute("rel-smoke", { mode: "scan", tabId, browserSessionId, detailLevel: "detailed" }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
  const envelopeText = Array.isArray(toolResult.content) ? toolResult.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n") : "";
  const envelope = JSON.parse(envelopeText);

  // The agent-visible contract: relations live at the envelope TOP LEVEL (sibling to gist/outline),
  // and entities carry their typed relations inline.
  const summary = (envelope.relations && envelope.relations.summary) || {};
  const familiesPresent = {
    labelledBy: (summary.labelledBy ?? 0) > 0,
    describedBy: (summary.describedBy ?? 0) > 0,
    controls: (summary.controls ?? 0) > 0,
    expandedTarget: (summary.expandedTarget ?? 0) > 0,
    table: (summary.cellOf ?? 0) > 0 && (summary.headerFor ?? 0) > 0,
    columnOf: (summary.columnOf ?? 0) > 0,
    currentIn: (summary.currentIn ?? 0) > 0, // batch 2: DOM-sourced aria-current
    occlusion: (summary.coveredBy ?? 0) > 0 && (summary.occludes ?? 0) > 0, // batch 2: hit-test
  };
  const entities = Array.isArray(envelope.entities) ? envelope.entities : [];
  const entitiesWithRelations = entities.filter((e) => Array.isArray(e.relations) && e.relations.length).length;
  const highlights = (envelope.relations && envelope.relations.highlights) || [];
  const allTargetsAreRefs = [
    ...entities.flatMap((e) => Array.isArray(e.relations) ? e.relations : []),
    ...highlights,
  ].every((r) => /^pi-ref:\/\//.test(String(r.targetRef || "")));
  // Pass gate = the real observe envelope exposes abmlIntegrated + a populated top-level relations
  // summary covering every family this fixture exercises, with entities carrying inline relations.
  const corePass = envelope.abmlIntegrated === true && Object.values(familiesPresent).every(Boolean) && entitiesWithRelations > 0 && allTargetsAreRefs;
  record("observe.envelope.relations", corePass, { abmlIntegrated: envelope.abmlIntegrated, summary, familiesPresent, entitiesWithRelations, allTargetsAreRefs, sampleHighlights: highlights.slice(0, 6) });
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
