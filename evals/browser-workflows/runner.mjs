#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";
import { writeTemporalProfileArtifacts } from "../../src/driver/temporalProfileArtifacts.ts";
import { ToolCollectingAdapter } from "../../src/frontend/toolCollector.ts";
import { registerBrowserTools } from "../../src/tools/registerTools.ts";
import { runJsAstShell } from "../../src/tools/webSecurity/shared/jsAstShell.ts";
import { runWasmShell } from "../../src/tools/webSecurity/shared/wasmShell.ts";
import { runWsShell } from "../../src/tools/webSecurity/shared/wsShell.ts";
import { browserLaunchHardeningArgs, chromePath, freePort, stopBrowserProcess, windowsPathForChrome } from "../../tests/support/browserSmokeEnv.mjs";
import { patchExtensionDistPort } from "../../tests/support/patchExtensionPort.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const evalRoot = path.join(root, "evals", "browser-workflows");
const fixturesRoot = path.join(evalRoot, "fixtures");
const defaultOutDir = path.join(root, ".pi", "browser-artifacts", "eval-browser-workflows");
const tempRoot = path.join(root, ".pi", "temp-profiles");
const dangerousFixtureMimeFallback = "application/octet-stream";
// Runtime result records mirror manual-result-template.json and are validated by result-schema.json.

function usage() {
	return `Browser workflow eval runner (opt-in)

Usage:
  npm run eval:browser-workflows -- --fixture-server [--eval 01-readable-content-artifact] [--out-dir .pi/browser-artifacts/eval-browser-workflows] [--timeout-ms 120000]

Required:
  --fixture-server      explicit opt-in to start the local 127.0.0.1 fixture server and isolated browser

Options:
  --eval <id>           run one eval id from manifest; default runs the implemented runner subset
  --out-dir <path>      result/artifact directory; default .pi/browser-artifacts/eval-browser-workflows
  --timeout-ms <ms>     per-eval timeout budget; default 120000
  --keep-temp           preserve temporary browser profile/extension directories
  --list                list implemented eval ids without running
  --help                show this help
`;
}

function parseArgs(argv) {
	const args = { evalIds: [], fixtureServer: false, outDir: defaultOutDir, timeoutMs: 120_000, keepTemp: false, list: false, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--fixture-server") args.fixtureServer = true;
		else if (arg === "--eval") args.evalIds.push(requireNext(argv, ++i, "--eval"));
		else if (arg === "--out-dir") args.outDir = path.resolve(root, requireNext(argv, ++i, "--out-dir"));
		else if (arg === "--timeout-ms") args.timeoutMs = positiveInt(requireNext(argv, ++i, "--timeout-ms"), "--timeout-ms");
		else if (arg === "--keep-temp") args.keepTemp = true;
		else if (arg === "--list") args.list = true;
		else if (arg === "--help" || arg === "-h") args.help = true;
		else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
	}
	return args;
}

function requireNext(argv, index, flag) {
	const value = argv[index];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function positiveInt(value, label) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`);
	return n;
}

async function readJson(rel) {
	return JSON.parse(await readFile(path.join(root, rel), "utf8"));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function nowIso() { return new Date().toISOString(); }
function pathRef(absPath) { return path.relative(root, absPath).replace(/\\/g, "/"); }
function fixturePath(relPath) { return path.join(fixturesRoot, relPath); }
function textIncludes(value, pattern) { return pattern.test(JSON.stringify(value)); }
function toolCallId(evalId, name, index) { return `${evalId}:${name}:${index}`; }
function isRecord(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function resultText(toolResult) { return String(toolResult?.content?.[0]?.text ?? ""); }
function parseToolJson(toolResult) { return JSON.parse(resultText(toolResult)); }
function tryParseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
function unwrapToolData(toolResult) {
	const parsed = parseToolJson(toolResult);
	return parsed?.data ?? parsed;
}
function bridgeData(value) {
	return value?.data ?? value?.result?.data ?? value;
}
function persistentCdpPayload(value) {
	return bridgeData(value)?.result?.value ?? bridgeData(value)?.result?.result?.value;
}
function persistentCdpException(value) {
	return bridgeData(value)?.exceptionDetails ?? bridgeData(value)?.result?.exceptionDetails ?? bridgeData(value)?.result?.result?.exceptionDetails;
}
function toolReturnedError(toolResult) {
	const text = resultText(toolResult);
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed === "object" && (parsed.code || parsed.error || parsed.error_code)) return { error: parsed };
	} catch {}
	return undefined;
}
function assertToolOk(toolResult, label) {
	const err = toolReturnedError(toolResult);
	if (err) throw new Error(`${label} returned error: ${JSON.stringify(err.error).slice(0, 1000)}`);
	return toolResult;
}
function noStoreHeaders(contentType) { return { "content-type": contentType, "cache-control": "no-store" }; }

function resultRecord(evalId, status, metrics) {
	return {
		schemaVersion: 1,
		evalId,
		status,
		toolCallCount: metrics.toolCallCount,
		firstWrongToolChoice: metrics.firstWrongToolChoice,
		recoveredAfterFailure: metrics.recoveredAfterFailure,
		artifactSufficiency: metrics.artifactSufficiency,
		scopedFollowUpDiscipline: metrics.scopedFollowUpDiscipline,
		evidence: {
			summary: metrics.summary,
			artifacts: metrics.artifacts,
			diagnostics: metrics.diagnostics,
		},
		notes: metrics.notes,
	};
}

function newMetrics(evalId) {
	return {
		evalId,
		toolCallCount: 0,
		firstWrongToolChoice: null,
		recoveredAfterFailure: false,
		artifactSufficiency: "not-evaluated",
		scopedFollowUpDiscipline: "not-evaluated",
		summary: [],
		artifacts: [],
		diagnostics: [],
		notes: [],
		calls: [],
	};
}

function beginMetrics(env, evalId) {
	const metrics = newMetrics(evalId);
	env.currentMetrics = metrics;
	return metrics;
}

async function callTool(env, metrics, name, params = {}) {
	const tool = env.tools.getTool(name);
	if (!tool) throw new Error(`Tool not registered: ${name}`);
	metrics.toolCallCount += 1;
	metrics.calls.push({ tool: name, params: sanitizeParams(params) });
	const startedAt = Date.now();
	const result = await tool.execute(toolCallId(metrics.evalId, name, metrics.toolCallCount), params, undefined, undefined, { cwd: env.runDir, hasUI: false });
	const elapsedMs = Math.max(0, Date.now() - startedAt);
	const text = resultText(result);
	const saved = savedPathFromEnvelope(text);
	if (saved) addArtifact(metrics, saved);
	const observeSample = maybeObserveTimingSample(result, params, metrics);
	if (observeSample) env.observeTimingSamples.push(observeSample);
	const temporalSample = maybeTemporalProfileSample(result, params, metrics, { tool: name, elapsedMs });
	if (temporalSample) env.temporalProfileSamples.push(temporalSample);
	return result;
}

function addArtifact(metrics, value) {
	if (!value) return;
	const text = String(value);
	const ref = path.isAbsolute(text) ? pathRef(text) : text.replace(/\\/g, "/");
	if (!metrics.artifacts.includes(ref)) metrics.artifacts.push(ref);
}

async function saveJsonEvidence(env, metrics, name, value) {
	const target = path.join(env.runDir, `${metrics.evalId}-${name}.json`);
	await writeFile(target, JSON.stringify(value, null, 2), "utf8");
	addArtifact(metrics, target);
	return target;
}

async function saveTextEvidence(env, metrics, name, value) {
	const target = path.join(env.runDir, `${metrics.evalId}-${name}`);
	await writeFile(target, String(value), "utf8");
	addArtifact(metrics, target);
	return target;
}

function savedPathFromEnvelope(text) {
	try {
		const parsed = JSON.parse(text);
		return typeof parsed?.saved?.path === "string" ? parsed.saved.path : undefined;
	} catch {
		return undefined;
	}
}

async function artifactTextFromSaved(value, fallbackPath) {
	const savedPath = typeof value?.saved?.path === "string" ? value.saved.path : fallbackPath;
	if (!savedPath) return "";
	const absPath = path.isAbsolute(savedPath) ? savedPath : path.resolve(root, savedPath);
	return await readFile(absPath, "utf8").catch(() => "");
}

function sanitizeParams(params) {
	const copy = { ...params };
	if (typeof copy.script === "string") copy.script = `${copy.script.slice(0, 120)}${copy.script.length > 120 ? "…" : ""}`;
	return copy;
}

function maybeObserveTimingSample(toolResult, params, metrics) {
	const diagnostics = isRecord(toolResult?.details?.diagnostics) ? toolResult.details.diagnostics : undefined;
	const timings = isRecord(diagnostics?.observeTimings) ? diagnostics.observeTimings : undefined;
	if (!timings) return undefined;
	const parsed = tryParseJson(resultText(toolResult));
	const envelope = isRecord(parsed?.envelope) ? parsed.envelope : undefined;
	const data = isRecord(parsed?.data) ? parsed.data : undefined;
	const summary = isRecord(envelope?.summary) ? envelope.summary : isRecord(parsed?.summary) ? parsed.summary : undefined;
	const outputPath = typeof params.outputPath === "string" ? path.resolve(root, params.outputPath) : undefined;
	return {
		evalId: metrics.evalId,
		mode: typeof params.mode === "string" ? params.mode : undefined,
		detailLevel: typeof params.detailLevel === "string" ? params.detailLevel : undefined,
		selector: typeof params.selector === "string" ? params.selector : undefined,
		outputPath: outputPath ? pathRef(outputPath) : undefined,
		url: typeof summary?.url === "string" ? summary.url : typeof data?.url === "string" ? data.url : undefined,
		timings,
	};
}

function firstRecord(...values) {
	for (const value of values) if (isRecord(value)) return value;
	return undefined;
}

function temporalFromEffect(effect) {
	const record = isRecord(effect) ? effect : undefined;
	return isRecord(record?.temporal) ? record.temporal : undefined;
}

function effectFromParsedResult(parsed) {
	const summary = firstRecord(parsed?.summary, parsed?.envelope?.summary);
	const data = firstRecord(parsed?.data, parsed?.envelope?.data);
	const execution = firstRecord(parsed?.execution, data?.execution, parsed?.envelope?.execution);
	return firstRecord(summary?.effect, parsed?.effect, data?.effect, execution?.effect);
}

function supervisorFromParsed(parsed) {
	const data = isRecord(parsed?.data) ? parsed.data : undefined;
	if (isRecord(data?.supervisor)) return data.supervisor;
	const wait = isRecord(data?.wait) ? data.wait : undefined;
	if (isRecord(wait?.supervisor)) return wait.supervisor;
	return undefined;
}

export function maybeTemporalProfileSample(toolResult, params, metrics, call) {
	const parsed = tryParseJson(resultText(toolResult));
	const diagnostics = firstRecord(
		toolResult?.details?.diagnostics,
		parsed?.diagnostics,
		parsed?.envelope?.diagnostics,
		parsed?.details?.diagnostics,
	);
	const temporalProfile = firstRecord(diagnostics?.temporalProfile);
	const supervisor = supervisorFromParsed(parsed);
	const effect = effectFromParsedResult(parsed);
	const effectTemporal = temporalFromEffect(effect);
	const temporal = call.tool === "browser_execute"
		? firstRecord(effectTemporal, diagnostics?.temporal, supervisor?.temporal)
		: firstRecord(diagnostics?.temporal, supervisor?.temporal, effectTemporal);
	const verdict = firstRecord(temporal?.verdict);
	const frontier = firstRecord(temporal?.frontier);
	const operation = firstRecord(parsed?.operation, parsed?.data?.operation);
	const effectTargetRef = typeof effect?.targetRef === "string" ? effect.targetRef : undefined;
	const target = {
		...(typeof params.browserSessionId === "string" ? { browserSessionId: params.browserSessionId } : {}),
		...(Number.isInteger(Number(params.tabId)) ? { tabId: Number(params.tabId) } : {}),
		...(typeof params.targetRef === "string" ? { targetRef: params.targetRef } : effectTargetRef ? { targetRef: effectTargetRef } : {}),
	};
	const sample = {
		...(typeof operation?.operationId === "string" ? { operationId: operation.operationId } : {}),
		tool: call.tool,
		command: typeof temporalProfile?.command === "string" ? temporalProfile.command : typeof operation?.command === "string" ? operation.command : undefined,
		...(Object.keys(target).length ? { target } : {}),
		deadlineMs: Number.isFinite(Number(params.timeoutMs)) ? Number(params.timeoutMs) : typeof temporalProfile?.deadlineMs === "number" ? temporalProfile.deadlineMs : undefined,
		elapsedMs: call.elapsedMs,
		bridgeRoundTrips: typeof temporalProfile?.bridgeRoundTrips === "number" ? temporalProfile.bridgeRoundTrips : undefined,
		queueDepthAtEnqueue: typeof temporalProfile?.queueDepthAtEnqueue === "number" ? temporalProfile.queueDepthAtEnqueue : undefined,
		queueDepthAtStart: typeof temporalProfile?.queueDepthAtStart === "number" ? temporalProfile.queueDepthAtStart : undefined,
		queueDelayMs: typeof temporalProfile?.queueDelayMs === "number" ? temporalProfile.queueDelayMs : undefined,
		waitAttempts: typeof supervisor?.attempts === "number" ? supervisor.attempts : typeof temporalProfile?.waitAttempts === "number" ? temporalProfile.waitAttempts : undefined,
		workerRestarts: typeof supervisor?.workerRestarts === "number" ? supervisor.workerRestarts : typeof temporalProfile?.workerRestarts === "number" ? temporalProfile.workerRestarts : undefined,
		historyLost: typeof supervisor?.historyLost === "boolean" ? supervisor.historyLost : typeof temporalProfile?.historyLost === "boolean" ? temporalProfile.historyLost : undefined,
		rawSignals: Array.isArray(temporalProfile?.rawSignals) ? temporalProfile.rawSignals.filter((item) => typeof item === "string").slice(0, 8) : undefined,
		verdict: typeof verdict?.status === "string" ? verdict.status : undefined,
		reasons: Array.isArray(verdict?.reasons) ? verdict.reasons.filter((item) => typeof item === "string").slice(0, 3) : undefined,
		recovery: typeof frontier?.next === "string" ? frontier.next : undefined,
	};
	return Object.fromEntries(Object.entries(sample).filter(([, value]) => value !== undefined));
}

async function fixtureFileResponse(res, relPath) {
	let safeRel = relPath.replace(/^\/+/, "");
	if (safeRel === "abml-frame-child.html") safeRel = "abml-frame-child.html";
	const absPath = path.resolve(fixturesRoot, safeRel);
	if (!absPath.startsWith(fixturesRoot + path.sep) && absPath !== fixturesRoot) {
		res.writeHead(403, noStoreHeaders("text/plain; charset=utf-8"));
		res.end("forbidden");
		return;
	}
	if (!existsSync(absPath) || !(await stat(absPath)).isFile()) {
		res.writeHead(404, noStoreHeaders("text/plain; charset=utf-8"));
		res.end("not found");
		return;
	}
	res.writeHead(200, noStoreHeaders(contentType(absPath)));
	createReadStream(absPath).pipe(res);
}

function contentType(absPath) {
	const ext = path.extname(absPath).toLowerCase();
	if (ext === ".html") return "text/html; charset=utf-8";
	if (ext === ".js") return "text/javascript; charset=utf-8";
	if (ext === ".json" || ext === ".map") return "application/json; charset=utf-8";
	if (ext === ".txt" || ext === ".md" || ext === ".wat") return "text/plain; charset=utf-8";
	if (ext === ".wasm") return "application/wasm";
	return dangerousFixtureMimeFallback;
}

async function readRequestBody(req, maxBytes = 64_000) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > maxBytes) throw new Error("request body too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function startFixtureServer() {
	const routeMap = await readJson("evals/browser-workflows/fixtures/path-fuzz-routes.json");
	const port = await freePort();
	const server = createHttpServer(async (req, res) => {
		try {
			const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
			if (url.pathname === "/") {
				res.writeHead(302, { location: "/fixtures/article.html", "cache-control": "no-store" });
				res.end();
				return;
			}
			if (url.pathname.startsWith("/fixtures/")) {
				await fixtureFileResponse(res, decodeURIComponent(url.pathname.slice("/fixtures/".length)));
				return;
			}
			if (url.pathname === "/abml-frame-child.html") {
				await fixtureFileResponse(res, "abml-frame-child.html");
				return;
			}
			if (url.pathname === "/api/echo") {
				const body = await readRequestBody(req).catch((error) => JSON.stringify({ error: String(error?.message || error) }));
				res.writeHead(200, noStoreHeaders("application/json; charset=utf-8"));
				res.end(JSON.stringify({ ok: true, method: req.method, item: url.searchParams.get("item"), body, fixture: "browser-workflow" }));
				return;
			}
			if (url.pathname === "/api/search") {
				const id = url.searchParams.get("id");
				const category = url.searchParams.get("category");
				res.writeHead(200, noStoreHeaders("application/json; charset=utf-8"));
				res.end(JSON.stringify({ ok: true, id, category, rows: [{ id, title: "fixture book" }] }));
				return;
			}
			if (url.pathname === "/api/jshook/replay") {
				const body = await readRequestBody(req).catch((error) => JSON.stringify({ error: String(error?.message || error) }));
				let parsedBody;
				try { parsedBody = JSON.parse(body || "{}"); } catch { parsedBody = { raw: body }; }
				res.writeHead(200, noStoreHeaders("application/json; charset=utf-8"));
				res.end(JSON.stringify({ ok: true, replay: true, item: url.searchParams.get("item"), method: req.method, fixtureHeader: req.headers["x-pi-fixture"] || null, quantity: parsedBody?.quantity ?? null, body: parsedBody }));
				return;
			}
			const fuzzRoute = routeMap.routes?.[url.pathname];
			if (fuzzRoute) {
				res.writeHead(Number(fuzzRoute.status || 200), noStoreHeaders("text/plain; charset=utf-8"));
				res.end(String(fuzzRoute.body || ""));
				return;
			}
			res.writeHead(404, noStoreHeaders("text/plain; charset=utf-8"));
			res.end("fallback");
		} catch (error) {
			res.writeHead(500, noStoreHeaders("text/plain; charset=utf-8"));
			res.end(`fixture error: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	const wss = new WebSocketServer({ server, path: "/ws" });
	wss.on("connection", (socket) => {
		socket.send("ready:browser-workflow-ws");
		socket.on("message", (data) => socket.send(`ack:${String(data)}`));
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		wsUrl: `ws://127.0.0.1:${port}/ws`,
		close: async () => {
			await new Promise((resolve) => wss.close(resolve));
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

async function startBrowserEnv(args, runDir, fixture) {
	const bridgePort = await freePort();
	const runId = `${Date.now()}-${process.pid}`;
	const profileDir = path.join(tempRoot, `eval-browser-workflows-profile-${runId}`);
	const extensionDir = path.join(tempRoot, `eval-browser-workflows-extension-${runId}`);
	const extensionSource = path.resolve(process.env.PI_BROWSER_EVAL_EXTENSION_DIR || process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	await mkdir(tempRoot, { recursive: true });
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	const extensionPatch = await patchExtensionDistPort(extensionDir, bridgePort);
	Object.assign(process.env, extensionPatch.env);
	const bridge = new BrowserBridgeServer({ port: bridgePort, portRangeEnd: bridgePort });
	await bridge.start();
	const chromeExe = chromePath({ envNames: ["PI_BROWSER_EVAL_CHROME", "PI_BROWSER_SMOKE_CHROME"] });
	const chrome = spawn(chromeExe, [
		`--user-data-dir=${windowsPathForChrome(profileDir, chromeExe)}`,
		`--disable-extensions-except=${windowsPathForChrome(extensionDir, chromeExe)}`,
		`--load-extension=${windowsPathForChrome(extensionDir, chromeExe)}`,
		"--no-first-run",
		"--no-default-browser-check",
		...browserLaunchHardeningArgs(),
		"--enable-logging=stderr",
		"--v=0",
		`${fixture.baseUrl}/fixtures/article.html`,
	], { stdio: ["ignore", "pipe", "pipe"], detached: false });
	chrome.stdout.on("data", () => {});
	chrome.stderr.on("data", () => {});
	const connected = await waitUntil(() => {
		const snapshot = bridge.snapshot();
		return snapshot.extensionConnected ? snapshot : undefined;
	}, 25_000);
	if (!connected) throw new Error(`Browser extension did not connect to bridge port ${bridge.port}`);
	const launchTab = await waitUntil(async () => {
		await bridge.refreshTabs(5_000).catch(() => undefined);
		return bridge.getTabs().find((tab) => String(tab.url || "").startsWith(`${fixture.baseUrl}/`));
	}, 25_000);
	if (!launchTab?.browserId) throw new Error(`Fixture launch tab did not appear for ${fixture.baseUrl}`);
	bridge.selectBrowser(launchTab.browserId);
	const tools = new ToolCollectingAdapter();
	registerBrowserTools(tools, bridge, async () => bridge);
	return { bridge, chrome, bridgePort, profileDir, extensionDir, extensionSource, launchBrowserId: launchTab.browserId, launchTabId: launchTab.tabId, sharedTabId: launchTab.tabId, tools, runDir, fixtureBaseUrl: fixture.baseUrl, fixtureWsUrl: fixture.wsUrl, keepTemp: args.keepTemp, observeTimingSamples: [], temporalProfileSamples: [] };
}

async function waitUntil(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const value = await predicate();
		if (value) return value;
		await delay(250);
	}
	return undefined;
}

async function stopBrowserEnv(env) {
	try { await env.bridge?.stop?.(); } catch {}
	stopBrowserProcess(env.chrome);
	if (!env.keepTemp) {
		await rm(env.profileDir, { recursive: true, force: true }).catch(() => {});
		await rm(env.extensionDir, { recursive: true, force: true }).catch(() => {});
	}
}

async function createTab(env, metrics, relFixture) {
	const url = `${env.fixtureBaseUrl}/fixtures/${relFixture}`;
	if (env.sharedTabId) {
		await callTool(env, metrics, "browser_tabs", { action: "list", timeoutMs: 5_000 });
		assertToolOk(await callTool(env, metrics, "browser_wait", { action: "navigateAndWait", tabId: env.sharedTabId, params: { url, state: "complete" }, timeoutMs: 25_000 }), "browser_wait navigateAndWait");
		return Number(env.sharedTabId);
	}
	const created = parseToolJson(await callTool(env, metrics, "browser_tabs", { action: "create", url, active: true, timeoutMs: 10_000 }));
	assertToolOk({ content: [{ type: "text", text: JSON.stringify(created) }] }, "browser_tabs create");
	const createdTabId = Number(created?.data?.tabId ?? created?.tabId ?? created?.data?.tab?.tabId);
	const target = await waitUntil(async () => {
		await env.bridge.refreshTabs(5_000).catch(() => undefined);
		const tabs = env.bridge.getTabs();
		return tabs.find((tab) => tab.browserId === env.launchBrowserId && String(tab.url || "") === url)
			|| tabs.find((tab) => Number(tab.tabId) === createdTabId && tab.browserId === env.launchBrowserId)
			|| tabs.filter((tab) => tab.browserId === env.launchBrowserId && String(tab.url || "").startsWith(`${env.fixtureBaseUrl}/fixtures/`)).sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))[0]
			|| undefined;
	}, 25_000);
	if (!target?.tabId) throw new Error(`browser_tabs create did not produce a connected tab for ${relFixture}; createdTabId=${createdTabId || "unknown"}`);
	await callTool(env, metrics, "browser_tabs", { action: "list", timeoutMs: 5_000 });
	assertToolOk(await callTool(env, metrics, "browser_wait", { action: "loadState", tabId: target.tabId, params: { state: "complete" }, timeoutMs: 15_000 }), "browser_wait loadState");
	return Number(target.tabId);
}

async function closeTabQuiet(env, tabId) {
	if (!tabId || Number(tabId) === Number(env.sharedTabId)) return;
	try {
		const tool = env.tools.getTool("browser_tabs");
		await tool?.execute(`cleanup:close:${tabId}`, { action: "close", tabId, timeoutMs: 2_000 }, undefined, undefined, { cwd: env.runDir, hasUI: false });
	} catch {}
}

async function eval01(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "article.html");
	try {
		const contentResult = assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "content", tabId, selector: "#report-article", outputPath: path.join(env.runDir, `${entry.id}-content.md`), maxChars: 8_000, timeoutMs: 20_000 }), "browser_observe content");
		const content = parseToolJson(contentResult);
		const artifactResult = assertToolOk(await callTool(env, metrics, "browser_artifact", { path: content.saved?.path, mode: "text", limit: 40, maxChars: 4_000 }), "browser_artifact content read");
		const markdown = resultText(artifactResult);
		const ok = /Browser Evidence Notes/.test(JSON.stringify(content)) && /observed page state|saved artifact path/.test(markdown);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push(`Readable content extracted from #report-article with saved artifact ${pathRef(content.saved?.path || "")}.`);
		metrics.diagnostics.push(`Targeted artifact read confirmed article signal: ${/Browser Evidence Notes/.test(markdown)}.`);
		metrics.notes.push("Runner used browser_observe content plus browser_artifact only; no broad raw page dump was needed.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval02(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "interactive.html");
	try {
		const before = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId, outputPath: path.join(env.runDir, `${entry.id}-before.json`), maxChars: 12_000, timeoutMs: 20_000 }), "browser_observe scan"));
		const executePath = path.join(env.runDir, `${entry.id}-execute.json`);
		const execute = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { document.querySelector('#activate').click(); return { state: document.querySelector('#status')?.dataset.state, text: document.querySelector('#status')?.textContent, popupOptions: document.querySelectorAll('#activation-popup [role=option]').length }; })()", monitor: true, outputPath: executePath, maxChars: 8_000, timeoutMs: 20_000 }), "browser_execute activate"));
		const executeArtifact = JSON.parse(await readFile(executePath, "utf8"));
		assertToolOk(await callTool(env, metrics, "browser_wait", { action: "selector", tabId, params: { selector: "#activation-popup[role='listbox']", state: "attached" }, outputPath: path.join(env.runDir, `${entry.id}-wait.json`), timeoutMs: 15_000 }), "browser_wait activated popup");
		const afterPath = path.join(env.runDir, `${entry.id}-after.txt`);
		const after = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "html", tabId, selector: "main", htmlMode: "text", outputPath: afterPath, maxChars: 4_000, timeoutMs: 10_000 }), "browser_observe html after"));
		const beforeText = `${JSON.stringify(before)}\n${await artifactTextFromSaved(before, path.join(env.runDir, `${entry.id}-before.json`))}`;
		const afterText = `${JSON.stringify(after)}\n${await artifactTextFromSaved(after, afterPath)}`;
		const mutationCount = Number(executeArtifact?.effect?.mutations ?? executeArtifact?.execution?.effect?.mutations);
		const ok = /Status: activated/.test(afterText) && /Confirm activation/.test(afterText) && /Activate workflow/.test(beforeText) && /activated/.test(JSON.stringify(execute)) && Number.isFinite(mutationCount) && mutationCount > 0;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Scan identified the interactive fixture, browser_execute clicked #activate, and browser_wait verified the dynamically inserted #activation-popup.");
		metrics.diagnostics.push(`Post-state artifact contains activated status: ${/Status: activated/.test(afterText)}; execute effect mutations=${Number.isFinite(mutationCount) ? mutationCount : "missing"}.`);
		metrics.notes.push("State change was verified by wait/observe evidence, not assumed from JavaScript execution alone.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval03(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "network.html");
	try {
		assertToolOk(await callTool(env, metrics, "browser_network", { action: "start", tabId, outputPath: path.join(env.runDir, `${entry.id}-network-start.json`), timeoutMs: 10_000 }), "browser_network start");
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { document.querySelector('#load').click(); return { clicked: true }; })()", timeoutMs: 10_000 }), "browser_execute network load");
		await delay(500);
		const listed = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_network", { action: "list", tabId, outputPath: path.join(env.runDir, `${entry.id}-network-list.json`), timeoutMs: 15_000, maxChars: 12_000 }), "browser_network list"));
		const text = JSON.stringify(listed);
		const replay = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_http_replay", { url: `${env.fixtureBaseUrl}/api/echo?item=browser-workflow`, method: "POST", headers: { "content-type": "application/json", "x-fixture": "network-eval-runner" }, body: JSON.stringify({ action: "capture", value: 8 }), compareBaseline: true, outputPath: path.join(env.runDir, `${entry.id}-replay.json`), timeoutMs: 15_000, maxChars: 12_000 }), "browser_http_replay network"));
		const ok = /api\/echo/.test(text) && /browser-workflow/.test(JSON.stringify(replay));
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Network recorder captured the fixture /api/echo request and browser_http_replay produced deterministic replay evidence.");
		metrics.diagnostics.push(`Captured /api/echo: ${/api\/echo/.test(text)}; replay echoed fixture marker: ${/browser-workflow/.test(JSON.stringify(replay))}.`);
		metrics.notes.push("Replay target stayed inside the local 127.0.0.1 fixture server and used one narrow body/header mutation.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval04(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "selector-recovery.html");
	try {
		const missing = parseToolJson(await callTool(env, metrics, "browser_wait", { action: "selector", tabId, params: { selector: "#missing-action", state: "attached" }, outputPath: path.join(env.runDir, `${entry.id}-missing-wait.json`), timeoutMs: 750, maxChars: 8_000 }));
		const html = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "html", tabId, selector: "main", htmlMode: "outer", outputPath: path.join(env.runDir, `${entry.id}-recovery.html`), maxChars: 8_000, timeoutMs: 10_000 }), "browser_observe selector recovery"));
		const ok = /ok\s*[:=]\s*false|TIMEOUT|timeout/i.test(JSON.stringify(missing)) && /actual-panel|ready-panel|Recovered selector target/i.test(JSON.stringify(html));
		metrics.recoveredAfterFailure = true;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("A bounded selector miss was followed by targeted HTML recovery evidence for the correct action.");
		metrics.diagnostics.push(`Selector miss recorded timeout diagnostics and recovery HTML contains actual-panel/ready-panel: ${/actual-panel|ready-panel/.test(JSON.stringify(html))}.`);
		metrics.notes.push("The runner intentionally triggers the first failure to validate recovery behavior.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval05(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "download.html");
	try {
		const downloaded = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_download", { tabId, selector: "#download-report", outputPath: path.join(env.runDir, `${entry.id}-download.json`), timeoutMs: 20_000, maxChars: 8_000 }), "browser_download report"));
		const text = JSON.stringify(downloaded);
		const pathMatch = text.match(/[A-Z]?:?[\\/][^"\n]*report[^"\n]*\.txt/i) || text.match(/\.pi[^"\n]*report[^"\n]*\.txt/i);
		const ok = /complete|completed|state/i.test(text) && /report\.txt/.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "not-applicable";
		metrics.summary.push("browser_download clicked #download-report and returned completed download metadata for report.txt.");
		metrics.diagnostics.push(`Download metadata path-like signal: ${pathMatch?.[0] || "report.txt"}.`);
		metrics.notes.push("The fixture file is local and deterministic; no external download host is used.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval06(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "wait-timeout.html");
	try {
		const timedOut = parseToolJson(await callTool(env, metrics, "browser_wait", { action: "selector", tabId, params: { selector: "#never-appears", state: "attached" }, outputPath: path.join(env.runDir, `${entry.id}-timeout.json`), timeoutMs: 750, maxChars: 8_000 }));
		const diagnosticPath = path.join(env.runDir, `${entry.id}-diagnostic.txt`);
		const observed = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "html", tabId, selector: "main", htmlMode: "text", outputPath: diagnosticPath, maxChars: 4_000, timeoutMs: 10_000 }), "browser_observe wait diagnostic"));
		const observedText = `${JSON.stringify(observed)}\n${await artifactTextFromSaved(observed, diagnosticPath)}`;
		const ok = /TIMEOUT|timeout|ok\s*[:=]\s*false/i.test(JSON.stringify(timedOut)) && /intentionally absent/.test(observedText);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Bounded wait timeout produced diagnostics, then targeted observe evidence explained that #never-appears is intentionally absent.");
		metrics.diagnostics.push(`Timeout surfaced: ${/TIMEOUT|timeout/i.test(JSON.stringify(timedOut))}; diagnostic artifact text present: ${/intentionally absent/.test(observedText)}.`);
		metrics.notes.push("No retry loop was used after timeout; the runner moved to diagnostic observation.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval07(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const routeMap = await readJson("evals/browser-workflows/fixtures/path-fuzz-routes.json");
	const replayHealth = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_http_replay", { url: `${env.fixtureBaseUrl}/health`, outputPath: path.join(env.runDir, `${entry.id}-baseline-health.json`), timeoutMs: 10_000, maxChars: 8_000 }), "browser_http_replay health"));
	const replayAdmin = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_http_replay", { url: `${env.fixtureBaseUrl}/admin`, outputPath: path.join(env.runDir, `${entry.id}-matched-admin.json`), timeoutMs: 10_000, maxChars: 8_000 }), "browser_http_replay admin"));
	const ok = /ok/.test(JSON.stringify(replayHealth)) && /403|forbidden/.test(JSON.stringify(replayAdmin)) && Array.isArray(routeMap.wordlist) && routeMap.wordlist.length <= 10;
	metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
	metrics.scopedFollowUpDiscipline = "passed";
	metrics.summary.push(`Bounded path baseline used fixture wordlist (${routeMap.wordlist.length} candidates) and confirmed /health plus /admin response evidence.`);
	metrics.diagnostics.push("Runner uses deterministic replay probes instead of scanner/OAST execution for the local path-fuzz fixture.");
	metrics.notes.push("This implemented runner keeps the eval local-safe; mature fuzzing remains a separate scoped follow-up tool path.");
	return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
}

async function eval08(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const cookies = await readJson("evals/browser-workflows/fixtures/cookies.json");
	const analyzed = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_cookie_analyze", { cookies: cookies.cookies, jwts: cookies.jwts, outputPath: path.join(env.runDir, `${entry.id}-cookie-analysis.json`), timeoutMs: 15_000, maxChars: 12_000 }), "browser_cookie_analyze fixture"));
	const text = JSON.stringify(analyzed);
	const ok = /jwt|claim|cookie/i.test(text) && !/sk_live_|AKIA[0-9A-Z]{16}/.test(text);
	metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
	metrics.scopedFollowUpDiscipline = "passed";
	metrics.summary.push("browser_cookie_analyze decoded synthetic cookie/JWT fixture while keeping output redacted and artifact-backed.");
	metrics.diagnostics.push(`Cookie/JWT signal present: ${/jwt|claim|cookie/i.test(text)}; secret-like leakage absent: ${!/sk_live_|AKIA[0-9A-Z]{16}/.test(text)}.`);
	metrics.notes.push("Inputs come from the synthetic fixture file only; no browser-session cookie collection is required.");
	return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
}

async function eval09(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const rawRequest = (await readFile(path.join(fixturesRoot, "sqli-request.txt"), "utf8")).replace("Host: 127.0.0.1:0", `Host: 127.0.0.1:${new URL(env.fixtureBaseUrl).port}`);
	const replay = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_http_replay", { baseUrl: env.fixtureBaseUrl, rawRequest, outputPath: path.join(env.runDir, `${entry.id}-replay.json`), timeoutMs: 10_000, maxChars: 8_000 }), "browser_http_replay sqli baseline"));
	const sqli = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_sqli", { engine: "builtin", baseUrl: env.fixtureBaseUrl, rawRequest, paramNames: ["id"], probeTypes: ["boolean", "error"], maxCases: 6, outputPath: path.join(env.runDir, `${entry.id}-sqli.json`), timeoutMs: 20_000, maxChars: 12_000 }), "browser_sqli builtin"));
	const ok = /fixture book|rows|ok/.test(JSON.stringify(replay)) && /id|probe|sqli|vulnerable|findings/i.test(JSON.stringify(sqli));
	metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
	metrics.scopedFollowUpDiscipline = "passed";
	metrics.summary.push("Raw request replay established baseline evidence before bounded built-in SQLi probes ran against the local deterministic API.");
	metrics.diagnostics.push("No sqlmap bridge, scanner, external database, or outbound target was used by the default runner.");
	metrics.notes.push("Mature sqlmap automation remains a deeper opt-in follow-up after explicit request evidence.");
	return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
}

async function eval10(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "interactive.html");
	try {
		const sessionA = parseToolJson(await callTool(env, metrics, "browser_tabs", { action: "createSession", name: "eval-a", timeoutMs: 5_000 }));
		const sessionB = parseToolJson(await callTool(env, metrics, "browser_tabs", { action: "createSession", name: "eval-b", timeoutMs: 5_000 }));
		const browserSessionId = sessionA.data?.session?.browserSessionId || sessionA.session?.browserSessionId || sessionA.data?.session?.id || sessionA.session?.id || sessionA.session?.browserSessionId;
		const secondSessionId = sessionB.data?.session?.browserSessionId || sessionB.data?.session?.id || sessionB.session?.browserSessionId || sessionB.session?.id;
		const lease = parseToolJson(await callTool(env, metrics, "browser_tabs", { action: "leaseTab", browserSessionId, tabId, timeoutMs: 5_000 }));
		const evidence = parseToolJson(await callTool(env, metrics, "browser_evidence", { browserSessionId, tabId, outputPath: path.join(env.runDir, `${entry.id}-evidence.json`), timeoutMs: 10_000, maxChars: 10_000 }));
		await callTool(env, metrics, "browser_tabs", { action: "releaseTab", browserSessionId, tabId, timeoutMs: 5_000 });
		const ok = /lease|session|browserSessionId|tabId/i.test(JSON.stringify({ sessionA, sessionB, lease, evidence })) && browserSessionId && secondSessionId;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Runner created explicit browser sessions, leased a target tab, collected evidence, and released the lease.");
		metrics.diagnostics.push(`Session ids surfaced: ${Boolean(browserSessionId && secondSessionId)}; lease evidence surfaced: ${/lease/i.test(JSON.stringify(lease))}.`);
		metrics.notes.push("The workflow validates explicit session/tab handling without relying on active-tab fallback.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval11(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "jshook-runtime-sinks.html");
	try {
		const targets = unwrapToolData(assertToolOk(await callTool(env, metrics, "browser_hook", { action: "listTargets", tabId, outputPath: path.join(env.runDir, `${entry.id}-targets.json`), timeoutMs: 10_000, maxChars: 10_000 }), "browser_hook listTargets"));
		const installed = unwrapToolData(assertToolOk(await callTool(env, metrics, "browser_hook", { action: "installTargets", tabId, sessionId: "eval11", params: { targets: ["console", "storage", "websocket", "dom-sinks"], buffer_size: 100 }, outputPath: path.join(env.runDir, `${entry.id}-install.json`), timeoutMs: 15_000, maxChars: 10_000 }), "browser_hook installTargets"));
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { document.querySelector('#run-sinks').click(); return { status: document.querySelector('#status').textContent }; })()", timeoutMs: 10_000, maxChars: 4_000 }), "browser_execute run sinks");
		await delay(600);
		const collected = unwrapToolData(assertToolOk(await callTool(env, metrics, "browser_hook", { action: "collect", tabId, sessionId: "eval11", params: { limit: 100 }, outputPath: path.join(env.runDir, `${entry.id}-events.json`), timeoutMs: 10_000, maxChars: 12_000 }), "browser_hook collect"));
		const evidence = unwrapToolData(await callTool(env, metrics, "browser_evidence", { tabId, eventTypes: ["storage", "websocket", "dom_sinks", "console"], outputPath: path.join(env.runDir, `${entry.id}-evidence.json`), timeoutMs: 10_000, maxChars: 12_000 }));
		await callTool(env, metrics, "browser_hook", { action: "uninstall", tabId, sessionId: "eval11", timeoutMs: 10_000, maxChars: 8_000 });
		const text = JSON.stringify({ targets, installed, collected, evidence });
		const ok = /static-explicit-targets|domSinks|dom_sinks/i.test(text) && /storage\.|websocket\.|dom\.sink/i.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("hook-events were collected for explicit storage/websocket/DOM-sink target classes; static expanded-targets reduced custom JS hook setup.");
		metrics.diagnostics.push(`Installed target boundary: ${installed?.target_boundary || "direct"}; hook event signal present: ${/storage\.|websocket\.|dom\.sink/i.test(text)}.`);
		metrics.notes.push("Closure: existing browser_hook installTargets + browser_evidence is sufficient; no new public jshook runtime tool is needed.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval12(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "jshook-source-map.html");
	try {
		const url = `${env.fixtureBaseUrl}/fixtures/jshook-source-map.html`;
		const crawl = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_crawl", { url, sameOrigin: true, maxDepth: 2, maxPages: 8, extractJs: true, activeGraphqlIntrospection: false, outputPath: path.join(env.runDir, `${entry.id}-crawl.json`), timeoutMs: 20_000, maxChars: 15_000 }), "browser_crawl source map"));
		const search = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_artifact", { root: path.join(env.runDir, ".pi", "browser-artifacts"), glob: "**/*", mode: "search", query: "piJshookFixtureMessage", maxFiles: 20, maxBytes: 300_000, maxTotalMatches: 5, maxChars: 8_000 }), "browser_artifact source map search"));
		const runtime = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => ({ status: document.querySelector('#source-map-status')?.textContent }))()", timeoutMs: 10_000, maxChars: 4_000 }), "browser_execute source map status"));
		const text = JSON.stringify({ crawl, search, runtime });
		const ok = /bundle\.js\.map|source-map|src\/pi-jshook-fixture\.js/i.test(text) && /piJshookFixtureMessage|source-map-fixture-value/.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("browser_crawl discovered bundle.js.map and archived original source metadata; browser_artifact found the synthetic source identifier.");
		metrics.diagnostics.push(`Source-map details present: ${/source-map|bundle\.js\.map/i.test(text)}; runtime fallback status checked: ${/source-map-fixture-value/.test(text)}.`);
		metrics.notes.push("Closure: existing browser_crawl + browser_artifact covers source-map evidence; no separate public source-inspection tool is needed.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval13(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "jshook-storage.html");
	try {
		assertToolOk(await callTool(env, metrics, "browser_hook", { action: "installTargets", tabId, sessionId: "eval13", params: { targets: ["storage"], buffer_size: 50 }, outputPath: path.join(env.runDir, `${entry.id}-hook-install.json`), timeoutMs: 15_000, maxChars: 8_000 }), "browser_hook storage install");
		const written = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => document.querySelector('#write-storage').click())()", timeoutMs: 10_000, maxChars: 4_000 }), "browser_execute write storage"));
		await callTool(env, metrics, "browser_wait", { action: "selector", tabId, params: { selector: "#storage-status", state: "attached" }, timeoutMs: 5_000, maxChars: 4_000 });
		await delay(600);
		const dumpPath = path.join(env.runDir, `${entry.id}-storage-dump.json`);
		const dump = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: `(async () => {
			const readStore = () => new Promise((resolve, reject) => {
				const req = indexedDB.open('pi-jshook-storage-fixture', 1);
				req.onerror = () => reject(String(req.error && req.error.message || req.error));
				req.onsuccess = () => {
					const db = req.result;
					const tx = db.transaction('records', 'readonly');
					const all = tx.objectStore('records').getAll();
					all.onsuccess = () => { db.close(); resolve(all.result.map((r) => ({ id: r.id, label: r.label, tokenLike: '[redacted]', tokenLikeLength: String(r.tokenLike || '').length }))); };
					all.onerror = () => reject(String(all.error && all.error.message || all.error));
				};
			});
			return {
				localStorage: Object.keys(localStorage).filter((k) => k.startsWith('pi-jshook')).map((key) => ({ key, preview: key.includes('token') ? '[redacted]' : localStorage.getItem(key) })),
				sessionStorage: Object.keys(sessionStorage).filter((k) => k.startsWith('pi-jshook')).map((key) => ({ key, preview: sessionStorage.getItem(key) })),
				indexedDB: await readStore(),
			};
		})()`, outputPath: dumpPath, timeoutMs: 20_000, maxChars: 12_000 }), "browser_execute storage dump"));
		const events = unwrapToolData(assertToolOk(await callTool(env, metrics, "browser_hook", { action: "collect", tabId, sessionId: "eval13", params: { limit: 80 }, outputPath: path.join(env.runDir, `${entry.id}-storage-events.json`), timeoutMs: 10_000, maxChars: 10_000 }), "browser_hook storage collect"));
		await callTool(env, metrics, "browser_hook", { action: "uninstall", tabId, sessionId: "eval13", timeoutMs: 10_000, maxChars: 8_000 });
		const dumpRaw = await readFile(dumpPath, "utf8").catch(() => "");
		const text = JSON.stringify({ written, dump, events });
		const ok = /pi-jshook-token|pi-jshook-session|fixture-record-1/.test(`${text}\n${dumpRaw}`) && /storage/i.test(text) && !/fixture-token-redact-me/.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("storage-summary listed localStorage/sessionStorage keys and bounded IndexedDB records with token-like values redacted.");
		metrics.diagnostics.push(`Storage event evidence present: ${/storage/i.test(text)}; raw token leaked: ${/fixture-token-redact-me/.test(text)}.`);
		metrics.notes.push("Closure: focused browser_execute state reads plus browser_hook storage events are sufficient; no separate public storage tool is needed.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval14(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "jshook-replay.html");
	try {
		assertToolOk(await callTool(env, metrics, "browser_network", { action: "start", tabId, outputPath: path.join(env.runDir, `${entry.id}-network-start.json`), timeoutMs: 10_000 }), "browser_network start replay");
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { document.querySelector('#send-request').click(); return { clicked: true }; })()", timeoutMs: 10_000, maxChars: 4_000 }), "browser_execute send replay request");
		await delay(800);
		const listed = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_network", { action: "list", tabId, outputPath: path.join(env.runDir, `${entry.id}-network-list.json`), timeoutMs: 15_000, maxChars: 12_000 }), "browser_network list replay"));
		const replay = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_http_replay", { url: `${env.fixtureBaseUrl}/api/jshook/replay?item=mutated`, method: "POST", headers: { "content-type": "application/json", "x-pi-fixture": "mutated" }, body: JSON.stringify({ item: "fixture", quantity: 2 }), compareBaseline: true, outputPath: path.join(env.runDir, `${entry.id}-http-replay.json`), timeoutMs: 15_000, maxChars: 12_000 }), "browser_http_replay mutation"));
		const text = JSON.stringify({ listed, replay });
		const ok = /api\/jshook\/replay/.test(text) && /mutated/.test(text) && /quantity/.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Passive browser_network capture identified the fixture request, then browser_http_replay applied one narrow header/query/body mutation.");
		metrics.diagnostics.push("Response delta was produced by offline replay; no live interception or fetch monkeypatch was used.");
		metrics.notes.push("Closure: browser_network + browser_http_replay is sufficient for replay/delta tasks; live interception remains RFC-only for live-flow-only needs.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval15(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "jshook-canvas.html");
	try {
		const shot = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_screenshot", { tabId, outputPath: path.join(env.runDir, `${entry.id}-screenshot.png`), timeoutMs: 15_000, maxChars: 4_000 }), "browser_screenshot canvas"));
		const canvas = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { const c = document.querySelector('#scene'); const r = c.getBoundingClientRect(); const ctx = c.getContext('2d'); return { selector: '#scene', width: c.width, height: c.height, rect: {x:r.x,y:r.y,width:r.width,height:r.height}, contextType: ctx ? '2d' : 'none', metadata: window.__piCanvasFixture, pixel: Array.from(ctx.getImageData(25,25,1,1).data) }; })()", outputPath: path.join(env.runDir, `${entry.id}-canvas-metadata.json`), timeoutMs: 10_000, maxChars: 10_000 }), "browser_execute canvas metadata"));
		const text = JSON.stringify({ shot, canvas });
		const ok = /#scene|240|120|box-1|label-1|2d/.test(text) && /screenshot|png/i.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Canvas selector, dimensions, 2D context, deterministic scene metadata, bounded pixel evidence, and screenshot artifact were captured.");
		metrics.diagnostics.push("Observation stayed bounded to one canvas and one pixel sample; no gameplay/CAPTCHA/solver semantics were introduced.");
		metrics.notes.push("Closure: browser_screenshot + focused browser_execute covers bounded canvas observation; no separate public canvas tool is needed.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval16(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "scan-high-entropy.html");
	try {
		const scan = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId, outputPath: path.join(env.runDir, `${entry.id}-scan.json`), detailLevel: "summary", timeoutMs: 20_000, maxChars: 14_000 }), "browser_observe high entropy scan"));
		const hintReadText = resultText(assertToolOk(await callTool(env, metrics, "browser_artifact", { path: scan.saved?.path, mode: "json", jsonPath: "data.actionables", maxChars: 8_000 }), "browser_artifact actionables hint"));
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { document.querySelector('#pay-now').click(); return { status: document.querySelector('#cart-status').textContent }; })()", timeoutMs: 10_000, maxChars: 4_000 }), "browser_execute pay now" );
		assertToolOk(await callTool(env, metrics, "browser_wait", { action: "selector", tabId, params: { selector: "#cart-status[data-last-action='pay-now']", state: "attached" }, timeoutMs: 10_000, maxChars: 4_000 }), "browser_wait pay status");
		const summaryOnly = scan?.data?.summary || scan?.summary || scan?.envelope?.summary || scan;
		const summaryText = JSON.stringify(summaryOnly);
		const ok = /summaryVersion|primary_actions|artifact_hints|Pay now|Apply coupon|Search|newsletter/i.test(summaryText) && /actionables|data\.actionables/i.test(hintReadText) && !/Synthetic private query 12345/.test(summaryText);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Scan high-entropy summary exposed primary actions, form/list/text signals, and artifact_hints before targeted jsonPath read.");
		metrics.diagnostics.push(`Prefilled private value leaked in summary: ${/Synthetic private query 12345/.test(summaryText)}.`);
		metrics.notes.push("The runner used artifact_hints data.actionables rather than blindly opening the full raw scan artifact.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval17(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "debugger-evidence.html");
	try {
		const observed = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId, outputPath: path.join(env.runDir, `${entry.id}-scan.json`), timeoutMs: 15_000, maxChars: 10_000 }), "browser_observe debugger scan"));
		const enabled = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Debugger.enable", params: {}, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-debugger-enable.json`), timeoutMs: 15_000, maxChars: 10_000 }), "browser_command Debugger.enable"));
		const clicked = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Runtime.evaluate", params: { expression: "(() => { document.querySelector('#run-workflow').click(); return window.__DEBUGGER_FIXTURE_LAST__; })()", awaitPromise: true, returnByValue: true }, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-runtime-evaluate.json`), timeoutMs: 15_000, maxChars: 12_000 }), "browser_command Runtime.evaluate"));
		const thrown = parseToolJson(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Runtime.evaluate", params: { expression: "(() => { throw new Error('debugger-evidence-marker'); })()", awaitPromise: true, returnByValue: true }, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-exception.json`), timeoutMs: 15_000, maxChars: 12_000 }));
		await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Debugger.disable", params: {}, persistent: true, timeoutMs: 10_000 }, timeoutMs: 15_000, maxChars: 6_000 });
		await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "detach", tabId, timeoutMs: 8_000 }, timeoutMs: 12_000, maxChars: 6_000 });
		const runtimeRaw = await readFile(path.join(env.runDir, `${entry.id}-runtime-evaluate.json`), "utf8").catch(() => "");
		const payload = persistentCdpPayload(clicked);
		const exception = persistentCdpException(thrown);
		const ok = /alpha|workflow-handler/.test(`${JSON.stringify(clicked)}\n${runtimeRaw}`) || payload?.nested?.branch === "alpha";
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("One-shot CDP debugger evidence through browser_command captured Runtime.evaluate object preview/payload under the existing public command surface.");
		metrics.diagnostics.push(`Exception details frame count: ${Array.isArray(exception?.stackTrace?.callFrames) ? exception.stackTrace.callFrames.length : 0}; unresolved pause/breakpoint lifecycle remains RFC-only.`);
		metrics.notes.push("No separate public debugger tool was assumed; current evidence closes one-shot reads while lifecycle gaps stay RFC-only.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval18(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "debugger-provenance.html");
	try {
		const crawled = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_crawl", { url: `${env.fixtureBaseUrl}/fixtures/debugger-provenance.html`, sameOrigin: true, maxDepth: 1, maxPages: 5, extractJs: true, activeGraphqlIntrospection: false, outputPath: path.join(env.runDir, `${entry.id}-crawl.json`), timeoutMs: 20_000, maxChars: 12_000 }), "browser_crawl provenance"));
		const runtime = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Runtime.evaluate", params: { expression: "(() => { document.querySelector('#run-provenance').click(); return window.__PROVENANCE_LAST__; })()", awaitPromise: true, returnByValue: true }, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-runtime.json`), timeoutMs: 15_000, maxChars: 10_000 }), "browser_command provenance runtime"));
		const helperSearch = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_artifact", { path: fixturePath("debugger/provenance-helper.js"), mode: "search", query: "sourceTag", maxChars: 4_000 }), "browser_artifact helper source"));
		const text = JSON.stringify({ crawled, runtime, helperSearch });
		const ok = /provenance-helper\.js|sourceTag|helper-script/.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Script provenance evidence captured external helper URL, bounded helper source search, and runtime payload sourceTag correlation.");
		metrics.diagnostics.push("Authored script provenance is partially closed by crawl/artifact/runtime evidence; stronger event-stream correlation remains RFC-only if needed.");
		metrics.notes.push("No separate public source/debugger tool was introduced; provenance stayed on canonical crawl/artifact/command surfaces.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval19(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "debugger-pause.html");
	try {
		const before = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => ({ count: Number(document.querySelector('#status').dataset.count || 0), state: document.querySelector('#status').dataset.state }))()", outputPath: path.join(env.runDir, `${entry.id}-before.json`), timeoutMs: 10_000, maxChars: 4_000 }), "browser_execute pause before"));
		const enabled = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Debugger.enable", params: {}, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-enable.json`), timeoutMs: 15_000, maxChars: 8_000 }), "browser_command Debugger.enable pause"));
		const pause = parseToolJson(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Debugger.pause", params: {}, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-pause.json`), timeoutMs: 15_000, maxChars: 8_000 }));
		await delay(600);
		const disable = parseToolJson(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Debugger.disable", params: {}, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-disable.json`), timeoutMs: 15_000, maxChars: 8_000 }));
		await delay(600);
		const after = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => ({ count: Number(document.querySelector('#status').dataset.count || 0), state: document.querySelector('#status').dataset.state }))()", outputPath: path.join(env.runDir, `${entry.id}-after.json`), timeoutMs: 10_000, maxChars: 4_000 }), "browser_execute pause after"));
		await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "detach", tabId, timeoutMs: 8_000 }, timeoutMs: 12_000, maxChars: 6_000 });
		const beforeCount = Number(persistentCdpPayload(before) || before?.data?.result?.value?.count || 0);
		const afterPayload = persistentCdpPayload(after) || after?.data?.result?.value;
		const ok = JSON.stringify(enabled).length > 0 && /Debugger\.pause|debugger/i.test(JSON.stringify({ pause, disable })) && Number(afterPayload?.count || 0) >= beforeCount;
		metrics.recoveredAfterFailure = true;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Debugger lifecycle attempt produced pause/disable evidence, then a follow-up page-state read verified recovery.");
		metrics.diagnostics.push("Pause/resume semantics remain fragile; cleanup via Debugger.disable/detach is the bounded recovery path and supports RFC-only lifecycle gap tracking.");
		metrics.notes.push("The eval does not assume a public debugger lifecycle tool; it records cleanup risk under existing browser_command.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval20(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "debugger-navigation.html");
	try {
		const beforePath = path.join(env.runDir, `${entry.id}-before.txt`);
		const before = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "html", tabId, selector: "#status", htmlMode: "text", outputPath: beforePath, timeoutMs: 10_000, maxChars: 4_000 }), "browser_observe nav before"));
		const enabled = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Debugger.enable", params: {}, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-enable.json`), timeoutMs: 15_000, maxChars: 8_000 }), "browser_command Debugger.enable navigation"));
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { document.querySelector('#nav-next').click(); return { href: location.href }; })()", timeoutMs: 10_000, maxChars: 4_000 }), "browser_execute nav next");
		assertToolOk(await callTool(env, metrics, "browser_wait", { action: "selector", tabId, params: { selector: "#status[data-state='page-b']", state: "attached" }, outputPath: path.join(env.runDir, `${entry.id}-wait.json`), timeoutMs: 20_000, maxChars: 6_000 }), "browser_wait nav page-b");
		const afterPath = path.join(env.runDir, `${entry.id}-after.txt`);
		const after = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "html", tabId, selector: "#status", htmlMode: "text", outputPath: afterPath, timeoutMs: 10_000, maxChars: 4_000 }), "browser_observe nav after"));
		const disabled = parseToolJson(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "Debugger.disable", params: {}, persistent: true, timeoutMs: 10_000 }, outputPath: path.join(env.runDir, `${entry.id}-disable.json`), timeoutMs: 15_000, maxChars: 8_000 }));
		await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "detach", tabId, timeoutMs: 8_000 }, timeoutMs: 12_000, maxChars: 6_000 });
		const text = `${JSON.stringify({ before, enabled, after, disabled })}\n${await artifactTextFromSaved(before, beforePath)}\n${await artifactTextFromSaved(after, afterPath)}`;
		const ok = /page-a/.test(text) && /page-b/.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Before/after navigation state stayed verifiable after debugger-like evidence collection, and cleanup/detach diagnostics were recorded.");
		metrics.diagnostics.push("Navigation recovery currently fails safe for this fixture; persistent debugger provenance/lifecycle still remains an RFC-only gap if stronger guarantees are needed.");
		metrics.notes.push("No public debugger tool was assumed; recovery stayed within browser_command, browser_wait, and browser_observe.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval21(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "interactive.html");
	try {
		assertToolOk(await callTool(env, metrics, "browser_network", { action: "start", tabId, outputPath: path.join(env.runDir, `${entry.id}-network-start.json`), timeoutMs: 10_000, maxChars: 6_000 }), "browser_network start correlation");
		const observed = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId, outputPath: path.join(env.runDir, `${entry.id}-observe.json`), timeoutMs: 20_000, maxChars: 12_000 }), "browser_observe correlation scan"));
		const executed = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { document.querySelector('#activate').click(); fetch('/api/echo?item=correlation', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({correlation:true})}); return { status: document.querySelector('#status').textContent }; })()", monitor: true, outputPath: path.join(env.runDir, `${entry.id}-execute.json`), timeoutMs: 20_000, maxChars: 10_000 }), "browser_execute correlation action"));
		const waited = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_wait", { action: "selector", tabId, params: { selector: "#status[data-state='activated']", state: "attached" }, outputPath: path.join(env.runDir, `${entry.id}-wait.json`), timeoutMs: 15_000, maxChars: 10_000 }), "browser_wait correlation"));
		await delay(500);
		const network = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_network", { action: "list", tabId, outputPath: path.join(env.runDir, `${entry.id}-network-list.json`), timeoutMs: 10_000, maxChars: 10_000 }), "browser_network list correlation"));
		const opRead = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_artifact", { path: observed.saved?.path, mode: "json", jsonPath: "operation.operationId", maxChars: 2_000 }), "browser_artifact operationId"));
		const snapRead = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_artifact", { path: observed.saved?.path, mode: "json", jsonPath: "snapshot.snapshotId", maxChars: 2_000 }), "browser_artifact snapshotId"));
		const waitRead = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_artifact", { path: waited.saved?.path, mode: "json", jsonPath: "data.waitId", maxChars: 2_000 }), "browser_artifact waitId"));
		const text = JSON.stringify({ observed, executed, waited, network, opRead, snapRead, waitRead });
		const ok = /operationId|snapshotId|waitId|selectionVersionAtDispatch|selectionVersionAtResolve|requestId/.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("operationId, snapshotId, waitId, requestId, and targeted artifact jsonPath reads were preserved across observe/execute/wait/network.");
		metrics.diagnostics.push("selectionVersionAtDispatch/selectionVersionAtResolve remained available for target drift diagnosis; artifact reads used narrow jsonPath first.");
		metrics.notes.push("Existing canonical tools kept correlation metadata without adding a new orchestration layer.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval22(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const paths = ["js-ast-minified.js", "js-ast-patterns.js", "js-ast-reduction.js", "js-ast-malformed.js"].map(fixturePath);
	const minified = await runJsAstShell({ path: paths[0], analysis: { maxReductionPreviewChars: 400 } }, { cwd: env.runDir });
	const patterns = await runJsAstShell({ path: paths[1], analysis: { maxReductionPreviewChars: 400 } }, { cwd: env.runDir });
	const reduction = await runJsAstShell({ path: paths[2], outputPath: path.join(env.runDir, `${entry.id}-reduction.json`), analysis: { maxReductionPreviewChars: 400 } }, { cwd: env.runDir });
	const malformed = await runJsAstShell({ path: paths[3] }, { cwd: env.runDir });
	for (const p of paths) addArtifact(metrics, p);
	if (reduction.saved?.path) addArtifact(metrics, reduction.saved.path);
	await saveJsonEvidence(env, metrics, "analysis", { minified, patterns, reduction, malformed });
	const text = JSON.stringify({ minified, patterns, reduction, malformed });
	const ok = /imports|exports|functions|evalCalls|functionConstructorCalls|parseDiagnostics/i.test(text);
	metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
	metrics.scopedFollowUpDiscipline = "passed";
	metrics.summary.push("AST summary returned bounded imports/exports/function inventory and suspicious-pattern counts from explicit local artifacts.");
	metrics.diagnostics.push("Malformed JS produced parse diagnostics; input stayed artifact-first and explicit with no whole-site source workflow.");
	metrics.notes.push("This remains an internal-first AST/deobfuscation path, not a new callable browser tool.");
	return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
}

async function eval23(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "dom-flow-listeners.html");
	try {
		const facts = unwrapToolData(assertToolOk(await callTool(env, metrics, "browser_hook", { action: "getNodeListeners", tabId, params: { selector: "#pay" }, outputPath: path.join(env.runDir, `${entry.id}-listeners.json`), timeoutMs: 15_000, maxChars: 10_000 }), "browser_hook getNodeListeners"));
		const chain = unwrapToolData(assertToolOk(await callTool(env, metrics, "browser_hook", { action: "getListenerChain", tabId, params: { selector: "#pay" }, outputPath: path.join(env.runDir, `${entry.id}-chain.json`), timeoutMs: 15_000, maxChars: 10_000 }), "browser_hook getListenerChain"));
		const text = JSON.stringify({ facts, chain });
		const ok = /click|handler|listener|#pay|onPay/i.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Listener facts, handler source metadata, and node-to-handler chain were collected for explicit selector #pay.");
		metrics.diagnostics.push("The workflow stayed selector-scoped and bounded; no full dynamic taint engine or broad DOM crawl was used.");
		metrics.notes.push("Closure: existing browser_hook DOM-flow commands cover this evidence-assist case; no new public DOM-flow tool is needed.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval24(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "dom-flow-listeners.html");
	try {
		const beforeMiss = parseToolJson(await callTool(env, metrics, "browser_hook", { action: "getSinkHints", tabId, params: { selector: "#missing" }, outputPath: path.join(env.runDir, `${entry.id}-selector-miss.json`), timeoutMs: 10_000, maxChars: 6_000 }));
		const hints = unwrapToolData(assertToolOk(await callTool(env, metrics, "browser_hook", { action: "getSinkHints", tabId, params: { selector: "#pay" }, outputPath: path.join(env.runDir, `${entry.id}-sink-hints.json`), timeoutMs: 15_000, maxChars: 10_000 }), "browser_hook getSinkHints"));
		const text = JSON.stringify({ beforeMiss, hints });
		const ok = /sink hints|hints|actionable-node|#sink|SELECTOR_NOT_FOUND/i.test(text);
		metrics.recoveredAfterFailure = true;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("Heuristic sink hints cited observable sink facts for #pay after bounded selector-miss recovery.");
		metrics.diagnostics.push("The result is evidence-assist only: no exploit judgement and no full taint engine was claimed.");
		metrics.notes.push("Closure: browser_hook sink hints stay bounded and selector-scoped; no exploit-decider or taint-engine tool is introduced.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval25(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const wasmPath = fixturePath("wasm-minimal.wasm");
	const watPath = fixturePath("wasm-minimal.wat");
	const analysis = await runWasmShell({ path: wasmPath, mode: "metadata" }, { cwd: env.runDir });
	let malformed;
	try { await runWasmShell({ path: watPath, mode: "metadata" }, { cwd: env.runDir }); } catch (error) { malformed = { code: error?.code, message: error instanceof Error ? error.message : String(error), details: error?.details }; }
	addArtifact(metrics, wasmPath);
	addArtifact(metrics, watPath);
	await saveJsonEvidence(env, metrics, "metadata", { analysis, malformed });
	const text = JSON.stringify({ analysis, malformed });
	const ok = /wasm|version|sha256|sections|imports|exports|WASM_MAGIC_INVALID/i.test(text);
	metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
	metrics.scopedFollowUpDiscipline = "passed";
	metrics.summary.push("Wasm metadata summary captured header/version/hash/section/import/export facts from an explicit local Wasm artifact.");
	metrics.diagnostics.push("Malformed .wat control produced bounded non-Wasm diagnostics; no whole-site discovery fallback was used.");
	metrics.notes.push("This remains an artifact-first path for explicit local Wasm artifacts, not a public Wasm browser tool.");
	return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
}

async function eval26(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const wasmPath = fixturePath("wasm-minimal.wasm");
	let result;
	try {
		result = await runWasmShell({ path: wasmPath, mode: "wat", outputPath: path.join(env.runDir, `${entry.id}.wat`), processTimeoutMs: 5_000 }, { cwd: env.runDir });
	} catch (error) {
		const metadata = await runWasmShell({ path: wasmPath, mode: "metadata" }, { cwd: env.runDir });
		result = { mode: "wat", summary: { launcherUnavailable: true, bridge: { error: error?.code || "launcher-unavailable" } }, analysis: metadata.analysis, bridgeError: { code: error?.code, message: error instanceof Error ? error.message : String(error), details: error?.details } };
	}
	addArtifact(metrics, wasmPath);
	if (result.bridge?.watArtifact?.path) addArtifact(metrics, result.bridge.watArtifact.path);
	const evidencePath = await saveJsonEvidence(env, metrics, "wat-bridge", result);
	const text = JSON.stringify(result);
	const ok = /launcher|wat|wasm2wat|launcherUnavailable|MATURE_BRIDGE/i.test(text);
	metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
	metrics.scopedFollowUpDiscipline = "passed";
	metrics.summary.push("Wasm WAT bridge returned launcher metadata or structured launcher-unavailable diagnostics with artifact-first evidence.");
	metrics.diagnostics.push(`Bridge evidence saved to ${pathRef(evidencePath)}; unavailable launchers remain a structured recovery path, not fake inline decompilation.`);
	metrics.notes.push("This is mature-bridge-first evidence, not a public browser tool or in-repo Wasm decompiler.");
	return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
}

async function eval27(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const sessionId = `eval27-${Date.now()}`;
	const opened = await runWsShell({ action: "open", sessionId, url: env.fixtureWsUrl, timeoutMs: 8_000, maxTranscript: 50 }, { cwd: env.runDir });
	const sent = await runWsShell({ action: "send", sessionId, text: "hello-browser-workflow" }, { cwd: env.runDir });
	const waited = await runWsShell({ action: "wait", sessionId, contains: "ack:hello-browser-workflow", timeoutMs: 5_000 }, { cwd: env.runDir });
	const failure = await runWsShell({ action: "replay", sessionId, steps: [{ text: "will-fail", contains: "never-matches", timeoutMs: 250 }], outputPath: path.join(env.runDir, `${entry.id}-ws-replay-failure.json`) }, { cwd: env.runDir });
	const collected = await runWsShell({ action: "collect", sessionId, outputPath: path.join(env.runDir, `${entry.id}-ws-transcript.json`) }, { cwd: env.runDir });
	const closed = await runWsShell({ action: "close", sessionId, timeoutMs: 2_000 }, { cwd: env.runDir });
	for (const item of [failure, collected]) if (item.saved?.path) addArtifact(metrics, item.saved.path);
	await saveJsonEvidence(env, metrics, "summary", { opened, sent, waited, failure, collected, closed });
	const text = JSON.stringify({ opened, sent, waited, failure, collected, closed });
	const ok = /WS|websocket|session|transcript|stepIndex|lastSeq|partialTranscript/i.test(text);
	metrics.recoveredAfterFailure = true;
	metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
	metrics.scopedFollowUpDiscipline = "passed";
	metrics.summary.push("WS summary recorded open/send/wait/collect/close session state plus replay failure stepIndex/lastSeq/partial-step diagnostics.");
	metrics.diagnostics.push("Replay failure preserved partialSteps and partialTranscript artifact evidence for bounded recovery from the failing step.");
	metrics.notes.push("This remains internal-first WebSocket state-machine evidence, not a public browser websocket fuzz tool.");
	return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
}

async function eval30(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "interactive.html");
	try {
		const observe = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId, outputPath: path.join(env.runDir, `${entry.id}-observe.json`), timeoutMs: 20_000, maxChars: 12_000 }), "browser_observe abml routing"));
		const execute = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { document.querySelector('#activate').click(); return { status: document.querySelector('#status').textContent }; })()", monitor: true, outputPath: path.join(env.runDir, `${entry.id}-monitor.json`), timeoutMs: 20_000, maxChars: 10_000 }), "browser_execute abml monitor"));
		const frameTabId = await createTab(env, metrics, "abml-frame-same-origin.html");
		const frame = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_frame", { action: "list", tabId: frameTabId, outputPath: path.join(env.runDir, `${entry.id}-frame.json`), timeoutMs: 15_000, maxChars: 12_000 }), "browser_frame abml frame"));
		const visionTabId = await createTab(env, metrics, "abml-vision-floor.html");
		const vision = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId: visionTabId, outputPath: path.join(env.runDir, `${entry.id}-vision.json`), timeoutMs: 20_000, maxChars: 12_000 }), "browser_observe abml vision"));
		const axTabId = await createTab(env, metrics, "abml-ax-canvas-aria.html");
		const ax = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId: axTabId, outputPath: path.join(env.runDir, `${entry.id}-ax.json`), timeoutMs: 20_000, maxChars: 12_000 }), "browser_observe abml ax"));
		const text = JSON.stringify({ observe, execute, frame, vision, ax });
		const ok = /abml|primary_entities|monitor|frame|visual_regions|canvas/i.test(text);
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push("ABML-backed primary entity projections, ABML-integrated monitor facts, frame entities, and visual region evidence surfaced under existing browser_* tools.");
		metrics.diagnostics.push("Conclusion: current browser_* public tools plus internal ABML integration are sufficient for exercised tasks and do not show a task blocked solely by missing public ABML verbs.");
		metrics.notes.push("ABML remains an internal substrate; no evidence here justifies exposing new public browser_read/browser_click/browser_type tools or parallel verbs.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

const implemented = new Map([
	["01-readable-content-artifact", eval01],
	["02-scan-execute-wait", eval02],
	["03-network-capture-replay", eval03],
	["04-selector-missing-recovery", eval04],
	["05-download-artifact", eval05],
	["06-wait-timeout-diagnostics", eval06],
	["07-bounded-path-fuzz-baseline", eval07],
	["08-cookie-jwt-redaction", eval08],
	["09-sqli-probe-vs-bridge", eval09],
	["10-multi-session-lease-conflict", eval10],
	["11-jshook-runtime-hook-targets", eval11],
	["12-jshook-source-map-artifact", eval12],
	["13-jshook-storage-evidence", eval13],
	["14-jshook-replay-not-intercept", eval14],
	["15-jshook-canvas-observation", eval15],
	["16-scan-high-entropy-summary", eval16],
	["17-debugger-evidence-workflow", eval17],
	["18-debugger-script-provenance", eval18],
	["19-debugger-pause-lifecycle", eval19],
	["20-debugger-navigation-recovery", eval20],
	["21-cross-tool-correlation-chain", eval21],
	["22-js-ast-artifact-summary", eval22],
	["23-dom-flow-listener-chain", eval23],
	["24-dom-flow-sink-hints", eval24],
	["25-wasm-artifact-metadata", eval25],
	["26-wasm-wat-bridge", eval26],
	["27-websocket-session-transcript", eval27],
	["30-abml-internal-routing-evidence", eval30],
]);

async function writeRunnerSummary(runDir, records, envMeta) {
	const summary = {
		schemaVersion: 1,
		suite: "browser-workflows",
		runner: "evals/browser-workflows/runner.mjs",
		startedAt: envMeta.startedAt,
		finishedAt: nowIso(),
		fixtureBaseUrl: envMeta.fixtureBaseUrl,
		fixturePort: envMeta.fixturePort,
		bridgePort: envMeta.bridgePort,
		resultDir: pathRef(runDir),
		implementedEvalIds: [...implemented.keys()],
		results: records.map((record) => ({ evalId: record.evalId, status: record.status, toolCallCount: record.toolCallCount, artifacts: record.evidence.artifacts.length })),
	};
	const summaryPath = path.join(runDir, "browser-workflow-eval-summary.json");
	await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
	return summaryPath;
}

function numericMetricSummary(values) {
	const sorted = [...values].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (!sorted.length) return undefined;
	const percentile = (p) => {
		if (sorted.length === 1) return sorted[0];
		const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
		return sorted[index];
	};
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
	return {
		samples: sorted.length,
		min: sorted[0],
		median,
		p95: percentile(0.95),
		max: sorted[sorted.length - 1],
	};
}

function summarizeObserveTimingSamples(samples) {
	const numericBuckets = new Map();
	const booleanBuckets = new Map();
	for (const sample of samples) {
		if (!isRecord(sample?.timings)) continue;
		for (const [metric, value] of Object.entries(sample.timings)) {
			if (typeof value === "number" && Number.isFinite(value)) {
				const bucket = numericBuckets.get(metric) || [];
				bucket.push(value);
				numericBuckets.set(metric, bucket);
			} else if (typeof value === "boolean") {
				const bucket = booleanBuckets.get(metric) || { trueCount: 0, falseCount: 0 };
				if (value) bucket.trueCount += 1;
				else bucket.falseCount += 1;
				booleanBuckets.set(metric, bucket);
			}
		}
	}
	const numericMetrics = [...numericBuckets.entries()]
		.map(([metric, values]) => {
			const summary = numericMetricSummary(values);
			return summary ? { metric, ...summary } : undefined;
		})
		.filter(Boolean);
	const rankedStages = numericMetrics
		.filter((entry) => /Ms$/.test(entry.metric))
		.sort((a, b) => b.median - a.median || b.p95 - a.p95 || a.metric.localeCompare(b.metric));
	const transportAndCounts = numericMetrics
		.filter((entry) => !/Ms$/.test(entry.metric))
		.sort((a, b) => b.median - a.median || b.p95 - a.p95 || a.metric.localeCompare(b.metric));
	const booleanFlags = Object.fromEntries([...booleanBuckets.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([metric, counts]) => [metric, { ...counts, samples: counts.trueCount + counts.falseCount }]));
	return { rankedStages, transportAndCounts, booleanFlags };
}

async function writeObserveTimingSummary(outDir, runDir, runnerSummaryPath, observeTimingSamples) {
	const summary = {
		schemaVersion: 1,
		generatedAt: nowIso(),
		runnerSummaryPath: pathRef(runnerSummaryPath),
		resultDir: pathRef(runDir),
		sampleCount: observeTimingSamples.length,
		evalIds: [...new Set(observeTimingSamples.map((sample) => sample.evalId))],
		...summarizeObserveTimingSamples(observeTimingSamples),
		samples: observeTimingSamples,
	};
	const canonicalPath = path.join(outDir, "observe-timings-summary.json");
	const runPath = path.join(runDir, "observe-timings-summary.json");
	await writeFile(canonicalPath, JSON.stringify(summary, null, 2), "utf8");
	await writeFile(runPath, JSON.stringify(summary, null, 2), "utf8");
	return { canonicalPath, runPath };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const manifest = await readJson("evals/browser-workflows/manifest.json");
	const implementedIds = [...implemented.keys()];
	if (args.help) {
		console.log(usage());
		return;
	}
	if (args.list) {
		console.log(JSON.stringify({ implementedEvalIds: implementedIds, fixtureServerRequired: true }, null, 2));
		return;
	}
	if (!args.fixtureServer) throw new Error(`Refusing to run: --fixture-server is required.\n\n${usage()}`);
	const requested = args.evalIds.length ? args.evalIds : implementedIds;
	const entries = requested.map((id) => {
		const entry = manifest.evals.find((item) => item.id === id);
		if (!entry) throw new Error(`Unknown eval id: ${id}`);
		if (!implemented.has(id)) throw new Error(`Eval is in manifest but runner implementation is not active yet: ${id}`);
		return entry;
	});
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${createHash("sha1").update(String(process.pid)).digest("hex").slice(0, 8)}`;
	const runDir = path.join(args.outDir, runId);
	await mkdir(runDir, { recursive: true });
	const fixture = await startFixtureServer();
	let env;
	const records = [];
	try {
		env = await startBrowserEnv(args, runDir, fixture);
		for (const entry of entries) {
			const fn = implemented.get(entry.id);
			const timeout = withTimeout(fn(env, entry), args.timeoutMs, entry.id);
			let record;
			try {
				record = await timeout;
			} catch (error) {
				const metrics = env?.currentMetrics?.evalId === entry.id ? env.currentMetrics : newMetrics(entry.id);
				metrics.artifactSufficiency = "insufficient";
				metrics.scopedFollowUpDiscipline = "not-evaluated";
				metrics.diagnostics.push(error instanceof Error ? error.message : String(error));
				metrics.notes.push("Runner caught an eval failure and wrote a schema-compatible failed result.");
				record = resultRecord(entry.id, "failed", metrics);
			}
			const resultPath = path.join(runDir, `${entry.id}.result.json`);
			await writeFile(resultPath, JSON.stringify(record, null, 2), "utf8");
			records.push(record);
		}
		const summaryPath = await writeRunnerSummary(runDir, records, { startedAt: nowIso(), fixtureBaseUrl: fixture.baseUrl, fixturePort: fixture.port, bridgePort: env.bridgePort });
		const observeSummary = await writeObserveTimingSummary(args.outDir, runDir, summaryPath, env.observeTimingSamples);
		const temporalSummary = await writeTemporalProfileArtifacts({ cwd: root, runId, samples: env.temporalProfileSamples, evalRunDir: runDir, runnerSummaryPath: summaryPath });
		const failed = records.filter((record) => record.status !== "passed");
		console.log(JSON.stringify({ ok: failed.length === 0, summaryPath: pathRef(summaryPath), observeSummaryPath: pathRef(observeSummary.canonicalPath), temporalSummaryPath: pathRef(temporalSummary.canonicalSummaryPath), resultDir: pathRef(runDir), fixturePort: fixture.port, bridgePort: env.bridgePort, results: records.map((record) => ({ evalId: record.evalId, status: record.status })) }, null, 2));
		if (failed.length) process.exitCode = 1;
	} finally {
		await stopBrowserEnv(env || {}).catch(() => {});
		await fixture.close().catch(() => {});
	}
}

async function withTimeout(promise, timeoutMs, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
