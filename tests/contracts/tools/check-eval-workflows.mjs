import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_PORT_PATCH_BUNDLES, patchExtensionDistPort } from "../../support/patchExtensionPort.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const evalRoot = path.join(root, "evals", "browser-workflows");
const fixturesRoot = path.join(evalRoot, "fixtures");

function read(rel) {
	return readFileSync(path.join(root, rel), "utf8");
}

function readJson(rel) {
	return JSON.parse(read(rel));
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const specFiles = [
	"01-readable-content-artifact.md",
	"02-scan-execute-wait.md",
	"03-network-capture-replay.md",
	"04-selector-missing-recovery.md",
	"05-download-artifact.md",
	"06-wait-timeout-diagnostics.md",
	"07-bounded-path-fuzz-baseline.md",
	"08-cookie-jwt-redaction.md",
	"09-sqli-probe-vs-bridge.md",
	"10-multi-session-lease-conflict.md",
	"11-jshook-runtime-hook-targets.md",
	"12-jshook-source-map-artifact.md",
	"13-jshook-storage-evidence.md",
	"14-jshook-replay-not-intercept.md",
	"15-jshook-canvas-observation.md",
	"16-scan-high-entropy-summary.md",
	"17-debugger-evidence-workflow.md",
	"18-debugger-script-provenance.md",
	"19-debugger-pause-lifecycle.md",
	"20-debugger-navigation-recovery.md",
	"21-cross-tool-correlation-chain.md",
	"22-js-ast-artifact-summary.md",
	"23-dom-flow-listener-chain.md",
	"24-dom-flow-sink-hints.md",
	"25-wasm-artifact-metadata.md",
	"26-wasm-wat-bridge.md",
	"27-websocket-session-transcript.md",
	"30-abml-internal-routing-evidence.md",
	"31-execution-plane-cdp-fusion.md",
	"32-abml-identity-bootstrap-evidence.md",
	"33-layer-paint-occlusion-boundary.md",
	"34-oopif-composite-key-boundary.md",
	"35-abml-growth-probe-evidence.md",
];

for (const file of ["README.md", "eval-plan.md", "spec-template.md", "manifest.json", "manual-result-template.json", "future-runner.md", "runner.mjs", "result-schema.json", "results/README.md", "blind-agent-prompt.md", ...specFiles]) {
	assert(existsSync(path.join(evalRoot, file)), `missing browser workflow eval file: ${file}`);
}
assert(existsSync(path.join(root, "WORKSTREAMS_A_E_SUMMARY.md")), "missing Workstreams A-E completion summary");

const futureRunnerText = read(path.join("evals", "browser-workflows", "future-runner.md"));
for (const requiredText of ["Require an explicit opt-in flag", "Bind to `127.0.0.1` only", "Use an ephemeral port by default", "Never make outbound network requests", "Do not run sqlmap, nuclei, OAST listeners", "refuses to run without `--fixture-server`"] ) {
	assert(futureRunnerText.includes(requiredText), `future-runner.md must state boundary: ${requiredText}`);
}

const runnerText = read(path.join("evals", "browser-workflows", "runner.mjs"));
const launchBlindText = read(path.join("evals", "browser-workflows", "launch-blind.mjs"));
const usageDistillerText = read(path.join("evals", "browser-workflows", "distill-usage-log.mjs"));
const pbBlindText = read(path.join("evals", "browser-workflows", "pb-blind.mjs"));
const teardownBlindText = read(path.join("evals", "browser-workflows", "teardown-blind.mjs"));
const blindAgentPromptText = read(path.join("evals", "browser-workflows", "blind-agent-prompt.md"));
const blindEvalSkillText = read(path.join("skills", "browser-pilot-blind-eval", "SKILL.md"));
for (const requiredText of ["--fixture-server", "127.0.0.1", "startFixtureServer", "manual-result-template.json", "result-schema.json", "evals/browser-workflows/runner.mjs", "No sqlmap bridge, scanner, external database, or outbound target was used", "writeTemporalProfileArtifacts", "temporalProfileSamples", "temporalSummaryPath", "observeEstimatedTokens", "artifactBroadReadCalls"]) {
	assert(runnerText.includes(requiredText), `runner.mjs must preserve opt-in/local-safe boundary: ${requiredText}`);
}
assert(runnerText.includes("throw new Error(`Refusing to run: --fixture-server is required."), "runner must fail closed without --fixture-server");
assert(!runnerText.includes("sqlmap") || runnerText.includes("No sqlmap bridge"), "runner must not invoke sqlmap by default");
assert(!runnerText.includes("nuclei"), "runner must not invoke nuclei by default");
for (const requiredText of ["CLI ROUTING ADOPTION", "`wait`", "`network`", "`frame`", "`hook`", "frame evaluate", "hook collect", "`--action` / `--params`", "`commands --json` / `schema --json` metadata"]) {
	assert(blindAgentPromptText.includes(requiredText), `blind-agent-prompt.md must capture route-adoption signal: ${requiredText}`);
}
for (const requiredText of ["MEMORY ADOPTION", "memoryPlaneSeen", "inlineBodyUsed", "readThroughUsed", "recordNudgeShown", "recordCalled", "usedInFinalAnswer"]) {
	assert(blindAgentPromptText.includes(requiredText), `blind-agent-prompt.md must capture memory-adoption signal: ${requiredText}`);
	assert(blindEvalSkillText.includes(requiredText), `browser-pilot-blind-eval skill must require memory-adoption triage: ${requiredText}`);
}
for (const requiredText of ["PI_BROWSER_USAGE_LOG", "PI_BROWSER_USAGE_RUN_ID", "usageLogPath", "usageReportPath", "runId"]) {
	assert(launchBlindText.includes(requiredText), `launch-blind.mjs must stage usage-log metadata: ${requiredText}`);
}
assert(pbBlindText.includes("stage.cliEnv"), "pb-blind must propagate stage cliEnv, including usage-log attribution");
for (const requiredText of ["unattributed", "repeatedCalls", "p50", "p95", "advancedCompatibility", "runId"]) {
	assert(usageDistillerText.includes(requiredText), `distill-usage-log.mjs must report usage metric: ${requiredText}`);
}
for (const requiredText of ["CLI natural-routing", "`wait` /", "`network` /", "`frame` /", "`hook`", "frame evaluate", "hook collect", "`--action` / `--params`"]) {
	assert(blindEvalSkillText.includes(requiredText), `browser-pilot-blind-eval skill must require route-adoption triage: ${requiredText}`);
}

const specTexts = new Map();
for (const file of specFiles) {
	const text = read(path.join("evals", "browser-workflows", file));
	specTexts.set(file, text);
	for (const heading of ["## Goal", "## Fixture", "## Allowed starting tools", "## Expected tool sequence", "## Success criteria", "## Required evidence", "## Recovery checks", "## Metrics"]) {
		assert(text.includes(heading), `${file} missing eval heading: ${heading}`);
	}
	assert(text.includes("browser_"), `${file} must name relevant browser tools`);
	assert(!/https?:\/\//i.test(text), `${file} must not depend on external HTTP(S) URLs`);
	assert(!/sk_live_|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|xox[baprs]-/i.test(text), `${file} contains secret-like material`);
}

for (const file of specFiles.filter((file) => file.includes("jshook"))) {
	const text = specTexts.get(file) || "";
	assert(text.includes("## Capability closure classification"), `${file} must classify jshook capability closure`);
	assert(text.includes("must not introduce") || text.includes("must not create"), `${file} must prohibit new public tool creation`);
}

const correlationSpec = specTexts.get("21-cross-tool-correlation-chain.md") || "";
for (const requiredText of ["operationId", "snapshotId", "requestId", "waitId", "listenerId", "selectionVersionAtDispatch", "selectionVersionAtResolve", "browser_artifact", "jsonPath"]) {
	assert(correlationSpec.includes(requiredText), `21-cross-tool-correlation-chain.md must require correlation evidence: ${requiredText}`);
}

const manifest = readJson(path.join("evals", "browser-workflows", "manifest.json"));
assert(manifest.schemaVersion === 1, "browser workflow manifest schemaVersion must be 1");
assert(manifest.externalNetwork === false && manifest.runsBrowser === false && manifest.runsScanners === false, "browser workflow manifest must declare non-runtime local-safe mode");
assert(Array.isArray(manifest.evals) && manifest.evals.length === specFiles.length, "browser workflow manifest must list every eval");
assert(new Set(manifest.evals.map((entry) => entry.id)).size === manifest.evals.length, "browser workflow manifest eval ids must be unique");
for (const entry of manifest.evals) {
	assert(specFiles.includes(entry.spec), `manifest references unknown spec: ${entry.spec}`);
	assert(entry.id === entry.spec.replace(/\.md$/, ""), `manifest id must match spec filename: ${entry.id}`);
	assert(Array.isArray(entry.fixtures) && entry.fixtures.length >= 1, `${entry.id} must list fixtures`);
	assert(Array.isArray(entry.primaryTools) && entry.primaryTools.every((tool) => /^browser_/.test(tool)), `${entry.id} must list browser primary tools`);
	assert(Array.isArray(entry.evidence) && entry.evidence.length >= 1, `${entry.id} must list expected evidence classes`);
	assert(runnerText.includes(`"${entry.id}"`), `runner.mjs must implement manifest eval id: ${entry.id}`);
	const specText = specTexts.get(entry.spec) || "";
	for (const fixture of entry.fixtures) assert(specText.includes(fixture), `${entry.spec} must mention manifest fixture: ${fixture}`);
	for (const tool of entry.primaryTools) assert(specText.includes(tool), `${entry.spec} must mention manifest primary tool: ${tool}`);
	for (const evidence of entry.evidence) assert(specText.includes(evidence), `${entry.spec} must mention manifest evidence: ${evidence}`);
}

const pkg = readJson("package.json");
assert(pkg.scripts?.["eval:browser-workflows"] === "tsx evals/browser-workflows/runner.mjs", "package must expose the opt-in browser workflow eval runner");
assert(!String(pkg.scripts?.check || "").includes("eval:browser-workflows"), "npm run check must not launch the runtime eval runner");

assert(EXTENSION_PORT_PATCH_BUNDLES.includes("service-worker.js"), "extension port patch helper must patch the service worker bundle");
assert(EXTENSION_PORT_PATCH_BUNDLES.includes("offscreen.js"), "extension port patch helper must patch the B5 offscreen transport bundle");
{
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-port-patch-"));
	try {
		const distDir = path.join(tempDir, "dist");
		mkdirSync(distDir, { recursive: true });
		writeFileSync(path.join(tempDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "fixture", version: "1.0.0", background: { service_worker: "dist/service-worker.js" } }), "utf8");
		for (const bundle of EXTENSION_PORT_PATCH_BUNDLES) {
			writeFileSync(path.join(distDir, bundle), "const PI_BROWSER_BRIDGE_PORT = 18765; const PI_BROWSER_BRIDGE_PORT_RANGE_END = 18784; const url = 'ws://127.0.0.1:18765';\n", "utf8");
		}
		writeFileSync(path.join(distDir, "content.js"), "console.log('content');\n", "utf8");
		writeFileSync(path.join(distDir, "hook_dispatcher.js"), "console.log('hook');\n", "utf8");
		writeFileSync(path.join(distDir, "disable_dialogs.js"), "console.log('dialogs');\n", "utf8");
		writeFileSync(path.join(distDir, "build-manifest.json"), JSON.stringify({
			buildId: "0".repeat(64),
			buildIdPlaceholder: "__PI_BROWSER_BRIDGE_BUILD_ID_PLACEHOLDER__",
			inputs: [
				"bridge/pi_browser_bridge/dist/content.js",
				"bridge/pi_browser_bridge/dist/disable_dialogs.js",
				"bridge/pi_browser_bridge/dist/hook_dispatcher.js",
				"bridge/pi_browser_bridge/dist/offscreen.js",
				"bridge/pi_browser_bridge/dist/service-worker.js",
				"bridge/pi_browser_bridge/manifest.json",
			],
		}), "utf8");
		const patch = await patchExtensionDistPort(tempDir, 19001);
		assert(patch.patched.length === EXTENSION_PORT_PATCH_BUNDLES.length && patch.patched.every((item) => item.replacements >= 3), "extension port patch helper must report replacement diagnostics for every runtime bundle");
		assert(/^[0-9a-f]{64}$/.test(patch.buildId) && patch.manifestPath.endsWith(path.join("dist", "build-manifest.json")), "extension port patch helper must return staged buildId and manifestPath");
		assert(patch.env?.PI_BROWSER_EXPECTED_EXTENSION_BUILD_MANIFEST === patch.manifestPath, "extension port patch helper must return ready-to-spread expected manifest env");
		for (const bundle of EXTENSION_PORT_PATCH_BUNDLES) {
			const text = readFileSync(path.join(distDir, bundle), "utf8");
			assert(text.includes("19001") && !text.includes("18784") && !text.includes("127.0.0.1:18765"), `extension port patch helper must rewrite bridge markers in ${bundle}`);
		}
		for (const bundle of EXTENSION_PORT_PATCH_BUNDLES) {
			writeFileSync(path.join(distDir, bundle), "const PI_BROWSER_BRIDGE_PORT = 18765; const PI_BROWSER_BRIDGE_PORT_RANGE_END = 18784; const url = 'ws://127.0.0.1:18765';\n", "utf8");
		}
		await patchExtensionDistPort(tempDir, 18784);
		for (const bundle of EXTENSION_PORT_PATCH_BUNDLES) {
			const text = readFileSync(path.join(distDir, bundle), "utf8");
			assert(text.includes("PI_BROWSER_BRIDGE_PORT = 18784") && text.includes("PI_BROWSER_BRIDGE_PORT_RANGE_END = 18784") && text.includes("127.0.0.1:18784"), `extension port patch helper must allow bridge port 18784 without treating range-end as stale in ${bundle}`);
		}
		for (const bundle of EXTENSION_PORT_PATCH_BUNDLES) writeFileSync(path.join(distDir, bundle), "console.log('no bridge markers');\n", "utf8");
		let failed = false;
		try {
			await patchExtensionDistPort(tempDir, 19002);
		} catch (error) {
			failed = /no bridge port markers/.test(String(error?.message || error));
		}
		assert(failed, "extension port patch helper must fail when bundle port markers drift instead of silently leaving the default bridge port");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
const isolatedPatchScripts = [
	...readdirSync(path.join(root, "tests", "smoke"))
		.filter((file) => file.endsWith(".mjs"))
		.map((file) => path.join("tests", "smoke", file)),
	path.join("evals", "browser-workflows", "runner.mjs"),
	path.join("evals", "browser-workflows", "launch-blind.mjs"),
].filter((file) => read(file).includes("patchExtensionDistPort("));
const extensionLaunchScripts = [
	...readdirSync(path.join(root, "tests", "smoke"))
		.filter((file) => file.endsWith(".mjs"))
		.map((file) => path.join("tests", "smoke", file)),
	path.join("evals", "browser-workflows", "runner.mjs"),
	path.join("evals", "browser-workflows", "launch-blind.mjs"),
].filter((file) => read(file).includes("--load-extension"));
assert(isolatedPatchScripts.length >= 20, "isolated smoke/eval scripts that stage extension copies must call the shared patchExtensionDistPort helper directly");
for (const file of isolatedPatchScripts) {
	const text = read(file);
	assert(text.includes("patchExtensionDistPort"), `${file} must use the shared extension port patch helper`);
	assert(text.includes("extensionPatch") && text.includes(".env"), `${file} must propagate patchExtensionDistPort().env so staged extension build skew is compared against the staged manifest`);
	assert(!/function\s+patchExtensionPort\s*\(/.test(text), `${file} must not keep a local pass-through patchExtensionPort wrapper; call patchExtensionDistPort directly`);
	assert(!text.includes('path.join(extensionDir, "dist", "service-worker.js")'), `${file} must not patch only dist/service-worker.js; B5 WebSocket transport lives in dist/offscreen.js`);
}
const isolatedSmokeText = read(path.join("tests", "smoke", "smoke-browser-isolated.mjs"));
assert(isolatedSmokeText.includes("node_modules\", \"tsx\", \"dist\", \"cli.mjs"), "smoke-browser-isolated must launch the inner smoke via the local tsx CLI path");
assert(!isolatedSmokeText.includes("npx.cmd") && !isolatedSmokeText.includes("'npx'") && !isolatedSmokeText.includes("\"npx\""), "smoke-browser-isolated must not spawn npx/npx.cmd; Windows .cmd shims can throw EINVAL under Node spawn");
const browserSmokeEnv = read(path.join("tests", "support", "browserSmokeEnv.mjs"));
assert(browserSmokeEnv.includes("export function chromePath") && browserSmokeEnv.includes("export function findChromePath") && browserSmokeEnv.includes("export async function freePort") && browserSmokeEnv.includes("export function windowsPathForChrome") && browserSmokeEnv.includes("export function browserLaunchHardeningArgs") && browserSmokeEnv.includes("export function stopProcessTree") && browserSmokeEnv.includes("export function stopBrowserProcess"), "browser smoke/eval environment helpers must centralize Chrome discovery, optional Chrome discovery, port allocation, WSL path conversion, browser launch hardening, generic process-tree cleanup, and browser process cleanup");
assert(browserSmokeEnv.includes("if (!server.listening) return"), "shared freePort helper must not call server.close on a socket that never listened after a bind error");
assert(browserSmokeEnv.includes("RECENT_EPHEMERAL_PORTS") && browserSmokeEnv.includes("Could not allocate a distinct ephemeral port"), "shared freePort helper must avoid returning the same ephemeral port twice within one smoke/eval process");
for (const flag of ["--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-default-apps"]) {
	assert(browserSmokeEnv.includes(flag), `browserLaunchHardeningArgs must include ${flag}`);
}
assert(isolatedSmokeText.includes("stopProcessTree(smokeChild)") && !isolatedSmokeText.includes("smokeChild.kill"), "smoke-browser-isolated must clean up the nested smoke process tree instead of sending a direct SIGTERM that leaks children on Windows");
assert(teardownBlindText.includes("stopProcessTree(pid)") && !teardownBlindText.includes("taskkill.exe") && !/process\.kill\(pid/.test(teardownBlindText), "blind eval teardown must reuse the shared process-tree cleanup helper for tracked pids");
assert(pbBlindText.includes("PI_BROWSER_BLIND_CLI_TIMEOUT_MS") && pbBlindText.includes("timeout: timeoutMs") && pbBlindText.includes("TIMEOUT_EXIT_CODE = 124"), "pb-blind wrapper must bound forwarded CLI commands with an overridable timeout and conventional timeout exit code");
{
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-pb-blind-timeout-"));
	try {
		const tempEvalDir = path.join(tempDir, "evals", "browser-workflows");
		const tempCliDir = path.join(tempDir, "dist", "cli");
		const tempStageDir = path.join(tempDir, ".pi", "browser-artifacts", "eval-blind");
		mkdirSync(tempEvalDir, { recursive: true });
		mkdirSync(tempCliDir, { recursive: true });
		mkdirSync(tempStageDir, { recursive: true });
		writeFileSync(path.join(tempEvalDir, "pb-blind.mjs"), pbBlindText, "utf8");
		writeFileSync(path.join(tempCliDir, "bin.js"), "setInterval(() => {}, 1000);\n", "utf8");
		writeFileSync(path.join(tempStageDir, "stage.json"), JSON.stringify({ stateDir: path.join(tempDir, "state") }), "utf8");
		const result = spawnSync(process.execPath, [path.join(tempEvalDir, "pb-blind.mjs"), "tabs", "--action", "list"], {
			env: { ...process.env, PI_BROWSER_BLIND_CLI_TIMEOUT_MS: "50" },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 2000,
		});
		assert(result.status === 124, `pb-blind must exit 124 when the forwarded CLI hangs; got status=${result.status} signal=${result.signal} error=${result.error?.message || ""}`);
		assert(result.stderr.includes("timed out after 50ms"), "pb-blind timeout must print a concrete diagnostic");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
assert(launchBlindText.includes("stageState: \"daemon-started\"") && launchBlindText.includes("stageState: \"browser-started\"") && launchBlindText.includes("stageState: \"ready\"") && launchBlindText.includes("stageState: \"launch-failed\""), "blind eval launch must write partial/final stage states so teardown can clean failed launches");
assert(launchBlindText.includes("latestStage") && launchBlindText.includes("writeStage("), "blind eval launch must keep a latest partial stage manifest for failure cleanup");
assert(launchBlindText.includes("parsed.value"), "blind eval launch must accept the browser-pilot CLI JSON result envelope shape from tabs list");
assert(teardownBlindText.includes("stageState: stage.stageState"), "blind eval teardown output must report the stage state it cleaned");
for (const file of isolatedPatchScripts) {
	const text = read(file);
	assert(text.includes("browserSmokeEnv.mjs"), `${file} must use the shared browser smoke environment helper`);
	assert(!/const\s+chromeCandidates\s*=/.test(text) && !/function\s+windowsPathForChrome\s*\(/.test(text) && !/createServer\s+as\s+createNetServer/.test(text), `${file} must not re-inline Chrome discovery, WSL path conversion, or port probing`);
	assert(!/freePort\(\s*\d/.test(text), `${file} must use ephemeral freePort() ports instead of shared fixed ranges; fixed smoke ranges collide under parallel runs`);
	if (!file.endsWith(path.join("evals", "browser-workflows", "launch-blind.mjs"))) {
		assert(text.includes("stopBrowserProcess"), `${file} must use the shared browser process cleanup helper`);
		assert(!/taskkill\.exe|chrome\.kill/.test(text), `${file} must not inline browser process cleanup; use stopBrowserProcess`);
	}
}
assert(extensionLaunchScripts.length >= 20, "browser smoke/eval scripts that load the extension must be covered by launch hardening checks");
for (const file of extensionLaunchScripts) {
	const text = read(file);
	assert(text.includes("browserLaunchHardeningArgs()"), `${file} must consume the shared browser launch hardening helper`);
	assert(!/"--disable-(background-networking|sync|component-update|default-apps)"/.test(text), `${file} must not inline browser launch hardening flags; use browserLaunchHardeningArgs()`);
}

const resultSchema = readJson(path.join("evals", "browser-workflows", "result-schema.json"));
assert(resultSchema.type === "object" && resultSchema.additionalProperties === false, "result schema must be a closed object");
for (const field of ["schemaVersion", "evalId", "status", "toolCallCount", "firstWrongToolChoice", "recoveredAfterFailure", "artifactSufficiency", "scopedFollowUpDiscipline", "evidence", "notes"]) {
	assert(resultSchema.required?.includes(field), `result schema must require ${field}`);
}
assert(resultSchema.properties?.status?.enum?.includes("passed") && resultSchema.properties?.status?.enum?.includes("blocked"), "result schema must define terminal statuses");
assert(resultSchema.properties?.evidence?.properties?.artifacts?.type === "array", "result schema must keep artifact evidence as path references array");

const resultTemplate = readJson(path.join("evals", "browser-workflows", "manual-result-template.json"));
assert(resultTemplate.schemaVersion === 1 && resultTemplate.status === "not-run", "manual result template must be inert by default");
assert(resultTemplate.evidence && Array.isArray(resultTemplate.evidence.artifacts), "manual result template must include evidence arrays");
assert(Object.hasOwn(resultTemplate, "firstWrongToolChoice") && Object.hasOwn(resultTemplate, "artifactSufficiency") && Object.hasOwn(resultTemplate, "scopedFollowUpDiscipline"), "manual result template must preserve ACI metrics fields");
assert(Object.keys(resultTemplate).every((key) => resultSchema.required.includes(key)), "manual result template must only use result schema top-level fields");
for (const field of resultSchema.required) assert(Object.hasOwn(resultTemplate, field), `manual result template must include schema field ${field}`);

const resultsReadme = read(path.join("evals", "browser-workflows", "results", "README.md"));
for (const requiredText of ["Do not commit raw browser dumps", "follows `../result-schema.json`", "artifact path references", "Do not treat these records as required CI output"]) {
	assert(resultsReadme.includes(requiredText), `results README must state boundary: ${requiredText}`);
}

const requiredFixtures = [
	"README.md",
	"article.html",
	"interactive.html",
	"network.html",
	"selector-recovery.html",
	"download.html",
	"files/report.txt",
	"wait-timeout.html",
	"cookies.json",
	"path-fuzz-routes.json",
	"sqli-request.txt",
	"jshook-runtime-sinks.html",
	"jshook-source-map.html",
	"jshook/bundle.js",
	"jshook/bundle.js.map",
	"jshook-storage.html",
	"jshook-replay.html",
	"jshook-canvas.html",
	"scan-high-entropy.html",
	"debugger-evidence.html",
	"debugger-provenance.html",
	"debugger/provenance-helper.js",
	"debugger-pause.html",
	"debugger-navigation.html",
	"js-ast-minified.js",
	"js-ast-malformed.js",
	"js-ast-reduction.js",
	"js-ast-patterns.js",
	"js-ast-constant-folding.js",
	"js-ast-decoder-inline.js",
	"js-ast-alias-propagation.js",
	"js-ast-object-dispatch.js",
	"dom-flow-listeners.html",
	"ws-session-fixture.md",
	"execution-plane-cdp-fusion.html",
];

for (const file of requiredFixtures) {
	assert(existsSync(path.join(fixturesRoot, file)), `missing browser workflow fixture: ${file}`);
}

for (const entry of manifest.evals) {
	for (const fixture of entry.fixtures) assert(existsSync(path.join(evalRoot, fixture)), `${entry.id} references missing fixture: ${fixture}`);
}

const fixtureFiles = readdirSync(fixturesRoot, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) => path.join(entry.parentPath || fixturesRoot, entry.name));

for (const absolutePath of fixtureFiles) {
	const rel = path.relative(root, absolutePath).replace(/\\/g, "/");
	const text = readFileSync(absolutePath, "utf8");
	assert(!/https?:\/\//i.test(text), `${rel} must not depend on external HTTP(S) URLs`);
	assert(!/sk_live_|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|xox[baprs]-/i.test(text), `${rel} contains secret-like material`);
}

const cookies = readJson(path.join("evals", "browser-workflows", "fixtures", "cookies.json"));
assert(Array.isArray(cookies.cookies) && Array.isArray(cookies.jwts), "cookies fixture must expose cookies and jwts arrays");
assert(JSON.stringify(cookies).includes("Synthetic") || JSON.stringify(cookies).includes("fixture"), "cookies fixture must be explicitly synthetic");

const routeMap = readJson(path.join("evals", "browser-workflows", "fixtures", "path-fuzz-routes.json"));
assert(routeMap.routes && routeMap.wordlist, "path fuzz route fixture must include routes and wordlist");

{
	const tempDir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-usage-distill-"));
	try {
		const logA = path.join(tempDir, "usage-a.jsonl");
		const logB = path.join(tempDir, "usage-b.jsonl");
		const stage = path.join(tempDir, "stage.json");
		writeFileSync(stage, JSON.stringify({ runId: "run-a", startUrl: "https://example.test/", goal: "read" }), "utf8");
		writeFileSync(logA, [
			{ runId: "run-a", tool: "browser_wait", result: "ok", ms: 10, cli: { routing: "natural", command: "wait" }, args: { action: "selector" } },
			{ runId: "run-a", tool: "browser_wait", result: "ok", ms: 20, cli: { routing: "natural", command: "wait" }, args: { action: "selector" } },
			{ runId: "run-a", tool: "browser_tabs", result: "error", ms: 30, details: { code: "TAB_NOT_FOUND" }, args: { action: "list" } },
		].map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
		writeFileSync(logB, `${JSON.stringify({ tool: "browser_observe", result: "ok", ms: 5, args: { mode: "scan" } })}\n`, "utf8");
		const outPath = path.join(tempDir, "usage-report.json");
		const result = spawnSync(process.execPath, [path.join(root, "evals", "browser-workflows", "distill-usage-log.mjs"), logA, logB, "--stage", stage, "--out", outPath], { encoding: "utf8" });
		assert(result.status === 0, `usage distiller must exit 0: ${result.stderr}`);
		const report = JSON.parse(readFileSync(outPath, "utf8"));
		assert(report.runCount === 2 && report.totalCalls === 4, "usage distiller must keep attributed and unattributed runs separate");
		const runA = report.runs.find((run) => run.runId === "run-a");
		assert(runA?.stage?.startUrl === "https://example.test/", "usage distiller must annotate runs from stage sidecars by embedded runId");
		assert(runA.callsByTool.browser_wait === 2 && runA.errorCodesByTool.browser_tabs.TAB_NOT_FOUND === 1, "usage distiller must aggregate calls and error-code histograms");
		assert(runA.routing.natural === 2 && runA.durationMs.p50 === 20 && runA.durationMs.p95 === 30, "usage distiller must report routing and duration percentiles");
		assert(runA.repeatedCalls.some((item) => item.tool === "browser_wait" && item.count === 2), "usage distiller must detect repeated tool+params within the same run");
		const unattributed = report.runs.find((run) => run.runId === "unattributed");
		assert(unattributed?.attributed === false && unattributed.totalCalls === 1, "usage distiller must not join missing-runId lines to stage sidecars");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

console.log("browser workflow eval contract ok");
