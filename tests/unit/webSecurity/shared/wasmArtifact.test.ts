import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeWasmArtifact, WasmArtifactError } from "../../../../src/tools/webSecurity/shared/wasmArtifact.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fixture = (name: string) => path.join(root, "evals", "browser-workflows", "fixtures", name);

test("wasmArtifact extracts bounded module metadata from minimal wasm fixture", async () => {
	const result = await analyzeWasmArtifact({ path: fixture("wasm-minimal.wasm") });
	assert.equal(result.analysis.ok, true);
	assert.equal(result.analysis.format, "wasm");
	assert.equal(result.analysis.version, 1);
	assert.equal(result.analysis.counts.imports, 1);
	assert.equal(result.analysis.counts.memories, 1);
	assert.equal(result.analysis.counts.exports, 2);
	assert.equal(result.analysis.imports[0]?.module, "env");
	assert.equal(result.analysis.exports.some((item) => item.name === "run"), true);
});

test("wasmArtifact rejects non-wasm input", async () => {
	await assert.rejects(() => analyzeWasmArtifact({ path: fixture("wasm-minimal.wat") }), (error: unknown) => {
		assert.equal(error instanceof WasmArtifactError, true);
		assert.equal((error as WasmArtifactError).code, "WASM_MAGIC_INVALID");
		return true;
	});
});
