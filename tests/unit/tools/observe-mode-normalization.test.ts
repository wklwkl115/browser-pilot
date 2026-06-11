import test from "node:test";
import assert from "node:assert/strict";
import { normalizeObserveMode, validateObserveParams } from "../../../src/tools/registerObserveTool.ts";

test("browser_observe infers mode from unambiguous params when mode is omitted", () => {
	assert.deepEqual(normalizeObserveMode(undefined, { selector: "#main" }), { mode: "content", inferred: { mode: "content", reason: "selector" } });
	assert.deepEqual(normalizeObserveMode(undefined, { includeLinks: false }), { mode: "content", inferred: { mode: "content", reason: "includeLinks" } });
	assert.deepEqual(normalizeObserveMode(undefined, { htmlMode: "text" }), { mode: "html", inferred: { mode: "html", reason: "htmlMode" } });
	assert.deepEqual(normalizeObserveMode(undefined, { params: { selector: "#main" } }), { mode: "html", inferred: { mode: "html", reason: "params" } });
	assert.deepEqual(normalizeObserveMode(undefined, { selector: "#main", htmlMode: "outer" }), { mode: "html", inferred: { mode: "html", reason: "htmlMode+selector" } });
	assert.deepEqual(normalizeObserveMode(undefined, { selector: "#main", includeLinks: true }), { mode: "content", inferred: { mode: "content", reason: "includeLinks+selector" } });
});

test("browser_observe keeps scan default for scan-shaped params and explicit intent", () => {
	assert.deepEqual(normalizeObserveMode(undefined, { intent: "checkout" }), { mode: "scan", inferred: null });
	assert.deepEqual(normalizeObserveMode(undefined, { maxNodes: 500 }), { mode: "scan", inferred: null });
	assert.deepEqual(normalizeObserveMode(undefined, { includeIframes: false }), { mode: "scan", inferred: null });
	assert.deepEqual(normalizeObserveMode(undefined, { url: "https://example.test/" }), { mode: "scan", inferred: null });
});

test("browser_observe rejects incompatible omitted-mode param sets", () => {
	assert.throws(() => normalizeObserveMode(undefined, { selector: "#main", includeIframes: false }), /incompatible observation modes/);
	assert.throws(() => normalizeObserveMode(undefined, { intent: "checkout", includeLinks: true }), /incompatible observation modes/);
});

test("browser_observe explicit mode bypasses inference but keeps strict validation", () => {
	assert.deepEqual(normalizeObserveMode("scan", { selector: "#main" }), { mode: "scan", inferred: null });
	assert.throws(() => validateObserveParams("scan", { selector: "#main" }), /does not accept selector/);
	assert.doesNotThrow(() => validateObserveParams("text", { intent: "checkout" }));
	assert.throws(() => validateObserveParams("content", { intent: "checkout" }), /does not accept intent/);
	assert.throws(() => validateObserveParams("tabs", { url: "https://example.test/" }), /does not accept url/);
});
