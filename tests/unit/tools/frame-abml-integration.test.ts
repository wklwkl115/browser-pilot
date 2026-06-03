import test from "node:test";
import assert from "node:assert/strict";
import { registerFrameTool } from "../../../src/tools/registerNativeActionTools.ts";
import { ToolCollectingAdapter as McpExtensionAdapter } from "../../../src/frontend/toolCollector.ts";

function fakeServer() {
	let opId = 0;
	return {
		queueDepth() { return 0; },
		leaseOwnerHash() { return undefined; },
		beginOperation(meta) { opId += 1; return { operationId: `op-${opId}`, startedAt: Date.now(), updatedAt: Date.now(), ...meta }; },
		updateOperation(operationId, patch) { return { operationId, startedAt: Date.now(), updatedAt: Date.now(), ...patch }; },
		finishOperation() { return undefined; },
		async sendCommand(command) {
			if (command.cmd === "frame.list") {
				return { id: "frame-list", acknowledged: true, tabId: 7, data: { frameTree: { frameId: "root" }, frames: [{ frameId: "root", id: "root", url: "https://example.test", name: "root", securityOrigin: "https://example.test" }, { frameId: "child-x", id: "child-x", url: "https://example.test/frame", name: "child", securityOrigin: "https://example.test", parentId: "root" }], count: 2 } };
			}
			throw new Error(`unexpected command ${JSON.stringify(command)}`);
		},
	};
}

test("browser_frame list exposes ABML integration metadata internally", async () => {
	const adapter = new McpExtensionAdapter();
	const server = fakeServer();
	registerFrameTool({ pi: adapter as any, ensureStarted: async () => server as any });
	const tool = adapter.getTool("browser_frame");
	if (!tool) throw new Error("browser_frame not registered");
	const result = await tool.execute("frame-1", { action: "list", tabId: 7, detailLevel: "summary", maxChars: 12000 }, undefined, undefined, { cwd: process.cwd(), hasUI: false });
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.summary.abmlIntegrated, true);
	assert.equal(envelope.summary.entityCount >= 1, true);
	assert.equal(envelope.summary.frameCount, 2);
});
