import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runWasmWatBridge } from "../../../../src/tools/webSecurity/shared/wasmBridge.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fixture = (name: string) => path.join(root, "evals", "browser-workflows", "fixtures", name);

test("wasmBridge reports structured launcher-not-found diagnostics for explicit bad path", async () => {
	await assert.rejects(() => runWasmWatBridge({ path: fixture("wasm-minimal.wasm"), toolPath: "__pi_missing_wasm2wat__" }), (error: Error & { code?: string; details?: Record<string, unknown> }) => {
		assert.equal(error.code, "MATURE_BRIDGE_LAUNCHER_NOT_FOUND");
		assert.equal(error.details?.bridgeName, "wasm2wat");
		return true;
	});
});
