import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIsolatedSmokePreflight } from "../smoke/isolatedSmokePreflight.mjs";
import { classifyBridgePortOwner, diagnoseBridgePortInUse } from "../smoke/smokePortDiagnostics.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "expected tcp address");
	const port = address.port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function withServer(handler) {
	const server = createServer(handler);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "expected server address");
	try {
		return await diagnoseBridgePortInUse({ host: "127.0.0.1", port: address.port, error: { code: "BRIDGE_START_FAILED", message: `listen EADDRINUSE 127.0.0.1:${address.port}` } });
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

async function withPreflightFixture(run) {
	const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "pi-browser-smoke-preflight-"));
	const extensionDir = path.join(workspaceRoot, "bridge", "pi_browser_bridge");
	const scriptsDir = path.join(workspaceRoot, "scripts");
	await mkdir(extensionDir, { recursive: true });
	await mkdir(scriptsDir, { recursive: true });
	await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({
		manifest_version: 3,
		background: { service_worker: "dist/service-worker.js" },
		content_scripts: [{ matches: ["<all_urls>"], js: ["dist/content.js", "dist/disable_dialogs.js"] }],
	}, null, 2), "utf8");
	await writeFile(path.join(scriptsDir, "build-bridge.mjs"), [
		'import { mkdir, writeFile } from "node:fs/promises";',
		'import path from "node:path";',
		'const dist = path.join(process.cwd(), "bridge", "pi_browser_bridge", "dist");',
		'await mkdir(dist, { recursive: true });',
		'await writeFile(path.join(dist, "service-worker.js"), "// fixture service worker\\n", "utf8");',
		'await writeFile(path.join(dist, "content.js"), "// fixture content\\n", "utf8");',
		'await writeFile(path.join(dist, "disable_dialogs.js"), "// fixture disable dialogs\\n", "utf8");',
		'await writeFile(path.join(dist, "hook_dispatcher.js"), "// fixture hook dispatcher\\n", "utf8");',
		'await writeFile(path.join(dist, "build-manifest.json"), JSON.stringify({ serviceWorkerBuildMode: "esm-import-graph", orderedConcatenation: false, legacyServiceWorkerModules: [], entries: [{ name: "service-worker" }, { name: "content" }] }, null, 2), "utf8");',
	].join("\n"), "utf8");
	try {
		return await run({ workspaceRoot, extensionDir });
	} finally {
		await rm(workspaceRoot, { recursive: true, force: true });
	}
}

assert.equal(classifyBridgePortOwner({
	health: { ok: true, json: { name: "pi-browser-tools" } },
	owners: [{ pid: 10, name: "node.exe", commandLine: "D:\\Pi\\agent\\cli.js" }],
}), "agent_occupies", "smoke diagnostics must classify a healthy Pi bridge as agent_occupies");

assert.equal(classifyBridgePortOwner({
	health: { ok: true, json: { name: "pi-browser-tools" } },
	owners: [{ pid: 11, name: "node.exe", commandLine: "node tests/smoke/smoke-browser.mjs" }],
}), "orphan_socket", "smoke diagnostics must classify leftover smoke/node listeners as orphan_socket");

assert.equal(classifyBridgePortOwner({
	health: { ok: false },
	owners: [{ pid: 12, name: "custom.exe", commandLine: "custom.exe --listen 18765" }],
}), "unknown_owner", "smoke diagnostics must preserve an unknown process classification");

const occupiedDiagnosis = await withServer((req, res) => {
	if (req.url === "/health") {
		const body = JSON.stringify({ ok: true, name: "pi-browser-tools" });
		res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
		res.end(body);
		return;
	}
	res.writeHead(404);
	res.end();
});
assert.equal(occupiedDiagnosis.reason, "agent_occupies", "smoke diagnostics must probe occupied bridge health");
assert.equal(occupiedDiagnosis.health.ok, true, "occupied bridge diagnostic must include health evidence");

const freeDiagnosis = await diagnoseBridgePortInUse({ host: "127.0.0.1", port: await freePort(), error: { code: "BRIDGE_START_FAILED", message: "fixture free-port check" } });
assert.equal(freeDiagnosis.reason, "unknown_owner", "free-port diagnostic must not invent a Pi owner");
assert.equal(freeDiagnosis.health.ok, false, "free-port diagnostic must preserve failed health evidence");

await withPreflightFixture(async ({ workspaceRoot, extensionDir }) => {
	const disabled = await resolveIsolatedSmokePreflight({ workspaceRoot, extensionSource: extensionDir, autoBuild: false });
	assert.equal(disabled.ok, false, "preflight must fail deterministically when dist runtime is missing and auto-build is disabled");
	assert.equal(disabled.reason, "autobuild_disabled", "preflight must surface autobuild_disabled when the workspace bridge can be built but auto-build is turned off");
	assert(disabled.missingPaths.some((item) => item.endsWith(path.join("dist", "build-manifest.json"))), "preflight must report build-manifest.json as a missing runtime prerequisite");
	assert.equal(disabled.autoBuild.attempted, false, "preflight must not attempt a build when auto-build is disabled");

	const enabled = await resolveIsolatedSmokePreflight({ workspaceRoot, extensionSource: extensionDir, autoBuild: true });
	assert.equal(enabled.ok, true, "preflight must auto-build the workspace bridge dist runtime when prerequisites are missing");
	assert.equal(enabled.reason, "auto_built", "preflight must report auto_built after generating the missing dist runtime");
	assert.equal(enabled.autoBuild.attempted, true, "preflight must record that it invoked the bridge build");
	assert.equal(enabled.buildManifest?.serviceWorkerBuildMode, "esm-import-graph", "preflight must surface build-manifest metadata after auto-build");
	assert.deepEqual(enabled.missingPaths, [], "preflight must clear missing runtime paths after a successful auto-build");
});

const smoke = read("tests/smoke/smoke-browser.mjs");
assert(smoke.includes("diagnoseBridgePortInUse") && smoke.includes('record("bridge.port"'), "smoke-browser must emit bridge.port diagnostics on bridge start conflicts");
for (const step of ["browser_orchestrate.plan", "browser_orchestrate.apply", "browser_orchestrate.status", "browser_orchestrate.selfHeal", "browser_orchestrate.delete"]) assert(smoke.includes(step), `smoke-browser must cover orchestration step ${step}`);
for (const step of ["browser_orchestrate.persistenceApply", "browser_orchestrate.persistenceLoad", "browser_orchestrate.persistenceStaleDelete", "browser_orchestrate.persistenceBadAdoption", "browser_orchestrate.persistenceAdopt", "browser_orchestrate.persistenceDelete", "browser_orchestrate.persistenceArtifact"]) assert(smoke.includes(step), `smoke-browser must cover persistence/adoption orchestration step ${step}`);
for (const step of ["browser_orchestrate.preNavPlan", "browser_orchestrate.preNavApply", "browser_orchestrate.preNavEffect", "browser_orchestrate.preNavStop", "browser_orchestrate.preNavDelete", "browser_orchestrate.preNavArtifact"]) assert(smoke.includes(step), `smoke-browser must cover pre-navigation hook orchestration step ${step}`);
for (const step of ["browser_orchestrate.windowPlan", "browser_orchestrate.windowApply", "browser_orchestrate.windowStatus", "browser_orchestrate.windowDelete", "browser_orchestrate.windowArtifact"]) assert(smoke.includes(step), `smoke-browser must cover window/tabGroups orchestration step ${step}`);
for (const step of ["browser_orchestrate.profileIsolationPlan", "browser_orchestrate.profileIsolationApply", "browser_orchestrate.profileIsolationStorage", "browser_orchestrate.profileIsolationDeleteA", "browser_orchestrate.profileIsolationDelete", "browser_orchestrate.profileIsolationArtifact"]) assert(smoke.includes(step), `smoke-browser must cover managed profile isolation orchestration step ${step}`);
for (const step of ["browser_orchestrate.assertionsApplyFail", "browser_orchestrate.assertionsStatusFail", "browser_orchestrate.assertionsApplyPass", "browser_orchestrate.assertionsStatusPass", "browser_orchestrate.assertionsLogicalTarget", "browser_orchestrate.assertionsArtifact"]) assert(smoke.includes(step), `smoke-browser must cover sessionAssertions orchestration step ${step}`);
assert(smoke.includes("profile-isolation-result.json") && smoke.includes("local_redacted_profile_isolation") && smoke.includes("forbiddenCookieAbsent") && smoke.includes("forbiddenLocalAbsent") && smoke.includes("forbiddenSessionAbsent"), "smoke-browser must verify profile A/B cookie/localStorage/sessionStorage isolation and redacted artifact output");
assert(smoke.includes("smoke-orchestration-assertions-result.json") && smoke.includes("local_redacted_session_assertions") && smoke.includes("sessionAssertions") && smoke.includes("data-pre-nav") && smoke.includes("ORCHESTRATION_ASSERTION_FAILED"), "smoke-browser must verify sessionAssertions pass/fail diagnostics, pre-navigation assertion evidence, and redacted artifact output");
assert(smoke.includes("preNavigationHooks") && smoke.includes("installPreNavigationHook") && smoke.includes("__PI_BROWSER_PAGE_SCRIPT_PRE_NAV_PRESENT__") && smoke.includes("smoke-pre-navigation-hook-result.json"), "smoke-browser must verify document-start pre-navigation hook effects and artifact output");
assert(smoke.includes("ownedWindow") && smoke.includes("visualGrouping") && smoke.includes("groupTabs") && smoke.includes("closeWindow"), "smoke-browser must create owned windows and exercise visual grouping cleanup");
assert(smoke.includes("PI_BROWSER_SMOKE_BROWSER_RESULT_PATH") && smoke.includes("smoke-orchestration-result.json") && smoke.includes("smoke-window-tabgroups-result.json") && smoke.includes("smoke-orchestration-persistence-result.json") && smoke.includes("smoke-orchestration-assertions-result.json"), "smoke-browser must write configurable smoke and orchestration full-envelope artifacts");
const isolatedSmoke = read("tests/smoke/smoke-browser-isolated.mjs");
const releaseAcceptance = read("tests/release/release-local-acceptance.mjs");
const pkg = JSON.parse(read("package.json"));
assert(pkg.scripts?.["smoke:browser:isolated"]?.includes("smoke-browser-isolated.mjs"), "package must expose isolated browser smoke");
assert(isolatedSmoke.includes("--user-data-dir") && isolatedSmoke.includes("--load-extension") && isolatedSmoke.includes("PI_BROWSER_BRIDGE_PORT") && isolatedSmoke.includes("smoke-browser-isolated-results.json"), "isolated smoke must launch a temporary Chrome profile, patch a temporary extension port, and write an artifact");
assert(isolatedSmoke.includes("ensureIsolatedSmokePreflight") && isolatedSmoke.includes("preflight") && isolatedSmoke.includes("PI_BROWSER_SMOKE_AUTO_BUILD"), "isolated smoke must preflight dist runtime readiness and expose auto-build diagnostics");
assert(isolatedSmoke.includes("extractOrchestrationDiagnostics") && isolatedSmoke.includes("PI_BROWSER_SMOKE_BROWSER_RESULT_PATH"), "isolated smoke must surface orchestration diagnostics from the inner smoke artifact");
assert(isolatedSmoke.includes("windowTabGroups") && isolatedSmoke.includes("windowIds") && isolatedSmoke.includes("groupIds") && isolatedSmoke.includes("tabGroupsStatuses"), "isolated smoke must surface window/tabGroups diagnostics from the inner smoke artifact");
assert(isolatedSmoke.includes("preNavigationHooks") && isolatedSmoke.includes("preNavigationOrchestrationId") && isolatedSmoke.includes("effectVerifiedCount") && isolatedSmoke.includes("installCount") && isolatedSmoke.includes("uninstallCount"), "isolated smoke must surface pre-navigation hook diagnostics from the inner smoke artifact");
assert(isolatedSmoke.includes("profileIsolation") && isolatedSmoke.includes("profileIds") && isolatedSmoke.includes("bridgePorts") && isolatedSmoke.includes("cookieIsolation") && isolatedSmoke.includes("storageIsolation"), "isolated smoke must surface managed profile isolation diagnostics from the inner smoke artifact");
assert(isolatedSmoke.includes("assertions") && isolatedSmoke.includes("satisfiedOrchestrationId") && isolatedSmoke.includes("unsatisfiedOrchestrationId") && isolatedSmoke.includes("logicalTargetSource") && isolatedSmoke.includes("artifactPrivacy"), "isolated smoke must surface sessionAssertions diagnostics from the inner smoke artifact");
assert(releaseAcceptance.includes("orchestrationId") && releaseAcceptance.includes("operationResults") && releaseAcceptance.includes("artifactPaths") && releaseAcceptance.includes("preflight"), "release smoke failure diagnostics must include orchestration id, operation results, artifact paths, and preflight diagnostics");
assert(releaseAcceptance.includes("windowTabGroups") && releaseAcceptance.includes("bindings"), "release smoke diagnostics must include window/tabGroups binding diagnostics");
assert(releaseAcceptance.includes("preNavigationHooks"), "release smoke diagnostics must include pre-navigation hook diagnostics");
assert(releaseAcceptance.includes("profileIsolation"), "release smoke diagnostics must include managed profile isolation diagnostics");
assert(releaseAcceptance.includes("assertions"), "release smoke diagnostics must include sessionAssertions diagnostics");
for (const reason of ["agent_occupies", "orphan_socket", "unknown_owner"]) {
	assert(read("AI_INSTALL.md").includes(reason), `AI_INSTALL.md must document smoke port reason ${reason}`);
	assert(read("README.md").includes(reason), `README.md must document smoke port reason ${reason}`);
}
assert(read("AI_INSTALL.md").includes("PI_BROWSER_SMOKE_AUTO_BUILD=0") && read("AI_INSTALL.md").includes("preflight.reason"), "AI_INSTALL.md must document isolated smoke preflight auto-build diagnostics");
assert(read("README.md").includes("PI_BROWSER_SMOKE_AUTO_BUILD=0") && read("README.md").includes("build-manifest.json"), "README.md must document isolated smoke preflight and manual opt-out");


console.log("smoke diagnostics contract ok");
