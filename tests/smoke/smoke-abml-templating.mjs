// ABML mechanism arm — M1 structure templating + M2a treeDiff live smoke. Drives a real browser
// through the genuine browser_observe/browser_execute tool seams and asserts:
//   A) observe(mode:scan) on a 6-link semantic list -> envelope.templates carries one structure
//      template (role link, count >= 4, varies includes name, instanceRefs are pi-ref:// handles).
//   B) mutate the list, then observe(mode:scan, baseline:snapshotId) -> envelope.treeDiff reports
//      O(change) structure delta (one high-confidence appeared instance), not nested text churn.
// The fixture's <a> items share an AX list container AND carry aria-setsize, so templating fires via
// either grouping path. Exit 0 PASS · 3 NEEDS BROWSER · 1 FAIL. Self-launches an isolated Chrome/Edge
// + bridge + extension copy, so it never touches the user's browser.
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
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-abml-templating-results.json"));
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
    } catch { await new Promise((resolve) => server.close(resolve)); }
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
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(250); }
  return undefined;
}
const steps = [];
function record(step, ok, data = {}) { steps.push({ step, ok, ...data, t: Date.now() }); }

async function observeEnvelope(observe, args) {
  const r = await observe.execute("templating", args, undefined, undefined, { cwd: process.cwd(), hasUI: false });
  const text = Array.isArray(r.content) ? r.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n") : "";
  return JSON.parse(text);
}

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `abml-templating-profile-${runId}`);
const extensionDir = path.join(tempRoot, `abml-templating-extension-${runId}`);
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
  const bridgePort = await freePort(18841, 18870);
  const fixturePort = await freePort(8841, 8870);
  const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "abml-templating-list.html"), "utf8");
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/abml-templating-list.html`;
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
  if (!targetTab?.tabId) throw new Error("templating fixture tab not found");
  const tabId = targetTab.tabId;
  await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });

  const profile = resolveBrowserToolCapabilityProfile();
  bridge.setCapabilityProfile?.(profile);
  const adapter = new ToolCollectingAdapter();
  registerBrowserTools(adapter, bridge, async () => bridge, { securityToolsEnabled: profile.securityToolsEnabled });
  const observe = adapter.getTool("browser_observe");
  const execute = adapter.getTool("browser_execute");
  if (!observe) throw new Error("browser_observe not registered");
  if (!execute) throw new Error("browser_execute not registered");
  const browserSessionId = bridge.snapshot().browserSessionId;

  // ── A) observe the repeated list → envelope.templates folds it into one structure template ──────
  const env = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, detailLevel: "detailed" });
  const templates = Array.isArray(env.templates) ? env.templates : [];
  const linkTemplate = templates.find((t) => t && (t.role === "link" || t.kind === "control") && Number(t.count) >= 4) || templates[0];
  const countOk = !!linkTemplate && Number(linkTemplate.count) >= 4;
  const refsOk = !!linkTemplate && Array.isArray(linkTemplate.instanceRefs) && linkTemplate.instanceRefs.length >= 4 && linkTemplate.instanceRefs.every((r) => /^pi-ref:\/\//.test(String(r)));
  const variesName = !!linkTemplate && Array.isArray(linkTemplate.varies) && linkTemplate.varies.includes("name");
  const templatingOk = templates.length >= 1 && countOk && refsOk && variesName;
  record("templating.fold", templatingOk, {
    templateCount: templates.length,
    template: linkTemplate ? { container: linkTemplate.container, containerName: linkTemplate.containerName, role: linkTemplate.role, kind: linkTemplate.kind, count: linkTemplate.count, setSize: linkTemplate.setSize, varies: linkTemplate.varies, instanceRefCount: Array.isArray(linkTemplate.instanceRefs) ? linkTemplate.instanceRefs.length : 0, sample: linkTemplate.sample } : null,
    countOk, refsOk, variesName,
  });


  // ── B) mutate the repeated list → baseline observe emits O(change) treeDiff ─────────────────
  await execute.execute("templating", {
    tabId, browserSessionId,
    script: `(() => {
      const list = document.querySelector('ul[aria-label="Products"]');
      if (!list) return { ok: false, reason: 'missing-list' };
      const items = Array.from(list.children);
      const charlie = items.find((li) => /Charlie/.test(li.textContent || ''));
      if (charlie) list.insertBefore(charlie, list.firstElementChild);
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#golf';
      a.textContent = 'Product Golf';
      a.setAttribute('aria-setsize', '7');
      a.setAttribute('aria-posinset', '7');
      li.appendChild(a);
      list.appendChild(li);
      Array.from(list.querySelectorAll('a')).forEach((link, index) => {
        link.setAttribute('aria-setsize', '7');
        link.setAttribute('aria-posinset', String(index + 1));
      });
      return { ok: true, count: list.querySelectorAll('a').length };
    })()`,
  }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
  const afterEnv = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, detailLevel: "detailed", baseline: { snapshotId: env.snapshot?.snapshotId } });
  const treeDiff = afterEnv.treeDiff;
  const treeTemplate = Array.isArray(treeDiff?.templates) ? treeDiff.templates[0] : undefined;
  const treeAppearedOk = Number(treeDiff?.summary?.appeared) === 1 && Number(treeDiff?.summary?.disappeared) === 0 && treeTemplate?.appeared?.instances?.some((item) => item?.name === "Product Golf" && item?.confidence === "high");
  const nestedChurnSuppressed = Number(treeDiff?.summary?.templateCount) === 1 && Number(treeDiff?.summary?.changedTemplateCount) === 1;
  const treeDiffOk = !!treeDiff && treeAppearedOk && nestedChurnSuppressed;
  record("treeDiff.delta", treeDiffOk, {
    summary: treeDiff?.summary,
    template: treeTemplate ? { container: treeTemplate.container, containerName: treeTemplate.containerName, beforeCount: treeTemplate.beforeCount, afterCount: treeTemplate.afterCount, appeared: treeTemplate.appeared, disappeared: treeTemplate.disappeared, changed: treeTemplate.changed, reordered: treeTemplate.reordered } : null,
    treeAppearedOk,
    nestedChurnSuppressed,
  });

  result.ok = templatingOk && treeDiffOk;
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
console.log(`${result.ok ? "PASS" : "FAIL"} abml templating live smoke — ${resultPath}`);
process.exit(result.ok ? 0 : 1);
