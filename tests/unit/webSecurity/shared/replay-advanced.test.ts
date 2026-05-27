import test from "node:test";
import assert from "node:assert/strict";
import {
	applyReplayVariables,
	extractReplayVariables,
	replayInputOptions,
	replaySequenceInputs,
	replayStepExtractors,
	replayVariableMap,
} from "../../../../src/tools/webSecurity/shared/replay.ts";

test("replayVariableMap stringifies structured values", () => {
	assert.deepEqual(replayVariableMap({ a: 1, b: true, c: { nested: 1 } }), {
		a: "1",
		b: "true",
		c: JSON.stringify({ nested: 1 }),
	});
});

test("applyReplayVariables rewrites strings recursively", () => {
	const result = applyReplayVariables({ url: "{{base}}/api", nested: ["{{id}}"] }, { base: "https://example.test", id: "42" });
	assert.deepEqual(result, { url: "https://example.test/api", nested: ["42"] });
});

test("replayStepExtractors reads extractors or captures aliases", () => {
	assert.deepEqual(replayStepExtractors({ extractors: [{ type: "header", header: "x-id" }] }), [{ type: "header", header: "x-id" }]);
	assert.deepEqual(replayStepExtractors({ captures: [{ type: "cookie", cookie: "sid" }] }), [{ type: "cookie", cookie: "sid" }]);
});

test("extractReplayVariables pulls values from headers", () => {
	const vars = extractReplayVariables([{ type: "header", header: "x-id", name: "id" }], {
		url: "https://example.test/",
		status: 200,
		statusText: "OK",
		headers: { "x-id": "abc" },
		setCookie: [],
		elapsedMs: 10,
		ok: true,
		bodyText: "",
		bodyBytes: 0,
		bodyTruncated: false,
	});
	assert.deepEqual(vars, { id: "abc" });
});

test("replayInputOptions normalizes raw and object sequence items", () => {
	assert.equal(replayInputOptions("GET / HTTP/1.1", { timeoutMs: 1 }).rawRequest, "GET / HTTP/1.1");
	const objectInput = replayInputOptions({ url: "https://example.test/", method: "POST" }, { timeoutMs: 1, cookieProvider: async () => undefined });
	assert.equal(objectInput.url, "https://example.test/");
	assert.equal(objectInput.method, "POST");
	assert.equal(typeof objectInput.cookieProvider, "function");
});

test("replaySequenceInputs prefers explicit sequence entries", async () => {
	const items = await replaySequenceInputs({ sequence: ["GET /a HTTP/1.1", "GET /b HTTP/1.1"] });
	assert.equal(items.length, 2);
	assert.equal(items[0].source, "sequence");
	assert.equal(items[0].label, "step-1");
});
