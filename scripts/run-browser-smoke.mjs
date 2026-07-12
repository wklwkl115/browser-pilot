import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "bridge", "browser_pilot_bridge");
const launchTimeoutMs = Math.max(5_000, Number(process.env.BROWSER_PILOT_SMOKE_LAUNCH_TIMEOUT_MS || 20_000));

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function existingBrowserCandidates() {
	const candidates = [process.env.BROWSER_PILOT_SMOKE_BROWSER];
	if (process.platform === "win32") {
		candidates.push(
			path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome for Testing", "Application", "chrome.exe"),
			path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		);
	} else if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		);
	} else {
		candidates.push("/usr/bin/google-chrome-for-testing", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge");
	}
	const found = [];
	for (const candidate of [...new Set(candidates.filter(Boolean))]) {
		try {
			await access(candidate);
			found.push(candidate);
		} catch {
			// Try the next conventional browser path.
		}
	}
	return found;
}

async function startFixtureServer() {
	const server = http.createServer((req, res) => {
		if (req.url?.startsWith("/api/")) {
			const body = JSON.stringify({ ok: true, path: req.url });
			res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			res.end(body);
			return;
		}
		const body = "<!doctype html><html><head><title>Browser Pilot Smoke</title></head><body><main><h1 id=\"smoke-marker\">Browser Pilot Smoke</h1><button id=\"smoke-button\" type=\"button\">Run smoke</button></main><script>fetch('/api/boot').then(r=>r.json()).then(v=>globalThis.__smokeBoot=v)</script></body></html>";
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
		res.end(body);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}/`,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

async function daemonJson(daemon, pathname, init = {}) {
	const response = await fetch(`http://${daemon.controlHost}:${daemon.controlPort}${pathname}`, {
		...init,
		headers: {
			"x-browser-pilot-daemon-token": daemon.token,
			...(init.body ? { "content-type": "application/json" } : {}),
			...init.headers,
		},
		signal: AbortSignal.timeout(10_000),
	});
	const value = await response.json();
	if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${JSON.stringify(value)}`);
	return value;
}

function resultText(result) {
	return Array.isArray(result?.content) ? result.content.map((item) => typeof item?.text === "string" ? item.text : "").join("\n") : "";
}

function operationOutcome(result, label, expectedStatus) {
	let value;
	try { value = JSON.parse(resultText(result)); } catch { throw new Error(`${label} did not return JSON: ${resultText(result)}`); }
	if (value?.schema !== "browser-operation/v2") throw new Error(`${label} did not return browser-operation/v2: ${JSON.stringify(value)}`);
	if (expectedStatus && value.status !== expectedStatus) throw new Error(`${label} returned ${String(value.status)}, expected ${expectedStatus}: ${JSON.stringify(value)}`);
	const completed = value.status === "completed";
	if (value.ok !== completed || value.completionVerified !== completed || value.classification !== (completed ? "success" : ["effect_observed", "ambiguous", "target_lost", "deadline"].includes(value.status) ? "inconclusive" : "failure")) {
		throw new Error(`${label} returned inconsistent browser-operation/v2 classification: ${JSON.stringify(value)}`);
	}
	return value;
}

function resultEnvelope(result, label) {
	try { return JSON.parse(resultText(result)); } catch { throw new Error(`${label} did not return JSON: ${resultText(result)}`); }
}

async function invoke(daemon, tool, params) {
	const result = await daemonJson(daemon, "/invoke", {
		method: "POST",
		body: JSON.stringify({ tool, params, cwd: root, cli: { command: tool } }),
	});
	if (result.ok !== true || result.terminate === true) throw new Error(`${tool} failed: ${resultText(result) || JSON.stringify(result)}`);
	return result;
}

async function waitForStatus(daemon, predicate, label) {
	const deadline = Date.now() + launchTimeoutMs;
	let last;
	do {
		last = await daemonJson(daemon, "/status?tabs=1");
		if (predicate(last)) return last;
		await delay(250);
	} while (Date.now() < deadline);
	throw new Error(`${label} timed out after ${launchTimeoutMs}ms; last status=${JSON.stringify(last)}`);
}

function captureProcessOutput(child) {
	let output = "";
	const append = (chunk) => { output = (output + String(chunk)).slice(-8_000); };
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);
	return () => output;
}

async function stopBrowser(child) {
	if (!child || child.exitCode !== null) return;
	child.kill();
	await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
	if (child.exitCode === null) child.kill("SIGKILL");
}

async function launchConnectedBrowser(daemon, fixtureUrl, profileDir) {
	const candidates = await existingBrowserCandidates();
	if (!candidates.length) throw new Error("no Chrome/Edge/Chromium executable found; set BROWSER_PILOT_SMOKE_BROWSER");
	const failures = [];
	for (const executable of candidates) {
		const child = spawn(executable, [
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			`--user-data-dir=${profileDir}`,
			`--disable-extensions-except=${extensionDir}`,
			`--load-extension=${extensionDir}`,
			"--window-size=1280,900",
			fixtureUrl,
		], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const output = captureProcessOutput(child);
		try {
			const status = await waitForStatus(daemon, (value) => value.extensionConnected === true && Array.isArray(value.tabs) && value.tabs.some((tab) => String(tab?.url || "").startsWith(fixtureUrl)), `extension handshake via ${executable}`);
			return { child, executable, status, output };
		} catch (error) {
			failures.push({ executable, error: error instanceof Error ? error.message : String(error), output: output() });
			await stopBrowser(child);
		}
	}
	throw new Error(`no browser completed the extension handshake: ${JSON.stringify(failures)}`);
}

await import("./build-bridge.mjs");
const { startDaemon } = await import("../src/apps/daemon/server.ts");
const profileDir = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-smoke-"));
const fixture = await startFixtureServer();
const daemon = await startDaemon({ writeLock: false, startBridgeEagerly: true });
let browser;
try {
	if (!daemon.bridgePort) throw new Error("daemon did not start the browser bridge");
	browser = await launchConnectedBrowser(daemon, fixture.url, profileDir);
	const tab = browser.status.tabs.find((item) => String(item?.url || "").startsWith(fixture.url));
	const tabId = Number(tab?.tabId ?? tab?.id);
	if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`fixture tab was not routable: ${JSON.stringify(tab)}`);

	const tabs = await invoke(daemon, "browser_tabs", { action: "list" });
	if (!resultText(tabs).includes("Browser Pilot Smoke")) throw new Error(`browser_tabs did not expose the fixture tab: ${resultText(tabs)}`);
	const executed = await invoke(daemon, "browser_execute", {
		tabId,
		script: "(async()=>{const api=await(await fetch('/api/execute')).json();return{title:document.title,marker:document.querySelector('#smoke-marker')?.textContent,api:api.ok}})()",
	});
	operationOutcome(executed, "browser_execute", "completed");
	if (!resultText(executed).includes("Browser Pilot Smoke")) throw new Error(`browser_execute did not return fixture evidence: ${resultText(executed)}`);
	const noEffect = await invoke(daemon, "browser_execute", { tabId, script: "void 0" });
	const noEffectOutcome = operationOutcome(noEffect, "browser_execute no-effect", "no_effect");
	if ((noEffectOutcome.ok ? 0 : 1) !== 1) throw new Error(`browser_execute no-effect did not map to a non-zero CLI outcome: ${JSON.stringify(noEffectOutcome)}`);
	const created = operationOutcome(await invoke(daemon, "browser_tabs", { action: "create", url: `${fixture.url}secondary`, active: true }), "browser_tabs create", "completed");
	const createdTabId = Number(created.target?.tabId);
	const originalTargetRef = tab?.targetRef || tab?.tabHandle || tabId;
	if (!Number.isInteger(createdTabId) || createdTabId <= 0 || !created.target?.targetRef) throw new Error(`created tab was not ready/routable: ${JSON.stringify(created)}`);
	operationOutcome(await invoke(daemon, "browser_tabs", { action: "switch", targetRef: originalTargetRef }), "browser_tabs switch", "completed");
	operationOutcome(await invoke(daemon, "browser_execute", { targetRef: originalTargetRef, script: "document.title" }), "browser_execute after switch", "completed");
	operationOutcome(await invoke(daemon, "browser_tabs", { action: "close", targetRef: created.target.targetRef }), "browser_tabs close", "completed");
	const observedResult = await invoke(daemon, "browser_observe", { tabId, maxNodes: 200 });
	const observed = resultEnvelope(observedResult, "browser_observe full");
	if (!resultText(observedResult).includes("Browser Pilot Smoke")) throw new Error(`browser_observe did not return fixture evidence: ${resultText(observedResult)}`);
	const reloadBaselineSnapshotId = observed.snapshot?.snapshotId;
	const reloadBaselinePageEpoch = observed.snapshot?.pageEpoch;
	if (typeof reloadBaselineSnapshotId !== "string" || typeof reloadBaselinePageEpoch !== "string") throw new Error(`browser_observe full did not expose page identity: ${JSON.stringify(observed.snapshot)}`);
	const network = await invoke(daemon, "browser_network", {
		action: "captureReload",
		tabId,
		params: { idleMs: 300, waitTimeoutMs: 10_000, limit: 20 },
	});
	if (!/networkCaptureReload|captureReload|api\/boot/.test(resultText(network))) throw new Error(`browser_network did not return capture evidence: ${resultText(network)}`);
	const sameUrlReload = resultEnvelope(await invoke(daemon, "browser_observe", { tabId, baselineSnapshotId: reloadBaselineSnapshotId, maxNodes: 200 }), "browser_observe after same-url reload");
	if (sameUrlReload.snapshot?.pageEpoch === reloadBaselinePageEpoch) throw new Error(`same-URL reload reused the old page epoch: ${JSON.stringify(sameUrlReload.snapshot)}`);
	const reloadReanchorReason = sameUrlReload.reanchorReason ?? sameUrlReload.summary?.reanchorReason ?? sameUrlReload.pageObservation?.reanchorReason;
	if (reloadReanchorReason !== "document_changed") throw new Error(`same-URL reload did not re-anchor as document_changed: ${JSON.stringify({ reloadReanchorReason, snapshot: sameUrlReload.snapshot })}`);
	if (sameUrlReload.diff !== undefined || sameUrlReload.treeDiff !== undefined) throw new Error(`same-URL reload reused an old baseline delta: ${JSON.stringify({ diff: sameUrlReload.diff, treeDiff: sameUrlReload.treeDiff })}`);
	const hookSessionId = `browser-pilot-smoke-${process.pid}`;
	await invoke(daemon, "browser_hook", {
		action: "installTargets",
		tabId,
		sessionId: hookSessionId,
		params: { targets: ["console", "networkApi"], buffer_size: 50 },
	});
	await invoke(daemon, "browser_execute", {
		tabId,
		script: "(async()=>{console.info('browser-pilot-hook-smoke');await fetch('/api/hook-smoke');return true})()",
	});
	const hookEvents = await invoke(daemon, "browser_hook", {
		action: "collect",
		tabId,
		sessionId: hookSessionId,
		params: { event_types: ["console.", "network."], limit: 20 },
	});
	if (!/console\.info/.test(resultText(hookEvents)) || !/network\.(request|response)/.test(resultText(hookEvents))) {
		throw new Error(`browser_hook did not collect console and network evidence: ${resultText(hookEvents)}`);
	}
	await invoke(daemon, "browser_hook", { action: "uninstall", tabId, sessionId: hookSessionId });

	const reconnectBaseline = resultEnvelope(await invoke(daemon, "browser_observe", { tabId, maxNodes: 200 }), "browser_observe reconnect baseline");
	const sameDocumentBaselineId = reconnectBaseline.snapshot?.snapshotId;
	const sameDocumentPageEpoch = reconnectBaseline.snapshot?.pageEpoch;
	if (typeof sameDocumentBaselineId !== "string" || typeof sameDocumentPageEpoch !== "string") throw new Error(`browser_observe did not expose page identity: ${JSON.stringify(reconnectBaseline.snapshot)}`);
	operationOutcome(await invoke(daemon, "browser_execute", { tabId, script: "history.pushState({browserPilotSmoke:true},'',`/spa?smoke=${Date.now()}`);document.body.dataset.browserPilotSmokeDelta=String(Date.now());true" }), "browser_execute same-document SPA mutation", "completed");
	await waitForStatus(daemon, (value) => Array.isArray(value.tabs) && value.tabs.some((item) => Number(item?.tabId ?? item?.id) === tabId && String(item?.url || "").includes("/spa?smoke=")), "SPA history tab sync");
	const deltaObservation = resultEnvelope(await invoke(daemon, "browser_observe", { tabId, baselineSnapshotId: sameDocumentBaselineId, maxNodes: 200 }), "browser_observe same-document delta");
	if (deltaObservation.snapshot?.pageEpoch !== sameDocumentPageEpoch) throw new Error(`same-document SPA mutation changed page epoch: ${JSON.stringify(deltaObservation.snapshot)}`);
	if (deltaObservation.diff === undefined && deltaObservation.treeDiff === undefined && deltaObservation.summary?.diff === undefined && deltaObservation.summary?.pageObservation?.diff === undefined) throw new Error(`same-document observation did not produce a delta: ${JSON.stringify(deltaObservation.summary)}`);
	const baselineSnapshotId = deltaObservation.snapshot?.snapshotId;
	const baselinePageEpoch = deltaObservation.snapshot?.pageEpoch;
	if (typeof baselineSnapshotId !== "string" || typeof baselinePageEpoch !== "string") throw new Error(`delta observation did not expose page identity: ${JSON.stringify(deltaObservation.snapshot)}`);
	const beforeMetrics = browser.status.health?.connectionMetrics || {};
	await invoke(daemon, "browser_command", { command: { cmd: "management", method: "reload" } });
	const reconnected = await waitForStatus(daemon, (value) => value.extensionConnected === true && Number(value.health?.connectionMetrics?.connects || 0) > Number(beforeMetrics.connects || 0), "extension reload reconnect");
	const reanchored = resultEnvelope(await invoke(daemon, "browser_observe", { tabId, baselineSnapshotId }), "browser_observe after extension reconnect");
	if (reanchored.snapshot?.pageEpoch === baselinePageEpoch) throw new Error(`extension reconnect reused the old page epoch: ${JSON.stringify(reanchored.snapshot)}`);
	const reanchorReason = reanchored.reanchorReason ?? reanchored.summary?.reanchorReason ?? reanchored.pageObservation?.reanchorReason;
	if (!["identity_unproven", "document_changed"].includes(reanchorReason)) throw new Error(`extension reconnect did not force a full re-anchor: ${JSON.stringify({ reanchorReason, snapshot: reanchored.snapshot })}`);
	if (reanchored.diff !== undefined || reanchored.treeDiff !== undefined) throw new Error(`extension reconnect reused an old baseline delta: ${JSON.stringify({ diff: reanchored.diff, treeDiff: reanchored.treeDiff })}`);
	console.log(JSON.stringify({
		ok: true,
		browser: browser.executable,
		bridgePort: daemon.bridgePort,
		tabId,
		checks: ["extension-handshake", "tabs", "execute-operation-v2", "no-effect-nonzero", "tab-create-switch-close", "observe-full-delta", "network-capture-reload", "same-url-reload-page-epoch", "spa-history-preserves-page-epoch", "hook-install-collect-uninstall", "extension-reconnect-page-epoch"],
		connectionMetrics: reconnected.health?.connectionMetrics,
	}, null, 2));
} finally {
	await stopBrowser(browser?.child);
	await daemon.close();
	await fixture.close();
	await rm(profileDir, { recursive: true, force: true });
}
