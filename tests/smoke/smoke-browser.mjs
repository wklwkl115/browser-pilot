import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildElementActionScript } from "../../src/actions/buildElementActionScript.ts";
import { buildContentScript } from "../../src/content/buildContentScript.ts";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { buildPickScript } from "../../src/pick/buildPickScript.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const smokePort = Number(process.env.PI_BROWSER_SMOKE_PORT || 8765);
const transferSmoke = process.env.PI_BROWSER_SMOKE_TRANSFER === "1" || process.argv.includes("--transfer");
const bridge = new BrowserBridgeServer();
const results = [];

function record(step, ok, data = {}) { results.push({ step, ok, ...data, t: Date.now() }); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function startFixture() {
	const server = createServer((req, res) => {
		if (req.url?.startsWith("/api/data")) {
			const body = JSON.stringify({ ok: true, items: [1, 2, 3], path: req.url });
			res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			res.end(body);
			return;
		}
		const body = "<!doctype html><html><head><title>Pi Browser Smoke</title></head><body><main><h1>Smoke Page</h1><p>Readable smoke article body.</p><form onsubmit='event.preventDefault();document.querySelector(\"#result\").textContent=\"submitted\"'><label>Query <input name='q' value='pi'></label><button id='go' type='button' onclick='document.querySelector(\"#result\").textContent=document.querySelector(\"input[name=q]\").value'>Go</button><input id='upload' type='file' onchange='document.querySelector(\"#result\").textContent=this.files[0]?.name||\"no-file\"'></form><button id='download' type='button' onclick='const blob=new Blob([\"pi smoke download\"],{type:\"text/plain\"});const a=document.createElement(\"a\");a.href=URL.createObjectURL(blob);a.download=\"pi-browser-smoke-download.txt\";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000)'>Download</button><div id='result' role='status'>idle</div><a href='/api/data'>Data</a></main></body></html>";
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

let fixture;
let tabId;
try {
	await mkdir(outDir, { recursive: true });
	fixture = await startFixture();
	await bridge.start();
	const connected = await waitForExtension();
	record("bridge", true, { extension: connected.extension?.name, tabs: connected.tabs.length });

	const created = await bridge.createTab(`http://127.0.0.1:${smokePort}/`, true, 5_000);
	tabId = created.data?.tabId || created.data?.id;
	record("tabs.create", Boolean(tabId), { tabId });
	await bridge.sendCommand({ cmd: "wait.loadState", state: "complete", tabId }, { tabId, timeoutMs: 10_000 });
	record("wait.loadState", true);

	const scan = await bridge.executeJavaScript(buildScanScript({ maxChars: 20_000 }), { tabId, timeoutMs: 10_000 });
	const scanContent = String(scan.data?.content || "");
	await writeFile(path.join(outDir, "smoke-script-scan.txt"), scanContent, "utf8");
	record("scan", scanContent.includes("Smoke Page"), { chars: scanContent.length });

	const content = await bridge.executeJavaScript(buildContentScript({ selector: "main", maxChars: 20_000 }), { tabId, timeoutMs: 10_000 });
	const markdown = String(content.data?.markdown || "");
	await writeFile(path.join(outDir, "smoke-script-content.md"), markdown, "utf8");
	record("content", markdown.includes("Readable smoke article body"), { chars: markdown.length });

	const query = await bridge.executeJavaScript(buildElementActionScript({ action: "query", selector: "button", limit: 5, visibleOnly: true }), { tabId, timeoutMs: 10_000 });
	record("query", Number(query.data?.returnedMatches || 0) >= 1, { returnedMatches: query.data?.returnedMatches });
	const typed = await bridge.executeJavaScript(buildElementActionScript({ action: "type", selector: "input[name=q]", text: "typed-smoke", clear: true }), { tabId, timeoutMs: 10_000 });
	record("type", typed.data?.finalValue === "typed-smoke", { valueLength: typed.data?.valueLength });
	const clicked = await bridge.executeJavaScript(buildElementActionScript({ action: "click", selector: "#go" }), { tabId, timeoutMs: 10_000 });
	const resultText = await bridge.executeJavaScript("return document.querySelector('#result')?.textContent", { tabId, timeoutMs: 10_000 });
	record("click", clicked.data?.clicked === true && resultText.data === "typed-smoke", { resultText: resultText.data });
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
} catch (error) {
	record("error", false, { message: error instanceof Error ? error.message : String(error) });
	process.exitCode = 1;
} finally {
	if (tabId) await bridge.closeTab(tabId, 2_000).catch(() => {});
	await bridge.stop().catch(() => {});
	if (fixture) await new Promise((resolve) => fixture.close(resolve));
	await writeFile(path.join(outDir, "smoke-browser-results.json"), JSON.stringify({ ok: process.exitCode !== 1, results }, null, 2), "utf8");
	console.log(JSON.stringify({ ok: process.exitCode !== 1, results }, null, 2));
}
