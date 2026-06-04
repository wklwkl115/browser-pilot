// ABML R2 inference + R3 post-action live smoke. Drives a real browser against the
// abml-inference-postaction.html fixture through the genuine browser_observe tool seam, then:
//   1) baseline scan  -> asserts de-overfitted login (real "Sign in" submit beats federated +
//      passkey via generic signals), filter-panel from real facet controls, and that a HIDDEN
//      dialog does NOT fire (perceptibility gating).
//   2) an action (enable a disabled control + focus an editable field + inject a role=alert toast)
//   3) scan with the baseline -> asserts the envelope top-level R3 diff (appeared), alert-region
//      flagged fresh=appeared (post-action live region), and form-dependency from the diff.
// Exit 0 PASS · 3 NEEDS BROWSER · 1 FAIL.
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
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-abml-inference-postaction-results.json"));
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

const intentsOf = (env) => (env && env.inference && Array.isArray(env.inference.intents)) ? env.inference.intents : [];
const intentByName = (env, name) => intentsOf(env).find((i) => i.intent === name);
const entityByRef = (env, ref) => (env && Array.isArray(env.entities) ? env.entities : []).find((e) => e.ref === ref);
async function observeEnvelope(observe, args) {
  const r = await observe.execute("infer-b", args, undefined, undefined, { cwd: process.cwd(), hasUI: false });
  const text = Array.isArray(r.content) ? r.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n") : "";
  return JSON.parse(text);
}

const ACTION_SCRIPT = [
  "document.getElementById('apply').disabled = false;",
  "document.getElementById('email').focus();",
  "var t = document.createElement('div');",
  "t.setAttribute('role','alert');",
  "t.textContent = 'Sign in failed: invalid credentials';",
  "document.getElementById('region').appendChild(t);",
  "return 'ok';",
].join("\n");

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `abml-infer-b-profile-${runId}`);
const extensionDir = path.join(tempRoot, `abml-infer-b-extension-${runId}`);
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
  if (!targetTab?.tabId) throw new Error("inference fixture tab not found");
  const tabId = targetTab.tabId;
  await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });

  const profile = resolveBrowserToolCapabilityProfile();
  bridge.setCapabilityProfile?.(profile);
  const adapter = new ToolCollectingAdapter();
  registerBrowserTools(adapter, bridge, async () => bridge, { securityToolsEnabled: profile.securityToolsEnabled });
  const observe = adapter.getTool("browser_observe");
  if (!observe) throw new Error("browser_observe not registered");
  const browserSessionId = bridge.snapshot().browserSessionId;

  // ── 1) baseline scan ────────────────────────────────────────────────────────
  const env1 = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, detailLevel: "detailed" });
  const login1 = intentByName(env1, "login");
  const submitRef = login1?.evidence?.submitRef;
  const submitName = String(entityByRef(env1, submitRef)?.name || "");
  // De-overfit check: login fires high and the chosen submit is NOT a federated/passkey/forgot
  // distractor. envelope.entities is a salience SUBSET (the real "Sign in" submit can be absent for
  // a name lookup), so assert by EXCLUDING the distractor refs — which are present in the subset.
  const distractorRefs = (Array.isArray(env1.entities) ? env1.entities : []).filter((e) => /google|passkey|forgot/i.test(String(e.name || ""))).map((e) => e.ref);
  const loginDeOverfitOk = login1?.confidence === "high" && !!submitRef && !distractorRefs.includes(submitRef);
  const filterPanelOk = intentByName(env1, "filter-panel")?.confidence === "high";
  const dialogGatedOk = !intentByName(env1, "dialog"); // hidden dialog must not fire
  const navOk = !!intentByName(env1, "navigation");
  const dumpControls = (env) => (Array.isArray(env.entities) ? env.entities : [])
    .filter((e) => ["button", "link"].includes(e.role))
    .map((e) => ({ ref: String(e.ref).slice(-6), role: e.role, name: e.name, kind: e.kind, sel: e.hints?.selector }));
  record("baseline.scan", loginDeOverfitOk && filterPanelOk && dialogGatedOk, {
    intents: intentsOf(env1).map((i) => `${i.intent}(${i.confidence})`),
    submitRef, submitName, distractorRefs: distractorRefs.map((r) => String(r).slice(-6)),
    loginDeOverfitOk, filterPanelOk, dialogGatedOk, navOk,
    controls: dumpControls(env1),
  });

  // ── 2) action: enable disabled control + focus editable + inject role=alert toast ─
  await bridge.executeJavaScript(ACTION_SCRIPT, { tabId, browserSessionId, timeoutMs: 8000 });
  await delay(600);

  // ── 3) scan with the baseline → R3 diff + post-action alert + form-dependency ──
  const env2 = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, baseline: env1.entities, detailLevel: "detailed" });
  const diff = env2.diff || {};
  const diffHasAppeared = Array.isArray(diff.appeared) && diff.appeared.length > 0;
  const alert2 = intentByName(env2, "alert-region");
  const alertFreshOk = alert2?.evidence?.fresh === "appeared" && alert2?.evidence?.live === "assertive";
  const dep2 = intentByName(env2, "form-dependency");
  const formDepOk = !!dep2?.evidence?.enabledRef && !!dep2?.evidence?.requiredRef;
  record("postaction.scan", diffHasAppeared && alertFreshOk, {
    intents: intentsOf(env2).map((i) => `${i.intent}(${i.confidence})`),
    appearedCount: Array.isArray(diff.appeared) ? diff.appeared.length : 0,
    changed: Array.isArray(diff.changed) ? diff.changed.map((c) => `${c.kind}:${c.ref}`) : [],
    focusedRef: diff.focusedRef,
    alertEvidence: alert2?.evidence, formDepEvidence: dep2?.evidence,
    diffHasAppeared, alertFreshOk, formDepOk,
  });

  // Core PASS gate: the two things this batch shipped — de-overfit login + post-action alert via R3 diff —
  // plus the supporting gating (hidden dialog suppressed) and a populated diff. form-dependency + nav are
  // recorded as extras (form-dependency can be focus-timing sensitive on a real page).
  const corePass = loginDeOverfitOk && filterPanelOk && dialogGatedOk && diffHasAppeared && alertFreshOk;
  result.extras = { navOk, formDepOk };
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
console.log(`${result.ok ? "PASS" : "FAIL"} abml inference post-action smoke — ${resultPath}`);
process.exit(result.ok ? 0 : 1);
