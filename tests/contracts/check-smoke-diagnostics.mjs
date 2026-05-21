import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const smoke = read("tests/smoke/smoke-browser.mjs");
assert(smoke.includes("diagnoseBridgePortInUse") && smoke.includes('record("bridge.port"'), "smoke-browser must emit bridge.port diagnostics on bridge start conflicts");
for (const step of ["browser_orchestrate.plan", "browser_orchestrate.apply", "browser_orchestrate.status", "browser_orchestrate.selfHeal", "browser_orchestrate.delete"]) assert(smoke.includes(step), `smoke-browser must cover orchestration step ${step}`);
for (const step of ["browser_orchestrate.preNavPlan", "browser_orchestrate.preNavApply", "browser_orchestrate.preNavEffect", "browser_orchestrate.preNavStop", "browser_orchestrate.preNavDelete", "browser_orchestrate.preNavArtifact"]) assert(smoke.includes(step), `smoke-browser must cover pre-navigation hook orchestration step ${step}`);
for (const step of ["browser_orchestrate.windowPlan", "browser_orchestrate.windowApply", "browser_orchestrate.windowStatus", "browser_orchestrate.windowDelete", "browser_orchestrate.windowArtifact"]) assert(smoke.includes(step), `smoke-browser must cover window/tabGroups orchestration step ${step}`);
assert(smoke.includes("preNavigationHooks") && smoke.includes("installPreNavigationHook") && smoke.includes("__PI_BROWSER_PAGE_SCRIPT_PRE_NAV_PRESENT__") && smoke.includes("smoke-pre-navigation-hook-result.json"), "smoke-browser must verify document-start pre-navigation hook effects and artifact output");
assert(smoke.includes("ownedWindow") && smoke.includes("visualGrouping") && smoke.includes("groupTabs") && smoke.includes("closeWindow"), "smoke-browser must create owned windows and exercise visual grouping cleanup");
assert(smoke.includes("PI_BROWSER_SMOKE_BROWSER_RESULT_PATH") && smoke.includes("smoke-orchestration-result.json") && smoke.includes("smoke-window-tabgroups-result.json"), "smoke-browser must write configurable smoke and orchestration full-envelope artifacts");
const isolatedSmoke = read("tests/smoke/smoke-browser-isolated.mjs");
const releaseAcceptance = read("tests/release/release-local-acceptance.mjs");
const pkg = JSON.parse(read("package.json"));
assert(pkg.scripts?.["smoke:browser:isolated"]?.includes("smoke-browser-isolated.mjs"), "package must expose isolated browser smoke");
assert(isolatedSmoke.includes("--user-data-dir") && isolatedSmoke.includes("--load-extension") && isolatedSmoke.includes("PI_BROWSER_BRIDGE_PORT") && isolatedSmoke.includes("smoke-browser-isolated-results.json"), "isolated smoke must launch a temporary Chrome profile, patch a temporary extension port, and write an artifact");
assert(isolatedSmoke.includes("extractOrchestrationDiagnostics") && isolatedSmoke.includes("PI_BROWSER_SMOKE_BROWSER_RESULT_PATH"), "isolated smoke must surface orchestration diagnostics from the inner smoke artifact");
assert(isolatedSmoke.includes("windowTabGroups") && isolatedSmoke.includes("windowIds") && isolatedSmoke.includes("groupIds") && isolatedSmoke.includes("tabGroupsStatuses"), "isolated smoke must surface window/tabGroups diagnostics from the inner smoke artifact");
assert(isolatedSmoke.includes("preNavigationHooks") && isolatedSmoke.includes("preNavigationOrchestrationId") && isolatedSmoke.includes("effectVerifiedCount") && isolatedSmoke.includes("installCount") && isolatedSmoke.includes("uninstallCount"), "isolated smoke must surface pre-navigation hook diagnostics from the inner smoke artifact");
assert(releaseAcceptance.includes("orchestrationId") && releaseAcceptance.includes("operationResults") && releaseAcceptance.includes("artifactPaths"), "release smoke failure diagnostics must include orchestration id, operation results, and artifact paths");
assert(releaseAcceptance.includes("windowTabGroups") && releaseAcceptance.includes("bindings"), "release smoke diagnostics must include window/tabGroups binding diagnostics");
assert(releaseAcceptance.includes("preNavigationHooks"), "release smoke diagnostics must include pre-navigation hook diagnostics");
for (const reason of ["agent_occupies", "orphan_socket", "unknown_owner"]) {
	assert(read("AI_INSTALL.md").includes(reason), `AI_INSTALL.md must document smoke port reason ${reason}`);
	assert(read("README.md").includes(reason), `README.md must document smoke port reason ${reason}`);
}

console.log("smoke diagnostics contract ok");
