// ABML mechanism arm — M1 structure templating + M2a treeDiff + M2b semantic ref anchor live smoke. Drives a real browser
// through the genuine browser_observe/browser_execute tool seams and asserts:
//   A) observe(mode:scan) on a 6-link semantic list -> envelope.templates carries one structure
//      template (role link, count >= 4, varies includes name, instanceRefs are pi-ref:// handles).
//   B) mutate the list, then observe(mode:scan, baseline:snapshotId) -> envelope.treeDiff reports
//      O(change) structure delta (one high-confidence appeared instance), not nested text churn.
//   C) a stable named item keeps the same pi-ref after reorder/insert, and that old ref can still
//      read/click the current item; this validates M2b's narrow high-confidence semantic ref anchor path.
//   D) the M2c snapshotProjection attaches treeDiff delta and is persisted in the saved artifact.
// The fixture's <a> items share an AX list container AND carry aria-setsize, so templating fires via
// either grouping path. Exit 0 PASS · 3 NEEDS BROWSER · 1 FAIL. Self-launches an isolated Chrome/Edge
// + bridge + extension copy, so it never touches the user's browser.
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { ToolCollectingAdapter } from "../../src/frontend/toolCollector.ts";
import { registerBrowserTools } from "../../src/tools/registerTools.ts";
import { createBrowserAbmlIntegration } from "../../src/abml/verbs/integration.ts";
import { browserLaunchHardeningArgs, findChromePath as chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-abml-templating-results.json"));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntil(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(250); }
  return undefined;
}
const steps = [];
function record(step, ok, data = {}) { steps.push({ step, ok, ...data, t: Date.now() }); }
function namedEntityFromRecord(record, name) {
  const focus = record && typeof record.focus === "object" ? record.focus : {};
  const abml = record && typeof record.abml === "object" ? record.abml : {};
  const candidates = [
    ...(Array.isArray(focus.primary_entities) ? focus.primary_entities : []),
    ...(Array.isArray(focus.list_entities) ? focus.list_entities : []),
    ...(Array.isArray(focus.referenced_entities) ? focus.referenced_entities : []),
    ...(Array.isArray(abml.entities) ? abml.entities : []),
  ];
  return candidates.find((entity) => entity && entity.name === name);
}
async function namedEntity(env, name) {
  const inline = namedEntityFromRecord(env, name);
  if (inline) return inline;
  const savedPath = env?.snapshot?.saved?.path;
  if (typeof savedPath !== "string" || !savedPath) return undefined;
  try { return namedEntityFromRecord(JSON.parse(await readFile(savedPath, "utf8")), name); }
  catch { return undefined; }
}

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
  const bridgePort = await freePort();
  const fixturePort = await freePort();
  const fixtureHtml = await readFile(path.join(root, "evals", "browser-workflows", "fixtures", "abml-templating-list.html"), "utf8");
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/abml-templating-list.html`;
  fixture = createHttpServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) }); res.end(fixtureHtml); });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
  await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
  const extensionPatch = await patchExtensionDistPort(extensionDir, bridgePort); Object.assign(process.env, extensionPatch.env);
  bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort });
  await bridge.start();
  chrome = spawn(chromeExe, [
    `--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`,
    `--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`,
    `--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...browserLaunchHardeningArgs(),
    fixtureUrl,
  ], { stdio: ["ignore", "pipe", "pipe"], detached: false });
  const connected = await waitUntil(() => { const snapshot = bridge.snapshot(); return snapshot.extensionConnected ? snapshot : undefined; }, 30000);
  if (!connected) { result.needsBrowser = true; throw new Error("NEEDS_BROWSER: extension did not connect"); }
  record("bridge.connected", true, { bridgePort, fixturePort, chrome: chromeExe });
  const targetTab = await waitUntil(async () => { await bridge.refreshTabs(5000).catch(() => undefined); return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`)); }, 20000);
  if (!targetTab?.tabId) throw new Error("templating fixture tab not found");
  const tabId = targetTab.tabId;
  await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10000 }, { tabId, timeoutMs: 12000 });

  const adapter = new ToolCollectingAdapter();
  registerBrowserTools(adapter, bridge, async () => bridge);
  const observe = adapter.getTool("browser_observe");
  const execute = adapter.getTool("browser_execute");
  if (!observe) throw new Error("browser_observe not registered");
  if (!execute) throw new Error("browser_execute not registered");
  const browserSessionId = bridge.snapshot().browserSessionId;

  // ── A) observe the repeated list → the templating engine folds it, surfaced via the kept
  //       snapshotProjection.templates (the standalone envelope.templates output field was removed 2026-06-05). ──────
  const env = await observeEnvelope(observe, { mode: "scan", tabId, browserSessionId, detailLevel: "detailed" });
  const templates = Array.isArray(env.snapshotProjection?.templates) ? env.snapshotProjection.templates : [];
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
  const stableBefore = await namedEntity(env, "Product Bravo");
  const stableAfter = await namedEntity(afterEnv, "Product Bravo");
  const semanticRefStable = !!stableBefore?.ref && stableBefore.ref === stableAfter?.ref;
  const semanticRefShape = /^pi-ref:\/\/control\/[0-9a-f]{24}$/.test(String(stableAfter?.ref || ""));
  const treeDiffOk = !!treeDiff && treeAppearedOk && nestedChurnSuppressed;
  record("treeDiff.delta", treeDiffOk, {
    summary: treeDiff?.summary,
    template: treeTemplate ? { container: treeTemplate.container, containerName: treeTemplate.containerName, beforeCount: treeTemplate.beforeCount, afterCount: treeTemplate.afterCount, appeared: treeTemplate.appeared, disappeared: treeTemplate.disappeared, changed: treeTemplate.changed, reordered: treeTemplate.reordered } : null,
    treeAppearedOk,
    nestedChurnSuppressed,
  });
  const projection = afterEnv.snapshotProjection;
  const projectionTemplate = Array.isArray(projection?.templates) ? projection.templates.find((item) => item?.containerName === "Products" && item?.role === "link") || projection.templates[0] : undefined;
  const projectionDeltaOk = Number(projection?.summary?.appeared) === 1 && projectionTemplate?.delta?.appeared?.instances?.some((item) => item?.name === "Product Golf" && item?.confidence === "high");
  const savedPath = afterEnv?.saved?.path || afterEnv?.snapshot?.saved?.path;
  const savedArtifact = typeof savedPath === "string" && savedPath ? JSON.parse(await readFile(savedPath, "utf8")) : undefined;
  const artifactProjectionOk = !!savedArtifact?.abml?.snapshotProjection?.templates?.some((item) => item?.delta?.appeared?.instances?.some((instance) => instance?.name === "Product Golf"));
  const artifactEntitiesOk = Array.isArray(savedArtifact?.abml?.entities) && savedArtifact.abml.entities.length >= 7;
  record("snapshotProjection.delta", projectionDeltaOk && artifactProjectionOk && artifactEntitiesOk, {
    summary: projection?.summary,
    template: projectionTemplate ? { container: projectionTemplate.container, containerName: projectionTemplate.containerName, role: projectionTemplate.role, count: projectionTemplate.count, instanceRefCount: projectionTemplate.instanceRefCount, delta: projectionTemplate.delta } : null,
    savedPath,
    projectionDeltaOk,
    artifactProjectionOk,
    artifactEntitiesOk,
  });

  const abml = createBrowserAbmlIntegration(bridge, { browserSessionId, tabId, timeoutMs: 10000, maxChars: 50000 });
  const readViaOldRef = stableBefore?.ref ? await abml.readStructure({ ref: stableBefore.ref, browserSessionId, tabId, timeoutMs: 10000, maxChars: 50000 }) : undefined;
  const readResolved = !!readViaOldRef?.ok && Array.isArray(readViaOldRef.entities) && readViaOldRef.entities.some((entity) => entity?.name === "Product Bravo");
  const clickViaOldRef = stableBefore?.ref && abml.runtime.click ? await abml.runtime.click({ ref: stableBefore.ref }) : undefined;
  const clickResolved = !!clickViaOldRef?.ok;
  record("semanticRef.stable", semanticRefStable && semanticRefShape && readResolved && clickResolved, {
    before: stableBefore ? { ref: stableBefore.ref, name: stableBefore.name, role: stableBefore.role } : null,
    after: stableAfter ? { ref: stableAfter.ref, name: stableAfter.name, role: stableAfter.role } : null,
    semanticRefStable,
    semanticRefShape,
    readResolved,
    clickResolved,
  });

  result.ok = templatingOk && treeDiffOk && semanticRefStable && semanticRefShape && readResolved && clickResolved && projectionDeltaOk && artifactProjectionOk && artifactEntitiesOk;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  record("error", false, { message });
  if (/NEEDS_BROWSER/.test(message)) result.needsBrowser = true;
} finally {
  stopBrowserProcess(chrome);
  try { if (bridge) await bridge.stop?.(); } catch {}
  try { if (fixture) await new Promise((resolve) => fixture.close(resolve)); } catch {}
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8").catch(() => {});
}
if (result.needsBrowser && !result.ok) { console.log(`NEEDS BROWSER — ${resultPath}`); process.exit(3); }
console.log(`${result.ok ? "PASS" : "FAIL"} abml templating live smoke — ${resultPath}`);
process.exit(result.ok ? 0 : 1);
