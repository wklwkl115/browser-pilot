import test from "node:test";
import assert from "node:assert/strict";
import type { JsonRecord } from "../../src/bridge/extension/service_worker/types.ts";

const calls: Array<{ method: string; args: unknown[] }> = [];
let response: JsonRecord = {};
const operation =
	(method: string) =>
	async (...args: unknown[]) => {
		calls.push({ method, args });
		return response;
	};
const bridge = {
	frameTree: operation("frameTree"),
	evaluateInFrame: operation("evaluateInFrame"),
	addNewDocumentScript: operation("addNewDocumentScript"),
	removeNewDocumentScript: operation("removeNewDocumentScript"),
};
Object.assign(globalThis, {
	self: globalThis,
	chrome: {},
	BrowserPilotPersistentCdp: bridge,
	browserPilotPersistentCdpBridge: bridge,
});
const { handleBrowserPilotFrameCommand: frame } = await import("../../src/bridge/extension/service_worker/frame.ts");
function reset(data: JsonRecord = {}) {
	calls.length = 0;
	response = { ok: true, data };
}

test("frame.list preserves the frame hierarchy and document metadata", async () => {
	const frames = [{ frameId: "main" }, { frameId: "child", parentId: "main", url: "http://fixture.invalid/child" }];
	reset({ frames, frameTree: { frameId: "main", childFrames: [frames[1]] } });
	const result = await frame("frame.list", 7, {});
	assert.equal(result.ok, true);
	assert.deepEqual(result.data, {
		tabId: 7,
		frames,
		frameTree: response.data && (response.data as JsonRecord).frameTree,
		count: 2,
	});
	assert.deepEqual(calls, [{ method: "frameTree", args: [7, {}] }]);
});

test("frame.evaluate keeps frame selection explicit and universal access opt-in", async () => {
	reset({ result: { value: 2 } });
	await frame("frame.evaluate", 7, { frameId: "child", expression: "1+1" });
	assert.deepEqual(calls[0], {
		method: "evaluateInFrame",
		args: [7, "1+1", { frameId: "child", awaitPromise: true }],
	});
	reset();
	await frame("frame.evaluate", 7, {
		frameId: "child",
		expression: "2+2",
		awaitPromise: false,
		returnByValue: false,
		grantUniversalAccess: false,
		userGesture: true,
		worldName: "test-world",
	});
	assert.deepEqual(calls[0]?.args[2], {
		frameId: "child",
		awaitPromise: false,
		returnByValue: false,
		grantUniversalAccess: false,
		userGesture: true,
		worldName: "test-world",
	});
});

test("frame commands reject incomplete requests before calling CDP", async () => {
	reset();
	for (const command of [
		"frame.evaluate",
		"frame.addNewDocumentScript",
		"frame.removeNewDocumentScript",
		"frame.unknown",
	]) {
		const result = await frame(command, 7, {});
		assert.equal(result.ok, false);
	}
	assert.equal(calls.length, 0);
});

test("frame commands preserve CDP failures rather than manufacturing successful results", async () => {
	reset();
	response = { ok: false, error: { code: "FRAME_NOT_FOUND", message: "gone", details: { frameId: "missing" } } };
	assert.deepEqual(await frame("frame.evaluate", 7, { frameId: "missing", expression: "1" }), {
		ok: false,
		error_code: "FRAME_NOT_FOUND",
		error: "gone",
		details: { frameId: "missing" },
	});
});

test("frame document-script registration and removal retain the lifecycle identifier", async () => {
	reset({ identifier: "script-1" });
	await frame("frame.addNewDocumentScript", 7, {
		source: "window.fixture=true",
		runImmediately: true,
		worldName: "fixture-world",
	});
	assert.equal(calls[0]?.method, "addNewDocumentScript");
	assert.deepEqual(calls[0]?.args.slice(0, 2), [7, "window.fixture=true"]);
	assert.deepEqual(calls[0]?.args[2], {
		persistent: true,
		name: "new_document",
		runImmediately: true,
		worldName: "fixture-world",
	});
	reset();
	await frame("frame.removeNewDocumentScript", 7, { identifier: "script-1" });
	assert.equal(calls[0]?.method, "removeNewDocumentScript");
	assert.deepEqual(calls[0]?.args.slice(0, 2), [7, "script-1"]);
});
