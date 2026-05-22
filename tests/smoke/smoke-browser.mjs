import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildContentScript } from "../../src/content/buildContentScript.ts";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { BrowserOrchestrationCoordinator, PersistentOrchestrationStore, preNavigationHookRegistryHash } from "../../src/driver/orchestration/index.ts";
import { buildPickScript } from "../../src/pick/buildPickScript.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { diagnoseBridgePortInUse } from "./smokePortDiagnostics.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const smokePort = Number(process.env.PI_BROWSER_SMOKE_PORT || 8765);
const smokeResultPath = path.resolve(process.env.PI_BROWSER_SMOKE_BROWSER_RESULT_PATH || path.join(outDir, "smoke-browser-results.json"));
const transferSmoke = process.env.PI_BROWSER_SMOKE_TRANSFER === "1" || process.argv.includes("--transfer");
const minimalSmoke = process.env.PI_BROWSER_SMOKE_MINIMAL === "1" || process.argv.includes("--minimal");
const extensionTimeoutMs = Number(process.env.PI_BROWSER_SMOKE_EXTENSION_TIMEOUT_MS || 15_000);
const bridge = new BrowserBridgeServer({ profileExtensionSource: process.env.PI_BROWSER_SMOKE_EXTENSION_DIR ? path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR) : undefined });
const results = [];

function record(step, ok, data = {}) { results.push({ step, ok, ...data, t: Date.now() }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function sha256(value) { return createHash("sha256").update(String(value)).digest("hex"); }
async function waitUntil(predicate, label, timeoutMs = 8_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() <= deadline) {
		last = await predicate();
		if (last) return last;
		await delay(200);
	}
	throw new Error(`${label} was not reached; last=${JSON.stringify(last)}`);
}
async function commandResultOrError(command, options) {
	try {
		return await bridge.sendCommand(command, options);
	} catch (error) {
		return { data: error?.details?.result || { ok: false, error_code: error?.details?.result?.error_code || error?.code, error: errorMessage(error) } };
	}
}
async function buildRuntimeMetadata() {
	const manifestPath = path.join(root, "bridge", "pi_browser_bridge", "dist", "build-manifest.json");
	const serviceWorkerPath = path.join(root, "bridge", "pi_browser_bridge", "dist", "service-worker.js");
	const [manifestText, serviceWorker] = await Promise.all([readFile(manifestPath, "utf8"), readFile(serviceWorkerPath)]);
	const manifest = JSON.parse(manifestText);
	return {
		runtimeSwitched: manifest.runtimeSwitched,
		manifestTarget: manifest.manifestTarget,
		entries: Array.isArray(manifest.entries) ? manifest.entries.map((entry) => entry.name) : [],
		serviceWorkerSha256: createHash("sha256").update(serviceWorker).digest("hex"),
	};
}
function isBridgePortStartFailure(error) {
	const details = error && typeof error === "object" && error.details && typeof error.details === "object" ? error.details : {};
	return error && typeof error === "object"
		&& error.code === "BRIDGE_START_FAILED"
		&& Number(details.port) === Number(bridge.port)
		&& /EADDRINUSE|address already in use|listen/i.test(errorMessage(error));
}

function startFixture() {
	const server = createServer((req, res) => {
		if (req.url?.startsWith("/api/data")) {
			const body = JSON.stringify({ ok: true, items: [1, 2, 3], path: req.url });
			res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			res.end(body);
			return;
		}
		const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${smokePort}`);
		const authState = requestUrl.searchParams.get("auth") === "signed-in" ? "signed-in" : "guest";
		const authHeading = authState === "signed-in" ? "Welcome back" : "Please sign in";
		const body = `<!doctype html><html><head><script>(()=>{const params=new URLSearchParams(location.search);const authState=params.get("auth")==="signed-in"?"signed-in":"guest";const storageKey=params.get("storageKey")||"";const storageValue=params.get("storageValue")||"signed-in";window.__PI_BROWSER_PAGE_SCRIPT_PRE_NAV_PRESENT__=Array.isArray(window.__PI_BROWSER_PRE_NAVIGATION_HOOKS__)&&window.__PI_BROWSER_PRE_NAVIGATION_HOOKS__.some(item=>item&&item.hookId==='pi.preNavigationMarker'&&item.readyState==='loading');window.__PI_BROWSER_PAGE_SCRIPT_READY_STATE__=document.readyState;document.documentElement.setAttribute("data-auth-state",authState);document.documentElement.setAttribute("data-pre-nav",window.__PI_BROWSER_PAGE_SCRIPT_PRE_NAV_PRESENT__===true?"loading":"missing");if(storageKey){if(authState==="signed-in")window.localStorage.setItem(storageKey,storageValue);else window.localStorage.removeItem(storageKey);window.sessionStorage.removeItem(storageKey);}})();</script><title>Pi Browser Smoke</title></head><body><main><h1>Smoke Page</h1><p>Readable smoke article body.</p><div id='auth-status' data-auth-state='${authState}'>${authHeading}</div><div id='empty'></div><form onsubmit='event.preventDefault();document.querySelector("#result").textContent="submitted"'><label>Query <input name='q' value='pi'></label><button id='go' type='button' onclick='document.querySelector("#result").textContent=document.querySelector("input[name=q]").value'>Go</button><input id='upload' type='file' onchange='document.querySelector("#result").textContent=this.files[0]?.name||"no-file"'></form><div id='comment' role='textbox' contenteditable='true' style='border:1px solid #999;padding:4px' oninput='document.querySelector("#send").disabled=!this.textContent.trim()'></div><button id='send' type='button' disabled onclick='document.querySelector("#comment-result").textContent=document.querySelector("#comment").textContent'>Send</button><div id='comment-result'></div><button id='download' type='button' onclick='const blob=new Blob(["pi smoke download"],{type:"text/plain"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="pi-browser-smoke-download.txt";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000)'>Download</button><div id='result' role='status'>idle</div><a href='/api/data'>Data</a></main></body></html>`;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
		res.end(body);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(smokePort, "127.0.0.1", () => resolve(server));
	});
}

async function waitForExtension(timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const snapshot = bridge.snapshot();
		if (snapshot.extensionConnected) return snapshot;
		await delay(250);
	}
	throw new Error(`Browser extension did not connect to bridge port ${bridge.port}; close other bridge servers or reload extension`);
}

async function cdpSend(tabId, cdpMethod, params) {
	return await bridge.sendCommand({ cmd: "persistent_cdp", action: "send", tabId, cdpMethod, params, timeoutMs: 8_000, persistent: false }, { tabId, timeoutMs: 10_000 });
}

async function cdpKey(tabId, type, key, code, windowsVirtualKeyCode, modifiers = 0, extra = {}) {
	return await cdpSend(tabId, "Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers, ...extra });
}

function compactOperationResults(result) {
	return (Array.isArray(result?.operationResults) ? result.operationResults : []).map((item) => ({
		phase: item.phase,
		action: item.action,
		status: item.status,
		tabId: item.resourceRef?.tabId,
		browserId: item.resourceRef?.browserId,
		windowId: item.resourceRef?.windowId ?? item.result?.windowId,
		groupId: item.resourceRef?.groupId ?? item.result?.groupId,
		tabGroupsStatus: item.result?.tabGroupsStatus,
		sessionTag: item.resourceRef?.sessionTag,
		tabRole: item.resourceRef?.tabRole,
		cookieName: item.resourceRef?.cookieName,
		sessionId: item.resourceRef?.sessionId,
		hookId: item.resourceRef?.hookId,
		hookVersion: item.resourceRef?.hookVersion,
		hookHash: item.resourceRef?.hookHash,
		hookIdentifier: item.resourceRef?.hookIdentifier ?? item.result?.identifier,
		failure: item.failure ? { code: item.failure.code, retryable: item.failure.retryable } : undefined,
	}));
}

function compactBindings(result) {
	return (Array.isArray(result?.bindings) ? result.bindings : []).map((binding) => ({
		sessionTag: binding.sessionTag,
		tabRole: binding.tabRole,
		browserId: binding.browserId,
		tabId: binding.tabId,
		windowId: binding.windowId,
		windowOwned: binding.windowOwned,
		windowCloseOnDelete: binding.windowCloseOnDelete,
		groupId: binding.groupId,
		profileId: binding.profileId,
		tabGroupsStatus: binding.tabGroupsStatus,
		owned: binding.owned,
		preNavigationHooks: Array.isArray(binding.preNavigationHooks) ? binding.preNavigationHooks.map((hook) => ({ hookId: hook.hookId, version: hook.version, hash: hook.hash, identifier: hook.identifier, effectVerifiedAt: hook.effectVerifiedAt })) : [],
	}));
}

function compactProfiles(profiles) {
	return (Array.isArray(profiles) ? profiles : []).map((profile) => ({
		profileId: profile.profileId,
		bridgePort: profile.bridgePort,
		debugPort: profile.debugPort,
		browserId: profile.browserId,
		processId: profile.processId,
		owned: profile.owned,
		cleanup: profile.cleanup,
		profileDir: profile.profileDir,
		extensionDir: profile.extensionDir,
	}));
}

function compactFailures(result) {
	return (Array.isArray(result?.failures) ? result.failures : []).map((failure) => ({
		code: failure.code,
		message: failure.message,
		retryable: failure.retryable,
		assertionId: failure.assertionId,
		kind: failure.kind,
		tabRole: failure.tabRole,
	}));
}

function compactSessionAssertions(state) {
	if (!state || typeof state !== "object") return undefined;
	return {
		mode: state.mode,
		passed: state.passed,
		total: state.total,
		passedCount: state.passedCount,
		failedCount: state.failedCount,
		probeFailedCount: state.probeFailedCount,
		checks: (Array.isArray(state.checks) ? state.checks : []).map((check) => ({
			id: check.id,
			kind: check.kind,
			tabRole: check.tabRole,
			status: check.status,
			passed: check.passed,
			message: check.message,
			details: check.details,
		})),
	};
}

function sessionAssertionsFromResult(result, sessionTag) {
	const session = (Array.isArray(result?.actual?.sessions) ? result.actual.sessions : []).find((item) => item?.tag === sessionTag);
	return compactSessionAssertions(session?.sessionAssertions);
}

async function runPreNavigationHookSmoke() {
	const coordinator = bridge.orchestrator();
	const origin = `http://127.0.0.1:${smokePort}`;
	const orchestrationId = `smoke-pre-nav-${Date.now()}`;
	const artifactPath = path.join(outDir, "smoke-pre-navigation-hook-result.json");
	const desired = {
		apiVersion: "pi.browser/v1",
		orchestrationId,
		allowedOrigins: [origin],
		defaults: { timeoutMs: 15_000, navigationTimeoutMs: 10_000 },
		preNavigationHooks: [{ hookId: "pi.preNavigationMarker", version: "1", hash: preNavigationHookRegistryHash(), required: true }],
		sessions: [{ tag: "pre-nav", tabs: [{ role: "main", url: `${origin}/pre-navigation?run=${encodeURIComponent(orchestrationId)}`, waitUntil: "complete" }] }],
	};
	const envelope = { orchestrationId, artifactPath };
	try {
		envelope.plan = await coordinator.plan(desired, { timeoutMs: 15_000 });
		const actions = envelope.plan.plan.operations.map((item) => item.action);
		record("browser_orchestrate.preNavPlan", envelope.plan.ok === true && actions.includes("installPreNavigationHook") && actions.includes("navigate") && actions.indexOf("navigate") > actions.indexOf("installPreNavigationHook"), { orchestrationId, operationCount: envelope.plan.plan.operations.length, actions });

		envelope.apply = await coordinator.apply(desired, { timeoutMs: 25_000 });
		const bindings = compactBindings(envelope.apply);
		record("browser_orchestrate.preNavApply", envelope.apply.ok === true && bindings.length === 1 && bindings[0].preNavigationHooks.length === 1 && envelope.apply.operationResults.some((item) => item.action === "installPreNavigationHook" && item.status === "succeeded"), { orchestrationId, bindings, operationResults: compactOperationResults(envelope.apply) });

		const effect = await bridge.executeJavaScript("return {hooks: globalThis.__PI_BROWSER_PRE_NAVIGATION_HOOKS__ || [], pageScriptSaw: globalThis.__PI_BROWSER_PAGE_SCRIPT_PRE_NAV_PRESENT__ === true, pageScriptReadyState: globalThis.__PI_BROWSER_PAGE_SCRIPT_READY_STATE__};", { target: { orchestrationId, sessionTag: "pre-nav", tabRole: "main" }, timeoutMs: 10_000 });
		record("browser_orchestrate.preNavEffect", effect.data?.pageScriptSaw === true && Array.isArray(effect.data?.hooks) && effect.data.hooks.some((hook) => hook.hookId === "pi.preNavigationMarker" && hook.readyState === "loading") && effect.target?.source === "orchestration", { orchestrationId, effect: effect.data, targetSource: effect.target?.source });
	} finally {
		envelope.stop = await coordinator.stop(orchestrationId, { timeoutMs: 12_000 }).catch((error) => ({ ok: false, action: "stop", orchestrationId, failures: [{ code: error?.code || "STOP_FAILED", message: errorMessage(error) }] }));
		record("browser_orchestrate.preNavStop", envelope.stop.ok === true && envelope.stop.operationResults?.some((item) => item.action === "uninstallPreNavigationHook" && item.status === "succeeded"), { orchestrationId, operationResults: compactOperationResults(envelope.stop) });
		envelope.delete = await coordinator.delete(orchestrationId, { timeoutMs: 15_000 }).catch((error) => ({ ok: false, action: "delete", orchestrationId, failures: [{ code: error?.code || "DELETE_FAILED", message: errorMessage(error) }] }));
		record("browser_orchestrate.preNavDelete", envelope.delete.ok === true && envelope.delete.operationResults?.some((item) => item.action === "closeTab" && item.status === "succeeded"), { orchestrationId, operationResults: compactOperationResults(envelope.delete) });
		await writeFile(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
		record("browser_orchestrate.preNavArtifact", true, { orchestrationId, path: artifactPath, bindings: compactBindings(envelope.apply), operationResults: compactOperationResults(envelope.apply) });
	}
}

async function runWindowTabGroupsSmoke() {
	const coordinator = bridge.orchestrator();
	const origin = `http://127.0.0.1:${smokePort}`;
	const orchestrationId = `smoke-window-${Date.now()}`;
	const artifactPath = path.join(outDir, "smoke-window-tabgroups-result.json");
	const desired = {
		apiVersion: "pi.browser/v1",
		orchestrationId,
		allowedOrigins: [origin],
		defaults: { timeoutMs: 15_000, navigationTimeoutMs: 10_000 },
		sessions: [{
			tag: "owned-window",
			ownedWindow: { focused: true, state: "normal", closeOnDelete: true },
			visualGrouping: { title: "Pi Smoke", color: "blue", collapsed: false },
			tabs: [
				{ role: "main", url: `${origin}/window-main?run=${encodeURIComponent(orchestrationId)}`, waitUntil: "complete" },
				{ role: "side", url: `${origin}/window-side?run=${encodeURIComponent(orchestrationId)}`, waitUntil: "complete", active: false },
			],
		}],
	};
	const envelope = { orchestrationId, artifactPath };
	try {
		envelope.plan = await coordinator.plan(desired, { timeoutMs: 15_000 });
		const planActions = envelope.plan.plan.operations.map((item) => item.action);
		record("browser_orchestrate.windowPlan", envelope.plan.ok === true && planActions.includes("createWindow") && planActions.includes("groupTabs"), { orchestrationId, operationCount: envelope.plan.plan.operations.length, actions: planActions });

		envelope.apply = await coordinator.apply(desired, { timeoutMs: 25_000 });
		const bindings = compactBindings(envelope.apply);
		const windowIds = new Set(bindings.map((binding) => binding.windowId).filter(Boolean));
		const tabGroupsStatuses = bindings.map((binding) => binding.tabGroupsStatus).filter(Boolean);
		const groupIds = bindings.map((binding) => binding.groupId).filter(Boolean);
		const groupResult = envelope.apply.operationResults.find((item) => item.action === "groupTabs");
		const visualGroupingOk = groupResult?.status === "succeeded" ? groupIds.length === bindings.length && tabGroupsStatuses.every((status) => status === "available") : groupResult?.status === "degraded" && tabGroupsStatuses.every((status) => String(status).startsWith("degraded_"));
		record("browser_orchestrate.windowApply", envelope.apply.ok === true && bindings.length === 2 && windowIds.size === 1 && bindings.every((binding) => binding.windowOwned === true && binding.windowCloseOnDelete !== false) && visualGroupingOk, { orchestrationId, bindings, operationResults: compactOperationResults(envelope.apply), tabGroupsStatus: groupResult?.result?.tabGroupsStatus, groupStatus: groupResult?.status });

		envelope.status = await coordinator.status(orchestrationId, { timeoutMs: 15_000 });
		record("browser_orchestrate.windowStatus", envelope.status.ok === true && envelope.status.converged === true && Boolean(envelope.status.actual?.tabGroups?.tabGroupsStatus), { orchestrationId, operationCount: envelope.status.plan?.operationCount, tabGroupsStatus: envelope.status.actual?.tabGroups?.tabGroupsStatus, windowCount: envelope.status.actual?.windows?.length });
	} finally {
		await coordinator.stop(orchestrationId);
		envelope.delete = await coordinator.delete(orchestrationId, { timeoutMs: 15_000 }).catch((error) => ({ ok: false, action: "delete", orchestrationId, failures: [{ code: error?.code || "DELETE_FAILED", message: errorMessage(error) }] }));
		record("browser_orchestrate.windowDelete", envelope.delete.ok === true && envelope.delete.operationResults?.some((item) => item.action === "closeWindow" && item.status === "succeeded"), { orchestrationId, operationResults: compactOperationResults(envelope.delete) });
		await writeFile(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
		record("browser_orchestrate.windowArtifact", true, { orchestrationId, path: artifactPath, bindings: compactBindings(envelope.apply), operationResults: compactOperationResults(envelope.apply) });
	}
}

async function runOrchestrationSmoke() {
	const coordinator = bridge.orchestrator();
	const origin = `http://127.0.0.1:${smokePort}`;
	const orchestrationId = `smoke-orch-${Date.now()}`;
	const desiredUrl = `${origin}/orchestrate?run=${encodeURIComponent(orchestrationId)}`;
	const driftUrl = `${origin}/orchestrate-drift?run=${encodeURIComponent(orchestrationId)}`;
	const networkSessionId = `${orchestrationId}-network`;
	const hookSessionId = `${orchestrationId}-hook`;
	const cookieName = `pi_orch_${Date.now()}`;
	const removeCookieName = `${cookieName}_remove`;
	const cookieSecret = "orchestration-smoke-secret";
	const removeSecret = "orchestration-remove-secret";
	const artifactPath = path.join(outDir, "smoke-orchestration-result.json");
	const desired = {
		apiVersion: "pi.browser/v1",
		orchestrationId,
		allowedOrigins: [origin],
		defaults: { timeoutMs: 15_000, navigationTimeoutMs: 10_000 },
		sessions: [{
			tag: "runtime",
			tabs: [{ role: "main", url: desiredUrl, waitUntil: "complete", recreateOnMissing: true }],
			cookies: [{ name: cookieName, value: cookieSecret, path: "/" }, { name: removeCookieName, remove: true, path: "/" }],
			networkRecorder: { sessionId: networkSessionId, captureBodies: true, maxEntries: 30 },
			hookDispatcher: { sessionId: hookSessionId, installFingerprint: `${orchestrationId}-hook-fp`, bufferSize: 50 },
		}],
	};
	const fullEnvelope = { orchestrationId, artifactPath };
	try {
		await bridge.sendCommand({ cmd: "cookies", method: "set", url: desiredUrl, name: removeCookieName, value: removeSecret, path: "/" }, { timeoutMs: 8_000 });
		fullEnvelope.plan = await coordinator.plan(desired, { timeoutMs: 15_000 });
		const planActions = fullEnvelope.plan.plan.operations.map((item) => item.action);
		record("browser_orchestrate.plan", fullEnvelope.plan.ok === true && ["createTab", "setCookie", "removeCookie", "startNetwork", "installHook"].every((action) => planActions.includes(action)), { orchestrationId, operationCount: fullEnvelope.plan.plan.operations.length, actions: planActions });

		fullEnvelope.apply = await coordinator.apply(desired, { timeoutMs: 20_000 });
		const binding = fullEnvelope.apply.bindings[0];
		const orchestrationTabId = binding?.tabId;
		const orchestrationTarget = { orchestrationId, sessionTag: "runtime", tabRole: "main" };
		record("browser_orchestrate.apply", fullEnvelope.apply.ok === true && Boolean(orchestrationTabId) && fullEnvelope.apply.operationResults.some((item) => item.action === "removeCookie" && item.status === "succeeded"), { orchestrationId, tabId: orchestrationTabId, bindings: compactBindings(fullEnvelope.apply), operationResults: compactOperationResults(fullEnvelope.apply) });
		if (!orchestrationTabId) throw new Error("browser_orchestrate apply did not create an owned tab binding");

		fullEnvelope.status = await coordinator.status(orchestrationId, { timeoutMs: 12_000 });
		record("browser_orchestrate.status", fullEnvelope.status.ok === true && fullEnvelope.status.converged === true && fullEnvelope.status.plan?.operationCount === 0, { orchestrationId, operationCount: fullEnvelope.status.plan?.operationCount });

		const setCookie = await bridge.sendCommand({ cmd: "cookies", method: "get", url: desiredUrl, name: cookieName }, { timeoutMs: 8_000 });
		const removedCookie = await bridge.sendCommand({ cmd: "cookies", method: "get", url: desiredUrl, name: removeCookieName }, { timeoutMs: 8_000 });
		record("browser_orchestrate.cookies", setCookie.data?.name === cookieName && setCookie.data?.value === cookieSecret && !removedCookie.data?.name, { orchestrationId, setName: setCookie.data?.name, removedPresent: Boolean(removedCookie.data?.name) });

		const logicalExecute = await bridge.executeJavaScript("return await fetch('/api/data?smoke=orchestrate-apply').then(r => r.json())", { target: orchestrationTarget, timeoutMs: 10_000 });
		const networkWait = await commandResultOrError({ cmd: "network.wait", sessionId: networkSessionId, condition: "response", urlContains: "/api/data", timeoutMs: 5_000 }, { target: orchestrationTarget, timeoutMs: 8_000 });
		record("browser_orchestrate.networkRecorder", networkWait.data?.request?.status === 200 && logicalExecute.target?.source === "orchestration", { orchestrationId, requestId: networkWait.data?.request?.requestId, targetSource: logicalExecute.target?.source });

		const hookStatus = await commandResultOrError({ cmd: "hook.status", sessionId: hookSessionId, timeoutMs: 5_000 }, { target: orchestrationTarget, timeoutMs: 8_000 });
		record("browser_orchestrate.hookDispatcher", String(hookStatus.data?.state || "").toUpperCase() === "INSTALLED" && hookStatus.data?.session_id === hookSessionId && hookStatus.target?.source === "orchestration", { orchestrationId, state: hookStatus.data?.state, sessionId: hookStatus.data?.session_id, targetSource: hookStatus.target?.source });

		fullEnvelope.watch = await coordinator.watch(desired, { intervalMs: 1_000, ttlMs: 6_000, maxAttempts: 3, timeoutMs: 15_000 });
		record("browser_orchestrate.watch", fullEnvelope.watch.ok === true && fullEnvelope.watch.watch.active === true, { orchestrationId, watch: fullEnvelope.watch.watch });

		await bridge.sendCommand({ cmd: "network.stop", sessionId: networkSessionId, keepBuffer: false }, { target: orchestrationTarget, timeoutMs: 8_000 }).catch(() => {});
		await bridge.sendCommand({ cmd: "hook.uninstall", sessionId: hookSessionId }, { target: orchestrationTarget, timeoutMs: 8_000 }).catch(() => {});
		await bridge.sendCommand({ cmd: "cookies", method: "remove", url: desiredUrl, name: cookieName }, { timeoutMs: 8_000 }).catch(() => {});
		await bridge.sendCommand({ cmd: "wait.navigate", url: driftUrl, timeoutMs: 5_000 }, { target: orchestrationTarget, timeoutMs: 8_000 });

		fullEnvelope.selfHealStatus = await waitUntil(async () => {
			const status = await coordinator.status(orchestrationId, { timeoutMs: 12_000 });
			return status.ok === true && status.converged === true && (status.state?.watch?.recoveries || 0) > (fullEnvelope.watch.watch.recoveries || 0) ? status : false;
		}, "browser_orchestrate watch self-heal", 9_000);
		const healedCookie = await bridge.sendCommand({ cmd: "cookies", method: "get", url: desiredUrl, name: cookieName }, { timeoutMs: 8_000 });
		const healedHook = await commandResultOrError({ cmd: "hook.status", sessionId: hookSessionId, timeoutMs: 5_000 }, { target: orchestrationTarget, timeoutMs: 8_000 });
		await bridge.executeJavaScript("return await fetch('/api/data?smoke=orchestrate-healed').then(r => r.json())", { target: orchestrationTarget, timeoutMs: 10_000 });
		const healedNetwork = await commandResultOrError({ cmd: "network.wait", sessionId: networkSessionId, condition: "response", urlContains: "orchestrate-healed", timeoutMs: 5_000 }, { target: orchestrationTarget, timeoutMs: 8_000 });
		const healedLocation = await bridge.executeJavaScript("return location.href", { target: orchestrationTarget, timeoutMs: 8_000 });
		record("browser_orchestrate.selfHeal", fullEnvelope.selfHealStatus.ok === true && healedCookie.data?.name === cookieName && String(healedHook.data?.state || "").toUpperCase() === "INSTALLED" && healedNetwork.data?.request?.status === 200 && healedLocation.data === desiredUrl && healedLocation.target?.source === "orchestration", { orchestrationId, recoveries: fullEnvelope.selfHealStatus.state?.watch?.recoveries, url: healedLocation.data, hookState: healedHook.data?.state, requestId: healedNetwork.data?.request?.requestId, targetSource: healedLocation.target?.source });
	} finally {
		await coordinator.stop(orchestrationId);
		fullEnvelope.delete = await coordinator.delete(orchestrationId, { timeoutMs: 15_000 }).catch((error) => ({ ok: false, action: "delete", orchestrationId, failures: [{ code: error?.code || "DELETE_FAILED", message: errorMessage(error) }] }));
		record("browser_orchestrate.delete", fullEnvelope.delete.ok === true && fullEnvelope.delete.operationResults?.some((item) => item.action === "closeTab" && item.status === "succeeded"), { orchestrationId, operationResults: compactOperationResults(fullEnvelope.delete) });
		const fullText = JSON.stringify(fullEnvelope);
		if (fullText.includes(cookieSecret) || fullText.includes(removeSecret)) throw new Error("browser_orchestrate smoke artifact leaked raw cookie value");
		await writeFile(artifactPath, `${JSON.stringify(fullEnvelope, null, 2)}\n`, "utf8");
		record("browser_orchestrate.artifact", true, { orchestrationId, path: artifactPath });
	}
}

async function runPersistentAdoptionSmoke() {
	const origin = `http://127.0.0.1:${smokePort}`;
	const orchestrationId = `smoke-persist-${Date.now()}`;
	const desiredUrl = `${origin}/persistent-adoption?run=${encodeURIComponent(orchestrationId)}`;
	const cookieName = `pi_persist_${Date.now()}`;
	const cookieSecret = "orchestration-persistence-secret";
	const stateDir = path.join(outDir, "smoke-orchestration-state");
	const statePath = path.join(stateDir, "state.v1.json");
	const artifactPath = path.join(outDir, "smoke-orchestration-persistence-result.json");
	const desired = {
		apiVersion: "pi.browser/v1",
		orchestrationId,
		allowedOrigins: [origin],
		defaults: { timeoutMs: 15_000, navigationTimeoutMs: 10_000 },
		sessions: [{ tag: "persist", tabs: [{ role: "main", url: desiredUrl, waitUntil: "complete" }], cookies: [{ name: cookieName, value: cookieSecret, path: "/" }] }],
	};
	const envelope = { orchestrationId, artifactPath, statePath };
	await rm(stateDir, { recursive: true, force: true });
	const first = new BrowserOrchestrationCoordinator(bridge, { persistence: new PersistentOrchestrationStore({ statePath, driverRunId: `${orchestrationId}-run-a`, piSessionId: "smoke-session" }) });
	const restarted = new BrowserOrchestrationCoordinator(bridge, { persistence: new PersistentOrchestrationStore({ statePath, driverRunId: `${orchestrationId}-run-b`, piSessionId: "smoke-session" }) });
	try {
		envelope.apply = await first.apply(desired, { timeoutMs: 20_000 });
		const binding = envelope.apply.bindings[0];
		record("browser_orchestrate.persistenceApply", envelope.apply.ok === true && Boolean(binding?.tabId), { orchestrationId, bindings: compactBindings(envelope.apply), operationResults: compactOperationResults(envelope.apply) });
		const stateText = await readFile(statePath, "utf8");
		if (stateText.includes(cookieSecret)) throw new Error("orchestration persistence smoke state leaked raw cookie value");
		envelope.stateFile = { path: statePath, bytes: stateText.length, rawCookieLeaked: false };
		envelope.load = await restarted.loadPersistentState();
		envelope.staleStatus = await restarted.status(orchestrationId, { timeoutMs: 10_000 });
		record("browser_orchestrate.persistenceLoad", envelope.load.loaded === 1 && envelope.staleStatus.state?.persistence?.adoptionRequired === true, { orchestrationId, persistence: envelope.staleStatus.state?.persistence });
		const tabsBeforeDelete = bridge.getTabs().length;
		envelope.staleDelete = await restarted.delete(orchestrationId, { timeoutMs: 10_000 });
		record("browser_orchestrate.persistenceStaleDelete", envelope.staleDelete.ok === false && envelope.staleDelete.failures?.[0]?.code === "ORCHESTRATION_TARGET_STALE" && bridge.getTabs().length === tabsBeforeDelete, { orchestrationId, failure: envelope.staleDelete.failures?.[0] });
		envelope.badAdoption = await restarted.apply({ ...desired, adoption: { enabled: true, orchestrationId, resourceTypes: ["tab"], verifyOrigins: ["https://wrong.invalid"], verifyUrls: ["https://wrong.invalid/app"], requireOwnedFingerprint: true } }, { timeoutMs: 15_000 });
		record("browser_orchestrate.persistenceBadAdoption", envelope.badAdoption.ok === false && bridge.getTabs().some((tab) => tab.tabId === binding.tabId), { orchestrationId, failure: envelope.badAdoption.failures?.[0] });
		envelope.adopt = await restarted.apply({ ...desired, adoption: { enabled: true, orchestrationId, resourceTypes: ["tab", "cookie"], verifyOrigins: [origin], verifyUrls: [desiredUrl], requireOwnedFingerprint: true } }, { timeoutMs: 20_000 });
		record("browser_orchestrate.persistenceAdopt", envelope.adopt.ok === true && envelope.adopt.persistence?.status !== "adoption_required", { orchestrationId, persistence: envelope.adopt.persistence, bindings: compactBindings(envelope.adopt) });
	} finally {
		envelope.delete = await restarted.delete(orchestrationId, { timeoutMs: 15_000 }).catch((error) => ({ ok: false, action: "delete", orchestrationId, failures: [{ code: error?.code || "DELETE_FAILED", message: errorMessage(error) }] }));
		record("browser_orchestrate.persistenceDelete", envelope.delete.ok === true && envelope.delete.operationResults?.some((item) => item.action === "closeTab" && item.status === "succeeded"), { orchestrationId, operationResults: compactOperationResults(envelope.delete) });
		const text = JSON.stringify(envelope);
		if (text.includes(cookieSecret)) throw new Error("orchestration persistence smoke artifact leaked raw cookie value");
		await writeFile(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
		record("browser_orchestrate.persistenceArtifact", true, { orchestrationId, path: artifactPath, statePath });
	}
}

async function runSessionAssertionsSmoke() {
	const coordinator = bridge.orchestrator();
	const origin = `http://127.0.0.1:${smokePort}`;
	const runId = Date.now();
	const artifactPath = path.join(outDir, "smoke-orchestration-assertions-result.json");
	const cookieName = `pi_assert_auth_${runId}`;
	const cookieSecret = `assert-auth-secret-${runId}`;
	const storageKey = `pi_assert_state_${runId}`;
	const storageValue = "signed-in";
	const hookSessionId = `smoke-assert-hook-${runId}`;
	const passOrchestrationId = `smoke-assert-pass-${runId}`;
	const failOrchestrationId = `smoke-assert-fail-${runId}`;
	const cookieHash = sha256(cookieSecret);
	const storageHash = sha256(storageValue);
	const passUrl = `${origin}/assertions?auth=signed-in&storageKey=${encodeURIComponent(storageKey)}&storageValue=${encodeURIComponent(storageValue)}&run=${runId}`;
	const failUrl = `${origin}/assertions?auth=guest&storageKey=${encodeURIComponent(storageKey)}&run=${runId}`;
	const passTarget = { orchestrationId: passOrchestrationId, sessionTag: "assert-pass", tabRole: "main" };
	const passDesired = {
		apiVersion: "pi.browser/v1",
		orchestrationId: passOrchestrationId,
		allowedOrigins: [origin],
		defaults: { timeoutMs: 20_000, navigationTimeoutMs: 10_000 },
		preNavigationHooks: [{ hookId: "pi.preNavigationMarker", version: "1", hash: preNavigationHookRegistryHash(), required: true }],
		sessions: [{
			tag: "assert-pass",
			tabs: [{ role: "main", url: passUrl, waitUntil: "complete" }],
			cookies: [{ name: cookieName, value: cookieSecret, path: "/" }],
			hookDispatcher: { sessionId: hookSessionId, installFingerprint: `assert-hook-${runId}`, bufferSize: 25 },
			sessionAssertions: {
				mode: "all",
				checks: [
					{ id: "login-cookie", kind: "cookie", name: cookieName, present: true, valueHash: cookieHash },
					{ id: "login-storage", kind: "storage", storageArea: "localStorage", key: storageKey, present: true, valueHash: storageHash },
					{ id: "login-attr", kind: "attribute", selector: "html", name: "data-auth-state", present: true, equals: "signed-in" },
					{ id: "pre-nav-effect", kind: "attribute", selector: "html", name: "data-pre-nav", present: true, equals: "loading" },
					{ id: "hook-installed", kind: "hook", state: "INSTALLED", sessionId: hookSessionId },
				],
			},
		}],
	};
	const failDesired = {
		apiVersion: "pi.browser/v1",
		orchestrationId: failOrchestrationId,
		allowedOrigins: [origin],
		defaults: { timeoutMs: 20_000, navigationTimeoutMs: 10_000 },
		sessions: [{
			tag: "assert-fail",
			tabs: [{ role: "main", url: failUrl, waitUntil: "complete" }],
			sessionAssertions: {
				mode: "all",
				checks: [
					{ id: "missing-login-cookie", kind: "cookie", name: cookieName, present: true, valueHash: cookieHash },
					{ id: "missing-login-storage", kind: "storage", storageArea: "localStorage", key: storageKey, present: true, valueHash: storageHash },
				],
			},
		}],
	};
	const envelope = {
		artifactPrivacy: "local_redacted_session_assertions",
		artifactPath,
		redaction: {
			cookie: "value_hash_only",
			storage: "value_hash_only",
			attribute: "public_selector_bool_only",
			logicalTarget: "no_raw_cookie_values",
		},
		scenarios: {},
	};
	try {
		envelope.scenarios.unsatisfied = { orchestrationId: failOrchestrationId };
		envelope.scenarios.unsatisfied.apply = await coordinator.apply(failDesired, { timeoutMs: 25_000 });
		const failAssertions = sessionAssertionsFromResult(envelope.scenarios.unsatisfied.apply, "assert-fail");
		envelope.scenarios.unsatisfied.summary = failAssertions;
		record("browser_orchestrate.assertionsApplyFail", envelope.scenarios.unsatisfied.apply.ok === false && failAssertions?.failedCount >= 1 && compactFailures(envelope.scenarios.unsatisfied.apply).some((failure) => failure.code === "ORCHESTRATION_ASSERTION_FAILED") && envelope.scenarios.unsatisfied.apply.plan?.operationCount === 0, {
			orchestrationId: failOrchestrationId,
			assertions: failAssertions,
			bindings: compactBindings(envelope.scenarios.unsatisfied.apply),
			failures: compactFailures(envelope.scenarios.unsatisfied.apply),
		});
		envelope.scenarios.unsatisfied.status = await coordinator.status(failOrchestrationId, { timeoutMs: 15_000 });
		record("browser_orchestrate.assertionsStatusFail", envelope.scenarios.unsatisfied.status.ok === false && sessionAssertionsFromResult(envelope.scenarios.unsatisfied.status, "assert-fail")?.failedCount >= 1 && compactFailures(envelope.scenarios.unsatisfied.status).some((failure) => failure.code === "ORCHESTRATION_ASSERTION_FAILED"), {
			orchestrationId: failOrchestrationId,
			assertions: sessionAssertionsFromResult(envelope.scenarios.unsatisfied.status, "assert-fail"),
			failures: compactFailures(envelope.scenarios.unsatisfied.status),
		});

		envelope.scenarios.satisfied = { orchestrationId: passOrchestrationId };
		envelope.scenarios.satisfied.apply = await coordinator.apply(passDesired, { timeoutMs: 30_000 });
		const passAssertions = sessionAssertionsFromResult(envelope.scenarios.satisfied.apply, "assert-pass");
		envelope.scenarios.satisfied.summary = passAssertions;
		record("browser_orchestrate.assertionsApplyPass", envelope.scenarios.satisfied.apply.ok === true && passAssertions?.passed === true && passAssertions?.passedCount === 5, {
			orchestrationId: passOrchestrationId,
			assertions: passAssertions,
			bindings: compactBindings(envelope.scenarios.satisfied.apply),
			operationResults: compactOperationResults(envelope.scenarios.satisfied.apply),
		});
		envelope.scenarios.satisfied.status = await coordinator.status(passOrchestrationId, { timeoutMs: 15_000 });
		record("browser_orchestrate.assertionsStatusPass", envelope.scenarios.satisfied.status.ok === true && sessionAssertionsFromResult(envelope.scenarios.satisfied.status, "assert-pass")?.passed === true && envelope.scenarios.satisfied.status.plan?.operationCount === 0, {
			orchestrationId: passOrchestrationId,
			assertions: sessionAssertionsFromResult(envelope.scenarios.satisfied.status, "assert-pass"),
			operationCount: envelope.scenarios.satisfied.status.plan?.operationCount,
		});
		const logicalTarget = await bridge.executeJavaScript(`return {
			authState: document.documentElement.getAttribute("data-auth-state"),
			preNav: document.documentElement.getAttribute("data-pre-nav"),
			cookiePresent: document.cookie.includes(${JSON.stringify(`${cookieName}=${cookieSecret}`)}),
			storageValue: localStorage.getItem(${JSON.stringify(storageKey)}),
			hookCount: Array.isArray(globalThis.__PI_BROWSER_PRE_NAVIGATION_HOOKS__) ? globalThis.__PI_BROWSER_PRE_NAVIGATION_HOOKS__.length : 0,
		};`, { target: passTarget, timeoutMs: 10_000 });
		envelope.scenarios.satisfied.logicalTarget = {
			targetSource: logicalTarget.target?.source,
			authState: logicalTarget.data?.authState,
			preNav: logicalTarget.data?.preNav,
			cookiePresent: logicalTarget.data?.cookiePresent === true,
			storageValueHash: logicalTarget.data?.storageValue ? sha256(logicalTarget.data.storageValue) : undefined,
			hookCount: logicalTarget.data?.hookCount,
		};
		record("browser_orchestrate.assertionsLogicalTarget", logicalTarget.target?.source === "orchestration" && logicalTarget.data?.authState === "signed-in" && logicalTarget.data?.preNav === "loading" && logicalTarget.data?.cookiePresent === true && logicalTarget.data?.storageValue === storageValue && Number(logicalTarget.data?.hookCount || 0) >= 1, {
			orchestrationId: passOrchestrationId,
			targetSource: logicalTarget.target?.source,
			authState: logicalTarget.data?.authState,
			preNav: logicalTarget.data?.preNav,
			cookiePresent: logicalTarget.data?.cookiePresent === true,
			storageValueHash: logicalTarget.data?.storageValue ? sha256(logicalTarget.data.storageValue) : undefined,
			hookCount: logicalTarget.data?.hookCount,
		});
	} finally {
		envelope.scenarios.unsatisfiedDelete = await coordinator.delete(failOrchestrationId, { timeoutMs: 20_000 }).catch((error) => ({ ok: false, action: "delete", orchestrationId: failOrchestrationId, failures: [{ code: error?.code || "DELETE_FAILED", message: errorMessage(error) }] }));
		record("browser_orchestrate.assertionsDeleteFail", envelope.scenarios.unsatisfiedDelete.ok === true && envelope.scenarios.unsatisfiedDelete.operationResults?.some((item) => item.action === "closeTab" && item.status === "succeeded"), { orchestrationId: failOrchestrationId, operationResults: compactOperationResults(envelope.scenarios.unsatisfiedDelete) });
		envelope.scenarios.satisfiedDelete = await coordinator.delete(passOrchestrationId, { timeoutMs: 20_000 }).catch((error) => ({ ok: false, action: "delete", orchestrationId: passOrchestrationId, failures: [{ code: error?.code || "DELETE_FAILED", message: errorMessage(error) }] }));
		record("browser_orchestrate.assertionsDeletePass", envelope.scenarios.satisfiedDelete.ok === true && envelope.scenarios.satisfiedDelete.operationResults?.some((item) => item.action === "closeTab" && item.status === "succeeded"), { orchestrationId: passOrchestrationId, operationResults: compactOperationResults(envelope.scenarios.satisfiedDelete) });
		const text = JSON.stringify(envelope);
		if (text.includes(cookieSecret)) throw new Error("orchestration assertions smoke artifact leaked raw cookie value");
		await writeFile(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
		record("browser_orchestrate.assertionsArtifact", true, {
			path: artifactPath,
			artifactPrivacy: envelope.artifactPrivacy,
			redaction: envelope.redaction,
			satisfiedOrchestrationId: passOrchestrationId,
			unsatisfiedOrchestrationId: failOrchestrationId,
			satisfiedAssertions: envelope.scenarios.satisfied?.summary,
			unsatisfiedAssertions: envelope.scenarios.unsatisfied?.summary,
			logicalTargetSource: envelope.scenarios.satisfied?.logicalTarget?.targetSource,
		});
	}
}

function profileDesired(orchestrationId, profileId, sessionTag, tabRole, url, cookieName, cookieValue) {
	return {
		apiVersion: "pi.browser/v1",
		orchestrationId,
		allowedOrigins: [new URL(url).origin],
		defaults: { timeoutMs: 30_000, navigationTimeoutMs: 12_000 },
		isolation: { scope: "profile", profile: { profileId, lifecycle: "managed", reuse: "none", cleanup: "delete" } },
		sessions: [{ tag: sessionTag, tabs: [{ role: tabRole, url, waitUntil: "complete" }], cookies: [{ name: cookieName, value: cookieValue, path: "/" }] }],
	};
}

async function readProfileState(target, storageKey, cookieName) {
	const result = await bridge.executeJavaScript(
		`return { cookie: document.cookie || "", local: localStorage.getItem(${JSON.stringify(storageKey)}), session: sessionStorage.getItem(${JSON.stringify(storageKey)}), href: location.href };`,
		{ target, timeoutMs: 10_000 },
	);
	const data = result.data || {};
	return {
		cookieText: String(data.cookie || ""),
		local: data.local === null || data.local === undefined ? null : String(data.local),
		session: data.session === null || data.session === undefined ? null : String(data.session),
		href: String(data.href || ""),
		targetSource: result.target?.source,
		cookieName,
	};
}

function summarizeProfileState(state, expected, forbidden, cookieName) {
	return {
		targetSource: state.targetSource,
		hrefHash: sha256(state.href),
		cookiePresent: state.cookieText.includes(`${cookieName}=${expected.cookie}`),
		forbiddenCookieAbsent: !state.cookieText.includes(`${cookieName}=${forbidden.cookie}`),
		localMatches: state.local === expected.local,
		sessionMatches: state.session === expected.session,
		forbiddenLocalAbsent: state.local !== forbidden.local,
		forbiddenSessionAbsent: state.session !== forbidden.session,
		cookieHash: state.cookieText.includes(`${cookieName}=${expected.cookie}`) ? sha256(expected.cookie) : undefined,
		localHash: state.local ? sha256(state.local) : undefined,
		sessionHash: state.session ? sha256(state.session) : undefined,
	};
}

async function runProfileIsolationSmoke() {
	const coordinator = bridge.orchestrator();
	const origin = `http://127.0.0.1:${smokePort}`;
	const runId = Date.now();
	const artifactDir = path.join(outDir, "profile-isolation");
	const artifactPath = path.join(artifactDir, "profile-isolation-result.json");
	const profileA = `smoke-profile-a-${runId}`;
	const profileB = `smoke-profile-b-${runId}`;
	const orchestrationA = `smoke-profile-a-${runId}`;
	const orchestrationB = `smoke-profile-b-${runId}`;
	const cookieName = `pi_profile_${runId}`;
	const storageKey = `pi_profile_storage_${runId}`;
	const secretA = { cookie: `profile-cookie-a-${runId}`, local: `profile-local-a-${runId}`, session: `profile-session-a-${runId}` };
	const secretB = { cookie: `profile-cookie-b-${runId}`, local: `profile-local-b-${runId}`, session: `profile-session-b-${runId}` };
	const targetA = { orchestrationId: orchestrationA, sessionTag: "profile-a", tabRole: "main", profileId: profileA };
	const targetB = { orchestrationId: orchestrationB, sessionTag: "profile-b", tabRole: "main", profileId: profileB };
	const desiredA = profileDesired(orchestrationA, profileA, "profile-a", "main", `${origin}/profile-isolation?slot=a&run=${runId}`, cookieName, secretA.cookie);
	const desiredB = profileDesired(orchestrationB, profileB, "profile-b", "main", `${origin}/profile-isolation?slot=b&run=${runId}`, cookieName, secretB.cookie);
	const envelope = { artifactPrivacy: "local_redacted_profile_isolation", artifactPath, profiles: {}, bridgePorts: [], operationResults: {} };
	let profileDirs = [];
	let extensionDirs = [];
	try {
		await mkdir(artifactDir, { recursive: true });
		envelope.planA = await coordinator.plan(desiredA, { timeoutMs: 35_000 });
		envelope.planB = await coordinator.plan(desiredB, { timeoutMs: 35_000 });
		const planActions = [...envelope.planA.plan.operations, ...envelope.planB.plan.operations].map((item) => item.action);
		record("browser_orchestrate.profileIsolationPlan", planActions.filter((action) => action === "ensureProfile").length === 2, { orchestrationIds: [orchestrationA, orchestrationB], actions: planActions });

		envelope.applyA = await coordinator.apply(desiredA, { timeoutMs: 60_000 });
		envelope.applyB = await coordinator.apply(desiredB, { timeoutMs: 60_000 });
		const bindingsA = compactBindings(envelope.applyA);
		const bindingsB = compactBindings(envelope.applyB);
		const profiles = compactProfiles(bridge.managedProfiles());
		profileDirs = profiles.map((profile) => profile.profileDir).filter(Boolean);
		extensionDirs = profiles.map((profile) => profile.extensionDir).filter(Boolean);
		const bridgePorts = Array.from(new Set(profiles.map((profile) => profile.bridgePort).filter(Boolean)));
		envelope.profiles.afterApply = profiles;
		envelope.bridgePorts = bridgePorts;
		envelope.operationResults.applyA = compactOperationResults(envelope.applyA);
		envelope.operationResults.applyB = compactOperationResults(envelope.applyB);
		record("browser_orchestrate.profileIsolationApply", envelope.applyA.ok === true && envelope.applyB.ok === true && bindingsA.some((binding) => binding.profileId === profileA) && bindingsB.some((binding) => binding.profileId === profileB) && bridgePorts.length >= 2, { orchestrationIds: [orchestrationA, orchestrationB], bindings: [...bindingsA, ...bindingsB], profiles });

		await bridge.executeJavaScript(`(() => { localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(secretA.local)}); sessionStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(secretA.session)}); return true; })()`, { target: targetA, timeoutMs: 10_000 });
		await bridge.executeJavaScript(`(() => { localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(secretB.local)}); sessionStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(secretB.session)}); return true; })()`, { target: targetB, timeoutMs: 10_000 });
		const stateA = await readProfileState(targetA, storageKey, cookieName);
		const stateB = await readProfileState(targetB, storageKey, cookieName);
		const summaryA = summarizeProfileState(stateA, secretA, secretB, cookieName);
		const summaryB = summarizeProfileState(stateB, secretB, secretA, cookieName);
		envelope.cookieIsolation = { a: { present: summaryA.cookiePresent, forbiddenAbsent: summaryA.forbiddenCookieAbsent, valueHash: summaryA.cookieHash }, b: { present: summaryB.cookiePresent, forbiddenAbsent: summaryB.forbiddenCookieAbsent, valueHash: summaryB.cookieHash } };
		envelope.storageIsolation = { a: { localMatches: summaryA.localMatches, sessionMatches: summaryA.sessionMatches, localHash: summaryA.localHash, sessionHash: summaryA.sessionHash }, b: { localMatches: summaryB.localMatches, sessionMatches: summaryB.sessionMatches, localHash: summaryB.localHash, sessionHash: summaryB.sessionHash } };
		record("browser_orchestrate.profileIsolationStorage", [summaryA, summaryB].every((item) => item.targetSource === "orchestration" && item.cookiePresent && item.forbiddenCookieAbsent && item.localMatches && item.sessionMatches && item.forbiddenLocalAbsent && item.forbiddenSessionAbsent), { orchestrationIds: [orchestrationA, orchestrationB], a: summaryA, b: summaryB });

		envelope.deleteA = await coordinator.delete(orchestrationA, { timeoutMs: 30_000 });
		const stateBAfterDeleteA = await readProfileState(targetB, storageKey, cookieName);
		const summaryBAfterDeleteA = summarizeProfileState(stateBAfterDeleteA, secretB, secretA, cookieName);
		envelope.cleanupAfterDeleteA = { profiles: compactProfiles(bridge.managedProfiles()), bStillIsolated: summaryBAfterDeleteA.cookiePresent && summaryBAfterDeleteA.localMatches && summaryBAfterDeleteA.sessionMatches };
		record("browser_orchestrate.profileIsolationDeleteA", envelope.deleteA.ok === true && envelope.cleanupAfterDeleteA.bStillIsolated && !bridge.managedProfiles().some((profile) => profile.profileId === profileA), { orchestrationId: orchestrationA, operationResults: compactOperationResults(envelope.deleteA), cleanup: envelope.cleanupAfterDeleteA });
	} finally {
		if (!envelope.deleteA) envelope.deleteA = await coordinator.delete(orchestrationA, { timeoutMs: 30_000 }).catch((error) => ({ ok: false, action: "delete", orchestrationId: orchestrationA, failures: [{ code: error?.code || "DELETE_FAILED", message: errorMessage(error) }] }));
		envelope.deleteB = await coordinator.delete(orchestrationB, { timeoutMs: 30_000 }).catch((error) => ({ ok: false, action: "delete", orchestrationId: orchestrationB, failures: [{ code: error?.code || "DELETE_FAILED", message: errorMessage(error) }] }));
		const remainingProfiles = compactProfiles(bridge.managedProfiles());
		const cleanup = {
			remainingProfiles,
			profileDirsRemoved: profileDirs.every((dir) => !existsSync(dir)),
			extensionDirsRemoved: extensionDirs.every((dir) => !existsSync(dir)),
		};
		envelope.cleanup = cleanup;
		envelope.operationResults.deleteA = compactOperationResults(envelope.deleteA);
		envelope.operationResults.deleteB = compactOperationResults(envelope.deleteB);
		record("browser_orchestrate.profileIsolationDelete", envelope.deleteA.ok === true && envelope.deleteB.ok === true && !remainingProfiles.some((profile) => profile.profileId === profileA || profile.profileId === profileB) && cleanup.profileDirsRemoved && cleanup.extensionDirsRemoved, { orchestrationIds: [orchestrationA, orchestrationB], cleanup, operationResults: [...compactOperationResults(envelope.deleteA), ...compactOperationResults(envelope.deleteB)] });
		const text = JSON.stringify(envelope);
		if ([secretA.cookie, secretA.local, secretA.session, secretB.cookie, secretB.local, secretB.session].some((secret) => text.includes(secret))) throw new Error("profile isolation smoke artifact leaked raw profile cookie/storage value");
		await writeFile(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
		record("browser_orchestrate.profileIsolationArtifact", true, { path: artifactPath, artifactPrivacy: "local_redacted_profile_isolation", cleanup });
	}
}

let fixture;
let tabId;
try {
	await mkdir(outDir, { recursive: true });
	record("build.runtime", true, await buildRuntimeMetadata());
	fixture = await startFixture();
	await bridge.start();
	const connected = await waitForExtension(extensionTimeoutMs);
	record("bridge", true, { extension: connected.extension?.name, tabs: connected.tabs.length });

	if (process.env.PI_BROWSER_SMOKE_REUSE_EXISTING === "1") {
		const existing = connected.tabs.find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${smokePort}/`));
		tabId = existing?.tabId || existing?.id;
		record("tabs.reuse", Boolean(tabId), { tabId, url: existing?.url });
	} else {
		const created = await bridge.createTab(`http://127.0.0.1:${smokePort}/`, true, 5_000);
		tabId = created.data?.tabId || created.data?.id;
		record("tabs.create", Boolean(tabId), { tabId });
	}
	if (!tabId) throw new Error("Smoke target tab was not created or discovered");
	await bridge.sendCommand({ cmd: "wait.loadState", state: "complete", tabId }, { tabId, timeoutMs: 10_000 });
	record("wait.loadState", true);

	if (minimalSmoke) {
		const minimal = await bridge.executeJavaScript("(() => { const el = document.querySelector('#result'); el.textContent = 'rollback-minimal'; return { title: document.title, result: el.textContent }; })()", { tabId, timeoutMs: 10_000 });
		record("execute.minimal", minimal.data?.title === "Pi Browser Smoke" && minimal.data?.result === "rollback-minimal", minimal.data || {});
		await bridge.closeTab(tabId, 5_000).catch(() => {});
		tabId = undefined;
		record("tabs.close", true, { minimal: true });
	} else {
	const scan = await bridge.executeJavaScript(buildScanScript({ maxChars: 20_000 }), { tabId, timeoutMs: 10_000 });
	const scanContent = String(scan.data?.content || "");
	await writeFile(path.join(outDir, "smoke-script-scan.txt"), scanContent, "utf8");
	record("scan", scanContent.includes("Smoke Page") && Array.isArray(scan.data?.actionables) && scan.data.actionables.length >= 2, { chars: scanContent.length, actionables: scan.data?.actionables?.length });

	const content = await bridge.executeJavaScript(buildContentScript({ selector: "main", maxChars: 20_000 }), { tabId, timeoutMs: 10_000 });
	const markdown = String(content.data?.markdown || "");
	await writeFile(path.join(outDir, "smoke-script-content.md"), markdown, "utf8");
	record("content", markdown.includes("Readable smoke article body"), { chars: markdown.length });

	const emptyContent = await bridge.executeJavaScript(buildContentScript({ selector: "#empty", maxChars: 20_000 }), { tabId, timeoutMs: 10_000 });
	record("content.empty", emptyContent.data?.empty === true && emptyContent.data?.markdown === "", { empty: emptyContent.data?.empty });
	const missingContent = await bridge.executeJavaScript(buildContentScript({ selector: "#missing", maxChars: 20_000 }), { tabId, timeoutMs: 10_000 });
	record("content.selectorMissing", missingContent.data?.ok === false && missingContent.data?.error_code === "SELECTOR_NOT_FOUND", { error_code: missingContent.data?.error_code });
	const missingHtml = await commandResultOrError({ cmd: "html.get", tabId, selector: "#missing", timeoutMs: 5_000 }, { tabId, timeoutMs: 8_000 });
	record("html.selectorMissing", missingHtml.data?.ok === false && missingHtml.data?.error_code === "SELECTOR_NOT_FOUND", { error_code: missingHtml.data?.error_code });
	const frameList = await bridge.sendCommand({ cmd: "frame.list", tabId, timeoutMs: 8_000 }, { tabId, timeoutMs: 10_000 });
	record("frame.list", frameList.data?.tabId === tabId && Array.isArray(frameList.data?.frames), { count: frameList.data?.count });
	const hookStatus = await commandResultOrError({ cmd: "hook.status", tabId, timeoutMs: 5_000 }, { tabId, timeoutMs: 8_000 });
	const hookCollect = await commandResultOrError({ cmd: "hook.collect", tabId, timeoutMs: 5_000 }, { tabId, timeoutMs: 8_000 });
	record("hook.readOnlyNoInstall", hookStatus.data?.ok === false && hookCollect.data?.ok === false, { status: hookStatus.data?.error_code, collect: hookCollect.data?.error_code });
	const cookieUrl = `http://127.0.0.1:${smokePort}/`;
	const cookieSet = await bridge.sendCommand({ cmd: "cookies", method: "set", url: cookieUrl, name: "pi_smoke_cookie", value: "cookie-smoke-secret", path: "/" }, { timeoutMs: 8_000 });
	const cookieGet = await bridge.sendCommand({ cmd: "cookies", method: "get", url: cookieUrl, name: "pi_smoke_cookie" }, { timeoutMs: 8_000 });
	const cookieRemove = await bridge.sendCommand({ cmd: "cookies", method: "remove", url: cookieUrl, name: "pi_smoke_cookie" }, { timeoutMs: 8_000 });
	record("cookies.setGetRemove", cookieSet.data?.set === true && cookieGet.data?.name === "pi_smoke_cookie" && cookieGet.data?.value === "cookie-smoke-secret" && cookieRemove.data?.removed === true, { set: cookieSet.data?.set, got: cookieGet.data?.name, removed: cookieRemove.data?.removed });

	const interaction = await bridge.executeJavaScript("const input = document.querySelector('input[name=q]'); input.value = 'typed-smoke'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#go').click(); const comment = document.querySelector('#comment'); comment.focus(); comment.textContent = '666'; comment.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '666' })); document.querySelector('#send').click(); return { result: document.querySelector('#result')?.textContent, comment: document.querySelector('#comment-result')?.textContent, sendDisabled: document.querySelector('#send')?.disabled };", { tabId, timeoutMs: 10_000 });
	record("execute.interaction", interaction.data?.result === "typed-smoke" && interaction.data?.comment === "666" && interaction.data?.sendDisabled === false, { resultText: interaction.data?.result, commentText: interaction.data?.comment, sendDisabled: interaction.data?.sendDisabled });

	const cdpTarget = await bridge.executeJavaScript("const comment = document.querySelector('#comment'); comment.textContent = ''; comment.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); const r = comment.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };", { tabId, timeoutMs: 10_000 });
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: cdpTarget.data.x, y: cdpTarget.data.y, button: "left", clickCount: 1 });
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: cdpTarget.data.x, y: cdpTarget.data.y, button: "left", clickCount: 1 });
	await cdpSend(tabId, "Input.insertText", { text: "cdp-smoke" });
	const cdpTyped = await bridge.executeJavaScript("return { text: document.querySelector('#comment')?.textContent, sendDisabled: document.querySelector('#send')?.disabled, active: document.activeElement === document.querySelector('#comment') };", { tabId, timeoutMs: 10_000 });
	await cdpKey(tabId, "rawKeyDown", "Control", "ControlLeft", 17, 2);
	await cdpKey(tabId, "rawKeyDown", "a", "KeyA", 65, 2, { commands: ["selectAll"] });
	await cdpKey(tabId, "keyUp", "a", "KeyA", 65, 2);
	await cdpKey(tabId, "keyUp", "Control", "ControlLeft", 17, 0);
	await cdpKey(tabId, "rawKeyDown", "Backspace", "Backspace", 8, 0);
	await cdpKey(tabId, "keyUp", "Backspace", "Backspace", 8, 0);
	let cdpCleared = await bridge.executeJavaScript("return { text: document.querySelector('#comment')?.textContent, sendDisabled: document.querySelector('#send')?.disabled };", { tabId, timeoutMs: 10_000 });
	let cdpClearFallback = false;
	if (cdpCleared.data?.text !== "") {
		cdpClearFallback = true;
		cdpCleared = await bridge.executeJavaScript("const comment = document.querySelector('#comment'); comment.textContent = ''; comment.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); return { text: comment?.textContent, sendDisabled: document.querySelector('#send')?.disabled };", { tabId, timeoutMs: 10_000 });
	}
	record("execute.cdpInput", cdpTyped.data?.text === "cdp-smoke" && cdpTyped.data?.sendDisabled === false && cdpCleared.data?.text === "" && cdpCleared.data?.sendDisabled === true, { typed: cdpTyped.data, cleared: cdpCleared.data, clearFallback: cdpClearFallback });

	const pickLite = await bridge.executeJavaScript(buildPickScript({ message: "Smoke picker timeout", multiple: false, timeoutMs: 1_200 }), { tabId, timeoutMs: 4_000 });
	record("pick-lite", pickLite.data?.cancelled === true && pickLite.data?.reason === "timeout", { reason: pickLite.data?.reason });

	if (transferSmoke) {
		const uploadPath = path.join(outDir, "smoke-upload.txt");
		await writeFile(uploadPath, "pi smoke upload", "utf8");
		const upload = await bridge.sendCommand({ cmd: "transfer.upload", tabId, selector: "#upload", files: [uploadPath], timeoutMs: 15_000 }, { tabId, timeoutMs: 20_000 });
		record("upload", upload.data?.uploaded === true, { files_count: upload.data?.files_count });
		const download = await bridge.sendCommand({ cmd: "transfer.download", tabId, selector: "#download", timeoutMs: 20_000 }, { tabId, timeoutMs: 25_000 });
		record("download", typeof download.data?.path === "string" && download.data.path.length > 0, { path: download.data?.path, state: download.data?.download?.state });
	}

	await bridge.sendCommand({ cmd: "network.start", tabId, sessionId: "smoke-script", captureBodies: true, clear: true }, { tabId, timeoutMs: 10_000 });
	await bridge.executeJavaScript("return await fetch('/api/data?smoke=script').then(r => r.json())", { tabId, timeoutMs: 10_000 });
	const net = await bridge.sendCommand({ cmd: "network.wait", tabId, sessionId: "smoke-script", condition: "response", urlContains: "/api/data", timeoutMs: 5_000 }, { tabId, timeoutMs: 8_000 });
	record("network", net.data?.request?.status === 200, { requestId: net.data?.request?.requestId });
	await bridge.sendCommand({ cmd: "network.stop", tabId, sessionId: "smoke-script", keepBuffer: false }, { tabId, timeoutMs: 8_000 }).catch(() => {});

	const shot = await bridge.sendCommand({ cmd: "screenshot.capture", tabId, format: "png" }, { tabId, timeoutMs: 15_000 });
	record("screenshot", typeof shot.data?.screenshot === "string", { format: shot.data?.format });

	await runOrchestrationSmoke();
	await runPersistentAdoptionSmoke();
	await runSessionAssertionsSmoke();
	await runPreNavigationHookSmoke();
	await runWindowTabGroupsSmoke();
	await runProfileIsolationSmoke();

	await bridge.closeTab(tabId, 5_000).catch(() => {});
	tabId = undefined;
	record("tabs.close", true);
	}
} catch (error) {
	if (isBridgePortStartFailure(error)) {
		const diagnosis = await diagnoseBridgePortInUse({ host: bridge.host, port: bridge.port, error });
		record("bridge.port", false, diagnosis);
		console.error(`[PI-BROWSER-SMOKE] Bridge port ${bridge.host}:${bridge.port} is occupied: ${diagnosis.reason}`);
	}
	record("error", false, { message: errorMessage(error), code: error && typeof error === "object" ? error.code : undefined, details: error && typeof error === "object" ? error.details : undefined });
	process.exitCode = 1;
} finally {
	if (tabId) await bridge.closeTab(tabId, 2_000).catch(() => {});
	await bridge.stop().catch(() => {});
	if (fixture) await new Promise((resolve) => fixture.close(resolve));
	const ok = process.exitCode !== 1 && results.every((item) => item.ok !== false);
	if (!ok) process.exitCode = 1;
	await writeFile(smokeResultPath, JSON.stringify({ ok, results }, null, 2), "utf8");
	console.log(JSON.stringify({ ok, results }, null, 2));
}
