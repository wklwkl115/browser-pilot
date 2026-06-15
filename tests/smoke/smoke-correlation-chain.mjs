import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { evaluatePageScriptDirect } from "../../src/tools/pageScriptEvaluation.ts";
import { distilledJsonResult, distilledTextResult } from "../../src/tools/resultMiddleware.ts";
import { summarizeScanData } from "../../src/tools/summaries/scan.ts";
import { readBrowserArtifact } from "../../src/tools/artifactReader.ts";
import { executeBrowserWaitWithSupervisor } from "../../src/driver/BrowserWaitSupervisor.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-correlation-chain-results.json"));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntil(predicate, timeoutMs = 20_000) {
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
const profileDir = path.join(tempRoot, `correlation-chain-profile-${runId}`);
const extensionDir = path.join(tempRoot, `correlation-chain-extension-${runId}`);
const observeArtifactPath = path.join(outDir, `correlation-chain-observe-${runId}.json`);
const waitArtifactPath = path.join(outDir, `correlation-chain-wait-${runId}.json`);
const executeArtifactPath = path.join(outDir, `correlation-chain-execute-${runId}.json`);
const executeMonitorArtifactPath = path.join(outDir, `correlation-chain-execute-monitor-${runId}.json`);
let chrome;
let fixture;
let bridge;
let tabId;
let result = { ok: false, resultPath, observeArtifactPath, waitArtifactPath, executeArtifactPath, profileDir, extensionDir, extensionSource, steps };

try {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort();
	const fixturePort = await freePort();
	const fixtureHtml = await readFile(path.join(root, "tests", "fixtures", "browser-workflows", "interactive.html"), "utf8");
	const fixtureUrl = `http://127.0.0.1:${fixturePort}/interactive.html`;
	fixture = createHttpServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(fixtureHtml) });
		res.end(fixtureHtml);
	});
	await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(fixturePort, "127.0.0.1", resolve); });
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	const extensionPatch = await patchExtensionDistPort(extensionDir, bridgePort);
	Object.assign(process.env, extensionPatch.env);
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
	chrome.stdout.on("data", () => {});
	chrome.stderr.on("data", () => {});

	const connected = await waitUntil(() => {
		const snapshot = bridge.snapshot();
		return snapshot.extensionConnected ? snapshot : undefined;
	}, 20_000);
	if (!connected) throw new Error(`Browser extension did not connect to bridge port ${bridge.port}`);
	record("bridge.connected", true, { bridgePort, fixturePort, connectedClients: connected.connectedClients });

	const targetTab = await waitUntil(async () => {
		await bridge.refreshTabs(5_000).catch(() => undefined);
		return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${fixturePort}/`));
	}, 20_000);
	if (!targetTab?.tabId) throw new Error(`Fixture tab ${fixtureUrl} not found`);
	tabId = targetTab.tabId;
	await bridge.sendCommand({ cmd: "wait.loadState", tabId, state: "complete", timeoutMs: 10_000 }, { tabId, timeoutMs: 12_000 });
	record("fixture.open", true, { tabId, fixtureUrl });

	const maxChars = 12_000;
	const scanScript = buildScanScript({ maxChars: 80_000, maxNodes: 4_000, includeIframes: true, textOnly: false });
	const rawScan = await evaluatePageScriptDirect(bridge, scanScript, { tabId, timeoutMs: 10_000, name: "scan_extract" });
	const tabs = await bridge.refreshTabs(5_000).catch(() => bridge.getTabs());
	const scanContent = typeof rawScan.data?.content === "string" ? rawScan.data.content : JSON.stringify(rawScan.data ?? rawScan, null, 2);
	const observeSummary = summarizeScanData(rawScan.data, tabs, { detailLevel: "summary", maxChars });
	const observeOperation = bridge.beginOperation({ toolName: "browser_observe", command: "scan", tabId, browserSessionId: bridge.snapshot().browserSessionId, phase: "completed", progress: 100, sourceMode: "scan" });
	const observeSnapshot = bridge.createObservationSnapshot({ browserSessionId: bridge.snapshot().browserSessionId, tabId, url: fixtureUrl, frameScope: "tab", selectionVersion: bridge.snapshot().selectionVersion, sourceMode: "scan", capturedAt: Date.now(), saved: { path: observeArtifactPath } });
	const observeEnvelope = JSON.parse((await distilledTextResult(scanContent, {
		toolName: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		maxChars,
		ctx: { cwd: root },
		outputPath: observeArtifactPath,
		fallbackName: path.basename(observeArtifactPath),
		summary: {
			...observeSummary,
			browserSessionId: bridge.snapshot().browserSessionId,
			tabId,
			selectionVersion: bridge.snapshot().selectionVersion,
			selectionVersionAtDispatch: bridge.snapshot().selectionVersion,
			selectionVersionAtResolve: bridge.snapshot().selectionVersion,
		},
		artifactValue: {
			...rawScan,
			tabs_count: tabs.length,
			tabs,
			active_tab: bridge.snapshot().defaultTabId,
			browserSessionId: bridge.snapshot().browserSessionId,
			operation: observeOperation,
			snapshot: observeSnapshot,
		},
		operation: observeOperation,
		snapshot: observeSnapshot,
	})).content[0].text);
	record("observe.correlation", typeof observeEnvelope.correlation?.operationId === "string"
		&& typeof observeEnvelope.correlation?.snapshotId === "string"
		&& observeEnvelope.correlation?.sourceMode === "scan"
		&& Number.isInteger(observeEnvelope.target?.selectionVersionAtDispatch)
		&& Number.isInteger(observeEnvelope.target?.selectionVersionAtResolve), {
			correlation: observeEnvelope.correlation,
			target: observeEnvelope.target,
			savedPath: observeEnvelope.saved?.path,
		});
	const observeAbmlOk = await readBrowserArtifact({ path: observeArtifactPath, mode: "json", jsonPath: "abml.ok" }, { cwd: root }).catch(() => ({ value: undefined }));
	const observeAbmlEntities = await readBrowserArtifact({ path: observeArtifactPath, mode: "json", jsonPath: "abml.entities" }, { cwd: root }).catch(() => ({ value: undefined }));
	record("observe.abml.artifact", (Array.isArray(observeAbmlEntities.value) && observeAbmlEntities.value.length >= 1) || Number(observeEnvelope.summary?.focus?.primary_entities?.length || 0) >= 1, {
		abmlOk: observeAbmlOk.value,
		abmlEntityCount: Array.isArray(observeAbmlEntities.value) ? observeAbmlEntities.value.length : undefined,
		primaryEntities: observeEnvelope.summary?.focus?.primary_entities?.length,
		savedPath: observeArtifactPath,
	});

	const executeResult = await bridge.executeJavaScript(`(() => {
		const button = document.querySelector('#activate');
		if (!button) return { ok: false, reason: 'missing' };
		button.click();
		return { ok: true, status: document.querySelector('#status')?.textContent || '' };
	})()`, { tabId, timeoutMs: 10_000 });
	const executeOperation = bridge.beginOperation({ toolName: "browser_execute", command: "javascript", tabId, browserSessionId: bridge.snapshot().browserSessionId, phase: "completed", progress: 100, sourceMode: "scan" });
	const executeEnvelope = JSON.parse((await distilledJsonResult(executeResult, {
		toolName: "browser_execute",
		command: "javascript",
		detailLevel: "summary",
		maxChars,
		ctx: { cwd: root },
		outputPath: executeArtifactPath,
		fallbackName: path.basename(executeArtifactPath),
		artifactValue: { ...executeResult, operation: executeOperation },
		operation: executeOperation,
	})).content[0].text);
	record("execute.correlation", typeof executeEnvelope.correlation?.operationId === "string" && executeResult.data?.status === "Status: activated", {
		correlation: executeEnvelope.correlation,
		status: executeResult.data?.status,
		savedPath: executeEnvelope.saved?.path,
	});
	const executeMonitorOperation = bridge.beginOperation({ toolName: "browser_execute", command: "javascript", tabId, browserSessionId: bridge.snapshot().browserSessionId, phase: "completed", progress: 100, sourceMode: "scan" });
	const executeMonitorEnvelope = JSON.parse((await distilledJsonResult({
		ok: true,
		tabId,
		data: { status: "Status: monitor route changed", monitor: { beforeOk: true, afterOk: true, beforeChars: 20, afterChars: 42, changed: 1, top_change: "Status: monitor route changed", abmlIntegrated: true } },
	}, {
		toolName: "browser_execute",
		command: "javascript",
		detailLevel: "summary",
		maxChars,
		ctx: { cwd: root },
		outputPath: executeMonitorArtifactPath,
		fallbackName: path.basename(executeMonitorArtifactPath),
		artifactValue: { tabId, monitor: { changed: 1, top_change: "Status: monitor route changed", abmlIntegrated: true }, operation: executeMonitorOperation },
		operation: executeMonitorOperation,
	})).content[0].text);
	record("execute.monitor.correlation", typeof executeMonitorEnvelope.correlation?.operationId === "string"
		&& executeMonitorEnvelope.summary?.data?.monitor?.changed === 1, {
		correlation: executeMonitorEnvelope.correlation,
		monitor: executeMonitorEnvelope.summary?.data?.monitor,
		savedPath: executeMonitorEnvelope.saved?.path,
	});

	const waitCommand = { cmd: "wait.selector", tabId, selector: "#status[data-state='activated']", timeoutMs: 8_000 };
	const waitResult = await executeBrowserWaitWithSupervisor(bridge, waitCommand, { tabId, timeoutMs: 8_000 });
	const waitOperation = bridge.beginOperation({ toolName: "browser_wait", command: "wait.selector", tabId, browserSessionId: bridge.snapshot().browserSessionId, phase: "completed", progress: 100, sourceMode: "scan" });
	const waitEnvelope = JSON.parse((await distilledJsonResult(waitResult, {
		toolName: "browser_wait",
		command: "wait.selector",
		detailLevel: "summary",
		maxChars,
		ctx: { cwd: root },
		outputPath: waitArtifactPath,
		fallbackName: path.basename(waitArtifactPath),
		artifactValue: { ...waitResult, operation: waitOperation, snapshot: observeSnapshot },
		operation: waitOperation,
		snapshot: observeSnapshot,
	})).content[0].text);
	record("wait.correlation", typeof waitEnvelope.correlation?.operationId === "string"
		&& typeof waitEnvelope.correlation?.waitId === "string"
		&& Number.isInteger(waitEnvelope.target?.selectionVersionAtResolve), {
			correlation: waitEnvelope.correlation,
			target: waitEnvelope.target,
			savedPath: waitEnvelope.saved?.path,
		});

	const waitArtifactOperation = await readBrowserArtifact({ path: waitArtifactPath, mode: "json", jsonPath: "operation.operationId" }, { cwd: root });
	const waitArtifactSnapshotMeta = await readBrowserArtifact({ path: waitArtifactPath, mode: "json", jsonPath: "snapshot.snapshotId" }, { cwd: root });
	const waitArtifactSnapshot = await readBrowserArtifact({ path: waitArtifactPath, mode: "json", jsonPath: "data.waitId" }, { cwd: root });
	record("artifact.targetedRead", waitArtifactOperation.value === waitEnvelope.correlation?.operationId && waitArtifactSnapshotMeta.value === waitEnvelope.correlation?.snapshotId && waitArtifactSnapshot.value === waitEnvelope.correlation?.waitId, {
		operationJsonPath: "operation.operationId",
		snapshotJsonPath: "snapshot.snapshotId",
		waitJsonPath: "data.waitId",
		operationValue: waitArtifactOperation.value,
		snapshotValue: waitArtifactSnapshotMeta.value,
		waitValue: waitArtifactSnapshot.value,
		correlationSummary: waitArtifactOperation.summary?.correlation,
		correlationPaths: waitArtifactOperation.summary?.correlationPaths,
	});

	result.ok = steps.every((step) => step.ok !== false);
	if (!result.ok) process.exitCode = 1;
} catch (error) {
	record("error", false, { message: error instanceof Error ? error.message : String(error) });
	result.ok = false;
	process.exitCode = 1;
} finally {
	if (tabId && bridge) await bridge.closeTab(tabId, 2_000).catch(() => {});
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
