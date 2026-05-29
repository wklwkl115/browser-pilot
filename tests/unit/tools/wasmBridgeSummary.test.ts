import test from "node:test";
import assert from "node:assert/strict";
import { summarizeWasmWatBridgeData } from "../../../src/tools/summaries/webSecurity/wasmBridge.ts";

test("wasm bridge summary adapter emits compact artifact-first bridge output", () => {
	const summary = summarizeWasmWatBridgeData({
		bridge: {
			tool: "wasm2wat",
			launcher: { command: "wasm2wat", source: "auto" },
			watArtifact: { path: "fixture.wat", bytes: 123, sha256: "abc", read: { tool: "browser_artifact", path: "fixture.wat", mode: "text" } },
			stdoutPreview: "(module)",
			stderrPreview: "",
		},
	});
	assert.equal(summary.tool, "wasm2wat");
	assert.equal(typeof summary.watArtifact, "object");
	assert.equal(Array.isArray(summary.nextActions), true);
});
