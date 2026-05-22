import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.resolve(root, ".pi", "browser-artifacts");
const tempRoot = path.resolve(root, ".pi", "temp-profiles");
const extensionSource = path.resolve(process.env.PI_BROWSER_SMOKE_EXTENSION_DIR || path.join(root, "bridge", "pi_browser_bridge"));
const resultPath = path.resolve(process.env.PI_BROWSER_SMOKE_RESULT_PATH || path.join(outDir, "smoke-browser-isolated-results.json"));
const chromeCandidates = [
	process.env.PI_BROWSER_SMOKE_CHROME,
	process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
	process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
	process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean);

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isWindowsChromeExecutable(chromeExe) {
	return process.platform !== "win32" && /\.exe$/i.test(String(chromeExe || "")) && /^\/mnt\/[a-z]\//i.test(String(chromeExe || ""));
}
function windowsPathForChrome(value, chromeExe) {
	if (!isWindowsChromeExecutable(chromeExe)) return value;
	const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(String(value || ""));
	if (!match) return value;
	return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}
function powershellString(value) {
	return `'${String(value || "").replace(/'/g, "''")}'`;
}
function stopWindowsChromeForProfile(chromeExe, profileDir, debugPort) {
	if (!isWindowsChromeExecutable(chromeExe)) return;
	const profileNeedle = windowsPathForChrome(profileDir, chromeExe);
	const debugNeedle = `--remote-debugging-port=${debugPort}`;
	const command = [
		`$profileNeedle=${powershellString(profileNeedle)};`,
		`$debugNeedle=${powershellString(debugNeedle)};`,
		"Get-CimInstance Win32_Process |",
		"Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($profileNeedle) -or $_.CommandLine.Contains($debugNeedle)) } |",
		"ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
	].join(" ");
	spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "ignore" });
}
function chromePath() {
	for (const candidate of chromeCandidates) if (existsSync(candidate)) return candidate;
	throw new Error(`Chrome/Chromium executable not found; set PI_BROWSER_SMOKE_CHROME. Tried: ${chromeCandidates.join(", ")}`);
}
function innerSmokeResultPath(isolatedResultPath) {
	const base = path.basename(isolatedResultPath).replace(/-isolated-results\.json$/, "-results.json");
	return path.join(path.dirname(isolatedResultPath), base === path.basename(isolatedResultPath) ? "smoke-browser-results.json" : base);
}
async function readJsonFile(file) {
	try { return JSON.parse(await readFile(file, "utf8")); }
	catch { return undefined; }
}
function extractOrchestrationDiagnostics(smokeArtifact) {
	const results = Array.isArray(smokeArtifact?.results) ? smokeArtifact.results : [];
	const orchestrationSteps = results.filter((item) => String(item.step || "").startsWith("browser_orchestrate."));
	const windowSteps = orchestrationSteps.filter((item) => String(item.step || "").startsWith("browser_orchestrate.window"));
	const preNavSteps = orchestrationSteps.filter((item) => String(item.step || "").startsWith("browser_orchestrate.preNav"));
	const profileSteps = orchestrationSteps.filter((item) => String(item.step || "").startsWith("browser_orchestrate.profileIsolation"));
	const assertionSteps = orchestrationSteps.filter((item) => String(item.step || "").startsWith("browser_orchestrate.assertions"));
	const windowApplyStep = windowSteps.find((item) => item.step === "browser_orchestrate.windowApply");
	const windowArtifactStep = windowSteps.find((item) => item.step === "browser_orchestrate.windowArtifact");
	const windowDeleteStep = windowSteps.find((item) => item.step === "browser_orchestrate.windowDelete");
	const preNavApplyStep = preNavSteps.find((item) => item.step === "browser_orchestrate.preNavApply");
	const preNavArtifactStep = preNavSteps.find((item) => item.step === "browser_orchestrate.preNavArtifact");
	const preNavStopStep = preNavSteps.find((item) => item.step === "browser_orchestrate.preNavStop");
	const preNavDeleteStep = preNavSteps.find((item) => item.step === "browser_orchestrate.preNavDelete");
	const profileApplyStep = profileSteps.find((item) => item.step === "browser_orchestrate.profileIsolationApply");
	const profileStorageStep = profileSteps.find((item) => item.step === "browser_orchestrate.profileIsolationStorage");
	const profileDeleteAStep = profileSteps.find((item) => item.step === "browser_orchestrate.profileIsolationDeleteA");
	const profileDeleteStep = profileSteps.find((item) => item.step === "browser_orchestrate.profileIsolationDelete");
	const profileArtifactStep = profileSteps.find((item) => item.step === "browser_orchestrate.profileIsolationArtifact");
	const assertionsApplyFailStep = assertionSteps.find((item) => item.step === "browser_orchestrate.assertionsApplyFail");
	const assertionsStatusFailStep = assertionSteps.find((item) => item.step === "browser_orchestrate.assertionsStatusFail");
	const assertionsApplyPassStep = assertionSteps.find((item) => item.step === "browser_orchestrate.assertionsApplyPass");
	const assertionsStatusPassStep = assertionSteps.find((item) => item.step === "browser_orchestrate.assertionsStatusPass");
	const assertionsLogicalTargetStep = assertionSteps.find((item) => item.step === "browser_orchestrate.assertionsLogicalTarget");
	const assertionsArtifactStep = assertionSteps.find((item) => item.step === "browser_orchestrate.assertionsArtifact");
	const orchestrationId = orchestrationSteps.find((item) => typeof item.orchestrationId === "string")?.orchestrationId;
	const windowOrchestrationId = windowSteps.find((item) => typeof item.orchestrationId === "string")?.orchestrationId;
	const preNavigationOrchestrationId = preNavSteps.find((item) => typeof item.orchestrationId === "string")?.orchestrationId;
	const operationResults = orchestrationSteps.flatMap((item) => Array.isArray(item.operationResults) ? item.operationResults : []);
	const bindings = orchestrationSteps.flatMap((item) => Array.isArray(item.bindings) ? item.bindings : []);
	const windowOperationResults = [windowApplyStep, windowDeleteStep].flatMap((item) => Array.isArray(item?.operationResults) ? item.operationResults : []);
	const windowBindings = Array.isArray(windowApplyStep?.bindings) ? windowApplyStep.bindings : Array.isArray(windowArtifactStep?.bindings) ? windowArtifactStep.bindings : [];
	const preNavigationOperationResults = [preNavApplyStep, preNavStopStep, preNavDeleteStep].flatMap((item) => Array.isArray(item?.operationResults) ? item.operationResults : []);
	const preNavigationBindings = Array.isArray(preNavApplyStep?.bindings) ? preNavApplyStep.bindings : Array.isArray(preNavArtifactStep?.bindings) ? preNavArtifactStep.bindings : [];
	const profileOperationResults = [profileApplyStep, profileDeleteAStep, profileDeleteStep].flatMap((item) => Array.isArray(item?.operationResults) ? item.operationResults : []);
	const profileBindings = Array.isArray(profileApplyStep?.bindings) ? profileApplyStep.bindings : [];
	const artifactPaths = orchestrationSteps.map((item) => item.path).filter((item) => typeof item === "string");
	const windowTabGroups = {
		windowOrchestrationId,
		windowIds: Array.from(new Set(windowBindings.map((item) => item.windowId).filter((item) => typeof item === "number"))),
		groupIds: Array.from(new Set(windowBindings.map((item) => item.groupId).filter((item) => typeof item === "number"))),
		tabGroupsStatuses: Array.from(new Set([
			...windowBindings.map((item) => item.tabGroupsStatus).filter(Boolean),
			...windowOperationResults.map((item) => item.tabGroupsStatus).filter(Boolean),
		])),
		windowOwnedCount: windowBindings.filter((item) => item.windowOwned === true).length,
		closeWindowCount: windowOperationResults.filter((item) => item.action === "closeWindow").length,
		groupTabsStatus: windowOperationResults.find((item) => item.action === "groupTabs")?.status,
	};
	const preNavigationHooks = {
		preNavigationOrchestrationId,
		hookIds: Array.from(new Set(preNavigationBindings.flatMap((item) => Array.isArray(item.preNavigationHooks) ? item.preNavigationHooks.map((hook) => hook.hookId).filter(Boolean) : []))),
		identifiers: Array.from(new Set(preNavigationBindings.flatMap((item) => Array.isArray(item.preNavigationHooks) ? item.preNavigationHooks.map((hook) => hook.identifier).filter(Boolean) : []))),
		effectVerifiedCount: preNavigationBindings.flatMap((item) => Array.isArray(item.preNavigationHooks) ? item.preNavigationHooks : []).filter((hook) => hook.effectVerifiedAt).length,
		installCount: preNavigationOperationResults.filter((item) => item.action === "installPreNavigationHook").length,
		uninstallCount: preNavigationOperationResults.filter((item) => item.action === "uninstallPreNavigationHook").length,
		effectStepOk: preNavSteps.find((item) => item.step === "browser_orchestrate.preNavEffect")?.ok === true,
	};
	const profileIsolation = {
		profileOrchestrationIds: Array.from(new Set(profileSteps.flatMap((item) => Array.isArray(item.orchestrationIds) ? item.orchestrationIds : typeof item.orchestrationId === "string" ? [item.orchestrationId] : []))),
		profileIds: Array.from(new Set(profileBindings.map((item) => item.profileId).filter(Boolean))),
		profiles: Array.isArray(profileApplyStep?.profiles) ? profileApplyStep.profiles : [],
		bridgePorts: Array.from(new Set((Array.isArray(profileApplyStep?.profiles) ? profileApplyStep.profiles : []).map((item) => item.bridgePort).filter((item) => typeof item === "number"))),
		operationResults: profileOperationResults,
		bindings: profileBindings,
		cookieIsolation: { a: profileStorageStep?.a?.cookiePresent === true && profileStorageStep?.a?.forbiddenCookieAbsent === true, b: profileStorageStep?.b?.cookiePresent === true && profileStorageStep?.b?.forbiddenCookieAbsent === true },
		storageIsolation: { a: profileStorageStep?.a?.localMatches === true && profileStorageStep?.a?.sessionMatches === true, b: profileStorageStep?.b?.localMatches === true && profileStorageStep?.b?.sessionMatches === true },
		deleteAOk: profileDeleteAStep?.ok === true,
		cleanup: profileDeleteStep?.cleanup || profileArtifactStep?.cleanup,
		artifactPath: profileArtifactStep?.path,
		artifactPrivacy: profileArtifactStep?.artifactPrivacy,
	};
	const assertions = {
		satisfiedOrchestrationId: assertionsApplyPassStep?.orchestrationId || assertionsArtifactStep?.satisfiedOrchestrationId,
		unsatisfiedOrchestrationId: assertionsApplyFailStep?.orchestrationId || assertionsArtifactStep?.unsatisfiedOrchestrationId,
		satisfied: assertionsApplyPassStep?.assertions || assertionsStatusPassStep?.assertions || assertionsArtifactStep?.satisfiedAssertions,
		unsatisfied: assertionsApplyFailStep?.assertions || assertionsStatusFailStep?.assertions || assertionsArtifactStep?.unsatisfiedAssertions,
		bindings: Array.isArray(assertionsApplyPassStep?.bindings) ? assertionsApplyPassStep.bindings : [],
		failures: [assertionsApplyFailStep, assertionsStatusFailStep].flatMap((item) => Array.isArray(item?.failures) ? item.failures : []),
		logicalTargetSource: assertionsLogicalTargetStep?.targetSource || assertionsArtifactStep?.logicalTargetSource,
		artifactPath: assertionsArtifactStep?.path,
		artifactPrivacy: assertionsArtifactStep?.artifactPrivacy,
		redaction: assertionsArtifactStep?.redaction,
	};
	return orchestrationSteps.length ? { orchestrationId, windowOrchestrationId, preNavigationOrchestrationId, steps: orchestrationSteps.map((item) => ({ step: item.step, ok: item.ok })), operationResults, bindings, windowOperationResults, windowBindings, windowTabGroups, preNavigationOperationResults, preNavigationBindings, preNavigationHooks, profileIsolation, assertions, artifactPaths } : undefined;
}
async function fetchJson(url) {
	const res = await fetch(url);
	return await res.json();
}

async function listChromeTargets(debugPort) {
	try {
		const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
		return Array.isArray(targets) ? targets : [];
	} catch {
		return [];
	}
}

function cdpSend(socket, id, method, params = {}) {
	return new Promise((resolve, reject) => {
		const onMessage = (data) => {
			let message;
			try { message = JSON.parse(String(data)); } catch { return; }
			if (message.id !== id) return;
			socket.off("message", onMessage);
			resolve(message);
		};
		socket.on("message", onMessage);
		socket.send(JSON.stringify({ id, method, params }), (error) => {
			if (error) {
				socket.off("message", onMessage);
				reject(error);
			}
		});
	});
}

async function wakeExtensionServiceWorker(target) {
	if (!target?.webSocketDebuggerUrl) return { ok: false, reason: "no_debugger_url" };
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	try {
		await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
		await cdpSend(socket, 1, "Runtime.enable");
		const evaluated = await cdpSend(socket, 2, "Runtime.evaluate", { expression: "globalThis.__PI_BROWSER_EXPERIMENTAL_BUILD__ || null", returnByValue: true });
		return { ok: true, result: evaluated?.result?.result?.value || null };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		socket.close();
	}
}

async function freePort(start, end) {
	for (let port = start; port <= end; port += 1) {
		const server = createServer();
		try {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
			await new Promise((resolve) => server.close(resolve));
			return port;
		} catch {
			await new Promise((resolve) => server.close(resolve));
		}
	}
	throw new Error(`No free port in range ${start}-${end}`);
}
async function patchExtensionPort(extensionDir, bridgePort) {
	const serviceWorkerPath = path.join(extensionDir, "dist", "service-worker.js");
	let source = await readFile(serviceWorkerPath, "utf8");
	source = source
		.replaceAll("127.0.0.1:18765", `127.0.0.1:${bridgePort}`)
		.replace(/PI_BROWSER_BRIDGE_PORT\s*=\s*18765/g, `PI_BROWSER_BRIDGE_PORT = ${bridgePort}`);
	await writeFile(serviceWorkerPath, source, "utf8");
}
function startNodeSmoke(env) {
	const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", "--import", "./scripts/register-ts-extension-loader.mjs", "tests/smoke/smoke-browser.mjs"], {
			cwd: root,
			env: { ...process.env, PI_BROWSER_SMOKE_EXTENSION_TIMEOUT_MS: "30000", ...env },
			stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => { stdout += chunk.toString(); process.stdout.write(chunk); });
	child.stderr.on("data", (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk); });
	return {
		child,
		done: new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }))),
	};
}

const runId = String(Date.now());
const profileDir = path.join(tempRoot, `smoke-profile-${runId}`);
const extensionDir = path.join(tempRoot, `smoke-extension-${runId}`);
let chrome;
let chromeExe;
let smokeChild;
let chromeStdout = "";
let chromeStderr = "";
let debugPort;
let chromeTargets = [];
let serviceWorkerWake;
let result = { ok: false, profileDir, extensionDir, extensionSource, resultPath, smokeResultPath: innerSmokeResultPath(resultPath) };
try {
	await mkdir(outDir, { recursive: true });
	await mkdir(path.dirname(resultPath), { recursive: true });
	await mkdir(tempRoot, { recursive: true });
	if (!existsSync(path.join(extensionSource, "manifest.json"))) throw new Error(`Pi Browser extension source is missing manifest.json: ${extensionSource}`);
	const bridgePort = await freePort(18766, 18800);
	const fixturePort = await freePort(8766, 8800);
	debugPort = await freePort(9229, 9260);
	await cp(extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	await patchExtensionPort(extensionDir, bridgePort);
	chromeExe = chromePath();
	const chromeProfileDir = windowsPathForChrome(profileDir, chromeExe);
	const chromeExtensionDir = windowsPathForChrome(extensionDir, chromeExe);
	const smokeResultPath = innerSmokeResultPath(resultPath);
	const smokeRun = startNodeSmoke({ PI_BROWSER_BRIDGE_PORT: String(bridgePort), PI_BROWSER_SMOKE_PORT: String(fixturePort), PI_BROWSER_SMOKE_REUSE_EXISTING: "1", PI_BROWSER_SMOKE_BROWSER_RESULT_PATH: smokeResultPath });
	smokeChild = smokeRun.child;
	await delay(1000);
	chrome = spawn(chromeExe, [
		`--user-data-dir=${chromeProfileDir}`,
		`--disable-extensions-except=${chromeExtensionDir}`,
		`--load-extension=${chromeExtensionDir}`,
		`--remote-debugging-port=${debugPort}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--enable-logging=stderr",
		"--v=0",
		`http://127.0.0.1:${fixturePort}/`,
	], { stdio: ["ignore", "pipe", "pipe"], detached: false });
	chrome.stdout.on("data", (chunk) => { chromeStdout += chunk.toString(); });
	chrome.stderr.on("data", (chunk) => { chromeStderr += chunk.toString(); });
	for (let i = 0; i < 40; i += 1) {
		chromeTargets = await listChromeTargets(debugPort);
		const serviceWorker = chromeTargets.find((target) => target.type === "service_worker" && String(target.url || "").includes("dist/service-worker.js"));
		if (serviceWorker) {
			serviceWorkerWake = await wakeExtensionServiceWorker(serviceWorker);
			break;
		}
		await delay(250);
	}
	const smoke = await smokeRun.done;
	const smokeArtifact = await readJsonFile(smokeResultPath);
	const orchestration = extractOrchestrationDiagnostics(smokeArtifact);
	result = { ok: smoke.code === 0, bridgePort, fixturePort, debugPort, chrome: chromeExe, profileDir, extensionDir, extensionSource, resultPath, smokeResultPath, orchestration, smokeArtifactSummary: smokeArtifact ? { ok: smokeArtifact.ok, resultCount: Array.isArray(smokeArtifact.results) ? smokeArtifact.results.length : 0, failedSteps: (Array.isArray(smokeArtifact.results) ? smokeArtifact.results : []).filter((item) => item.ok === false).map((item) => item.step) } : undefined, chromeProfileDir, chromeExtensionDir, smokeCode: smoke.code, smokeSignal: smoke.signal, serviceWorkerWake, chromeTargets: chromeTargets.map((target) => ({ type: target.type, title: target.title, url: target.url })), stdoutTail: smoke.stdout.slice(-4000), stderrTail: smoke.stderr.slice(-4000), chromeStdoutTail: chromeStdout.slice(-4000), chromeStderrTail: chromeStderr.slice(-4000) };
	process.exitCode = smoke.code === 0 ? 0 : 1;
} catch (error) {
	result = { ...result, ok: false, error: error instanceof Error ? error.message : String(error) };
	process.exitCode = 1;
} finally {
	if (chrome?.pid) {
		stopWindowsChromeForProfile(chromeExe, profileDir, debugPort);
		if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
		else chrome.kill("SIGTERM");
	}
	if (smokeChild && smokeChild.exitCode === null) smokeChild.kill("SIGTERM");
	const keepTemp = process.env.PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE === "1" && result.ok === false;
	if (keepTemp) result.tempPreserved = { profileDir, extensionDir };
	else {
		await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		await rm(extensionDir, { recursive: true, force: true }).catch(() => {});
	}
	await writeFile(resultPath, JSON.stringify(result, null, 2), "utf8");
	console.log(JSON.stringify(result, null, 2));
}
