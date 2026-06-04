// ABML action-gap measurement (Task C). Quantifies, on a real browser, the cost the "no one is
// blocked" framing hides: the PUBLIC action path (raw browser_execute JS, the skill's click snippet)
// vs the INTERNAL ABML degradation ladder (runtime.click → synthetic → verify → CDP trusted fallback).
//
// Fixture #guarded honors only a TRUSTED click. So:
//   A) raw skill snippet (el.click(), isTrusted:false) → reports ok BUT the effect never fires =
//      SILENT FAILURE (the agent thinks it clicked; nothing happened).
//   B) ABML ladder → synthetic fails verification → auto-falls-back to CDP trusted event → effect
//      fires → verified. The ladder RECOVERS the exact case the public path silently loses.
//   control) raw snippet on #plain (accepts any click) → works — proving raw JS isn't broken in
//      general, only on the trusted-event case the ladder is built for.
// PASS = the gap is real and the ladder fixes it (rawGuardedEffect=false, ladderGuardedEffect=true).
// Self-launches an isolated Chrome/Edge + bridge; never touches the user's browser.
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { createBrowserAbmlIntegration } from "../../src/abml/verbs/integration.ts";
import { ToolCollectingAdapter } from "../../src/frontend/toolCollector.ts";
import { registerBrowserTools } from "../../src/tools/registerTools.ts";
import { resolveBrowserToolCapabilityProfile } from "../../src/tools/capabilityProfile.ts";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-abml-action-gap-results.json"));
const chromeCandidates = [
  process.env.PI_BROWSER_SMOKE_CHROME,
  process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
  process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
  process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : undefined,
  process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe") : undefined,
  process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
  "google-chrome", "chromium", "chromium-browser",
].filter(Boolean);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function chromePath() { for (const c of chromeCandidates) if (existsSync(c)) return c; return undefined; }
function isWindowsChromeExecutable(chromeExe) { return process.platform !== "win32" && /\.exe$/i.test(String(chromeExe || "")) && /^\/mnt\/[a-z]\//i.test(String(chromeExe || "")); }
function windowsPathForChrome(value, chromeExe) { if (!isWindowsChromeExecutable(chromeExe)) return value; const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(String(value || "")); if (!match) return value; return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`; }
async function freePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    const server = createNetServer();
    try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); await new Promise((resolve) => server.close(resolve)); return port; }
    catch { await new Promise((resolve) => server.close(resolve)); }
  }
  throw new Error(`No free port in range ${start}-${end}`);
}
async function patchExtensionPort(extensionDir, bridgePort) {
  const serviceWorkerPath = path.join(extensionDir, "dist", "service-worker.js");
  let source = await readFile(serviceWorkerPath, "utf8");
  source = source.replaceAll("127.0.0.1:18765", `127.0.0.1:${bridgePort}`).replace(/PI_BROWSER_BRIDGE_PORT\s*=\s*18765/g, `PI_BROWSER_BRIDGE_PORT = ${bridgePort}`).replace(/PI_BROWSER_BRIDGE_PORT_RANGE_END\s*=\s*18784/g, `PI_BROWSER_BRIDGE_PORT_RANGE_END = ${bridgePort}`);
  await writeFile(serviceWorkerPath, source, "utf8");
}
async function waitUntil(predicate, timeoutMs = 20000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(250); } return undefined; }
const steps = [];
function record(step, ok, data = {}) { steps.push({ step, ok, ...data, t: Date.now() }); }
function evalValue(res) { const d = res?.data; if (d && typeof d === "object") { if ("value" in d) return d.value; if (d.result && typeof d.result === "object" && "value" in d.result) return d.result.value; } return d; }

// The skill's canonical click snippet (verbatim — this is what an agent runs today).
const clickSnippet = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false, reason: 'not_found' }; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return { ok: false, reason: 'covered' }; el.click(); return { ok: true, text: el.innerText || el.value || '' }; })()`;

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `abml-action-gap-profile-${runId}`);
const extensionDir = path.join(tempRoot, `abml-action-gap-extension-${runId}`);
let fixture; let chrome; let bridge;
let result = { ok: false, needsBrowser: false, resultPath, steps, measurement: {} };
try {
  await mkdir(outDir, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  const chromeExe = chromePath();
  if (!chromeExe) { result.needsBrowser = true; throw new Error("NEEDS_BROWSER: no Chrome/Edge found (set PI_BROWSER_SMOKE_CHROME)"); }
  if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`extension source missing manifest.json: ${extensionSource}`);
  const bridgePort = await freePort(18871, 18900);
  const fixturePort = await freePort(8871, 8900);
  const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "abml-action-gap.html"), "utf8");
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/abml-action-gap.html`;
  fixture = createHttpServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) }); res.end(fixtureHtml); });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
  await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  await patchExtensionPort(extensionDir, bridgePort);
  bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort });
  await bridge.start();
  chrome = spawn(chromeExe, [`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`, `--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`, `--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", fixtureUrl], { stdio: ["ignore", "pipe", "pipe"], detached: false });
  const connected = await waitUntil(() => { const snapshot = bridge.snapshot(); return snapshot.extensionConnected ? snapshot : undefined; }, 30000);
  if (!connected) { result.needsBrowser = true; throw new Error("NEEDS_BROWSER: extension did not connect"); }
  record("bridge.connected", true, { bridgePort, fixturePort });
  const targetTab = await waitUntil(async () => { await bridge.refreshTabs(5000).catch(() => undefined); return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`)); }, 20000);
  if (!targetTab?.tabId) throw new Error("action-gap fixture tab not found");
  const tabId = targetTab.tabId;
  await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });
  const browserSessionId = bridge.snapshot().browserSessionId;
  const readEffect = async (expr) => evalValue(await bridge.executeJavaScript(`return ${expr};`, { tabId, browserSessionId, timeoutMs: 8000 }));

  // ── control) raw snippet on #plain (accepts any click) — raw JS is not broken in general ──────────
  await bridge.executeJavaScript("return window.__resetEffect();", { tabId, browserSessionId, timeoutMs: 8000 });
  await bridge.executeJavaScript(`return ${clickSnippet("#plain")};`, { tabId, browserSessionId, timeoutMs: 8000 });
  await delay(150);
  const rawPlainEffect = (await readEffect("window.__plainEffect === true")) === true;
  record("raw.plain", rawPlainEffect === true, { rawPlainEffect });

  // ── A) raw skill snippet on #guarded (trusted-only) → reports ok but effect never fires ──────────
  await bridge.executeJavaScript("return window.__resetEffect();", { tabId, browserSessionId, timeoutMs: 8000 });
  const rawRes = await bridge.executeJavaScript(`return ${clickSnippet("#guarded")};`, { tabId, browserSessionId, timeoutMs: 8000 });
  await delay(150);
  const rawClick = evalValue(rawRes);
  const rawClickReportedOk = !!(rawClick && rawClick.ok === true);
  const rawGuardedEffect = (await readEffect("window.__effect === true")) === true;
  record("raw.guarded", true, { rawClickReportedOk, rawGuardedEffect, silentFailure: rawClickReportedOk && !rawGuardedEffect });

  // ── B) ABML ladder on #guarded → synthetic fails verify → CDP trusted fallback → effect fires ────
  await bridge.executeJavaScript("return window.__resetEffect();", { tabId, browserSessionId, timeoutMs: 8000 });
  const abml = createBrowserAbmlIntegration(bridge, { tabId, browserSessionId, timeoutMs: 10000, maxChars: 50000 });
  const read = await abml.readStructure({ tabId, browserSessionId, timeoutMs: 10000, maxChars: 50000 });
  const guardedEntity = (read?.ok ? read.entities || [] : []).find((e) => e?.hints?.selector === "#guarded" || (Array.isArray(e?.locators) && e.locators.some((l) => l.by === "css" && l.value === "#guarded")));
  let ladderClick;
  if (guardedEntity?.ref) ladderClick = await abml.runtime.click({ ref: guardedEntity.ref });
  await delay(200);
  const ladderGuardedEffect = (await readEffect("window.__effect === true")) === true;
  const ladderTransport = ladderClick?.ok ? ladderClick.data?.transport : undefined;
  const ladderVerified = ladderClick?.ok ? ladderClick.verification?.status : ladderClick?.error?.code;
  record("ladder.guarded", ladderGuardedEffect === true, { foundRef: guardedEntity?.ref, ladderTransport, ladderVerified, ladderGuardedEffect });

  // ── E) PUBLIC PATH (B2): browser_execute action:{click:"#guarded"} routes through the ladder ──────
  await bridge.executeJavaScript("return window.__resetEffect();", { tabId, browserSessionId, timeoutMs: 8000 });
  const profile = resolveBrowserToolCapabilityProfile();
  bridge.setCapabilityProfile?.(profile);
  const adapter = new ToolCollectingAdapter();
  registerBrowserTools(adapter, bridge, async () => bridge, { securityToolsEnabled: profile.securityToolsEnabled });
  const execute = adapter.getTool("browser_execute");
  let toolActionEnvelope;
  if (execute) {
    const r = await execute.execute("action", { action: { click: "#guarded" }, tabId, browserSessionId }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
    const text = Array.isArray(r.content) ? r.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n") : "";
    try { toolActionEnvelope = JSON.parse(text); } catch { toolActionEnvelope = undefined; }
  }
  await delay(200);
  const toolActionEffect = (await readEffect("window.__effect === true")) === true;
  record("public.action", toolActionEffect === true, { toolActionEffect, registered: !!execute, transport: toolActionEnvelope?.details?.transport, verification: toolActionEnvelope?.details?.verification });

  result.measurement = {
    raw_works_on_plain: rawPlainEffect,
    raw_guarded_reported_ok: rawClickReportedOk,
    raw_guarded_effect_fired: rawGuardedEffect,
    raw_guarded_silent_failure: rawClickReportedOk && !rawGuardedEffect,
    ladder_guarded_effect_fired: ladderGuardedEffect,
    ladder_transport: ladderTransport,
    ladder_verification: ladderVerified,
    public_action_effect_fired: toolActionEffect,
  };
  // Gap confirmed AND ladder recovers it: raw silently fails on the trusted-only case, ladder fixes it.
  result.ok = rawPlainEffect === true && rawClickReportedOk === true && rawGuardedEffect === false && ladderGuardedEffect === true && toolActionEffect === true;
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
console.log(`${result.ok ? "PASS" : "FAIL"} abml action-gap measurement — ${resultPath}`);
console.log(JSON.stringify(result.measurement, null, 2));
process.exit(result.ok ? 0 : 1);
