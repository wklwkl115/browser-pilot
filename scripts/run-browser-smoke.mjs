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
	const events = new Set();
	const eventWaiters = new Map();
	const navigationGates = new Map();
	const markEvent = (key) => {
		events.add(key);
		for (const resolve of eventWaiters.get(key) ?? []) resolve();
		eventWaiters.delete(key);
	};
	const waitForEvent = (key, timeoutMs = launchTimeoutMs) => {
		if (events.has(key)) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const waiters = eventWaiters.get(key) ?? [];
				eventWaiters.set(key, waiters.filter((candidate) => candidate !== onEvent));
				reject(new Error(`fixture event ${key} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			const onEvent = () => { clearTimeout(timer); resolve(); };
			eventWaiters.set(key, [...(eventWaiters.get(key) ?? []), onEvent]);
		});
	};
	const send = (res, body, contentType = "text/html; charset=utf-8") => {
		res.writeHead(200, { "content-type": contentType, "content-length": Buffer.byteLength(body), "cache-control": "public, max-age=60" });
		res.end(body);
	};
	const server = http.createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/api/navigation-gate") {
			const token = requestUrl.searchParams.get("token") || "";
			navigationGates.set(token, res);
			res.once("close", () => { if (navigationGates.get(token) === res) navigationGates.delete(token); });
			markEvent(`navigation-gate-ready:${token}`);
			return;
		}
		if (requestUrl.pathname === "/api/operation-armed") {
			markEvent(`operation-armed:${requestUrl.searchParams.get("token") || ""}`);
			send(res, JSON.stringify({ ok: true, armed: true }), "application/json");
			return;
		}
		if (requestUrl.pathname === "/api/prerender-ready") {
			markEvent(`prerender-ready:${requestUrl.searchParams.get("token") || ""}`);
			send(res, JSON.stringify({ ok: true, prerendering: true }), "application/json");
			return;
		}
		if (requestUrl.pathname.startsWith("/api/")) {
			send(res, JSON.stringify({ ok: true, path: req.url }), "application/json");
			return;
		}
		if (requestUrl.pathname === "/bfcache-a" || requestUrl.pathname === "/bfcache-b") {
			const marker = requestUrl.pathname.endsWith("a") ? "A" : "B";
			const token = requestUrl.searchParams.get("token") || "";
			const encodedToken = encodeURIComponent(token);
			const transitionScript = token && marker === "A"
				? `<script>globalThis.__browserPilotBFCacheRestored=false;fetch('/api/navigation-gate?token=${encodeURIComponent(`bfcache-to-b:${token}`)}').then(response=>{if(!response.ok)throw new Error('BFCache B gate failed');location.href='/bfcache-b?token=${encodedToken}'});addEventListener('pageshow',event=>{globalThis.__browserPilotBFCacheRestored=event.persisted;if(event.persisted)fetch('/api/navigation-gate?token=${encodeURIComponent(`bfcache-forward:${token}`)}').then(response=>{if(response.ok)history.forward()})})</script>`
				: token ? `<script>globalThis.__browserPilotBFCacheRestored=false;fetch('/api/navigation-gate?token=${encodeURIComponent(`bfcache-back:${token}`)}').then(response=>{if(response.ok)history.back()});addEventListener('pageshow',event=>{globalThis.__browserPilotBFCacheRestored=event.persisted})</script>` : "";
			send(res, `<!doctype html><html><head><title>BFCache ${marker}</title></head><body><main><h1 id="bfcache-marker">BFCache ${marker}</h1><p>This document is intentionally eligible for a real back-forward cache restore.</p></main>${transitionScript}</body></html>`);
			return;
		}
		if (requestUrl.pathname === "/operation-event-source") {
			const token = requestUrl.searchParams.get("token") || "missing";
			send(res, `<!doctype html><html><head><title>Operation Event Source</title></head><body><main><h1>Operation Event Source</h1></main><script>fetch('/api/navigation-gate?token=${encodeURIComponent(`operation-start:${token}`)}').then(response=>{if(!response.ok)throw new Error('navigation gate failed');location.href='/operation-complete?token=${encodeURIComponent(token)}'})</script></body></html>`);
			return;
		}
		if (requestUrl.pathname === "/operation-complete") {
			send(res, "<!doctype html><html><head><title>Operation Complete</title></head><body><main><h1>Operation Complete</h1></main></body></html>");
			return;
		}
		if (requestUrl.pathname === "/frontier") {
			const cards = Array.from({ length: 80 }, (_, index) => `<article class="frontier-card"><h2>Frontier item ${index + 1}</h2><p>Deterministic collection evidence ${index + 1} ${"x".repeat(160)}</p><button type="button" data-item="${index + 1}">Inspect item ${index + 1}</button></article>`).join("");
			send(res, `<!doctype html><html><head><title>Frontier Fixture</title></head><body><main><h1>Frontier Fixture</h1><section aria-label="Frontier collection">${cards}</section></main></body></html>`);
			return;
		}
		if (requestUrl.pathname === "/prerender-prehost") {
			const rawToken = requestUrl.searchParams.get("token") || "missing";
			const host = `/prerender-host?token=${encodeURIComponent(rawToken)}`;
			send(res, `<!doctype html><html><head><title>Prerender Prehost</title></head><body><main><h1>Prerender Prehost</h1></main><script>fetch('/api/navigation-gate?token=${encodeURIComponent(`prerender-enter:${rawToken}`)}').then(response=>{if(response.ok)location.href=${JSON.stringify(host)}})</script></body></html>`);
			return;
		}
		if (requestUrl.pathname === "/prerender-host") {
			const rawToken = requestUrl.searchParams.get("token") || "missing";
			const token = encodeURIComponent(rawToken);
			const target = `/prerender-target?token=${token}`;
			const rules = JSON.stringify({ prerender: [{ source: "list", urls: [target], eagerness: "immediate" }] });
			send(res, `<!doctype html><html><head><title>Prerender Host</title><script type="speculationrules">${rules}</script></head><body><main><h1>Prerender Host</h1><a id="activate-prerender" href="${target}">Activate prerender</a></main><script>fetch('/api/navigation-gate?token=${encodeURIComponent(`prerender-activate:${rawToken}`)}').then(response=>{if(response.ok)document.querySelector('#activate-prerender').click()})</script></body></html>`);
			return;
		}
		if (requestUrl.pathname === "/prerender-target") {
			const token = encodeURIComponent(requestUrl.searchParams.get("token") || "missing");
			send(res, `<!doctype html><html><head><title>Prerender Target</title><script>globalThis.__browserPilotWasPrerendered=document.prerendering===true;if(document.prerendering){fetch('/api/prerender-ready?token=${token}')}document.addEventListener('prerenderingchange',()=>{globalThis.__browserPilotWasPrerendered=true},{once:true})</script></head><body><main><h1 id="prerender-marker">Prerender Target</h1></main></body></html>`);
			return;
		}
		const body = "<!doctype html><html><head><title>Browser Pilot Smoke</title></head><body><main><h1 id=\"smoke-marker\">Browser Pilot Smoke</h1><button id=\"smoke-button\" type=\"button\">Run smoke</button></main><script>fetch('/api/boot').then(r=>r.json()).then(v=>globalThis.__smokeBoot=v)</script></body></html>";
		send(res, body);
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
		waitForEvent,
		releaseNavigationGate(token) {
			const response = navigationGates.get(token);
			if (!response) throw new Error(`navigation gate ${token} is not waiting`);
			navigationGates.delete(token);
			send(response, JSON.stringify({ ok: true, released: true }), "application/json");
		},
		close: () => {
			for (const [token, response] of navigationGates) {
				navigationGates.delete(token);
				response.destroy();
			}
			return new Promise((resolve) => server.close(() => resolve()));
		},
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

function tabForUrl(status, expectedUrl) {
	return Array.isArray(status?.tabs) ? status.tabs.find((tab) => String(tab?.url || "").startsWith(expectedUrl)) : undefined;
}

function assertCostVector(value, label) {
	if (!value || !Number.isInteger(value.chars) || value.chars < 0 || !Number.isInteger(value.bytes) || value.bytes < 0 || !Number.isInteger(value.estimatedTokens) || value.estimatedTokens < 0) {
		throw new Error(`${label} did not expose a valid CostVector: ${JSON.stringify(value)}`);
	}
}

function assertProviderBudgetTelemetry(observation) {
	const providers = observation?.providers;
	for (const provider of ["causal", "axe", "readability"]) {
		const item = providers?.[provider];
		if (item?.planned !== true || item.status === "skipped" || !Number.isInteger(item.reservedMs) || item.reservedMs < 500 || !Number.isInteger(item.actualMs) || item.actualMs < 0 || !Number.isInteger(item.bridgeRoundTrips) || item.bridgeRoundTrips < 0) {
			throw new Error(`${provider} provider telemetry was not executed under a bounded plan: ${JSON.stringify(item)}`);
		}
		assertCostVector(item.cost, `${provider} provider`);
	}
	if (Math.abs(providers.causal.reservedMs - (providers.axe.reservedMs * 2)) > 1 || providers.axe.reservedMs !== providers.readability.reservedMs) {
		throw new Error(`provider reserve weights were not causal:axe:readability=2:1:1: ${JSON.stringify(providers)}`);
	}
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
			"--enable-features=Prerender2",
			"--disable-features=PreloadingHoldback,Prerender2MemoryControls",
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
	const browserId = typeof tab?.browserId === "string" ? tab.browserId : "";
	if (!browserId) throw new Error(`fixture browser client was not identifiable: ${JSON.stringify(tab)}`);
	const selectedBrowser = await invoke(daemon, "browser_tabs", { action: "selectBrowser", browserId });
	if (!resultText(selectedBrowser).includes(browserId)) throw new Error(`fixture browser client was not selected: ${resultText(selectedBrowser)}`);

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
	const reloadReanchorReason = sameUrlReload.reanchorReason;
	if (reloadReanchorReason !== "document_changed") throw new Error(`same-URL reload did not re-anchor as document_changed: ${JSON.stringify({ reloadReanchorReason, snapshot: sameUrlReload.snapshot })}`);
	if (sameUrlReload.diff !== undefined || sameUrlReload.treeDiff !== undefined) throw new Error(`same-URL reload reused an old baseline delta: ${JSON.stringify({ diff: sameUrlReload.diff, treeDiff: sameUrlReload.treeDiff })}`);
	const hookSessionId = `browser-pilot-smoke-${process.pid}`;
	await invoke(daemon, "browser_hook", {
		action: "installTargets",
		tabId,
		sessionId: hookSessionId,
		params: { targets: ["console", "networkApi"], bufferSize: 50 },
	});
	await invoke(daemon, "browser_execute", {
		tabId,
		script: "(async()=>{console.info('browser-pilot-hook-smoke');await fetch('/api/hook-smoke');return true})()",
	});
	const hookEvents = await invoke(daemon, "browser_hook", {
		action: "collect",
		tabId,
		sessionId: hookSessionId,
		params: { eventTypes: ["console.", "network."], limit: 20 },
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
	if (deltaObservation.diff === undefined && deltaObservation.treeDiff === undefined) throw new Error(`same-document observation did not produce a delta: ${JSON.stringify(deltaObservation)}`);
	const baselineSnapshotId = deltaObservation.snapshot?.snapshotId;
	const baselinePageEpoch = deltaObservation.snapshot?.pageEpoch;
	if (typeof baselineSnapshotId !== "string" || typeof baselinePageEpoch !== "string") throw new Error(`delta observation did not expose page identity: ${JSON.stringify(deltaObservation.snapshot)}`);
	operationOutcome(await invoke(daemon, "browser_execute", { tabId, script: "document.querySelector('main')?.append(Object.assign(document.createElement('p'),{textContent:'provider telemetry mutation'}));true" }), "browser_execute provider telemetry mutation", "completed");
	const providerObservation = resultEnvelope(await invoke(daemon, "browser_observe", {
		tabId,
		baselineSnapshotId,
		axe: true,
		readability: true,
		timeoutMs: 12_000,
		maxChars: 64_000,
	}), "browser_observe provider telemetry");
	if (providerObservation.schema !== "browser-page-observation/v3") throw new Error(`provider observation did not use PageObservation v3: ${JSON.stringify(providerObservation)}`);
	assertProviderBudgetTelemetry(providerObservation);
	const beforeReloadStatus = await daemonJson(daemon, "/status?tabs=1");
	const beforeExtensionConnectedAt = Number(beforeReloadStatus.health?.connectedAt || 0);
	if (!Number.isFinite(beforeExtensionConnectedAt) || beforeExtensionConnectedAt <= 0) throw new Error(`extension reload baseline did not expose connectedAt: ${JSON.stringify(beforeReloadStatus.health)}`);
	await invoke(daemon, "browser_command", { command: { cmd: "management", method: "reload" } });
	const reconnected = await waitForStatus(daemon, (value) => value.extensionConnected === true
		&& Number(value.health?.connectedAt || 0) > beforeExtensionConnectedAt, "extension reload reconnect");
	const reanchored = resultEnvelope(await invoke(daemon, "browser_observe", { tabId, baselineSnapshotId }), "browser_observe after extension reconnect");
	if (reanchored.snapshot?.pageEpoch === baselinePageEpoch) throw new Error(`extension reconnect reused the old page epoch: ${JSON.stringify(reanchored.snapshot)}`);
	const reanchorReason = reanchored.reanchorReason;
	if (!["identity_unproven", "document_changed"].includes(reanchorReason)) throw new Error(`extension reconnect did not force a full re-anchor: ${JSON.stringify({ reanchorReason, snapshot: reanchored.snapshot })}`);
	if (reanchored.diff !== undefined || reanchored.treeDiff !== undefined) throw new Error(`extension reconnect reused an old baseline delta: ${JSON.stringify({ diff: reanchored.diff, treeDiff: reanchored.treeDiff })}`);

	const lineageToken = `${process.pid}-${Date.now()}`;
	const bfcacheAUrl = `${fixture.url}bfcache-a?token=${lineageToken}`;
	const bfcacheBUrl = `${fixture.url}bfcache-b?token=${lineageToken}`;
	const eventSourceUrl = `${fixture.url}operation-event-source?token=${lineageToken}`;
	const completionEventUrl = `${fixture.url}operation-complete?token=${lineageToken}`;
	const eventSourceTarget = operationOutcome(await invoke(daemon, "browser_tabs", { action: "create", url: eventSourceUrl, active: true }), "browser_tabs operation event source", "completed");
	const completionTabId = Number(eventSourceTarget.target?.tabId);
	if (!Number.isInteger(completionTabId) || completionTabId <= 0) throw new Error(`operation event source target was invalid: ${JSON.stringify(eventSourceTarget.target)}`);
	await fixture.waitForEvent(`navigation-gate-ready:operation-start:${lineageToken}`);
	const completionEventStartedAt = Date.now();
	const completionEventPromise = invoke(daemon, "browser_execute", {
		tabId: completionTabId,
		program: [
			{ eval: `fetch('/api/operation-armed?token=${encodeURIComponent(lineageToken)}').then(()=>true)` },
			{ key: "down", code: "ShiftLeft" },
			{ key: "up", code: "ShiftLeft" },
		],
	});
	await fixture.waitForEvent(`operation-armed:${lineageToken}`);
	fixture.releaseNavigationGate(`operation-start:${lineageToken}`);
	const completionEventOutcome = operationOutcome(await completionEventPromise, "browser_execute navigation completion event");
	const completionEventElapsedMs = Date.now() - completionEventStartedAt;
	const completionNavigationStatus = await waitForStatus(daemon, (value) => Boolean(tabForUrl(value, completionEventUrl)), "operation completion navigation");
	if (completionEventOutcome.status !== "completed") {
		throw new Error(`navigation reached the real tab but operation did not settle completed: ${JSON.stringify({ outcome: completionEventOutcome, tab: tabForUrl(completionNavigationStatus, completionEventUrl) })}`);
	}
	if (completionEventOutcome.completion?.source !== "navigation-completed" || completionEventElapsedMs >= 5_000) {
		throw new Error(`navigation completion event did not settle immediately through the operation waiter: ${JSON.stringify({ completionEventElapsedMs, completion: completionEventOutcome.completion })}`);
	}

	const bfcacheTarget = operationOutcome(await invoke(daemon, "browser_tabs", { action: "create", url: bfcacheAUrl, active: true }), "browser_tabs isolated BFCache target", "completed");
	const lineageTabId = Number(bfcacheTarget.target?.tabId);
	if (!Number.isInteger(lineageTabId) || lineageTabId <= 0 || lineageTabId === completionTabId) throw new Error(`isolated BFCache target was invalid: ${JSON.stringify(bfcacheTarget.target)}`);
	const bfcacheAStatus = await waitForStatus(daemon, (value) => Boolean(tabForUrl(value, bfcacheAUrl)), "isolated BFCache A load");
	const bfcacheATab = tabForUrl(bfcacheAStatus, bfcacheAUrl);
	const bfcacheAEpoch = bfcacheATab?.pageEpoch;
	const bfcacheADocumentId = bfcacheATab?.documentId;
	if (![bfcacheAEpoch, bfcacheADocumentId].every((value) => typeof value === "string" && value.length > 0)) throw new Error(`BFCache A identity was incomplete: ${JSON.stringify(bfcacheATab)}`);

	await fixture.waitForEvent(`navigation-gate-ready:bfcache-to-b:${lineageToken}`);
	fixture.releaseNavigationGate(`bfcache-to-b:${lineageToken}`);
	const bfcacheBNavigationStatus = await waitForStatus(daemon, (value) => Boolean(tabForUrl(value, bfcacheBUrl)), "BFCache B navigation");
	const bfcacheBTab = tabForUrl(bfcacheBNavigationStatus, bfcacheBUrl);
	const bfcacheBEpoch = bfcacheBTab?.pageEpoch;
	const bfcacheBDocumentId = bfcacheBTab?.documentId;
	if (typeof bfcacheBEpoch !== "string" || typeof bfcacheBDocumentId !== "string" || bfcacheBEpoch === bfcacheAEpoch || bfcacheBDocumentId === bfcacheADocumentId) {
		throw new Error(`BFCache B did not establish a distinct document lineage: ${JSON.stringify(bfcacheBTab)}`);
	}

	await fixture.waitForEvent(`navigation-gate-ready:bfcache-back:${lineageToken}`);
	fixture.releaseNavigationGate(`bfcache-back:${lineageToken}`);
	const restoredAStatus = await waitForStatus(daemon, (value) => Boolean(tabForUrl(value, bfcacheAUrl)), "real BFCache back restore");
	const restoredATab = tabForUrl(restoredAStatus, bfcacheAUrl);
	if (restoredATab?.pageEpoch !== bfcacheAEpoch || restoredATab?.documentId !== bfcacheADocumentId) {
		throw new Error(`real BFCache back did not reuse proven A lineage: ${JSON.stringify(restoredATab)}`);
	}

	await fixture.waitForEvent(`navigation-gate-ready:bfcache-forward:${lineageToken}`);
	fixture.releaseNavigationGate(`bfcache-forward:${lineageToken}`);
	const restoredBStatus = await waitForStatus(daemon, (value) => Boolean(tabForUrl(value, bfcacheBUrl)), "real BFCache forward restore");
	const restoredBTab = tabForUrl(restoredBStatus, bfcacheBUrl);
	if (restoredBTab?.pageEpoch !== bfcacheBEpoch || restoredBTab?.documentId !== bfcacheBDocumentId) {
		throw new Error(`real BFCache forward did not reuse proven B lineage: ${JSON.stringify(restoredBTab)}`);
	}
	const bfcacheProof = operationOutcome(await invoke(daemon, "browser_execute", { tabId: lineageTabId, script: "({persisted:globalThis.__browserPilotBFCacheRestored===true,navigationType:performance.getEntriesByType('navigation')[0]?.type})" }), "browser_execute BFCache proof", "completed");
	const bfcacheProofValue = bfcacheProof.completion?.evidence?.result;
	if (bfcacheProofValue?.persisted !== true) throw new Error(`real BFCache pageshow.persisted proof was missing: ${JSON.stringify(bfcacheProofValue)}`);
	const bfcacheObservation = resultEnvelope(await invoke(daemon, "browser_observe", { tabId: lineageTabId, fresh: true, maxNodes: 200 }), "browser_observe after BFCache lineage");
	if (bfcacheObservation.snapshot?.pageEpoch !== bfcacheBEpoch) throw new Error(`PageObservation did not consume the restored BFCache epoch: ${JSON.stringify(bfcacheObservation.snapshot)}`);

	const frontierUrl = `${fixture.url}frontier`;
	const frontierTarget = operationOutcome(await invoke(daemon, "browser_tabs", { action: "create", url: frontierUrl, active: true }), "browser_tabs frontier target", "completed");
	const frontierTabId = Number(frontierTarget.target?.tabId);
	if (!Number.isInteger(frontierTabId) || frontierTabId <= 0) throw new Error(`frontier target was invalid: ${JSON.stringify(frontierTarget.target)}`);
	const frontierOutputPath = path.join(profileDir, "frontier-observation.json");
	const frontierObservation = resultEnvelope(await invoke(daemon, "browser_observe", { tabId: frontierTabId, fresh: true, maxNodes: 1_000, maxChars: 20_000, timeoutMs: 20_000, outputPath: frontierOutputPath }), "browser_observe frontier artifact");
	const frontierItem = frontierObservation.frontier?.items?.find((item) => item?.read?.tool === "browser_artifact" && typeof item.read.jsonPath === "string");
	if (!frontierItem || typeof frontierObservation.saved?.path !== "string") throw new Error(`folded frontier did not expose a verified artifact read: ${JSON.stringify(frontierObservation.frontier)}`);
	const targetedFrontierRead = resultEnvelope(await invoke(daemon, "browser_artifact", {
		mode: "json",
		path: frontierObservation.saved.path,
		jsonPath: frontierItem.read.jsonPath,
		...(Number.isInteger(frontierItem.read.offset) ? { offset: frontierItem.read.offset } : {}),
		...(Number.isInteger(frontierItem.read.limit) ? { limit: frontierItem.read.limit } : {}),
	}), "browser_artifact targeted frontier read");
	if (targetedFrontierRead.summary?.exists !== true || targetedFrontierRead.jsonPath !== frontierItem.read.jsonPath) {
		throw new Error(`frontier targeted read did not resolve the verified JSON path: ${JSON.stringify(targetedFrontierRead)}`);
	}

	const prerenderToken = `${process.pid}-${Date.now()}`;
	const prerenderPrehostUrl = `${fixture.url}prerender-prehost?token=${prerenderToken}`;
	const prerenderHostUrl = `${fixture.url}prerender-host?token=${prerenderToken}`;
	const prerenderTargetUrl = `${fixture.url}prerender-target?token=${prerenderToken}`;
	operationOutcome(await invoke(daemon, "browser_tabs", { action: "create", url: prerenderPrehostUrl, active: true }), "browser_tabs prerender prehost", "completed");
	const prerenderPrehostStatus = await waitForStatus(daemon, (value) => Boolean(tabForUrl(value, prerenderPrehostUrl)), "prerender prehost navigation");
	const prerenderPrehostTab = tabForUrl(prerenderPrehostStatus, prerenderPrehostUrl);
	const prerenderPrehostTabId = Number(prerenderPrehostTab?.tabId ?? prerenderPrehostTab?.id);
	const prerenderPrehostObservation = resultEnvelope(await invoke(daemon, "browser_observe", { tabId: prerenderPrehostTabId, fresh: true, maxNodes: 200 }), "browser_observe prerender prehost");
	operationOutcome(await invoke(daemon, "browser_tabs", { action: "create", url: prerenderHostUrl, active: true }), "browser_tabs isolated prerender host", "completed");
	const prerenderHostStatus = await waitForStatus(daemon, (value) => Boolean(tabForUrl(value, prerenderHostUrl)), "prerender host navigation");
	const prerenderHostTab = tabForUrl(prerenderHostStatus, prerenderHostUrl);
	const prerenderHostTabId = Number(prerenderHostTab?.tabId ?? prerenderHostTab?.id);
	if (!Number.isInteger(prerenderHostTabId) || prerenderHostTabId <= 0 || prerenderHostTabId === prerenderPrehostTabId) throw new Error(`isolated prerender host did not receive a fresh tab identity: ${JSON.stringify({ prerenderPrehostTab, prerenderHostTab })}`);
	await fixture.waitForEvent(`navigation-gate-ready:prerender-activate:${prerenderToken}`);
	await fixture.waitForEvent(`prerender-ready:${prerenderToken}`);
	fixture.releaseNavigationGate(`prerender-activate:${prerenderToken}`);
	const prerenderActivatedStatus = await waitForStatus(daemon, (value) => {
		const activated = tabForUrl(value, prerenderTargetUrl);
		const activatedTabId = Number(activated?.tabId ?? activated?.id);
		const activatedGeneration = Number(activated?.targetGeneration ?? activated?.generation);
		const hostGeneration = Number(prerenderHostTab?.targetGeneration ?? prerenderHostTab?.generation);
		return Number(activated?.replacedFromTabId) === prerenderHostTabId && (activatedTabId !== prerenderHostTabId || activatedGeneration > hostGeneration);
	}, "prerender tabs.onReplaced activation");
	const prerenderTargetTab = tabForUrl(prerenderActivatedStatus, prerenderTargetUrl);
	const prerenderTargetTabId = Number(prerenderTargetTab?.tabId ?? prerenderTargetTab?.id);
	const prerenderTargetRef = prerenderTargetTab?.targetRef;
	if (!Number.isInteger(prerenderTargetTabId) || prerenderTargetTabId <= 0 || typeof prerenderTargetRef !== "string") throw new Error(`prerender activation did not replace the target generation: ${JSON.stringify(prerenderTargetTab)}`);
	const prerenderProof = operationOutcome(await invoke(daemon, "browser_execute", { tabId: prerenderTargetTabId, script: "({wasPrerendered:globalThis.__browserPilotWasPrerendered===true,prerendering:document.prerendering===true,activationStart:Number(performance.getEntriesByType('navigation')[0]?.activationStart||0),title:document.title})" }), "browser_execute prerender proof", "completed");
	const prerenderProofValue = prerenderProof.completion?.evidence?.result;
	if (prerenderProofValue?.wasPrerendered !== true || prerenderProofValue?.prerendering !== false || !(prerenderProofValue?.activationStart > 0)) {
		throw new Error(`target was not activated from a real prerender: ${JSON.stringify(prerenderProofValue)}`);
	}
	const prerenderObservation = resultEnvelope(await invoke(daemon, "browser_observe", { tabId: prerenderTargetTabId, baselineSnapshotId: prerenderPrehostObservation.snapshot?.snapshotId, maxNodes: 200 }), "browser_observe after tabs.onReplaced");
	if (prerenderObservation.reanchorReason !== "target_replaced" || prerenderObservation.snapshot?.tabId !== prerenderTargetTabId) {
		throw new Error(`tabs.onReplaced did not force target_replaced observation lineage: ${JSON.stringify(prerenderObservation)}`);
	}

	const finalCreated = operationOutcome(await invoke(daemon, "browser_tabs", { action: "create", url: `${fixture.url}final-target`, active: true }), "browser_tabs final target create", "completed");
	const finalTargetRef = finalCreated.target?.targetRef;
	const finalTabId = Number(finalCreated.target?.tabId);
	if (!finalTargetRef || !Number.isInteger(finalTabId) || finalTabId <= 0 || finalTabId === prerenderTargetTabId) throw new Error(`new final target was invalid: ${JSON.stringify(finalCreated.target)}`);
	operationOutcome(await invoke(daemon, "browser_tabs", { action: "close", targetRef: prerenderTargetRef }), "browser_tabs close replaced target", "completed");
	await waitForStatus(daemon, (value) => Array.isArray(value.tabs) && !value.tabs.some((item) => Number(item?.tabId ?? item?.id) === prerenderTargetTabId) && value.tabs.some((item) => Number(item?.tabId ?? item?.id) === finalTabId), "target close and new-target retention");
	const finalObservation = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef: finalTargetRef, fresh: true, maxNodes: 200 }), "browser_observe new target after close");
	if (finalObservation.schema !== "browser-page-observation/v3" || finalObservation.snapshot?.tabId !== finalTabId || typeof finalObservation.snapshot?.pageEpoch !== "string") {
		throw new Error(`new target was not independently observable after closing the prior target: ${JSON.stringify(finalObservation)}`);
	}
	console.log(JSON.stringify({
		ok: true,
		browser: browser.executable,
		bridgePort: daemon.bridgePort,
		tabId,
		checks: ["extension-handshake", "tabs", "execute-operation-v2", "no-effect-nonzero", "tab-create-switch-close", "observe-full-delta", "network-capture-reload", "same-url-reload-page-epoch", "spa-history-preserves-page-epoch", "hook-install-collect-uninstall", "provider-budget-telemetry", "extension-reconnect-page-epoch", "operation-completion-event-wakeup", "bfcache-back-forward-lineage", "frontier-artifact-targeted-read", "prerender-tabs-onReplaced", "target-close-new-target"],
		operationCompletionEventMs: completionEventElapsedMs,
		connectionMetrics: reconnected.health?.connectionMetrics,
	}, null, 2));
} finally {
	await stopBrowser(browser?.child);
	await daemon.close();
	await fixture.close();
	await rm(profileDir, { recursive: true, force: true });
}
