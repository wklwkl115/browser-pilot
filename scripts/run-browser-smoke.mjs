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

	const tabs = await invoke(daemon, "browser_tabs", { action: "list", maxChars: 20_000 });
	if (!resultText(tabs).includes("Browser Pilot Smoke")) throw new Error(`browser_tabs did not expose the fixture tab: ${resultText(tabs)}`);
	const executed = await invoke(daemon, "browser_execute", {
		tabId,
		script: "(async()=>{const api=await(await fetch('/api/execute')).json();return{title:document.title,marker:document.querySelector('#smoke-marker')?.textContent,api:api.ok}})()",
		maxChars: 20_000,
	});
	if (!resultText(executed).includes("Browser Pilot Smoke")) throw new Error(`browser_execute did not return fixture evidence: ${resultText(executed)}`);
	const observed = await invoke(daemon, "browser_observe", { tabId, maxNodes: 200, maxChars: 30_000 });
	if (!resultText(observed).includes("Browser Pilot Smoke")) throw new Error(`browser_observe did not return fixture evidence: ${resultText(observed)}`);
	const network = await invoke(daemon, "browser_network", {
		action: "captureReload",
		tabId,
		timeoutMs: 15_000,
		maxChars: 30_000,
		params: { idleMs: 300, waitTimeoutMs: 10_000, limit: 20 },
	});
	if (!/networkCaptureReload|captureReload|api\/boot/.test(resultText(network))) throw new Error(`browser_network did not return capture evidence: ${resultText(network)}`);

	const beforeMetrics = browser.status.health?.connectionMetrics || {};
	await invoke(daemon, "browser_command", { command: { cmd: "management", method: "reload" }, timeoutMs: 5_000 });
	const reconnected = await waitForStatus(daemon, (value) => value.extensionConnected === true && Number(value.health?.connectionMetrics?.connects || 0) > Number(beforeMetrics.connects || 0), "extension reload reconnect");
	console.log(JSON.stringify({
		ok: true,
		browser: browser.executable,
		bridgePort: daemon.bridgePort,
		tabId,
		checks: ["extension-handshake", "tabs", "execute", "observe", "network-capture-reload", "extension-reconnect"],
		connectionMetrics: reconnected.health?.connectionMetrics,
	}, null, 2));
} finally {
	await stopBrowser(browser?.child);
	await daemon.close();
	await fixture.close();
	await rm(profileDir, { recursive: true, force: true });
}
