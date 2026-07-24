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
				: `<!doctype html><html><head><title>Browser Pilot Smoke</title></head><body><main><h1 id="smoke-marker">Browser Pilot Smoke</h1><button id="smoke-action" type="button" onclick="this.dataset.clicked='yes'">Run smoke</button><canvas id="visual-surface" width="240" height="120" style="display:block;border:1px solid #000"></canvas><input id="visual-input" aria-label="Visual input"></main><script>
					const canvas=document.querySelector('#visual-surface'),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#1266cc';ctx.fillRect(20,20,80,60);
					canvas.addEventListener('click',event=>{canvas.dataset.clickX=String(Math.round(event.offsetX));canvas.dataset.clickY=String(Math.round(event.offsetY));canvas.dataset.clickCount=String(Number(canvas.dataset.clickCount||0)+1);ctx.fillStyle='#d22';ctx.fillRect(event.offsetX,event.offsetY,8,8)});
					canvas.addEventListener('mousedown',event=>{canvas.dataset.dragStart=Math.round(event.offsetX)+','+Math.round(event.offsetY)});canvas.addEventListener('mouseup',event=>{canvas.dataset.dragEnd=Math.round(event.offsetX)+','+Math.round(event.offsetY)});
					canvas.addEventListener('wheel',event=>{event.preventDefault();canvas.dataset.wheelY=String(Math.round(event.deltaY));ctx.fillStyle='#2a2';ctx.fillRect(120,20,20,20)},{passive:false});fetch('/api/boot');
				</script></body></html>`;
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

function requireEffect(value, label, options = {}) {
	const effect = value?.effect;
	if (effect?.observed !== true) throw new Error(`${label} did not return observed page-effect feedback: ${JSON.stringify(value)}`);
	if (effect.changed !== (options.changed ?? true)) throw new Error(`${label} returned unexpected changed state: ${JSON.stringify(effect)}`);
	if (options.settled !== false && effect.settled !== true) throw new Error(`${label} did not settle: ${JSON.stringify(effect)}`);
	if (options.newTabs !== undefined && effect.newTabs !== options.newTabs) throw new Error(`${label} returned unexpected new-tab count: ${JSON.stringify(effect)}`);
	return effect;
}

function normalizedVisualPoint(visual, rect, x, y) {
	const width = Number(visual?.basis?.viewportWidth);
	const height = Number(visual?.basis?.viewportHeight);
	if (!(width > 0 && height > 0)) throw new Error(`visual observation has no viewport basis: ${JSON.stringify(visual)}`);
	return { x: (Number(rect.x) + x) / width, y: (Number(rect.y) + y) / height };
}

async function requirePngResource(resourceUri, label) {
	const prefix = "browser-pilot://artifact/";
	if (typeof resourceUri !== "string" || !resourceUri.startsWith(prefix)) throw new Error(`${label} did not return an artifact resource: ${String(resourceUri)}`);
	const relative = resourceUri.slice(prefix.length).split("/").map(decodeURIComponent);
	const data = await readFile(path.join(root, ".browser-pilot", "artifacts", ...relative));
	if (data.length < 8 || data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${label} resource is not a PNG: ${resourceUri}`);
}

async function invoke(daemon, tool, params, transportTimeoutMs = 10_000) {
	const result = await daemonJson(daemon, "/invoke", {
		method: "POST",
		body: JSON.stringify({ tool, params, cwd: root, contractIdentity: daemon.contractIdentity }),
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
const profileDir = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-smoke-"));
const { startDaemon } = await import("../src/apps/daemon/server.ts");
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
	const tabs = await invoke(daemon, "browser_tabs", { action: "list" });
	if (!resultText(tabs).includes("Browser Pilot Smoke")) throw new Error(`browser_tabs did not expose the fixture tab: ${resultText(tabs)}`);
	const executed = await invoke(daemon, "browser_execute", {
		targetRef,
		readOnly: true,
		script: "(async()=>{const api=await(await fetch('/api/execute')).json();return{title:document.title,marker:document.querySelector('#smoke-marker')?.textContent,api:api.ok}})()",
	});
	const executedResult = resultEnvelope(executed, "browser_execute");
	if (!resultText(executed).includes("Browser Pilot Smoke")) throw new Error(`browser_execute did not return fixture evidence: ${resultText(executed)}`);
	if (executedResult.result?.title !== "Browser Pilot Smoke") throw new Error(`browser_execute did not return raw script data: ${JSON.stringify(executedResult)}`);
	const cdp = resultEnvelope(await invoke(daemon, "browser_command", { targetRef, command: { cmd: "cdp", method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } } }), "browser_command cdp");
	if (cdp.result?.result?.value !== "Browser Pilot Smoke") throw new Error(`browser_command cdp did not return raw browser evidence: ${JSON.stringify(cdp)}`);

	const created = resultEnvelope(await invoke(daemon, "browser_tabs", { action: "create", url: `${fixture.url}secondary`, active: true }), "browser_tabs create");
	const createdTargetRef = created.createdTarget?.targetRef;
	if (!createdTargetRef) throw new Error(`created tab was not routable: ${JSON.stringify(created)}`);
	resultEnvelope(await invoke(daemon, "browser_tabs", { action: "close", targetRef: createdTargetRef }), "browser_tabs close");
	const background = resultEnvelope(await invoke(daemon, "browser_tabs", { action: "create", url: `${fixture.url}background`, active: false }), "browser_tabs create background");
	const backgroundTargetRef = background.createdTarget?.targetRef;
	if (!backgroundTargetRef) throw new Error(`background tab was not routable: ${JSON.stringify(background)}`);
	const backgroundWrite = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef: backgroundTargetRef, script: "document.documentElement.dataset.background='yes'; true" }), "background browser_execute");
	requireEffect(backgroundWrite, "background browser_execute");
	resultEnvelope(await invoke(daemon, "browser_tabs", { action: "close", targetRef: backgroundTargetRef }), "browser_tabs close background");

	const networkStarted = resultEnvelope(await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.start", clear: true } }), "browser_command network.start");
	requireEffect(networkStarted, "browser_command network.start", { changed: false });
	await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "fetch('/api/smoke').then(r=>r.text())" });
	const network = await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.list", limit: 20 } });
	if (!/api\/smoke/.test(resultText(network))) throw new Error(`browser_command network.list did not return capture evidence: ${resultText(network)}`);
	const networkStopped = resultEnvelope(await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.stop" } }), "browser_command network.stop");
	requireEffect(networkStopped, "browser_command network.stop", { changed: false });
	resultEnvelope(await invoke(daemon, "browser_command", { targetRef, command: { cmd: "hook.install", targets: ["console"] } }), "browser_command hook.install");
	const hookReused = resultEnvelope(await invoke(daemon, "browser_command", { targetRef, command: { cmd: "hook.install", targets: ["console"] } }), "browser_command hook.install reuse");
	if (hookReused.result?.idempotent !== true && hookReused.result?.reused !== true) throw new Error(`hook.install did not reuse its runtime-owned session: ${JSON.stringify(hookReused)}`);
		resultEnvelope(await invoke(daemon, "browser_command", { targetRef, command: { cmd: "hook.uninstall" } }), "browser_command hook.uninstall");

		const visualGeometry = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "(()=>{const box=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{canvas:box(document.querySelector('#visual-surface')),input:box(document.querySelector('#visual-input'))}})()" }), "visual geometry").result;
		const observeVisual = async (label) => {
			const value = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef, visual: "always" }), label);
			const visual = value.visual;
			if (typeof visual?.ref !== "string" || typeof visual?.basis?.observationId !== "string" || visual.actionableGrounding !== true) throw new Error(`${label} did not return actionable visual evidence: ${JSON.stringify(visual)}`);
			await requirePngResource(visual.resourceUri, label);
			return visual;
		};
		const visualCommand = (visual, action, point, extra = {}) => invoke(daemon, "browser_command", { command: { cmd: "input.ref", action, ref: visual.ref, visual: { observationId: visual.basis.observationId, point, ...(extra.to ? { to: extra.to } : {}) }, ...extra.command } });

		const clickVisual = await observeVisual("visual click observe");
		const clickPoint = normalizedVisualPoint(clickVisual, visualGeometry.canvas, 31, 19);
		const visualClick = resultEnvelope(await visualCommand(clickVisual, "click", clickPoint), "visual click");
		const visualClickEffect = requireEffect(visualClick, "visual click");
		if (visualClickEffect.visual?.observed !== true || visualClickEffect.visual.changed !== true) throw new Error(`visual click did not return changed pixel evidence: ${JSON.stringify(visualClickEffect)}`);
		await requirePngResource(visualClickEffect.visual.resourceUri, "visual click effect");
		const clickCoordinates = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "(()=>{const c=document.querySelector('#visual-surface');return{x:Number(c.dataset.clickX),y:Number(c.dataset.clickY),count:Number(c.dataset.clickCount)}})()" }), "visual click coordinates").result;
		if (Math.abs(clickCoordinates.x - 31) > 1 || Math.abs(clickCoordinates.y - 19) > 1 || clickCoordinates.count !== 1) throw new Error(`visual click was recentered or missed: ${JSON.stringify(clickCoordinates)}`);

		const dragVisual = await observeVisual("visual drag observe");
		const dragFrom = normalizedVisualPoint(dragVisual, visualGeometry.canvas, 24, 30);
		const dragTo = normalizedVisualPoint(dragVisual, visualGeometry.canvas, 180, 72);
		resultEnvelope(await visualCommand(dragVisual, "drag", dragFrom, { to: dragTo }), "visual drag");
		const dragCoordinates = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "(()=>{const c=document.querySelector('#visual-surface');return{from:c.dataset.dragStart,to:c.dataset.dragEnd}})()" }), "visual drag coordinates").result;
		const [dragFromX, dragFromY] = String(dragCoordinates.from).split(",").map(Number);
		const [dragToX, dragToY] = String(dragCoordinates.to).split(",").map(Number);
		if (Math.abs(dragFromX - 24) > 1 || Math.abs(dragFromY - 30) > 1 || Math.abs(dragToX - 180) > 1 || Math.abs(dragToY - 72) > 1) throw new Error(`visual drag coordinates changed: ${JSON.stringify(dragCoordinates)}`);

		const wheelVisual = await observeVisual("visual wheel observe");
		const wheelPoint = normalizedVisualPoint(wheelVisual, visualGeometry.canvas, 80, 60);
		resultEnvelope(await visualCommand(wheelVisual, "wheel", wheelPoint, { command: { deltaY: 47 } }), "visual wheel");
		const wheelY = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "Number(document.querySelector('#visual-surface').dataset.wheelY)" }), "visual wheel delta").result;
		if (wheelY !== 47) throw new Error(`visual wheel delta changed: ${JSON.stringify(wheelY)}`);

		const typeVisual = await observeVisual("visual type observe");
		const typePoint = normalizedVisualPoint(typeVisual, visualGeometry.input, visualGeometry.input.width / 2, visualGeometry.input.height / 2);
		const visualType = resultEnvelope(await visualCommand(typeVisual, "type", typePoint, { command: { text: "pixel input" } }), "visual type");
		if (visualType.effect?.visual?.observed !== true) throw new Error(`visual type did not return pixel evidence: ${JSON.stringify(visualType)}`);
		const typedValue = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "document.querySelector('#visual-input').value" }), "visual type value").result;
		if (typedValue !== "pixel input") throw new Error(`visual type missed its target: ${JSON.stringify(typedValue)}`);

		resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: "document.activeElement?.blur();true" }), "blur visual input");
		const staleVisual = await observeVisual("visual stale observe");
		const stalePoint = normalizedVisualPoint(staleVisual, visualGeometry.canvas, 60, 40);
		resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: "(()=>{const c=document.querySelector('#visual-surface');const x=c.getContext('2d');x.fillStyle='#111';x.fillRect(0,0,12,12);return true})()" }), "mutate visual pixels");
		const staleVisualInput = resultEnvelope(await visualCommand(staleVisual, "click", stalePoint), "stale visual click");
		if (staleVisualInput.code !== "REF_STALE") throw new Error(`visual input did not reject changed pixels: ${JSON.stringify(staleVisualInput)}`);

		const observed = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef, fresh: true }), "browser_observe");
		if (observed.schema !== "browser-page-observation/v3" || typeof observed.content?.text !== "string") {
			throw new Error(`browser_observe did not return a PageObservation view: ${JSON.stringify(observed)}`);
		}
		if (observed.visual?.actionableGrounding !== true) throw new Error(`browser_observe auto mode did not attach visual evidence: ${JSON.stringify(observed.visual)}`);
	if (!observed.content.text.includes("Browser Pilot Smoke")) throw new Error(`browser_observe did not return page content: ${JSON.stringify(observed.content)}`);
	const actionRef = Array.isArray(observed.actionSpace?.items) ? observed.actionSpace.items.find((entity) => entity?.name === "Run smoke")?.ref : undefined;
	if (typeof actionRef !== "string") throw new Error(`browser_observe did not mint the smoke action ref: ${JSON.stringify(observed.actionSpace)}`);
	const bound = resultEnvelope(await invoke(daemon, "browser_execute", { refs: { action: actionRef }, readOnly: true, script: "({id:browserPilot.refs.action?.id,tag:browserPilot.refs.action?.tagName})" }), "browser_execute refs");
	if (bound.result?.id !== "smoke-action" || bound.result?.tag !== "BUTTON") throw new Error(`browser_execute did not bind the observed ref: ${JSON.stringify(bound)}`);
	const input = resultEnvelope(await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }), "browser_command input.ref");
	requireEffect(input, "browser_command input.ref");
	const clicked = resultEnvelope(await invoke(daemon, "browser_execute", { refs: { action: actionRef }, readOnly: true, script: "browserPilot.refs.action?.dataset.clicked" }), "browser_execute ref verification");
	if (clicked.result !== "yes") throw new Error(`input.ref did not dispatch the physical click: ${JSON.stringify(clicked)}`);
	resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: "(()=>{const el=document.querySelector('#smoke-action');el.dataset.clicked='';el.textContent='Changed action';return true})()" }), "change ref semantics");
	const semanticMismatch = resultEnvelope(await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }), "semantic mismatch input.ref");
	if (semanticMismatch.code !== "BACKEND_NODE_STALE") throw new Error(`input.ref did not reject changed semantics: ${JSON.stringify(semanticMismatch)}`);
	resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: "(()=>{const el=document.querySelector('#smoke-action');el.textContent='Run smoke';const rect=el.getBoundingClientRect();const cover=document.createElement('div');cover.id='smoke-cover';Object.assign(cover.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,zIndex:'2147483647'});document.body.append(cover);return true})()" }), "cover ref target");
	const occluded = resultEnvelope(await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }), "occluded input.ref");
	if (occluded.code !== "BACKEND_NODE_STALE") throw new Error(`input.ref did not reject an occluded target: ${JSON.stringify(occluded)}`);
	resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: "document.querySelector('#smoke-cover')?.remove()" }), "uncover ref target");
	resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: "(()=>{const old=document.querySelector('#smoke-action');const next=document.createElement('button');next.id='danger-action';next.textContent='Danger';next.onclick=()=>{next.dataset.clicked='yes'};old.replaceWith(next);return true})()" }), "replace ref target");
	const staleInput = resultEnvelope(await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }), "stale input.ref");
	if (staleInput.code !== "BACKEND_NODE_STALE") throw new Error(`stale input.ref did not fail closed: ${JSON.stringify(staleInput)}`);
	const untouched = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, readOnly: true, script: "document.querySelector('#danger-action')?.dataset.clicked" }), "stale ref verification");
	if (untouched.result !== undefined && untouched.result !== "[undefined]") throw new Error(`stale input.ref clicked the replacement element: ${JSON.stringify(untouched)}`);
	const burst = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: "(()=>{let n=0;const timer=setInterval(()=>{document.documentElement.dataset.burst=String(++n);if(n===4)clearInterval(timer)},15);return true})()" }), "burst browser_execute");
	requireEffect(burst, "burst browser_execute");
	const popupUrl = `${fixture.url}popup`;
	const opened = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: `GM_openInTab('${popupUrl}')` }), "new-tab browser_execute");
	requireEffect(opened, "new-tab browser_execute", { newTabs: 1 });
	const popupStatus = await waitForStatus(daemon, (value) => Array.isArray(value.tabs) && value.tabs.some((item) => String(item?.url || "").startsWith(popupUrl)), "browser_execute new tab routing");
	const popup = popupStatus.tabs.find((item) => String(item?.url || "").startsWith(popupUrl));
	if (!popup?.targetRef) throw new Error(`new browser_execute tab was not routable: ${JSON.stringify(popupStatus.tabs)}`);
	resultEnvelope(await invoke(daemon, "browser_tabs", { action: "close", targetRef: popup.targetRef }), "browser_tabs close popup");
	const navigated = resultEnvelope(await invoke(daemon, "browser_execute", { targetRef, script: `location.href='${fixture.url}navigated'` }), "navigation browser_execute");
	const navigationEffect = requireEffect(navigated, "navigation browser_execute", { settled: false });
	if (!navigationEffect.page?.navigation) throw new Error(`navigation browser_execute did not report navigation: ${JSON.stringify(navigationEffect)}`);

	console.log(JSON.stringify({
		ok: true,
		browser: browser.executable,
		bridgePort: daemon.bridgePort,
		tabId,
			checks: ["extension-handshake", "tabs", "execute", "raw-cdp-auto-lifecycle", "tab-create-close", "background-cdp-effect", "browser-command-network-effect", "hook-auto-session", "visual-observe-resource", "visual-click-exact", "visual-drag", "visual-wheel", "visual-type", "visual-stale-rejected", "visual-auto", "canonical-observe", "direct-observe-content", "ref-execute", "ref-input-effect", "ref-semantic-mismatch-rejected", "ref-occlusion-rejected", "stale-ref-rejected", "burst-effect", "new-tab-effect", "navigation-effect"],
	}, null, 2));
} finally {
	await stopBrowser(browser?.child, browser?.profileDir);
	await daemon.close();
	await fixture.close();
	await removeProfileDir(profileDir);
}
