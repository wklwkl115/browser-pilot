import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWasmArtifact } from "../../../src/tools/webSecurity/shared/wasmArtifact.ts";
import { summarizeWasmArtifactData } from "../../../src/tools/summaries/webSecurity/wasm.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("wasm summary adapter emits compact artifact-first metadata", async () => {
	const result = await analyzeWasmArtifact({ path: path.join(root, "evals", "browser-workflows", "fixtures", "wasm-minimal.wasm") });
	const summary = summarizeWasmArtifactData(result);
	assert.equal(summary.format, "wasm");
	assert.equal(summary.version, 1);
	assert.equal(typeof summary.sections, "object");
	assert.equal(typeof summary.imports, "object");
	assert.equal(typeof summary.exports, "object");
	assert.equal(Array.isArray(summary.nextActions), true);
});
