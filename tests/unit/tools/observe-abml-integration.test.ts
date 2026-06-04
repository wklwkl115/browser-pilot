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

// --- R3.x causal plane (network-delta) runtime wiring ---------------------------------------------
// A server variant that also answers the network recorder reads observe issues for the causal plane.
function causalServer(network: { status: unknown; list?: unknown }) {
	return {
		...fakeServer,
		async sendCommand(command: any, options: any) {
			if (command.cmd === "network.status") return { acknowledged: true, data: network.status };
			if (command.cmd === "network.list") return { acknowledged: true, data: network.list ?? { items: [] } };
			return fakeServer.sendCommand(command, options);
		},
	};
}

const BASE_ENTITY = { ref: "pi-ref://base-1", state: {} };

test("browser_observe baseline lifts a redacted network-delta to envelope.causal", async () => {
	const server = causalServer({
		status: { active: true, lastSeq: 8 },
		list: { items: [{ seq: 6, requestId: "req-a", request: { url: "https://example.test/api/cart?token=SECRET123", method: "POST" }, response: { status: 200 }, type: "XHR", updatedAt: 111 }], total: 1 },
	});
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan");
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.causal?.sinceSeq, 5, "delta windowed at baseline seq");
	assert.equal(envelope.causal?.requests?.length, 1);
	assert.equal(envelope.causal.requests[0].ref, "pi-ref://network/req-a");
	assert.equal(envelope.causal.requests[0].method, "POST");
	assert.equal(envelope.causal.requests[0].status, 200);
	assert.ok(typeof envelope.causal.requests[0].url === "string" && !envelope.causal.requests[0].url.includes("SECRET123"), "sensitive query value scrubbed in lifted causal");
});

test("browser_observe baseline emits causal.unavailable when no recorder is active", async () => {
	const server = causalServer({ status: { active: false } });
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan");
	const envelope = JSON.parse(result.content[0].text);
	assert.ok(typeof envelope.causal?.unavailable === "string" && envelope.causal.unavailable.includes("not active"));
	assert.equal(envelope.causal?.requests, undefined);
});

test("browser_observe records the network seq high-water mark for a future baseline (no causal without baseline)", async () => {
	const server = causalServer({ status: { active: true, lastSeq: 8 } });
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan");
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.causal, undefined, "no baseline → no causal block");
	assert.equal(envelope.snapshot?.networkSeq, 8, "high-water mark stored on the snapshot so it can anchor a later baseline");
});
