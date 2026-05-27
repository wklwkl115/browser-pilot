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
const isolatedSmoke = read("tests/smoke/smoke-browser-isolated.mjs");
const scanSummarySmoke = read("tests/smoke/smoke-scan-summary.mjs");
const debuggerEvidenceSmoke = read("tests/smoke/smoke-debugger-evidence.mjs");
const pkg = JSON.parse(read("package.json"));
assert(pkg.scripts?.["smoke:browser:isolated"]?.includes("smoke-browser-isolated.mjs"), "package must expose isolated browser smoke");
assert(pkg.scripts?.["smoke:browser:scan-summary"]?.includes("smoke-scan-summary.mjs"), "package must expose scan summary runtime smoke");
assert(pkg.scripts?.["smoke:browser:debugger-evidence"]?.includes("smoke-debugger-evidence.mjs"), "package must expose debugger evidence runtime smoke");
assert(isolatedSmoke.includes("--user-data-dir") && isolatedSmoke.includes("--load-extension") && isolatedSmoke.includes("PI_BROWSER_BRIDGE_PORT") && isolatedSmoke.includes("smoke-browser-isolated-results.json"), "isolated smoke must launch a temporary Chrome profile, patch a temporary extension port, and write an artifact");
assert(scanSummarySmoke.includes("scan-high-entropy.html") && scanSummarySmoke.includes("summarizeScanData") && scanSummarySmoke.includes("smoke-browser-scan-summary-results.json"), "scan summary smoke must use the local high-entropy fixture, summarize scan output, and write a dedicated artifact");
assert(debuggerEvidenceSmoke.includes("debugger-evidence.html") && debuggerEvidenceSmoke.includes("Debugger.enable") && debuggerEvidenceSmoke.includes("Debugger.getScriptSource") && debuggerEvidenceSmoke.includes("smoke-browser-debugger-evidence-results.json"), "debugger evidence smoke must use the local debugger fixture, collect debugger evidence, and write a dedicated artifact");
for (const reason of ["agent_occupies", "orphan_socket", "unknown_owner"]) {
	assert(read("AI_INSTALL.md").includes(reason), `AI_INSTALL.md must document smoke port reason ${reason}`);
	assert(read("README.md").includes(reason), `README.md must document smoke port reason ${reason}`);
}
assert(read("AI_INSTALL.md").includes("npm run smoke:browser:scan-summary"), "AI_INSTALL.md must document scan summary runtime smoke");
assert(read("README.md").includes("npm run smoke:browser:scan-summary"), "README.md must document scan summary runtime smoke");
assert(read("AI_INSTALL.md").includes("npm run smoke:browser:debugger-evidence"), "AI_INSTALL.md must document debugger evidence runtime smoke");
assert(read("README.md").includes("npm run smoke:browser:debugger-evidence"), "README.md must document debugger evidence runtime smoke");

console.log("smoke diagnostics contract ok");
