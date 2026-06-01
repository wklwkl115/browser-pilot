import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const evalRoot = path.join(root, "evals", "browser-workflows");
const resultsRoot = path.join(evalRoot, "results");

function read(rel) {
	return readFileSync(path.join(root, rel), "utf8");
}
function readJsonAbs(absPath) {
	return JSON.parse(readFileSync(absPath, "utf8"));
}
function assertNoSecrets(text, label) {
	assert(!/sk_live_|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|xox[baprs]-/i.test(text), `${label} contains secret-like material`);
}

const resultSchema = JSON.parse(read("evals/browser-workflows/result-schema.json"));
const resultFiles = readdirSync(resultsRoot).filter((file) => file.endsWith(".result.json")).sort();
assert(resultFiles.includes("18-debugger-script-provenance.result.json"), "browser workflow results must keep existing debugger provenance sample");
assert(resultFiles.includes("19-debugger-pause-lifecycle.result.json"), "browser workflow results must keep existing debugger pause sample");
assert(resultFiles.includes("20-debugger-navigation-recovery.result.json"), "browser workflow results must keep existing debugger navigation sample");
assert(resultFiles.includes("21-cross-tool-correlation-chain.result.json"), "browser workflow results must include the cross-tool correlation chain sample");
assert(resultFiles.includes("22-js-ast-artifact-summary.result.json"), "browser workflow results must include the JS AST artifact summary sample");
assert(resultFiles.includes("23-dom-flow-listener-chain.result.json"), "browser workflow results must include the DOM flow listener-chain sample");
assert(resultFiles.includes("24-dom-flow-sink-hints.result.json"), "browser workflow results must include the DOM flow sink-hints sample");
assert(resultFiles.includes("25-wasm-artifact-metadata.result.json"), "browser workflow results must include the Wasm artifact metadata sample");
assert(resultFiles.includes("26-wasm-wat-bridge.result.json"), "browser workflow results must include the Wasm WAT bridge sample");
assert(resultFiles.includes("27-websocket-session-transcript.result.json"), "browser workflow results must include the websocket session transcript sample");
assert(resultFiles.includes("30-abml-internal-routing-evidence.result.json"), "browser workflow results must include the ABML internal routing evidence sample");

const knownEvalIds = new Set(JSON.parse(read("evals/browser-workflows/manifest.json")).evals.map((entry) => entry.id));
for (const file of resultFiles) {
	const absPath = path.join(resultsRoot, file);
	const text = readFileSync(absPath, "utf8");
	assertNoSecrets(text, file);
	const value = readJsonAbs(absPath);
	for (const field of resultSchema.required) assert(Object.hasOwn(value, field), `${file} missing required result field ${field}`);
	assert.equal(value.schemaVersion, 1, `${file} must keep schemaVersion 1`);
	assert.equal(resultSchema.properties.status.enum.includes(value.status), true, `${file} status must follow result schema enum`);
	assert.equal(typeof value.evalId, "string", `${file} must include evalId string`);
	assert(knownEvalIds.has(value.evalId), `${file} evalId must exist in manifest: ${value.evalId}`);
	assert(Array.isArray(value.evidence?.summary) && Array.isArray(value.evidence?.artifacts) && Array.isArray(value.evidence?.diagnostics), `${file} must keep evidence arrays`);
	assert(Array.isArray(value.notes), `${file} must keep notes array`);
	assert.equal(typeof value.toolCallCount, "number", `${file} must keep numeric toolCallCount`);
	assert.equal(typeof value.recoveredAfterFailure, "boolean", `${file} must keep boolean recoveredAfterFailure`);
	for (const artifactPath of value.evidence.artifacts) {
		assert.equal(typeof artifactPath, "string", `${file} artifact references must stay as strings`);
		assert(!artifactPath.includes("\n") && artifactPath.length < 260, `${file} artifact reference must stay compact and path-like: ${artifactPath}`);
	}
}

const correlation = readJsonAbs(path.join(resultsRoot, "21-cross-tool-correlation-chain.result.json"));
const jsAst = readJsonAbs(path.join(resultsRoot, "22-js-ast-artifact-summary.result.json"));
const domFlow = readJsonAbs(path.join(resultsRoot, "23-dom-flow-listener-chain.result.json"));
const domFlowHints = readJsonAbs(path.join(resultsRoot, "24-dom-flow-sink-hints.result.json"));
const wasm = readJsonAbs(path.join(resultsRoot, "25-wasm-artifact-metadata.result.json"));
const wasmWat = readJsonAbs(path.join(resultsRoot, "26-wasm-wat-bridge.result.json"));
const ws = readJsonAbs(path.join(resultsRoot, "27-websocket-session-transcript.result.json"));
const abmlRouting = readJsonAbs(path.join(resultsRoot, "30-abml-internal-routing-evidence.result.json"));
assert.equal(correlation.status, "passed", "21-cross-tool-correlation-chain.result.json must record a passing sample result");
assert.equal(correlation.scopedFollowUpDiscipline, "passed", "21-cross-tool-correlation-chain.result.json must preserve scoped follow-up discipline");
assert.equal(correlation.artifactSufficiency, "sufficient", "21-cross-tool-correlation-chain.result.json must preserve artifact sufficiency");
assert(correlation.evidence.summary.some((item) => /operationId/i.test(item)), "21-cross-tool-correlation-chain.result.json must mention operationId in summary evidence");
assert(correlation.evidence.summary.some((item) => /snapshotId/i.test(item)), "21-cross-tool-correlation-chain.result.json must mention snapshotId in summary evidence");
assert(correlation.evidence.summary.some((item) => /artifact/i.test(item)), "21-cross-tool-correlation-chain.result.json must mention targeted artifact behavior in summary evidence");
assert(correlation.evidence.diagnostics.some((item) => /selectionVersion/i.test(item)), "21-cross-tool-correlation-chain.result.json must mention selectionVersion in diagnostics evidence");
assert(correlation.notes.some((item) => /existing tool surface|existing canonical tools/i.test(item)), "21-cross-tool-correlation-chain.result.json must preserve the no-new-tool boundary in notes");
assert.equal(jsAst.status, "passed", "22-js-ast-artifact-summary.result.json must record a passing sample result");
assert.equal(jsAst.scopedFollowUpDiscipline, "passed", "22-js-ast-artifact-summary.result.json must preserve scoped follow-up discipline");
assert.equal(jsAst.artifactSufficiency, "sufficient", "22-js-ast-artifact-summary.result.json must preserve artifact sufficiency");
assert(jsAst.evidence.summary.some((item) => /AST summary|imports\/exports|function inventory/i.test(item)), "22-js-ast-artifact-summary.result.json must mention bounded AST facts in summary evidence");
assert(jsAst.evidence.diagnostics.some((item) => /artifact-first|explicit/i.test(item)), "22-js-ast-artifact-summary.result.json must preserve explicit artifact-first boundary in diagnostics evidence");
assert(jsAst.notes.some((item) => /internal-first|new callable browser tool/i.test(item)), "22-js-ast-artifact-summary.result.json must preserve the no-new-tool boundary in notes");
assert.equal(domFlow.status, "passed", "23-dom-flow-listener-chain.result.json must record a passing sample result");
assert.equal(domFlow.scopedFollowUpDiscipline, "passed", "23-dom-flow-listener-chain.result.json must preserve scoped follow-up discipline");
assert(domFlow.evidence.summary.some((item) => /Listener facts|handler source metadata|node-to-handler/i.test(item)), "23-dom-flow-listener-chain.result.json must mention listener/source/chain evidence in summary");
assert(domFlow.notes.some((item) => /existing browser_hook|new public DOM-flow tool|taint engine/i.test(item)), "23-dom-flow-listener-chain.result.json must preserve the no-new-tool and no-full-taint boundary in notes");
assert.equal(domFlowHints.status, "passed", "24-dom-flow-sink-hints.result.json must record a passing sample result");
assert.equal(domFlowHints.scopedFollowUpDiscipline, "passed", "24-dom-flow-sink-hints.result.json must preserve scoped follow-up discipline");
assert(domFlowHints.evidence.summary.some((item) => /sink hints|observable sink facts|heuristic/i.test(item)), "24-dom-flow-sink-hints.result.json must mention heuristic sink hints in summary evidence");
assert(domFlowHints.notes.some((item) => /browser_hook|taint engine|exploit-decider/i.test(item)), "24-dom-flow-sink-hints.result.json must preserve bounded evidence-assist boundary in notes");
assert.equal(wasm.status, "passed", "25-wasm-artifact-metadata.result.json must record a passing sample result");
assert.equal(wasm.scopedFollowUpDiscipline, "passed", "25-wasm-artifact-metadata.result.json must preserve scoped follow-up discipline");
assert(wasm.evidence.summary.some((item) => /Wasm metadata summary|header\/version\/hash|imports\/exports/i.test(item)), "25-wasm-artifact-metadata.result.json must mention bounded Wasm metadata in summary evidence");
assert(wasm.notes.some((item) => /public Wasm browser tool|explicit local Wasm artifacts/i.test(item)), "25-wasm-artifact-metadata.result.json must preserve Wasm artifact-first boundary in notes");
assert.equal(wasmWat.status, "passed", "26-wasm-wat-bridge.result.json must record a passing sample result");
assert.equal(wasmWat.scopedFollowUpDiscipline, "passed", "26-wasm-wat-bridge.result.json must preserve scoped follow-up discipline");
assert(wasmWat.evidence.summary.some((item) => /launcher metadata|\.wat artifact|artifact-first/i.test(item)), "26-wasm-wat-bridge.result.json must mention bridge output/artifact evidence in summary");
assert(wasmWat.notes.some((item) => /mature-bridge-first|public browser tool|Wasm decompiler/i.test(item)), "26-wasm-wat-bridge.result.json must preserve mature-bridge-first/no-public-tool boundary in notes");
assert.equal(ws.status, "passed", "27-websocket-session-transcript.result.json must record a passing sample result");
assert.equal(ws.scopedFollowUpDiscipline, "passed", "27-websocket-session-transcript.result.json must preserve scoped follow-up discipline");
assert(ws.evidence.summary.some((item) => /WS summary|session state|transcript/i.test(item)), "27-websocket-session-transcript.result.json must mention websocket session/transcript evidence in summary");
assert(ws.evidence.summary.some((item) => /stepIndex|lastSeq|partial-step/i.test(item)), "27-websocket-session-transcript.result.json must mention replay failure diagnostics in summary");
assert(ws.evidence.artifacts.some((item) => /ws-replay-failure/i.test(item)), "27-websocket-session-transcript.result.json must reference replay failure artifact paths");
assert(ws.evidence.diagnostics.some((item) => /partialSteps|partialTranscript|stepIndex/i.test(item)), "27-websocket-session-transcript.result.json must preserve replay failure diagnostics evidence");
assert(ws.notes.some((item) => /internal-first|public browser websocket fuzz tool|state machines/i.test(item)), "27-websocket-session-transcript.result.json must preserve websocket internal-first/no-public-tool boundary in notes");
assert.equal(abmlRouting.status, "passed", "30-abml-internal-routing-evidence.result.json must record a passing sample result");
assert.equal(abmlRouting.scopedFollowUpDiscipline, "passed", "30-abml-internal-routing-evidence.result.json must preserve scoped follow-up discipline");
assert.equal(abmlRouting.artifactSufficiency, "sufficient", "30-abml-internal-routing-evidence.result.json must preserve artifact sufficiency");
assert(abmlRouting.evidence.summary.some((item) => /ABML-backed primary entity|ABML-integrated monitor|frame entities|visual region/i.test(item)), "30-abml-internal-routing-evidence.result.json must mention internal ABML routing evidence in summary");
assert(abmlRouting.evidence.diagnostics.some((item) => /sufficient for the exercised tasks|not show a task that is blocked solely/i.test(item)), "30-abml-internal-routing-evidence.result.json must preserve the current sufficiency conclusion");
assert(abmlRouting.notes.some((item) => /internal substrate|migration\/replacement RFC|No evidence here justifies exposing new public/i.test(item)), "30-abml-internal-routing-evidence.result.json must preserve the no-public-verb conclusion in notes");

console.log("browser workflow results contract ok");
