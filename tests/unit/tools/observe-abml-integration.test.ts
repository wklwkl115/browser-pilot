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

function countingServer() {
	const calls: string[] = [];
	return {
		...fakeServer,
		calls,
		async sendCommand(command: any, options: any) {
			if (command.cmd === "cdp" && command.method === "Runtime.evaluate") {
				calls.push(String(command.name || ""));
			}
			return fakeServer.sendCommand(command, options);
		},
	};
}

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
	assert.equal(envelope.summary?.focus?.entityShape, "refs-v1");
	assert.equal(typeof envelope.summary?.focus?.primary_entities?.[0], "string");
	assert.equal(Array.isArray(envelope.entities), true);
	assert.equal(envelope.entities?.some((entity: any) => entity.kind === "control"), true);
});

test("browser_observe default scan reuses scan_extract data for ABML read", async () => {
	const server = countingServer();
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan");
	assert.equal(result.details?.abml?.integrated, true);
	assert.deepEqual(server.calls, ["scan_extract"], "default scan should not run a second abml_read_scan Runtime.evaluate");
});

test("browser_observe iframe-disabled scan keeps the separate ABML scan", async () => {
	const server = countingServer();
	const result = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, includeIframes: false }, { cwd: process.cwd() }, "scan");
	assert.equal(result.details?.abml?.integrated, true);
	assert.deepEqual(server.calls, ["scan_extract", "abml_read_scan"], "non-superset scans must keep the separate ABML capture");
});

test("browser_observe tabs mode returns a tracked scan.tabs envelope", async () => {
	const result = await runScanObservation(fakeServer as any, { mode: "tabs", maxChars: 12_000 }, { cwd: process.cwd() }, "tabs");
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.tool, "browser_observe");
	assert.equal(envelope.command, "scan.tabs");
	assert.equal(envelope.summary?.mode, "tabs");
	assert.equal(envelope.summary?.tabs_count, 1);
	assert.equal(envelope.summary?.active_tab, 7);
	assert.equal(envelope.operation?.operationId?.startsWith("op-"), true);
	assert.equal(envelope.snapshot?.snapshotId, "snap-1");
	assert.ok(envelope.saved?.path, "tabs mode should save a read-back artifact");
});

// --- R3.x causal plane (network-delta) runtime wiring ---------------------------------------------
// A server variant that also answers the network recorder reads observe issues for the causal plane.
function causalServer(network: { status: unknown; list?: unknown }, hook?: { status?: unknown; collect?: unknown }) {
	return {
		...fakeServer,
		async sendCommand(command: any, options: any) {
			if (command.cmd === "network.status") return { acknowledged: true, data: network.status };
			if (command.cmd === "network.list") return { acknowledged: true, data: network.list ?? { items: [] } };
			if (command.cmd === "hook.status") {
				if (!hook?.status) throw new Error("no hook session");
				return { acknowledged: true, data: hook.status };
			}
			if (command.cmd === "hook.collect") return { acknowledged: true, data: hook?.collect ?? { events: [] } };
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

test("browser_observe P1: actionRef attributes the causal delta to the control as a triggered relation", async () => {
	const server = causalServer({
		status: { active: true, lastSeq: 8 },
		list: { items: [{ seq: 6, requestId: "pay-1", request: { url: "https://example.test/api/pay", method: "POST" }, response: { status: 200 }, type: "XHR", updatedAt: 1 }], total: 1 },
	});
	// Discover the control ref from a plain scan, then attribute a baseline delta to it via actionRef.
	const env1 = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	const candidates = env1.entities ?? [];
	const control = candidates.find((e: any) => e.kind === "control") ?? candidates[0];
	const actionRef = control?.ref;
	assert.ok(typeof actionRef === "string" && actionRef, "a control ref is available to attribute to");
	const env2 = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, entities: [BASE_ENTITY] }, actionRef }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env2.relations?.summary?.triggered, 1, "triggered edge counted in the lifted relations summary");
	assert.equal(env2.causal?.requests?.length, 1, "the causal delta still ships inline (passive behavior preserved)");
	const triggered = (env2.entities ?? []).find((e: any) => e.ref === actionRef)?.relations?.find((r: any) => r.type === "triggered");
	if (triggered) {
		assert.equal(triggered.targetRef, "pi-ref://network/pay-1", "triggered points at the network request ref");
		assert.equal(triggered.source, "timing");
	}
});

test("browser_observe P1: no actionRef and no focusable control → causal present, no triggered (passive)", async () => {
	const server = causalServer({
		status: { active: true, lastSeq: 8 },
		list: { items: [{ seq: 6, requestId: "x", request: { url: "https://example.test/api/x", method: "GET" }, response: { status: 200 }, type: "Fetch", updatedAt: 1 }], total: 1 },
	});
	// No actionRef; the fakeServer control is not focused, so diff.focusedRef yields no control.
	const env = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env.causal?.requests?.length, 1, "causal delta present");
	assert.equal(env.relations?.summary?.triggered, undefined, "no attribution without an action signal");
});

test("browser_observe P2: baseline attaches the hook event-delta to envelope.causal.events", async () => {
	const server = causalServer(
		{ status: { active: true, lastSeq: 8 }, list: { items: [], total: 0 } },
		{ status: { last_seq: 11 }, collect: { events: [{ seq: 10, type: "domSink", timestamp: 1, data: { prop: "innerHTML", value: "secret=ABCDEF12 x", elementRef: { selector: "#out" } } }], next_seq: 10, total_available: 1 } },
	);
	const env = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, hookSeq: 9, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env.causal?.events?.length, 1, "hook event-delta lifted to envelope.causal.events");
	assert.equal(env.causal.events[0].ref, "pi-ref://event/10");
	assert.equal(env.causal.events[0].type, "domSink");
	assert.equal(env.causal.events[0].selector, "#out", "DOM-sink event carries its target selector");
	assert.ok(env.causal.events[0].summary && !env.causal.events[0].summary.includes("ABCDEF12"), "event summary redacted");
});

test("browser_observe P2: records the hook seq high-water on the snapshot for a future baseline", async () => {
	const server = causalServer({ status: { active: true, lastSeq: 8 } }, { status: { last_seq: 11 } });
	const env = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env.snapshot?.hookSeq, 11, "hook high-water stored so a later baseline can window events");
	assert.equal(env.causal, undefined, "no baseline → no causal block");
});

test("browser_observe C3: session delta is default and env escape disables it", async () => {
	const snapshots = new Map<string, any>();
	const ledger = new Map<string, any>();
	let snapshotSeq = 0;
	const server = {
		...fakeServer,
		createObservationSnapshot(snapshot: any) {
			snapshotSeq += 1;
			const record = { snapshotId: `snap-${snapshotSeq}`, ttlMs: 60_000, expired: false, ...snapshot };
			snapshots.set(record.snapshotId, record);
			return record;
		},
		getObservationSnapshot(snapshotId: string) { return snapshots.get(snapshotId); },
		getPerceptionLedgerFrame(key: any) { return ledger.get(JSON.stringify(key)); },
		recordPerceptionLedgerFrame(frame: any) { ledger.set(JSON.stringify(frame.key), frame); return frame; },
	};
	const previous = process.env.PI_BROWSER_SESSION_DELTA;
	try {
		delete process.env.PI_BROWSER_SESSION_DELTA;
		const first = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
		assert.equal(first.delta, undefined, "first observe remains an I-frame");
		assert.equal(typeof first.snapshot?.snapshotId, "string", "I-frame carries a snapshotId");
		const second = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
		assert.equal(second.delta, "session", "second observe renders as a default session P-frame");
		assert.equal(second.baselineSnapshotId, first.snapshot.snapshotId, "P-frame names its I-frame baseline snapshot");
		process.env.PI_BROWSER_SESSION_DELTA = "0";
		const disabled = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
		assert.equal(disabled.delta, undefined, "PI_BROWSER_SESSION_DELTA=0 forces I-frame behavior");
		const full = await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, detailLevel: "full" }, { cwd: process.cwd() }, "scan");
		assert.ok(full.content[0].text.includes("Checkout"), "detailLevel=full returns the full text payload as the refresh escape hatch");
	} finally {
		if (previous === undefined) delete process.env.PI_BROWSER_SESSION_DELTA;
		else process.env.PI_BROWSER_SESSION_DELTA = previous;
	}
});

test("browser_observe P2-B: a DOM-sink event naming its element → triggered edge on that control (source event)", async () => {
	// Discover a control with a selector from a plain scan, then have the hook delta name it.
	const probe = causalServer({ status: { active: true, lastSeq: 8 } });
	const env1 = JSON.parse((await runScanObservation(probe as any, { mode: "scan", tabId: 7, maxChars: 12_000 }, { cwd: process.cwd() }, "scan")).content[0].text);
	const ctl = (env1.entities ?? []).find((e: any) => e.hints?.selector && (e.kind === "control" || e.kind === "element"));
	assert.ok(ctl?.hints?.selector, "a control with a selector is available to attribute to");
	const server = causalServer(
		{ status: { active: true, lastSeq: 8 }, list: { items: [], total: 0 } },
		{ status: { last_seq: 11 }, collect: { events: [{ seq: 10, type: "domSink", timestamp: 1, data: { value: "x" }, selector: ctl.hints.selector }] } },
	);
	const env2 = JSON.parse((await runScanObservation(server as any, { mode: "scan", tabId: 7, maxChars: 12_000, baseline: { networkSeq: 5, hookSeq: 9, entities: [BASE_ENTITY] } }, { cwd: process.cwd() }, "scan")).content[0].text);
	assert.equal(env2.causal?.events?.length, 1, "event present in causal.events");
	assert.equal(env2.relations?.summary?.triggered, 1, "event-sourced triggered counted in relations.summary");
	const edge = (env2.entities ?? []).find((e: any) => e.ref === ctl.ref)?.relations?.find((r: any) => r.type === "triggered");
	if (edge) {
		assert.equal(edge.source, "event", "element-sourced attribution (stronger than timing)");
		assert.equal(edge.targetRef, "pi-ref://event/10", "edge targets the event ref");
	}
});
