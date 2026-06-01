import test from "node:test";
import assert from "node:assert/strict";
import { runScanObservation } from "../../../src/tools/observeRunners.ts";

let opId = 0;
const fakeServer = {
	queueDepth() { return 0; },
	leaseOwnerHash() { return undefined; },
	beginOperation(meta) { opId += 1; return { operationId: `op-${opId}`, startedAt: Date.now(), updatedAt: Date.now(), ...meta }; },
	updateOperation(operationId, patch) { return { operationId, startedAt: Date.now(), updatedAt: Date.now(), ...patch }; },
	finishOperation() { return undefined; },
	async refreshTabs() { return [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }]; },
	getTabs() { return [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }]; },
	snapshot() { return { browserSessionId: "default", defaultTabId: 7, selectionVersion: 3, tabs: [{ tabId: 7, url: "https://example.test/checkout", title: "Checkout", active: true }] }; },
	createObservationSnapshot(snapshot) { return { snapshotId: "snap-1", ttlMs: 60_000, expired: false, ...snapshot }; },
	async sendCommand(command) {
		if (command.cmd === "cdp" && command.method === "Runtime.evaluate") {
			const expression = String(command.params?.expression || "");
			if (expression.includes("collectActionables") && expression.includes("list_hints")) {
				return { id: "eval-1", acknowledged: true, tabId: 7, data: { result: { value: { url: "https://example.test/checkout", title: "Checkout", readyState: "complete", content: "<h1>Checkout</h1>\nStatus: payment required", node_count: 12, truncated: false, actionables: [{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 }], list_hints: [] } } } };
			}
		}
		if (command.cmd === "persistent_cdp" && command.cdpMethod === "Accessibility.getFullAXTree") {
			return { id: "ax-tree", acknowledged: true, tabId: 7, data: { result: { nodes: [{ nodeId: "ax-1", backendDOMNodeId: 81, role: { value: "button" }, name: { value: "Pay now" } }] } } };
		}
		if (command.cmd === "persistent_cdp" && command.cdpMethod === "DOM.getBoxModel") {
			return { id: "box-1", acknowledged: true, tabId: 7, data: { result: { border: [140, 240, 220, 240, 220, 272, 140, 272] } } };
		}
		throw new Error(`unexpected command ${JSON.stringify(command)}`);
	},
};

test("browser_observe scan exposes ABML integration diagnostics internally", async () => {
	const result = await runScanObservation(fakeServer as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan");
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(result.details?.abml?.integrated, true);
	assert.equal(result.details?.abml?.entityCount >= 1, true);
	assert.equal(typeof result.details?.abml?.primaryEntityCount, "number");
	assert.equal(typeof result.details?.abml?.visualRegionCount, "number");
	assert.equal(typeof result.details?.abml?.frameEntityCount, "number");
	assert.equal(Array.isArray(envelope.summary?.focus?.primary_entities), true);
	assert.equal(envelope.summary?.focus?.primary_entities?.length >= 1, true);
});
