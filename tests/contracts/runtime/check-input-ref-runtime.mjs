import assert from "node:assert/strict";

const cdpCalls = [];
let mode = "ok";
const listeners = new Set();

globalThis.self = globalThis;
globalThis.chrome = {
	runtime: { id: "input-ref-fixture" },
	tabs: { async update() { return {}; } },
	storage: { session: { async get() { return {}; }, async set() {}, async remove() {} } },
	debugger: {
		onDetach: { addListener() {}, removeListener() {} },
		onEvent: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
		async attach() {},
		async detach() {},
		async sendCommand(target, method, params = {}) {
			cdpCalls.push({ tabId: target.tabId, method, params });
			if (method === "DOM.getBoxModel") {
				if (mode === "stale") throw new Error("No node with given id");
				return { border: [10, 20, 50, 20, 50, 60, 10, 60] };
			}
			return {};
		},
	},
};

const { handlePiBrowserRefInputCommand } = await import("../../../bridge_src/service_worker/input.ts");

function reset(nextMode = "ok") {
	mode = nextMode;
	cdpCalls.length = 0;
}

reset("ok");
const backend = await handlePiBrowserRefInputCommand("input.ref", 7, { action: "click", target: { refId: "pi-ref://control/pay", backendNodeId: 91 }, timeoutMs: 1000 });
assert.equal(backend.ok, true);
assert.equal(backend.data.input.resolution, "backendNodeId");
assert.equal(backend.data.input.dispatchOnly, true);
assert.equal(backend.data.input.dispatched, 3);
assert.deepEqual(backend.data.input.events, ["mouseMoved", "mousePressed", "mouseReleased"]);
assert.deepEqual(backend.data.input.coordinates, { x: 30, y: 40 });
assert(cdpCalls.some((call) => call.method === "DOM.scrollIntoViewIfNeeded" && call.params.backendNodeId === 91));
assert(cdpCalls.some((call) => call.method === "DOM.getBoxModel" && call.params.backendNodeId === 91));

reset("ok");
const point = await handlePiBrowserRefInputCommand("input.ref", 7, { action: "click", target: { refId: "pi-ref://control/point", point: { x: 12, y: 34 } }, timeoutMs: 1000 });
assert.equal(point.ok, true);
assert.equal(point.data.input.resolution, "point");
assert.equal(point.data.input.dispatched, 3);
assert.equal(cdpCalls.some((call) => call.method === "DOM.getBoxModel"), false, "point tier must not perform backend lookup");

reset("stale");
const stale = await handlePiBrowserRefInputCommand("input.ref", 7, { action: "click", target: { refId: "pi-ref://control/stale", backendNodeId: 92, point: { x: 1, y: 2 } }, timeoutMs: 1000 });
assert.equal(stale.ok, false);
assert.equal(stale.error_code, "BACKEND_NODE_STALE");
assert.equal(stale.details.input.dispatched, 0);
assert.equal(stale.details.input.resolution, "backendNodeId");
assert.equal(cdpCalls.some((call) => call.method === "Input.dispatchMouseEvent"), false, "backend failure must not silently fall back to point");

reset("ok");
const invalid = await handlePiBrowserRefInputCommand("input.ref", 7, { action: "click", target: { refId: "pi-ref://control/invalid" }, timeoutMs: 1000 });
assert.equal(invalid.ok, false);
assert.equal(invalid.error_code, "INVALID_REF_TARGET");
assert.equal(invalid.details.input.dispatched, 0);

console.log("input.ref runtime contract ok");
