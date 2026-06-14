#!/usr/bin/env node
/**
 * Blind-eval STAGE launcher (Claude-driven standing harness; opt-in).
 *
 * Brings up a fully ISOLATED browser-pilot daemon + extension browser pointed at the local eval
 * fixtures, so a BLIND subagent can drive it through the real `browser-pilot` CLI without ever seeing
 * the operator's real browser:
 *   - dedicated daemon state dir (PI_BROWSER_DAEMON_STATE_DIR) + forced bridge port → its own
 *     user-local singleton, never the default ~/.pi daemon the human uses.
 *   - isolated --user-data-dir Chrome/Edge profile + patched extension copy on that port.
 *
 * It stays alive (the in-process fixture server keeps the event loop running) and writes
 * `.pi/browser-artifacts/eval-blind/stage.json`. Tear down with teardown-blind.mjs (kills by pid +
 * `daemon stop` on the isolated state dir). This script does NOT spawn agents — the operator
 * (the browser-pilot-blind-eval skill) does that against the stage.
 *
 * Usage:
 *   node evals/browser-workflows/launch-blind.mjs --confirm   [--keep-temp]
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { WebSocketServer } from "ws";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserLaunchHardeningArgs, chromePath, freePort, windowsPathForChrome } from "../../tests/support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../../tests/support/patchExtensionPort.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const evalRoot = path.join(root, "evals", "browser-workflows");
const fixturesRoot = path.join(evalRoot, "fixtures");
const outDir = path.join(root, ".pi", "browser-artifacts", "eval-blind");
const stagePath = path.join(outDir, "stage.json");
const tempRoot = path.join(root, ".pi", "temp-profiles");
const cliBin = path.join(root, "dist", "cli", "bin.js");
let latestStage;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function contentType(absPath) {
	const ext = path.extname(absPath).toLowerCase();
	if (ext === ".html") return "text/html; charset=utf-8";
	if (ext === ".js") return "text/javascript; charset=utf-8";
	if (ext === ".json" || ext === ".map") return "application/json; charset=utf-8";
	if (ext === ".txt" || ext === ".md" || ext === ".wat") return "text/plain; charset=utf-8";
	if (ext === ".wasm") return "application/wasm";
	return "application/octet-stream";
}
function noStore(ct) { return { "content-type": ct, "cache-control": "no-store" }; }
async function readBody(req, max = 64000) {
	const chunks = []; let total = 0;
	for await (const chunk of req) { total += chunk.length; if (total > max) throw new Error("body too large"); chunks.push(chunk); }
	return Buffer.concat(chunks).toString("utf8");
}
async function serveFixture(res, relPath) {
	const safeRel = relPath.replace(/^\/+/, "");
	const absPath = path.resolve(fixturesRoot, safeRel);
	if (!absPath.startsWith(fixturesRoot + path.sep) && absPath !== fixturesRoot) { res.writeHead(403, noStore("text/plain")); res.end("forbidden"); return; }
	if (!existsSync(absPath)) { res.writeHead(404, noStore("text/plain")); res.end("not found"); return; }
	res.writeHead(200, noStore(contentType(absPath)));
	createReadStream(absPath).pipe(res);
}

async function startFixtureServer() {
	const routeMap = JSON.parse(await readFile(path.join(fixturesRoot, "path-fuzz-routes.json"), "utf8"));
	const port = await freePort();
	const server = createHttpServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
			if (url.pathname === "/") { res.writeHead(302, { location: "/fixtures/article.html", "cache-control": "no-store" }); res.end(); return; }
			if (url.pathname.startsWith("/fixtures/")) { await serveFixture(res, decodeURIComponent(url.pathname.slice("/fixtures/".length))); return; }
			if (url.pathname === "/abml-frame-child.html") { await serveFixture(res, "abml-frame-child.html"); return; }
			if (url.pathname === "/api/echo") {
				const body = await readBody(req).catch((e) => JSON.stringify({ error: String(e?.message || e) }));
				res.writeHead(200, noStore("application/json")); res.end(JSON.stringify({ ok: true, method: req.method, item: url.searchParams.get("item"), body, fixture: "blind-eval" })); return;
			}
			if (url.pathname === "/api/search") {
				const id = url.searchParams.get("id"); const category = url.searchParams.get("category");
				res.writeHead(200, noStore("application/json")); res.end(JSON.stringify({ ok: true, id, category, rows: [{ id, title: "fixture book" }] })); return;
			}
			const fuzz = routeMap.routes?.[url.pathname];
			if (fuzz) { res.writeHead(Number(fuzz.status || 200), noStore("text/plain")); res.end(String(fuzz.body || "")); return; }
			res.writeHead(404, noStore("text/plain")); res.end("fallback");
		} catch (e) { res.writeHead(500, noStore("text/plain")); res.end(`fixture error: ${e instanceof Error ? e.message : String(e)}`); }
	});
	const wss = new WebSocketServer({ server, path: "/ws" });
	wss.on("connection", (socket) => { socket.send("ready:blind-eval-ws"); socket.on("message", (d) => socket.send(`ack:${String(d)}`)); });
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
	return { port, baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws` };
}

function cli(args, env) {
	const r = spawnSync(process.execPath, [cliBin, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
	return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}
async function waitUntil(fn, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) { const v = await fn(); if (v) return v; await delay(400); }
	return undefined;
}

async function writeStage(stage) {
	latestStage = { ...stage };
	await writeFile(stagePath, JSON.stringify(latestStage, null, 2), "utf8");
}

async function main() {
	if (!process.argv.includes("--confirm")) {
		console.error("refusing to launch without --confirm (starts an isolated browser). Usage: node evals/browser-workflows/launch-blind.mjs --confirm");
		process.exit(2);
	}
	await mkdir(outDir, { recursive: true });
	await mkdir(tempRoot, { recursive: true });

	const runId = `${Date.now()}-${process.pid}`;
	const usageLogPath = path.join(outDir, `usage-${runId}.jsonl`);
	const usageReportPath = path.join(outDir, `usage-${runId}-report.json`);
	const stateDir = path.join(tempRoot, `blind-state-${runId}`);
	const profileDir = path.join(tempRoot, `blind-profile-${runId}`);
	const extensionDir = path.join(tempRoot, `blind-extension-${runId}`);
	await mkdir(stateDir, { recursive: true });
	const env = { PI_BROWSER_DAEMON_STATE_DIR: stateDir, PI_BROWSER_USAGE_LOG: usageLogPath, PI_BROWSER_USAGE_RUN_ID: runId };

	const bridgePort = await freePort();
	const daemonEnv = { ...env, PI_BROWSER_BRIDGE_PORT: String(bridgePort), PI_BROWSER_BRIDGE_PORT_RANGE_END: String(bridgePort) };

	// Blind eval targets REAL sites by default (representative of production); local fixtures are
	// opt-in via --fixtures (deterministic regression seeding). --url sets the start page.
	const useFixtures = process.argv.includes("--fixtures");
	const urlFlagIdx = process.argv.indexOf("--url");
	const urlFlag = urlFlagIdx >= 0 ? process.argv[urlFlagIdx + 1] : undefined;
	let fixture;
	if (useFixtures) { fixture = await startFixtureServer(); console.error(`[blind] fixture server ${fixture.baseUrl}`); }
	const startUrl = urlFlag || (useFixtures ? `${fixture.baseUrl}/fixtures/article.html` : "about:blank");
	console.error(`[blind] start url ${startUrl}`);

	// Patch + stage the extension copy on the isolated bridge port.
	const extensionSource = path.resolve(process.env.PI_BROWSER_EVAL_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`extension source missing manifest.json: ${extensionSource}`);
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	const extensionPatch = await patchExtensionDistPort(extensionDir, bridgePort);
	Object.assign(env, extensionPatch.env);
	Object.assign(daemonEnv, extensionPatch.env);
	Object.assign(process.env, extensionPatch.env);

	// Auto-start the ISOLATED daemon + bind the bridge on our port (env is inherited by auto-start).
	const boot = cli(["tabs", "--action", "list", "--json"], daemonEnv);
	console.error(`[blind] daemon boot (expect NO_BROWSER_EXTENSION): code=${boot.code}`);
	const lock = await waitUntil(async () => {
		try { return JSON.parse(await readFile(path.join(stateDir, "browser-daemon.json"), "utf8")); } catch { return undefined; }
	}, 15000);
	if (!lock) throw new Error("isolated daemon lockfile did not appear");
	console.error(`[blind] isolated daemon pid=${lock.pid} controlPort=${lock.controlPort} bridgePort=${bridgePort}`);

	await writeStage({
		schemaVersion: 1,
		stageState: "daemon-started",
		startedAt: new Date().toISOString(),
		runId, stagePath, usageLogPath, usageReportPath,
		stateDir, bridgePort,
		startUrl,
		fixtures: useFixtures, fixturePort: fixture?.port, fixtureBaseUrl: fixture?.baseUrl, fixtureWsUrl: fixture?.wsUrl,
		daemonPid: lock.pid, launchPid: process.pid,
		profileDir, extensionDir,
		cliEnv: env,
		cliExample: `PI_BROWSER_DAEMON_STATE_DIR="${stateDir}" PI_BROWSER_USAGE_LOG="${usageLogPath}" PI_BROWSER_USAGE_RUN_ID="${runId}" node dist/cli/bin.js tabs --action list --json`,
	});

	// Launch the isolated browser pointed at the fixture root.
	const chromeExe = chromePath({ envNames: ["PI_BROWSER_EVAL_CHROME", "PI_BROWSER_SMOKE_CHROME"] });
	const child = spawn(chromeExe, [
		`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`,
		`--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`,
		`--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`,
		"--no-first-run", "--no-default-browser-check", ...browserLaunchHardeningArgs(),
		startUrl,
	], { stdio: ["ignore", "ignore", "ignore"], detached: true });
	child.unref();
	const browserPid = child.pid;
	console.error(`[blind] browser pid=${browserPid} (${path.basename(chromeExe)})`);
	await writeStage({ ...latestStage, stageState: "browser-started", browserPid });

	// Wait for OUR extension to connect and a tab to appear (the isolated daemon only ever lists our
	// own browser's tabs, so any tab here is ours — prefer the one matching the start URL host).
	const startHost = (() => { try { return new URL(startUrl).host; } catch { return ""; } })();
	const tab = await waitUntil(() => {
		const r = cli(["tabs", "--action", "list", "--json"], env);
		try {
			const parsed = JSON.parse(r.stdout);
			const arr = Array.isArray(parsed) ? parsed : (parsed.summary?.tabs || parsed.tabs || parsed.value || []);
			if (!arr.length) return undefined;
			return arr.find?.((t) => startHost && String(t.url || "").includes(startHost))
				|| arr.find?.((t) => String(t.url || "") && t.url !== "about:blank")
				|| arr[0];
		} catch { return undefined; }
	}, 30000);
	if (!tab?.tabId) throw new Error("no tab connected to the isolated daemon");

	const stage = {
		schemaVersion: 1,
		stageState: "ready",
		startedAt: new Date().toISOString(),
		runId, stagePath, usageLogPath, usageReportPath,
		stateDir, bridgePort,
		startUrl, currentUrl: tab.url,
		fixtures: useFixtures, fixturePort: fixture?.port, fixtureBaseUrl: fixture?.baseUrl, fixtureWsUrl: fixture?.wsUrl,
		tabId: tab.tabId, browserId: tab.browserId,
		daemonPid: lock.pid, browserPid, launchPid: process.pid,
		profileDir, extensionDir,
		// Env every blind-agent CLI call MUST carry so it only ever sees this isolated browser:
		cliEnv: env,
		cliExample: `PI_BROWSER_DAEMON_STATE_DIR="${stateDir}" PI_BROWSER_USAGE_LOG="${usageLogPath}" PI_BROWSER_USAGE_RUN_ID="${runId}" node dist/cli/bin.js tabs --action list --json`,
	};
	await writeStage(stage);
	console.error(`[blind] stage ready → ${path.relative(root, stagePath)}`);
	console.log(JSON.stringify({ ok: true, stagePath: path.relative(root, stagePath), ...stage }, null, 2));
	console.error("[blind] holding stage open (fixture server). Run teardown-blind.mjs to stop.");
	// The listening fixture server keeps the event loop alive; nothing else to do.
}

main().catch(async (e) => {
	const message = e instanceof Error ? e.message : String(e);
	if (latestStage) {
		await writeStage({ ...latestStage, stageState: "launch-failed", failedAt: new Date().toISOString(), failure: message }).catch(() => {});
	}
	console.error(`[blind] launch failed: ${message}`);
	process.exit(1);
});
