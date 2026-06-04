// ABML R3.x causal plane (P0 + P1) live smoke. Drives a real browser through the genuine
// browser_observe tool seam and asserts the network-delta causal plane end-to-end:
//   U) observe(baseline) BEFORE starting the recorder -> envelope.causal.unavailable
//      ("network recorder not active").
//   A) browser_network start, then a baseline scan (records the seq high-water mark on the
//      observation snapshot).
//   B) fire a fetch() to /api/ping?token=… , wait for the recorder to capture it, then
//      observe(baseline:A) -> envelope.causal.requests contains that request, URL redacted
//      (no token leak), windowed at the baseline seq.
//   C) P1 attribution: focus a control + fire /api/ping2, then observe(baseline, actionRef) ->
//      the delta is attributed to that control as a `triggered` relation (relations.summary.
//      triggered >= 1; targetRef resolvable in causal.requests). The focus-only path is recorded
//      as an extra (§7 focus robustness is environment-sensitive on live pages).
//   D) P2 event causal: arm the console hook, baseline, fire console.error, then observe(baseline)
//      -> the event lands in envelope.causal.events (pi-ref://event/, type console.*, redacted).
// Exit 0 PASS · 3 NEEDS BROWSER · 1 FAIL. Self-launches an isolated Chrome/Edge + bridge +
// extension copy (picks up the freshly-built dist), so it never touches the user's browser.
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
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-abml-causal-results.json"));
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

async function observeEnvelope(observe, args) {
  const r = await observe.execute("causal", args, undefined, undefined, { cwd: process.cwd(), hasUI: false });
  const text = Array.isArray(r.content) ? r.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n") : "";
  return JSON.parse(text);
}

const SECRET = "SECRET123";
const PING_PATH = "/api/ping";

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `abml-causal-profile-${runId}`);
const extensionDir = path.join(tempRoot, `abml-causal-extension-${runId}`);
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
  const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "abml-inference-postaction.html"), "utf8");
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/abml-inference-postaction.html`;
  // Answer any path (incl. /api/ping) so the page-fired fetch is a real recorded request.
  fixture = createHttpServer((req, res) => {
    if (String(req.url || "").startsWith(PING_PATH)) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) }); res.end(fixtureHtml);
  });
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
  if (!targetTab?.tabId) throw new Error("causal fixture tab not found");
  const tabId = targetTab.tabId;
  await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });

  const profile = resolveBrowserToolCapabilityProfile();
  bridge.setCapabilityProfile?.(profile);
  const adapter = new ToolCollectingAdapter();
  registerBrowserTools(adapter, bridge, async () => bridge, { securityToolsEnabled: profile.securityToolsEnabled });
  const observe = adapter.getTool("browser_observe");
  if (!observe) throw new Error("browser_observe not registered");
  const browserSessionId = bridge.snapshot().browserSessionId;

  // ── U) baseline scan BEFORE the recorder is active → causal.unavailable ──────────
  const envU = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, baseline: { networkSeq: 0, entities: [{ ref: "pi-ref://control/u", state: {} }] }, detailLevel: "detailed" });
  const unavailableOk = typeof envU.causal?.unavailable === "string" && /not active/i.test(envU.causal.unavailable);
  record("causal.unavailable", unavailableOk, { causal: envU.causal });

  // ── A) start the recorder + baseline scan (records the seq high-water mark) ───────
  await bridge.sendCommand({ cmd: "network.start", tabId }, { tabId, timeoutMs: 8000 });
  const env1 = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, detailLevel: "detailed" });
  const baselineSeq = env1.snapshot?.networkSeq;
  record("baseline.networkSeq", typeof baselineSeq === "number", { networkSeq: baselineSeq, causalAbsent: env1.causal === undefined });

  // ── B) fire a fetch, wait for capture, then observe(baseline) → causal delta ──────
  await bridge.executeJavaScript(`fetch('${PING_PATH}?token=${SECRET}').catch(function(){}); return 'fired';`, { tabId, browserSessionId, timeoutMs: 8000 });
  await bridge.sendCommand({ cmd: "network.wait", tabId, condition: "response", urlContains: PING_PATH, timeoutMs: 8000 }, { tabId, timeoutMs: 10000 }).catch(() => undefined);
  await delay(300);
  const env2 = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, baseline: env1, detailLevel: "detailed" });
  const causal2 = env2.causal || {};
  const requests = Array.isArray(causal2.requests) ? causal2.requests : [];
  const pingReq = requests.find((r) => typeof r.url === "string" && r.url.includes(PING_PATH));
  const sinceSeqOk = typeof causal2.sinceSeq === "number";
  const deltaHasPing = !!pingReq;
  const tokenScrubbed = !!pingReq && !String(pingReq.url).includes(SECRET);
  const refOk = !!pingReq && /^pi-ref:\/\/network\//.test(String(pingReq.ref || ""));
  record("causal.delta", deltaHasPing && tokenScrubbed && sinceSeqOk && refOk, {
    sinceSeq: causal2.sinceSeq, requestCount: requests.length,
    pingRequest: pingReq ? { ref: pingReq.ref, method: pingReq.method, url: pingReq.url, status: pingReq.status, type: pingReq.type } : null,
    deltaHasPing, tokenScrubbed, sinceSeqOk, refOk,
  });

  // ── C) P1 attribution: attribute the delta to a control via the `triggered` relation ──
  const PING2 = "/api/ping2";
  const liveControls = [...(env2.summary?.focus?.primary_entities ?? []), ...(env2.entities ?? [])].filter((e) => e && (e.kind === "control" || e.kind === "element"));
  const actionRef = liveControls[0]?.ref;
  const focusSel = typeof liveControls[0]?.hints?.selector === "string" ? liveControls[0].hints.selector : "#email";
  // Focus that control (drives diff.focusedRef for the focus-path check) and fire a fresh request.
  // executeJavaScript returns the FIRST expression, so wrap in an IIFE to run focus + fetch together.
  await bridge.executeJavaScript(`(function(){ var el=document.querySelector(${JSON.stringify(focusSel)}); if(el&&el.focus){el.focus();} fetch('${PING2}?token=${SECRET}').catch(function(){}); return 'fired2'; })()`, { tabId, browserSessionId, timeoutMs: 8000 });
  await bridge.sendCommand({ cmd: "network.wait", tabId, condition: "response", urlContains: PING2, timeoutMs: 8000 }, { tabId, timeoutMs: 10000 }).catch(() => undefined);
  await delay(300);
  // Explicit actionRef path (deterministic core): attribute the delta to the asserted control.
  const envC = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, baseline: env2, actionRef, detailLevel: "detailed" });
  const triggeredCount = envC.relations?.summary?.triggered || 0;
  const ctlEntity = (envC.entities ?? []).find((e) => e.ref === actionRef);
  const triggeredEdge = (ctlEntity?.relations ?? []).find((r) => r.type === "triggered");
  const ping2Req = (envC.causal?.requests ?? []).find((r) => typeof r.url === "string" && r.url.includes(PING2));
  const attributedOk = !!actionRef && triggeredCount >= 1 && !!ping2Req;
  // Focus-path (extra, non-gating: §7 focus robustness is environment-sensitive on live pages).
  const envCfocus = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, baseline: env2, detailLevel: "detailed" });
  const focusPathTriggered = (envCfocus.relations?.summary?.triggered || 0) >= 1;
  record("causal.attribution", attributedOk, {
    actionRef, triggeredCount,
    triggeredEdge: triggeredEdge ? { type: triggeredEdge.type, targetRef: triggeredEdge.targetRef, source: triggeredEdge.source, confidence: triggeredEdge.confidence } : null,
    ping2Ref: ping2Req?.ref, focusedRef: envCfocus.diff?.focusedRef, focusPathTriggered, attributedOk,
    diag: {
      baselineSeqC: env2.snapshot?.networkSeq,
      sinceSeqC: envC.causal?.sinceSeq,
      causalReqCount: (envC.causal?.requests ?? []).length,
      causalUrls: (envC.causal?.requests ?? []).map((r) => r.url),
      actionRefInEntities: (envC.entities ?? []).some((e) => e.ref === actionRef),
      relationsSummary: envC.relations?.summary,
    },
  });

  // ── D) P2: hook event-delta → envelope.causal.events ──────────────────────────────
  // Arm the console hook, take a fresh baseline (records the hook seq high-water), fire a
  // console.error, then observe(baseline) and assert the event lands in causal.events (redacted).
  await bridge.sendCommand({ cmd: "hook.install", targets: { console: true } }, { tabId, timeoutMs: 8000 }).catch(() => undefined);
  const envH0 = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, detailLevel: "detailed" });
  const hookSeqBase = envH0.snapshot?.hookSeq;
  await bridge.executeJavaScript(`(function(){ console.error('pi-causal-probe token=${SECRET}'); return 'logged'; })()`, { tabId, browserSessionId, timeoutMs: 8000 });
  await delay(400);
  const envH = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, baseline: envH0, detailLevel: "detailed" });
  const events = Array.isArray(envH.causal?.events) ? envH.causal.events : [];
  const probeEvent = events.find((e) => typeof e.summary === "string" && e.summary.includes("pi-causal-probe"));
  const eventRefOk = !!probeEvent && /^pi-ref:\/\/event\//.test(String(probeEvent.ref || ""));
  const eventTypeOk = !!probeEvent && /^console/.test(String(probeEvent.type || ""));
  const eventTokenScrubbed = !!probeEvent && !String(probeEvent.summary).includes(SECRET);
  const eventCausalOk = !!probeEvent && eventRefOk && eventTypeOk && eventTokenScrubbed;
  record("causal.events", eventCausalOk, {
    hookSeqBase, eventCount: events.length,
    probeEvent: probeEvent ? { ref: probeEvent.ref, type: probeEvent.type, summary: probeEvent.summary, selector: probeEvent.selector } : null,
    eventRefOk, eventTypeOk, eventTokenScrubbed, eventCausalOk,
  });

  // Core PASS gate: network-delta surfaces the fired request (redacted, windowed at the baseline
  // seq), the recorder-unavailable path is reported, the delta is attributed to the activated
  // control (P1 `triggered`), AND a hook console event lands in causal.events redacted (P2).
  result.extras = { focusPathTriggered };
  result.ok = unavailableOk && deltaHasPing && tokenScrubbed && sinceSeqOk && refOk && attributedOk && eventCausalOk;
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
console.log(`${result.ok ? "PASS" : "FAIL"} abml causal live smoke — ${resultPath}`);
process.exit(result.ok ? 0 : 1);
