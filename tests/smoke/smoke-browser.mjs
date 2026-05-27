import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildContentScript } from "../../src/content/buildContentScript.ts";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { buildPickScript } from "../../src/pick/buildPickScript.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { diagnoseBridgePortInUse } from "./smokePortDiagnostics.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const smokePort = Number(process.env.PI_BROWSER_SMOKE_PORT || 8765);
const transferSmoke = process.env.PI_BROWSER_SMOKE_TRANSFER === "1" || process.argv.includes("--transfer");
const minimalSmoke = process.env.PI_BROWSER_SMOKE_MINIMAL === "1" || process.argv.includes("--minimal");
const bridge = new BrowserBridgeServer();
const results = [];

function record(step, ok, data = {}) { results.push({ step, ok, ...data, t: Date.now() }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
async function waitUntil(predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await delay(100);
	}
	return undefined;
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
		const body = "<!doctype html><html><head><title>Pi Browser Smoke</title></head><body><main><h1>Smoke Page</h1><p>Readable smoke article body.</p><div id='empty'></div><form onsubmit='event.preventDefault();document.querySelector(\"#result\").textContent=\"submitted\"'><label>Query <input name='q' value='pi'></label><button id='go' type='button' onclick='document.querySelector(\"#result\").textContent=document.querySelector(\"input[name=q]\").value'>Go</button><input id='upload' type='file' onchange='document.querySelector(\"#result\").textContent=this.files[0]?.name||\"no-file\"'></form><div id='comment' role='textbox' contenteditable='true' style='border:1px solid #999;padding:4px' oninput='document.querySelector(\"#send\").disabled=!this.textContent.trim()'></div><button id='send' type='button' disabled onclick='document.querySelector(\"#comment-result\").textContent=document.querySelector(\"#comment\").textContent'>Send</button><div id='comment-result'></div><button id='download' type='button' onclick='const blob=new Blob([\"pi smoke download\"],{type:\"text/plain\"});const a=document.createElement(\"a\");a.href=URL.createObjectURL(blob);a.download=\"pi-browser-smoke-download.txt\";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000)'>Download</button><div id='result' role='status'>idle</div><a href='/api/data'>Data</a></main></body></html>";
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

async function cdpKey(tabId, type, key, code, windowsVirtualKeyCode, modifiers = 0) {
	return await cdpSend(tabId, "Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers });
}

let fixture;
let tabId;
try {
	await mkdir(outDir, { recursive: true });
	record("build.runtime", true, await buildRuntimeMetadata());
	fixture = await startFixture();
	await bridge.start();
	const connected = await waitForExtension();
	record("bridge", true, { extension: connected.extension?.name, tabs: connected.tabs.length });

	if (process.env.PI_BROWSER_SMOKE_REUSE_EXISTING === "1") {
		const existing = await waitUntil(async () => {
			await bridge.refreshTabs(5_000).catch(() => undefined);
			return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`http://127.0.0.1:${smokePort}/`) && !tab.disconnectedAt);
		}, 8_000);
		tabId = existing?.tabId || existing?.id;
		record("tabs.reuse", Boolean(tabId), { tabId, url: existing?.url });
	} else {
		const created = await bridge.createTab(`http://127.0.0.1:${smokePort}/`, true, 5_000);
		tabId = created.data?.tabId || created.data?.id;
		record("tabs.create", Boolean(tabId), { tabId });
		if (tabId) {
			await waitUntil(async () => {
				await bridge.refreshTabs(5_000).catch(() => undefined);
				return bridge.getTabs().some((tab) => tab.tabId === tabId && !tab.disconnectedAt);
			}, 5_000);
		}
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
	const secondTab = await bridge.createTab(`http://127.0.0.1:${smokePort}/?session=secondary`, false, 5_000);
	const secondTabId = secondTab.data?.tabId || secondTab.data?.id;
	const secondarySession = bridge.createBrowserSession("smoke-secondary");
	if (!secondTabId) throw new Error("Session smoke secondary tab was not created");
	await waitUntil(async () => {
		await bridge.refreshTabs(5_000).catch(() => undefined);
		return bridge.getTabs().some((tab) => tab.tabId === secondTabId && !tab.disconnectedAt);
	}, 5_000);
	bridge.attachTabToBrowserSession(secondTabId, { browserSessionId: secondarySession.id });
	await bridge.sendCommand({ cmd: "wait.loadState", state: "complete", tabId: secondTabId }, { browserSessionId: secondarySession.id, tabId: secondTabId, timeoutMs: 10_000 });
	await bridge.switchTab(tabId, 5_000);
	const defaultWrite = await bridge.executeJavaScript("document.querySelector('#result').textContent = 'default-session'; return { result: document.querySelector('#result').textContent, url: location.href };", { tabId, timeoutMs: 10_000 });
	const scopedWrite = await bridge.executeJavaScript("document.querySelector('#result').textContent = 'secondary-session'; return { result: document.querySelector('#result').textContent, url: location.href };", { browserSessionId: secondarySession.id, tabId: secondTabId, timeoutMs: 10_000 });
	const defaultRead = await bridge.executeJavaScript("return { result: document.querySelector('#result').textContent, url: location.href };", { tabId, timeoutMs: 10_000, accessMode: "read" });
	const scopedRead = await bridge.executeJavaScript("return { result: document.querySelector('#result').textContent, url: location.href };", { browserSessionId: secondarySession.id, tabId: secondTabId, timeoutMs: 10_000, accessMode: "read" });
	const heldLease = bridge.leaseTab(secondTabId, { browserSessionId: secondarySession.id });
	const conflict = await bridge.executeJavaScript("return 'lease-conflict'", { tabId: secondTabId, timeoutMs: 1_000 }).then(() => undefined, (error) => error);
	bridge.releaseTab(secondTabId, { browserSessionId: secondarySession.id });
	record("browserSession.scoped", defaultWrite.data === "default-session" && scopedWrite.data === "secondary-session" && defaultRead.data?.result === "default-session" && scopedRead.data?.result === "secondary-session" && conflict?.code === "TAB_LEASE_CONFLICT", { browserSessionId: secondarySession.id, secondTabId, leaseId: heldLease.id, conflict: conflict?.code, defaultWrite: defaultWrite.data, scopedWrite: scopedWrite.data, defaultRead: defaultRead.data, scopedRead: scopedRead.data, defaultTarget: defaultWrite.target, scopedTarget: scopedWrite.target });
	await bridge.closeTab(secondTabId, 5_000, { browserSessionId: secondarySession.id }).catch(() => {});
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

	const interaction = await bridge.executeJavaScript("const input = document.querySelector('input[name=q]'); input.value = 'typed-smoke'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#go').click(); const comment = document.querySelector('#comment'); comment.focus(); comment.textContent = '666'; comment.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '666' })); document.querySelector('#send').click(); return { result: document.querySelector('#result')?.textContent, comment: document.querySelector('#comment-result')?.textContent, sendDisabled: document.querySelector('#send')?.disabled };", { tabId, timeoutMs: 10_000 });
	record("execute.interaction", interaction.data?.result === "typed-smoke" && interaction.data?.comment === "666" && interaction.data?.sendDisabled === false, { resultText: interaction.data?.result, commentText: interaction.data?.comment, sendDisabled: interaction.data?.sendDisabled });

	const cdpTarget = await bridge.executeJavaScript("const comment = document.querySelector('#comment'); comment.textContent = ''; comment.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); const r = comment.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };", { tabId, timeoutMs: 10_000 });
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: cdpTarget.data.x, y: cdpTarget.data.y, button: "left", clickCount: 1 });
	await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: cdpTarget.data.x, y: cdpTarget.data.y, button: "left", clickCount: 1 });
	await cdpSend(tabId, "Input.insertText", { text: "cdp-smoke" });
	const cdpTyped = await bridge.executeJavaScript("return { text: document.querySelector('#comment')?.textContent, sendDisabled: document.querySelector('#send')?.disabled, active: document.activeElement === document.querySelector('#comment') };", { tabId, timeoutMs: 10_000 });
	await cdpKey(tabId, "keyDown", "Control", "ControlLeft", 17, 2);
	await cdpKey(tabId, "keyDown", "a", "KeyA", 65, 2);
	await cdpKey(tabId, "keyUp", "a", "KeyA", 65, 2);
	await cdpKey(tabId, "keyUp", "Control", "ControlLeft", 17, 0);
	await cdpKey(tabId, "keyDown", "Backspace", "Backspace", 8, 0);
	await cdpKey(tabId, "keyUp", "Backspace", "Backspace", 8, 0);
	const cdpCleared = await bridge.executeJavaScript("return { text: document.querySelector('#comment')?.textContent, sendDisabled: document.querySelector('#send')?.disabled };", { tabId, timeoutMs: 10_000 });
	record("execute.cdpInput", cdpTyped.data?.text === "cdp-smoke" && cdpTyped.data?.sendDisabled === false && cdpCleared.data?.text === "" && cdpCleared.data?.sendDisabled === true, { typed: cdpTyped.data, cleared: cdpCleared.data });

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
	await writeFile(path.join(outDir, "smoke-browser-results.json"), JSON.stringify({ ok, results }, null, 2), "utf8");
	console.log(JSON.stringify({ ok, results }, null, 2));
}
