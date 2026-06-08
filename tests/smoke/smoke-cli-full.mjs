import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, stopProcessTree, windowsPathForChrome } from "../support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../support/patchExtensionPort.mjs";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(root, "cli", "bin.ts");
const resultPath = path.resolve(process.env.PI_BROWSER_CLI_FULL_RESULT_PATH || path.join(outDir, "smoke-cli-full-results.json"));
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));

const results = [];
const runId = String(Date.now());
let fixtureServer;
let browser;
let bridgePort;
let fixturePort;
let stateDir;
let profileDir;
let extensionDir;
let uploadPath;
let artifactPath;

function record(step, ok, data = {}) {
	const entry = { step, ok, ...data, t: Date.now() };
	results.push(entry);
	console.log(`${ok ? "✓" : "✗"} ${step}${data.note ? ` — ${data.note}` : ""}`);
	return entry;
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function compact(value, limit = 900) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function jsonLine(stdout) {
	const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
	if (lines.length !== 1) throw new Error(`expected exactly one JSON line, got ${lines.length}: ${compact(stdout)}`);
	return JSON.parse(lines[0]);
}

function runCli(args, options = {}) {
	const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
		cwd: options.cwd || root,
		env: {
			...process.env,
			PI_BROWSER_DAEMON_STATE_DIR: stateDir,
			PI_BROWSER_BRIDGE_PORT: String(bridgePort),
			PI_BROWSER_BRIDGE_PORT_RANGE_END: String(bridgePort),
			...(options.env || {}),
		},
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			stopProcessTree(child);
			resolve({ code: 124, stdout, stderr: `${stderr}\nCLI command timed out after ${options.timeoutMs || 60_000}ms`, timedOut: true });
		}, options.timeoutMs || 60_000);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, error });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, signal, stdout, stderr });
		});
	});
}

async function cliJson(args, options = {}) {
	const r = await runCli(args, options);
	let parsed;
	try {
		parsed = jsonLine(r.stdout);
	} catch (error) {
		return { ...r, parsedError: error instanceof Error ? error.message : String(error) };
	}
	return { ...r, json: parsed };
}

async function checkCliStep(step, args, options = {}) {
	const r = options.json === false ? await runCli(args, options) : await cliJson(args, options);
	let ok;
	let note;
	if (options.expectExit !== undefined) ok = r.code === options.expectExit;
	else ok = r.code === 0;
	if (options.json !== false) {
		ok = ok && !r.parsedError && (options.allowJsonOkFalse || r.json?.ok !== false);
		note = r.parsedError || `exit=${r.code}`;
	} else {
		note = `exit=${r.code}`;
	}
	if (ok && typeof options.expect === "function") {
		try {
			const expected = options.expect(r);
			ok = expected === true;
			if (!ok) note = typeof expected === "string" ? expected : "expectation failed";
		} catch (error) {
			ok = false;
			note = error instanceof Error ? error.message : String(error);
		}
	}
	record(step, ok, {
		note,
		args,
		exitCode: r.code,
		stdoutTail: r.stdout.slice(-1200),
		stderrTail: r.stderr.slice(-1200),
		...(r.json ? { jsonSummary: summarizeJson(r.json) } : {}),
	});
	return r;
}

function summarizeJson(json) {
	if (!json || typeof json !== "object") return json;
	return {
		ok: json.ok,
		command: json.command,
		name: json.name,
		toolName: json.toolName,
		exitCode: json.exitCode,
		code: json.code,
		valueKeys: json.value && typeof json.value === "object" ? Object.keys(json.value).slice(0, 12) : undefined,
		dataKeys: json.data && typeof json.data === "object" ? Object.keys(json.data).slice(0, 12) : undefined,
	};
}

function envelopeValue(json) {
	return json?.value ?? json?.data ?? json?.summary ?? json;
}

async function startFixture() {
	const port = await freePort();
	const server = createServer(async (req, res) => {
		const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
		if (url.pathname === "/api/data") {
			const body = JSON.stringify({ ok: true, items: [1, 2, 3], path: url.pathname, query: Object.fromEntries(url.searchParams) });
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(body);
			return;
		}
		if (url.pathname === "/api/echo") {
			let body = "";
			req.setEncoding("utf8");
			for await (const chunk of req) body += chunk;
			const response = JSON.stringify({ ok: true, method: req.method, body, headers: req.headers });
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(response);
			return;
		}
		if (url.pathname === "/sqli") {
			const q = url.searchParams.get("id") || "";
			const body = q.includes("'") ? "SQL syntax error near quote" : `item:${q || "1"}`;
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			res.end(body);
			return;
		}
		if (url.pathname === "/download.txt") {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": "attachment; filename=cli-full-download.txt", "cache-control": "no-store" });
			res.end("cli full download\n");
			return;
		}
		const html = `<!doctype html>
<html>
<head><title>CLI Full Smoke</title></head>
<body>
<main>
<h1 id="ready">CLI Full Smoke</h1>
<p class="article">Readable CLI full smoke article body.</p>
<form onsubmit="event.preventDefault()">
  <label>Query <input id="q" name="q" value="pi"></label>
  <input id="upload" type="file" onchange="document.querySelector('#status').textContent=this.files[0]?.name||'no-file'">
  <button id="go" type="button" onclick="document.querySelector('#status').textContent=document.querySelector('#q').value">Go</button>
</form>
<button id="download" type="button" onclick="location.href='/download.txt'">Download</button>
<button id="fetch" type="button" onclick="fetch('/api/data?from=button').then(r=>r.json()).then(j=>document.querySelector('#status').textContent='fetched:'+j.items.length)">Fetch</button>
<div id="status" role="status">idle</div>
<iframe id="child" srcdoc="<html><body><h2 id='child-ready'>Child Frame</h2><p>frame text</p></body></html>"></iframe>
<script>console.log('cli-full-console-marker'); window.__CLI_FULL__ = {ready:true};</script>
</main>
</body>
</html>`;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(html);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	return { server, port };
}

async function launchBrowser() {
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`extension source missing manifest.json: ${extensionSource}`);
	bridgePort = await freePort();
	stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-cli-full-daemon-"));
	profileDir = path.join(tempRoot, `cli-full-profile-${runId}`);
	extensionDir = path.join(tempRoot, `cli-full-extension-${runId}`);
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	await patchExtensionDistPort(extensionDir, bridgePort);
	const chromeExe = chromePath();
	const fixture = await startFixture();
	fixtureServer = fixture.server;
	fixturePort = fixture.port;
	const chromeArgs = [
		`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`,
		`--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`,
		`--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`,
		"--no-first-run",
		"--no-default-browser-check",
		...browserLaunchHardeningArgs(),
		`http://127.0.0.1:${fixturePort}/`,
	];
	browser = spawn(chromeExe, chromeArgs, { stdio: ["ignore", "pipe", "pipe"], detached: false });
	let stderr = "";
	browser.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
	record("environment.launch", true, { bridgePort, fixturePort, stateDir, profileDir, extensionDir, chrome: chromeExe, chromeArgs });
	await waitForCliExtension();
	record("environment.ready", true, { bridgePort, fixturePort, chromeStderrTail: stderr.slice(-1000) });
}

async function waitForCliExtension() {
	const deadline = Date.now() + 25_000;
	let last;
	const initialStatus = await checkCliStep("connection.status.initial", ["status", "--json"], { expect: (r) => r.json?.command === "status" && r.json?.ready === false });
	if (!initialStatus.json || initialStatus.json.ready !== false) throw new Error(`initial status did not prove not-ready state: ${compact(initialStatus.stdout)}`);
	const connected = await checkCliStep("connection.connect-wait", ["connect", "--wait", "--timeout-ms", "25000", "--json"], { timeoutMs: 30_000, expect: (r) => r.json?.ready === true && r.json?.extension?.connected === true });
	last = connected;
	while (Date.now() < deadline) {
		const statusReady = await cliJson(["status", "--json"], { timeoutMs: 10_000 });
		if (statusReady.code === 0 && !statusReady.parsedError && statusReady.json?.ready === true && statusReady.json?.extension?.connected === true) {
			record("connection.status.ready", true, { note: `exit=${statusReady.code}`, jsonSummary: summarizeJson(statusReady.json) });
			return;
		}
		const tabs = await cliJson(["tabs", "--action", "list", "--json"], { timeoutMs: 20_000 });
		last = tabs;
		const status = await cliJson(["status", "--json"], { timeoutMs: 10_000 });
		const extensionConnected = status.json?.extension?.connected === true;
		if (tabs.code === 0 && !tabs.parsedError && tabs.json?.ok !== false && extensionConnected) return;
		await delay(500);
	}
	throw new Error(`extension did not connect through CLI daemon: ${compact(last?.stdout || last?.stderr || last)}`);
}

async function cleanup() {
	try {
		if (stateDir && bridgePort) await runCli(["daemon", "stop", "--json"], { timeoutMs: 10_000 });
	} catch {}
	if (browser) stopBrowserProcess(browser);
	if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve)).catch(() => {});
	if (process.env.PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE !== "1" || results.every((r) => r.ok !== false)) {
		if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		if (extensionDir) await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
	}
	if (stateDir) await rm(stateDir, { recursive: true, force: true }).catch(() => {});
	stopProcessTree(browser);
}

async function main() {
	await mkdir(outDir, { recursive: true });
	artifactPath = path.join(outDir, `cli-full-artifact-${runId}.json`);
	uploadPath = path.join(outDir, `cli-full-upload-${runId}.txt`);
	await writeFile(artifactPath, JSON.stringify({ data: { content: "cli full artifact content", actionables: [{ id: "a1" }], list_hints: ["hint"] }, operation: { operationId: "op-cli-full" }, snapshot: { snapshotId: "snap-cli-full" } }, null, 2), "utf8");
	await writeFile(uploadPath, "cli full upload\n", "utf8");

	await checkCliStep("local.help", ["--help"], { json: false, expect: (r) => r.stdout.includes("Commands:") });
	const commands = await checkCliStep("local.commands-json", ["commands", "--json"], { expect: (r) => Array.isArray(r.json?.commands) && r.json.commands.length === 22 });
	const commandNames = commands.json.commands.map((cmd) => cmd.name);
	for (const name of commandNames) {
		await checkCliStep(`local.help.${name}`, [name, "--help"], { json: false, expect: (r) => r.stdout.includes(`pi-browser ${name}`) });
		await checkCliStep(`local.schema.${name}`, ["schema", name, "--json"], { expect: (r) => r.json?.toolName?.startsWith("browser_") });
	}
	for (const [cmd, sub] of [["wait", "selector"], ["network", "start"], ["frame", "evaluate"], ["hook", "install-targets"]]) {
		await checkCliStep(`local.schema.${cmd}.${sub}`, ["schema", cmd, sub, "--json"], { expect: (r) => r.json?.naturalSubcommand === sub });
	}
	await checkCliStep("local.validate.execute", ["validate", "execute", "--params", "{\"script\":\"1+1\"}", "--json"], { expect: (r) => r.json?.valid === true });
	await checkCliStep("local.validate.command.file", ["validate", "command", "--params", `@${artifactPath}`, "--json"], { allowJsonOkFalse: true, expectExit: 2 });

	await launchBrowser();

	const base = `http://127.0.0.1:${fixturePort}/`;
	const sqli = `http://127.0.0.1:${fixturePort}/sqli?id=1`;
	const rawRequest = `GET http://127.0.0.1:${fixturePort}/api/data?from=raw HTTP/1.1\r\nHost: 127.0.0.1:${fixturePort}\r\nConnection: close\r\n\r\n`;
	const commandFile = path.join(outDir, `cli-full-command-${runId}.json`);
	await writeFile(commandFile, JSON.stringify({ cmd: "tabs", method: "list" }), "utf8");
	const templateFile = path.join(outDir, `cli-full-template-${runId}.json`);
	await writeFile(templateFile, JSON.stringify({ id: "cli-full-template", paths: ["/api/data?from=template"], matchStatus: 200, bodyIncludes: "items" }), "utf8");

	await checkCliStep("daemon.status", ["daemon", "status", "--json"], { expect: (r) => r.json?.running === true });
	await checkCliStep("doctor", ["doctor", "--json"], { expect: (r) => r.json?.commandCount === 22 && r.json?.daemon?.extensionConnected === true });
	await checkCliStep("tabs.list", ["tabs", "--action", "list", "--json"]);
	const createdTab = await checkCliStep("tabs.create", ["tabs", "--action", "create", "--url", base, "--json"]);
	const tabId = findTabId(createdTab.json);
	await checkCliStep("wait.navigate", ["wait", "navigate", "--url", base, "--json"]);
	await checkCliStep("wait.load-state", ["wait", "load-state", "--json"]);
	await checkCliStep("wait.selector", ["wait", "selector", "--selector", "#ready", "--json"]);
	await checkCliStep("wait.network-idle", ["wait", "network-idle", "--json"]);
	await checkCliStep("observe.scan", ["observe", "--mode", "scan", "--json"]);
	await checkCliStep("observe.content", ["observe", "--mode", "content", "--selector", "main", "--json"]);
	await checkCliStep("observe.html", ["observe", "--mode", "html", "--selector", "main", "--json"]);
	await checkCliStep("execute.inline", ["execute", "--script", "document.querySelector('#q').value='cli-full';document.querySelector('#go').click();document.querySelector('#status').textContent", "--json"], { expect: (r) => JSON.stringify(r.json).includes("cli-full") });
	const scriptFile = path.join(outDir, `cli-full-script-${runId}.js`);
	await writeFile(scriptFile, "document.querySelector('#status').textContent='script-file-ok'; document.querySelector('#status').textContent", "utf8");
	await checkCliStep("execute.script-file", ["execute", "--script-file", scriptFile, "--json"], { expect: (r) => JSON.stringify(r.json).includes("script-file-ok") });
	await checkCliStep("command.escape-file", ["command", "--command", `@${commandFile}`, "--json"]);
	const frameList = await checkCliStep("frame.list", ["frame", "list", "--json"]);
	const frameId = findFrameId(frameList.json);
	await checkCliStep("frame.evaluate", ["frame", "evaluate", "--frame-id", frameId || "main", "--expression", "document.body.innerText", "--json"]);
	await checkCliStep("network.start", ["network", "start", "--session-id", "cli-full-net", "--params", "{\"captureBodies\":true,\"clear\":true}", "--json"]);
	await checkCliStep("execute.fetch", ["execute", "--script", "fetch('/api/data?from=network').then(r=>r.json()).then(j=>j.items.length)", "--json"]);
	await checkCliStep("network.wait", ["network", "wait", "--session-id", "cli-full-net", "--params", "{\"condition\":\"response\",\"urlContains\":\"/api/data\",\"timeoutMs\":5000}", "--json"]);
	await checkCliStep("network.list", ["network", "list", "--session-id", "cli-full-net", "--json"]);
	await checkCliStep("network.export-har", ["network", "export-har", "--session-id", "cli-full-net", "--json"]);
	await checkCliStep("network.stop", ["network", "stop", "--session-id", "cli-full-net", "--json"]);
	await checkCliStep("hook.list-targets", ["hook", "list-targets", ...(tabId ? ["--tab-id", String(tabId)] : []), "--json"]);
	await checkCliStep("hook.install-targets", ["hook", "install-targets", "--session-id", "cli-full-hook", "--targets", "error", "--json"]);
	await checkCliStep("hook.status", ["hook", "status", "--session-id", "cli-full-hook", "--json"]);
	await checkCliStep("execute.console-error", ["execute", "--script", "console.error('cli-full-hook-error'); 'hooked'", "--json"]);
	await checkCliStep("hook.collect", ["hook", "collect", "--session-id", "cli-full-hook", "--json"]);
	await checkCliStep("hook.performance", ["hook", "performance", "--json"]);
	await checkCliStep("hook.uninstall", ["hook", "uninstall", "--session-id", "cli-full-hook", "--json"]);
	await checkCliStep("evidence", ["evidence", "--json"]);
	await checkCliStep("screenshot", ["screenshot", "--json"]);
	await checkCliStep("upload", ["upload", "--selector", "#upload", "--files", uploadPath, "--confirm", "--json"]);
	await checkCliStep("download.url", ["download", "--url", `${base}download.txt`, "--mode", "url", "--filename", `cli-full-download-${runId}.txt`, "--json"]);
	await checkCliStep("artifact.json", ["artifact", "--path", artifactPath, "--mode", "json", "--json-path", "data.content", "--json"], { expect: (r) => JSON.stringify(r.json).includes("cli full artifact") });
	await checkCliStep("artifact.search", ["artifact", "--path", artifactPath, "--mode", "search", "--query", "operationId", "--json"]);
	await checkCliStep("memory.validate", ["memory", "--action", "validate", "--kind", "fact", "--scope-kind", "task", "--scope-key", "cli-full", "--title", "CLI full fact", "--triggers", "cli-full", "--body", "CLI full smoke memory fact.", "--json"]);
	const memoryRecord = await checkCliStep("memory.record", ["memory", "--action", "record", "--kind", "fact", "--scope-kind", "task", "--scope-key", "cli-full", "--title", "CLI full fact", "--triggers", "cli-full", "--body", "CLI full smoke memory fact.", "--json"]);
	await checkCliStep("memory.recall", ["memory", "--action", "recall", "--scope-kind", "task", "--scope-key", "cli-full", "--query", "cli-full", "--json"]);
	const memoryId = findMemoryId(memoryRecord.json);
	if (memoryId) await checkCliStep("memory.read", ["memory", "--action", "read", "--id", memoryId, "--mode", "text", "--json"]);
	else record("memory.read", false, { note: "could not extract memory id" });
	await checkCliStep("callback-oast.start", ["callback-oast", "--action", "start", "--session-id", "cli-full-oast", "--port", "0", "--json"]);
	await checkCliStep("callback-oast.trigger", ["callback-oast", "--action", "trigger", "--session-id", "cli-full-oast", "--body", "cli-full-oast", "--trigger-timeout-ms", "3000", "--json"]);
	await checkCliStep("callback-oast.collect", ["callback-oast", "--action", "collect", "--session-id", "cli-full-oast", "--json"]);
	await checkCliStep("callback-oast.stop", ["callback-oast", "--action", "stop", "--session-id", "cli-full-oast", "--json"]);
	await checkCliStep("cookie-analyze.jwt", ["cookie-analyze", "--jwt", fixtureJwt(), "--secret-candidates", "secret", "--json"]);
	await checkCliStep("crawl.fingerprint", ["crawl", "--url", base, "--action", "fingerprint", "--json"]);
	await checkCliStep("fuzz.path", ["fuzz", "--url", base, "--mode", "path", "--wordlist", "api/data,missing", "--json"]);
	await checkCliStep("http-replay.raw", ["http-replay", "--raw-request", rawRequest, "--json"]);
	await checkCliStep("sqli.probe", ["sqli", "--url", sqli, "--probe-types", "error", "--json"]);
	await checkCliStep("template.builtin-file", ["template", "--url", base, "--template-path", templateFile, "--json"]);
	await checkCliStep("selftest", ["selftest", "--confirm", "--json"]);
	await checkCliStep("pick.overlay", ["pick", "--message", "CLI full smoke picker overlay", "--json"], { json: false, timeoutMs: 5_000, expectExit: 124 });

	await checkCliStep("daemon.stop", ["daemon", "stop", "--json"]);
}

function findFrameId(json) {
	const text = JSON.stringify(json);
	const match = /"frameId"\s*:\s*"([^"]+)"/.exec(text);
	return match?.[1];
}

function findTabId(json) {
	const text = JSON.stringify(json);
	const match = /"tabId"\s*:\s*(\d+)/.exec(text);
	return match ? Number(match[1]) : undefined;
}

function findMemoryId(json) {
	const text = JSON.stringify(json);
	const match = /"id"\s*:\s*"([^"]+)"/.exec(text);
	return match?.[1];
}

function fixtureJwt() {
	return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoidXNlciIsInN1YiI6ImNsaS1mdWxsIn0.mA7esrqVXJKtIkU1Hw9g-Tv6mYd4ZJXJ2cXPxfpfgzc";
}

try {
	await main();
} catch (error) {
	record("fatal", false, { note: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
} finally {
	const ok = results.length > 0 && results.every((entry) => entry.ok !== false);
	await cleanup();
	await writeFile(resultPath, JSON.stringify({ ok, runId, bridgePort, fixturePort, resultPath, commandCount: results.length, failed: results.filter((entry) => entry.ok === false), results }, null, 2), "utf8");
	console.log(JSON.stringify({ ok, resultPath, commandCount: results.length, failed: results.filter((entry) => entry.ok === false).map((entry) => entry.step) }, null, 2));
	process.exitCode = ok ? 0 : 1;
}

