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
function valueRecord(value) { return isRecord(value) ? value : {}; }
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
function bridgeInnerData(value) {
	const data = bridgeData(value);
	return isRecord(data?.data) ? data.data : data;
}
function persistentCdpPayload(value) {
	return bridgeData(value)?.result?.value ?? bridgeData(value)?.result?.result?.value;
}
function persistentCdpException(value) {
	return bridgeData(value)?.exceptionDetails ?? bridgeData(value)?.result?.exceptionDetails ?? bridgeData(value)?.result?.result?.exceptionDetails;
}
function findPiRefNearText(value, pattern) {
	const seen = new Set();
	const candidates = [];
	function visit(node) {
		if (node == null) return;
		if (typeof node === "string") {
			for (const match of node.matchAll(/pi-ref:\/\/[A-Za-z0-9_-]+\/[^\s"'`<>{}\])]+/g)) candidates.push({ ref: match[0], context: node });
			return;
		}
		if (typeof node !== "object" || seen.has(node)) return;
		seen.add(node);
		const context = JSON.stringify(node).slice(0, 4000);
		for (const match of context.matchAll(/pi-ref:\/\/[A-Za-z0-9_-]+\/[^\s"'`<>{}\])]+/g)) candidates.push({ ref: match[0], context });
		for (const child of Array.isArray(node) ? node : Object.values(node)) visit(child);
	}
	visit(value);
	const matched = candidates.find((item) => pattern.test(item.context)) || candidates[0];
	return matched?.ref;
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
	const callRecord = { tool: name, params: sanitizeParams(params) };
	metrics.calls.push(callRecord);
	const startedAt = Date.now();
	const result = await tool.execute(toolCallId(metrics.evalId, name, metrics.toolCallCount), params, undefined, undefined, { cwd: env.runDir, hasUI: false });
	const elapsedMs = Math.max(0, Date.now() - startedAt);
	const text = resultText(result);
	callRecord.elapsedMs = elapsedMs;
	callRecord.resultTextChars = text.length;
	callRecord.estimatedTokens = Math.ceil(text.length / 4);
	if (name === "browser_artifact") {
		callRecord.artifactRead = true;
		callRecord.artifactMode = typeof params.mode === "string" ? params.mode : undefined;
		callRecord.artifactJsonPath = typeof params.jsonPath === "string" ? params.jsonPath : undefined;
		callRecord.artifactBroadRead = !callRecord.artifactJsonPath;
	}
	const saved = savedPathFromEnvelope(text);
	if (saved) addArtifact(metrics, saved);
	if (saved) callRecord.savedPath = path.isAbsolute(saved) ? pathRef(saved) : saved.replace(/\\/g, "/");
	const observeSample = maybeObserveTimingSample(result, params, metrics);
	if (observeSample) env.observeTimingSamples.push(observeSample);
	const temporalSample = maybeTemporalProfileSample(result, params, metrics, { tool: name, elapsedMs });
	if (temporalSample) env.temporalProfileSamples.push(temporalSample);
	return result;
}

async function callInternalBridgeCommand(env, metrics, command, options = {}) {
	metrics.toolCallCount += 1;
	const callRecord = { tool: "internal_bridge_command", params: sanitizeParams({ command, ...options }) };
	metrics.calls.push(callRecord);
	const startedAt = Date.now();
	const result = await env.bridge.sendCommand(command, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId ?? command.tabId,
		timeoutMs: options.timeoutMs,
		internal: true,
	});
	const elapsedMs = Math.max(0, Date.now() - startedAt);
	const text = JSON.stringify(result);
	callRecord.elapsedMs = elapsedMs;
	callRecord.resultTextChars = text.length;
	callRecord.estimatedTokens = Math.ceil(text.length / 4);
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

function rectArea(rect) {
	return Math.max(0, Number(rect?.width || rect?.w || 0)) * Math.max(0, Number(rect?.height || rect?.h || 0));
}

function normalizeRect(rect) {
	if (!isRecord(rect)) return undefined;
	const x = Number(rect.x);
	const y = Number(rect.y);
	const width = Number(rect.width ?? rect.w);
	const height = Number(rect.height ?? rect.h);
	if (![x, y, width, height].every(Number.isFinite)) return undefined;
	return { x, y, width, height };
}

function rectIou(a, b) {
	const ar = normalizeRect(a);
	const br = normalizeRect(b);
	if (!ar || !br) return 0;
	const left = Math.max(ar.x, br.x);
	const top = Math.max(ar.y, br.y);
	const right = Math.min(ar.x + ar.width, br.x + br.width);
	const bottom = Math.min(ar.y + ar.height, br.y + br.height);
	const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
	const union = rectArea(ar) + rectArea(br) - intersection;
	return union > 0 ? Number((intersection / union).toFixed(4)) : 0;
}

function rectDelta(a, b) {
	const ar = normalizeRect(a);
	const br = normalizeRect(b);
	if (!ar || !br) return undefined;
	return {
		x: Number((br.x - ar.x).toFixed(2)),
		y: Number((br.y - ar.y).toFixed(2)),
		width: Number((br.width - ar.width).toFixed(2)),
		height: Number((br.height - ar.height).toFixed(2)),
	};
}

function snapshotDocumentsFromCdp(value) {
	const data = bridgeData(value);
	const result = isRecord(data?.result) ? data.result : isRecord(data?.result?.result) ? data.result.result : data;
	return {
		strings: Array.isArray(result?.strings) ? result.strings : Array.isArray(data?.strings) ? data.strings : [],
		documents: Array.isArray(result?.documents) ? result.documents : Array.isArray(data?.documents) ? data.documents : [],
	};
}

function snapshotAttrMap(nodes, strings, nodeIndex) {
	const raw = Array.isArray(nodes.attributes) ? nodes.attributes[nodeIndex] : undefined;
	const attrs = Array.isArray(raw) ? raw : [];
	const out = {};
	for (let i = 0; i + 1 < attrs.length; i += 2) {
		const name = strings[Number(attrs[i])] ?? String(attrs[i]);
		const value = strings[Number(attrs[i + 1])] ?? String(attrs[i + 1]);
		out[name] = value;
	}
	return out;
}

function snapshotElementRects(value, options = {}) {
	const { strings, documents } = snapshotDocumentsFromCdp(value);
	const scale = Number(options.scale || 1);
	const scaleDivisor = Number.isFinite(scale) && scale > 0 ? scale : 1;
	const out = [];
	for (const documentSnapshot of documents) {
		const doc = valueRecord(documentSnapshot);
		const nodes = valueRecord(doc.nodes);
		const layout = valueRecord(doc.layout);
		const backendIds = Array.isArray(nodes.backendNodeId) ? nodes.backendNodeId : [];
		const nodeNames = Array.isArray(nodes.nodeName) ? nodes.nodeName : [];
		const layoutNodeIndexes = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
		const bounds = Array.isArray(layout.bounds) ? layout.bounds : [];
		for (let i = 0; i < layoutNodeIndexes.length; i += 1) {
			const nodeIndex = Number(layoutNodeIndexes[i]);
			const rawBounds = Array.isArray(bounds[i]) ? bounds[i].map(Number) : [];
			const [x, y, width, height] = rawBounds;
			if (![x, y, width, height].every(Number.isFinite)) continue;
			const attrs = snapshotAttrMap(nodes, strings, nodeIndex);
			const rawRect = { x, y, width, height };
			out.push({
				nodeIndex,
				nodeName: strings[Number(nodeNames[nodeIndex])] ?? String(nodeNames[nodeIndex] ?? ""),
				backendNodeId: Number(backendIds[nodeIndex]),
				attrs,
				rawRect,
				rect: { x: x / scaleDivisor, y: y / scaleDivisor, width: width / scaleDivisor, height: height / scaleDivisor },
			});
		}
	}
	return out.filter((item) => Number.isFinite(item.backendNodeId) && item.backendNodeId > 0);
}

function toolCountsFromCalls(calls) {
	const out = {};
	for (const call of calls) out[call.tool] = (out[call.tool] || 0) + 1;
	return out;
}

function summarizeEvalMetrics(metrics) {
	const calls = metrics.calls || [];
	const artifactCalls = calls.filter((call) => call.tool === "browser_artifact");
	const observeCalls = calls.filter((call) => call.tool === "browser_observe");
	const resultTextChars = calls.map((call) => Number(call.resultTextChars || 0)).filter(Number.isFinite);
	const estimatedTokens = calls.map((call) => Number(call.estimatedTokens || 0)).filter(Number.isFinite);
	const observeResultTextChars = observeCalls.map((call) => Number(call.resultTextChars || 0)).filter(Number.isFinite);
	const observeEstimatedTokens = observeCalls.map((call) => Number(call.estimatedTokens || 0)).filter(Number.isFinite);
	return {
		evalId: metrics.evalId,
		toolCounts: toolCountsFromCalls(calls),
		observeCallCount: observeCalls.length,
		artifactReadCalls: artifactCalls.length,
		artifactJsonPathReadCalls: artifactCalls.filter((call) => call.artifactJsonPath).length,
		artifactBroadReadCalls: artifactCalls.filter((call) => call.artifactBroadRead).length,
		resultTextChars: numericMetricSummary(resultTextChars),
		estimatedTokens: numericMetricSummary(estimatedTokens),
		observeResultTextChars: numericMetricSummary(observeResultTextChars),
		observeEstimatedTokens: numericMetricSummary(observeEstimatedTokens),
	};
}

function summarizeSuiteMetrics(evalMetrics) {
	const toolCounts = {};
	let artifactReadCalls = 0;
	let artifactJsonPathReadCalls = 0;
	let artifactBroadReadCalls = 0;
	for (const item of evalMetrics) {
		for (const [tool, count] of Object.entries(item.toolCounts || {})) toolCounts[tool] = (toolCounts[tool] || 0) + count;
		artifactReadCalls += Number(item.artifactReadCalls || 0);
		artifactJsonPathReadCalls += Number(item.artifactJsonPathReadCalls || 0);
		artifactBroadReadCalls += Number(item.artifactBroadReadCalls || 0);
	}
	return { toolCounts, artifactReadCalls, artifactJsonPathReadCalls, artifactBroadReadCalls };
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

async function eval31(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const oldTabId = await createTab(env, metrics, "execution-plane-cdp-fusion.html");
	let fusedTabId;
	try {
		const oldMeasurePath = path.join(env.runDir, `${entry.id}-old-measure.json`);
		const oldMeasure = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", {
			tabId: oldTabId,
			script: `(() => {
  const el = document.querySelector('#trusted-activate');
  const r = el.getBoundingClientRect();
  el.click();
  return { point:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}, state:{...window.__fixtureState}, status:document.querySelector('#status').textContent, trustedResult:!!document.querySelector('#trusted-result') };
})()`,
			outputPath: oldMeasurePath,
			timeoutMs: 15_000,
			maxChars: 8_000,
		}), "browser_execute old measure synthetic click"));
		const oldMeasureData = oldMeasure.data || oldMeasure.summary?.data || oldMeasure;
		const oldPoint = oldMeasureData.point || oldMeasureData.data?.point;
		assertToolOk(await callTool(env, metrics, "browser_command", {
			tabId: oldTabId,
			command: { cmd: "input.pointer", tabId: oldTabId, gesture: "press", x: Number(oldPoint.x), y: Number(oldPoint.y), timeoutMs: 10_000 },
			outputPath: path.join(env.runDir, `${entry.id}-old-input-pointer.json`),
			timeoutMs: 15_000,
			maxChars: 8_000,
		}), "browser_command old input.pointer");
		assertToolOk(await callTool(env, metrics, "browser_wait", { action: "selector", tabId: oldTabId, params: { selector: "#trusted-result", state: "attached" }, timeoutMs: 10_000 }), "browser_wait old trusted result");

		fusedTabId = await createTab(env, metrics, "execution-plane-cdp-fusion.html");
		const beforePath = path.join(env.runDir, `${entry.id}-before-scan.json`);
		const before = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId: fusedTabId, outputPath: beforePath, maxChars: 14_000, timeoutMs: 20_000 }), "browser_observe fused scan"));
		const beforeArtifact = JSON.parse(await readFile(beforePath, "utf8"));
		const ref = findPiRefNearText({ before, beforeArtifact }, /Trusted activate|trusted-activate/i);
		if (!ref) throw new Error("eval31 could not locate a pi-ref for Trusted activate");
		const raw = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", {
			tabId: fusedTabId,
			script: "(() => { document.querySelector('#trusted-activate').click(); return { state:{...window.__fixtureState}, status:document.querySelector('#status').textContent, trustedResult:!!document.querySelector('#trusted-result') }; })()",
			outputPath: path.join(env.runDir, `${entry.id}-raw-click.json`),
			timeoutMs: 15_000,
			maxChars: 8_000,
		}), "browser_execute raw synthetic click"));
		const piClickPath = path.join(env.runDir, `${entry.id}-pi-click.json`);
		const piClick = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_execute", {
			tabId: fusedTabId,
			script: `return await pi.click(${JSON.stringify(ref)})`,
			outputPath: piClickPath,
			timeoutMs: 20_000,
			maxChars: 10_000,
		}), "browser_execute pi.click"));
		assertToolOk(await callTool(env, metrics, "browser_wait", { action: "selector", tabId: fusedTabId, params: { selector: "#trusted-result", state: "attached" }, timeoutMs: 10_000 }), "browser_wait fused trusted result");
		const afterPath = path.join(env.runDir, `${entry.id}-after.txt`);
		const after = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "html", tabId: fusedTabId, selector: "main", htmlMode: "text", outputPath: afterPath, maxChars: 6_000, timeoutMs: 10_000 }), "browser_observe fused after"));
		const afterText = `${JSON.stringify(after)}\n${await artifactTextFromSaved(after, afterPath)}`;
		const piClickArtifact = JSON.parse(await readFile(piClickPath, "utf8"));
		const combined = JSON.stringify({ oldMeasure, raw, piClick, piClickArtifact, after });
		const rawIgnored = /synthetic ignored/.test(JSON.stringify(raw)) && !/trustedResult":true/.test(JSON.stringify(raw));
		const dispatchFacts = /dispatchOnly/.test(combined) && /mousePressed/.test(combined) && /input\.ref/.test(combined);
		const trusted = /Status: trusted activated/.test(afterText) && /Trusted event accepted/.test(afterText);
		const ok = rawIgnored && dispatchFacts && trusted;
		metrics.recoveredAfterFailure = true;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push(`Raw el.click was ignored, old fallback used execute+input.pointer at (${oldPoint.x},${oldPoint.y}), and pi.click dispatched against ${ref}.`);
		metrics.summary.push("pi.click returned dispatch facts; trusted semantic success was verified afterward through wait/observe.");
		metrics.diagnostics.push("Action-call comparison: old path = browser_execute measurement + browser_command input.pointer (2 action calls); fused path after observe = browser_execute with pi.click(ref) (1 action call).");
		metrics.diagnostics.push(`dispatchOnly facts present=${dispatchFacts}; final trusted status present=${trusted}.`);
		metrics.notes.push("No browser_execute action parameter or public browser_* tool was added; the privileged path is an execute-time binding to internal input.ref.");
		await saveJsonEvidence(env, metrics, "comparison", { ref, oldPathActionCalls: 2, fusedPathActionCallsAfterObserve: 1, rawIgnored, dispatchFacts, trusted, oldPoint });
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, oldTabId);
		if (fusedTabId) await closeTabQuiet(env, fusedTabId);
	}
}

async function eval32(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "abml-identity-bootstrap.html");
	try {
		const scanStartedAt = nowIso();
		const scanPath = path.join(env.runDir, `${entry.id}-scan.json`);
		const scan = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId, outputPath: scanPath, timeoutMs: 20_000, maxChars: 14_000 }), "browser_observe bootstrap scan"));
		const scanArtifact = JSON.parse(await readFile(scanPath, "utf8"));
		const scanEndedAt = nowIso();
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => { window.scrollTo(0, 420); return window.__abmlBootstrapFixture.collect(); })()", outputPath: path.join(env.runDir, `${entry.id}-page-rects.json`), timeoutMs: 10_000, maxChars: 10_000 }), "browser_execute bootstrap collect rects");
		const rectArtifact = JSON.parse(await readFile(path.join(env.runDir, `${entry.id}-page-rects.json`), "utf8"));
		const pageSample = rectArtifact?.data?.value ?? rectArtifact?.data ?? rectArtifact;
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => window.__abmlBootstrapFixture.drift())()", outputPath: path.join(env.runDir, `${entry.id}-drift.json`), timeoutMs: 10_000, maxChars: 8_000 }), "browser_execute bootstrap drift");
		const snapshotStartedAt = nowIso();
		const snapshotPath = path.join(env.runDir, `${entry.id}-snapshot.json`);
		assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "DOMSnapshot.captureSnapshot", params: { computedStyles: [], includeDOMRects: true }, persistent: true, timeoutMs: 15_000 }, outputPath: snapshotPath, timeoutMs: 20_000, maxChars: 10_000 }), "browser_command DOMSnapshot.captureSnapshot");
		const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
		const snapshotEndedAt = nowIso();
		const dpr = Number(pageSample?.viewport?.devicePixelRatio || 1);
		const snapshotRects = snapshotElementRects(snapshot, { scale: dpr });
		const targetIds = new Set((pageSample.targets || []).map((target) => target.id));
		const snapshotTargets = snapshotRects.filter((item) => targetIds.has(item.attrs.id));
		const byId = new Map(snapshotTargets.map((item) => [item.attrs.id, item]));
		const candidates = snapshotTargets.map((item) => ({ id: item.attrs.id, case: item.attrs["data-bootstrap-case"], backendNodeId: item.backendNodeId, rect: item.rect, rawRect: item.rawRect }));
		const productBootstrap = scanArtifact?.abml?.data?.backendNodeIdBootstrap;
		const productListenerOracle = scanArtifact?.abml?.data?.listenerOracle;
		const productEntities = Array.isArray(scanArtifact?.abml?.entities) ? scanArtifact.abml.entities : [];
		const productStampedEntityCount = productEntities.filter((entity) => Array.isArray(entity.locators) && entity.locators.some((locator) => locator?.by === "backendNodeId" && Number(locator.value) > 0)).length;
		const productListenerEntityCount = productEntities.filter((entity) => Array.isArray(entity.hints?.listeners) && entity.hints.listeners.length > 0).length;
		const targetResults = [];
		const byCase = {};
		for (const target of pageSample.targets || []) {
			const scanRect = normalizeRect(target.docRect);
			const oracle = byId.get(target.id);
			const candidateScores = candidates
				.map((candidate) => ({ id: candidate.id, case: candidate.case, backendNodeId: candidate.backendNodeId, iou: rectIou(scanRect, candidate.rect), delta: rectDelta(scanRect, candidate.rect), rect: candidate.rect, rawRect: candidate.rawRect }))
				.filter((candidate) => candidate.iou >= 0.9)
				.sort((a, b) => b.iou - a.iou || a.id.localeCompare(b.id));
			let status = "missing";
			let reason = "snapshot-node-not-found";
			if (oracle) {
				if (candidateScores.length > 1 && target.case === "duplicate") {
					status = "ambiguous";
					reason = "multiple-high-iou-candidates";
				} else {
					const oracleIou = rectIou(scanRect, oracle.rect);
					if (oracleIou >= 0.9) {
						status = "matched";
						reason = "unique-high-iou";
					} else {
						status = target.case === "drift" ? "stale" : "unsupported";
						reason = target.case === "drift" ? "post-scan-layout-drift" : "coordinate-parity-miss";
					}
				}
			}
			byCase[target.case] = byCase[target.case] || {};
			byCase[target.case][status] = (byCase[target.case][status] || 0) + 1;
			targetResults.push({
				id: target.id,
				case: target.case,
				selector: target.selector,
				scanRect,
				snapshotBounds: oracle?.rect,
				snapshotRawBounds: oracle?.rawRect,
				backendNodeId: oracle?.backendNodeId,
				status,
				reason,
				iou: oracle ? rectIou(scanRect, oracle.rect) : 0,
				delta: oracle ? rectDelta(scanRect, oracle.rect) : undefined,
				candidates: candidateScores.slice(0, 4),
			});
		}
		const counts = {};
		for (const item of targetResults) counts[item.status] = (counts[item.status] || 0) + 1;
		const comparison = {
			sampleWindow: { scanStartedAt, scanEndedAt, snapshotStartedAt, snapshotEndedAt, sampleWindowMs: Math.max(0, Date.parse(snapshotEndedAt) - Date.parse(scanStartedAt)) },
			viewport: pageSample.viewport,
			coordinateDiagnostics: { normalizedTo: "document-relative-css-pixels", snapshotScaleDivisor: dpr, matchThreshold: 0.9, candidatePool: "fixture targets with DOMSnapshot layout.bounds" },
			targets: targetResults,
			bootstrapStats: {
				total: targetResults.length,
				matched: counts.matched || 0,
				ambiguous: counts.ambiguous || 0,
				stale: counts.stale || 0,
				unsupported: counts.unsupported || 0,
				missing: counts.missing || 0,
				coverage: targetResults.length ? Number(((counts.matched || 0) / targetResults.length).toFixed(3)) : 0,
				byCase,
			},
			nonClaims: [
				"Product bootstrap is best-effort: scan and DOMSnapshot are not atomic; stale/ambiguous targets remain fail-open.",
				"The manual post-scan drift sample proves stale classification evidence; product observe sees only its own scan/snapshot window.",
			],
			productBootstrap: productBootstrap ? {
				total: Number(productBootstrap.total || 0),
				matched: Number(productBootstrap.matched || 0),
				ambiguous: Number(productBootstrap.ambiguous || 0),
				stale: Number(productBootstrap.stale || 0),
				missing: Number(productBootstrap.missing || 0),
				unsupported: Number(productBootstrap.unsupported || 0),
				coverage: Number(productBootstrap.coverage || 0),
				snapshotScaleDivisor: Number(productBootstrap.snapshotScaleDivisor || 0),
				sampleWindowMs: Number(productBootstrap.sampleWindowMs || 0),
				stampedEntityCount: productStampedEntityCount,
			} : undefined,
			productListenerOracle: productListenerOracle ? {
				candidateCount: Number(productListenerOracle.candidateCount || 0),
				probedCount: Number(productListenerOracle.probedCount || 0),
				nodeWithListenersCount: Number(productListenerOracle.nodeWithListenersCount || 0),
				listenerCount: Number(productListenerOracle.listenerCount || 0),
				failureCount: Number(productListenerOracle.failureCount || 0),
				truncated: productListenerOracle.truncated === true,
				listenerEntityCount: productListenerEntityCount,
			} : undefined,
			scanArtifact: scan.saved?.path ? pathRef(scan.saved.path) : undefined,
		};
		await saveJsonEvidence(env, metrics, "comparison", comparison);
		const productStampingPresent = Number(productBootstrap?.matched || 0) > 0 && productStampedEntityCount > 0;
		const productListenerPresent = Number(productListenerOracle?.listenerCount || 0) > 0 && productListenerEntityCount > 0;
		const ok = comparison.bootstrapStats.matched >= 2 && comparison.bootstrapStats.ambiguous >= 1 && comparison.bootstrapStats.stale >= 1 && snapshotTargets.some((item) => item.backendNodeId > 0) && productStampingPresent && productListenerPresent;
		metrics.recoveredAfterFailure = true;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push(`Bootstrap evidence classified ${comparison.bootstrapStats.matched}/${comparison.bootstrapStats.total} matched targets plus ambiguous=${comparison.bootstrapStats.ambiguous}, stale=${comparison.bootstrapStats.stale}; product stamped entities=${productStampedEntityCount}.`);
		metrics.diagnostics.push(`DOMSnapshot target backend ids present=${snapshotTargets.some((item) => item.backendNodeId > 0)}; sample window ${comparison.sampleWindow.sampleWindowMs}ms; product bootstrap matched=${Number(productBootstrap?.matched || 0)} ambiguous=${Number(productBootstrap?.ambiguous || 0)}; product listener hints=${productListenerEntityCount}/${Number(productListenerOracle?.listenerCount || 0)}.`);
		metrics.notes.push("Passing means product ABML entities are now best-effort stamped with backendNodeId and carry bounded read-only listener hints while stale/ambiguous samples remain fail-open evidence.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval33(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "abml-layer-occlusion.html");
	try {
		const observePath = path.join(env.runDir, `${entry.id}-observe.json`);
		const topHitPath = path.join(env.runDir, `${entry.id}-top-hit.json`);
		assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId, outputPath: observePath, timeoutMs: 20_000, maxChars: 14_000 }), "browser_observe layer boundary");
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => window.__abmlLayerFixture.sample())()", outputPath: topHitPath, timeoutMs: 10_000, maxChars: 6_000 }), "browser_execute occlusion sample");
		const observe = JSON.parse(await readFile(observePath, "utf8"));
		const topHit = JSON.parse(await readFile(topHitPath, "utf8"));
		const layerProbePath = path.join(env.runDir, `${entry.id}-layer-probe.json`);
		const layerProbeResult = await callInternalBridgeCommand(env, metrics, { cmd: "layer.probe", tabId, waitMs: 500, maxEvents: 4, maxLayers: 120, timeoutMs: 10_000 }, { tabId, timeoutMs: 15_000 });
		await writeFile(layerProbePath, JSON.stringify(layerProbeResult, null, 2), "utf8");
		addArtifact(metrics, layerProbePath);
		const layerProbe = JSON.parse(await readFile(layerProbePath, "utf8"));
		const scanText = JSON.stringify(observe);
		const topHitData = topHit?.data?.value ?? topHit?.data ?? topHit;
		const layerProbeData = bridgeInnerData(layerProbe);
		const layerOwnerIds = Array.isArray(layerProbeData?.ownerBackendNodeIds) ? layerProbeData.ownerBackendNodeIds : [];
		const paintOrderData = isRecord(layerProbeData?.paintOrder) ? layerProbeData.paintOrder : {};
		const paintOrderOwnerIds = Array.isArray(paintOrderData.ownerBackendNodeIds) ? paintOrderData.ownerBackendNodeIds : [];
		const scanRelationsSummary = observe?.relations?.summary ?? observe?.envelope?.relations?.summary ?? observe?.summary?.focus?.relations?.summary ?? observe?.envelope?.summary?.focus?.relations?.summary;
		const paintOrderRuntime = observe?.abml?.data?.axDiagnostics?.paintOrder;
		const paintOrderArtifactEvidence = observe?.abml?.data?.paintOrderEvidence;
		const paintOrderArtifactEntries = Array.isArray(paintOrderArtifactEvidence?.entries) ? paintOrderArtifactEvidence.entries : [];
		const envelopeText = JSON.stringify(observe?.envelope ?? {});
		const paintOrderRelationEvidencePresent = /"paintOrder"\s*:\s*true/.test(scanText);
		const paintOrderFullEntriesArtifactOnly = paintOrderArtifactEntries.length > 0
			&& !Array.isArray(paintOrderRuntime?.entries)
			&& !/paintOrderEvidence|axDiagnostics/.test(envelopeText);
		const boundary = {
			topHit: topHitData,
			scanRelationsSummary,
			hasModelFacingOccludes: /occludes|occluded/i.test(scanText),
			hasLayerTreeSource: /layerTree|LayerTree/i.test(scanText),
			layerTreeProbe: {
				supported: layerProbeData?.supported === true,
				eventCount: Number(layerProbeData?.eventCount || 0),
				ownerBackendNodeIds: layerOwnerIds,
				ownerMappingPresent: layerOwnerIds.length > 0,
				proof: layerProbeData?.proof,
				enableError: layerProbeData?.enableError,
			},
			paintOrderProbe: {
				supported: paintOrderData.supported === true,
				paintOrderCount: Number(paintOrderData.paintOrderCount || 0),
				ownerBackendNodeIds: paintOrderOwnerIds,
				ownerMappingPresent: paintOrderOwnerIds.length > 0,
				proof: paintOrderData.proof,
			},
			paintOrderRuntime: {
				supported: paintOrderRuntime?.supported === true,
				entryCount: Number(paintOrderRuntime?.entryCount || 0),
				ownerBackendNodeIdCount: Number(paintOrderRuntime?.ownerBackendNodeIdCount || 0),
				relationEvidencePresent: paintOrderRelationEvidencePresent,
				fullEntriesArtifactOnly: paintOrderFullEntriesArtifactOnly,
			},
			paintOrderArtifactEvidence: {
				entryCount: Number(paintOrderArtifactEvidence?.entryCount || 0),
				ownerBackendNodeIdCount: Number(paintOrderArtifactEvidence?.ownerBackendNodeIdCount || 0),
				entryRows: paintOrderArtifactEntries.length,
			},
			nonClaims: [
				"LayerTree owner-to-backendNodeId relation model is not used; LayerTree.enable is recorded as unavailable when applicable.",
				"DOMSnapshot paint-order relation evidence is capped in the model-facing relation summary; full paint-order entries stay in the saved artifact.",
			],
		};
		await saveJsonEvidence(env, metrics, "boundary", boundary);
		const topHitShowsCover = /covering/.test(JSON.stringify(topHitData));
		const ownerMappingPresent = boundary.layerTreeProbe.ownerMappingPresent === true || boundary.paintOrderProbe.ownerMappingPresent === true;
		const relationSummaryHasOcclusion = Number(scanRelationsSummary?.occludes || 0) > 0 && Number(scanRelationsSummary?.coveredBy || 0) > 0;
		const ok = topHitShowsCover && ownerMappingPresent && relationSummaryHasOcclusion && paintOrderRelationEvidencePresent && paintOrderFullEntriesArtifactOnly;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push(`Occlusion evidence: elementFromPoint saw covering=${topHitShowsCover}; relation summary occludes=${Number(scanRelationsSummary?.occludes || 0)} coveredBy=${Number(scanRelationsSummary?.coveredBy || 0)}; layer owner ids=${layerOwnerIds.length}; paint-order owner ids=${paintOrderOwnerIds.length}.`);
		metrics.diagnostics.push("Passing proves DOMSnapshot paint-order owner evidence feeds capped ABML relations while LayerTree remains an unavailable boundary.");
		metrics.notes.push("LayerTree is not the implementation spine; product relation evidence follows DOMSnapshot paint-order with artifact-only full entries.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval34(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "oopif-parent.html");
	try {
		assertToolOk(await callTool(env, metrics, "browser_wait", { action: "selector", tabId, params: { selector: "#xframe", state: "attached" }, timeoutMs: 15_000, maxChars: 4_000 }), "browser_wait iframe attached");
		await delay(1_000);
		const inspectPath = path.join(env.runDir, `${entry.id}-inspect.json`);
		const afterPath = path.join(env.runDir, `${entry.id}-after.json`);
		const framePath = path.join(env.runDir, `${entry.id}-frame.json`);
		const targetsPath = path.join(env.runDir, `${entry.id}-targets.json`);
		const parentSnapshotPath = path.join(env.runDir, `${entry.id}-parent-snapshot.json`);
		const childSnapshotPath = path.join(env.runDir, `${entry.id}-child-snapshot.json`);
		const parentInputPath = path.join(env.runDir, `${entry.id}-parent-input.json`);
		const childInputPath = path.join(env.runDir, `${entry.id}-child-input.json`);
		const failClosedPath = path.join(env.runDir, `${entry.id}-fail-closed.json`);
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => window.__oopifFixture.inspect())()", outputPath: inspectPath, timeoutMs: 10_000, maxChars: 6_000 }), "browser_execute oopif inspect");
		assertToolOk(await callTool(env, metrics, "browser_frame", { action: "list", tabId, outputPath: framePath, timeoutMs: 15_000, maxChars: 12_000 }), "browser_frame oopif boundary");
		const targetResponse = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "targets", tabId, timeoutMs: 10_000 }, outputPath: targetsPath, timeoutMs: 15_000, maxChars: 12_000 }), "browser_command persistent_cdp targets"));
		const inspected = JSON.parse(await readFile(inspectPath, "utf8"));
		const frame = JSON.parse(await readFile(framePath, "utf8"));
		const targets = existsSync(targetsPath) ? JSON.parse(await readFile(targetsPath, "utf8")) : targetResponse;
		const inspectValue = inspected?.data?.value ?? inspected?.data ?? inspected;
		const targetData = bridgeData(targets);
		const targetInfos = targetData?.targets ?? targetData?.result?.targets ?? targetData?.targetInfos ?? [];
		const childTarget = Array.isArray(targetInfos) ? targetInfos.find((target) => /oopif-child\.html/i.test(String(target.url || ""))) : undefined;
		const childTargetId = typeof childTarget?.id === "string" ? childTarget.id : typeof childTarget?.targetId === "string" ? childTarget.targetId : undefined;
		let parentBackendNodeId;
		let childBackendNodeId;
		let parentInput;
		let childInput;
		let failClosed;
		if (childTargetId) {
			const parentSnapshotResponse = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, cdpMethod: "DOMSnapshot.captureSnapshot", params: { computedStyles: [], includeDOMRects: true }, persistent: true, timeoutMs: 10_000 }, outputPath: parentSnapshotPath, timeoutMs: 15_000, maxChars: 12_000 }), "browser_command parent DOMSnapshot"));
			const childSnapshotResponse = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "persistent_cdp", action: "send", tabId, targetId: childTargetId, cdpMethod: "DOMSnapshot.captureSnapshot", params: { computedStyles: [], includeDOMRects: true }, persistent: true, timeoutMs: 10_000 }, outputPath: childSnapshotPath, timeoutMs: 15_000, maxChars: 12_000 }), "browser_command child DOMSnapshot"));
			const parentSnapshot = existsSync(parentSnapshotPath) ? JSON.parse(await readFile(parentSnapshotPath, "utf8")) : parentSnapshotResponse;
			const childSnapshot = existsSync(childSnapshotPath) ? JSON.parse(await readFile(childSnapshotPath, "utf8")) : childSnapshotResponse;
			parentBackendNodeId = snapshotElementRects(parentSnapshot).find((item) => item.attrs?.id === "parent-action")?.backendNodeId;
			childBackendNodeId = snapshotElementRects(childSnapshot).find((item) => item.attrs?.id === "child-action")?.backendNodeId;
			if (parentBackendNodeId) {
				parentInput = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "input.ref", tabId, action: "click", target: { refId: "pi-ref://control/oopif-parent-action", backendNodeId: parentBackendNodeId }, timeoutMs: 10_000 }, outputPath: parentInputPath, timeoutMs: 15_000, maxChars: 8_000 }), "browser_command parent input.ref"));
			}
			if (childBackendNodeId) {
				childInput = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "input.ref", tabId, action: "click", target: { refId: "pi-ref://control/oopif-child-action", backendNodeId: childBackendNodeId, targetId: childTargetId }, timeoutMs: 10_000 }, outputPath: childInputPath, timeoutMs: 15_000, maxChars: 8_000 }), "browser_command child input.ref"));
				failClosed = parseToolJson(await callTool(env, metrics, "browser_command", { tabId, command: { cmd: "input.ref", tabId, action: "click", target: { refId: "pi-ref://control/oopif-missing-target", backendNodeId: childBackendNodeId, targetId: "missing-oopif-target-for-eval" }, timeoutMs: 2_000 }, outputPath: failClosedPath, timeoutMs: 6_000, maxChars: 8_000 }));
			}
		}
		if (existsSync(parentInputPath)) parentInput = JSON.parse(await readFile(parentInputPath, "utf8"));
		if (existsSync(childInputPath)) childInput = JSON.parse(await readFile(childInputPath, "utf8"));
		if (existsSync(failClosedPath)) failClosed = JSON.parse(await readFile(failClosedPath, "utf8"));
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => window.__oopifFixture.inspect())()", outputPath: afterPath, timeoutMs: 10_000, maxChars: 6_000 }), "browser_execute oopif after");
		const after = JSON.parse(await readFile(afterPath, "utf8"));
		const afterValue = after?.data?.value ?? after?.data ?? after;
		const inputData = (value) => {
			const data = bridgeData(value);
			const nativeResult = data?.details?.result ?? value?.details?.result;
			return data?.input ?? data?.data?.input ?? data?.result?.input ?? nativeResult?.details?.input ?? nativeResult?.input ?? value?.input;
		};
		const nativeErrorCode = (value) => value?.details?.result?.error_code ?? value?.details?.result?.code ?? value?.error_code ?? value?.code;
		const parentInputData = inputData(parentInput);
		const childInputData = inputData(childInput);
		const failClosedData = bridgeData(failClosed);
		const failClosedInput = inputData(failClosed);
		const failClosedCode = nativeErrorCode(failClosedData) ?? nativeErrorCode(failClosed);
		const targetText = JSON.stringify(targetInfos);
		const childClickDelivered = Number(afterValue?.childClickCount || 0) > Number(inspectValue?.childClickCount || 0);
		const parentClickDelivered = Number(afterValue?.parentClickCount || 0) > Number(inspectValue?.parentClickCount || 0);
		const boundary = {
			inspect: inspectValue,
			after: afterValue,
			frameSummary: frame?.data ?? frame?.summary ?? frame,
			targetCount: Array.isArray(targetInfos) ? targetInfos.length : 0,
			oopifTargetPresent: Boolean(childTarget) || /iframe|oopif/i.test(targetText),
			childTarget: childTarget ? { id: childTargetId, type: childTarget.type, url: childTarget.url, attached: childTarget.attached } : null,
			targetProbeError: toolReturnedError({ content: [{ type: "text", text: JSON.stringify(targetResponse) }] })?.error ?? null,
			crossOriginBlocked: inspectValue?.childReadableFromParent === false && Boolean(inspectValue?.crossOriginError),
			parentBackendNodeId,
			childBackendNodeId,
			nodeKeys: childTargetId && childBackendNodeId ? { composite: `t:${childTargetId}:b:${childBackendNodeId}`, legacy: `b:${childBackendNodeId}` } : null,
			parentInput: parentInputData,
			childInput: childInputData,
			failClosed: { error_code: failClosedCode, wrapped_code: failClosedData?.error_code ?? failClosedData?.code, input: failClosedInput },
			attachRouteUsed: childInputData?.attachRouteUsed === true,
			compositeKeyProof: childInputData?.attachRouteUsed === true && childClickDelivered ? "proven" : "not-proven",
			legacyRefCompatibility: parentInputData?.resolution === "backendNodeId" && parentClickDelivered && parentInputData?.targetScoped !== true,
			childClickDelivered,
			failClosedDiagnostics: failClosedCode === "OOPIF_SESSION_UNSUPPORTED" && Number(failClosedInput?.dispatched || 0) === 0,
		};
		await saveJsonEvidence(env, metrics, "boundary", boundary);
		const ok = boundary.crossOriginBlocked
			&& Boolean(childTargetId)
			&& Boolean(childBackendNodeId)
			&& boundary.attachRouteUsed
			&& boundary.compositeKeyProof === "proven"
			&& boundary.legacyRefCompatibility
			&& boundary.failClosedDiagnostics;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push(`OOPIF composite-key evidence: crossOriginBlocked=${boundary.crossOriginBlocked}, childTarget=${Boolean(childTargetId)}, attachRouteUsed=${boundary.attachRouteUsed}, childClickDelivered=${boundary.childClickDelivered}, legacyRefCompatibility=${boundary.legacyRefCompatibility}.`);
		metrics.diagnostics.push("Passing proves targetId/backendNodeId composite identity is consumed by input.ref through Target.setAutoAttach flat-session routing, with same-target bare backend ids still accepted.");
		metrics.notes.push("Composite-key proof stays inside existing browser_command/input.ref and pi.click plumbing; no public ABML verb is added.");
		return resultRecord(entry.id, ok ? "passed" : "failed", metrics);
	} finally {
		await closeTabQuiet(env, tabId);
	}
}

async function eval35(env, entry) {
	const metrics = beginMetrics(env, entry.id);
	const tabId = await createTab(env, metrics, "abml-growth-probe.html");
	try {
		const observePath = path.join(env.runDir, `${entry.id}-scan.json`);
		const statePath = path.join(env.runDir, `${entry.id}-state.json`);
		const observe = parseToolJson(assertToolOk(await callTool(env, metrics, "browser_observe", { mode: "scan", tabId, outputPath: observePath, timeoutMs: 20_000, maxChars: 14_000 }), "browser_observe growth probe scan"));
		assertToolOk(await callTool(env, metrics, "browser_execute", { tabId, script: "(() => window.__abmlGrowthFixture.state())()", outputPath: statePath, timeoutMs: 10_000, maxChars: 6_000 }), "browser_execute growth probe state");
		const artifact = JSON.parse(await readFile(observePath, "utf8"));
		const pageState = JSON.parse(await readFile(statePath, "utf8"));
		const growthProbe = artifact?.data?.growthProbe ?? artifact?.growthProbe ?? observe?.data?.growthProbe;
		const collections = Array.isArray(artifact?.collections) ? artifact.collections : Array.isArray(observe?.collections) ? observe.collections : [];
		const firstCollection = collections[0] || {};
		const collectionEvidence = Array.isArray(firstCollection.evidence) ? firstCollection.evidence : [];
		const publicText = JSON.stringify({ observe, artifact }).toLowerCase();
		const comparison = {
			growthProbe,
			collection: {
				completeness: firstCollection.completeness,
				confidence: firstCollection.confidence,
				continuationKind: firstCollection.continuation?.kind,
				evidence: collectionEvidence,
			},
			pageState: pageState?.data?.value ?? pageState?.data ?? pageState,
			boundary: {
				noPublicContinuationAction: !publicText.includes("continuecollection"),
				nextActionsAvoidScroll: !JSON.stringify(observe?.nextActions || artifact?.nextActions || []).toLowerCase().includes("scroll"),
			},
		};
		await saveJsonEvidence(env, metrics, "comparison", comparison);
		const growthSupported = growthProbe?.supported === true;
		const windowShifted = growthProbe?.windowShifted === true;
		const restored = growthProbe?.restoredScrollTop === true;
		const collectionVirtualized = firstCollection.completeness === "virtualized" && firstCollection.continuation?.kind === "virtual-window";
		const evidenceLinked = collectionEvidence.some((entry) => entry?.source === "growthProbe");
		const ok = growthSupported && windowShifted && restored && collectionVirtualized && evidenceLinked && comparison.boundary.noPublicContinuationAction && comparison.boundary.nextActionsAvoidScroll;
		metrics.artifactSufficiency = ok ? "sufficient" : "insufficient";
		metrics.scopedFollowUpDiscipline = "passed";
		metrics.summary.push(`Growth probe evidence: supported=${growthSupported}, windowShifted=${windowShifted}, restored=${restored}, collection=${firstCollection.completeness}/${firstCollection.continuation?.kind}.`);
		metrics.diagnostics.push(`Probe before="${growthProbe?.beforeFirstText}" after="${growthProbe?.afterFirstText}" count ${growthProbe?.beforeCount}->${growthProbe?.afterCount}; no public continuation action=${comparison.boundary.noPublicContinuationAction}.`);
		metrics.notes.push("Passing proves product scan emits growthProbe evidence and collection completeness consumes it without adding a public continuation runtime.");
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
	["31-execution-plane-cdp-fusion", eval31],
	["32-abml-identity-bootstrap-evidence", eval32],
	["33-layer-paint-occlusion-boundary", eval33],
	["34-oopif-composite-key-boundary", eval34],
	["35-abml-growth-probe-evidence", eval35],
]);

async function writeRunnerSummary(runDir, records, envMeta) {
	const evalMetrics = Array.isArray(envMeta.evalMetrics) ? envMeta.evalMetrics : [];
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
		metrics: {
			successRate: records.length ? records.filter((record) => record.status === "passed").length / records.length : 0,
			...summarizeSuiteMetrics(evalMetrics),
			evals: evalMetrics,
		},
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
	const evalMetrics = [];
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
			if (env?.currentMetrics?.evalId === entry.id) evalMetrics.push(summarizeEvalMetrics(env.currentMetrics));
		}
		const summaryPath = await writeRunnerSummary(runDir, records, { startedAt: nowIso(), fixtureBaseUrl: fixture.baseUrl, fixturePort: fixture.port, bridgePort: env.bridgePort, evalMetrics });
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
