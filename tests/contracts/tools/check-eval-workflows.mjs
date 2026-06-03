import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
];

for (const file of ["README.md", "eval-plan.md", "spec-template.md", "manifest.json", "manual-result-template.json", "future-runner.md", "result-schema.json", "results/README.md", ...specFiles]) {
	assert(existsSync(path.join(evalRoot, file)), `missing browser workflow eval file: ${file}`);
}
assert(existsSync(path.join(root, "WORKSTREAMS_A_E_SUMMARY.md")), "missing Workstreams A-E completion summary");

const futureRunnerText = read(path.join("evals", "browser-workflows", "future-runner.md"));
for (const requiredText of ["not an implementation plan", "Require an explicit opt-in flag", "Bind to `127.0.0.1` only", "Use an ephemeral port by default", "Never make outbound network requests", "Do not run sqlmap, nuclei, OAST listeners"]) {
	assert(futureRunnerText.includes(requiredText), `future-runner.md must state boundary: ${requiredText}`);
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
	const specText = specTexts.get(entry.spec) || "";
	for (const fixture of entry.fixtures) assert(specText.includes(fixture), `${entry.spec} must mention manifest fixture: ${fixture}`);
	for (const tool of entry.primaryTools) assert(specText.includes(tool), `${entry.spec} must mention manifest primary tool: ${tool}`);
	for (const evidence of entry.evidence) assert(specText.includes(evidence), `${entry.spec} must mention manifest evidence: ${evidence}`);
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

console.log("browser workflow eval contract ok");
