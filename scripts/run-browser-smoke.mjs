import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

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
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		const body = requestUrl.pathname.startsWith("/api/")
			? JSON.stringify({ ok: true, path: req.url })
			: '<!doctype html><html><head><title>Browser Pilot Smoke</title></head><body><main><h1 id="smoke-marker">Browser Pilot Smoke</h1><button id="smoke-action" type="button" onclick="this.dataset.clicked=\'yes\'">Run smoke</button></main><script>fetch("/api/boot")</script></body></html>';
		res.writeHead(200, { "content-type": requestUrl.pathname.startsWith("/api/") ? "application/json" : "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
		res.end(body);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
	return {
		url: "http://127.0.0.1:" + address.port + "/",
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function daemonJson(daemon, pathname, init = {}, timeoutMs = 10_000) {
	const response = await fetch(`http://${daemon.controlHost}:${daemon.controlPort}${pathname}`, {
		...init,
		headers: {
			"x-browser-pilot-daemon-token": daemon.token,
			...(init.body ? { "content-type": "application/json" } : {}),
			...init.headers,
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	const value = await response.json();
	if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${JSON.stringify(value)}`);
	return value;
}

function resultText(result) {
	return Array.isArray(result?.content) ? result.content.map((item) => typeof item?.text === "string" ? item.text : "").join("\n") : "";
}

function resultEnvelope(result, label) {
	try { return JSON.parse(resultText(result)); } catch { throw new Error(`${label} did not return JSON: ${resultText(result)}`); }
}

function bridgeResult(result, label) {
	const value = resultEnvelope(result, label);
	if (value?.acknowledged === true) return value;
	if (value?.summary?.type === "bridgeResult") return value.summary;
	throw new Error(`${label} was not acknowledged: ${JSON.stringify(value)}`);
}

async function invoke(daemon, tool, params, transportTimeoutMs = 10_000) {
	const result = await daemonJson(daemon, "/invoke", {
		method: "POST",
			body: JSON.stringify({ tool, params, cwd: root }),
	}, transportTimeoutMs);
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

async function closeBrowserViaCdp(profileDir) {
	let endpoint;
	try {
		const [portLine, socketPath] = (await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
		const port = Number(portLine);
		if (!Number.isInteger(port) || port <= 0 || !socketPath?.startsWith("/")) return false;
		endpoint = `ws://127.0.0.1:${port}${socketPath}`;
	} catch {
		return false;
	}
	return await new Promise((resolve) => {
		const socket = new WebSocket(endpoint);
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			socket.terminate();
			finish(false);
		}, 2_000);
		socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
		socket.on("message", (data) => {
			try {
				const message = JSON.parse(String(data));
				if (message?.id !== 1) return;
				if (message.error) finish(false);
				else finish(true);
			} catch {
				/* wait for the Browser.close response or socket close */
			}
		});
		socket.once("close", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function stopBrowser(child, profileDir) {
	if (profileDir && await closeBrowserViaCdp(profileDir)) await delay(1_000);
	if (!child || child.exitCode !== null) return;
	child.kill();
	const exited = await Promise.race([
		new Promise((resolve) => child.once("exit", () => resolve(true))),
		delay(2_000).then(() => false),
	]);
	if (exited || child.exitCode !== null) return;
	child.kill("SIGKILL");
	await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
}

async function removeProfileDir(profileDir) {
	try {
		await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (error) {
		const code = error && typeof error === "object" ? String(error.code || "") : "";
		if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
		console.warn(`[browser-pilot-smoke] temporary profile cleanup was deferred after a Windows file lock (${code}): ${path.basename(profileDir)}`);
	}
}

async function launchConnectedBrowser(daemon, fixtureUrl, profileRoot) {
	const candidates = await existingBrowserCandidates();
	if (!candidates.length) throw new Error("no Chrome/Edge/Chromium executable found; set BROWSER_PILOT_SMOKE_BROWSER");
	const failures = [];
	for (const executable of candidates) {
		const profileDir = await mkdtemp(path.join(profileRoot, "candidate-"));
		const child = spawn(executable, [
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--remote-debugging-port=0",
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
			return { child, executable, status, output, profileDir };
		} catch (error) {
			failures.push({ executable, error: error instanceof Error ? error.message : String(error), output: output() });
			await stopBrowser(child, profileDir);
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
		const targetRef = typeof tab?.targetRef === "string" ? tab.targetRef : typeof tab?.tabHandle === "string" ? tab.tabHandle : "";
		if (!targetRef) throw new Error(`fixture tab had no stable targetRef: ${JSON.stringify(tab)}`);
	const browserId = typeof tab?.browserId === "string" ? tab.browserId : "";
	if (!browserId) throw new Error(`fixture browser client was not identifiable: ${JSON.stringify(tab)}`);
	const selectedBrowser = await invoke(daemon, "browser_tabs", { action: "selectBrowser", browserId });
	if (!resultText(selectedBrowser).includes(browserId)) throw new Error(`fixture browser client was not selected: ${resultText(selectedBrowser)}`);

	const tabs = await invoke(daemon, "browser_tabs", { action: "list" });
	if (!resultText(tabs).includes("Browser Pilot Smoke")) throw new Error(`browser_tabs did not expose the fixture tab: ${resultText(tabs)}`);
		const executed = await invoke(daemon, "browser_execute", {
			targetRef,
		readOnly: true,
		script: "(async()=>{const api=await(await fetch('/api/execute')).json();return{title:document.title,marker:document.querySelector('#smoke-marker')?.textContent,api:api.ok}})()",
	});
		const executedResult = bridgeResult(executed, "browser_execute");
		if (!resultText(executed).includes("Browser Pilot Smoke")) throw new Error(`browser_execute did not return fixture evidence: ${resultText(executed)}`);
		if (executedResult.data?.title !== "Browser Pilot Smoke") throw new Error(`browser_execute did not return raw script data: ${JSON.stringify(executedResult)}`);

	const created = bridgeResult(await invoke(daemon, "browser_tabs", { action: "create", url: `${fixture.url}secondary`, active: true }), "browser_tabs create");
	const createdTargetRef = created.createdTarget?.targetRef ?? created.data?.targetRef;
		if (!createdTargetRef) throw new Error(`created tab was not routable: ${JSON.stringify(created)}`);
	bridgeResult(await invoke(daemon, "browser_tabs", { action: "close", targetRef: createdTargetRef }), "browser_tabs close");

		await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.start", clear: true } });
		await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "fetch('/api/smoke').then(r=>r.text())" });
		const network = await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.list", limit: 20 } });
		if (!/api\/smoke/.test(resultText(network))) throw new Error(`browser_command network.list did not return capture evidence: ${resultText(network)}`);
		await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.stop" } });

			const observed = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef }), "browser_observe");
		if (observed.schema !== "browser-page-observation/v3" || typeof observed.content?.text !== "string") {
				throw new Error(`browser_observe did not return canonical PageObservation: ${JSON.stringify(observed)}`);
		}
				if (!observed.content.text.includes("Browser Pilot Smoke")) throw new Error(`browser_observe did not return page content: ${JSON.stringify(observed.content)}`);
				const entities = observed.entities;
			const actionRef = Array.isArray(entities)
				? entities.find((entity) => entity?.name === "Run smoke")?.ref
				: entities?.projection === "folded-v1" && Array.isArray(entities.items)
					? entities.items.find((item) => item?.v?.[0] === "button")?.v?.[1]
					: undefined;
			if (typeof actionRef !== "string") throw new Error(`browser_observe did not mint the smoke action ref: ${JSON.stringify(entities)}`);
			const bound = bridgeResult(await invoke(daemon, "browser_execute", { refs: { action: actionRef }, readOnly: true, script: "({id:browserPilot.refs.action?.id,tag:browserPilot.refs.action?.tagName})" }), "browser_execute refs");
			if (bound.data?.id !== "smoke-action" || bound.data?.tag !== "BUTTON") throw new Error(`browser_execute did not bind the observed ref: ${JSON.stringify(bound)}`);
			bridgeResult(await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }), "browser_command input.ref");
			const clicked = bridgeResult(await invoke(daemon, "browser_execute", { refs: { action: actionRef }, readOnly: true, script: "browserPilot.refs.action?.dataset.clicked" }), "browser_execute ref verification");
			if (clicked.data !== "yes") throw new Error(`input.ref did not dispatch the physical click: ${JSON.stringify(clicked)}`);
			bridgeResult(await invoke(daemon, "browser_execute", { targetRef, script: "(()=>{const el=document.querySelector('#smoke-action');el.dataset.clicked='';el.textContent='Changed action';return true})()" }), "change ref semantics");
			const semanticMismatch = resultEnvelope(await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }), "semantic mismatch input.ref");
			if (semanticMismatch.code !== "BACKEND_NODE_STALE") throw new Error(`input.ref did not reject changed semantics: ${JSON.stringify(semanticMismatch)}`);
			bridgeResult(await invoke(daemon, "browser_execute", { targetRef, script: "(()=>{const el=document.querySelector('#smoke-action');el.textContent='Run smoke';const rect=el.getBoundingClientRect();const cover=document.createElement('div');cover.id='smoke-cover';Object.assign(cover.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,zIndex:'2147483647'});document.body.append(cover);return true})()" }), "cover ref target");
			const occluded = resultEnvelope(await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }), "occluded input.ref");
			if (occluded.code !== "BACKEND_NODE_STALE") throw new Error(`input.ref did not reject an occluded target: ${JSON.stringify(occluded)}`);
			bridgeResult(await invoke(daemon, "browser_execute", { targetRef, script: "document.querySelector('#smoke-cover')?.remove()" }), "uncover ref target");
			bridgeResult(await invoke(daemon, "browser_execute", { targetRef, script: "(()=>{const old=document.querySelector('#smoke-action');const next=document.createElement('button');next.id='danger-action';next.textContent='Danger';next.onclick=()=>{next.dataset.clicked='yes'};old.replaceWith(next);return true})()" }), "replace ref target");
			const staleInput = resultEnvelope(await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }), "stale input.ref");
			if (staleInput.code !== "BACKEND_NODE_STALE") throw new Error(`stale input.ref did not fail closed: ${JSON.stringify(staleInput)}`);
			const untouched = bridgeResult(await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "document.querySelector('#danger-action')?.dataset.clicked" }), "stale ref verification");
			if (untouched.data !== undefined && untouched.data !== "[undefined]") throw new Error(`stale input.ref clicked the replacement element: ${JSON.stringify(untouched)}`);

	console.log(JSON.stringify({
		ok: true,
		browser: browser.executable,
		bridgePort: daemon.bridgePort,
		tabId,
			checks: ["extension-handshake", "tabs", "execute", "tab-create-close", "browser-command-network", "canonical-observe", "direct-observe-content", "ref-execute", "ref-input", "ref-semantic-mismatch-rejected", "ref-occlusion-rejected", "stale-ref-rejected"],
	}, null, 2));
} finally {
	await stopBrowser(browser?.child, browser?.profileDir);
	await daemon.close();
	await fixture.close();
	await removeProfileDir(profileDir);
}
